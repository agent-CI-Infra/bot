import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import { fail, type Json } from '../core/security.js';
import { roleConfiguration } from './definition.js';
import { stageAllows, type StageDefinition } from './stage-policy.js';
import { concurrencyBounds, defaultConcurrency, repositoryConcurrency } from '../app/settings.js';

// #228 contract B: a read-only projection of per-role occupancy and the queue. Nothing here admits or blocks a run;
// `enforced` is part of the contract and stays false until the admission pull request (#228, second PR) lands.
const maxRoles = 32;
const maxReady = 100;
const defaultReadyLimit = 50;
// A queued task costs a stage lookup each, so the scan is bounded: a reader without write rights must not be able to
// make one GET cost as much as the whole backlog. 500 is far beyond what one page shows and beyond `ready_limit`.
const queueScanLimit = 500;
// `__proto__` is never a role id and assigning it would rewrite the prototype. `constructor`/`prototype` are ordinary
// names and are allowed: a project may define a role with either name.
const roleKeys = new Set(['__proto__']);

/**
 * Per-role concurrency overrides stored on the project policy. null means "explicitly unset", a missing key is "not
 * changed". This is the only read entry: it drops keys for roles the project no longer defines, so a later role with
 * the same id does not inherit a limit nobody set for it, and it drops values outside the shared bounds. Admission
 * (#228, second PR) must read through here rather than parsing the JSON itself.
 */
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

/** Validates one PATCH body value against this project's role configuration and the shared project concurrency bounds. */
export function roleConcurrencyValue(store: Store, repositoryId: string, value: unknown): Record<string, number | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_role_concurrency');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxRoles) fail(400, 'invalid_role_concurrency');
  const defined = new Set(roleConfiguration(store, repositoryId).roles.map(role => role.role_id));
  const limits: Record<string, number | null> = Object.create(null) as Record<string, number | null>;
  for (const [role, limit] of entries) {
    // A role id that this project does not define is a mistake, not a new role: never store a limit nothing can use.
    if (roleKeys.has(role) || !defined.has(role)) fail(400, 'invalid_role_concurrency');
    if (limit === null) { limits[role] = null; continue; }
    if (!Number.isSafeInteger(limit) || (limit as number) < concurrencyBounds[0] || (limit as number) > concurrencyBounds[1]) fail(400, 'invalid_role_concurrency');
    limits[role] = limit as number;
  }
  return limits;
}

/** The policy row as the console reads it: limits as an object, never a JSON string, and no invented default number. */
export function policyView(store: Store, policy: Json | undefined, repositoryId: string): Json | undefined {
  if (!policy) return policy;
  return { ...policy, role_concurrency: roleConcurrency(store, repositoryId) };
}

// Stages are validated acyclic when saved; ordering them here keeps the queue projection deterministic.
function ordered(stages: StageDefinition[]): StageDefinition[] {
  const done = new Set<string>(), order: StageDefinition[] = [];
  while (order.length < stages.length) {
    const next = stages.filter(stage => !done.has(stage.stage_id) && stage.depends_on.every(id => done.has(id)));
    if (!next.length) break;
    for (const stage of next) { done.add(stage.stage_id); order.push(stage); }
  }
  return order;
}

/** The first stage of this task that has no recorded result yet, or null when the task finished its stages. */
function nextStage(store: Store, taskId: string, order: StageDefinition[]): StageDefinition | null {
  const row = store.get('SELECT MAX(plan_revision) AS revision FROM task_stage_results WHERE task_id=?', taskId);
  if (row?.revision == null) return order[0] ?? null;
  const done = new Set(store.all('SELECT stage_id FROM task_stage_results WHERE task_id=? AND plan_revision=?', taskId, row.revision).map(r => r.stage_id));
  return order.find(stage => !done.has(stage.stage_id) && stage.depends_on.every(id => done.has(id))) ?? null;
}

/**
 * GET /api/repositories/:id/role-board. Display only: `enforced` is always false and no run is blocked by it.
 * A queued task is only attributed to a role when the project's stage policy names exactly one eligible role for the
 * stage the task is waiting for; otherwise the whole queue projection reports unsupported:["role_queue"] and `ready`
 * stays empty, because guessing a role from the task kind would show a number the scheduler does not honour.
 */
export function roleBoard(store: Store, repositoryId: string, url?: URL): Json {
  const limit = (() => { const raw = url?.searchParams.get('ready_limit'); if (raw === null || raw === undefined) return defaultReadyLimit; if (!/^\d+$/.test(raw)) fail(400, 'invalid_ready_limit'); const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1 || value > maxReady) fail(400, 'invalid_ready_limit'); return value; })();
  const config = roleConfiguration(store, repositoryId), limits = roleConcurrency(store, repositoryId);
  const stages = ordered(config.required_stages ?? []);
  const queued = store.all('SELECT id,kind,object_number,created_at FROM tasks WHERE repository_id=? AND status=\'queued\' ORDER BY created_at,id LIMIT ?', repositoryId, queueScanLimit + 1);
  let truncated = queued.length > queueScanLimit;
  if (truncated) queued.length = queueScanLimit;
  const attribution = new Map<string, string>();
  let unsupported: string[] = [];
  if (!stages.length) unsupported = ['role_queue'];
  else {
    const ambiguous = queued.filter(task => {
      const stage = nextStage(store, task.id, stages);
      const candidates = stage ? config.roles.filter(role => role.enabled && stageAllows(stage, role)) : [];
      if (candidates.length === 1) { attribution.set(task.id, candidates[0]!.role_id); return false; }
      return true;
    });
    if (ambiguous.length) unsupported = ['role_queue'];
  }
  const ready = queued.map((task, index) => ({ task, position: index + 1, role: unsupported.length ? null : attribution.get(task.id) ?? null }));
  const roles = config.roles.map(role => {
    const running = store.all(`SELECT r.id AS run_id,r.task_id,t.object_number,t.kind,r.role_instance_id,r.started_at
      FROM task_runs r JOIN tasks t ON t.id=r.task_id
      WHERE t.repository_id=? AND r.role=? AND r.status='running' ORDER BY r.started_at,r.id`, repositoryId, role.role_id)
      .map(run => ({ run_id: run.run_id, task_id: run.task_id, object_number: run.object_number, kind: run.kind, role_instance_id: run.role_instance_id, started_at: run.started_at }));
    const mine = ready.filter(entry => entry.role === role.role_id && role.enabled);
    if (mine.length > limit) truncated = true;
    const limitValue = limits[role.role_id] ?? null;
    return { role: role.role_id, enabled: !!role.enabled, limit: limitValue, limit_source: limitValue === null ? 'unset' : 'policy',
      running, ready: mine.slice(0, limit).map(entry => ({ task_id: entry.task.id, object_number: entry.task.object_number, kind: entry.task.kind, queued_at: entry.task.created_at, position: entry.position })),
      blocked: { capacity: 0 } };
  });
  const version = createHash('sha256').update(JSON.stringify({ revision: config.revision, updated_at: config.updated_at ?? null, stages: config.required_stages ?? [], limits })).digest('hex').slice(0, 16);
  return { version, updated_at: config.updated_at ?? null, enforced: false,
    project: { task_concurrency: repositoryConcurrency(store, repositoryId), task_concurrency_default: defaultConcurrency(store) },
    unsupported, roles, ready_more: truncated };
}
