# GitHub setup

Workflow files are committed through a bot pull request. Everything under "a person sets" is repository administration: committing YAML never creates it, and an assistant only lists it.

## One stable aggregate check

Require one check, for example `gate`, instead of every job. A required check that is never reported blocks merging forever, and a job skipped by `if:` reports success, so a list of required jobs is both brittle and easy to bypass.

The workflow has three parts:

1. **policy** job (first, no secrets): maps the event to a profile and writes it to job outputs.
   - `pull_request` → `pr` (L1, plus L2 when not a draft)
   - `merge_group` → `merge` (L3)
   - `push` to the default branch → `pr`, or `post-merge` cases when there is no queue
   - `schedule` → `daily` (L4); version tag → `release` (L5)
   - `workflow_dispatch` → the requested profile, from a fixed `choice` list
   An input can never raise the profile of a `pull_request` or `merge_group` event: compute the profile from `github.event_name` first, and only dispatch and called workflows read the input.
2. **layer jobs**, each with `needs: policy` and an `if:` on the profile outputs, a `timeout-minutes`, and the per-layer command from the catalog (no inline case lists).
3. **gate** job: `needs:` every layer job, `if: always()`, and a short script that reads `toJSON(needs)` and fails unless every job the profile requires succeeded and every job it does not require was skipped. A cancelled, failed or unexpectedly skipped job fails the gate; so does a job that ran outside its profile.

Daily and release workflows call the same workflow with `workflow_call` and a fixed profile, so there is one definition of what each layer runs. A called workflow sees the caller's `github.event_name`; pass the profile explicitly. Use `concurrency` keyed on workflow and ref with `cancel-in-progress: true` for PRs, never for release.

When several workflows already exist (for example images, CodeQL), either fold their jobs under the gate or keep them as separate required checks; both work, but each required check must run on `pull_request` and `merge_group` alike.

## Merge queue

Requirements and settings a person sets in the default branch's ruleset (or branch protection):

- **Require status checks to pass:** add the aggregate check. Enabling the queue alone does not make anything required.
- **Require merge queue**, with: merge method (match the repository's history policy), build concurrency 1 to start, minimum group size 1, **Only merge non-failing pull requests**, and a status check timeout longer than the slowest L3 run plus setup.
- **Require a pull request before merging**, approvals as the project needs, dismiss stale approvals and require approval of the most recent push when reviews are the trust decision.
- Every workflow that reports a required check must have `on: merge_group` (types `checks_requested`); otherwise the queue waits until its timeout and removes the PR.
- Do not require a queue-only check on the PR itself: the same aggregate check runs L1/L2 on the PR and L3 on the group.

Queue runs test a temporary branch `gh-readonly-queue/<base>/pr-<number>-<sha>`; results belong to that SHA, not the PR head. A PR removed and re-added runs L3 again, paid calls included.

When a repository cannot use a merge queue (plan, merge policy or volume), L3 moves to post-merge or daily; see [layers.md](layers.md#without-a-merge-queue).

## Credentials

- Put test credentials (model API keys, cloud test accounts) in an **Environment**, never in repository or organization secrets that every workflow can read. Only jobs that declare `environment:` receive them.
- Jobs with `environment:` also carry `if: github.event_name != 'pull_request'`. Add a contract test that fails when a job referencing a secret lacks either.
- Deployment branch and tag rules on the Environment (a person sets): the default branch, `gh-readonly-queue/<default>/*`, release tags and explicitly trusted dispatch refs.
- Required reviewers on the test Environment are optional; with them, every queue run waits for a click. The review before enqueue is usually the trust decision.
- Publishing credentials (registry tokens, signing keys, deploy keys) live in a separate Environment used only by the publish job after L5 passes.
- `permissions: contents: read` at the workflow top; widen per job only where needed. `actions/checkout` with `persist-credentials: false` unless the job pushes.

## Fork safety

- Use `pull_request` for PR checks. Fork PRs get a read-only token and no secrets.
- Never combine `pull_request_target` (or `workflow_run` with elevated permissions) with a checkout or build of the PR's code: that runs untrusted code with secrets.
- Dependabot PRs receive only Dependabot secrets; plan for L2 to work without any.
- First-time contributor approval ("Require approval for fork pull request workflows") is a person's setting.

## Documentation-only changes

A fast path skips cases on a blocking layer, so propose it as a decision for a person, with what it skips. When chosen, it is a policy output, not a path filter. `paths-ignore` on a required workflow leaves the check unreported and blocks the PR. Instead, the policy job computes the changed files (merge base for PRs, base/head SHAs for push and merge group), sets `docs_only=true` when every path matches a short allowlist (for example `*.md` outside source trees, `docs/**`, `LICENSE`), and the gate then requires only the policy and docs checks. An empty or unreadable diff keeps the full profile. Dispatch and scheduled runs always run their full profile.

## Contract tests

Keep the workflows honest with a small test in L1:

- each layer job calls a catalog command, not a hand-written list;
- every required workflow has `pull_request` and `merge_group` triggers;
- jobs that use secrets have `environment:` and exclude `pull_request`;
- no `pull_request_target` job checks out PR code;
- every job has `timeout-minutes`;
- the gate's required-job map matches the policy's profiles.

## Reading settings

With repository read access: `GET /repos/{o}/{r}/rules/branches/{branch}` (effective rules, including required checks and merge queue), `GET /repos/{o}/{r}/rulesets`, `GET /repos/{o}/{r}/actions/workflows`, `GET /repos/{o}/{r}/actions/runs?branch=...&event=...` for durations. Rulesets and classic branch protection are separate: a repository protected only by rulesets answers 404 "Branch not protected" on `/branches/{branch}/protection`, and `/branches/{branch}` may show `protection.enabled: false`. Runs with event `merge_group` show that a queue is in use. Environments, secrets and some protection details need admin rights; report what cannot be read as unknown rather than guessing.

GitHub documentation: [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).
