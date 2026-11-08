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
