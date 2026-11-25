import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureStore } from '../../../fixtures/database-fixture.mjs';
import { FakeDocker } from '../../../fixtures/fake-docker.mjs';
import { fixtureClient, account, repository, setup } from '../../../fixtures/helpers.mjs';
import { createControlPlane } from '../../../../dist/server.js';
import { ProjectService } from '../../../../dist/projects/service.js';
import { NotesReclaimer } from '../../../../dist/projects/reclaim.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';
import { claimQueuedTask } from '../../../../dist/tasks/priority.js';
import { SyncTokenService } from '../../../../dist/sync/storage.js';
import { ClusterManager } from '../../../../dist/cluster/manager.js';
import { defaultModelGateway } from '../../../../dist/harness/model-gateway.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { allocateLease, issueRunToken, verifyRunToken } from '../../../../dist/roles/role-run.js';
import { beginRun } from '../../../../dist/tasks/trace.js';
import { Projects } from '../../../../manager/projects.mjs';
import { AssistantComputers } from '../../../../manager/assistant-computers.mjs';
import { createManagerServer } from '../../../../manager/server.mjs';
import { ManagerClient } from '../../../../dist/projects/service.js';
import { NodeAgent } from '../../../../manager/node-agent.mjs';
import { NODE_AGENT_PROTOCOL_VERSION } from '../../../../runner/node-protocol.mjs';

async function startLocalManager(dir) {
  const token = randomBytes(24);
  const docker = new FakeDocker();
  const assistantHomes = join(dir, 'local-assistant-homes');
  mkdirSync(assistantHomes, { recursive: true });
  docker.homesMount = assistantHomes;
  const projects = new Projects({
    database: join(dir, 'local-manager.sqlite'),
    docker,
    deployment: 'localdeploy',
    image: 'approved',
  });
  const assistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'localdeploy',
    image: 'approved',
    homes: assistantHomes,
  });
  const { server, recovered } = createManagerServer({ projects, token, assistants });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await recovered;
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new ManagerClient(url, token);
  return {
    docker,
    projects,
    assistants,
    assistantHomes,
    client,
    async close() {
      await new Promise(r => { server.close(r); server.closeAllConnections?.(); });
      await assistants.shutdown();
      await projects.shutdown();
    },
  };
}

