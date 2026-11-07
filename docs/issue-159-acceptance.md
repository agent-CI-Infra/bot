# Issue #159 acceptance evidence

This report separates deterministic integration tests, real model development and live repository changes. The task ledger is the shared source; role conversations are not the sole handoff. No attribution conclusions or efficiency improvement are claimed.

## Real OpenToday development

- Source Issue [#22](https://github.com/zy95-12/OpenToday/issues/22), task `5fc9c8658a966a346804832ae8b9394e1b3cee13339ee68e`: Manager/native, Dev/native, Reviewer/process and QA/native. The process driver ran its own worker loop with framework model/tool RPC. Dev returned to the same instance across recovery; observers used independent candidate checkouts.
- Delivered [PR #23](https://github.com/zy95-12/OpenToday/pull/23), head `2a57d1d610f712a1beaa4e766c90291e36da5ef3`, tree `1aad1aef05fbd486af378d6fa95df6bf4a1276fa`: Living Memory title/content search, matching count and empty states. Mandatory `npm ci && npm test && npm run build` passed, including 31 product tests. Reviewer result is `task_history:696`, QA evaluated/pass is `task_history:816`, delivery is `task_history:831`.
- Explicitly authorized framework merge confirmed main commit `e8631700c6421da32388622a262e01ed78a8f38d`; `task_history:838` records checks, `task_history:839` the merge receipt, `task_history:840` the repository evolution. This repository had no remote check runs/statuses; the record says `no_remote_checks`, not remote CI success. Required local policy and independent QA passed. No deployment/release occurred.
- Follow-up Issue [#24](https://github.com/zy95-12/OpenToday/issues/24), task `fd840736ec6c0d7b7d5b7e5423b44d042f350911bfd1e56f`, prepared from this updated main SHA. It adds persisted category filtering combined with search, using Dev/Test/UX and QA. Actual browser assertions and final delivery are being completed; this row is not yet a passing final result.
- The second task actually read role memory `fce5ea08270c3e7a96772f49e6df9c7dcfce086bf5729ccd:1` (`task_history:919`). This source-backed experience was retained by the authorized operator from the first completed task, not invented as an autonomous agent memory write. New task/role instances do not inherit the prior executor conversation.

## Query-only reconstruction

A fresh real model context received only the first task ID and authenticated query tools against an isolated consistent SQLite copy served by the real control-plane HTTP server. It made 14 queries and 20 original source reads, reconstructing contract revision 2, all four role instances/harnesses, recovery, candidates, QA pass, PR #23 and its exact merged SHA. Original role sessions were excluded from the role API. Anonymous requests returned 401.

The first verifier assertion incorrectly expected a bare source ID, while the model returned descriptive citations containing multiple actual source IDs. The existing model result and recorded reads were checked against those IDs through HTTP without rerunning or changing its conclusions. Two earlier reader attempts received upstream HTTP 530; these are external faults, not successful reconstruction runs.

## Deterministic coverage mapped to the Issue

| Requirement | Evidence |
| --- | --- |
| Minimal team, no compulsory optional roles | `roles.test.mjs`: minimal Dev/Manager nomination leaves task running for framework QA; repeated delegation reuses the durable result |
| Multiple roles and advisory playbooks | Real #22 selected and read several playbooks; real #24 exercises Test/UX; no global all-role gate |
| Review back to the original Dev context | Controlled Manager → Dev v1 → Reviewer finding → same Dev v2 integration, with persisted result references |
| Reference-only handoff | Controlled role reads plus real handoff sources; invalid references return recoverable tool errors |
| Old evidence cannot certify new candidates | Observer replay binds candidate versions; existing acceptance tests check exact candidate/revision evidence reuse |
| Fresh mandatory QA and Manager restrictions | Both harnesses use fresh QA contexts; Manager has no execution/acceptance/publication tools; direct forbidden tool calls are rejected |
| Pass with issues | QA-role results reuse TaskRecords atomic child creation; replay does not duplicate residual tasks or expand child permissions |
| Return / insufficient evidence / needs human | Controlled QA-role results produce queued repair/proof collection versus needs_replan; existing evaluator semantics remain enforced |
| Restart recovery | Real SQLite reopen, interrupted tool receipts, role identity preservation, owned snapshot reconciliation and actual first-task recovery |
| Second real Harness | Real #22 process Reviewer plus native roles; process driver and native driver separately run transport-recovery/session tests |
| Cross-task role memory | Scoped namespace tests; actual fixed-version read in the second task; old experience is applicability-checked data |
| Query-only factual reconstruction | Real HTTP/auth and fresh model experiment above; conclusions checked against actual role IDs and merge receipt |
| Compatibility and nonblocking optional state | Existing task entry points retained, legacy review/event executors remain available; optional role-memory query failure explicitly continues; full CI required before completion |

## Disclosed corrections and limits

Real development exposed invalid task/contract reference handling and a legacy `../notes` write expectation. Both were corrected; fault records were retained. Dev source and continuing session were recovered using acknowledged owned snapshot receipts, with contract/base checks. The second task also encountered upstream stream failure; runtime transport retry now handles interrupted streams without repeating acknowledged role tools.

Worker provider reasoning fields were initially retained in process transcripts. The driver now forwards only assistant content/tool calls, storage scrubs existing auxiliary fields, and regression tests cover both harnesses and reopen migration. The isolated live transcript check confirmed zero remaining private auxiliary fields before export.

Role-result run linkage, observer replay version binding, driver registry and optional-memory fallback received deterministic regression coverage after early pilot runs. Pilot run metadata is retained rather than relabelled as the final source revision. Recovery uses transcript checkpoints, not resurrection of a live PID; automatic context compaction and OS sandboxing are not claimed. The memory handoff was seeded by the operator from real source records. Formal QA and actual merge were performed by the framework, never by Manager.
