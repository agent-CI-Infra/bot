import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { agentLoop } from '../dist/agent/loop.js';
import { Redactor } from '../dist/agent/common.js';
import { testPrompt } from '../dist/app/model-probe.js';

// A fake OpenAI-compatible upstream. /v1 answers normally; /echo answers 401 and repeats the key it was given,
// the way a careless proxy might; every request is recorded.
async function upstream(t) {
  const requests = [], ids = Array.from({ length: 250 }, (_, i) => `model-${String(249 - i).padStart(3, '0')}`);
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = { method: req.method, path: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null }; requests.push(request);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/echo/')) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization.slice(7)}` } })); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) })); return; }
    if (req.url === '/v1/chat/completions') { res.end(JSON.stringify({ model: request.body.model + '-2026-01-01', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })); return; }
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, ids };
}

test('a model URL resolves to the same chat and list addresses everywhere, without adding or removing /v1', async t => {
  const h = await harness(t), { admin } = await setup(h);
  const resolve = async value => (await admin('/api/models/endpoints?api_url=' + encodeURIComponent(value))).value;
  const v1 = { chat_url: 'https://example.com/v1/chat/completions', models_url: 'https://example.com/v1/models', has_v1: true };
  for (const value of ['https://example.com/v1', 'https://example.com/v1/', 'https://example.com/v1/chat/completions', 'https://example.com/v1/chat/completions/'])
    assert.deepEqual(await resolve(value), v1, value);
  assert.deepEqual(await resolve('https://example.com'), { chat_url: 'https://example.com/chat/completions', models_url: 'https://example.com/models', has_v1: false });
  assert.deepEqual(await resolve('https://example.com/api/v3'), { chat_url: 'https://example.com/api/v3/chat/completions', models_url: 'https://example.com/api/v3/models', has_v1: false });
  // A host called v1 is not a /v1 path.
  assert.equal((await resolve('https://v1')).has_v1, false);
  assert.equal((await admin('/api/models/endpoints?api_url=' + encodeURIComponent('ftp://example.com/v1'))).status, 400);
  assert.equal((await admin('/api/models/endpoints')).status, 400);
  // Saved models carry the same resolution, and saving a URL without /v1 is still allowed.
  const saved = await admin('/api/models', 'POST', { api_url: 'https://example.com', api_key: testPassword(), model_name: 'plain' });
  assert.equal(saved.status, 201); assert.deepEqual(saved.value.model.endpoints, await resolve('https://example.com'));
});

test('listing and testing an unsaved model call the upstream with the submitted key and return no key', async t => {
  const h = await harness(t), { admin } = await setup(h), fake = await upstream(t), key = 'sk-' + randomBytes(24).toString('hex');
  const rows = () => ['models', 'audit'].map(table => h.store.get(`SELECT count(*) n FROM ${table}`).n), before = rows();
  const list = await admin('/api/models/upstream', 'POST', { repository_id: null, api_url: fake.origin + '/v1/', api_key: key });
  assert.equal(list.status, 201);
  assert.equal(list.value.ok, true); assert.equal(list.value.models_url, fake.origin + '/v1/models');
  assert.equal(list.value.total, 250); assert.equal(list.value.truncated, true); assert.equal(list.value.models.length, 200);
  assert.deepEqual(list.value.models, [...fake.ids].sort().slice(0, 200));
  assert.deepEqual(fake.requests.at(-1), { method: 'GET', path: '/v1/models', authorization: 'Bearer ' + key, body: null });

  const probe = await admin('/api/models/test', 'POST', { repository_id: null, api_url: fake.origin + '/v1/chat/completions', api_key: key, model_name: 'fixture' });
  assert.equal(probe.value.ok, true); assert.equal(probe.value.status, 200); assert.equal(probe.value.chat_url, fake.origin + '/v1/chat/completions');
  assert.equal(probe.value.model, 'fixture-2026-01-01'); assert.equal(probe.value.reply, 'ok'); assert.equal(typeof probe.value.elapsed_ms, 'number');
  // The test sends one tiny output limit under max_completion_tokens and a fixed prompt with no project data.
  const sent = fake.requests.at(-1).body;
  assert.equal(sent.max_completion_tokens, 32); assert.ok(!('max_tokens' in sent)); assert.equal(sent.stream, false); assert.equal(sent.model, 'fixture');
  assert.deepEqual(sent.messages, [{ role: 'user', content: testPrompt }]);

  // Upstream failures report the status and a short message; the key the upstream echoed is scrubbed.
  for (const [path, body] of [['/api/models/upstream', {}], ['/api/models/test', { model_name: 'fixture' }]]) {
    const failed = await admin(path, 'POST', { repository_id: null, api_url: fake.origin + '/echo/v1', api_key: key, ...body });
    assert.equal(failed.value.ok, false); assert.equal(failed.value.status, 401); assert.equal(failed.value.error, 'upstream_http_error');
    assert.equal(failed.value.message, 'Incorrect API key provided: [REDACTED]'); assert.ok(!JSON.stringify(failed.value).includes(key));
  }
  const missing = await admin('/api/models/test', 'POST', { repository_id: null, api_url: fake.origin, api_key: key, model_name: 'fixture' });
  assert.equal(missing.value.status, 404); assert.equal(missing.value.chat_url, fake.origin + '/chat/completions'); assert.equal(missing.value.message, 'Not found');
  const closed = createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening'); const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const unreachable = await admin('/api/models/upstream', 'POST', { repository_id: null, api_url: `http://127.0.0.1:${port}/v1`, api_key: key });
  assert.equal(unreachable.value.ok, false); assert.equal(unreachable.value.status, null); assert.equal(unreachable.value.error, 'upstream_unreachable');
  // Our own validation errors carry codes only.
  const invalid = await admin('/api/models/test', 'POST', { repository_id: null, api_url: 'ftp://example.com', api_key: key, model_name: 'fixture' });
  assert.equal(invalid.status, 400); assert.deepEqual(invalid.value, { error: 'invalid_api_url' });
  assert.equal((await admin('/api/models/upstream', 'POST', { repository_id: null, api_url: fake.origin, api_key: key, model_name: 'extra' })).status, 400);
  // Unsaved probes write nothing.
  assert.deepEqual(rows(), before);
  assert.ok(!JSON.stringify((await admin('/api/audit')).value).includes(key));
});

