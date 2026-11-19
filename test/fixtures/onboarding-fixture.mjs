// Shared fixtures of the repository onboarding tests (#930, #932): the console API as a signed-in person, a repository as
// GitHub shows it to installation tokens, and an OpenAI-compatible model following a script per user request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { settled } from './management-fixture.mjs';
import { session } from '../../dist/app/auth.js';

export const client = (f, credentials) => async (path, method = 'GET', body) => {
  const response = await fetch(f.h.admin + path, { method, headers: { Cookie: 'bot_session=' + credentials.token, ...(method === 'GET' ? {} : { 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
};
// Installed in organization 10 through the fixture's installation 77, never started.
export const installed = (f, id) => {
  const now = new Date().toISOString();
  f.h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,'77',?,'10','fixture',1,1,?)`, f.a.id, id, 'fixture/project-' + id, now);
  f.h.store.run("INSERT OR REPLACE INTO installation_repositories VALUES('github.com/123/77',?,?,'10','fixture',1,1,?)", id, 'fixture/project-' + id, now);
};
export const readToken = 'onboarding-read-token-0123456789';
/**
 * Every repository fixture/project-<id> as GitHub shows it to an installation token: a README and the labels in `labels`
 * (shared by all of them). A label created through POST /labels joins the list; `created` records those requests.
 */
export function repositoryRoutes(f, labels = [{ name: 'bug', color: 'd73a4a', description: 'Something is broken' }]) {
  const { state } = f, created = [];
  state.route = (path, method, body, send) => {
    const id = /^\/repos\/fixture\/project-(\d+)\//.exec(path)?.[1] ?? /^\/repositories\/(\d+)$/.exec(path)?.[1];
    if (path.endsWith('/installation') && id) return send({ id: 77, account: { id: 10, login: 'fixture' }, events: [],
      permissions: { metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', actions: 'read', checks: 'read', statuses: 'read' } }), true;
    if (path === '/app/installations/77/access_tokens' && body.repository_ids) return send({ token: body.permissions.issues === 'write' ? 'onboarding-write-token' : readToken,
      expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions }, 201), true;
    if (/^\/repositories\/\d+$/.test(path)) return send({ id: Number(id), owner: { id: 10 }, full_name: 'fixture/project-' + id, default_branch: 'main' }), true;
    if (path.endsWith('/readme')) return send({ encoding: 'base64', content: Buffer.from('# Project\nA command line tool. Run `npm test`.').toString('base64') }), true;
    if (/\/labels(\?|$)/.test(path) && method === 'POST') { created.push({ path, body }); labels.push(body); return send(body, 201), true; }
    if (/\/labels(\?|$)/.test(path)) return send(new URL(path, 'http://x').searchParams.get('page') > 1 ? [] : labels), true;
    return false;
  };
  return { labels, created };
}
/**
 * An OpenAI-compatible fixture. `script(context)` returns the assistant messages of one user request, step by step; `gate`
 * holds a request until it is released.
 */
export async function provider(t, script) {
  const requests = [], state = { gate: null };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (state.gate) await state.gate;
    const context = JSON.parse(body.messages[1].content), steps = body.messages.filter(m => m.role === 'assistant').length;
    const messages = script(context, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: messages[Math.min(steps, messages.length - 1)] }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, state, url: `http://127.0.0.1:${server.address().port}/v1` };
}
/** One assistant message calling `[name, args]` tools; ids are unique per step. */
export const call = (step, ...calls) => ({ role: 'assistant', content: null, tool_calls: calls.map(([name, args], i) => ({ id: `call-${step}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
// Signs in through the fake GitHub as user `id` with this repository permission, and returns that person's console client.
export async function person(f, id, permission) {
  Object.assign(f.state, { id, login: 'user-' + id, owner: false, permission });
  const login = await f.login();
  // The client carries the person's principal id.
  return Object.assign(client(f, session(f.h.store, login.result.principal_id, login.result.identity_id)), { principal: login.result.principal_id });
}
export async function say(byWho, conversation, content) {
  const sent = await byWho(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: 'm-' + Math.random(), content });
  assert.equal(sent.status, 201, JSON.stringify(sent.value));
  return { id: sent.value.id, history: await settled(byWho, conversation, sent.value.id) };
}
/** Gives the management assistant a shared model served by `model`. */
export async function assistantModel(admin, model, name = 'Assistant fixture') {
  const shared = (await admin('/api/models', 'POST', { model_name: name, api_url: model.url, api_key: 'fixture-provider-key' })).value.model;
  const role = (await admin('/api/service-roles')).value.service_roles.find(r => r.id === 'management-assistant');
  await admin('/api/service-roles/management-assistant', 'PATCH', { expected_revision: role.revision, model_id: shared.id });
  return shared;
}
