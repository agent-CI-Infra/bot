/**
 * Label manifest bootstrap (#1 answer 4).
 *
 * The bot reads a repository's built-in config first (the per-repository YAML file, or a config
 * saved through the API). When neither exists it starts from this built-in manifest and adds an
 * `area/*` axis derived from the repository's own architecture, then emits both the YAML config
 * and a `LABELING.md` the repository can commit.
 */

import { stringify } from 'yaml';
import { type AutomationConfig, parseAutomationConfig } from './config.js';

const GENERIC_AXES: Record<string, string[]> = {
  type: ['bug', 'perf', 'feature', 'enhancement', 'refactor', 'test', 'ci', 'docs', 'security', 'chore'],
  source: ['user', 'ci', 'review', 'planned', 'incidental', 'nightly'],
  priority: ['critical', 'high', 'medium', 'low'],
  size: ['s', 'm', 'l'],
  agent: ['ok', 'human-only'],
  status: ['triage', 'claimed', 'blocked', 'needs-info'],
  pr: ['ready', 'needs-human', 'hold', 'still-relevant', 'no-issue'],
  gate: ['check-failed', 'hygiene-failed', 'review-failed'],
};

const MEANINGS: Record<string, string> = {
  'type/bug': 'Wrong behavior vs. intended behavior',
  'type/perf': 'Faster or cheaper, same behavior',
  'type/feature': 'New capability',
  'type/enhancement': 'Improvement to an existing capability',
  'type/refactor': 'Internal restructuring, no behavior change',
  'type/test': 'Tests and test infrastructure',
  'type/ci': 'Build, CI, gates and tooling',
  'type/docs': 'Documentation only',
  'type/security': 'Vulnerability or hardening',
  'type/chore': 'Dependencies and housekeeping',
  'source/user': 'Reported by a human',
  'source/ci': 'Surfaced by CI',
  'source/review': 'Raised in a pull request review',
  'source/planned': 'Roadmap or deliberately scoped work',
  'source/incidental': 'Found while working on something else',
  'source/nightly': 'Found by a scheduled run',
  'priority/critical': 'Drop everything; notify a human',
  'priority/high': 'Next in line',
  'priority/medium': 'Normal backlog',
  'priority/low': 'Nice to have',
  'size/s': 'Under about an hour',
  'size/m': 'About half a day',
  'size/l': 'Needs a design first',
  'agent/ok': 'Agents may implement unattended',
  'agent/human-only': 'Needs a human decision',
  'status/triage': 'A required axis is missing',
  'status/claimed': 'Someone is working on it',
  'status/blocked': 'Waiting on another issue or PR',
  'status/needs-info': 'Needs clarification',
  'pr/ready': 'Checks green, mergeable, issue linked',
  'pr/needs-human': 'Automation gave up',
  'pr/hold': 'Humans only; do not merge',
  'pr/still-relevant': 'Maintainer re-attested a stale PR',
  'pr/no-issue': 'No linked issue',
  'gate/check-failed': 'Tier-1 check failed',
  'gate/hygiene-failed': 'PR hygiene failed',
  'gate/review-failed': 'Review failed',
  blocker: 'Must close before the next release',
};

/** Sanitize architecture names into label-safe `area/*` values. */
export function areasFrom(value: readonly string[]): string[] {
  const result: string[] = [];
  for (const item of value) {
    const area = item.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (area && !result.includes(area)) result.push(area);
  }
  return result.slice(0, 50);
}

export function bootstrapConfig(areas: readonly string[] = []): AutomationConfig {
  const clean = areasFrom(areas);
  return parseAutomationConfig({
    labels: {
      enabled: true,
      axes: clean.length ? { ...GENERIC_AXES, area: clean } : GENERIC_AXES,
      manifest: ['blocker'],
      lint: { enabled: true, require: ['type', 'source'], exactlyOne: ['priority'], triageLabel: 'status/triage' },
      prStatus: { enabled: true, ready: 'pr/ready', noIssue: 'pr/no-issue' },
    },
    gate: {
      enabled: true, readyLabel: 'ready', status: 'merge-gate', requiredChecks: ['check', 'hygiene'],
      maintainerRoles: ['admin', 'maintain'], reviewMustBeAnswered: true,
    },
    merge: { enabled: false, method: 'merge', oldestFirst: true, skipLabels: ['pr/hold'] },
    ci: { stages: [] },
    dispatch: [],
  });
}