async function createClusterHarness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-st-'));
  const local = await startLocalManager(dir);
  const store = fixtureStore(join(dir, 'control.sqlite'), randomBytes(32));
  const syncTokens = new SyncTokenService(store);
  const cluster = new ClusterManager({
    store,
    localManager: local.client,
    syncTokens,
    assistantLeaseTtlMs: 30_000,
    assistantAffinityMs: 300_000,
  });
  const projects = new ProjectService(store, cluster);
  const { server, sync } = createControlPlane({
    store,
    staticDirectory: join(process.cwd(), 'static'),
    projects,
    cluster,
    assistantHomes: local.assistantHomes,
    syncOptions: { tokens: syncTokens },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { dir, store, local, cluster, projects, sync, server, admin: base, webhook: base };
  h.client = () => fixtureClient(h);
  const agents = [];
  const shortSocketDirs = [];
  h.spawnNode = async (pairingToken, opts = {}) => {
    const nodeDir = mkdtempSync(join(dir, 'node-'));
    const docker = new FakeDocker();
    const homesDir = join(nodeDir, 'assistant-homes');
    // Keep Unix domain socket path well below Linux's 108-byte sun_path limit regardless of TMPDIR depth.
    const gwDir = mkdtempSync('/tmp/bgw-');
    shortSocketDirs.push(gwDir);
    const notesDir = join(nodeDir, 'project-notes');
    mkdirSync(homesDir, { recursive: true });
    mkdirSync(notesDir, { recursive: true });
    docker.homesMount = homesDir;
    const agent = new NodeAgent({
      centerUrl: base,
      pairingToken,
      dataDir: nodeDir,
      docker,
      image: 'approved',
      assistantHomesDir: homesDir,
      projectNotesDir: notesDir,
      modelGatewayDir: gwDir,
      compactOnStart: false,
      heartbeatIntervalMs: 60_000,
      longPollTimeoutMs: 2_000,
      reconnectDelayMs: 60,
      ...opts,
    });
    agents.push(agent);
    void agent.start();
    await agent.waitUntilConnected(10_000);
    return { agent, docker, nodeDir, homesDir, gwDir, notesDir };
  };

  t.after(async () => {
    for (const agent of agents) await agent.stop().catch(() => {});
    await new Promise(r => { server.close(r); server.closeAllConnections?.(); });
    await local.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    for (const sdir of shortSocketDirs) rmSync(sdir, { recursive: true, force: true });
  });

  const { admin } = await setup(h);
  const acc = await account(admin);
  return { h, admin, acc };
}

test('single-host default local node, pairing/Ed25519 auth, protocol 426 mismatch, and scope/spoofing boundaries', { timeout: 60_000 }, async t => {
  const { h, admin, acc } = await createClusterHarness(t);
  await repository(admin, acc.id, '101');
  await repository(admin, acc.id, '102');

  // 1. Default zero-config local node starts repo 101 seamlessly
  await h.projects.reconcile();
  assert.equal(h.local.projects.describe('101').state, 'ready');
  const nodesInit = await admin('/api/nodes');
  assert.equal(nodesInit.status, 200);
  assert.equal(nodesInit.value.nodes.length, 1);
  assert.equal(nodesInit.value.nodes[0].id, 'local');
  assert.equal(nodesInit.value.nodes[0].status, 'online');

  // 2. Issue pairing tokens for node-a (WS) and node-b (forced long-poll)
  const createdA = await admin('/api/nodes', 'POST', { id: 'node-a', name: 'Worker A', labels: { zone: 'a', gpu: 'true' } });
  assert.equal(createdA.status, 201);
  assert.match(createdA.value.pairing_token, /^bnode_/);
  assert.match(createdA.value.join_command, /BOT_CENTER_URL=/);

  const createdB = await admin('/api/nodes', 'POST', { id: 'node-b', name: 'Worker B', labels: { zone: 'b' } });
  assert.equal(createdB.status, 201);

  // 3. Protocol version skew rejected with explicit 426 + upgrade instructions
  const skewRes = await fetch(`${h.admin}/cluster/nodes/pair`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${createdA.value.pairing_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      public_key: 'invalid-ignored-after-protocol-check',
      protocol_version: NODE_AGENT_PROTOCOL_VERSION + 9,
      min_protocol_version: NODE_AGENT_PROTOCOL_VERSION + 5,
    }),
  });
  assert.equal(skewRes.status, 426);
  const skewBody = await skewRes.json();
  assert.equal(skewBody.error, 'node_protocol_incompatible');
  assert.match(String(skewBody.detail?.detail || skewBody.detail || ''), /protocol/i);

  // 4. Pair node-a over WebSocket and node-b over forced HTTP long-poll fallback
  const nodeA = await h.spawnNode(createdA.value.pairing_token, { preferLongPoll: false });
  const nodeB = await h.spawnNode(createdB.value.pairing_token, { preferLongPoll: true });
  assert.equal(nodeA.agent.nodeId, 'node-a');
  assert.equal(nodeA.agent.transport, 'websocket');
  assert.equal(nodeB.agent.nodeId, 'node-b');
  assert.equal(nodeB.agent.transport, 'long_poll');

  // One-time pairing token cannot be reused
  const reuseRes = await fetch(`${h.admin}/cluster/nodes/pair`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${createdA.value.pairing_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: nodeA.agent.identity.public_key_pem, protocol_version: NODE_AGENT_PROTOCOL_VERSION }),
  });
  assert.equal(reuseRes.status, 401);

  // Rebind repo 101 -> node-a, repo 102 -> node-b
  assert.equal((await admin('/api/repositories/101/node', 'PUT', { node_id: 'node-a' })).status, 200);
  assert.equal((await admin('/api/repositories/102/node', 'PUT', { node_id: 'node-b' })).status, 200);

  // 5. Security boundary: node-a cannot request sync token for repo 102 (bound to node-b)
  const forbiddenSync = await fetch(`${h.admin}/cluster/nodes/sync-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${nodeA.agent.sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace: 'project-notes', scope: '102', mode: 'rw', node_id: 'node-a' }),
  });
  assert.equal(forbiddenSync.status, 403);
  assert.equal((await forbiddenSync.json()).error, 'node_scope_forbidden');

  // 6. Security boundary: node-a cannot spoof node-b's identity
  const spoofBeat = await fetch(`${h.admin}/cluster/nodes/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${nodeA.agent.sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_id: 'node-b', metrics: { cpus: 99 } }),
  });
  assert.equal(spoofBeat.status, 403);
  assert.equal((await spoofBeat.json()).error, 'node_identity_mismatch');

  // 7. Re-authenticating via Ed25519 signed assertion works without pairing token
  const renewed = await nodeA.agent.authenticate();
  assert.equal(renewed.node_id, 'node-a');
  assert.match(renewed.session_token, /^bnsess_/);
});

