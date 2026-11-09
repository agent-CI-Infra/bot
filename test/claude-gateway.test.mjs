import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { claudeModelGateway } from '../dist/harness/claude-gateway.js';
import { Redactor, TaskError } from '../dist/agent/common.js';

test('in-process Claude gateway + synthetic provider rejects foreign tokens, endpoints, models and server tools', async t => {
  mkdirSync('.tmp/claude-gateway-tests', { recursive: true }); const root = mkdtempSync(resolve('.tmp/claude-gateway-tests/run-'));
  const keyFile = join(root, 'provider.key'); writeFileSync(keyFile, 'fixture-provider-service-key', { mode: 0o600 });
  let upstreamCalls = 0, revoked = false;
  const upstream = createServer(async (req, res) => { upstreamCalls++; assert.equal(req.headers['x-api-key'], 'fixture-provider-service-key'); for await (const chunk of req) {} res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'claude-probe-20260101' }] })); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const spec = { runAccess: { check: token => { if (revoked || token !== 'run-only-capability') throw new TaskError('run_token_invalid', 'failed'); } }, guard: async () => {}, redactor: new Redactor(), maxOutputTokens: 256, harnessPreparation: { config: { model: 'claude-probe-20260101' } }, tools: [{ function: { name: 'read_task_record' } }] };
  const gateway = await claudeModelGateway(spec, { baseUrl: 'http://127.0.0.1:' + upstream.address().port, credentialFile: keyFile }, { run_id: 'run-1', lease_epoch: 7 }, new AbortController().signal);
  t.after(async () => { await gateway.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); rmSync(root, { recursive: true, force: true }); });
  const request = (path, body, token = 'run-only-capability') => fetch(gateway.url + path, { method: body ? 'POST' : 'GET', headers: { 'x-api-key': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/v1/models', null, 'wrong-run')).status, 401); assert.equal(upstreamCalls, 0);
  assert.equal((await request('/github/pull_requests')).status, 403); assert.equal(upstreamCalls, 0);
  const models = await request('/v1/models'); assert.equal(models.headers.get('x-bot-run-id'), 'run-1'); assert.equal(models.headers.get('x-bot-lease-epoch'), '7'); assert.ok(!(await models.text()).includes('service-key')); assert.equal(upstreamCalls, 1);
  const valid = { model: 'claude-probe-20260101', max_tokens: 256, messages: [], tools: [{ name: 'mcp__bot__read_task_record', input_schema: { type: 'object' } }] };
  for (const change of [{ model: 'other-model' }, { max_tokens: 257 }, { tools: [{ name: 'Bash' }] }, { tools: [{ name: 'mcp__bot__read_task_record', type: 'web_search_20250305' }] }, { mcp_servers: [] }, { container: {} }, { tool_choice: { type: 'tool', name: 'Bash' } }]) assert.equal((await request('/v1/messages', { ...valid, ...change })).status, 403);
  assert.equal(upstreamCalls, 1); assert.equal((await request('/v1/messages?beta=true', valid)).status, 200); assert.equal(upstreamCalls, 2);
  revoked = true; assert.equal((await request('/v1/messages', valid)).status, 401); assert.equal(upstreamCalls, 2);
});

async function streamingGateway(t, respond, timing = { firstByteMs: 200, idleMs: 100 }) {
  mkdirSync('.tmp/claude-gateway-tests', { recursive: true }); const root = mkdtempSync(resolve('.tmp/claude-gateway-tests/stream-'));
  const credentialFile = join(root, 'provider.key'); writeFileSync(credentialFile, 'synthetic-stream-service-key', { mode: 0o600 });
  const snapshots = [], upstream = createServer(respond); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = await claudeModelGateway({ runAccess: { check: v => assert.equal(v, 'stream-run-capability') }, guard: async () => {}, redactor: new Redactor(), maxOutputTokens: 1024,
    harnessPreparation: { config: { model: 'claude-stream-20260101' } }, tools: [], onExternalUsage: u => snapshots.push(u) },
    { baseUrl: 'http://127.0.0.1:' + upstream.address().port, credentialFile }, { run_id: 'stream-run', lease_epoch: 1 }, new AbortController().signal, timing);
  t.after(async () => { await gateway.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); rmSync(root, { recursive: true, force: true }); });
  const request = () => fetch(gateway.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'stream-run-capability' }, body: JSON.stringify({ model: 'claude-stream-20260101', max_tokens: 1024, tools: [], messages: [] }) });
  return { gateway, request, snapshots };
}
const sse = (res, value) => res.write('data: ' + JSON.stringify(value) + '\n\n');

test('in-process gateway + slow synthetic SSE keeps active generation beyond header and idle timeout durations', async t => {
  const f = await streamingGateway(t, async (req, res) => {
    for await (const chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_slow_usage' });
    sse(res, { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } });
    for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 30)); sse(res, { type: 'ping' }); }
    sse(res, { type: 'message_delta', usage: { output_tokens: 777 } }); sse(res, { type: 'message_stop' }); res.end();
  });
  const response = await f.request(); assert.equal(response.status, 200); const raw = await response.text(); assert.ok(raw.includes('message_stop'));
  assert.ok(f.snapshots.some(u => u.unknown_requests === 1), 'in-flight output=0 is not final usage');
  assert.equal(f.gateway.usage().output_tokens, 777); assert.equal(f.gateway.usage().input_tokens, 5); assert.equal(f.gateway.usage().unknown_requests, 0);
});

test('in-process gateway + incomplete synthetic SSE retains unknown output and a reconciliation receipt', async t => {
  const f = await streamingGateway(t, async (req, res) => {
    for await (const chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_missing_usage' });
    sse(res, { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }); sse(res, { type: 'message_stop' }); res.end();
  });
  await (await f.request()).text(); const usage = f.gateway.usage();
  assert.equal(usage.model_requests, 1); assert.equal(usage.unknown_requests, 1); assert.equal(usage.semantics, 'lower_bound');
  assert.equal(usage.unresolved_requests[0].provider_request_id, 'req_missing_usage'); assert.match(usage.reconciliation, /provider records/);
});

test('in-process gateway + idle synthetic upstream times out without turning missing usage into known zero', async t => {
  const f = await streamingGateway(t, async (req, res) => {
    for await (const chunk of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } });
  }, { firstByteMs: 200, idleMs: 60 });
  const response = await f.request(); await assert.rejects(response.text());
  await f.gateway.close(); assert.equal(f.gateway.usage().unknown_requests, 1); assert.equal(f.gateway.usage().unresolved_requests[0].reason, 'forwarded_without_final_usage');
});
