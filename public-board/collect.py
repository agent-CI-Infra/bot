"""Run the existing incremental public exporter against bot-owned local state."""
import json
import os
from pathlib import Path
import shutil
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
files = sync.files()
try:
    records = e2e_records.refresh(sync.gh.separate_phase(requests=1 + e2e_records.MAX_DOWNLOADS, seconds=120),
                                  repo, state, snapshot, sync.now, max_bytes=sync.cfg.artifact_max_bytes)
    records.write_preview(output / "board")
    files.update(records.files)
    index = json.loads(records.files["site/data/e2e/index.json"])
    retained = {str(record["artifact_id"]) for record in index["records"]}
    for folder in (output / "board/e2e").glob("*"):
        if folder.is_dir() and folder.name not in retained:
            shutil.rmtree(folder)
except Exception:
    pass
# Persist both checkpoints and public history, as the previous branch-based exporter did.
# Only site/data is copied into the HTTP export; .sync and other internal state stay private.
for name, content in files.items():
    targets = [state / name]
    if name.startswith("site/data/"):
        targets.append(output / "board" / name.removeprefix("site/"))
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(content, encoding="utf-8")
