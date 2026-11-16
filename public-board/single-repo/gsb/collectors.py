"""Section collectors. Each ``collect_*`` returns a plain dict for the UI.

Every collector receives a ``Context`` and may raise ``GitHubError``; the caller
turns that into a section-level error envelope. Inside a collector, optional
sub-queries (security alerts, traffic, search counts, ...) catch their own
errors and record them in ``notes`` so one missing scope only degrades the
piece that needs it.
"""

from __future__ import annotations

import re
import statistics
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .config import Config
from .github import GitHub, GitHubError


def _try(fn, *args):
    """Run ``fn`` and return ``(result, None)`` or ``(None, GitHubError)``; used inside thread pools
    so one failed call does not abort the others."""
    try:
        return fn(*args), None
    except GitHubError as err:
        return None, err


@dataclass
class Context:
    gh: GitHub
    cfg: Config
    now: datetime
    repo_meta: dict = field(default_factory=dict)

    @property
    def repo(self) -> str:
        return self.cfg.repo

    @property
    def default_branch(self) -> str:
        return self.repo_meta.get("default_branch") or "main"


# ------------------------------------------------------------------ helpers
def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def days_between(later: datetime, earlier: str | None) -> float | None:
    dt = parse_ts(earlier)
    if dt is None:
        return None
    return round((later - dt).total_seconds() / 86400, 1)


def note(notes: list, key: str, err: GitHubError | Exception, what: str) -> None:
    payload = err.to_dict() if isinstance(err, GitHubError) else {"kind": "error", "message": str(err), "hint": ""}
    payload.update({"key": key, "what": what})
    notes.append(payload)


def _user(obj: dict | None) -> str | None:
    return (obj or {}).get("login")


def _labels(items: list | None) -> list[dict]:
    return [{"name": l.get("name"), "color": l.get("color")} for l in (items or [])]


# ----------------------------------------------------------------- issues
def _slim_issue(item: dict, now: datetime) -> dict:
    return {
        "body": (item.get("body") or "")[:50000],
        "number": item.get("number"),
        "title": item.get("title"),
        "url": item.get("html_url"),
        "state": item.get("state"),
        "author": _user(item.get("user")),
        "labels": _labels(item.get("labels")),
        "assignees": [_user(a) for a in item.get("assignees") or []],
        "milestone": (item.get("milestone") or {}).get("title"),
        "comments": item.get("comments", 0),
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "closed_at": item.get("closed_at"),
        "age_days": days_between(now, item.get("created_at")),
        "idle_days": days_between(now, item.get("updated_at")),
        "reactions": (item.get("reactions") or {}).get("total_count", 0),
    }


def summarize_issues(issues, closed_recent, catalog, counts, cfg, notes=None, truncated=False):
    label_counts: Counter = Counter()
    for issue in issues:
        for label in issue["labels"]:
            label_counts[label["name"]] += 1
    color_of = {l.get("name"): l.get("color") for l in catalog}
    labels = [{"name": name, "count": count, "color": color_of.get(name)} for name, count in label_counts.most_common()]
    unused_labels = sorted(set(color_of) - set(label_counts))

    buckets = [("<7d", 0, 7), ("7-30d", 7, 30), ("30-90d", 30, 90), (">90d", 90, None)]
    aging = []
    for label, lo, hi in buckets:
        n = sum(1 for i in issues if i["age_days"] is not None and i["age_days"] >= lo and (hi is None or i["age_days"] < hi))
        aging.append({"bucket": label, "count": n})

    stale = [i for i in issues if (i["idle_days"] or 0) >= cfg.stale_days]
    unassigned = [i for i in issues if not i["assignees"]]
    unlabeled = [i for i in issues if not i["labels"]]
    no_response = [i for i in issues if i["comments"] == 0]
    assignee_load = Counter(a for i in issues for a in i["assignees"])
    milestone_load = Counter(i["milestone"] or "(无里程碑)" for i in issues)
    ages = [i["age_days"] for i in issues if i["age_days"] is not None]

    return {
        "notes": notes,
        "open_count": len(issues),
        "truncated": truncated,
        "counts": counts,
        "median_age_days": round(statistics.median(ages), 1) if ages else None,
        "oldest_age_days": max(ages) if ages else None,
        "stale_days_threshold": cfg.stale_days,
        "stale_count": len(stale),
        "unassigned_count": len(unassigned),
        "unlabeled_count": len(unlabeled),
        "no_response_count": len(no_response),
        "labels": labels,
        "unused_labels": unused_labels,
        "aging": aging,
        "assignee_load": [{"login": k, "count": v} for k, v in assignee_load.most_common()],
        "milestones": [{"name": k, "count": v} for k, v in milestone_load.most_common()],
        "recent": sorted(issues, key=lambda i: i["updated_at"] or "", reverse=True)[:15],
        "oldest": sorted(issues, key=lambda i: i["created_at"] or "")[:10],
        "stale": sorted(stale, key=lambda i: -(i["idle_days"] or 0))[:20],
        "items": issues,
        "closed_recent": closed_recent,
    }


