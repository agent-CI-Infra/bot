import { TaskRecords } from '../tasks/service.js';
import type { IncomingHttpHeaders } from 'node:http';
import type { Store, Row } from '../storage/database.js';
import { assertCurrent, authorize, confineActor, confinedTenant, resolvePrincipalActor, restrictActor, type ActorContext } from '../identity/authorization.js';
import { digest, fail, fields, HttpError, object, randomId, text, type Json } from '../core/security.js';
import { ManagementAgent } from '../management/agent.js';
import { managementFailure, managementStates, serviceFailure } from '../management/presentation.js';
import { commands } from '../management/catalog.js';
import { managementAssistant, serviceRole } from '../service-roles/roles.js';
import { ChannelBindings, externalSubject } from './binding.js';
import { FeishuAdapter, type ChannelFetch } from './feishu.js';
import type { ChannelDelivery, ChannelEvent } from './types.js';
import { ChannelLedger } from './ledger.js';
import { ChannelHistorySync } from './history-sync.js';
import { ChannelEmployees } from './employees.js';
import { bindingScope, ChannelServiceBindings } from './service-bindings.js';
import { ChannelServiceSessions } from './service-session.js';
import { ChannelSchedules } from './schedules.js';
import { roleConfiguration } from '../roles/definition.js';
import { assertManagedExecution, taskAuthorizationFence } from '../tasks/management.js';
import type { Manager } from '../projects/service.js';
import { TaskError } from '../agent/common.js';
import { ChannelReactions } from './reactions.js';
import { ChannelMedia, MediaTurn } from './media.js';
import { markdownPosts } from './format.js';
import { assistantMessage, ChannelTurnMessages } from './turn-messages.js';
import { ChannelMembers } from './members.js';

const errorCode = (error: unknown) => error instanceof HttpError || error instanceof TaskError ? error.code : 'channel_processing_failed';
const card = (value: string, link?: string, token?: string): Json => ({ config: { wide_screen_mode: true },
  elements: [{ tag: 'div', text: { tag: 'plain_text', content: value } },
    ...(link ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '登录后台查看' }, url: link },
      ...(token ? [{ tag: 'button', text: { tag: 'plain_text', content: '刷新执行状态' }, value: { token } }] : [])] }] : [])] });
