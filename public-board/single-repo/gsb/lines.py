"""Branch lines: long-lived branches whose CI is viewed apart.

A run belongs to the line its work targets: a pull request's base branch, or
the branch a push, dispatch or schedule ran on. Everything that targets no
other configured line (release tags, nightly, unmatched runs) stays with the
default branch, so no run is counted twice.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

PR_EVENTS = ("pull_request", "pull_request_target")


def _parse(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


def pr_number(run, prs=()):
    """The pull request a run belongs to. GitHub leaves pull_requests empty for fork PRs: match the PR
    with the same head branch open at the time; head repository, SHA and title only break ties."""
    linked = run.get("pull_requests") or []
    if linked:
        first = linked[0]
        return first.get("number") if isinstance(first, dict) else first
    if run.get("event") not in PR_EVENTS:
        return None
    created = _parse(run.get("created_at"))
    if not created or not run.get("branch"):
        return None
    found = []
    for pr in prs:
        opened, closed = _parse(pr.get("created_at")), _parse(pr.get("closed_at"))
        if pr.get("head") == run["branch"] and opened and opened <= created and not (closed and closed < created):
            found.append(pr)
    if run.get("head_repo"):
        found = [pr for pr in found if pr.get("head_repo") in (None, run["head_repo"])]
    for same in (lambda pr: pr.get("head_sha") == run.get("sha"), lambda pr: pr.get("title") == run.get("title")):
        if len(found) > 1:
            found = [pr for pr in found if same(pr)] or found
    return found[0].get("number") if len(found) == 1 else None

KEY_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,30}\Z")


def _historical_refs(entry):
    refs = []
    for item in entry.get("historical_refs") or []:
        if not isinstance(item, dict) or not isinstance(item.get("ref"), str) or not item["ref"]:
            continue
        before = item.get("before")
        try:
            cutoff = datetime.fromisoformat(before.replace("Z", "+00:00"))
            if cutoff.tzinfo is None:
                continue
        except (AttributeError, TypeError, ValueError):
            continue
        alias = {"ref": item["ref"], "before": cutoff.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}
        if alias not in refs:
            refs.append(alias)
    return refs


def configured_lines(settings, default_branch):
    """Lines from ``branch_lines`` in board-config.json, the default branch first."""
    lines, seen = [], set()
    for entry in (settings or {}).get("branch_lines") or []:
        if not isinstance(entry, dict):
            continue
        key, ref = str(entry.get("key") or ""), str(entry.get("ref") or "")
        if KEY_RE.match(key) and ref and key not in seen and ref not in {line["ref"] for line in lines}:
            seen.add(key)
            line = {"key": key, "ref": ref}
            aliases = _historical_refs(entry)
            if aliases:
                line["historical_refs"] = aliases
            lines.append(line)
    default = next((line for line in lines if line["ref"] == default_branch), None)
    if not default:
        default = {"key": default_branch if KEY_RE.match(default_branch) else "default", "ref": default_branch}
    return [{**default, "default": True}] + [{**line, "default": False} for line in lines if line is not default]


def target_of(run, prs=(), by_number=None):
    """The branch a run's work targets; None for a PR run that cannot be matched."""
    if run.get("event") not in PR_EVENTS:
        return run.get("branch")
    if run.get("base_branch"):
        return run["base_branch"]
    number = pr_number(run, prs)
    return ((by_number or {}).get(number) or {}).get("base") if number else None


def _historical_line(target, lines, created_at):
    if not created_at:
        return None
    for line in lines:
        if any(alias["ref"] == target and created_at < alias["before"] for alias in line.get("historical_refs", [])):
            return line
    return None


def canonical_branch(branch, lines, created_at=None):
    """Use the current ref for a run from before a branch rename."""
    historical = _historical_line(branch, lines, created_at)
    return historical["ref"] if historical else branch


def line_of(target, lines, created_at=None):
    """Key of the configured line a target branch belongs to; the default otherwise."""
    historical = _historical_line(target, lines, created_at)
    if historical:
        return historical["key"]
    return next((line["key"] for line in lines[1:] if line["ref"] == target), lines[0]["key"])
