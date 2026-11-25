import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker } from '../../../manager/docker.mjs';
import { Projects } from '../../../manager/projects.mjs';
import { AssistantComputers, assistantHome } from '../../../manager/assistant-computers.mjs';
import { createManagerServer } from '../../../manager/server.mjs';
import { RunnerClient } from '../../../manager/runner-client.mjs';
import { runnerRequestLimit } from '../../../runner/command-policy.mjs';
import { FakeDocker } from '../../fixtures/fake-docker.mjs';

const opId = () => randomBytes(24).toString('hex');
const hex = n => randomBytes(n).toString('hex');

function makeSocketAwareFakeDocker({ socketsDir, modelGatewayDir = null, skillStoreDir = null, homesDir = null }) {
  const docker = new FakeDocker();
  docker.runnerClients = new Map();
  docker.homesMount = homesDir;
  docker.registerRunnerEndpoint = (container, config) => {
    docker.unregisterRunnerEndpoint(container);
    const client = config instanceof RunnerClient ? config : new RunnerClient(config);
    docker.runnerClients.set(container, client);
    return client;
  };
  docker.unregisterRunnerEndpoint = container => {
    const existing = docker.runnerClients.get(container);
    if (existing) {
      docker.runnerClients.delete(container);
      try { existing.close(); } catch {}
    }
  };
  docker.runnerClient = container => docker.runnerClients.get(container) || null;

  const baseRequest = docker.request.bind(docker);
  // Real Docker Engine serializes Mount.ReadOnly with Go `omitempty`, dropping `ReadOnly: false` on inspect.
  docker.request = async (method, path, body, raw, timeout) => {
    const res = await baseRequest(method, path, body, raw, timeout);
    if (path.startsWith('/containers/create')) {
      const name = new URL('http://docker' + path).searchParams.get('name');
      const stored = docker.containers.get(name);
      if (stored?.HostConfig?.Mounts) {
        stored.HostConfig = {
          ...stored.HostConfig,
          Mounts: stored.HostConfig.Mounts.map(m => {
            const copy = { ...m };
            if (copy.ReadOnly === false) delete copy.ReadOnly;
            return copy;
          }),
        };
      }
    }
    return res;
  };
  const baseVolumeName = docker.volumeName.bind(docker);
  docker.volumeName = async destination => {
    if (destination === socketsDir) return 'bot_runner-sockets';
    if (modelGatewayDir && destination === modelGatewayDir) return 'bot_model-gateway';
    if (skillStoreDir && destination === skillStoreDir) return 'bot_skill-store';
    return baseVolumeName(destination);
  };
  docker.volumes.set('bot_runner-sockets', { Labels: { 'department.bot.kind': 'runner-sockets', 'com.docker.compose.volume': 'runner-sockets' } });
  if (modelGatewayDir) {
    docker.volumes.set('bot_model-gateway', { Labels: { 'department.bot.kind': 'model-gateway', 'com.docker.compose.volume': 'model-gateway' } });
  }
  if (skillStoreDir) {
    docker.volumes.set('bot_skill-store', { Labels: { 'department.bot.kind': 'skill-store', 'com.docker.compose.volume': 'skill-store' } });
  }
  return docker;
}

