---
name: roadmap-decomposition
description: Split a broad task into independently verifiable child deliveries and coordinate successive batches after deciding decomposition is useful.
---

# Progressive roadmap decomposition

Read the parent's original request and contract, existing progress and related tasks. Keep source references available to children: a short contract is an index, not a replacement for the original requirements. Identify what is delivered, already owned by active tasks, and still unassigned. Reuse or coordinate existing work before creating more.

## Draw useful boundaries

A child owns a cohesive capability or problem domain with its own meaningful test and acceptance cycle. Could QA accept this child while returning its neighbor? If they must be verified together, keep them together. Include necessary implementation, tests, configuration and documentation in the capability; these steps are not separate product tasks. Do not impose a number of tasks, files, or minutes. Investigate an uncertain boundary before committing to it.

For example, Windows device-path handling and SQLite JSON/JSONB support may be independently testable deliveries. Changing a custom-value trait, migrating its callers and testing the migration usually belong together.

## Choose a runnable batch

Identify necessary inputs, interface agreements and real shared-resource constraints. Start independent work concurrently. Work against an agreed interface can proceed before its producer is integrated when the executor can verify its own deliverable; record the integration requirement. A shared file or a different SHA is not by itself a reason to serialize development. Request Coordinator advice for an actual cross-task conflict.

You decide which work is ready. Record later goals and reasons for deferral in parent progress, or create them with execute=false. Do not build a complete fixed DAG before starting. Use existing task priority and FIFO; do not simulate a separate queue in prose.

## Create a child delivery

Use create_task with as_child=true. For product code use endpoint=reviewable_pull_request when the existing authority permits it; do not substitute a report for working code. Include in request and criteria:
- the capability and observable conditions for acceptance;
- the parent requirement/original source references it satisfies;
- required inputs and interface agreements, relevant persistent facts and where to read originals;
- expected artifacts, verification and known integration dependencies.

Leave implementation choices to the executing team. Paths locate code; they are not a prohibition on reasoned scope changes. Child criteria must cover its assigned outcome without silently removing parent requirements.

Record the batch, remaining parent goals and next decision using record_progress. Read read_child_tasks, handle the returned events, then call wait_for_children with its after_event_id to acknowledge exactly those events. Waiting releases the parent slot. Do not poll or nominate an unfinished parent merely to end coordination.

## Continue from returned facts

Any child result can wake the parent, including failure, cancellation or needs_help. Other children continue. Read the returned task through read_managed_task and inspect the relevant result, QA and versioned evidence; an executor report is not acceptance and an old candidate is not a new delivery.

Choose to reuse a successful artifact, repair the original child, clarify an interface, adjust the breakdown, start newly ready work, or wait again. Ordinary failure does not automatically justify a duplicate task, blind retry or human escalation. A paused, unstarted task needs an explicit start decision. If A is required by C, A ending unsuccessfully does not make C ready.

## Deliver the parent outcome

Compare the original parent requirements with actual child deliveries and the remaining progress record. Arrange integration and necessary cross-capability verification through the available roles. Preserve scope changes and evidence references. All children ending is a coordination event, not parent completion. Only nominate the parent to fresh QA when its full requested outcome and necessary evidence are ready.

## Sources

Adapted concepts: independently reviewable deliverables and self-contained parallel handoffs from obra/superpowers writing-plans and dispatching-parallel-agents. This guide implements Bot's durable task semantics rather than their session workflow. Source URLs and revision are retained in SOURCES.json.