# -------------------------------------------------------------------- prs
PR_GRAPHQL = """
query($owner:String!, $name:String!, $first:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequests(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number isDraft reviewDecision mergeable
        reviews(last: 30) { nodes { author { login } state submittedAt } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state
          contexts(first: 40) { nodes { __typename
            ... on CheckRun { name conclusion status detailsUrl }
            ... on StatusContext { context state targetUrl } } } } } } }
      }
    }
  }
}
"""


LINK_RE = re.compile(r"#(\d+)")
BRANCH_ISSUE_RE = re.compile(r"(?:^|[/-])issue[-_ ]?(\d+)", re.I)


def _linked_issues(item: dict) -> list[int]:
    """Issue numbers a PR refers to: `#N` in title/body plus `issue-N` in the branch name."""
    text = f"{item.get('title') or ''}\n{item.get('body') or ''}"
    found = {int(n) for n in LINK_RE.findall(text)}
    found.update(int(n) for n in BRANCH_ISSUE_RE.findall((item.get("head") or {}).get("ref") or ""))
    found.discard(item.get("number"))
    return sorted(found)


def _slim_pr(item: dict, now: datetime) -> dict:
    return {
        "body": (item.get("body") or "")[:50000],
        "linked_issues": _linked_issues(item),
        "number": item.get("number"),
        "title": item.get("title"),
        "url": item.get("html_url"),
        "state": item.get("state"),
        "draft": bool(item.get("draft")),
        "author": _user(item.get("user")),
        "labels": _labels(item.get("labels")),
        "assignees": [_user(a) for a in item.get("assignees") or []],
        "requested_reviewers": [_user(r) for r in item.get("requested_reviewers") or []],
        "base": (item.get("base") or {}).get("ref"),
        "head": (item.get("head") or {}).get("ref"),
        "head_repo": ((item.get("head") or {}).get("repo") or {}).get("full_name"),
        "head_sha": (item.get("head") or {}).get("sha"),
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "merged_at": item.get("merged_at"),
        "closed_at": item.get("closed_at"),
        "age_days": days_between(now, item.get("created_at")),
        "idle_days": days_between(now, item.get("updated_at")),
        "comments": item.get("comments", 0),
        "review_decision": None,
        "mergeable": None,
        "reviews": [],
        "ci": {"state": None, "checks": []},
    }


def _enrich_prs_graphql(ctx: Context, prs: list[dict]) -> None:
    data = ctx.gh.graphql(PR_GRAPHQL, {"owner": ctx.cfg.owner, "name": ctx.cfg.name, "first": min(max(len(prs), 1), 100)})
    nodes = (((data or {}).get("repository") or {}).get("pullRequests") or {}).get("nodes") or []
    by_number = {n["number"]: n for n in nodes}
    for pr in prs:
        node = by_number.get(pr["number"])
        if not node:
            continue
        pr["review_decision"] = node.get("reviewDecision") or "NONE"
        pr["mergeable"] = node.get("mergeable")
        pr["reviews"] = [{"author": _user(r.get("author")), "state": r.get("state"), "submitted_at": r.get("submittedAt")}
                         for r in (node.get("reviews") or {}).get("nodes") or []]
        commits = (node.get("commits") or {}).get("nodes") or []
        rollup = ((commits[0].get("commit") or {}).get("statusCheckRollup") if commits else None) or {}
        checks = []
        for c in (rollup.get("contexts") or {}).get("nodes") or []:
            if c.get("__typename") == "CheckRun":
                checks.append({"name": c.get("name"), "conclusion": (c.get("conclusion") or c.get("status") or "").lower(), "url": c.get("detailsUrl")})
            else:
                checks.append({"name": c.get("context"), "conclusion": (c.get("state") or "").lower(), "url": c.get("targetUrl")})
        pr["ci"] = {"state": (rollup.get("state") or "").lower() or None, "checks": checks}


