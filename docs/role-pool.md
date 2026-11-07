# Role-Pool and task coordination

Tasks retain goals, criteria, candidates and final delivery authority. A project can opt into role coordination without changing its existing queue, GitHub event entry points, policy validation or publisher. Existing projects remain on their previous executor until enabled; QA always runs as a recorded role with a fresh evaluation context.

## Configuration and execution

`GET/PUT /api/repositories/:repository/roles` uses existing project administration grants. PUT accepts `{enabled:true,harnesses:{reviewer:"process"},roles:[{id:"security",prompt:"Inspect security boundaries"}]}`. Built-ins are manager, dev, test, reviewer, ux, qa. Additional roles are observers. An entry for a built-in appends project instructions to the framework role prompt; it cannot add tools or authority. Definitions are versioned and pinned when a task instance is created; subsequent configuration changes apply to new instances. Harnesses can differ by role.

With coordination enabled, ordinary requests and development workflows use Manager → selected role runs → nominated delivery → independent QA → existing delivery/publisher. Existing review/event workflows keep their established executor; they share task records and QA. This is an incremental migration, not a claim that every Pi conversation has already moved to Manager.

Manager has only task record, progress, playbook and delegation tools. It cannot edit product files, run commands, publish, accept, complete or merge. `nominate_delivery` selects the latest dev output for QA; it does not change task status to completed. Custom roles follow the observer result contract. Dev is the only writable role; observers receive separate disposable checkouts of a fixed dev snapshot. Their command side effects do not become the delivery tree. Each formal QA evaluation is fresh, even though its role instance and previous evidence remain queryable.

## Shared handoff and continuing context

All role prompts require task-first collaboration: query the contract, candidate and relevant records before starting/resuming; record factual results and next actions; prefer references to duplicated prose; distinguish claims from observations and decisions; keep unknowns explicit; never persist private reasoning.

`delegate_role` carries purpose and record references. It returns a role result source, not a copied report. `read_task_record` supports paged original task-history sources, `task:<this task id>`, and the current `contract:revision:<n>`. Invalid references return correctable tool errors. History, source and run routes remain the common query surface. `GET /api/tasks/:id/roles` exposes instances and assignments, excluding conversation bodies.

One `(task, role)` instance persists its conversation and sequence. Review findings return to the same dev instance. Both initial harnesses support transcript checkpoints, not resumption of a live PID. Interrupted tool batches are marked as missing observations; the role must query durable facts before repeating actions. Context over the provider limit stops explicitly; automatic transcript compaction is not implemented in this phase.

`role_instances` stores pinned definitions, harness and redacted transcripts; `role_assignments` links delegation and result records; `task_runs` adds role, definition version, instance, assignment, harness/version and recovery mode. Role input/output, handoff, record reads and candidate snapshots are factual task history events. Existing tracing and model accounting remain authoritative for actual requests and tools.

## Harnesses and memory

`native` uses the control-plane tool loop. `process` launches an independent Node worker which owns its conversation loop and uses JSON-line RPC for model requests, tool observations and checkpoints. The worker receives no provider/GitHub credential or inherited control-plane environment; the parent validates offered tools and retains the provider/accounting boundary. Both use the project's configured model; these are different running implementations, not model-name aliases. This process boundary is not an OS security sandbox.

Role memory reuses project memory tables and versions with `scope.role`. Default project search excludes role-scoped entries; `GET .../memories?role=dev` queries the role namespace. Roles receive a bounded index and can use `search_role_memory`, `read_project_memory` and, where otherwise allowed, `remember_role_memory`. Actual reads remain recorded; context inclusion is not proof of reading. Agent notes remain unverified and cannot overwrite human facts. Tasks in different projects remain isolated.

## Authorized merge

`POST /api/tasks/:id/merge` accepts `expected_sha` and `merge_method` (`merge`, `squash`, `rebase`). This is an explicit authorized operator action, never an agent or Manager tool. The framework requires an accepted current candidate, completed PR delivery, unchanged verification policy, the exact owned PR head and default target. It inspects remote check runs/statuses, rejects failures/incomplete checks and lets GitHub enforce repository rules. Required merge queues are not bypassed; a GitHub refusal is surfaced. Repeated/uncertain writes reuse the existing publication effect ledger and reconcile the actual merged PR.

Repositories with no remote checks are marked `no_remote_checks`; this is not CI success. Their task's required local policy and QA must still have passed. A confirmed merge produces a `repository_evolved` event with the merge SHA; later tasks prepare from the updated default branch. This endpoint does not deploy, release or confer future merge authority on a role.

Provider reasoning/thinking fields are excluded from worker messages and persisted role transcripts, matching the native loop; existing role transcripts are scrubbed on storage initialization. The shared provider boundary retries interrupted/malformed streams within its finite transport budget before returning retry_wait. This does not turn invalid business output into a pass or repeat an already acknowledged role tool operation.

Trusted integrations can add a driver through `registerRoleHarness(metadata, adapterFactory)`, declaring version, session recovery and event visibility. Project configuration can only select registered IDs; it cannot upload arbitrary executable code. Built-in drivers cannot be replaced by registration. Runtime rows record the selected driver's version independently of the pinned role prompt.
A registered driver can declare `session: task_records` when it cannot continue a transcript. The framework supplies task references, starts a fresh driver context and records `rebuilt_from_task_records` on subsequent calls. It does not label that path a continued conversation. Native process/PID resumption is not part of this first adapter contract.

Role observations tolerate an evidence string by wrapping the unchanged text in a one-element evidence array, with a normalization event. Other submission-format errors get at most two local corrections in either harness, reusing existing observations. No acceptance verdict or completion boolean is weakened. Failed/interrupted assignments are marked accordingly; a resumed role is offered its prior failed submission source so it can repair packaging without repeating unchanged checks.

统一会话生命周期与外部 ACP 执行器接入见 [Harness Runtime](harness-runtime.md)。第一阶段验证 Codex ACP；Native/Process 继续支持，角色结果仍由独立 QA 验收。
