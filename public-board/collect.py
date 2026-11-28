"""Run the incremental public exporter against bot-owned local state."""
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).parent / "single-repo"))
from gsb import github
from gsb.sync import Sync
from gsb.incremental_project import build_snapshot
from gsb.history import encode, read_json


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


github.API_ROOT = os.environ.get("BOT_GITHUB_API_URL", "https://api.github.com").rstrip("/")
repo, output, state = sys.argv[1:]
output, state = Path(output), Path(state)
prev_env = os.environ.get("BOT_PUBLIC_BOARD_PREV_DIR", "")
prev_dir = Path(prev_env) if prev_env else None
state.mkdir(parents=True, exist_ok=True)
# What only the removed gate, coverage and E2E views (#938) produced goes, in the published copy and private state alike.
for retired in (output / "board/e2e", output / "board/data/e2e", state / "site/data/e2e", state / "e2e"):
    shutil.rmtree(retired, ignore_errors=True)
for retired in (state / ".sync/tagged.json", state / ".sync/coverage.json", state / ".sync/coverage-sources.json"):
    retired.unlink(missing_ok=True)
gh = github.GitHub(os.environ["GITHUB_TOKEN"], timeout=30)
sync = Sync(gh, state, repo).collect()
prev_snapshot_path = (prev_dir / "board/data/snapshot.json") if prev_dir else None
prev_snapshot = read_json(prev_snapshot_path, None) if (prev_snapshot_path and prev_snapshot_path.is_file()) else None
snapshot = build_snapshot(sync, old_snapshot=prev_snapshot)
# When the snapshot is unchanged and already present in the previous published generation, let the staging
# finalizer hard-link it directly instead of rewriting and re-redacting several megabytes of JSON.
if not (prev_snapshot is not None and snapshot is prev_snapshot):
    write_atomic(output / "board/data/snapshot.json", encode(snapshot))
# If there is no previous published history tree to inherit from (e.g. retrying after an interrupted initial run),
# seed exported history shards from private state before applying this run's changed files.
if not (prev_dir and (prev_dir / "board/data/history/manifest.json").is_file()):
    state_history = state / "site/data/history"
    if state_history.is_dir():
        for src in state_history.rglob("*"):
            if src.is_file():
                rel = src.relative_to(state / "site")
                dst = output / "board" / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
# Persist both checkpoints and public history, as the previous branch-based exporter did.
# Only site/data is copied into the HTTP export; .sync and other internal state stay private.
for name, content in sync.files().items():
    targets = [state / name]
    if name.startswith("site/data/"):
        targets.append(output / "board" / name.removeprefix("site/"))
    for path in targets:
        if content is None:
            path.unlink(missing_ok=True)
        else:
            write_atomic(path, content)
