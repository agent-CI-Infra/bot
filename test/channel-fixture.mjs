import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { managementFixture } from './management-fixture.mjs';
import { digest, randomId } from '../dist/core/security.js';

export const credentials = { app_secret: 'fixture-feishu-app-secret', encrypt_key: 'fixture-feishu-encrypt-key', verification_token: 'fixture-feishu-verification-token' };
export function transport() {
  const sent = [], state = { failures: 0, authGate: null, authRequests: [] };
  return { sent, state, fetch: async (url, init) => {
    if (url.includes('/auth/')) {
      if (state.authGate) await state.authGate;
      const auth = JSON.parse(init.body); state.authRequests.push({ url, tenant_key: auth.tenant_key, app_id: auth.app_id });
      if (url.endsWith('/app_access_token')) return Response.json({ code: 0, app_access_token: 'fixture-app-access-token' });
      return Response.json({ code: 0, tenant_access_token: 'fixture-only-access-token' });
    }
    if (state.failures) { state.failures--; return Response.json({ code: 999, msg: 'fixture failure' }, { status: 503 }); }
    const request = JSON.parse(init.body); sent.push({ url, method: init.method, ...request, content: JSON.parse(request.content) });
    return Response.json({ code: 0, data: { message_id: 'remote-' + sent.length } });
  } };
}
export async function connector(admin, override = {}) {
  const result = await admin('/api/channels/connectors', 'POST', { tenant_id: 'github.com:10', app_id: 'cli_fixture', installation_tenant: 'install-tenant',
    actor_tenants: ['actor-tenant', 'other-tenant'], bot_open_id: 'ou_bot', application_type: 'enterprise', transport: 'http', enabled: true, credentials, expected_revision: 0, ...override });
  if (result.status !== 201) throw new Error(JSON.stringify(result));
  return result.value.connector_id;
}
export function envelope(content = '/project 101 查询任务', overrides = {}) {
  const id = randomId(), now = Date.now();
  const data = JSON.parse(readFileSync(new URL('./fixtures/feishu-message.json', import.meta.url), 'utf8'));
  Object.assign(data.header, { event_id: id, create_time: String(now * 1000), token: credentials.verification_token });
  Object.assign(data.event.message, { message_id: 'om_' + id, create_time: String(now), content: JSON.stringify({ text: content }) });
  if (overrides.header) Object.assign(data.header, overrides.header);
  if (overrides.sender) Object.assign(data.event.sender, overrides.sender);
  if (overrides.message) Object.assign(data.event.message, overrides.message);
  return data;
}
export async function post(h, id, data, { encrypted = false, headers = {}, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  let raw = JSON.stringify(data);
  if (encrypted) {
    const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(credentials.encrypt_key).digest(), iv);
    raw = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(raw), cipher.final()]).toString('base64') });
  }
  const nonce = randomId(), signature = createHash('sha256').update(String(timestamp) + nonce + credentials.encrypt_key + raw).digest('hex');
  const response = await fetch(h.webhook + '/hooks/feishu/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Lark-Request-Timestamp': String(timestamp), 'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': signature, ...headers }, body: raw });
  return { status: response.status, value: await response.json() };
}
export async function until(read, check = v => !!v, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('channel_fixture_timeout');
}
export const finished = (h, id) => until(() => h.store.get('SELECT * FROM channel_inbox WHERE id=?', id), r => r && !['queued', 'running', 'submitted'].includes(r.state));
export function bindFixture(h, id, principal, actor = 'ou_alice', tenant = 'actor-tenant', app = 'cli_fixture') {
  h.store.run(`INSERT INTO external_identities(id,principal_id,provider,host,connector,external_tenant,external_actor,display_name,status,verified_at)
    VALUES(?,?,'feishu','open.feishu.cn',?,?,?,?,'active',?)`, randomId(), principal, id + ':' + app, tenant, actor, actor, Date.now());
}
export async function channelFixture(t, options = {}) {
  const wire = transport(); let service;
  const f = await managementFixture(t, { ...options, channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }, onChannels: s => { service = s; } });
  const id = await connector(f.admin), principal = (await f.admin('/api/auth/me')).value.id;
  bindFixture(f.h, id, principal);
  return { ...f, wire, service, id, principal };
}
export const directQuery = (project = '101', task = 'blocked') => '/project ' + project + ' /query ' + JSON.stringify({ operation: 'get_task', target: { project_id: project, task_id: task }, arguments: {} });
export async function group(admin, id, override = {}) {
  return admin('/api/channels/connectors/' + id + '/groups', 'PUT', { chat_id: 'oc_group', project_id: '101', fields: ['summary', 'status', 'operation'], sensitivity: 'private',
    audience_verified_until: Date.now() + 3500000, enabled: true, expected_revision: 0, ...override });
}
export const inGroup = (content, actor = 'ou_alice') => envelope('@_user_1 ' + content, { sender: { sender_id: { open_id: actor } },
  message: { chat_id: 'oc_group', chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] } });
export function cardEvent(token, message = 'remote-1', actor = 'ou_alice', chat = 'oc_private') {
  const e = envelope(); e.header.event_type = 'card.action.trigger';
  e.event = { operator: { open_id: actor, tenant_key: 'actor-tenant' }, context: { open_chat_id: chat, open_message_id: message }, action: { value: { token } } }; return e;
}
export const cardToken = sent => sent?.content.elements.flatMap(e => e.actions ?? []).find(a => a.value?.token)?.value.token;
export { digest };
