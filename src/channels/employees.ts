import type { Store, Row } from '../storage/database.js';
import { assertCurrent, authorize, invalidate, listEffectiveProjectAccess, narrowActor, resolvePrincipalActor, restrictActor, type ActorContext } from '../identity/authorization.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';
import { roleConfiguration } from '../roles/definition.js';
import { roleTaskCaller, taskSourceGuard, type TaskCaller } from '../tasks/management.js';
import type { FeishuAdapter } from './feishu.js';
import type { ChannelEvent } from './types.js';

const capabilities = ['tasks.read', 'tasks.manage_own', 'knowledge.read', 'knowledge.write'];
const audienceTtl = 5 * 60_000;
/** Durable authorization only. Business tasks still use TaskCommands and the existing scheduler. */
export class ChannelEmployees {
  private readonly pending = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(readonly store: Store, readonly adapter: (connector: Row, guard: () => void) => FeishuAdapter) {
    taskSourceGuard(store, origin => this.guardOrigin(origin));
  }
  close(): void { this.stopped = true; }
  chat(id: string): Row {
    const chat = this.store.get('SELECT * FROM channel_chats WHERE id=?', id);
    if (!chat) return fail(404, 'channel_chat_not_found');
    const c = this.store.get('SELECT * FROM channel_connectors WHERE id=?', chat.connector_id);
    if (this.stopped || chat.state !== 'active' || !c?.enabled || c.provider !== chat.provider || c.app_id !== chat.app_id || c.installation_tenant !== chat.installation_tenant) fail(403, 'channel_employee_source_inactive');
    return { ...chat, connector: c };
  }
  private binding(chat: Row, principal: string, binding?: string): Row {
    const row = this.store.all("SELECT * FROM external_identities WHERE principal_id=? AND provider='feishu' AND host='open.feishu.cn' AND status='active'", principal)
      .find(r => (!binding || r.id === binding) && String(r.connector).endsWith(':' + chat.app_id) && (!r.expires_at || r.expires_at > Date.now()));
    if (!row) return fail(403, 'external_binding_required'); return row;
  }
  private maintainer(grant: Row, chat: Row): Row {
    const actor = resolvePrincipalActor(this.store, grant.maintainer_id, null, grant.project_id, 'service');
    authorize(actor, 'config.write', { project_id: grant.project_id });
    for (const cap of JSON.parse(grant.capabilities)) authorize(actor, cap, { project_id: grant.project_id });
    if (!this.store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1', grant.project_id)) fail(403, 'channel_employee_project_inactive');
    const role = roleConfiguration(this.store, grant.project_id).roles.find(r => r.role_id === grant.role_id && r.enabled);
    if (!role || role.kind === 'evaluator' || role.role_id === 'coordinator') fail(403, 'channel_employee_role_unavailable');
    return this.binding(chat, grant.maintainer_id, grant.binding_id);
  }
  /** Called in the verified ingress transaction before ACK, so old tokens cannot race audience changes. */
  invalidate(chat: string, reason: string): void {
    this.store.run(`INSERT INTO channel_audiences(chat_id,last_error) VALUES(?,?) ON CONFLICT(chat_id)
      DO UPDATE SET revision=revision+1,verified_until=0,last_error=excluded.last_error`, chat, reason);
    this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', chat);
  }
  private audience(chat: Row): { id: string; tenant: string }[] {
    const row = this.store.get('SELECT * FROM channel_audiences WHERE chat_id=?', chat.id);
    if (!row?.members || row.verified_until <= Date.now()) return fail(403, 'channel_employee_revalidation_required');
    return this.store.secrets.open(row.members, 'channel-audience:' + chat.id).members as { id: string; tenant: string }[];
  }
  private member(chat: Row, id: string, tenant: string): void {
    if (!this.audience(chat).some(m => m.id === id && m.tenant === tenant)) fail(403, 'channel_employee_member_required');
  }
  async verify(id: string, force = false): Promise<void> {
    const existing = this.pending.get(id); if (existing) return existing;
    const chat = this.chat(id);
    if (chat.chat_type !== 'group') fail(400, 'channel_employee_group_required');
    this.store.run('INSERT OR IGNORE INTO channel_audiences(chat_id) VALUES(?)', id);
    const row = this.store.get('SELECT * FROM channel_audiences WHERE chat_id=?', id)!;
    if (!force && row.verified_until > Date.now()) return;
    const guard = () => {
      const current = this.chat(id);
      if (current.connector.id !== chat.connector.id || current.connector.revision !== chat.connector.revision ||
        this.store.get('SELECT revision FROM channel_audiences WHERE chat_id=?', id)?.revision !== row.revision) fail(409, 'channel_employee_audience_changed');
    };
    const work = (async () => {
      try {
        const members = await this.adapter(chat.connector, guard).audience(chat.chat_id); guard();
        this.store.run('UPDATE channel_audiences SET members=?,verified_until=?,checked_at=?,last_error=NULL WHERE chat_id=? AND revision=?',
          this.store.secrets.seal({ members }, 'channel-audience:' + id), Date.now() + audienceTtl, Date.now(), id, row.revision);
      } catch (error) {
        this.store.run('UPDATE channel_audiences SET verified_until=0,last_error=?,checked_at=? WHERE chat_id=? AND revision=?',
          (error as any).code ?? 'channel_audience_unavailable', Date.now(), id, row.revision); throw error;
      }
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, work); return work;
  }
  async configure(actor: ActorContext, id: string, input: Json): Promise<Json> {
    fields(input, ['project_id', 'role_id', 'capabilities', 'enabled', 'expected_revision']);
    const project = text(input.project_id), previous = this.store.get('SELECT * FROM channel_employee_grants WHERE chat_id=? AND project_id=?', id, project);
    authorize(actor, 'config.write', { project_id: project });
    if (input.expected_revision !== (previous?.revision ?? 0)) fail(409, 'channel_revision_conflict');
    if (typeof input.enabled !== 'boolean') fail(400, 'channel_employee_invalid');
    if (!input.enabled && !previous) fail(404, 'channel_employee_not_found');
    if (!input.enabled && previous) {
      this.store.transaction(() => {
        authorize(actor, 'config.write', { project_id: project });
        if (!this.store.run('UPDATE channel_employee_grants SET enabled=0,revision=revision+1 WHERE id=? AND revision=?', previous.id, Number(input.expected_revision)).changes) fail(409, 'channel_revision_conflict');
        this.store.run('UPDATE principals SET active=0 WHERE id=?', previous.principal_id);
        invalidate(this.store, previous.principal_id, 'channel_employee_disabled');
        this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', id);
        this.store.audit(actor.principal_id, 'channel.employee.disabled', previous.id, project);
      }); return { id: previous.id, revision: previous.revision + 1, enabled: false };
    }
    const chat = this.chat(id), role = text(input.role_id), binding = this.binding(chat, actor.principal_id);
    if (chat.chat_type !== 'group') fail(400, 'channel_employee_group_required');
    if (!Array.isArray(input.capabilities) || !input.capabilities.includes('tasks.read') || input.capabilities.some(c => !capabilities.includes(String(c))) || new Set(input.capabilities).size !== input.capabilities.length) fail(400, 'channel_employee_capabilities_invalid');
    const grant = { id: previous?.id ?? randomId(), project_id: project, principal_id: previous?.principal_id ?? randomId(), role_id: role,
      maintainer_id: actor.principal_id, binding_id: binding.id, capabilities: JSON.stringify(input.capabilities), revision: (previous?.revision ?? 0) + 1 };
    this.maintainer(grant, chat); await this.verify(id, true);
    return this.store.transaction(() => {
      assertCurrent(actor); const currentChat = this.chat(id); this.maintainer(grant, currentChat); this.member(currentChat, binding.external_actor, binding.external_tenant);
      if ((this.store.get('SELECT revision FROM channel_employee_grants WHERE chat_id=? AND project_id=?', id, project)?.revision ?? 0) !== input.expected_revision) fail(409, 'channel_revision_conflict');
      const tenant = this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)!.tenant_id;
      if (!previous) this.store.run("INSERT INTO principals(id,kind,project_id,tenant_id,maintenance) VALUES(?,'service',?,?,?)", grant.principal_id, project, tenant, 'channel:' + id);
      else this.store.run('UPDATE principals SET active=1,tenant_id=?,maintenance=? WHERE id=?', tenant, 'channel:' + id, grant.principal_id);
      this.store.run(`INSERT INTO channel_employee_grants VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        role_id=excluded.role_id,maintainer_id=excluded.maintainer_id,binding_id=excluded.binding_id,capabilities=excluded.capabilities,enabled=excluded.enabled,revision=excluded.revision`,
        grant.id, id, project, grant.principal_id, role, actor.principal_id, binding.id, grant.capabilities, 1, grant.revision, Date.now());
      // No platform/configuration/grant-management or project-wide task-write capability.
      this.store.run('DELETE FROM scoped_grants WHERE principal_id=?', grant.principal_id);
      this.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
        VALUES(?,?,?,?,'project','service',?,'explicit_delegation',?,'channel_employee',?,?)`, randomId(), grant.principal_id, tenant, project, grant.capabilities, actor.principal_id, 'channel:' + id, Date.now());
      invalidate(this.store, grant.principal_id, 'channel_employee_configured');
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', id);
      this.store.audit(actor.principal_id, 'channel.employee.configured', grant.id, project);
      return { id: grant.id, revision: grant.revision, enabled: true, conversation_id: id, principal_id: grant.principal_id };
    });
  }
  assertGrant(grant: Row): Row {
    const current = this.store.get('SELECT * FROM channel_employee_grants WHERE id=? AND enabled=1', grant.id);
    if (!current) return fail(403, 'channel_employee_disabled');
    const chat = this.chat(current.chat_id), binding = this.maintainer(current, chat);
    this.member(chat, binding.external_actor, binding.external_tenant);
    const actor = narrowActor(resolvePrincipalActor(this.store, current.principal_id, null, current.project_id, 'service'), JSON.parse(current.capabilities));
    for (const cap of JSON.parse(current.capabilities)) authorize(actor, cap, { project_id: current.project_id });
    return current;
  }
  /** The original accepted envelope fixes the real sender; neither tool args nor task input can replace it. */
  private receipt(chat: Row, source: string): ChannelEvent {
    const row = this.store.get('SELECT * FROM channel_inbox WHERE id=?', source);
    if (!row) return fail(403, 'channel_employee_message_required');
    const e = this.store.secrets.open(row.payload, 'channel-event:' + source) as unknown as ChannelEvent;
    if (e.kind !== 'message' || e.sender_type !== 'user' || e.provider !== chat.provider || e.app_id !== chat.app_id || e.installation_tenant !== chat.installation_tenant || e.chat_id !== chat.chat_id) fail(403, 'channel_employee_source_mismatch');
    this.member(chat, e.actor_id, e.actor_tenant); return e;
  }
  caller(chatId: string, project: string, source: string): TaskCaller {
    const grant = this.store.get('SELECT * FROM channel_employee_grants WHERE chat_id=? AND project_id=? AND enabled=1', chatId, project);
    if (!grant) return fail(403, 'channel_employee_project_required');
    this.assertGrant(grant); const chat = this.chat(chatId); this.receipt(chat, source);
    const guard = () => { this.assertGrant(grant); this.receipt(this.chat(chatId), source); };
    const actor = restrictActor(narrowActor(resolvePrincipalActor(this.store, grant.principal_id, null, project, 'im'), JSON.parse(grant.capabilities)), guard);
    return roleTaskCaller(this.store, project, grant.role_id, { actor, conversation_id: chatId, source_message: source, guard });
  }
  guardOrigin(origin: Row): void {
    const grant = this.store.get('SELECT * FROM channel_employee_grants WHERE principal_id=?', origin.principal_id ?? '');
    if (!grant) return;
    this.assertGrant(grant);
    if (origin.conversation_id !== grant.chat_id || origin.project_id !== grant.project_id) fail(403, 'channel_employee_source_mismatch');
    // A delegated role can create related work; its ancestry is checked by the
    // shared task service. The root must still be this grant's configured role.
    if (!origin.source_task_id && origin.source_role !== grant.role_id) fail(403, 'channel_employee_source_mismatch');
    this.receipt(this.chat(grant.chat_id), origin.source_message);
  }
  guardSync(chat: Row): void {
    const grants = this.store.all('SELECT * FROM channel_employee_grants WHERE chat_id=?', chat.id);
    // Discovery before any business enablement is authorized by the app's visible
    // range. After enablement, revoked authority must not keep importing history.
    if (!grants.length) return;
    for (const grant of grants) try { this.assertGrant(grant); return; } catch { /* Another project grant may still cover the chat. */ }
    fail(403, 'channel_employee_sync_paused');
  }
  authorizeHistory(actor: ActorContext, id: string): void {
    try { authorize(actor, 'platform.manage'); return; } catch (error) { if ((error as any).code !== 'capability_forbidden') throw error; }
    const grant = this.store.all('SELECT * FROM channel_employee_grants WHERE chat_id=? AND maintainer_id=? AND enabled=1', id, actor.principal_id)
      .find(g => { try { this.assertGrant(g); authorize(actor, 'config.write', { project_id: g.project_id }); return true; } catch { return false; } });
    if (!grant) fail(403, 'channel_history_forbidden');
  }
  list(actor: ActorContext): Json {
    assertCurrent(actor);
    const identities = this.store.all("SELECT connector,external_actor,external_tenant FROM external_identities WHERE principal_id=? AND provider='feishu' AND host='open.feishu.cn' AND status='active' AND (expires_at IS NULL OR expires_at>?)", actor.principal_id, Date.now());
    const chats = this.store.all("SELECT h.id,h.chat_id,h.app_id,h.installation_tenant,c.app_name FROM channel_chats h JOIN channel_connectors c ON c.id=h.connector_id WHERE h.chat_type='group' AND h.state='active' AND c.enabled=1 AND h.app_id=c.app_id AND h.installation_tenant=c.installation_tenant")
      .filter(chat => identities.some(i => String(i.connector).endsWith(':' + chat.app_id) && this.store.get('SELECT 1 FROM channel_messages WHERE chat_id=? AND sender_id=? AND sender_tenant=?', chat.id, i.external_actor, i.external_tenant)));
    return { employees: this.store.all('SELECT * FROM channel_employee_grants WHERE maintainer_id=? ORDER BY created_at', actor.principal_id).map(g => {
      let state = g.enabled ? 'active' : 'disabled', error = null;
      if (g.enabled) try { this.assertGrant(g); } catch (e) { state = 'paused'; error = (e as any).code ?? 'channel_employee_unavailable'; }
      return { ...g, capabilities: JSON.parse(g.capabilities), state, error, conversation_id: g.chat_id };
    }), chats, projects: listEffectiveProjectAccess(this.store, actor.principal_id).filter(p => p.can_configure), capability_options: capabilities };
  }
  /** Refresh authority, never run business work. Queries themselves perform no provider reads. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    for (const row of this.store.all(`SELECT DISTINCT g.chat_id FROM channel_employee_grants g LEFT JOIN channel_audiences a ON a.chat_id=g.chat_id
      WHERE g.enabled=1 AND (a.verified_until IS NULL OR a.verified_until<?) AND (a.checked_at IS NULL OR a.checked_at<?)`, Date.now() + 60_000, Date.now() - 30_000)) {
      try { await this.verify(row.chat_id, true); } catch { /* A failed check keeps the last snapshot unusable. */ }
    }
  }
}
