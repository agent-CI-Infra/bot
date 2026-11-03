"""Lightweight current views backed by the complete public history."""
from copy import deepcopy
from datetime import timedelta
import hashlib
from zoneinfo import ZoneInfo

from .board import BoardStore
from .ci_lanes import LANES, PR_EVENTS, build_lanes, window_start
from .ci_gates import summary as gate_summary
from .collectors import Context, collect_ci, summarize_issues, summarize_prs, days_between
from .coverage_store import CoverageStore
from .history import read_json, encode
from .lines import canonical_branch, configured_lines, line_of, target_of
from .work_trend import daily_trend
from .public_sections import public_ops, public_tests, score_history, daily_score_runs, latest_score_report, envelope
from .sync import stamp, date


SUPPLEMENT_TESTS_VERSION = 6
COVERAGE_TIMEZONE = ZoneInfo("Asia/Shanghai")
COVERAGE_GATE_JOBS = ("Gate / UT", "Gate / ST", "Gate / Coverage")


def _coverage_jobs_passed(run):
    """Require successful UT, ST and Coverage jobs from the same attempt."""
    conclusions = {job.get("name"): job.get("conclusion") for job in run.get("jobs", [])}
    return all(conclusions.get(name) == "success" for name in COVERAGE_GATE_JOBS)


def _tests_revision(runs):
    identity = [[row["id"], row["attempt"], row.get("status"), row.get("conclusion"), row.get("updated_at")]
                for row in runs]
    return hashlib.sha256(encode(identity).encode()).hexdigest()[:16]


def _coverage_run(history, run_id, created_at):
    """Find the attempt that owned an artifact created for a workflow run."""
    if not run_id or not created_at:
        return None
    created = date(created_at)
    candidates = []
    for key, row in history.rows("runs"):
        if row.get("id") != run_id or not row.get("started_at"):
            continue
        if date(row["started_at"]) <= created:
            candidates.append((row.get("attempt", 1), key, row))
    if not candidates:
        return None
    _, key, row = max(candidates)
    return key, row


def _persist_coverage_summaries(history, coverage, line, lines):
    """Attach compact, complete coverage evidence to its canonical run record."""
    for language, dataset in (coverage.get("languages") or {}).items():
        for item in dataset.get("history", []):
            matched = _coverage_run(history, item.get("run_id"), item.get("created_at"))
            if not matched:
                continue
            key, index = matched
            # Real E2E can fail independently of a complete Nightly coverage gate.
            # Main push/manual CI still needs to pass as a whole.
            if (index.get("event") in PR_EVENTS
                    or line_of(index.get("branch"), lines, index.get("created_at")) != line["key"]):
                continue
            record = history.get("runs", key)
            if not record:
                continue
            if (not _coverage_jobs_passed(record) if item.get("kind") == "nightly"
                    else record.get("conclusion") != "success"):
                continue
            summary = {k: item.get(k) for k in ("artifact", "run_id", "created_at", "sha", "kind", "totals")}
            summary["language"] = language
            summaries = {row.get("artifact"): row for row in record.get("coverage_summaries", [])}
            summaries[summary["artifact"]] = summary
            updated = sorted(summaries.values(), key=lambda row: (row.get("created_at") or "", row.get("artifact") or ""))
            if updated != record.get("coverage_summaries", []):
                record["coverage_summaries"] = updated
                history.put("runs", record)


def _daily_coverage_history(history, line, lines):
    """Latest complete coverage result per Beijing calendar day and language."""
    daily = {}
    for key, index in history.rows("runs"):
        if (index.get("event") in PR_EVENTS
                or line_of(index.get("branch"), lines, index.get("created_at")) != line["key"]):
            continue
        record = history.get("runs", key)
        for item in (record or {}).get("coverage_summaries", []):
            if (not _coverage_jobs_passed(record) if item.get("kind") == "nightly"
                    else record.get("conclusion") != "success"):
                continue
            created_at, language = item.get("created_at"), item.get("language")
            if not created_at or language not in ("node", "python"):
                continue
            day = date(created_at).astimezone(COVERAGE_TIMEZONE).date().isoformat()
            candidate = {**item, "day": day, "attempt": record.get("attempt")}
            identity = (language, day)
            previous = daily.get(identity)
            if not previous or (candidate["created_at"], candidate.get("artifact") or "") > (previous["created_at"], previous.get("artifact") or ""):
                daily[identity] = candidate
    return {
        language: sorted((row for (lang, _), row in daily.items() if lang == language), key=lambda row: row["day"])
        for language in ("node", "python")
    }


