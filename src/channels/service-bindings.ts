import type { Store, Row } from '../storage/database.js';
import { assertCurrent, authorize, invalidate, listEffectiveProjectAccess, narrowActor, resolvePrincipalActor, restrictActor, revision, type ActorContext } from '../identity/authorization.js';
import { digest, fail, fields, HttpError, object, randomId, text, type Json } from '../core/security.js';
import { managementAssistant, repositoryAssistant, serviceItems, serviceRole } from '../service-roles/roles.js';
import { normalizePermissions, permitsManagement, serviceCapabilities, type RolePermissions } from '../roles/permissions.js';
import { commands } from '../management/catalog.js';
import type { ChannelEmployees } from './employees.js';
import type { ChannelEvent } from './types.js';
import { tenantName } from './applications.js';
import { chatProfile } from './profiles.js';

// A group binds one service role and one project scope (a whole organization or chosen repositories). The scope is held as
// scoped_grants of a principal owned by the binding; each grant names the maintainer who granted it. At run time a group
// can use a project only while the binding, the role and that grantor's own current authority all still allow it.
// Speakers are not checked: the console configuration alone decides what the group may do.
// The first configurer owns the binding (owner_id); configured_by is whoever changed it last. Only the owner, organization
// admins of every tenant in its scope and platform administrators change or disable it (#424).

/** Bot replies of a binding are scoped to it in the local ledger, so another binding or project never reads them back. */
export const bindingScope = (id: string) => 'binding:' + id;
const participations = ['mentions', 'questions', 'all'];
const terminal = (error: unknown) => error instanceof HttpError && error.status < 500;
/**
 * Which management commands a group may submit. Delegation hands work to a project only through its Manager: creating a task,
 * changing its contract, adding an instruction or cancelling it, never choosing or steering a role. project_tasks write keeps
 * its own controls over other roles' tasks (pause, retry, cancel, instructions).
 */
