import { roleConfiguration } from '../roles/definition.js';
import type { Store, Row } from '../storage/database.js';
import { authorize, narrowActor, resolvePrincipalActor, type ActorContext } from '../identity/authorization.js';
import { fail } from '../core/security.js';

/** Created by server adapters only; no role supplied by a tool or HTTP request is trusted. */
export interface MemoryAccess { actor: ActorContext; role?: string; task_id?: string; run_id?: string; }

// Trace readers can still inspect non-knowledge work products of legacy tasks. Knowledge remains closed without an actor.
export function taskTraceAccess(store: Store, task: Row): MemoryAccess {
  try { return taskMemoryAccess(store, task); }
  catch (error) {
    if ((error as any).code !== 'memory_actor_unavailable') throw error;
    return { actor: undefined!, role: task.active_role || 'dev', task_id: task.id, run_id: task.trace_run_id ?? undefined };
  }
}

/** The configured Task Manager reads every retained record of its own task. This is not project-wide access. */
export function taskControllerReads(store: Store, taskId: string, access?: MemoryAccess): boolean {
  if (!access?.role || access.task_id !== taskId) return false;
  const task = store.get('SELECT repository_id FROM tasks WHERE id=?', taskId);
  return !!task && access.role === roleConfiguration(store, task.repository_id).controller.role;
}

export function taskMemoryAccess(store: Store, task: Row): MemoryAccess {
  const grant = store.get('SELECT * FROM task_authorizations WHERE task_id=? AND project_id=?', task.id, task.repository_id);
  if (!grant) return fail(403, 'memory_actor_unavailable');
  const resolved = resolvePrincipalActor(store, grant.principal_id, grant.tenant_id, grant.project_id, 'service');
  const origin = store.get('SELECT principal_capabilities FROM task_origins WHERE task_id=?', task.id);
  const actor = origin?.principal_capabilities ? narrowActor(resolved, JSON.parse(origin.principal_capabilities)) : resolved;
  authorize(actor, grant.capability, { project_id: grant.project_id });
  return { actor, role: task.active_role || (String(task.kind).startsWith('review.') ? 'reviewer' : 'dev'), task_id: task.id, run_id: task.trace_run_id ?? undefined };
}

export function memoryAuthorize(access: MemoryAccess | undefined, repo: string, write = false): MemoryAccess {
  if (!access?.actor) return fail(403, 'memory_actor_required');
  if (access.actor.project_id && access.actor.project_id !== repo) fail(403, 'project_scope_mismatch');
  authorize(access.actor, write ? 'knowledge.write' : 'knowledge.read', { project_id: repo });
  return access;
}