test('multi-node routing, authoritative center notes/file-tree, global aggregation, reconnect op.resume, and chunked results over long-poll', { timeout: 60_000 }, async t => {
  const { h, admin, acc } = await createClusterHarness(t);
  await repository(admin, acc.id, '101');
  await repository(admin, acc.id, '102');

  const tokA = (await admin('/api/nodes', 'POST', { id: 'node-a', name: 'Node A' })).value.pairing_token;
  const tokB = (await admin('/api/nodes', 'POST', { id: 'node-b', name: 'Node B' })).value.pairing_token;

  let dropOnce = false;
  let execCount = 0;
  let armReconnectDrop = false;
  const nodeA = await h.spawnNode(tokA, {
    preferLongPoll: false,
    onBeforeOperation: async op => {
      if (armReconnectDrop && op.method === 'GET' && op.path === '/v1/projects/101') {
        execCount++;
        if (!dropOnce) {
          dropOnce = true;
          // Drop WS mid-operation so center must recover via op.resume without re-running!
          nodeA.agent.disconnectTransport();
          await new Promise(r => setTimeout(r, 80));
        }
      }
    },
  });
  const nodeB = await h.spawnNode(tokB, { preferLongPoll: true, chunkBytes: 4096 });

  assert.equal((await admin('/api/repositories/101/node', 'PUT', { node_id: 'node-a' })).status, 200);
  assert.equal((await admin('/api/repositories/102/node', 'PUT', { node_id: 'node-b' })).status, 200);
  await h.projects.reconcile();

  // Repo 101 container lives on node-a; repo 102 container lives on node-b
  assert.equal(nodeA.agent.driver.projects.describe('101').state, 'ready');
  assert.equal(nodeB.agent.driver.projects.describe('102').state, 'ready');
  assert.equal(nodeA.agent.driver.projects.describe('102'), null);
  assert.equal(nodeB.agent.driver.projects.describe('101'), null);

  // Control plane remains sole authority for notes / file-tree (never routed to remote node!)
  await h.cluster.call('PUT', '/v1/projects/101/notes/design', { content: '# Center Authority\n' });
  const centerRead = await h.local.client.call('GET', '/v1/projects/101/notes/design');
  assert.equal(centerRead.content, '# Center Authority\n');

  // Global endpoints aggregate local + remote nodes
  const allProjects = await h.cluster.call('GET', '/v1/projects');
  assert.ok(allProjects.some(p => p.repository_id === '101' && p.node_id === 'node-a'));
  assert.ok(allProjects.some(p => p.repository_id === '102' && p.node_id === 'node-b'));

  const defaultsView = await h.cluster.call('GET', '/v1/defaults');
  assert.ok(Array.isArray(defaultsView.cluster_nodes));
  assert.ok(defaultsView.cluster_nodes.length >= 3);

  const storageView = await h.cluster.call('GET', '/v1/storage');
  assert.ok(Array.isArray(storageView.nodes));
  assert.ok(storageView.nodes.length >= 3);

  // Disconnect & reconnect mid-operation resumes by operation_id WITHOUT executing twice
  armReconnectDrop = true;
  const resumedProject = await h.cluster.call('GET', '/v1/projects/101');
  armReconnectDrop = false;
  assert.equal(resumedProject.repository_id, '101');
  assert.equal(execCount, 1, 'operation must execute exactly once across reconnect via op.resume');

  // Large payload (> chunkBytes=4096) transferred cleanly in chunks over HTTPS long-poll fallback
  const bigOutput = 'L'.repeat(20_000);
  nodeB.docker.runner = async () => ({ ok: true, result: { ready: true, exit_code: 0, output: bigOutput } });
  const execRes = await h.cluster.call('POST', '/v1/projects/102/execute', {
    operation_id: randomBytes(24).toString('hex'),
    generation: 1,
    request: { type: 'command', command: 'echo big', timeout_ms: 5000 },
  });
  assert.equal(execRes.ok, true);
  assert.equal(execRes.result.output, bigOutput);
});

