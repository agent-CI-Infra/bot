"""Project board (GitHub Projects-style) built on top of the snapshot.

The board adds *local* custom fields to the repository's issues and pull requests,
the way a GitHub Project adds fields to items without changing the issue itself:

- ``status``    single-select, user-editable option list with optional WIP limits;
- ``priority``  single-select (P0..P3);
- ``iteration`` free text with suggestions (e.g. ``2026-W39``);
- ``note``      free text.

Items are never written back to GitHub. Field values, column order, automation
rules, history and display aliases historically lived in ``.data/board.json``.
Public export uses ``persist=False`` to derive only GitHub defaults; browser-local
editing is implemented in ``static/board-local.js``.

Automation mirrors the built-in GitHub Projects workflows:

- item added → default status;
- item closed / PR merged → done status (unless the status was set manually
  *after* the close);
- item reopened → default status;
- issue gets an open linked PR → review status;
- issue gets an assignee → doing status.

Automatic transitions only move forward through the column list, so a manual
status is never downgraded by a rule.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import Config

PRIORITY_OPTIONS = [
    {"name": "P0", "label": "P0 紧急", "color": "critical"},
    {"name": "P1", "label": "P1 高", "color": "serious"},
    {"name": "P2", "label": "P2 中", "color": "warning"},
    {"name": "P3", "label": "P3 低", "color": "muted"},
]
DEFAULT_STATUS_OPTIONS = [
    {"name": "待处理", "color": "s1", "limit": None, "description": "已进入看板、还没人动手"},
    {"name": "进行中", "color": "s4", "limit": 6, "description": "有人正在做"},
    {"name": "评审中", "color": "s7", "limit": None, "description": "已有关联 PR，等待评审 / CI"},
    {"name": "已完成", "color": "s3", "limit": None, "description": "Issue 已关闭或 PR 已合并"},
]
DEFAULT_RULES = {
    "default_status": "待处理",
    "doing_status": "进行中",
    "review_status": "评审中",
    "done_status": "已完成",
    "closed_to_done": True,
    "reopened_to_default": True,
    "linked_pr_to_review": True,
    "assigned_to_doing": True,
    "include_prs": True,
    "closed_window_days": 30,
}
MAX_HISTORY = 300
ID_RE = re.compile(r"^(issue|pr):(\d+)$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class BoardError(ValueError):
    """Invalid board request (bad id, unknown column, ...)."""


class BoardStore:
    """Thread-safe local state with atomic JSON persistence."""

    def __init__(self, cfg: Config, *, persist: bool = True):
        self.cfg = cfg
        self.persist = persist
        self.path = cfg.data_dir / "board.json"
        self.lock = threading.RLock()
        self.state = self._load() if persist else self._default_state()

    # ------------------------------------------------------------ persistence
    def _default_state(self) -> dict:
        return {
            "version": 1,
            "fields": {
                "status": {"options": [dict(o) for o in DEFAULT_STATUS_OPTIONS]},
                "priority": {"options": [dict(o) for o in PRIORITY_OPTIONS]},
                "iterations": [],
            },
            "rules": dict(DEFAULT_RULES),
            "items": {},
            "aliases": {},
            "history": [],
            "updated_at": None,
        }

    def _load(self) -> dict:
        base = self._default_state()
        try:
            doc = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return base
        if not isinstance(doc, dict):
            return base
        for key in ("fields", "rules", "items", "aliases", "history"):
            if key in doc:
                base[key] = doc[key]
        base["rules"] = {**DEFAULT_RULES, **(base.get("rules") or {})}
        base["fields"].setdefault("priority", {"options": [dict(o) for o in PRIORITY_OPTIONS]})
        base["fields"].setdefault("iterations", [])
        base["updated_at"] = doc.get("updated_at")
        return base

    def _save(self) -> None:
        self.state["updated_at"] = _now_iso()
        if not self.persist:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.path.parent, 0o700)
        except OSError:
            pass
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def _record(self, kind: str, item_id: str | None, detail: dict, actor: str = "user") -> None:
        self.state["history"].append({"at": _now_iso(), "kind": kind, "item": item_id, "actor": actor, **detail})
        del self.state["history"][:-MAX_HISTORY]

    # ------------------------------------------------------------ field helpers
    @property
    def status_names(self) -> list[str]:
        return [o["name"] for o in self.state["fields"]["status"]["options"]]

    def _status_index(self, name: str | None) -> int:
        names = self.status_names
        return names.index(name) if name in names else -1

    def _rule_status(self, key: str) -> str | None:
        name = self.state["rules"].get(key)
        return name if name in self.status_names else None

    # ------------------------------------------------------------ assembly
    def payload(self, snapshot: dict | None) -> dict:
        """Merge the snapshot's issues/PRs with local fields; apply automations; group."""
        with self.lock:
            items = self._collect_items(snapshot)
            changed = self._apply_rules(items)
            if changed:
                self._save()
            for item in items:
                stored = self.state["items"].get(item["id"], {})
                item["status"] = stored.get("status")
                item["status_by"] = stored.get("status_by")
                item["priority"] = stored.get("priority")
                item["iteration"] = stored.get("iteration")
                item["note"] = stored.get("note")
                item["order"] = stored.get("order")
            self._apply_aliases(items)
            items.sort(key=lambda i: (i["order"] if i["order"] is not None else 10**9, -_parse_ts(i["updated_at"])))
            return {
                "repo": (snapshot or {}).get("repo"),
                "snapshot_generated_at": (snapshot or {}).get("generated_at"),
                "fields": self.state["fields"],
                "rules": self.state["rules"],
                "columns": self._columns(items),
                "items": items,
                "facets": self._facets(items),
                "aliases": self.state["aliases"],
                "history": list(reversed(self.state["history"][-40:])),
                "updated_at": self.state["updated_at"],
                "counts": {"total": len(items), "issues": sum(1 for i in items if i["kind"] == "issue"),
                           "prs": sum(1 for i in items if i["kind"] == "pr"),
                           "open": sum(1 for i in items if i["state"] == "open")},
            }

    def _collect_items(self, snapshot: dict | None) -> list[dict]:
        sections = (snapshot or {}).get("sections") or {}
        issues = ((sections.get("issues") or {}).get("data") or {})
        prs = ((sections.get("prs") or {}).get("data") or {})
        rules = self.state["rules"]
        window = float(rules.get("closed_window_days") or 30) * 86400
        cutoff = time.time() - window
        items: list[dict] = []
        open_prs = prs.get("items") or []
        linked_by_issue: dict[int, list[dict]] = {}
        for pr in open_prs + (prs.get("recent_merged") or []) + (prs.get("recent_closed_unmerged") or []):
            for n in pr.get("linked_issues") or []:
                linked_by_issue.setdefault(n, []).append({
                    "number": pr["number"], "title": pr["title"], "url": pr["url"],
                    "state": "merged" if pr.get("merged_at") else pr.get("state", "open"),
                })
        for issue in (issues.get("items") or []) + [i for i in (issues.get("closed_recent") or []) if _parse_ts(i.get("closed_at")) >= cutoff]:
            items.append(self._item_from_issue(issue, linked_by_issue.get(issue["number"], [])))
        if rules.get("include_prs", True):
            seen = set()
            for pr in open_prs + [p for p in (prs.get("recent_merged") or []) + (prs.get("recent_closed_unmerged") or [])
                                  if _parse_ts(p.get("closed_at") or p.get("merged_at")) >= cutoff]:
                if pr["number"] in seen:
                    continue
                seen.add(pr["number"])
                items.append(self._item_from_pr(pr))
        return items

    @staticmethod
    def _item_from_issue(issue: dict, linked_prs: list[dict]) -> dict:
        return {
            "id": f"issue:{issue['number']}", "kind": "issue", "number": issue["number"], "title": issue["title"],
            "url": issue["url"], "state": issue["state"], "author": issue.get("author"), "labels": issue.get("labels") or [],
            "assignees": issue.get("assignees") or [], "milestone": issue.get("milestone"), "comments": issue.get("comments", 0),
            "created_at": issue.get("created_at"), "updated_at": issue.get("updated_at"), "closed_at": issue.get("closed_at"),
            "age_days": issue.get("age_days"), "idle_days": issue.get("idle_days"),
            "linked": linked_prs, "draft": False, "review_decision": None, "ci_state": None, "merged": False,
        }

    @staticmethod
    def _item_from_pr(pr: dict) -> dict:
        merged = bool(pr.get("merged_at"))
        return {
            "id": f"pr:{pr['number']}", "kind": "pr", "number": pr["number"], "title": pr["title"], "url": pr["url"],
            "state": "closed" if pr.get("state") == "closed" or merged else "open", "author": pr.get("author"),
            "labels": pr.get("labels") or [], "assignees": pr.get("assignees") or [], "milestone": None,
            "comments": pr.get("comments", 0), "created_at": pr.get("created_at"), "updated_at": pr.get("updated_at"),
            "closed_at": pr.get("merged_at") or pr.get("closed_at"), "age_days": pr.get("age_days"), "idle_days": pr.get("idle_days"),
            "linked": [{"number": n, "kind": "issue"} for n in pr.get("linked_issues") or []],
            "draft": bool(pr.get("draft")), "review_decision": pr.get("review_decision"),
            "ci_state": (pr.get("ci") or {}).get("state"), "merged": merged, "head": pr.get("head"), "base": pr.get("base"),
        }

    # ------------------------------------------------------------ automation
    def _apply_rules(self, items: list[dict]) -> bool:
        rules = self.state["rules"]
        default = self._rule_status("default_status") or (self.status_names[0] if self.status_names else None)
        done = self._rule_status("done_status")
        review = self._rule_status("review_status")
        doing = self._rule_status("doing_status")
        changed = False
        for item in items:
            stored = self.state["items"].setdefault(item["id"], {})
            current = stored.get("status")
            by = stored.get("status_by")
            target, reason = None, None
            closed = item["state"] == "closed"
            if closed:
                if rules.get("closed_to_done") and done and current != done:
                    manual_after_close = by == "manual" and _parse_ts(stored.get("status_at")) > _parse_ts(item.get("closed_at"))
                    if not manual_after_close:
                        target, reason = done, "auto:closed"
            else:
                if current is None:
                    target, reason = default, "auto:added"
                elif by == "auto:closed" and rules.get("reopened_to_default") and default:
                    target, reason = default, "auto:reopened"
                if by != "manual":
                    base = target or current
                    base_idx = self._status_index(base)
                    if (rules.get("linked_pr_to_review") and review and item["kind"] == "issue"
                            and any(l.get("state") == "open" for l in item["linked"]) and self._status_index(review) > base_idx):
                        target, reason = review, "auto:linked-pr"
                    elif (rules.get("assigned_to_doing") and doing and item["assignees"]
                          and self._status_index(doing) > base_idx and base_idx <= self._status_index(default)):
                        target, reason = doing, "auto:assigned"
            if target and target != current:
                stored.update({"status": target, "status_by": reason, "status_at": _now_iso()})
                self._record("status", item["id"], {"from": current, "to": target, "reason": reason}, actor="rule")
                changed = True
        return changed

    # ------------------------------------------------------------ grouping
    def _columns(self, items: list[dict]) -> list[dict]:
        options = self.state["fields"]["status"]["options"]
        by_status: dict[str, list[dict]] = {o["name"]: [] for o in options}
        orphans: list[dict] = []
        for item in items:
            (by_status.get(item["status"]) if item["status"] in by_status else orphans).append(item)
        columns = []
        for o in options:
            cards = by_status[o["name"]]
            columns.append({"name": o["name"], "color": o.get("color"), "limit": o.get("limit"), "description": o.get("description"),
                            "count": len(cards), "over_limit": bool(o.get("limit")) and len([c for c in cards if c["state"] == "open"]) > o["limit"],
                            "items": [c["id"] for c in cards]})
        if orphans:
            columns.insert(0, {"name": None, "label": "未分类", "count": len(orphans), "items": [c["id"] for c in orphans]})
        return columns

    def _facets(self, items: list[dict]) -> dict:
        def uniq(values):
            return sorted({v for v in values if v}, key=str.casefold)
        return {
            "labels": uniq(l["name"] for i in items for l in i["labels"]),
            "assignees": uniq(a for i in items for a in i["assignees"]),
            "authors": uniq(i["author"] for i in items),
            "milestones": uniq(i["milestone"] for i in items),
            "iterations": uniq(list(self.state["fields"].get("iterations") or []) + [i["iteration"] for i in items]),
            "priorities": [o["name"] for o in self.state["fields"]["priority"]["options"]],
            "statuses": self.status_names,
        }

    def _apply_aliases(self, items: list[dict]) -> None:
        aliases = self.state["aliases"] or {}
        for item in items:
            item["author_name"] = aliases.get(item["author"] or "", item["author"])
            item["assignee_names"] = [aliases.get(a, a) for a in item["assignees"]]

    # ------------------------------------------------------------ mutations
    def update_item(self, item_id: str, changes: dict) -> dict:
        if not ID_RE.match(item_id or ""):
            raise BoardError("item id must look like issue:123 or pr:45")
        if not isinstance(changes, dict) or not changes:
            raise BoardError("JSON body must be a non-empty object")
        allowed = {"status", "priority", "iteration", "note"}
        unknown = set(changes) - allowed
        if unknown:
            raise BoardError(f"unsupported fields: {', '.join(sorted(unknown))}")
        with self.lock:
            stored = self.state["items"].setdefault(item_id, {})
            if "status" in changes:
                status = changes["status"]
                if status is not None and status not in self.status_names:
                    raise BoardError("status must be one of the configured columns")
                if stored.get("status") != status:
                    self._record("status", item_id, {"from": stored.get("status"), "to": status, "reason": "manual"})
                stored.update({"status": status, "status_by": "manual", "status_at": _now_iso()})
            if "priority" in changes:
                priority = changes["priority"]
                names = [o["name"] for o in self.state["fields"]["priority"]["options"]]
                if priority is not None and priority not in names:
                    raise BoardError("priority must be one of " + "/".join(names) + " or null")
                if stored.get("priority") != priority:
                    self._record("priority", item_id, {"from": stored.get("priority"), "to": priority})
                stored["priority"] = priority
            if "iteration" in changes:
                iteration = self._clean_text(changes["iteration"], 40)
                if stored.get("iteration") != iteration:
                    self._record("iteration", item_id, {"from": stored.get("iteration"), "to": iteration})
                stored["iteration"] = iteration
                if iteration and iteration not in self.state["fields"]["iterations"]:
                    self.state["fields"]["iterations"].append(iteration)
            if "note" in changes:
                stored["note"] = self._clean_text(changes["note"], 2000)
            self._save()
            return {"id": item_id, **stored}

    def move_item(self, item_id: str, status: str | None, *, before: str | None = None, after: str | None = None) -> dict:
        """Set the status and place the card relative to a neighbour inside the target column."""
        if not ID_RE.match(item_id or ""):
            raise BoardError("item id must look like issue:123 or pr:45")
        if status is not None and status not in self.status_names:
            raise BoardError("status must be one of the configured columns")
        with self.lock:
            stored = self.state["items"].setdefault(item_id, {})
            if stored.get("status") != status:
                self._record("status", item_id, {"from": stored.get("status"), "to": status, "reason": "manual"})
            stored.update({"status": status, "status_by": "manual", "status_at": _now_iso()})
            # Order: renumber the target column so the moved card sits next to its neighbour.
            siblings = [(iid, s) for iid, s in self.state["items"].items() if s.get("status") == status and iid != item_id]
            siblings.sort(key=lambda kv: kv[1].get("order") if kv[1].get("order") is not None else 10**9)
            ids = [iid for iid, _ in siblings]
            if before in ids:
                ids.insert(ids.index(before), item_id)
            elif after in ids:
                ids.insert(ids.index(after) + 1, item_id)
            else:
                ids.insert(0, item_id)
            for pos, iid in enumerate(ids):
                self.state["items"][iid]["order"] = pos
            self._save()
            return {"id": item_id, **stored}

    def update_fields(self, changes: dict) -> dict:
        """Replace the status option list (rename/add/remove/reorder/limits) and/or rules."""
        if not isinstance(changes, dict):
            raise BoardError("JSON body must be an object")
        with self.lock:
            if "status_options" in changes:
                options = changes["status_options"]
                if not isinstance(options, list) or not options:
                    raise BoardError("status_options must be a non-empty array")
                cleaned, seen = [], set()
                renames = {}
                for opt in options:
                    if not isinstance(opt, dict):
                        raise BoardError("each status option must be an object")
                    name = self._clean_text(opt.get("name"), 40)
                    if not name:
                        raise BoardError("status option name must not be empty")
                    if name.casefold() in seen:
                        raise BoardError(f"duplicate status option: {name}")
                    seen.add(name.casefold())
                    limit = opt.get("limit")
                    if limit is not None:
                        try:
                            limit = int(limit)
                        except (TypeError, ValueError):
                            raise BoardError("limit must be an integer or null") from None
                        if limit <= 0:
                            limit = None
                    if opt.get("rename_from") and opt["rename_from"] != name:
                        renames[opt["rename_from"]] = name
                    cleaned.append({"name": name, "color": self._clean_text(opt.get("color"), 20) or "s1",
                                    "limit": limit, "description": self._clean_text(opt.get("description"), 120) or ""})
                for stored in self.state["items"].values():
                    if stored.get("status") in renames:
                        stored["status"] = renames[stored["status"]]
                for key in ("default_status", "doing_status", "review_status", "done_status"):
                    if self.state["rules"].get(key) in renames:
                        self.state["rules"][key] = renames[self.state["rules"][key]]
                self.state["fields"]["status"]["options"] = cleaned
                self._record("fields", None, {"status_options": [o["name"] for o in cleaned]})
            if "rules" in changes:
                rules = changes["rules"]
                if not isinstance(rules, dict):
                    raise BoardError("rules must be an object")
                for key, value in rules.items():
                    if key not in DEFAULT_RULES:
                        raise BoardError(f"unknown rule: {key}")
                    if key.endswith("_status"):
                        self.state["rules"][key] = self._clean_text(value, 40)
                    elif key == "closed_window_days":
                        self.state["rules"][key] = max(1, min(int(value), 365))
                    else:
                        self.state["rules"][key] = bool(value)
                self._record("rules", None, {"rules": dict(self.state["rules"])})
            if "iterations" in changes:
                values = changes["iterations"]
                if not isinstance(values, list):
                    raise BoardError("iterations must be an array")
                self.state["fields"]["iterations"] = [v for v in (self._clean_text(x, 40) for x in values) if v]
            self._save()
            return {"fields": self.state["fields"], "rules": self.state["rules"]}

    def set_alias(self, login: str, alias: str | None) -> dict:
        login = self._clean_text(login, 60)
        if not login:
            raise BoardError("login must not be empty")
        with self.lock:
            alias = self._clean_text(alias, 60)
            if alias:
                self.state["aliases"][login] = alias
            else:
                self.state["aliases"].pop(login, None)
            self._save()
            return dict(self.state["aliases"])

    @staticmethod
    def _clean_text(value, limit: int) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise BoardError("expected a string")
        value = value.strip()
        if len(value) > limit:
            raise BoardError(f"value exceeds {limit} characters")
        return value or None
