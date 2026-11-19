# Recommendation report

Write the report in the language of the conversation. Keep it short enough to read in a few minutes: tables for facts, one line of reason per decision. Cite files, commands and runs. Mark every duration as measured (with the run) or estimated.

## 1. Repository profile

Purpose, languages and build tools, architecture (packages, services, UI, containers), how it is released, collaboration (PR volume, review, whether a ruleset or merge queue is in use: say unknown when unreadable).

## 2. Current CI

| Workflow / job | Trigger | Runs | Duration | Required | Layer it acts as |
|---|---|---|---|---|---|

Then the health of each layer: `working`, `partial` (what is missing) or `not set up`. List scripts and tests that no workflow runs.

## 3. Proposed layers

| Case (command) | Covers | Needs | Duration | Today | Proposed layer | Reason |
|---|---|---|---|---|---|---|

Follow with:

- whether to use a merge queue, and why; without one, where L3 cases go and what that delays;
- the per-layer local commands to add and the tags or markers to use;
- gaps that are not about placement (aggregate check, `merge_group` triggers, credentials, timeouts, contract tests);
- **needs a decision:** anything that would weaken an existing gate, with what is lost.

## 4. Estimated time and cost

Per layer: wall time, runner minutes per run, runs per day (PR pushes, queue entries, nightly), paid calls or other spending per run. Say which numbers are estimates.

## 5. Settings a person must change

A checklist of repository settings (ruleset, required checks, merge queue settings, Environments and their secrets and branch rules, fork workflow approval, schedules), in the order they must happen relative to the pull requests. A required check added before its workflow exists blocks every PR.

## 6. PR plan

Numbered small pull requests, each leaving CI working:

| # | Changes | Files | How it is validated | Setting changed after it merges |
|---|---|---|---|---|

The first is usually per-layer scripts plus the L1 + L2 aggregate check. Every pull request that changes `.github/workflows/` is a development task confirmed by a project administrator. State what the first task's request would say.

## 7. Open questions

Only what a person must answer before the plan can proceed.
