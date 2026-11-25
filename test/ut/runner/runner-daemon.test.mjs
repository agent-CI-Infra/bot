import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { RunnerClient } from '../../../manager/runner-client.mjs';
import { commandLimit, runnerRequestLimit } from '../../../runner/command-policy.mjs';
import { WsConnection, WS_OPCODES, encodeWsFrame } from '../../../runner/wire-protocol.mjs';
import { waitForMailboxChange } from '../../../runner/mailbox-watch.mjs';

// Configure local workspace BEFORE importing any runner module that reads runner/paths.mjs at load time.
const sharedRoot = mkdtempSync(join(tmpdir(), 'bot-rd-root-'));
const sharedWork = join(sharedRoot, 'work');
mkdirSync(join(sharedWork, 'home'), { recursive: true, mode: 0o700 });
mkdirSync(join(sharedWork, 'tmp'), { recursive: true, mode: 0o700 });
process.env.BOT_LOCAL_EXECUTION = 'true';
process.env.BOT_LOCAL_WORKSPACE = sharedWork;

const { startRunnerDaemon } = await import('../../../runner/daemon.mjs');
const { isKeeper, isRunner } = await import('../../../runner/ownership.mjs');
const { runnerRoot, tasksDirectory } = await import('../../../runner/paths.mjs');

test.after(() => {
  rmSync(sharedRoot, { recursive: true, force: true });
});

const opId = () => randomBytes(24).toString('hex');

