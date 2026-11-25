import { type Actor, repository, superAdmin } from '../app/auth.js';
import { fail, fields, text, type Json } from '../core/security.js';
import { NODE_AGENT_PROTOCOL_VERSION, normalizeNodeLabels } from '../../runner/node-protocol.mjs';
import type { ClusterManager } from './manager.js';
import { DEFAULT_DRAIN_TIMEOUT_MS, type ComputeNodeRecord } from './storage.js';

function nodeView(cluster: ClusterManager, node: ComputeNodeRecord): Json {
  const connected = node.kind === 'local' ? node.status !== 'offline' : cluster.hub.isNodeConnected(node.id);
  const boundRepoIds = cluster.clusterStore.listRepositoriesOnNode(node.id);
  const boundProjects = boundRepoIds.map(repoId => {
    const repo = cluster.store.get('SELECT id, full_name FROM repositories WHERE id=?', repoId);
    const binding = cluster.clusterStore.getRepositoryBinding(repoId);
    return {
      repository_id: repoId,
      full_name: repo?.full_name ? String(repo.full_name) : repoId,
      state: binding.state,
      binding_epoch: binding.binding_epoch,
    };
  });
  const placements = cluster.clusterStore.listAssistantPlacements(node.id).map(p => ({
    owner: p.owner,
    state: p.state,
    generation: p.generation,
    epoch: p.epoch,
    turn: p.turn,
  }));
  const work = cluster.activeWorkOnNode(node.id);
  return {
    ...node,
    connected,
    active_tasks: work.running_tasks,
    busy_assistants: work.busy_assistants,
    drained: node.status === 'draining' && node.drained_at !== null,
    bound_projects: boundProjects,
    assistant_placements: placements,
  } as unknown as Json;
}

function buildJoinCommand(origin: string, nodeId: string, pairingToken: string | null, imageTag?: string): string | null {
  if (!pairingToken) return null;
  const tag = imageTag && imageTag.trim() ? imageTag.trim() : 'latest';
  return [
    `BOT_CENTER_URL=${origin}`,
    `BOT_NODE_PAIRING_TOKEN=${pairingToken}`,
    `BOT_IMAGE_TAG=${tag}`,
    `docker compose -f docker/compose.node.yaml -p bot-node-${nodeId} up -d`,
  ].join(' ');
}

/**
 * Super-admin & project-level HTTP APIs for distributed compute nodes and project node bindings:
 * - `GET /api/nodes`
 * - `POST /api/nodes`
 * - `PATCH /api/nodes/:id`
 * - `POST /api/nodes/:id/token`
 * - `POST /api/nodes/:id/drain`
 * - `POST /api/nodes/:id/undrain`
 * - `POST /api/nodes/:id/revoke` / `DELETE /api/nodes/:id`
 * - `GET /api/repositories/:id/node`
 * - `PUT /api/repositories/:id/node`
 */