/** The repository-facing YAML, in the same snake_case the loader accepts. */
export function toRepositoryYaml(config: AutomationConfig): string {
  return stringify({
    dry_run: config.dryRun,
    labels: {
      enabled: config.labels.enabled,
      axes: config.labels.axes,
      manifest: config.labels.manifest,
      lint: {
        enabled: config.labels.lint.enabled, require: config.labels.lint.require,
        exactly_one: config.labels.lint.exactlyOne, triage: config.labels.lint.triageLabel,
      },
      pr_status: {
        enabled: config.labels.prStatus.enabled, ready: config.labels.prStatus.ready, no_issue: config.labels.prStatus.noIssue,
      },
    },
    gate: {
      enabled: config.gate.enabled, ready_label: config.gate.readyLabel, status: config.gate.status,
      required_checks: config.gate.requiredChecks, maintainer_roles: config.gate.maintainerRoles,
      review_must_be_answered: config.gate.reviewMustBeAnswered,
    },
    merge: {
      enabled: config.merge.enabled, method: config.merge.method,
      oldest_first: config.merge.oldestFirst, skip_labels: config.merge.skipLabels,
    },
    ci: {
      stages: config.ci.stages.map(stage => ({
        id: stage.id, workflow: stage.workflow, runner_labels: stage.runnerLabels, required: stage.required,
      })),
    },
    ...(config.dispatch.length ? {
      dispatch: config.dispatch.map(rule => ({ target: rule.target, events: rule.events, labels: rule.labels })),
    } : {}),
  }, { lineWidth: 0 });
}

/** A `LABELING.md` proposal for the repository to review and commit. */
export function toLabeling(config: AutomationConfig, fullName: string, generated: boolean): string {
  const lines = [
    `# Labels — ${fullName}`,
    '',
    generated
      ? '> Generated by the bot from its built-in manifest and this repository\'s architecture. Review and commit, then set `BOT_REPOSITORY_CONFIG_DIR` to use it.'
      : '> Derived from this repository\'s configuration.',
    '',
    'Required on every issue: `type/*`, `source/*`, exactly one `priority/*`.',
    '',
  ];
  for (const [axis, values] of Object.entries(config.labels.axes)) {
    lines.push(`## \`${axis}/*\``, '', '| Label | Meaning |', '|---|---|');
    for (const value of values) {
      const label = `${axis}/${value}`;
      lines.push(`| \`${label}\` | ${MEANINGS[label] ?? (axis === 'area' ? 'Component or subsystem' : value)} |`);
    }
    lines.push('');
  }
  const flags = config.labels.manifest.filter(label => !Object.keys(config.labels.axes).some(axis => label.startsWith(`${axis}/`)));
  if (flags.length) {
    lines.push('## Flags', '', '| Label | Meaning |', '|---|---|');
    for (const label of flags) lines.push(`| \`${label}\` | ${MEANINGS[label] ?? 'Flag'} |`);
    lines.push('');
  }
  lines.push(
    '## Rules', '',
    `- Missing \`${config.labels.lint.require.join('`, `')}\` or not exactly one of \`${config.labels.lint.exactlyOne.join('`, `')}\`: automation adds \`${config.labels.lint.triageLabel}\`.`,
    '- Do not set `pr/*` or `gate/*` by hand; they belong to automation.',
    '- `pr/hold`, `agent/human-only` and `blocker` are human-only decisions.',
    '- Add new `area/*` or `gate/*` values to the manifest in the same PR that uses them.',
    '',
  );
  return lines.join('\n');
}
