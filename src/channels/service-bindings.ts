import type { Store, Row } from '../storage/database.js';
import { activeScopes, assertCurrent, authorize, invalidate, invalidateIfLost, listEffectiveProjectAccess, narrowActor, resolvePrincipalActor, restrictActor, revision, type ActorContext } from '../identity/authorization.js';
import { digest, fail, fields, HttpError, object, randomId, text, type Json } from '../core/security.js';
import { defaultGroupAssistantPrompt, defaultSharedModel, groupAssistant, managementAssistant, modelGaps, modelServes, repositoryAssistant, serviceHarnesses, serviceRole } from '../service-roles/roles.js';
import { githubResources, groupPermissionItems, groupTaskModes, normalizePermissions, permissionItems, permitsManagement, retiredPermissionItems, serviceCapabilities, updatePermissions, validPermissionInput, type RolePermissions } from '../roles/permissions.js';
import { commands } from '../management/catalog.js';
import type { ChannelEmployees } from './employees.js';
import type { ChannelEvent } from './types.js';
import { tenantName } from './applications.js';
import { chatProfile } from './profiles.js';

// A group binding owns one project scope (a whole organization or chosen repositories), the group's own permission level,
// and its assistant configuration: model, prompt and Agent harness (#849, #1206, #1249). The scope is held as scoped_grants
// of a principal owned by the binding; each grant names the maintainer who granted it. At run time a group can use a project
// only while the binding's level and that grantor's own current authority both still allow it; GitHub writes are further
// limited by what the App installation grants. Speakers are not checked: the console configuration alone decides what the
// group may do, for every member alike.
// The first configurer owns the binding (owner_id); configured_by is whoever changed it last. Only the owner, organization
// admins of every tenant in its scope and platform administrators change or disable it (#424).

/** Bot replies of a binding are scoped to it in the local ledger, so another binding or project never reads them back. */
export const bindingScope = (id: string) => 'binding:' + id;
const participations = ['mentions', 'questions', 'all'];
const terminal = (error: unknown) => error instanceof HttpError && error.status < 500;
function optionalText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return fail(400, 'invalid_field', field);
  return value.trim();
}

/**
 * The three permission levels a binding offers (#849), as items of the shared permission catalog. Each level adds to the
 * previous one: read is GitHub reads plus the conversation tools every group has; comment adds github_write on Issues and
 * pull requests (comments, labels, assignees, new Issues) and on Actions (starting a workflow, #1072); dispatch adds
 * creating tasks through the Manager and updating or cancelling this group's tasks. Contents write, and so merging from the group, is only available
 * as an individual item (custom).
 */
export const bindingLevels = ['read', 'comment', 'dispatch'] as const;
export type BindingLevel = typeof bindingLevels[number] | 'custom';
export const bindingGithubLevels = ['read', 'comment'] as const;
export type BindingGithubLevel = typeof bindingGithubLevels[number] | 'custom';
export function githubLevelPermissions(level: typeof bindingGithubLevels[number]): RolePermissions {
  return {
    github_issues: level === 'comment' ? 'write' : 'read',
    github_pull_requests: level === 'comment' ? 'write' : 'read',
    github_actions: level === 'comment' ? 'write' : 'read',
    github_contents: 'read',
    github_checks: 'read',
    github_statuses: 'read',
  };
}
/** The GitHub permission preset a set of items equals on the 6 GitHub resources, or custom (#1206). */
export function bindingGithubLevel(value: RolePermissions): BindingGithubLevel {
  const p = normalizePermissions(value, true);
  if (Object.keys(p).some(key => githubResources.some(resource => key.startsWith('legacy_' + resource + '_')))) return 'custom';
  return bindingGithubLevels.find(level => {
    const preset = githubLevelPermissions(level);
    return Object.entries(preset).every(([key, mode]) => p[key] === mode);
  }) ?? 'custom';
}
export function levelPermissions(level: typeof bindingLevels[number]): RolePermissions {
  const p = normalizePermissions({ github: 'read' }, true);
  p.project_memory = 'read';
  if (level !== 'read') { p.github_issues = 'write'; p.github_pull_requests = 'write'; p.github_actions = 'write'; }
  if (level === 'dispatch') { p.delegation = 'allow'; p.project_tasks = 'create'; }
  return p;
}
/** The level a set of items equals exactly, or custom: a binding never reads as a level wider or narrower than it is. */
export function bindingLevel(value: RolePermissions): BindingLevel {
  const p = normalizePermissions(value, true);
  if (Object.keys(p).some(key => key.startsWith('legacy_'))) return 'custom';
  return bindingLevels.find(level => { const preset = levelPermissions(level); return permissionItems.every(item => p[item.id] === preset[item.id]); }) ?? 'custom';
}
/** The stored form: normalized like a service role's items, so a migrated binding keeps the authorization fence it had. */
const stored = (p: RolePermissions) => JSON.stringify(normalizePermissions(p, true));
/** Preserve the pre-#1206 fence slot for untouched existing bindings whose stored JSON still carries retired
 * computer/browser (or legacy_repository/legacy_commands) keys, so upgrading never breaks active turns, visible group
 * history, attachments, or running assistant computers. Saving a binding after #1206 increments binding.revision and
 * writes only active items, rotating the fence normally. */
function fencePermissions(binding: Row): string {
  const raw: RolePermissions | null = binding.permissions ? JSON.parse(String(binding.permissions)) : null;
  if (raw && Object.hasOwn(raw, 'computer')) {
    const { playbooks: _playbooks, ...active } = raw;
    const base = Object.fromEntries(permissionItems.map(item => [item.id, item.modes[0]!])) as RolePermissions;
    const slot: RolePermissions = { computer: 'deny', browser: 'deny', ...base, ...active };
    if (!Object.hasOwn(raw, 'browser') && (slot.computer === 'allow' || slot.computer === 'custom' && slot.legacy_commands === 'allow')) slot.browser = 'allow';
    if (slot.github_actions === 'write') slot.github_actions = 'read';
    return JSON.stringify(slot);
  }
  const items = bindingPermissions(binding);
  return stored(items.github_actions === 'write' ? { ...items, github_actions: 'read' } : items);
}
/** Older advanced bindings could grant task creation (delegation) independently of task visibility and control.
 * Keep those exact grants until the owner explicitly selects one of the four task modes. */
function bindingTaskMode(p: RolePermissions) {
  const mode = p.project_tasks;
  if (mode === 'custom' || (p.delegation === 'allow') !== (mode === 'create' || mode === 'write')) return 'custom';
  return mode;
}

