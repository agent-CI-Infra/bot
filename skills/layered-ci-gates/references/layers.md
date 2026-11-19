# Layer definitions

Each layer is cumulative: it runs every case of the layers below it, then its own. A case declares the first layer that needs it. Budgets below are starting points for wall time of the whole layer (parallel jobs count once); adjust them to the repository and say so.

## L1 — static

- **Trigger:** every pull request event, drafts included (`opened`, `synchronize`, `reopened`, `ready_for_review`), default-branch push, merge group.
- **Runs:** formatting, lint, type checks, architecture/import rules, docs links and spelling, schema and metadata checks, the case catalog check, workflow linting. No service, container, browser or network beyond installing pinned dependencies.
- **Budget:** about 5 minutes, at most 10.
- **Trust:** untrusted code, read-only token, no secrets.
- **Failure means:** the change is malformed; nothing heavier needs to run. Later layers wait for L1.

## L2 — PR

- **Trigger:** non-draft pull requests and default-branch pushes, after L1. Also the merge group (L2 always reruns there on the queue's SHA).
- **Runs:** hermetic unit and system tests, builds and packaging that prove the artifact can be produced, container image builds without pushing, contract tests with local fakes. Deterministic: no real external services, no clock or ordering luck.
- **Budget:** about 15 minutes, at most 30, using parallel jobs or shards before raising it.
- **Trust:** untrusted code (forks included), read-only `GITHUB_TOKEN`, no secrets, no paid calls. Same-repository branches receive repository secrets on `pull_request`, so keep secrets out of repository scope entirely (see [github-setup.md](github-setup.md#credentials)).
- **Failure means:** the change breaks the product. Required before review is worth a person's time and before enqueue.

## L3 — merge queue

- **Trigger:** `merge_group: checks_requested`, created when a maintainer adds a reviewed pull request to the queue. Without a queue, there is no L3; see [Without a merge queue](#without-a-merge-queue).
- **Runs:** L2 on the queue's candidate SHA, plus browser or API end-to-end journeys, tests against real containers or databases, short journeys against real paid APIs, cross-package or cross-service integration, longer system suites. Everything that must block a merge but is too slow, costly or privileged for every PR push.
- **Budget:** about 30 minutes, at most 60. With queue concurrency 1, each queued PR waits for those ahead of it, so throughput is roughly 60 / L3-minutes merges per hour; state this.
- **Trust:** reviewed code. The maintainer's review and enqueue are the trust decision, so L3 jobs may read test credentials from an Environment. Production and publishing credentials never belong here.
- **Failure means:** the queued change (or its combination with others ahead of it) would break the default branch; the queue removes it and the default branch stays green.

## L4 — daily

- **Trigger:** `schedule` (once a day, timed so results are ready when people start work) and `workflow_dispatch`.
- **Runs:** L3 plus suites too long or broad to run per merge: full browser matrix, other operating systems and architectures, installers and desktop packages, real external services and their failure modes, long-running research or model-quality cases, dependency-update canaries, security scans, live tests that need hardware or self-hosted runners.
- **Budget:** hours, split into parallel jobs with their own timeouts.
- **Trust:** default-branch code; test credentials from an Environment.
- **Failure means:** a regression has already merged; someone must be told (an issue, a chat message or a summary that a person reads). A daily run nobody reads is not a gate. Before calling the signal missing, look for how failures are reported today, for example Issues a bot or app opens about failed runs.
- **Caveats:** GitHub runs `schedule` only on the default branch, in UTC, and may start it late or drop it under load; in public repositories, scheduled workflows are disabled after 60 days without repository activity. Treat a missing night as a scheduling miss and dispatch again.

## L5 — release

- **Trigger:** version tag push, `release` events or `workflow_dispatch` on the release ref.
- **Runs:** L4 plus the full benchmark with recorded metrics, release artifact builds for every target, signing, provenance or SBOM, install and upgrade from the previous release, migration checks.
- **Budget:** as long as the release needs; one run at a time, never cancelled half way.
- **Trust:** the tagged commit. Publishing credentials live only in the job that publishes, after the gate passes.
- **Failure means:** do not publish. Prefer creating a draft release only after L5 passes, rather than deleting artifacts afterwards. Do not "fix" a failed release by moving the tag.

## Placement

Put a case in the first layer whose budget and trust allow it:

| The case needs | Layer |
|---|---|
| Only source files and pinned tools; no build of the product | L1 |
| A build, local processes, in-memory or local fakes; deterministic; no secret, network service or special hardware | L2 |
| A browser, Docker, real databases or other local services, and the layer still fits the L2 budget | L2, otherwise L3 |
| Any credential, paid call or external service, and it must block a merge | L3 (needs a merge queue) |
| Long duration, broad matrix, other operating systems, installers, hardware, self-hosted runners, or external flakiness people accept | L4 |
| Release artifacts, signing, publishing, full benchmarks, upgrade from the previous version | L5 |

Further rules:

- Split a case whose parts need different environments rather than raising the whole case.
- A flaky case is fixed or quarantined with an owner, not moved to a later layer to hide it. Quarantine is listed in the report and never counted as a pass.
- Coverage is recorded by the runs that gate, not by an extra run; thresholds are a separate decision.
- Matrix width belongs to the layer that needs it: one platform in L2, the full matrix in L4 or L5, unless the product ships on several platforms and breaks often on one of them.
- Letting documentation-only changes skip the heavy layers is a person's decision, because it removes cases from a blocking layer; when chosen, it is done inside the gate (see [github-setup.md](github-setup.md#documentation-only-changes)), never by leaving a required check unreported.

## Without a merge queue

Without a merge queue, the default branch receives changes that only passed L2. Cases that would be L3 go to one of:

- **Post-merge:** a `push` workflow on the default branch. Failures appear minutes after the merge, on the default branch, after the author has moved on; the next PRs may already be built on top. Needs someone to watch it or an automatic issue.
- **Daily:** joins L4. Failures appear up to a day after the merge, mixed with every other change of that day, so finding the culprit takes bisecting.

State which one, the delay, and who gets the signal. If that delay is unacceptable, the case belongs in L2 (if it can be made hermetic and fast) or the repository needs a merge queue.

## Layer health

A layer is set up only when all hold: it has a trigger, it runs at least one case, its failures fail a check people see (required for L1–L3), and someone receives L4/L5 failures. Report each layer as `working`, `partial` (with what is missing) or `not set up`. Never call an empty or never-triggered layer passing.
