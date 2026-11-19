"""Calendar of Actions runs, using the latest stored attempt of each run."""
import re
from datetime import timedelta
from zoneinfo import ZoneInfo

from .collectors import parse_ts
from .lines import PR_EVENTS
from .project import duration_seconds

ZONE = ZoneInfo("Asia/Shanghai")
WINDOW = 30
LANES = (("pr", "PR"), ("merge_queue", "合并队列"), ("daily", "Daily"),
         ("release", "版本"), ("main", "主干"), ("other", "其他"))


def is_scheduled(run, scheduled_workflows):
    return run.get("event") == "schedule" or (run.get("event") == "workflow_dispatch"
                                               and run.get("workflow_id") in scheduled_workflows)


def lane_of(run, branch, scheduled_workflows):
    event = run.get("event")
    if event in PR_EVENTS:
        return "pr"
    if event == "merge_group":
        return "merge_queue"
    if is_scheduled(run, scheduled_workflows):
        return "daily"
    if event == "release" or re.search(r"release|version|版本", run.get("name") or "", re.I):
        return "release"
    if event == "workflow_dispatch" or (event == "push" and run.get("branch") == branch):
        return "main"
    return "other"


def build_lanes(rows, branch, scheduled_workflows, now, collected_since):
    first = now.astimezone(ZONE).date() - timedelta(days=WINDOW - 1)
    since = parse_ts(collected_since)
    since = since.astimezone(ZONE).date() if since else None
    days = [first + timedelta(days=i) for i in range(WINDOW)]
    cells = {key: [[] for _ in days] for key, _ in LANES}
    for run in rows:
        created = parse_ts(run.get("created_at"))
        if not created:
            continue
        local = created.astimezone(ZONE)
        column = (local.date() - first).days
        if not 0 <= column < WINDOW:
            continue
        key = lane_of(run, branch, scheduled_workflows)
        duration = run.get("duration_s")
        if "duration_s" not in run and run.get("status") == "completed":
            # Older index shards carry the same start and end used to store the duration.
            duration = duration_seconds(run.get("started_at"), run.get("updated_at"))
        cell = {k: run.get(k) for k in ("id", "attempt", "name", "event", "branch", "url", "status", "conclusion")}
        cell.update(sha=(run.get("sha") or "")[:7], time=local.strftime("%H:%M:%S"), duration_s=duration)
        cells[key][column].append((created, run["id"], cell))
    return {"zone": ZONE.key, "days": [{"date": day.isoformat(), "collected": since is not None and day >= since} for day in days],
            "rows": [{"key": key, "label": label,
                      "days": [[cell for _, _, cell in sorted(column)] for column in cells[key]]} for key, label in LANES]}
