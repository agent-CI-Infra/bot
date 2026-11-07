# Issue #155 information-availability acceptance

This verifies retained inputs, observations, versions and links, not attribution conclusions or model determinism. Existing task/claim/publication gates remain unchanged. See task-trace.md for query and retention boundaries.

## Controlled checks

The first full suite passed 690 tests. Final additional coverage exercises actual model input/public output capture and excludes private reasoning; the final suite contains 691 tests. After extending run coverage to preparation and deterministic verification, the combined request/evaluator/runtime/process/trace regression passed 75 tests. Final-head CI reruns all checks. TypeScript and runtime syntax checks are required separately.

The deterministic trace tests exercise: real SQLite close/reopen; immutable input/config despite later edits; interrupted-run previous linkage; actual operation snapshots surviving later receipt updates; transactional rollback; idempotent run finalization; cursor paging/filtering; foreign-project denial; exact acceptance linkage for child/grandchild tasks; oversized payloads with explicit incompleteness and credential/private-reasoning omission. Existing real Git snapshot/restore, obsolete claim, version mismatch, uncertain publication, repeated followup and evaluator-outage tests remain applicable.

## Real OpenToday continuation

A private isolated SQLite backup of the original trial was used, preserving the original 13 tasks as legacy history without inventing runs. The original service/database was not migrated or modified. Task `9114f0d55098306830512ca50347a65bc0ce481068a8daef` used the actual TaskEngine, GitHub App, opt-in LocalManager and DeepSeek model `deepseek-v4.1-flash-1017` against Memory PR head `e816af94bba62d68f599a5676dff64013882474e`.

The task inspected loadMemoryFilter/filterMemories, ran actual unit verification, and delivered docs/verification155.md without product changes or publication. A local proxy injected exactly three HTTP 503s at the first independent acceptance request; execution/model responses otherwise came from the configured real provider. The first run stopped at retry_wait/acceptance with the candidate retained. After closing and reopening SQLite, acceptance passed on the same candidate, with no second executor run. The execution workspace was then removed; the archived report was still identical through its task_history source reference.

The pilot recorded one executor and two model-evaluation runs; preparation/full-verification envelope coverage was added afterward and validated in the 75-test regression. It is an iterative development pilot, not a frozen-version unattended benchmark. It forwarded 30 actual provider requests (620,316 known input / 20,366 output tokens), plus three injected failures with unknown usage. No price is configured. Existing historical followups were queried to verify exact parent-candidate/acceptance event linkage, including the citation-fix lineage. No historical input/config gap was manufactured away.

## Availability and limits

Explicit delivered reports are retained, bounded, in SQLite. Whole repositories and arbitrary intermediate binaries are not universally archived. A 2 MiB capture limit, up to 16 advertised delivery files, original bounded/truncated observations, and missing legacy metadata are reported honestly. Build/config references and source snapshots permit inspection; mutable external services and provider internals cannot be replayed exactly. Private model reasoning is excluded from the new capture surface, transport chunks omitted, credentials redacted; the original protected runtime operation store retains its existing behavior.

Task-owned retention survives normal workspace cleanup and database reopen; authorized project deletion intentionally deletes its records. Query access uses existing project grants. No new maintenance timer, approval chain, business task recursion, merge or formal release is introduced. Facts are exported separately from model judgment; detailed original captures remain in the operator database.
