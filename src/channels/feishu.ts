import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Row } from '../storage/database.js';
import { fail, HttpError, object, text, type Json } from '../core/security.js';
import type { ChannelAdapter, ChannelDelivery, ChannelEvent } from './types.js';

export type ChannelFetch = typeof fetch;
export class ChannelRateLimitError extends HttpError {
  constructor(readonly retryAfterMs: number) { super(503, 'channel_rate_limited'); }
}
const equal = (a: string, b: string) => !!a && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Only this adapter reads credential values; persisted configuration and callers hold a reference. */
export class FeishuAdapter implements ChannelAdapter {
  readonly capabilities = { messages: true, cards: true, update: true, group_history: false as const };
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
      envelope = { header: { app_id: legacy.app_id, tenant_key: legacy.tenant_key, event_id: envelope.uuid, event_type: 'app.uninstalled' }, event: {} };
    }
    const h = object(envelope.header), e = object(envelope.event);
    if (h.app_id !== this.connector.app_id || h.tenant_key !== this.connector.installation_tenant) fail(403, 'channel_source_mismatch');
    const type = h.event_type, base = { provider: 'feishu' as const, connector_id: this.connector.id, connector_revision: this.connector.revision, app_id: this.connector.app_id,
      installation_tenant: this.connector.installation_tenant, event_id: text(h.event_id), thread_id: '', content: '' };
    if (type === 'app.uninstalled' || type === 'im.chat.member.user.added_v1' || type === 'im.chat.member.user.deleted_v1')
      return { ...base, actor_tenant: '', actor_id: '', chat_id: String(e.chat_id ?? ''), chat_type: 'group', message_id: '', created_at: Date.now(),
        kind: type === 'app.uninstalled' ? 'uninstalled' : 'audience_changed' };
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
    if (sender.sender_type !== 'user' || id.open_id === this.connector.bot_open_id || !['p2p', 'group'].includes(String(message.chat_type))) return null;
    if (message.message_type !== 'text') return null;
    const actorTenant = text(sender.tenant_key);
    const mentions = Array.isArray(message.mentions) ? message.mentions as any[] : [];
    if (message.chat_type === 'group' && !mentions.some(m => m.id?.open_id === this.connector.bot_open_id)) return null;
    let content: string;
    try { content = text(object(JSON.parse(text(message.content, 20000))).text, 16000); } catch { return fail(400, 'channel_message_invalid'); }
    for (const m of mentions) if (m.id?.open_id === this.connector.bot_open_id && typeof m.key === 'string') content = content.replaceAll(m.key, '').trim();
    return { ...base, actor_tenant: actorTenant, actor_id: text(id.open_id), chat_id: text(message.chat_id),
      chat_type: message.chat_type as 'p2p' | 'group', message_id: text(message.message_id), thread_id: String(message.thread_id ?? message.root_id ?? ''),
      created_at: Number(message.create_time), kind: 'message', content };
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
      if (!r.ok || data.code !== 0) fail(502, path.startsWith('/auth/') ? 'channel_auth_failed' : path === '/bot/v3/info' ? 'channel_bot_unavailable' : path === '/tenant/v2/tenant/query' ? 'channel_tenant_unavailable' : 'channel_delivery_rejected');
      return data;
    } catch (error) { if (error instanceof HttpError) throw error; return fail(502, 'channel_delivery_failed'); }
  }
  async send(delivery: ChannelDelivery, key: string): Promise<string> {
    const data = await this.api('/im/v1/messages?receive_id_type=' + delivery.receive_id_type, { method: 'POST',
      body: JSON.stringify({ receive_id: delivery.receive_id, msg_type: 'interactive', content: JSON.stringify(delivery.content), uuid: key.slice(0, 50) }) });
    return text(data.data?.message_id);
  }
  async probe(): Promise<Json> {
    const data = await this.api('/bot/v3/info', { method: 'GET' });
    const bot = data.bot ?? data.data?.bot;
    if (typeof bot?.open_id !== 'string' || !bot.open_id) fail(502, 'channel_bot_unavailable');
    this.guard();
    return { bot_open_id: text(bot.open_id), name: typeof bot.app_name === 'string' ? bot.app_name.slice(0, 200) : '' };
  }
  async installationTenant(): Promise<string> {
    const data = await this.api('/tenant/v2/tenant/query', { method: 'GET' });
    const tenant = data.data?.tenant?.tenant_key;
    if (typeof tenant !== 'string' || !tenant) fail(502, 'channel_tenant_unavailable');
    this.guard();
    return text(tenant);
  }
  async update(delivery: ChannelDelivery): Promise<string> {
    const id = text(delivery.message_id);
    await this.api('/im/v1/messages/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ content: JSON.stringify(delivery.content) }) });
    return id;
  }
}
