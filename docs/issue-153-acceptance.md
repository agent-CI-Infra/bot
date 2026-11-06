# Issue #153 acceptance

Implementation: [PR #154](https://github.com/agent-CI-Infra/bot/pull/154). Task identity, queue, claims and publication reconciliation remain shared with existing Bot execution. See [task-delivery.md](task-delivery.md) for the domain and interfaces and [issue-153-review.md](issue-153-review.md) for independent implementation review.

## Automated checks

The full local suite passed **681 tests**, with no skipped or cancelled tests. TypeScript and runtime JavaScript syntax checks passed. The Bot console passed **41 Playwright tests**. Both Compose configurations validate. After the full run, the ordinary-request integration case was expanded and rerun successfully to exercise report return and missing-evidence repair, in addition to its existing outage/restart and residual execution checks. CI reruns the complete suite on the submitted branch.

| Requirement | Executed checks |
| --- | --- |
| Universal structured tasks, old data and project persistence | `task-lifecycle.test.mjs`: existing/future kinds, legacy unknowns, independent contract/progress/candidate revisions, SQLite close/reopen, project facts and lineage. API permission/revision checks in `task-acceptance.test.mjs`. |
| Optional guides | Lifecycle tests select zero/one/multiple already-read versioned guides, reject fabricated/stale versions and preserve the contract. Ordinary-request integration actually discovers, reads and selects guides through model HTTP/tool boundaries. No selection count gates execution. |
| Clean independent acceptance | Evaluator tests exclude the executor-message sentinel, narrow tools, inspect raw evidence, preserve source versions and reject foreign evidence. Local runner tests use real Git candidates, mutate the executor checkout and verify the pinned candidate remains readable, including after `git gc --prune=now`. Copied executor paths in verifier commands are rejected with recoverable feedback. |
| Return and automatic evidence recovery | `agent-process.test.mjs`: code publication retries each outcome through the same task/agent. `task-request.test.mjs`: report omissions and missing evidence are returned, the report is amended with the requested observation, and a fresh evaluator reads it before passing. These are controlled model fixtures, not claims about real model judgments. |
| Pass with issues | Atomic original completion, residual creation, lineage, replay and rollback failure injection. The full ordinary-request engine runs the residual task and reads the inherited accepted report before completing. Incomplete core goals/missing mandatory evidence cannot pass. |
| Human decision and finite exit | Explicit human gaps, unchanged unrelated queued tasks, bounded remediation/no-progress and cancellation/claim fences. Evaluation transport faults remain separate from rejected deliveries. |
| Restart and external publication | Candidate-only evaluator restart after HTTP 503 without repeating execution; exact checkpoint restore; staged acceptance before publication; uncertain GitHub publication does not complete the original or create premature residuals; rejected restarted publication queues repair. |
| Production protocol | Docker manager allowlist/source-id validation forwards candidate verification and restore operations. Fake-manager protocol tests complement real local runner tests. Production remains Docker by default. |

## OpenToday real run

The configured model is `deepseek-v4.1-flash-1017`. Real tasks use the same TaskEngine, Store, claims, runner protocol, GitHub client and evaluator. The environment has no Docker daemon, so this trial explicitly uses LocalManager; this is host-user execution, not an OS sandbox. No model fixture supplies the real task verdicts.

Existing [PR #8](https://github.com/zy95-12/OpenToday/pull/8) at `5ad7c51617dcac3b5e8444a5b777643a9cc8a576` supplies the already implemented execution-confirmation browser baseline. It remains unmerged. The following feature PRs target that existing branch:

| Case | Real issue/delivery | Status |
| --- | --- | --- |
| Product research | [#9](https://github.com/zy95-12/OpenToday/issues/9), three-module public-source/code comparison | Pass with issues; two citation-precision residual tasks created atomically |
| Brief switch | [#10](https://github.com/zy95-12/OpenToday/issues/10), [PR #15](https://github.com/zy95-12/OpenToday/pull/15) at `eb203022fe14b77e88b31deed335754e2721e46c` | Pass; 32 unit tests, build, 11 browser tests. This executor selected zero guides, which is permitted. |
| Memory persistence | [#11](https://github.com/zy95-12/OpenToday/issues/11), [PR #16](https://github.com/zy95-12/OpenToday/pull/16) at `e816af94bba62d68f599a5676dff64013882474e` | Pass; 31 unit tests, build, 12 browser tests. Three selected guides: persistence, interaction, browser-verification. |
| Independent inspection | [#12](https://github.com/zy95-12/OpenToday/issues/12) | Pass; verifier independently reconstructed and hash-matched all 16 changed files, checked citations and raw verification records |
| Execution browser verification | [#13](https://github.com/zy95-12/OpenToday/issues/13) | Pass after recovery; 19 unit tests, build and 11 browser tests (including four additional confirmation checks) |
| Release preparation | [#14](https://github.com/zy95-12/OpenToday/issues/14), notes and preflight only | Pass with issues; three ordinary residual tasks created for command attribution, inline-code escaping and summary counts |
| Small Brief verification / single-guide observation | [#17](https://github.com/zy95-12/OpenToday/issues/17), real Chromium empty-state fixture on PR #15 | Pass; exactly one browser-verification guide; 32 unit tests, build and 14 browser tests, including a negative fixture check |

The two feature heads were combined locally on `193c642d9e1c9d337c1c81327c236887738933e2`. README/style conflicts were resolved to retain both changes. **44 unit tests, build and 16 real browser tests passed**. This is local integration evidence, not a merged remote branch; the conflict resolution must be retained when actually integrating the feature branches.

## Evidence and limits

The live SQLite database is the authoritative task state. Operator scripts seed inputs/export persisted facts; they do not decide business completion. The [persisted evidence export](https://github.com/zy95-12/OpenToday/pull/18) contains each task's contract revisions, guide versions/purposes, timeline, immutable artifact references, evidence digests/locators and actual acceptance rounds. Model conversations and credentials are excluded.

No new user approval was required during normal steps. Engineering intervention was required to fix transport/path/background-process issues, recover failed attempts, hand over a running process and narrow an over-exploring research task through the versioned contract API. These interventions remain in history; this run does not demonstrate unattended operation without engineering support. Research originally reached its finite turn limit and was not marked complete. Known model usage and acceptance duration are recorded separately; requests without usage remain unknown. No price is configured, so monetary cost is not claimed.

All five outcomes and crash/replay cases are exercised in controlled tests. The real research report received pass_with_issues and created two ordinary residual tasks (a nonexistent citation key and inconsistent pair/key units); these are actual evaluator findings, not forced synthetic problems. No implementation PR is merged and no production release is performed.

## Final acceptance snapshot

All **seven required real cases are accepted**. SQLite integrity and foreign keys pass; all 13 tasks have structured records and history. Ten tasks have accepted deliveries; three newly created release-report residual tasks remain running/queued. These residuals do not reopen or block the accepted parent. The research citation/count children and a Markdown-fence grandchild actually executed and passed independently, demonstrating ordinary follow-up scheduling and inherited artifacts. Parent candidates remain immutable; corrected child versions are preserved separately rather than overwriting the original evidence.

Selected guide counts were research 2, Brief development 0, Memory 3, browser verification 1, review 2, Brief empty-state verification 1 and release preparation 2. This establishes actual zero/single/multiple selection without requiring a guide as an execution gate.

A final inheritance check also verifies that residuals retain the parent's authorized context attachments, in addition to its accepted artifact. The 17 request/evaluator integration tests pass after that change. CI reruns the full 681-test suite and browser checks on the final commit.

### Real semantic negative controls

Separate controlled inputs were evaluated by the actual DeepSeek model, not fixture verdicts. Missing required content produced `return`; implemented code without required raw browser evidence produced `insufficient_evidence`; mutually exclusive owner requirements with no delegated authority produced `needs_human`. Combined with the live `pass` and `pass_with_issues` deliveries, all five outcomes were observed. Initial/refined/routed control results are archived in the private evidence PR, including unexpected judgments: an ambiguous report endpoint initially allowed pass-with-issues, and the refined configuration conflict initially returned for repair. Clarifying endpoint semantics and giving genuine authority conflicts precedence corrected the latter. This small experiment is not a general model reliability guarantee.

### Time and resource observations

At the evidence snapshot, ordinary execution recorded 941 model calls (48,409,209 input / 890,178 output tokens), acceptance 225 calls (13,477,882 input / 365,181 output), and implementation review 13 calls (171,977 input / 46,708 output). Cached-input counts are subsets of input, not additional usage. Four execution/acceptance calls have unknown usage. Additional semantic controls are exported separately; prices are unconfigured. These are cumulative development-trial costs, including retries and engineering recovery, not steady-state per-task costs.

Successful acceptance runs for the seven main cases took approximately 55–326 seconds each. Failed verifier runs are separately recorded, including three release evaluation faults (about 476, 426 and 118 seconds); they did not count as business rejection or silently complete tasks. Bounded explicit verdict submission and same-candidate raw-observation reuse address the repeated exploration observed here. Model opinions are not reused as proof; a changed candidate or contract invalidates reuse.

The trial exposed over-exploration, schema errors, late drafts and very fine-grained report follow-ups. All interventions and failed attempts remain visible. The three remaining formatting/attribution tasks illustrate a granularity/cost limitation, not an additional approval gate. The background process can continue ordinary follow-ups, but reboot autostart, webhooks and unattended production operation were not established. No PR was merged, and no tag or production deployment was created.
