import type { Store, Row } from '../storage/database.js';
import type { Actor } from '../app/auth.js';
import { assertCurrent, authorize, narrowActor, resolvePrincipalActor, type ActorContext } from '../identity/authorization.js';
import { projectCapabilities, explicitDelegationCapabilities } from '../identity/storage.js';
import { fail, digest } from '../core/security.js';
import { roleConfiguration } from '../roles/definition.js';
import { permissionItems, permitsTool, type RolePermissions } from '../roles/permissions.js';
import { taskPermissions } from './configuration.js';

export function taskManagementStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_origins(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL,project_id TEXT NOT NULL,source_role TEXT,principal_id TEXT,conversation_id TEXT,
    source_message TEXT,source_task_id TEXT,source_run_id TEXT,owner_key TEXT NOT NULL,executor_role TEXT,
    permissions TEXT,config_revision INTEGER NOT NULL,authorization_revision INTEGER,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_origin_owner ON task_origins(project_id,owner_key);`);
  if (!store.all('PRAGMA table_info(task_origins)').some(c => c.name === 'principal_capabilities')) store.db.exec('ALTER TABLE task_origins ADD COLUMN principal_capabilities TEXT');
  store.db.exec(`DROP TRIGGER IF EXISTS inherit_task_origin;
    CREATE TRIGGER inherit_task_origin AFTER INSERT ON tasks WHEN NEW.source_task_id IS NOT NULL BEGIN
      INSERT OR IGNORE INTO task_origins SELECT NEW.id,source_kind,project_id,source_role,principal_id,conversation_id,source_message,
        NEW.source_task_id,source_run_id,owner_key,executor_role,permissions,config_revision,authorization_revision,strftime('%Y-%m-%dT%H:%M:%fZ','now'),principal_capabilities
        FROM task_origins WHERE task_id=NEW.source_task_id; END;`);
  if(!store.all('PRAGMA table_info(role_instances)').some(c=>c.name==='source_fence'))store.db.exec("ALTER TABLE role_instances ADD COLUMN source_fence TEXT NOT NULL DEFAULT ''");
}

export interface TaskCaller {
  readonly kind: 'operator' | 'event' | 'role'; readonly project_id: string; readonly role: string | null;
  readonly principal_id: string | null; readonly conversation_id: string | null; readonly source_message: string | null;
  readonly source_task_id: string | null; readonly source_run_id: string | null; readonly owner_key: string;
  readonly permissions: RolePermissions | null; readonly config_revision: number; readonly authorization_revision: number | null;
  readonly principal_capabilities: readonly string[] | null;
}
interface Trust { store: Store; guard: () => void; actor?: ActorContext; user?: Actor; }
// Model arguments and deserialized snapshots cannot manufacture this in-process authority.
const issued = new WeakMap<TaskCaller, Trust>();
const sourceGuards = new WeakMap<Store, (origin: Row) => void>();
export function taskSourceGuard(store: Store, guard: (origin: Row) => void): void { sourceGuards.set(store, guard); }
const roleOf = (s: Store, project: string, role: string) => roleConfiguration(s, project).roles.find(r => r.role_id === role && r.enabled);
const canManage = (permissions: RolePermissions, write: boolean) => permissions.task_management === 'write' || !write && permissions.task_management === 'read';
function issue(store: Store, data: Omit<TaskCaller, 'owner_key' | 'principal_capabilities'>, trust: Omit<Trust, 'store'>): TaskCaller {
  const owner_key = JSON.stringify([data.kind, data.project_id, data.principal_id, data.conversation_id, data.role]);
  const principal_capabilities = trust.actor ? [...projectCapabilities, ...explicitDelegationCapabilities].filter(cap => {
    try { authorize(trust.actor!, cap, { project_id: data.project_id }); return true; } catch (error) { if ((error as any).code !== 'capability_forbidden') throw error; return false; }
  }) : null;
  const caller = Object.freeze({ ...data, permissions: data.permissions ? Object.freeze({ ...data.permissions }) : null,
    principal_capabilities: principal_capabilities ? Object.freeze(principal_capabilities) : null, owner_key });
  issued.set(caller, { store, ...trust }); return caller;
}
/** Trusted adapters supply the role, principal and source. None of these fields are accepted by task tools. */
export function roleTaskCaller(store: Store, project: string, role: string, source: {
  actor?: ActorContext; conversation_id?: string; source_message?: string; source_task_id?: string; source_run_id?: string; allowed_tools?: readonly string[]; allowed_capabilities?: readonly string[]; guard: () => void;
}): TaskCaller {
  source.guard(); const actor = source.actor && source.allowed_capabilities ? narrowActor(source.actor, [...source.allowed_capabilities]) : source.actor;
  if (actor) { assertCurrent(actor); authorize(actor, 'tasks.read', { project_id: project }); }
  const config = roleConfiguration(store, project), definition = config.roles.find(r => r.role_id === role && r.enabled);
  if (!definition) return fail(403, 'task_role_unavailable');
  return issue(store, { kind: 'role', project_id: project, role, principal_id: source.actor?.principal_id ?? null,
    conversation_id: source.conversation_id ?? null, source_message: source.source_message ?? null,
    source_task_id: source.source_task_id ?? null, source_run_id: source.source_run_id ?? null,
    permissions: Object.fromEntries(permissionItems.map(item => {
      const mode = definition.permissions[item.id]!;
      if (!source.allowed_tools) return [item.id, mode];
      const all = [...item.read, ...item.write].every(name => source.allowed_tools!.includes(name));
      return [item.id, all ? mode : item.modes.includes('read') && item.read.every(name => source.allowed_tools!.includes(name)) ? (mode === 'none' ? 'none' : 'read') : item.modes[0]!];
    })), config_revision: config.revision, authorization_revision: source.actor?.authorization_revision ?? null },
    { guard: source.guard, actor });
}
/** The human console keeps its existing project-management grant; it is not an impersonated employee role. */
export function operatorTaskCaller(store: Store, user: Actor, project: string): TaskCaller {
  const guard = () => {
    if (user.context) authorize(user.context, 'tasks.write', { project_id: project });
    else if (user.role !== 'super_admin' && !user.repositories.includes(project)) fail(403, 'repository_forbidden');
  };
  guard(); return issue(store, { kind: 'operator', project_id: project, role: null, principal_id: user.context?.principal_id ?? null,
    conversation_id: null, source_message: null, source_task_id: null, source_run_id: null, permissions: null,
    config_revision: roleConfiguration(store, project).revision, authorization_revision: user.context?.authorization_revision ?? null }, { guard, actor: user.context, user });
}
/** Event eligibility/object/head/development approval stays in its adapter; final role checks are shared. */
export function eventTaskCaller(store: Store, project: string, event: string, guard: () => void = () => {}): TaskCaller {
  const config = roleConfiguration(store, project), role = config.roles.find(r => r.role_id === 'manager' && r.enabled);
  if (!role) return fail(403, 'task_role_unavailable');
  return issue(store, { kind: 'event', project_id: project, role: role.role_id, principal_id: null, conversation_id: null,
    source_message: event, source_task_id: null, source_run_id: null, permissions: role.permissions, config_revision: config.revision, authorization_revision: null }, { guard });
}
/** A conversation may answer without task-management authority; it still needs a trusted live source. */
export function assertTaskSource(store: Store, caller: TaskCaller): void {
  const trust = issued.get(caller); if (!trust || trust.store !== store) return fail(403, 'task_caller_untrusted');
  trust.guard();
  if (trust.actor) { assertCurrent(trust.actor); authorize(trust.actor, 'tasks.read', { project_id: caller.project_id }); }
  if (caller.role && !roleOf(store, caller.project_id, caller.role)) fail(403, 'task_role_unavailable');
}
export function assertTaskCaller(store: Store, caller: TaskCaller, write = false): void {
  assertTaskSource(store, caller); const trust = issued.get(caller)!;
  if (trust.actor) {
    assertCurrent(trust.actor);
    if (caller.kind === 'operator') authorize(trust.actor, write ? 'tasks.write' : 'tasks.read', { project_id: caller.project_id });
    else if (write) {
      try { authorize(trust.actor, 'tasks.manage_own', { project_id: caller.project_id }); }
      catch (error) { if ((error as any).code !== 'capability_forbidden') throw error; authorize(trust.actor, 'tasks.write', { project_id: caller.project_id }); }
    }
  }
  if (caller.role) {
    const current = roleOf(store, caller.project_id, caller.role);
    if (!current || !caller.permissions || !canManage(caller.permissions, write) || !canManage(current.permissions, write)) fail(403, 'task_management_forbidden');
  }
}
export function taskCallerActor(store: Store, caller: TaskCaller): ActorContext | undefined {
  const trust = issued.get(caller); if (!trust || trust.store !== store) return fail(403, 'task_caller_untrusted');
  return trust.actor;
}
export function taskExecutor(store: Store, caller: TaskCaller, requested?: string): string | null {
  assertTaskCaller(store, caller, true);
  const executor = requested ?? caller.role;
  // A human API call has no calling role and retains the existing project-team entry.
  if (!executor) return null;
  const target = roleOf(store, caller.project_id, executor);
  if (!target || target.kind === 'evaluator' || executor === 'coordinator') return fail(403, 'task_executor_unavailable');
  if (executor !== caller.role && caller.kind !== 'operator') {
    const source = roleOf(store, caller.project_id, caller.role!);
    if (caller.permissions?.delegation !== 'allow' || source?.permissions.delegation !== 'allow') fail(403, 'task_delegation_forbidden');
  }
  return executor;
}
export function assertManagedTask(store: Store, caller: TaskCaller, id: string, write = false): Row {
  assertTaskCaller(store, caller, write);
  const task = store.get('SELECT * FROM tasks WHERE id=? AND repository_id=?', id, caller.project_id);
  if (!task) return fail(404, 'task_not_found');
  if (caller.kind === 'operator' || caller.kind === 'event') return task;
  const origin = store.get('SELECT owner_key FROM task_origins WHERE task_id=?', id);
  const assigned = caller.source_task_id === id && caller.source_run_id && store.get(
    "SELECT 1 FROM task_runs WHERE id=? AND task_id=? AND role=? AND status='running'", caller.source_run_id, id, caller.role!);
  if (origin?.owner_key !== caller.owner_key && !assigned) return fail(403, 'task_not_owned');
  return task;
}
/** Every entry creates/attaches through this boundary; its callback retains the work type's original validation and records. */
export function createManagedTask(store: Store, caller: TaskCaller, requested: string | undefined, create: (executor: string | null) => string | null): string | null {
  return store.transaction(() => {
    const executor = taskExecutor(store, caller, requested), id = create(executor);
    if (!id) return null;
    const task = store.get('SELECT repository_id FROM tasks WHERE id=?', id);
    if (task?.repository_id !== caller.project_id) return fail(403, 'task_project_mismatch');
    store.run(`INSERT OR IGNORE INTO task_origins VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, caller.kind, caller.project_id, caller.role, caller.principal_id,
      caller.conversation_id, caller.source_message, caller.source_task_id, caller.source_run_id, caller.owner_key, executor,
      caller.permissions ? JSON.stringify(caller.permissions) : null, caller.config_revision, caller.authorization_revision, new Date().toISOString(),
      caller.principal_capabilities ? JSON.stringify(caller.principal_capabilities) : null);
    return id;
  });
}
export function managedTaskOrigin(store: Store, id: string): Row | undefined { return store.get('SELECT * FROM task_origins WHERE task_id=?', id); }
export function taskOriginChain(store: Store, task: Row): Row[] {
  const result: Row[] = [], seen = new Set<string>(); let current = task;
  for (;;) {
    if (seen.has(current.id) || seen.size >= 64) return fail(403, 'task_source_lineage_invalid');
    seen.add(current.id); const origin = managedTaskOrigin(store, current.id); if (!origin) break;
    if (origin.project_id !== task.repository_id) return fail(403, 'task_project_mismatch');
    result.push(origin); if (!origin.source_task_id) break;
    const parent = store.get('SELECT * FROM tasks WHERE id=? AND repository_id=?', origin.source_task_id, task.repository_id);
    if (!parent) return fail(403, 'task_source_lineage_invalid'); current = parent;
  }
  return result;
}
/** Recovered work checks current grants and source facts, without trusting serialized ActorContext values. */
export function assertManagedExecution(store: Store, task: Row): Row | undefined {
  const chain = taskOriginChain(store, task);
  for (let index = 0; index < chain.length; index++) {
  const origin = chain[index]!;
  const child = chain[index - 1];
  if (child && origin.principal_id && child.principal_id !== origin.principal_id) fail(403, 'task_source_lineage_invalid');
  sourceGuards.get(store)?.(origin);
  if (origin.principal_id) {
    const resolved = resolvePrincipalActor(store, origin.principal_id, null, task.repository_id);
    const actor = origin.principal_capabilities ? narrowActor(resolved, JSON.parse(origin.principal_capabilities)) : resolved;
    authorize(actor, 'tasks.read', { project_id: task.repository_id });
    if (origin.source_kind === 'operator') authorize(actor, 'tasks.write', { project_id: task.repository_id });
    else {
      try { authorize(actor, 'tasks.manage_own', { project_id: task.repository_id }); }
      catch (error) { if ((error as any).code !== 'capability_forbidden') throw error; authorize(actor, 'tasks.write', { project_id: task.repository_id }); }
    }
  }
  if (origin.source_role) {
    const live = roleOf(store, task.repository_id, origin.source_role), fixed = JSON.parse(origin.permissions) as RolePermissions;
    if (!live || !canManage(fixed, true) || !canManage(live.permissions, true)) return fail(403, 'task_management_forbidden');
    if (origin.executor_role !== origin.source_role && (fixed.delegation !== 'allow' || live.permissions.delegation !== 'allow')) fail(403, 'task_delegation_forbidden');
    if (origin.executor_role && !roleOf(store, task.repository_id, origin.executor_role)) fail(403, 'task_executor_unavailable');
    if (child && origin.source_kind === 'role' && child.source_role !== origin.source_role && (fixed.delegation !== 'allow' || live.permissions.delegation !== 'allow')) fail(403, 'task_delegation_forbidden');
  }
  }
  return chain[0];
}
/** A role may narrow a delegated run, never lend an external write it did not receive. QA submission is a framework gate. */
export function taskToolAllowed(store: Store, task: Row, role: string, name: string): boolean {
  assertManagedExecution(store, task);
  if (role === 'qa' && name === 'submit_acceptance') return true;
  for (const origin of taskOriginChain(store, task).filter(o => o.source_kind === 'role')) {
  const fixed = JSON.parse(origin.permissions) as RolePermissions, current = roleOf(store, task.repository_id, origin.source_role)?.permissions;
  if (!current || !permitsTool(fixed, name) || !permitsTool(current, name)) return false;
  }
  return true;
}
export function assertTaskRole(store: Store, task: Row, role: string): void {
  assertManagedExecution(store, task); if (role === 'qa') return;
  for (const origin of taskOriginChain(store, task).filter(o => o.source_kind === 'role' && o.source_role !== role)) {
  const fixed = JSON.parse(origin.permissions) as RolePermissions, current = roleOf(store, task.repository_id, origin.source_role)?.permissions;
  if (fixed.delegation !== 'allow' || current?.delegation !== 'allow') fail(403, 'task_delegation_forbidden');
  }
}
export function assertTaskExternalEffect(store: Store, task: Row, kind: string): void {
  const origin=assertManagedExecution(store,task);
  if(!origin||origin.source_kind!=='role')return;
  const tool=kind==='issue'?'create_issue':['branch','pull_request'].includes(kind)?'create_pull_request':null;
  const role=String(task.active_role??origin.executor_role),current=roleOf(store,task.repository_id,role);
  if(!tool||!current||!permitsTool(current.permissions,tool)||!taskToolAllowed(store,task,role,tool)||
    !taskPermissions(store,task).writes.includes(kind==='issue'?'issue':'pull_request'))fail(403,'task_external_write_forbidden');
}
/** A physical transcript is rebuilt when authority changes; the logical task and role instance keep their IDs. */
export function taskAuthorizationFence(store:Store,task:Row,role:string):string {
  return digest(JSON.stringify({role:roleOf(store,task.repository_id,role)?.permissions??null,sources:taskOriginChain(store,task).map(origin=>({source_role:origin.source_role,
    source_permissions:origin.source_role?roleOf(store,task.repository_id,origin.source_role)?.permissions:null,
    principal_revision:origin.principal_id?store.get('SELECT authorization_revision FROM principals WHERE id=?',origin.principal_id)?.authorization_revision:null}))}));
}

const tool = (name: string, description: string, properties: any, required: string[] = []) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
export const taskManagementTools = [
  tool('list_managed_tasks', 'List tasks owned by this trusted caller. This never reads another conversation or project.', { offset: { type: 'integer' }, limit: { type: 'integer' } }),
  tool('read_managed_task', 'Read one owned or explicitly assigned task and its current revision.', { task_id: { type: 'string' } }, ['task_id']),
  tool('create_task', 'Create a task in the current project, executing as yourself by default. Another executor requires delegation. Set execute=false to record it without running.', {
    request: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } }, executor_role: { type: 'string' }, execute: { type: 'boolean' } }, ['request', 'criteria']),
  tool('manage_task', 'Append an instruction, continue, pause, or cancel an owned or assigned task. Terminal software deliveries cannot be reopened.', {
    task_id: { type: 'string' }, action: { type: 'string', enum: ['instructions', 'retry', 'pause', 'cancel'] }, instruction: { type: 'string' } }, ['task_id', 'action'])
];
