import type { Store, Row } from '../storage/database.js';
import { selectedModel } from '../agent/model.js';
import { stop, TaskError } from '../agent/common.js';
import { covers, projectCeiling, withinCeiling } from '../projects/ceiling.js';
import { resolveRules } from '../rules/service.js';
import { roleConfiguration } from '../roles/definition.js';
import { grantedWrites, effectiveWrites } from './grants.js';
import { sourcePolicies } from './management.js';

export interface TaskPermissions {
  writes: string[];
  workspace: { read: boolean; write: boolean; shell: boolean; notes: boolean };
  github: string[];
  agents: boolean;
}

const fullGithubReads = ['contents', 'issues', 'pull_requests', 'actions', 'checks', 'statuses', 'metadata'];

export function taskConfiguration(store: Store, task: Row): any | null {
  const row = store.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', task.id ?? '');
  return row ? JSON.parse(row.snapshot) : null;
}

export function captureTaskConfiguration(store: Store, id: string): void {
  const task = store.get('SELECT * FROM tasks WHERE id=?', id);
  if (!task) return;
  try {
    executionModel(store, task);
  } catch (error) {
    if (!(error instanceof TaskError && error.state === 'waiting_configuration')) throw error;
  }
}

/** Capture once per explicitly adopted execution revision. Credentials are sealed, and omitted from public snapshots. */
export function executionModel(store: Store, task: Row, _kind?: string) {
  if (!task.id || !store.get('SELECT 1 FROM tasks WHERE id=?', task.id)) return selectedModel(store, task.repository_id);
  let config = taskConfiguration(store, task);
  if (!config) {
    const model = selectedModel(store, task.repository_id);
    const { key, ...metadata } = model;
    config = {
      policy: store.get('SELECT * FROM policies WHERE repository_id=?', task.repository_id),
      work: String(task.kind ?? 'task.request'),
      permissions: taskPermissions(store, task),
      roles: roleConfiguration(store, task.repository_id),
      model: metadata,
      credentials: store.secrets.seal({ value: key }, 'task-model:' + task.id),
    };
    store.run(
      'INSERT OR IGNORE INTO task_execution_configs VALUES(?,?,?,?)',
      task.id,
      JSON.parse(task.input || '{}').configuration_revision ?? 1,
      JSON.stringify(config),
      new Date().toISOString(),
    );
    config = taskConfiguration(store, task);
  }
  const current = store.get(
    `SELECT * FROM models WHERE id=? AND (repository_id=? OR (repository_id IS NULL AND (models.restricted=0 OR EXISTS
      (SELECT 1 FROM model_projects WHERE model_id=models.id AND repository_id=?))))`,
    config.model.id,
    task.repository_id,
    task.repository_id,
  );
  if (!current?.api_key) {
    stop('model_not_configured', 'waiting_configuration', `仓库 ${task.repository_id} 的固定模型已被删除、撤销凭据或撤销共享授权；不会自动切换模型。`);
  }
  const key = String(store.secrets.open(current!.api_key, 'model:' + current!.id).value || '');
  if (current!.version !== config.model.version || current!.api_url !== config.model.url || current!.model_name !== config.model.model) {
    stop('model_configuration_changed', 'waiting_configuration', '固定的执行模型地址或名称已变化，请显式采用新配置。');
  }
  return { ...config.model, key } as ReturnType<typeof selectedModel>;
}

export function supplementalInstructions(store: Store, task: Row): string[] {
  return store
    .all("SELECT data FROM task_history WHERE task_id=? AND type='supplemental_instruction' ORDER BY id DESC LIMIT 30", task.id)
    .reverse()
    .map(r => String(JSON.parse(r.data).instruction));
}

export function executionRuleFiles(store: Store, task: Row, files: Record<string, string>, sha: string): Record<string, string> {
  const config = taskConfiguration(store, task);
  if (!config) return files;
  if (config.rule_files) return config.rule_files;
  resolveRules(config.policy, files);
  config.rule_files = files;
  config.rule_sha = sha;
  store.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify(config), task.id);
  return files;
}

function legacyKindWrites(kind: string, input: any): string[] {
  const adapter = typeof input?.event_adapter === 'string' ? input.event_adapter : kind;
  if (kind === 'development.issue' || kind === 'development.pr' || kind === 'task.development') return ['code', 'pull_request'];
  if (kind.startsWith('review.')) return ['reply', 'labels'];
  if (adapter === 'release.notes') return ['release_notes'];
  if (adapter === 'release.observe') return [];
  if (kind.startsWith('workflow.')) {
    return Array.isArray(input?.manager?.writes) ? (input.manager.writes as string[]).map(String) : ['reply'];
  }
  return [];
}

/**
 * Effective writes of a task under `capability_ceiling` and `task_write_grants` (#814, #1122).
 * Generic tasks (`task.request`) derive their GitHub deliveries solely from `task_write_grants` bounded by the ceiling and
 * source policies; legacy in-flight rows follow their historical kind bounded by the ceiling.
 */
export function taskPermissions(store: Store, task: Row): TaskPermissions {
  const ceiling = projectCeiling(store, task.repository_id);
  const input = (() => { try { return JSON.parse(String(task.input || '{}')); } catch { return {}; } })();
  const kind = String(task.kind ?? 'task.request');
  const adapter = typeof input?.event_adapter === 'string' ? String(input.event_adapter) : kind;
  const isEventAdapter = ['actions.failures', 'release.notes', 'release.observe'].includes(adapter);
  const isReleaseNotes = adapter === 'release.notes';

  if (grantedWrites(store, String(task.id ?? ''))) {
    const effective = adapter === 'actions.failures' ? [] : effectiveWrites(store, task, sourcePolicies(store, task));
    const writes = isEventAdapter
      ? [...effective, ...(isReleaseNotes ? ['release_notes'] : [])]
      : [...(covers(ceiling, 'develop') || effective.includes('pull_request') ? ['code'] : []), ...effective];
    return {
      workspace: { read: true, write: !isEventAdapter && writes.includes('code'), shell: !isReleaseNotes, notes: !isReleaseNotes },
      github: [...fullGithubReads],
      agents: true,
      writes,
    };
  }
  let base = kind === 'task.request' && !isEventAdapter
    ? (covers(ceiling, 'develop') ? ['code'] : [])
    : withinCeiling(ceiling, legacyKindWrites(kind, input));
  const fixed = taskConfiguration(store, task)?.permissions?.writes;
  if (Array.isArray(fixed)) base = base.filter(w => fixed.includes(w));
  if (Array.isArray(input.manager?.writes)) {
    const managerSet = new Set(input.manager.writes as string[]);
    base = base.filter(w => w === 'code' || managerSet.has(w) || (w === 'issue' && managerSet.has('github')));
  }
  return {
    workspace: { read: true, write: !isEventAdapter && base.includes('code'), shell: !isReleaseNotes, notes: !isReleaseNotes },
    github: [...fullGithubReads],
    agents: true,
    writes: base,
  };
}