def summarize_prs(prs, closed, cfg, now, notes=None):
    merged = [p for p in closed if p["merged_at"]]
    cutoff = now - timedelta(days=30)
    merged_30d = [p for p in merged if (parse_ts(p["merged_at"]) or cutoff) >= cutoff]
    closed_unmerged_30d = [p for p in closed if not p["merged_at"] and (parse_ts(p["closed_at"]) or cutoff) >= cutoff]
    ttm, ttm_human = [], []
    for p in merged:
        a, b = parse_ts(p["created_at"]), parse_ts(p["merged_at"])
        if a and b:
            p["time_to_merge_h"] = round((b - a).total_seconds() / 3600, 2)
            ttm.append(p["time_to_merge_h"])
            if not (p["author"] or "").endswith("[bot]"):
                ttm_human.append(p["time_to_merge_h"])  # bots merge instantly and would hide the human latency

    def waiting(pr: dict) -> bool:
        if pr["draft"] or pr["review_decision"] == "APPROVED":
            return False
        last_review = max((r["submitted_at"] or "" for r in pr["reviews"]), default="")
        last_touch = parse_ts(last_review) or parse_ts(pr["created_at"])
        return last_touch is not None and (now - last_touch).days >= cfg.review_sla_days

    for pr in prs:
        pr["waiting_review"] = waiting(pr)

    reviewer_load: Counter = Counter()
    for pr in prs:
        for r in pr["requested_reviewers"]:
            reviewer_load[r] += 1
        for r in pr["reviews"]:
            if r["author"] and r["author"] != pr["author"]:
                reviewer_load[r["author"]] += 1
    authors = Counter(p["author"] for p in prs + closed if p["author"])
    ci_states = Counter(p["ci"]["state"] or "unknown" for p in prs)
    decisions = Counter(p["review_decision"] or "NONE" for p in prs)

    return {
        "notes": notes,
        "open_count": len(prs),
        "draft_count": sum(1 for p in prs if p["draft"]),
        "waiting_review_count": sum(1 for p in prs if p["waiting_review"]),
        "review_sla_days": cfg.review_sla_days,
        "ci_states": dict(ci_states),
        "review_decisions": dict(decisions),
        "merged_30d": len(merged_30d),
        "closed_unmerged_30d": len(closed_unmerged_30d),
        "median_time_to_merge_h": round(statistics.median(ttm), 2) if ttm else None,
        "p90_time_to_merge_h": round(sorted(ttm)[int(len(ttm) * 0.9) - 1], 2) if len(ttm) >= 2 else None,
        "median_time_to_merge_h_human": round(statistics.median(ttm_human), 2) if ttm_human else None,
        "merged_human_count": len(ttm_human),
        "reviewer_load": [{"login": k, "count": v} for k, v in reviewer_load.most_common()],
        "authors": [{"login": k, "count": v} for k, v in authors.most_common(15)],
        "items": prs,
        "recent_merged": sorted(merged, key=lambda p: p["merged_at"] or "", reverse=True)[:15],
        "recent_closed_unmerged": sorted(closed_unmerged_30d, key=lambda p: p["closed_at"] or "", reverse=True)[:10],
    }


# --------------------------------------------------------------------- ci
def _slim_run(r: dict, now: datetime) -> dict:
    started, updated = parse_ts(r.get("run_started_at")), parse_ts(r.get("updated_at"))
    duration = round((updated - started).total_seconds()) if started and updated and r.get("status") == "completed" else None
    return {
        "id": r.get("id"), "name": r.get("name"), "workflow_id": r.get("workflow_id"),
        "title": r.get("display_title"), "status": r.get("status"), "conclusion": r.get("conclusion"),
        "branch": r.get("head_branch"), "event": r.get("event"), "url": r.get("html_url"),
        "actor": _user(r.get("actor")), "sha": (r.get("head_sha") or "")[:7],
        "created_at": r.get("created_at"), "duration_s": duration, "attempt": r.get("run_attempt"),
        "age_days": days_between(now, r.get("created_at")),
    }


