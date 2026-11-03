"""Stable public shards and reversible counters; no credentials or report bodies."""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else deepcopy(default)


# Searchable summary of each record. Runs keep what places them on a branch
# line (trigger, linked PRs, target, head repository); PRs keep their branches.
INDEX_FIELDS = ("id", "number", "attempt", "tag", "name", "title", "state", "status", "conclusion", "channel", "workflow_id",
                "event", "pull_requests", "base_branch", "head_repo", "head", "base", "head_sha", "started_at", "author",
                "labels", "assignees", "created_at", "updated_at", "closed_at", "merged_at", "branch", "sha", "url")


def contributions(kind, row):
    out = Counter()
    out[f"{kind}:total"] = 1
    if kind in ("issues", "prs"):
        out[f"{kind}:state:{row['state']}"] = 1
        for field in ("created_at", "closed_at", "merged_at"):
            if row.get(field):
                out[f"{kind}:{field}:{row[field][:10]}"] = 1
    elif kind == "runs":
        for group in ("all", "channel:" + row["channel"], "workflow:" + str(row["workflow_id"]), "day:" + row["created_at"][:10]):
            prefix = f"runs:{group}:"
            out[prefix + "total"] = 1
            out[prefix + str(row.get("conclusion") or row["status"])] = 1
            for report in row.get("tests", []):
                for name, value in (report.get("counts") or {}).items():
                    out[prefix + report["layer"] + ":" + name] += value or 0
    return out


class History:
    """Load records only on demand. Index shards contain small searchable rows."""
    def __init__(self, root):
        self.root = Path(root)
        self.manifest = read_json(self.root / "site/data/history/manifest.json", {"schema": 1, "shards": {}, "totals": {}})
        self.aggregate = read_json(self.root / ".sync/aggregate.json", {})
        self.records, self.indexes, self.changed = {}, {}, {}

    @staticmethod
    def key(kind, row):
        if kind == "runs":
            return f"{row['id']}-{row['attempt']}"
        return str(row.get("number", row.get("id")))

    @staticmethod
    def bucket(kind, key):
        # Numeric ranges remain stable as the repository grows; no record limit.
        number = int(key.split("-")[0])
        return f"{kind}/{number // (100 if kind != 'runs' else 1000000):012d}"

    def _records(self, bucket):
        if bucket not in self.records:
            self.records[bucket] = read_json(self.root / f"site/data/history/records/{bucket}.json", {})
        return self.records[bucket]

    def _index(self, bucket):
        if bucket not in self.indexes:
            self.indexes[bucket] = read_json(self.root / f"site/data/history/index/{bucket}.json", {})
        return self.indexes[bucket]

    def get(self, kind, key):
        return deepcopy(self._records(self.bucket(kind, str(key))).get(str(key)))

    def put(self, kind, row):
        key = self.key(kind, row)
        bucket = self.bucket(kind, key)
        records = self._records(bucket)
        old = records.get(key)
        if old == row:
            return False
        counts = Counter(self.aggregate)
        if old:
            counts.subtract(contributions(kind, old))
        counts.update(contributions(kind, row))
        self.aggregate = {k: v for k, v in counts.items() if v}
        records[key] = deepcopy(row)
        self._index(bucket)[key] = self._summary(row)
        self.changed[f"site/data/history/records/{bucket}.json"] = encode(records)
        self.changed[f"site/data/history/index/{bucket}.json"] = encode(self._index(bucket))
        self.manifest["shards"][bucket] = {
            "kind": kind, "count": len(records), "index": f"index/{bucket}.json", "records": f"records/{bucket}.json",
            "revision": hashlib.sha256(self.changed[f"site/data/history/records/{bucket}.json"].encode()).hexdigest()[:16]}
        self.manifest["totals"][kind] = self.aggregate.get(f"{kind}:total", 0)
        return True

    @staticmethod
    def _summary(row):
        return {k: v for k, v in row.items() if k in INDEX_FIELDS}

    def reindex(self, kind, key):
        """Rewrite one index row from its record, e.g. after the index gained fields.

        Records and counts are unchanged; returns the refreshed row or None."""
        bucket = self.bucket(kind, str(key))
        record = self._records(bucket).get(str(key))
        if record is None:
            return None
        row = self._summary(record)
        if self._index(bucket).get(str(key)) != row:
            self._index(bucket)[str(key)] = row
            self.changed[f"site/data/history/index/{bucket}.json"] = encode(self._index(bucket))
        return deepcopy(row)

    def rows(self, kind):
        for bucket, info in self.manifest["shards"].items():
            if info["kind"] == kind:
                for key, row in self._index(bucket).items():
                    yield key, row

    def select(self, kind, predicate=lambda r: True, limit=None):
        rows = sorted(((key, row) for key, row in self.rows(kind) if predicate(row)),
                      key=lambda pair: (pair[1].get("updated_at") or pair[1].get("created_at") or "", pair[0]), reverse=True)
        return [self.get(kind, key) for key, _ in (rows if limit is None else rows[:limit])]

    def files(self):
        # GitHub run IDs are global and sparse within one repository. Bundle
        # their tiny search indexes to avoid one HTTP request per few runs.
        groups = {}
        for bucket, info in self.manifest["shards"].items():
            kind, number = bucket.split("/")
            group = f"{kind}/{int(number) // (100 if kind == 'runs' else 10):012d}"
            groups.setdefault(group, []).append(bucket)
        catalogs = self.manifest.setdefault("catalogs", {})
        for group, buckets in groups.items():
            if group in catalogs and not any(f"site/data/history/{part}/{b}.json" in self.changed for b in buckets for part in ("records", "index")):
                continue
            entries = [{"key": key, "row": row, "record": self.manifest["shards"][b]["records"],
                        "revision": self.manifest["shards"][b]["revision"]}
                       for b in buckets for key, row in self._index(b).items()]
            content = encode(entries)
            self.changed[f"site/data/history/catalog/{group}.json"] = content
            catalogs[group] = {"kind": group.split("/")[0], "path": f"catalog/{group}.json", "count": len(entries),
                               "revision": hashlib.sha256(content.encode()).hexdigest()[:16]}
        if self.changed:
            self.changed["site/data/history/manifest.json"] = encode(self.manifest)
            self.changed[".sync/aggregate.json"] = encode(self.aggregate)
        return self.changed
