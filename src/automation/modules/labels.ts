import type { Json } from '../../core/security.js';
import type { Action, AutomationModule, Outcome, RuleContext } from '../types.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => object(item)?.name).filter((name): name is string => typeof name === 'string');
}

function axisCount(labelNames: string[], axis: string): number {
  return labelNames.filter(name => name.startsWith(`${axis}/`)).length;
}

/**
 * Label lint, ported from PPMA's `label-lint.yml` (#1).
 *
 * A violated issue gets `status/triage` and one upserted comment; a passing issue has the label
 * removed. Labels are GitHub state, so the planner reads them from the event payload and emits
 * actions only for the difference.
 */
export const labelLint: AutomationModule = {
  id: 'label-lint',
  plan({ event, config }: RuleContext): Outcome {
    const lint = config.labels.lint;
    if (!config.labels.enabled || !lint.enabled || event.event !== 'issues') return { actions: [], notes: [] };
    const issue = object(event.payload.issue);
    if (!issue || issue.pull_request !== undefined) return { actions: [], notes: [] };
    const number = Number(issue.number ?? event.payload.number);
    const current = labelNames(issue.labels);
    const violations = [
      ...lint.require.filter(axis => axisCount(current, axis) === 0).map(axis => `missing \`${axis}/*\``),
      ...lint.exactlyOne.filter(axis => axisCount(current, axis) !== 1).map(axis => `needs exactly one \`${axis}/*\``),
    ];
    const actions: Action[] = [];
    if (violations.length === 0) {
      if (current.includes(lint.triageLabel)) actions.push({ type: 'label.remove', label: lint.triageLabel });
      return { actions, notes: [] };
    }
    if (!current.includes(lint.triageLabel)) actions.push({ type: 'label.add', label: lint.triageLabel });
    actions.push({
      type: 'comment.upsert',
      marker: `label-lint:${number}`,
      body: [
        'This issue does not meet the label standard (LABELING.md):',
        ...violations.map(violation => `- ${violation}`),
        '',
        `Add the missing labels, then \`${lint.triageLabel}\` is removed automatically.`,
      ].join('\n'),
    });
    return { actions, notes: violations };
  },
};

function pullRequest(payload: Json): Record<string, unknown> | undefined {
  return object(payload.pull_request);
}

/**
 * PR status labels, ported from PPMA's `pr-status.yml` (#1).
 *
 * The planner tracks the two states GitHub already tells us about in the event: a PR that becomes
 * ready gets `pr/ready`; a draft or a closed PR loses it. The linked-issue rule needs issue links,
 * which the caller supplies as facts later rather than guessing from the payload.
 */
export const prStatus: AutomationModule = {
  id: 'pr-status',
  plan({ event, config }: RuleContext): Outcome {
    const status = config.labels.prStatus;
    if (!config.labels.enabled || !status.enabled) return { actions: [], notes: [] };
    if (event.event !== 'pull_request' && event.event !== 'pull_request_target') return { actions: [], notes: [] };
    const pr = pullRequest(event.payload);
    if (!pr) return { actions: [], notes: [] };
    const current = labelNames(pr.labels);
    const actions: Action[] = [];
    if (event.action === 'ready_for_review' && !current.includes(status.ready)) actions.push({ type: 'label.add', label: status.ready });
    if ((event.action === 'converted_to_draft' || event.action === 'closed') && current.includes(status.ready)) {
      actions.push({ type: 'label.remove', label: status.ready });
    }
    return { actions, notes: [] };
  },
};
