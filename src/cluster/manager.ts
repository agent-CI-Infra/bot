import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Store } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import type { SyncTokenService } from '../sync/storage.js';
import { fail, HttpError, randomId, type Json } from '../core/security.js';
import { computerResultOwner } from '../../runner/result-owner.mjs';
import { FileTree } from '../../manager/file-tree.mjs';
import { ClusterHub } from './hub.js';
import {
  ClusterStore,
  DEFAULT_ASSISTANT_AFFINITY_MS,
  DEFAULT_ASSISTANT_LEASE_TTL_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  getOperationNodeBinding,
  LOCAL_NODE_ID,
  type ComputeNodeRecord,
  type RepositoryNodeBinding,
} from './storage.js';

export type ManagerRouteKind =
  | 'notes_authority'
  | 'notes_reclaim'
  | 'project_bound'
  | 'global_aggregate'
  | 'global_fanout'
  | 'local_only'
  | 'assistant_aggregate'
  | 'assistant_fanout'
  | 'assistant_owner'
  | 'unknown';

export interface ClassifiedManagerRoute {
  kind: ManagerRouteKind;
  repositoryId?: string;
  action?: string;
  owner?: string;
}

/**
 * Pure routing table for every `Manager.call(method, path)` endpoint.
 * Control plane retains authoritative ownership of `file-tree` / `notes` and aggregates global endpoints;
 * per-project lifecycle/execute/output route to the bound node; assistant endpoints route via CAS placement.
 */
export function classifyManagerRoute(method: string, rawPath: string): ClassifiedManagerRoute {
  const m = String(method || 'GET').toUpperCase();
  const pathname = new URL(rawPath, 'http://manager').pathname;

  if (pathname === '/v1/projects' && m === 'GET') return { kind: 'global_aggregate', action: 'projects_list' };
  if (pathname === '/v1/notes-volumes' && m === 'GET') return { kind: 'global_aggregate', action: 'notes_volumes' };
  if (pathname === '/v1/defaults') {
    return m === 'GET' ? { kind: 'global_aggregate', action: 'defaults' } : { kind: 'global_fanout', action: 'defaults' };
  }
  if (pathname === '/v1/defaults/build/cancel' && m === 'POST') return { kind: 'global_fanout', action: 'defaults_build_cancel' };
  if (pathname === '/v1/storage' && m === 'GET') return { kind: 'global_aggregate', action: 'storage' };
  if (pathname === '/v1/storage/retention' && m === 'PUT') return { kind: 'global_fanout', action: 'storage_retention' };
  if (pathname === '/v1/storage/reclaim' && m === 'POST') return { kind: 'global_fanout', action: 'storage_reclaim' };
  if (pathname === '/v1/precompiled-images' && m === 'GET') return { kind: 'global_aggregate', action: 'precompiled_images' };
  if (pathname === '/v1/precompiled-images/prune' && m === 'POST') return { kind: 'global_fanout', action: 'precompiled_images_prune' };
  if (pathname === '/v1/project-tools/mounts' && m === 'GET') return { kind: 'global_aggregate', action: 'project_tools_mounts' };
  if (pathname === '/v1/agent-tools/install-acp' && m === 'POST') return { kind: 'local_only', action: 'install_acp' };

  if (pathname === '/v1/assistant-computers' && m === 'GET') return { kind: 'assistant_aggregate', action: 'list' };
  if (pathname === '/v1/assistant-computers/settings') {
    return m === 'GET' ? { kind: 'assistant_aggregate', action: 'settings' } : { kind: 'assistant_fanout', action: 'settings' };
  }
  if (pathname === '/v1/assistant-computers/reconcile' && m === 'POST') return { kind: 'assistant_fanout', action: 'reconcile' };
  const asstOwner = /^\/v1\/assistant-computers\/([a-f0-9]{32})(?:\/(execute|output|renew|release))?$/.exec(pathname);
  if (asstOwner) {
    return { kind: 'assistant_owner', owner: asstOwner[1]!, action: asstOwner[2] || (m === 'PUT' ? 'acquire' : m === 'DELETE' ? 'remove' : 'inspect') };
  }

  const notesReclaim = /^\/v1\/projects\/([1-9]\d{0,19})\/notes\/reclaim$/.exec(pathname);
  if (notesReclaim && m === 'POST') {
    return { kind: 'notes_reclaim', repositoryId: notesReclaim[1]!, action: 'notes_reclaim' };
  }

  const notesAuthority = /^\/v1\/projects\/([1-9]\d{0,19})\/(file-tree|files|notes)(?:\/|$)/.exec(pathname);
  if (notesAuthority) {
    return { kind: 'notes_authority', repositoryId: notesAuthority[1]!, action: notesAuthority[2]! };
  }

  const projectMatch = /^\/v1\/projects\/([1-9]\d{0,19})(?:\/([a-z-]+))?(?:\/|$)/.exec(pathname);
  if (projectMatch) {
    return { kind: 'project_bound', repositoryId: projectMatch[1]!, action: projectMatch[2] || m.toLowerCase() };
  }

  return { kind: 'unknown' };
}

export interface ClusterManagerOptions {
  store: Store;
  localManager?: Manager;
  clusterStore?: ClusterStore;
  hub?: ClusterHub;
  syncTokens?: SyncTokenService;
  notesRoot?: string;
  imageTag?: string;
  assistantLeaseTtlMs?: number;
  assistantAffinityMs?: number;
  clock?: () => number;
}

/**
 * Central cluster router and aggregator implementing `Manager`.
 * - Single-host zero-config: automatically registers built-in `local` node and delegates cleanly to `localManager`.
 * - Multi-node Linux Docker: routes per-project calls by `repository_node_bindings`, keeps notes/file-tree authoritative
 *   on control plane, schedules assistant computers with persistent single-writer CAS placements, and orchestrates
 *   graceful drain and safe rebind without losing data or mis-reclaiming volumes.
 */
export class ClusterManager implements Manager {
  readonly store: Store;
  readonly clusterStore: ClusterStore;
  readonly hub: ClusterHub;
  readonly localManager?: Manager;
  private syncTokens?: SyncTokenService;
  private readonly centerNotesRoot: string | null;
  private readonly assistantLeaseTtlMs: number;
  private readonly assistantAffinityMs: number;
  private readonly assistantProjectTools = new Map<string, { nodeId: string; repoIds: Set<string> }>();
  private drainTimer?: ReturnType<typeof setInterval>;
  private reconcilingDrains: Promise<void> | null = null;
  private closed = false;

  constructor(options: ClusterManagerOptions) {
    this.store = options.store;
    this.localManager = options.localManager;
    this.syncTokens = options.syncTokens;
    this.assistantLeaseTtlMs = options.assistantLeaseTtlMs ?? DEFAULT_ASSISTANT_LEASE_TTL_MS;
    this.assistantAffinityMs = options.assistantAffinityMs ?? DEFAULT_ASSISTANT_AFFINITY_MS;
    this.clusterStore = options.clusterStore ?? new ClusterStore(options.store, options.clock);
    this.clusterStore.ensureLocalNode({ online: Boolean(options.localManager) });
    this.hub =
      options.hub ??
      new ClusterHub({
        clusterStore: this.clusterStore,
        syncTokens: options.syncTokens,
        imageTag: options.imageTag,
        isProjectToolAuthorizedOnNode: (nodeId, repoId) => {
          for (const grant of this.assistantProjectTools.values()) {
            if (grant.nodeId === nodeId && grant.repoIds.has(repoId)) return true;
          }
          return false;
        },
      });
    this.centerNotesRoot =
      options.notesRoot ??
      (options.store.path === ':memory:'
        ? join(options.store.trajectories.root, '.project-notes')
        : join(dirname(options.store.path), 'project-notes'));
  }

