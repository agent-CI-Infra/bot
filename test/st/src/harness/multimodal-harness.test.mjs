import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Store } from '../../../../dist/storage/database.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { runAgent } from '../../../../dist/agent/runtime.js';
import { serviceHarnessTurn } from '../../../../dist/harness/service-session.js';
import { serviceRole, serviceRoleModel, managementAssistant, updateServiceRole } from '../../../../dist/service-roles/roles.js';
import { saveModelMetadata } from '../../../../dist/models/catalog.js';
import { ChannelLedger } from '../../../../dist/channels/ledger.js';
import { ChannelMedia, MediaTurn, mediaTools } from '../../../../dist/channels/media.js';
import { roleHarness } from '../../../../dist/roles/harness.js';
import { openModel } from '../../../../dist/agent/model.js';
import { operationRequestText } from '../../../../dist/storage/payloads.js';
import { randomWorkspaceId } from '../../../fixtures/helpers.mjs';

const piSdkInstalled = existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json');
const piSkip = !piSdkInstalled && process.env.BOT_REQUIRE_PI !== '1'
  ? 'Pi SDK not installed: npm ci --prefix runner --omit=dev --ignore-scripts'
  : false;

// Minimal valid 16x16 RGB PNG (spec-compliant for Photon and all decoders).
const validPng = makeSolidPng(16, 16);
// Minimal 1x1 PNG header (used with trailing padding to exercise Pi normalization-failure raw passthrough).
const smallPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

// Generate a valid solid-color PNG of arbitrary dimensions (for verifying Pi's real Photon autoResize).
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
function makeSolidPng(width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height, 0);
  for (let y = 0; y < height; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter none
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = 0x22;
      raw[off + 2 + x * 3] = 0x88;
      raw[off + 3 + x * 3] = 0xee;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createMediaHarness(store, resources, workspaceFiles = new Map(), imageInput = () => true) {
  const ledger = new ChannelLedger(store);
  const chat = ledger.accept({
    kind: 'message',
    connector_id: 'conn-1',
    provider: 'feishu',
    app_id: 'cli_fixture',
    installation_tenant: 'tenant-1',
    chat_id: 'oc_multimodal',
    chat_type: 'group',
    message_id: 'om_img_1',
    actor_id: 'ou_user_1',
    actor_tenant: 'tenant-1',
    sender_type: 'user',
    message_type: 'image',
    content: 'Please inspect the attached image',
    raw_content: JSON.stringify({ image_key: 'img_fixture_1' }),
    created_at: Date.now(),
    source: 'event',
    parent_id: '',
    root_id: '',
    thread_id: '',
    deleted: false,
    mentions: [],
  });
  let downloadCount = 0;
  const media = new ChannelMedia(store, ledger, () => ({
    async download(_messageId, key) {
      downloadCount++;
      const found = resources.get(key);
      if (!found) throw new Error('missing_fixture_resource:' + key);
      return found;
    },
  }));
  const mediaComputer = {
    async importFile(path, data) {
      workspaceFiles.set(path, { data, name: path.split('/').at(-1) || 'file.png' });
      return { path, written: true, size: data.length };
    },
    async exportFile(path, maxBytes) {
      const found = workspaceFiles.get(path);
      if (!found) throw new Error('file_not_found:' + path);
      if (found.data.length > maxBytes) throw new Error('channel_resource_too_large');
      return found;
    },
  };
  const turn = new MediaTurn(media, chat.id, 'om_img_1', () => {}, mediaComputer, () => {}, undefined, '', imageInput);
  return { turn, chat, getDownloads: () => downloadCount };
}

function findPiModelsJson(root) {
  const tasksDir = join(root, 'tasks');
  if (!existsSync(tasksDir)) return null;
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, 'agent', 'models.json');
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
  }
  return null;
}

function readAllEventsJsonl(root) {
  const tasksDir = join(root, 'tasks');
  if (!existsSync(tasksDir)) return '';
  let out = '';
  for (const entry of readdirSync(tasksDir)) {
    const file = join(tasksDir, entry, 'agent', 'events.jsonl');
    if (existsSync(file)) out += readFileSync(file, 'utf8') + '\n';
  }
  return out;
}