async function startLocalDaemon(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-rd-'));
  const sockDir = join(dir, 'sock');
  mkdirSync(sockDir, { recursive: true, mode: 0o770 });
  const token = opts.token ?? randomBytes(32).toString('hex');
  let tokenFile = null;
  if (opts.useTokenFile) {
    tokenFile = join(sockDir, '.token');
    writeFileSync(tokenFile, token + '\n', { mode: 0o640 });
  }
  const socketPath = opts.socketPath === null ? null : join(sockDir, 'r.sock');
  const daemon = await startRunnerDaemon({
    socketPath,
    listen: opts.listen ?? null,
    token: opts.useTokenFile ? undefined : token,
    tokenFile: opts.useTokenFile ? tokenFile : null,
    heartbeatMs: opts.heartbeatMs ?? 200,
  });
  t.after(async () => {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, sockDir, socketPath, tokenFile, token, daemon };
}

function rawHttpUds(socketPath, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('RFC 6455 WebSocket framing handles small/medium/large messages, fragmented frames, chunk splits, and ping/pong', async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const makePairSocket = (readable, writable) => {
    const sock = new PassThrough();
    readable.on('data', d => sock.emit('data', d));
    readable.on('end', () => sock.emit('close'));
    sock.write = chunk => writable.write(chunk);
    sock.end = () => { writable.end(); sock.emit('close'); };
    sock.destroy = () => { sock.destroyed = true; writable.destroy(); sock.emit('close'); };
    sock.destroyed = false;
    sock.writable = true;
    return sock;
  };
  const serverWs = new WsConnection(makePairSocket(clientToServer, serverToClient), { isServer: true });
  const clientWs = new WsConnection(makePairSocket(serverToClient, clientToServer), { isServer: false });

  const receivedServer = [];
  const receivedClient = [];
  let ponged = false;
  serverWs.on('text', msg => receivedServer.push(msg));
  clientWs.on('text', msg => receivedClient.push(msg));
  clientWs.on('pong', () => { ponged = true; });

  // Small (<126), medium (>126 & <65536), large (>65535) payloads
  const small = 'hello-ws';
  const medium = 'm'.repeat(2000);
  const large = 'L'.repeat(70_000);
  clientWs.sendText(small);
  clientWs.sendText(medium);
  clientWs.sendText(large);
  clientWs.ping(Buffer.from('hb'));
  serverWs.sendText('reply-from-server');

  // Fragmented client text frame split into 2 continuation frames, fed byte-by-byte into transport
  const frag1 = encodeWsFrame(WS_OPCODES.TEXT, Buffer.from('part-one-'), { mask: true, fin: false });
  const frag2 = encodeWsFrame(WS_OPCODES.CONTINUATION, Buffer.from('part-two'), { mask: true, fin: true });
  const combined = Buffer.concat([frag1, frag2]);
  for (let i = 0; i < combined.length; i += 3) {
    clientToServer.write(combined.subarray(i, i + 3));
  }

  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(receivedServer, [small, medium, large, 'part-one-part-two']);
  assert.deepEqual(receivedClient, ['reply-from-server']);
  assert.equal(ponged, true);
});

test('ownership recognizes daemon.mjs alongside idle.mjs and runner.mjs', () => {
  assert.equal(isKeeper({ cmdline: `node ${runnerRoot}/daemon.mjs` }), true);
  assert.equal(isKeeper({ cmdline: `${process.execPath} ${runnerRoot}/daemon.mjs` }), true);
  assert.equal(isKeeper({ cmdline: `node ${runnerRoot}/idle.mjs` }), true);
  assert.equal(isKeeper({ cmdline: `node ${runnerRoot}/runner.mjs abc` }), false);
  assert.equal(isRunner({ cmdline: `node ${runnerRoot}/daemon.mjs` }), true);
  assert.equal(isRunner({ cmdline: `node ${runnerRoot}/runner.mjs --stdin` }), true);
  assert.equal(isRunner({ cmdline: `${process.execPath} ${runnerRoot}/runner.mjs --stdin` }), true);
});

test('runner daemon over private UDS enforces token auth, unlinks .token, runs >95 KiB payloads & >64 KiB commands, and streams output over WS and HTTP long-poll', async t => {
  // Initialize BOT_LOCAL_* before first runner/paths.mjs evaluation in this test file.
  const f = await startLocalDaemon(t, { useTokenFile: true, heartbeatMs: 200 });

  // Token file must be unlinked immediately on startup so container child processes cannot read it.
  assert.equal(existsSync(f.tokenFile), false, '.token must be unlinked immediately on daemon startup');

  // Unauthenticated and wrong-token requests must be rejected with 401.
  const noAuth = await rawHttpUds(f.socketPath, 'GET', '/v1/health');
  assert.equal(noAuth.status, 401);
  const badAuth = await rawHttpUds(f.socketPath, 'GET', '/v1/health', { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(badAuth.status, 401);

  const client = new RunnerClient({ socketPath: f.socketPath, token: f.token, preferWs: true });
  t.after(() => client.close());

  const health = await client.waitReady({ timeoutMs: 5_000 });
  assert.equal(health.ok, true);
  assert.equal(health.result.ready, true);
  assert.equal(health.result.daemon, true);
  assert.equal(health.result.protocol_version, 2);

  // 1. >95 KiB JSON request + >64 KiB (128 KiB) script runs cleanly with stdin closed and no leaked token env.
  const scriptHead = 'test -z "$(cat)" && test -z "$BOT_RUNNER_TOKEN" && printf big-script-ok # ';
  const bigScript = scriptHead + 'a'.repeat(128 * 1024 - scriptHead.length);
  const bigRes = await client.execute({ operation_id: opId(), type: 'command', command: bigScript, timeout_ms: 15_000 });
  assert.equal(bigRes.ok, true, JSON.stringify(bigRes));
  assert.equal(bigRes.result.exit_code, 0);
  assert.equal(bigRes.result.output, 'big-script-ok');

  // 2. Command exceeding 1 MiB is refused with stable `command_too_long`.
  const overCmd = await client.execute({ operation_id: opId(), type: 'command', command: 'x'.repeat(commandLimit + 1), timeout_ms: 5_000 });
  assert.equal(overCmd.ok, false);
  assert.equal(overCmd.error, 'command_too_long');
  assert.equal(overCmd.limit, commandLimit);
  assert.equal(overCmd.length, commandLimit + 1);

  // 3. Request exceeding 8 MiB is rejected with 413 `runner_request_too_large` (daemon-side enforcement too).
  const hugeBody = Buffer.alloc(runnerRequestLimit + 128, 0x20);
  const hugeHttp = await rawHttpUds(f.socketPath, 'POST', '/v1/execute', {
    headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json', 'Content-Length': String(hugeBody.length) },
    body: hugeBody,
  });
  assert.equal(hugeHttp.status, 413);
  assert.equal(JSON.parse(hugeHttp.body).error, 'runner_request_too_large');

  // 4. Async streaming command over WebSocket receives incremental output chunks and final completion.
  const wsChunks = [];
  const streamOpId = opId();
  const streamRes = await client.execute(
    { operation_id: streamOpId, type: 'command', command: 'printf "chunk-1\\n"; sleep 0.35; printf "chunk-2\\n"', timeout_ms: 15_000 },
    { onOutput: msg => wsChunks.push(msg.data) },
  );
  assert.equal(streamRes.ok, true, JSON.stringify(streamRes));
  assert.equal(streamRes.result.exit_code, 0);
  assert.match(streamRes.result.output, /chunk-1[\s\S]*chunk-2/);
  assert.ok(wsChunks.join('').includes('chunk-1') && wsChunks.join('').includes('chunk-2'), `expected streamed WS chunks, got: ${JSON.stringify(wsChunks)}`);

  // 5. Same streaming command over HTTP long-poll fallback (WS disabled) receives output & heartbeats without blocking >25s.
  const pollClient = new RunnerClient({ socketPath: f.socketPath, token: f.token, preferWs: false, longPollWaitMs: 150 });
  t.after(() => pollClient.close());
  const pollChunks = [];
  const pollRes = await pollClient.execute(
    { operation_id: opId(), type: 'command', command: 'printf "lp-1\\n"; sleep 0.4; printf "lp-2\\n"', timeout_ms: 15_000 },
    { onOutput: msg => pollChunks.push(msg.data) },
  );
  assert.equal(pollRes.ok, true, JSON.stringify(pollRes));
  assert.equal(pollRes.result.exit_code, 0);
  assert.ok(pollChunks.join('').includes('lp-1') && pollChunks.join('').includes('lp-2'), `expected long-poll chunks, got: ${JSON.stringify(pollChunks)}`);

  // 6. Async command submit (202) + explicit cancel stops long-running command promptly.
  const cancelOpId = opId();
  const started = await client.startCommand({ operation_id: cancelOpId, type: 'command', command: 'sleep 30', timeout_ms: 30_000 });
  assert.equal(started.state, 'running');
  const statusRunning = await client.commandStatus(cancelOpId);
  assert.equal(statusRunning.state, 'running');
  const cancelRes = await client.cancelCommand(cancelOpId);
  assert.equal(cancelRes.cancelled, true);
  // Wait for cancelled command to settle quickly (well below 30s).
  const waited = await client.waitCommand(cancelOpId, { offset: 0, timeoutMs: 5_000 });
  assert.equal(waited.body.state, 'completed');

  // 7. Raw binary blob download of command_output (both inline small output and disk-backed >100 KiB truncated output) and upload of workspace_artifact.
  const fullOut = await client.downloadBlob('command_output', streamOpId);
  assert.match(fullOut.buffer.toString('utf8'), /chunk-1[\s\S]*chunk-2/);
  assert.equal(fullOut.totalSize, fullOut.buffer.length);
  const partialOut = await client.downloadBlob('command_output', streamOpId, { offset: 4 });
  assert.equal(partialOut.buffer.toString('utf8'), fullOut.buffer.subarray(4).toString('utf8'));

  const truncOpId = opId();
  const truncRes = await client.execute({
    operation_id: truncOpId,
    type: 'command',
    command: `node -e "process.stdout.write('B'.repeat(1200 * 1024))"`,
    timeout_ms: 15_000,
  });
  assert.equal(truncRes.ok, true);
  assert.equal(truncRes.result.truncated, true);
  const truncBlob = await client.downloadBlob('command_output', truncOpId);
  assert.equal(truncBlob.buffer.length, 1200 * 1024);
  assert.equal(truncBlob.totalSize, 1200 * 1024);

  const wsId = opId();
  const wsInit = await client.execute({ operation_id: opId(), type: 'workspace_init', workspace_id: wsId });
  assert.equal(wsInit.ok, true, JSON.stringify(wsInit));
  const stageId = opId();
  const rawBlob = randomBytes(128 * 1024);
  const uploaded = await client.uploadBlob('workspace_artifact', stageId, rawBlob, { workspaceId: wsId });
  assert.equal(uploaded.staged, true);
  assert.equal(uploaded.size, rawBlob.length);

  // 8. cli_config_write delivers content via x-bot-cli-config-b64 header, not JSON body.
  const secretJson = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-test-secret-1378' } });
  const writeCfg = await client.execute(
    { operation_id: opId(), type: 'cli_config_write', cli: 'claude_code', file: '.credentials.json' },
    { extraEnv: ['BOT_CLI_CONFIG_B64=' + Buffer.from(secretJson, 'utf8').toString('base64')] },
  );
  assert.equal(writeCfg.ok, true, JSON.stringify(writeCfg));
  const statusCfg = await client.execute({ operation_id: opId(), type: 'cli_config_status' });
  assert.equal(statusCfg.ok, true);
  assert.equal(statusCfg.result.claude_code.files['.credentials.json'].exists, true);
  const delCfg = await client.execute({ operation_id: opId(), type: 'cli_config_delete', cli: 'claude_code', file: '.credentials.json' });
  assert.equal(delCfg.ok, true);

  // 9. Mailbox inotify watcher pushes WS `mailbox.event` immediately when a tool request lands.
  const mailboxDir = join(tasksDirectory, wsId, 'agent');
  mkdirSync(join(mailboxDir, 'tool-requests'), { recursive: true });
  const events = [];
  const unwatch = await client.watchMailbox(wsId, ev => events.push(ev));
  t.after(() => unwatch());
  // Allow watch registration frame to settle on daemon.
  await new Promise(r => setTimeout(r, 40));
  const startedAt = Date.now();
  writeFileSync(join(mailboxDir, 'tool-requests', `${opId()}.json`), '{"id":"test"}');
  while (!events.length && Date.now() - startedAt < 2_000) {
    await new Promise(r => setTimeout(r, 15));
  }
  assert.ok(events.length >= 1, 'expected immediate WS mailbox.event push via inotify');
  assert.equal(events[0].workspace_id, wsId);

  // Also test waitForMailboxChange fast wakeup (<300ms despite 3000ms fallback).
  const waitStart = Date.now();
  const waitPromise = waitForMailboxChange(mailboxDir, 3_000, { fallbackMs: 3_000 });
  setTimeout(() => writeFileSync(join(mailboxDir, 'events.ndjson'), '{"type":"ping"}\n'), 30);
  await waitPromise;
  assert.ok(Date.now() - waitStart < 1_000, 'inotify should wake waitForMailboxChange immediately');
});

test('runner daemon over controlled loopback TCP enforces mandatory auth and supports identical WS/HTTP protocol', async t => {
  await assert.rejects(
    () => startRunnerDaemon({ socketPath: null, listen: '127.0.0.1:0', tokenFile: null }),
    /runner_daemon_token_required_for_tcp/,
  );

  const f = await startLocalDaemon(t, { socketPath: null, listen: '127.0.0.1:0', heartbeatMs: 200 });
  assert.ok(f.daemon.tcp?.url?.startsWith('http://127.0.0.1:'));

  // Reject unauthenticated TCP request.
  const unauth = await fetch(`${f.daemon.tcp.url}/v1/health`);
  assert.equal(unauth.status, 401);

  const tcpClient = new RunnerClient({ baseUrl: f.daemon.tcp.url, token: f.token, preferWs: true });
  t.after(() => tcpClient.close());
  const health = await tcpClient.waitReady({ timeoutMs: 5_000 });
  assert.equal(health.ok, true);
  assert.equal(health.result.daemon, true);

  const cmd = await tcpClient.execute({ operation_id: opId(), type: 'command', command: 'printf tcp-ok', timeout_ms: 10_000 });
  assert.equal(cmd.ok, true);
  assert.equal(cmd.result.output, 'tcp-ok');
});