  getSyncTokens(): SyncTokenService | undefined {
    return this.syncTokens;
  }

  setSyncTokens(tokens: SyncTokenService): void {
    this.syncTokens = tokens;
    this.hub.setSyncTokens(tokens);
  }

  start(): void {
    this.hub.start();
    if (!this.drainTimer && !this.closed) {
      this.drainTimer = setInterval(() => {
        void this.reconcileDrains().catch(err => console.error('[cluster] drain reconciliation failed:', err));
      }, 5_000);
      this.drainTimer.unref?.();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.drainTimer);
    this.drainTimer = undefined;
    await this.hub.close();
  }

  private hasLocalManager(): boolean {
    return Boolean(this.localManager);
  }

  private onlineRemoteNodes(): ComputeNodeRecord[] {
    return this.clusterStore
      .listNodes()
      .filter(n => n.kind === 'remote' && ['online', 'draining'].includes(n.status) && this.hub.isNodeConnected(n.id));
  }

  private async callSpecificNode(
    nodeId: string,
    method: string,
    path: string,
    input?: Json,
    timeoutMs = 90_000,
    bindingEpoch?: number,
  ): Promise<any> {
    if (nodeId === LOCAL_NODE_ID) {
      if (!this.localManager) return fail(503, 'manager_not_configured');
      return this.localManager.call(method, path, input, timeoutMs);
    }
    return this.hub.callNode(nodeId, method, path, input, { timeoutMs, bindingEpoch });
  }

  async call(method: string, path: string, input?: Json, timeoutMs = 90_000): Promise<any> {
    const route = classifyManagerRoute(method, path);
    switch (route.kind) {
      case 'notes_authority':
        return this.handleNotesAuthority(method, path, route.repositoryId!, input, timeoutMs);
      case 'notes_reclaim':
        return this.handleNotesReclaim(route.repositoryId!, path, input, timeoutMs);
      case 'project_bound':
        return this.handleProjectBound(method, path, route.repositoryId!, route.action!, input, timeoutMs);
      case 'global_aggregate':
        return this.handleGlobalAggregate(route.action!, path, timeoutMs);
      case 'global_fanout':
        return this.handleGlobalFanout(method, path, route.action!, input, timeoutMs);
      case 'local_only':
        if (!this.localManager) return fail(503, 'manager_not_configured');
        return this.localManager.call(method, path, input, timeoutMs);
      case 'assistant_aggregate':
        return this.handleAssistantAggregate(route.action!, path, timeoutMs);
      case 'assistant_fanout':
        return this.handleAssistantFanout(method, path, route.action!, input, timeoutMs);
      case 'assistant_owner':
        return this.handleAssistantOwner(method, path, route.owner!, route.action!, input, timeoutMs);
      default:
        if (this.localManager) return this.localManager.call(method, path, input, timeoutMs);
        return fail(404, 'not_found');
    }
  }

  // ---- 1. Control-plane authoritative notes / file-tree (NEVER routes writes to remote nodes!) ----

  private async handleNotesAuthority(
    method: string,
    rawPath: string,
    repoId: string,
    input: Json | undefined,
    timeoutMs: number,
  ): Promise<any> {
    if (this.localManager) {
      return this.localManager.call(method, rawPath, input, timeoutMs);
    }
    // Control-plane local FileTree fallback when running without a local Docker manager container.
    if (!this.centerNotesRoot) return fail(503, 'notes_volume_unavailable');
    const url = new URL(rawPath, 'http://manager');
    const pathname = url.pathname;
    const repoDir = join(this.centerNotesRoot, repoId);

    const pruneMatch = /^\/v1\/projects\/([1-9]\d{0,19})\/file-tree\/prune$/.exec(pathname);
    if (pruneMatch && method === 'POST') {
      const info = await lstat(repoDir).catch(() => null);
      if (!info?.isDirectory()) return { pruned_versions: 0, removed_blobs: 0, freed_bytes: 0, files_trimmed: 0 };
      const body = (input ?? {}) as Record<string, any>;
      return new FileTree(repoDir).pruneHistory({
        keepVersions: body.keep_versions === undefined ? 50 : body.keep_versions,
        keepDays: body.keep_days === undefined ? 30 : body.keep_days,
        now: body.now === undefined ? Date.now() : Number(body.now),
      });
    }

    const ftMatch = /^\/v1\/projects\/([1-9]\d{0,19})\/file-tree(?:\/([^/]+))?(?:\/(versions|restore|move))?$/.exec(pathname);
    if (ftMatch) {
      let id: string | undefined;
      if (ftMatch[2] !== undefined) {
        try { id = decodeURIComponent(ftMatch[2]); } catch { fail(400, 'invalid_note_id'); }
      }
      const action = ftMatch[3];
      const directories = id === 'directories';
      const body = (input ?? {}) as Record<string, any>;
      const actor = typeof body.actor === 'string' ? body.actor : 'console';
      if (method === 'GET' && url.searchParams.get('require_existing') === '1') {
        const info = await lstat(repoDir).catch(() => null);
        if (!info || info.isSymbolicLink() || !info.isDirectory()) fail(503, 'notes_volume_unavailable');
      } else {
        await mkdir(repoDir, { recursive: true, mode: 0o700 });
      }
      const tree = new FileTree(repoDir);
      try {
        if (directories && method === 'POST') return await tree.createDirectory(body.path);
        if (directories && method === 'DELETE') return await tree.deleteDirectory(body.path);
        if (id === undefined && method === 'GET') {
          return await tree.list({
            directory: url.searchParams.get('directory') ?? '',
            query: url.searchParams.get('query') ?? '',
            includeDeleted: url.searchParams.get('include_deleted') === '1',
            deletedOnly: url.searchParams.get('deleted_only') === '1',
            recursive: url.searchParams.get('recursive') === '1',
            preview: url.searchParams.get('preview') === '1',
          });
        }
        if (id === undefined && method === 'POST') {
          return await tree.create(body.path, body.content, actor, { createParents: body.create_parents === true });
        }
        if (id !== undefined && method === 'GET' && action === 'versions') return await tree.versions(id);
        if (id !== undefined && method === 'GET' && !action) {
          return await tree.read(id, url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined);
        }
        if (id !== undefined && method === 'PUT' && !action) return await tree.save(id, body.content, body.expected_revision, actor);
        if (id !== undefined && method === 'DELETE' && !action) return await tree.delete(id, body.expected_revision, actor);
        if (id !== undefined && method === 'POST' && action === 'restore') return await tree.restore(id, body.revision, body.expected_revision, actor);
        if (id !== undefined && method === 'POST' && action === 'move') return await tree.move(id, body.path, body.expected_revision, actor);
        return fail(405, 'method_not_allowed');
      } catch (err: any) {
        if (err instanceof HttpError) throw err;
        if (err?.code === 'ENOENT') fail(404, 'note_not_found');
        if (err?.message === 'note_revision_changed') fail(409, 'note_revision_changed');
        if (err?.message === 'unsupported_note_format') fail(415, 'unsupported_note_format');
        if (/^(?:invalid_note|notes_|note_|directory_)/.test(String(err?.message || ''))) fail(err.status ?? 400, err.message);
        throw err;
      }
    }
    return fail(503, 'manager_not_configured');
  }

