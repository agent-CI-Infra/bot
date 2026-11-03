"""Section collectors. Each ``collect_*`` returns a plain dict for the UI.

Every collector receives a ``Context`` and may raise ``GitHubError``; the caller
turns that into a section-level error envelope. Inside a collector, optional
sub-queries (security alerts, traffic, search counts, ...) catch their own
errors and record them in ``notes`` so one missing scope only degrades the
piece that needs it.
"""

from __future__ import annotations

import json
import os
import re
import statistics
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from .config import Config
from .github import GitHub, GitHubError
from .testparse import PARSER_VERSION, parse_artifact_zip, summarize_tree


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
    # Optional CoverageStore: summaries read by earlier builds are not downloaded again.
    coverage_store: object = None

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


# ------------------------------------------------------------------- repo
def collect_repo(ctx: Context) -> dict:
    meta = ctx.gh.get(f"/repos/{ctx.repo}")
    ctx.repo_meta = meta
    login = None
    if ctx.gh.token:
        try:
            login = ctx.gh.get("/user").get("login")
        except GitHubError:
            login = None
    return {
        "full_name": meta.get("full_name"),
        "html_url": meta.get("html_url"),
        "description": meta.get("description"),
        "default_branch": meta.get("default_branch"),
        "visibility": meta.get("visibility"),
        "archived": meta.get("archived"),
        "language": meta.get("language"),
        "license": (meta.get("license") or {}).get("spdx_id"),
        "topics": meta.get("topics") or [],
        "stars": meta.get("stargazers_count"),
        "forks": meta.get("forks_count"),
        "watchers": meta.get("subscribers_count"),
        "open_issues_and_prs": meta.get("open_issues_count"),
        "pushed_at": meta.get("pushed_at"),
        "created_at": meta.get("created_at"),
        "size_kb": meta.get("size"),
        "has_wiki": meta.get("has_wiki"),
        "has_discussions": meta.get("has_discussions"),
        "has_projects": meta.get("has_projects"),
        "security_and_analysis": meta.get("security_and_analysis"),
        "viewer": login,
        "permissions": meta.get("permissions"),
    }


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


def collect_issues(ctx: Context) -> dict:
    gh, repo, cfg, now = ctx.gh, ctx.repo, ctx.cfg, ctx.now
    notes: list = []
    raw = gh.paginate(f"/repos/{repo}/issues", {"state": "open", "sort": "updated", "direction": "desc"},
                      max_pages=cfg.issue_pages)
    issues = [_slim_issue(i, now) for i in raw if "pull_request" not in i]
    # Recently closed issues feed the kanban's "done" column; one page is plenty for 30 days.
    closed_recent: list[dict] = []
    try:
        since = (now - timedelta(days=30)).isoformat()
        raw_closed = gh.paginate(f"/repos/{repo}/issues", {"state": "closed", "since": since, "sort": "updated",
                                                            "direction": "desc"}, max_pages=1)
        closed_recent = [_slim_issue(i, now) for i in raw_closed if "pull_request" not in i and i.get("closed_at")]
    except GitHubError as err:
        note(notes, "closed_recent", err, "最近关闭的 Issue")
    try:
        catalog = gh.paginate(f"/repos/{repo}/labels", max_pages=2)
    except GitHubError as err:
        catalog = []
        note(notes, "labels", err, "标签目录")

    since_30 = (now - timedelta(days=30)).date().isoformat()
    since_7 = (now - timedelta(days=7)).date().isoformat()
    counts: dict[str, int | None] = {}
    for key, query in {
        "closed_total": f"repo:{repo} is:issue is:closed",
        "closed_30d": f"repo:{repo} is:issue closed:>={since_30}",
        "opened_30d": f"repo:{repo} is:issue created:>={since_30}",
        "opened_7d": f"repo:{repo} is:issue created:>={since_7}",
        "closed_7d": f"repo:{repo} is:issue closed:>={since_7}",
    }.items():
        try:
            counts[key] = gh.get("/search/issues", {"q": query, "per_page": 1}).get("total_count")
        except GitHubError as err:
            counts[key] = None
            note(notes, f"search:{key}", err, f"搜索计数 {key}")

    return summarize_issues(issues, closed_recent, catalog, counts, cfg, notes, len(raw) >= cfg.issue_pages * 100)


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


