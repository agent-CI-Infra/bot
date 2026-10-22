/**
 * Repository-level automation config (#1).
 *
 * Stored as JSON on the repository policy row, and optionally loaded from a per-repository YAML
 * file (`config/repositories/<owner>__<repo>.yml`) so a repository declares its own labels and
 * policies instead of patching the API. Anything not in the schema is rejected rather than
 * ignored, so a typo cannot silently disable a rule. Partial patches merge over the defaults; the
 * platform default is dry-run, and merge stays disabled until a repository enables it explicitly.
 */

export interface CiStage {
  id: string;
  workflow: string;
  runnerLabels: string[];
  required: boolean;
}

export interface LabelsConfig {
  enabled: boolean;
  /** Axis name to its values, without the `axis/` prefix (`type: [bug, docs]`). */
  axes: Record<string, string[]>;
  /** Explicit extra labels (for flags such as `blocker`) or a full override. */
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

export interface CiConfig {
  /** The CI stages a repository runs and where each one runs; `required` feeds the gate. */
  stages: CiStage[];
}

export interface AutomationConfig {
  dryRun: boolean;
  labels: LabelsConfig;
  gate: GateConfig;
  merge: MergeConfig;
  ci: CiConfig;
}

export const DEFAULT_AUTOMATION: AutomationConfig = {
  dryRun: true,
  labels: {
    enabled: true,
    axes: {},
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
  ci: { stages: [] },
};

export class AutomationConfigError extends Error {
  constructor(readonly field: string) {
    super(`invalid_automation_config:${field}`);
    this.name = 'AutomationConfigError';
  }
}

const LABEL = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
const AXIS = /^[a-z][a-z0-9-]{0,31}$/;
const VALUE = /^[a-z0-9][a-z0-9._-]{0,48}$/;
const WORD = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

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
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !WORD.test(item))) {
    throw new AutomationConfigError(field);
  }
  return value as string[];
}

function axes(value: unknown, field: string, fallback: Record<string, string[]>): Record<string, string[]> {
  if (value === undefined) return structuredClone(fallback);
  const map = record(value, field);
  const result: Record<string, string[]> = {};
  for (const [axis, values] of Object.entries(map)) {
    if (!AXIS.test(axis)) throw new AutomationConfigError(`${field}.${axis}`);
    if (!Array.isArray(values) || values.length > 200) throw new AutomationConfigError(`${field}.${axis}`);
    result[axis] = values.map((item, index) => {
      if (typeof item !== 'string' || !VALUE.test(item)) throw new AutomationConfigError(`${field}.${axis}[${index}]`);
      return item;
    });
  }
  return result;
}

function stages(value: unknown, field: string, fallback: CiStage[]): CiStage[] {
  if (value === undefined) return fallback.map(stage => ({ ...stage, runnerLabels: [...stage.runnerLabels] }));
  if (!Array.isArray(value) || value.length > 100) throw new AutomationConfigError(field);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const stage = record(item, `${field}[${index}]`);
    const at = `${field}[${index}]`;
    onlyKeys(stage, ['id', 'workflow', 'runnerLabels', 'required'], at);
    const id = words(stage.id === undefined ? undefined : [stage.id], `${at}.id`, [''])[0]!;
    if (!id) throw new AutomationConfigError(`${at}.id`);
    if (seen.has(id)) throw new AutomationConfigError(`${at}.id`);
    seen.add(id);
    if (typeof stage.workflow !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/.test(stage.workflow)) {
      throw new AutomationConfigError(`${at}.workflow`);
    }
    const runnerLabels = words(stage.runnerLabels, `${at}.runnerLabels`, []);
    if (runnerLabels.length === 0) throw new AutomationConfigError(`${at}.runnerLabels`);
    return { id, workflow: stage.workflow, runnerLabels, required: boolean(stage.required, `${at}.required`, true) };
  });
}

