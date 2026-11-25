import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projects } from '../../../manager/projects.mjs';
import { AssistantComputers, assistantHome } from '../../../manager/assistant-computers.mjs';
import { createManagerServer } from '../../../manager/server.mjs';
import { RunnerClient } from '../../../manager/runner-client.mjs';
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
  assert.equal(runnerMount.ReadOnly, false);
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

  // Stop unregisters endpoint; start regenerates a fresh .token.
  await projects.operate('101', 'stop', { operation_id: opId(), generation: 1 });
  assert.equal(docker.runnerClient(cname), null);
  await projects.operate('101', 'start', { operation_id: opId(), generation: 1 });
  const secondToken = readFileSync(tokenPath, 'utf8').trim();
  assert.match(secondToken, /^[a-f0-9]{64}$/);
  assert.notEqual(secondToken, firstToken, 'restart must rotate the one-time runner token');

  // Legacy idle.mjs container is automatically detected as stale and recreated on refresh (keeping generation 1).
  const createdBefore = docker.created;
  container.Config.Cmd = ['node', '/opt/runner/idle.mjs'];
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
  assert.equal(runnerMount.ReadOnly, false);
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
});
