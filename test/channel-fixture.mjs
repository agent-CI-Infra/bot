import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { managementFixture } from './management-fixture.mjs';
import { digest, randomId } from '../dist/core/security.js';
import { FEISHU_SCOPES } from '../dist/channels/feishu.js';
import { resolvePrincipalActor } from '../dist/identity/authorization.js';

export const credentials = { app_secret: 'fixture-feishu-app-secret', encrypt_key: 'fixture-feishu-encrypt-key', verification_token: 'fixture-feishu-verification-token' };
export function transport() {
  const sent = [], state = { sendFailures: 0, reactionRequests: [], reactions: [], reactionHandler: null, reactionSequence: 0, authGate: null, authRequests: [], authStarted: 0, authCode: 0, botCode: 0, botOpenId: 'ou_bot', appName: 'Fixture bot', currentAppName: null, applicationCode: 0, applicationId: null, tenantCode: 0, installationTenant: 'install-tenant', tenantName: 'Fixture enterprise', tenantGate: null, tenantStarted: 0, historyRequests: [], history: null,
    audienceRequests: [], audience: null, inChat: true, profileRequests: [], profileGate: null, profileCode: 0, profileOpenId: null, profileName: '张小明', scopeCode: 0, scopes: null, scopeRequests: 0,
    members: [{ member_id_type: 'open_id', member_id: 'ou_alice', tenant_key: 'actor-tenant' }, { member_id_type: 'open_id', member_id: 'ou_bob', tenant_key: 'actor-tenant' }] };
  return { sent, state, fetch: async (url, init) => {
    if (url.includes('/auth/')) {
      state.authStarted++;
      if (state.authGate) await state.authGate;
      const auth = JSON.parse(init.body); state.authRequests.push({ url, tenant_key: auth.tenant_key, app_id: auth.app_id });
      if (url.endsWith('/app_access_token')) return Response.json({ code: 0, app_access_token: 'fixture-app-access-token' });
      return Response.json({ code: state.authCode, tenant_access_token: 'fixture-only-access-token', msg: 'fixture-feishu-app-secret' });
    }
    if (url.includes('/reactions')) {
      const path = new URL(url).pathname.split('/'), message = decodeURIComponent(path[5]), reaction = path[7] && decodeURIComponent(path[7]);
      const request = { url, method: init.method, message, reaction, ...(init.body ? JSON.parse(init.body) : {}) };
      state.reactionRequests.push(request);
      if (state.reactionHandler) { const response = await state.reactionHandler(request); if (response) return response; }
      if (init.method === 'POST') {
        const item = { message, reaction_id: 'reaction-' + ++state.reactionSequence, operator: { operator_type: 'app', operator_id: 'cli_fixture' }, reaction_type: request.reaction_type };
        state.reactions.push(item); return Response.json({ code: 0, data: item });
      }
      if (init.method === 'DELETE') { state.reactions = state.reactions.filter(r => r.reaction_id !== reaction || r.message !== message); return Response.json({ code: 0, data: {} }); }
      return Response.json({ code: 0, data: { items: state.reactions.filter(r => r.message === message), has_more: false } });
    }
    if (state.sendFailures && ['POST', 'PATCH'].includes(init.method) && url.includes('/im/v1/messages')) {
      state.sendFailures--; return Response.json({ code: 999, msg: 'fixture failure' }, { status: 503 });
    }
    if (url.endsWith('/bot/v3/info')) return Response.json({ code: state.botCode, bot: { open_id: state.botOpenId, app_name: state.appName }, msg: 'fixture-only-access-token' });
    if (url.includes('/contact/v3/users/')) {
      state.profileRequests.push(url); if (state.profileGate) await state.profileGate;
      return Response.json({ code: state.profileCode, data: { user: { open_id: state.profileOpenId ?? decodeURIComponent(new URL(url).pathname.split('/').at(-1)),
        name: state.profileName, email: 'must-not-expose-profile-email', mobile: 'must-not-expose-profile-phone' } }, msg: 'fixture-only-access-token' });
    }
    if (url.endsWith('/application/v6/scopes')) {
      state.scopeRequests++;
      // Defaults to every required scope granted; tests replace the list to simulate a partly configured app.
      return Response.json({ code: state.scopeCode, data: { scopes: state.scopes ?? FEISHU_SCOPES.map(s => ({ scope_name: s.scope, grant_status: 1, scope_type: 'tenant' })) } });
    }
    if (url.includes('/application/v6/applications/')) return Response.json({ code: state.applicationCode, data: { app: {
      app_id: state.applicationId ?? decodeURIComponent(new URL(url).pathname.split('/').at(-1)), app_name: state.currentAppName ?? state.appName,
      secret: 'must-not-return-app-secret', encryption: { verification_token: 'must-not-return-verification-token' } } } });
    if (url.endsWith('/tenant/v2/tenant/query')) {
      state.tenantStarted++; if (state.tenantGate) await state.tenantGate;
      return Response.json({ code: state.tenantCode, data: { tenant: { tenant_key: state.installationTenant, name: state.tenantName } }, msg: 'fixture-only-access-token' }, { status: state.tenantCode === 1184001 ? 403 : 200 });
    }
    if (init.method === 'GET' && url.includes('/im/v1/messages?')) {
      state.historyRequests.push(url);
      return state.history ? state.history(new URL(url)) : Response.json({ code: 0, data: { items: [], has_more: false } });
    }
    if (init.method === 'GET' && url.includes('/members')) {
      state.audienceRequests.push(url);
      if (state.audience) return state.audience(new URL(url));
      return Response.json({ code: 0, data: url.endsWith('/is_in_chat') ? { is_in_chat: state.inChat } : { items: state.members, has_more: false } });
    }
    const request = JSON.parse(init.body); sent.push({ url, method: init.method, ...request, content: JSON.parse(request.content) });
    return Response.json({ code: 0, data: { message_id: 'remote-' + sent.length } });
  } };
}
export async function connector(admin, override = {}) {
  const result = await admin('/api/channels/connectors', 'POST', { app_id: 'cli_fixture', installation_tenant: 'install-tenant',
    bot_open_id: 'ou_bot', application_type: 'enterprise', transport: 'http', enabled: true, credentials, expected_revision: 0, ...override });
  if (result.status !== 201) throw new Error(JSON.stringify(result));
  return result.value.connector_id;
}
export function envelope(content = '查询 blocked 任务的进展', overrides = {}) {
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
  const f = await managementFixture(t, store => ({ ...(typeof options === 'function' ? options(store) : options), channels: { origin: 'https://console.example.test', fetch: wire.fetch, longConnections: false }, onChannels: s => { service = s; } }));
  f.h.channels = service;
  const id = await connector(f.admin), principal = (await f.admin('/api/auth/me')).value.id;
  bindFixture(f.h, id, principal);
  return { ...f, wire, service, id, principal };
}
/** A private chat owned by a bound user, as their first message leaves it, without running the assistant (the message is too old to act on). */
export async function privateChat(f, actor = 'ou_alice', principal = f.principal, chat = 'oc_private') {
  const quiet = envelope('earlier private message', { sender: { sender_id: { open_id: actor } }, message: { chat_id: chat, create_time: String(Date.now() - 3600000) } });
  await post(f.h, f.id, quiet);
  const row = f.h.store.get("SELECT * FROM channel_chats WHERE chat_type='p2p' AND chat_id=?", chat);
  f.h.store.run('INSERT OR REPLACE INTO channel_personal_owners VALUES(?,?,?,?)', row.id, principal, actor, 'actor-tenant');
  return row;
}
/** A group bound to the repository assistant over the given projects by the platform administrator (who is in the group). */
export async function boundGroup(f, projects = ['101'], chat = 'oc_group', client = f.admin) {
  const quiet = inGroup('Group discussion', 'ou_alice'); quiet.event.message.mentions = []; quiet.event.message.chat_id = chat; await post(f.h, f.id, quiet);
  const row = f.h.store.get('SELECT * FROM channel_chats WHERE chat_id=?', chat);
  const revision = f.h.store.get('SELECT revision FROM channel_service_bindings WHERE chat_id=?', row.id)?.revision ?? 0;
  const result = await client('/api/channels/chats/' + row.id + '/service-binding', 'PUT', { service_role_id: 'repository-assistant', scope: { kind: 'repositories', repositories: projects }, enabled: true, expected_revision: revision });
  if (result.status !== 200) throw new Error(JSON.stringify(result.value));
  return row;
}
/** A project notification destination for a chat, registered for the client's user as a project's schedule panel does when that
 * chat is chosen (#330); there is no separate registration endpoint any more. */
