import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import { computerResultOwner } from '../../../../runner/result-owner.mjs';

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

async function createClusterHarness(t, extraSyncOptions = {}) {
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
    syncOptions: { tokens: syncTokens, ...extraSyncOptions },
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
    const docker = opts.docker || new FakeDocker();
    const homesDir = opts.assistantHomesDir || join(nodeDir, 'assistant-homes');
    // Keep Unix domain socket path well below Linux's 108-byte sun_path limit regardless of TMPDIR depth.
    const gwDir = mkdtempSync('/tmp/bgw-');
    shortSocketDirs.push(gwDir);
    const notesDir = join(nodeDir, 'project-notes');
    mkdirSync(homesDir, { recursive: true });
    mkdirSync(notesDir, { recursive: true });
    if (!docker.homesMount) docker.homesMount = homesDir;
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

test('compose.node.yaml volume labels pass real Projects/AssistantComputers trust checks, all 4 read-only sync namespaces sync on node-agent lifecycle, and offline nodes never wedge reconcile or deletion', async t => {
  // 1. Parse docker/compose.node.yaml (using real `docker compose config --format json` when available, else YAML parse)
  //    and prove every declared volume name + Compose label passes manager/projects.mjs & assistant-computers.mjs trust checks.
  const projectName = 'bot-node-test';
  let composeVolumes = null;
  let mountTargets = null;
  try {
    const raw = execFileSync(
      'docker',
      ['compose', '-f', join(process.cwd(), 'docker/compose.node.yaml'), '-p', projectName, 'config', '--format', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(raw);
    composeVolumes = parsed.volumes || {};
    mountTargets = (parsed.services?.['node-agent']?.volumes || [])
      .filter(v => v.type === 'volume')
      .map(v => ({ key: v.source, target: v.target, name: composeVolumes[v.source]?.name || `${projectName}_${v.source}` }));
  } catch {
    // Fallback parser for CI environments without a Docker CLI binary.
    const yaml = readFileSync(join(process.cwd(), 'docker/compose.node.yaml'), 'utf8');
    const volsBlock = yaml.split(/^volumes:\s*$/m)[1] || '';
    composeVolumes = {};
    for (const line of volsBlock.split('\n')) {
      const m = /^\s{2}([a-z0-9-]+):\s*$/.exec(line);
      if (m) composeVolumes[m[1]] = { name: `${projectName}_${m[1]}` };
    }
    mountTargets = [];
    for (const m of yaml.matchAll(/^\s+-\s+([a-z0-9-]+):(\/[^\s]+)\s*$/gm)) {
      if (composeVolumes[m[1]]) {
        mountTargets.push({ key: m[1], target: m[2], name: composeVolumes[m[1]].name });
      }
    }
  }

  assert.ok(mountTargets.length >= 8, `expected all canonical compose.node.yaml volumes, got ${mountTargets.length}`);
  const volDir = mkdtempSync(join(tmpdir(), 'compose-vols-'));
  t.after(() => rmSync(volDir, { recursive: true, force: true }));

  const mountByTarget = new Map();
  const dockerVolumes = new Map();
  const localDirByTarget = new Map();
  for (const entry of mountTargets) {
    const localPath = join(volDir, entry.key);
    mkdirSync(localPath, { recursive: true });
    localDirByTarget.set(entry.target, localPath);
    mountByTarget.set(localPath, entry.name);
    // Docker Compose automatically applies `com.docker.compose.volume=<key>` to every declared volume.
    dockerVolumes.set(entry.name, {
      Name: entry.name,
      Labels: {
        'com.docker.compose.project': projectName,
        'com.docker.compose.volume': entry.key,
      },
    });
  }

  const composeDocker = new FakeDocker();
  const origVolumeName = composeDocker.volumeName.bind(composeDocker);
  composeDocker.volumeName = async target => {
    if (mountByTarget.has(target)) return mountByTarget.get(target);
    return origVolumeName(target);
  };
  const origRequest = composeDocker.request.bind(composeDocker);
  composeDocker.request = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/volumes/')) {
      const name = decodeURIComponent(path.slice('/volumes/'.length));
      if (dockerVolumes.has(name)) return dockerVolumes.get(name);
    }
    return origRequest(method, path, body);
  };

  const resultsOwner101 = computerResultOwner('project', '101');
  mkdirSync(join(localDirByTarget.get('/tool-results'), resultsOwner101), { recursive: true });
  mkdirSync(join(localDirByTarget.get('/project-tools'), '101', 'rev-1'), { recursive: true });
  mkdirSync(join(localDirByTarget.get('/skill-store'), 'projects', '101'), { recursive: true });
  mkdirSync(join(localDirByTarget.get('/skill-store'), 'service'), { recursive: true });

  const composeProjects = new Projects({
    database: join(volDir, 'compose-check.sqlite'),
    docker: composeDocker,
    deployment: 'nodetest',
    image: 'approved',
    tools: localDirByTarget.get('/opt/agent-tools'),
    projectTools: localDirByTarget.get('/project-tools'),
    skillStore: localDirByTarget.get('/skill-store'),
    results: localDirByTarget.get('/tool-results'),
    modelGateway: localDirByTarget.get('/run/model-gateway'),
    runnerSockets: localDirByTarget.get('/run/bot-runner'),
  });
  const composeAssistants = new AssistantComputers({
    docker: composeDocker,
    db: composeProjects.db,
    deployment: 'nodetest',
    image: 'approved',
    homes: localDirByTarget.get('/assistant-homes'),
    skillStoreMount: localDirByTarget.get('/skill-store'),
    skillStoreVolume: () => composeProjects.skillStoreVolume(),
  });
  t.after(async () => {
    await composeAssistants.shutdown();
    await composeProjects.shutdown();
  });

  assert.equal(await composeProjects.agentToolsVolume(), `${projectName}_agent-tools`);
  assert.equal(await composeProjects.projectToolsVolume(), `${projectName}_project-tools`);
  assert.equal(await composeProjects.skillStoreVolume(), `${projectName}_skill-store`);
  assert.equal(await composeProjects.modelGatewayVolume(), `${projectName}_model-gateway`);
  assert.equal(await composeProjects.runnerSocketsVolume(), `${projectName}_runner-sockets`);
  const rMounts = await composeProjects.resultMount(resultsOwner101);
  assert.equal(rMounts[0].Source, `${projectName}_tool-results`);
  const ptMount = await composeProjects.projectToolsSpecMount('101', 1);
  assert.equal(ptMount.Source, `${projectName}_project-tools`);
  const skMounts = await composeProjects.projectSkillsMount('101');
  assert.equal(skMounts[0].Source, `${projectName}_skill-store`);
  assert.equal(await composeAssistants.volume(), `${projectName}_assistant-homes`);

  // 2. End-to-end sync of ALL 4 read-only namespaces (agent-tools, project-tools, skill-store, tool-results)
  //    from control plane FileSyncEngine to a paired remote NodeAgent during project & assistant lifecycles.
  const syncRoot = mkdtempSync(join(tmpdir(), 'cluster-ro-sync-'));
  t.after(() => rmSync(syncRoot, { recursive: true, force: true }));
  const cpAgentTools = join(syncRoot, 'cp-agent-tools');
  const cpProjectTools = join(syncRoot, 'cp-project-tools');
  const cpSkillStore = join(syncRoot, 'cp-skill-store');
  const cpToolResults = join(syncRoot, 'cp-tool-results');

  const nodeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  mkdirSync(join(cpAgentTools, 'codex', '1.0.0', 'bin'), { recursive: true });
  writeFileSync(join(cpAgentTools, 'codex', '1.0.0', 'manifest.json'), JSON.stringify({ arch: nodeArch, version: '1.0.0' }));
  writeFileSync(join(cpAgentTools, 'codex', '1.0.0', 'bin', 'codex'), '#!/bin/sh\necho codex-ok\n', { mode: 0o755 });

  const toolContent = Buffer.from('#!/bin/sh\necho custom-tool-ok\n');
  const toolSha = createHash('sha256').update(toolContent).digest('hex');
  mkdirSync(join(cpProjectTools, '101', 'rev-1', 'bin'), { recursive: true });
  writeFileSync(join(cpProjectTools, '101', 'rev-1', 'bin', 'mytool'), toolContent, { mode: 0o755 });

  mkdirSync(join(cpSkillStore, 'projects', '101', 'sets', 'a'.repeat(64)), { recursive: true });
  writeFileSync(join(cpSkillStore, 'projects', '101', 'sets', 'a'.repeat(64), 'SKILL.md'), '# Project Skill 101\n');
  mkdirSync(join(cpSkillStore, 'service', 'sets', 'b'.repeat(64)), { recursive: true });
  writeFileSync(join(cpSkillStore, 'service', 'sets', 'b'.repeat(64), 'SKILL.md'), '# Service Skill\n');

  const projResultFile = 'a'.repeat(48) + '.utf8';
  const asstOwner = 'c'.repeat(32);
  const asstResultOwner = computerResultOwner('assistant', asstOwner);
  const asstResultFile = 'd'.repeat(48) + '.utf8';
  mkdirSync(join(cpToolResults, resultsOwner101), { recursive: true });
  writeFileSync(join(cpToolResults, resultsOwner101, projResultFile), 'project tool result payload\n');
  mkdirSync(join(cpToolResults, asstResultOwner), { recursive: true });
  writeFileSync(join(cpToolResults, asstResultOwner, asstResultFile), 'assistant tool result payload\n');

  const { h, admin, acc } = await createClusterHarness(t, {
    agentToolsRoot: cpAgentTools,
    projectToolsRoot: cpProjectTools,
    skillStoreRoot: cpSkillStore,
    toolResultsRoot: cpToolResults,
  });
  await repository(admin, acc.id, '101');
  await repository(admin, acc.id, '102');

  // Record active project-tools revision 1 for repo 101 in control-plane DB
  const nowIso = new Date().toISOString();
  h.store.run(
    `INSERT INTO project_tool_revisions(repository_id,revision,status,mode,files_count,total_bytes,manifest,sha256,actor,source,note,created_at)
     VALUES('101',1,'active','replace',1,?,?,?,?,?,'',?)`,
    toolContent.length,
    JSON.stringify([{ path: 'bin/mytool', type: 'file', sha256: toolSha, size: toolContent.length, executable: true }]),
    toolSha,
    'admin',
    'test',
    nowIso,
  );
  h.store.run(
    `INSERT INTO project_tool_state(repository_id,active_revision,next_revision,updated_at,updated_by) VALUES('101',1,2,?,'admin')`,
    nowIso,
  );

  // Pair remote node with dedicated empty node-side volume roots (all 4 RO namespaces + assistant-homes)
  // backed by a FakeDocker returning the exact canonical Compose volume names & labels from docker/compose.node.yaml.
  const createdSyncNode = await admin('/api/nodes', 'POST', { id: 'node-sync', name: 'Sync Node' });
  assert.equal(createdSyncNode.status, 201);
  const nAgentTools = join(syncRoot, 'node-agent-tools');
  const nProjectTools = join(syncRoot, 'node-project-tools');
  const nSkillStore = join(syncRoot, 'node-skill-store');
  const nToolResults = join(syncRoot, 'node-tool-results');
  const nAssistantHomes = join(syncRoot, 'node-assistant-homes');
  for (const d of [nAgentTools, nProjectTools, nSkillStore, nToolResults, nAssistantHomes]) mkdirSync(d, { recursive: true });

  const syncNodeDocker = new FakeDocker();
  syncNodeDocker.homesMount = nAssistantHomes;
  const syncVolByMount = new Map([
    [nAgentTools, { name: `${projectName}_agent-tools`, key: 'agent-tools' }],
    [nProjectTools, { name: `${projectName}_project-tools`, key: 'project-tools' }],
    [nSkillStore, { name: `${projectName}_skill-store`, key: 'skill-store' }],
    [nToolResults, { name: `${projectName}_tool-results`, key: 'tool-results' }],
    [nAssistantHomes, { name: `${projectName}_assistant-homes`, key: 'assistant-homes' }],
  ]);
  const syncVolByName = new Map(
    [...syncVolByMount.values()].map(v => [
      v.name,
      { Name: v.name, Labels: { 'com.docker.compose.project': projectName, 'com.docker.compose.volume': v.key } },
    ]),
  );
  const origSyncVolName = syncNodeDocker.volumeName.bind(syncNodeDocker);
  syncNodeDocker.volumeName = async target => syncVolByMount.get(target)?.name ?? origSyncVolName(target);
  const origSyncReq = syncNodeDocker.request.bind(syncNodeDocker);
  syncNodeDocker.request = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/volumes/')) {
      const name = decodeURIComponent(path.slice('/volumes/'.length));
      if (syncVolByName.has(name)) return syncVolByName.get(name);
    }
    return origSyncReq(method, path, body);
  };

  const nodeSync = await h.spawnNode(createdSyncNode.value.pairing_token, {
    docker: syncNodeDocker,
    toolsDir: nAgentTools,
    projectToolsDir: nProjectTools,
    skillStoreDir: nSkillStore,
    toolResultsDir: nToolResults,
    assistantHomesDir: nAssistantHomes,
  });

  // Rebind repo 101 to node-sync and sync tools revision + start project
  const rebind = await admin('/api/repositories/101/node', 'PUT', { node_id: 'node-sync' });
  assert.equal(rebind.status, 200);
  await h.cluster.call('PUT', '/v1/projects/101');
  await h.cluster.call('PUT', '/v1/projects/101/tools', { revision: 1 });
  const started = await h.cluster.call('POST', '/v1/projects/101/start', { operation_id: 'f'.repeat(48), generation: 1 });
  assert.equal(started.state, 'ready');

  assert.equal(readFileSync(join(nAgentTools, 'codex', '1.0.0', 'bin', 'codex'), 'utf8'), '#!/bin/sh\necho codex-ok\n');
  assert.equal(readFileSync(join(nProjectTools, '101', 'rev-1', 'bin', 'mytool'), 'utf8'), '#!/bin/sh\necho custom-tool-ok\n');
  assert.equal(readFileSync(join(nSkillStore, 'projects', '101', 'sets', 'a'.repeat(64), 'SKILL.md'), 'utf8'), '# Project Skill 101\n');
  assert.equal(readFileSync(join(nToolResults, resultsOwner101, projResultFile), 'utf8'), 'project tool result payload\n');
  assert.equal(nodeSync.agent.driver.projects.hasProjectSkillsDir('101'), true);

  // Acquire assistant computer on node-sync (drain local so node-sync is picked) with project_tools
  await admin('/api/nodes/local/drain', 'POST', {});
  const asstHomeDir = join(h.local.assistantHomes, asstOwner, 'home-1', 'memory');
  mkdirSync(asstHomeDir, { recursive: true });
  const acq = await h.cluster.call('PUT', `/v1/assistant-computers/${asstOwner}`, {
    turn: 'turn-sync-1',
    fence: 'a'.repeat(32),
    home_generation: 1,
    home_mode: 'rw',
    project_tools: [{ repository_id: '101', revision: 1, mount_name: 'fixture__project-101' }],
  });
  assert.equal(acq.state, 'ready');
  assert.equal(acq.node_id, 'node-sync');
  assert.equal(readFileSync(join(nSkillStore, 'service', 'sets', 'b'.repeat(64), 'SKILL.md'), 'utf8'), '# Service Skill\n');
  assert.equal(readFileSync(join(nToolResults, asstResultOwner, asstResultFile), 'utf8'), 'assistant tool result payload\n');
  await admin('/api/nodes/local/undrain', 'POST', {});

  // 3. Offline remote node must NOT abort reconcile() for later healthy repos, and must NOT block removeEnvironment()!
  await repository(admin, acc.id, '103');
  const createdOffline = await admin('/api/nodes', 'POST', { id: 'node-flaky', name: 'Flaky Node' });
  assert.equal(createdOffline.status, 201);
  const nodeFlaky = await h.spawnNode(createdOffline.value.pairing_token);
  const rebind102 = await admin('/api/repositories/102/node', 'PUT', { node_id: 'node-flaky' });
  assert.equal(rebind102.status, 200);
  // Disconnect node-flaky and mark offline
  await nodeFlaky.agent.stop();
  h.store.run("UPDATE compute_nodes SET status='offline' WHERE id='node-flaky'");

  // Run reconcile(): repo 102 (ordered before 103) is bound to offline node-flaky, yet repo 103 on local MUST still reconcile to ready!
  await h.projects.reconcile();
  const env102 = h.store.get('SELECT state,error FROM project_environments WHERE repository_id=?', '102');
  const env103 = h.store.get('SELECT state FROM project_environments WHERE repository_id=?', '103');
  assert.equal(env102?.state, 'unavailable');
  assert.equal(env103?.state, 'ready', 'later healthy repository must still reconcile when an earlier repository node is offline');

  // Deleting repo 102 while its bound remote node is offline must succeed without wedging on GET /v1/projects/102
  await h.projects.removeEnvironment('102');
  h.projects.endRemoval('102');
});
