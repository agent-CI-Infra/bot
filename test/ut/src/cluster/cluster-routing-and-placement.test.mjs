import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { classifyManagerRoute } from '../../../../dist/cluster/manager.js';
import { ClusterStore, isRepositoryNodeClaimable, LOCAL_NODE_ID } from '../../../../dist/cluster/storage.js';
import { configuredRedactor, publicText } from '../../../../dist/core/redaction.js';
import { checkProtocolCompatibility, NODE_AGENT_PROTOCOL_VERSION } from '../../../../runner/node-protocol.mjs';
import { createComputeDriver } from '../../../../manager/compute-driver.mjs';

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-ut-'));
  const store = new Store(join(dir, 'control.sqlite'), randomBytes(32));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('classifyManagerRoute keeps notes/file-tree authoritative, separates notes/reclaim, and classifies global vs project vs assistant routes', () => {
  // Control-plane authoritative notes / file-tree routes must NEVER route to remote nodes
  for (const [method, path] of [
    ['GET', '/v1/projects/101/file-tree'],
    ['PUT', '/v1/projects/101/file-tree/note-1'],
    ['POST', '/v1/projects/101/file-tree/prune'],
    ['DELETE', '/v1/projects/101/file-tree/note-1'],
    ['GET', '/v1/projects/101/files'],
    ['PUT', '/v1/projects/101/files/readme.md'],
    ['GET', '/v1/projects/101/notes'],
    ['PUT', '/v1/projects/101/notes/architecture'],
  ]) {
    assert.deepEqual(classifyManagerRoute(method, path).kind, 'notes_authority', `${method} ${path}`);
  }

  assert.deepEqual(classifyManagerRoute('POST', '/v1/projects/101/notes/reclaim'), {
    kind: 'notes_reclaim',
    repositoryId: '101',
    action: 'notes_reclaim',
  });

  // Global aggregate endpoints
  for (const path of [
    '/v1/projects',
    '/v1/notes-volumes',
    '/v1/defaults',
    '/v1/storage',
    '/v1/precompiled-images',
    '/v1/project-tools/mounts',
  ]) {
    assert.equal(classifyManagerRoute('GET', path).kind, 'global_aggregate', `GET ${path}`);
  }

  // Global fan-out write endpoints
  for (const [method, path] of [
    ['PUT', '/v1/defaults'],
    ['POST', '/v1/defaults/build/cancel'],
    ['PUT', '/v1/storage/retention'],
    ['POST', '/v1/storage/reclaim'],
    ['POST', '/v1/precompiled-images/prune'],
  ]) {
    assert.equal(classifyManagerRoute(method, path).kind, 'global_fanout', `${method} ${path}`);
  }

  assert.equal(classifyManagerRoute('POST', '/v1/agent-tools/install-acp').kind, 'local_only');

  // Project-bound routes
  for (const [method, path] of [
    ['GET', '/v1/projects/101'],
    ['PUT', '/v1/projects/101'],
    ['POST', '/v1/projects/101/start'],
    ['POST', '/v1/projects/101/stop'],
    ['POST', '/v1/projects/101/reset'],
    ['POST', '/v1/projects/101/delete'],
    ['POST', '/v1/projects/101/execute'],
    ['POST', '/v1/projects/101/configure'],
    ['POST', '/v1/projects/101/refresh'],
    ['POST', '/v1/projects/101/commands'],
    ['GET', '/v1/projects/101/output/' + 'a'.repeat(48)],
    ['GET', '/v1/projects/101/stats'],
    ['PUT', '/v1/projects/101/parallel'],
    ['PUT', '/v1/projects/101/tools'],
    ['GET', '/v1/projects/101/cli-config'],
    ['POST', '/v1/projects/101/build/cancel'],
  ]) {
    const res = classifyManagerRoute(method, path);
    assert.equal(res.kind, 'project_bound', `${method} ${path}`);
    assert.equal(res.repositoryId, '101');
  }

  // Assistant endpoints
  const owner = 'a'.repeat(32);
  assert.equal(classifyManagerRoute('GET', '/v1/assistant-computers').kind, 'assistant_aggregate');
  assert.equal(classifyManagerRoute('GET', '/v1/assistant-computers/settings').kind, 'assistant_aggregate');
  assert.equal(classifyManagerRoute('PUT', '/v1/assistant-computers/settings').kind, 'assistant_fanout');
  assert.equal(classifyManagerRoute('POST', '/v1/assistant-computers/reconcile').kind, 'assistant_fanout');
  for (const [method, path, expectedAction] of [
    ['PUT', `/v1/assistant-computers/${owner}`, 'acquire'],
    ['GET', `/v1/assistant-computers/${owner}`, 'inspect'],
    ['DELETE', `/v1/assistant-computers/${owner}`, 'remove'],
    ['POST', `/v1/assistant-computers/${owner}/execute`, 'execute'],
    ['POST', `/v1/assistant-computers/${owner}/output`, 'output'],
    ['POST', `/v1/assistant-computers/${owner}/renew`, 'renew'],
    ['POST', `/v1/assistant-computers/${owner}/release`, 'release'],
  ]) {
    assert.deepEqual(classifyManagerRoute(method, path), {
      kind: 'assistant_owner',
      owner,
      action: expectedAction,
    });
  }
});