function chatToolCall(id, name, args) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function writeChatSse(res, message, usage = { prompt_tokens: 20, completion_tokens: 10 }) {
  res.setHeader('content-type', 'text/event-stream');
  const delta = message.tool_calls
    ? { role: 'assistant', tool_calls: message.tool_calls.map((c, idx) => ({ ...c, index: idx })) }
    : { role: 'assistant', content: message.content };
  res.write('data: ' + JSON.stringify({ id: 'cmpl-1', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ id: 'cmpl-1', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage }) + '\n\ndata: [DONE]\n\n');
}

function writeResponsesSse(res, outputItem) {
  res.setHeader('content-type', 'text/event-stream');
  const id = 'resp_' + randomBytes(6).toString('hex');
  res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress' } })}\n\n`);
  if (outputItem.type === 'function_call') {
    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: outputItem.call_id, name: outputItem.name, arguments: '' } })}\n\n`);
    res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: outputItem.arguments })}\n\n`);
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: outputItem.call_id, name: outputItem.name, arguments: outputItem.arguments } })}\n\n`);
  } else {
    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } })}\n\n`);
    res.write(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })}\n\n`);
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: outputItem.text })}\n\n`);
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: outputItem.text }] } })}\n\n`);
  }
  res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: [outputItem], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } })}\n\n`);
}

