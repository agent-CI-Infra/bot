# Task priority and related work (#197)

Task Manager decides scheduling priority from QA's impact facts; QA does not set queue order or accept an unrelated goal on the Manager's behalf. Every new task defaults to P2. Residual tasks enter the executable queue directly: there is no new backlog admission gate.

| Level | Evidence-based standard |
|---|---|
| P0 | Observed or credibly imminent major damage requiring immediate containment: ongoing data loss, credential exposure/unauthorized access, widespread core-service outage without an alternative. |
| P1 | A core goal or critical delivery is blocked and there is no acceptable workaround. |
| P2 | Ordinary planned work, final integration/acceptance, or bounded defects with an acceptable workaround. |
| P3 | Non-core polish, wording, or verification beyond the current required acceptance. |

QA reports occurrence conditions, affected scope, evidence, workaround and delivery impact. Manager must record a reason and evidence references; adjectives alone do not establish urgency. Unknown facts do not justify inventing P0/P1. Credible major risk may justify immediate containment.

## Queue contract

`tasks.priority` and `tasks.queue_seq` are persistent. Legacy tasks receive P2 and tickets in chronological creation order (ID breaks ties); opening the database again does not move them. New tasks receive a monotonically increasing ticket from the same SQLite transaction. The next eligible task is ordered by priority, ticket, then ID.

A changed priority receives a ticket at the new level's tail. A no-op change keeps its ticket. Returning from execution to a queued/retry state receives a new ticket when the retry is scheduled; it is not eligible until `next_run_at`. Unready review dependencies and not-yet-due retries do not hold up ready work. A running task is never preempted merely because another task has higher priority. After a restart, interrupted executions rejoin the queue; already queued entries keep their order.

Claim selection, project capacity and claim writes share a `BEGIN IMMEDIATE` transaction. Competing claim callers cannot claim the same task or exceed project capacity. This does not introduce multi-primary control-plane deployment: existing single-instance engine recovery remains the deployment model.

## Manager planning and associations

For a `pass_with_issues` result, a bounded Manager run reads the original QA facts and a compact project task index. It can inspect matching same-project task records and submit one decision per residual:

- `new`: create a distinct task.
- `supplement`: append this discovery to an existing unresolved task; do not create another execution.
- `related`: create independent work and link the related task.
- `recurrence`: create new work linked to an earlier fix, without rewriting its acceptance.

Titles alone never cause automatic merging. The plan is bound to parent task, candidate and contract revision, with the actual Manager run reference. Replaying a completed acceptance does not create another child. Different sources, candidate versions, impact facts, evidence, Manager reasons and an optional same-repository GitHub Issue URL remain in `task_relations`; `source_task_id` is not the only provenance edge.

A similar task that is running triggers a durable Coordinator request. Newly created related work waits for advice; the existing running task consumes notices at its safe checkpoint. Supplementing a running task requests coordination without stealing its claim. Neither path bypasses notice acknowledgement, candidate binding or fresh QA.

If Manager infrastructure/permissions are unavailable, the original QA result is retained, a deferred-planning event records the failure, and residuals enter at explicit default P2. They can subsequently be ranked by their Task Manager or an authorized user; a classification outage is not a new business rejection. New external GitHub writes are not granted: issue publication still belongs to existing authorized work/publish tools; these associations can reference an existing Issue but do not independently create/comment on GitHub.

## Interfaces

- `POST /api/tasks/:id/priority` with `{priority:"P0"|"P1"|"P2"|"P3",reason}`; same project/task-write authorization as other task mutations.
- `POST /api/tasks/:id/relate` with `{key,task_id,relationship:"same_problem"|"related"|"recurrence",reason,evidence}`; active similar work requests coordination.
- Task details expose priority, queue sequence and relations; task lists support `priority=P0` through `P3`.
- Management commands `task.priority` / `task.relate` share these mutation boundaries.
- Task Manager tools `set_task_priority` / `relate_task` record decisions; the role's coordination/nomination permissions remain editable. Worker/QA roles do not receive these tools by default.

## Verification

Automated tests cover priority order, same-level FIFO, unchanged-priority stability, re-entry/ready dependencies, durable reopen, competing real Node processes, QA urgency injection being ignored, explicit Manager decisions, two-source supplementation, recurrence, active-work coordination, and scope protection. A Native tool-loop fixture covers QA facts → Manager plan → Coordinator advice → acknowledgement without accepting the child automatically. Browser coverage checks priority editing, persistence/audit and mobile width.

An isolated real Native/DeepSeek replay uses the actual OpenToday residual facts from task `4f2eed3b…`: three documentation discrepancies and their existing derived tasks. The Manager classified all three as P3, chose to supplement the three existing tasks, created no duplicates, and P2 `final-integration` claimed the next slot. This validates Manager decision-making and queue application on historical facts, not a new product implementation or fresh product QA. The experiment's original database/repository were not modified.