export function serviceCommandAllowed(permissions: RolePermissions, operation: string): boolean {
  return permitsManagement(permissions,operation,true);
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
  // Bindings from before #424 are owned by their configurer.
  if (!store.all('PRAGMA table_info(channel_service_bindings)').some(c => c.name === 'owner_id'))
    store.db.exec("ALTER TABLE channel_service_bindings ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
  store.run("UPDATE channel_service_bindings SET owner_id=configured_by WHERE owner_id=''");
  migrateEmployees(store);
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
      store.run("INSERT INTO principals(id,kind,maintenance) VALUES(?,'service',?)", principal, 'channel-binding:' + chat_id);
      store.run(`INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,participation,enabled,revision,migrated_from,created_at,updated_at)
        VALUES(?,?,?,'repositories',?,?,?,?,1,1,'channel_employee',?,?)`, id, chat_id, repositoryAssistant, principal, grants[0]!.maintainer_id, grants[0]!.maintainer_id,
        modes.size === 1 ? grants[0]!.participation : 'mentions', time, time);
      for (const g of grants) grant(store, principal, chat_id, g.tenant_id, g.project_id, g.maintainer_id, time);
      store.audit(grants[0]!.maintainer_id, 'channel.service_binding.migrated', id);
    }
    store.run("INSERT INTO settings VALUES('channel_service_bindings_migrated',?) ON CONFLICT(key) DO NOTHING", new Date().toISOString());
  });
}
function grant(store: Store, principal: string, chat: string, tenant: string, project: string | null, grantor: string, time: number, permissions?: RolePermissions): void {
  store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES(?,?,?,?,?,'service',?,'explicit_delegation',?,'channel_service_binding',?,?)`, randomId(), principal, tenant, project, project ? 'project' : 'tenant',
    JSON.stringify(serviceCapabilities(permissions??JSON.parse(store.get('SELECT r.permissions FROM channel_service_bindings b JOIN service_roles r ON r.id=b.service_role_id WHERE b.principal_id=?',principal)?.permissions??'{}'))), grantor, 'channel:' + chat, time);
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
  permissions(binding: Row): RolePermissions {
    const role = serviceRole(this.store, binding.service_role_id);
    return normalizePermissions(JSON.parse(role?.permissions??'{}'));
  }
  /** The binding is still the chat's current, enabled binding and its role can serve a group. */
  assertUsable(binding: Row): Row {
    const current = this.get(binding.chat_id);
    if (!current || current.id !== binding.id || current.revision !== binding.revision) return fail(409, 'conversation_source_changed');
    if (!current.enabled || !revision(this.store, current.principal_id)) return fail(403, 'channel_service_binding_disabled');
    this.employees.chat(current.chat_id);
    const role = serviceRole(this.store, current.service_role_id);
    if (!role?.enabled) return fail(403, 'service_role_unavailable');
    if (!role.permissions) return fail(403, 'service_role_not_bindable');
    return current;
  }
  /** Changes whenever what the group may see changes: chat sources, binding, role permissions or any grantor's authority. */
  fence(chat: string): string {
    const binding = this.get(chat), role = binding && serviceRole(this.store, binding.service_role_id);
    return digest(JSON.stringify({ context: this.store.get('SELECT context_revision FROM channel_chats WHERE id=?', chat)?.context_revision,
      binding: binding ? [binding.id, binding.revision, binding.enabled, revision(this.store, binding.principal_id)] : null,
      role: role ? [role.id, role.enabled, role.permissions] : null,
      grants: binding ? this.grants(binding).map(g => [g.id, revision(this.store, g.grantor_id)]) : [] }));
  }
  /** Projects inside the binding's grants, split by whether each grantor still holds config.write and the capability there. */
  reach(binding: Row, capabilities = ['tasks.read']): { projects: Reachable[]; paused: Reachable[] } {
    const grantors = new Map<string, ActorContext | null>(), projects: Reachable[] = [], paused: Reachable[] = [], seen = new Set<string>();
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
        (actor && allows(actor, p.id, capabilities) ? projects : paused).push(project);
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
  /** A management command submitted from a group: binding, source chat, role permission and grantor authority must still hold. */
  guardCommand(binding: Row, command: Row, event?: ChannelEvent): void {
    const current = this.assertUsable(binding);
    // Without a message (a timer run of the group, checked by its caller) the command's own conversation is the group.
    const chat = event ? this.store.get('SELECT * FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? AND chat_id=?', event.provider, event.app_id, event.installation_tenant, event.chat_id)
      : this.store.get('SELECT * FROM channel_chats WHERE id=?', command.source_conversation);
    if (!chat || chat.id !== current.chat_id || command.source_conversation !== chat.id) fail(403, 'channel_service_source_mismatch');
    if (event) this.employees.currentMessage(chat!, event);
    if (!serviceCommandAllowed(this.permissions(current), command.operation)) fail(403, 'channel_service_permission_revoked');
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
   * A delegated task keeps running only while its group may still delegate there: the binding is current and enabled, its role
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
   * Bind (or rebind) a group. The editor holds config.write over the whole new scope. The first configurer becomes the owner
   * and must be bound to Feishu through the group's app and currently in the group; the owner's later edits need the same.
   * Changing an existing binding needs its owner or someone who governs it, who may do so from outside the group.
   */
  async configure(actor: ActorContext, id: string, input: Json): Promise<Json> {
    fields(input, ['service_role_id', 'scope', 'participation', 'enabled', 'expected_revision']);
    assertCurrent(actor);
    if (!Number.isSafeInteger(input.expected_revision)) fail(400, 'expected_revision_required', 'expected_revision');
    if (typeof input.enabled !== 'boolean') fail(400, 'invalid_field', 'enabled');
    const previous = this.get(id);
    if ((previous?.revision ?? 0) !== input.expected_revision) fail(409, 'channel_revision_conflict', 'expected_revision');
    if (previous && !this.manageable(actor, previous)) fail(403, 'channel_service_binding_forbidden');
    if (!input.enabled) return this.disable(actor, previous, input.expected_revision as number);
    const chat = this.employees.chat(id);
    if (chat.chat_type !== 'group') fail(400, 'channel_service_binding_group_required');
    const role = serviceRole(this.store, text(input.service_role_id, 64));
    if (!role) return fail(404, 'service_role_not_found', 'service_role_id');
    if (!role.enabled) fail(409, 'service_role_unavailable', 'service_role_id');
    if (!role.permissions || role.id === managementAssistant) fail(400, 'service_role_not_bindable', 'service_role_id');
    const participation = input.participation ?? previous?.participation ?? 'mentions';
    if (!participations.includes(String(participation))) fail(400, 'channel_participation_invalid', 'participation');
    this.scopeInput(actor, input.scope, chat);
    const identity = !previous || !this.governs(actor, previous) ? this.employees.feishuIdentity(chat, actor.principal_id) : undefined;
    // The audience lookup is a network call; the decision below reads the snapshot it stored, inside the transaction.
    if (identity) await this.employees.verify(id, true);
    return this.store.transaction(() => {
      assertCurrent(actor);
      const current = this.employees.chat(id), scope = this.scopeInput(actor, input.scope, current);
      if (identity) this.employees.assertMember(current, identity.external_actor, identity.external_tenant);
      const locked = this.get(id);
      if ((locked?.revision ?? 0) !== input.expected_revision) fail(409, 'channel_revision_conflict', 'expected_revision');
      if (locked && !this.manageable(actor, locked)) fail(403, 'channel_service_binding_forbidden');
      const time = Date.now(), principal = locked?.principal_id ?? randomId(), binding = locked?.id ?? randomId(), next = (locked?.revision ?? 0) + 1;
      if (locked) this.store.run('UPDATE principals SET active=1,maintenance=? WHERE id=?', 'channel-binding:' + id, principal);
      else this.store.run("INSERT INTO principals(id,kind,maintenance) VALUES(?,'service',?)", principal, 'channel-binding:' + id);
      this.store.run('DELETE FROM scoped_grants WHERE principal_id=?', principal);
      for (const row of scope.rows) grant(this.store, principal, id, row.tenant_id, row.project_id, actor.principal_id, time, JSON.parse(role.permissions));
      if (locked) this.store.run('UPDATE channel_service_bindings SET service_role_id=?,scope=?,configured_by=?,participation=?,enabled=1,revision=?,updated_at=? WHERE id=?',
        role.id, scope.kind, actor.principal_id, participation, next, time, binding);
      else this.store.run(`INSERT INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,participation,enabled,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,?,?,?)`, binding, id, role.id, scope.kind, principal, actor.principal_id, actor.principal_id, participation, next, time, time);
      invalidate(this.store, principal, 'channel_service_binding_configured');
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
  view(binding: Row): Json {
    const role = serviceRole(this.store, binding.service_role_id), grants = this.grants(binding);
    let state = binding.enabled ? 'active' : 'disabled', error: string | null = null;
    if (binding.enabled) try { this.assertUsable(binding); } catch (e) { if (!terminal(e)) throw e; state = 'paused'; error = (e as HttpError).code; }
    const reach = binding.enabled ? this.reach(binding) : { projects: [], paused: [] };
    if (state === 'active' && !reach.projects.length) { state = 'paused'; error = 'channel_service_scope_paused'; }
    const organization = grants.find(g => g.scope === 'tenant'), chat = this.store.get('SELECT h.chat_id,c.app_name,c.owner_tenant FROM channel_chats h LEFT JOIN channel_connectors c ON c.id=h.connector_id WHERE h.id=?', binding.chat_id);
    const username = (principal: string) => this.store.get('SELECT username FROM users WHERE id=?', principal)?.username ?? null;
    return { id: binding.id, chat_id: binding.chat_id, chat: { id: binding.chat_id, chat_id: chat?.chat_id ?? null, organization: chat?.owner_tenant || null, ...chatProfile(this.store, binding.chat_id) },
      service_role: role ? { id: role.id, name: role.name, enabled: !!role.enabled } : { id: binding.service_role_id, name: null, enabled: false },
      scope: { kind: binding.scope, organization: organization ? { id: organization.tenant_id, name: tenantName(this.store, organization.tenant_id) } : null,
        repositories: grants.filter(g => g.scope === 'project').map(g => ({ id: g.project_id, full_name: this.store.get('SELECT full_name FROM repositories WHERE id=?', g.project_id)?.full_name ?? g.project_id })) },
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
    const items = serviceItems;
    return { bindings: bindings.map(b => { const governs = this.governs(actor, b);
      return { ...this.view(b), can_manage: governs || b.owner_id === actor.principal_id, can_transfer: governs, ...(governs ? { owner_candidates: this.owners(b) } : {}) }; }), chats,
      service_roles: this.store.all('SELECT * FROM service_roles WHERE enabled=1 AND id<>? ORDER BY builtin DESC,created_at,id',managementAssistant)
        .map(r => ({ id: r.id, name: r.name, responsibility: r.responsibility, permissions: JSON.parse(serviceRole(this.store,r.id)!.permissions), builtin: !!r.builtin, recommended: r.id === repositoryAssistant })),
      organizations: this.store.all('SELECT * FROM tenants ORDER BY display_name').filter(t => {
        try { authorize(actor, 'config.write', { tenant_id: t.id }); return true; } catch (error) { if (!terminal(error)) throw error; return false; }
      }).map(t => ({ id: t.id, name: tenantName(this.store, t.id) })),
      projects: listEffectiveProjectAccess(this.store, actor.principal_id).filter(p => p.can_configure)
        .map(p => ({ id: p.id, full_name: p.full_name, organization: this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', p.id)?.tenant_id ?? null })),
      permission_items: items.map(item => ({ id: item.id, name: item.name, modes: item.modes })), legacy_employees: this.employees.legacy(actor) };
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