function writeAnthropicSse(res, block) {
  res.setHeader('content-type', 'text/event-stream');
  const id = 'msg_' + randomBytes(6).toString('hex');
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`);
  if (block.type === 'tool_use') {
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}\n\n`);
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } })}\n\n`);
  } else {
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } })}\n\n`);
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`);
  }
  res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

test('Pi gateway serviceHarnessTurn delivers 4.5 MiB view_message_image, auto-resizes 2400x2400 view_workspace_image, sets models.json input, and keeps base64 out of events and receipts', { skip: piSkip, timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-mm-pi-gw-'));
  const store = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root);
  const redactor = new Redactor();

  // 4.5 MiB raw image (~6 MiB base64) padded onto valid PNG header: exercises >2 MiB tool reply, >2 MiB proxy, chunked workspace_agent_request, and >2 MiB pi.ts & gateway.ts!
  const large45MiBPng = Buffer.concat([smallPng, Buffer.alloc(4.5 * 1024 * 1024, 0x55)]);
  const large45Base64 = large45MiBPng.toString('base64');
  // Real 2400x2400 PNG to verify Pi's default images.autoResize scales to <=2000x2000 while retaining original workspace path.
  const hugeDimPng = makeSolidPng(2400, 2400);
  const hugeDimBase64 = hugeDimPng.toString('base64');

  const seenBodies = [];
  let step = 0;
  const modelServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seenBodies.push(body);
    step++;
    if (step === 1) {
      writeChatSse(res, chatToolCall('call_1', 'list_message_resources', {}), { prompt_tokens: 10, completion_tokens: 5 });
      return;
    }
    if (step === 2) {
      const toolMsg = body.messages.find(m => m.role === 'tool');
      const resId = JSON.parse(toolMsg.content).resources[0].resource_id;
      writeChatSse(res, chatToolCall('call_2', 'view_message_image', { resource_id: resId }), { prompt_tokens: 12, completion_tokens: 5 });
      return;
    }
    if (step === 3) {
      writeChatSse(res, chatToolCall('call_3', 'view_workspace_image', { path: '~/hd-chart.png' }), { prompt_tokens: 14, completion_tokens: 5 });
      return;
    }
    writeChatSse(res, chatToolCall('call_4', 'finish', { message: 'Verified both 4.5 MiB message image and auto-resized 2400x2400 workspace image.' }), { prompt_tokens: 16, completion_tokens: 10 });
  });
  modelServer.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  t.after(async () => {
    await manager.recover();
    modelServer.closeAllConnections();
    await new Promise(r => modelServer.close(r));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m',NULL,?,'vision-fixture',?,'now')",
    `http://127.0.0.1:${modelServer.address().port}/v1`, store.secrets.seal({ value: 'fixture-key' }, 'model:m'));
  const before = serviceRole(store, managementAssistant);
  updateServiceRole(store, 'admin', managementAssistant, { expected_revision: before.revision, harness: 'pi', model_id: 'm' });
  const role = serviceRole(store, managementAssistant);
  await manager.call('PUT', '/v1/projects/101');

  const { turn: mediaTurn } = createMediaHarness(
    store,
    new Map([['img_fixture_1', { data: large45MiBPng, mime: 'image/png' }]]),
    new Map([['~/hd-chart.png', { data: hugeDimPng, name: 'hd-chart.png' }]]),
    () => true,
  );
  const computer = {
    async sessionWorkspace(task, workspaceId, r, log) {
      const ws = new Workspace(store, manager, { ...task, repository_id: '101', workspace_id: workspaceId, generation: 1 }, r, async () => {}, log, 'service_role_operations');
      await ws.call('init', { type: 'workspace_init' });
      return ws;
    },
  };
  const spec = {
    store,
    task: { id: randomBytes(24).toString('hex'), kind: 'management.agent', repository_id: null, service_role_id: role.id, conversation_id: 'mm-pi-gw', source_message: 'm1' },
    redactor,
    guard: async () => {},
    system: 'Inspect images with media tools.',
    prompt: 'Inspect the message image and ~/hd-chart.png.',
    model: serviceRoleModel(store, role.id),
    tools: mediaTools,
    execute: async (name, args) => mediaTurn.execute(name, args),
  };

  const reply = await runAgent({
    ...spec,
    adapter: services => serviceHarnessTurn(spec, services, role, computer, 'owner:pi-gw', mediaTurn),
  });
  assert.match(reply, /Verified both/);

  // 1. models.json declares input: ['text', 'image'].
  const modelsJson = findPiModelsJson(root);
  assert.ok(modelsJson, 'models.json should exist');
  const modelEntry = Object.values(modelsJson.providers)[0].models[0];
  assert.deepEqual(modelEntry.input, ['text', 'image']);

  // 2. Request #3 carries the 4.5 MiB message image as OpenAI Chat image_url AND keeps resource_id in tool text.
  const req3 = seenBodies[2];
  const req3Images = req3.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);
  assert.equal(req3Images.length, 1, 'request 3 must include the 4.5 MiB message image');
  assert.ok(req3Images[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(req3Images[0].image_url.url.length > 4 * 1024 * 1024, '4.5 MiB image passed through proxy/mailbox/pi.ts/gateway');
  const req3ToolMsg = req3.messages.filter(m => m.role === 'tool').at(-1);
  assert.ok(JSON.parse(req3ToolMsg.content).resource_id, 'original resource_id preserved');

  // 3. Request #4 carries the 2400x2400 workspace image auto-resized by Pi's default images.autoResize + original path preserved!
  const req4 = seenBodies[3];
  const req4Images = req4.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);
  assert.equal(req4Images.length, 2, 'request 4 carries both images');
  const req4ToolMsg = req4.messages.filter(m => m.role === 'tool').at(-1);
  assert.ok(req4ToolMsg.content.includes('~/hd-chart.png'), 'original workspace path preserved');
  assert.match(req4ToolMsg.content, /original 2400x2400, displayed at 2000x2000/, 'Pi default images.autoResize scaled 2400x2400 -> 2000x2000 with dimension note');
  assert.ok(!req4ToolMsg.content.includes(root), 'host path must never leak');

  // 4. Zero raw base64 in events.jsonl, service_harness_events, or service_role_operations!
  const prefix45 = large45Base64.slice(0, 80);
  const prefix2400 = hugeDimBase64.slice(0, 80);
  const eventsText = readAllEventsJsonl(root);
  assert.ok(!eventsText.includes(prefix45), 'events.jsonl must not contain raw base64 from 4.5 MiB image');
  assert.ok(!eventsText.includes(prefix2400), 'events.jsonl must not contain raw base64 from workspace image');
  const harnessEvents = JSON.stringify(store.all('SELECT * FROM service_harness_events'));
  assert.ok(!harnessEvents.includes(prefix45) && !harnessEvents.includes(prefix2400), 'service_harness_events must not contain raw base64');
  for (const row of store.all('SELECT * FROM service_role_operations')) {
    const reqText = operationRequestText(store, 'service_role_operations', row);
    assert.ok(!reqText.includes(prefix45) && !reqText.includes(prefix2400), 'service_role_operations must not persist tool image base64');
  }
});

