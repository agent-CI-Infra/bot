import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
process.env.BOT_LOCAL_EXECUTION = 'true';
process.env.BOT_LOCAL_WORKSPACE = tmpdir();
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { openModel } from '../../../../dist/agent/model.js';
import { ModelCatalog, saveModelMetadata } from '../../../../dist/models/catalog.js';
import { savePricing } from '../../../../dist/metrics/accounting.js';
import { allocateLease, issueRunToken, roleRunStorage, verifyRunToken } from '../../../../dist/roles/role-run.js';
import { beginRun } from '../../../../dist/tasks/trace.js';
import { createModelGatewayHub, DEFAULT_MODEL_GATEWAY_SOCKET, readProviderCredentialFile, resolveControlPlaneModelGatewaySocket } from '../../../../dist/harness/model-gateway.js';
const { startModelBridge } = await import('../../../../runner/model-relay.mjs');

const hex48 = () => randomBytes(24).toString('hex');

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

async function createGatewayRig(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'model-gw-'));
  const store = new Store(':memory:', randomBytes(32), join(root, 'trajectories'));
  roleRunStorage(store);
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });

  const repoId = '101';
  const taskId = 'task-gw-1';
  const role = options.role ?? 'developer';
  store.run("INSERT INTO accounts VALUES('acc','org','github_app','1','{}','2026-01-01T00:00:00Z')");
  store.run('INSERT INTO repositories VALUES(?,?,?,?)', repoId, 'org/repo', 'org', 'acc');
  store.run('INSERT INTO policies(repository_id,enabled) VALUES(?,1)', repoId);
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES(?,?,'development','running','Gateway test','{}',1,1)",
    taskId, repoId,
  );
  const run = beginRun(store, store.get('SELECT * FROM tasks WHERE id=?', taskId), 'execution', {});
  const runId = run.id;
  store.run('UPDATE task_runs SET role=? WHERE id=?', role, runId);
  const lease = allocateLease(store, taskId, 'assign-1', runId);
  const { token } = issueRunToken(store, {
    tenant_id: 'acc',
    project_id: repoId,
    task_id: taskId,
    run_id: runId,
    lease_epoch: lease.epoch,
    role,
  }, ['model:invoke']);
  const runAccess = {
    token,
    check: presented => verifyRunToken(store, presented, {
      tenant_id: 'acc',
      project_id: repoId,
      task_id: taskId,
      run_id: runId,
      lease_epoch: lease.epoch,
      role,
    }, 'model:invoke'),
  };

  const hub = createModelGatewayHub();
  const useUds = options.uds !== false;
  let socketDir = null;
  let socketPath = null;
  const redactor = new Redactor();
  let session = null;
  let bridge = null;

  t.after(async () => {
    await bridge?.close();
    await session?.close();
    await hub.closeAll();
    store.close();
    rmSync(root, { recursive: true, force: true });
    if (socketDir && socketDir !== root) rmSync(socketDir, { recursive: true, force: true });
  });

  if (useUds) {
    // Keep UDS path well below the Linux 107-byte sun_path limit even inside deep worktree TMPDIRs.
    const candidate = join(root, 'gateway.sock');
    socketDir = Buffer.byteLength(candidate, 'utf8') < 100 ? root : mkdtempSync(join('/tmp', 'mgw-'));
    socketPath = join(socketDir, 'gateway.sock');
    await hub.startUds(socketPath);
  }

  const taskRow = { ...store.get('SELECT * FROM tasks WHERE id=?', taskId), trace_run_id: runId, active_role: role };
  return {
    root,
    agentDir,
    socketPath,
    store,
    repoId,
    taskId,
    runId,
    role,
    token,
    runAccess,
    redactor,
    hub,
    taskRow,
    get bridge() { return bridge; },
    async startGateway(gwOptions = {}) {
      session = await hub.registerSession({
        store,
        task: taskRow,
        runId,
        leaseEpoch: lease.epoch,
        runAccess,
        redactor,
        preferLoopback: !useUds,
        ...gwOptions,
      });
      bridge = await startModelBridge({
        socketPath: session.socketPath ?? undefined,
        targetUrl: session.gatewayUrl ?? undefined,
      });
      return { session, bridge };
    },
  };
}

