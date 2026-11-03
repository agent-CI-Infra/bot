"""Coverage summaries the board has already read, so each artifact is downloaded once.

An Actions artifact never changes after upload. ``.sync/coverage.json`` keeps the
artifact listing the coverage view draws from and, for every summary it read,
the summary without its per-file list. ``.sync/coverage-sources.json`` keeps the
per-file lists only for summaries the view currently shows. A build pages the
artifact listing only back to artifacts it has seen and downloads only
summaries it has never read.
"""
from __future__ import annotations

from datetime import datetime
import re

# Artifacts the coverage view can read; everything else in the listing is ignored.
COVERAGE_NAME = re.compile(r"cover|lcov|codecov", re.I)
MAX_PAGES = 5
ROW_FIELDS = ("id", "name", "size_in_bytes", "expired", "created_at", "expires_at", "url")


def _parse(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


class CoverageStore:
    def __init__(self, state=None, sources=None):
        valid = isinstance(state, dict) and state.get("version") == 1
        self.state: dict = state if isinstance(state, dict) and valid else {"version": 1, "newest": 0, "artifacts": {}}
        self.sources: dict = sources if valid and isinstance(sources, dict) else {}
        self.changed = self.sources_changed = False
        self.touched, self.used = set(), set()
        # Per-file lists downloaded in this build; saved only for summaries in use.
        self._fresh = {}
        self._listing = None
        self.downloads = 0

    def listing(self, gh, repo, now):
        """Coverage artifacts GitHub still keeps, newest first; one listing per build.

        GitHub lists artifacts newest first, so paging stops at the first page
        that reaches an artifact seen before; older ones come from the store."""
        if self._listing is not None:
            return self._listing
        known, newest = self.state["artifacts"], self.state.get("newest") or 0
        for page in range(1, MAX_PAGES + 1):
            rows = (gh.get(f"/repos/{repo}/actions/artifacts", {"per_page": 100, "page": page}) or {}).get("artifacts") or []
            for raw in rows:
                if not COVERAGE_NAME.search(raw.get("name") or ""):
                    continue
                run = raw.get("workflow_run") or {}
                row = {**{k: raw.get(k) for k in ROW_FIELDS},
                       "workflow_run": {"id": run.get("id"), "head_branch": run.get("head_branch"), "head_sha": run.get("head_sha")}}
                entry = known.setdefault(str(raw["id"]), {})
                if entry.get("artifact") != row:
                    entry["artifact"] = row
                    self.changed = True
            if rows and max(raw["id"] for raw in rows) > self.state.get("newest", 0):
                self.state["newest"] = max(raw["id"] for raw in rows)
                self.changed = True
            if len(rows) < 100 or (newest and min(raw["id"] for raw in rows) <= newest):
                break
        self._listing = sorted((entry["artifact"] for entry in known.values() if "artifact" in entry and not self._expired(entry, now)),
                               key=lambda row: row.get("created_at") or "", reverse=True)
        return self._listing

    @staticmethod
    def _expired(entry, now):
        row = entry.get("artifact") or {}
        expires = _parse(row.get("expires_at"))
        return bool(row.get("expired")) or (expires is not None and expires <= now)

    def get(self, artifact, sources=False):
        """(True, manifest) for a summary read before; (False, None) when it must be downloaded."""
        key = str(artifact["id"])
        self.touched.add(key)
        entry = self.state["artifacts"].get(key) or {}
        if "manifest" not in entry or (sources and entry["manifest"] is not None and key not in self.sources and key not in self._fresh):
            return False, None
        if entry["manifest"] is None:
            return True, None
        if not sources:
            return True, dict(entry["manifest"])
        self._use(key)
        return True, {**entry["manifest"], "sources": self.sources[key]}

    def _use(self, key):
        self.used.add(key)
        if key not in self.sources and key in self._fresh:
            self.sources[key] = self._fresh[key]
            self.sources_changed = True

    def put(self, artifact, manifest, sources=False):
        """Remember what a downloaded artifact held; ``None`` when it is not a summary."""
        key = str(artifact["id"])
        self.downloads += 1
        self.touched.add(key)
        entry = self.state["artifacts"].setdefault(key, {})
        entry.setdefault("artifact", {**{k: artifact.get(k) for k in ROW_FIELDS},
                                      "workflow_run": {"id": artifact.get("run_id"), "head_branch": artifact.get("branch"), "head_sha": artifact.get("sha")}})
        entry["manifest"] = None if manifest is None else {k: v for k, v in manifest.items() if k != "sources"}
        self.changed = True
        if manifest is not None and manifest.get("sources") is not None:
            self._fresh[key] = manifest["sources"]
        if sources and manifest is not None:
            self._use(key)

    def finish(self, now, complete):
        """Drop expired artifacts; after a build that refreshed every line, also
        drop summaries no line read and per-file lists no view shows."""
        artifacts = self.state["artifacts"]
        for key in list(artifacts):
            if self._expired(artifacts[key], now) or (complete and key not in self.touched):
                del artifacts[key]
                self.changed = True
        for key in list(self.sources):
            if key not in artifacts or (complete and key not in self.used):
                del self.sources[key]
                self.sources_changed = True
