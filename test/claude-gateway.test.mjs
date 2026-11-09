import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { claudeModelGateway } from '../dist/harness/claude-gateway.js';
import { Redactor, TaskError } from '../dist/agent/common.js';

test('run-local Claude gateway never exposes the service key and rejects foreign tokens, endpoints, models and server tools', async t => {
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
