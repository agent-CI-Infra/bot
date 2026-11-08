# Native coordination context and submission

A role configured with a finish tool and no explicit text validator must submit through that tool. Existing callers that explicitly validate text into a structured result keep that validated path; the unchecked text-to-result cast is forbidden for finish-only callers. A normal text response (including empty text) receives bounded format feedback and consumes the existing turn budget; it cannot complete the execution. A provider response ending with `finish_reason=length` without a tool submission fails explicitly as `agent_output_budget_exhausted`. The transcript is not extended with the truncated output. Existing tool-call argument validation remains mandatory.

The Coordinator uses the same persistent role identity, but rebuilds its transient transcript from durable facts for every attempt/request. This prevents successive full snapshots and failed transcripts from being concatenated. `recovery_mode=rebuilt_from_task_records` records this choice. Historical role inputs, outputs, model requests, evidence, and objections remain queryable in SQLite.

Its initial input contains the coordination request, compact per-task indexes, and an excerpt of the previous result. The index identifies the contract revision, candidate/artifact versions, acceptance outcome and recent event references. Excerpts are explicitly marked; they are not complete contracts or new verification.

`read_project_task` supports read-only discovery within the same project; advice recipients remain restricted to the request task IDs:

- Without `task_id`, list same-project task IDs, issue numbers and statuses (10/page), so omitted owners can be found.
- With `task_id` but without `ref`, return the compact summary and an event index (10 records/page). An optional `type` filters event kinds.
- With `task_history:<id>`, read that task's exact evidence record in 8,000-character pages.
- With `contract:revision:<n>`, read the complete current contract in the same bounded pages, or report that its revision changed.
- `next_offset` and `total_chars` distinguish partial reads from complete records. Reference substitution into a different task and all cross-project reads are rejected.

A returned advice object is checked before notices are consumed. Existing revision checks, claim guards, safe-checkpoint acknowledgements and fresh QA rules still apply. Coordinator advice does not execute product repairs, accept candidates or authorize merges.

## Regression verification

The runtime tests cover plain/empty-text bypass followed by a valid tool submission, and explicit output-budget failure. Coordination tests cover a 60,000-character observation, bounded pagination, foreign-task rejection, a second evaluation after an objection without carrying the first transcript or large evidence forward, missing-source-notice format repair, and omitted-owner discovery without cross-project access.

Real Native replay uses an isolated SQLite backup and the same model configuration as experiment #193; no live task/notice state is changed. This proves advice generation and persistence, not downstream adoption, product repair or fresh QA completion. Replay measurements and the resulting decision should be recorded with the experiment evidence.

Missing ownership information and ordinary integration conflicts do not by themselves require a human decision. The Coordinator can recommend that the parent Manager delegate a code repair under its existing task contract; a temporary docs-only child assignment does not narrow that parent contract. Actual goal/criteria changes and explicit user restrictions still require the corresponding decision.

## Experiment #193 real Native replay

The final replay used the pre-interruption SQLite backup from 2026-11-08 14:27 UTC and the unchanged original coordination request. It retained `deepseek-v4.1-flash-1017`, Native, 12 turns and 8192 output tokens. It ran against an isolated copy, not the live experiment database.

On the final implementation, the run took 106 seconds (15:26:58–15:28:44 UTC), made 9 model requests, and persisted `outcome=notices` / `state=awaiting_feedback`. Initial input was 8,064 tokens; the largest request after evidence reads was 33,563. The original failed attempts had 154,929 and 236,247 input tokens and exhausted the output budget with no submission. This is a comparison of per-request context size, not a claim of a 95% reduction in total run cost.

The agent discovered the omitted settings task #37 through the same-project task index. It connected reviewer record `task_history:112641` (parent tree `788df703…`) to #37's delivered candidate and accepted save-time change. It recommended assigning integration repair to the live homepage task, preserving user-save and migration/export semantics, resolving the docs conflict separately, and obtaining fresh tests plus independent QA on the repaired exact tree. It did not treat ordinary ownership discovery or merge repair as a human decision, and did not claim to have repaired or accepted the product.

Development replays are retained rather than counted as successes: before project discovery/clear parent-versus-child guidance, one run omitted its source notice and failed validation, another returned `needs_human` for missing ownership, and another generated usable notices. After discovery was added, both the first discovery replay and final implementation replay returned actionable notices and identified #37. Two samples show feasibility, not a guarantee that every future model decision will be correct. Safe-checkpoint adoption and downstream product repair are not exercised by these isolated runs.
