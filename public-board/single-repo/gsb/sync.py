"""Budgeted, restartable collection. The Pages repository owns all progress."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import time
from urllib.parse import quote

from .collectors import _slim_issue, _slim_pr
from .config import Config
from .github import GitHubError
from .history import History, encode, read_json
from .project import slim_run, run_details
from .lines import configured_lines
from .tagged import TaggedStore

# 2: tagged catalogs and harness summaries are read from results artifacts.
# 3: Real E2E metrics are reduced to public score summaries.
PARSER_VERSION = 4


def stamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def date(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class BudgetExhausted(Exception):
    pass


class Budget:
    def __init__(self, gh, requests=180, seconds=480):
        self.gh, self.left, self.deadline = gh, requests, time.monotonic() + seconds
        self.downloaded = 0
        self.token = gh.token
        self.recent = {}

    def call(self, method, *args, **kwargs):
        if self.left <= 0 or time.monotonic() >= self.deadline:
            raise BudgetExhausted()
        self.left -= 1
        return getattr(self.gh, method)(*args, **kwargs)

    def get(self, *a, **kw):
        return self.call("get", *a, **kw)

    def graphql(self, *a, **kw):
        return self.call("graphql", *a, **kw)

    def paginate(self, path, params=None, *, key=None, max_pages=None):
        # max_pages from the old collector is intentionally not a retention cap.
        out, page = [], 1
        while True:
            data = self.get(path, {**(params or {}), "per_page": 100, "page": page})
            rows = data[key] if key else data
            out.extend(rows)
            if len(rows) < 100:
                return out
            page += 1

    def get_text_file(self, *a, **kw):
        return self.call("get_text_file", *a, **kw)

    def separate_phase(self, *, requests, seconds):
        """Give a bounded follow-up phase its own budget, sharing downloaded bytes."""
        phase = Budget(self.gh, requests=requests, seconds=seconds)
        phase.recent = self.recent
        return phase

    def download_artifact(self, repo, artifact_id, **kwargs):
        # Reuse artifacts across phases, but honor each caller's per-file limit.
        if (repo, artifact_id) in self.recent:
            data = self.recent[repo, artifact_id]
            if len(data) > kwargs["max_bytes"]:
                raise GitHubError("cached artifact exceeds download limit", kind="error")
            return data
        if self.downloaded >= 160 * 1024 * 1024:
            raise BudgetExhausted()
        data = self.call("download_artifact", repo, artifact_id, **kwargs)
        self.downloaded += len(data)
        self.recent[repo, artifact_id] = data
        return data


class Sync:
    def __init__(self, gh, root, repo, settings=None, now=None, requests=180, seconds=480):
        self.history = History(root)
        self.gh = Budget(gh, requests, seconds)
        self.repo, self.settings = repo, settings or {}
        self.now = (now or datetime.now(timezone.utc)).replace(microsecond=0)
        self.state = read_json(self.history.root / ".sync/state.json", {
            "schema": 1, "repository": repo, "started_at": stamp(self.now), "backfill": {},
            "incremental": {}, "pending": {}, "errors": {}, "reconcile": {}})
        if self.state["schema"] != 1 or self.state["repository"].lower() != repo.lower():
            raise ValueError("sync state belongs to a different repository or schema")
        self.base = f"/repos/{repo}"
        self.cfg = Config.from_env(repo=repo)
        self.tagged = TaggedStore(read_json(self.history.root / ".sync/tagged.json", None))
        if not self.state.get("migrated"):
            old = read_json(self.history.root / "site/data/snapshot.json", {})
            source = (old.get("repository") or {}).get("name", "")
            if source and source.lower() != repo.lower():
                raise ValueError("existing site belongs to another source")
            for kind, keys in (("issues", ("items", "closed_recent")), ("prs", ("items", "recent_merged", "recent_closed_unmerged"))):
                for field in keys:
                    for row in (old.get(kind) or {}).get(field, []):
                        row.pop("age_days", None)
                        row.pop("idle_days", None)
                        self.history.put(kind, row)
            for row in old.get("quality", {}).get("runs", []):
                for report in row.get("tests", []):
                    report.pop("cases", None)
                    report.pop("commands", None)
                self.history.put("runs", row)
            self.state["migrated"] = True

    def guarded(self, name, fn):
        try:
            fn()
            self.state["errors"].pop(name, None)
        except BudgetExhausted:
            return
        except GitHubError as err:
            # Error categories only: API messages can contain non-public context.
            self.state["errors"][name] = {"kind": err.kind, "at": stamp(self.now)}

    def save_item(self, kind, raw):
        if kind == "issues" and "pull_request" in raw:
            return
        fn = _slim_issue if kind == "issues" else _slim_pr
        row = fn(raw, self.now)
        row["body"] = raw.get("body") or ""
        row.pop("age_days", None)
        row.pop("idle_days", None)
        if kind == "prs":
            old = self.history.get(kind, row["number"])
            if old and old.get("head_sha") == row.get("head_sha"):
                for key in ("review_decision", "mergeable", "reviews", "ci"):
                    row[key] = old[key]
            if row["state"] == "open":
                self.queue("pr:" + str(row["number"]))
        self.history.put(kind, row)

    def queue(self, key, due=None):
        self.state["pending"].setdefault(key, {"due": due or stamp(self.now), "tries": 0})

    def refresh_changed_runs(self, changes):
        """Get only notified IDs, including reruns outside the created-time window."""
        for hint in changes:
            try:
                raw = self.gh.get(self.base + f"/actions/runs/{hint['id']}")
                attempt = raw.get("run_attempt")
                if raw.get("id") != hint['id'] or type(attempt) is not int or attempt < hint['attempt']:
                    raise GitHubError("rerun metadata not ready", kind="rerun_not_ready")
                self.save_run(raw)
                key = History.key("runs", slim_run(raw, self.settings.get("workflows", {})))
                self.state["pending"]["run:" + key]["due"] = stamp(self.now)
                self.changed_jobs.append((hint, key))
                self.state["errors"].pop("rerun:" + str(hint['id']), None)
            except GitHubError as err:
                self.state["errors"]["rerun:" + str(hint['id'])] = {"kind": err.kind, "at": stamp(self.now)}

    def completed_changes(self):
        # Reports may need another poll or exceed this run's budget. Until settled,
        # keep the bot hint as well as the existing durable detail job in Pages.
        return [hint for hint, key in self.changed_jobs
                if "run:" + key not in self.state["pending"]
                and (self.history.get("runs", key) or {}).get("status") == "completed"]

    def objects(self, kind, mode, pages=4):
        store = self.state[mode]
        cursor = store.setdefault(kind, {"page": 1, "done": False})
        if cursor.get("done") and mode != "incremental":
            return
        if mode == "incremental" and cursor.get("done"):
            cursor.update(page=1, done=False, since=cursor["until"])
            cursor.pop("until", None)
        cursor.setdefault("until", stamp(self.now))
        path = self.base + ("/issues" if kind == "issues" else "/pulls")
        params = {"state": "all", "sort": "created", "direction": "asc", "per_page": 100}
        since = cursor.get("since", self.state["started_at"])
        overlap = stamp(date(since) - timedelta(hours=1))
        if mode == "incremental":
            params.update(sort="updated", direction="desc")
            if kind == "issues":
                params["since"] = overlap
        for _ in range(pages):
            rows = self.gh.get(path, {**params, "page": cursor["page"]})
            for row in rows:
                self.save_item(kind, row)
            cursor["page"] += 1
            if len(rows) < 100 or (mode == "incremental" and rows[-1]["updated_at"] < overlap):
                cursor["done"] = True
                cursor["completed_at"] = stamp(self.now)
                break

    def save_run(self, raw):
        # Re-fetch attempts missed while the webhook/collector was offline.
        for attempt in range(1, raw.get("run_attempt", 1)):
            key = f"{raw['id']}-{attempt}"
            if not self.history.get("runs", key):
                self.queue("attempt:" + key)
        row = slim_run(raw, self.settings.get("workflows", {}))
        row["title"] = raw.get("display_title") or row["name"]
        row["duration_s"] = max(0, int((date(row["updated_at"]) - date(row["started_at"])).total_seconds())) if row["status"] == "completed" and row.get("started_at") and row.get("updated_at") else None
        key = History.key("runs", row)
        old = self.history.get("runs", key)
        # A list response is metadata, never evidence that previously parsed
        # metrics disappeared. Keep them across expiration and transient errors.
        if old:
            for field in ("tests", "jobs", "coverage", "coverage_summaries", "reports_status", "metrics_version", "inspected_at", "inspected"):
                if field in old:
                    row[field] = old[field]
        self.history.put("runs", row)
        job = self.state["pending"].get("run:" + key)
        if job and old and old.get("status") != "completed" and row["status"] == "completed":
            # Jobs that finished after the last inspection uploaded more reports.
            job["due"] = stamp(self.now)
        self.queue("run:" + key)

    def runs(self, mode, pages=4):
        state = self.state[mode]
        scan = state.setdefault("runs", {"windows": [], "done": False})
        if scan["done"] and mode != "incremental":
            return
        if not scan["windows"]:
            lower = scan.get("until", self.meta["created_at"] if mode != "incremental" else self.state["started_at"])
            if mode == "incremental":
                lower = stamp(date(lower) - timedelta(hours=1))
            scan.update(windows=[{"lo": lower, "hi": stamp(self.now), "page": 1}], until=stamp(self.now), done=False)
        for _ in range(pages):
            if not scan["windows"]:
                break
            window = scan["windows"][-1]
            response = self.gh.get(self.base + "/actions/runs", {
                "created": window["lo"] + ".." + window["hi"], "page": window["page"], "per_page": 100})
            # GitHub caps filtered searches at 1,000. Split inclusive time
            # ranges into disjoint seconds before consuming any capped result.
            if response["total_count"] > 1000:
                lo, hi = date(window["lo"]), date(window["hi"])
                if lo >= hi:
                    raise GitHubError("saturated second", kind="time_window_saturated")
                mid = lo + timedelta(seconds=int((hi - lo).total_seconds()) // 2)
                scan["windows"].pop()
                scan["windows"].extend([{"lo": stamp(lo), "hi": stamp(mid), "page": 1},
                                        {"lo": stamp(mid + timedelta(seconds=1)), "hi": stamp(hi), "page": 1}])
                continue
            rows = response["workflow_runs"]
            for row in rows:
                self.save_run(row)
            window["page"] += 1
            if len(rows) < 100 or (window["page"] - 1) * 100 >= response["total_count"]:
                scan["windows"].pop()
        if not scan["windows"]:
            scan.update(done=True, completed_at=stamp(self.now))

    def releases(self, mode, pages=2):
        cursor = self.state[mode].setdefault("releases", {"page": 1, "done": False})
        if cursor["done"]:
            return
        for _ in range(pages):
            rows = self.gh.get(self.base + "/releases", {"page": cursor["page"], "per_page": 100})
            for raw in rows:
                if raw.get("draft"):
                    continue
                row = {"id": raw["id"], "tag": raw["tag_name"], "name": raw.get("name") or raw["tag_name"],
                       "prerelease": raw.get("prerelease", False), "created_at": raw.get("created_at"),
                       "published_at": raw.get("published_at"), "url": raw["html_url"]}
                old = self.history.get("releases", raw["id"])
                row["sha"] = old.get("sha") if old and old["tag"] == row["tag"] else None
                if not row["sha"]:
                    row["sha"] = self.gh.get(self.base + "/commits/" + quote(row["tag"], safe=""))["sha"]
                self.history.put("releases", row)
            cursor["page"] += 1
            if len(rows) < 100:
                cursor.update(done=True, completed_at=stamp(self.now))
                break

    def pr_details(self, number):
        # Query the exact PR rather than the first N open PRs.
        from .collectors import PR_GRAPHQL
        fields = PR_GRAPHQL[PR_GRAPHQL.index("        number"):PR_GRAPHQL.rindex("      }")]
        query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){" + fields + "}}}"
        owner, name = self.repo.split("/")
        node = self.gh.graphql(query, {"owner": owner, "name": name, "number": int(number)})["repository"]["pullRequest"]
        row = self.history.get("prs", number)
        if not node or not row:
            return
        from .collectors import _enrich_prs_graphql, Context
        class OnePR:
            def graphql(self, *_):
                return {"repository": {"pullRequests": {"nodes": [node]}}}
        _enrich_prs_graphql(Context(OnePR(), self.cfg, self.now, self.meta), [row])
        self.history.put("prs", row)

    def pending(self, count=30, priority=(), only_priority=False):
        ready = [(key, value) for key, value in self.state["pending"].items() if value["due"] <= stamp(self.now) and (not only_priority or key in priority)]
        urgent = [item for item in ready if item[0] in priority][:count]
        urgent_keys = {key for key, _ in urgent}
        remaining = count - len(urgent)
        rest = [item for item in ready if item[0] not in urgent_keys]
        latest = sorted(rest, key=lambda item: (not item[0].startswith("pr:"), -int(item[0].split(":")[1].split("-")[0])))[:(remaining + 1) // 2]
        selected = urgent_keys | {key for key, _ in latest}
        # Keep half the remaining slots for old backlog after the bounded hints.
        due = urgent + latest + sorted((item for item in ready if item[0] not in selected), key=lambda item: (item[1]["due"], item[0]))[:remaining-len(latest)]
        for key, job in due:
            kind, ident = key.split(":", 1)
            try:
                if kind == "pr":
                    self.pr_details(ident)
                    del self.state["pending"][key]
                    continue
                run_id, attempt = ident.split("-")
                row = self.history.get("runs", ident)
                if kind == "attempt" or not row or row["status"] != "completed":
                    raw = self.gh.get(self.base + f"/actions/runs/{run_id}/attempts/{attempt}")
                    raw["run_attempt"] = int(attempt)
                    self.save_run(raw)
                    row = self.history.get("runs", ident)
                if kind == "attempt":
                    following = self.history.get("runs", f"{run_id}-{int(attempt)+1}")
                    if not following:
                        following = self.gh.get(self.base + f"/actions/runs/{run_id}/attempts/{int(attempt)+1}")
                    row["next_started_at"] = following.get("started_at") or following.get("run_started_at")
                previous = deepcopy(row)
                try:
                    run_details(self.gh, self.cfg, row, cache=previous, parser_version=PARSER_VERSION)
                finally:
                    slices = row.pop("tagged", None)
                    if slices:
                        self.tagged.observe(row, slices, self.meta["default_branch"],
                                            [line["ref"] for line in configured_lines(self.settings, self.meta["default_branch"])])
                    # Budget interruption must not erase already parsed artifacts.
                    for report in previous.get("tests", []):
                        if report.get("counts") is not None and not any(t["artifact_id"] == report["artifact_id"] for t in row.get("tests", [])):
                            row.setdefault("tests", []).append(report)
                    # Strip transient testcase details before any possible commit.
                    for report in row.get("tests", []):
                        report.pop("cases", None)
                        report.pop("commands", None)
                    self.history.put("runs", row)
                row["metrics_version"] = PARSER_VERSION
                # Inspection time is internal progress, not a reason to deploy.
                self.history.put("runs", row)
                if kind == "attempt":
                    del self.state["pending"][key]
                    continue
                job["tries"] += 1
                job.pop("error", None)
                delay = 120 if row["status"] != "completed" else min(86400, 300 * 2 ** min(job["tries"], 9))
                # Early reports of a running workflow are not the whole run.
                if row.get("reports_status") == "available" and row["status"] == "completed":
                    delay = 86400
                unavailable = row.get("reports_status") == "unavailable" or row.get("jobs_status") == "unavailable" or any(t["status"] == "unavailable" for t in row.get("tests", []))
                if unavailable:
                    job["error"] = "details_unavailable"
                # A completed attempt's jobs and artifacts no longer change. It leaves
                # the queue once its reports are read, or after a second look found
                # nothing new; only unreadable details keep being retried for a week.
                settled = row["status"] == "completed" and not unavailable
                if settled:
                    job["after"] = job.get("after", 0) + 1
                if settled and (row.get("reports_status") == "available" or job["after"] >= 2
                                or date(row["updated_at"]) < self.now - timedelta(days=7)):
                    del self.state["pending"][key]
                else:
                    job["due"] = stamp(self.now + timedelta(seconds=delay))
            except GitHubError as err:
                job["tries"] += 1
                job.update(error=err.kind, due=stamp(self.now + timedelta(seconds=min(86400, 60 * 2 ** min(job["tries"], 10)))))

    def collect(self, changed_runs=()):
        self.changed_jobs = []
        self.meta = self.gh.get(self.base)
        if (self.meta.get("private") or self.meta.get("visibility", "public") != "public") and not self.cfg.allow_private:
            raise ValueError("public dashboard requires a public source")
        self.guarded("reruns", lambda: self.refresh_changed_runs(changed_runs))
        self.guarded("rerun_details", lambda: self.pending(count=20, priority={"run:" + key for _, key in self.changed_jobs}, only_priority=True))
        # Fair lane budgets prevent a large initial backfill starving live data.
        for mode in ("incremental", "backfill"):
            for kind in ("issues", "prs"):
                self.guarded(mode + ":" + kind, lambda k=kind, m=mode: self.objects(k, m))
            self.guarded(mode + ":runs", lambda m=mode: self.runs(m))
        self.guarded("releases", lambda: self.releases("backfill"))
        # Weekly rolling reconciliation repairs missed updates, old reruns and
        # pagination movement. It is resumable and never discards known records.
        reconcile = self.state["reconcile"]
        if not reconcile or all(reconcile.get(k, {}).get("done") for k in ("issues", "prs", "runs", "releases")):
            if not reconcile.get("next_at") or reconcile["next_at"] <= stamp(self.now):
                self.state["reconcile"] = {"next_at": stamp(self.now + timedelta(days=7))}
        if self.state["backfill"].get("runs", {}).get("done"):
            for kind in ("issues", "prs"):
                self.guarded("reconcile:" + kind, lambda k=kind: self.objects(k, "reconcile", pages=1))
            self.guarded("reconcile:runs", lambda: self.runs("reconcile", pages=1))
            self.guarded("reconcile:releases", lambda: self.releases("reconcile", pages=1))
        self.guarded("details", lambda: self.pending(priority={"run:" + key for _, key in self.changed_jobs}))
        self.guarded("tagged", lambda: self.tagged.refresh_schema(self.gh.get_text_file, self.repo))
        self.state["last_poll"] = stamp(self.now)
        return self

    def progress(self):
        backfill = self.state["backfill"]
        return {"started_at": self.state["started_at"],
                "complete": all(backfill.get(k, {}).get("done") for k in ("issues", "prs", "runs", "releases")),
                "backfill": {k: {"complete": bool(v.get("done")), "page": v.get("page"), "windows": len(v.get("windows", []))} for k, v in backfill.items()},
                "totals": self.history.manifest["totals"],
                "pending": sum(1 for k, v in self.state["pending"].items() if not v.get("tries") or v.get("error") or k.startswith(("attempt:", "pr:"))),
                "failed": len(self.state["errors"]) + sum(bool(v.get("error")) for v in self.state["pending"].values())}

    def files(self):
        files = {**self.history.files(), ".sync/state.json": encode(self.state)}
        if self.tagged.changed:
            files[".sync/tagged.json"] = encode(self.tagged.state)
        return files