def _coverage_artifact_eligible(artifact, owner):
    """Nightly coverage can survive an unrelated failure; main CI must pass."""
    name = artifact.get("name") or ""
    if not name.startswith(("node-coverage-summary-", "python-coverage-summary-")):
        return True
    if (owner and owner.get("event") in PR_EVENTS) or "-pr-" in name:
        return True
    if "-nightly-" in name:
        return bool(owner and _coverage_jobs_passed(owner))
    return bool(owner and owner.get("conclusion") == "success")


class _SharedListings:
    """One artifact listing per build, however many branch lines read it."""
    def __init__(self, gh):
        self.gh, self.pages = gh, {}

    def __getattr__(self, name):
        return getattr(self.gh, name)

    def paginate(self, path, params=None, **kw):
        key = encode([path, params, kw])
        if key not in self.pages:
            self.pages[key] = self.gh.paginate(path, params, **kw)
        return self.pages[key]


def _stored_ci(history, index):
    """collect_ci's GitHub reads answered from the stored runs of one line."""
    class StoredCI:
        def get(self, path, params=None):
            if path.endswith("/actions/workflows"):
                return {"workflows": list({r["workflow_id"]: {"id": r["workflow_id"], "name": r["name"], "html_url": r["url"]} for r in index.values()}.values())}
            ident = path.split("/runs/")[1].split("/")[0]
            row = index.get(int(ident))
            record = history.get("runs", history_key(row)) if row else None
            return {"jobs": [{**j, "html_url": j["url"], "steps": [{"name": s, "conclusion": "failure"} for s in j.get("failed_steps", [])]} for j in (record or {}).get("jobs", [])]}
        def paginate(self, *_a, **_kw):
            return [{**r, "head_branch": r["branch"], "head_sha": r["sha"], "run_attempt": r["attempt"],
                     "html_url": r["url"], "run_started_at": r.get("started_at"), "display_title": r.get("title")}
                    for r in sorted(index.values(), key=lambda r: (r["created_at"], r["id"]), reverse=True)]
    return StoredCI()


def _executed(runs):
    latest_reports = {}
    for r in runs:
        for t in r["tests"]:
            latest_reports.setdefault(t["name"], (r, t))
    return [{"artifact": t["name"], "layer": "ut" if t["layer"] == "unit" else t["layer"],
             "status": "incomplete" if t.get("counts") is None else "failed" if t["counts"]["failed"] else "unstable" if t["counts"]["flaky"] or t["counts"]["skipped"] else "passed",
             "run_id": r["id"], "sha": r["sha"], "attempt": r["attempt"], "branch": r["branch"], "created_at": r["updated_at"],
             "url": t.get("url"), "scores": t.get("scores", []),
             "totals": t.get("counts"), "duration_ms": None, "detail": {"files": [], "failures": [], "projects": [], "stats": {}}}
            for r, t in latest_reports.values()]