test('ClusterStore assistant single-writer CAS fence, warm affinity, and safe cross-node migration lock', t => {
  let now = 1_700_000_000_000;
  const store = tempStore(t);
  const cs = new ClusterStore(store, () => now);
  cs.createRemoteNode({ id: 'node-a', name: 'Node A', actor: 'admin' });
  cs.createRemoteNode({ id: 'node-b', name: 'Node B', actor: 'admin' });
  cs.recordHeartbeat('node-a', { metrics: { memory_free_mb: 32000, busy_assistant_containers: 0 } });
  cs.recordHeartbeat('node-b', { metrics: { memory_free_mb: 8000, busy_assistant_containers: 2 } });

  const owner = '1'.repeat(32);
  const online = new Set(['node-a', 'node-b']);

  // Cold placement picks node with better headroom (node-a)
  const first = cs.selectAssistantNode(owner, online);
  assert.equal(first?.nodeId, 'node-a');
  assert.equal(first?.existing, null);

  // CAS reserve -> activate busy
  const res1 = cs.casReserveAssistantPlacement({
    owner,
    generation: 1,
    turn: 'turn-1',
    targetNodeId: 'node-a',
    leaseTtlMs: 60_000,
    now,
  });
  assert.equal(res1.action, 'acquire');
  assert.equal(res1.node_id, 'node-a');
  assert.equal(cs.casActivateAssistantPlacement({ owner, nodeId: 'node-a', epoch: res1.epoch, turn: 'turn-1', leaseTtlMs: 60_000, now }), true);

  // Concurrent second turn for the same owner is rejected as busy (single-writer / owner_busy invariant!)
  const concurrent = cs.casReserveAssistantPlacement({
    owner,
    generation: 1,
    turn: 'turn-2',
    targetNodeId: 'node-b',
    leaseTtlMs: 60_000,
    now,
  });
  assert.equal(concurrent.action, 'busy');
  assert.equal(concurrent.turn, 'turn-1');

  // Same-turn idempotent retry reuses the lease
  const retry = cs.casReserveAssistantPlacement({
    owner,
    generation: 1,
    turn: 'turn-1',
    targetNodeId: 'node-a',
    leaseTtlMs: 60_000,
    now,
  });
  assert.equal(retry.action, 'acquire');
  assert.equal(retry.reused_placement, true);

  // Renew enforces turn & node CAS
  assert.equal(cs.casRenewAssistantPlacement({ owner, nodeId: 'node-a', turn: 'wrong-turn', now }).renewed, false);
  assert.equal(cs.casRenewAssistantPlacement({ owner, nodeId: 'node-b', turn: 'turn-1', now }).renewed, false);
  assert.equal(cs.casRenewAssistantPlacement({ owner, nodeId: 'node-a', turn: 'turn-1', leaseTtlMs: 60_000, now }).renewed, true);

  // Release leaves idle placement with warm affinity window
  assert.equal(cs.casReleaseAssistantPlacement({ owner, nodeId: 'node-a', turn: 'turn-1', affinityMs: 300_000, now }), true);
  now += 30_000;

  // Even if node-b now has higher free memory, warm affinity keeps owner on node-a within affinity window
  cs.recordHeartbeat('node-a', { metrics: { memory_free_mb: 8000, busy_assistant_containers: 1 } });
  cs.recordHeartbeat('node-b', { metrics: { memory_free_mb: 32000, busy_assistant_containers: 0 } });
  const warm = cs.selectAssistantNode(owner, online);
  assert.equal(warm?.nodeId, 'node-a');
  assert.equal(warm?.existing?.node_id, 'node-a');

  // When node-a drains and leaves online set, CAS starts an exclusive migration lock before moving to node-b
  cs.startDrain('node-a', { actor: 'admin' });
  const chosenAfterDrain = cs.selectAssistantNode(owner, new Set(['node-b']));
  assert.equal(chosenAfterDrain?.nodeId, 'node-b');
  const mig = cs.casReserveAssistantPlacement({
    owner,
    generation: 1,
    turn: 'turn-3',
    targetNodeId: 'node-b',
    leaseTtlMs: 60_000,
    now,
  });
  assert.equal(mig.action, 'migrate');
  assert.equal(mig.from_node_id, 'node-a');
  assert.equal(mig.to_node_id, 'node-b');

  // While migration is in progress, another turn sees busy (cannot double-write)
  const blockedDuringMig = cs.casReserveAssistantPlacement({
    owner,
    generation: 1,
    turn: 'turn-4',
    targetNodeId: 'node-b',
    leaseTtlMs: 60_000,
    now,
  });
  assert.equal(blockedDuringMig.action, 'busy');

  // Commit migration switches placement atomically to node-b and bumps epoch; activate moves to busy
  const committedEpoch = cs.casCommitAssistantMigration({
    owner,
    epoch: mig.epoch,
    toNodeId: 'node-b',
    generation: 1,
    turn: 'turn-3',
    leaseTtlMs: 60_000,
    now,
  });
  assert.equal(committedEpoch, mig.epoch + 1);
  assert.equal(cs.casActivateAssistantPlacement({ owner, nodeId: 'node-b', epoch: committedEpoch, turn: 'turn-3', leaseTtlMs: 60_000, now }), true);
  assert.equal(cs.getAssistantPlacement(owner)?.node_id, 'node-b');
  assert.equal(cs.getAssistantPlacement(owner)?.state, 'busy');
});

