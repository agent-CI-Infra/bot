"""Lightweight current views backed by the complete public history.

Only generic GitHub data is shown: Issues, pull requests, workflow runs and their jobs, releases, and
the repository's public maintenance views. Nothing depends on how a repository lays out its CI (#938).
"""
from datetime import timedelta

from .board import BoardStore
from .collectors import Context, collect_ci, summarize_issues, summarize_prs, days_between
from .history import read_json, encode
from .lines import PR_EVENTS, canonical_branch, configured_lines, line_of, target_of
from .work_trend import daily_trend
from .public_sections import public_ops, envelope
from .sync import stamp


# 2: before #938 (lanes, gates, tests and coverage). 3: generic sections only.
SCHEMA_VERSION = 3


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


def build_snapshot(sync):
    history, state, meta = sync.history, sync.state, sync.meta
    old = read_json(history.root / "site/data/snapshot.json", {})
    supplements = read_json(history.root / ".sync/supplements.json", {})
    midnight = sync.now.replace(hour=0, minute=0, second=0)
    cutoff = stamp(midnight - timedelta(days=30))
    progress = sync.progress()
    lines = configured_lines(sync.settings, meta["default_branch"])
    # A successful poll with no changed records does not manufacture a new snapshot. Daily aging and
    # health metadata still get a regular refresh, and an older layout is rebuilt once.
    if (not history.changed and old.get("schema_version") == SCHEMA_VERSION and old.get("lines") == lines
            and old.get("sync") == progress and old.get("generated_at", "")[:10] == stamp(midnight)[:10]):
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
    # Historical attempts remain in History. CI rates use the latest attempt
    # of each run to avoid double counting reruns.
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

    wrap = lambda data: {"status": "ok", "data": data, "notes": [], "error": None}
    day = stamp(midnight)[:10]
    if supplements.get("day") != day or "ops" not in supplements:
        # Repository operations are intentionally a daily snapshot.
        supplements["ops"] = envelope(lambda: public_ops(Context(sync.gh.gh, cfg, midnight, meta)))
        supplements = {"day": day, "ops": supplements["ops"]}
        state["supplements_changed"] = True
        history.changed[".sync/supplements.json"] = encode(supplements)
    views = {}
    for line in lines:
        key = line["key"]
        line_meta = {**meta, "default_branch": line["ref"]}
        line_index = {ident: project_run(row) for ident, row in index.items() if run_line[ident] == key}
        ci = collect_ci(Context(_stored_ci(history, line_index), cfg, midnight, line_meta))
        runs = [project_run(row) for row in history.select("runs", lambda r, key=key: run_line.get(r["id"]) == key and r["attempt"] == index[r["id"]]["attempt"], limit=100)]
        views[key] = {"ci": wrap(ci), "runs": runs}
    main = views[lines[0]["key"]]
    runs = main["runs"]
    releases = history.select("releases", limit=30)
    for release in releases:
        release["validation_run_ids"] = [r["id"] for r in runs if r["sha"] == release["sha"] and r["channel"] == "release"]
    repo = {k: meta.get(k) for k in ("description", "default_branch", "language", "pushed_at")}
    repo.update(stars=meta.get("stargazers_count"), forks=meta.get("forks_count"), license=(meta.get("license") or {}).get("spdx_id"))
    doc = {"schema_version": SCHEMA_VERSION, "generated_at": stamp(sync.now), "repo": sync.repo, "repo_url": meta["html_url"],
           "repository": {"name": sync.repo, "url": meta["html_url"], **repo}, "sync": progress,
           "history": {"manifest": "./data/history/manifest.json", "totals": history.manifest["totals"]},
           "issues": issues, "prs": prs, "quality": {"runs": runs, "required_checks": old.get("quality", {}).get("required_checks"),
               "workflows": main["ci"]["data"]["workflows"], "status": "available"}, "releases": releases, "notices": [],
           "sections": {"repo": wrap(repo), "issues": wrap(issues), "prs": wrap(prs), "ci": main["ci"],
                        "ops": supplements.get("ops", wrap({}))},
           # The CI page switches lines; sections hold the default one.
           "lines": lines,
           "line_sections": {line["key"]: {"ci": views[line["key"]]["ci"]} for line in lines[1:]},
           "config": {"stale_days": cfg.stale_days, "review_sla_days": cfg.review_sla_days, "pr_idle_days": cfg.pr_idle_days}}
    doc["board"] = BoardStore(cfg, persist=False).payload(doc)
    doc["details"] = {f"{kind}:{r['number']}": {"body": r.get("body", ""), "cross_references": []}
                      for kind, rows in (("issue", issues["items"] + issues["closed_recent"]), ("pr", prs["items"] + prs["recent_merged"] + prs["recent_closed_unmerged"])) for r in rows}
    return doc


def history_key(row):
    return f"{row['id']}-{row['attempt']}"