def _enrich_prs_rest(ctx: Context, prs: list[dict], notes: list) -> None:
    """Fallback when GraphQL is unavailable: check-runs and reviews per PR (capped)."""
    for pr in prs[:20]:
        try:
            runs = ctx.gh.get(f"/repos/{ctx.repo}/commits/{pr['head_sha']}/check-runs", {"per_page": 50}).get("check_runs", [])
            checks = [{"name": r.get("name"), "conclusion": (r.get("conclusion") or r.get("status") or "").lower(), "url": r.get("html_url")} for r in runs]
            concl = {c["conclusion"] for c in checks}
            state = "failure" if concl & {"failure", "timed_out", "cancelled"} else ("pending" if concl & {"queued", "in_progress", ""} else ("success" if checks else None))
            pr["ci"] = {"state": state, "checks": checks}
            reviews = ctx.gh.get(f"/repos/{ctx.repo}/pulls/{pr['number']}/reviews", {"per_page": 30})
            pr["reviews"] = [{"author": _user(r.get("user")), "state": r.get("state"), "submitted_at": r.get("submitted_at")} for r in reviews]
            states = [r["state"] for r in pr["reviews"]]
            pr["review_decision"] = "CHANGES_REQUESTED" if "CHANGES_REQUESTED" in states else ("APPROVED" if "APPROVED" in states else "NONE")
        except GitHubError as err:
            note(notes, f"pr:{pr['number']}", err, f"PR #{pr['number']} 的检查/评审")
            break


def collect_prs(ctx: Context) -> dict:
    gh, repo, cfg, now = ctx.gh, ctx.repo, ctx.cfg, ctx.now
    notes: list = []
    raw_open = gh.paginate(f"/repos/{repo}/pulls", {"state": "open", "sort": "updated", "direction": "desc"}, max_pages=2)
    prs = [_slim_pr(p, now) for p in raw_open]
    if prs:
        try:
            _enrich_prs_graphql(ctx, prs)
        except GitHubError as err:
            note(notes, "graphql", err, "PR 评审决定/检查汇总（GraphQL），已用 REST 逐个补齐")
            _enrich_prs_rest(ctx, prs, notes)

    try:
        raw_closed = gh.paginate(f"/repos/{repo}/pulls", {"state": "closed", "sort": "updated", "direction": "desc"}, max_pages=1)
    except GitHubError as err:
        raw_closed = []
        note(notes, "closed", err, "最近关闭的 PR")
    closed = [_slim_pr(p, now) for p in raw_closed]
    return summarize_prs(prs, closed, cfg, now, notes)


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
            dur = round((e - s).total_seconds()) if s and e else None
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


# ------------------------------------------------------------------ tests
def _artifact_cache_path(cfg: Config, artifact_id: int) -> Path:
    return cfg.cache_dir / "artifacts" / f"{artifact_id}-v{PARSER_VERSION}.json"


def _load_artifact(ctx: Context, art: dict, notes: list) -> dict | None:
    """Download + parse an artifact once; later refreshes read the parsed JSON from disk."""
    cache = _artifact_cache_path(ctx.cfg, art["id"])
    if cache.exists():
        try:
            return json.loads(cache.read_text("utf-8"))
        except ValueError:
            pass
    try:
        blob = ctx.gh.download_artifact(ctx.repo, art["id"], max_bytes=ctx.cfg.artifact_max_bytes)
    except GitHubError as err:
        note(notes, f"artifact:{art['name']}", err, f"下载产物 {art['name']}")
        return None
    parsed = parse_artifact_zip(art["name"], blob)
    parsed.update({"id": art["id"], "run_id": art.get("run_id"), "created_at": art.get("created_at"),
                   "url": art.get("url"), "expires_at": art.get("expires_at"), "branch": art.get("branch")})
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(parsed, ensure_ascii=False), "utf-8")
    return parsed