export function serviceBindingStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS channel_service_bindings(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL UNIQUE REFERENCES channel_chats(id),
      service_role_id TEXT NOT NULL,scope TEXT NOT NULL,principal_id TEXT NOT NULL UNIQUE,configured_by TEXT NOT NULL,
      participation TEXT NOT NULL DEFAULT 'mentions',enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,
      migrated_from TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS channel_service_binding_role ON channel_service_bindings(service_role_id);
    CREATE TABLE IF NOT EXISTS channel_service_turns(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,binding_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,
      service_role_id TEXT NOT NULL,source_message TEXT NOT NULL,fence TEXT NOT NULL,state TEXT NOT NULL,reply TEXT,error TEXT,
      tool_calls INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(chat_id,source_message));
    CREATE INDEX IF NOT EXISTS channel_service_turn_scope ON channel_service_turns(chat_id,created_at);
    CREATE TABLE IF NOT EXISTS channel_service_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,turn_id TEXT NOT NULL REFERENCES channel_service_turns(id) ON DELETE CASCADE,
      type TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS channel_service_event_turn ON channel_service_events(turn_id,sequence);
    -- Tasks a group created through delegation, so their results return to that group (and only while it may still see them).
    CREATE TABLE IF NOT EXISTS channel_service_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,binding_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,source_message TEXT NOT NULL,command_id TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS channel_service_task_result AFTER UPDATE OF status,result,error_code ON tasks
      WHEN NEW.status IN ('completed','succeeded','pr_opened','cancelled','failed') AND (OLD.status<>NEW.status OR OLD.result IS NOT NEW.result OR OLD.error_code IS NOT NEW.error_code)
      AND EXISTS(SELECT 1 FROM channel_service_tasks WHERE task_id=NEW.id) BEGIN
      INSERT INTO channel_task_results(task_id) VALUES(NEW.id); END;`);
  // Why a turn failed beyond its code, for example a model that sent nothing for 90 seconds through every retry.
  if (!store.all('PRAGMA table_info(channel_service_turns)').some(c => c.name === 'error_detail'))
    store.db.exec('ALTER TABLE channel_service_turns ADD COLUMN error_detail TEXT');
  // Step identity and timing (#1313): a call and its result share a call id, and each side keeps the clock reading taken
  // when it was written. Steps recorded before this migration keep NULL in all three and read as unrecorded.
  const eventCols = store.all('PRAGMA table_info(channel_service_events)').map(c => c.name);
  if (!eventCols.includes('call_id')) store.db.exec('ALTER TABLE channel_service_events ADD COLUMN call_id TEXT');
  if (!eventCols.includes('started_at')) store.db.exec('ALTER TABLE channel_service_events ADD COLUMN started_at INTEGER');
  if (!eventCols.includes('ended_at')) store.db.exec('ALTER TABLE channel_service_events ADD COLUMN ended_at INTEGER');
  // Bindings from before #424 are owned by their configurer.
  if (!store.all('PRAGMA table_info(channel_service_bindings)').some(c => c.name === 'owner_id'))
    store.db.exec("ALTER TABLE channel_service_bindings ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
  store.run("UPDATE channel_service_bindings SET owner_id=configured_by WHERE owner_id=''");
  // Group assistant configuration lives directly on each group binding (#1249).
  const bindingCols = store.all('PRAGMA table_info(channel_service_bindings)').map(c => c.name);
  if (!bindingCols.includes('model_id')) store.db.exec('ALTER TABLE channel_service_bindings ADD COLUMN model_id TEXT');
  if (!bindingCols.includes('prompt')) store.db.exec('ALTER TABLE channel_service_bindings ADD COLUMN prompt TEXT');
  // Pi is the default backend (#1255); a database from before it moves its Native bindings over once (src/roles/native-to-pi.ts).
  if (!bindingCols.includes('harness')) store.db.exec("ALTER TABLE channel_service_bindings ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi'");
  migrateEmployees(store);
  migrateLevels(store);
  migrateActionsWrite(store);
  migrateInlineAssistant(store);
  migrateModelGrants(store);
}
/** Once per binding (#1249): copy the referenced service role's model, harness and responsibility+prompt onto the binding
 * itself. Keeps service_role_id and revision untouched so upgraded bindings keep their authorization fence, chat summaries,
 * assistant computers, own tasks and private memory without disruption. */
function migrateInlineAssistant(store: Store): void {
  const pending = store.all('SELECT id,service_role_id FROM channel_service_bindings WHERE prompt IS NULL ORDER BY created_at,id');
  if (!pending.length) return;
  store.transaction(() => {
    for (const binding of pending) {
      const role = store.hasTable('service_roles') ? store.get('SELECT * FROM service_roles WHERE id=?', binding.service_role_id) : undefined;
      const prompt = [String(role?.responsibility ?? '').trim(), String(role?.prompt ?? '').trim()].filter(Boolean).join('\n\n');
      const modelId = role?.model_id ?? null;
      const harness = role?.harness && serviceHarnesses.includes(String(role.harness)) ? String(role.harness) : 'pi';
      store.run('UPDATE channel_service_bindings SET model_id=?,prompt=?,harness=? WHERE id=? AND prompt IS NULL',
        modelId, prompt, harness, binding.id);
      store.audit('system', 'channel.service_binding.assistant_migrated', binding.id);
    }
  });
}
/** Once (#1072): comment and dispatch gained Actions write. A binding that writes Issues and reads Actions takes it too, so
 * it keeps reading as its level; like project roles, Actions write follows Issues write. Nothing narrows, so the revision
 * and the fence (see fence) stay: no turn is stopped and the group's history stays readable. */
function migrateActionsWrite(store: Store): void {
  if (store.get("SELECT 1 FROM settings WHERE key='channel_service_binding_actions_write_migrated'")) return;
  store.transaction(() => {
    for (const binding of store.all('SELECT id,permissions FROM channel_service_bindings WHERE permissions IS NOT NULL ORDER BY created_at,id')) {
      let raw: RolePermissions; try { raw = JSON.parse(String(binding.permissions)); } catch { continue; }
      const p = normalizePermissions(raw, true);
      if (p.github_issues !== 'write' || p.github_actions !== 'read') continue;
      const next = Object.hasOwn(raw, 'computer') ? JSON.stringify({ ...raw, ...p, github_actions: 'write' }) : stored({ ...p, github_actions: 'write' });
      store.run('UPDATE channel_service_bindings SET permissions=? WHERE id=?', next, binding.id);
      store.audit('system', 'channel.service_binding.actions_write_migrated', binding.id);
    }
    store.run("INSERT INTO settings VALUES('channel_service_binding_actions_write_migrated',?) ON CONFLICT(key) DO NOTHING", new Date().toISOString());
  });
}
/** The started projects a binding's scope covers: each chosen repository, or every project of the organization. A group reads
 * all of them, so its model must serve all of them (#849). */
export function scopeProjects(store: Store, principal: string): string[] {
  return store.all(`SELECT DISTINCT r.id FROM scoped_grants g JOIN identity_projects ip ON ip.tenant_id=g.tenant_id AND (g.scope='tenant' OR ip.project_id=g.project_id)
    JOIN repositories r ON r.id=ip.project_id WHERE g.principal_id=? AND g.policy='channel_service_binding' AND g.revoked_at IS NULL ORDER BY r.full_name`, principal).map(r => String(r.id));
}
/** Once (#849): before the model rule, a group's shared model read every project in its scope without being authorized to
 * them. Each enabled binding's model is authorized to the projects it already served, so no group stops on upgrade; the
 * trust this records was already given when the group was bound. */
function migrateModelGrants(store: Store): void {
  if (store.get("SELECT 1 FROM settings WHERE key='channel_service_binding_models_migrated'")) return;
  store.transaction(() => {
    for (const binding of store.all(`SELECT b.principal_id,m.id model FROM channel_service_bindings b
      JOIN models m ON m.id=b.model_id AND m.repository_id IS NULL WHERE b.enabled=1`))
      for (const gap of modelGaps(store, binding.model, scopeProjects(store, binding.principal_id))) {
        store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', binding.model, gap.id);
        store.audit('system', 'model.sharing_migrated', binding.model, gap.id);
      }
    store.run("INSERT INTO settings VALUES('channel_service_binding_models_migrated',?) ON CONFLICT(key) DO NOTHING", new Date().toISOString());
  });
}
/** Once per binding (#849): what a group may do moves from its service role onto the binding. Each binding gets exactly the
 * items its role grants now, so it reads as the matching level and is never wider; a binding whose role is gone (only
 * possible while disabled) starts at read. The revision stays: nothing the group may do changes, so no turn is stopped. */
function migrateLevels(store: Store): void {
  if (!store.all('PRAGMA table_info(channel_service_bindings)').some(c => c.name === 'permissions'))
    store.db.exec('ALTER TABLE channel_service_bindings ADD COLUMN permissions TEXT');
  const pending = store.all('SELECT id,service_role_id FROM channel_service_bindings WHERE permissions IS NULL ORDER BY created_at,id');
  if (!pending.length) return;
  store.transaction(() => {
    for (const binding of pending) {
      const role = serviceRole(store, binding.service_role_id);
      store.run('UPDATE channel_service_bindings SET permissions=? WHERE id=? AND permissions IS NULL',
        role && role.id !== managementAssistant ? stored(JSON.parse(role.permissions)) : stored(levelPermissions('read')), binding.id);
      store.audit('system', 'channel.service_binding.level_migrated', binding.id);
    }
  });
}
/** Once: a group with enabled legacy employees gets one repository assistant binding over the same projects, each keeping its
 * original maintainer as grantor. The legacy grants stay only to authorize the tasks they already created. */
function migrateEmployees(store: Store): void {
  if (store.get("SELECT 1 FROM settings WHERE key='channel_service_bindings_migrated'")) return;
  store.transaction(() => {
    for (const { chat_id } of store.all('SELECT DISTINCT chat_id FROM channel_employee_grants WHERE enabled=1 AND chat_id NOT IN (SELECT chat_id FROM channel_service_bindings)')) {
      const grants = store.all(`SELECT g.*,p.tenant_id FROM channel_employee_grants g JOIN identity_projects p ON p.project_id=g.project_id
        WHERE g.chat_id=? AND g.enabled=1 AND p.tenant_id IS NOT NULL ORDER BY g.created_at,g.id`, chat_id);
      if (!grants.length) continue;
      const id = randomId(), principal = randomId(), time = Date.now(), modes = new Set(grants.map(g => g.participation));
      const migratedModel = (store.hasTable('service_roles') ? store.get('SELECT model_id FROM service_roles WHERE id=?', repositoryAssistant)?.model_id : null) ?? defaultSharedModel(store);
      store.run("INSERT INTO principals(id,kind,maintenance) VALUES(?,'service',?)", principal, 'channel-binding:' + chat_id);
      store.run(`INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,participation,enabled,revision,migrated_from,model_id,prompt,harness,created_at,updated_at)
        VALUES(?,?,?,'repositories',?,?,?,?,1,1,'channel_employee',?,?,?, ?,?)`, id, chat_id, groupAssistant, principal, grants[0]!.maintainer_id, grants[0]!.maintainer_id,
        modes.size === 1 ? grants[0]!.participation : 'mentions', migratedModel, defaultGroupAssistantPrompt, 'pi', time, time);
      for (const g of grants) grant(store, principal, chat_id, g.tenant_id, g.project_id, g.maintainer_id, time, levelPermissions('read'));
      store.audit(grants[0]!.maintainer_id, 'channel.service_binding.migrated', id);
    }
    store.run("INSERT INTO settings VALUES('channel_service_bindings_migrated',?) ON CONFLICT(key) DO NOTHING", new Date().toISOString());
  });
}
/** One scope grant of a binding's principal, carrying only the capabilities the binding's level uses. */
function grant(store: Store, principal: string, chat: string, tenant: string, project: string | null, grantor: string, time: number, permissions: RolePermissions): void {
  store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES(?,?,?,?,?,'service',?,'explicit_delegation',?,'channel_service_binding',?,?)`, randomId(), principal, tenant, project, project ? 'project' : 'tenant',
    JSON.stringify(serviceCapabilities(permissions)), grantor, 'channel:' + chat, time);
}
/** A binding's own permission items (#849). Read by the group's tools, its commands and the tasks it created. */
export function bindingPermissions(binding: Row): RolePermissions {
  return normalizePermissions(JSON.parse(binding.permissions ?? '{}'), true);
}
interface Reachable { id: string; full_name: string; private: boolean; enabled: boolean }