  // ---- 2. Notes volume reclaim targeted strictly to the node(s) holding the volume ----

  private async handleNotesReclaim(repoId: string, rawPath: string, input: Json | undefined, timeoutMs: number): Promise<any> {
    const url = new URL(rawPath, 'http://manager');
    const explicitNode =
      (typeof input?.node_id === 'string' && input.node_id.trim()) ||
      url.searchParams.get('node_id') ||
      null;

    const targetNodes = new Set<string>();
    if (explicitNode) {
      targetNodes.add(explicitNode);
    } else {
      // Find EVERY node actually holding a notes volume for this repository (never blindly use the newly bound node!).
      for (const vol of this.clusterStore.listNodeVolumes({ repositoryId: repoId, volumeKind: 'notes' })) {
        targetNodes.add(vol.node_id);
      }
      const bindingRow = this.store.get('SELECT node_id, previous_node_id, notes_node_id FROM repository_node_bindings WHERE repository_id=?', repoId);
      if (bindingRow?.previous_node_id) targetNodes.add(String(bindingRow.previous_node_id));
      if (bindingRow?.notes_node_id) targetNodes.add(String(bindingRow.notes_node_id));
      // Probe live volume listings across connected nodes to catch any untracked volume.
      const live = await this.collectLiveNotesVolumes(10_000).catch(() => ({ volumes: [], unreachableNodes: [] }));
      for (const v of live.volumes) {
        if (String(v.repository_id) === repoId && v.node_id) targetNodes.add(String(v.node_id));
      }
      // Single-host fallback when no node volume record exists at all.
      if (targetNodes.size === 0 && this.hasLocalManager()) {
        targetNodes.add(LOCAL_NODE_ID);
      }
    }

    let reclaimed = false;
    const errors: Array<{ node_id: string; error: unknown }> = [];
    for (const nodeId of targetNodes) {
      try {
        const res = await this.callSpecificNode(nodeId, 'POST', `/v1/projects/${repoId}/notes/reclaim`, {}, timeoutMs);
        if (res?.reclaimed) reclaimed = true;
        this.clusterStore.clearNodeVolume(repoId, nodeId, 'notes');
      } catch (err) {
        errors.push({ node_id: nodeId, error: err });
      }
    }
    if (errors.length) {
      const first = errors[0]!.error;
      if (first instanceof HttpError) throw first;
      fail(503, 'manager_unavailable');
    }
    return { repository_id: repoId, reclaimed, nodes: [...targetNodes] };
  }

  private async collectLiveNotesVolumes(timeoutMs = 15_000): Promise<{
    volumes: Array<{ name: string; repository_id: string; created_at: string | null; node_id: string }>;
    unreachableNodes: string[];
  }> {
    const results: Array<{ name: string; repository_id: string; created_at: string | null; node_id: string }> = [];
    const unreachableNodes: string[] = [];
    const seen = new Set<string>();

    const targets: string[] = [];
    if (this.hasLocalManager()) targets.push(LOCAL_NODE_ID);
    for (const node of this.clusterStore.listNodes()) {
      if (node.kind === 'remote' && node.status !== 'revoked' && node.status !== 'pending') {
        targets.push(node.id);
      }
    }

    await Promise.all(
      targets.map(async nodeId => {
        if (nodeId !== LOCAL_NODE_ID && !this.hub.isNodeConnected(nodeId)) {
          unreachableNodes.push(nodeId);
          return;
        }
        try {
          const raw = await this.callSpecificNode(nodeId, 'GET', '/v1/notes-volumes', undefined, timeoutMs);
          const list = Array.isArray(raw) ? raw : Array.isArray(raw?.volumes) ? raw.volumes : null;
          if (!list) {
            unreachableNodes.push(nodeId);
            return;
          }
          const activeReposOnNode = new Set<string>();
          for (const item of list) {
            const repoId = String(item.repository_id || /-(\d+)-notes$/.exec(String(item.name || ''))?.[1] || '');
            const name = String(item.name || '');
            const createdAt = item.created_at ? String(item.created_at) : null;
            const key = `${nodeId}:${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({ name, repository_id: repoId, created_at: createdAt, node_id: nodeId });
            if (repoId) {
              activeReposOnNode.add(repoId);
              this.clusterStore.recordNodeVolume(repoId, nodeId, 'notes', name, createdAt);
            }
          }
          // Any non-pending tracked volume on this reachable node that is no longer returned has been cleaned up.
          for (const tracked of this.clusterStore.listNodeVolumes({ nodeId, volumeKind: 'notes' })) {
            if (!activeReposOnNode.has(tracked.repository_id) && !tracked.reclaim_pending) {
              this.clusterStore.clearNodeVolume(tracked.repository_id, nodeId, 'notes');
            }
          }
        } catch {
          unreachableNodes.push(nodeId);
        }
      }),
    );

    // Include tracked pending-reclaim volumes on unreachable nodes so orphan accounting NEVER drops them silently!
    for (const nodeId of unreachableNodes) {
      for (const tracked of this.clusterStore.listNodeVolumes({ nodeId, volumeKind: 'notes', reclaimPendingOnly: true })) {
        const key = `${nodeId}:${tracked.volume_name}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            name: tracked.volume_name,
            repository_id: tracked.repository_id,
            created_at: tracked.created_at,
            node_id: nodeId,
          });
        }
      }
    }

    if (targets.length > 0 && unreachableNodes.length === targets.length) {
      fail(503, 'manager_notes_volumes_unavailable');
    }
    return { volumes: results, unreachableNodes };
  }

  // ---- 3. Per-repository routed calls (bound node + binding_epoch fence) ----