def _tree_paths(ctx: Context, notes: list) -> tuple[list[str], str]:
    """Blob paths of the default branch. Falls back to a local checkout when configured."""
    try:
        tree = ctx.gh.get(f"/repos/{ctx.repo}/git/trees/{ctx.default_branch}", {"recursive": "1"})
        paths = [t["path"] for t in tree.get("tree", []) if t.get("type") == "blob"]
        if tree.get("truncated"):
            notes.append({"kind": "warning", "key": "tree", "what": "文件树", "message": "GitHub 返回的文件树被截断，分布统计不完整。", "hint": ""})
        return paths, "github:git-tree"
    except GitHubError as err:
        note(notes, "tree", err, "仓库文件树")
    local = ctx.cfg.local_checkout
    if local and os.path.isdir(local):
        paths = []
        for root, dirs, files in os.walk(local):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "dist", ".venv", "__pycache__")]
            rel = os.path.relpath(root, local)
            for f in files:
                paths.append(f if rel == "." else f"{rel}/{f}")
        return paths, f"local:{local}"
    return [], "none"


def _coverage_totals(groups: list[dict]) -> dict:
    totals = {}
    for metric in ("lines", "branches", "functions"):
        covered = sum(int((group.get("totals") or {}).get(metric, {}).get("covered") or 0) for group in groups)
        total = sum(int((group.get("totals") or {}).get(metric, {}).get("total") or 0) for group in groups)
        totals[metric] = {"covered": covered, "total": total,
                          "percentage": round(covered * 100 / total, 2) if total else None}
    return totals


def _coverage_value(totals: dict) -> dict:
    value = {"format": "sciencediscovery-summary"}
    for metric in ("lines", "branches", "functions"):
        row = totals.get(metric) or {}
        value[f"{metric}_pct"] = row.get("percentage")
        value[f"{metric}_hit"] = row.get("covered")
        value[f"{metric}_found"] = row.get("total")
    return value


def _coverage_language(artifact: dict, manifest: dict) -> str | None:
    language = str(manifest.get("language") or "").lower()
    if language in ("node", "python"):
        return language
    name = artifact.get("name") or ""
    if name.startswith("node-coverage-summary-"):
        return "node"
    if name.startswith("python-coverage-summary-"):
        return "python"
    return None


def _coverage_source_sha(entry: dict) -> str | None:
    artifact, manifest = entry["artifact"], entry["manifest"]
    return (manifest.get("source_sha") or artifact.get("sha")
            or (artifact.get("workflow_run") or {}).get("head_sha"))


def _coverage_layers_complete(manifest: dict) -> bool | None:
    """Return the new gate-report completeness signal, or None for legacy summaries."""
    layers = manifest.get("layers")
    if not isinstance(layers, dict) or not layers:
        return None
    return all(isinstance(layer, dict)
               and layer.get("complete") is True
               and layer.get("producer") == "success"
               for layer in layers.values())


def _coverage_is_full(entry: dict, default_branch: str) -> bool:
    artifact, manifest = entry["artifact"], entry["manifest"]
    completeness = _coverage_layers_complete(manifest)
    if completeness is False:
        return False
    name = artifact.get("name", "")
    legacy_full = (manifest.get("authoritative") is True
                   or manifest.get("mode") == "full"
                   or "-nightly-" in name)
    # The current ScienceDiscovery contract records the whole UT/ST gate and
    # publishes it as *-coverage-summary-<event>-<sha>.  It deliberately omits
    # the legacy mode/authoritative fields; the per-layer completeness signal
    # is the authority marker instead. A branch without push CI, such as a
    # long-lived feature line, gets its full gate from a manual dispatch.
    gate_push = (artifact.get("branch") == default_branch
                 and re.search(r"-coverage-summary-(push|workflow_dispatch)-", name) is not None
                 and completeness is True)
    return legacy_full or gate_push


def _coverage_sources(manifest: dict) -> dict:
    """Per-file totals by path; summaries published before files were listed have none."""
    return {source["path"]: {"path": source["path"], "totals": source.get("totals") or {}}
            for source in manifest.get("sources") or []
            if isinstance(source, dict) and isinstance(source.get("path"), str)}