test('Projects mounts private per-container /run/bot-runner subpath, uses daemon.mjs, upgrades legacy idle.mjs containers, and cleans up on delete', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-transport-'));
  const socketsDir = join(dir, 'runner-sockets');
  const modelGatewayDir = join(dir, 'model-gateway');
  const skillStoreDir = join(dir, 'skill-store');
  mkdirSync(socketsDir, { recursive: true, mode: 0o770 });
  mkdirSync(modelGatewayDir, { recursive: true, mode: 0o755 });
  mkdirSync(join(skillStoreDir, 'projects', '101'), { recursive: true, mode: 0o755 });

  const docker = makeSocketAwareFakeDocker({ socketsDir, modelGatewayDir, skillStoreDir });
  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'tr1378',
    image: 'approved',
    egress: false,
    modelGateway: modelGatewayDir,
    skillStore: skillStoreDir,
    runnerSockets: socketsDir,
  });
  t.after(async () => {
    await projects.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  await projects.register('101');
  const cname = projects.names('101', 1).container;
  const container = docker.containers.get(cname);
  assert.ok(container);
  assert.deepEqual(container.Config.Cmd, ['node', '/opt/runner/daemon.mjs']);

  // Verify coexistence with egress=false (Internal network), #1358 /run/model-gateway, and #1359 /opt/bot-skills.
  const net = docker.networks.get(projects.names('101', 1).network);
  assert.equal(net.Internal, true);
  const mounts = container.HostConfig.Mounts;
  const runnerMount = mounts.find(m => m.Target === '/run/bot-runner');
  const mgMount = mounts.find(m => m.Target === '/run/model-gateway');
  const skillMount = mounts.find(m => m.Target === '/opt/bot-skills');
  assert.ok(mgMount && mgMount.ReadOnly === true);
  assert.ok(skillMount && skillMount.ReadOnly === true && skillMount.VolumeOptions?.Subpath === 'projects/101');
  assert.ok(runnerMount, 'expected /run/bot-runner mount');
  assert.equal(runnerMount.Source, 'bot_runner-sockets');
  assert.equal(runnerMount.ReadOnly, undefined, 'real Docker inspect omits ReadOnly when false');
  const expectedKey = createHash('sha256').update(cname).digest('hex').slice(0, 24);
  assert.equal(runnerMount.VolumeOptions?.Subpath, expectedKey);
  assert.equal(runnerMount.VolumeOptions?.NoCopy, true);

  // Per-container dir created with 0770 and fresh .token written with 0640.
  const containerSockDir = join(socketsDir, expectedKey);
  const tokenPath = join(containerSockDir, '.token');
  assert.equal(existsSync(tokenPath), true);
  assert.equal(statSync(containerSockDir).mode & 0o777, 0o770);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o640);
  const firstToken = readFileSync(tokenPath, 'utf8').trim();
  assert.match(firstToken, /^[a-f0-9]{64}$/);
  assert.ok(docker.runnerClient(cname), 'RunnerClient should be registered for started container');

  // Calling refresh/provision again when nothing changed must NOT recreate the container even though Docker omits ReadOnly: false.
  const createdStable = docker.created;
  await projects.operate('101', 'refresh', { operation_id: opId(), generation: 1 });
  assert.equal(docker.created, createdStable, 'unchanged container with omitted ReadOnly must not be recreated');

  // Mutating the runner socket mount to ReadOnly: true must be detected as stale and recreate the container.
  docker.containers.get(cname).HostConfig.Mounts.find(m => m.Target === '/run/bot-runner').ReadOnly = true;
  await projects.operate('101', 'refresh', { operation_id: opId(), generation: 1 });
  assert.equal(docker.created, createdStable + 1, 'read-only runner socket mount must trigger container recreation');
  assert.equal(docker.containers.get(cname).HostConfig.Mounts.find(m => m.Target === '/run/bot-runner').ReadOnly, undefined);

  // Stop unregisters endpoint; start regenerates a fresh .token.
  await projects.operate('101', 'stop', { operation_id: opId(), generation: 1 });
  assert.equal(docker.runnerClient(cname), null);
  await projects.operate('101', 'start', { operation_id: opId(), generation: 1 });
  const secondToken = readFileSync(tokenPath, 'utf8').trim();
  assert.match(secondToken, /^[a-f0-9]{64}$/);
  assert.notEqual(secondToken, firstToken, 'restart must rotate the one-time runner token');

  // Legacy idle.mjs container is automatically detected as stale and recreated on refresh (keeping generation 1).
  const createdBefore = docker.created;
  docker.containers.get(cname).Config.Cmd = ['node', '/opt/runner/idle.mjs'];
  await projects.operate('101', 'refresh', { operation_id: opId(), generation: 1 });
  assert.equal(docker.created, createdBefore + 1);
  assert.deepEqual(docker.containers.get(cname).Config.Cmd, ['node', '/opt/runner/daemon.mjs']);

  // Delete cleans up socket directory and unregisters endpoint.
  await projects.operate('101', 'delete', { operation_id: opId(), generation: 1 });
  assert.equal(docker.runnerClient(cname), null);
  assert.equal(existsSync(containerSockDir), false);
});

