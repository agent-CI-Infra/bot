# Worked example: openJiuwen-ai/sciencediscovery

An illustration of a mature five-layer setup, read at revision `a117ae9964f86cdfa6be5c21969a3e8ea5e07507`. It is a large research product whose expensive cases call real models, so its pipeline is far bigger than most repositories need. Take the ideas, not the size.

## The repository

A monorepo with Node/TypeScript services and web UI, Python research services, a Linux sandbox runner (bubblewrap), Docker distribution, Linux binaries and a Windows desktop installer. Real end-to-end journeys call paid model and judge endpoints.

## How its layers map

| Layer | Its trigger | What it adds |
|---|---|---|
| L1 | every PR event, drafts included | architecture, docs, test catalog and E2E metadata checks; no services or browser |
| L2 `pr` | non-draft PR, default-branch push | hermetic unit and system tests, Linux binary and Docker distribution builds; no model credentials |
| L3 `merge` | `merge_group`, after review and enqueue | the same hermetic tests on the queue SHA, mocked browser E2E in parallel workers, a few short real-model journeys; distribution builds are skipped because L2 already ran them on the PR |
| L4 `daily` | nightly schedule or dispatch | distributions again, the Windows desktop installer, a dozen long research journeys |
| L5 `release` | version tag or dispatch | the full benchmark with metrics; a failure prevents creating the draft Release |

## Ideas worth reusing

- **Tags declare the first layer.** Each case carries a tier tag (default L2) next to independent category, cost and backend tags. The layer commands (`ci:l1`, `ci:ut`, `ci:st`, `ci:e2e`, `ci:e2e:real`) select disjoint slices whose union is the cumulative profile, and every one runs locally.
- **The event decides the profile.** A small policy module turns `pull_request` into `pr` and `merge_group` into `merge` regardless of inputs, so a fork cannot request credentials; only dispatch and called workflows choose a profile.
- **One aggregate check.** The gate job reads every job result and fails unless the profile's required jobs succeeded and the others were skipped. The ruleset requires that one check plus the merge queue.
- **Credentials in an Environment.** L3–L5 jobs use one test Environment with no required reviewers: the maintainer's review and enqueue are the trust decision. Jobs that use it exclude `pull_request`, and a regression test checks that.
- **Daily and release call the same workflow** with a fixed profile instead of defining their own lists.
- **Documentation-only fast path** computed from the diff inside the policy job, with a short allowlist; the gate still reports.
- **Exact accounting.** A layer passes only when planned, executed and passed cases are equal; a skip or a missing shard fails it.
- **Contract tests** check that layer commands only run slices of the shared plan and that test files are not outside collection patterns.

## What not to copy blindly

- Sharded mocked browser workers, real-model matrix planning and benchmark metrics exist because its suites take hours and cost money. A repository whose whole PR run takes ten minutes needs none of it.
- A 1000-line workflow is a cost: start with a policy job, two or three layer jobs and a gate.
- Its documents describe the layers in several places. When documents and the policy code disagree, the policy code is what runs; a repository with layered CI should check its documents against it, and a review should report any drift it finds.

## Sources

`.ci/README.md`, `.ci/tier-policy.mjs`, `.ci/test-catalog.mjs`, `.ci/run-layer.mjs`, `.ci/test-selector.mjs`, `.ci/ci-contract.mjs`, `.github/workflows/{ci,nightly,real-e2e,release}.yml` and `.agents/skills/ci/` at the revision above, Apache-2.0. Ideas are summarised here; no code is copied.