def _in_group(path: str, group: str) -> bool:
    return path == group or path.startswith(group.rstrip("/") + "/")


def _coverage_manifest(ctx: Context, artifact: dict, notes: list, sources: bool = False) -> dict | None:
    """A coverage summary, from the store when an earlier build already read it.

    ``sources`` asks for the per-file list too; the store keeps it only for the
    summaries the view shows, so an older one may be downloaded again."""
    store = ctx.coverage_store
    if store is not None:
        known, manifest = store.get(artifact, sources)
        if known:
            return manifest
    loaded = _load_artifact(ctx, artifact, notes)
    manifest = (loaded or {}).get("coverage_manifest")
    if store is not None and loaded is not None:
        # A failed download stays unknown and is tried again next time.
        store.put(artifact, manifest, sources)
    return manifest


def _coverage_summary_dataset(ctx: Context, artifacts: list[dict], notes: list, language: str) -> dict | None:
    prefix = f"{language}-coverage-summary-"
    candidates = sorted(
        (artifact for artifact in artifacts
         if artifact.get("name", "").startswith(prefix) and not artifact.get("expired")),
        key=lambda artifact: artifact.get("created_at") or "",
        reverse=True,
    )[:80]
    entries = []
    for artifact in candidates:
        manifest = _coverage_manifest(ctx, artifact, notes)
        if not manifest or _coverage_language(artifact, manifest) != language:
            continue
        entries.append({"artifact": artifact, "manifest": manifest})
    if not entries:
        return None

    default_entries = [entry for entry in entries if entry["artifact"].get("branch") == ctx.default_branch]
    full_entries = [entry for entry in default_entries if _coverage_is_full(entry, ctx.default_branch)]
    baseline_entry = full_entries[0] if full_entries else None

    if baseline_entry:
        baseline_artifact = baseline_entry["artifact"]
        baseline = baseline_entry["manifest"]
        groups = {
            group["name"]: {
                **group,
                "source_sha": _coverage_source_sha(baseline_entry),
                "updated_at": baseline.get("generated_at") or baseline_artifact.get("created_at"),
                "update_kind": "full baseline",
            }
            for group in baseline.get("groups", []) if group.get("name")
        }
        # Files follow their group: an increment replaces the files of each group it measured.
        files = _coverage_sources(_coverage_manifest(ctx, baseline_artifact, notes, sources=True) or {})
        increments = [
            entry for entry in reversed(default_entries)
            if (entry["artifact"].get("created_at") or "") > (baseline_artifact.get("created_at") or "")
            and (entry["manifest"].get("mode") == "incremental"
                 or (entry["manifest"].get("mode") is None
                     and "-main-incremental-" in entry["artifact"].get("name", "")))
        ]
        applied = []
        read_files = {}
        def increment_files(entry):
            # Per-file lists are read only for increments that are applied.
            key = entry["artifact"]["id"]
            if key not in read_files:
                read_files[key] = _coverage_sources(_coverage_manifest(ctx, entry["artifact"], notes, sources=True) or {})
            return read_files[key]
        for entry in increments:
            artifact, manifest = entry["artifact"], entry["manifest"]
            changed = []
            for group in manifest.get("groups", []):
                if not group.get("name"):
                    continue
                groups[group["name"]] = {
                    **group,
                    "source_sha": _coverage_source_sha(entry),
                    "updated_at": manifest.get("generated_at") or artifact.get("created_at"),
                    "update_kind": "main increment",
                }
                changed.append(group["name"])
                files = {path: value for path, value in files.items() if not _in_group(path, group["name"])}
                files.update({path: value for path, value in increment_files(entry).items() if _in_group(path, group["name"])})
            if changed:
                applied.append({"artifact": artifact["name"], "created_at": artifact.get("created_at"),
                                "sha": _coverage_source_sha(entry), "groups": changed})
        current_groups = sorted(groups.values(), key=lambda group: group["name"])
        current_totals = _coverage_totals(current_groups)
        baseline_payload = {
            "artifact": baseline_artifact["name"],
            "created_at": baseline.get("generated_at") or baseline_artifact.get("created_at"),
            "kind": "nightly" if "-nightly-" in baseline_artifact["name"] else "main full",
            "sha": _coverage_source_sha(baseline_entry),
            "totals": baseline.get("totals") or {},
            "groups": baseline.get("groups", []),
        }
        current = {
            "kind": "incremental" if applied else "authoritative",
            "totals": current_totals,
            "groups": current_groups,
            "increments": applied,
            "sources": sorted(files.values(), key=lambda source: source["path"]),
        }
    else:
        latest = default_entries[0] if default_entries else entries[0]
        artifact, manifest = latest["artifact"], latest["manifest"]
        current_groups = [{
            **group,
            "source_sha": _coverage_source_sha(latest),
            "updated_at": manifest.get("generated_at") or artifact.get("created_at"),
            "update_kind": "partial",
        } for group in manifest.get("groups", []) if group.get("name")]
        baseline_payload = None
        current = {
            "kind": "partial",
            "totals": manifest.get("totals") or _coverage_totals(current_groups),
            "groups": current_groups,
            "increments": [],
            "sources": sorted(_coverage_sources(_coverage_manifest(ctx, artifact, notes, sources=True) or {}).values(), key=lambda source: source["path"]),
        }

    history = [{
        "artifact": entry["artifact"]["name"],
        "run_id": entry["artifact"].get("run_id"),
        "created_at": entry["manifest"].get("generated_at") or entry["artifact"].get("created_at"),
        "sha": _coverage_source_sha(entry),
        "kind": "nightly" if "-nightly-" in entry["artifact"]["name"] else "main full",
        "totals": entry["manifest"].get("totals") or {},
    } for entry in reversed(full_entries)]

    latest_pr = {}
    for entry in entries:
        match = re.match(rf"{language}-coverage-summary-pr-(\d+)-", entry["artifact"]["name"])
        if match and match.group(1) not in latest_pr:
            latest_pr[match.group(1)] = entry
    pull_requests = []
    for number, entry in list(latest_pr.items())[:10]:
        artifact, manifest = entry["artifact"], entry["manifest"]
        pull_requests.append({"number": int(number), "branch": artifact.get("branch"),
                              "created_at": artifact.get("created_at"), "sha": _coverage_source_sha(entry),
                              "groups": manifest.get("groups", []), "totals": manifest.get("totals") or {}})

    source_artifact = (baseline_payload or {}).get("artifact") or (default_entries[0] if default_entries else entries[0])["artifact"]["name"]
    return {
        "language": language,
        "source": f"artifact:{source_artifact}",
        "scope": (baseline_entry or entries[0])["manifest"].get("scope"),
        "baseline": baseline_payload,
        "current": current,
        "history": history,
        "pull_requests": pull_requests,
        "value": _coverage_value(current["totals"]),
    }


