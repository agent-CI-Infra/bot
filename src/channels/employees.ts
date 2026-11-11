import type { Store, Row } from '../storage/database.js';
import { assertCurrent, authorize, invalidate, listEffectiveProjectAccess, narrowActor, resolvePrincipalActor, restrictActor, type ActorContext } from '../identity/authorization.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';
import { roleConfiguration } from '../roles/definition.js';
import { roleTaskCaller, taskSourceGuard, type TaskCaller } from '../tasks/management.js';
import type { FeishuAdapter } from './feishu.js';
import type { ChannelEvent } from './types.js';

const capabilities = ['tasks.read', 'tasks.manage_own', 'knowledge.read', 'knowledge.write'];
const audienceTtl = 5 * 60_000;
/** Legacy group employees (before service role bindings, #312), Feishu identities and group membership snapshots.
 * New groups bind a service role instead (service-bindings.ts); an employee grant now only authorizes the tasks it created. */
export class ChannelEmployees {
  private readonly pending = new Map<string, Promise<void>>();
  private stopped = false;
  /** Set by the channel service: tasks a group binding delegated are checked against that binding (one source guard per store). */
  bindingGuard?: (origin: Row) => void;
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
  // One account may hold several Feishu identities for the same app (for example in two enterprises); a known speaker selects its own.
  private binding(chat: Row, principal: string, binding?: string, subject?: { actor: string; tenant: string }): Row {
    const row = this.store.all("SELECT * FROM external_identities WHERE principal_id=? AND provider='feishu' AND host='open.feishu.cn' AND status='active'", principal)
      .find(r => (!binding || r.id === binding) && (!subject || r.external_actor === subject.actor && r.external_tenant === subject.tenant)
        && String(r.connector).endsWith(':' + chat.app_id) && (!r.expires_at || r.expires_at > Date.now()));
    if (!row) return fail(403, 'external_binding_required'); return row;
  }
  /** The principal's active Feishu identity for this chat's application. */
  feishuIdentity(chat: Row, principal: string, subject?: { actor: string; tenant: string }): Row { return this.binding(chat, principal, undefined, subject); }
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
  /** Against the last verified member snapshot; call verify() first for a fresh one. */
  assertMember(chat: Row, id: string, tenant: string): void { this.member(chat, id, tenant); }
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
    fields(input, ['project_id', 'role_id', 'capabilities', 'participation', 'enabled', 'expected_revision']);
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
    const chat = this.chat(id), role = text(input.role_id), binding = this.binding(chat, actor.principal_id),participation=input.participation??previous?.participation??'mentions';
    if(!['mentions','questions','all'].includes(participation))fail(400,'channel_participation_invalid');
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
      this.store.run(`INSERT INTO channel_employee_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        role_id=excluded.role_id,maintainer_id=excluded.maintainer_id,binding_id=excluded.binding_id,capabilities=excluded.capabilities,enabled=excluded.enabled,revision=excluded.revision,participation=excluded.participation`,
        grant.id, id, project, grant.principal_id, role, actor.principal_id, binding.id, grant.capabilities, 1, grant.revision, Date.now(),participation);
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
  currentMessage(chat:Row,event:ChannelEvent):void{
    const current=this.store.get('SELECT * FROM channel_messages WHERE chat_id=? AND message_id=?',chat.id,event.message_id);
    if(!current||current.deleted||current.sensitive)return fail(403,'channel_source_message_unavailable');
    const payload=this.store.secrets.open(current.payload,'channel-message:'+chat.id+':'+event.message_id);
    if(current.sender_id!==event.actor_id||current.sender_tenant!==event.actor_tenant||payload.content!==event.content)fail(403,'channel_source_message_changed');
  }
  private receipt(chat: Row, source: string, currentMember = true): ChannelEvent {
    const row = this.store.get('SELECT * FROM channel_inbox WHERE id=?', source);
    if (!row) return fail(403, 'channel_employee_message_required');
    const e = this.store.secrets.open(row.payload, 'channel-event:' + source) as unknown as ChannelEvent;
    if (e.kind !== 'message' || e.sender_type !== 'user' || e.provider !== chat.provider || e.app_id !== chat.app_id || e.installation_tenant !== chat.installation_tenant || e.chat_id !== chat.chat_id) fail(403, 'channel_employee_source_mismatch');
    this.currentMessage(chat,e);if(currentMember)this.member(chat, e.actor_id, e.actor_tenant); return e;
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
    if (!grant) {
      this.bindingGuard?.(origin);
      const chat=origin.conversation_id&&this.store.get("SELECT * FROM channel_chats WHERE id=? AND chat_type='p2p'",origin.conversation_id);
      // A task a private chat created before #301 stays bound to that chat's owner and source message.
      if(chat)this.guardPersonal(chat.id,origin.principal_id,origin.source_message);
      return;
    }
    this.assertGrant(grant);
    if (origin.conversation_id !== grant.chat_id || origin.project_id !== grant.project_id) fail(403, 'channel_employee_source_mismatch');
    // A delegated role can create related work; its ancestry is checked by the
    // shared task service. The root must still be this grant's configured role.
    if (!origin.source_task_id && origin.source_role !== grant.role_id) fail(403, 'channel_employee_source_mismatch');
    this.receipt(this.chat(grant.chat_id), origin.source_message, false);
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
    const owner=this.store.get('SELECT * FROM channel_personal_owners WHERE chat_id=? AND principal_id=?',id,actor.principal_id);
    if(owner){const binding=this.binding(this.chat(id),actor.principal_id,undefined,{actor:owner.actor_id,tenant:owner.actor_tenant});if(binding.external_actor===owner.actor_id&&binding.external_tenant===owner.actor_tenant)return;}
    const grant = this.store.all('SELECT * FROM channel_employee_grants WHERE chat_id=? AND maintainer_id=? AND enabled=1', id, actor.principal_id)
      .find(g => { try { this.assertGrant(g); authorize(actor, 'config.write', { project_id: g.project_id }); return true; } catch { return false; } });
    if (!grant) fail(403, 'channel_history_forbidden');
  }
  visibleProjects(id:string,actor?:ActorContext):string[] {
    const owner=this.store.get('SELECT * FROM channel_personal_owners WHERE chat_id=?',id);
    if(owner)return listEffectiveProjectAccess(this.store,actor?.principal_id??owner.principal_id).map(p=>p.id);
    return this.store.all('SELECT * FROM channel_employee_grants WHERE chat_id=? AND enabled=1',id).filter(grant=>{
      try{this.assertGrant(grant);if(actor)authorize(actor,'tasks.read',{project_id:grant.project_id});return true;}catch{return false;}
    }).map(g=>g.project_id);
  }
  personalOwner(id:string,event:ChannelEvent,actor:ActorContext):void{
    const chat=this.chat(id),binding=this.binding(chat,actor.principal_id,undefined,{actor:event.actor_id,tenant:event.actor_tenant});
    if(chat.chat_type!=='p2p'||binding.external_actor!==event.actor_id||binding.external_tenant!==event.actor_tenant)fail(403,'channel_personal_source_mismatch');
    const previous=this.store.get('SELECT * FROM channel_personal_owners WHERE chat_id=?',id);
    if(previous&&(previous.actor_id!==event.actor_id||previous.actor_tenant!==event.actor_tenant))fail(403,'channel_personal_source_mismatch');
    this.store.run('INSERT INTO channel_personal_owners VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET principal_id=excluded.principal_id',id,actor.principal_id,event.actor_id,event.actor_tenant);
  }
  guardPersonal(id:string,principal:string,source:string):void{
    const chat=this.chat(id),owner=this.store.get('SELECT * FROM channel_personal_owners WHERE chat_id=? AND principal_id=?',id,principal),row=this.store.get('SELECT payload FROM channel_inbox WHERE id=?',source);
    if(!owner||!row)fail(403,'channel_personal_source_mismatch');
    const event=this.store.secrets.open(row!.payload,'channel-event:'+source) as unknown as ChannelEvent,binding=this.binding(chat,principal,undefined,{actor:event.actor_id,tenant:event.actor_tenant});
    if(event.chat_id!==chat.chat_id||event.app_id!==chat.app_id||event.installation_tenant!==chat.installation_tenant||event.actor_id!==owner!.actor_id||event.actor_tenant!==owner!.actor_tenant||
      binding.external_actor!==event.actor_id||binding.external_tenant!==event.actor_tenant||event.kind!=='message')fail(403,'channel_personal_source_mismatch');
    this.currentMessage(chat,event);
  }
  /** Groups the actor can pick: an active chat of an enabled app where the actor's bound Feishu identity has spoken. */
  selectableChats(actor: ActorContext): Row[] {
    const identities = this.store.all("SELECT connector,external_actor,external_tenant FROM external_identities WHERE principal_id=? AND provider='feishu' AND host='open.feishu.cn' AND status='active' AND (expires_at IS NULL OR expires_at>?)", actor.principal_id, Date.now());
    return this.store.all("SELECT h.id,h.chat_id,h.app_id,h.installation_tenant,c.app_name FROM channel_chats h JOIN channel_connectors c ON c.id=h.connector_id WHERE h.chat_type='group' AND h.state='active' AND c.enabled=1 AND h.app_id=c.app_id AND h.installation_tenant=c.installation_tenant")
      .filter(chat => identities.some(i => String(i.connector).endsWith(':' + chat.app_id) && this.store.get('SELECT 1 FROM channel_messages WHERE chat_id=? AND sender_id=? AND sender_tenant=?', chat.id, i.external_actor, i.external_tenant)));
  }
  /** Legacy employee grants the actor maintains. They no longer receive messages; they only authorize tasks they already created. */
  legacy(actor: ActorContext): Json[] {
    return this.store.all('SELECT * FROM channel_employee_grants WHERE maintainer_id=? ORDER BY created_at', actor.principal_id).map(g => ({ ...g, capabilities: JSON.parse(g.capabilities),
      state: g.enabled ? 'active' : 'disabled', conversation_id: g.chat_id, open_tasks: this.store.get(`SELECT count(*) n FROM task_origins o JOIN tasks t ON t.id=o.task_id
        WHERE o.principal_id=? AND t.status NOT IN ('completed','succeeded','pr_opened','cancelled','failed','superseded')`, g.principal_id)!.n,
      full_name: this.store.get('SELECT full_name FROM repositories WHERE id=?', g.project_id)?.full_name ?? g.project_id }));
  }
  list(actor: ActorContext): Json {
    assertCurrent(actor);
    const chats = this.selectableChats(actor);
    return { employees: this.store.all('SELECT * FROM channel_employee_grants WHERE maintainer_id=? ORDER BY created_at', actor.principal_id).map(g => {
      let state = g.enabled ? 'active' : 'disabled', error = null;
      if (g.enabled) try { this.assertGrant(g); } catch (e) { state = 'paused'; error = (e as any).code ?? 'channel_employee_unavailable'; }
      return { ...g, capabilities: JSON.parse(g.capabilities), state, error, conversation_id: g.chat_id };
    }), chats,personal_chats:this.store.all('SELECT c.id,c.chat_id,c.app_id FROM channel_chats c JOIN channel_personal_owners o ON o.chat_id=c.id WHERE o.principal_id=?',actor.principal_id),
      projects: listEffectiveProjectAccess(this.store, actor.principal_id).filter(p => p.can_configure), capability_options: capabilities };
  }
  /** Refresh authority, never run business work. Queries themselves perform no provider reads. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    // Legacy grants only authorize tasks they already created; a group with no open legacy task needs no membership polling.
    for (const row of this.store.all(`SELECT DISTINCT g.chat_id FROM channel_employee_grants g LEFT JOIN channel_audiences a ON a.chat_id=g.chat_id
      WHERE g.enabled=1 AND (a.verified_until IS NULL OR a.verified_until<?) AND (a.checked_at IS NULL OR a.checked_at<?)
      AND EXISTS(SELECT 1 FROM task_origins o JOIN tasks t ON t.id=o.task_id WHERE o.principal_id=g.principal_id
        AND t.status NOT IN ('completed','succeeded','pr_opened','cancelled','failed','superseded'))`, Date.now() + 60_000, Date.now() - 30_000)) {
      try { await this.verify(row.chat_id, true); } catch { /* A failed check keeps the last snapshot unusable. */ }
    }
  }
}