test('AssistantComputers mounts /run/bot-runner after assistant HOME (preserving Mounts[0]), works with egress=false, and cleans up on remove', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'asst-transport-'));
  const socketsDir = join(dir, 'runner-sockets');
  const homesDir = join(dir, 'homes');
  const owner = hex(16);
  mkdirSync(socketsDir, { recursive: true, mode: 0o770 });
  mkdirSync(join(homesDir, owner, 'home-1'), { recursive: true, mode: 0o700 });

  const docker = makeSocketAwareFakeDocker({ socketsDir, homesDir });
  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'ac1378',
    image: 'approved',
    egress: false,
    runnerSockets: socketsDir,
  });
  const assistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'ac1378',
    image: 'approved',
    homes: homesDir,
    runnerSocket: {
      prepare: name => projects.prepareRunnerSocket(name),
      cleanup: name => projects.cleanupRunnerSocket(name),
    },
    globalEnvironment: () => projects.assistantGlobalEnvironment(),
  });
  t.after(async () => {
    await assistants.shutdown();
    await projects.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  const acq = await assistants.acquire(owner, { turn: 'turn-1', fence: 'a'.repeat(32), home_generation: 1, home_mode: 'rw' });
  assert.equal(acq.state, 'ready');
  const cname = assistants.name(owner);
  const container = docker.containers.get(cname);
  assert.deepEqual(container.Config.Cmd, ['node', '/opt/runner/daemon.mjs']);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  // Preserve Mounts[0] as assistant HOME (critical contract checked across assistant tests).
  assert.equal(container.HostConfig.Mounts[0].Target, assistantHome);
  const runnerMount = container.HostConfig.Mounts.at(-1);
  assert.equal(runnerMount.Target, '/run/bot-runner');
  assert.equal(runnerMount.Source, 'bot_runner-sockets');
  assert.equal(runnerMount.ReadOnly, undefined, 'real Docker inspect omits ReadOnly when false');
  const key = projects.runnerSocketKey(cname);
  assert.equal(runnerMount.VolumeOptions?.Subpath, key);
  assert.equal(existsSync(join(socketsDir, key, '.token')), true);

  await assistants.remove(owner);
  assert.equal(docker.runnerClient(cname), null);
  assert.equal(existsSync(join(socketsDir, key)), false);
});

