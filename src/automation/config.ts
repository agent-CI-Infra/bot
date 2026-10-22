/**
 * Repository-level automation config (#1).
 *
 * Stored as JSON on the repository policy row. Anything not in the schema is rejected rather than
 * ignored, so a typo cannot silently disable a rule. Partial patches merge over the defaults; the
 * platform default is dry-run, and merge stays disabled until a repository enables it explicitly.
 */

export interface LabelsConfig {
  enabled: boolean;
  manifest: string[];
  lint: { enabled: boolean; require: string[]; exactlyOne: string[]; triageLabel: string };
  prStatus: { enabled: boolean; ready: string; noIssue: string };
}

export interface GateConfig {
  enabled: boolean;
  readyLabel: string;
  status: string;
  requiredChecks: string[];
  maintainerRoles: string[];
  reviewMustBeAnswered: boolean;
}

export interface MergeConfig {
  enabled: boolean;
  method: 'merge';
  oldestFirst: boolean;
  skipLabels: string[];
}

export interface AutomationConfig {
  dryRun: boolean;
  labels: LabelsConfig;
  gate: GateConfig;
  merge: MergeConfig;
}

export const DEFAULT_AUTOMATION: AutomationConfig = {
  dryRun: true,
  labels: {
    enabled: true,
    manifest: [],
    lint: { enabled: true, require: ['type', 'source'], exactlyOne: ['priority'], triageLabel: 'status/triage' },
    prStatus: { enabled: true, ready: 'pr/ready', noIssue: 'pr/no-issue' },
  },
  gate: {
    enabled: true,
    readyLabel: 'ready',
    status: 'merge-gate',
    requiredChecks: ['check', 'hygiene'],
    maintainerRoles: ['admin', 'maintain'],
    reviewMustBeAnswered: true,
  },
  merge: { enabled: false, method: 'merge', oldestFirst: true, skipLabels: ['pr/hold'] },
};

export class AutomationConfigError extends Error {
  constructor(readonly field: string) {
    super(`invalid_automation_config:${field}`);
    this.name = 'AutomationConfigError';
  }
}

const LABEL = /^[a-z0-9][a-z0-9._/-]{0,99}$/;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationConfigError(field);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AutomationConfigError(`${field}.${key}`);
}

function boolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AutomationConfigError(field);
  return value;
}

function label(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !LABEL.test(value)) throw new AutomationConfigError(field);
  return value;
}

function labels(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new AutomationConfigError(field);
  return value.map((item, index) => label(item, `${field}[${index}]`, ''));
}

function words(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(item))) {
    throw new AutomationConfigError(field);
  }
  return value as string[];
}

/** Parse a stored or posted config, merging it over `base`. */
export function parseAutomationConfig(value: unknown, base: AutomationConfig = DEFAULT_AUTOMATION): AutomationConfig {
  const root = record(value, 'automation');
  onlyKeys(root, ['dryRun', 'labels', 'gate', 'merge'], 'automation');
  const labelsValue = root.labels === undefined ? {} : record(root.labels, 'labels');
  onlyKeys(labelsValue, ['enabled', 'manifest', 'lint', 'prStatus'], 'labels');
  const lintValue = labelsValue.lint === undefined ? {} : record(labelsValue.lint, 'labels.lint');
  onlyKeys(lintValue, ['enabled', 'require', 'exactlyOne', 'triageLabel'], 'labels.lint');
  const prStatusValue = labelsValue.prStatus === undefined ? {} : record(labelsValue.prStatus, 'labels.prStatus');
  onlyKeys(prStatusValue, ['enabled', 'ready', 'noIssue'], 'labels.prStatus');
  const gateValue = root.gate === undefined ? {} : record(root.gate, 'gate');
  onlyKeys(gateValue, ['enabled', 'readyLabel', 'status', 'requiredChecks', 'maintainerRoles', 'reviewMustBeAnswered'], 'gate');
  const mergeValue = root.merge === undefined ? {} : record(root.merge, 'merge');
  onlyKeys(mergeValue, ['enabled', 'method', 'oldestFirst', 'skipLabels'], 'merge');
  if (mergeValue.method !== undefined && mergeValue.method !== 'merge') throw new AutomationConfigError('merge.method');

  const requiredChecks = words(gateValue.requiredChecks, 'gate.requiredChecks', base.gate.requiredChecks);
  if (requiredChecks.length === 0) throw new AutomationConfigError('gate.requiredChecks');
  const maintainerRoles = words(gateValue.maintainerRoles, 'gate.maintainerRoles', base.gate.maintainerRoles);
  if (maintainerRoles.length === 0) throw new AutomationConfigError('gate.maintainerRoles');

  return {
    dryRun: boolean(root.dryRun, 'dryRun', base.dryRun),
    labels: {
      enabled: boolean(labelsValue.enabled, 'labels.enabled', base.labels.enabled),
      manifest: labels(labelsValue.manifest, 'labels.manifest', base.labels.manifest),
      lint: {
        enabled: boolean(lintValue.enabled, 'labels.lint.enabled', base.labels.lint.enabled),
        require: words(lintValue.require, 'labels.lint.require', base.labels.lint.require),
        exactlyOne: words(lintValue.exactlyOne, 'labels.lint.exactlyOne', base.labels.lint.exactlyOne),
        triageLabel: label(lintValue.triageLabel, 'labels.lint.triageLabel', base.labels.lint.triageLabel),
      },
      prStatus: {
        enabled: boolean(prStatusValue.enabled, 'labels.prStatus.enabled', base.labels.prStatus.enabled),
        ready: label(prStatusValue.ready, 'labels.prStatus.ready', base.labels.prStatus.ready),
        noIssue: label(prStatusValue.noIssue, 'labels.prStatus.noIssue', base.labels.prStatus.noIssue),
      },
    },
    gate: {
      enabled: boolean(gateValue.enabled, 'gate.enabled', base.gate.enabled),
      readyLabel: label(gateValue.readyLabel, 'gate.readyLabel', base.gate.readyLabel),
      status: label(gateValue.status, 'gate.status', base.gate.status),
      requiredChecks,
      maintainerRoles,
      reviewMustBeAnswered: boolean(gateValue.reviewMustBeAnswered, 'gate.reviewMustBeAnswered', base.gate.reviewMustBeAnswered),
    },
    merge: {
      enabled: boolean(mergeValue.enabled, 'merge.enabled', base.merge.enabled),
      method: 'merge',
      oldestFirst: boolean(mergeValue.oldestFirst, 'merge.oldestFirst', base.merge.oldestFirst),
      skipLabels: labels(mergeValue.skipLabels, 'merge.skipLabels', base.merge.skipLabels),
    },
  };
}

/** Read a policy row's JSON, falling back to the platform default when it is absent or corrupt. */
export function loadAutomationConfig(stored: unknown): { config: AutomationConfig; problem: string | null } {
  if (stored === undefined || stored === null || stored === '') return { config: DEFAULT_AUTOMATION, problem: null };
  try {
    const value = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return { config: parseAutomationConfig(value), problem: null };
  } catch {
    return { config: DEFAULT_AUTOMATION, problem: 'automation_config_invalid' };
  }
}