for (const interfaceType of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
  test(`Pi unified passthrough gateway forwards view_message_image over ${interfaceType} without leaking API keys`, { skip: piSkip, timeout: 90000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), `bot-mm-pi-pass-${interfaceType}-`));
    const store = new Store(':memory:', randomBytes(32));
    const manager = new LocalManager('101', root);
    const redactor = new Redactor();
    const smallBase64 = smallPng.toString('base64');

    const captured = [];
    let step = 0;
    const provider = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      captured.push({ url: req.url, body });
      step++;
      if (interfaceType === 'openai-chat-completions') {
        if (step === 1) return writeChatSse(res, chatToolCall('c1', 'list_message_resources', {}));
        if (step === 2) {
          const resId = JSON.parse(body.messages.find(m => m.role === 'tool').content).resources[0].resource_id;
          return writeChatSse(res, chatToolCall('c2', 'view_message_image', { resource_id: resId }));
        }
        return writeChatSse(res, chatToolCall('c3', 'finish', { message: 'passthrough chat ok' }));
      }
      if (interfaceType === 'openai-responses') {
        if (step === 1) return writeResponsesSse(res, { type: 'function_call', call_id: 'c1', name: 'list_message_resources', arguments: '{}' });
        if (step === 2) {
          const outItem = body.input.find(i => i.type === 'function_call_output');
          const resId = JSON.parse(typeof outItem.output === 'string' ? outItem.output : outItem.output[0].text).resources[0].resource_id;
          return writeResponsesSse(res, { type: 'function_call', call_id: 'c2', name: 'view_message_image', arguments: JSON.stringify({ resource_id: resId }) });
        }
        return writeResponsesSse(res, { type: 'function_call', call_id: 'c3', name: 'finish', arguments: JSON.stringify({ message: 'passthrough responses ok' }) });
      }
      // anthropic-messages
      if (step === 1) return writeAnthropicSse(res, { type: 'tool_use', id: 'toolu_1', name: 'list_message_resources', input: {} });
      if (step === 2) {
        const tr = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === 'tool_result');
        const trText = typeof tr.content === 'string' ? tr.content : tr.content[0].text;
        const resId = JSON.parse(trText).resources[0].resource_id;
        return writeAnthropicSse(res, { type: 'tool_use', id: 'toolu_2', name: 'view_message_image', input: { resource_id: resId } });
      }
      return writeAnthropicSse(res, { type: 'tool_use', id: 'toolu_3', name: 'finish', input: { message: 'passthrough anthropic ok' } });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    t.after(async () => {
      await manager.recover();
      provider.closeAllConnections();
      await new Promise(r => provider.close(r));
      store.close();
      rmSync(root, { recursive: true, force: true });
    });

    const secretApiKey = 'passthrough-secret-key-' + interfaceType;
    store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m',NULL,?,'fixture-model',?,'now')",
      `http://127.0.0.1:${provider.address().port}/v1`, store.secrets.seal({ value: secretApiKey }, 'model:m'));
    saveModelMetadata(store, 'm', { interface_type: interfaceType, capabilities: { image_input: true } });
    const before = serviceRole(store, managementAssistant);
    updateServiceRole(store, 'admin', managementAssistant, { expected_revision: before.revision, harness: 'pi', model_id: 'm' });
    const role = serviceRole(store, managementAssistant);
    await manager.call('PUT', '/v1/projects/101');

    const { turn: mediaTurn } = createMediaHarness(store, new Map([['img_fixture_1', { data: smallPng, mime: 'image/png' }]]));
    const computer = {
      async sessionWorkspace(task, workspaceId, r, log) {
        const ws = new Workspace(store, manager, { ...task, repository_id: '101', workspace_id: workspaceId, generation: 1 }, r, async () => {}, log, 'service_role_operations');
        await ws.call('init', { type: 'workspace_init' });
        return ws;
      },
    };
    const spec = {
      store,
      task: { id: randomBytes(24).toString('hex'), kind: 'management.agent', repository_id: null, service_role_id: role.id, conversation_id: 'mm-pi-pass-' + interfaceType, source_message: 'm1' },
      redactor,
      guard: async () => {},
      system: 'Inspect images via passthrough gateway.',
      prompt: 'Inspect the message image.',
      model: serviceRoleModel(store, role.id),
      tools: mediaTools,
      execute: async (name, args) => mediaTurn.execute(name, args),
    };

    const reply = await runAgent({
      ...spec,
      adapter: services => serviceHarnessTurn(spec, services, role, computer, 'owner:pass:' + interfaceType, mediaTurn),
    });
    assert.match(reply, /ok/);
    assert.equal(captured.length, 3);
    assert.equal(store.get('SELECT count(*) n FROM model_requests').n, 3);
    assert.ok(!JSON.stringify(findPiModelsJson(root)).includes(secretApiKey), 'long-lived API key must never enter container models.json');
    const third = captured[2].body;
    if (interfaceType === 'openai-chat-completions') {
      const img = third.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'image_url');
      assert.equal(img?.image_url?.url, `data:image/png;base64,${smallBase64}`);
    } else if (interfaceType === 'openai-responses') {
      const img = third.input.flatMap(i => Array.isArray(i.output) ? i.output : []).find(p => p.type === 'input_image');
      assert.equal(img?.image_url, `data:image/png;base64,${smallBase64}`);
    } else {
      const tr = third.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result').at(-1);
      const img = Array.isArray(tr?.content) ? tr.content.find(b => b.type === 'image') : null;
      assert.equal(img?.source?.type, 'base64');
      assert.equal(img?.source?.media_type, 'image/png');
      assert.equal(img?.source?.data, smallBase64);
    }
    assert.ok(!readAllEventsJsonl(root).includes(smallBase64), 'events.jsonl must not contain base64');
  });
}