test('manager/server.mjs accepts >1.5 MiB execute payloads and proxies async /v1/projects/:id/commands endpoints to real UDS runner daemon', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-srv-'));
  const work = join(dir, 'work');
  const sockDir = join(dir, 'sock');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  mkdirSync(sockDir, { recursive: true, mode: 0o770 });
  const prevLocal = process.env.BOT_LOCAL_EXECUTION;
  const prevWork = process.env.BOT_LOCAL_WORKSPACE;
  process.env.BOT_LOCAL_EXECUTION = 'true';
  process.env.BOT_LOCAL_WORKSPACE = work;

  const { startRunnerDaemon } = await import('../../../runner/daemon.mjs');
  const daemonToken = hex(32);
  const socketPath = join(sockDir, 'r.sock');
  const daemon = await startRunnerDaemon({ socketPath, token: daemonToken, heartbeatMs: 150 });

  const docker = new FakeDocker();
  const realClient = new RunnerClient({ socketPath, token: daemonToken, preferWs: true });
  docker.runnerClient = () => realClient;
  docker.runner = (_container, input, timeout, extraEnv) => realClient.execute(input, { timeoutMs: timeout, extraEnv });

  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'srv1378',
    image: 'approved',
  });
  const token = randomBytes(32);
  const auth = 'Bearer ' + token.toString('base64');
  const { server, recovered } = createManagerServer({ projects, token });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await recovered;
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    realClient.close();
    await new Promise(r => server.close(r));
    await projects.shutdown();
    await daemon.close();
    if (prevLocal === undefined) delete process.env.BOT_LOCAL_EXECUTION;
    else process.env.BOT_LOCAL_EXECUTION = prevLocal;
    if (prevWork === undefined) delete process.env.BOT_LOCAL_WORKSPACE;
    else process.env.BOT_LOCAL_WORKSPACE = prevWork;
    rmSync(dir, { recursive: true, force: true });
  });

  await projects.register('101');
  const wsId = opId();
  const initRes = await fetch(`${base}/v1/projects/101/execute`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation_id: opId(), generation: 1, request: { type: 'workspace_init', workspace_id: wsId } }),
  });
  assert.equal(initRes.status, 200);

  // 1.5+ MiB JSON body (1.2 MiB raw -> 1.6 MiB base64) previously failed manager/server.mjs at 1500000 bytes.
  const bigData = randomBytes(1200 * 1024);
  const writeRes = await fetch(`${base}/v1/projects/101/execute`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation_id: opId(),
      generation: 1,
      request: {
        type: 'workspace_write',
        workspace_id: wsId,
        path: 'large.bin',
        base64: bigData.toString('base64'),
        offset: 0,
        final: true,
        mode: '100644',
      },
    }),
  });
  assert.equal(writeRes.status, 200, await writeRes.clone().text());
  assert.equal((await writeRes.json()).result.ok, true);

  // Async command submit + bounded long-poll wait through manager/server.mjs -> UDS daemon.
  const asyncOp = opId();
  const subRes = await fetch(`${base}/v1/projects/101/commands`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation_id: asyncOp,
      generation: 1,
      request: { type: 'workspace_command', workspace_id: wsId, command: 'printf "async-hello"; sleep 0.15; printf -- "-done"', timeout_ms: 10_000 },
    }),
  });
  assert.equal(subRes.status, 200);
  const subBody = await subRes.json();
  assert.equal(subBody.result.operation_id, asyncOp);

  let offset = 0;
  let finalResponse = null;
  let streamed = '';
  for (let i = 0; i < 10 && !finalResponse; i++) {
    const waitRes = await fetch(`${base}/v1/projects/101/commands/${asyncOp}/wait?offset=${offset}&timeout_ms=2000`, {
      headers: { Authorization: auth },
    });
    assert.equal(waitRes.status, 200);
    const { result } = await waitRes.json();
    if (result.data) streamed += result.data;
    offset = result.offset ?? offset;
    if (result.state === 'completed') finalResponse = result.response;
  }
  assert.ok(finalResponse?.ok, JSON.stringify(finalResponse));
  assert.equal(finalResponse.result.output, 'async-hello-done');
  assert.equal(streamed, 'async-hello-done');

  // Verify manager/server.mjs preserves limit/length/detail on 413 runner_request_too_large responses.
  const oversizedRes = await fetch(`${base}/v1/projects/101/execute`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation_id: opId(),
      generation: 1,
      request: { type: 'workspace_write', workspace_id: wsId, path: 'huge.bin', base64: 'A'.repeat(runnerRequestLimit + 1024), offset: 0, final: true },
    }),
  });
  assert.equal(oversizedRes.status, 413);
  const oversizedBody = await oversizedRes.json();
  assert.equal(oversizedBody.error, 'runner_request_too_large');
  assert.equal(oversizedBody.limit, runnerRequestLimit);
  assert.ok(Number.isSafeInteger(oversizedBody.length) && oversizedBody.length > runnerRequestLimit);
  assert.match(String(oversizedBody.detail || ''), new RegExp(String(runnerRequestLimit)));
});

