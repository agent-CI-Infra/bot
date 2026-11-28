import { projectLabels } from '../rules/service.js';
import { roleKind } from './catalog.js';
import { projectCeiling } from '../projects/ceiling.js';
import { createHash } from 'node:crypto';
import { pullRequestQaGate } from '../tasks/grants.js';
import type { Store, Row } from '../storage/database.js';
import { fail, type Json } from '../core/security.js';
import { roleConfiguration } from './definition.js';
import { harnesses } from './harness.js';
import { concurrencyBounds, defaultConcurrency, repositoryConcurrency } from '../app/settings.js';
import { waitForReviewSatisfied } from '../tasks/readiness.js';
import { taskGroupSQL } from '../app/project-activity.js';
import { attributeCapacityWaitingRole, attributeControllerQueuedRole } from './flow.js';
import { parseTaskTargetMeta, taskTargetSelectSQL } from '../tasks/external-links.js';

// #228 / #952: read-only projection of per-role occupancy, configured capacity limits, and genuinely attributable queues
// (default Manager controller entries, uniquely attributable stage-policy queues, and #283 role_capacity waits).
const maxRoles = 32;
const maxReady = 100;
const defaultReadyLimit = 50;
const queueScanLimit = 500;
const roleKeys = new Set(['__proto__']);

export function roleConcurrency(store: Store, repositoryId: string): Record<string, number | null> {
  const raw = store.get('SELECT role_concurrency FROM policies WHERE repository_id=?', repositoryId)?.role_concurrency;
  let value: unknown;
  try { value = JSON.parse(String(raw ?? '{}')); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const defined = new Set(roleConfiguration(store, repositoryId).roles.map(role => role.role_id));
  const limits: Record<string, number | null> = Object.create(null) as Record<string, number | null>;
  for (const [role, limit] of Object.entries(value as Record<string, unknown>)) {
    if (!defined.has(role)) continue;
    if (limit === null) { limits[role] = null; continue; }
    if (Number.isSafeInteger(limit) && (limit as number) >= concurrencyBounds[0] && (limit as number) <= concurrencyBounds[1]) limits[role] = limit as number;
  }
  return limits;
}

export function roleCapacity(store: Store, repositoryId: string, role: string, kind: string, exclude?: string): { limit: number; running: number } | null {
  if (kind === 'observer') return null;
  return store.transaction(() => {
    const limit = roleConcurrency(store, repositoryId)[role] ?? null;
    if (limit === null) return null;
    const running = Number(store.get(`SELECT count(*) n FROM task_runs r CROSS JOIN tasks t ON t.id=r.task_id
      WHERE r.status='running' AND r.role=? AND r.id<>? AND t.repository_id=?`, role, exclude ?? '', repositoryId)?.n ?? 0);
    return { limit, running };
  });
}

export function roleConcurrencyValue(store: Store, repositoryId: string, value: unknown): Record<string, number | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_role_concurrency');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxRoles) fail(400, 'invalid_role_concurrency');
  const defined = new Set(roleConfiguration(store, repositoryId).roles.map(role => role.role_id));
  const limits: Record<string, number | null> = Object.create(null) as Record<string, number | null>;
  for (const [role, limit] of entries) {
    if (roleKeys.has(role) || !defined.has(role)) fail(400, 'invalid_role_concurrency');
    if (limit === null) { limits[role] = null; continue; }
    if (!Number.isSafeInteger(limit) || (limit as number) < concurrencyBounds[0] || (limit as number) > concurrencyBounds[1]) fail(400, 'invalid_role_concurrency');
    limits[role] = limit as number;
  }
  return limits;
}

export function policyView(store: Store, policy: Json | undefined, repositoryId: string): Json | undefined {
  if (!policy) return policy;
  // Retired policy columns (#935, #1104, #1122): max_revisions, work_settings, task_models, automation.
  const { max_revisions: _retired, work_settings: _work, task_models: _models, automation: _auto, ...kept } = policy as any;
  return { ...kept, ...projectLabels(store, repositoryId), capability_ceiling: projectCeiling(store, repositoryId, policy), role_concurrency: roleConcurrency(store, repositoryId),
    delivery_gates: { pull_request_qa: pullRequestQaGate(store, repositoryId, policy as any) } };
}