  private async handleProjectBound(
    method: string,
    path: string,
    repoId: string,
    action: string,
    input: Json | undefined,
    timeoutMs: number,
  ): Promise<any> {
    const binding = this.clusterStore.getRepositoryBinding(repoId);
    const targetNodeId =
      typeof input?.node_id === 'string' && input.node_id && ['stop', 'delete'].includes(action)
        ? String(input.node_id)
        : binding.node_id;
    const node = this.clusterStore.getNode(targetNodeId);

    // Enforce binding_epoch fence when caller supplies one OR when operation_id was recorded in environment_operation_nodes.
    if (
      input &&
      typeof input === 'object' &&
      input.binding_epoch !== undefined &&
      Number(input.binding_epoch) !== binding.binding_epoch
    ) {
      fail(409, 'binding_epoch_mismatch');
    }
    if (
      input &&
      typeof input === 'object' &&
      typeof input.operation_id === 'string' &&
      input.operation_id &&
      !['stop', 'delete'].includes(action)
    ) {
      const opBinding = getOperationNodeBinding(this.store, input.operation_id);
      if (opBinding && (opBinding.node_id !== binding.node_id || opBinding.binding_epoch !== binding.binding_epoch)) {
        fail(409, 'binding_epoch_mismatch');
      }
    }

    // Refuse starting/configuring/refreshing/registering on a draining, rebinding, offline, or revoked node!
    const mutatingStartLike =
      (method === 'PUT' && action === 'put') ||
      (method === 'POST' && ['start', 'reset', 'configure', 'refresh'].includes(action));
    if (mutatingStartLike) {
      if (binding.state === 'rebinding') fail(409, 'repository_rebinding');
      if (binding.state === 'draining' || node?.status === 'draining') fail(409, 'node_draining');
      if (node?.status === 'revoked') fail(409, 'node_revoked');
      if (binding.state === 'offline' || node?.status === 'offline') fail(503, 'node_offline');
    }
    if (method === 'POST' && action === 'execute' && binding.state === 'rebinding') {
      fail(409, 'repository_rebinding');
    }

    // Strip cluster-only metadata keys before forwarding to legacy local `manager/server.mjs` (which strictly checks keys!).
    let forwardInput = input;
    if (targetNodeId === LOCAL_NODE_ID && input && typeof input === 'object' && !Array.isArray(input)) {
      if ('node_id' in input || 'binding_epoch' in input) {
        const { node_id: _n, binding_epoch: _e, ...rest } = input as Record<string, any>;
        forwardInput = rest;
      }
    }

    const result = await this.callSpecificNode(targetNodeId, method, path, forwardInput, timeoutMs, binding.binding_epoch);

    if (result && typeof result === 'object' && !Array.isArray(result) && 'repository_id' in result) {
      if (result.state === 'ready' || result.state === 'busy') {
        this.clusterStore.markBindingActive(repoId, targetNodeId);
        this.clusterStore.recordNodeVolume(repoId, targetNodeId, 'workspace', `dbot-${targetNodeId}-${repoId}-ws`);
        if (targetNodeId === LOCAL_NODE_ID) {
          this.clusterStore.recordNodeVolume(repoId, targetNodeId, 'notes', `dbot-${targetNodeId}-${repoId}-notes`);
        }
      }
      return {
        ...result,
        node_id: targetNodeId,
        binding_state: this.clusterStore.getRepositoryBinding(repoId).state,
        binding_epoch: binding.binding_epoch,
      };
    }
    return result;
  }

  // ---- 4. Global aggregated & fan-out endpoints ----

  private async handleGlobalAggregate(action: string, path: string, timeoutMs: number): Promise<any> {
    if (action === 'notes_volumes') {
      const { volumes } = await this.collectLiveNotesVolumes(timeoutMs);
      return volumes;
    }

    if (action === 'projects_list') {
      const all: any[] = [];
      const nodes: string[] = [...(this.hasLocalManager() ? [LOCAL_NODE_ID] : []), ...this.onlineRemoteNodes().map(n => n.id)];
      if (!nodes.length) fail(503, 'manager_unavailable');
      let succeeded = 0;
      await Promise.all(
        nodes.map(async nodeId => {
          try {
            const list = await this.callSpecificNode(nodeId, 'GET', '/v1/projects', undefined, Math.min(timeoutMs, 15_000));
            if (Array.isArray(list)) {
              succeeded++;
              for (const row of list) all.push({ ...row, node_id: nodeId });
            }
          } catch { /* partial node outage still returns healthy nodes */ }
        }),
      );
      if (!succeeded) fail(503, 'manager_unavailable');
      return all.sort((a, b) => String(a.repository_id).localeCompare(String(b.repository_id)));
    }

    if (action === 'defaults') {
      const primary = this.hasLocalManager()
        ? await this.localManager!.call('GET', '/v1/defaults', undefined, timeoutMs)
        : null;
      const remotes = this.onlineRemoteNodes();
      if (!primary && !remotes.length) fail(503, 'manager_unavailable');

      const remoteViews = await Promise.all(
        remotes.map(async n => {
          try {
            const view = await this.hub.callNode(n.id, 'GET', '/v1/defaults', undefined, { timeoutMs: Math.min(timeoutMs, 15_000) });
            return { node_id: n.id, view };
          } catch {
            return null;
          }
        }),
      );
      const validRemotes = remoteViews.filter((x): x is { node_id: string; view: any } => Boolean(x?.view));
      const base = primary ?? validRemotes[0]?.view;
      if (!base) fail(503, 'manager_unavailable');
      if (!validRemotes.length) return base;

      // Aggregate allocated computers/cpus/memory across local + online remote nodes.
      const allViews = [...(primary ? [primary] : []), ...validRemotes.map(r => r.view)];
      const allocated = {
        computers: allViews.reduce((s, v) => s + (Number(v?.allocated?.computers) || 0), 0),
        cpus: Math.round(allViews.reduce((s, v) => s + (Number(v?.allocated?.cpus) || 0), 0) * 100) / 100,
        memory_mb: allViews.reduce((s, v) => s + (Number(v?.allocated?.memory_mb) || 0), 0),
      };
      return {
        ...base,
        allocated,
        cluster_nodes: [
          ...(primary ? [{ node_id: LOCAL_NODE_ID, host: primary.host ?? null, allocated: primary.allocated ?? null }] : []),
          ...validRemotes.map(r => ({ node_id: r.node_id, host: r.view.host ?? null, allocated: r.view.allocated ?? null })),
        ],
      };
    }

    if (action === 'storage') {
      const primary = this.hasLocalManager()
        ? await this.localManager!.call('GET', '/v1/storage', undefined, timeoutMs)
        : null;
      const remotes = this.onlineRemoteNodes();
      if (!primary && !remotes.length) fail(503, 'manager_unavailable');
      if (!remotes.length) return primary;

      const remoteReports = (
        await Promise.all(
          remotes.map(async n => {
            try {
              const data = await this.hub.callNode(n.id, 'GET', '/v1/storage', undefined, { timeoutMs: Math.min(timeoutMs, 20_000) });
              return data ? { node_id: n.id, data } : null;
            } catch {
              return null;
            }
          }),
        )
      ).filter((x): x is { node_id: string; data: any } => Boolean(x));

      const base = primary ?? remoteReports[0]?.data;
      if (!base) fail(503, 'manager_unavailable');
      if (!primary && remoteReports.length === 1) return base;

      // Merge project computers and usage rows from remote nodes into the center aggregate view.
      const computersByRepo = new Map<string, any>();
      for (const c of Array.isArray(base.computers) ? base.computers : []) {
        computersByRepo.set(String(c.repository_id), { ...c, node_id: primary ? LOCAL_NODE_ID : remoteReports[0]!.node_id });
      }
      const usage = [...(Array.isArray(base.usage) ? base.usage : [])];
      const workspaceProjects = new Set<string>(Array.isArray(base.workspace_projects) ? base.workspace_projects.map(String) : []);
      let precompiledCount = Number(base.precompiled_images?.count || 0);
      let precompiledBytes = Number(base.precompiled_images?.total_bytes || 0);
      let queueLength = Number(base.precompiled_images?.queue_length || 0);

      for (const report of primary ? remoteReports : remoteReports.slice(1)) {
        for (const c of Array.isArray(report.data.computers) ? report.data.computers : []) {
          const repoId = String(c.repository_id);
          const binding = this.clusterStore.getRepositoryBinding(repoId);
          if (binding.node_id === report.node_id || !computersByRepo.has(repoId)) {
            computersByRepo.set(repoId, { ...c, node_id: report.node_id });
          }
        }
        if (Array.isArray(report.data.usage)) usage.push(...report.data.usage);
        if (Array.isArray(report.data.workspace_projects)) {
          for (const repoId of report.data.workspace_projects) workspaceProjects.add(String(repoId));
        }
        precompiledCount += Number(report.data.precompiled_images?.count || 0);
        precompiledBytes += Number(report.data.precompiled_images?.total_bytes || 0);
        queueLength += Number(report.data.precompiled_images?.queue_length || 0);
      }

      return {
        ...base,
        computers: [...computersByRepo.values()],
        usage,
        workspace_projects: [...workspaceProjects],
        precompiled_images: {
          ...(base.precompiled_images || {}),
          count: precompiledCount,
          total_bytes: precompiledBytes,
          queue_length: queueLength,
        },
        nodes: [
          ...(primary ? [{ node_id: LOCAL_NODE_ID, disk: primary.disk ?? null, docker: primary.docker ?? null }] : []),
          ...remoteReports.map(r => ({ node_id: r.node_id, disk: r.data.disk ?? null, docker: r.data.docker ?? null })),
        ],
      };
    }

    if (action === 'precompiled_images') {
      const targets: string[] = [...(this.hasLocalManager() ? [LOCAL_NODE_ID] : []), ...this.onlineRemoteNodes().map(n => n.id)];
      if (!targets.length) return { queue_length: 0, active_build: null, images: [] };
      const images: any[] = [];
      let queueLength = 0;
      let activeBuild: any = null;
      await Promise.all(
        targets.map(async nodeId => {
          try {
            const res = await this.callSpecificNode(nodeId, 'GET', '/v1/precompiled-images', undefined, Math.min(timeoutMs, 15_000));
            queueLength += Number(res?.queue_length || 0);
            if (!activeBuild && res?.active_build) activeBuild = { ...res.active_build, node_id: nodeId };
            for (const img of Array.isArray(res?.images) ? res.images : []) {
              images.push({ ...img, node_id: nodeId });
            }
          } catch {}
        }),
      );
      return { queue_length: queueLength, active_build: activeBuild, images };
    }

    if (action === 'project_tools_mounts') {
      // CRITICAL: Aggregate across ALL nodes so GC in ProjectToolsService never deletes a revision mounted on any node!
      const targets: string[] = [...(this.hasLocalManager() ? [LOCAL_NODE_ID] : []), ...this.onlineRemoteNodes().map(n => n.id)];
      if (!targets.length) fail(503, 'manager_unavailable');
      const mounts: any[] = [];
      let succeeded = 0;
      await Promise.all(
        targets.map(async nodeId => {
          try {
            const res = await this.callSpecificNode(nodeId, 'GET', '/v1/project-tools/mounts', undefined, Math.min(timeoutMs, 15_000));
            if (Array.isArray(res?.mounts)) {
              succeeded++;
              for (const m of res.mounts) mounts.push({ ...m, node_id: nodeId });
            }
          } catch {}
        }),
      );
      if (!succeeded) fail(503, 'manager_unavailable');
      return { mounts };
    }

    if (this.localManager) return this.localManager.call('GET', path, undefined, timeoutMs);
    return fail(404, 'not_found');
  }