test('a saved model is listed and tested with its stored key under the editing right, and audited without the key', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin), fake = await upstream(t);
  await repository(admin, a.id, '101'); await repository(admin, a.id, '202');
  const password = testPassword(); await admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  const ownKey = 'sk-' + randomBytes(24).toString('hex'), sharedKey = 'sk-' + randomBytes(24).toString('hex');
  const own = (await member('/api/models', 'POST', { repository_id: '101', api_url: fake.origin + '/v1', api_key: ownKey, model_name: 'own' })).value.model;
  const shared = (await admin('/api/models', 'POST', { api_url: fake.origin + '/echo/v1', api_key: sharedKey, model_name: 'shared' })).value.model;

  const listed = await member(`/api/models/${own.id}/upstream`, 'POST', {});
  assert.equal(listed.value.ok, true); assert.equal(listed.value.models.length, 200); assert.equal(fake.requests.at(-1).authorization, 'Bearer ' + ownKey);
  const tested = await member(`/api/models/${own.id}/test`, 'POST', {});
  assert.equal(tested.value.ok, true); assert.equal(tested.value.model, 'own-2026-01-01'); assert.equal(fake.requests.at(-1).body.max_completion_tokens, 32);
  assert.equal((await member(`/api/models/${own.id}/test`, 'POST', { model_name: 'other' })).status, 400);

  // A project administrator can neither list nor test a shared model: invisible before the grant, forbidden after it.
  const calls = fake.requests.length;
  for (const action of ['upstream', 'test']) assert.equal((await member(`/api/models/${shared.id}/${action}`, 'POST', {})).status, 404);
  await admin(`/api/models/${shared.id}/projects`, 'PUT', { repository_ids: ['101'] });
  for (const action of ['upstream', 'test']) {
    const denied = await member(`/api/models/${shared.id}/${action}`, 'POST', {});
    assert.equal(denied.status, 403); assert.deepEqual(denied.value, { error: 'super_admin_required' });
  }
  // Nor probe an unsaved model for another project or as a shared model.
  assert.equal((await member('/api/models/upstream', 'POST', { repository_id: '202', api_url: fake.origin + '/v1', api_key: ownKey })).status, 403);
  assert.equal((await member('/api/models/test', 'POST', { repository_id: null, api_url: fake.origin + '/v1', api_key: ownKey, model_name: 'x' })).status, 403);
  assert.equal(fake.requests.length, calls);
  assert.equal((await member('/api/models/upstream', 'POST', { repository_id: '101', api_url: fake.origin + '/v1', api_key: ownKey })).value.ok, true);

  // The super administrator may test the shared model; the upstream's echo of its key is scrubbed from the response.
  const failed = await admin(`/api/models/${shared.id}/test`, 'POST', {});
  assert.equal(failed.value.status, 401); assert.ok(!JSON.stringify(failed.value).includes(sharedKey));
  const audit = (await admin('/api/audit')).value.audit;
  assert.deepEqual(audit.filter(r => ['model.upstream_listed', 'model.tested'].includes(r.action)).map(r => [r.action, r.resource_id]).sort(),
    [['model.tested', own.id], ['model.tested', shared.id], ['model.upstream_listed', own.id]].sort());
  for (const secret of [ownKey, sharedKey]) assert.ok(!JSON.stringify(audit).includes(secret));

  // A revoked key cannot be used.
  await member(`/api/models/${own.id}/credentials/revoke`, 'POST', {});
  assert.deepEqual((await member(`/api/models/${own.id}/test`, 'POST', {})).value, { error: 'model_key_missing' });
});

test('task model calls use the shared address rule and keep their single 8192 output limit', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin), fake = await upstream(t); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: fake.origin + '/v1/chat/completions/', api_key: 'task-fixture-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.id });
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,claim_token) VALUES('probe','101','review.pr','running','pr',4,'claim')");
  const finish = { summary: 'Done.', requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '', findings: [] };
  let asked = false;
  const workspace = { log: () => {}, call: async (_key, input) => {
    if (input.type !== 'workspace_agent_poll') return { written: true, started: true };
    if (asked) return { state: 'completed', result: finish, events: [], offset: 0 };
    asked = true; return { state: 'running', request: { id: '1'.padStart(48, '0'), body: { model: 'runner', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 } }, events: [], offset: 0 };
  } };
  await agentLoop(h.store, h.store.get("SELECT * FROM tasks WHERE id='probe'"), workspace, new Redactor(), async () => {}, { mode: 'review' });
  const call = fake.requests.find(r => r.method === 'POST');
  assert.equal(call.path, '/v1/chat/completions'); assert.equal(call.body.max_tokens, 8192); assert.ok(!('max_completion_tokens' in call.body));
});
