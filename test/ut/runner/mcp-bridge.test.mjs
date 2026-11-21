import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcpBridge } from '../../../runner/mcp-bridge.mjs';

function writeReply(agentDir, reqFile, payload) {
  const req = JSON.parse(readFileSync(join(agentDir, 'tool-requests', reqFile), 'utf8'));
  const tmp = join(agentDir, 'tool-replies', `${req.id}.tmp`);
  const out = join(agentDir, 'tool-replies', `${req.id}.json`);
  writeFileSync(tmp, JSON.stringify(payload));
  writeFileSync(out, JSON.stringify(payload));
  rmSync(tmp, { force: true });
  return req;
}

async function waitForRequests(agentDir, count, timeoutMs = 3000) {
  const dir = join(agentDir, 'tool-requests');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.json'));
      if (files.length >= count) return files;
    } catch {}
    await delay(15);
  }
  throw new Error(`Timed out waiting for ${count} tool request(s)`);
}

test('mcp-bridge handles line-delimited JSON-RPC, parallel out-of-order tool calls, error replies, and cancellation', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'mcp-bridge-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  writeFileSync(
    join(agentDir, 'mcp-tools.json'),
    JSON.stringify([
      {
        name: 'submit_review',
        description: 'Submit final structured review',
        inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      },
      {
        name: 'read_note',
        description: 'Read task note',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
      },
    ]),
  );

  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  let buf = '';
  output.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  const bridge = startMcpBridge({
    agentDir,
    input,
    output,
    token: 'rrt_test_run_token_123456',
    timeoutMs: 5000,
    pollMs: 10,
  });
  t.after(() => bridge.close());

  const waitResp = async (id, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = responses.find(r => r.id === id);
      if (hit) return hit;
      await delay(10);
    }
    throw new Error(`Timed out waiting for response id=${id}`);
  };

  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  const initResp = await waitResp(1);
  assert.equal(initResp.result.protocolVersion, '2025-03-26');
  assert.equal(initResp.result.serverInfo.name, 'bot');

  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  const listResp = await waitResp(2);
  assert.deepEqual(listResp.result.tools.map(tool => tool.name), ['submit_review', 'read_note']);

  // Issue two concurrent tool calls and answer the second one first to verify non-blocking parallel dispatch.
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'call-slow', method: 'tools/call', params: { name: 'read_note', arguments: { key: 'a' } } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'call-fast', method: 'tools/call', params: { name: 'submit_review', arguments: { summary: 'ok' } } }) + '\n');

  const files = await waitForRequests(agentDir, 2);
  const parsed = files.map(f => ({ file: f, body: JSON.parse(readFileSync(join(agentDir, 'tool-requests', f), 'utf8')) }));
  const fastReq = parsed.find(p => p.body.name === 'submit_review');
  const slowReq = parsed.find(p => p.body.name === 'read_note');
  assert.ok(fastReq && slowReq);
  assert.equal(fastReq.body.kind, 'mcp_tool');
  assert.equal(fastReq.body.token, 'rrt_test_run_token_123456');

  writeReply(agentDir, fastReq.file, { accepted: true });
  const fastResp = await waitResp('call-fast');
  assert.equal(fastResp.result.isError, false);
  assert.deepEqual(JSON.parse(fastResp.result.content[0].text), { accepted: true });
  assert.equal(responses.some(r => r.id === 'call-slow'), false);

  writeReply(agentDir, slowReq.file, { error: 'capability_denied', detail: 'not allowed' });
  const slowResp = await waitResp('call-slow');
  assert.equal(slowResp.result.isError, true);
  assert.deepEqual(JSON.parse(slowResp.result.content[0].text), { error: 'capability_denied', detail: 'not allowed' });

  // Verify notifications/cancelled aborts an in-flight call cleanly and cleans up its request file.
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'call-cancel', method: 'tools/call', params: { name: 'read_note', arguments: { key: 'cancel' } } }) + '\n');
  await waitForRequests(agentDir, 1);
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-cancel' } }) + '\n');
  await delay(60);
  assert.deepEqual(readdirSync(join(agentDir, 'tool-requests')).filter(f => f.endsWith('.json')), []);
  assert.equal(responses.some(r => r.id === 'call-cancel'), false);
});