def _coverage_probe(ctx: Context, artifacts: list[dict], paths: list[str], parsed: dict, notes: list) -> dict:
    """Try every coverage source in priority order and report what was attempted."""
    attempts = []
    result = {"source": None, "value": None, "attempts": attempts}

    languages = {}
    for language in ("node", "python"):
        dataset = _coverage_summary_dataset(ctx, artifacts, notes, language)
        if dataset:
            languages[language] = dataset
    if languages:
        combined_totals = _coverage_totals([
            {"totals": dataset["current"]["totals"]} for dataset in languages.values()
        ])
        kinds = {dataset["current"]["kind"] for dataset in languages.values()}
        result.update({
            "source": "Actions coverage summaries",
            "value": _coverage_value(combined_totals),
            "current": {
                "kind": "authoritative" if kinds == {"authoritative"} else "partial" if "partial" in kinds else "incremental",
                "totals": combined_totals,
            },
            "languages": languages,
        })
        attempts.append({"step": "Actions 覆盖率摘要", "ok": True,
                         "detail": "；".join(f"{name}: {dataset['source'].removeprefix('artifact:')}"
                                             for name, dataset in languages.items())})
        return result

    cov_arts = sorted(
        (a for a in artifacts if re.search(r"cover|lcov|codecov", a["name"], re.I) and not a.get("expired")),
        key=lambda a: a.get("created_at") or "",
        reverse=True,
    )
    # Show the default branch baseline when available; a newer PR artifact is only a fallback.
    cov_arts.sort(key=lambda a: a.get("branch") != ctx.default_branch)
    if cov_arts:
        art = cov_arts[0]
        artifact_label = art["name"]
        loaded = _load_artifact(ctx, art, notes)
        if loaded and loaded.get("coverage"):
            result["source"] = f"artifact:{artifact_label}"
            result["value"] = loaded["coverage"][0]
            attempts.append({"step": "Actions 覆盖率产物", "ok": True, "detail": artifact_label})
            return result
        attempts.append({"step": "Actions 覆盖率产物", "ok": False, "detail": f"产物 {artifact_label} 中未找到可解析的覆盖率文件"})
    else:
        attempts.append({"step": "Actions 覆盖率产物", "ok": False, "detail": "最近产物中没有名称含 coverage/lcov/codecov 的项"})

    embedded = [c for p in parsed.values() if p for c in p.get("coverage", [])]
    if embedded:
        result["source"] = "artifact:embedded"
        result["value"] = embedded[0]
        attempts.append({"step": "测试产物内嵌覆盖率文件", "ok": True, "detail": embedded[0].get("file")})
        return result
    attempts.append({"step": "测试产物内嵌覆盖率文件", "ok": False, "detail": "ut/st/e2e 产物里没有 lcov / coverage-summary / cobertura"})

    try:
        import urllib.request
        req = urllib.request.Request(f"https://api.codecov.io/api/v2/github/{ctx.cfg.owner}/repos/{ctx.cfg.name}/",
                                     headers={"User-Agent": "github-status-board"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            doc = json.loads(resp.read().decode("utf-8"))
        totals = (doc.get("totals") or {})
        if totals.get("coverage") is not None:
            result["source"] = "codecov"
            result["value"] = {"format": "codecov", "lines_pct": totals.get("coverage")}
            attempts.append({"step": "Codecov 公共 API", "ok": True, "detail": "已接入 Codecov"})
            return result
        attempts.append({"step": "Codecov 公共 API", "ok": False, "detail": "仓库存在于 Codecov 但没有上传记录"})
    except Exception as err:  # noqa: BLE001 - any failure here just means "not on Codecov"
        code = getattr(err, "code", None)
        if code in (401, 403, 404):
            detail = f"未接入 Codecov（HTTP {code}）"
        elif code:
            detail = f"Codecov 返回 HTTP {code}（未接入或服务异常）"
        else:
            detail = f"Codecov 不可达：{err}"
        attempts.append({"step": "Codecov 公共 API", "ok": False, "detail": detail})

    try:
        sha = ctx.gh.get(f"/repos/{ctx.repo}/commits/{ctx.default_branch}").get("sha")
        checks = ctx.gh.get(f"/repos/{ctx.repo}/commits/{sha}/check-runs", {"per_page": 100}).get("check_runs", [])
        cov_checks = [c for c in checks if re.search(r"cover|codecov|coveralls", c.get("name", ""), re.I)]
        if cov_checks:
            c = cov_checks[0]
            result["source"] = f"check-run:{c.get('name')}"
            result["value"] = {"format": "check-run", "summary": (c.get("output") or {}).get("summary"), "url": c.get("html_url")}
            attempts.append({"step": "默认分支 check-run", "ok": True, "detail": c.get("name")})
            return result
        attempts.append({"step": "默认分支 check-run", "ok": False, "detail": f"最新提交的 {len(checks)} 个 check 里没有覆盖率相关项"})
    except GitHubError as err:
        attempts.append({"step": "默认分支 check-run", "ok": False, "detail": err.message})

    config_hits = [p for p in paths if re.search(r"(^|/)(\.nycrc|\.c8rc|codecov\.ya?ml|\.coveragerc|jest\.config|vitest\.config)", p)]
    attempts.append({"step": "仓库内覆盖率配置", "ok": bool(config_hits),
                     "detail": ", ".join(config_hits[:5]) if config_hits else "未发现 c8/nyc/codecov/coveragerc 等配置文件"})
    return result


def collect_tests(ctx: Context) -> dict:
    gh, repo, cfg = ctx.gh, ctx.repo, ctx.cfg
    notes: list = []
    paths, tree_source = _tree_paths(ctx, notes)
    tree = summarize_tree(paths) if paths else None
    test_scripts = {}
    try:
        raw_pkg = gh.get_text_file(repo, "package.json", ctx.default_branch)
        if raw_pkg:
            scripts = json.loads(raw_pkg).get("scripts", {})
            test_scripts = {k: v for k, v in scripts.items() if re.search(r"test|e2e|check|smoke", k)}
    except (GitHubError, ValueError) as err:
        note(notes, "package.json", err, "根 package.json")

    try:
        # Coverage history competes with every other CI artifact in this list. Keep
        # enough metadata pages for daily baselines to remain discoverable during
        # busy PR periods; payloads are still downloaded only on demand below.
        arts_raw = gh.paginate(f"/repos/{repo}/actions/artifacts", {"per_page": 100}, max_pages=5, key="artifacts")
    except GitHubError as err:
        arts_raw = []
        note(notes, "artifacts", err, "Actions 产物列表")
    artifacts = [{"id": a["id"], "name": a["name"], "size": a.get("size_in_bytes"), "expired": a.get("expired"),
                  "created_at": a.get("created_at"), "expires_at": a.get("expires_at"), "url": a.get("url"),
                  "run_id": (a.get("workflow_run") or {}).get("id"), "branch": (a.get("workflow_run") or {}).get("head_branch"),
                  "sha": (a.get("workflow_run") or {}).get("head_sha")}
                 for a in arts_raw]
    # Prefer the newest artifact produced on the default branch; PR branches only as fallback.
    live = sorted((a for a in artifacts if not a["expired"]), key=lambda a: a["created_at"] or "", reverse=True)
    live.sort(key=lambda a: a["branch"] != ctx.default_branch)  # stable: default branch first, newest first inside
    latest_by_name: dict[str, dict] = {}
    for a in live:
        latest_by_name.setdefault(a["name"], a)

    parsed: dict[str, dict | None] = {}
    to_load: list[tuple[str, dict]] = []
    for name in cfg.artifact_names:
        art = latest_by_name.get(name)
        if not art:
            notes.append({"kind": "warning", "key": f"artifact:{name}", "what": f"产物 {name}",
                          "message": f"最近 100 个产物中没有未过期的 {name}", "hint": "确认 CI 是否上传该产物。"})
            parsed[name] = None
        else:
            to_load.append((name, art))
    # Downloads are independent (and cached after the first time); run them side by side.
    with ThreadPoolExecutor(max_workers=max(len(to_load), 1)) as pool:
        for (name, _), result in zip(to_load, pool.map(lambda item: _load_artifact(ctx, item[1], notes), to_load)):
            parsed[name] = result

    # Executed-case rollup per layer from whatever artifacts parsed.
    executed = []
    for name, p in parsed.items():
        if not p:
            continue
        if not any(p.get(key) for key in ("summary", "run_log", "playwright", "junit")):
            # A coverage-only artifact is a data source for the coverage panel, not an
            # executed test layer. Do not render it as an incomplete test result.
            continue
        entry = {"artifact": name, "layer": (p.get("summary") or {}).get("layer") or name.split("-")[0],
                 "status": (p.get("summary") or {}).get("status"), "run_id": p.get("run_id"), "branch": p.get("branch"),
                 "created_at": p.get("created_at"), "duration_ms": (p.get("summary") or {}).get("duration_ms"),
                 "totals": None, "detail": None}
        if p.get("run_log") and p["run_log"]["totals"]["tests"]:
            entry["totals"] = p["run_log"]["totals"]
            entry["detail"] = {"commands": p["run_log"]["commands"], "packages": p["run_log"]["packages"]}
        elif p.get("playwright"):
            entry["totals"] = p["playwright"]["totals"]
            if entry["status"] is None:
                entry["status"] = "failed" if p["playwright"]["stats"].get("unexpected") else "passed"
            entry["duration_ms"] = entry["duration_ms"] or p["playwright"]["stats"].get("duration_ms")
            entry["detail"] = {"files": p["playwright"]["files"], "failures": p["playwright"]["failures"],
                               "stats": p["playwright"]["stats"], "projects": p["playwright"]["projects"],
                               "journeys": p.get("journeys")}
        elif p.get("junit"):
            t = {"tests": 0, "passed": 0, "failed": 0, "skipped": 0}
            for j in p["junit"]:
                for k in t:
                    t[k] += j["totals"][k]
            entry["totals"] = t
            entry["detail"] = {"junit": p["junit"]}
        elif p.get("summary"):
            outs = p["summary"]["outcomes"]
            entry["totals"] = {"tests": len(outs), "passed": sum(1 for o in outs if o["exit_code"] == 0),
                               "failed": sum(1 for o in outs if o["exit_code"] not in (0, None)), "skipped": 0}
            entry["detail"] = {"outcomes": outs, "unit": "命令"}
        if entry["totals"] is None or (entry["status"] is None and not p.get("summary")):
            # The artifact exists but carries no result files: the job most likely failed or was
            # cancelled before the reporter ran. Say so instead of showing an empty card.
            entry["status"] = entry["status"] or "incomplete"
            entry["note"] = f"产物只有 {p.get('entries', 0)} 个文件、{p.get('bytes', 0)} 字节，没有结果文件；对应 run 可能失败或被取消。"
        executed.append(entry)

    coverage = _coverage_probe(ctx, artifacts, paths, parsed, notes)

    # Structural proxy: which packages have any tests, and how many CI cases ran per package.
    ci_cases_by_pkg = {}
    ut = parsed.get("ut-results") or {}
    for pkg in (ut.get("run_log") or {}).get("packages", []):
        ci_cases_by_pkg[pkg["package"]] = pkg
    basenames = {row["package"].split("/")[-1]: row["package"] for row in (tree or {}).get("inventory", [])}
    for cmd in (ut.get("run_log") or {}).get("commands", []):
        m = re.search(r"--project (services/[\w-]+)|-s (services/[\w-]+)/tests|pytest (services/[\w-]+)", cmd["command"])
        key = next((g for g in m.groups() if g), None) if m else None
        if not key and cmd.get("filter"):
            key = basenames.get(cmd["filter"].split("/")[-1])  # `pnpm --filter @scope/runner test` → services/runner
        if key:
            ci_cases_by_pkg[key] = {**cmd, "package": key}
    inventory = []
    for row in (tree or {}).get("inventory", []):
        cases = ci_cases_by_pkg.get(row["package"])
        inventory.append({**row, "ci_cases": cases["tests"] if cases else None,
                          "ci_failed": cases["failed"] if cases else None})

    return {
        "notes": notes,
        "tree_source": tree_source,
        "tree": {k: v for k, v in (tree or {}).items() if k != "inventory"} if tree else None,
        "inventory": inventory,
        "test_scripts": test_scripts,
        "artifacts_recent": artifacts[:30],
        "executed": executed,
        "coverage": coverage,
    }


# -------------------------------------------------------------------- ops
# Each block is independent and talks to different endpoints, so collect_ops runs them in a
# small thread pool; a block that raises is recorded in notes and shows as unavailable.

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


def collect_ops(ctx: Context) -> dict:
    notes: list = []
    out: dict = {"notes": notes}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {key: pool.submit(_try, fn, ctx, notes) for key, (fn, _) in OPS_BLOCKS.items()}
        for key, fut in futures.items():
            result, err = fut.result()
            if err is not None:
                note(notes, key, err, OPS_BLOCKS[key][1])
            if key == "commits":
                out["recent_commits"], out["commits_7d"] = result if result else ([], None)
            elif key == "stale_automation":
                out[key] = result or {"workflow": None}
            else:
                out[key] = result
    return out


SECTIONS = {
    "issues": collect_issues,
    "prs": collect_prs,
    "ci": collect_ci,
    "tests": collect_tests,
    "ops": collect_ops,
}
