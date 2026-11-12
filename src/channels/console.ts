import type { ActorContext } from '../identity/authorization.js';
import { assertCurrent, authorize } from '../identity/authorization.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { traceClean } from '../tasks/trace.js';
import type { Row } from '../storage/database.js';
import type { ChannelService } from './service.js';
import { chatProfile } from './profiles.js';
import { managementAssistant } from '../service-roles/roles.js';
import { commands } from '../management/catalog.js';
import { managementFailure, managementStates } from '../management/presentation.js';

const pageOffset = (value: unknown): number => {
  const offset = Number(value ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'invalid_pagination');
  return offset;
};
const denied = (error: unknown): boolean => error instanceof HttpError && error.status === 403 &&
  ['capability_forbidden', 'channel_history_forbidden', 'tenant_forbidden', 'external_binding_required', 'channel_employee_source_inactive'].includes(error.code);

/** Read-only console projections. Reading a project never grants access to its group's conversation. */
export class ChannelConsole {
  constructor(readonly service: ChannelService) {}
  async refreshName(actor: ActorContext, id: string): Promise<Json> {
    const chat = this.service.employees.chat(id);
    if (chat.chat_type !== 'group') return fail(400, 'channel_employee_group_required');
    const guard = () => {
      assertCurrent(actor);
      const current = this.service.employees.chat(id);
      if (current.connector_id !== chat.connector_id || current.connector.revision !== chat.connector.revision || current.revision !== chat.revision)
        fail(409, 'channel_configuration_changed');
      // A group may be selectable before its first assistant binding; neither case grants access to other groups.
      if (!this.service.employees.selectableChats(actor).some(c => c.id === id)) this.service.authorizeHistory(actor, id);
    };
    guard();
    const name = await this.service.adapter(chat.connector, guard).chatName(chat.chat_id);
    this.service.store.transaction(() => { guard(); this.service.store.run('UPDATE channel_chats SET display_name=? WHERE id=?', name, id); });
    return { id, ...chatProfile(this.service.store, id) };
  }
  private chat(actor: ActorContext, id: string): Row {
    return this.service.authorizeConversation(actor, id);
  }
  private profile(actor: ActorContext, chat: Row): Json {
    const profile = chatProfile(this.service.store, chat.id);
    const owner = chat.chat_type !== 'p2p' || this.service.store.get('SELECT 1 FROM channel_personal_owners WHERE chat_id=? AND principal_id=?', chat.id, actor.principal_id);
    return { ...profile, ...(owner ? {} : { binding_id: null, can_refresh_name: false }) };
  }
  list(actor: ActorContext, offset: number): Json {
    pageOffset(offset);
    const store = this.service.store;
    const chats = store.all('SELECT h.*,c.app_name,c.tenant_name,c.enabled AS connection_enabled FROM channel_chats h LEFT JOIN channel_connectors c ON c.id=h.connector_id ORDER BY h.last_received_at DESC,h.id')
      .filter(chat => { try { this.chat(actor, chat.id); return true; } catch (error) { if (denied(error)) return false; throw error; } });
    return { conversations: chats.slice(offset, offset + 50).map(chat => ({ id: chat.id, chat_id: chat.chat_id, type: chat.chat_type,
      ...this.profile(actor, chat), state: chat.state, connection_enabled: !!chat.connection_enabled,
      last_received_at: chat.last_received_at, binding: chat.chat_type === 'group' ? this.service.serviceBindings.get(chat.id)?.enabled === 1 : null })),
      total: chats.length, next_offset: offset + 50 < chats.length ? offset + 50 : null,
      counts: { private: chats.filter(c => c.chat_type === 'p2p').length, group: chats.filter(c => c.chat_type === 'group').length } };
  }
  /** Session rotations keep old inbox/message links, so a logical private chat includes its earlier management sessions. */
  private personalSessions(chat: Row): string[] {
    const connectors = [...new Set([chat.connector_id, ...this.service.store.all('SELECT id FROM channel_connectors WHERE provider=? AND app_id=? AND installation_tenant=?',
      chat.provider, chat.app_id, chat.installation_tenant).map(row => row.id)])];
    return this.service.store.all(`SELECT s.conversation_id AS id FROM channel_sessions s
      JOIN channel_connectors c ON c.id=s.connector_id JOIN management_conversations m ON m.id=s.conversation_id
      WHERE c.provider=? AND c.app_id=? AND c.installation_tenant=? AND s.installation_tenant=? AND s.chat_id=? AND s.project_id=''
      UNION SELECT m.conversation_id AS id FROM channel_messages h
      JOIN channel_inbox i ON i.connector_id IN (${connectors.map(() => '?').join(',')}) AND i.dedup_key='message:'||h.message_id
      JOIN management_messages m ON m.id=i.message_id AND m.conversation_id=i.conversation_id AND m.source_message='feishu:'||i.id
      WHERE h.chat_id=?`,
      chat.provider, chat.app_id, chat.installation_tenant, chat.installation_tenant, chat.chat_id,
      ...connectors, chat.id).map(row => row.id);
  }
  private personalReply(message: Row): string {
    const store = this.service.store;
    const reply = store.get("SELECT data FROM management_events WHERE message_id=? AND type='reply' ORDER BY sequence DESC LIMIT 1", message.id);
    const error = store.get("SELECT data FROM management_events WHERE message_id=? AND type='error' ORDER BY sequence DESC LIMIT 1", message.id);
    const operations = store.all('SELECT * FROM management_commands WHERE source_conversation=? AND source_message=? ORDER BY created_at', message.conversation_id, message.source_message);
    const receipts = operations.map(op => {
      const target = JSON.parse(op.target), result = op.result ? JSON.parse(op.result) : {};
      const project = store.get('SELECT full_name FROM repositories WHERE id=?', op.project_id)?.full_name ?? op.project_id;
      const task = target.task_id ? store.get('SELECT summary FROM tasks WHERE id=? AND repository_id=?', target.task_id, op.project_id) : undefined;
      return `${project}${task ? ' · ' + task.summary : ''}：${commands[op.operation]?.description ?? op.operation}\n${managementStates[op.state] ?? op.state}${result.error ? '；' + managementFailure(String(result.error)) : ''}`;
    });
    const answer = reply && !operations.some(op => op.state !== 'succeeded') ? JSON.parse(reply.data).text : '';
    return [...receipts, answer, error ? managementFailure(JSON.parse(error.data).error) : ''].filter(Boolean).join('\n\n') || managementStates[message.state] || '请求已记录，请在控制台查看进展。';
  }
  conversation(actor: ActorContext, id: string, offset = 0): Json {
    return this.view(actor, this.chat(actor, id), pageOffset(offset));
  }
  private view(actor: ActorContext, chat: Row, offset: number): Json {
    const store = this.service.store, binding = this.service.serviceBindings.get(chat.id);
    const mode = chat.chat_type === 'p2p' ? 'management' : binding ? 'service' : 'legacy';
    const sessions = mode === 'management' ? this.personalSessions(chat) : [];
    const marks = sessions.map(() => '?').join(',');
    const turns = mode === 'management' ? sessions.length ? store.all(`SELECT * FROM management_messages WHERE conversation_id IN (${marks}) ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?`, ...sessions, offset) : []
      : store.all(`SELECT * FROM ${binding ? 'channel_service_turns' : 'role_conversation_turns'} WHERE ${binding ? 'chat_id' : 'conversation_id'}=? ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?`, chat.id, offset);
    const usageWhere = mode === 'management' ? sessions.length ? `conversation_id IN (${marks}) AND service_role_id=?` : '0'
      : binding ? 'conversation_id=? AND repository_id IS NULL AND service_role_id IS NOT NULL' : 'conversation_id=?';
    const usageArgs = mode === 'management' ? sessions.length ? [...sessions, managementAssistant] : [] : [chat.id];
    const requests = store.get(`SELECT count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,
      sum(CASE WHEN finished_at IS NULL OR input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) usage_missing_requests,
      sum(CASE WHEN accounting_source='acp_prompt' THEN 1 ELSE 0 END) provider_request_count_unknown,
      sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced_requests FROM model_requests WHERE ${usageWhere}`, ...usageArgs)!;
    const costs = store.all(`SELECT currency,sum(cost) amount FROM model_requests WHERE ${usageWhere} AND cost IS NOT NULL GROUP BY currency`, ...usageArgs);
    const roles = new Map(store.all('SELECT id,name FROM service_roles').map(row => [row.id, row.name]));
    const manageable = !!binding && this.service.serviceBindings.canManage(actor, chat.id);
    const current = mode === 'management' ? store.get("SELECT conversation_id FROM channel_sessions WHERE connector_id=? AND chat_id=? AND project_id='' AND principal_id=?", chat.connector_id, chat.chat_id,
      store.get('SELECT principal_id FROM channel_personal_owners WHERE chat_id=?', chat.id)?.principal_id ?? '') : undefined;
    return traceClean({ conversation_id: chat.id, ...(mode === 'legacy' ? {} : { mode }), current_project: null,
      ...(mode === 'management' ? { management_conversation_id: current?.conversation_id ?? null,
        can_continue: !!store.get('SELECT 1 FROM channel_personal_owners WHERE chat_id=? AND principal_id=?', chat.id, actor.principal_id) }
        : binding ? { binding: this.service.serviceBindings.view(binding), can_manage: manageable } : {}),
      turns: turns.slice(0, 50).map(turn => mode === 'management' ? { id: turn.id, source_message: turn.source_message, created_at: turn.created_at,
        state: managementStates[turn.state] ?? turn.state, request: JSON.parse(turn.input).content, messages: this.service.management.stageMessages(turn.id),
        incoming_messages: this.service.turnMessages.list(turn.id), reply: this.personalReply(turn), role_id: '管理助手' }
        : binding ? { id: turn.id, source_message: turn.source_message, state: turn.state, error: turn.error, created_at: turn.created_at, updated_at: turn.updated_at,
          role_id: roles.get(turn.service_role_id) ?? turn.service_role_id, can_stop: manageable && turn.state === 'running',
          messages: this.service.serviceSessions.messages(turn.id).map(m => ({ sequence: m.sequence, text: m.text, created_at: m.created_at })),
          incoming_messages: this.service.turnMessages.list(turn.id),
          reply: turn.reply ? store.secrets.open(turn.reply, 'service-turn-reply:' + turn.id).message : null }
        : { id: turn.id, source_message: turn.source_message, project_id: turn.project_id, role_id: turn.role_id, state: turn.state, error: turn.error,
          created_at: turn.created_at, updated_at: turn.updated_at, reply: turn.reply ? store.secrets.open(turn.reply, 'conversation-reply:' + turn.id).message : null }),
      has_more: turns.length > 50, next_offset: turns.length > 50 ? offset + 50 : null,
      usage: { ...requests, costs, semantics: requests.usage_missing_requests ? 'lower_bound' : requests.unpriced_requests ? 'known usage; cost incomplete' : 'recorded estimates' },
      ...this.service.ledger.diagnostics(chat.id) });
  }
  timeline(actor: ActorContext, id: string, url: URL): Json {
    const chat = this.chat(actor, id);
    const messages = this.service.ledger.query(id, { direction: 'older', limit: 50, ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}) });
    // Resolve names only from an exact, still-active local identity for this connector; reading history makes no profile request.
    const connector = chat.connector_id + ':' + chat.app_id;
    messages.messages = (messages.messages as Json[]).map(message => {
      const identity = this.service.store.get(`SELECT display_name FROM external_identities WHERE provider=? AND host='open.feishu.cn'
        AND connector=? AND external_actor=? AND external_tenant=? AND status='active' AND (expires_at IS NULL OR expires_at>?)`,
        chat.provider, connector, String(message.sender_id), String(message.sender_tenant), Date.now());
      return { ...message, ...(identity?.display_name && identity.display_name !== message.sender_id ? { sender_name: identity.display_name } : {}) };
    });
    const conversation = this.view(actor, chat, pageOffset(url.searchParams.get('turn_offset'))) as any;
    conversation.turns = conversation.turns.map((turn: Json) => {
      const source = String(turn.source_message).replace(/^feishu:/, ''), suffix = conversation.mode === 'service' ? ':business-result' : ':result';
      const delivery = this.service.store.get('SELECT state,last_error FROM channel_outbox WHERE connector_id=? AND idempotency_key=?', chat.connector_id, source + suffix);
      const rawState = conversation.mode === 'management' ? this.service.store.get('SELECT state FROM management_messages WHERE id=?', String(turn.id))?.state : undefined;
      const progress = ((turn.messages ?? []) as (string | Json)[]).map((message, index) => {
        const sequence = typeof message === 'string' ? index + 1 : Number(message.sequence);
        const receipt = conversation.mode === 'service'
          ? this.service.store.get(`SELECT o.state,o.last_error FROM channel_service_turn_messages m JOIN channel_outbox o ON o.id=m.outbox_id WHERE m.turn_id=? AND m.sequence=?`, String(turn.id), sequence)
          : this.service.store.get('SELECT state,last_error FROM channel_outbox WHERE connector_id=? AND idempotency_key=?', chat.connector_id, source + ':stage:' + sequence);
        return { sequence, text: typeof message === 'string' ? message : message.text,
          ...(typeof message === 'string' ? {} : { created_at: message.created_at }), delivery: receipt ? { state: receipt.state, error: receipt.last_error } : null };
      });
      return { ...turn, messages: progress, ...(rawState ? { state: rawState, state_label: turn.state } : {}), delivery: delivery ? { state: delivery.state, error: delivery.last_error } : null };
    });
    return { ...messages, conversation,
      chat: { id, chat_id: chat.chat_id, type: chat.chat_type, ...this.profile(actor, chat) }, read_at: Date.now() };
  }
  /** Event metadata is paginated independently of message history, so a long turn cannot silently truncate. */
  events(actor: ActorContext, chatId: string, turnId: string, after: number): Json {
    const chat = this.chat(actor, chatId); pageOffset(after);
    const store = this.service.store, binding = this.service.serviceBindings.get(chatId);
    if (binding) {
      const turn = store.get('SELECT * FROM channel_service_turns WHERE id=? AND chat_id=?', turnId, chatId);
      if (!turn) return fail(404, 'channel_turn_not_found');
      const rows = store.all('SELECT sequence,type,name,created_at FROM channel_service_events WHERE turn_id=? AND sequence>? ORDER BY sequence LIMIT 101', turnId, after);
      return { events: rows.slice(0, 100), has_more: rows.length > 100, next_after: rows.slice(0, 100).at(-1)?.sequence ?? after,
        coverage: rows.length || after ? 'recorded_steps' : 'legacy_steps_unavailable' };
    }
    const sessions = chat.chat_type === 'p2p' ? this.personalSessions(chat) : [];
    if (!sessions.length) return { events: [], has_more: false, coverage: 'legacy_steps_unavailable' };
    const message = store.get(`SELECT id FROM management_messages WHERE id=? AND conversation_id IN (${sessions.map(() => '?').join(',')})`, turnId, ...sessions);
    if (!message) return fail(404, 'channel_turn_not_found');
    // Publish step names and outcomes, never the management tool's payload or provisional model text.
    const rows = store.all(`SELECT sequence,type,data,created_at FROM management_events WHERE message_id=? AND sequence>?
      AND type IN ('running','model_start','model_request','tool_call','tool_result','tool_error','done','error','stopped') ORDER BY sequence LIMIT 101`, turnId, after);
    return { events: rows.slice(0, 100).map(row => ({ sequence: row.sequence, type: row.type, name: String(JSON.parse(row.data).name ?? ''), created_at: Date.parse(row.created_at) })),
      has_more: rows.length > 100, next_after: rows.slice(0, 100).at(-1)?.sequence ?? after, coverage: 'recorded_steps' };
  }
  tasks(actor: ActorContext, id: string, offset: number): Json {
    const chat = this.chat(actor, id); pageOffset(offset);
    const store = this.service.store, binding = this.service.serviceBindings.get(id);
    const sessions = chat.chat_type === 'p2p' ? this.personalSessions(chat) : [];
    let rows: Row[] = [];
    if (binding) rows = store.all(`SELECT t.*,s.source_message FROM channel_service_tasks s JOIN tasks t ON t.id=s.task_id
      WHERE s.chat_id=? ORDER BY t.created_at DESC,t.id`, id);
    else if (sessions.length) rows = store.all(`SELECT t.*,c.source_message FROM management_commands c JOIN tasks t ON t.id=json_extract(c.result,'$.id')
      WHERE c.source_conversation IN (${sessions.map(() => '?').join(',')}) AND c.operation='task.create' AND c.state='succeeded' ORDER BY t.created_at DESC,t.id`, ...sessions);
    const visible = rows.filter(row => { try { authorize(actor, 'tasks.read', { project_id: row.repository_id }); return true; } catch (error) { if (denied(error)) return false; throw error; } });
    const owners = binding ? [binding.id] : sessions;
    const own = owners.length ? store.all(`SELECT * FROM service_role_own_tasks WHERE owner_kind=? AND owner_id IN (${owners.map(() => '?').join(',')})
      ORDER BY updated_at DESC,rowid DESC LIMIT 20`, binding ? 'channel' : 'management', ...owners).map(row => {
        const history = store.secrets.open(row.history, 'own-task:' + row.id).rounds as { conclusion: string }[];
        return { task_id: row.id, title: row.title, state: row.control ?? row.state, rounds: row.rounds, error: row.error ?? null,
          updated_at: row.updated_at, last_conclusion: (history.at(-1)?.conclusion ?? '').slice(0, 2000) };
      }) : [];
    return traceClean({ tasks: visible.slice(offset, offset + 20).map(t => ({ id: t.id, summary: t.summary, status: t.status,
      project_id: t.repository_id, project_name: store.get('SELECT full_name FROM repositories WHERE id=?', t.repository_id)?.full_name,
      source_message: t.source_message, updated_at: t.updated_at })), next_offset: offset + 20 < visible.length ? offset + 20 : null,
      own_tasks: own, own_tasks_limit: 20 });
  }
}