export class ChannelServiceBindings {
  constructor(readonly store: Store, readonly employees: ChannelEmployees) {}
  get(chat: string): Row | undefined { return this.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=?', chat); }
  active(chat: string): Row | undefined { return this.store.get('SELECT * FROM channel_service_bindings WHERE chat_id=? AND enabled=1', chat); }
  /** The binding's scope: one grant per repository, or one for the organization. */
  grants(binding: Row): Row[] {
    return this.store.all("SELECT * FROM scoped_grants WHERE principal_id=? AND policy='channel_service_binding' AND revoked_at IS NULL ORDER BY scope,tenant_id,project_id", binding.principal_id);
  }
  /** What the group may do: its binding's level. Every change of it is a new binding revision. */
  permissions(binding: Row): RolePermissions { return bindingPermissions(binding); }
  /** The binding is still the chat's current, enabled binding. Untouched pre-#1249 bindings also respect any disabled legacy role until resaved. */
  assertUsable(binding: Row): Row {
    const current = this.get(binding.chat_id);
    if (!current || current.id !== binding.id || current.revision !== binding.revision) return fail(409, 'conversation_source_changed');
    if (!current.enabled || !revision(this.store, current.principal_id)) return fail(403, 'channel_service_binding_disabled');
    this.employees.chat(current.chat_id);
    if (current.service_role_id !== groupAssistant) {
      const role = serviceRole(this.store, current.service_role_id);
      if (!role?.enabled) return fail(403, 'service_role_unavailable');
      if (role.id === managementAssistant) return fail(403, 'service_role_not_bindable');
    }
    return current;
  }
  /** Changes whenever what the group may see changes: chat sources, binding (its level, model, prompt or harness included),
   * or any grantor's authority. Untouched pre-#1249 bindings keep their legacy service_role_id slot so upgrading preserves
   * their exact authorization fence, chat summaries, assistant computers, own tasks and private memory without disruption. */
  fence(chat: string): string {
    const binding = this.get(chat);
    const role = binding ? (binding.service_role_id === groupAssistant ? { id: groupAssistant, enabled: 1 } : serviceRole(this.store, binding.service_role_id)) : undefined;
    return digest(JSON.stringify({ context: this.store.get('SELECT context_revision FROM channel_chats WHERE id=?', chat)?.context_revision,
      binding: binding ? [binding.id, binding.revision, binding.enabled, revision(this.store, binding.principal_id)] : null,
      role: role ? [role.id, role.enabled, fencePermissions(binding!)] : null,
      grants: binding ? this.grants(binding).map(g => [g.id, revision(this.store, g.grantor_id)]) : [] }));
  }
  /** Projects inside the binding's grants, split by whether each grantor still holds config.write and the capability there. */
  reach(binding: Row, capabilities = ['tasks.read']): { projects: Reachable[]; paused: (Reachable & { grantor_id: string })[] } {
    const grantors = new Map<string, ActorContext | null>(), projects: Reachable[] = [], paused: (Reachable & { grantor_id: string })[] = [], seen = new Set<string>();
    const grantor = (id: string) => {
      if (!grantors.has(id)) { try { grantors.set(id, resolvePrincipalActor(this.store, id, null, undefined, 'service')); } catch (error) { if (!terminal(error)) throw error; grantors.set(id, null); } }
      return grantors.get(id)!;
    };
    for (const g of this.grants(binding)) {
      const candidates = this.store.all(`SELECT r.id,r.full_name,coalesce(i.private,1) private,coalesce(p.enabled,0) enabled FROM repositories r JOIN identity_projects ip ON ip.project_id=r.id
        LEFT JOIN installed_repositories i ON i.account_id=r.account_id AND i.repository_id=r.id LEFT JOIN policies p ON p.repository_id=r.id
        WHERE ip.tenant_id=? ${g.scope === 'tenant' ? '' : 'AND r.id=?'} ORDER BY r.full_name`, g.tenant_id, ...(g.scope === 'tenant' ? [] : [g.project_id]));
      for (const p of candidates) {
        if (seen.has(p.id)) continue; seen.add(p.id);
        const actor = grantor(g.grantor_id), project = { id: p.id, full_name: p.full_name, private: p.private !== 0, enabled: !!p.enabled };
        // A paused project names the grantor whose authority no longer covers it, for the group's explanation (#846).
        if (actor && allows(actor, p.id, capabilities)) projects.push(project); else paused.push({ ...project, grantor_id: g.grantor_id });
      }
    }
    return { projects, paused };
  }
  /** Resolves a model-supplied repository (full name or project ID) inside the reachable scope; anything else is refused. */
  project(binding: Row, repository: unknown, capabilities = ['tasks.read']): Reachable | null {
    if (typeof repository !== 'string' || !repository.trim()) return null;
    const wanted = repository.trim().toLowerCase();
    return this.reach(binding, capabilities).projects.find(p => p.full_name.toLowerCase() === wanted || p.id === repository.trim()) ?? null;
  }
  /** One project's check without listing the whole scope: its covering grant, and that grantor's current authority there. */
  reachable(binding: Row, project: string, capabilities: string[]): boolean {
    const tenant = this.store.get('SELECT p.tenant_id FROM identity_projects p JOIN repositories r ON r.id=p.project_id WHERE p.project_id=?', project)?.tenant_id;
    const grants = tenant ? this.grants(binding).filter(g => g.tenant_id === tenant) : [];
    const covering = grants.find(g => g.scope === 'project' && g.project_id === project) ?? grants.find(g => g.scope === 'tenant');
    if (!covering) return false;
    let actor: ActorContext;
    try { actor = resolvePrincipalActor(this.store, covering.grantor_id, null, undefined, 'service'); } catch (error) { if (!terminal(error)) throw error; return false; }
    return allows(actor, project, capabilities);
  }
  /** The binding principal narrowed to one project and the capabilities a tool needs, rechecked on every authorization. */
  actor(binding: Row, project: string, capabilities: string[]): ActorContext {
    const check = () => {
      const current = this.assertUsable(binding);
      if (!capabilities.every(cap=>serviceCapabilities(this.permissions(current)).includes(cap))) fail(403,'channel_service_permission_revoked');
      if (!this.reachable(current, project, capabilities)) fail(403, 'channel_service_scope_paused');
    };
    check();
    this.store.run("UPDATE scoped_grants SET capabilities=? WHERE principal_id=? AND policy='channel_service_binding'",JSON.stringify(serviceCapabilities(this.permissions(binding))),binding.principal_id);
    const scoped = narrowActor(resolvePrincipalActor(this.store, binding.principal_id, null, project, 'im'), capabilities);
    restrictActor(scoped, check);
    for (const capability of capabilities) authorize(scoped, capability, { project_id: project });
    return scoped;
  }
  /** Shared by both tool interfaces and by the execution fence of persisted commands. */
  checkOperation(binding: Row, operation: string, write: boolean, taskId?: unknown, denied = 'operation_not_allowed'): void {
    const permissions = this.permissions(binding);
    if (permissions.project_tasks === 'create') {
      if (['list_tasks', 'get_task', 'task.create'].includes(operation)) return;
      if (['task.instructions', 'task.cancel'].includes(operation)) {
        if (typeof taskId === 'string' && this.store.get('SELECT 1 FROM channel_service_tasks WHERE task_id=? AND binding_id=?', taskId, binding.id)) return;
        return fail(403, 'channel_service_task_not_owned');
      }
    }
    if (!permitsManagement(permissions, operation, write)) fail(403, denied);
  }
  /** A management command submitted from a group: binding, source chat, the binding's level and grantor authority must still hold. */
  guardCommand(binding: Row, command: Row, event?: ChannelEvent): void {
    const current = this.assertUsable(binding);
    // Without a message (a timer run of the group, checked by its caller) the command's own conversation is the group.
    const chat = event ? this.store.get('SELECT * FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? AND chat_id=?', event.provider, event.app_id, event.installation_tenant, event.chat_id)
      : this.store.get('SELECT * FROM channel_chats WHERE id=?', command.source_conversation);
    if (!chat || chat.id !== current.chat_id || command.source_conversation !== chat.id) fail(403, 'channel_service_source_mismatch');
    if (event) this.employees.currentMessage(chat!, event);
    this.checkOperation(current, command.operation, true, JSON.parse(command.target).task_id, 'channel_service_permission_revoked');
    const capability = commands[command.operation]?.capability ?? 'tasks.write';
    if (!this.reachable(current, command.project_id, ['tasks.read', capability])) fail(403, 'channel_service_scope_paused');
  }
  /** Links a task a group's delegation created to that group, inside the transaction that creates it. */
  linkTask(command: Row, task: string): void {
    const binding = this.store.get('SELECT * FROM channel_service_bindings WHERE principal_id=?', command.principal_id);
    if (!binding || command.operation !== 'task.create') return;
    this.store.run('INSERT OR IGNORE INTO channel_service_tasks VALUES(?,?,?,?,?,?)', task, binding.id, binding.chat_id,
      String(command.source_message).replace(/^feishu:/, ''), command.id, Date.now());
  }
  /**
   * A delegated task keeps running only while its group may still delegate there: the binding is current and enabled, its level
   * still allows delegation, and the grantor still holds the repository. Checked whenever the task engine rechecks a task's source.
   */
  guardTask(origin: Row): void {
    const binding = this.store.get('SELECT * FROM channel_service_bindings WHERE principal_id=?', origin.principal_id ?? '');
    if (!binding) return;
    const current = this.assertUsable(binding);
    if (this.permissions(current).delegation !== 'allow') fail(403, 'channel_service_delegation_revoked');
    if (!this.reachable(current, origin.project_id, ['tasks.read', 'tasks.write'])) fail(403, 'channel_service_scope_paused');
  }
  /** Platform administrators, or organization admins of every tenant the binding's scope touches: they change a binding from
   * outside its group and transfer its ownership. */
  private governs(actor: ActorContext, binding: Row): boolean {
    if (permitted(() => authorize(actor, 'platform.manage'))) return true;
    const tenants = [...new Set(this.grants(binding).map(g => g.tenant_id as string))];
    return tenants.length > 0 && tenants.every(tenant => permitted(() => authorize(actor, 'config.write', { tenant_id: tenant })));
  }
  /** Who may change or disable a binding: its owner or someone who governs it. Admins of other repositories may not (#424). */
  private manageable(actor: ActorContext, binding: Row): boolean {
    return binding.owner_id === actor.principal_id || this.governs(actor, binding);
  }
  /** Whether the actor may manage a group's current binding (owner or governor, #424), for example to stop its running answer. */
  canManage(actor: ActorContext, chat: string): boolean {
    const binding = this.get(chat);
    return !!binding && this.manageable(actor, binding);
  }
  /** config.write over every repository or organization in the binding's current scope. */
  private covers(actor: ActorContext, binding: Row): boolean {
    const grants = this.grants(binding);
    return grants.length > 0 && grants.every(g => permitted(() => authorize(actor, 'config.write', g.scope === 'tenant' ? { tenant_id: g.tenant_id } : { project_id: g.project_id })));
  }
  /** Who may read a bound group's local history and assistant turns in the console, and post a project's notifications there:
   * its managers and anyone holding config.write over its whole scope. */
  canView(actor: ActorContext, chat: string): Row | undefined {
    const binding = this.get(chat);
    return binding && (this.manageable(actor, binding) || this.covers(actor, binding)) ? binding : undefined;
  }
  /** A new owner is an active account holding config.write over the binding's whole current scope. */
  private eligible(binding: Row, principal: string): boolean {
    if (!this.store.get("SELECT 1 FROM principals p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.kind='human' AND p.active=1 AND u.active=1", principal)) return false;
    let candidate: ActorContext;
    try { candidate = resolvePrincipalActor(this.store, principal, null, undefined, 'service'); } catch (error) { if (!terminal(error)) throw error; return false; }
    return this.covers(candidate, binding);
  }
  private owners(binding: Row): Json[] {
    return this.store.all("SELECT p.id,u.username FROM principals p JOIN users u ON u.id=p.user_id WHERE p.kind='human' AND p.active=1 AND u.active=1 AND p.id<>? ORDER BY u.username", binding.owner_id)
      .filter(p => this.eligible(binding, p.id)).map(p => ({ id: p.id, username: p.username }));
  }
  /** Organization and platform administrators hand a binding to someone who could configure its whole scope. What the group may
   * do is unchanged, so its revision (and any running turn) stays as it is. */
  transfer(actor: ActorContext, id: string, input: Json): Json {
    fields(input, ['owner_id', 'expected_revision']);
    assertCurrent(actor);
    if (!Number.isSafeInteger(input.expected_revision)) fail(400, 'expected_revision_required', 'expected_revision');
    const owner = text(input.owner_id, 64);
    const check = () => {
      const binding = this.get(id);
      if (!binding) return fail(404, 'channel_service_binding_not_found');
      if (binding.revision !== input.expected_revision) fail(409, 'channel_revision_conflict', 'expected_revision');
      if (!this.governs(actor, binding)) fail(403, 'channel_service_binding_forbidden');
      if (!this.eligible(binding, owner)) fail(403, 'channel_service_owner_ineligible', 'owner_id');
      return binding;
    };
    check();
    return this.store.transaction(() => {
      assertCurrent(actor);
      const binding = check();
      this.store.run('UPDATE channel_service_bindings SET owner_id=?,updated_at=? WHERE id=?', owner, Date.now(), binding.id);
      this.store.audit(actor.principal_id, 'channel.service_binding.transferred', binding.id);
      return this.view(this.get(id)!);
    });
  }
  /** Projects covered by a parsed scope input. */
  private scopeProjectIds(scope: { kind: string; rows: { tenant_id: string; project_id: string | null }[] }): string[] {
    return scope.rows.flatMap(row => row.project_id ? [row.project_id] : this.store.all(`SELECT r.id FROM repositories r JOIN identity_projects ip ON ip.project_id=r.id
      WHERE ip.tenant_id=? ORDER BY r.full_name`, row.tenant_id).map(r => String(r.id)));
  }
  /**
   * The binding's model must serve every project the scope covers (#849, #1249): a project's own model serves only a
   * single-repository scope of that project; a shared model serves every project it is authorized to.
   */
  private modelScope(modelId: string | null, scope: { kind: string; rows: { tenant_id: string; project_id: string | null }[] }): void {
    if (!modelId) return;
    const model = this.store.get('SELECT * FROM models WHERE id=?', modelId);
    if (!model) return fail(404, 'model_not_found', 'model_id');
    if (scope.kind === 'organization' && model.repository_id !== null) fail(400, 'shared_model_required', 'model_id');
    const projects = this.scopeProjectIds(scope);
    if (scope.kind === 'organization' && model.restricted && !projects.length) fail(409, 'channel_service_model_unavailable', 'model_id', { projects: [] });
    const gaps = modelGaps(this.store, modelId, projects);
    if (gaps.length) fail(409, 'channel_service_model_unavailable', 'model_id', { projects: gaps.map(p => p.full_name) });
  }
  private scopeInput(actor: ActorContext, value: unknown, chat: Row): { kind: string; rows: { tenant_id: string; project_id: string | null }[] } {
    const scope = object(value);
    // A group reached through an organization's app stays inside that organization: the app's owner reads every message (#424).
    const application = String(this.store.get('SELECT owner_tenant FROM channel_connectors WHERE id=?', chat.connector_id)?.owner_tenant ?? '');
    const inside = (tenant: string) => { if (application && tenant !== application) fail(403, 'channel_service_scope_outside_organization', 'scope'); };
    if (scope.kind === 'organization') {
      fields(scope, ['kind', 'organization']);
      const tenant = this.store.get('SELECT * FROM tenants WHERE id=?', text(scope.organization, 200));
      if (!tenant) return fail(404, 'organization_not_found', 'scope.organization');
      inside(tenant.id);
      authorize(actor, 'config.write', { tenant_id: tenant.id });
      return { kind: 'organization', rows: [{ tenant_id: tenant.id, project_id: null }] };
    }
    if (scope.kind !== 'repositories') return fail(400, 'channel_service_scope_invalid', 'scope.kind');
    fields(scope, ['kind', 'repositories']);
    const ids = scope.repositories;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) return fail(400, 'channel_service_scope_invalid', 'scope.repositories');
    return { kind: 'repositories', rows: (ids as string[]).map(id => {
      const project = this.store.get('SELECT p.tenant_id FROM identity_projects p JOIN repositories r ON r.id=p.project_id WHERE p.project_id=? AND p.tenant_id IS NOT NULL', id);
      if (!project) return fail(404, 'repository_not_found', 'scope.repositories');
      inside(project.tenant_id);
      authorize(actor, 'config.write', { project_id: id });
      return { tenant_id: project.tenant_id as string, project_id: id };
    }) };
  }
  /**
   * The binding's next items: a level, individual items over the current ones (advanced), or, when neither is given, what
   * it has now (a new binding starts at read). Retired transitional values are kept only while they are unchanged.
   */
  private levelInput(input: Json, previous?: Row): RolePermissions {
    if (input.level !== undefined && input.permissions !== undefined) return fail(400, 'channel_service_level_conflict', 'permissions');
    if (input.level !== undefined) {
      if (!(bindingLevels as readonly unknown[]).includes(input.level)) return fail(400, 'channel_service_level_invalid', 'level');
      return levelPermissions(input.level as typeof bindingLevels[number]);
    }
    const base = previous ? this.permissions(previous) : levelPermissions('read');
    if (input.permissions === undefined) return base;
    const given = object(input.permissions);
    for (const [key, mode] of Object.entries(given)) {
      if (key === 'project_tasks' && groupTaskModes.some(value => value === mode)) continue;
      if (!key.startsWith('legacy_') && !permissionItems.some(item => item.id === key) && !(retiredPermissionItems as readonly string[]).includes(key) || !validPermissionInput(key, mode, base)) fail(400, 'channel_service_permission_invalid', 'permissions.' + key);
    }
    const next = updatePermissions(base, given as RolePermissions, true);
    // Selecting a tier sets its creation grant too. Old clients that only change delegation retain their exact subset.
    const echo = previous && given.project_tasks === base.project_tasks && given.delegation === base.delegation;
    if (!echo && groupTaskModes.some(value => value === given.project_tasks))
      next.delegation = given.project_tasks === 'create' || given.project_tasks === 'write' ? 'allow' : 'deny';
    if (next.project_tasks === 'create' && next.delegation !== 'allow') next.project_tasks = 'read';
    return next;
  }
  /**
   * Bind (or rebind) a group. The editor holds config.write over the whole new scope. The first configurer becomes the owner
   * and must be bound to Feishu through the group's app and currently in the group; the owner's later edits need the same.
   * Changing an existing binding needs its owner or someone who governs it, who may do so from outside the group.
   */
  async configure(actor: ActorContext, id: string, input: Json): Promise<Json> {
    fields(input, ['scope', 'participation', 'level', 'permissions', 'model_id', 'prompt', 'harness', 'enabled', 'expected_revision']);
    assertCurrent(actor);
    if (!Number.isSafeInteger(input.expected_revision)) fail(400, 'expected_revision_required', 'expected_revision');
    if (typeof input.enabled !== 'boolean') fail(400, 'invalid_field', 'enabled');
    const previous = this.get(id);
    if ((previous?.revision ?? 0) !== input.expected_revision) fail(409, 'channel_revision_conflict', 'expected_revision');
    if (previous && !this.manageable(actor, previous)) fail(403, 'channel_service_binding_forbidden');
    if (!input.enabled) return this.disable(actor, previous, input.expected_revision as number);
    const chat = this.employees.chat(id);
    if (chat.chat_type !== 'group') fail(400, 'channel_service_binding_group_required');
    const participation = input.participation ?? previous?.participation ?? 'mentions';
    if (!participations.includes(String(participation))) fail(400, 'channel_participation_invalid', 'participation');
    // Accommodate migrated legacy responsibility (<=2000) + "\n\n" + prompt (<=32000) = 34002 chars without making bindings unsavable.
    const prompt = input.prompt !== undefined ? optionalText(input.prompt, 35000, 'prompt') : String(previous?.prompt ?? '');
    // As for a service role, a backend the request names must be one the console offers; an omitted one keeps the saved one.
    const harness = input.harness !== undefined ? String(input.harness) : String(previous?.harness ?? 'pi');
    if (input.harness !== undefined && !serviceHarnesses.includes(harness)) fail(400, 'unknown_role_harness', 'harness');
    const permissions = this.levelInput(input, previous);
    const previewScope = this.scopeInput(actor, input.scope, chat);
    const resolveModel = (scope: { kind: string; rows: { tenant_id: string; project_id: string | null }[] }): string | null => {
      if (input.model_id !== undefined) return input.model_id === null ? null : text(input.model_id, 128);
      if (previous) return previous.model_id ?? null;
      const fallback = defaultSharedModel(this.store);
      if (!fallback) return null;
      const projects = this.scopeProjectIds(scope);
      if (scope.kind === 'organization' && !projects.length && this.store.get('SELECT restricted FROM models WHERE id=?', fallback)?.restricted) return null;
      return !modelGaps(this.store, fallback, projects).length ? fallback : null;
    };
    const modelId = resolveModel(previewScope);
    this.modelScope(modelId, previewScope);
    const identity = !previous || !this.governs(actor, previous) ? this.employees.feishuIdentity(chat, actor.principal_id) : undefined;
    // The audience lookup is a network call; the decision below reads the snapshot it stored, inside the transaction.
    if (identity) await this.employees.verify(id, true);
    return this.store.transaction(() => {
      assertCurrent(actor);
      const current = this.employees.chat(id), scope = this.scopeInput(actor, input.scope, current);
      const nextModel = resolveModel(scope);
      this.modelScope(nextModel, scope);
      if (identity) this.employees.assertMember(current, identity.external_actor, identity.external_tenant);
      const locked = this.get(id);
      if ((locked?.revision ?? 0) !== input.expected_revision) fail(409, 'channel_revision_conflict', 'expected_revision');
      if (locked && !this.manageable(actor, locked)) fail(403, 'channel_service_binding_forbidden');
      const time = Date.now(), principal = locked?.principal_id ?? randomId(), binding = locked?.id ?? randomId(), next = (locked?.revision ?? 0) + 1;
      const before = locked ? activeScopes(this.store, principal) : [];
      if (locked) this.store.run('UPDATE principals SET active=1,maintenance=? WHERE id=?', 'channel-binding:' + id, principal);
      else this.store.run("INSERT INTO principals(id,kind,maintenance) VALUES(?,'service',?)", principal, 'channel-binding:' + id);
      this.store.run('DELETE FROM scoped_grants WHERE principal_id=?', principal);
      // The revision check above makes `previous` the binding as it is now, so an advanced edit never builds on a stale copy.
      const items = permissions;
      for (const row of scope.rows) grant(this.store, principal, id, row.tenant_id, row.project_id, actor.principal_id, time, items);
      if (locked) {
        this.store.run(`UPDATE channel_service_bindings SET service_role_id=?,scope=?,configured_by=?,participation=?,permissions=?,model_id=?,prompt=?,harness=?,enabled=1,revision=?,updated_at=? WHERE id=?`,
          groupAssistant, scope.kind, actor.principal_id, participation, stored(items), nextModel, prompt, harness, next, time, binding);
        // Preserve a pre-#1249 binding's persistent assistant HOME when migrating its role slot to group-assistant;
        // AssistantHomes.prepare() still seals the HOME if repositories were narrowed.
        if (locked.service_role_id !== groupAssistant && this.store.hasTable('assistant_homes')) {
          this.store.run('UPDATE assistant_homes SET service_role_id=? WHERE binding_id=? AND service_role_id=?', groupAssistant, binding, locked.service_role_id);
        }
      } else this.store.run(`INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,participation,permissions,model_id,prompt,harness,enabled,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`, binding, id, groupAssistant, scope.kind, principal, actor.principal_id, actor.principal_id, participation, stored(items), nextModel, prompt, harness, next, time, time);
      invalidateIfLost(this.store, principal, before, 'channel_service_binding_configured');
      // Summaries and replies derived under the previous scope must not return into the new one.
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', id);
      this.store.audit(actor.principal_id, 'channel.service_binding.configured', binding);
      return this.view(this.get(id)!);
    });
  }
  private disable(actor: ActorContext, binding: Row | undefined, expected: number): Json {
    if (!binding) return fail(404, 'channel_service_binding_not_found');
    if (!this.manageable(actor, binding)) fail(403, 'channel_service_binding_forbidden');
    return this.store.transaction(() => {
      assertCurrent(actor);
      if (!this.store.run('UPDATE channel_service_bindings SET enabled=0,revision=revision+1,updated_at=? WHERE id=? AND revision=?', Date.now(), binding.id, expected).changes) fail(409, 'channel_revision_conflict', 'expected_revision');
      this.store.run('UPDATE principals SET active=0 WHERE id=?', binding.principal_id);
      invalidate(this.store, binding.principal_id, 'channel_service_binding_disabled');
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', binding.chat_id);
      this.store.audit(actor.principal_id, 'channel.service_binding.disabled', binding.id);
      return this.view(this.get(binding.chat_id)!);
    });
  }
  private usage(chatId: string): Json {
    const total = this.store.get(`SELECT count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(cached_input_tokens) cached_input_tokens,
      sum(CASE WHEN finished_at IS NULL OR input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) usage_missing_requests,
      sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced_requests,max(requested_at) last_requested_at FROM model_requests WHERE conversation_id=? AND service_role_id IS NOT NULL`, chatId)!;
    const costs = this.store.all('SELECT currency,sum(cost) amount FROM model_requests WHERE conversation_id=? AND service_role_id IS NOT NULL AND cost IS NOT NULL GROUP BY currency ORDER BY currency', chatId);
    return { requests: total.requests, input_tokens: total.input_tokens, output_tokens: total.output_tokens, cached_input_tokens: total.cached_input_tokens,
      usage_missing_requests: total.usage_missing_requests ?? 0, unpriced_requests: total.unpriced_requests ?? 0, last_requested_at: total.last_requested_at, costs };
  }
  view(binding: Row): Json {
    const grants = this.grants(binding);
    let state = binding.enabled ? 'active' : 'disabled', error: string | null = null;
    if (binding.enabled) try { this.assertUsable(binding); } catch (e) { if (!terminal(e)) throw e; state = 'paused'; error = (e as HttpError).code; }
    const permissions = this.permissions(binding);
    const reach = binding.enabled ? this.reach(binding) : { projects: [], paused: [] };
    if (state === 'active' && !reach.projects.length) { state = 'paused'; error = 'channel_service_scope_paused'; }
    const modelRow = binding.model_id ? this.store.get('SELECT id,model_name,api_url,api_key,repository_id FROM models WHERE id=?', binding.model_id) : undefined;
    // A model no longer authorized to a project in scope stops the group's answers until someone changes the model or scope.
    const gaps = binding.enabled && binding.model_id ? modelGaps(this.store, binding.model_id, scopeProjects(this.store, binding.principal_id)).map(p => p.full_name) : [];
    if (state === 'active' && gaps.length) { state = 'paused'; error = 'channel_service_model_unavailable'; }
    const organization = grants.find(g => g.scope === 'tenant'), chat = this.store.get('SELECT h.chat_id,c.app_name,c.owner_tenant FROM channel_chats h LEFT JOIN channel_connectors c ON c.id=h.connector_id WHERE h.id=?', binding.chat_id);
    const username = (principal: string) => this.store.get('SELECT username FROM users WHERE id=?', principal)?.username ?? null;
    return { id: binding.id, chat_id: binding.chat_id, chat: { id: binding.chat_id, chat_id: chat?.chat_id ?? null, organization: chat?.owner_tenant || null, ...chatProfile(this.store, binding.chat_id) },
      model_id: binding.model_id ?? null,
      model: modelRow ? { id: modelRow.id, model_name: modelRow.model_name, api_url: modelRow.api_url, key_configured: !!modelRow.api_key, project_id: modelRow.repository_id ?? null } : null,
      prompt: String(binding.prompt ?? ''),
      harness: String(binding.harness ?? 'pi'),
      usage: this.usage(binding.chat_id),
      model_gaps: gaps,
      scope: { kind: binding.scope, organization: organization ? { id: organization.tenant_id, name: tenantName(this.store, organization.tenant_id) } : null,
        repositories: grants.filter(g => g.scope === 'project').map(g => ({ id: g.project_id, full_name: this.store.get('SELECT full_name FROM repositories WHERE id=?', g.project_id)?.full_name ?? g.project_id })) },
      level: bindingLevel(permissions), github_level: bindingGithubLevel(permissions), task_mode: bindingTaskMode(permissions), permissions,
      participation: binding.participation, enabled: !!binding.enabled, revision: binding.revision, migrated: binding.migrated_from === 'channel_employee',
      owner: username(binding.owner_id), configured_by: username(binding.configured_by),
      state, error, reachable: reach.projects.map(p => p.full_name), reachable_projects: reach.projects.map(p => ({ id: p.id, full_name: p.full_name })), paused: reach.paused.map(p => p.full_name), created_at: binding.created_at, updated_at: binding.updated_at };
  }
  list(actor: ActorContext): Json {
    assertCurrent(actor);
    const chats = this.employees.selectableChats(actor);
    let platform = false; try { authorize(actor, 'platform.manage'); platform = true; } catch (error) { if (!terminal(error)) throw error; }
    const bindings = this.store.all('SELECT * FROM channel_service_bindings ORDER BY created_at,id').filter(b => platform || chats.some(c => c.id === b.chat_id) ||
      b.owner_id === actor.principal_id || b.configured_by === actor.principal_id || this.grants(b).some(g => g.grantor_id === actor.principal_id) || this.governs(actor, b));
    const projects = listEffectiveProjectAccess(this.store, actor.principal_id).filter(p => p.can_configure), configurable = new Set(projects.map(p => String(p.id)));
    const organizations = this.store.all('SELECT * FROM tenants ORDER BY display_name').filter(t => {
      try { authorize(actor, 'config.write', { tenant_id: t.id }); return true; } catch (error) { if (!terminal(error)) throw error; return false; }
    }).map(t => ({ id: t.id, name: tenantName(this.store, t.id) }));
    // Models visible to this caller for group binding configuration (#1249): project-owned models of their configurable
    // repositories, plus shared models serving at least one of those repositories (or any shared model for platform/org admins).
    const models = this.store.all('SELECT * FROM models ORDER BY repository_id IS NOT NULL,updated_at,id')
      .filter(m => {
        if (m.repository_id !== null) return configurable.has(m.repository_id);
        if (platform || (organizations.length > 0 && !m.restricted)) return true;
        return projects.some(p => modelServes(this.store, m, String(p.id)));
      })
      .map(m => {
        const authorized = m.repository_id !== null ? [String(m.repository_id)]
          : m.restricted ? this.store.all('SELECT repository_id FROM model_projects WHERE model_id=?', m.id).map(r => String(r.repository_id)).filter(id => configurable.has(id))
            : null;
        return { id: m.id, model_name: m.model_name, api_url: m.api_url, key_configured: m.api_key !== null,
          project_id: m.repository_id ?? null, all_projects: m.repository_id === null && !m.restricted, authorized_projects: authorized };
      });
    const fallbackModel = defaultSharedModel(this.store);
    const defaultModelId = fallbackModel && models.some(m => m.id === fallbackModel) ? fallbackModel : null;
    return { bindings: bindings.map(b => { const governs = this.governs(actor, b);
      return { ...this.view(b), can_manage: governs || b.owner_id === actor.principal_id, can_view: platform || !!this.canView(actor, b.chat_id),
        can_transfer: governs, ...(governs ? { owner_candidates: this.owners(b) } : {}) }; }), chats,
      models, default_model_id: defaultModelId, default_prompt: defaultGroupAssistantPrompt, harnesses: [...serviceHarnesses],
      levels: bindingLevels.map(level => ({ id: level, permissions: levelPermissions(level) })),
      github_levels: bindingGithubLevels.map(level => ({ id: level, permissions: githubLevelPermissions(level) })),
      default_permissions: levelPermissions('read'),
      organizations,
      projects: projects
        .map(p => ({ id: p.id, full_name: p.full_name, organization: this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', p.id)?.tenant_id ?? null })),
      permission_items: groupPermissionItems.map(item => ({ id: item.id, name: item.name, modes: item.modes, group: item.group, detail: item.detail })), legacy_employees: this.employees.legacy(actor) };
  }
}
/** Only an authorization refusal means "no"; a changed authorization or a server fault still propagates. */
function permitted(check: () => void): boolean {
  try { check(); return true; } catch (error) { if (!terminal(error)) throw error; return false; }
}
function allows(actor: ActorContext, project: string, capabilities: string[]): boolean {
  try { for (const capability of ['config.write', ...capabilities]) authorize(actor, capability, { project_id: project }); return true; }
  catch (error) { if (!terminal(error)) throw error; return false; }
}
