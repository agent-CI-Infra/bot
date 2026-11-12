import type { ActorContext } from '../identity/authorization.js';
import { authorize } from '../identity/authorization.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { traceClean } from '../tasks/trace.js';
import type { Row } from '../storage/database.js';
import type { ChannelService } from './service.js';

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
  private chat(actor: ActorContext, id: string): Row {
    const chat = this.service.store.get('SELECT * FROM channel_chats WHERE id=?', id);
    if (!chat) return fail(404, 'channel_chat_not_found');
    // A personal management conversation stays with its owner, including for platform administrators.
    if (chat.chat_type === 'p2p' && !this.service.store.get('SELECT 1 FROM channel_personal_owners WHERE chat_id=? AND principal_id=?', id, actor.principal_id))
      return fail(403, 'channel_history_forbidden');
    this.service.authorizeHistory(actor, id);
    return chat;
  }
  list(actor: ActorContext, offset: number): Json {
    pageOffset(offset);
    const store = this.service.store;
    const chats = store.all('SELECT h.*,c.app_name,c.tenant_name,c.enabled AS connection_enabled FROM channel_chats h LEFT JOIN channel_connectors c ON c.id=h.connector_id ORDER BY h.last_received_at DESC,h.id')
      .filter(chat => { try { this.chat(actor, chat.id); return true; } catch (error) { if (denied(error)) return false; throw error; } });
    return { conversations: chats.slice(offset, offset + 50).map(chat => ({ id: chat.id, chat_id: chat.chat_id, type: chat.chat_type,
      app_name: chat.app_name || '飞书机器人', tenant_name: chat.tenant_name || '', state: chat.state, connection_enabled: !!chat.connection_enabled,
      last_received_at: chat.last_received_at, binding: chat.chat_type === 'group' ? this.service.serviceBindings.get(chat.id)?.enabled === 1 : null })),
      total: chats.length, next_offset: offset + 50 < chats.length ? offset + 50 : null,
      counts: { private: chats.filter(c => c.chat_type === 'p2p').length, group: chats.filter(c => c.chat_type === 'group').length } };
  }
  timeline(actor: ActorContext, id: string, url: URL): Json {
    const chat = this.chat(actor, id), binding = this.service.serviceBindings.get(id);
    let platform = false; try { authorize(actor, 'platform.manage'); platform = true; } catch (error) { if (!denied(error)) throw error; }
    const messages = this.service.ledger.query(id, { direction: 'older', limit: 50, ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}) },
      platform ? undefined : this.service.visibleScopes(id, actor), binding ? this.service.serviceBindings.fence(id) : undefined);
    // Resolve names only from an exact, still-active local identity for this connector; reading history makes no profile request.
    const connector = chat.connector_id + ':' + chat.app_id;
    messages.messages = (messages.messages as Json[]).map(message => {
      const identity = this.service.store.get(`SELECT display_name FROM external_identities WHERE provider=? AND host='open.feishu.cn'
        AND connector=? AND external_actor=? AND external_tenant=? AND status='active' AND (expires_at IS NULL OR expires_at>?)`,
        chat.provider, connector, String(message.sender_id), String(message.sender_tenant), Date.now());
      return { ...message, ...(identity?.display_name && identity.display_name !== message.sender_id ? { sender_name: identity.display_name } : {}) };
    });
    const conversation = this.service.conversationView(actor, id, pageOffset(url.searchParams.get('turn_offset'))) as any;
    conversation.turns = conversation.turns.map((turn: Json) => {
      const source = String(turn.source_message).replace(/^feishu:/, ''), suffix = conversation.mode === 'service' ? ':business-result' : ':result';
      const delivery = turn.stale_source ? null : this.service.store.get('SELECT state,last_error FROM channel_outbox WHERE connector_id=? AND idempotency_key=?', chat.connector_id, source + suffix);
      const rawState = conversation.mode === 'management' ? this.service.store.get('SELECT state FROM management_messages WHERE id=?', String(turn.id))?.state : undefined;
      return { ...turn, ...(rawState ? { state: rawState, state_label: turn.state } : {}), delivery: delivery ? { state: delivery.state, error: delivery.last_error } : null };
    });
    return { ...messages, conversation,
      chat: { id, chat_id: chat.chat_id, type: chat.chat_type }, read_at: Date.now() };
  }
  /** Event metadata is paginated independently of message history, so a long turn cannot silently truncate. */
  events(actor: ActorContext, chatId: string, turnId: string, after: number): Json {
    this.chat(actor, chatId); pageOffset(after);
    const store = this.service.store, binding = this.service.serviceBindings.get(chatId);
    if (binding) {
      const turn = store.get('SELECT * FROM channel_service_turns WHERE id=? AND chat_id=?', turnId, chatId);
      if (!turn) return fail(404, 'channel_turn_not_found');
      if (turn.fence !== this.service.serviceBindings.fence(chatId)) return { events: [], has_more: false, stale_source: true };
      const rows = store.all('SELECT sequence,type,name,created_at FROM channel_service_events WHERE turn_id=? AND sequence>? ORDER BY sequence LIMIT 101', turnId, after);
      return { events: rows.slice(0, 100), has_more: rows.length > 100, next_after: rows.slice(0, 100).at(-1)?.sequence ?? after,
        coverage: rows.length || after ? 'recorded_steps' : 'legacy_steps_unavailable' };
    }
    const view = this.service.conversationView(actor, chatId) as any;
    if (view.mode !== 'management' || !view.management_conversation_id) return { events: [], has_more: false, coverage: 'legacy_steps_unavailable' };
    this.service.management.conversation(actor, view.management_conversation_id);
    const message = store.get('SELECT id FROM management_messages WHERE id=? AND conversation_id=? AND authorization_revision=?', turnId, view.management_conversation_id, actor.authorization_revision);
    if (!message) return fail(404, 'channel_turn_not_found');
    // Publish step names and outcomes, never the management tool's payload or provisional model text.
    const rows = store.all(`SELECT sequence,type,data,created_at FROM management_events WHERE message_id=? AND sequence>?
      AND type IN ('running','model_start','model_request','tool_call','tool_result','tool_error','done','error','stopped') ORDER BY sequence LIMIT 101`, turnId, after);
    return { events: rows.slice(0, 100).map(row => ({ sequence: row.sequence, type: row.type, name: String(JSON.parse(row.data).name ?? ''), created_at: Date.parse(row.created_at) })),
      has_more: rows.length > 100, next_after: rows.slice(0, 100).at(-1)?.sequence ?? after, coverage: 'recorded_steps' };
  }
  tasks(actor: ActorContext, id: string, offset: number): Json {
    this.chat(actor, id); pageOffset(offset);
    const store = this.service.store, binding = this.service.serviceBindings.get(id);
    const view = this.service.conversationView(actor, id) as any;
    let rows: Row[] = [];
    if (binding) rows = store.all(`SELECT t.*,s.source_message FROM channel_service_tasks s JOIN tasks t ON t.id=s.task_id
      JOIN channel_service_turns turn ON turn.chat_id=s.chat_id AND turn.source_message=s.source_message
      WHERE s.chat_id=? AND s.binding_id=? AND turn.fence=? ORDER BY t.created_at DESC,t.id`, id, binding.id, this.service.serviceBindings.fence(id))
      .filter(t => this.service.serviceBindings.reachable(binding, t.repository_id, ['tasks.read']));
    else if (view.mode === 'management' && view.management_conversation_id) rows = store.all(`SELECT t.*,c.source_message FROM management_commands c JOIN tasks t ON t.id=json_extract(c.result,'$.id')
      JOIN management_messages m ON m.conversation_id=c.source_conversation AND m.source_message=c.source_message
      WHERE c.source_conversation=? AND c.operation='task.create' AND c.state='succeeded' AND m.authorization_revision=? ORDER BY t.created_at DESC,t.id`, view.management_conversation_id, actor.authorization_revision);
    const visible = rows.filter(row => { try { authorize(actor, 'tasks.read', { project_id: row.repository_id }); return true; } catch (error) { if (denied(error)) return false; throw error; } });
    let own: Json[] = [];
    if (binding) own = this.service.serviceSessions.own.list({ service_role_id: binding.service_role_id, kind: 'channel', owner_id: binding.id,
      principal_id: binding.principal_id, fence: this.service.serviceBindings.fence(id) }).own_tasks as Json[];
    else if (view.mode === 'management' && view.management_conversation_id) own = this.service.management.own.list({ service_role_id: 'management-assistant', kind: 'management',
      owner_id: view.management_conversation_id, principal_id: actor.principal_id, fence: String(actor.authorization_revision) }).own_tasks as Json[];
    return traceClean({ tasks: visible.slice(offset, offset + 20).map(t => ({ id: t.id, summary: t.summary, status: t.status,
      project_id: t.repository_id, project_name: store.get('SELECT full_name FROM repositories WHERE id=?', t.repository_id)?.full_name,
      source_message: t.source_message, updated_at: t.updated_at })), next_offset: offset + 20 < visible.length ? offset + 20 : null,
      own_tasks: own, own_tasks_limit: 20 });
  }
}
