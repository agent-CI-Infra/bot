---
name: layered-ci-gates
description: Design or review a repository's CI as cumulative gates (PR, merge queue, daily, release) fitted to what the repository is, its languages and its architecture. Use when onboarding a repository's CI, when asked which checks should run where, or before changing .github/workflows/ or per-layer test scripts in a CI task.
---

# Layered CI gates

Gates grow with trust and cost. A pull request gets fast checks that need no special environment and cost nothing. After a person has reviewed the change, the merge queue can run complex and costly suites. Daily and release runs add more on top. Each layer runs everything the layer before it runs, plus its own cases.

| Layer | Runs on | What belongs there |
|---|---|---|
| L1 static | every PR, drafts included | lint, format, type and architecture checks, docs and metadata checks; no services or browser |
| L2 PR | non-draft PRs and default-branch pushes | L1 + hermetic unit and system tests and builds; no credentials, no paid calls |
| L3 merge | `merge_group`, after review and enqueue | L2 rerun on the queue's SHA + E2E, credentialed or longer suites that must block a merge |
| L4 daily | schedule or manual dispatch | L3 + long, broad or externally dependent suites, installers, wide matrices |
| L5 release | version tag or manual dispatch | L4 + full benchmarks, release artifacts and upgrade checks; blocks publication |

Budgets, trust rules and placement rules are in [references/layers.md](references/layers.md).

## Rules

1. Start with L1 + L2, then grow one layer at a time. Do not propose all five layers at once for a repository that has no working PR gate. Size the plan to the repository: when its whole suite takes seconds and it ships nothing, L1 + L2 and a release check may be all it needs; do not add artifacts, matrices or repeated runs it has no use for.
2. Never weaken an existing gate without a person's explicit decision. Removing a required check, moving a case to a later layer, adding a skip, `continue-on-error` or a path filter to a required workflow, a documentation-only fast path that skips cases, or dropping `merge_group` all weaken it. List such proposals under "needs a decision" with what is lost.
3. An empty layer is "not set up", not "passing". A layer that has no trigger, a job that ran zero cases, and a required check that was skipped all count as missing.
4. Without a merge queue, L3 cases move to post-merge (push to the default branch) or to daily. Say what that delays: how long until a failure is seen, that it lands on the default branch, and who receives the signal.
5. When a layer has no script, propose creating one: its name, its local command, and the tags or markers that select its cases. Workflows call these scripts and never keep their own lists of cases.
6. Credentials never reach `pull_request` jobs, and `pull_request_target` never checks out PR code.
7. Every workflow change goes through a bot pull request from a development task that a project administrator confirmed may change `.github/workflows/`. Repository settings (rulesets, required checks, merge queue, Environments, secrets) are changed by a person: list them and never report them as done.

## Method

### 1. Profile the repository

Find out what it is for (library, service, CLI, web or desktop app, infrastructure, documentation), its languages, build tools and package managers, its architecture (workspaces or monorepo, services, containers, UI), how it is released, and how people collaborate (PR volume, reviews, whether a merge queue or ruleset is in use).

Read, in this order: README, CONTRIBUTING and testing docs; manifests and script runners (`package.json` scripts, `Makefile`, `justfile`, `Taskfile`, `pyproject.toml`, `tox.ini`/`noxfile.py`, `go.mod`, `pom.xml`/`build.gradle*`, `Cargo.toml`); test directories and their configuration; every file under `.github/workflows/`; recent Actions runs for durations and failure rates; branch rules. Rules come from `GET /repos/{owner}/{repo}/rules/branches/{branch}` (rulesets: required checks, merge queue) when your tools can read it. Classic branch protection (`/branches/{branch}/protection`) does not show rulesets, so its 404 "Branch not protected" proves nothing. When no rules are readable, report them as unknown and use indirect evidence: runs with event `merge_group` or `gh-readonly-queue/` refs mean a merge queue is in use. [references/stacks.md](references/stacks.md) says where each stack keeps its tests and what usually belongs in each layer.

### 2. Inventory the cases

List one row per runnable entry point (a command, not a single test): what it covers, what it needs (services, Docker, browser, GPU or other hardware, outbound network, credentials, paid APIs), how long it takes (measured from a named run, or estimated: say which), how flaky it is, and when it runs today and whether that check is required. Include scripts and test directories that no workflow runs: they are the most common gap.

### 3. Place every case

Put each case in the first layer whose budget and trust allow it, by the rules in [references/layers.md](references/layers.md#placement). Split a case when one part needs a stricter environment than the rest. Record why each case sits where it does.

### 4. Decide on a merge queue

Recommend one when cases that must block a merge cannot run on PRs (credentials, cost, duration, special environment), or when many PRs merge daily and must be tested against each other. Otherwise L3 stays empty and its cases go post-merge or daily (rule 4). [references/github-setup.md](references/github-setup.md) gives the queue settings and the stable aggregate check that works with or without it.

### 5. Find and fill the gaps

Typical gaps: cases no layer runs; layers without a local command; case lists maintained inside workflows; several required checks instead of one aggregate; required workflows missing a `merge_group` trigger; skipped jobs that count as success; path filters on required workflows; credentials visible to PR jobs; no timeouts; nothing that checks the workflows still match the policy. Propose concrete scripts, tags and jobs. [references/catalog.md](references/catalog.md) describes the case catalog, tags and per-layer commands.

### 6. Report and plan

Write the recommendation in the format of [references/report.md](references/report.md): repository profile, current CI, proposed layers with a case table, estimated time and cost, settings a person must change, and the PR plan. Split the plan into small pull requests, each one leaving CI working: per-layer scripts and the L1 + L2 aggregate check first, then the merge queue's L3, then daily, then release.

## Evidence

Cite a file and line, a command or a run for every finding. Mark durations as measured or estimated. When something cannot be read (rulesets, Environments, secrets, private logs), report it as unknown and say what would reveal it. While analysing, do not run paid or credentialed suites, push, open pull requests or change settings.

## Advising and implementing

When advising (for example during repository onboarding), stop at the report and a draft of the development task that would carry the first pull request; the person confirms it. When implementing a confirmed CI task, carry out only the slice it names: keep existing gates unless the task records a person's decision to change them, add the scripts before the jobs that call them, run each new local command, and list the settings a person still has to change in the pull request description.

[references/example-sciencediscovery.md](references/example-sciencediscovery.md) shows a mature five-layer setup. It illustrates the ideas; it is not a template, and most repositories need far less.

## Sources

The layering, catalog and aggregate-check ideas are distilled from [openJiuwen-ai/sciencediscovery](https://github.com/openJiuwen-ai/sciencediscovery/tree/a117ae9964f86cdfa6be5c21969a3e8ea5e07507/.ci) (Apache-2.0); no code is copied. See SOURCES.json.