  private async handleGlobalFanout(
    method: string,
    path: string,
    action: string,
    input: Json | undefined,
    timeoutMs: number,
  ): Promise<any> {
    const targets: string[] = [...(this.hasLocalManager() ? [LOCAL_NODE_ID] : []), ...this.onlineRemoteNodes().map(n => n.id)];
    if (!targets.length) fail(503, 'manager_unavailable');

    const settled = await Promise.allSettled(
      targets.map(async nodeId => ({
        nodeId,
        result: await this.callSpecificNode(nodeId, method, path, input, timeoutMs),
      })),
    );
    const ok = settled
      .filter((s): s is PromiseFulfilledResult<{ nodeId: string; result: any }> => s.status === 'fulfilled')
      .map(s => s.value);

    if (!ok.length) {
      const firstErr = (settled[0] as PromiseRejectedResult | undefined)?.reason;
      if (firstErr instanceof HttpError) throw firstErr;
      fail(503, 'manager_unavailable');
    }

    if (action === 'precompiled_images_prune') {
      return {
        removed: ok.flatMap(entry => (Array.isArray(entry.result?.removed) ? entry.result.removed.map((r: any) => ({ ...r, node_id: entry.nodeId })) : [])),
        kept: ok.reduce((sum, entry) => sum + (Number(entry.result?.kept) || 0), 0),
      };
    }

    if (action === 'storage_reclaim') {
      return {
        files: ok.reduce((sum, entry) => sum + (Number(entry.result?.files) || 0), 0),
        bytes: ok.reduce((sum, entry) => sum + (Number(entry.result?.bytes) || 0), 0),
      };
    }

    // For defaults / retention / cancel, prefer local manager's authoritative view (or first responding node).
    const localEntry = ok.find(entry => entry.nodeId === LOCAL_NODE_ID);
    return (localEntry ?? ok[0]!).result;
  }

  // ---- 5. Assistant computers: single-writer CAS placement + cross-node handoff ----

  private async handleAssistantAggregate(action: string, _path: string, timeoutMs: number): Promise<any> {
    const targets: string[] = [...(this.hasLocalManager() ? [LOCAL_NODE_ID] : []), ...this.onlineRemoteNodes().map(n => n.id)];
    if (!targets.length) fail(503, 'manager_unavailable');

    if (action === 'list') {
      const computers: any[] = [];
      let waiting = 0;
      let settings: any = null;
      let succeeded = 0;
      await Promise.all(
        targets.map(async nodeId => {
          try {
            const res = await this.callSpecificNode(nodeId, 'GET', '/v1/assistant-computers', undefined, Math.min(timeoutMs, 15_000));
            if (res && Array.isArray(res.computers)) {
              succeeded++;
              for (const c of res.computers) computers.push({ ...c, node_id: nodeId });
              waiting += Number(res.waiting || 0);
              if (!settings || nodeId === LOCAL_NODE_ID) settings = res.settings ?? settings;
            }
          } catch {}
        }),
      );
      if (!succeeded) fail(503, 'manager_unavailable');
      return { computers, waiting, settings };
    }

    // action === 'settings'
    const settled = await Promise.allSettled(
      targets.map(async nodeId => ({
        nodeId,
        view: await this.callSpecificNode(nodeId, 'GET', '/v1/assistant-computers/settings', undefined, Math.min(timeoutMs, 15_000)),
      })),
    );
    const ok = settled
      .filter((s): s is PromiseFulfilledResult<{ nodeId: string; view: any }> => s.status === 'fulfilled' && Boolean(s.value.view))
      .map(s => s.value);
    if (!ok.length) fail(503, 'manager_unavailable');
    const base = (ok.find(x => x.nodeId === LOCAL_NODE_ID) ?? ok[0]!).view;
    if (ok.length === 1) return base;
    return {
      ...base,
      homes: ok.some(x => x.view?.homes !== false),
      usage: {
        computers: ok.reduce((sum, x) => sum + (Number(x.view?.usage?.computers) || 0), 0),
        busy: ok.reduce((sum, x) => sum + (Number(x.view?.usage?.busy) || 0), 0),
        waiting: ok.reduce((sum, x) => sum + (Number(x.view?.usage?.waiting) || 0), 0),
      },
    };
  }