def collect_ci(ctx: Context) -> dict:
    gh, repo, cfg, now = ctx.gh, ctx.repo, ctx.cfg, ctx.now
    notes: list = []
    default = ctx.default_branch
    workflows = gh.get(f"/repos/{repo}/actions/workflows").get("workflows", [])
    runs_raw = gh.paginate(f"/repos/{repo}/actions/runs", {"per_page": 100}, max_pages=cfg.run_pages, key="workflow_runs")
    runs = [_slim_run(r, now) for r in runs_raw]
    week_ago = now - timedelta(days=7)

    def rate(items: list[dict]) -> dict:
        decided = [r for r in items if r["conclusion"] in ("success", "failure", "timed_out")]
        ok = sum(1 for r in decided if r["conclusion"] == "success")
        durations = [r["duration_s"] for r in decided if r["duration_s"]]
        return {
            "total": len(items),
            "success": ok,
            "failure": len(decided) - ok,
            "cancelled": sum(1 for r in items if r["conclusion"] == "cancelled"),
            "in_progress": sum(1 for r in items if r["status"] != "completed"),
            "success_rate": round(ok * 100 / len(decided), 1) if decided else None,
            "median_duration_s": int(statistics.median(durations)) if durations else None,
            "p90_duration_s": int(statistics.quantiles(durations, n=10, method="inclusive")[8]) if len(durations) > 1 else (durations[0] if durations else None),
        }

    per_workflow = []
    for wf in workflows:
        wf_runs = [r for r in runs if r["workflow_id"] == wf.get("id")]
        main_runs = [r for r in wf_runs if r["branch"] == default and r["event"] != "pull_request"]
        pr_runs = [r for r in wf_runs if r["event"] == "pull_request"]
        per_workflow.append({
            "id": wf.get("id"), "name": wf.get("name"), "path": wf.get("path"), "state": wf.get("state"),
            "url": wf.get("html_url"),
            "all": rate(wf_runs), "main": rate(main_runs), "pull_request": rate(pr_runs),
            "failures_7d": sum(1 for r in wf_runs if r["conclusion"] == "failure" and (parse_ts(r["created_at"]) or week_ago) >= week_ago),
            "last_run": wf_runs[0] if wf_runs else None,
            "last_main_run": main_runs[0] if main_runs else None,
        })

    main_timeline = [r for r in runs if r["branch"] == default and r["event"] != "pull_request"][:40]
    streak = 0
    for r in main_timeline:
        if r["conclusion"] == "failure":
            streak += 1
        elif r["conclusion"] in ("success", "timed_out"):
            break

    # Job-level health over the latest completed default-branch runs. The per-run job lists are
    # independent, so they are fetched concurrently (this used to be the slowest part of a refresh).
    jobs_by_name: dict[str, dict] = {}
    inspected = 0
    latest_main_jobs = None
    sample = [x for x in main_timeline if x["status"] == "completed"][:cfg.job_history_runs]

    def fetch_jobs(run: dict):
        return gh.get(f"/repos/{repo}/actions/runs/{run['id']}/jobs", {"per_page": 100}).get("jobs", [])

    with ThreadPoolExecutor(max_workers=6) as pool:
        job_results = list(pool.map(lambda run: _try(fetch_jobs, run), sample))
    for r, (jobs, err) in zip(sample, job_results):
        if err is not None:
            note(notes, f"jobs:{r['id']}", err, f"run {r['id']} 的 job 列表")
            continue
        inspected += 1
        slim_jobs = []
        for j in jobs:
            s, e = parse_ts(j.get("started_at")), parse_ts(j.get("completed_at"))
            # Stored jobs keep only their duration; jobs read from GitHub have their times.
            dur = round((e - s).total_seconds()) if s and e else j.get("duration_s")
            failed_steps = [st.get("name") for st in j.get("steps", []) if st.get("conclusion") == "failure"]
            slim_jobs.append({"name": j.get("name"), "conclusion": j.get("conclusion"), "status": j.get("status"),
                              "url": j.get("html_url"), "duration_s": dur, "failed_steps": failed_steps})
            entry = jobs_by_name.setdefault(j.get("name"), {"name": j.get("name"), "runs": 0, "success": 0, "failure": 0,
                                                            "cancelled": 0, "skipped": 0, "durations": [], "last": None,
                                                            "failed_steps": Counter()})
            entry["runs"] += 1
            concl = j.get("conclusion") or "unknown"
            if concl in entry:
                entry[concl] += 1
            if dur:
                entry["durations"].append(dur)
            if entry["last"] is None:
                entry["last"] = {"conclusion": concl, "url": j.get("html_url"), "run_id": r["id"], "created_at": r["created_at"]}
            for st in failed_steps:
                entry["failed_steps"][st] += 1
        if latest_main_jobs is None:
            latest_main_jobs = {"run": r, "jobs": slim_jobs}

    job_health = []
    for entry in jobs_by_name.values():
        decided = entry["success"] + entry["failure"]
        job_health.append({
            "name": entry["name"], "runs": entry["runs"], "success": entry["success"], "failure": entry["failure"],
            "cancelled": entry["cancelled"], "skipped": entry["skipped"],
            "success_rate": round(entry["success"] * 100 / decided, 1) if decided else None,
            "median_duration_s": int(statistics.median(entry["durations"])) if entry["durations"] else None,
            "last": entry["last"],
            "top_failed_steps": [{"step": k, "count": v} for k, v in entry["failed_steps"].most_common(3)],
        })
    job_health.sort(key=lambda j: (j["success_rate"] if j["success_rate"] is not None else 101, j["name"]))

    return {
        "notes": notes,
        "default_branch": default,
        "workflows": per_workflow,
        "runs_sampled": len(runs),
        "overall": rate(runs),
        "main": rate([r for r in runs if r["branch"] == default and r["event"] != "pull_request"]),
        "pull_request": rate([r for r in runs if r["event"] == "pull_request"]),
        "failures_7d": sum(1 for r in runs if r["conclusion"] == "failure" and (parse_ts(r["created_at"]) or week_ago) >= week_ago),
        "red_streak_main": streak,
        "main_timeline": main_timeline,
        "recent_runs": runs[:30],
        "job_history_runs": inspected,
        "job_health": job_health,
        "latest_main": latest_main_jobs,
        "recent_failures": [r for r in runs if r["conclusion"] == "failure"][:15],
    }