test('Docker.execRunner fallback uses base64url argv for <=95 KiB and AttachStdin --stdin upgrade for 1 MiB+ chunks up to 8 MiB', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'docker-exec-fallback-'));
  const sockPath = join(dir, 'docker.sock');
  const execs = new Map();
  let seq = 0;

  const dockerFrame = (streamType, payload) => {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const hdr = Buffer.alloc(8);
    hdr[0] = streamType;
    hdr.writeUInt32BE(buf.length, 4);
    return Buffer.concat([hdr, buf]);
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const createMatch = /^\/v1\.47\/containers\/([^/]+)\/exec$/.exec(req.url || '');
    if (req.method === 'POST' && createMatch) {
      const id = `exec-${++seq}`;
      execs.set(id, { spec: JSON.parse(bodyText), stdin: null });
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Id: id }));
      return;
    }
    const startMatch = /^\/v1\.47\/exec\/([^/]+)\/start$/.exec(req.url || '');
    if (req.method === 'POST' && startMatch) {
      const rec = execs.get(startMatch[1]);
      assert.equal(rec.spec.AttachStdin, false);
      const parsed = JSON.parse(Buffer.from(rec.spec.Cmd[2], 'base64url').toString('utf8'));
      res.statusCode = 200;
      res.end(dockerFrame(1, JSON.stringify({ ok: true, result: { transport: 'argv', type: parsed.type, len: parsed.payload.length } })));
      return;
    }
    const inspectMatch = /^\/v1\.47\/exec\/([^/]+)\/json$/.exec(req.url || '');
    if (req.method === 'GET' && inspectMatch) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Running: false, ExitCode: 0 }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.on('upgrade', (req, socket, head) => {
    const startMatch = /^\/v1\.47\/exec\/([^/]+)\/start$/.exec(req.url || '');
    assert.ok(startMatch, `unexpected upgrade url: ${req.url}`);
    const rec = execs.get(startMatch[1]);
    assert.equal(rec.spec.AttachStdin, true);
    assert.deepEqual(rec.spec.Cmd, ['node', '/opt/runner/runner.mjs', '--stdin']);
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    const stdinChunks = [];
    // Skip any HTTP request body bytes ({"Detach":false,"Tty":false}) already read into head.
    const bodyLen = Number(req.headers['content-length'] || 0);
    let remainingBody = bodyLen;
    const consume = buf => {
      if (!buf?.length) return;
      if (remainingBody > 0) {
        if (buf.length <= remainingBody) {
          remainingBody -= buf.length;
          return;
        }
        buf = buf.subarray(remainingBody);
        remainingBody = 0;
      }
      if (buf.length) stdinChunks.push(buf);
    };
    if (head?.length) consume(head);
    socket.on('data', consume);
    socket.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(stdinChunks).toString('utf8'));
      rec.stdin = parsed;
      const reply = JSON.stringify({ ok: true, result: { transport: 'stdin', type: parsed.type, base64_len: parsed.base64.length } });
      socket.end(dockerFrame(1, reply));
    });
  });

  await new Promise(r => server.listen(sockPath, r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const docker = new Docker(sockPath);
  const small = await docker.execRunner('test-c', { operation_id: opId(), type: 'workspace_write', payload: 'hello' }, 10_000);
  assert.deepEqual(small, { ok: true, result: { transport: 'argv', type: 'workspace_write', len: 5 } });

  // 1 MiB raw -> ~1.33 MiB base64 JSON (> 95 KiB legacy argv cap, <= 8 MiB runnerRequestLimit).
  const oneMibB64 = randomBytes(1024 * 1024).toString('base64');
  const large = await docker.execRunner('test-c', { operation_id: opId(), type: 'workspace_write', base64: oneMibB64 }, 15_000);
  assert.deepEqual(large, { ok: true, result: { transport: 'stdin', type: 'workspace_write', base64_len: oneMibB64.length } });

  // > 8 MiB is still rejected with 413 runner_request_too_large carrying limit and length.
  await assert.rejects(
    () => docker.execRunner('test-c', { operation_id: opId(), type: 'workspace_write', base64: 'A'.repeat(runnerRequestLimit + 1024) }, 10_000),
    err => err.message === 'runner_request_too_large' && err.status === 413 && err.limit === runnerRequestLimit && err.length > runnerRequestLimit,
  );
});
