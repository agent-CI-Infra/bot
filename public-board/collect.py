"""Run the existing incremental public exporter against bot-owned local state."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "single-repo"))
from gsb import github, e2e_records
from gsb.sync import Sync
from gsb.incremental_project import build_snapshot
from gsb.history import encode

github.API_ROOT = os.environ.get("BOT_GITHUB_API_URL", "https://api.github.com").rstrip("/")
repo, output, state = sys.argv[1:]
output, state = Path(output), Path(state)
state.mkdir(parents=True, exist_ok=True)
gh = github.GitHub(os.environ["GITHUB_TOKEN"], timeout=30)
sync = Sync(gh, state, repo).collect()
snapshot = build_snapshot(sync)
target = output / "board/data"
target.mkdir(parents=True, exist_ok=True)
(target / "snapshot.json").write_text(encode(snapshot), encoding="utf-8")
# Keep the original E2E report and step contracts; optional evidence must not fail the snapshot.
try:
    records = e2e_records.refresh(sync.gh.separate_phase(requests=1 + e2e_records.MAX_DOWNLOADS, seconds=120),
                                  repo, state, snapshot, sync.now, max_bytes=sync.cfg.artifact_max_bytes)
    records.write_preview(output / "board")
except Exception:
    pass
# Incremental checkpoints remain private. Only board/data is routed to public HTTP.
for name, content in sync.files().items():
    path = state / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if content is None:
        path.unlink(missing_ok=True)
    else:
        path.write_text(content, encoding="utf-8")
