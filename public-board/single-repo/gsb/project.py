"""Workflow runs as the public board keeps them: the run, its channel and its jobs."""
from __future__ import annotations

from datetime import datetime
import re

from .github import GitHubError


def channel(run, rules):
    for kind in ("release", "daily"):
        if any(re.search(pattern, run.get("name", ""), re.I) for pattern in rules.get(kind, [])):
            return kind
    if run.get("event") == "release" or re.search(r"release|version|版本|发布", run.get("name", ""), re.I):
        return "release"
    if run.get("event") == "schedule" or re.search(r"nightly|daily|每日|夜间", run.get("name", ""), re.I):
        return "daily"
    return "ci"


def slim_run(run, rules):
    return {"id": run["id"], "name": run.get("name"), "workflow_id": run.get("workflow_id"),
            "channel": channel(run, rules), "event": run.get("event"), "status": run.get("status"),
            "conclusion": run.get("conclusion"), "branch": run.get("head_branch"), "sha": run.get("head_sha"),
            "attempt": run.get("run_attempt", 1), "created_at": run.get("created_at"),
            "started_at": run.get("run_started_at"), "updated_at": run.get("updated_at"), "url": run.get("html_url"),
            "pull_requests": [p["number"] for p in run.get("pull_requests", [])],
            # Fork PR runs carry no pull_requests; the head repository lets
            # branch lines match them to the right PR.
            "head_repo": (run.get("head_repository") or {}).get("full_name"),
            # The branch a same-repository PR run targets; fork PRs are matched later.
            "base_branch": ((run.get("pull_requests") or [{}])[0].get("base") or {}).get("ref"), "jobs": [],
            # The check runs a scheduled run reports its results in (see results.py).
            "check_suite_id": run.get("check_suite_id")}


def duration_seconds(start, end):
    try:
        return max(0, int((datetime.fromisoformat(end.replace("Z", "+00:00")) - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()))
    except (AttributeError, ValueError):
        return None


def run_details(gh, cfg, run):
    """The run's jobs with their conclusions, durations and failed steps; nothing is downloaded."""
    base = f"/repos/{cfg.repo}/actions/runs/{run['id']}"
    try:
        jobs = gh.paginate(base + f"/attempts/{run['attempt']}/jobs", key="jobs", max_pages=2)
        run["jobs"] = [{"name": j.get("name"), "status": j.get("status"), "conclusion": j.get("conclusion"),
                        "url": j.get("html_url"), "duration_s": duration_seconds(j.get("started_at"), j.get("completed_at")),
                        "failed_steps": [s["name"] for s in j.get("steps", []) if s.get("conclusion") == "failure"]}
                       for j in jobs]
        run["jobs_status"] = "available"
    except GitHubError:
        run["jobs_status"] = "unavailable"
    return run
