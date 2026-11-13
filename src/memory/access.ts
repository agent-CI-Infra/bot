import {roleConfiguration} from '../roles/definition.js';
import type { Store, Row } from '../storage/database.js';
import { authorize, narrowActor, resolvePrincipalActor, type ActorContext } from '../identity/authorization.js';
import { fail } from '../core/security.js';
import { createHash } from 'node:crypto';

/** Created by server adapters only; no role/audience supplied by a tool or HTTP request is trusted. */
export interface MemoryAccess { actor: ActorContext; role?: string; task_id?: string; run_id?: string; }
// Trace readers can still inspect non-knowledge work products of legacy tasks. Knowledge remains closed without an actor.
export function taskTraceAccess(store: Store, task: Row): MemoryAccess {
  try { return taskMemoryAccess(store, task); }
  catch (error) { if ((error as any).code !== 'memory_actor_unavailable') throw error; return { actor: undefined!, role: task.active_role || 'dev',task_id:task.id,run_id:task.trace_run_id??undefined }; }
}
/** The configured Task Manager reads every retained record of its own task. This is not project-wide access. */
export function taskControllerReads(store:Store,taskId:string,access?:MemoryAccess):boolean {
  if(!access?.role||access.task_id!==taskId)return false;
  const task=store.get('SELECT repository_id FROM tasks WHERE id=?',taskId);
  return !!task&&access.role===roleConfiguration(store,task.repository_id).controller.role;
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
  if (write && access.role && access.role !== 'dev') fail(403, 'memory_role_read_only');
  return access;
}

/** Apply current ACLs to captured knowledge too. Snapshots cannot prolong a withdrawn grant/audience. */
export function visibleMemorySnapshot(store: Store, repo: string, value: any, access?: MemoryAccess): any {
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value), scoped = visibleMemorySnapshot(store, repo, parsed, access);
        // Preserve file/observation bytes unless a knowledge ACL actually removed something.
        return scoped === parsed ? value : JSON.stringify(scoped);
      } catch (error) { if ((error as any).code) throw error; }
    }
    const ref = /^project_memories:([^:]+):(\d+)$/.exec(value);
    if (ref && !canReadMemory(store, repo, ref[1]!, Number(ref[2]), access)) return '[knowledge unavailable]';
    return value;
  }
  if (Array.isArray(value)) {
    const scoped = value.map(v => visibleMemorySnapshot(store, repo, v, access));
    return scoped.some((v, i) => v !== value[i]) ? scoped : value;
  }
  if (!value || typeof value !== 'object') return value;
  // Legacy read_task_record receipts can wrap raw version JSON without an ID inside `content`.
  // Reject the whole receipt when its source is private; filtering only the reference would retain the body.
  for (const key of ['ref','memory_source','source']) {
    const ref = typeof value[key] === 'string' ? /^project_memories:([^:]+):(\d+)$/.exec(value[key]) : null;
    if (ref && !canReadMemory(store, repo, ref[1]!, Number(ref[2]), access)) return { availability: 'knowledge_forbidden' };
  }
  const memoryShape = value.repository_id && value.catalog && value.sources && Object.hasOwn(value, 'body');
  if (typeof value.id === 'string' && Number.isSafeInteger(value.revision) && (memoryShape || store.get('SELECT 1 FROM project_memories WHERE id=?', value.id)) && !canReadMemory(store, repo, value.id, value.revision, access)) return { availability: 'knowledge_forbidden' };
  const entries = Object.entries(value).map(([k,v]) => [k, visibleMemorySnapshot(store, repo, v, access)] as const);
  if (!entries.some(([k,v]) => v !== value[k])) return value;
  const scoped = Object.fromEntries(entries);
  if (value.schema_version === 1 && typeof value.sha256 === 'string') {
    // The original digest still identifies retained evidence; a filtered view is explicitly incomplete.
    return { ...scoped, complete: false, missing_reason: 'knowledge_filtered' };
  }
  return scoped;
}
export function canReadMemory(store: Store, repo: string, id: string, revision: number, access?: MemoryAccess): boolean {
  if(!access?.actor)return false;memoryAuthorize(access, repo);
  const current = store.get('SELECT data FROM project_memories WHERE repository_id=? AND id=?', repo, id);
  const old = store.get('SELECT data FROM project_memory_versions WHERE memory_id=? AND revision=?', id, revision);
  return !!current && !!old && memoryVisible(access!, repo, JSON.parse(current.data)) && memoryVisible(access!, repo, JSON.parse(old.data));
}
export function memoryAudience(data: any): string {
  return data.catalog?.audience ?? (data.scope?.role ? 'role:' + data.scope.role : data.owner === 'agent' ? 'role:dev' : 'project');
}
export function memoryVisible(access: MemoryAccess, repo: string, data: any): boolean {
  memoryAuthorize(access, repo);
  const audience = memoryAudience(data);
  if (audience === 'project' || access.role && audience === 'role:' + access.role) return true;
  // Administrators may manage role knowledge; a task never inherits its creator's administrative view.
  if (access.role) return false;
  try { authorize(access.actor, 'knowledge.write', { project_id: repo }); return true; } catch { return false; }
}

/**
 * Keep the authorized subject separate from its visible memory IDs. Only withdrawing a previously visible ID requires
 * rebuilding a session; new memories or wider audiences preserve it and are announced in the next input.
 */
export function memoryViewSnapshot(store: Store, task: Row): { scope: string; entries: { id: string; title: string }[] } {
  try {
    const access = taskMemoryAccess(store, task); memoryAuthorize(access, task.repository_id);
    const entries = store.all('SELECT id,fact_key,data FROM project_memories WHERE repository_id=? ORDER BY id', task.repository_id).flatMap(row => {
      const data = JSON.parse(row.data);
      return memoryVisible(access, task.repository_id, data) ? [{ id: row.id, title: data.catalog?.title ?? row.fact_key }] : [];
    });
    return { scope: createHash('sha256').update(JSON.stringify([task.repository_id, access.actor.principal_id, access.actor.tenant_id, access.role])).digest('hex'), entries };
  } catch (error) { return { scope: 'unavailable:' + ((error as any).code ?? 'memory_unavailable'), entries: [] }; }
}
