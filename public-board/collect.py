"""Run the incremental public exporter against bot-owned local state."""
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).parent / "single-repo"))
from gsb import github
from gsb.sync import Sync
from gsb.incremental_project import build_snapshot
from gsb.history import encode

github.API_ROOT = os.environ.get("BOT_GITHUB_API_URL", "https://api.github.com").rstrip("/")
repo, output, state = sys.argv[1:]
output, state = Path(output), Path(state)
state.mkdir(parents=True, exist_ok=True)
# The output starts as a copy of the last published snapshot. What only the removed gate, coverage and
# E2E views (#938) produced goes, in the published copy and in the private state alike.
for retired in (output / "board/e2e", output / "board/data/e2e", state / "site/data/e2e", state / "e2e"):
    shutil.rmtree(retired, ignore_errors=True)
for retired in (state / ".sync/tagged.json", state / ".sync/coverage.json", state / ".sync/coverage-sources.json"):
    retired.unlink(missing_ok=True)
gh = github.GitHub(os.environ["GITHUB_TOKEN"], timeout=30)
sync = Sync(gh, state, repo).collect()
snapshot = build_snapshot(sync)
target = output / "board/data"
target.mkdir(parents=True, exist_ok=True)
(target / "snapshot.json").write_text(encode(snapshot), encoding="utf-8")
# Persist both checkpoints and public history, as the previous branch-based exporter did.
# Only site/data is copied into the HTTP export; .sync and other internal state stay private.
for name, content in sync.files().items():
    targets = [state / name]
    if name.startswith("site/data/"):
        targets.append(output / "board" / name.removeprefix("site/"))
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(content, encoding="utf-8")
