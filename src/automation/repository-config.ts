/**
 * Per-repository automation configuration files (#1).
 *
 * `config/repositories/<owner>__<repo>.yml` declares one repository's labels, gate, merge and CI
 * stages in YAML. The file is a *base* config: a policy row saved through the API is still merged
 * on top, and an API patch always wins. Unknown keys are rejected, like the JSON schema.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type AutomationConfig, AutomationConfigError, parseAutomationConfig } from './config.js';

export interface RepositoryConfigEntry {
  fullName: string;
  path: string;
  config: AutomationConfig;
}

const FILE = /^([A-Za-z0-9_.-]+)__([A-Za-z0-9_.-]+)\.ya?ml$/;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationConfigError(field);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AutomationConfigError(`${field}.${key}`);
}

function translated(value: Record<string, unknown>, pairs: Record<string, string>, field: string): Record<string, unknown> {
  only(value, Object.keys(pairs), field);
  const result: Record<string, unknown> = {};
  for (const [source, target] of Object.entries(pairs)) if (value[source] !== undefined) result[target] = value[source];
  return result;
}

function translateLabels(value: unknown): Record<string, unknown> {
  const labels = object(value, 'labels');
  const result = translated(labels, {
    enabled: 'enabled', axes: 'axes', manifest: 'manifest', lint: 'lint', pr_status: 'prStatus',
  }, 'labels');
  if (labels.lint !== undefined) {
    result.lint = translated(object(labels.lint, 'labels.lint'), {
      enabled: 'enabled', require: 'require', exactly_one: 'exactlyOne', triage: 'triageLabel',
    }, 'labels.lint');
  }
  if (labels.pr_status !== undefined) {
    result.prStatus = translated(object(labels.pr_status, 'labels.pr_status'), {
      enabled: 'enabled', ready: 'ready', no_issue: 'noIssue',
    }, 'labels.pr_status');
  }
  return result;
}

function translateCi(value: unknown): Record<string, unknown> {
  const ci = object(value, 'ci');
  only(ci, ['stages'], 'ci');
  if (ci.stages === undefined) return {};
  if (!Array.isArray(ci.stages)) throw new AutomationConfigError('ci.stages');
  return {
    stages: ci.stages.map((item, index) => translated(object(item, `ci.stages[${index}]`), {
      id: 'id', workflow: 'workflow', runner_labels: 'runnerLabels', required: 'required',
    }, `ci.stages[${index}]`)),
  };
}

/** Translate the documented snake_case YAML into the stored camelCase schema. */
export function translateConfig(value: unknown): Record<string, unknown> {
  const root = object(value, 'yaml');
  const result = translated(root, {
    dry_run: 'dryRun', labels: 'labels', gate: 'gate', merge: 'merge', ci: 'ci',
  }, 'yaml');
  if (root.labels !== undefined) result.labels = translateLabels(root.labels);
  if (root.gate !== undefined) {
    result.gate = translated(object(root.gate, 'gate'), {
      enabled: 'enabled', ready_label: 'readyLabel', status: 'status', required_checks: 'requiredChecks',
      maintainer_roles: 'maintainerRoles', review_must_be_answered: 'reviewMustBeAnswered',
    }, 'gate');
  }
  if (root.merge !== undefined) {
    result.merge = translated(object(root.merge, 'merge'), {
      enabled: 'enabled', method: 'method', oldest_first: 'oldestFirst', skip_labels: 'skipLabels',
    }, 'merge');
  }
  if (root.ci !== undefined) result.ci = translateCi(root.ci);
  return result;
}

/** Parse one repository file body. Throws `AutomationConfigError` naming the bad field. */
export function parseRepositoryConfig(source: string, fullName: string): AutomationConfig {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new AutomationConfigError(`yaml:${fullName}`);
  }
  if (value === null || value === undefined) throw new AutomationConfigError(`yaml:${fullName}`);
  return parseAutomationConfig(translateConfig(value));
}

/**
 * Load every `*.yml` / `*.yaml` file in `directory`. A missing directory is an empty set: the bot
 * runs fine with no repository files, and every repository then uses the platform defaults.
 */
export function loadRepositoryConfigs(directory: string): RepositoryConfigEntry[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: RepositoryConfigEntry[] = [];
  const seen = new Map<string, string>();
  for (const name of names.sort()) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const match = FILE.exec(name);
    if (!match) throw new AutomationConfigError(`file:${name}`);
    const fullName = `${match[1]}/${match[2]}`;
    const key = fullName.toLowerCase();
    if (seen.has(key)) throw new AutomationConfigError(`duplicate:${fullName}`);
    const path = join(directory, name);
    entries.push({ fullName, path, config: parseRepositoryConfig(readFileSync(path, 'utf8'), fullName) });
    seen.set(key, path);
  }
  return entries;
}

/** Resolve entries by lower-cased `owner/repo`, which is how a webhook's repository row is keyed. */
export function repositoryConfigMap(entries: readonly RepositoryConfigEntry[]): Map<string, AutomationConfig> {
  return new Map(entries.map(entry => [entry.fullName.toLowerCase(), entry.config]));
}