  private async handleAssistantFanout(
    method: string,
    path: string,
    action: string,
    input: Json | undefined,
    timeoutMs: number,
  ): Promise<any> {
    const targets: string[] = [...(this.hasLocalManager() ? [LOCAL_NODE_ID] : []), ...this.onlineRemoteNodes().map(n => n.id)];
    if (!targets.length) fail(503, 'manager_unavailable');

    const settled = await Promise.allSettled(
      targets.map(async nodeId => {
        let payload = input;
        if (action === 'reconcile') {
          // Include only active turns + live placements belonging to this node so stale containers on old nodes get swept.
          const turns = Array.isArray(input?.turns) ? (input.turns as string[]) : [];
          const placements = this.clusterStore.listAssistantPlacements(nodeId);
          const placedTurns = new Set(placements.filter(p => p.turn).map(p => p.turn!));
          const nodeTurns = nodeId === LOCAL_NODE_ID && !this.onlineRemoteNodes().length
            ? turns
            : turns.filter(t => placedTurns.has(t));
          payload = { turns: nodeTurns };
        }
        return { nodeId, result: await this.callSpecificNode(nodeId, method, path, payload, timeoutMs) };
      }),
    );
    const ok = settled
      .filter((s): s is PromiseFulfilledResult<{ nodeId: string; result: any }> => s.status === 'fulfilled')
      .map(s => s.value);
    if (!ok.length) {
      const firstErr = (settled[0] as PromiseRejectedResult | undefined)?.reason;
      if (firstErr instanceof HttpError) throw firstErr;
      fail(503, 'manager_unavailable');
    }
    return (ok.find(x => x.nodeId === LOCAL_NODE_ID) ?? ok[0]!).result;
  }

  private async handleAssistantOwner(
    method: string,
    path: string,
    owner: string,
    action: string,
    input: Json | undefined,
    timeoutMs: number,
  ): Promise<any> {
    if (action === 'acquire') {
      return this.acquireAssistantComputer(owner, input ?? {}, timeoutMs);
    }

    const placement = this.clusterStore.getAssistantPlacement(owner);
    const targetNodeId = placement?.node_id ?? (this.hasLocalManager() ? LOCAL_NODE_ID : null);
    if (!targetNodeId) {
      if (action === 'remove') return { owner, removed: false };
      return fail(410, 'assistant_computer_released');
    }

    if (action === 'renew') {
      const turn = typeof input?.turn === 'string' ? input.turn : '';
      if (placement) {
        const renewed = this.clusterStore.casRenewAssistantPlacement({
          owner,
          nodeId: targetNodeId,
          turn,
          leaseTtlMs: this.assistantLeaseTtlMs,
        });
        if (!renewed.renewed) fail(410, 'assistant_computer_released');
      }
      return this.callSpecificNode(targetNodeId, method, path, input, timeoutMs);
    }

    if (action === 'release') {
      const turn = typeof input?.turn === 'string' ? input.turn : undefined;
      const remove = input?.remove === true;
      try {
        if (targetNodeId !== LOCAL_NODE_ID && this.hub.isNodeConnected(targetNodeId)) {
          // Ensure remote node flushes assistant-homes back to center via SyncClient before releasing container!
          await this.hub
            .callNode(targetNodeId, 'POST', `/v1/node/assistant-computers/${owner}/flush-sync`, {
              generation: placement?.generation,
            }, { timeoutMs: 60_000 })
            .catch(() => {});
        }
        return await this.callSpecificNode(targetNodeId, method, path, input, timeoutMs);
      } finally {
        this.clusterStore.casReleaseAssistantPlacement({
          owner,
          nodeId: targetNodeId,
          turn,
          remove,
          affinityMs: this.assistantAffinityMs,
        });
        if (remove && targetNodeId !== LOCAL_NODE_ID && placement) {
          this.assistantProjectTools.delete(owner);
          this.syncTokens?.revokeMatchingScope(`node:${targetNodeId}`, 'assistant-homes', `${owner}:${placement.generation}`, 'cluster');
        }
      }
    }

    if (action === 'remove') {
      try {
        if (targetNodeId !== LOCAL_NODE_ID && this.hub.isNodeConnected(targetNodeId)) {
          await this.hub
            .callNode(targetNodeId, 'POST', `/v1/node/assistant-computers/${owner}/flush-sync`, {
              generation: placement?.generation,
            }, { timeoutMs: 60_000 })
            .catch(() => {});
        }
        return await this.callSpecificNode(targetNodeId, 'DELETE', `/v1/assistant-computers/${owner}`, undefined, timeoutMs);
      } finally {
        this.assistantProjectTools.delete(owner);
        this.clusterStore.deleteAssistantPlacement(owner, targetNodeId);
        if (targetNodeId !== LOCAL_NODE_ID && placement) {
          this.syncTokens?.revokeMatchingScope(`node:${targetNodeId}`, 'assistant-homes', `${owner}:${placement.generation}`, 'cluster');
        }
      }
    }

    // execute / output / inspect: strictly routed to current placement node (never split-brain!)
    return this.callSpecificNode(targetNodeId, method, path, input, timeoutMs);
  }