export async function clusterApi(
  cluster: ClusterManager,
  user: Actor,
  method: string,
  url: URL,
  input: Json,
  options: { origin?: string; imageTag?: string; onRebound?: () => void } = {},
): Promise<Json | undefined> {
  const path = url.pathname;

  // Project node binding read/write
  const repoNodeMatch = /^\/api\/repositories\/([1-9]\d{0,19})\/node$/.exec(path);
  if (repoNodeMatch) {
    const repoId = repoNodeMatch[1]!;
    repository(cluster.store, user, repoId);
    if (method === 'GET') {
      const binding = cluster.clusterStore.getRepositoryBinding(repoId);
      const boundNode = cluster.clusterStore.getNode(binding.node_id);
      const isSuper = user.role === 'super_admin';
      const nodes = isSuper
        ? cluster.clusterStore
            .listNodes()
            .filter(n => n.status !== 'revoked')
            .map(n => ({
              id: n.id,
              name: n.name,
              kind: n.kind,
              driver: n.driver,
              os: n.os,
              arch: n.arch,
              labels: n.labels,
              status: n.status,
              connected: n.kind === 'local' ? n.status !== 'offline' : cluster.hub.isNodeConnected(n.id),
              metrics: n.metrics,
            }))
        : undefined;
      return {
        binding: {
          ...binding,
          node_name: boundNode?.name ?? binding.node_id,
          node_status: boundNode?.status ?? 'offline',
          node_arch: boundNode?.arch ?? 'unknown',
          node_os: boundNode?.os ?? 'linux',
          node_labels: boundNode?.labels ?? {},
        },
        can_rebind: isSuper,
        ...(nodes ? { nodes } : {}),
      } as unknown as Json;
    }
    if (method === 'PUT') {
      superAdmin(user);
      fields(input, ['node_id', 'label_selector', 'force']);
      const nodeId = text(input.node_id, 64);
      const force = input.force === true;
      let labelSelector: Record<string, string> = {};
      if (input.label_selector !== undefined) {
        try { labelSelector = normalizeNodeLabels(input.label_selector); } catch { fail(400, 'invalid_node_labels'); }
      }
      const rebound = await cluster.rebindRepository(repoId, nodeId, { labelSelector, force, actor: user.id });
      options.onRebound?.();
      const boundNode = cluster.clusterStore.getNode(rebound.binding.node_id);
      return {
        binding: {
          ...rebound.binding,
          node_name: boundNode?.name ?? rebound.binding.node_id,
          node_status: boundNode?.status ?? 'offline',
          node_arch: boundNode?.arch ?? 'unknown',
          node_os: boundNode?.os ?? 'linux',
          node_labels: boundNode?.labels ?? {},
        },
        previous_node_id: rebound.previous_node_id,
        old_node_cleaned: rebound.old_node_cleaned,
      } as unknown as Json;
    }
    return fail(405, 'method_not_allowed');
  }

  if (path !== '/api/nodes' && !path.startsWith('/api/nodes/')) return undefined;
  superAdmin(user);

  if (path === '/api/nodes') {
    if (method === 'GET') {
      cluster.hub.sweepStaleNodes();
      const includeRevoked = url.searchParams.get('include_revoked') === '1';
      const nodes = cluster.clusterStore
        .listNodes()
        .filter(n => includeRevoked || n.status !== 'revoked')
        .map(n => nodeView(cluster, n));
      return {
        protocol_version: NODE_AGENT_PROTOCOL_VERSION,
        nodes,
      };
    }
    if (method === 'POST') {
      fields(input, ['id', 'name', 'driver', 'labels', 'public_key', 'direct_url', 'ttl_seconds', 'ttl_minutes']);
      const name = text(input.name, 100);
      let ttlMs: number | undefined;
      if (input.ttl_seconds !== undefined && input.ttl_minutes !== undefined) fail(400, 'invalid_pairing_ttl');
      if (input.ttl_seconds !== undefined) {
        const s = Number(input.ttl_seconds);
        if (!Number.isFinite(s)) fail(400, 'invalid_pairing_ttl');
        ttlMs = s * 1000;
      } else if (input.ttl_minutes !== undefined) {
        const m = Number(input.ttl_minutes);
        if (!Number.isFinite(m)) fail(400, 'invalid_pairing_ttl');
        ttlMs = m * 60_000;
      }
      const created = cluster.clusterStore.createRemoteNode({
        id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
        name,
        driver: typeof input.driver === 'string' ? input.driver : 'docker',
        labels: input.labels as Record<string, string> | undefined,
        publicKey: typeof input.public_key === 'string' ? input.public_key : undefined,
        directUrl: typeof input.direct_url === 'string' ? input.direct_url : undefined,
        ttlMs,
        actor: user.id,
      });
      const origin = options.origin || 'https://<your-control-plane>';
      return {
        node: nodeView(cluster, created.node),
        pairing_token: created.pairing_token,
        pairing_expires_at: created.pairing_expires_at,
        join_command: buildJoinCommand(origin, created.node.id, created.pairing_token, options.imageTag),
      };
    }
    return fail(405, 'method_not_allowed');
  }

  const nodeMatch = /^\/api\/nodes\/([a-z0-9][a-z0-9._-]{0,63})(?:\/(token|drain|undrain|revoke))?$/.exec(path);
  if (!nodeMatch) return fail(404, 'not_found');
  const nodeId = nodeMatch[1]!;
  const action = nodeMatch[2];

  if (!action) {
    if (method === 'GET') {
      const node = cluster.clusterStore.getNode(nodeId);
      if (!node) fail(404, 'node_not_found');
      return { node: nodeView(cluster, node!) };
    }
    if (method === 'PATCH') {
      fields(input, ['name', 'labels', 'direct_url']);
      const updated = cluster.clusterStore.updateNode(nodeId, {
        name: typeof input.name === 'string' ? input.name : undefined,
        labels: input.labels as Record<string, string> | undefined,
        directUrl: input.direct_url === null ? null : typeof input.direct_url === 'string' ? input.direct_url : undefined,
        actor: user.id,
      });
      return { node: nodeView(cluster, updated) };
    }
    if (method === 'DELETE') {
      fields(input, ['confirm', 'force']);
      if (input.confirm !== true) fail(400, 'confirmation_required');
      const revoked = await cluster.revokeNode(nodeId, { force: input.force === true, actor: user.id });
      return { node: nodeView(cluster, revoked), revoked: true };
    }
    return fail(405, 'method_not_allowed');
  }

  if (method !== 'POST') return fail(405, 'method_not_allowed');

  if (action === 'token') {
    fields(input, ['ttl_seconds', 'ttl_minutes']);
    let ttlMs: number | undefined;
    if (input.ttl_seconds !== undefined && input.ttl_minutes !== undefined) fail(400, 'invalid_pairing_ttl');
    if (input.ttl_seconds !== undefined) {
      const s = Number(input.ttl_seconds);
      if (!Number.isFinite(s)) fail(400, 'invalid_pairing_ttl');
      ttlMs = s * 1000;
    } else if (input.ttl_minutes !== undefined) {
      const m = Number(input.ttl_minutes);
      if (!Number.isFinite(m)) fail(400, 'invalid_pairing_ttl');
      ttlMs = m * 60_000;
    }
    const reissued = cluster.clusterStore.reissuePairingToken(nodeId, { ttlMs, actor: user.id });
    const origin = options.origin || 'https://<your-control-plane>';
    return {
      node: nodeView(cluster, reissued.node),
      pairing_token: reissued.pairing_token,
      pairing_expires_at: reissued.pairing_expires_at,
      join_command: buildJoinCommand(origin, reissued.node.id, reissued.pairing_token, options.imageTag),
    };
  }

  if (action === 'drain') {
    fields(input, ['timeout_seconds', 'timeout_ms']);
    let timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS;
    if (input.timeout_seconds !== undefined) {
      const s = Number(input.timeout_seconds);
      if (!Number.isSafeInteger(s) || s < 1) fail(400, 'invalid_drain_timeout');
      timeoutMs = s * 1000;
    } else if (input.timeout_ms !== undefined) {
      const ms = Number(input.timeout_ms);
      if (!Number.isSafeInteger(ms) || ms < 1000) fail(400, 'invalid_drain_timeout');
      timeoutMs = ms;
    }
    const result = await cluster.drainNode(nodeId, { timeoutMs, actor: user.id });
    return { node: nodeView(cluster, result.node), active_work: result.active_work };
  }

  if (action === 'undrain') {
    fields(input, []);
    const resumed = await cluster.undrainNode(nodeId, user.id);
    options.onRebound?.();
    return { node: nodeView(cluster, resumed) };
  }

  if (action === 'revoke') {
    fields(input, ['confirm', 'force']);
    if (input.confirm !== true) fail(400, 'confirmation_required');
    const revoked = await cluster.revokeNode(nodeId, { force: input.force === true, actor: user.id });
    return { node: nodeView(cluster, revoked), revoked: true };
  }

  return fail(404, 'not_found');
}