for (const scenario of [
  { name: '413 payload', status: 413, message: 'Request Entity Too Large' },
  { name: '400 vision unsupported', status: 400, message: 'This model does not support image inputs' },
]) {
  test(`Pi recovers cleanly from upstream image rejection (${scenario.name}) and strips offending image with recovery guidance`, { skip: piSkip, timeout: 90000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), `bot-mm-pi-recover-${scenario.status}-`));
    const store = new Store(':memory:', randomBytes(32));
    const manager = new LocalManager('101', root);
    const redactor = new Redactor();

    let rejectedOnce = false;
    let sawRecoveryNotice = false;
    let step = 0;
    const provider = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      step++;
      const hasImg = body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
      if (hasImg && !rejectedOnce) {
        rejectedOnce = true;
        res.writeHead(scenario.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: scenario.message,
          },
        }));
        return;
      }
      if (rejectedOnce) {
        assert.equal(hasImg, false, 'rejected image must be stripped before retry');
        sawRecoveryNotice = JSON.stringify(body.messages).includes('Image input omitted') && JSON.stringify(body.messages).includes('import_message_resource');
        return writeChatSse(res, chatToolCall('c_fin', 'finish', { message: 'Recovered after image rejection.' }));
      }
      if (step === 1) return writeChatSse(res, chatToolCall('c1', 'list_message_resources', {}));
      const resId = JSON.parse(body.messages.find(m => m.role === 'tool').content).resources[0].resource_id;
      return writeChatSse(res, chatToolCall('c2', 'view_message_image', { resource_id: resId }));
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    t.after(async () => {
      await manager.recover();
      provider.closeAllConnections();
      await new Promise(r => provider.close(r));
      store.close();
      rmSync(root, { recursive: true, force: true });
    });

    store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m',NULL,?,'fixture-model',?,'now')",
      `http://127.0.0.1:${provider.address().port}/v1`, store.secrets.seal({ value: 'recover-key' }, 'model:m'));
    const before = serviceRole(store, managementAssistant);
    updateServiceRole(store, 'admin', managementAssistant, { expected_revision: before.revision, harness: 'pi', model_id: 'm' });
    const role = serviceRole(store, managementAssistant);
    await manager.call('PUT', '/v1/projects/101');

    const { turn: mediaTurn } = createMediaHarness(store, new Map([['img_fixture_1', { data: smallPng, mime: 'image/png' }]]));
    const computer = {
      async sessionWorkspace(task, workspaceId, r, log) {
        const ws = new Workspace(store, manager, { ...task, repository_id: '101', workspace_id: workspaceId, generation: 1 }, r, async () => {}, log, 'service_role_operations');
        await ws.call('init', { type: 'workspace_init' });
        return ws;
      },
    };
    const spec = {
      store,
      task: { id: randomBytes(24).toString('hex'), kind: 'management.agent', repository_id: null, service_role_id: role.id, conversation_id: 'mm-pi-rec-' + scenario.status, source_message: 'm1' },
      redactor,
      guard: async () => {},
      system: 'Inspect images and recover on errors.',
      prompt: 'Inspect the message image.',
      model: serviceRoleModel(store, role.id),
      tools: mediaTools,
      execute: async (name, args) => mediaTurn.execute(name, args),
    };
    const reply = await runAgent({
      ...spec,
      adapter: services => serviceHarnessTurn(spec, services, role, computer, 'owner:rec:' + scenario.status, mediaTurn),
    });
    assert.equal(rejectedOnce, true);
    assert.equal(sawRecoveryNotice, true);
    assert.match(reply, /Recovered/);
  });
}