# ------------------------------------------------------------ repository operations
def _ops_releases(ctx: Context, notes: list) -> dict:
    gh, repo, now, default = ctx.gh, ctx.repo, ctx.now, ctx.default_branch
    releases = [r for r in gh.paginate(f"/repos/{repo}/releases", {"per_page": 20}, max_pages=1) if not r.get("draft")]
    tags = gh.paginate(f"/repos/{repo}/tags", {"per_page": 30}, max_pages=1)
    rel_list = [{"tag": r.get("tag_name"), "name": r.get("name"), "url": r.get("html_url"), "draft": r.get("draft"),
                 "prerelease": r.get("prerelease"), "published_at": r.get("published_at"), "author": _user(r.get("author")),
                 "assets": [{"name": a.get("name"), "downloads": a.get("download_count"), "size": a.get("size")} for a in r.get("assets", [])],
                 "age_days": days_between(now, r.get("published_at"))} for r in releases]
    latest = next((r for r in rel_list if not r["draft"] and not r["prerelease"]), rel_list[0] if rel_list else None)
    since = None
    if latest:
        try:
            cmp = gh.get(f"/repos/{repo}/compare/{latest['tag']}...{default}")
            since = {"commits": cmp.get("total_commits", cmp.get("ahead_by")), "url": cmp.get("html_url"),
                     "files_changed": len(cmp.get("files", []) or [])}
        except GitHubError as err:
            note(notes, "compare_release", err, "最新 release 到默认分支的差异")
    cadence = None
    published = sorted([dt for dt in (parse_ts(r["published_at"]) for r in rel_list) if dt], reverse=True)
    if len(published) >= 2:
        gaps = [(published[i] - published[i + 1]).days for i in range(len(published) - 1)]
        cadence = round(statistics.mean(gaps), 1)
    return {"latest": latest, "count": len(rel_list), "items": rel_list[:10],
            "tags": [{"name": t.get("name"), "sha": (t.get("commit") or {}).get("sha", "")[:7]} for t in tags[:15]],
            "unreleased": since, "cadence_days": cadence,
            "total_downloads": sum(a["downloads"] or 0 for r in rel_list for a in r["assets"])}