test('isRepositoryNodeClaimable enforces all 5 binding states and node statuses', t => {
  const store = tempStore(t);
  const cs = new ClusterStore(store);
  store.run(
    "INSERT INTO accounts(id,name,type,credentials,created_at) VALUES('acc-1','A','bot_account','{}',?)",
    new Date().toISOString(),
  );
  store.run(
    "INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('101','o/r','10','acc-1')",
  );

  // Default unbound repo uses built-in local node (online) -> claimable
  assert.equal(isRepositoryNodeClaimable(store, '101'), true);

  cs.createRemoteNode({ id: 'node-a', name: 'Node A', actor: 'admin' });
  cs.recordHeartbeat('node-a', {});
  const started = cs.beginRepositoryRebind('101', 'node-a', { actor: 'admin' });
  // During rebinding -> NOT claimable
  assert.equal(isRepositoryNodeClaimable(store, '101'), false);

  cs.completeRepositoryRebind('101', started.rebind_epoch, 'node-a', 'admin');
  // bound + online -> claimable
  assert.equal(isRepositoryNodeClaimable(store, '101'), true);

  cs.markBindingActive('101', 'node-a');
  // active + online -> claimable
  assert.equal(isRepositoryNodeClaimable(store, '101'), true);

  cs.startDrain('node-a', { actor: 'admin' });
  // draining -> NOT claimable
  assert.equal(isRepositoryNodeClaimable(store, '101'), false);

  cs.undrainNode('node-a', { isOnline: true, actor: 'admin' });
  assert.equal(isRepositoryNodeClaimable(store, '101'), true);

  cs.markNodeOffline('node-a');
  // offline -> NOT claimable
  assert.equal(isRepositoryNodeClaimable(store, '101'), false);

  // Also test local node draining blocks unbound repos
  store.run(
    "INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('102','o/r2','10','acc-1')",
  );
  assert.equal(isRepositoryNodeClaimable(store, '102'), true);
  cs.startDrain(LOCAL_NODE_ID, { actor: 'admin' });
  assert.equal(isRepositoryNodeClaimable(store, '102'), false);
});

test('protocol compatibility check, bnode_/bnsess_ redaction, and host compute driver 501 stub', async t => {
  const ok = checkProtocolCompatibility(NODE_AGENT_PROTOCOL_VERSION, 1);
  assert.equal(ok.compatible, true);
  assert.equal(ok.negotiated_version, NODE_AGENT_PROTOCOL_VERSION);

  const invalid = checkProtocolCompatibility(0, 0);
  assert.equal(invalid.compatible, false);
  assert.equal(invalid.code, 'node_protocol_incompatible');
  assert.match(invalid.detail, /protocol/i);

  const tooNew = checkProtocolCompatibility(NODE_AGENT_PROTOCOL_VERSION + 5, NODE_AGENT_PROTOCOL_VERSION + 2);
  assert.equal(tooNew.compatible, false);
  assert.equal(tooNew.code, 'node_protocol_incompatible');
  assert.match(tooNew.detail, /Upgrade the control plane/i);

  const store = tempStore(t);
  const pairingTok = 'bnode_' + 'a'.repeat(12) + '.' + 'b'.repeat(48);
  const sessionTok = 'bnsess_' + 'c'.repeat(12) + '.' + 'd'.repeat(48);
  const redacted = publicText(`token=${pairingTok} session=${sessionTok}`, configuredRedactor(store));
  assert.ok(!redacted.includes(pairingTok), 'pairing token must be redacted');
  assert.ok(!redacted.includes(sessionTok), 'session token must be redacted');

  const hostDriver = createComputeDriver('host');
  await assert.rejects(() => hostDriver.recover(), err => err.status === 501 && err.message === 'host_driver_not_implemented');

  const cs = new ClusterStore(store);
  assert.throws(
    () => cs.createRemoteNode({ name: 'Mac Host', driver: 'host', actor: 'admin' }),
    err => err.status === 501 && err.code === 'host_driver_not_implemented',
  );
});
