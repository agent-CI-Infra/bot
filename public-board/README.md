# Public board hosting

The dashboard and single-repository pages started from
https://github.com/agent-CI-Infra/dashboard at revision
`9e57dfaf11fa44606517da454c5732a59d1f7996` and are now maintained in this
repository; they no longer follow the upstream template. The dashboard's MIT
license and the single-repository exporter's Apache-2.0 license are kept in
their respective directories.

The boards show only data every GitHub repository has, so any repository has
content as soon as its board is on: the dashboard shows community statistics
(pull requests, Issues, contributors, growth, releases), and each repository
board shows Issues, pull requests, the run history of every workflow and job,
and releases. Nothing depends on how a repository lays out its CI.

`dashboard/` builds the React application with `/dashboard/` as its asset base.
`single-repo/static/` contains the read-only board pages and
`single-repo/gsb/` the incremental exporter; `scripts/` contains the community
collector. `collect.py` and `collect.mjs` adapt these collectors to local
storage and repository-scoped GitHub credentials. Collection uses a read-only
installation token and never commits, dispatches workflows or deploys to an
external site.

Run `npm ci` and `npm run build` at the bot repository root. The production
image includes Python 3 (standard library only) for the exporter. Private
incremental state and generated snapshots live beside the bot database under
`public-boards/`; only the explicit exported routes are public.

The community collector exports `collectRepo` and accepts its output directory
from its caller instead of invoking its former command-line entrypoint.
Classification configuration is resolved relative to the vendored module.