export interface ChannelOptions { origin?: string; fetch?: ChannelFetch; longConnections?: boolean; manager?: Manager; githubUrl?: string; }
/** Transport replies and authorized destination registration. Durable scheduling lives in schedules/. */
export class ChannelService {
  readonly bindings: ChannelBindings;
  readonly ledger: ChannelLedger;
  readonly media: ChannelMedia;
  readonly historySync: ChannelHistorySync;
  readonly employees: ChannelEmployees;
  readonly serviceBindings: ChannelServiceBindings;
  readonly serviceSessions: ChannelServiceSessions;
  readonly reactions: ChannelReactions;
  readonly schedules: ChannelSchedules;
  readonly turnMessages: ChannelTurnMessages;
  readonly members: ChannelMembers;
  private readonly business = new Map<string,Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  constructor(readonly store: Store, readonly management: ManagementAgent, readonly options: ChannelOptions = {}) {
    this.bindings = new ChannelBindings(store, e => this.source(e));
    this.ledger = new ChannelLedger(store);
    this.media = new ChannelMedia(store,this.ledger,(chat,guard)=>this.adapter(this.connector(chat.connector_id),guard));
    this.reactions = new ChannelReactions(store, (c, guard) => this.adapter(c, guard), e => this.source(e));
    this.employees = new ChannelEmployees(store, (c, guard) => this.adapter(c, guard));
    this.serviceBindings = new ChannelServiceBindings(store, this.employees);
    this.serviceSessions = new ChannelServiceSessions(store, this.serviceBindings, this.ledger, management.service, options.githubUrl,this.media);
    this.turnMessages = new ChannelTurnMessages(store);
    this.members = new ChannelMembers(store, (c, guard) => this.adapter(c, guard));
    this.serviceSessions.members = this.members;
    management.incomingHistory = id => this.turnMessages.history(id);
    const senderName = (chat: Row) => { const name = this.members.namer(chat); return (event: ChannelEvent) => name({ id: event.actor_id, tenant: event.actor_tenant }); };
    this.serviceSessions.incomingMessages = (turn,id) => this.turnMessages.open(turn.chat,id,turn.chat.id,turn.source_message,{
      needsReply: event => this.needsReply(event,turn.binding), guard: (row,event) => { this.source(event);this.employees.currentMessage(turn.chat,event); },
      senderName: event => senderName(turn.chat)(event), request: turn.event });
    management.incomingMessages = (actor,conversation,input,id) => {
      const source=store.get('SELECT * FROM channel_inbox WHERE id=? AND conversation_id=?',String(input.source_message).replace(/^feishu:/,''),conversation);
      if(!source||!input.content)return;
      const event=this.turnMessages.event(source),chat=store.get('SELECT * FROM channel_chats WHERE id=?',source.chat_ref);
      if(!chat||event.chat_type!=='p2p')return;
      void this.members.resolve(chat,[{id:event.actor_id,tenant:event.actor_tenant}],0);
      return this.turnMessages.open(chat,id,conversation,source.id,{needsReply:()=>true,guard:(row,event)=>{
        this.source(event);this.employees.guardPersonal(chat.id,actor.principal_id,row.id);
        if(row.context_revision!==null&&row.context_revision!==chat.context_revision)fail(409,'conversation_source_changed');
      },senderName:event=>senderName(chat)(event),request:event});
    };
    this.schedules = new ChannelSchedules(store, this);
    // Tasks a group delegated are linked to it when created, and stop once that group may no longer delegate there.
    this.employees.bindingGuard = origin => this.serviceBindings.guardTask(origin);
    management.service.taskCreated = (command, task) => this.serviceBindings.linkTask(command, task);
    // A group's computer (#457) is bound to its fence; a changed fence or a binding no longer usable removes it at once.
    management.service.assistants?.resolve('group', row => {
      const binding = this.serviceBindings.active(row.subject); if (!binding) return null;
      this.serviceBindings.assertUsable(binding); return this.serviceBindings.fence(row.subject);
    });
    this.historySync = new ChannelHistorySync(store, this.ledger, (c, guard) => this.adapter(c, guard), chat => this.syncGuard(chat));
    management.sourceGuard=(actor,conversation)=>{
      const source=store.get('SELECT * FROM channel_inbox WHERE conversation_id=? AND context_revision IS NOT NULL ORDER BY rowid DESC LIMIT 1',conversation);
      if(!source)return;
      const e=store.secrets.open(source.payload,'channel-event:'+source.id) as unknown as ChannelEvent;
      this.source(e);
      const chat=store.get('SELECT * FROM channel_chats WHERE connector_id=? AND chat_id=?',e.connector_id,e.chat_id);
      if(!chat||chat.context_revision!==source.context_revision)fail(409,'conversation_source_changed');
      this.employees.guardPersonal(chat!.id,actor.principal_id,source.id);
    };
    management.mediaTurn=(actor,conversation,input,computers,guard)=>{
      const source=store.get('SELECT * FROM channel_inbox WHERE id=? AND conversation_id=?',String(input.source_message).replace(/^feishu:/,''),conversation);
      if(!source)return;
      const event=store.secrets.open(source.payload,'channel-event:'+source.id) as unknown as ChannelEvent;
      const chat=store.get('SELECT * FROM channel_chats WHERE connector_id=? AND chat_id=?',event.connector_id,event.chat_id);
      if(!chat||event.chat_type!=='p2p')return;
      const fence=digest(JSON.stringify([actor.principal_id,actor.authorization_revision,chat.context_revision,event.connector_revision]));
      return new MediaTurn(this.media,chat.id,event.message_id,()=>{guard();this.source(event);this.employees.guardPersonal(chat.id,actor.principal_id,source.id);},computers,
        project=>{this.management.service.scope(actor,project);},undefined,fence);
    };
    // A progress message of the management assistant (#435) goes to the private chat or timer that started the turn, under
    // the same protection as its final answer; a console conversation only shows it in its event stream.
    management.stageMessage=(actor,conversation,input,message,text,sequence)=>{
      const source=String(input.source_message);
      if(source.startsWith('schedule:'))return this.schedules.personalStage(source.slice(9),actor,message,text,sequence);
      const row=store.get('SELECT * FROM channel_inbox WHERE id=? AND conversation_id=?',source.replace(/^feishu:/,''),conversation);
      if(!row)return;
      const e=store.secrets.open(row.payload,'channel-event:'+row.id) as unknown as ChannelEvent;
      const chat=store.get('SELECT * FROM channel_chats WHERE connector_id=? AND chat_id=?',e.connector_id,e.chat_id);
      if(!chat||e.chat_type!=='p2p')return;
      this.source(e);this.employees.guardPersonal(chat.id,actor.principal_id,row.id);
      if(row.context_revision!==chat.context_revision)fail(409,'conversation_source_changed');
      return this.queue(e,card(text),row.id+':stage:'+sequence,row.id,{principal_id:actor.principal_id,authorization_revision:actor.authorization_revision,
        personal_chat:chat.id,context_revision:chat.context_revision,source_message:row.id,management_message:message,stage:sequence});
    };
    management.service.sourceGuard = command => {
      if (command.channel !== 'im') return;
      // A group's command runs as its binding's principal: the console binding, not the speaker, is its authority.
      const binding = store.get('SELECT * FROM channel_service_bindings WHERE principal_id=?', command.principal_id);
      const source = store.get(`SELECT * FROM channel_inbox WHERE conversation_id=? AND ${binding ? '' : 'message_id IS NOT NULL AND '}id=?`,
        command.source_conversation, String(command.source_message).replace(/^feishu:/, ''));
      // A group's timer run (#330) is its source the way a message is: the run must be live and belong to this group.
      const run = String(command.source_message).replace(/^feishu:/, '');
      if (binding && !source && run.startsWith('schedule:')) { this.schedules.sourceOfCommand(command, run.slice(9)); this.serviceBindings.guardCommand(binding, command); return; }
      if (!source) fail(403, 'channel_command_source_required');
      const e = store.secrets.open(source!.payload, 'channel-event:' + source!.id) as unknown as ChannelEvent;
      this.source(e);
      if (binding) { this.serviceBindings.guardCommand(binding, command, e); return; }
      const subject = externalSubject(e);
      if (!store.get("SELECT 1 FROM external_identities WHERE principal_id=? AND provider=? AND host=? AND connector=? AND external_tenant=? AND external_actor=? AND status='active'",
        command.principal_id, subject.provider, subject.host, subject.connector, subject.external_tenant, subject.external_actor)) fail(403, 'external_binding_required');
      // Groups submit commands only through their service binding (above); the /project group path was retired (#312).
      if (e.chat_type === 'group') fail(403, 'channel_group_command_retired');
      else {
        const chat=store.get('SELECT id FROM channel_chats WHERE connector_id=? AND chat_id=?',e.connector_id,e.chat_id);
        if(chat&&store.get('SELECT 1 FROM channel_personal_owners WHERE chat_id=?',chat.id))this.employees.guardPersonal(chat.id,command.principal_id,source!.id);
        if(source!.context_revision!==null&&store.get('SELECT context_revision FROM channel_chats WHERE id=?',chat?.id)?.context_revision!==source!.context_revision)fail(409,'conversation_source_changed');
      }
    };
    // An interrupted model turn must be inspected in Web, never submitted again on restart.
    store.run("UPDATE channel_inbox SET state='failed',error='interrupted_check_operation' WHERE state='running'");
    store.run("UPDATE channel_outbox SET state='retry',last_error='delivery_interrupted' WHERE state='sending'");
  }
  start(): void {
    for (const chat of this.store.all("SELECT h.id FROM channel_chats h JOIN channel_connectors c ON c.id=h.connector_id WHERE h.state='active' AND c.enabled=1 AND c.app_id=h.app_id AND c.installation_tenant=h.installation_tenant")) this.ledger.resync(chat.id);
    this.timer = setInterval(() => { void this.tick(); }, 100); this.timer.unref();
    this.syncTimer = setInterval(() => { void this.historySync.tick().catch(() => {}); void this.employees.tick().catch(() => {}); void this.schedules.tick().catch(() => {}); }, 1000); this.syncTimer.unref();
  }
  close(): void { this.stopped = true; this.schedules.close(); this.reactions.close(); this.serviceSessions.stop(); this.historySync.close(); this.employees.close(); clearInterval(this.timer); clearInterval(this.syncTimer); }
  async drain():Promise<void>{await Promise.allSettled([...this.business.values(),this.reactions.drain(),this.schedules.drain()]);}
  /** Console readers of a chat's local history: platform managers, its binding's managers, the personal owner or a legacy maintainer. */
  authorizeHistory(actor:ActorContext,id:string):void{
    if(this.serviceBindings.canView(actor,id))return;
    this.employees.authorizeHistory(actor,id);
  }
  /** Console history is authorized once for the whole chat; execution keeps its own source and scope guards. */
  authorizeConversation(actor: ActorContext, id: string): Row {
    assertCurrent(actor);
    const chat = this.store.get('SELECT * FROM channel_chats WHERE id=?', id);
    if (!chat) return fail(404, 'channel_chat_not_found');
    try { authorize(actor, 'platform.manage'); return chat; }
    catch (error) { if (!(error instanceof HttpError) || error.code !== 'capability_forbidden') throw error; }
    if (chat.chat_type === 'p2p' && !this.store.get('SELECT 1 FROM channel_personal_owners WHERE chat_id=? AND principal_id=?', id, actor.principal_id))
      fail(403, 'channel_history_forbidden');
    if (chat.chat_type === 'group' && this.serviceBindings.get(id)) {
      if (!this.serviceBindings.canView(actor, id)) fail(403, 'channel_history_forbidden');
      return chat;
    }
    this.authorizeHistory(actor, id);
    return chat;
  }
  /** Ledger scopes for assistant execution and tools; console history uses whole-conversation authorization. */
  visibleScopes(id:string,actor:ActorContext):string[]{
    const binding=this.serviceBindings.canView(actor,id);
    return [...this.employees.visibleProjects(id,actor),...(binding?[bindingScope(binding.id)]:[])];
  }
  private syncGuard(chat:Row):void{
    // A bound group keeps importing history while its binding is enabled; before any binding the app's visible range decides.
    const binding=this.serviceBindings.get(chat.id);
    if(binding){if(!binding.enabled)fail(403,'channel_service_binding_disabled');return;}
    this.employees.guardSync(chat);
  }
  personalReply(actor:ActorContext,message:Row):string{
    const reply=this.store.get("SELECT data FROM management_events WHERE message_id=? AND type='reply' ORDER BY sequence DESC LIMIT 1",message.id);
    const error=this.store.get("SELECT data FROM management_events WHERE message_id=? AND type='error' ORDER BY sequence DESC LIMIT 1",message.id);
    const operations=this.store.all('SELECT * FROM management_commands WHERE source_conversation=? AND source_message=? ORDER BY created_at',message.conversation_id,message.source_message);
    const receipts=operations.map(op=>{
      const receipt=this.management.service.read(actor,op.id),target=receipt.target as Json;
      const project=this.management.service.scope(actor,op.project_id),task=target.task_id?this.store.get('SELECT summary FROM tasks WHERE id=? AND repository_id=?',String(target.task_id),op.project_id):null;
      return `${project.full_name}${task?' · '+task.summary:''}：${commands[op.operation]?.description??op.operation}\n${managementStates[String(receipt.state)]??receipt.state}${(receipt.result as Json)?.error?'；'+managementFailure(String((receipt.result as Json).error)):''}`;
    });
    // A model's completion claim cannot override a pending, failed or uncertain receipt.
    const answer=reply&&!operations.some(op=>op.state!=='succeeded')?JSON.parse(reply.data).text:'';
    return [...receipts,answer,error?managementFailure(JSON.parse(error.data).error):''].filter(Boolean).join('\n\n')||managementStates[message.state]||'请求已记录，请在控制台查看进展。';
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
    const participation=event.chat_type==='group'?this.store.get(`SELECT b.participation FROM channel_service_bindings b JOIN channel_chats h ON h.id=b.chat_id WHERE h.provider=? AND h.app_id=? AND h.installation_tenant=? AND h.chat_id=? AND b.enabled=1`,
      event.provider,event.app_id,event.installation_tenant,event.chat_id)?.participation as string|undefined:undefined;
    const ambient=participation==='all'||participation==='questions'&&/[?？]\s*$/.test(event.content);
    const actionable = event.kind !== 'message' || (event.addressed||ambient) && event.sender_type === 'user' && Math.abs(Date.now() - event.created_at) <= 300_000;
    // The processing indicator acknowledges a call: a private message, or a group message that @-mentions the bot, in every
    // working mode. A group message without an @ never gets one, even when the assistant follows every message or every
    // question or takes the message into a running turn, so the bot never marks people's conversation.
    const indicates = event.kind === 'message' && actionable && (event.chat_type !== 'group' || !!event.addressed);
    const id = randomId(); let state = actionable ? 'queued' : 'completed', merged: Row | undefined;
    this.store.transaction(() => {
      this.store.run('INSERT INTO channel_inbox(id,connector_id,event_id,dedup_key,payload,state,created_at) VALUES(?,?,?,?,?,?,?)',
        id, c.id, event.event_id, event.kind === 'message' ? 'message:' + event.message_id : event.kind + ':' + event.event_id,
        this.store.secrets.seal(event, 'channel-event:' + id), state, Date.now());
      const chat=this.ledger.accept(event);
      if(chat){
        this.store.run('UPDATE channel_inbox SET chat_ref=? WHERE id=?',chat.id,id);
        if(assistantMessage(event)&&this.turnMessages.merge(chat.id,this.store.get('SELECT * FROM channel_inbox WHERE id=?',id)!,!!actionable)){state='merged';merged=chat;}
      }
      // A merged message keeps its indicator until the turn's final answer is delivered (see ChannelReactions.wanted).
      if (indicates)
        this.store.run("INSERT INTO channel_reactions(source_event,state) VALUES(?,'pending')", id);
      if (['audience_changed', 'bot_removed', 'chat_archived', 'uninstalled'].includes(event.kind)) {
        for (const chat of this.store.all(`SELECT id FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? ${event.chat_id ? 'AND chat_id=?' : ''}`,
          event.provider, event.app_id, event.installation_tenant, ...(event.chat_id ? [event.chat_id] : []))) { this.employees.invalidate(chat.id, event.kind); this.members.stale(chat.id); }
      }
      this.store.run('UPDATE channel_connectors SET last_received_at=?,last_error=NULL WHERE id=?', Date.now(), c.id);
      // Revocation and audience invalidation are cheap security facts, applied before acknowledgement.
      if (event.kind === 'uninstalled') {
        this.store.run('UPDATE channel_connectors SET enabled=0,revision=revision+1 WHERE id=?', c.id);
        this.store.run("UPDATE channel_sync_jobs SET state='paused',lease_token=NULL,lease_until=0,last_error='app_uninstalled' WHERE chat_id IN (SELECT id FROM channel_chats WHERE connector_id=?)", c.id);
        this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id IN (SELECT id FROM channel_chats WHERE connector_id=?)', c.id);
        this.members.forgetConnector(c.id);
      }
    });
    // The merged sender's name is looked up in the background, ready for the turn's next model step.
    if (merged) void this.members.resolve(merged, [{ id: event.actor_id, tenant: event.actor_tenant }], 0);
    return { operation_id: id, state };
  }
  async actor(e: ChannelEvent): Promise<ActorContext> {
    const c = this.source(e);
    // The connection supplies only a verified identity; projects are chosen per request by the management assistant.
    const actor = await this.bindings.identities.resolveExternalActor(this.bindings.credential(e), null, undefined, () => { this.source(e); });
    // An organization's app carries its users' authority only inside that organization (#424).
    return c.owner_tenant ? confineActor(actor, c.owner_tenant) : actor;
  }
  /** A private chat's owner, with the authority the chat's app lets them use (see actor), for work without a live message. */
  personalActor(principal: string, chat: Row, channel: ActorContext['channel']): ActorContext {
    const actor = resolvePrincipalActor(this.store, principal, null, undefined, channel), owner = this.applicationTenant(chat);
    return owner ? confineActor(actor, owner) : actor;
  }
  /** The organization a chat's app belongs to, or '' for a platform-wide app. */
  applicationTenant(chat: Row): string { return String(this.store.get('SELECT owner_tenant FROM channel_connectors WHERE id=?', chat.connector_id)?.owner_tenant ?? ''); }
  /** An organization's app carries only that organization's projects, to a private chat as to a group (#424). */
  assertApplicationProject(chat: Row, project: string): void {
    const owner = this.applicationTenant(chat);
    if (owner && this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', project)?.tenant_id !== owner) fail(403, 'channel_application_scope_forbidden');
  }
  /** The management conversation scope of a private chat: the whole platform, or the app's organization for a confined actor. */
  personalScope(actor: ActorContext): string { const tenant = confinedTenant(actor); return tenant ? 'tenant:' + tenant : 'platform'; }
  /** The bound user's personal management session in a private chat. */
  private session(actor: ActorContext, e: ChannelEvent): Row {
    const keys = [e.connector_id, e.installation_tenant, e.actor_tenant, e.actor_id, e.chat_id, '', '', actor.principal_id];
    const row = this.store.get(`SELECT * FROM channel_sessions WHERE connector_id=? AND installation_tenant=? AND actor_tenant=? AND actor_id=? AND chat_id=? AND thread_id=? AND project_id=? AND principal_id=?`, ...keys);
    if (row) return row;
    const conversation = (this.management.create(actor, { scope: this.personalScope(actor) }).conversation as Json).id, id = randomId();
    this.store.run('INSERT INTO channel_sessions(id,connector_id,installation_tenant,actor_tenant,actor_id,chat_id,thread_id,project_id,principal_id,conversation_id) VALUES(?,?,?,?,?,?,?,?,?,?)', id, ...keys, String(conversation));
    this.store.run('UPDATE channel_sessions SET context_revision=(SELECT context_revision FROM channel_chats WHERE connector_id=? AND chat_id=?),connector_revision=? WHERE id=?',e.connector_id,e.chat_id,e.connector_revision,id);
    return this.store.get('SELECT * FROM channel_sessions WHERE id=?', id)!;
  }
  private url(): string { return (this.options.origin ?? '') + '/#/management'; }
  /** A send-only source for a chat through its app's current connection: no message and no speaker. */
  chatEvent(chat: Row): ChannelEvent {
    const c = this.connector(chat.connector_id);
    return { provider: 'feishu', connector_id: c.id, connector_revision: c.revision, app_id: chat.app_id, installation_tenant: chat.installation_tenant, actor_tenant: '', actor_id: '',
      chat_id: chat.chat_id, chat_type: chat.chat_type, message_id: '', event_id: '', thread_id: '', created_at: Date.now(), kind: 'message', content: '' };
  }
  /** Queues a card to a chat once per key; the protection is checked again right before sending. */
  post(chat: Row, message: string, key: string, source: string, protection: Json): string { return this.queue(this.chatEvent(chat), card(message), key, source, protection); }
  chatBusy(chat: string): boolean { return this.business.has(chat); }
  /** Serializes turns, including timers; the active turn may absorb incoming messages before its final answer. */
  exclusive<T>(chat: string, work: () => Promise<T>): Promise<T> {
    if (this.business.has(chat)) return fail(409, 'channel_chat_busy');
    const result = work(), settled = result.then(() => {}, () => {}).finally(() => this.business.delete(chat));
    this.business.set(chat, settled); return result;
  }
  /** A project notification destination (#312): a private chat of its own bound owner, or a bound group a manager of its binding
   * may use for a project in its scope. Since #330 a project's schedule panel registers a chosen chat through this on save,
   * once per chat, project and registrant; schedules consume the sealed registration, which never proves delivery. */
  registerDestination(actor: ActorContext, id: string, input: Json): Json {
    fields(input, ['project_id']); assertCurrent(actor);
    const project = text(input.project_id), chat = this.employees.chat(id), c = this.connector(chat.connector_id);
    authorize(actor, 'schedules.manage', { project_id: project });
    this.assertApplicationProject(chat, project);
    const base = { provider: 'feishu' as const, connector_id: c.id, connector_revision: c.revision, app_id: chat.app_id, installation_tenant: chat.installation_tenant,
      chat_id: chat.chat_id, chat_type: chat.chat_type, message_id: '', event_id: '', thread_id: '', created_at: Date.now(), kind: 'message' as const, content: '' };
    let event: ChannelEvent, protection: Json;
    if (chat.chat_type === 'p2p') {
      const owner = this.store.get('SELECT * FROM channel_personal_owners WHERE chat_id=? AND principal_id=?', chat.id, actor.principal_id);
      if (!owner) return fail(403, 'channel_destination_forbidden');
      const identity = this.employees.feishuIdentity(chat, actor.principal_id, { actor: owner.actor_id, tenant: owner.actor_tenant });
      if (identity.external_actor !== owner.actor_id || identity.external_tenant !== owner.actor_tenant) fail(403, 'channel_destination_forbidden');
      authorize(actor, 'tasks.read', { project_id: project });
      event = { ...base, actor_tenant: owner.actor_tenant, actor_id: owner.actor_id };
      protection = { principal_id: actor.principal_id, project_id: project, chat_id: chat.id };
    } else {
      const binding = this.serviceBindings.canView(actor, chat.id);
      if (!binding?.enabled) return fail(403, 'channel_destination_forbidden');
      if (!this.serviceBindings.reachable(binding, project, ['tasks.read'])) fail(403, 'channel_service_scope_paused');
      event = { ...base, actor_tenant: '', actor_id: '' };
      protection = { principal_id: actor.principal_id, project_id: project, chat_id: chat.id, binding_id: binding.id };
    }
    // One registration per chat, project and registrant.
    const key = 'destination:' + digest(JSON.stringify([chat.id, project, actor.principal_id]));
    return this.store.transaction(() => {
      const existing = this.store.get('SELECT id FROM channel_outbox WHERE idempotency_key=?', key);
      const created = existing?.id ?? this.queue(event, card('通知目的地已登记，尚未发送。'), key, undefined, protection, true);
      if (!existing) this.store.audit(actor.principal_id, 'channel.destination.registered', created, project);
      return { id: created, chat_id: chat.id, chat_type: chat.chat_type, project_id: project };
    });
  }
  /** A group destination stays usable while the group's enabled binding still reaches the project. */
  groupDestination(e: ChannelEvent, project: string): void {
    const chat = this.store.get('SELECT id FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? AND chat_id=?', e.provider, e.app_id, e.installation_tenant, e.chat_id);
    const binding = chat && this.serviceBindings.active(chat.id);
    if (!binding) return fail(403, 'schedule_destination_binding_required');
    this.serviceBindings.assertUsable(binding);
    if (!this.serviceBindings.reachable(binding, project, ['tasks.read'])) fail(403, 'channel_service_scope_paused');
  }
  private queue(e: ChannelEvent, content: Json, key: string, source?: string, protection?: Json, registered = false, direct = false, update?: string, resources: string[] = [], replyTo = false): string {
    const previous = this.store.get('SELECT id FROM channel_outbox WHERE idempotency_key=?', key); if (previous) return previous.id;
    const id = randomId(), delivery: ChannelDelivery = { receive_id: direct ? e.actor_id : e.chat_id, receive_id_type: direct ? 'open_id' : 'chat_id', content, resources,format_version:2,
      ...(!direct&&(replyTo||e.thread_id)&&e.message_id?{reply_to:e.message_id,...(e.thread_id?{reply_in_thread:true}:{})}:{}),...(update ? { message_id: update } : {}) };
    this.store.run('INSERT INTO channel_outbox(id,connector_id,idempotency_key,source_event,payload,state,next_attempt,created_at) VALUES(?,?,?,?,?,?,?,?)', id, e.connector_id, key, source ?? null,
      this.store.secrets.seal({ event: {...e,content:'',raw_content:''}, delivery, protection }, 'channel-outbox:' + id), registered ? 'registered' : 'queued', Date.now(), Date.now());
    return id;
  }
  private async process(row: Row): Promise<void> {
    const e = this.store.secrets.open(row.payload, 'channel-event:' + row.id) as unknown as ChannelEvent;
    if (['uninstalled', 'audience_changed', 'message_recalled', 'bot_removed', 'chat_archived'].includes(e.kind)) { this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id); return; }
    this.source(e);
    if (e.kind === 'bot_added') {
      this.queue(e, card('机器人会在应用获准的可见范围内记录本群消息并同步历史，仅查询本地记录；平台不可见或未同步的内容会标明。群聊助手须由已绑定飞书、对相关仓库有配置权限的维护人在控制台「个人设置 → 飞书绑定」点击「创建群绑定」另行启用，并选择服务角色和项目范围。'), row.id + ':notice', row.id);
      this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id); return;
    }
    // Result cards no longer carry refresh actions; a click on an older card is answered as stale.
    if (e.kind === 'card') return fail(409, 'channel_card_stale');
    // No /chat or /project syntax (#312): anything else is natural language for the assistant.
    const content = (e.command_text ?? e.content).trim();
    const reply = (message: string, link?: string) => this.queue(e, card(message, link), row.id + ':reply', row.id);
    const consoleCode = /^(?:绑定|\/bind)\s+(FSB-[A-Za-z0-9]{8,})$/.exec(content);
    if (consoleCode) {
      // The console issued this code for the chosen bot; this private-chat message is the proof, so one message binds.
      await this.bindings.redeem(consoleCode[1]!, e);
      reply('双端身份绑定成功。这个飞书账号已绑定到你在控制台登录的平台账户；绑定本身不会增加项目权限。');
    } else if (['绑定', '/bind', '重新认证', '/reauth'].includes(content)) {
      const binding = this.bindings.begin(e);
      reply('飞书身份认证字符串（五分钟内有效，仅可使用一次）：\n' + binding.code + '\n请在控制台「个人设置 → 飞书绑定」选择本机器人，粘贴认证字符串，核对当前平台账户后确认绑定。请勿转发认证字符串。可使用本地账户或 GitHub 登录，绑定不会授予项目权限。' + (this.options.origin ? '\n也可打开下方链接，登录后回到原私聊确认。' : ''),
        this.options.origin ? this.options.origin + '/auth/channels/start?challenge=' + binding.challenge : undefined);
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
      // A bound group is served by its service role; legacy employees no longer receive messages.
      const binding = chat && e.chat_type==='group' ? this.serviceBindings.active(chat.id) : undefined;
      if(e.chat_type==='p2p'){
        if(!chat)return fail(403,'channel_chat_not_found');
        await this.personalMessage(row,e,chat,content);return;
      }
      if (binding && chat) {
        if (this.business.has(chat.id)) {
          if(!this.turnMessages.merge(chat.id,row,this.needsReply(e,binding)))this.store.run("UPDATE channel_inbox SET state='queued' WHERE id=?",row.id);
          else void this.members.resolve(chat,[{id:e.actor_id,tenant:e.actor_tenant}],0);
          return;
        }
        const work = this.serviceMessage(row,e,chat,binding).catch(error=>{
          const turn=this.store.get('SELECT id FROM channel_service_turns WHERE chat_id=? AND source_message=?',chat.id,row.id);
          if(turn)this.turnMessages.release(turn.id);
          if(this.stopped)return;
          this.store.run("UPDATE channel_inbox SET state='failed',error=? WHERE id=?",errorCode(error),row.id);
          try { this.source(e);this.queue(e,card(serviceFailure(errorCode(error),serviceRole(this.store,binding.service_role_id)?.name??'群助手')),row.id+':business-error',row.id); } catch {}
        }).finally(()=>this.business.delete(chat.id));
        this.business.set(chat.id,work);return;
      }
      reply('本群尚未绑定群聊助手。已绑定飞书的维护人可以在控制台「个人设置 → 飞书绑定」点击「创建群绑定」为本群选择服务角色和项目范围；个人绑定请在私聊发送“绑定”。');
    }
    this.store.run("UPDATE channel_inbox SET state='completed' WHERE id=?", row.id);
  }
  private async personalMessage(row:Row,e:ChannelEvent,chat:Row,content:string):Promise<void>{
    const actor=await this.actor(e);
    this.employees.personalOwner(chat.id,e,actor);
    // Through an organization's app a person without any project there has nothing to manage.
    if(confinedTenant(actor)&&!this.management.service.projects(actor).length)fail(403,'channel_application_tenant_forbidden');
    const revision=chat.context_revision;
    restrictActor(actor,()=>{
      if(this.stopped)fail(409,'channel_stopped');
      this.employees.guardPersonal(chat.id,actor.principal_id,row.id);
      if(this.store.get('SELECT context_revision FROM channel_chats WHERE id=?',chat.id)?.context_revision!==revision)fail(409,'conversation_source_changed');
    });
    let session=this.session(actor,e);
    if(this.store.get("SELECT 1 FROM management_messages WHERE conversation_id=? AND state IN ('pending','running')",session.conversation_id)){
      if(!this.turnMessages.merge(chat.id,row,true))this.store.run("UPDATE channel_inbox SET state='queued' WHERE id=?",row.id);
      else void this.members.resolve(chat,[{id:e.actor_id,tenant:e.actor_tenant}],0);
      return;
    }
    if(e.created_at<session.last_message_at)fail(409,'channel_message_out_of_order');
    if(session.context_revision!==revision||session.connector_revision!==e.connector_revision){
      // Edited, recalled or cleaned local sources must not return through old management context.
      const conversation=(this.management.create(actor,{scope:this.personalScope(actor)}).conversation as Json).id;
      this.store.run('UPDATE channel_sessions SET conversation_id=?,context_revision=?,connector_revision=? WHERE id=?',String(conversation),revision,e.connector_revision,session.id);
      session=this.store.get('SELECT * FROM channel_sessions WHERE id=?',session.id)!;
    }
    const request=content.length>14000?content.slice(0,14000)+'\n[长消息的其余内容保存在本地消息账本；请用 read_message_text 分页读取当前消息，不能只根据此节选回答。]':content;
    const message=this.management.send(actor,session.conversation_id,{content:request,source_message:'feishu:'+row.id});
    this.store.run('UPDATE channel_sessions SET last_message_at=? WHERE id=?',e.created_at,session.id);
    this.store.run("UPDATE channel_inbox SET state='submitted',conversation_id=?,message_id=?,context_revision=? WHERE id=?",session.conversation_id,String(message.id),revision,row.id);
  }
  private businessFence(chat:Row):string {
    // Source fence of legacy employee tasks' results; a private chat's legacy tasks use the same shape with no grants.
    const visible=this.employees.visibleProjects(chat.id);
    return digest(JSON.stringify({context:this.store.get('SELECT context_revision FROM channel_chats WHERE id=?',chat.id)?.context_revision,
      audience:this.store.get('SELECT revision FROM channel_audiences WHERE chat_id=?',chat.id)?.revision,
      grants:this.store.all('SELECT * FROM channel_employee_grants WHERE chat_id=? ORDER BY id',chat.id).map(g=>[g.id,g.revision,g.enabled,
        this.store.get('SELECT authorization_revision FROM principals WHERE id=?',g.principal_id)?.authorization_revision,
        this.store.get('SELECT authorization_revision FROM principals WHERE id=?',g.maintainer_id)?.authorization_revision,roleConfiguration(this.store,g.project_id).revision,
        visible.includes(g.project_id)])}));
  }
  /** One message in a bound group: participation decides whether to answer; the reply is protected by the turn's fence. */
  private needsReply(event:ChannelEvent,binding:Row):boolean {
    return !!event.addressed||binding.participation==='all'||binding.participation==='questions'&&/[?？]\s*$/.test(event.content.trim());
  }
  private async serviceMessage(row:Row,e:ChannelEvent,chat:Row,binding:Row):Promise<void> {
    const content=e.content.trim();
    if(!e.addressed&&binding.participation!=='all'&&!(binding.participation==='questions'&&/[?？]\s*$/.test(content))){this.store.run("UPDATE channel_inbox SET state='completed',conversation_id=? WHERE id=?",chat.id,row.id);return;}
    const message=(this.ledger.query(chat.id,{message_id:e.message_id}).messages as Json[])[0];
    if(!message||message.sensitive||message.deleted)fail(403,'channel_sensitive_message');
    this.store.run('UPDATE channel_inbox SET conversation_id=? WHERE id=?',chat.id,row.id);
    const protection=(fence:string,turn:string)=>({kind:'service_binding',chat_id:chat.id,binding_id:binding.id,binding_revision:binding.revision,source_message:row.id,source_fence:fence,turn_id:turn});
    // Progress messages (#435) go out while the turn runs, as replies to the same message; attachments only with the answer.
    const result=await this.serviceSessions.run({chat,binding,source_message:row.id,event:e,request:content,allowSilence:!e.addressed,
      stage:m=>this.queue(e,card(m.text),row.id+':stage:'+m.sequence,row.id,{...protection(m.fence,m.turn_id),stage:m.sequence})});
    const target=this.turnMessages.replyEvent(result.id);
    this.store.transaction(()=>{
      // An explicit stay_silent (#489) or an empty answer sends nothing.
      const outbox=!result.silent&&(result.message.trim()||result.attachments?.length)?this.queue(target??e,card(result.message),row.id+':business-result',row.id,{...protection(result.fence,result.id),resource_fence:result.fence},
        false,false,undefined,result.attachments,!!target):undefined;
      this.turnMessages.complete(result.id,outbox);
      this.store.run("UPDATE channel_inbox SET state='completed',message_id=? WHERE id=?",result.id,row.id);
    });
  }
  private async result(row: Row): Promise<void> {
    const m = this.store.get('SELECT state FROM management_messages WHERE id=?', row.message_id);
    if (!m || ['pending', 'running'].includes(m.state)) return;
    const e = this.store.secrets.open(row.payload, 'channel-event:' + row.id) as unknown as ChannelEvent;
    const session = this.store.get('SELECT * FROM channel_sessions WHERE conversation_id=? AND connector_id=? AND actor_id=? AND actor_tenant=? AND chat_id=?', row.conversation_id, e.connector_id, e.actor_id, e.actor_tenant, e.chat_id)!;
    const actor = await this.actor(e);
    if(session.project_id){this.store.run("UPDATE channel_inbox SET state='failed',error='channel_project_session_retired' WHERE id=?",row.id);return;}
    const chat=this.store.get('SELECT * FROM channel_chats WHERE connector_id=? AND chat_id=?',e.connector_id,e.chat_id)!;
    this.employees.guardPersonal(chat.id,actor.principal_id,row.id);
    const message=this.store.get('SELECT * FROM management_messages WHERE id=?',row.message_id)!;
    if(message.authorization_revision!==actor.authorization_revision||session.context_revision!==chat.context_revision)fail(409,'conversation_source_changed');
    const selected=this.store.get("SELECT data FROM management_events WHERE message_id=? AND type='attachments' ORDER BY sequence DESC LIMIT 1",row.message_id);
    const attachments=m.state==='completed'&&selected?JSON.parse(selected.data):{};
    const target=this.turnMessages.replyEvent(message.id);
    this.store.transaction(()=>{
      const outbox=this.queue(target??e,card(this.personalReply(actor,message),this.url()),row.id+':result',row.id,{principal_id:actor.principal_id,authorization_revision:actor.authorization_revision,
        personal_chat:chat.id,context_revision:chat.context_revision,source_message:row.id,management_message:message.id,resource_fence:attachments.fence??''},false,false,undefined,attachments.resource_ids??[],!!target);
      if(m.state==='completed')this.turnMessages.complete(message.id,outbox);
      this.store.run("UPDATE channel_inbox SET state=? WHERE id=?",m.state==='completed'?'completed':'failed',row.id);
    });
  }
  private async deliver(row: Row): Promise<void> {
    const { event, delivery, protection } = this.store.secrets.open(row.payload, 'channel-outbox:' + row.id) as any;
    const c = this.source(event);
    if(['employee','personal_conversation','service_binding','service_task','channel_schedule'].includes(protection?.kind)){
      const guard=()=>{
        this.source(event);if(this.stopped)fail(409,'channel_stopped');
        if(protection.kind==='channel_schedule'){this.schedules.guardDelivery(protection);return;}
        if(protection.kind==='service_task'){
          const binding=this.serviceBindings.get(protection.chat_id);
          if(!binding||binding.id!==protection.binding_id)fail(409,'conversation_source_changed');
          this.serviceBindings.assertUsable(binding!);
          if(!this.serviceBindings.reachable(binding!,protection.project_id,['tasks.read']))fail(403,'channel_service_scope_paused');
          const task=this.store.get('SELECT * FROM tasks WHERE id=?',protection.task_id);if(!task)fail(404,'task_not_found');this.resultAuthority(task!);
          return;
        }
        if(protection.kind==='service_binding'){
          const binding=this.serviceBindings.get(protection.chat_id);
          if(!binding||binding.id!==protection.binding_id||binding.revision!==protection.binding_revision)fail(409,'conversation_source_changed');
          this.serviceBindings.assertUsable(binding!);
          this.serviceTurnLive(protection);
          return;
        }
        if(protection.kind==='personal_conversation')this.employees.guardPersonal(protection.chat_id,protection.principal_id,protection.source_message);
        else{const grant=this.store.get('SELECT * FROM channel_employee_grants WHERE id=?',protection.grant_id);
          if(!grant||grant.chat_id!==protection.chat_id||grant.project_id!==protection.project_id||grant.principal_id!==protection.principal_id||grant.revision!==protection.grant_revision)fail(403,'channel_employee_source_mismatch');
          this.employees.assertGrant(grant!);if(!protection.task_id)this.employees.caller(grant!.chat_id,grant!.project_id,protection.source_message);}
        if(protection.task_id){const task=this.store.get('SELECT * FROM tasks WHERE id=?',protection.task_id);if(!task)fail(404,'task_not_found');this.resultAuthority(task!);}
        if(protection.source_fence&&this.businessFence(this.store.get('SELECT * FROM channel_chats WHERE id=?',protection.chat_id)!)!==protection.source_fence)fail(409,'conversation_source_changed');
        if(protection.turn_id){const turn=this.store.get('SELECT * FROM role_conversation_turns WHERE id=?',protection.turn_id);
          if(turn?.state!=='completed'||turn.fence!==protection.source_fence||this.businessFence(this.store.get('SELECT * FROM channel_chats WHERE id=?',protection.chat_id)!)!==turn.fence)fail(409,'conversation_source_changed');}
      };
      guard();const remote=await this.sendParts(row,event,delivery,protection,guard,(remote,part)=>{
        if(protection.kind==='channel_schedule'&&!protection.binding_id)return;
        const chat=this.store.get('SELECT * FROM channel_chats WHERE id=?',protection.chat_id)!;
        const content=part.message_type==='post'?String((part.content.zh_cn as any)?.content?.[0]?.[0]?.text??''):part.message_type==='image'?'[图片附件]':part.message_type==='file'?'[文件附件]':String((part.content.elements as any)?.[0]?.text?.content??'');
        this.ledger.merge(chat,{message_id:remote,sender_id:c.bot_open_id,sender_tenant:c.installation_tenant,sender_type:'app',message_type:part.message_type??'interactive',content,raw_content:JSON.stringify(part.content),created_at:Date.now(),updated_at:Date.now(),parent_id:event.message_id,root_id:event.root_id??'',thread_id:event.thread_id,deleted:false},'live');
        const fence=protection.kind==='service_task'?this.serviceBindings.fence(chat.id):protection.source_fence;
        this.store.run('INSERT OR REPLACE INTO channel_message_scopes VALUES(?,?,?,?)',chat.id,remote,['service_binding','service_task','channel_schedule'].includes(protection.kind)?bindingScope(protection.binding_id):protection.project_id,fence);
      });
      // A private timer's result is a personal reply: it is not part of any group's context.
      if(protection.kind==='channel_schedule'&&!protection.binding_id){if(!this.stopped)this.store.run("UPDATE channel_outbox SET state='sent',last_error=NULL,remote_message_id=? WHERE id=?",remote,row.id);return;}
      if(!this.stopped)this.store.run("UPDATE channel_outbox SET state='sent',last_error=NULL,remote_message_id=? WHERE id=?",remote,row.id);return;
    }
    const actor = protection ? await this.actor(event) : undefined;
    const guard = () => {
      const current = this.source(event);
      if (this.stopped || current.credential_ref !== c.credential_ref) fail(403, 'channel_connector_changed');
      if (protection && actor) {
        assertCurrent(actor);
        if (actor.principal_id !== protection.principal_id || protection.authorization_revision && actor.authorization_revision !== protection.authorization_revision) fail(403, 'authorization_changed');
        // A progress message (#435) is sent only while its management turn runs or after it completed, never once stopped.
        if (protection.stage) this.managementTurnLive(String(protection.management_message));
        if(protection.project_id)this.management.service.scope(actor, protection.project_id);
        if(protection.personal_chat){
          this.employees.guardPersonal(protection.personal_chat,actor.principal_id,protection.source_message);
          if(this.store.get('SELECT context_revision FROM channel_chats WHERE id=?',protection.personal_chat)?.context_revision!==protection.context_revision)fail(409,'conversation_source_changed');
        }
        // Protected group replies come only from service bindings now; an older queued project reply to a group is not sent.
        if (event.chat_type === 'group' && delivery.receive_id_type === 'chat_id') fail(403, 'channel_group_reply_retired');
      }
    };
    guard();
    const adapter = this.adapter(c, guard), remote = delivery.message_id ? await adapter.update(delivery) : await this.sendParts(row,event,delivery,protection,guard);
    if (!this.stopped) this.store.run("UPDATE channel_outbox SET state='sent',last_error=NULL,remote_message_id=? WHERE id=?", remote, row.id);
  }
  /** One durable receipt and UUID per text chunk/resource. Uploading again is safe; sending an unknown part outside its dedup window is not. */
  private async sendParts(row:Row,event:ChannelEvent,delivery:ChannelDelivery,protection:Json|undefined,guard:()=>void,record?:(remote:string,part:ChannelDelivery)=>void):Promise<string>{
    const store=this.store;
    if(!store.get('SELECT 1 FROM channel_outbox_parts WHERE outbox_id=?',row.id))store.transaction(()=>{
      const parts:{delivery:ChannelDelivery;resource_id?:string;legacy?:boolean}[]=[];
      const elements=delivery.content.elements as any[]|undefined;
      // A pre-upgrade send may already have reached Feishu with the old UUID and interactive payload.
      if(row.attempts>0&&delivery.format_version!==2){parts.push({delivery:{...delivery,resources:undefined,message_type:'interactive'},legacy:true});}
      else if(elements?.some(el=>el.tag==='action'&&el.actions?.some((a:any)=>a.value))){parts.push({delivery:{...delivery,resources:undefined,message_type:'interactive'}});}
      else{
        let value=String(elements?.[0]?.text?.content??'');
        for(const el of elements??[])for(const action of el.actions??[])if(typeof action.url==='string'&&/^https?:\/\//.test(action.url))value+='\n\n[登录后台查看]('+action.url+')';
        for(const content of markdownPosts(value,this.options.origin))parts.push({delivery:{...delivery,resources:undefined,content,message_type:'post'}});
      }
      for(const id of delivery.resources??[])parts.push({delivery:{...delivery,resources:undefined,content:{}},resource_id:id});
      parts.forEach((part,i)=>store.run('INSERT INTO channel_outbox_parts(outbox_id,part,payload,first_attempt) VALUES(?,?,?,?)',row.id,i,store.secrets.seal(part,'channel-outbox-part:'+row.id+':'+i),part.legacy?row.created_at:null));
    });
    let last='';
    for(const part of store.all('SELECT * FROM channel_outbox_parts WHERE outbox_id=? ORDER BY part',row.id)){
      if(part.state==='sent'){last=part.remote_id;continue;}
      guard();
      const payload=store.secrets.open(part.payload,'channel-outbox-part:'+row.id+':'+part.part) as any, next=payload.delivery as ChannelDelivery;
      const checkResource=()=>{
        guard();const resource=store.get('SELECT * FROM channel_resources WHERE id=?',payload.resource_id);
        const chat=resource&&store.get('SELECT * FROM channel_chats WHERE id=?',resource.chat_id);
        if(!resource||!chat||chat.connector_id!==event.connector_id||chat.chat_id!==event.chat_id||chat.app_id!==event.app_id||chat.installation_tenant!==event.installation_tenant)fail(403,'channel_resource_scope_changed');
        const message=store.get('SELECT deleted,sensitive FROM channel_messages WHERE chat_id=? AND message_id=?',resource!.chat_id,resource!.message_id);
        if(!message||message.deleted||message.sensitive)fail(403,'channel_resource_unavailable');
        if(resource!.kind==='artifact'&&resource!.fence!==protection?.resource_fence)fail(403,'channel_resource_scope_changed');
        if(resource!.project_id){
          if(event.chat_type==='group'){
            const binding=this.serviceBindings.active(chat!.id);if(!binding||!this.serviceBindings.reachable(binding,resource!.project_id,['tasks.read']))fail(403,'channel_resource_scope_changed');
          }else{
            const actor=this.personalActor(String(protection?.principal_id),chat!,'im');
            this.management.service.scope(actor,resource!.project_id);
          }
        }
        if(event.chat_type==='group'){
          const scopes=protection?.binding_id?[bindingScope(String(protection.binding_id))]:[];
          if(!(this.ledger.query(chat!.id,{message_id:resource!.message_id,limit:1},scopes,String(protection?.source_fence??'')).messages as Json[]).length)fail(403,'channel_resource_scope_changed');
        }
        return resource!;
      };
      if(payload.resource_id){
        const resource=checkResource();
        if(!next.message_type){
          const file=await this.media.bytes(resource,()=>{checkResource();});
          const key=await this.adapter(this.source(event),()=>{checkResource();}).upload(file.data,file.name,file.mime,file.image);
          checkResource();next.message_type=file.image?'image':'file';next.content={ [file.image?'image_key':'file_key']:key };
          store.run('UPDATE channel_outbox_parts SET payload=? WHERE outbox_id=? AND part=?',store.secrets.seal(payload,'channel-outbox-part:'+row.id+':'+part.part),row.id,part.part);
        }
      }
      // Feishu's UUID only deduplicates for one hour. After that, an unknown send needs human reconciliation, never a fresh UUID.
      if(part.first_attempt&&Date.now()-part.first_attempt>55*60_000)fail(409,'channel_delivery_unknown');
      store.run("UPDATE channel_outbox_parts SET state='sending',first_attempt=coalesce(first_attempt,?) WHERE outbox_id=? AND part=?",Date.now(),row.id,part.part);
      const check=()=>{guard();if(payload.resource_id)checkResource();};
      last=await this.adapter(this.source(event),check).send(next,digest(payload.legacy?row.id:row.id+':'+part.part));
      if(this.stopped)fail(409,'channel_stopped');
      store.transaction(()=>{
        store.run("UPDATE channel_outbox_parts SET state='sent',remote_id=? WHERE outbox_id=? AND part=?",last,row.id,part.part);
        record?.(last,next);
      });
    }
    return last;
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    void this.reactions.tick().catch(() => {});
    if (this.busy) return; this.busy = true;
    try {
      for (const row of this.store.all("SELECT * FROM channel_inbox WHERE state IN ('queued','submitted') ORDER BY created_at,rowid LIMIT 50")) {
        if (this.stopped) return;
        // Opening a turn may have claimed later rows from this snapshot already.
        if(this.store.get('SELECT state FROM channel_inbox WHERE id=?',row.id)?.state!==row.state)continue;
        try {
          if (row.state === 'submitted') await this.result(row);
          else { this.store.run("UPDATE channel_inbox SET state='running' WHERE id=?", row.id); await this.process(row); }
        } catch (error) {
          if (this.stopped) return;
          if(row.state==='submitted')this.turnMessages.release(row.message_id);
          this.store.run("UPDATE channel_inbox SET state='failed',error=? WHERE id=?", errorCode(error), row.id);
          // Stable public diagnostics never contain request contents, project data or credentials.
          const e = this.store.secrets.open(row.payload, 'channel-event:' + row.id) as unknown as ChannelEvent;
          try { this.source(e); this.queue(e, card(e.chat_type==='p2p'?managementFailure(errorCode(error)):'未执行或无法展示：' + errorCode(error) + '。请登录后台检查；绑定需在私聊发起。', this.url()), row.id + ':error', row.id); } catch { /* An uninstalled connector cannot send. */ }
        }
      }
      for (const row of this.store.all("SELECT * FROM channel_outbox WHERE state IN ('queued','retry') AND next_attempt<=? ORDER BY created_at LIMIT 20", Date.now())) {
        if (this.stopped) return;
        this.store.run("UPDATE channel_outbox SET state='sending',attempts=attempts+1 WHERE id=?", row.id);
        try { await this.deliver(row); } catch (error) {
          if (this.stopped) return;
          const resultEvent=this.store.get('SELECT * FROM channel_task_results WHERE outbox_id=?',row.id);
          const retry = resultEvent ? this.retryResult(error) : error instanceof HttpError && error.status >= 500 && row.attempts < 4;
          if(resultEvent)this.resultFailure(resultEvent,error,!retry,'delivery');
          this.store.run('UPDATE channel_outbox SET state=?,last_error=?,next_attempt=? WHERE id=?', retry ? 'retry' : 'failed', errorCode(error), Date.now() + 1000 * 2 ** Math.min(row.attempts, 6), row.id);
          this.store.run('UPDATE channel_connectors SET last_error=? WHERE id=?', errorCode(error), row.connector_id);
          if(!retry){
            const payload=this.store.secrets.open(row.payload,'channel-outbox:'+row.id) as any;
            // A changed source can invalidate a completed draft before its first delivery. Return its unanswered inputs,
            // but never auto-repeat a final answer that already has a confirmed sent part.
            const turn=payload.protection?.turn_id??payload.protection?.management_message;
            if(turn&&!payload.protection?.stage&&/changed|inactive|mismatch|revoked|forbidden|stopped|unavailable/.test(errorCode(error))&&
              !this.store.get("SELECT 1 FROM channel_outbox_parts WHERE outbox_id=? AND state='sent'",row.id))this.turnMessages.release(turn,true);
            if(payload.delivery.resources?.length){
              const code=errorCode(error),notice=code==='channel_resource_permission_required'?'附件未全部送达。请管理员在控制台飞书连接设置中补齐图片与文件权限，并在飞书发布生效后重新请求发送。'
                :code==='channel_delivery_unknown'?'部分消息或附件的送达结果无法确认，自动重发已停止。请管理员核对原会话与控制台的逐项发送记录，避免重复发送。'
                :code==='channel_resource_too_large'?'附件超过大小限制：接收最多 20 MiB，发送图片最多 10 MiB、文件最多 30 MiB。已确认送达的部分会保留，请缩小附件后重新请求。'
                :'附件发送未全部确认；已确认送达的部分会保留。请先核对原会话和控制台发送记录，再处理剩余附件，避免重复发送。';
              this.queue(payload.event,card(notice),row.id+':delivery-notice',row.source_event,payload.protection);
            }
          }
        }
      }
      this.processTaskResults();
    } finally { this.busy = false; }
  }
  /** Pending results have independent retry clocks; a failing old result never blocks later cards. */
  private processTaskResults():void {
    for(const event of this.store.all("SELECT * FROM channel_task_results WHERE id>(SELECT sequence FROM channel_result_cursor WHERE id=1) AND state='pending' AND next_attempt<=? ORDER BY id LIMIT 50",Date.now())){
      try{this.store.transaction(()=>{
        const outbox=this.queueTaskResult(event);
        this.store.run('UPDATE channel_task_results SET state=?,outbox_id=?,last_error=NULL WHERE id=?',outbox?'queued':'suppressed',outbox??null,event.id);
        if(!outbox)this.resultHistory(event,'suppressed','task_result_destination_unavailable','queue');
      });}catch(error){
        try{this.resultFailure(event,error,!this.retryResult(error),'queue');}
        catch{console.error('channel_result_failure_record_failed',{task_id:event.task_id,result_id:event.id,error_code:errorCode(error)});break;}
      }
    }
    // The cursor denotes terminal results, not just attempted enqueue operations. The per-result state lets later
    // deliveries continue while an earlier one retries, and survives restart without repeating a confirmed send.
    this.store.transaction(()=>{
      this.store.run("UPDATE channel_task_results SET state='delivered' WHERE state='queued' AND outbox_id IN (SELECT id FROM channel_outbox WHERE state='sent')");
      this.store.run("UPDATE channel_task_results SET state='suppressed' WHERE state='queued' AND outbox_id IN (SELECT id FROM channel_outbox WHERE state='failed')");
      this.store.run(`UPDATE channel_result_cursor SET sequence=max(sequence,coalesce(
        (SELECT min(id)-1 FROM channel_task_results WHERE id>sequence AND state IN ('pending','queued')),
        (SELECT max(id) FROM channel_task_results),sequence)) WHERE id=1`);
    });
  }
  private retryResult(error:unknown):boolean {
    if(error instanceof HttpError)return [408,425,429].includes(error.status)||error.status>=500;
    if(error instanceof TaskError)return !/authority_changed|source_changed|revoked|forbidden|scope_paused|inactive|not_found|delivery_unknown/.test(error.code);
    return true; // Transport and local storage faults are retryable; never silently discard an unclassified failure.
  }
  private resultFailure(event:Row,error:unknown,terminal:boolean,phase:string):void {
    const code=errorCode(error);
    if(phase==='queue')this.store.run('UPDATE channel_task_results SET state=?,attempts=attempts+1,last_error=?,next_attempt=? WHERE id=?',terminal?'suppressed':'pending',code,Date.now()+Math.min(300000,1000*2**Math.min(event.attempts,9)),event.id);
    this.resultHistory(event,terminal?'suppressed':'retry',code,phase);
  }
  private resultHistory(event:Row,state:string,code:string,phase:string):void {
    const destination=this.store.get(`SELECT c.id,c.connector_id FROM channel_chats c WHERE c.id=coalesce(
      (SELECT chat_id FROM channel_service_tasks WHERE task_id=?),(SELECT conversation_id FROM task_origins WHERE task_id=?))`,event.task_id,event.task_id);
    new TaskRecords(this.store).history(event.task_id,'channel_result_delivery',{result_id:event.id,task_id:event.task_id,channel:destination?.id??null,connector_id:destination?.connector_id??null,state,error_code:code,phase,
      message:state==='retry'?'结果投递失败，稍后重试':code==='task_result_authority_changed'?'结果未投递：权限已变化':code==='task_result_destination_unavailable'?'结果未投递：目标或权限不可用':'结果未投递：'+code+'（已停止自动重试）'});
  }
  private queueTaskResult(event:Row):string|undefined {
    const link=this.store.get('SELECT * FROM channel_service_tasks WHERE task_id=?',event.task_id);
    if(link)return this.serviceTaskResult(link);
    const task=this.store.get(`SELECT t.*,o.conversation_id,o.principal_id,o.source_message FROM tasks t JOIN task_origins o ON o.task_id=t.id
      JOIN channel_chats c ON c.id=o.conversation_id WHERE t.id=? AND c.state='active' AND t.status IN ('completed','succeeded','pr_opened','cancelled','failed')`,event.task_id);
    if(!task)return;
    const key='task-result:'+task.id+':'+digest(JSON.stringify([task.status,task.result,task.error_code,this.store.get('SELECT revision FROM task_records WHERE task_id=?',task.id)?.revision]));
    const existing=this.store.get('SELECT id FROM channel_outbox WHERE idempotency_key=?',key);if(existing)return existing.id;
    this.resultAuthority(task);
    const chat=this.store.get('SELECT * FROM channel_chats WHERE id=?',task.conversation_id)!,receipt=this.store.get('SELECT payload FROM channel_inbox WHERE id=?',task.source_message);
    if(!receipt)return;
    const original=this.store.secrets.open(receipt.payload,'channel-event:'+task.source_message) as unknown as ChannelEvent,c=this.connector(chat.connector_id);
    const source={...original,connector_id:c.id,connector_revision:c.revision};
    let protection:Json={kind:'personal_conversation',chat_id:chat.id,project_id:task.repository_id,principal_id:task.principal_id,source_message:task.source_message,task_id:task.id,source_fence:this.businessFence(chat)};
    if(chat.chat_type==='group'){
      const grant=this.store.get('SELECT * FROM channel_employee_grants WHERE chat_id=? AND project_id=? AND principal_id=?',chat.id,task.repository_id,task.principal_id);if(!grant)return;
      this.employees.assertGrant(grant);protection={...protection,kind:'employee',grant_id:grant.id,grant_revision:grant.revision};
    }
    let summary='';try{const result=JSON.parse(task.result??'null');summary=String(result?.summary??result?.report?.summary??result?.pr_url??'');}catch{}
    return this.queue(source,card(`任务 ${task.id}\n状态：${task.status}\n${summary||task.summary}${task.error_code?'\n原因：'+task.error_code:''}`,(this.options.origin??'')+'/#/board'),key,task.source_message,protection);
  }
  /** A task a group delegated reports back to that group, only while the binding may still see its repository. */
  private serviceTaskResult(link:Row):string|undefined{
    const task=this.store.get("SELECT * FROM tasks WHERE id=? AND status IN ('completed','succeeded','pr_opened','cancelled','failed')",link.task_id);
    const chat=this.store.get("SELECT * FROM channel_chats WHERE id=? AND state='active'",link.chat_id);
    if(!task||!chat)return;
    const key='service-task-result:'+task.id+':'+digest(JSON.stringify([task.status,task.result,task.error_code,this.store.get('SELECT revision FROM task_records WHERE task_id=?',task.id)?.revision]));
    const existing=this.store.get('SELECT id FROM channel_outbox WHERE idempotency_key=?',key);if(existing)return existing.id;
    const binding=this.serviceBindings.get(chat.id);
    if(!binding||binding.id!==link.binding_id)return;
    this.serviceBindings.assertUsable(binding);
    if(!this.serviceBindings.reachable(binding,task.repository_id,['tasks.read']))return;
    this.resultAuthority(task);
    // A task a group's timer delegated (#330) has no source message; its result goes to the same group.
    const receipt=this.store.get('SELECT payload FROM channel_inbox WHERE id=?',link.source_message);if(!receipt&&!String(link.source_message).startsWith('schedule:'))return;
    const original=receipt?this.store.secrets.open(receipt.payload,'channel-event:'+link.source_message) as unknown as ChannelEvent:this.chatEvent(chat),c=this.connector(chat.connector_id);
    const name=this.store.get('SELECT full_name FROM repositories WHERE id=?',task.repository_id)?.full_name??task.repository_id;
    const state=({completed:'已完成',succeeded:'已完成',pr_opened:'已提交 PR',cancelled:'已取消',failed:'失败'} as Record<string,string>)[task.status]??task.status;
    let summary='';try{const result=JSON.parse(task.result??'null');summary=String(result?.summary??result?.report?.summary??result?.pr_url??'');}catch{}
    return this.queue({...original,connector_id:c.id,connector_revision:c.revision},card(`${name} 的任务「${task.summary}」${state}${summary?'\n'+summary:''}${task.error_code?'\n原因：'+task.error_code:''}`,(this.options.origin??'')+'/#/board'),
      key,link.source_message,{kind:'service_task',chat_id:chat.id,binding_id:binding.id,project_id:task.repository_id,task_id:task.id,source_message:link.source_message});
  }
  /** A group turn's output may still be sent: its fence is current, and it completed (the answer) or still runs or completed
   * (a progress message, #435). Shared by message answers and group timers. */
  serviceTurnLive(protection:Json):void{
    const turn=this.store.get('SELECT state,fence FROM channel_service_turns WHERE id=?',String(protection.turn_id));
    if(!turn||turn.fence!==protection.source_fence||this.serviceBindings.fence(String(protection.chat_id))!==protection.source_fence)fail(409,'conversation_source_changed');
    if(protection.stage?!['running','completed'].includes(turn!.state):turn!.state!=='completed')fail(409,protection.stage?'conversation_turn_inactive':'conversation_source_changed');
  }
  /** A management turn's progress message is sent only while the turn runs or after it completed. */
  managementTurnLive(message:string):void{
    if(!['running','completed'].includes(String(this.store.get('SELECT state FROM management_messages WHERE id=?',message)?.state)))fail(409,'conversation_turn_inactive');
  }
  /** Stops a running group answer from the console (#435): for whoever may manage the group's binding (#424). */
  stopServiceTurn(actor:ActorContext,chat:string,turn:string):Json{
    assertCurrent(actor);
    const row=this.store.get('SELECT * FROM channel_service_turns WHERE id=? AND chat_id=?',turn,chat);
    if(!row)return fail(404,'conversation_turn_not_found');
    if(!this.serviceBindings.canManage(actor,chat))fail(403,'channel_service_binding_forbidden');
    if(this.serviceSessions.cancel(turn))this.store.audit(actor.principal_id,'channel.service_turn.stopped',turn,chat);
    return {id:turn,state:this.store.get('SELECT state FROM channel_service_turns WHERE id=?',turn)!.state};
  }
  private resultAuthority(task:Row):void{
    assertManagedExecution(this.store,task);
    for(const instance of this.store.all('SELECT role,source_fence FROM role_instances WHERE task_id=?',task.id))
      if(instance.source_fence&&instance.source_fence!==taskAuthorizationFence(this.store,task,instance.role))fail(403,'task_result_authority_changed');
  }
}