test('mcp-bridge supports Content-Length framing and standalone CLI invocation over stdio', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'mcp-bridge-cli-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, 'mcp-tools.json'), JSON.stringify([{ name: 'ping_tool', description: 'Ping' }]));

  const child = spawn(process.execPath, [resolve('runner/mcp-bridge.mjs'), agentDir], {
    env: { ...process.env, BOT_RUN_TOKEN: 'rrt_cli_token_abcdef123456' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    try { child.kill('SIGTERM'); } catch {}
  });

  let out = Buffer.alloc(0);
  child.stdout.on('data', chunk => {
    out = Buffer.concat([out, chunk]);
  });

  const frame = obj => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
  };

  child.stdin.write(frame({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));
  child.stdin.write(frame({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }));

  const deadline = Date.now() + 3000;
  const decoded = [];
  while (Date.now() < deadline && decoded.length < 2) {
    let cursor = 0;
    decoded.length = 0;
    while (cursor < out.length) {
      const sep = out.indexOf('\r\n\r\n', cursor);
      if (sep < 0) break;
      const hdr = out.toString('utf8', cursor, sep);
      const m = /Content-Length:\s*(\d+)/i.exec(hdr);
      assert.ok(m);
      const len = Number(m[1]);
      if (out.length < sep + 4 + len) break;
      decoded.push(JSON.parse(out.toString('utf8', sep + 4, sep + 4 + len)));
      cursor = sep + 4 + len;
    }
    if (decoded.length < 2) await delay(15);
  }

  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(decoded[1].result.tools.map(tool => tool.name), ['ping_tool']);
  child.stdin.end();
});

test('mcp-bridge emits standard MCP image content blocks for multimodal tool replies including >4 MiB payloads', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'mcp-bridge-image-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, 'mcp-tools.json'), JSON.stringify([{ name: 'view_message_image', description: 'Inspect image' }]));

  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  let buf = '';
  output.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  const bridge = startMcpBridge({ agentDir, input, output, token: 'rrt_img_token_123456', timeoutMs: 5000, pollMs: 10 });
  t.after(() => bridge.close());

  const waitResp = async (id, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = responses.find(r => r.id === id);
      if (hit) return hit;
      await delay(10);
    }
    throw new Error(`Timed out waiting for response id=${id}`);
  };

  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'img-call', method: 'tools/call', params: { name: 'view_message_image', arguments: { resource_id: 'res_45m' } } }) + '\n');
  const [reqFile] = await waitForRequests(agentDir, 1);

  // 4.5 MiB raw -> 6 MiB base64 payload exceeds legacy 4 MiB MCP frame cap.
  const bigBase64 = Buffer.alloc(4.5 * 1024 * 1024, 0x33).toString('base64');
  const metadata = { resource_id: 'res_45m', name: 'big.png', mime: 'image/png', size: 4.5 * 1024 * 1024, image_input: 'next_model_request' };
  writeReply(agentDir, reqFile, {
    __bot_tool_content: true,
    observation: metadata,
    content: [
      { type: 'text', text: JSON.stringify(metadata) },
      { type: 'image', data: bigBase64, mimeType: 'image/png' },
    ],
    isError: false,
  });

  const resp = await waitResp('img-call');
  assert.equal(resp.result.isError, false);
  assert.equal(resp.result.content.length, 2);
  assert.deepEqual(JSON.parse(resp.result.content[0].text), metadata);
  assert.equal(resp.result.content[1].type, 'image');
  assert.equal(resp.result.content[1].mimeType, 'image/png');
  assert.equal(resp.result.content[1].data.length, bigBase64.length);
  assert.equal(resp.result.content[1].data, bigBase64);
});
