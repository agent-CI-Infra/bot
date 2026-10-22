import type { Action, AutomationModule, Outcome, RuleContext } from '../types.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => object(item)?.name).filter((name): name is string => typeof name === 'string');
}

function headSha(pr: Record<string, unknown>): string {
  const head = object(pr.head);
  return typeof head?.sha === 'string' ? head.sha : '';
}

/** Why a `ready` label is refused, or null when every condition the events can answer holds. */
export function refusal(context: RuleContext): string | null {
  const pr = object(context.event.payload.pull_request) ?? {};
  const facts = context.facts.gate;
  if (pr.draft === true) return 'the PR is a draft';
  if (!facts) return 'the control plane could not read the checks and permissions for this head yet';
  if (facts.maintainer !== true) return `only a maintainer (${context.config.gate.maintainerRoles.join(' or ')}) may add the label`;
  if (facts.conflict !== false) return 'GitHub reports a conflict with the base branch';
  if (facts.headChecksPassed !== true) return `not every required check passed on the head (${context.config.gate.requiredChecks.join(', ')})`;
  if (context.config.gate.reviewMustBeAnswered && facts.reviewAnswered !== true) return 'an open review finding has no answer yet';
  return null;
}

/**
 * The `ready` label and the merge-gate status, ported from PPMA's `gate.yml` / `ci_gate.py` (#1).
 *
 * The module only plans. Acceptance is always `pending`: the scenario finish that used to turn it
 * green is retired, and the merger re-reads the head's checks before merging. Missing facts fail
 * closed — the gate stays pending rather than accepting a label it cannot verify.
 */
export const gate: AutomationModule = {
  id: 'gate',
  plan(context: RuleContext): Outcome {
    const config = context.config.gate;
    if (!config.enabled) return { actions: [], notes: [] };
    if (context.event.event !== 'pull_request' && context.event.event !== 'pull_request_target') {
      return { actions: [], notes: [] };
    }
    const pr = object(context.event.payload.pull_request);
    if (!pr) return { actions: [], notes: [] };
    const number = Number(pr.number ?? context.event.payload.number);
    const sha = headSha(pr);
    const current = labelNames(pr.labels);
    const hasReady = current.includes(config.readyLabel);
    const pending: Action = {
      type: 'status.post',
      context: config.status,
      state: 'pending',
      description: `waiting for the head to be verified (${config.readyLabel})`,
    };
    const actions: Action[] = [];
    const notes: string[] = [];

    if (context.event.action === 'opened') return { actions: [pending], notes: ['a new head starts with a pending gate'] };

    if (context.event.action === 'labeled' && object(context.event.payload.label)?.name === config.readyLabel) {
      // Without verified facts the gate stays pending and the label is left alone: refusing is
      // knowable only from facts, and removing a maintainer's label on a guess would be worse.
      if (!context.facts.gate) return { actions: [pending], notes: ['ready cannot be verified yet; the gate stays pending'] };
      const reason = refusal(context);
      if (!reason) return { actions: [pending], notes: ['ready accepted'] };
      actions.push({ type: 'label.remove', label: config.readyLabel });
      actions.push({
        type: 'comment.upsert',
        marker: `gate:${sha}`,
        body: `The \`${config.readyLabel}\` label was removed: ${reason}.`,
      });
      notes.push(reason);
      return { actions, notes };
    }

    if (context.event.action === 'unlabeled' && object(context.event.payload.label)?.name === config.readyLabel) {
      return { actions: [pending], notes: ['ready removed; the gate re-evaluates'] };
    }

    if (context.event.action === 'converted_to_draft') {
      if (hasReady) actions.push({ type: 'label.remove', label: config.readyLabel });
      actions.push(pending);
      return { actions, notes: ['a draft does not hold a gate'] };
    }

    if (['synchronize', 'reopened', 'edited'].includes(context.event.action)) {
      if (hasReady) {
        actions.push({ type: 'label.remove', label: config.readyLabel });
        actions.push({
          type: 'comment.upsert',
          marker: `gate:${sha}`,
          body: `The \`${config.readyLabel}\` label was removed: the PR changed after it was added. Add it again to approve the new head.`,
        });
      }
      actions.push(pending);
      return { actions, notes: notes.concat(hasReady ? ['ready matched an older head'] : []) };
    }

    return { actions: [], notes: [] };
  },
};