function addProjectModel(store, repoId, { id = hex48().slice(0, 16), url, key, name, interface_type, auth_header, pricing }) {
  store.run(
    'INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES(?,?,?,?,?,?,?)',
    id, repoId, url, name, store.secrets.seal({ value: key }, `model:${id}`), 1, '2026-01-01T00:00:00Z',
  );
  if (interface_type || auth_header) saveModelMetadata(store, id, { ...(interface_type ? { interface_type } : {}), ...(auth_header ? { auth_header } : {}) });
  if (pricing) savePricing(store, id, pricing);
  return openModel(store, store.get('SELECT * FROM models WHERE id=?', id));
}

test('UDS passthrough gateway streams Anthropic Messages verbatim with query preservation, accounting, delta trajectories, and zero disk writes', async t => {
  const upstreamReqs = [];
  const anthropicKey = 'sk-ant-uds-secret-' + randomBytes(16).toString('hex');
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    upstreamReqs.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const hasToolResult = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
    if (!hasToolResult) {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking workspace.' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_bash_1', name: 'Bash', input: {} } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } })}\n\n`);
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    } else {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 100, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All done!' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`);
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const rig = await createGatewayRig(t, { uds: true });
  const model = addProjectModel(rig.store, rig.repoId, {
    url: `http://127.0.0.1:${upstream.address().port}`,
    key: anthropicKey,
    name: 'claude-sonnet-4-5',
    interface_type: 'anthropic-messages',
    auth_header: 'x-api-key',
    pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2, cache_per_million: 0.1 },
  });
  await rig.startGateway({ primaryModel: model });

  // Turn 1: client alias is replaced with target model, query ?beta=true preserved, real x-api-key injected.
  const turn1Res = await fetch(`${rig.bridge.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': rig.token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'You are a helpful coding agent.',
      thinking: { type: 'enabled', budget_tokens: 1024 },
      stream: true,
      tools: [{ name: 'Bash', description: 'Run shell', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
      messages: [{ role: 'user', content: 'List files' }],
    }),
  });
  assert.equal(turn1Res.status, 200);
  assert.match(turn1Res.headers.get('content-type') || '', /text\/event-stream/);
  const turn1Sse = await turn1Res.text();
  assert.match(turn1Sse, /"text":"Checking workspace\."/);
  assert.match(turn1Sse, /"name":"Bash"/);
  assert.match(turn1Sse, /event: message_stop/);

  assert.equal(upstreamReqs.length, 1);
  assert.equal(upstreamReqs[0].url, '/v1/messages?beta=true');
  assert.equal(upstreamReqs[0].headers['x-api-key'], anthropicKey);
  assert.equal(upstreamReqs[0].headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(upstreamReqs[0].headers.authorization, undefined);
  assert.deepEqual(upstreamReqs[0].body.thinking, { type: 'enabled', budget_tokens: 1024 });

  // Turn 2: tool_result round-trip.
  const turn2Res = await fetch(`${rig.bridge.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': rig.token },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: 'user', content: 'List files' },
        { role: 'assistant', content: [{ type: 'text', text: 'Checking workspace.' }, { type: 'tool_use', id: 'call_bash_1', name: 'Bash', input: { cmd: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_bash_1', content: 'README.md\nsrc' }] },
      ],
    }),
  });
  assert.equal(turn2Res.status, 200);
  assert.match(await turn2Res.text(), /"text":"All done!"/);

  // Verify per-request ledger accounting & delta-encoded trajectories.
  const ledger = rig.store.all('SELECT * FROM model_requests WHERE task_id=? ORDER BY requested_at, rowid', rig.taskId);
  assert.equal(ledger.length, 2);
  assert.deepEqual([ledger[0].input_tokens, ledger[0].output_tokens, ledger[0].cached_input_tokens, ledger[0].state], [120, 30, 20, 'received']);
  assert.deepEqual([ledger[1].input_tokens, ledger[1].output_tokens, ledger[1].cached_input_tokens, ledger[1].state], [200, 10, 100, 'received']);
  assert.ok(ledger[0].cost > 0 && ledger[1].cost > 0);
  assert.ok(ledger[0].request_ref && ledger[0].response_ref && ledger[1].request_ref && ledger[1].response_ref);
  assert.equal(rig.store.trajectories.readModelRequest(ledger[1].request_ref).messages.length, 3);
  assert.ok(!JSON.stringify(ledger).includes(anthropicKey));

  // Pure in-memory bridge leaves zero mailbox files under agent/.
  assert.deepEqual(readdirSync(rig.agentDir), []);
  for (const file of collectFiles(rig.root)) {
    if (file.endsWith('.sock')) continue;
    assert.ok(!readFileSync(file, 'utf8').includes(anthropicKey), `provider key leaked into ${file}`);
  }
});