  private async acquireAssistantComputer(owner: string, input: Json, timeoutMs: number): Promise<any> {
    const turn = typeof input.turn === 'string' ? input.turn : '';
    const generation = Number(input.home_generation);
    const onlineIds = new Set<string>();
    if (this.hasLocalManager() && this.clusterStore.getNode(LOCAL_NODE_ID)?.status === 'online') {
      onlineIds.add(LOCAL_NODE_ID);
    }
    for (const remote of this.onlineRemoteNodes()) {
      if (remote.status === 'online') onlineIds.add(remote.id);
    }

    const chosen = this.clusterStore.selectAssistantNode(owner, onlineIds);
    if (!chosen) return fail(503, 'assistant_computer_unavailable');

    const reserved = this.clusterStore.casReserveAssistantPlacement({
      owner,
      generation,
      turn,
      targetNodeId: chosen.nodeId,
      leaseTtlMs: this.assistantLeaseTtlMs,
      affinityMs: this.assistantAffinityMs,
    });

    if (reserved.action === 'busy') {
      return { state: 'queued', reason: 'owner_busy', position: 1 };
    }

    let targetNodeId: string;
    let activeEpoch: number;

    if (reserved.action === 'migrate') {
      // Single-writer handoff invariant: MUST stop & flush old node container BEFORE starting on new node!
      const fromNode = this.clusterStore.getNode(reserved.from_node_id);
      const fromOnline =
        reserved.from_node_id === LOCAL_NODE_ID
          ? this.hasLocalManager()
          : this.hub.isNodeConnected(reserved.from_node_id);

      if (fromOnline) {
        try {
          if (reserved.from_node_id !== LOCAL_NODE_ID) {
            await this.hub.callNode(
              reserved.from_node_id,
              'POST',
              `/v1/node/assistant-computers/${owner}/flush-sync`,
              { generation: reserved.previous_generation },
              { timeoutMs: 60_000 },
            );
          }
          await this.callSpecificNode(reserved.from_node_id, 'DELETE', `/v1/assistant-computers/${owner}`, undefined, 60_000);
          if (reserved.from_node_id !== LOCAL_NODE_ID) {
            this.syncTokens?.revokeMatchingScope(
              `node:${reserved.from_node_id}`,
              'assistant-homes',
              `${owner}:${reserved.previous_generation}`,
              'cluster',
            );
          }
        } catch (err) {
          this.clusterStore.casAbortAssistantMigration(owner, reserved.epoch);
          throw err;
        }
      } else if (fromNode && fromNode.status !== 'revoked' && !reserved.previous_lease_expired) {
        // Old node is temporarily unreachable and lease has not expired yet -> fail closed (no split-brain rw mount!).
        this.clusterStore.casAbortAssistantMigration(owner, reserved.epoch);
        return { state: 'queued', reason: 'owner_busy', position: 1 };
      } else if (reserved.from_node_id !== LOCAL_NODE_ID) {
        // Lease expired or node revoked: revoke old node's sync tokens before moving.
        this.syncTokens?.revokeMatchingScope(
          `node:${reserved.from_node_id}`,
          'assistant-homes',
          `${owner}:${reserved.previous_generation}`,
          'cluster',
        );
      }

      targetNodeId = reserved.to_node_id;
      activeEpoch = this.clusterStore.casCommitAssistantMigration({
        owner,
        epoch: reserved.epoch,
        toNodeId: targetNodeId,
        generation,
        turn,
        leaseTtlMs: this.assistantLeaseTtlMs,
        affinityMs: this.assistantAffinityMs,
      });
    } else {
      targetNodeId = reserved.node_id;
      activeEpoch = reserved.epoch;
    }

    const requestedProjectToolRepos = new Set<string>();
    if (Array.isArray(input.project_tools)) {
      for (const item of input.project_tools as any[]) {
        if (item && typeof item === 'object' && typeof item.repository_id === 'string' && /^[1-9]\d{0,19}$/.test(item.repository_id)) {
          requestedProjectToolRepos.add(item.repository_id);
        }
      }
    }
    if (targetNodeId !== LOCAL_NODE_ID && requestedProjectToolRepos.size > 0) {
      this.assistantProjectTools.set(owner, { nodeId: targetNodeId, repoIds: requestedProjectToolRepos });
    } else {
      this.assistantProjectTools.delete(owner);
    }

    try {
      const result = await this.callSpecificNode(targetNodeId, 'PUT', `/v1/assistant-computers/${owner}`, input, timeoutMs);
      if (result?.state === 'ready') {
        const activated = this.clusterStore.casActivateAssistantPlacement({
          owner,
          nodeId: targetNodeId,
          epoch: activeEpoch,
          turn,
          leaseTtlMs: this.assistantLeaseTtlMs,
          affinityMs: this.assistantAffinityMs,
        });
        if (!activated) {
          this.assistantProjectTools.delete(owner);
          // Fenced while creating -> stop container cleanly so no stray writer survives.
          await this.callSpecificNode(targetNodeId, 'DELETE', `/v1/assistant-computers/${owner}`, undefined, 30_000).catch(() => {});
          fail(410, 'assistant_computer_released');
        }
        return {
          ...result,
          node_id: targetNodeId,
          placement_epoch: activeEpoch,
        };
      }
      this.assistantProjectTools.delete(owner);
      // Queued for capacity on target node -> release acquiring reservation cleanly.
      this.clusterStore.casReleaseAssistantPlacement({
        owner,
        nodeId: targetNodeId,
        turn,
        epoch: activeEpoch,
        remove: false,
        affinityMs: 0,
      });
      return result;
    } catch (err) {
      this.assistantProjectTools.delete(owner);
      this.clusterStore.casReleaseAssistantPlacement({
        owner,
        nodeId: targetNodeId,
        turn,
        epoch: activeEpoch,
        remove: false,
        affinityMs: 0,
      });
      throw err;
    }
  }

  // ---- 6. Graceful Drain, Safe Project Rebind & Node Revocation ----

  activeWorkOnNode(nodeId: string): { running_tasks: number; busy_assistants: number } {
    const repoIds = this.clusterStore.listRepositoriesOnNode(nodeId);
    let runningTasks = 0;
    if (repoIds.length > 0) {
      runningTasks = Number(
        this.store.get(
          'SELECT count(*) AS n FROM task_claims WHERE repository_id IN (SELECT value FROM json_each(?))',
          JSON.stringify(repoIds),
        )?.n ?? 0,
      );
    }
    const now = this.clusterStore.now();
    const busyAssistants = this.clusterStore
      .listAssistantPlacements(nodeId)
      .filter(p => ['busy', 'acquiring', 'migrating'].includes(p.state) && p.lease_expires_at > now).length;
    return { running_tasks: runningTasks, busy_assistants: busyAssistants };
  }

  async drainNode(nodeId: string, options: { timeoutMs?: number; actor: string }): Promise<{
    node: ComputeNodeRecord;
    active_work: { running_tasks: number; busy_assistants: number };
  }> {
    const node = this.clusterStore.startDrain(nodeId, {
      timeoutMs: options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      actor: options.actor,
    });
    const activeWork = this.activeWorkOnNode(nodeId);
    if (activeWork.running_tasks === 0 && activeWork.busy_assistants === 0) {
      await this.finalizeNodeDrain(nodeId);
    }
    return { node: this.clusterStore.getNode(nodeId) ?? node, active_work: this.activeWorkOnNode(nodeId) };
  }

  async undrainNode(nodeId: string, actor: string): Promise<ComputeNodeRecord> {
    const isOnline = nodeId === LOCAL_NODE_ID ? this.hasLocalManager() : this.hub.isNodeConnected(nodeId);
    return this.clusterStore.undrainNode(nodeId, { isOnline, actor });
  }

  reconcileDrains(): Promise<void> {
    if (this.reconcilingDrains) return this.reconcilingDrains;
    this.reconcilingDrains = (async () => {
      const now = this.clusterStore.now();
      for (const node of this.clusterStore.listNodes()) {
        if (node.status !== 'draining' || node.drained_at !== null) continue;
        const work = this.activeWorkOnNode(node.id);
        const requestedAt = node.drain_requested_at ? Date.parse(node.drain_requested_at) : now;
        const timeoutMs = node.drain_timeout_ms ?? DEFAULT_DRAIN_TIMEOUT_MS;
        const timedOut = Number.isFinite(requestedAt) && now - requestedAt >= timeoutMs;
        if ((work.running_tasks === 0 && work.busy_assistants === 0) || timedOut) {
          await this.finalizeNodeDrain(node.id);
        }
      }
    })().finally(() => {
      this.reconcilingDrains = null;
    });
    return this.reconcilingDrains;
  }

  private async finalizeNodeDrain(nodeId: string): Promise<void> {
    const reachable = nodeId === LOCAL_NODE_ID ? this.hasLocalManager() : this.hub.isNodeConnected(nodeId);
    if (reachable) {
      // Stop project containers gracefully on this node (flushing notes on remote nodes first!).
      for (const repoId of this.clusterStore.listRepositoriesOnNode(nodeId)) {
        try {
          const state = await this.callSpecificNode(nodeId, 'GET', `/v1/projects/${repoId}`, undefined, 15_000).catch(() => null);
          if (!state || ['stopped', 'deleted'].includes(state.state)) continue;
          if (nodeId !== LOCAL_NODE_ID) {
            await this.hub
              .callNode(nodeId, 'POST', `/v1/node/projects/${repoId}/flush-sync`, {}, { timeoutMs: 60_000 })
              .catch(() => {});
          }
          await this.callSpecificNode(
            nodeId,
            'POST',
            `/v1/projects/${repoId}/stop`,
            { operation_id: randomId(), generation: Number(state.generation || 1) },
            60_000,
          ).catch(() => {});
        } catch {}
      }
      // Flush and remove all assistant containers on this node.
      for (const placement of this.clusterStore.listAssistantPlacements(nodeId)) {
        try {
          if (nodeId !== LOCAL_NODE_ID) {
            await this.hub
              .callNode(nodeId, 'POST', `/v1/node/assistant-computers/${placement.owner}/flush-sync`, {
                generation: placement.generation,
              }, { timeoutMs: 60_000 })
              .catch(() => {});
          }
          await this.callSpecificNode(nodeId, 'DELETE', `/v1/assistant-computers/${placement.owner}`, undefined, 30_000).catch(() => {});
        } finally {
          this.clusterStore.deleteAssistantPlacement(placement.owner, nodeId);
          if (nodeId !== LOCAL_NODE_ID) {
            this.syncTokens?.revokeMatchingScope(`node:${nodeId}`, 'assistant-homes', `${placement.owner}:${placement.generation}`, 'cluster');
          }
        }
      }
    }
    this.clusterStore.markNodeDrained(nodeId);
  }