function resolveModelNames(store: Store, repositoryId: string): { byId: Map<string, string>; fallback: string | null } {
  const rows = store.all(`SELECT m.id,m.model_name FROM models m
    WHERE m.api_key IS NOT NULL AND (m.repository_id=? OR (m.repository_id IS NULL AND (m.restricted=0 OR EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?))))`,
    repositoryId, repositoryId);
  const byId = new Map<string, string>(rows.map(r => [String(r.id), String(r.model_name)]));
  const policy = store.get('SELECT model_id FROM policies WHERE repository_id=?', repositoryId);
  const defaultModelId = typeof policy?.model_id === 'string' ? policy.model_id : null;
  return { byId, fallback: defaultModelId ? (byId.get(defaultModelId) ?? null) : null };
}

export function roleBoard(store: Store, repositoryId: string, url?: URL): Json {
  const limit = (() => {
    const raw = url?.searchParams.get('ready_limit');
    if (raw === null || raw === undefined) return defaultReadyLimit;
    if (!/^\d+$/.test(raw)) fail(400, 'invalid_ready_limit');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maxReady) fail(400, 'invalid_ready_limit');
    return value;
  })();

  const config = roleConfiguration(store, repositoryId);
  const limits = roleConcurrency(store, repositoryId);
  const now = Date.now();

  const queued = store.all(
    `SELECT id,kind,phase,summary,priority,object_number,created_at,updated_at,input,${taskTargetSelectSQL()} AS target_meta FROM tasks
     WHERE repository_id=? AND status='queued' AND next_run_at<=? ORDER BY created_at,id LIMIT ?`,
    repositoryId, now, queueScanLimit + 1,
  );
  let truncated = queued.length > queueScanLimit;
  if (truncated) queued.length = queueScanLimit;
  const eligible = queued.filter(task => waitForReviewSatisfied(store, task));

  const origins = new Map<string, Row>();
  if (eligible.length && store.hasTable('task_origins')) {
    const qIds = eligible.map(t => String(t.id));
    for (const row of store.all(`SELECT task_id,source_kind,executor_role FROM task_origins WHERE task_id IN (${qIds.map(() => '?').join(',')})`, ...qIds)) {
      origins.set(String(row.task_id), row);
    }
  }

  const attribution = new Map<string, string>();
  let unsupported: string[] = [];
  let unattributedQueued = 0;
  if (!config.enabled) {
    unsupported = ['role_queue'];
  } else {
    for (const task of eligible) {
      const target = attributeControllerQueuedRole(task, config, origins.get(String(task.id)) ?? null);
      if (target) attribution.set(String(task.id), target);
      else unattributedQueued++;
    }
  }

  // #283: tasks waiting in retry_wait explicitly due to `role_capacity` belong to that role's slot wait queue.
  const capacityWaiting = store.all(
    `SELECT id,kind,phase,summary,priority,object_number,created_at,updated_at,${taskTargetSelectSQL()} AS target_meta FROM tasks
     WHERE repository_id=? AND status='retry_wait' AND error_code='role_capacity' ORDER BY updated_at,created_at,id LIMIT ?`,
    repositoryId, queueScanLimit + 1,
  );
  if (capacityWaiting.length > queueScanLimit) {
    truncated = true;
    capacityWaiting.length = queueScanLimit;
  }
  const capacityByRole = new Map<string, Row[]>();
  for (const task of capacityWaiting) {
    const target = attributeCapacityWaitingRole(store, String(task.id), config);
    if (!target) continue;
    const list = capacityByRole.get(target) ?? [];
    list.push(task);
    capacityByRole.set(target, list);
  }

  const ready = eligible.map((task, index) => ({
    task,
    position: index + 1,
    role: unsupported.length ? null : attribution.get(task.id) ?? null,
    queue_reason: 'queued' as const,
  }));

  // Active child worker runs per task so Role View knows when Manager has handed the active baton to a worker.
  // CROSS JOIN keeps task_runs outermost via the partial index task_runs_running (only live rows, already in
  // started_at, id order) instead of scanning every historical task of the repository.
  const allRunning = store.all(
    `SELECT r.id AS run_id,r.task_id,r.role,r.role_instance_id,r.started_at,t.object_number,t.kind,t.summary,t.priority,t.phase,${taskTargetSelectSQL('t.input')} AS target_meta
     FROM task_runs r CROSS JOIN tasks t ON t.id=r.task_id
     WHERE r.status='running' AND r.role IS NOT NULL AND t.repository_id=? ORDER BY r.started_at,r.id`,
    repositoryId,
  );
  const workerRunningTasks = new Set(
    allRunning.filter(r => String(r.role) !== config.controller.role).map(r => String(r.task_id)),
  );
  const runningByRole = new Map<string, Row[]>();
  for (const r of allRunning) {
    const roleId = String(r.role);
    const list = runningByRole.get(roleId) ?? [];
    list.push(r);
    runningByRole.set(roleId, list);
  }

  const models = resolveModelNames(store, repositoryId);

  const roles = config.roles.map(role => {
    const harnessDef = harnesses.find(h => h.id === role.harness_ref.id);
    const resolvedModel = harnessDef?.externalModel
      ? null
      : role.model_profile_ref?.model_id
        ? (models.byId.get(role.model_profile_ref.model_id) ?? role.model_profile_ref.name ?? null)
        : models.fallback;

    const running = (runningByRole.get(role.role_id) ?? []).map(run => ({
      run_id: run.run_id,
      task_id: run.task_id,
      object_number: run.object_number,
      target: parseTaskTargetMeta(run.target_meta),
      kind: run.kind,
      summary: run.summary ?? '',
      priority: run.priority ?? 'P2',
      phase: run.phase ?? null,
      role_instance_id: run.role_instance_id,
      started_at: run.started_at,
      delegated_active: role.role_id === config.controller.role && workerRunningTasks.has(String(run.task_id)),
    }));

    const capTasks = role.enabled ? (capacityByRole.get(role.role_id) ?? []) : [];
    const queuedMine = ready.filter(entry => entry.role === role.role_id && role.enabled);
    const combined = [
      ...capTasks.map((task, idx) => ({
        task_id: task.id,
        object_number: task.object_number,
        target: parseTaskTargetMeta(task.target_meta),
        kind: task.kind,
        summary: task.summary ?? '',
        priority: task.priority ?? 'P2',
        queued_at: task.updated_at || task.created_at,
        position: idx + 1,
        queue_reason: 'role_capacity',
      })),
      ...queuedMine.map(entry => ({
        task_id: entry.task.id,
        object_number: entry.task.object_number,
        target: parseTaskTargetMeta(entry.task.target_meta),
        kind: entry.task.kind,
        summary: entry.task.summary ?? '',
        priority: entry.task.priority ?? 'P2',
        queued_at: entry.task.created_at,
        position: entry.position,
        queue_reason: entry.queue_reason,
      })),
    ];
    if (combined.length > limit) truncated = true;
    const limitValue = limits[role.role_id] ?? null;

    return {
      role: role.role_id,
      name: role.name,
      responsibility: role.responsibility,
      kind: role.kind,
      enabled: !!role.enabled,
      harness: role.harness_ref.id,
      model: resolvedModel,
      limit: limitValue,
      limit_source: limitValue === null ? 'unset' : 'policy',
      running,
      ready: combined.slice(0, limit),
    };
  });

  const counts = store.get(
    `SELECT
       COALESCE(SUM(CASE WHEN ${taskGroupSQL.active} THEN 1 ELSE 0 END),0) AS running_tasks,
       COALESCE(SUM(CASE WHEN ${taskGroupSQL.queued} THEN 1 ELSE 0 END),0) AS queued_tasks,
       COALESCE(SUM(CASE WHEN status='retry_wait' AND error_code='role_capacity' THEN 1 ELSE 0 END),0) AS capacity_waiting_tasks
     FROM tasks WHERE repository_id=?`,
    repositoryId,
  );

  const version = createHash('sha256')
    .update(JSON.stringify({ revision: config.revision, updated_at: config.updated_at ?? null, limits }))
    .digest('hex')
    .slice(0, 16);
  const enforced = config.roles.some(role => roleKind(role.role_id) !== 'observer' && (limits[role.role_id] ?? null) !== null);

  return {
    version,
    updated_at: config.updated_at ?? null,
    enforced,
    project: {
      task_concurrency: repositoryConcurrency(store, repositoryId),
      task_concurrency_default: defaultConcurrency(store),
      running_tasks: Number(counts?.running_tasks ?? 0),
      queued_tasks: Number(counts?.queued_tasks ?? 0),
      capacity_waiting_tasks: Number(counts?.capacity_waiting_tasks ?? 0),
      ...(unattributedQueued > 0 ? { unattributed_queued: unattributedQueued } : {}),
    },
    unsupported,
    roles,
    ready_more: truncated,
  };
}
