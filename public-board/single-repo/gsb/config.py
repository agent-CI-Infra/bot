"""Runtime configuration, all overridable through ``GSB_*`` environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Config:
    repo: str = "openJiuwen-ai/sciencediscovery"
    host: str = "127.0.0.1"
    port: int = 8790
    refresh_interval: int = 600           # seconds between automatic refreshes; 0 disables
    cache_dir: Path = ROOT / ".cache"
    data_dir: Path = ROOT / ".data"        # board fields, rules, aliases (user data, kept across restarts)
    static_dir: Path = ROOT / "static"
    # Actions artifacts that carry test results; parsed for the test tab.
    artifact_names: list[str] = field(default_factory=lambda: ["ut-results", "st-results", "e2e-results", "real-e2e-results"])
    artifact_max_bytes: int = 80 * 1024 * 1024
    review_sla_days: int = 3              # open PR without review after this many days is "waiting too long"
    stale_days: int = 30                  # issue with no update for this long counts as stale
    pr_idle_days: int = 14
    job_history_runs: int = 12            # how many default-branch runs to inspect job-by-job
    run_pages: int = 2                    # 100 runs per page
    issue_pages: int = 5                  # 100 issues per page
    local_checkout: str | None = None     # optional local clone used when the git tree API fails
    disk_cache: bool = True               # GSB_DISK_CACHE=0 keeps the whole snapshot in memory only
    allow_private: bool = False           # GSB_ALLOW_PRIVATE=1 for loopback/local-only export

    @classmethod
    def from_env(cls, **overrides) -> "Config":
        cfg = cls(
            repo=os.environ.get("GSB_REPO", cls.repo),
            host=os.environ.get("GSB_HOST", cls.host),
            port=_int("GSB_PORT", cls.port),
            refresh_interval=_int("GSB_REFRESH_INTERVAL", cls.refresh_interval),
            review_sla_days=_int("GSB_REVIEW_SLA_DAYS", cls.review_sla_days),
            stale_days=_int("GSB_STALE_DAYS", cls.stale_days),
            pr_idle_days=_int("GSB_PR_IDLE_DAYS", cls.pr_idle_days),
            job_history_runs=_int("GSB_JOB_HISTORY_RUNS", cls.job_history_runs),
            run_pages=_int("GSB_RUN_PAGES", cls.run_pages),
            issue_pages=_int("GSB_ISSUE_PAGES", cls.issue_pages),
            artifact_max_bytes=_int("GSB_ARTIFACT_MAX_MB", 80) * 1024 * 1024,
            local_checkout=os.environ.get("GSB_LOCAL_CHECKOUT") or None,
            disk_cache=os.environ.get("GSB_DISK_CACHE", "1").strip().lower() not in ("0", "false", "no", "off"),
            allow_private=os.environ.get("GSB_ALLOW_PRIVATE", "0").strip().lower() in ("1", "true", "yes", "on"),
        )
        names = os.environ.get("GSB_TEST_ARTIFACTS")
        if names:
            cfg.artifact_names = [n.strip() for n in names.split(",") if n.strip()]
        cache = os.environ.get("GSB_CACHE_DIR")
        if cache:
            cfg.cache_dir = Path(cache).expanduser()
        data = os.environ.get("GSB_DATA_DIR")
        if data:
            cfg.data_dir = Path(data).expanduser()
        for key, value in overrides.items():
            if value is not None:
                setattr(cfg, key, value)
        return cfg

    @property
    def owner(self) -> str:
        return self.repo.split("/", 1)[0]

    @property
    def name(self) -> str:
        return self.repo.split("/", 1)[1]

    @property
    def repo_url(self) -> str:
        return f"https://github.com/{self.repo}"
