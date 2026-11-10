import type { IncomingHttpHeaders } from 'node:http';
import type { Store, Row } from '../storage/database.js';
import { assertCurrent, authorize, type ActorContext } from '../identity/authorization.js';
import { digest, fail, HttpError, object, randomId, text, type Json } from '../core/security.js';
import { traceClean } from '../tasks/trace.js';
import { ManagementAgent } from '../management/agent.js';
import { parameterHash } from '../management/service.js';
import { ChannelBindings, externalSubject } from './binding.js';
import { FeishuAdapter, type ChannelFetch } from './feishu.js';
import type { ChannelDelivery, ChannelEvent } from './types.js';
import { ChannelLedger } from './ledger.js';
import { ChannelHistorySync } from './history-sync.js';
import { ChannelEmployees } from './employees.js';
import { RoleConversations } from '../roles/conversation.js';
import { roleConfiguration } from '../roles/definition.js';
import { roleTaskCaller, assertManagedExecution, taskAuthorizationFence } from '../tasks/management.js';
import type { Manager } from '../projects/service.js';
import { TaskError } from '../agent/common.js';

const errorCode = (error: unknown) => error instanceof HttpError || error instanceof TaskError ? error.code : 'channel_processing_failed';
const card = (value: string, link?: string, token?: string): Json => ({ config: { wide_screen_mode: true },
  elements: [{ tag: 'div', text: { tag: 'plain_text', content: value.length>12000?value.slice(0,11880)+'\n内容较长，此卡片仅显示前段；请登录后台查看完整记录。':value } },
    ...(link ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '登录后台查看' }, url: link },
      ...(token ? [{ tag: 'button', text: { tag: 'plain_text', content: '刷新执行状态' }, value: { token } }] : [])] }] : [])] });
