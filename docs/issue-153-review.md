# Independent review resolution

An independent DeepSeek review used a fresh context and the actual task domain/evaluator/request/checkpoint source. Its findings were checked against the complete implementation rather than adopted as new gates.

Confirmed and fixed:

- Execution evidence now comes only from the current execution, retains the actually observed file/source version, and does not label error/timeout/truncated results as successful verification. Historical evidence remains in history.
- Submission, staged acceptance and final decisions check the live task claim at the commit boundary. Ordinary-request updates reject lost claims. Checkpoints recheck execution ownership, contract revision and workspace after the asynchronous snapshot operation.
- Checkpoint restoration requires an artifact-checkpoint record belonging to the same task, contract and base. An arbitrary input pointer cannot name another task's artifacts.
- A genuinely new verdict can accept the same candidate after evidence is recovered. An identical rejected candidate and identical verdict has a finite no-progress exit; all rounds remain in history.
- Evaluator and ordinary-request cleanup now includes preparation failures. Verifier ids/source versions are recorded. Report inspection uses the original source snapshot when present; code/file reads come from the submitted Git object.
- Delivered tasks cannot be silently revised or given a different candidate; exact replay remains idempotent. This also prevents a second residual set being created through a new candidate on a delivered task.

Findings whose triggers do not apply:

- Every task insertion creates its task_records row through the Store-installed trigger, including residual tasks. This is tested across task kinds and transaction rollback; there is no independent unsupported Store path without the trigger.
- Public task creation accepts repository_id/request/contract only, not arbitrary tasks.input, snapshot_sha or recovery. A caller cannot inject those fields through the API. The checkpoint ownership check additionally makes the invariant explicit.
- Human contract revision updates both the authoritative contract and execution input and is rejected while running or after publication. The first-execution completeness initialization cannot overwrite an explicit human revision.
- Staged verdicts are consumed by the existing engine's completion boundary. The domain-only reviewer did not inspect that caller. Publication uncertainty tests verify no residuals or original completion occur before reconciliation.
- Contract revision after completion is rejected, so completed tasks' residuals are historical lineage rather than accidentally current work under a rewritten parent.

Validation includes real SQLite close/reopen and failure injection, obsolete-claim rejection, refreshed verdict on the same candidate, live Git snapshot/restore, failed-verifier cleanup, raw evaluator transport, and ordinary requests using one/multiple guides and correcting invalid paths before an evaluation outage and resume.

## Final PR review follow-up

The repository bot reviewed final head `c908167` and identified two additional issues. Both are fixed before merge:

- F1: Model transport retries no longer depend on `BOT_LOCAL_EXECUTION`. Trusted `AgentSpec.modelAttempts` defaults to three total attempts in all modes, accepts only integers 1–3, and does not read a model-supplied request override. HTTP 429/5xx and transient transport failures may retry; authentication and guard failures still stop. Domain-only runs without a tasks FK retain their model ledger without attempting an invalid task log insert. Regression tests cover recovery, exhaustion, invalid budgets and permanent authentication errors.
- F2: A rejected final report releases its existing workspace before clearing the generation/workspace identifiers. Regression tests for both return and insufficient_evidence assert exactly one reap for the original workspace and a queued task with cleared identifiers.

The private evidence was verified with the operator's authorized credentials: all 13 persisted trial tasks have accepted, candidate-bound deliveries and SQLite integrity/foreign-key checks pass. The repository bot's read-only token cannot access that private repository; its 404 is an access limit rather than evidence of missing artifacts.
