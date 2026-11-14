import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { openModel } from '../dist/agent/model.js';
import { ModelCatalog, saveModelMetadata } from '../dist/models/catalog.js';
import { savePricing } from '../dist/metrics/accounting.js';
import { allocateLease, issueRunToken, roleRunStorage, verifyRunToken } from '../dist/roles/role-run.js';
import { beginRun } from '../dist/tasks/trace.js';
import { createMailboxModelGateway, readProviderCredentialFile } from '../dist/harness/model-gateway.js';
import { startModelRelay } from '../runner/model-relay.mjs';
import { agentOperation } from '../runner/agent.mjs';

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

async function createRelayRig(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'model-relay-'));
  const store = new Store(':memory:', randomBytes(32), join(root, 'trajectories'));
  roleRunStorage(store);
  mkdirSync(join(root, 'repo'), { recursive: true });
  mkdirSync(join(root, 'agent'), { recursive: true });

  const workspaceId = hex48();
  const repoId = '101';
  const taskId = 'task-relay-1';
  const role = options.role ?? 'developer';
  store.run("INSERT INTO accounts VALUES('acc','org','github_app','1','{}','2026-01-01T00:00:00Z')");
  store.run('INSERT INTO repositories VALUES(?,?,?,?)', repoId, 'org/repo', 'org', 'acc');
  store.run('INSERT INTO policies(repository_id,enabled) VALUES(?,1)', repoId);
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES(?,?,'development','running','Relay test','{}',1,1)",
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

  const runnerCalls = [];
  const runner = async input => {
    const serialized = JSON.stringify(input);
    assert.ok(Buffer.byteLength(serialized) <= 64 * 1024, `runner argv exceeded 64 KiB: ${Buffer.byteLength(serialized)}`);
    runnerCalls.push(input);
    const result = await agentOperation(input, root);
    const outBytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(outBytes <= 4 * 1024 * 1024, `runner stdout exceeded 4 MiB: ${outBytes}`);
    return result;
  };

  const relay = await startModelRelay({ agentDir: join(root, 'agent'), pollMs: 15, idleTimeoutMs: options.idleTimeoutMs ?? 30_000 });
  const redactor = new Redactor();
  let gateway = null;
  let polling = true;
  const pollLoop = (async () => {
    while (polling) {
      if (gateway) {
        const polled = await runner({ type: 'workspace_agent_poll', workspace_id: workspaceId, offset: 0 });
        gateway.dispatchPoll(polled.model_requests);
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  })();

  t.after(async () => {
    polling = false;
    await pollLoop;
    await gateway?.close();
    await relay.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const taskRow = { ...store.get('SELECT * FROM tasks WHERE id=?', taskId), trace_run_id: runId, active_role: role };
  return {
    root,
    store,
    repoId,
    taskId,
    runId,
    role,
    token,
    runAccess,
    redactor,
    runner,
    runnerCalls,
    relay,
    taskRow,
    startGateway(gwOptions = {}) {
      gateway = createMailboxModelGateway({
        store,
        task: taskRow,
        runId,
        leaseEpoch: lease.epoch,
        runAccess,
        redactor,
        runner,
        workspaceId,
        ...gwOptions,
      });
      return gateway;
    },
  };
}

function addProjectModel(store, repoId, { id = hex48().slice(0, 16), url, key, name, interface_type, auth_header, pricing }) {
  store.run(
    'INSERT INTO models VALUES(?,?,?,?,?,?,?)',
    id, repoId, url, name, store.secrets.seal({ value: key }, `model:${id}`), 1, '2026-01-01T00:00:00Z',
  );
  if (interface_type || auth_header) saveModelMetadata(store, id, { ...(interface_type ? { interface_type } : {}), ...(auth_header ? { auth_header } : {}) });
  if (pricing) savePricing(store, id, pricing);
  return openModel(store, store.get('SELECT * FROM models WHERE id=?', id));
}

test('Claude Code (/v1/messages) uses OpenAI Chat Completions upstream with streaming SSE, tool calls, accounting and trajectories', async t => {
  const upstreamReqs = [];
  const providerKey = 'sk-openai-secret-' + randomBytes(16).toString('hex');
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    upstreamReqs.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const hasToolResult = body.messages.some(m => m.role === 'tool');
    if (!hasToolResult) {
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'deepseek-coder-v3', choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking ' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'deepseek-coder-v3', choices: [{ index: 0, delta: { content: 'workspace.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'deepseek-coder-v3', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_bash_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":' } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'deepseek-coder-v3', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'deepseek-coder-v3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'deepseek-coder-v3', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-2', model: 'deepseek-coder-v3', choices: [{ index: 0, delta: { role: 'assistant', content: 'All done!' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-2', model: 'deepseek-coder-v3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-2', model: 'deepseek-coder-v3', choices: [], usage: { prompt_tokens: 200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const rig = await createRelayRig(t);
  const model = addProjectModel(rig.store, rig.repoId, {
    url: `http://127.0.0.1:${upstream.address().port}/v1`,
    key: providerKey,
    name: 'deepseek-coder-v3',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
    pricing: { currency: 'USD', input_per_million: 1, output_per_million: 2, cache_per_million: 0.1 },
  });
  rig.startGateway({ primaryModel: model });

  // Turn 1: Non-claude-* model name works via catalog/configured model, streams Anthropic SSE with tool_use.
  const turn1Res = await fetch(`${rig.relay.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': rig.token, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'deepseek-coder-v3',
      max_tokens: 1024,
      system: 'You are a helpful coding agent.',
      stream: true,
      tools: [{ name: 'Bash', description: 'Run shell', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
      messages: [{ role: 'user', content: 'List files' }],
    }),
  });
  assert.equal(turn1Res.status, 200);
  assert.match(turn1Res.headers.get('content-type') || '', /text\/event-stream/);
  const turn1Sse = await turn1Res.text();
  assert.match(turn1Sse, /event: message_start/);
  assert.match(turn1Sse, /"text":"Checking "/);
  assert.match(turn1Sse, /"type":"tool_use","id":"call_bash_1","name":"Bash"/);
  assert.match(turn1Sse, /"stop_reason":"tool_use"/);
  assert.match(turn1Sse, /event: message_stop/);

  assert.equal(upstreamReqs.length, 1);
  assert.equal(upstreamReqs[0].headers.authorization, `Bearer ${providerKey}`);
  assert.equal(upstreamReqs[0].headers['x-api-key'], undefined);
  assert.equal(upstreamReqs[0].body.messages[0].role, 'system');

  // Turn 2: Send tool_result back through /v1/messages.
  const turn2Res = await fetch(`${rig.relay.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': rig.token },
    body: JSON.stringify({
      model: 'deepseek-coder-v3',
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
  const turn2Sse = await turn2Res.text();
  assert.match(turn2Sse, /"text":"All done!"/);
  assert.match(turn2Sse, /"stop_reason":"end_turn"/);

  // Verify per-request ledger accounting & delta-encoded trajectories (#624, #625).
  const ledger = rig.store.all('SELECT * FROM model_requests WHERE task_id=? ORDER BY requested_at, rowid', rig.taskId);
  assert.equal(ledger.length, 2);
  assert.deepEqual([ledger[0].input_tokens, ledger[0].output_tokens, ledger[0].cached_input_tokens, ledger[0].state], [120, 30, 20, 'received']);
  assert.deepEqual([ledger[1].input_tokens, ledger[1].output_tokens, ledger[1].cached_input_tokens, ledger[1].state], [200, 10, 100, 'received']);
  assert.ok(ledger[0].cost > 0 && ledger[1].cost > 0);
  assert.ok(ledger[0].request_ref && ledger[0].response_ref && ledger[1].request_ref && ledger[1].response_ref);
  const recordedTurn2 = rig.store.trajectories.readModelRequest(ledger[1].request_ref);
  assert.equal(recordedTurn2.messages.length, 3);
  assert.ok(!JSON.stringify(ledger).includes(providerKey));
  for (const file of collectFiles(rig.root)) {
    assert.ok(!readFileSync(file, 'utf8').includes(providerKey), `provider key leaked into ${file}`);
  }
});

test('Codex app-server (/v1/responses) uses Anthropic Messages upstream with streaming SSE, developer instructions, function & custom tools', async t => {
  const upstreamReqs = [];
  const anthropicKey = 'sk-ant-secret-' + randomBytes(16).toString('hex');
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    upstreamReqs.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const hasToolResult = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
    if (!hasToolResult) {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_ant_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Running patch' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_patch_1', name: 'apply_patch', input: {} } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch"}' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } })}\n\n`);
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    } else {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_ant_2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 110, cache_read_input_tokens: 40, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Patch applied.' } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } })}\n\n`);
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const rig = await createRelayRig(t);
  const catalog = new ModelCatalog(rig.store, async () => new Response(JSON.stringify({
    anthropic: {
      name: 'Anthropic',
      doc: 'https://docs.anthropic.com/models',
      models: {
        'claude-sonnet-4-5': {
          id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', attachment: true, reasoning: true,
          limit: { context: 200000, output: 64000 }, modalities: { input: ['text', 'image'], output: ['text'] },
          cost: { input: 3, output: 15, cache_read: 0.3 },
        },
      },
    },
  })));
  await catalog.refresh();

  const model = addProjectModel(rig.store, rig.repoId, {
    url: `http://127.0.0.1:${upstream.address().port}`,
    key: anthropicKey,
    name: 'claude-sonnet-4-5',
  });
  rig.startGateway({ primaryModel: model });

  // Verify GET /v1/models comes from the catalog without hitting upstream /v1/models.
  const modelsRes = await fetch(`${rig.relay.url}/v1/models`, {
    headers: { Authorization: `Bearer ${rig.token}` },
  });
  assert.equal(modelsRes.status, 200);
  const modelsJson = await modelsRes.json();
  assert.equal(modelsJson.object, 'list');
  assert.ok(modelsJson.data.some(m => m.id === 'claude-sonnet-4-5' && m.interface_type === 'anthropic-messages'));
  assert.equal(upstreamReqs.length, 0);

  // Turn 1: Codex sends POST /v1/responses with Bearer token and custom apply_patch tool.
  const resp1 = await fetch(`${rig.relay.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${rig.token}` },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      instructions: 'Base instructions',
      stream: true,
      tools: [
        { type: 'custom', name: 'apply_patch', description: 'Apply patch' },
        { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      ],
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Update README' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'Sandbox: workspace-write' }] },
      ],
    }),
  });
  assert.equal(resp1.status, 200);
  const sse1 = await resp1.text();
  assert.match(sse1, /event: response\.created/);
  assert.match(sse1, /event: response\.output_text\.delta/);
  assert.match(sse1, /"type":"custom_tool_call","status":"completed","call_id":"call_patch_1","name":"apply_patch","input":"\*\*\* Begin Patch"/);
  assert.match(sse1, /event: response\.completed/);

  assert.equal(upstreamReqs.length, 1);
  assert.equal(upstreamReqs[0].url, '/v1/messages');
  assert.equal(upstreamReqs[0].headers['x-api-key'], anthropicKey);
  assert.equal(upstreamReqs[0].headers['anthropic-version'], '2023-06-01');

  // Turn 2: Codex returns custom_tool_call_output.
  const resp2 = await fetch(`${rig.relay.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${rig.token}` },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      stream: false,
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply patch' }],
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Update README' }] },
        { type: 'custom_tool_call', call_id: 'call_patch_1', name: 'apply_patch', input: '*** Begin Patch' },
        { type: 'custom_tool_call_output', call_id: 'call_patch_1', output: 'Success' },
      ],
    }),
  });
  assert.equal(resp2.status, 200);
  const json2 = await resp2.json();
  assert.equal(json2.object, 'response');
  assert.equal(json2.status, 'completed');
  assert.equal(json2.output_text, 'Patch applied.');
  assert.deepEqual(json2.usage, { input_tokens: 150, output_tokens: 12, total_tokens: 162, input_tokens_details: { cached_tokens: 40 } });

  // Verify Anthropic cache_read_input_tokens + input_tokens accounting and /v1/responses trajectory round-trip.
  const rows = rig.store.all('SELECT * FROM model_requests WHERE task_id=? ORDER BY rowid', rig.taskId);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].input_tokens, rows[0].cached_input_tokens, rows[0].output_tokens], [100, 20, 25]);
  assert.deepEqual([rows[1].input_tokens, rows[1].cached_input_tokens, rows[1].output_tokens], [150, 40, 12]);
  const storedReq2 = rig.store.trajectories.readModelRequest(rows[1].request_ref);
  assert.equal(Array.isArray(storedReq2.input), true);
  assert.equal(storedReq2.messages, undefined);
});

