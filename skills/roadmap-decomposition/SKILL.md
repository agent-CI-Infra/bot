---
name: roadmap-decomposition
description: Split a broad task into independently verifiable child deliveries and coordinate successive batches after deciding decomposition is useful.
---

# Progressive roadmap decomposition

Read the parent's original request and contract, existing progress and related tasks. Keep source references available to children: a short contract is an index, not a replacement for the original requirements. Identify what is delivered, already owned by active tasks, and still unassigned. Reuse or coordinate existing work before creating more.

## Draw useful boundaries

Prefer child deliveries organized around a meaningful capability or problem domain with observable acceptance conditions. Implementation, tests, configuration and documentation usually belong to that delivery rather than separate product tasks.

The breakdown is a current allocation of responsibility, not a fixed implementation boundary. Shared files, shared interfaces or final joint verification do not by themselves require one task: assess whether each team can advance its deliverable and provide useful acceptance evidence. Investigate uncertain boundaries and adjust progressively as facts arrive. Each child Manager can make the same judgment about further decomposition; there is usually no need to prescribe a decomposition depth, task count, file count or duration.

For example, Windows device-path handling and SQLite JSON/JSONB support may be independently testable deliveries. Changing a custom-value trait, migrating its callers and testing the migration usually belong together.

## Choose a runnable batch

Identify necessary inputs, interface agreements and real shared-resource constraints. Start independent work concurrently. Work against an agreed interface can proceed before its producer is integrated when the executor can verify its own deliverable; record the integration requirement. A shared file or a different SHA is not by itself a reason to serialize development. Inspect same-project tasks with `list_project_tasks` / `read_project_task` and use `wait_for_tasks` only when there is a real delivery or merge dependency.

You decide which work is ready. Record later goals and reasons for deferral in parent progress, or create them with execute=false. Do not build a complete fixed DAG before starting. Use existing task priority and FIFO; do not simulate a separate queue in prose.

## Create a child delivery

Use create_task with as_child=true. For product code use endpoint=reviewable_pull_request when the existing authority permits it; do not substitute a report for working code. Include in request and criteria:
- the capability and observable conditions for acceptance;
- the parent requirement/original source references it satisfies;
- required inputs and interface agreements, relevant persistent facts and where to read originals;
- expected artifacts, verification and known integration dependencies.

Describe the child's assigned capability, observable acceptance conditions and the parent requirements it implements. The parent retains the remaining goals and final integration; each child need not deliver the entire parent roadmap. Keep all parent requirements accounted for across child deliveries and the parent's remaining work.

Leave implementation choices to the executing team. Paths are starting points; sibling assignments describe responsibility. Neither usually belongs in acceptance criteria as "only these files may change", "other areas must not be touched" or "no further child tasks". Necessary cross-module changes can proceed with their relationship to the goal, impact and verification recorded; coordinate when they affect another running task.

Distinguish original requirements and real authority limits from the Manager's current execution plan. Preserve the former accurately; adjust the latter as facts change rather than turning it into a new immutable constraint. QA assesses the assigned outcome and the reasons and evidence for adjustments, not mechanical compliance with the initial division of work.

Record the batch, remaining parent goals and next decision using record_progress. Read read_child_tasks, handle the returned events, then call wait_for_children with its after_event_id to acknowledge exactly those events. Waiting releases the parent slot. Do not poll or nominate an unfinished parent merely to end coordination.

## Continue from returned facts

Any child result can wake the parent, including failure, cancellation or needs_help. Other children continue. Read the returned task through read_managed_task and inspect the relevant result, QA and versioned evidence; an executor report is not acceptance and an old candidate is not a new delivery.

Choose to reuse a successful artifact, repair the original child, clarify an interface, adjust the breakdown, start newly ready work, or wait again. Ordinary failure does not automatically justify a duplicate task, blind retry or human escalation. A paused, unstarted task needs an explicit start decision. If A is required by C, A ending unsuccessfully does not make C ready.

## Deliver the parent outcome

Compare the original parent requirements with actual child deliveries and the remaining progress record. Arrange integration and necessary cross-capability verification through the available roles. Preserve scope changes and evidence references. All children ending is a coordination event, not parent completion. Only nominate the parent to fresh QA when its full requested outcome and necessary evidence are ready.

## Sources

Adapted concepts: independently reviewable deliverables and self-contained parallel handoffs from obra/superpowers writing-plans and dispatching-parallel-agents. This guide implements Bot's durable task semantics rather than their session workflow. Source URLs and revision are retained in SOURCES.json.