def build_snapshot(sync):
    history, state, meta = sync.history, sync.state, sync.meta
    old = read_json(history.root / "site/data/snapshot.json", {})
    supplements = read_json(history.root / ".sync/supplements.json", {})
    midnight = sync.now.replace(hour=0, minute=0, second=0)
    cutoff = stamp(midnight - timedelta(days=30))
    progress = sync.progress()
    lines = configured_lines(sync.settings, meta["default_branch"])
    # A successful poll with no changed records does not manufacture a Pages
    # deployment. Daily aging and health metadata still get a regular refresh.
    cache_upgrade = supplements.get("tests_version") != SUPPLEMENT_TESTS_VERSION
    # Snapshots published before the CI lanes, tagged tests, the current
    # branch lines, complete lane set or run times on the lanes are rebuilt once.
    old_ci = ((old.get("sections") or {}).get("ci") or {}).get("data") or {}
    old_tests = ((old.get("sections") or {}).get("tests") or {}).get("data")
    cache_upgrade = (cache_upgrade or "lanes" not in old_ci or (isinstance(old_tests, dict) and "tagged" not in old_tests)
                     or old.get("lines") != lines
                     or any("median_duration_s" not in lane.get("summary", {}) for lane in old_ci["lanes"].get("lanes", [])))
    # Snapshots from before the Issue / PR trend charts are rebuilt once (without refreshing test data).
    trend_upgrade = any(isinstance(((old.get("sections") or {}).get(kind) or {}).get("data"), dict)
                        and "trend" not in old["sections"][kind]["data"] for kind in ("issues", "prs"))
    lanes_upgrade = False
    for line in lines:
        sections = old.get("sections", {}) if line["default"] else old.get("line_sections", {}).get(line["key"], {})
        view = ((sections.get("ci") or {}).get("data") or {}).get("lanes") or {}
        lanes_upgrade = lanes_upgrade or [lane["key"] for lane in view.get("lanes", [])] != [key for key, _ in LANES]
    # Reprojecting stored run categories must not invalidate test-artifact caches.
    if (not history.changed and not sync.tagged.changed and not cache_upgrade and not lanes_upgrade and not trend_upgrade and old.get("sync") == progress
            and old.get("generated_at", "")[:10] == stamp(midnight)[:10]):
        return old
    cfg = sync.cfg
    cfg.stale_days = int(sync.settings.get("stale_days", 30))
    cfg.review_sla_days = int(sync.settings.get("review_sla_days", 3))
    def aged(rows):
        for row in rows:
            row["age_days"] = days_between(midnight, row.get("created_at"))
            row["idle_days"] = days_between(midnight, row.get("updated_at"))
        return rows
    open_issues = aged(history.select("issues", lambda r: r["state"] == "open"))
    closed_issues = aged(history.select("issues", lambda r: r["state"] == "closed" and (r.get("closed_at") or "") >= cutoff))
    open_prs = aged(history.select("prs", lambda r: r["state"] == "open"))
    closed_prs = aged(history.select("prs", lambda r: r["state"] == "closed" and (r.get("closed_at") or "") >= cutoff))
    counts = {"closed_total": history.aggregate.get("issues:state:closed", 0)}
    for days in (7, 30):
        lo = stamp(midnight - timedelta(days=days))[:10]
        for label, field in (("opened", "created_at"), ("closed", "closed_at")):
            prefix = "issues:" + field + ":"
            counts[f"{label}_{days}d"] = sum(v for k, v in history.aggregate.items() if k.startswith(prefix) and k[len(prefix):] >= lo)
    labels = {label["name"]: label for issue in open_issues for label in issue.get("labels", [])}
    issues = summarize_issues(open_issues, closed_issues, list(labels.values()), counts, cfg)
    prs = summarize_prs(open_prs, closed_prs, cfg, midnight)
    # The ordinary tabs/board show current work; archived objects are retrieved
    # by shard in History. Never prune canonical records when creating previews.
    issues["preview_total"] = len(issues["items"])
    prs["preview_total"] = len(prs["items"])
    # Daily flow for the trend charts comes from the aggregate's day counts, not from the records.
    for kind, data in (("issues", issues), ("prs", prs)):
        data["trend"] = daily_trend(history.aggregate, kind, stamp(sync.now)[:10],
                                    complete=progress["backfill"].get(kind, {}).get("complete", False))
    issues["items"] = issues["items"][:200]
    issues["closed_recent"] = issues["closed_recent"][:100]
    prs["items"] = prs["items"][:200]

    # Index rows written before runs kept their linked PRs, and PRs their
    # branches, are rebuilt from the records once.
    for kind, fields in (("runs", ("event", "pull_requests")), ("prs", ("base",))):
        for key, row in list(history.rows(kind)):
            if any(field not in row for field in fields):
                history.reindex(kind, key)
    # Historical attempts remain in History. Current quality cards and CI rates
    # use the latest attempt for each run to avoid double counting reruns.
    index = {}
    for key, row in history.rows("runs"):
        previous = index.get(row["id"])
        if not previous or row["attempt"] > previous["attempt"]:
            index[row["id"]] = row
    all_prs = [row for _, row in history.rows("prs")]
    by_number = {row.get("number"): row for row in all_prs}
    run_line = {ident: line_of(target_of(row, all_prs, by_number), lines, row.get("created_at")) for ident, row in index.items()}
    def project_run(row):
        if row.get("event") in PR_EVENTS:
            return row
        branch = canonical_branch(row.get("branch"), lines, row.get("created_at"))
        return {**row, "branch": branch} if branch != row.get("branch") else row

    def artifact_line(artifact):
        owner = index.get(artifact.get("run_id"))
        destination = run_line.get(artifact.get("run_id")) or line_of(artifact.get("branch"), lines, artifact.get("created_at"))
        if owner and owner.get("event") not in PR_EVENTS:
            artifact["branch"] = canonical_branch(owner.get("branch"), lines, owner.get("created_at"))
        elif not owner:
            artifact["branch"] = canonical_branch(artifact.get("branch"), lines, artifact.get("created_at"))
        # Artifacts of runs older than the history fall back to their branch.
        return destination

    def coverage_owner(artifact):
        matched = _coverage_run(history, artifact.get("run_id"), artifact.get("created_at"))
        return history.get("runs", matched[0]) if matched else None

    wrap = lambda data: {"status": "ok", "data": data, "notes": [], "error": None}
    day = stamp(midnight)[:10]
    day_changed = supplements.get("day") != day
    gh = _SharedListings(sync.gh.gh)
    # Coverage summaries read by earlier builds are not downloaded again.
    store = CoverageStore(read_json(history.root / ".sync/coverage.json", None),
                          read_json(history.root / ".sync/coverage-sources.json", None))
    lines_read = 0
    start = stamp(window_start(sync.now))
    lane_prs = [history.get("prs", str(row["number"])) for row in all_prs if not row.get("closed_at") or row["closed_at"] >= start]
    refreshed = day_changed or "ops" not in supplements
    if refreshed:
        # Repository operations are intentionally a daily snapshot.
        supplements["ops"] = envelope(lambda: public_ops(Context(gh, cfg, midnight, meta)))
    views = {}
    for line in lines:
        key = line["key"]
        line_meta = {**meta, "default_branch": line["ref"]}
        line_index = {ident: project_run(row) for ident, row in index.items() if run_line[ident] == key}
        ci = collect_ci(Context(_stored_ci(history, line_index), cfg, midnight, line_meta))
        # Lanes read complete records (event, linked PRs, head repository) for the
        # displayed window only, plus the PRs that were open during it. Each
        # line keeps the same five lanes, including manually dispatched Nightly.
        lane_runs = [project_run(history.get("runs", history_key(row)) or index[row["id"]]) for row in line_index.values() if (row.get("created_at") or "") >= start]
        ci["lanes"] = build_lanes(lane_runs, default_branch=line["ref"], now=sync.now,
                                  rules=sync.settings.get("workflows"), prs=[pr for pr in lane_prs if pr],
                                  lanes=tuple((key, line["ref"] if key == "main" and not line["default"] else label)
                                              for key, label in LANES),
                                  collected_since=None if progress["backfill"].get("runs", {}).get("complete")
                                  else min((row["created_at"] for row in index.values()), default=None))
        runs = [project_run(row) for row in history.select("runs", lambda r, key=key: run_line.get(r["id"]) == key and r["attempt"] == index[r["id"]]["attempt"], limit=100)]
        ci["gates"] = gate_summary(runs)
        for run in runs:
            for report in run.get("tests", []):
                report["cases"] = []  # old renderer contract; no testcase records
        # The default line keeps the supplement keys it always had.
        cache = supplements if line["default"] else supplements.setdefault("lines", {}).setdefault(key, {})
        tests_revision = _tests_revision(runs)
        if day_changed or cache_upgrade or cache.get("tests_revision") != tests_revision or "tests" not in cache:
            # Actions artifacts are live evidence: refresh when the line's run set
            # changes, while retaining the daily fallback for repository-tree data.
            fresh = envelope(lambda: public_tests(Context(gh, cfg, midnight, line_meta, coverage_store=store), runs,
                                                  owns=lambda artifact, key=key: artifact_line(artifact) == key,
                                                  coverage_eligible=lambda artifact: _coverage_artifact_eligible(
                                                      artifact, coverage_owner(artifact))))
            # A failed read (e.g. an exhausted API quota) keeps the last good
            # evidence and is retried by the next build.
            if fresh["status"] != "error" or (cache.get("tests") or {}).get("status") in (None, "error"):
                cache["tests"] = fresh
                cache["tests_revision"] = tests_revision if fresh["status"] != "error" else None
                refreshed = True
            lines_read += fresh["status"] != "error"
        tests = deepcopy(cache.get("tests", wrap({})))
        if isinstance(tests.get("data"), dict):
            tests["data"]["tagged"] = sync.tagged.view(line["ref"])
        coverage = (tests.get("data") or {}).get("coverage") or {}
        _persist_coverage_summaries(history, coverage, line, lines)
        daily_coverage = _daily_coverage_history(history, line, lines)
        for language, dataset in (coverage.get("languages") or {}).items():
            dataset["history"] = daily_coverage.get(language, [])
        if tests.get("data"):
            # Refresh test metrics without re-fetching the repository tree/Codecov.
            tests["data"]["executed"] = _executed(runs)
            daily = history.select("runs", lambda r, key=key: r.get("channel") == "daily"
                                   and run_line.get(r["id"]) == key, limit=120)
            # The current CI window is capped at 100 runs and can lose yesterday's
            # readable report during a busy day. Score cards use the same durable
            # Daily history as their curves.
            tests["data"]["score_report"] = latest_score_report(daily)
            tests["data"]["score_history"] = score_history(daily)
            tests["data"]["score_runs"] = [dict(run_id=r["id"], attempt=r.get("attempt", 1), branch=r.get("branch"),
                created_at=r.get("created_at"), url=r.get("url"), event=r.get("event"), conclusion=r.get("conclusion"),
                duration_s=r.get("duration_s"), artifact_status=next((t.get("status") for t in r.get("tests", [])
                    if t.get("name", "").startswith("real-e2e-results")), "missing")) for r in daily_score_runs(daily)]
        for row in history.select("runs", lambda r, key=key: bool(r.get("channel")) and run_line.get(r["id"]) == key, limit=100):
            if row.get("coverage") and tests.get("data") and not tests["data"].get("coverage", {}).get("languages"):
                tests["data"]["coverage"].update(source=f"Actions run {row['id']} / attempt {row['attempt']}", value=row["coverage"][0])
                break
        views[key] = {"ci": wrap(ci), "tests": tests, "runs": runs}
    # Every line read its coverage in this build, so what none of them read can go.
    store.finish(sync.now, complete=lines_read == len(lines))
    if store.changed:
        history.changed[".sync/coverage.json"] = encode(store.state)
    if store.sources_changed:
        history.changed[".sync/coverage-sources.json"] = encode(store.sources)
    if refreshed:
        supplements.update(day=day, tests_version=SUPPLEMENT_TESTS_VERSION)
        state["supplements_changed"] = True
        history.changed[".sync/supplements.json"] = encode(supplements)
    main = views[lines[0]["key"]]
    runs = main["runs"]
    releases = history.select("releases", limit=30)
    for release in releases:
        release["validation_run_ids"] = [r["id"] for r in runs if r["sha"] == release["sha"] and r["channel"] == "release"]
    repo = {k: meta.get(k) for k in ("description", "default_branch", "language", "pushed_at")}
    repo.update(stars=meta.get("stargazers_count"), forks=meta.get("forks_count"), license=(meta.get("license") or {}).get("spdx_id"))
    doc = {"schema_version": 2, "generated_at": stamp(sync.now), "repo": sync.repo, "repo_url": meta["html_url"],
           "repository": {"name": sync.repo, "url": meta["html_url"], **repo}, "sync": progress,
           "history": {"manifest": "./data/history/manifest.json", "totals": history.manifest["totals"]},
           "issues": issues, "prs": prs, "quality": {"runs": runs, "required_checks": old.get("quality", {}).get("required_checks"),
               "workflows": main["ci"]["data"]["workflows"], "status": "available"}, "releases": releases, "notices": [],
           "sections": {"repo": wrap(repo), "issues": wrap(issues), "prs": wrap(prs), "ci": main["ci"],
                        "tests": main["tests"], "ops": supplements.get("ops", wrap({}))},
           # The CI, test and coverage pages switch lines; sections hold the default one.
           "lines": lines,
           "line_sections": {line["key"]: {name: views[line["key"]][name] for name in ("ci", "tests")} for line in lines[1:]},
           "config": {"artifact_names": cfg.artifact_names, "stale_days": cfg.stale_days, "review_sla_days": cfg.review_sla_days, "pr_idle_days": cfg.pr_idle_days}}
    doc["board"] = BoardStore(cfg, persist=False).payload(doc)
    doc["details"] = {f"{kind}:{r['number']}": {"body": r.get("body", ""), "cross_references": []}
                      for kind, rows in (("issue", issues["items"] + issues["closed_recent"]), ("pr", prs["items"] + prs["recent_merged"] + prs["recent_closed_unmerged"])) for r in rows}
    return doc


def history_key(row):
    return f"{row['id']}-{row['attempt']}"