def _ops_branches(ctx: Context, notes: list) -> dict:
    gh, repo, now, default = ctx.gh, ctx.repo, ctx.now, ctx.default_branch
    branches = gh.paginate(f"/repos/{repo}/branches", {"per_page": 100}, max_pages=2)
    rows = [{"name": b.get("name"), "protected": b.get("protected"), "sha": (b.get("commit") or {}).get("sha", "")[:7],
             "ahead": None, "behind": None, "last_commit_at": None, "is_default": b.get("name") == default} for b in branches]
    others = [r for r in rows if not r["is_default"]][:20]

    def compare(row: dict):
        return gh.get(f"/repos/{repo}/compare/{default}...{row['name']}")

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda row: _try(compare, row), others))
    for row, (cmp, err) in zip(others, results):
        if err is not None:
            note(notes, f"compare:{row['name']}", err, f"分支 {row['name']} 与默认分支比较")
            continue
        row["ahead"], row["behind"] = cmp.get("ahead_by"), cmp.get("behind_by")
        commits = cmp.get("commits") or []
        if commits:
            row["last_commit_at"] = ((commits[-1].get("commit") or {}).get("committer") or {}).get("date")
            row["idle_days"] = days_between(now, row["last_commit_at"])
    try:
        prot = gh.get(f"/repos/{repo}/branches/{default}/protection")
        protection = {"enabled": True,
                      "required_reviews": ((prot.get("required_pull_request_reviews") or {}).get("required_approving_review_count")),
                      "required_checks": ((prot.get("required_status_checks") or {}).get("contexts")),
                      "enforce_admins": (prot.get("enforce_admins") or {}).get("enabled")}
    except GitHubError as err:
        default_row = next((r for r in rows if r["is_default"]), None)
        protection = {"enabled": bool(default_row and default_row["protected"]), "readable": False,
                      "reason": err.message, "hint": err.hint, "kind": err.kind}
    rulesets = None
    try:
        rulesets = [{"name": r.get("name"), "enforcement": r.get("enforcement"), "target": r.get("target")}
                    for r in gh.get(f"/repos/{repo}/rulesets", {"per_page": 50}) or []]
    except GitHubError as err:
        note(notes, "rulesets", err, "仓库 rulesets")
    return {"count": len(branches), "items": rows, "default": default, "protection": protection, "rulesets": rulesets,
            "stale": [r for r in rows if not r["is_default"] and ((r.get("idle_days") or 0) >= 90 or (r["behind"] or 0) >= 100)]}


def _ops_security(ctx: Context, notes: list) -> dict:
    gh, repo = ctx.gh, ctx.repo
    sec: dict = {"dependabot": None, "code_scanning": None, "secret_scanning": None, "vulnerability_alerts_enabled": None}
    for key, path, params in (
        ("dependabot", f"/repos/{repo}/dependabot/alerts", {"state": "open", "per_page": 100}),
        ("code_scanning", f"/repos/{repo}/code-scanning/alerts", {"state": "open", "per_page": 100}),
        ("secret_scanning", f"/repos/{repo}/secret-scanning/alerts", {"state": "open", "per_page": 100}),
    ):
        try:
            alerts = gh.paginate(path, params, max_pages=1)
            sev: Counter = Counter()
            for a in alerts:
                s = ((a.get("security_advisory") or {}).get("severity") or (a.get("rule") or {}).get("severity") or "unknown")
                sev[s] += 1
            sec[key] = {"ok": True, "open": len(alerts), "by_severity": dict(sev),
                        "items": [{"number": a.get("number"), "url": a.get("html_url"),
                                   "summary": (a.get("security_advisory") or {}).get("summary") or (a.get("rule") or {}).get("description") or a.get("secret_type_display_name"),
                                   "package": ((a.get("dependency") or {}).get("package") or {}).get("name"),
                                   "severity": (a.get("security_advisory") or {}).get("severity") or (a.get("rule") or {}).get("severity"),
                                   "created_at": a.get("created_at")} for a in alerts[:20]]}
        except GitHubError as err:
            sec[key] = {"ok": False, "error": err.to_dict()}
    try:
        status = gh.get_status(f"/repos/{repo}/vulnerability-alerts")
        sec["vulnerability_alerts_enabled"] = status == 204
    except GitHubError as err:
        sec["vulnerability_alerts_enabled"] = None if err.kind != "not_found" else False
        if err.kind != "not_found":
            note(notes, "vulnerability-alerts", err, "Dependabot 告警开关")
    sec["repo_flags"] = ctx.repo_meta.get("security_and_analysis")
    return sec


