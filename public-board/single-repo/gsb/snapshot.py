"""Snapshot assembly and caching.

A snapshot is one JSON document with every section. Sections are collected in
parallel (a few threads; GitHub tolerates that comfortably) and each is wrapped
in an envelope ``{status, error, notes, data, elapsed_s}`` so a failure stays
local to its card. The latest snapshot is persisted under ``.cache/`` so the UI
has something to show immediately after a restart.
"""

from __future__ import annotations

import copy
import json
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .collectors import SECTIONS, Context, collect_repo
from .config import Config
from .github import GitHub, GitHubError, discover_token


# Parts of the snapshot that are kept in process memory only. They are replaced by a marker
# before the snapshot is written to .cache/, so the disk never holds security-alert details,
# traffic analytics or the account's permission level. After a restart the UI shows these
# cards as "pending" until the first refresh (which starts immediately) fills them again.
MEMORY_ONLY_PATHS = (
    "sections.ops.data.security",
    "sections.ops.data.traffic",
    "sections.repo.data.permissions",
    "sections.repo.data.viewer",
    "sections.repo.data.security_and_analysis",  # admin-only view of the repo's security feature switches
)
REDACTED_MARKER = {"redacted": True, "reason": "memory-only"}


def redact_for_disk(doc: dict) -> dict:
    """Deep-copy ``doc`` with every MEMORY_ONLY_PATHS value replaced by a marker."""
    out = copy.deepcopy(doc)
    hit: list[str] = []
    for path in MEMORY_ONLY_PATHS:
        parts = path.split(".")
        node = out
        for key in parts[:-1]:
            node = node.get(key) if isinstance(node, dict) else None
            if node is None:
                break
        if isinstance(node, dict) and node.get(parts[-1]) is not None:
            node[parts[-1]] = dict(REDACTED_MARKER)
            hit.append(path)
    out["redacted_paths"] = hit
    return out


def _run_section(name: str, fn, ctx: Context) -> dict:
    started = time.time()
    try:
        data = fn(ctx)
        notes = data.pop("notes", []) if isinstance(data, dict) else []
        status = "partial" if any(n.get("kind") not in (None, "warning") for n in notes) else ("ok" if not notes else "partial")
        return {"status": status, "error": None, "notes": notes, "data": data, "elapsed_s": round(time.time() - started, 2)}
    except GitHubError as err:
        return {"status": "error", "error": err.to_dict(), "notes": [], "data": None, "elapsed_s": round(time.time() - started, 2)}
    except Exception as err:  # noqa: BLE001 - a collector bug must not take the server down
        return {"status": "error",
                "error": {"kind": "internal", "message": f"{type(err).__name__}: {err}", "hint": "看板内部错误，请把服务日志中的堆栈反馈给维护者。",
                          "trace": traceback.format_exc()[-1500:]},
                "notes": [], "data": None, "elapsed_s": round(time.time() - started, 2)}


def build_snapshot(cfg: Config, sections: list[str] | None = None) -> dict:
    started = time.time()
    now = datetime.now(timezone.utc)
    token, source = discover_token()
    gh = GitHub(token)
    ctx = Context(gh=gh, cfg=cfg, now=now)
    snapshot = {
        "generated_at": now.isoformat(),
        "repo": cfg.repo,
        "repo_url": cfg.repo_url,
        "auth": {"token_source": source, "authenticated": bool(token)},
        "config": {"stale_days": cfg.stale_days, "review_sla_days": cfg.review_sla_days,
                   "refresh_interval": cfg.refresh_interval, "artifact_names": cfg.artifact_names},
        "sections": {},
    }
    # The repo section runs first: it decides the default branch and proves the token works.
    snapshot["sections"]["repo"] = _run_section("repo", collect_repo, ctx)
    repo_err = snapshot["sections"]["repo"]["error"]
    wanted = [s for s in SECTIONS if sections is None or s in sections]
    if repo_err and repo_err.get("kind") in ("unauthorized", "rate_limited", "network", "not_found"):
        # Nothing else can succeed; replicate the error so every card explains itself.
        for name in wanted:
            snapshot["sections"][name] = {"status": "error", "error": repo_err, "notes": [], "data": None, "elapsed_s": 0}
    else:
        with ThreadPoolExecutor(max_workers=len(wanted) or 1) as pool:
            futures = {name: pool.submit(_run_section, name, SECTIONS[name], ctx) for name in wanted}
            for name, fut in futures.items():
                snapshot["sections"][name] = fut.result()
    snapshot["rate"] = gh.rate
    snapshot["api_calls"] = gh.calls
    snapshot["duration_s"] = round(time.time() - started, 1)
    return snapshot


class SnapshotStore:
    """Holds the current snapshot, refreshes it in a background thread, persists to disk."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.path = cfg.cache_dir / "snapshot.json"
        self.lock = threading.Lock()
        self.data: dict | None = self._load()
        self.refreshing = False
        self.last_error: str | None = None
        self.last_refresh_started: float | None = None
        self._stop = threading.Event()

    def _load(self) -> dict | None:
        try:
            doc = json.loads(self.path.read_text("utf-8"))
            return doc if doc.get("repo") == self.cfg.repo else None
        except (OSError, ValueError):
            return None

    def _save(self, doc: dict) -> None:
        if not self.cfg.disk_cache:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(redact_for_disk(doc), ensure_ascii=False), "utf-8")
            tmp.replace(self.path)
        except OSError as err:
            self.last_error = f"cache write failed: {err}"

    def refresh(self, *, wait: bool = False) -> bool:
        with self.lock:
            if self.refreshing:
                return False
            self.refreshing = True
            self.last_refresh_started = time.time()
        thread = threading.Thread(target=self._run, name="gsb-refresh", daemon=True)
        thread.start()
        if wait:
            thread.join()
        return True

    def _run(self) -> None:
        try:
            doc = build_snapshot(self.cfg)
            with self.lock:
                self.data = doc
                self.last_error = None
            self._save(doc)
        except Exception as err:  # noqa: BLE001
            with self.lock:
                self.last_error = f"{type(err).__name__}: {err}"
        finally:
            with self.lock:
                self.refreshing = False

    def status(self) -> dict:
        with self.lock:
            return {
                "refreshing": self.refreshing,
                "has_snapshot": self.data is not None,
                "generated_at": (self.data or {}).get("generated_at"),
                "last_error": self.last_error,
                "refresh_started": self.last_refresh_started,
                "refresh_elapsed_s": round(time.time() - self.last_refresh_started, 1) if self.refreshing and self.last_refresh_started else None,
                "last_duration_s": (self.data or {}).get("duration_s"),
                "memory_only_pending": bool((self.data or {}).get("redacted_paths")),
                "disk_cache": self.cfg.disk_cache,
                "refresh_interval": self.cfg.refresh_interval,
                "repo": self.cfg.repo,
            }

    def start_auto_refresh(self) -> None:
        # No snapshot, or a disk snapshot whose memory-only parts were stripped: collect right away.
        if self.data is None or self.data.get("redacted_paths"):
            self.refresh()

        def loop():
            while not self._stop.wait(max(self.cfg.refresh_interval, 30)):
                self.refresh()

        if self.cfg.refresh_interval > 0:
            threading.Thread(target=loop, name="gsb-auto-refresh", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