  /**
   * Safe repository node rebind sequence (Product Decision 3):
   * 1. CAS `state='rebinding'`, bump `binding_epoch` (blocks new task claims immediately).
   * 2. On old node: flush `project-notes` via `SyncClient` back to control plane (if remote), stop & remove old
   *    container/network, and reclaim old node's workspace/cache locally (NEVER copy workspace volumes across nodes!).
   * 3. If old node held a notes volume/cache and could not clean it right now, mark `reclaim_pending=1` on `old_node_id`
   *    so `reclaimNotes` ALWAYS targets the old node, never the new node.
   * 4. Revoke old node's sync tokens for this repository.
   * 5. Commit binding to `targetNodeId` (`state='bound'`, bumped `binding_epoch`).
   */
  async rebindRepository(
    repositoryId: string,
    targetNodeId: string,
    options: { labelSelector?: Record<string, string>; force?: boolean; actor: string },
  ): Promise<{ binding: RepositoryNodeBinding; previous_node_id: string; old_node_cleaned: boolean }> {
    const started = this.clusterStore.beginRepositoryRebind(repositoryId, targetNodeId, options);
    const oldNodeId = started.previous_node_id;
    const oldNode = this.clusterStore.getNode(oldNodeId);
    const oldReachable = oldNodeId === LOCAL_NODE_ID ? this.hasLocalManager() : this.hub.isNodeConnected(oldNodeId);
    let oldNodeCleaned = false;

    if (oldReachable && oldNode?.status !== 'revoked') {
      try {
        // Flush any dirty remote project-notes back to control plane before stopping old container.
        if (oldNodeId !== LOCAL_NODE_ID) {
          await this.hub.callNode(oldNodeId, 'POST', `/v1/node/projects/${repositoryId}/flush-sync`, {}, { timeoutMs: 60_000 });
        }
        const oldState = await this.callSpecificNode(oldNodeId, 'GET', `/v1/projects/${repositoryId}`, undefined, 15_000).catch(() => null);
        if (oldState && oldState.state !== 'deleted') {
          // Stop and remove container/network on old node (do NOT delete control-plane authoritative notes!).
          await this.callSpecificNode(
            oldNodeId,
            'POST',
            `/v1/projects/${repositoryId}/delete`,
            { operation_id: randomId(), generation: Number(oldState.generation || 1) },
            90_000,
          );
        }
        // Reclaim workspace volumes & local sync cache on old node only (keeping center authoritative notes intact).
        if (oldNodeId !== LOCAL_NODE_ID) {
          await this.hub
            .callNode(oldNodeId, 'POST', `/v1/node/projects/${repositoryId}/reclaim-local`, {}, { timeoutMs: 60_000 })
            .catch(() => {});
          this.clusterStore.clearNodeVolume(repositoryId, oldNodeId);
        } else {
          // On local node, workspace volume cleanup is owned by local node; authoritative project-notes stays on local/center!
          this.clusterStore.clearNodeVolume(repositoryId, oldNodeId, 'workspace');
        }
        oldNodeCleaned = true;
      } catch (err) {
        if (!options.force) {
          this.clusterStore.abortRepositoryRebind(repositoryId, started.rebind_epoch, started.previous_state);
          throw err;
        }
        this.clusterStore.markVolumeReclaimPending(repositoryId, oldNodeId, 'workspace');
        if (oldNodeId !== LOCAL_NODE_ID) {
          this.clusterStore.markVolumeReclaimPending(repositoryId, oldNodeId, 'notes');
        }
      }
    } else if (!options.force && oldNode && oldNode.status !== 'revoked' && oldNode.status !== 'offline') {
      this.clusterStore.abortRepositoryRebind(repositoryId, started.rebind_epoch, started.previous_state);
      fail(503, 'previous_node_unreachable');
    } else {
      // Old node is offline/revoked: record pending local reclaim against oldNodeId (NEVER against targetNodeId!).
      this.clusterStore.markVolumeReclaimPending(repositoryId, oldNodeId, 'workspace');
      if (oldNodeId !== LOCAL_NODE_ID) {
        this.clusterStore.markVolumeReclaimPending(repositoryId, oldNodeId, 'notes');
      }
    }

    // Revoke old remote node's scoped sync tokens for this repository immediately.
    if (oldNodeId !== LOCAL_NODE_ID && this.syncTokens) {
      const actor = `node:${oldNodeId}`;
      this.syncTokens.revokeMatchingScope(actor, 'project-notes', repositoryId, options.actor);
      this.syncTokens.revokeMatchingScope(actor, 'project-tools', repositoryId, options.actor);
      this.syncTokens.revokeMatchingScope(actor, 'skill-store', `projects/${repositoryId}`, options.actor);
      this.syncTokens.revokeMatchingScope(actor, 'tool-results', computerResultOwner('project', repositoryId), options.actor);
    }

    const binding = this.clusterStore.completeRepositoryRebind(repositoryId, started.rebind_epoch, targetNodeId, options.actor);
    return { binding, previous_node_id: oldNodeId, old_node_cleaned: oldNodeCleaned };
  }

  /**
   * Revokes a remote compute node: best-effort stops & deletes containers on the node, closes active WS/poll sessions,
   * revokes all node sessions and sync tokens, and records an audit trail.
   */
  async revokeNode(nodeId: string, options: { force?: boolean; actor: string }): Promise<ComputeNodeRecord> {
    const existing = this.clusterStore.getNode(nodeId);
    if (!existing) return fail(404, 'node_not_found');
    if (existing.kind === 'local' || nodeId === LOCAL_NODE_ID) return fail(409, 'cannot_revoke_local_node');

    const boundRepos = this.clusterStore.listRepositoriesOnNode(nodeId);
    if (boundRepos.length > 0 && !options.force) {
      fail(409, 'node_has_bound_projects', undefined, {
        detail: `节点仍绑定 ${boundRepos.length} 个项目，请先将项目改绑到其他节点或确认强制下线。`,
        repositories: boundRepos,
      });
    }

    // Best-effort notify connected node to stop and delete all its containers before severing the link.
    if (this.hub.isNodeConnected(nodeId)) {
      await this.hub
        .callNode(nodeId, 'POST', '/v1/node/revoke', { reason: 'revoked_by_admin' }, { timeoutMs: 10_000 })
        .catch(() => {});
    }

    const revoked = this.clusterStore.revokeNode(nodeId, options);
    for (const [owner, grant] of [...this.assistantProjectTools.entries()]) {
      if (grant.nodeId === nodeId) this.assistantProjectTools.delete(owner);
    }
    this.syncTokens?.revokeByActor(`node:${nodeId}`, options.actor);
    this.hub.disconnectNode(nodeId, 'node_revoked');
    return revoked;
  }
}
