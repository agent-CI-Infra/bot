# Public board hosting

The dashboard and single-repository pages are vendored from
https://github.com/agent-CI-Infra/dashboard at revision
`9e57dfaf11fa44606517da454c5732a59d1f7996`.
Their existing presentation and JSON contracts are retained. The dashboard's
MIT license and the single-repository exporter's Apache-2.0 license are kept
in their respective directories.

`dashboard/` builds the existing React application with `/dashboard/` as its
asset base. `single-repo/static/` contains the existing read-only board pages.
`single-repo/gsb/` contains the incremental exporter, and `scripts/` contains
the community collector and gate aggregation adapters. `collect.py` and
`collect.mjs` adapt these collectors to local storage and repository-scoped
GitHub credentials. Collection never commits, dispatches workflows or deploys
to an external site.

Run `npm ci` and `npm run build` at the bot repository root. The production
image includes Python 3 (standard library only) for the existing exporter.
Private incremental state and generated snapshots live beside the bot database
under `public-boards/`; only the explicit exported routes are public.

Upstream page layouts, metric fields and calculations are retained. Hosting URLs and onboarding instructions point at the bot, and the gate page no longer appends demo repositories outside the installation/publication scope.
The community collector exports `collectRepo` and accepts its output directory
from its caller instead of invoking its former command-line entrypoint. Classification configuration is resolved relative to the vendored module.