test('rejects missing, invalid, other-run, wrong-role and revoked tokens, unconfigured models, and disabled policies', async t => {
  const rig = await createRelayRig(t);
  let upstreamCalled = 0;
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'http://relay.internal:8080/v1',
    key: 'sk-non-loopback-secret',
    name: 'qwen3-coder',
    interface_type: 'openai-chat-completions',
    auth_header: 'x-api-key',
  });
  rig.startGateway({
    primaryModel: model,
    fetcher: async (url, init) => {
      upstreamCalled++;
      assert.equal(url, 'http://relay.internal:8080/v1/chat/completions');
      assert.equal(init.headers['x-api-key'], 'sk-non-loopback-secret');
      assert.equal(init.headers.Authorization, undefined);
      return new Response(JSON.stringify({
        id: 'cmpl-1', model: 'qwen3-coder',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  // 1. Missing token rejected locally at relay before mailbox.
  assert.equal((await fetch(`${rig.relay.url}/v1/models`)).status, 401);
  // 2. Mismatched Bearer + x-api-key rejected.
  assert.equal((await fetch(`${rig.relay.url}/v1/models`, { headers: { 'x-api-key': rig.token, Authorization: 'Bearer other' } })).status, 401);
  // 3. Forged token rejected by control plane.
  assert.equal((await fetch(`${rig.relay.url}/v1/models`, { headers: { 'x-api-key': 'rt_forged_token_value' } })).status, 401);
  // 4. Token from another run / wrong role rejected by control plane.
  const otherRun = beginRun(rig.store, rig.store.get('SELECT * FROM tasks WHERE id=?', rig.taskId), 'execution', {});
  rig.store.run("UPDATE task_runs SET role='reviewer' WHERE id=?", otherRun.id);
  const otherLease = allocateLease(rig.store, rig.taskId, 'assign-2', otherRun.id);
  const { token: otherRoleToken } = issueRunToken(rig.store, {
    tenant_id: 'acc', project_id: rig.repoId, task_id: rig.taskId, run_id: otherRun.id, lease_epoch: otherLease.epoch, role: 'reviewer',
  }, ['model:invoke']);
  assert.equal((await fetch(`${rig.relay.url}/v1/models`, { headers: { Authorization: `Bearer ${otherRoleToken}` } })).status, 401);

  // 5. Unlisted endpoint rejected.
  assert.equal((await fetch(`${rig.relay.url}/v1/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);

  // 6. Unconfigured model name rejected.
  const deniedModel = await fetch(`${rig.relay.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'unapproved-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(deniedModel.status, 403);
  assert.equal(upstreamCalled, 0);

  // 7. Non-loopback http:// upstream with configured x-api-key auth succeeds with valid run token.
  const allowed = await fetch(`${rig.relay.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder', messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(upstreamCalled, 1);

  // 8. Disabling repository policy immediately blocks subsequent calls.
  rig.store.run('UPDATE policies SET enabled=0 WHERE repository_id=?', rig.repoId);
  const disabled = await fetch(`${rig.relay.url}/v1/models`, { headers: { Authorization: `Bearer ${rig.token}` } });
  assert.equal(disabled.status, 403);
  rig.store.run('UPDATE policies SET enabled=1 WHERE repository_id=?', rig.repoId);

  // 9. Revoking run token (e.g. lease takeover / run end) immediately blocks calls.
  rig.store.run('UPDATE role_run_tokens SET revoked_at=? WHERE run_id=?', Date.now(), rig.runId);
  assert.equal((await fetch(`${rig.relay.url}/v1/models`, { headers: { Authorization: `Bearer ${rig.token}` } })).status, 401);
});

test('supports parallel sub-agent requests, >256 KiB chunked prompts and >90 KiB chunked responses within 64 KiB runner limit', async t => {
  const rig = await createRelayRig(t);
  const largeOutput = 'A'.repeat(95_000);
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'http://relay.internal:8080/v1',
    key: 'sk-parallel-key-secret',
    name: 'glm-5',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });
  rig.startGateway({
    primaryModel: model,
    fetcher: async (_url, init) => {
      const parsed = JSON.parse(init.body);
      const tag = parsed.messages.at(-1).content.slice(0, 12);
      await new Promise(resolve => setTimeout(resolve, 30));
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
    fetch(`${rig.relay.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': rig.token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', max_tokens: 4096, stream: false, messages: [{ role: 'user', content: hugePrompt }] }),
    }).then(r => r.json()),
    fetch(`${rig.relay.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', stream: false, messages: [{ role: 'user', content: 'SUBAGENT_ONE_prompt' }] }),
    }).then(r => r.json()),
    fetch(`${rig.relay.url}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', stream: false, input: 'SUBAGENT_TWO_prompt' }),
    }).then(r => r.json()),
  ]);

  assert.equal(r1.content[0].text, `LARGE_PROMPT:${largeOutput}`);
  assert.equal(r2.choices[0].message.content, `SUBAGENT_ONE:${largeOutput}`);
  assert.equal(r3.output_text, `SUBAGENT_TWO:${largeOutput}`);
  assert.ok(rig.runnerCalls.some(c => c.type === 'workspace_agent_model_request'), 'expected >256 KiB prompt to use chunked read');
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

test('pre-header keepalive heartbeats do not prematurely commit 200/application/json before slow upstream headers or errors arrive', async t => {
  const rig = await createRelayRig(t);
  const model = addProjectModel(rig.store, rig.repoId, {
    url: 'http://upstream.invalid/v1',
    key: 'sk-slow-upstream-key',
    name: 'slow-gpt',
    interface_type: 'openai-chat-completions',
    auth_header: 'bearer',
  });

  let scenario = '429';
  rig.startGateway({
    primaryModel: model,
    timing: { firstByteMs: 450, idleMs: 2_000, keepaliveMs: 25 },
    fetcher: async (_url, init) => {
      if (scenario === 'timeout') {
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true });
        });
      }
      // Wait long enough for multiple 25ms keepalive heartbeats to flush to cursor.json before headers arrive.
      await new Promise(resolve => setTimeout(resolve, 90));
      if (scenario === '429') {
        return new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
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

  // 1. Slow upstream 429 after multiple pre-header keepalives still delivers HTTP 429 to the client.
  const res429 = await fetch(`${rig.relay.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'slow-gpt', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res429.status, 429);
  assert.match(res429.headers.get('content-type') || '', /application\/json/);
  const err429 = await res429.json();
  assert.equal(err429.error.type, 'rate_limit_error');
  assert.ok(
    rig.runnerCalls.some(c => c.type === 'workspace_agent_model_reply' && c.sequence >= 1 && c.status === undefined),
    'expected pre-header keepalive without premature status',
  );

  // 2. Slow upstream streaming 200 after multiple pre-header keepalives delivers text/event-stream, not application/json.
  scenario = 'stream';
  const resStream = await fetch(`${rig.relay.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'slow-gpt', stream: true, messages: [{ role: 'user', content: 'stream please' }] }),
  });
  assert.equal(resStream.status, 200);
  assert.match(resStream.headers.get('content-type') || '', /text\/event-stream/);
  const sseBody = await resStream.text();
  assert.match(sseBody, /Slow /);
  assert.match(sseBody, /stream!/);

  // 3. First-byte timeout after pre-header keepalives delivers HTTP 502 error instead of HTTP 200.
  scenario = 'timeout';
  const resTimeout = await fetch(`${rig.relay.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'slow-gpt', stream: false, messages: [{ role: 'user', content: 'hang' }] }),
  });
  assert.equal(resTimeout.status, 502);
  const errTimeout = await resTimeout.json();
  assert.equal(errTimeout.error.code, 'provider_timeout');
});
