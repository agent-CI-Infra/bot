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

const errorCode = (error: unknown) => error instanceof HttpError ? error.code : 'channel_processing_failed';
const card = (value: string, link?: string, token?: string): Json => ({ config: { wide_screen_mode: true },
  elements: [{ tag: 'div', text: { tag: 'plain_text', content: value.slice(0, 12000) } },
    ...(link ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '登录后台查看' }, url: link },
      ...(token ? [{ tag: 'button', text: { tag: 'plain_text', content: '刷新执行状态' }, value: { token } }] : [])] }] : [])] });
export interface ChannelOptions { origin?: string; fetch?: ChannelFetch; longConnections?: boolean; }
/** Transport work only: this queue does not schedule future notifications (#166). */
export class ChannelService {
  readonly bindings: ChannelBindings;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  constructor(readonly store: Store, readonly management: ManagementAgent, readonly options: ChannelOptions = {}) {
    this.bindings = new ChannelBindings(store, e => this.source(e));
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
    this.timer = setInterval(() => { void this.tick(); }, 100); this.timer.unref();
  }
  close(): void { this.stopped = true; clearInterval(this.timer); }
  connector(id: string): Row {
    const c = this.store.get('SELECT * FROM channel_connectors WHERE id=? AND enabled=1', id);
    if (!c) return fail(403, 'channel_connector_inactive'); return c;
  }
  source(e: ChannelEvent): Row {
    const c = this.connector(e.connector_id);
    if (e.connector_revision !== c.revision) fail(403, 'channel_configuration_changed');
    if (c.provider !== e.provider || c.app_id !== e.app_id || c.installation_tenant !== e.installation_tenant ||
      e.actor_tenant && !(JSON.parse(c.actor_tenants) as string[]).includes(e.actor_tenant)) fail(403, 'channel_source_mismatch');
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
    if (event.kind === 'message' && (!Number.isFinite(event.created_at) || Math.abs(Date.now() - event.created_at) > 300_000)) return { state: 'ignored', reason: 'channel_message_stale' };
    const id = randomId();
    this.store.transaction(() => {
      this.store.run('INSERT INTO channel_inbox(id,connector_id,event_id,dedup_key,payload,state,created_at) VALUES(?,?,?,?,?,?,?)',
        id, c.id, event.event_id, event.kind === 'message' ? 'message:' + event.message_id : event.kind + ':' + event.event_id,
        this.store.secrets.seal(event, 'channel-event:' + id), 'queued', Date.now());
      this.store.run('UPDATE channel_connectors SET last_received_at=?,last_error=NULL WHERE id=?', Date.now(), c.id);
      // Revocation and audience invalidation are cheap security facts, applied before acknowledgement.
      if (event.kind === 'uninstalled') this.store.run('UPDATE channel_connectors SET enabled=0,revision=revision+1 WHERE id=?', c.id);
      if (event.kind === 'audience_changed') this.store.run('UPDATE channel_group_scopes SET audience_verified_until=0,revision=revision+1 WHERE connector_id=? AND chat_id=?', c.id, event.chat_id);
    });
    return { operation_id: id, state: 'queued' };
  }
  async actor(e: ChannelEvent, project?: string): Promise<ActorContext> {
    const c = this.source(e);
    return this.bindings.identities.resolveExternalActor(this.bindings.credential(e), c.tenant_id, project, () => {
      this.source(e); if (project && e.chat_type === 'group') this.groupScope(e, project);
    });
  }
  groupScope(e: ChannelEvent, project: string, field = 'summary'): Row {
    const c = this.source(e), p = this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project);
    if (!p || p.tenant_id !== c.tenant_id) return fail(403, 'channel_project_tenant_mismatch');
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
    // Future delivery must be registered by #166. Queueing never claims it was sent.
    const id = this.queue(e, card('通知已入队，尚未发送。', this.url()), 'notification:' + digest(JSON.stringify([actor.principal_id, project, e.connector_id, e.actor_tenant, e.chat_id, key])), undefined, { principal_id: actor.principal_id, project_id: project }, true);
    return { operation_id: id, state: 'registered', sent: false };
  }
  private queue(e: ChannelEvent, content: Json, key: string, source?: string, protection?: Json, registered = false, direct = false, update?: string): string {
    const previous = this.store.get('SELECT id FROM channel_outbox WHERE idempotency_key=?', key); if (previous) return previous.id;
    const id = randomId(), delivery: ChannelDelivery = { receive_id: direct ? e.actor_id : e.chat_id, receive_id_type: direct ? 'open_id' : 'chat_id', content, ...(update ? { message_id: update } : {}) };
    this.store.run('INSERT INTO channel_outbox(id,connector_id,idempotency_key,source_event,payload,state,next_attempt,created_at) VALUES(?,?,?,?,?,?,?,?)', id, e.connector_id, key, source ?? null,
      this.store.secrets.seal({ event: e, delivery, protection }, 'channel-outbox:' + id), registered ? 'registered' : 'queued', Date.now(), Date.now());
    return id;
  }
  private async process(row: Row): Promise<void> {
    const e = this.store.secrets.open(row.payload, 'channel-event:' + row.id) as unknown as ChannelEvent;
    if (['uninstalled', 'audience_changed'].includes(e.kind)) { this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id); return; }
    this.source(e);
    if (e.kind === 'card') { await this.refreshCard(row, e); return; }
    const content = e.content.trim();
    const reply = (message: string, link?: string) => this.queue(e, card(message, link), row.id + ':reply', row.id);
    if (['绑定', '/bind', '重新认证', '/reauth'].includes(content)) {
      if (!this.options.origin) fail(503, 'channel_admin_origin_required');
      const binding = this.bindings.begin(e);
      reply('请在五分钟内打开后台完成 GitHub 登录，然后回到同一私聊确认。绑定不会授予项目权限。', this.options.origin + '/auth/channels/start?challenge=' + binding.challenge);
    } else if (/^(确认绑定|\/confirm) /.test(content)) {
      await this.bindings.confirm(e, content.slice(content.indexOf(' ') + 1).trim()); reply('双端身份绑定成功。项目权限仍由统一授权服务决定。');
    } else if (['解绑', '/unbind'].includes(content)) {
      await this.bindings.unlink(e); reply('已解绑。后续消息和旧卡片将重新检查当前身份。');
    } else if (['身份', '/identity'].includes(content)) {
      if (e.chat_type !== 'p2p') fail(403, 'binding_private_chat_required');
      const principal = await this.bindings.identities.resolveExternalPrincipal(this.bindings.credential(e));
      reply(principal ? '此飞书身份已绑定。授权与绑定列表请登录后台身份页查看；发送“重新认证”可重新证明双端。' : '尚未绑定。请发送“绑定”。');
    } else {
      const selection = /^\/project ([^\s]+)(?:\s+([\s\S]*))?$/.exec(content);
      if (!selection) { reply('请显式选择项目：/project <项目ID> <管理请求>。绑定请在私聊发送“绑定”。'); this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id); return; }
      const project = selection[1]!, request = selection[2] ?? '', actor = await this.actor(e, project);
      this.management.service.scope(actor, project);
      if (e.chat_type === 'group') this.groupScope(e, project);
      const linked = /^\/link ([a-f0-9]{48})$/.exec(request);
      if (linked) { this.link(actor, e, project, linked[1]!); reply('已显式关联本人同一项目的管理会话。'); }
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
        this.store.secrets.seal(e, 'channel-card:' + digest(token)), session.project_id, String(operation.id), parameterHash(operation), Date.now() + 10 * 60_000);
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
    } finally { this.busy = false; }
  }
}