/** Parse a stored or posted config, merging it over `base`. */
export function parseAutomationConfig(value: unknown, base: AutomationConfig = DEFAULT_AUTOMATION): AutomationConfig {
  const root = record(value, 'automation');
  onlyKeys(root, ['dryRun', 'labels', 'gate', 'merge', 'ci'], 'automation');
  const labelsValue = root.labels === undefined ? {} : record(root.labels, 'labels');
  onlyKeys(labelsValue, ['enabled', 'axes', 'manifest', 'lint', 'prStatus'], 'labels');
  const lintValue = labelsValue.lint === undefined ? {} : record(labelsValue.lint, 'labels.lint');
  onlyKeys(lintValue, ['enabled', 'require', 'exactlyOne', 'triageLabel'], 'labels.lint');
  const prStatusValue = labelsValue.prStatus === undefined ? {} : record(labelsValue.prStatus, 'labels.prStatus');
  onlyKeys(prStatusValue, ['enabled', 'ready', 'noIssue'], 'labels.prStatus');
  const gateValue = root.gate === undefined ? {} : record(root.gate, 'gate');
  onlyKeys(gateValue, ['enabled', 'readyLabel', 'status', 'requiredChecks', 'maintainerRoles', 'reviewMustBeAnswered'], 'gate');
  const mergeValue = root.merge === undefined ? {} : record(root.merge, 'merge');
  onlyKeys(mergeValue, ['enabled', 'method', 'oldestFirst', 'skipLabels'], 'merge');
  if (mergeValue.method !== undefined && mergeValue.method !== 'merge') throw new AutomationConfigError('merge.method');
  const ciValue = root.ci === undefined ? {} : record(root.ci, 'ci');
  onlyKeys(ciValue, ['stages'], 'ci');

  const axesValue = axes(labelsValue.axes, 'labels.axes', base.labels.axes);
  const derived = Object.entries(axesValue).flatMap(([axis, values]) => values.map(item => `${axis}/${item}`));
  const manifest = labelsValue.manifest === undefined
    ? (derived.length ? derived : [...base.labels.manifest])
    : [...new Set([...derived, ...labels(labelsValue.manifest, 'labels.manifest', [])])];

  const ciStages = stages(ciValue.stages, 'ci.stages', base.ci.stages);
  const requiredChecks = words(gateValue.requiredChecks, 'gate.requiredChecks', base.gate.requiredChecks);
  if (requiredChecks.length === 0) throw new AutomationConfigError('gate.requiredChecks');
  if (ciStages.length > 0) {
    const requiredStageIds = new Set(ciStages.filter(stage => stage.required).map(stage => stage.id));
    if (requiredChecks.some(check => !requiredStageIds.has(check))) throw new AutomationConfigError('gate.requiredChecks');
  }
  const maintainerRoles = words(gateValue.maintainerRoles, 'gate.maintainerRoles', base.gate.maintainerRoles);
  if (maintainerRoles.length === 0) throw new AutomationConfigError('gate.maintainerRoles');

  return {
    dryRun: boolean(root.dryRun, 'dryRun', base.dryRun),
    labels: {
      enabled: boolean(labelsValue.enabled, 'labels.enabled', base.labels.enabled),
      axes: axesValue,
      manifest,
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
    ci: { stages: ciStages },
  };
}

/**
 * Read a policy row's JSON. A missing value uses `fallback` (a repository YAML file, when one is
 * configured); a corrupt value also falls back but reports the problem on the automation run.
 */
export function loadAutomationConfig(
  stored: unknown,
  fallback: AutomationConfig = DEFAULT_AUTOMATION,
): { config: AutomationConfig; problem: string | null } {
  if (stored === undefined || stored === null || stored === '') return { config: fallback, problem: null };
  try {
    const value = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return { config: parseAutomationConfig(value, fallback), problem: null };
  } catch {
    return { config: fallback, problem: 'automation_config_invalid' };
  }
}