export interface ChannelOptions { origin?: string; fetch?: ChannelFetch; longConnections?: boolean; manager?: Manager; }
/** Transport replies and authorized destination registration. Durable scheduling lives in schedules/. */
export class ChannelService {
  readonly bindings: ChannelBindings;
  readonly ledger: ChannelLedger;
  readonly historySync: ChannelHistorySync;
  readonly employees: ChannelEmployees;
  readonly conversations: RoleConversations;
  private readonly business = new Map<string,Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  constructor(readonly store: Store, readonly management: ManagementAgent, readonly options: ChannelOptions = {}) {
    this.bindings = new ChannelBindings(store, e => this.source(e));
    this.ledger = new ChannelLedger(store);
    this.employees = new ChannelEmployees(store, (c, guard) => this.adapter(c, guard));
    this.conversations = new RoleConversations(store, management.service.tasks, options.manager);
    this.historySync = new ChannelHistorySync(store, this.ledger, (c, guard) => this.adapter(c, guard), chat => this.employees.guardSync(chat));
    management.service.sourceGuard = command => {
      if (command.channel !== 'im') return;
      const source = store.get('SELECT * FROM channel_inbox WHERE conversation_id=? AND message_id IS NOT NULL AND id=?',
        command.source_conversation, String(command.source_message).replace(/^feishu:/, ''));
      if (!source) fail(403, 'channel_command_source_required');
      const e = store.secrets.open(source!.payload, 'channel-event:' + source!.id) as unknown as ChannelEvent;
      this.source(e);
      const subject = externalSubject(e);
      if (!store.get("SELECT 1 FROM external_identities WHERE principal_id=? AND provider=? AND host=? AND connector=? AND external_tenant=? AND external_actor=? AND status='active'",
        command.principal_id, subject.provider, subject.host, subject.connector, subject.external_tenant, subject.external_actor)) fail(403, 'external_binding_required');
      if (e.chat_type === 'group') this.groupScope(e, command.project_id);
    };
    // An interrupted model turn must be inspected in Web, never submitted again on restart.
    store.run("UPDATE channel_inbox SET state='failed',error='interrupted_check_operation' WHERE state='running'");
    store.run("UPDATE channel_outbox SET state='retry',last_error='delivery_interrupted' WHERE state='sending'");
  }
  start(): void {
    for (const chat of this.store.all("SELECT h.id FROM channel_chats h JOIN channel_connectors c ON c.id=h.connector_id WHERE h.state='active' AND c.enabled=1 AND c.app_id=h.app_id AND c.installation_tenant=h.installation_tenant")) this.ledger.resync(chat.id);
    this.timer = setInterval(() => { void this.tick(); }, 100); this.timer.unref();
    this.syncTimer = setInterval(() => { void this.historySync.tick().catch(() => {}); void this.employees.tick().catch(() => {}); }, 1000); this.syncTimer.unref();
  }
  close(): void { this.stopped = true; this.conversations.stop(); this.historySync.close(); this.employees.close(); clearInterval(this.timer); clearInterval(this.syncTimer); }
  async drain():Promise<void>{await Promise.allSettled([...this.business.values()]);}
  conversationView(actor:ActorContext,id:string,offset=0):Json{
    this.employees.authorizeHistory(actor,id);if(!Number.isSafeInteger(offset)||offset<0)fail(400,'invalid_pagination');
    const chat=this.store.get('SELECT * FROM channel_chats WHERE id=?',id)!;
    const projects=this.employees.visibleProjects(id,actor),marks=projects.map(()=>'?').join(','),fence=this.businessFence(chat);
    const turns=projects.length?this.store.all(`SELECT id,source_message,project_id,role_id,state,reply,error,created_at,updated_at,fence FROM role_conversation_turns
      WHERE conversation_id=? AND project_id IN (${marks}) ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?`,id,...projects,offset):[];
    const requests=projects.length?this.store.get(`SELECT count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,
      sum(CASE WHEN finished_at IS NULL OR input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) usage_missing_requests,sum(CASE WHEN accounting_source='acp_prompt' THEN 1 ELSE 0 END) provider_request_count_unknown,
      sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced_requests FROM model_requests WHERE conversation_id=? AND repository_id IN (${marks})`,id,...projects):null;
    const costs=projects.length?this.store.all(`SELECT currency,sum(cost) amount FROM model_requests WHERE conversation_id=? AND repository_id IN (${marks}) AND cost IS NOT NULL GROUP BY currency`,id,...projects):[];
    return {conversation_id:id,current_project:this.store.get('SELECT project_id FROM role_conversations WHERE id=?',id)?.project_id??null,
      turns:turns.slice(0,50).map(t=>({...t,fence:undefined,reply:t.reply&&t.fence===fence?this.store.secrets.open(t.reply,'conversation-reply:'+t.id).message:null,
        stale_source:t.fence!==fence})),has_more:turns.length>50,next_offset:turns.length>50?offset+50:null,usage:{...requests,costs,semantics:requests?.usage_missing_requests?'lower_bound':requests?.unpriced_requests?'known usage; cost incomplete':'recorded estimates'},...this.ledger.diagnostics(id)};
  }
  connector(id: string): Row {
    const c = this.store.get('SELECT * FROM channel_connectors WHERE id=? AND enabled=1', id);
    if (!c) return fail(403, 'channel_connector_inactive'); return c;
  }
  source(e: ChannelEvent): Row {
    const c = this.connector(e.connector_id);
    if (e.connector_revision !== c.revision) fail(403, 'channel_configuration_changed');
    if (c.provider !== e.provider || c.app_id !== e.app_id || c.installation_tenant !== e.installation_tenant) fail(403, 'channel_source_mismatch');
    const chat = e.chat_id ? this.store.get('SELECT state FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? AND chat_id=?', e.provider, e.app_id, e.installation_tenant, e.chat_id) : undefined;
    if (chat && chat.state !== 'active') fail(403, 'channel_chat_inactive');
    return c;
  }
  adapter(c: Row, guard?: () => void): FeishuAdapter {
    const row = this.store.get('SELECT sealed FROM channel_credentials WHERE id=?', c.credential_ref);
    if (!row) return fail(403, 'channel_credentials_revoked');
    return new FeishuAdapter(c, this.store.secrets.open(row.sealed, 'channel-credential:' + c.credential_ref), this.options.fetch, guard);
  }
  receiveHTTP(id: string, headers: IncomingHttpHeaders, body: Buffer): Json {
    // One store app has one callback URL. Its verified installation tenant selects an explicitly configured connector.
    const anchor = this.store.get("SELECT * FROM channel_connectors WHERE id=? AND provider='feishu'", id);
    if (!anchor) return fail(403, 'channel_connector_inactive');
    if (anchor.transport !== 'http') fail(403, 'channel_transport_mismatch');
    const data = this.adapter(anchor).verify(headers, body);
    if (data.type === 'url_verification') return { challenge: text(data.challenge) };
    if ((data.event as Json)?.type === 'app_ticket') return this.appTicket(anchor, headers, body, data);
    const tenant = (data.header as Json)?.tenant_key ?? (data.event as Json)?.tenant_key;
    const c = anchor.application_type === 'saas' && tenant !== anchor.installation_tenant ?
      this.store.get("SELECT * FROM channel_connectors WHERE provider='feishu' AND app_id=? AND installation_tenant=? AND application_type='saas' AND transport='http'", anchor.app_id, String(tenant)) : anchor;
    if (!c) return fail(403, 'channel_source_mismatch');
    // Each selected installation must independently trust the same signed callback.
    this.adapter(c).verify(headers, body);
    return this.accept(c, data);
  }
  private appTicket(anchor: Row, headers: IncomingHttpHeaders, body: Buffer, data: Json): Json {
    if (anchor.application_type !== 'saas') fail(403, 'channel_app_ticket_forbidden');
    const event = object(data.event), ticket = text(event.app_ticket, 8192), eventId = text(data.uuid), timestamp = Number(data.ts) * 1000;
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 300_000) fail(400, 'channel_message_stale');
    let receipt: Json = { state: 'ignored' };
    this.store.transaction(() => {
      for (const c of this.store.all("SELECT * FROM channel_connectors WHERE provider='feishu' AND app_id=? AND application_type='saas' AND enabled=1", anchor.app_id)) {
        try { this.adapter(c).verify(headers, body); } catch { continue; }
        const previous = this.store.get('SELECT id FROM channel_inbox WHERE connector_id=? AND event_id=?', c.id, eventId);
        if (previous) { receipt = { operation_id: previous.id, state: 'completed', duplicate: true }; continue; }
        const credential = this.store.get('SELECT sealed FROM channel_credentials WHERE id=?', c.credential_ref)!;
        const secret = this.store.secrets.open(credential.sealed, 'channel-credential:' + c.credential_ref);
        if (Number(secret.app_ticket_time ?? 0) < timestamp) this.store.run('UPDATE channel_credentials SET sealed=? WHERE id=?',
          this.store.secrets.seal({ ...secret, app_ticket: ticket, app_ticket_time: timestamp }, 'channel-credential:' + c.credential_ref), c.credential_ref);
        const id = randomId();
        this.store.run("INSERT INTO channel_inbox(id,connector_id,event_id,dedup_key,payload,state,created_at) VALUES(?,?,?,?,?,'completed',?)", id, c.id, eventId, 'app_ticket:' + eventId,
          this.store.secrets.seal({ kind: 'app_ticket' }, 'channel-event:' + id), Date.now());
        this.store.run('UPDATE channel_connectors SET last_received_at=?,last_error=NULL WHERE id=?', Date.now(), c.id);
        receipt = { operation_id: id, state: 'completed' };
      }
    });
    return receipt;
  }
  // Only the authenticated official SDK calls this method. There is no HTTP route for SDK input.
  receiveLongConnection(id: string, envelope: Json): Json {
    const c = this.connector(id);
    if (c.transport !== 'websocket' || c.application_type !== 'enterprise') fail(403, 'channel_transport_mismatch');
    return this.accept(c, envelope);
  }
  private accept(c: Row, data: Json): Json {
    const event = this.adapter(c).normalize(data);
    if (!event) return { state: 'ignored' };
    const previous = this.store.get('SELECT id,state FROM channel_inbox WHERE connector_id=? AND (event_id=? OR dedup_key=?)', c.id, event.event_id,
      event.kind === 'message' ? 'message:' + event.message_id : event.kind + ':' + event.event_id);
    if (previous) return { operation_id: previous.id, state: previous.state, duplicate: true };
    if (!c.enabled) fail(403, 'channel_connector_inactive');
    // Reading is independent of speaking. A delayed message still belongs in the local ledger.
    const ambient=event.chat_type==='group'&&this.store.get(`SELECT 1 FROM channel_employee_grants g JOIN channel_chats h ON h.id=g.chat_id WHERE h.provider=? AND h.app_id=? AND h.installation_tenant=? AND h.chat_id=? AND g.enabled=1
      AND (g.participation='all' OR (g.participation='questions' AND ?=1))`,event.provider,event.app_id,event.installation_tenant,event.chat_id,/[?？]\s*$/.test(event.content)?1:0);
    const actionable = event.kind !== 'message' || (event.addressed||ambient) && event.message_type === 'text' && event.sender_type === 'user' && Math.abs(Date.now() - event.created_at) <= 300_000;
    const id = randomId(), state = actionable ? 'queued' : 'completed';
    this.store.transaction(() => {
      this.store.run('INSERT INTO channel_inbox(id,connector_id,event_id,dedup_key,payload,state,created_at) VALUES(?,?,?,?,?,?,?)',
        id, c.id, event.event_id, event.kind === 'message' ? 'message:' + event.message_id : event.kind + ':' + event.event_id,
        this.store.secrets.seal(event, 'channel-event:' + id), state, Date.now());
      this.ledger.accept(event);
      if (['audience_changed', 'bot_removed', 'chat_archived', 'uninstalled'].includes(event.kind)) {
        for (const chat of this.store.all(`SELECT id FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? ${event.chat_id ? 'AND chat_id=?' : ''}`,
          event.provider, event.app_id, event.installation_tenant, ...(event.chat_id ? [event.chat_id] : []))) this.employees.invalidate(chat.id, event.kind);
      }
      this.store.run('UPDATE channel_connectors SET last_received_at=?,last_error=NULL WHERE id=?', Date.now(), c.id);
      // Revocation and audience invalidation are cheap security facts, applied before acknowledgement.
      if (event.kind === 'uninstalled') {
        this.store.run('UPDATE channel_connectors SET enabled=0,revision=revision+1 WHERE id=?', c.id);
        this.store.run("UPDATE channel_sync_jobs SET state='paused',lease_token=NULL,lease_until=0,last_error='app_uninstalled' WHERE chat_id IN (SELECT id FROM channel_chats WHERE connector_id=?)", c.id);
        this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id IN (SELECT id FROM channel_chats WHERE connector_id=?)', c.id);
      }
      if (event.kind === 'audience_changed') this.store.run('UPDATE channel_group_scopes SET audience_verified_until=0,revision=revision+1 WHERE connector_id=? AND chat_id=?', c.id, event.chat_id);
      if (['bot_removed', 'chat_archived'].includes(event.kind)) this.store.run('UPDATE channel_group_scopes SET enabled=0,audience_verified_until=0,revision=revision+1 WHERE connector_id=? AND chat_id=?', c.id, event.chat_id);
    });
    return { operation_id: id, state };
  }
  async actor(e: ChannelEvent, project?: string): Promise<ActorContext> {
    this.source(e);
    // The selected project supplies its organization; the connection supplies only a verified identity.
    return this.bindings.identities.resolveExternalActor(this.bindings.credential(e), null, project, () => {
      this.source(e); if (project && e.chat_type === 'group') this.groupScope(e, project);
    });
  }
  groupScope(e: ChannelEvent, project: string, field = 'summary'): Row {
    const c = this.source(e);
    const s = this.store.get('SELECT * FROM channel_group_scopes WHERE connector_id=? AND installation_tenant=? AND chat_id=? AND project_id=? AND enabled=1',
      c.id, e.installation_tenant, e.chat_id, project);
    // A public repository can still have private prompts, task logs and account configuration.
    const privateRepo = field === 'result' || this.store.get('SELECT i.private FROM installed_repositories i JOIN repositories r ON r.account_id=i.account_id AND r.id=i.repository_id WHERE r.id=?', project)?.private !== 0;
    if (!s || s.audience_verified_until <= Date.now() || !(JSON.parse(s.fields) as string[]).includes(field) || privateRepo && s.sensitivity !== 'private')
      return fail(403, 'channel_group_scope_required');
    return s;
  }
  link(actor: ActorContext, e: ChannelEvent, project: string, conversation: string): void {
    this.management.service.scope(actor, project);
    const target = this.management.conversation(actor, conversation);
    if (target.row.scope !== 'project:' + project) fail(403, 'conversation_project_mismatch');
    this.session(actor, e, project, conversation);
  }
  private session(actor: ActorContext, e: ChannelEvent, project: string, link?: string): Row {
    const keys = [e.connector_id, e.installation_tenant, e.actor_tenant, e.actor_id, e.chat_id, e.thread_id, project, actor.principal_id];
    const row = this.store.get(`SELECT * FROM channel_sessions WHERE connector_id=? AND installation_tenant=? AND actor_tenant=? AND actor_id=? AND chat_id=? AND thread_id=? AND project_id=? AND principal_id=?`, ...keys);
    if (row) {
      if (link) this.store.run('UPDATE channel_sessions SET conversation_id=? WHERE id=?', link, row.id);
      return this.store.get('SELECT * FROM channel_sessions WHERE id=?', row.id)!;
    }
    const conversation = link ?? (this.management.create(actor, { scope: 'project:' + project }).conversation as Json).id;
    const id = randomId();
    this.store.run('INSERT INTO channel_sessions(id,connector_id,installation_tenant,actor_tenant,actor_id,chat_id,thread_id,project_id,principal_id,conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?)', id, ...keys, String(conversation));
    return this.store.get('SELECT * FROM channel_sessions WHERE id=?', id)!;
  }
  private url(): string { return (this.options.origin ?? '') + '/#/management'; }
  /** NotificationOutbox contract: callers register an authorized destination, never a raw webhook. */
  enqueue(actor: ActorContext, e: ChannelEvent, project: string, key: string): Json {
    authorize(actor, 'schedules.manage', { project_id: project });
    this.source(e); if (e.chat_type === 'group') this.groupScope(e, project);
    // Schedules consume this sealed registration as a destination, never as proof of delivery.
    const id = this.queue(e, card('通知已入队，尚未发送。', this.url()), 'notification:' + digest(JSON.stringify([actor.principal_id, project, e.connector_id, e.actor_tenant, e.chat_id, key])), undefined, { principal_id: actor.principal_id, project_id: project }, true);
    return { operation_id: id, state: 'registered', sent: false };
  }
  private queue(e: ChannelEvent, content: Json, key: string, source?: string, protection?: Json, registered = false, direct = false, update?: string): string {
    const previous = this.store.get('SELECT id FROM channel_outbox WHERE idempotency_key=?', key); if (previous) return previous.id;
    const id = randomId(), delivery: ChannelDelivery = { receive_id: direct ? e.actor_id : e.chat_id, receive_id_type: direct ? 'open_id' : 'chat_id', content, ...(update ? { message_id: update } : {}) };
    this.store.run('INSERT INTO channel_outbox(id,connector_id,idempotency_key,source_event,payload,state,next_attempt,created_at) VALUES(?,?,?,?,?,?,?,?)', id, e.connector_id, key, source ?? null,
      this.store.secrets.seal({ event: {...e,content:'',raw_content:''}, delivery, protection }, 'channel-outbox:' + id), registered ? 'registered' : 'queued', Date.now(), Date.now());
    return id;
  }
  private async process(row: Row): Promise<void> {
    const e = this.store.secrets.open(row.payload, 'channel-event:' + row.id) as unknown as ChannelEvent;
    if (['uninstalled', 'audience_changed', 'message_recalled', 'bot_removed', 'chat_archived'].includes(e.kind)) { this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id); return; }
    this.source(e);
    if (e.kind === 'bot_added') {
      this.queue(e, card('机器人会在应用获准的可见范围内记录本群消息并同步历史，仅查询本地记录；平台不可见或未同步的内容会标明。项目业务能力须由有资格的已绑定维护人另行启用。'), row.id + ':notice', row.id);
      this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id); return;
    }
    if (e.kind === 'card') { await this.refreshCard(row, e); return; }
    const content = e.content.trim();
    const reply = (message: string, link?: string) => this.queue(e, card(message, link), row.id + ':reply', row.id);
    if (['绑定', '/bind', '重新认证', '/reauth'].includes(content)) {
      if (!this.options.origin) fail(503, 'channel_admin_origin_required');
      const binding = this.bindings.begin(e);
      reply('请在五分钟内打开后台，登录并核对要绑定的平台账户，然后回到同一私聊确认。可使用本地账户或 GitHub 登录，绑定不会授予项目权限。', this.options.origin + '/auth/channels/start?challenge=' + binding.challenge);
    } else if (/^(确认绑定|\/confirm) /.test(content)) {
      await this.bindings.confirm(e, content.slice(content.indexOf(' ') + 1).trim()); reply('双端身份绑定成功。项目权限仍由统一授权服务决定。');
    } else if (['解绑', '/unbind'].includes(content)) {
      await this.bindings.unlink(e); reply('已解绑。后续消息和旧卡片将重新检查当前身份。');
    } else if (['身份', '/identity'].includes(content)) {
      if (e.chat_type !== 'p2p') fail(403, 'binding_private_chat_required');
      const principal = await this.bindings.identities.resolveExternalPrincipal(this.bindings.credential(e));
      reply(principal ? '此飞书身份已绑定。授权与绑定列表请登录后台身份页查看；发送“重新认证”可重新证明双端。' : '尚未绑定。请发送“绑定”。');
    } else {
      const chat = this.store.get('SELECT * FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? AND chat_id=?', e.provider,e.app_id,e.installation_tenant,e.chat_id);
      const employee = chat && e.chat_type==='group' && this.store.get('SELECT 1 FROM channel_employee_grants WHERE chat_id=? AND enabled=1',chat.id);
      const legacyCommand = /^\/project \S+\s+\/(?:query|command|link|destination)(?:\s|$)/.test(content);
      const personalMain=e.chat_type==='p2p'&&!content.startsWith('/project ');
      if ((employee && !legacyCommand)||personalMain) {
        if(!chat)return fail(403,'channel_chat_not_found');
        if (this.business.has(chat.id)) { this.store.run("UPDATE channel_inbox SET state='queued' WHERE id=?",row.id);return; }
        const work = this.businessMessage(row,e,chat).catch(error=>{
          if(this.stopped)return;
          if(errorCode(error)==='conversation_busy'){this.store.run("UPDATE channel_inbox SET state='queued' WHERE id=?",row.id);return;}
          this.store.run("UPDATE channel_inbox SET state='failed',error=? WHERE id=?",errorCode(error),row.id);
          try { this.source(e);this.queue(e,card('本次请求未完成：'+errorCode(error)+'。已有任务与回执保留，请检查后再继续。'),row.id+':business-error',row.id); } catch {}
        }).finally(()=>this.business.delete(chat.id));
        this.business.set(chat.id,work);return;
      }
      const selection = /^\/project ([^\s]+)(?:\s+([\s\S]*))?$/.exec(content);
      if (!selection) { reply('请显式选择项目：/project <项目ID> <管理请求>。绑定请在私聊发送“绑定”。'); this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id); return; }
      const project = selection[1]!, request = selection[2] ?? '', actor = await this.actor(e, project);
      this.management.service.scope(actor, project);
      if (e.chat_type === 'group') this.groupScope(e, project);
      const linked = /^\/link ([a-f0-9]{48})$/.exec(request);
      if (request === '/destination' || request === '登记通知目的地') {
        const registered = this.enqueue(actor, e, project, 'destination:' + row.id);
        reply('通知目的地已登记：' + registered.operation_id + '。可在后台创建日报或事件订阅；登记不表示已发送通知。');
      } else if (linked) { this.link(actor, e, project, linked[1]!); reply('已显式关联本人同一项目的管理会话。'); }
      else {
        const session = this.session(actor, e, project);
        if (e.created_at < session.last_message_at) fail(409, 'channel_message_out_of_order');
        const active = this.store.get("SELECT 1 FROM management_messages WHERE conversation_id=? AND state IN ('pending','running')", session.conversation_id);
        if (active) { this.store.run("UPDATE channel_inbox SET state='queued' WHERE id=?", row.id); return; }
        let input: Json = { content: request };
        for (const mode of ['query', 'command']) if (request.startsWith('/' + mode + ' ')) {
          let value: Json; try { value = object(JSON.parse(request.slice(mode.length + 2))); } catch { return fail(400, 'channel_command_invalid'); }
          if ((value.target as Json)?.project_id !== project) fail(403, 'project_scope_mismatch');
          input = { [mode]: value };
        }
        if (!request) fail(400, 'channel_request_required');
        const message = this.management.send(actor, session.conversation_id, { ...input, source_message: 'feishu:' + row.id });
        this.store.run('UPDATE channel_sessions SET last_message_at=? WHERE id=?', e.created_at, session.id);
        this.store.run("UPDATE channel_inbox SET state='submitted',conversation_id=?,message_id=? WHERE id=?", session.conversation_id, String(message.id), row.id);
        return;
      }
    }
    this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id);
  }
  private businessFence(chat:Row):string {
    const visible=this.employees.visibleProjects(chat.id);
    if(chat.chat_type==='p2p'){
      const owner=this.store.get('SELECT * FROM channel_personal_owners WHERE chat_id=?',chat.id);
      return digest(JSON.stringify({owner,context:this.store.get('SELECT context_revision FROM channel_chats WHERE id=?',chat.id)?.context_revision,
        principal:owner&&this.store.get('SELECT authorization_revision FROM principals WHERE id=?',owner.principal_id)?.authorization_revision,
        projects:visible.map(project=>[project,roleConfiguration(this.store,project).revision,this.employees.personalRole(chat.id,project),this.store.get('SELECT enabled FROM policies WHERE repository_id=?',project)?.enabled])}));
    }
    return digest(JSON.stringify({context:this.store.get('SELECT context_revision FROM channel_chats WHERE id=?',chat.id)?.context_revision,
      audience:this.store.get('SELECT revision FROM channel_audiences WHERE chat_id=?',chat.id)?.revision,
      grants:this.store.all('SELECT * FROM channel_employee_grants WHERE chat_id=? ORDER BY id',chat.id).map(g=>[g.id,g.revision,g.enabled,
        this.store.get('SELECT authorization_revision FROM principals WHERE id=?',g.principal_id)?.authorization_revision,
        this.store.get('SELECT authorization_revision FROM principals WHERE id=?',g.maintainer_id)?.authorization_revision,roleConfiguration(this.store,g.project_id).revision,
        visible.includes(g.project_id)])}));
  }
  private async businessMessage(row:Row,e:ChannelEvent,chat:Row):Promise<void> {
    const personal=e.chat_type==='p2p',actor=personal?await this.actor(e):undefined;
    if(actor)this.employees.personalOwner(chat.id,e,actor);
    const grants:Row[]=personal?this.management.service.projects(actor!).map(project_id=>({project_id,role_id:this.employees.personalRole(chat.id,project_id)})):
      this.store.all('SELECT * FROM channel_employee_grants WHERE chat_id=? AND enabled=1',chat.id);
    const content=e.content.trim().replace(/^\/chat\s+/,''),selection=/^\/project (\S+)(?:\s+([\s\S]*))?$/.exec(content);
    const previous=this.store.get('SELECT project_id FROM role_conversations WHERE id=?',chat.id)?.project_id;
    const project=selection?.[1]??(grants.length===1?grants[0]!.project_id:grants.some(g=>g.project_id===previous)?previous:null);
    if(!project){if(e.addressed)this.queue(e,card('请明确本次操作的项目：'+(personal?'/chat ':'')+'/project <项目ID> <请求>。可用项目：'+(grants.map(g=>g.project_id).join('、')||'尚无已授权项目')),row.id+':project',row.id);this.store.run("UPDATE channel_inbox SET state='completed',conversation_id=? WHERE id=?",chat.id,row.id);return;}
    const grant=grants.find(g=>g.project_id===project);if(!grant)return fail(403,'channel_employee_project_required');
    if(!e.addressed&&grant.participation!=='all'&&!(grant.participation==='questions'&&/[?？]\s*$/.test(content))){this.store.run("UPDATE channel_inbox SET state='completed',conversation_id=? WHERE id=?",chat.id,row.id);return;}
    const privateActor=personal?await this.actor(e,project):undefined;
    const caller=privateActor?roleTaskCaller(this.store,project,grant!.role_id,{actor:privateActor,conversation_id:chat.id,source_message:row.id,guard:()=>this.employees.guardPersonal(chat.id,privateActor.principal_id,row.id)}):this.employees.caller(chat.id,project,row.id);
    const message=(this.ledger.query(chat.id,{message_id:e.message_id}).messages as Json[])[0];
    if(!message||message.sensitive||message.deleted)fail(403,'channel_sensitive_message');
    const fence=()=>this.businessFence(chat),projects=this.employees.visibleProjects(chat.id);
    const fixed=fence(),guard=()=>{if(this.stopped)fail(409,'channel_stopped');if(personal)this.employees.guardPersonal(chat.id,caller.principal_id!,row.id);else this.employees.assertGrant(grant!);if(fence()!==fixed)fail(409,'conversation_source_changed');};
    const summary=():Json=>{
      const saved=this.store.get('SELECT * FROM channel_chat_summaries WHERE chat_id=?',chat.id);
      if(!saved||JSON.parse(saved.sources).authorization_fence!==fixed)return {state:'not_compacted',notice:'摘要尚未建立；可检索本地原文。'};
      return {...this.store.secrets.open(saved.payload,'channel-summary:'+chat.id),sources:JSON.parse(saved.sources),through_time:saved.through_time,through_id:saved.through_id,authority:'derived; inspect original messages'};
    };
    const recent=this.ledger.recent(chat.id,40,projects,fixed),saved=summary(),boundary=recent[0],older=boundary?this.ledger.before(chat.id,boundary,saved.through_id?{message_id:saved.through_id,created_at:saved.through_time}:undefined,projects,fixed):[];
    // Model context is bounded; original local evidence remains available in explicit chunks.
    const excerpt=(m:Json,limit:number):Json=>{const {resources,...rest}=m;return {...rest,content:String(m.content??'').slice(0,limit),
      truncated:String(m.content??'').length>limit,resource_references_available:!!resources};};
    this.store.run('UPDATE channel_inbox SET conversation_id=? WHERE id=?',chat.id,row.id);
    const result=await this.conversations.run({id:chat.id,source_message:row.id,caller,request:selection?.[2]??content,allowSilence:!e.addressed,fence,guard,
      context:()=>({recent_messages:recent.map(m=>excerpt(m,3000)),history:this.ledger.diagnostics(chat.id),
        authorized_projects:grants.filter(g=>projects.includes(g.project_id)).map(g=>({project_id:g.project_id,role:g.role_id})),
        tasks:caller.permissions?.task_management==='none'?{state:'task_management_disabled'}:this.management.service.tasks.tool(caller,'list_managed_tasks',{})}),
      query:args=>{guard();const result=this.ledger.query(chat.id,args,projects,fixed);return {...result,messages:(result.messages as Json[]).map(m=>excerpt(m,2000))};},
      read:args=>{
        guard();const part=text(args.part??'content'),offset=Number(args.offset??0),limit=Number(args.limit??4000);
        if(args.offset!==undefined&&typeof args.offset!=='number'||args.limit!==undefined&&typeof args.limit!=='number'||!['content','resources'].includes(part)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>8000)return fail(400,'invalid_message_chunk');
        const found=(this.ledger.query(chat.id,{message_id:text(args.message_id),limit:1},projects,fixed).messages as Json[])[0];
        if(!found)return {state:'not_found_locally',notice:'No implicit provider fetch.'};
        const value=part==='content'?String(found.content??''):JSON.stringify(found.resources??[]);
        return {...excerpt(found,0),part,offset,text:value.slice(offset,offset+limit),next_offset:offset+limit<value.length?offset+limit:null,total_characters:value.length};
      },summary,
      ...(older.length?{compact:{input:{prior_summary:saved,messages:older.map(m=>excerpt(m,3000)),sync:this.ledger.diagnostics(chat.id)},commit:(text:string)=>{
        guard();const through=older.at(-1)!;this.store.run(`INSERT INTO channel_chat_summaries VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,
          authorization_revision=excluded.authorization_revision,through_time=excluded.through_time,through_id=excluded.through_id,sources=excluded.sources,payload=excluded.payload`,
          chat.id,this.store.get('SELECT context_revision FROM channel_chats WHERE id=?',chat.id)!.context_revision,caller.authorization_revision??0,Number(through.created_at),String(through.message_id),
          JSON.stringify({authorization_fence:fixed,first_message:older[0]!.message_id,through_message:through.message_id,truncated_messages:older.filter(m=>String(m.content??'').length>3000).map(m=>m.message_id),range_hash:digest(JSON.stringify(older.map(m=>[m.message_id,m.updated_at])))}),
          this.store.secrets.seal({summary:text},'channel-summary:'+chat.id));
      }}}:{})});
    guard(); if(result.message.trim())this.queue(e,card(result.message,this.url()),row.id+':business-result',row.id,{kind:personal?'personal_conversation':'employee',chat_id:chat.id,project_id:project,principal_id:caller.principal_id,
      grant_id:grant!.id??null,grant_revision:grant!.revision??null,source_message:row.id,source_fence:fixed,turn_id:result.id});
    this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?",row.id);
  }
  private async result(row: Row): Promise<void> {
    const m = this.store.get('SELECT state FROM management_messages WHERE id=?', row.message_id);
    if (!m || ['pending', 'running'].includes(m.state)) return;
    const e = this.store.secrets.open(row.payload, 'channel-event:' + row.id) as unknown as ChannelEvent;
    const session = this.store.get('SELECT * FROM channel_sessions WHERE conversation_id=? AND connector_id=? AND actor_id=? AND actor_tenant=? AND chat_id=?', row.conversation_id, e.connector_id, e.actor_id, e.actor_tenant, e.chat_id)!;
    const actor = await this.actor(e, session.project_id);
    const history = this.management.history(actor, row.conversation_id), events = (history.events as any[]).filter(v => v.message_id === row.message_id);
    const operations = this.store.all('SELECT id,state FROM management_commands WHERE source_conversation=? AND source_message=?', row.conversation_id, 'feishu:' + row.id);
    const summary = '管理消息 ' + row.message_id + '：' + m.state + '\n会话 ' + row.conversation_id +
      operations.map(o => '\noperation ' + o.id + '：' + o.state).join('');
    const receipts = operations.map(o => this.management.service.read(actor, o.id));
    // Put durable receipts and version diffs first, before a potentially large query observation.
    const details = JSON.stringify(traceClean({ operations: receipts, events }), null, 2);
    const protection = { principal_id: actor.principal_id, project_id: session.project_id, authorization_revision: actor.authorization_revision };
    let groupDetails = false;
    if (e.chat_type === 'group') { this.groupScope(e, session.project_id); try { this.groupScope(e, session.project_id, 'result'); groupDetails = true; } catch { /* Details go to the authenticated operator's DM. */ } }
    let token: string | undefined;
    if (operations.length === 1) {
      const operation = this.management.service.read(actor, operations[0]!.id); token = randomId();
      this.store.run('INSERT INTO channel_cards VALUES(?,?,?,?,?,?,?,?,NULL)', digest(token), e.connector_id, actor.principal_id,
        this.store.secrets.seal({...e,content:'',raw_content:''}, 'channel-card:' + digest(token)), session.project_id, String(operation.id), parameterHash(operation), Date.now() + 10 * 60_000);
    }
    let publicSummary = summary;
    if (e.chat_type === 'group' && !groupDetails) {
      const fields = JSON.parse(this.groupScope(e, session.project_id).fields) as string[];
      publicSummary = '管理请求已处理。' + (fields.includes('status') ? '\n管理消息：' + m.state : '') +
        (fields.includes('operation') ? '\n会话 ' + row.conversation_id + operations.map(o => '\noperation ' + o.id).join('') : '');
      if (!fields.includes('operation') || !fields.includes('status')) token = undefined;
    }
    const requiredFields = e.chat_type === 'group' && !groupDetails ? (JSON.parse(this.groupScope(e, session.project_id).fields) as string[]).filter(f => ['summary', 'status', 'operation'].includes(f)) : [];
    this.queue(e, card(publicSummary + (e.chat_type === 'p2p' || groupDetails ? '\n' + details : '\n详细结果请查看本人私聊或登录后台。'), this.url(), token), row.id + ':result', row.id, { ...protection, field: groupDetails ? 'result' : 'summary', required_fields: requiredFields });
    if (e.chat_type === 'group' && !groupDetails) this.queue(e, card(summary + '\n' + details, this.url()), row.id + ':private', row.id, protection, false, true);
    this.store.run("UPDATE channel_inbox SET state=? WHERE id=?", m.state === 'completed' ? 'completed' : 'failed', row.id);
  }
  private async refreshCard(row: Row, click: ChannelEvent): Promise<void> {
    const c = this.store.get('SELECT * FROM channel_cards WHERE token_hash=?', digest(click.card_token ?? ''));
    if (!c || c.connector_id !== click.connector_id || c.used_at || c.expires_at <= Date.now()) fail(409, 'channel_card_stale');
    const original = this.store.secrets.open(c!.subject, 'channel-card:' + c!.token_hash) as unknown as ChannelEvent;
    if (['app_id', 'installation_tenant', 'actor_tenant', 'actor_id', 'chat_id'].some(k => original[k as keyof ChannelEvent] !== click[k as keyof ChannelEvent])) fail(403, 'channel_card_operator_mismatch');
    const actor = await this.actor(original, c!.project_id);
    if (actor.principal_id !== c!.principal_id) fail(403, 'channel_card_operator_mismatch');
    if (original.chat_type === 'group') this.groupScope(original, c!.project_id);
    if (original.chat_type === 'group') { this.groupScope(original, c!.project_id, 'operation'); this.groupScope(original, c!.project_id, 'status'); }
    const sent = this.store.all("SELECT payload,id FROM channel_outbox WHERE connector_id=? AND remote_message_id=? AND state='sent'", click.connector_id, click.message_id)
      .some(o => JSON.stringify(this.store.secrets.open(o.payload, 'channel-outbox:' + o.id).delivery).includes(String(click.card_token)));
    if (!sent) fail(403, 'channel_card_message_mismatch');
    const operation = this.management.service.read(actor, c!.operation_id);
    if (parameterHash(operation) !== c!.operation_version) fail(409, 'channel_card_stale');
    // This card only refreshes an existing receipt. Writes and approvals use ManagementService contracts.
    this.store.run('UPDATE channel_cards SET used_at=? WHERE token_hash=? AND used_at IS NULL', Date.now(), c!.token_hash);
    this.queue(original, card('operation ' + operation.id + '：' + operation.state, this.url()), row.id + ':refresh', row.id,
      { principal_id: actor.principal_id, project_id: c!.project_id, authorization_revision: actor.authorization_revision, field: 'operation', required_fields: ['operation', 'status'] }, false, false, click.message_id);
    this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id);
  }
  private async deliver(row: Row): Promise<void> {
    const { event, delivery, protection } = this.store.secrets.open(row.payload, 'channel-outbox:' + row.id) as any;
    const c = this.source(event);
    if(['employee','personal_conversation'].includes(protection?.kind)){
      const guard=()=>{
        this.source(event);if(this.stopped)fail(409,'channel_stopped');
        if(protection.kind==='personal_conversation')this.employees.guardPersonal(protection.chat_id,protection.principal_id,protection.source_message);
        else{const grant=this.store.get('SELECT * FROM channel_employee_grants WHERE id=?',protection.grant_id);
          if(!grant||grant.chat_id!==protection.chat_id||grant.project_id!==protection.project_id||grant.principal_id!==protection.principal_id||grant.revision!==protection.grant_revision)fail(403,'channel_employee_source_mismatch');
          this.employees.assertGrant(grant!);if(!protection.task_id)this.employees.caller(grant!.chat_id,grant!.project_id,protection.source_message);}
        if(protection.task_id){const task=this.store.get('SELECT * FROM tasks WHERE id=?',protection.task_id);if(!task)fail(404,'task_not_found');this.resultAuthority(task!);}
        if(protection.source_fence&&this.businessFence(this.store.get('SELECT * FROM channel_chats WHERE id=?',protection.chat_id)!)!==protection.source_fence)fail(409,'conversation_source_changed');
        if(protection.turn_id){const turn=this.store.get('SELECT * FROM role_conversation_turns WHERE id=?',protection.turn_id);
          if(turn?.state!=='completed'||turn.fence!==protection.source_fence||this.businessFence(this.store.get('SELECT * FROM channel_chats WHERE id=?',protection.chat_id)!)!==turn.fence)fail(409,'conversation_source_changed');}
      };
      guard();const remote=await this.adapter(c,guard).send(delivery,digest(row.id));
      if(!this.stopped)this.store.transaction(()=>{this.store.run("UPDATE channel_outbox SET state='sent',last_error=NULL,remote_message_id=? WHERE id=?",remote,row.id);
        const chat=this.store.get('SELECT * FROM channel_chats WHERE id=?',protection.chat_id)!;
        const content=String(delivery.content.elements?.[0]?.text?.content??'');
        this.ledger.merge(chat,{message_id:remote,sender_id:c.bot_open_id,sender_tenant:c.installation_tenant,sender_type:'app',message_type:'interactive',content,raw_content:JSON.stringify(delivery.content),created_at:Date.now(),updated_at:Date.now(),parent_id:event.message_id,root_id:'',thread_id:event.thread_id,deleted:false},'live');
        this.store.run('INSERT OR REPLACE INTO channel_message_scopes VALUES(?,?,?,?)',chat.id,remote,protection.project_id,protection.source_fence);
      });return;
    }
    const actor = protection ? await this.actor(event, protection.project_id) : undefined;
    const guard = () => {
      const current = this.source(event);
      if (this.stopped || current.credential_ref !== c.credential_ref) fail(403, 'channel_connector_changed');
      if (protection && actor) {
        assertCurrent(actor);
        if (actor.principal_id !== protection.principal_id || protection.authorization_revision && actor.authorization_revision !== protection.authorization_revision) fail(403, 'authorization_changed');
        this.management.service.scope(actor, protection.project_id);
        if (event.chat_type === 'group' && delivery.receive_id_type === 'chat_id') {
          this.groupScope(event, protection.project_id, protection.field ?? 'summary');
          for (const field of protection.required_fields ?? []) this.groupScope(event, protection.project_id, field);
        }
      }
    };
    guard();
    const adapter = this.adapter(c, guard), remote = delivery.message_id ? await adapter.update(delivery) : await adapter.send(delivery, digest(row.id));
    if (!this.stopped) this.store.run("UPDATE channel_outbox SET state='sent',last_error=NULL,remote_message_id=? WHERE id=?", remote, row.id);
  }
  async tick(): Promise<void> {
    if (this.stopped || this.busy) return; this.busy = true;
    try {
      for (const row of this.store.all("SELECT * FROM channel_inbox WHERE state IN ('queued','submitted') ORDER BY created_at,rowid LIMIT 50")) {
        if (this.stopped) return;
        try {
          if (row.state === 'submitted') await this.result(row);
          else { this.store.run("UPDATE channel_inbox SET state='running' WHERE id=?", row.id); await this.process(row); }
        } catch (error) {
          if (this.stopped) return;
          this.store.run("UPDATE channel_inbox SET state='failed',error=? WHERE id=?", errorCode(error), row.id);
          // Stable public diagnostics never contain request contents, project data or credentials.
          const e = this.store.secrets.open(row.payload, 'channel-event:' + row.id) as unknown as ChannelEvent;
          try { this.source(e); this.queue(e, card('未执行或无法展示：' + errorCode(error) + '。请登录后台检查；绑定需在私聊发起。', this.url()), row.id + ':error', row.id); } catch { /* An uninstalled connector cannot send. */ }
        }
      }
      for (const row of this.store.all("SELECT * FROM channel_outbox WHERE state IN ('queued','retry') AND next_attempt<=? ORDER BY created_at LIMIT 20", Date.now())) {
        if (this.stopped) return;
        this.store.run("UPDATE channel_outbox SET state='sending',attempts=attempts+1 WHERE id=?", row.id);
        try { await this.deliver(row); } catch (error) {
          if (this.stopped) return;
          const retry = error instanceof HttpError && error.status >= 500 && row.attempts < 4;
          this.store.run('UPDATE channel_outbox SET state=?,last_error=?,next_attempt=? WHERE id=?', retry ? 'retry' : 'failed', errorCode(error), Date.now() + 1000 * 2 ** Math.min(row.attempts, 6), row.id);
          this.store.run('UPDATE channel_connectors SET last_error=? WHERE id=?', errorCode(error), row.connector_id);
        }
      }
      // Notification only: tasks are created/claimed/run by the existing task service and engine.
      // The outbox key is the receipt for each result revision, including across process restarts.
      for(const event of this.store.all('SELECT * FROM channel_task_results WHERE id>(SELECT sequence FROM channel_result_cursor WHERE id=1) ORDER BY id LIMIT 50')){
        try{this.store.transaction(()=>{
        const task=this.store.get(`SELECT t.*,o.conversation_id,o.principal_id,o.source_message FROM tasks t JOIN task_origins o ON o.task_id=t.id
          JOIN channel_chats c ON c.id=o.conversation_id WHERE t.id=? AND c.state='active' AND t.status IN ('completed','succeeded','pr_opened','cancelled','failed')`,event.task_id);
        try{
        if(!task)return;
        const key='task-result:'+task.id+':'+digest(JSON.stringify([task.status,task.result,task.error_code,this.store.get('SELECT revision FROM task_records WHERE task_id=?',task.id)?.revision]));
        if(this.store.get('SELECT 1 FROM channel_outbox WHERE idempotency_key=?',key))return;
          this.resultAuthority(task);
          const chat=this.store.get('SELECT * FROM channel_chats WHERE id=?',task.conversation_id)!,receipt=this.store.get('SELECT payload FROM channel_inbox WHERE id=?',task.source_message);
          if(!receipt)return;const original=this.store.secrets.open(receipt.payload,'channel-event:'+task.source_message) as unknown as ChannelEvent,c=this.connector(chat.connector_id);
          const event={...original,connector_id:c.id,connector_revision:c.revision};let protection:Json={kind:'personal_conversation',chat_id:chat.id,project_id:task.repository_id,principal_id:task.principal_id,source_message:task.source_message,task_id:task.id,source_fence:this.businessFence(chat)};
          if(chat.chat_type==='group'){const grant=this.store.get('SELECT * FROM channel_employee_grants WHERE chat_id=? AND project_id=? AND principal_id=?',chat.id,task.repository_id,task.principal_id);if(!grant)return;
            this.employees.assertGrant(grant);protection={...protection,kind:'employee',grant_id:grant.id,grant_revision:grant.revision};}
          let summary='';try{const result=JSON.parse(task.result??'null');summary=String(result?.summary??result?.report?.summary??result?.pr_url??'');}catch{}
          this.queue(event,card(`任务 ${task.id}\n状态：${task.status}\n${summary||task.summary}${task.error_code?'\n原因：'+task.error_code:''}`, (this.options.origin??'')+'/#/board'),key,task.source_message,protection);
        }catch(error){if(!(error instanceof HttpError||error instanceof TaskError))throw error;/* Withdrawn authority cannot disclose a result. */}
        finally{this.store.run('UPDATE channel_result_cursor SET sequence=? WHERE id=1',event.id);}
        });}catch{break;/* Queue failure rolls back the cursor; the next tick retries the same event. */}
      }
    } finally { this.busy = false; }
  }
  private resultAuthority(task:Row):void{
    assertManagedExecution(this.store,task);
    for(const instance of this.store.all('SELECT role,source_fence FROM role_instances WHERE task_id=?',task.id))
      if(instance.source_fence&&instance.source_fence!==taskAuthorizationFence(this.store,task,instance.role))fail(403,'task_result_authority_changed');
  }
}