def _ops_community(ctx: Context, notes: list) -> dict:
    profile = ctx.gh.get(f"/repos/{ctx.repo}/community/profile")
    files = profile.get("files") or {}
    return {"health_percentage": profile.get("health_percentage"),
            "files": {k: bool(v) for k, v in files.items()},
            "missing": [k for k, v in files.items() if not v and k != "code_of_conduct_file"],
            "updated_at": profile.get("updated_at")}


def _ops_activity(ctx: Context, notes: list) -> dict | None:
    gh = ctx.gh
    for _ in range(2):
        payload, _, status = gh._request("GET", gh._url(f"/repos/{ctx.repo}/stats/commit_activity", None))
        if status == 202 or not payload:
            time.sleep(2)  # GitHub computes the statistics in the background on first request
            continue
        return {"weeks": [{"week": w.get("week"), "total": w.get("total")} for w in payload[-26:]],
                "commits_4w": sum(w.get("total", 0) for w in payload[-4:]),
                "commits_52w": sum(w.get("total", 0) for w in payload)}
    notes.append({"kind": "warning", "key": "commit_activity", "what": "提交活跃度",
                  "message": "GitHub 正在后台计算统计（202），稍后刷新即可。", "hint": ""})
    return None


def _ops_commits(ctx: Context, notes: list) -> tuple[list, int]:
    commits = ctx.gh.paginate(f"/repos/{ctx.repo}/commits", {"sha": ctx.default_branch, "per_page": 30}, max_pages=1)
    recent = [{"sha": c.get("sha", "")[:7], "url": c.get("html_url"),
               "message": (c.get("commit", {}).get("message") or "").split("\n")[0][:120],
               "author": _user(c.get("author")) or (c.get("commit", {}).get("author") or {}).get("name"),
               "date": (c.get("commit", {}).get("committer") or {}).get("date")} for c in commits]
    week = ctx.now - timedelta(days=7)
    return recent, sum(1 for c in recent if (parse_ts(c["date"]) or week) >= week)


def _ops_traffic(ctx: Context, notes: list) -> dict:
    traffic = {}
    for key in ("views", "clones"):
        try:
            t = ctx.gh.get(f"/repos/{ctx.repo}/traffic/{key}")
            traffic[key] = {"ok": True, "count": t.get("count"), "uniques": t.get("uniques"),
                            "series": [{"day": d.get("timestamp", "")[:10], "count": d.get("count"), "uniques": d.get("uniques")} for d in t.get(key, [])]}
        except GitHubError as err:
            traffic[key] = {"ok": False, "error": err.to_dict()}
    return traffic


def _ops_stale_automation(ctx: Context, notes: list) -> dict:
    gh, repo = ctx.gh, ctx.repo
    workflow = None
    for wf in gh.get(f"/repos/{repo}/actions/workflows").get("workflows", []):
        content = gh.get_text_file(repo, wf.get("path", ""), ctx.default_branch) or ""
        if "actions/stale" in content:
            workflow = wf.get("path")
            break
    return {"workflow": workflow}


OPS_BLOCKS = {
    "releases": (_ops_releases, "Release / Tag"),
    "branches": (_ops_branches, "分支列表"),
    "security": (_ops_security, "安全告警"),
    "community": (_ops_community, "社区健康度"),
    "activity": (_ops_activity, "提交活跃度"),
    "commits": (_ops_commits, "最近提交"),
    "traffic": (_ops_traffic, "流量"),
    "stale_automation": (_ops_stale_automation, "stale 自动化检测"),
}