test('strict passthrough rejects protocol mismatches with 400 model_protocol_mismatch without calling upstream', async t => {
  const rig = await createGatewayRig(t, { uds: true });
  let upstreamCalled = 0;
  const chatModel = addProjectModel(rig.store, rig.repoId, {
    url: 'https://chat.internal/v1',
    key: 'sk-chat-only',
    name: 'chat-only-model',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });
  addProjectModel(rig.store, rig.repoId, {
    url: 'https://resp.internal/v1/responses',
    key: 'sk-resp-only',
    name: 'responses-only-model',
    interface_type: 'openai-responses',
    auth_header: 'bearer',
  });
  addProjectModel(rig.store, rig.repoId, {
    url: 'https://anth.internal/v1/messages',
    key: 'sk-anth-only',
    name: 'anthropic-only-model',
    interface_type: 'anthropic-messages',
    auth_header: 'x-api-key',
  });

  await rig.startGateway({
    primaryModel: chatModel,
    allowVisibleModels: true,
    fetcher: async () => {
      upstreamCalled++;
      return new Response(JSON.stringify({ id: 'ok', choices: [{ message: { role: 'assistant', content: 'ok' } }], output: [], content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  // Cross-protocol calls are strictly rejected (no translation).
  const mismatches = [
    ['/v1/messages', { 'x-api-key': rig.token }, { model: 'chat-only-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/responses', { Authorization: `Bearer ${rig.token}` }, { model: 'chat-only-model', input: 'hi' }],
    ['/v1/chat/completions', { Authorization: `Bearer ${rig.token}` }, { model: 'responses-only-model', messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/messages', { 'x-api-key': rig.token }, { model: 'responses-only-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/chat/completions', { Authorization: `Bearer ${rig.token}` }, { model: 'anthropic-only-model', messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/responses', { Authorization: `Bearer ${rig.token}` }, { model: 'anthropic-only-model', input: 'hi' }],
  ];
  for (const [path, auth, body] of mismatches) {
    const res = await fetch(`${rig.bridge.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `${path} with ${body.model} must return 400`);
    const text = await res.text();
    assert.match(text, /model_protocol_mismatch/, `${path} with ${body.model}: ${text}`);
  }
  assert.equal(upstreamCalled, 0, 'protocol mismatches must never reach upstream');

  // Matching protocols succeed verbatim.
  for (const [path, auth, body] of [
    ['/v1/chat/completions', { Authorization: `Bearer ${rig.token}` }, { model: 'chat-only-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/responses', { Authorization: `Bearer ${rig.token}` }, { model: 'responses-only-model', stream: false, input: 'hi' }],
    ['/v1/messages', { 'x-api-key': rig.token }, { model: 'anthropic-only-model', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hi' }] }],
  ]) {
    const res = await fetch(`${rig.bridge.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200, `matching ${path} with ${body.model}`);
  }
  assert.equal(upstreamCalled, 3);
});

test('rejects missing, invalid, other-run, wrong-role and revoked tokens, unconfigured models, and disabled policies', async t => {
  const rig = await createGatewayRig(t, { uds: true });
  let upstreamCalled = 0;
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'https://relay.internal:8080/v1',
    key: 'sk-non-loopback-secret',
    name: 'qwen3-coder',
    interface_type: 'openai-chat-completions',
    auth_header: 'x-api-key',
  });
  await rig.startGateway({
    primaryModel: model,
    fetcher: async (url, init) => {
      upstreamCalled++;
      assert.equal(url, 'https://relay.internal:8080/v1/chat/completions');
      assert.equal(init.headers['x-api-key'], 'sk-non-loopback-secret');
      assert.equal(init.headers.Authorization, undefined);
      return new Response(JSON.stringify({
        id: 'cmpl-1', model: 'qwen3-coder',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  // 1. Missing token rejected.
  assert.equal((await fetch(`${rig.bridge.url}/v1/models`)).status, 401);
  // 2. Mismatched Bearer + x-api-key rejected.
  assert.equal((await fetch(`${rig.bridge.url}/v1/models`, { headers: { 'x-api-key': rig.token, Authorization: 'Bearer other' } })).status, 401);
  // 3. Forged token rejected.
  assert.equal((await fetch(`${rig.bridge.url}/v1/models`, { headers: { 'x-api-key': 'rt_forged_token_value' } })).status, 401);
  // 4. Token from another run / wrong role rejected.
  const otherRun = beginRun(rig.store, rig.store.get('SELECT * FROM tasks WHERE id=?', rig.taskId), 'execution', {});
  rig.store.run("UPDATE task_runs SET role='reviewer' WHERE id=?", otherRun.id);
  const otherLease = allocateLease(rig.store, rig.taskId, 'assign-2', otherRun.id);
  const { token: otherRoleToken } = issueRunToken(rig.store, {
    tenant_id: 'acc', project_id: rig.repoId, task_id: rig.taskId, run_id: otherRun.id, lease_epoch: otherLease.epoch, role: 'reviewer',
  }, ['model:invoke']);
  assert.equal((await fetch(`${rig.bridge.url}/v1/models`, { headers: { Authorization: `Bearer ${otherRoleToken}` } })).status, 401);

  // 5. GET /v1/models comes from configured catalog without calling upstream.
  const modelsRes = await fetch(`${rig.bridge.url}/v1/models`, { headers: { Authorization: `Bearer ${rig.token}` } });
  assert.equal(modelsRes.status, 200);
  const modelsJson = await modelsRes.json();
  assert.equal(modelsJson.object, 'list');
  assert.ok(modelsJson.data.some(m => m.id === 'qwen3-coder' && m.interface_type === 'openai-chat-completions'));
  assert.equal(upstreamCalled, 0);

  // 6. Unlisted endpoint rejected.
  assert.equal((await fetch(`${rig.bridge.url}/v1/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);

  // 7. Unconfigured model name rejected.
  const deniedModel = await fetch(`${rig.bridge.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'unapproved-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(deniedModel.status, 403);
  assert.equal(upstreamCalled, 0);

  // 8. Valid call succeeds with configured x-api-key auth.
  const allowed = await fetch(`${rig.bridge.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder', messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(upstreamCalled, 1);

  // 9. Disabling repository policy immediately blocks subsequent calls.
  rig.store.run('UPDATE policies SET enabled=0 WHERE repository_id=?', rig.repoId);
  assert.equal((await fetch(`${rig.bridge.url}/v1/models`, { headers: { Authorization: `Bearer ${rig.token}` } })).status, 403);
  rig.store.run('UPDATE policies SET enabled=1 WHERE repository_id=?', rig.repoId);

  // 10. Revoking run token immediately blocks calls.
  rig.store.run('UPDATE role_run_tokens SET revoked_at=? WHERE run_id=?', Date.now(), rig.runId);
  assert.equal((await fetch(`${rig.bridge.url}/v1/models`, { headers: { Authorization: `Bearer ${rig.token}` } })).status, 401);
});

test('supports parallel sub-agent requests, >320 KiB prompts and >95 KiB responses directly over UDS without disk buffering', async t => {
  const rig = await createGatewayRig(t, { uds: true });
  const largeOutput = 'A'.repeat(95_000);
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'https://relay.internal:8080/v1',
    key: 'sk-parallel-key-secret',
    name: 'glm-5',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });
  await rig.startGateway({
    primaryModel: model,
    fetcher: async (_url, init) => {
      const parsed = JSON.parse(init.body);
      const tag = parsed.messages.at(-1).content.slice(0, 12);
      await new Promise(resolve => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        id: 'cmpl-' + tag,
        model: 'glm-5',
        choices: [{ index: 0, message: { role: 'assistant', content: `${tag}:${largeOutput}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const hugePrompt = 'LARGE_PROMPT' + 'x'.repeat(320_000);
  const [r1, r2, r3] = await Promise.all([
    fetch(`${rig.bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', stream: false, messages: [{ role: 'user', content: hugePrompt }] }),
    }).then(r => r.json()),
    fetch(`${rig.bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', stream: false, messages: [{ role: 'user', content: 'SUBAGENT_ONE_prompt' }] }),
    }).then(r => r.json()),
    fetch(`${rig.bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', stream: false, messages: [{ role: 'user', content: 'SUBAGENT_TWO_prompt' }] }),
    }).then(r => r.json()),
  ]);

  assert.equal(r1.choices[0].message.content, `LARGE_PROMPT:${largeOutput}`);
  assert.equal(r2.choices[0].message.content, `SUBAGENT_ONE:${largeOutput}`);
  assert.equal(r3.choices[0].message.content, `SUBAGENT_TWO:${largeOutput}`);
  assert.deepEqual(readdirSync(rig.agentDir), []);
  assert.equal(rig.store.get('SELECT count(*) n FROM model_requests WHERE task_id=?', rig.taskId).n, 3);
});

test('readProviderCredentialFile accepts read-only files and symlinks and reports specific failure reasons', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const realFile = join(dir, 'readonly-secret');
  writeFileSync(realFile, '  sk-ant-valid-symlinked-secret-key  \n', { mode: 0o444 });
  chmodSync(realFile, 0o444);
  const linkFile = join(dir, 'symlink-secret');
  symlinkSync(realFile, linkFile);
  assert.equal(readProviderCredentialFile(realFile).key, 'sk-ant-valid-symlinked-secret-key');
  assert.equal(readProviderCredentialFile(linkFile).key, 'sk-ant-valid-symlinked-secret-key');

  assert.throws(() => readProviderCredentialFile(join(dir, 'missing')), err => err.code === 'provider_credential_unavailable' && /credential_file_not_found/.test(err.detail));
  const brokenLink = join(dir, 'broken');
  symlinkSync(join(dir, 'does-not-exist'), brokenLink);
  assert.throws(() => readProviderCredentialFile(brokenLink), err => /credential_file_not_found/.test(err.detail));

  const loopA = join(dir, 'loop-a'), loopB = join(dir, 'loop-b');
  symlinkSync(loopB, loopA); symlinkSync(loopA, loopB);
  assert.throws(() => readProviderCredentialFile(loopA), err => /credential_file_broken_symlink/.test(err.detail));

  assert.throws(() => readProviderCredentialFile(dir), err => /credential_file_not_regular/.test(err.detail));

  const emptyFile = join(dir, 'empty');
  writeFileSync(emptyFile, '   \n');
  assert.throws(() => readProviderCredentialFile(emptyFile), err => /credential_file_empty/.test(err.detail));

  const spaceKey = join(dir, 'malformed');
  writeFileSync(spaceKey, 'sk-bad key with spaces');
  assert.throws(() => readProviderCredentialFile(spaceKey), err => /credential_file_malformed/.test(err.detail));

  const hugeFile = join(dir, 'huge');
  writeFileSync(hugeFile, 'k'.repeat(40_000));
  assert.throws(() => readProviderCredentialFile(hugeFile), err => /credential_file_too_large/.test(err.detail));
});

test('slow upstream 429, streaming 200, and first-byte timeout preserve exact status codes and headers', async t => {
  const rig = await createGatewayRig(t, { uds: false });
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'https://upstream.invalid/v1',
    key: 'sk-slow-upstream-key',
    name: 'slow-gpt',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });

  let scenario = '429';
  await rig.startGateway({
    primaryModel: model,
    timing: { firstByteMs: 250, idleMs: 2_000 },
    fetcher: async (_url, init) => {
      if (scenario === 'timeout') {
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true });
        });
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      if (scenario === '429') {
        return new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '3' },
        });
      }
      const chunks = [
        'data: {"id":"cmpl-slow","choices":[{"index":0,"delta":{"role":"assistant","content":"Slow "},"finish_reason":null}]}\n\n',
        'data: {"id":"cmpl-slow","choices":[{"index":0,"delta":{"content":"stream!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ].map(chunk => Buffer.from(chunk, 'utf8'));
      return new Response(Readable.toWeb(Readable.from(chunks)), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const res429 = await fetch(`${rig.bridge.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'slow-gpt', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res429.status, 429);
  assert.equal(res429.headers.get('retry-after'), '3');
  assert.equal((await res429.json()).error.type, 'rate_limit_error');

  scenario = 'stream';
  const resStream = await fetch(`${rig.bridge.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'slow-gpt', stream: true, messages: [{ role: 'user', content: 'stream please' }] }),
  });
  assert.equal(resStream.status, 200);
  assert.match(resStream.headers.get('content-type') || '', /text\/event-stream/);
  const sseBody = await resStream.text();
  assert.match(sseBody, /Slow /);
  assert.match(sseBody, /stream!/);

  scenario = 'timeout';
  const resTimeout = await fetch(`${rig.bridge.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'slow-gpt', stream: false, messages: [{ role: 'user', content: 'hang' }] }),
  });
  assert.equal(resTimeout.status, 502);
  assert.equal((await resTimeout.json()).error.code, 'provider_timeout');
});

test('client disconnect immediately aborts upstream fetch signal and marks ledger cancelled', async t => {
  const rig = await createGatewayRig(t, { uds: true });
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'https://upstream.invalid/v1',
    key: 'sk-cancel-test-secret',
    name: 'cancel-model',
    interface_type: 'anthropic-messages',
    auth_header: 'x-api-key',
  });

  let upstreamAborted = false;
  let releaseSecondChunk;
  const secondChunkGate = new Promise(resolve => { releaseSecondChunk = resolve; });

  await rig.startGateway({
    primaryModel: model,
    fetcher: async (_url, init) => {
      init.signal?.addEventListener('abort', () => {
        upstreamAborted = true;
        releaseSecondChunk();
      }, { once: true });
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"cancel-model","content":[],"usage":{"input_tokens":50,"output_tokens":0}}}\n\n'));
          controller.enqueue(Buffer.from('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
          controller.enqueue(Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First chunk"}}\n\n'));
          for (let i = 0; i < 40 && !init.signal?.aborted; i++) {
            await new Promise(resolve => setTimeout(resolve, 30));
            if (init.signal?.aborted) break;
            controller.enqueue(Buffer.from(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" more-${i}"}}\n\n`));
          }
          await secondChunkGate;
          try { controller.close(); } catch {}
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const clientAbort = new AbortController();
  const res = await fetch(`${rig.bridge.url}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': rig.token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cancel-model', max_tokens: 512, stream: true, messages: [{ role: 'user', content: 'stream until cancelled' }] }),
    signal: clientAbort.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  clientAbort.abort();
  await reader.cancel().catch(() => {});

  const deadline = Date.now() + 3000;
  while (!upstreamAborted && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(upstreamAborted, true, 'expected upstream fetch signal to abort after client disconnect');

  let row = null;
  while (Date.now() < deadline) {
    row = rig.store.get('SELECT * FROM model_requests WHERE task_id=?', rig.taskId);
    if (row?.state && row.state !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(row?.state, 'cancelled');
});

test('boundary-safe streaming redaction scrubs secrets split across multi-byte UTF-8 chunks without corrupting text', async t => {
  const rig = await createGatewayRig(t, { uds: true });
  const secretKey = 'sk-utf8-secret-key-998877';
  const outboundToken = 'ghs_outbound_secret_token_998877';
  rig.redactor.add(outboundToken);
  let capturedOutboundBody = '';

  const chatModel = addProjectModel(rig.store, rig.repoId, {
    url: 'https://chat-provider.internal/v1',
    key: secretKey,
    name: 'vision-chat-model',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });

  await rig.startGateway({
    primaryModel: chatModel,
    fetcher: async (_url, init) => {
      capturedOutboundBody = String(init.body);
      const fullBytes = Buffer.from(JSON.stringify({
        id: 'cmpl-utf8',
        object: 'chat.completion',
        model: 'vision-chat-model',
        choices: [{ index: 0, message: { role: 'assistant', content: `中文测试🚀多字节边界 key=${secretKey} 结束` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 12 },
      }), 'utf8');
      const parts = [];
      for (let i = 0; i < fullBytes.length; i += 5) parts.push(fullBytes.subarray(i, i + 5));
      return new Response(Readable.toWeb(Readable.from(parts)), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const utf8Res = await fetch(`${rig.bridge.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vision-chat-model', stream: false, messages: [{ role: 'user', content: `token=${outboundToken}` }] }),
  });
  assert.equal(utf8Res.status, 200);
  const utf8Json = await utf8Res.json();
  assert.equal(utf8Json.choices[0].message.content, '中文测试🚀多字节边界 key=[REDACTED] 结束');
  assert.ok(!utf8Json.choices[0].message.content.includes('\uFFFD'));
  assert.ok(!capturedOutboundBody.includes(outboundToken) && capturedOutboundBody.includes('[REDACTED]'), 'registered secrets must never leave control plane');
});

test('WorkSwarm gateway filters tools via trusted allowedTools and omits empty tool lists', async t => {
  const rig = await createGatewayRig(t, { uds: true });
  const allowedName = 'mcp_bot_read_file';
  const forwardedBodies = [];
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'https://chat-provider.internal/v1',
    key: 'sk-ws-key',
    name: 'ws-model',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });
  await rig.startGateway({
    primaryModel: model,
    allowedTools: new Set([allowedName]),
    fetcher: async (_url, init) => {
      forwardedBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        id: 'cmpl-ws',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const granted = { type: 'function', function: { name: allowedName } };
  const native = { type: 'function', function: { name: 'native_fixture' } };
  for (const body of [
    { tools: [native, granted], tool_choice: { type: 'function', function: { name: native.function.name } } },
    { tools: [native], tool_choice: 'required' },
  ]) {
    const res = await fetch(`${rig.bridge.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ws-model', stream: false, messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
    assert.equal(res.status, 200);
    await res.json();
  }
  assert.deepEqual(forwardedBodies[0].tools, [granted]);
  assert.equal('tool_choice' in forwardedBodies[0], false);
  assert.equal('tools' in forwardedBodies[1], false);
  assert.equal('tool_choice' in forwardedBodies[1], false);
});

test('model bridge close() resolves promptly when a slow client disconnects during streaming backpressure', async t => {
  const rig = await createGatewayRig(t, { uds: true });
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'https://upstream.invalid/v1',
    key: 'sk-drain-key',
    name: 'drain-model',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });
  await rig.startGateway({
    primaryModel: model,
    fetcher: async (_url, init) => {
      const payload = Buffer.alloc(4 * 1024 * 1024, 0x61);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const { connect } = await import('node:net');
  const sock = connect(rig.bridge.port, '127.0.0.1');
  await once(sock, 'connect');
  sock.pause();
  const reqBody = JSON.stringify({ model: 'drain-model', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  sock.write(
    `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${rig.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(reqBody)}\r\n\r\n${reqBody}`,
  );
  await new Promise(resolve => setTimeout(resolve, 80));
  sock.destroy();

  const closeResult = await Promise.race([
    rig.bridge.close().then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 2000)),
  ]);
  assert.equal(closeResult, 'closed');
});

test('Codex Responses passthrough accepts an SSE body advertised as JSON and preserves completion and accounting', async t => {
  const response = { id: 'resp-framing', object: 'response', model: 'framing-model', status: 'completed',
    output: [{ id: 'msg-framing', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'READY', annotations: [] }] }],
    usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 } };
  const body = `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('ev');
    setTimeout(() => res.end(body.slice(2)), 5);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const rig = await createGatewayRig(t, { uds: true });
  const catalog = new ModelCatalog(rig.store, async () => new Response('{}'));
  await catalog.refresh().catch(() => {});
  const model = addProjectModel(rig.store, rig.repoId, { url: `http://127.0.0.1:${upstream.address().port}/v1`, key: 'framing-provider-key', name: 'framing-model', interface_type: 'openai-responses' });
  await rig.startGateway({ primaryModel: model });
  const reply = await fetch(`${rig.bridge.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + rig.token },
    body: JSON.stringify({ model: 'framing-model', stream: true, input: 'Say READY' }),
  });
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get('content-type') || '', /text\/event-stream/);
  assert.equal(await reply.text(), body);
  const deadline = Date.now() + 3000;
  while (rig.store.get('SELECT state FROM model_requests ORDER BY rowid DESC LIMIT 1')?.state !== 'received' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const stored = rig.store.get('SELECT state,input_tokens,output_tokens FROM model_requests ORDER BY rowid DESC LIMIT 1');
  assert.deepEqual([stored.state, stored.input_tokens, stored.output_tokens], ['received', 9, 2]);
});

test('client closing SSE stream right after terminal response.completed still records state=received and full usage', async t => {
  const response = {
    id: 'resp-early-close',
    object: 'response',
    model: 'early-close-model',
    status: 'completed',
    output: [{ id: 'msg-ec', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE_EARLY', annotations: [] }] }],
    usage: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
  };
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
    // Keep upstream open briefly (like real providers before TCP FIN) so client closes first.
    const keepOpen = setTimeout(() => { try { res.end(); } catch {} }, 5000);
    keepOpen.unref?.();
    req.on('close', () => { clearTimeout(keepOpen); try { res.end(); } catch {} });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections?.(); }));

  const rig = await createGatewayRig(t, { uds: true });
  const model = addProjectModel(rig.store, rig.repoId, { url: `http://127.0.0.1:${upstream.address().port}/v1/responses`, key: 'early-close-key', name: 'early-close-model', interface_type: 'openai-responses' });
  await rig.startGateway({ primaryModel: model });

  const reply = await fetch(`${rig.bridge.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + rig.token },
    body: JSON.stringify({ model: 'early-close-model', stream: true, input: 'hi' }),
  });
  assert.equal(reply.status, 200);
  const reader = reply.body.getReader();
  const dec = new TextDecoder();
  let seen = '';
  while (!seen.includes('response.completed')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += dec.decode(value, { stream: true });
  }
  // Close client socket immediately upon seeing response.completed (just like Codex CLI does).
  await reader.cancel();

  const deadline = Date.now() + 3000;
  let stored = null;
  while (Date.now() < deadline) {
    stored = rig.store.get('SELECT state,http_status,input_tokens,output_tokens FROM model_requests ORDER BY rowid DESC LIMIT 1');
    if (stored && stored.state !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual([stored?.state, stored?.http_status, stored?.input_tokens, stored?.output_tokens], ['received', 200, 42, 7]);
});

test('resolveControlPlaneModelGatewaySocket defaults to /run/model-gateway/gateway.sock when mounted, honors explicit env override/disable, and skips when unmounted', () => {
  assert.equal(resolveControlPlaneModelGatewaySocket('/custom/gw.sock', () => false), '/custom/gw.sock');
  assert.equal(resolveControlPlaneModelGatewaySocket('  /custom/gw.sock  ', () => false), '/custom/gw.sock');
  assert.equal(resolveControlPlaneModelGatewaySocket('', () => true), null);
  assert.equal(resolveControlPlaneModelGatewaySocket('   ', () => true), null);
  assert.equal(resolveControlPlaneModelGatewaySocket(undefined, dir => dir === '/run/model-gateway'), DEFAULT_MODEL_GATEWAY_SOCKET);
  assert.equal(resolveControlPlaneModelGatewaySocket(undefined, () => false), null);
});
