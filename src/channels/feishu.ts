import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Row } from '../storage/database.js';
import { fail, HttpError, object, text, type Json } from '../core/security.js';
import type { ChannelAdapter, ChannelDelivery, ChannelEvent, HistoryPage, StoredMessage } from './types.js';

export type ChannelFetch = typeof fetch;
export class ChannelRateLimitError extends HttpError {
  constructor(readonly retryAfterMs: number) { super(503, 'channel_rate_limited'); }
}
export class ChannelHistoryError extends HttpError {
  constructor(code: string, readonly permanent: boolean) { super(permanent ? 403 : 502, code); }
}
const equal = (a: string, b: string) => !!a && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Only this adapter reads credential values; persisted configuration and callers hold a reference. */
export class FeishuAdapter implements ChannelAdapter {
  readonly capabilities = { messages: true, cards: true, update: true, group_history: true };
  constructor(readonly connector: Row, private readonly secret: Json, private readonly request: ChannelFetch = fetch, private readonly guard: () => void = () => {}) {}
  verify(headers: IncomingHttpHeaders, body: Buffer): Json {
    const timestamp = String(headers['x-lark-request-timestamp'] ?? ''), nonce = String(headers['x-lark-request-nonce'] ?? '');
    const signature = String(headers['x-lark-signature'] ?? ''), key = String(this.secret.encrypt_key ?? '');
    if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 || !nonce || nonce.length > 256 || !key ||
      !/^[a-f0-9]{64}$/.test(signature) || !equal(signature, createHash('sha256').update(timestamp + nonce + key).update(body).digest('hex')))
      return fail(401, 'channel_signature_invalid');
    let data: Json;
    try {
      data = object(JSON.parse(body.toString('utf8')));
      if (data.encrypt) {
        const raw = Buffer.from(text(data.encrypt, 2 * 1024 * 1024), 'base64');
        if (raw.length < 32) throw new Error();
        const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), raw.subarray(0, 16));
        data = object(JSON.parse(Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8')));
      }
    } catch { return fail(400, 'channel_payload_invalid'); }
    const header = data.header as Json | undefined;
    if (!equal(String(header?.token ?? data.token ?? ''), String(this.secret.verification_token ?? ''))) fail(401, 'channel_token_invalid');
    if (data.type !== 'url_verification' && (header?.app_id ?? (data.event as Json)?.app_id) !== this.connector.app_id) fail(403, 'channel_app_mismatch');
    return data;
  }
  normalize(envelope: Json): ChannelEvent | null {
    // App lifecycle events still use Feishu's v1 envelope, unlike message/card events.
    if (!envelope.header && envelope.event) {
      const legacy = object(envelope.event);
      if (!['app_uninstalled', 'app_status_change'].includes(String(legacy.type))) return null;
      envelope = { header: { app_id: legacy.app_id, tenant_key: legacy.tenant_key, event_id: envelope.uuid, event_type: 'app.uninstalled',
        create_time: envelope.ts === undefined ? Date.now() : Math.round(Number(envelope.ts) * 1000) }, event: {} };
    }
    const h = object(envelope.header), e = object(envelope.event);
    if (h.app_id !== this.connector.app_id || h.tenant_key !== this.connector.installation_tenant) fail(403, 'channel_source_mismatch');
    const type = h.event_type, base = { provider: 'feishu' as const, connector_id: this.connector.id, connector_revision: this.connector.revision, app_id: this.connector.app_id,
      installation_tenant: this.connector.installation_tenant, event_id: text(h.event_id), thread_id: '', content: '', received_at: eventTime(h.create_time) };
    const lifecycle = { 'app.uninstalled': 'uninstalled', 'im.chat.member.user.added_v1': 'audience_changed',
      'im.chat.member.user.deleted_v1': 'audience_changed', 'im.chat.member.bot.added_v1': 'bot_added',
      'im.chat.member.bot.deleted_v1': 'bot_removed', 'im.chat.disbanded_v1': 'chat_archived' } as const;
    if (Object.hasOwn(lifecycle, String(type)))
      return { ...base, actor_tenant: '', actor_id: '', chat_id: String(e.chat_id ?? ''), chat_type: 'group', message_id: '', created_at: Date.now(),
        kind: lifecycle[type as keyof typeof lifecycle] };
    if (type === 'im.message.recalled_v1') return { ...base, actor_tenant: '', actor_id: '', chat_id: text(e.chat_id), chat_type: 'group',
      message_id: text(e.message_id), created_at: eventTime(e.recall_time), updated_at: eventTime(e.recall_time), kind: 'message_recalled', deleted: true };
    if (type === 'card.action.trigger') {
      if (!this.connector.bot_open_id) fail(503, 'channel_bot_unavailable');
      const op = object(e.operator), context = object(e.context), value = object((e.action as Json)?.value);
      const tenant = text(op.tenant_key);
      return { ...base, actor_tenant: tenant, actor_id: text(op.open_id), chat_id: text(context.open_chat_id),
        // The card's audience comes from the server record, never action.value or client-supplied scope.
        chat_type: 'group', message_id: text(context.open_message_id), created_at: Number(h.create_time) / 1000,
        kind: 'card', card_token: text(value.token) };
    }
    if (type !== 'im.message.receive_v1') return null;
    if (!this.connector.bot_open_id) fail(503, 'channel_bot_unavailable');
    const sender = object(e.sender), id = object(sender.sender_id), message = object(e.message);
    if (!['p2p', 'group'].includes(String(message.chat_type))) return null;
    const actorTenant = sender.sender_type === 'user' ? text(sender.tenant_key) : String(sender.tenant_key ?? '');
    const mentions = Array.isArray(message.mentions) ? message.mentions as any[] : [];
    const addressed = message.chat_type === 'p2p' || mentions.some(m => m.id?.open_id === this.connector.bot_open_id);
    const raw = text(message.content, 200000), messageType = text(message.message_type, 80);
    let content = '';
    try { content = messageText(messageType, raw); } catch { return fail(400, 'channel_message_invalid'); }
    for (const m of mentions) if (m.id?.open_id === this.connector.bot_open_id && typeof m.key === 'string') content = content.replaceAll(m.key, '').trim();
    return { ...base, actor_tenant: actorTenant, actor_id: text(id.open_id ?? id.app_id), chat_id: text(message.chat_id),
      chat_type: message.chat_type as 'p2p' | 'group', message_id: text(message.message_id), thread_id: String(message.thread_id ?? ''),
      parent_id: String(message.parent_id ?? ''), root_id: String(message.root_id ?? ''), created_at: eventTime(message.create_time),
      updated_at: eventTime(message.update_time ?? message.create_time), kind: 'message', content, raw_content: raw,
      message_type: messageType, sender_type: String(sender.sender_type ?? 'unknown'), addressed: addressed && sender.sender_type === 'user' && id.open_id !== this.connector.bot_open_id };
  }
  private async api(path: string, init: RequestInit, authenticated = true): Promise<any> {
    let token = '';
    if (authenticated) {
      let data: any;
      if (this.connector.application_type === 'saas') {
        if (!this.secret.app_ticket || Number(this.secret.app_ticket_time) < Date.now() - 2 * 3600_000) fail(503, 'channel_app_ticket_required');
        const app = await this.api('/auth/v3/app_access_token', { method: 'POST', body: JSON.stringify({ app_id: this.connector.app_id, app_secret: this.secret.app_secret, app_ticket: this.secret.app_ticket }) }, false);
        if (typeof app.app_access_token !== 'string') fail(502, 'channel_auth_failed');
        data = await this.api('/auth/v3/tenant_access_token', { method: 'POST', body: JSON.stringify({ app_access_token: app.app_access_token, tenant_key: this.connector.installation_tenant }) }, false);
      } else data = await this.api('/auth/v3/tenant_access_token/internal', { method: 'POST', body: JSON.stringify({ app_id: this.connector.app_id, app_secret: this.secret.app_secret }) }, false);
      if (typeof data.tenant_access_token !== 'string') fail(502, 'channel_auth_failed');
      token = data.tenant_access_token;
    }
    try {
      this.guard();
      const r = await this.request('https://open.feishu.cn/open-apis' + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) } });
      const data = await r.json().catch(error => { if (r.status === 429) return {}; throw error; }) as any;
      if (r.status === 429 || [99991400, 99991401].includes(data.code)) {
        const retry = r.headers.get('retry-after') ?? '1';
        const delay = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        throw new ChannelRateLimitError(Number.isFinite(delay) ? Math.min(3600000, Math.max(1000, delay)) : 1000);
      }
      if (path.startsWith('/im/v1/messages?') && init.method === 'GET' && (!r.ok || data.code !== 0)) {
        const permanent = r.status === 403 || [230002, 230006, 230013, 230027, 230073, 231203, 231204, 99991672].includes(data.code);
        throw new ChannelHistoryError(({ 230002: 'channel_bot_not_in_chat', 230006: 'channel_bot_disabled', 230013: 'channel_chat_out_of_scope',
          230027: 'channel_history_permission_required', 230073: 'channel_thread_invisible', 231203: 'channel_history_chat_unsupported',
          231204: 'channel_history_app_unsupported', 99991672: 'channel_history_permission_required' } as Record<number, string>)[data.code] ?? 'channel_history_rejected', permanent);
      }
      if (!r.ok || data.code !== 0) fail(502, path.startsWith('/auth/') ? 'channel_auth_failed' : path === '/bot/v3/info' ? 'channel_bot_unavailable' : path === '/tenant/v2/tenant/query' ? 'channel_tenant_unavailable' : 'channel_delivery_rejected');
      return data;
    } catch (error) { if (error instanceof HttpError) throw error; return fail(502, 'channel_delivery_failed'); }
  }
  async send(delivery: ChannelDelivery, key: string): Promise<string> {
    const data = await this.api('/im/v1/messages?receive_id_type=' + delivery.receive_id_type, { method: 'POST',
      body: JSON.stringify({ receive_id: delivery.receive_id, msg_type: 'interactive', content: JSON.stringify(delivery.content), uuid: key.slice(0, 50) }) });
    return text(data.data?.message_id);
  }
  async history(job: Row): Promise<HistoryPage> {
    // Feishu's maximum is 50 per page, not a cap on total history. Threads do not support time boundaries.
    const query = new URLSearchParams({ container_id_type: job.container_type, container_id: job.container_id, sort_type: 'ByCreateTimeAsc', page_size: '50' });
    if (job.container_type === 'chat') {
      query.set('start_time', String(job.start_time)); query.set('end_time', String(job.end_time));
    }
    if (job.page_token) query.set('page_token', job.page_token);
    const result = await this.api('/im/v1/messages?' + query, { method: 'GET' });
    const data = result.data;
    if (!data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean' || data.has_more && typeof data.page_token !== 'string') fail(502, 'channel_history_invalid');
    const items: StoredMessage[] = data.items.map((item: any) => {
      const raw = String(item.body?.content ?? ''), messageType = text(item.msg_type, 80);
      let content = '';
      if (!item.deleted) { try { content = messageText(messageType, raw); } catch { fail(502, 'channel_history_invalid'); } }
      return { message_id: text(item.message_id), sender_id: String(item.sender?.id ?? ''), sender_tenant: String(item.sender?.tenant_key ?? ''),
        sender_type: String(item.sender?.sender_type ?? 'unknown'), message_type: messageType, content, raw_content: raw,
        created_at: eventTime(item.create_time), updated_at: eventTime(item.update_time ?? item.create_time), deleted: !!item.deleted,
        parent_id: String(item.parent_id ?? ''), root_id: String(item.root_id ?? ''), thread_id: String(item.thread_id ?? '') };
    });
    return { items, has_more: data.has_more, page_token: data.page_token ?? '' };
  }
  async probe(): Promise<Json> {
    const data = await this.api('/bot/v3/info', { method: 'GET' });
    const bot = data.bot ?? data.data?.bot;
    if (typeof bot?.open_id !== 'string' || !bot.open_id) fail(502, 'channel_bot_unavailable');
    this.guard();
    return { bot_open_id: text(bot.open_id), name: typeof bot.app_name === 'string' ? bot.app_name.trim().slice(0, 200) : '' };
  }
  /** is_in_chat checks this token's bot, while members lists human members only. */
  async audience(chat: string): Promise<{ id: string; tenant: string }[]> {
    const path = '/im/v1/chats/' + encodeURIComponent(chat) + '/members';
    if ((await this.api(path + '/is_in_chat', { method: 'GET' })).data?.is_in_chat !== true) fail(403, 'channel_bot_not_in_chat');
    const members = new Map<string, { id: string; tenant: string }>(), seen = new Set<string>(); let token = '';
    for (;;) {
      const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100', check_security_conf: 'true' });
      if (token) query.set('page_token', token);
      const data = (await this.api(path + '?' + query, { method: 'GET' })).data;
      if (!data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean' || data.trigger_security_conf_limit) fail(403, 'channel_audience_unverified');
      for (const item of data.items) {
        if (item.member_id_type !== 'open_id' || typeof item.member_id !== 'string' || !item.member_id || typeof item.tenant_key !== 'string' || !item.tenant_key) fail(502, 'channel_audience_invalid');
        members.set(item.tenant_key + ':' + item.member_id, { id: item.member_id, tenant: item.tenant_key });
      }
      if (!data.has_more) break;
      if (typeof data.page_token !== 'string' || !data.page_token || seen.has(data.page_token)) fail(502, 'channel_audience_cursor_stalled');
      seen.add(data.page_token); token = data.page_token;
    }
    this.guard(); return [...members.values()];
  }
  async installationInfo(): Promise<{ tenant_key: string; tenant_name: string }> {
    const data = await this.api('/tenant/v2/tenant/query', { method: 'GET' });
    const tenant = data.data?.tenant;
    if (typeof tenant?.tenant_key !== 'string' || !tenant.tenant_key) fail(502, 'channel_tenant_unavailable');
    this.guard();
    return { tenant_key: text(tenant.tenant_key), tenant_name: typeof tenant.name === 'string' ? tenant.name.trim().slice(0, 200) : '' };
  }
  async update(delivery: ChannelDelivery): Promise<string> {
    const id = text(delivery.message_id);
    await this.api('/im/v1/messages/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ content: JSON.stringify(delivery.content) }) });
    return id;
  }
}

function messageText(type: string, raw: string): string {
  if (!['text', 'post', 'file', 'audio', 'media'].includes(type)) return '';
  const data = object(JSON.parse(raw));
  if (type === 'text') return String(data.text ?? '');
  if (type !== 'post') return String(data.file_name ?? '');
  const parts: string[] = [];
  const walk = (node: any): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (['text', 'title'].includes(key) && typeof value === 'string') parts.push(value);
      else if (typeof value === 'object') walk(value);
    }
  };
  walk(data); return parts.join('\n');
}

function eventTime(value: unknown): number {
  let number = Number(value);
  // Header timestamps from some SDK versions are microseconds; message timestamps are milliseconds.
  if (number > 100_000_000_000_000) number = Math.floor(number / 1000);
  if (!Number.isSafeInteger(number) || number < 0) return fail(400, 'channel_message_time_invalid');
  return number;
}