export async function registerDestination(client, chat, project = '101') {
  const h = client.harness, principal = (await client('/api/auth/me')).value.id;
  return h.channels.registerDestination(resolvePrincipalActor(h.store, principal, null), chat.id, { project_id: project }).id;
}
export const inGroup = (content, actor = 'ou_alice') => envelope('@_user_1 ' + content, { sender: { sender_id: { open_id: actor } },
  message: { chat_id: 'oc_group', chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] } });
export function cardEvent(token, message = 'remote-1', actor = 'ou_alice', chat = 'oc_private') {
  const e = envelope(); e.header.event_type = 'card.action.trigger';
  e.event = { operator: { open_id: actor, tenant_key: 'actor-tenant' }, context: { open_chat_id: chat, open_message_id: message }, action: { value: { token } } }; return e;
}
export const cardToken = sent => sent?.content.elements.flatMap(e => e.actions ?? []).find(a => a.value?.token)?.value.token;
export { digest };
/** A model that takes one step per request: each step is [tool, args], a final answer string, or a function of
 * (earlier tool results, the request context) returning either. It serves the management assistant and group assistants. */
export function scriptedModel(f, steps) {
  f.modelState.respond = async (body, res) => {
    const done = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    let step = steps[done.length] ?? '已完成。';
    if (typeof step === 'function') step = step(done, JSON.parse(body.messages[1].content));
    const message = typeof step === 'string' ? { role: 'assistant', content: step }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + done.length, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  };
}
/** A private message's management outcome: the inbox row, its management message state and the error event code, if any. */
export function managementOutcome(h, inbox) {
  const row = h.store.get('SELECT * FROM channel_inbox WHERE id=?', inbox), message = row?.message_id ? h.store.get('SELECT * FROM management_messages WHERE id=?', row.message_id) : null;
  const error = message ? h.store.get("SELECT data FROM management_events WHERE message_id=? AND type='error' ORDER BY sequence DESC LIMIT 1", message.id) : null;
  return { state: row?.state, error: row?.error ?? (error ? JSON.parse(error.data).error : null), message: message?.state ?? null, input: message ? JSON.parse(message.input) : null };
}
/** Give the repository assistant the shared fixture model and, optionally, other permission items. */
export async function repositoryAssistant(f, permissions) {
  const role = (await f.admin('/api/service-roles')).value.service_roles.find(r => r.id === 'repository-assistant');
  const result = await f.admin('/api/service-roles/repository-assistant', 'PATCH', { expected_revision: role.revision, model_id: f.assistantModel.id, ...(permissions ? { permissions } : {}) });
  if (result.status !== 200) throw new Error(JSON.stringify(result.value));
}