test('Pi models.json writes input:["text"] when image_input=false and view_message_image returns model_image_input_unsupported without downloading', { skip: piSkip, timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-mm-pi-novision-'));
  const store = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root);
  const redactor = new Redactor();

  let observedToolError = null;
  let step = 0;
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    step++;
    assert.equal(body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')), false);
    if (step === 1) return writeChatSse(res, chatToolCall('c1', 'list_message_resources', {}));
    if (step === 2) {
      const resId = JSON.parse(body.messages.find(m => m.role === 'tool').content).resources[0].resource_id;
      return writeChatSse(res, chatToolCall('c2', 'view_message_image', { resource_id: resId }));
    }
    observedToolError = JSON.parse(body.messages.filter(m => m.role === 'tool').at(-1).content);
    return writeChatSse(res, chatToolCall('c3', 'finish', { message: 'Model does not support images.' }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(async () => {
    await manager.recover();
    provider.closeAllConnections();
    await new Promise(r => provider.close(r));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m',NULL,?,'text-only',?,'now')",
    `http://127.0.0.1:${provider.address().port}/v1`, store.secrets.seal({ value: 'key' }, 'model:m'));
  saveModelMetadata(store, 'm', { capabilities: { image_input: false } });
  const before = serviceRole(store, managementAssistant);
  updateServiceRole(store, 'admin', managementAssistant, { expected_revision: before.revision, harness: 'pi', model_id: 'm' });
  const role = serviceRole(store, managementAssistant);
  await manager.call('PUT', '/v1/projects/101');

  const model = serviceRoleModel(store, role.id);
  const { turn: mediaTurn, getDownloads } = createMediaHarness(store, new Map([['img_fixture_1', { data: smallPng, mime: 'image/png' }]]), new Map(), () => model.capabilities?.image_input !== false);
  const computer = {
    async sessionWorkspace(task, workspaceId, r, log) {
      const ws = new Workspace(store, manager, { ...task, repository_id: '101', workspace_id: workspaceId, generation: 1 }, r, async () => {}, log, 'service_role_operations');
      await ws.call('init', { type: 'workspace_init' });
      return ws;
    },
  };
  const spec = {
    store,
    task: { id: randomBytes(24).toString('hex'), kind: 'management.agent', repository_id: null, service_role_id: role.id, conversation_id: 'mm-pi-novision', source_message: 'm1' },
    redactor,
    guard: async () => {},
    system: 'Respect model capabilities.',
    prompt: 'Try to inspect the image.',
    model,
    tools: mediaTools,
    execute: async (name, args) => mediaTurn.execute(name, args),
  };

  const reply = await runAgent({
    ...spec,
    adapter: services => serviceHarnessTurn(spec, services, role, computer, 'owner:novision', mediaTurn),
  });
  assert.match(reply, /does not support/);
  assert.equal(getDownloads(), 0, 'image_input=false must not download resource bytes');
  assert.equal(observedToolError?.error, 'model_image_input_unsupported');
  const modelsJson = findPiModelsJson(root);
  assert.deepEqual(Object.values(modelsJson.providers)[0].models[0].input, ['text']);
});

test('Pi task agent native read tool sends workspace image when image_input=true and scrubs base64 from events.jsonl', { skip: piSkip, timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-mm-pi-task-'));
  const store = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root);
  const redactor = new Redactor();
  const wsId = randomWorkspaceId();
  const logs = [];
  const diagramPng = validPng;
  const diagramBase64 = diagramPng.toString('base64');

  let sawImageInModelRequest = false;
  let lastMessages = null;
  let step = 0;
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    step++;
    if (step === 1) return writeChatSse(res, chatToolCall('c1', 'read', { path: 'diagram.png' }));
    lastMessages = body.messages;
    const img = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(p => p.type === 'image_url');
    sawImageInModelRequest = img?.image_url?.url === `data:image/png;base64,${diagramBase64}`;
    return writeChatSse(res, chatToolCall('c2', 'finish', { summary: 'inspected diagram.png' }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(async () => {
    await manager.recover();
    provider.closeAllConnections();
    await new Promise(r => provider.close(r));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('101','fixture/repo','o','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101',?,'vision-task-model',?,'now')",
    `http://127.0.0.1:${provider.address().port}/v1`, store.secrets.seal({ value: 'task-key' }, 'model:m'));
  store.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('101','m',1)");
  const env = await manager.call('PUT', '/v1/projects/101');
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t1','101','review.issue','running','Inspect diagram','{}',1,?,?)", env.generation, wsId);
  const task = store.get("SELECT * FROM tasks WHERE id='t1'");
  const workspace = new Workspace(store, manager, task, redactor, async () => {}, value => logs.push(value));
  await workspace.call('init', { type: 'workspace_init' });
  writeFileSync(join(root, 'tasks', wsId, 'repo', 'diagram.png'), diagramPng);

  const model = openModel(store, store.get("SELECT * FROM models WHERE id='m'"));
  const finishTool = {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Finish inspection',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    },
  };
  const spec = {
    store,
    task,
    redactor,
    guard: async () => {},
    system: 'Inspect repository image diagram.png and finish.',
    prompt: 'Read diagram.png and submit finish.',
    model,
    tools: [finishTool],
    finish: { name: 'finish', validate: args => String(args.summary) },
    roleRun: { instance_id: 'ri-mm-1', role: 'reviewer', version: '1', harness: 'pi', harness_version: '1', recovery_mode: 'fresh' },
    roleWorkspace: workspace,
    harnessAccess: { workspace: 'read', fileTools: 'read', commands: false, network: false, github: { repository: 'fixture/repo', scopes: [] } },
    pi: { workspace, key: 'task-mm-pi', resume: false },
  };
  const summary = await runAgent({ ...spec, adapter: roleHarness('pi').adapter(spec) });
  assert.equal(summary, 'inspected diagram.png');
  assert.equal(sawImageInModelRequest, true, 'Pi native read tool image must reach the model; messages=' + JSON.stringify(lastMessages));
  assert.ok(!readAllEventsJsonl(root).includes(diagramBase64), 'events.jsonl must not contain base64 from native read tool');
  assert.ok(!JSON.stringify(logs).includes(diagramBase64), 'workspace.log must not contain base64 from native read tool');
  const taskToolRows = store.all('SELECT * FROM task_tools');
  // The session starts with the last piece of its configuration (#1277); that effectful call is recorded, its bytes are not.
  const startRow = taskToolRows.map(row => JSON.parse(row.request)).find(request => request.request?.type === 'workspace_agent_config' && request.request.start === true);
  assert.ok(startRow, 'expected effectful agent start row recorded in task_tools');
  assert.equal(startRow.request.base64, '[redacted]');
  assert.ok(!taskToolRows.some(row => String(row.request).includes('workspace_agent_poll')), 'runner polls must not be recorded in task_tools (#1266)');
  assert.ok(!JSON.stringify(taskToolRows).includes(diagramBase64), 'task_tools must not contain base64 from native read tool');
});