test('graceful drain blocks new claims & failed auto-restarts, safe rebind flushes SyncClient notes, reclaimNotes targets exact old node', { timeout: 60_000 }, async t => {
  const { h, admin, acc } = await createClusterHarness(t);
  await repository(admin, acc.id, '101');

  const tokA = (await admin('/api/nodes', 'POST', { id: 'node-a', name: 'Node A' })).value.pairing_token;
  const tokB = (await admin('/api/nodes', 'POST', { id: 'node-b', name: 'Node B' })).value.pairing_token;
  const nodeA = await h.spawnNode(tokA, { preferLongPoll: false });
  const nodeB = await h.spawnNode(tokB, { preferLongPoll: true });

  assert.equal((await admin('/api/repositories/101/node', 'PUT', { node_id: 'node-a' })).status, 200);
  await h.projects.reconcile();
  assert.equal(nodeA.agent.driver.projects.describe('101').state, 'ready');

  // Seed one running task (claimed) and one queued task for repo 101
  const nowIso = new Date().toISOString();
  h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,summary,object_number,status,phase,claim_token,next_run_at,created_at,updated_at)
     VALUES('task-running','101','review','Running task',1,'running','running','tok-1',0,?,?),
           ('task-queued','101','review','Queued task',2,'queued','queued',NULL,0,?,?)`,
    nowIso, nowIso, nowIso, nowIso,
  );
  h.store.run("INSERT INTO task_claims(task_id,repository_id,token,claimed_at) VALUES('task-running','101','tok-1',?)", nowIso);

  // Start draining node-a: stops admitting new tasks, does NOT kill running container while task_claims is active!
  const drainRes = await admin('/api/nodes/node-a/drain', 'POST', { timeout_seconds: 120 });
  assert.equal(drainRes.status, 201);
  assert.equal(drainRes.value.node.status, 'draining');
  assert.equal(drainRes.value.active_work.running_tasks, 1);

  assert.equal(claimQueuedTask(h.store, '101', "kind='review'", 4, Date.now()), undefined, 'draining node must refuse new claims');
  assert.equal(nodeA.agent.driver.projects.describe('101').state, 'ready', 'running task container must NOT be killed before idle');

  // Finish running task -> reconcileDrains stops container on node-a and marks drained
  h.store.run("DELETE FROM task_claims WHERE task_id='task-running'");
  h.store.run("UPDATE tasks SET status='completed' WHERE id='task-running'");
  await h.cluster.reconcileDrains();
  assert.equal(nodeA.agent.driver.projects.describe('101').state, 'stopped');
  assert.ok(h.cluster.clusterStore.getNode('node-a').drained_at);

  // Failed enabled project on draining node must NOT be auto-restarted by reconcile()
  nodeA.agent.driver.projects.db.prepare("UPDATE projects SET state='failed' WHERE repository_id='101'").run();
  await h.projects.reconcile();
  assert.equal(nodeA.agent.driver.projects.describe('101').state, 'failed', 'draining node must not auto-restart failed project');

  // Undrain node-a -> reconcile brings it back up
  assert.equal((await admin('/api/nodes/node-a/undrain', 'POST', {})).status, 201);
  await h.projects.reconcile();
  assert.equal(nodeA.agent.driver.projects.describe('101').state, 'ready');

  // SyncClient roundtrip + 3-way merge / conflict copy on rebind:
  // 1. Seed a note on center, pull onto node-a via SyncClient
  await h.cluster.call('PUT', '/v1/projects/101/notes/runbook.md', { content: 'line1\nline2\nline3\n' });
  await nodeA.agent.sync.pullProjectNotes('101');
  assert.equal(readFileSync(join(nodeA.notesDir, '101', 'runbook.md'), 'utf8'), 'line1\nline2\nline3\n');

  // 2. Concurrent non-overlapping edits on center (line1) and node-a (line3) -> SyncClient background push 3-way merges!
  await h.cluster.call('PUT', '/v1/projects/101/notes/runbook.md', { content: 'line1-center\nline2\nline3\n' });
  writeFileSync(join(nodeA.notesDir, '101', 'runbook.md'), 'line1\nline2\nline3-nodeA\n');
  writeFileSync(join(nodeA.notesDir, '101', 'node-only.md'), 'created on node-a\n');

  const epochBefore = h.cluster.clusterStore.getRepositoryBinding('101').binding_epoch;
  const rebindRes = await admin('/api/repositories/101/node', 'PUT', { node_id: 'node-b' });
  assert.equal(rebindRes.status, 200);
  assert.equal(rebindRes.value.binding.node_id, 'node-b');
  assert.ok(rebindRes.value.binding.binding_epoch > epochBefore);

  // Verify SyncClient flushed & merged node-a's notes into authoritative center before stopping node-a!
  const merged = await h.local.client.call('GET', '/v1/projects/101/notes/runbook.md');
  assert.equal(merged.content, 'line1-center\nline2\nline3-nodeA\n');
  const nodeOnly = await h.local.client.call('GET', '/v1/projects/101/notes/node-only.md');
  assert.equal(nodeOnly.content, 'created on node-a\n');

  // Stale binding_epoch operation is refused with 409 binding_epoch_mismatch
  await assert.rejects(
    () => h.cluster.call('POST', '/v1/projects/101/start', { operation_id: randomBytes(24).toString('hex'), generation: 1, binding_epoch: epochBefore }),
    err => err.status === 409 && err.code === 'binding_epoch_mismatch',
  );

  // Verify reclaimNotes targets the EXACT node holding an orphan notes volume (node-a), NEVER blindly node-b!
  const orphanRepoId = '999';
  const orphanVol = `dbot-${nodeA.agent.driver.deployment}-${orphanRepoId}-notes`;
  nodeA.docker.volumes.set(orphanVol, {
    Labels: { 'department.bot.deployment': nodeA.agent.driver.deployment, 'department.bot.repository': orphanRepoId, 'department.bot.kind': 'notes' },
  });
  const nodeBCallsBefore = nodeB.docker.calls.length;
  const reclaimer = new NotesReclaimer(h.store, h.projects);
  const remaining = await reclaimer.sweep();
  assert.equal(remaining.length, 0);
  assert.equal(nodeA.docker.volumes.has(orphanVol), false, 'orphan notes volume on node-a must be deleted');
  const nodeBDeleteCalls = nodeB.docker.calls.slice(nodeBCallsBefore).filter(c => c.startsWith('DELETE /volumes/'));
  assert.equal(nodeBDeleteCalls.length, 0, 'reclaimNotes must NEVER blindly hit node-b for a volume residing on node-a');

  // Verify deleteProjectRecords removes cluster bindings & volume rows cleanly
  deleteProjectRecords(h.store, '101');
  assert.equal(h.store.get('SELECT 1 FROM repository_node_bindings WHERE repository_id=?', '101'), undefined);
  assert.equal(h.store.get('SELECT 1 FROM repository_node_volumes WHERE repository_id=?', '101'), undefined);
});

test('assistant single-writer cross-node handoff (stop-old-before-start-new), UDS model proxy without API keys, default-deny TCP tunnel, and revoke cleanup', { timeout: 60_000 }, async t => {
  const { h, admin, acc } = await createClusterHarness(t);
  await repository(admin, acc.id, '101');

  // Disable local node for assistant placement so assistants place strictly on node-a / node-b
  h.cluster.clusterStore.startDrain('local', { actor: 'admin' });

  const tokA = (await admin('/api/nodes', 'POST', { id: 'node-a', name: 'Node A' })).value.pairing_token;
  const tokB = (await admin('/api/nodes', 'POST', { id: 'node-b', name: 'Node B' })).value.pairing_token;
  const nodeA = await h.spawnNode(tokA, { preferLongPoll: false, allowTunnel: false });
  const nodeB = await h.spawnNode(tokB, { preferLongPoll: true, allowTunnel: false });

  // Give node-a better headroom initially so owner lands on node-a
  h.cluster.clusterStore.recordHeartbeat('node-a', { metrics: { memory_free_mb: 32000, busy_assistant_containers: 0 } });
  h.cluster.clusterStore.recordHeartbeat('node-b', { metrics: { memory_free_mb: 8000, busy_assistant_containers: 2 } });

  const owner = 'e'.repeat(32);
  const ownerMemoryCenter = join(h.local.assistantHomes, owner, 'home-1', 'memory');
  mkdirSync(ownerMemoryCenter, { recursive: true });
  writeFileSync(join(ownerMemoryCenter, 'memo.md'), 'center-initial\n');

  // 1. Acquire turn-1 on node-a -> pulls ~/memory via SyncClient
  const fenceHex = 'f'.repeat(32);
  const acq1 = await h.cluster.call('PUT', `/v1/assistant-computers/${owner}`, {
    turn: 'turn-1',
    fence: fenceHex,
    home_generation: 1,
    home_mode: 'rw',
  });
  assert.equal(acq1.state, 'ready');
  assert.equal(acq1.node_id, 'node-a');
  assert.equal(readFileSync(join(nodeA.homesDir, owner, 'home-1', 'memory', 'memo.md'), 'utf8'), 'center-initial\n');

  // Concurrent turn-2 gets owner_busy (single-writer guarantee)
  const busy = await h.cluster.call('PUT', `/v1/assistant-computers/${owner}`, {
    turn: 'turn-2',
    fence: fenceHex,
    home_generation: 1,
    home_mode: 'rw',
  });
  assert.equal(busy.state, 'queued');
  assert.equal(busy.reason, 'owner_busy');

  // Edit ~/memory on node-a during turn-1, then release -> SyncClient flushes back to control plane!
  writeFileSync(join(nodeA.homesDir, owner, 'home-1', 'memory', 'memo.md'), 'updated-on-node-a\n');
  await h.cluster.call('POST', `/v1/assistant-computers/${owner}/release`, { turn: 'turn-1', remove: false });
  assert.equal(readFileSync(join(ownerMemoryCenter, 'memo.md'), 'utf8'), 'updated-on-node-a\n');

  // 2. Drain node-a -> turn-3 MUST stop & delete old container on node-a BEFORE creating new container on node-b!
  const timeline = [];
  const origNodeAReq = nodeA.docker.request.bind(nodeA.docker);
  nodeA.docker.request = async (m, p, b, raw, to) => {
    if (m === 'DELETE' && p.startsWith('/containers/')) timeline.push('node-a:delete');
    return origNodeAReq(m, p, b, raw, to);
  };
  const origNodeBReq = nodeB.docker.request.bind(nodeB.docker);
  nodeB.docker.request = async (m, p, b, raw, to) => {
    if (p.startsWith('/containers/create')) timeline.push('node-b:create');
    return origNodeBReq(m, p, b, raw, to);
  };

  assert.equal((await admin('/api/nodes/node-a/drain', 'POST', {})).status, 201);
  const acq3 = await h.cluster.call('PUT', `/v1/assistant-computers/${owner}`, {
    turn: 'turn-3',
    fence: fenceHex,
    home_generation: 1,
    home_mode: 'rw',
  });
  assert.equal(acq3.state, 'ready');
  assert.equal(acq3.node_id, 'node-b');
  assert.deepEqual(timeline, ['node-a:delete', 'node-b:create'], 'old node container MUST be deleted before new node creates container');
  assert.equal(readFileSync(join(nodeB.homesDir, owner, 'home-1', 'memory', 'memo.md'), 'utf8'), 'updated-on-node-a\n');

  // 3. Node local UDS model gateway streams through control-plane ModelGatewayHub without API keys on the node!
  const upstreamSecret = 'sk-center-only-secret-key-99999';
  let seenUpstreamAuth = '';
  const mockUpstream = http.createServer((req, res) => {
    seenUpstreamAuth = String(req.headers.authorization || '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"delta":"hello"}\n\n');
    res.end('data: [DONE]\n\n');
  });
  mockUpstream.listen(0, '127.0.0.1');
  await once(mockUpstream, 'listening');
  t.after(() => new Promise(r => { mockUpstream.close(r); mockUpstream.closeAllConnections?.(); }));

  const upstreamBase = `http://127.0.0.1:${mockUpstream.address().port}/v1`;
  const taskId = 'task-gw-proxy';
  const nowIso = new Date().toISOString();
  h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,summary,status,input,attempt,generation,created_at,updated_at)
     VALUES(?,?,'development','Gateway proxy test','running','{}',1,1,?,?)`,
    taskId, '101', nowIso, nowIso,
  );
  const run = beginRun(h.store, h.store.get('SELECT * FROM tasks WHERE id=?', taskId), 'execution', {});
  h.store.run('UPDATE task_runs SET role=? WHERE id=?', 'developer', run.id);
  const lease = allocateLease(h.store, taskId, 'assign-gw-1', run.id);
  const issued = issueRunToken(
    h.store,
    { tenant_id: acc.id, project_id: '101', task_id: taskId, run_id: run.id, lease_epoch: lease.epoch, role: 'developer' },
    ['model:invoke'],
  );
  const gwSession = await defaultModelGateway.registerSession({
    store: h.store,
    task: h.store.get('SELECT * FROM tasks WHERE id=?', taskId),
    runId: run.id,
    leaseEpoch: lease.epoch,
    runAccess: {
      token: issued.token,
      check: presented => verifyRunToken(h.store, presented, {
        tenant_id: acc.id, project_id: '101', task_id: taskId, run_id: run.id, lease_epoch: lease.epoch, role: 'developer',
      }),
    },
    redactor: new Redactor(),
    fileProvider: {
      baseUrl: `${upstreamBase}/chat/completions`,
      model: 'gpt-test',
      apiKey: upstreamSecret,
      interfaceType: 'openai-chat-completions',
    },
  });
  t.after(() => gwSession.close());

  const callUds = socketPath =>
    new Promise((resolveReq, rejectReq) => {
      const req = http.request(
        {
          socketPath,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issued.token}`,
            'Content-Type': 'application/json',
          },
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolveReq({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', rejectReq);
      req.end(JSON.stringify({ model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });

  // WS-multiplexed model proxy on node-a
  const gwWs = await callUds(join(nodeA.gwDir, 'gateway.sock'));
  assert.equal(gwWs.status, 200);
  assert.match(gwWs.body, /"delta":"hello"/);
  assert.equal(seenUpstreamAuth, `Bearer ${upstreamSecret}`);

  // HTTP streaming fallback model proxy on node-b (long-poll node without WS)
  seenUpstreamAuth = '';
  const gwHttp = await callUds(join(nodeB.gwDir, 'gateway.sock'));
  assert.equal(gwHttp.status, 200);
  assert.match(gwHttp.body, /"delta":"hello"/);
  assert.equal(seenUpstreamAuth, `Bearer ${upstreamSecret}`);

  // 4. Default-deny TCP tunnel primitive: refused by default, allowed ONLY when explicitly opted-in
  const echoServer = net.createServer(sock => sock.pipe(sock));
  echoServer.listen(0, '127.0.0.1');
  await once(echoServer, 'listening');
  t.after(() => new Promise(r => echoServer.close(r)));
  const echoPort = echoServer.address().port;

  await assert.rejects(
    () => h.cluster.hub.openTcpTunnel('node-a', { host: '127.0.0.1', port: echoPort }),
    err => err.code === 'tunnel_disabled',
  );

  nodeA.agent.allowTunnel = true;
  const tunnel = await h.cluster.hub.openTcpTunnel('node-a', { host: '127.0.0.1', port: echoPort });
  const echoed = await new Promise((resolveEcho, rejectEcho) => {
    const bufs = [];
    tunnel.on('data', chunk => {
      bufs.push(chunk);
      if (Buffer.concat(bufs).toString('utf8') === 'ping-1380') {
        tunnel.end();
        resolveEcho(Buffer.concat(bufs).toString('utf8'));
      }
    });
    tunnel.on('error', rejectEcho);
    tunnel.write('ping-1380');
  });
  assert.equal(echoed, 'ping-1380');

  // 5. Revoking node-b stops/deletes its containers, revokes sessions & sync tokens, and blocks re-auth
  assert.ok(nodeB.docker.containers.size > 0);
  const revoked = await admin('/api/nodes/node-b/revoke', 'POST', { confirm: true, force: true });
  assert.equal(revoked.status, 201);
  assert.equal(revoked.value.node.status, 'revoked');
  assert.equal(nodeB.docker.containers.size, 0, 'revoked node must stop & delete its containers');

  const staleBeat = await fetch(`${h.admin}/cluster/nodes/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${nodeB.agent.sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ metrics: {} }),
  });
  assert.ok([401, 403].includes(staleBeat.status));
});
