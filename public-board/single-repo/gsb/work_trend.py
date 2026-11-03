"""Daily Issue / PR flow for the trend charts, read from the incremental aggregate.

`History.put` keeps `<kind>:created_at|closed_at|merged_at:<UTC day>` counts by swapping a
changed record's old contribution for its new one, so building the series reads only these
day keys: no record is rescanned, and the work grows with the number of days, not items.
"""
from datetime import date, timedelta

FIELDS = ("created_at", "closed_at", "merged_at")


def daily_trend(aggregate, kind, today, complete=True):
    """Contiguous per-day series from the first created day to `today` (UTC dates).

    `open` is the number still open at the end of each day: everything created so far minus
    everything closed so far. It follows each item's current timestamps, so an item that was
    closed and reopened counts as open from its creation. A merged PR also has `closed_at`,
    so for PRs `closed` lists only those closed without merging.
    """
    days = {field: {} for field in FIELDS}
    for key, value in aggregate.items():
        parts = key.split(":")
        if len(parts) == 3 and parts[0] == kind and parts[1] in days:
            days[parts[1]][parts[2]] = value
    if not days["created_at"]:
        return None
    start = date.fromisoformat(min(days["created_at"]))
    end = max(date.fromisoformat(today), date.fromisoformat(max(day for values in days.values() for day in values)))
    series = {"opened": [], "closed": [], "open": []}
    if kind == "prs":
        series["merged"] = []
    still_open = 0
    for offset in range((end - start).days + 1):
        day = (start + timedelta(days=offset)).isoformat()
        opened, closed, merged = (days[field].get(day, 0) for field in FIELDS)
        still_open += opened - closed
        series["opened"].append(opened)
        series["open"].append(still_open)
        if kind == "prs":
            series["merged"].append(merged)
            # closed_at equals merged_at for a merge, so the day's difference is never negative.
            series["closed"].append(max(0, closed - merged))
        else:
            series["closed"].append(closed)
    return {"start": start.isoformat(), "end": end.isoformat(), "timezone": "UTC", "complete": bool(complete), **series}
