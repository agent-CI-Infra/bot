import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Row, Store } from '../storage/database.js';
import { digest, fail, HttpError, randomId } from '../core/security.js';
import {
  checkProtocolCompatibility,
  DEFAULT_NODE_PAIRING_TTL_MS,
  DEFAULT_NODE_SESSION_TTL_MS,
  isValidNodeDriver,
  isValidNodeId,
  NODE_AGENT_PROTOCOL_VERSION,
  NODE_PAIRING_TOKEN_PREFIX,
  NODE_SESSION_TOKEN_PREFIX,
  normalizeNodeArch,
  normalizeNodeLabels,
  normalizeNodeOs,
  validateEd25519PublicKey,
  verifyNodeAssertion,
  type BindingState,
  type NodeDriver,
  type NodeStatus,
} from '../../runner/node-protocol.mjs';

export const LOCAL_NODE_ID = 'local';
export const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_ASSISTANT_LEASE_TTL_MS = 120_000;
export const DEFAULT_ASSISTANT_AFFINITY_MS = 5 * 60 * 1000;

export interface NodeMetrics {
  cpu_count?: number | null;
  cpu_load_1m?: number | null;
  memory_total_mb?: number | null;
  memory_free_mb?: number | null;
  memory_used_mb?: number | null;
  disk_total_bytes?: number | null;
  disk_free_bytes?: number | null;
  disk_low?: boolean;
  project_containers?: number;
  assistant_containers?: number;
  busy_project_containers?: number;
  busy_assistant_containers?: number;
  containers?: Array<{
    kind: 'project' | 'assistant';
    id: string;
    state: string;
    memory_mb?: number | null;
    cpus?: number | null;
  }>;
}

export interface ComputeNodeRecord {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  driver: NodeDriver;
  os: string;
  arch: string;
  labels: Record<string, string>;
  status: NodeStatus;
  transport: 'local' | 'websocket' | 'long_poll' | 'direct';
  direct_url: string | null;
  protocol_version: number | null;
  agent_version: string | null;
  auth_type: 'local' | 'pairing_token' | 'public_key';
  has_public_key: boolean;
  pairing_expires_at: string | null;
  paired_at: string | null;
  last_heartbeat_at: string | null;
  metrics: NodeMetrics;
  drain_requested_at: string | null;
  drain_timeout_ms: number | null;
  drained_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepositoryNodeBinding {
  repository_id: string;
  node_id: string;
  target_node_id: string | null;
  previous_node_id: string | null;
  label_selector: Record<string, string>;
  state: BindingState;
  binding_epoch: number;
  notes_node_id: string;
  updated_at: string;
}

export interface AssistantPlacementRecord {
  owner: string;
  node_id: string;
  epoch: number;
  generation: number;
  turn: string | null;
  state: 'acquiring' | 'busy' | 'idle' | 'migrating' | 'releasing';
  lease_expires_at: number;
  affinity_until: number;
  updated_at: string;
}

export interface RepositoryNodeVolumeRecord {
  repository_id: string;
  node_id: string;
  volume_kind: 'notes' | 'workspace';
  volume_name: string;
  created_at: string | null;
  reclaim_pending: boolean;
  updated_at: string;
}

function safeJsonObject<T extends object>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
  } catch { /* isolate corrupt JSON columns */ }
  return fallback;
}

function rowToNode(row: Row): ComputeNodeRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind === 'local' ? 'local' : 'remote',
    driver: row.driver === 'host' ? 'host' : 'docker',
    os: String(row.os || 'linux'),
    arch: String(row.arch || 'amd64'),
    labels: safeJsonObject<Record<string, string>>(row.labels, {}),
    status: String(row.status || 'offline') as NodeStatus,
    transport: (['local', 'websocket', 'long_poll', 'direct'].includes(String(row.transport)) ? String(row.transport) : 'websocket') as ComputeNodeRecord['transport'],
    direct_url: row.direct_url ? String(row.direct_url) : null,
    protocol_version: row.protocol_version === null || row.protocol_version === undefined ? null : Number(row.protocol_version),
    agent_version: row.agent_version ? String(row.agent_version) : null,
    auth_type: (['local', 'pairing_token', 'public_key'].includes(String(row.auth_type)) ? String(row.auth_type) : 'pairing_token') as ComputeNodeRecord['auth_type'],
    has_public_key: Boolean(row.public_key),
    pairing_expires_at: row.pairing_expires_at ? new Date(Number(row.pairing_expires_at)).toISOString() : null,
    paired_at: row.paired_at ? String(row.paired_at) : null,
    last_heartbeat_at: row.last_heartbeat_at ? String(row.last_heartbeat_at) : null,
    metrics: safeJsonObject<NodeMetrics>(row.metrics, {}),
    drain_requested_at: row.drain_requested_at ? String(row.drain_requested_at) : null,
    drain_timeout_ms: row.drain_timeout_ms === null || row.drain_timeout_ms === undefined ? null : Number(row.drain_timeout_ms),
    drained_at: row.drained_at ? String(row.drained_at) : null,
    revoked_at: row.revoked_at ? String(row.revoked_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToBinding(row: Row): RepositoryNodeBinding {
  return {
    repository_id: String(row.repository_id),
    node_id: String(row.node_id),
    target_node_id: row.target_node_id ? String(row.target_node_id) : null,
    previous_node_id: row.previous_node_id ? String(row.previous_node_id) : null,
    label_selector: safeJsonObject<Record<string, string>>(row.label_selector, {}),
    state: String(row.state) as BindingState,
    binding_epoch: Number(row.binding_epoch || 1),
    notes_node_id: String(row.notes_node_id || LOCAL_NODE_ID),
    updated_at: String(row.updated_at),
  };
}

function rowToPlacement(row: Row): AssistantPlacementRecord {
  return {
    owner: String(row.owner),
    node_id: String(row.node_id),
    epoch: Number(row.epoch),
    generation: Number(row.generation),
    turn: row.turn ? String(row.turn) : null,
    state: String(row.state) as AssistantPlacementRecord['state'],
    lease_expires_at: Number(row.lease_expires_at),
    affinity_until: Number(row.affinity_until),
    updated_at: String(row.updated_at),
  };
}

export function clusterStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS compute_nodes(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('local','remote')),
      driver TEXT NOT NULL DEFAULT 'docker' CHECK(driver IN ('docker','host')),
      os TEXT NOT NULL DEFAULT 'linux',
      arch TEXT NOT NULL DEFAULT 'amd64',
      labels TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','online','draining','offline','revoked')),
      transport TEXT NOT NULL DEFAULT 'websocket' CHECK(transport IN ('local','websocket','long_poll','direct')),
      direct_url TEXT,
      protocol_version INTEGER,
      agent_version TEXT,
      auth_type TEXT NOT NULL DEFAULT 'pairing_token' CHECK(auth_type IN ('local','pairing_token','public_key')),
      credential_hash TEXT,
      public_key TEXT,
      pairing_expires_at INTEGER,
      paired_at TEXT,
      last_heartbeat_at TEXT,
      metrics TEXT NOT NULL DEFAULT '{}',
      drain_requested_at TEXT,
      drain_timeout_ms INTEGER,
      drained_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS compute_nodes_status ON compute_nodes(status, kind);

    CREATE TABLE IF NOT EXISTS compute_node_sessions(
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES compute_nodes(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'websocket',
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS compute_node_sessions_node ON compute_node_sessions(node_id, revoked_at, expires_at);

    CREATE TABLE IF NOT EXISTS repository_node_bindings(
      repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
      node_id TEXT NOT NULL DEFAULT 'local' REFERENCES compute_nodes(id),
      target_node_id TEXT REFERENCES compute_nodes(id),
      previous_node_id TEXT REFERENCES compute_nodes(id),
      label_selector TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('bound','active','draining','offline','rebinding')),
      binding_epoch INTEGER NOT NULL DEFAULT 1,
      notes_node_id TEXT NOT NULL DEFAULT 'local',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS repository_node_bindings_node ON repository_node_bindings(node_id, state);

    CREATE TABLE IF NOT EXISTS repository_node_volumes(
      repository_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      volume_kind TEXT NOT NULL CHECK(volume_kind IN ('notes','workspace')),
      volume_name TEXT NOT NULL,
      created_at TEXT,
      reclaim_pending INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, node_id, volume_kind)
    );
    CREATE INDEX IF NOT EXISTS repository_node_volumes_reclaim ON repository_node_volumes(reclaim_pending, node_id);

    CREATE TABLE IF NOT EXISTS assistant_placements(
      owner TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES compute_nodes(id),
      epoch INTEGER NOT NULL DEFAULT 1,
      generation INTEGER NOT NULL DEFAULT 1,
      turn TEXT,
      state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('acquiring','busy','idle','migrating','releasing')),
      lease_expires_at INTEGER NOT NULL DEFAULT 0,
      affinity_until INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_placements_node ON assistant_placements(node_id, state, lease_expires_at);

    CREATE TABLE IF NOT EXISTS environment_operation_nodes(
      operation_id TEXT PRIMARY KEY REFERENCES environment_operations(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL DEFAULT 'local',
      binding_epoch INTEGER NOT NULL DEFAULT 1
    );
  `);

  const nowIso = new Date().toISOString();
  const osName = normalizeNodeOs(process.platform);
  const archName = normalizeNodeArch(process.arch);
  store.run(
    `INSERT OR IGNORE INTO compute_nodes(
       id,name,kind,driver,os,arch,labels,status,transport,protocol_version,auth_type,paired_at,last_heartbeat_at,metrics,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    LOCAL_NODE_ID,
    '本机节点 (local)',
    'local',
    'docker',
    osName,
    archName,
    JSON.stringify({ arch: archName, role: 'local' }),
    'online',
    'local',
    NODE_AGENT_PROTOCOL_VERSION,
    'local',
    nowIso,
    nowIso,
    '{}',
    nowIso,
    nowIso,
  );
}

/**
 * Checks whether a repository's bound node & binding state currently admit new task claims.
 * Used directly inside `claimQueuedTask` transactions so draining/offline/rebinding nodes never accept new work.
 */
export function isRepositoryNodeClaimable(store: Store, repositoryId: string): boolean {
  if (!store.hasTable('repository_node_bindings') || !store.hasTable('compute_nodes')) return true;
  const binding = store.get(
    'SELECT b.state AS binding_state, n.status AS node_status FROM repository_node_bindings b JOIN compute_nodes n ON n.id=b.node_id WHERE b.repository_id=?',
    repositoryId,
  );
  if (!binding) {
    // Legacy/unbound repositories default to built-in `local` node.
    const local = store.get('SELECT status FROM compute_nodes WHERE id=?', LOCAL_NODE_ID);
    if (!local) return true;
    return String(local.status) === 'online';
  }
  if (['draining', 'rebinding', 'offline'].includes(String(binding.binding_state))) return false;
  return String(binding.node_status) === 'online';
}

export function recordOperationNodeBinding(store: Store, operationId: string, repositoryId: string): { node_id: string; binding_epoch: number } {
  if (!store.hasTable('environment_operation_nodes')) {
    return { node_id: LOCAL_NODE_ID, binding_epoch: 1 };
  }
  const binding = store.hasTable('repository_node_bindings')
    ? store.get('SELECT node_id, binding_epoch FROM repository_node_bindings WHERE repository_id=?', repositoryId)
    : undefined;
  const nodeId = binding?.node_id ? String(binding.node_id) : LOCAL_NODE_ID;
  const bindingEpoch = binding?.binding_epoch ? Number(binding.binding_epoch) : 1;
  store.run(
    'INSERT OR REPLACE INTO environment_operation_nodes(operation_id,node_id,binding_epoch) VALUES(?,?,?)',
    operationId,
    nodeId,
    bindingEpoch,
  );
  return { node_id: nodeId, binding_epoch: bindingEpoch };
}

export function getOperationNodeBinding(store: Store, operationId: string): { node_id: string; binding_epoch: number } | null {
  if (!store.hasTable('environment_operation_nodes')) return null;
  const row = store.get('SELECT node_id, binding_epoch FROM environment_operation_nodes WHERE operation_id=?', operationId);
  if (!row) return null;
  return { node_id: String(row.node_id), binding_epoch: Number(row.binding_epoch) };
}

export class ClusterStore {
  private readonly seenNonces = new Map<string, number>();

  constructor(
    readonly store: Store,
    private readonly clock: () => number = () => Date.now(),
  ) {
    clusterStorage(store);
  }

  now(): number {
    return this.clock();
  }

  ensureLocalNode(options: { name?: string; online?: boolean } = {}): ComputeNodeRecord {
    const existing = this.store.get('SELECT * FROM compute_nodes WHERE id=?', LOCAL_NODE_ID);
    const nowIso = new Date(this.now()).toISOString();
    if (!existing) {
      const osName = normalizeNodeOs(process.platform);
      const archName = normalizeNodeArch(process.arch);
      this.store.run(
        `INSERT INTO compute_nodes(
           id,name,kind,driver,os,arch,labels,status,transport,protocol_version,auth_type,paired_at,last_heartbeat_at,metrics,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        LOCAL_NODE_ID,
        options.name || '本机节点 (local)',
        'local',
        'docker',
        osName,
        archName,
        JSON.stringify({ arch: archName, role: 'local' }),
        options.online === false ? 'offline' : 'online',
        'local',
        NODE_AGENT_PROTOCOL_VERSION,
        'local',
        nowIso,
        nowIso,
        '{}',
        nowIso,
        nowIso,
      );
    }
    return this.getNode(LOCAL_NODE_ID)!;
  }

  listNodes(): ComputeNodeRecord[] {
    return this.store
      .all("SELECT * FROM compute_nodes ORDER BY CASE WHEN id='local' THEN 0 ELSE 1 END, created_at ASC, id ASC")
      .map(rowToNode);
  }

  getNode(nodeId: string): ComputeNodeRecord | null {
    const row = this.store.get('SELECT * FROM compute_nodes WHERE id=?', nodeId);
    return row ? rowToNode(row) : null;
  }

  createRemoteNode(input: {
    id?: string;
    name: string;
    driver?: string;
    labels?: Record<string, string>;
    publicKey?: string;
    directUrl?: string | null;
    ttlMs?: number;
    actor: string;
  }): { node: ComputeNodeRecord; pairing_token: string | null; pairing_expires_at: string | null } {
    const name = String(input.name || '').trim();
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      fail(400, 'invalid_node_name');
    }
    const driver = input.driver ?? 'docker';
    if (!isValidNodeDriver(driver)) fail(400, 'invalid_node_driver');
    if (driver === 'host') fail(501, 'host_driver_not_implemented');

    let labels: Record<string, string>;
    try {
      labels = normalizeNodeLabels(input.labels ?? {});
    } catch {
      return fail(400, 'invalid_node_labels');
    }

    let nodeId = input.id ? String(input.id).trim().toLowerCase() : `node-${randomBytes(6).toString('hex')}`;
    if (!isValidNodeId(nodeId) || nodeId === LOCAL_NODE_ID) {
      fail(400, 'invalid_node_id');
    }
    if (this.store.get('SELECT 1 FROM compute_nodes WHERE id=?', nodeId)) {
      fail(409, 'node_already_exists');
    }

    let directUrl: string | null = null;
    if (input.directUrl !== undefined && input.directUrl !== null && String(input.directUrl).trim()) {
      const rawUrl = String(input.directUrl).trim();
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return fail(400, 'invalid_direct_url');
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        fail(400, 'invalid_direct_url');
      }
      directUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    }

    let publicKeyPem: string | null = null;
    if (input.publicKey !== undefined && input.publicKey !== null && String(input.publicKey).trim()) {
      try {
        publicKeyPem = validateEd25519PublicKey(input.publicKey);
      } catch {
        return fail(400, 'invalid_node_public_key');
      }
    }

    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const ttlMs = input.ttlMs ?? DEFAULT_NODE_PAIRING_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 3600_000) {
      fail(400, 'invalid_pairing_ttl');
    }

    let pairingToken: string | null = null;
    let pairingExpiresAt: number | null = null;
    let credentialHash: string;
    let authType: 'pairing_token' | 'public_key';

    if (publicKeyPem) {
      authType = 'public_key';
      credentialHash = createHash('sha256').update(publicKeyPem).digest('hex');
    } else {
      authType = 'pairing_token';
      const tokenId = randomBytes(6).toString('hex');
      const secret = randomBytes(24).toString('hex');
      pairingToken = `${NODE_PAIRING_TOKEN_PREFIX}${tokenId}.${secret}`;
      credentialHash = `${tokenId}:${digest(secret)}`;
      pairingExpiresAt = now + Math.trunc(ttlMs);
    }

    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO compute_nodes(
           id,name,kind,driver,os,arch,labels,status,transport,direct_url,auth_type,credential_hash,public_key,pairing_expires_at,metrics,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        nodeId,
        name,
        'remote',
        driver,
        'linux',
        labels.arch ? normalizeNodeArch(labels.arch) : 'amd64',
        JSON.stringify(labels),
        'pending',
        directUrl ? 'direct' : 'websocket',
        directUrl,
        authType,
        credentialHash,
        publicKeyPem,
        pairingExpiresAt,
        '{}',
        nowIso,
        nowIso,
      );
      this.store.audit(input.actor, 'cluster.node.created', nodeId);
    });

    return {
      node: this.getNode(nodeId)!,
      pairing_token: pairingToken,
      pairing_expires_at: pairingExpiresAt ? new Date(pairingExpiresAt).toISOString() : null,
    };
  }

  reissuePairingToken(nodeId: string, { ttlMs = DEFAULT_NODE_PAIRING_TTL_MS, actor }: { ttlMs?: number; actor: string }): {
    node: ComputeNodeRecord;
    pairing_token: string;
    pairing_expires_at: string;
  } {
    const node = this.getNode(nodeId);
    if (!node) return fail(404, 'node_not_found');
    if (node.kind === 'local') return fail(409, 'local_node_no_pairing_token');
    if (node.status === 'revoked') return fail(409, 'node_revoked');
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 3600_000) return fail(400, 'invalid_pairing_ttl');

    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const tokenId = randomBytes(6).toString('hex');
    const secret = randomBytes(24).toString('hex');
    const pairingToken = `${NODE_PAIRING_TOKEN_PREFIX}${tokenId}.${secret}`;
    const credentialHash = `${tokenId}:${digest(secret)}`;
    const expiresAt = now + Math.trunc(ttlMs);

    this.store.transaction(() => {
      this.store.run(
        `UPDATE compute_nodes SET auth_type='pairing_token', credential_hash=?, pairing_expires_at=?, updated_at=? WHERE id=?`,
        credentialHash,
        expiresAt,
        nowIso,
        nodeId,
      );
      this.store.audit(actor, 'cluster.node.token_issued', nodeId);
    });

    return {
      node: this.getNode(nodeId)!,
      pairing_token: pairingToken,
      pairing_expires_at: new Date(expiresAt).toISOString(),
    };
  }

  updateNode(
    nodeId: string,
    input: { name?: string; labels?: Record<string, string>; directUrl?: string | null; actor: string },
  ): ComputeNodeRecord {
    const node = this.getNode(nodeId);
    if (!node) return fail(404, 'node_not_found');
    if (node.status === 'revoked') return fail(409, 'node_revoked');

    const nextName = input.name !== undefined ? String(input.name).trim() : node.name;
    if (!nextName || nextName.length > 100 || /[\u0000-\u001f\u007f]/.test(nextName)) {
      fail(400, 'invalid_node_name');
    }
    let nextLabels = node.labels;
    if (input.labels !== undefined) {
      try {
        nextLabels = normalizeNodeLabels(input.labels);
      } catch {
        return fail(400, 'invalid_node_labels');
      }
    }
    let nextDirectUrl = node.direct_url;
    if (input.directUrl !== undefined) {
      if (input.directUrl === null || !String(input.directUrl).trim()) {
        nextDirectUrl = null;
      } else {
        let parsed: URL;
        try {
          parsed = new URL(String(input.directUrl).trim());
        } catch {
          return fail(400, 'invalid_direct_url');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          fail(400, 'invalid_direct_url');
        }
        nextDirectUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
      }
    }

    const nowIso = new Date(this.now()).toISOString();
    this.store.transaction(() => {
      this.store.run(
        'UPDATE compute_nodes SET name=?, labels=?, direct_url=?, updated_at=? WHERE id=?',
        nextName,
        JSON.stringify(nextLabels),
        nextDirectUrl,
        nowIso,
        nodeId,
      );
      this.store.audit(input.actor, 'cluster.node.updated', nodeId);
    });
    return this.getNode(nodeId)!;
  }

  private assertProtocolCompatible(protocolVersion: unknown, minProtocolVersion?: unknown): number {
    const check = checkProtocolCompatibility(protocolVersion, minProtocolVersion);
    if (!check.compatible) {
      fail(426, check.code || 'node_protocol_incompatible', undefined, {
        detail: check.detail,
        center_protocol_version: check.center_protocol_version,
        supported_range: check.supported_range,
        agent_protocol_version: check.agent_protocol_version,
      });
    }
    return check.negotiated_version!;
  }

  private createSessionRow(nodeId: string, transport: string, ttlMs = DEFAULT_NODE_SESSION_TTL_MS): {
    session_id: string;
    session_token: string;
    session_expires_at: string;
  } {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const sessionId = randomBytes(6).toString('hex');
    const secret = randomBytes(24).toString('hex');
    const sessionToken = `${NODE_SESSION_TOKEN_PREFIX}${sessionId}.${secret}`;
    const tokenHash = digest(secret);
    const expiresAt = now + ttlMs;
    this.store.run(
      `INSERT INTO compute_node_sessions(id,node_id,token_hash,transport,expires_at,revoked_at,created_at,last_seen_at)
       VALUES(?,?,?,?,?,NULL,?,?)`,
      sessionId,
      nodeId,
      tokenHash,
      transport,
      expiresAt,
      nowIso,
      nowIso,
    );
    return {
      session_id: sessionId,
      session_token: sessionToken,
      session_expires_at: new Date(expiresAt).toISOString(),
    };
  }

  pairNode(input: {
    authorization: string | undefined;
    publicKey: string;
    protocolVersion: unknown;
    minProtocolVersion?: unknown;
    agentVersion?: string;
    driver?: string;
    os?: string;
    arch?: string;
    labels?: Record<string, string>;
    transport?: string;
    directUrl?: string | null;
    metrics?: NodeMetrics;
  }): {
    node: ComputeNodeRecord;
    session_id: string;
    session_token: string;
    session_expires_at: string;
    protocol_version: number;
  } {
    const negotiated = this.assertProtocolCompatible(input.protocolVersion, input.minProtocolVersion);
    const rawAuth = String(input.authorization || '').trim();
    const match = /^Bearer\s+(bnode_([a-f0-9]{12})\.([a-f0-9]{48}))$/.exec(rawAuth);
    if (!match) return fail(401, 'node_unauthorized');
    const [, , tokenId, secret] = match;

    const driver = input.driver ?? 'docker';
    if (!isValidNodeDriver(driver)) fail(400, 'invalid_node_driver');
    if (driver === 'host') fail(501, 'host_driver_not_implemented');

    let publicKeyPem: string;
    try {
      publicKeyPem = validateEd25519PublicKey(input.publicKey);
    } catch {
      return fail(400, 'invalid_node_public_key');
    }

    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const candidateHash = Buffer.from(digest(secret!), 'hex');

    const rows = this.store.all(
      "SELECT * FROM compute_nodes WHERE kind='remote' AND credential_hash LIKE ?",
      `${tokenId}:%`,
    );
    let matchedRow: Row | null = null;
    for (const row of rows) {
      const storedHex = String(row.credential_hash || '').slice(tokenId!.length + 1);
      if (storedHex.length !== 64) continue;
      const storedBuf = Buffer.from(storedHex, 'hex');
      if (storedBuf.length === candidateHash.length && timingSafeEqual(storedBuf, candidateHash)) {
        matchedRow = row;
        break;
      }
    }
    if (!matchedRow) return fail(401, 'node_unauthorized');
    if (String(matchedRow.status) === 'revoked') return fail(403, 'node_revoked');
    if (!matchedRow.pairing_expires_at || Number(matchedRow.pairing_expires_at) <= now) {
      return fail(401, 'node_pairing_token_expired');
    }

    const nodeId = String(matchedRow.id);
    const osName = normalizeNodeOs(input.os || 'linux');
    const archName = normalizeNodeArch(input.arch || 'amd64');
    const existingLabels = safeJsonObject<Record<string, string>>(matchedRow.labels, {});
    let incomingLabels: Record<string, string> = {};
    if (input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels)) {
      try { incomingLabels = normalizeNodeLabels(input.labels); } catch { incomingLabels = {}; }
    }
    const mergedLabels = { ...incomingLabels, ...existingLabels, arch: archName };
    const transport = (['websocket', 'long_poll', 'direct'].includes(String(input.transport)) ? String(input.transport) : 'websocket') as 'websocket' | 'long_poll' | 'direct';
    const nextStatus: NodeStatus = String(matchedRow.status) === 'draining' ? 'draining' : 'online';
    const keyFingerprint = createHash('sha256').update(publicKeyPem).digest('hex');

    const session = this.store.transaction(() => {
      // One-time pairing token is immediately replaced with the node's Ed25519 public key fingerprint.
      this.store.run(
        `UPDATE compute_nodes
         SET driver=?, os=?, arch=?, labels=?, status=?, transport=?, protocol_version=?, agent_version=?,
             auth_type='public_key', credential_hash=?, public_key=?, pairing_expires_at=NULL,
             paired_at=COALESCE(paired_at, ?), last_heartbeat_at=?, metrics=?, updated_at=?
         WHERE id=?`,
        driver,
        osName,
        archName,
        JSON.stringify(mergedLabels),
        nextStatus,
        transport,
        negotiated,
        input.agentVersion ? String(input.agentVersion).slice(0, 128) : null,
        keyFingerprint,
        publicKeyPem,
        nowIso,
        nowIso,
        JSON.stringify(input.metrics && typeof input.metrics === 'object' ? input.metrics : safeJsonObject(matchedRow.metrics, {})),
        nowIso,
        nodeId,
      );
      if (nextStatus === 'online') {
        this.store.run(
          "UPDATE repository_node_bindings SET state='active', updated_at=? WHERE node_id=? AND state='offline'",
          nowIso,
          nodeId,
        );
      }
      const created = this.createSessionRow(nodeId, transport);
      this.store.audit('node:' + nodeId, 'cluster.node.paired', nodeId);
      return created;
    });

    return {
      node: this.getNode(nodeId)!,
      ...session,
      protocol_version: negotiated,
    };
  }

  exchangeSession(input: {
    nodeId: string;
    assertion: unknown;
    protocolVersion: unknown;
    minProtocolVersion?: unknown;
    agentVersion?: string;
    os?: string;
    arch?: string;
    transport?: string;
    metrics?: NodeMetrics;
  }): {
    node: ComputeNodeRecord;
    session_id: string;
    session_token: string;
    session_expires_at: string;
    protocol_version: number;
  } {
    const negotiated = this.assertProtocolCompatible(input.protocolVersion, input.minProtocolVersion);
    const nodeId = String(input.nodeId || '').trim();
    if (!isValidNodeId(nodeId) || nodeId === LOCAL_NODE_ID) fail(401, 'node_unauthorized');

    const row = this.store.get('SELECT * FROM compute_nodes WHERE id=?', nodeId);
    if (!row || String(row.kind) !== 'remote') return fail(401, 'node_unauthorized');
    if (String(row.status) === 'revoked') return fail(403, 'node_revoked');
    if (!row.public_key) return fail(401, 'node_not_paired');

    const now = this.now();
    // Prune expired replay nonces
    for (const [k, exp] of this.seenNonces) {
      if (exp <= now) this.seenNonces.delete(k);
    }
    const valid = verifyNodeAssertion(nodeId, String(row.public_key), input.assertion, { nowMs: now, maxSkewMs: 120_000 });
    if (!valid) fail(401, 'node_unauthorized');
    const nonceKey = `${nodeId}:${String((input.assertion as any).nonce)}`;
    if (this.seenNonces.has(nonceKey)) fail(401, 'node_assertion_replayed');
    this.seenNonces.set(nonceKey, now + 180_000);

    const nowIso = new Date(now).toISOString();
    const osName = input.os ? normalizeNodeOs(input.os) : String(row.os || 'linux');
    const archName = input.arch ? normalizeNodeArch(input.arch) : String(row.arch || 'amd64');
    const transport = (['websocket', 'long_poll', 'direct'].includes(String(input.transport)) ? String(input.transport) : String(row.transport || 'websocket')) as 'websocket' | 'long_poll' | 'direct';
    const nextStatus: NodeStatus = String(row.status) === 'draining' ? 'draining' : 'online';
    const existingLabels = safeJsonObject<Record<string, string>>(row.labels, {});
    const mergedLabels = { ...existingLabels, arch: archName };

    const session = this.store.transaction(() => {
      this.store.run(
        `UPDATE compute_nodes
         SET os=?, arch=?, labels=?, status=?, transport=?, protocol_version=?, agent_version=?,
             last_heartbeat_at=?, metrics=?, updated_at=?
         WHERE id=?`,
        osName,
        archName,
        JSON.stringify(mergedLabels),
        nextStatus,
        transport,
        negotiated,
        input.agentVersion ? String(input.agentVersion).slice(0, 128) : row.agent_version,
        nowIso,
        JSON.stringify(input.metrics && typeof input.metrics === 'object' ? input.metrics : safeJsonObject(row.metrics, {})),
        nowIso,
        nodeId,
      );
      if (nextStatus === 'online') {
        this.store.run(
          "UPDATE repository_node_bindings SET state='active', updated_at=? WHERE node_id=? AND state='offline'",
          nowIso,
          nodeId,
        );
      }
      return this.createSessionRow(nodeId, transport);
    });

    return {
      node: this.getNode(nodeId)!,
      ...session,
      protocol_version: negotiated,
    };
  }

  authenticateSession(authorization: string | undefined, expectedNodeId?: string): {
    session_id: string;
    node_id: string;
    node: ComputeNodeRecord;
    expires_at: number;
  } {
    const raw = String(authorization || '').trim();
    const match = /^Bearer\s+(bnsess_([a-f0-9]{12})\.([a-f0-9]{48}))$/.exec(raw);
    if (!match) return fail(401, 'node_unauthorized');
    const [, , sessionId, secret] = match;
    const row = this.store.get('SELECT * FROM compute_node_sessions WHERE id=?', sessionId!);
    if (!row || row.revoked_at !== null || Number(row.expires_at) <= this.now()) {
      return fail(401, 'node_session_invalid');
    }
    const candidateHash = Buffer.from(digest(secret!), 'hex');
    const storedHash = Buffer.from(String(row.token_hash || ''), 'hex');
    if (storedHash.length !== candidateHash.length || !timingSafeEqual(storedHash, candidateHash)) {
      return fail(401, 'node_session_invalid');
    }
    const nodeId = String(row.node_id);
    if (expectedNodeId && expectedNodeId !== nodeId) {
      return fail(403, 'node_identity_mismatch');
    }
    const node = this.getNode(nodeId);
    if (!node) return fail(401, 'node_session_invalid');
    if (node.status === 'revoked') return fail(403, 'node_revoked');

    const nowIso = new Date(this.now()).toISOString();
    this.store.run('UPDATE compute_node_sessions SET last_seen_at=? WHERE id=?', nowIso, sessionId!);
    return {
      session_id: sessionId!,
      node_id: nodeId,
      node,
      expires_at: Number(row.expires_at),
    };
  }

  recordHeartbeat(
    nodeId: string,
    input: {
      metrics?: NodeMetrics;
      transport?: 'local' | 'websocket' | 'long_poll' | 'direct';
      os?: string;
      arch?: string;
      agentVersion?: string;
    },
  ): ComputeNodeRecord {
    const node = this.getNode(nodeId);
    if (!node) return fail(404, 'node_not_found');
    if (node.status === 'revoked') return fail(403, 'node_revoked');

    const nowIso = new Date(this.now()).toISOString();
    const nextStatus: NodeStatus = node.status === 'draining' ? 'draining' : 'online';
    const nextMetrics = input.metrics && typeof input.metrics === 'object' ? input.metrics : node.metrics;
    const nextTransport = input.transport ?? node.transport;
    const nextOs = input.os ? normalizeNodeOs(input.os) : node.os;
    const nextArch = input.arch ? normalizeNodeArch(input.arch) : node.arch;
    const nextAgentVersion = input.agentVersion ? String(input.agentVersion).slice(0, 128) : node.agent_version;

    this.store.transaction(() => {
      this.store.run(
        `UPDATE compute_nodes
         SET status=?, transport=?, os=?, arch=?, agent_version=?, last_heartbeat_at=?, metrics=?, updated_at=?
         WHERE id=?`,
        nextStatus,
        nextTransport,
        nextOs,
        nextArch,
        nextAgentVersion,
        nowIso,
        JSON.stringify(nextMetrics),
        nowIso,
        nodeId,
      );
      if (nextStatus === 'online') {
        this.store.run(
          "UPDATE repository_node_bindings SET state='active', updated_at=? WHERE node_id=? AND state='offline'",
          nowIso,
          nodeId,
        );
      }
    });
    return this.getNode(nodeId)!;
  }

  markNodeOffline(nodeId: string): ComputeNodeRecord | null {
    const node = this.getNode(nodeId);
    if (!node || node.status === 'revoked') return node;
    const nowIso = new Date(this.now()).toISOString();
    this.store.transaction(() => {
      if (node.status === 'online') {
        this.store.run("UPDATE compute_nodes SET status='offline', updated_at=? WHERE id=?", nowIso, nodeId);
      }
      this.store.run(
        "UPDATE repository_node_bindings SET state='offline', updated_at=? WHERE node_id=? AND state IN ('bound','active')",
        nowIso,
        nodeId,
      );
    });
    return this.getNode(nodeId);
  }

  startDrain(nodeId: string, { timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS, actor }: { timeoutMs?: number; actor: string }): ComputeNodeRecord {
    const node = this.getNode(nodeId);
    if (!node) return fail(404, 'node_not_found');
    if (node.status === 'revoked') return fail(409, 'node_revoked');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 24 * 3600_000) {
      fail(400, 'invalid_drain_timeout');
    }
    const nowIso = new Date(this.now()).toISOString();
    this.store.transaction(() => {
      this.store.run(
        `UPDATE compute_nodes
         SET status='draining', drain_requested_at=COALESCE(drain_requested_at, ?), drain_timeout_ms=?, drained_at=NULL, updated_at=?
         WHERE id=?`,
        nowIso,
        timeoutMs,
        nowIso,
        nodeId,
      );
      this.store.run(
        "UPDATE repository_node_bindings SET state='draining', updated_at=? WHERE node_id=? AND state IN ('bound','active','offline')",
        nowIso,
        nodeId,
      );
      this.store.audit(actor, 'cluster.node.draining', nodeId);
    });
    return this.getNode(nodeId)!;
  }

  markNodeDrained(nodeId: string): ComputeNodeRecord | null {
    const node = this.getNode(nodeId);
    if (!node || node.status !== 'draining') return node;
    const nowIso = new Date(this.now()).toISOString();
    this.store.run(
      'UPDATE compute_nodes SET drained_at=COALESCE(drained_at, ?), updated_at=? WHERE id=?',
      nowIso,
      nowIso,
      nodeId,
    );
    return this.getNode(nodeId);
  }

  undrainNode(nodeId: string, { isOnline, actor }: { isOnline: boolean; actor: string }): ComputeNodeRecord {
    const node = this.getNode(nodeId);
    if (!node) return fail(404, 'node_not_found');
    if (node.status === 'revoked') return fail(409, 'node_revoked');
    if (node.status !== 'draining') return node;

    const nowIso = new Date(this.now()).toISOString();
    const nextStatus: NodeStatus = isOnline || node.kind === 'local' ? 'online' : 'offline';
    const nextBindingState: BindingState = nextStatus === 'online' ? 'active' : 'offline';
    this.store.transaction(() => {
      this.store.run(
        'UPDATE compute_nodes SET status=?, drain_requested_at=NULL, drain_timeout_ms=NULL, drained_at=NULL, updated_at=? WHERE id=?',
        nextStatus,
        nowIso,
        nodeId,
      );
      this.store.run(
        "UPDATE repository_node_bindings SET state=?, updated_at=? WHERE node_id=? AND state='draining'",
        nextBindingState,
        nowIso,
        nodeId,
      );
      this.store.audit(actor, 'cluster.node.undrained', nodeId);
    });
    return this.getNode(nodeId)!;
  }

  revokeNode(nodeId: string, { force = false, actor }: { force?: boolean; actor: string }): ComputeNodeRecord {
    const node = this.getNode(nodeId);
    if (!node) return fail(404, 'node_not_found');
    if (node.kind === 'local' || node.id === LOCAL_NODE_ID) return fail(409, 'cannot_revoke_local_node');

    const boundRepos = this.listRepositoriesOnNode(nodeId);
    if (boundRepos.length > 0 && !force) {
      fail(409, 'node_has_bound_projects', undefined, {
        detail: `节点仍绑定 ${boundRepos.length} 个项目，请先将项目改绑到其他节点或勾选强制撤销。`,
        repositories: boundRepos,
      });
    }

    const now = this.now();
    const nowIso = new Date(now).toISOString();
    this.store.transaction(() => {
      this.store.run(
        `UPDATE compute_nodes
         SET status='revoked', credential_hash=NULL, public_key=NULL, pairing_expires_at=NULL,
             revoked_at=COALESCE(revoked_at, ?), updated_at=?
         WHERE id=?`,
        nowIso,
        nowIso,
        nodeId,
      );
      this.store.run('UPDATE compute_node_sessions SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL', now, nodeId);
      this.store.run(
        "UPDATE repository_node_bindings SET state='offline', updated_at=? WHERE node_id=?",
        nowIso,
        nodeId,
      );
      this.store.run('DELETE FROM assistant_placements WHERE node_id=?', nodeId);
      this.store.audit(actor, 'cluster.node.revoked', nodeId);
    });
    return this.getNode(nodeId)!;
  }

  listRepositoriesOnNode(nodeId: string): string[] {
    if (nodeId === LOCAL_NODE_ID) {
      return this.store
        .all(
          `SELECT r.id FROM repositories r
           LEFT JOIN repository_node_bindings b ON b.repository_id=r.id
           WHERE COALESCE(b.node_id, 'local')=?
           ORDER BY r.id`,
          LOCAL_NODE_ID,
        )
        .map(row => String(row.id));
    }
    return this.store
      .all('SELECT repository_id FROM repository_node_bindings WHERE node_id=? ORDER BY repository_id', nodeId)
      .map(row => String(row.repository_id));
  }

  getRepositoryBinding(repositoryId: string): RepositoryNodeBinding {
    const row = this.store.get('SELECT * FROM repository_node_bindings WHERE repository_id=?', repositoryId);
    if (row) return rowToBinding(row);
    const local = this.getNode(LOCAL_NODE_ID);
    const defaultState: BindingState = local?.status === 'draining'
      ? 'draining'
      : local?.status === 'offline'
        ? 'offline'
        : 'active';
    return {
      repository_id: repositoryId,
      node_id: LOCAL_NODE_ID,
      target_node_id: null,
      previous_node_id: null,
      label_selector: {},
      state: defaultState,
      binding_epoch: 1,
      notes_node_id: LOCAL_NODE_ID,
      updated_at: local?.updated_at ?? new Date(this.now()).toISOString(),
    };
  }

  ensureRepositoryBinding(repositoryId: string, defaultNodeId = LOCAL_NODE_ID): RepositoryNodeBinding {
    const existing = this.store.get('SELECT * FROM repository_node_bindings WHERE repository_id=?', repositoryId);
    if (existing) return rowToBinding(existing);
    if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId)) {
      return this.getRepositoryBinding(repositoryId);
    }
    const nowIso = new Date(this.now()).toISOString();
    const targetNode = this.getNode(defaultNodeId) ?? this.ensureLocalNode();
    const initialState: BindingState = targetNode.status === 'draining'
      ? 'draining'
      : targetNode.status === 'online'
        ? 'active'
        : 'offline';
    this.store.run(
      `INSERT OR IGNORE INTO repository_node_bindings(
         repository_id,node_id,target_node_id,previous_node_id,label_selector,state,binding_epoch,notes_node_id,updated_at
       ) VALUES(?,?,NULL,NULL,'{}',?,1,?,?)`,
      repositoryId,
      targetNode.id,
      initialState,
      LOCAL_NODE_ID,
      nowIso,
    );
    return this.getRepositoryBinding(repositoryId);
  }

  beginRepositoryRebind(
    repositoryId: string,
    targetNodeId: string,
    { labelSelector = {}, force = false, actor }: { labelSelector?: Record<string, string>; force?: boolean; actor: string },
  ): {
    previous_node_id: string;
    target_node_id: string;
    old_epoch: number;
    rebind_epoch: number;
    previous_state: BindingState;
  } {
    if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId)) {
      fail(404, 'repository_not_found');
    }
    const targetNode = this.getNode(targetNodeId);
    if (!targetNode) return fail(404, 'node_not_found');
    if (targetNode.status !== 'online') return fail(409, 'target_node_not_online');

    let normalizedLabels: Record<string, string>;
    try {
      normalizedLabels = normalizeNodeLabels(labelSelector);
    } catch {
      return fail(400, 'invalid_node_labels');
    }

    return this.store.transaction(() => {
      const current = this.ensureRepositoryBinding(repositoryId);
      if (current.node_id === targetNodeId && current.state !== 'rebinding') {
        fail(409, 'repository_already_bound_to_node');
      }
      if (current.state === 'rebinding') {
        fail(409, 'repository_rebind_in_progress');
      }
      const runningTasks = Number(
        this.store.get('SELECT count(*) AS n FROM task_claims WHERE repository_id=?', repositoryId)?.n ?? 0,
      );
      if (runningTasks > 0 && !force) {
        fail(409, 'project_tasks_running', undefined, { detail: `项目当前有 ${runningTasks} 个运行中任务，请等任务结束后再切换节点。` });
      }
      const pendingOps = Number(
        this.store.get("SELECT count(*) AS n FROM environment_operations WHERE repository_id=? AND state='pending'", repositoryId)?.n ?? 0,
      );
      if (pendingOps > 0 && !force) {
        fail(409, 'environment_operation_pending');
      }
      const rebindEpoch = current.binding_epoch + 1;
      const nowIso = new Date(this.now()).toISOString();
      this.store.run(
        `UPDATE repository_node_bindings
         SET target_node_id=?, previous_node_id=?, label_selector=?, state='rebinding', binding_epoch=?, updated_at=?
         WHERE repository_id=? AND binding_epoch=?`,
        targetNodeId,
        current.node_id,
        JSON.stringify(normalizedLabels),
        rebindEpoch,
        nowIso,
        repositoryId,
        current.binding_epoch,
      );
      this.store.audit(actor, 'repository.node_rebind_started', `${current.node_id}->${targetNodeId}`, repositoryId);
      return {
        previous_node_id: current.node_id,
        target_node_id: targetNodeId,
        old_epoch: current.binding_epoch,
        rebind_epoch: rebindEpoch,
        previous_state: current.state,
      };
    });
  }

  completeRepositoryRebind(repositoryId: string, rebindEpoch: number, targetNodeId: string, actor: string): RepositoryNodeBinding {
    const nowIso = new Date(this.now()).toISOString();
    this.store.transaction(() => {
      const res = this.store.run(
        `UPDATE repository_node_bindings
         SET node_id=?, target_node_id=NULL, state='bound', binding_epoch=binding_epoch+1, updated_at=?
         WHERE repository_id=? AND binding_epoch=? AND state='rebinding'`,
        targetNodeId,
        nowIso,
        repositoryId,
        rebindEpoch,
      );
      if (Number(res.changes ?? 0) === 0) fail(409, 'binding_epoch_mismatch');
      // Fail closed on cached environment until the new node reports live state.
      this.store.run(
        "UPDATE project_environments SET state='provisioning', toolchain_pending=1, error=NULL WHERE repository_id=?",
        repositoryId,
      );
      this.store.audit(actor, 'repository.node_bound', targetNodeId, repositoryId);
    });
    return this.getRepositoryBinding(repositoryId);
  }

  abortRepositoryRebind(repositoryId: string, rebindEpoch: number, restoreState: BindingState): void {
    const nowIso = new Date(this.now()).toISOString();
    this.store.run(
      `UPDATE repository_node_bindings
       SET target_node_id=NULL, state=?, updated_at=?
       WHERE repository_id=? AND binding_epoch=? AND state='rebinding'`,
      restoreState === 'rebinding' ? 'active' : restoreState,
      nowIso,
      repositoryId,
      rebindEpoch,
    );
  }

  markBindingActive(repositoryId: string, nodeId: string): void {
    const existing = this.store.get(
      'SELECT state FROM repository_node_bindings WHERE repository_id=? AND node_id=?',
      repositoryId,
      nodeId,
    );
    if (existing?.state !== 'bound') return;
    const nowIso = new Date(this.now()).toISOString();
    this.store.run(
      "UPDATE repository_node_bindings SET state='active', updated_at=? WHERE repository_id=? AND node_id=? AND state='bound'",
      nowIso,
      repositoryId,
      nodeId,
    );
  }

  canStartProject(repositoryId: string): boolean {
    return isRepositoryNodeClaimable(this.store, repositoryId);
  }

  /**
   * Ensures a volume tracking row exists without rewriting an unchanged row (or overwriting a real Docker volume name
   * previously reported by live volume discovery) during high-frequency read-only probes.
   */
  ensureNodeVolume(
    repositoryId: string,
    nodeId: string,
    volumeKind: 'notes' | 'workspace',
    fallbackVolumeName: string,
  ): void {
    if (
      this.store.get(
        'SELECT 1 FROM repository_node_volumes WHERE repository_id=? AND node_id=? AND volume_kind=?',
        repositoryId,
        nodeId,
        volumeKind,
      )
    ) {
      return;
    }
    const nowIso = new Date(this.now()).toISOString();
    this.store.run(
      `INSERT OR IGNORE INTO repository_node_volumes(repository_id,node_id,volume_kind,volume_name,created_at,reclaim_pending,updated_at)
       VALUES(?,?,?,?,NULL,0,?)`,
      repositoryId,
      nodeId,
      volumeKind,
      fallbackVolumeName,
      nowIso,
    );
  }

  recordNodeVolume(
    repositoryId: string,
    nodeId: string,
    volumeKind: 'notes' | 'workspace',
    volumeName: string,
    createdAt: string | null = null,
    reclaimPending = false,
  ): void {
    const existing = this.store.get(
      'SELECT volume_name, created_at, reclaim_pending FROM repository_node_volumes WHERE repository_id=? AND node_id=? AND volume_kind=?',
      repositoryId,
      nodeId,
      volumeKind,
    );
    const nextCreatedAt = createdAt ?? (existing?.created_at ? String(existing.created_at) : null);
    const nextReclaim = reclaimPending || Number(existing?.reclaim_pending ?? 0) === 1 ? 1 : 0;
    if (
      existing &&
      String(existing.volume_name) === volumeName &&
      (existing.created_at ? String(existing.created_at) : null) === nextCreatedAt &&
      Number(existing.reclaim_pending) === nextReclaim
    ) {
      return;
    }
    const nowIso = new Date(this.now()).toISOString();
    this.store.run(
      `INSERT INTO repository_node_volumes(repository_id,node_id,volume_kind,volume_name,created_at,reclaim_pending,updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(repository_id,node_id,volume_kind) DO UPDATE SET
         volume_name=excluded.volume_name,
         created_at=COALESCE(excluded.created_at, repository_node_volumes.created_at),
         reclaim_pending=CASE WHEN excluded.reclaim_pending=1 THEN 1 ELSE repository_node_volumes.reclaim_pending END,
         updated_at=excluded.updated_at
       WHERE repository_node_volumes.volume_name IS NOT excluded.volume_name
          OR repository_node_volumes.created_at IS NOT COALESCE(excluded.created_at, repository_node_volumes.created_at)
          OR repository_node_volumes.reclaim_pending IS NOT (CASE WHEN excluded.reclaim_pending=1 THEN 1 ELSE repository_node_volumes.reclaim_pending END)`,
      repositoryId,
      nodeId,
      volumeKind,
      volumeName,
      createdAt,
      reclaimPending ? 1 : 0,
      nowIso,
    );
  }

  markVolumeReclaimPending(repositoryId: string, nodeId: string, volumeKind: 'notes' | 'workspace', volumeName?: string): void {
    const existing = this.store.get(
      'SELECT reclaim_pending FROM repository_node_volumes WHERE repository_id=? AND node_id=? AND volume_kind=?',
      repositoryId,
      nodeId,
      volumeKind,
    );
    if (existing && Number(existing.reclaim_pending) === 1) return;
    const nowIso = new Date(this.now()).toISOString();
    this.store.run(
      `INSERT INTO repository_node_volumes(repository_id,node_id,volume_kind,volume_name,created_at,reclaim_pending,updated_at)
       VALUES(?,?,?,?,?,1,?)
       ON CONFLICT(repository_id,node_id,volume_kind) DO UPDATE SET reclaim_pending=1, updated_at=excluded.updated_at
       WHERE repository_node_volumes.reclaim_pending IS NOT 1`,
      repositoryId,
      nodeId,
      volumeKind,
      volumeName ?? `dbot-${nodeId}-${repositoryId}-${volumeKind}`,
      nowIso,
      nowIso,
    );
  }

  clearNodeVolume(repositoryId: string, nodeId: string, volumeKind?: 'notes' | 'workspace'): void {
    if (volumeKind) {
      this.store.run(
        'DELETE FROM repository_node_volumes WHERE repository_id=? AND node_id=? AND volume_kind=?',
        repositoryId,
        nodeId,
        volumeKind,
      );
    } else {
      this.store.run('DELETE FROM repository_node_volumes WHERE repository_id=? AND node_id=?', repositoryId, nodeId);
    }
  }

  listNodeVolumes(options: { repositoryId?: string; nodeId?: string; volumeKind?: 'notes' | 'workspace'; reclaimPendingOnly?: boolean } = {}): RepositoryNodeVolumeRecord[] {
    const clauses: string[] = [];
    const args: any[] = [];
    if (options.repositoryId) { clauses.push('repository_id=?'); args.push(options.repositoryId); }
    if (options.nodeId) { clauses.push('node_id=?'); args.push(options.nodeId); }
    if (options.volumeKind) { clauses.push('volume_kind=?'); args.push(options.volumeKind); }
    if (options.reclaimPendingOnly) { clauses.push('reclaim_pending=1'); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.store
      .all(`SELECT * FROM repository_node_volumes ${where} ORDER BY repository_id, node_id, volume_kind`, ...args)
      .map(row => ({
        repository_id: String(row.repository_id),
        node_id: String(row.node_id),
        volume_kind: row.volume_kind === 'workspace' ? 'workspace' : 'notes',
        volume_name: String(row.volume_name),
        created_at: row.created_at ? String(row.created_at) : null,
        reclaim_pending: Number(row.reclaim_pending) === 1,
        updated_at: String(row.updated_at),
      }));
  }

  // ---- Assistant Computer Single-Writer Placement (CAS) ----

  getAssistantPlacement(owner: string): AssistantPlacementRecord | null {
    const row = this.store.get('SELECT * FROM assistant_placements WHERE owner=?', owner);
    return row ? rowToPlacement(row) : null;
  }

  listAssistantPlacements(nodeId?: string): AssistantPlacementRecord[] {
    const rows = nodeId
      ? this.store.all('SELECT * FROM assistant_placements WHERE node_id=? ORDER BY updated_at DESC', nodeId)
      : this.store.all('SELECT * FROM assistant_placements ORDER BY updated_at DESC');
    return rows.map(rowToPlacement);
  }

  /**
   * Picks the best online, non-draining node for an assistant computer turn.
   * Respects warm-session affinity to the current placement node when healthy and within `affinity_until`.
   */
  selectAssistantNode(
    owner: string,
    onlineNodeIds: ReadonlySet<string>,
    now = this.now(),
  ): { nodeId: string; existing: AssistantPlacementRecord | null } | null {
    const nodes = this.listNodes().filter(
      n => n.status === 'online' && onlineNodeIds.has(n.id) && !n.metrics?.disk_low,
    );
    if (!nodes.length) return null;

    const existing = this.getAssistantPlacement(owner);
    if (existing) {
      const currentNode = nodes.find(n => n.id === existing.node_id);
      if (currentNode && (existing.state === 'busy' || existing.affinity_until > now)) {
        return { nodeId: currentNode.id, existing };
      }
    }

    // Score by available memory & lowest busy container count (preferring nodes with headroom).
    const score = (node: ComputeNodeRecord): number => {
      const m = node.metrics || {};
      const freeMem = typeof m.memory_free_mb === 'number' && Number.isFinite(m.memory_free_mb)
        ? m.memory_free_mb
        : typeof m.memory_total_mb === 'number' && Number.isFinite(m.memory_total_mb)
          ? Math.max(0, m.memory_total_mb - (Number(m.memory_used_mb) || 0))
          : 8192;
      const busy = (Number(m.busy_assistant_containers) || 0) + (Number(m.busy_project_containers) || 0);
      const loadPenalty = typeof m.cpu_load_1m === 'number' && Number.isFinite(m.cpu_load_1m) ? m.cpu_load_1m * 512 : 0;
      const affinityBonus = existing && existing.node_id === node.id ? 2048 : 0;
      return freeMem - busy * 1024 - loadPenalty + affinityBonus;
    };

    const sorted = [...nodes].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    return { nodeId: sorted[0]!.id, existing };
  }

  casReserveAssistantPlacement(input: {
    owner: string;
    generation: number;
    turn: string;
    targetNodeId: string;
    leaseTtlMs?: number;
    affinityMs?: number;
    now?: number;
  }):
    | { action: 'busy'; node_id: string; epoch: number; turn: string | null }
    | { action: 'acquire'; node_id: string; epoch: number; reused_placement: boolean }
    | { action: 'migrate'; from_node_id: string; to_node_id: string; epoch: number; previous_generation: number; previous_lease_expired: boolean } {
    const now = input.now ?? this.now();
    const nowIso = new Date(now).toISOString();
    const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_ASSISTANT_LEASE_TTL_MS;
    const affinityMs = input.affinityMs ?? DEFAULT_ASSISTANT_AFFINITY_MS;

    return this.store.transaction(() => {
      const existing = this.getAssistantPlacement(input.owner);
      if (!existing) {
        this.store.run(
          `INSERT INTO assistant_placements(owner,node_id,epoch,generation,turn,state,lease_expires_at,affinity_until,updated_at)
           VALUES(?,?,1,?,?,'acquiring',?,?,?)`,
          input.owner,
          input.targetNodeId,
          input.generation,
          input.turn,
          now + leaseTtlMs,
          now + affinityMs,
          nowIso,
        );
        return { action: 'acquire' as const, node_id: input.targetNodeId, epoch: 1, reused_placement: false };
      }

      const activeLease = existing.lease_expires_at > now;
      if (['busy', 'acquiring', 'migrating', 'releasing'].includes(existing.state) && activeLease) {
        if (existing.turn === input.turn && existing.node_id === input.targetNodeId) {
          this.store.run(
            `UPDATE assistant_placements SET generation=?, lease_expires_at=?, affinity_until=?, updated_at=?
             WHERE owner=? AND epoch=?`,
            input.generation,
            now + leaseTtlMs,
            now + affinityMs,
            nowIso,
            input.owner,
            existing.epoch,
          );
          return { action: 'acquire' as const, node_id: existing.node_id, epoch: existing.epoch, reused_placement: true };
        }
        return { action: 'busy' as const, node_id: existing.node_id, epoch: existing.epoch, turn: existing.turn };
      }

      const nextEpoch = existing.epoch + 1;
      if (existing.node_id === input.targetNodeId) {
        const res = this.store.run(
          `UPDATE assistant_placements
           SET epoch=?, generation=?, turn=?, state='acquiring', lease_expires_at=?, affinity_until=?, updated_at=?
           WHERE owner=? AND epoch=?`,
          nextEpoch,
          input.generation,
          input.turn,
          now + leaseTtlMs,
          now + affinityMs,
          nowIso,
          input.owner,
          existing.epoch,
        );
        if (Number(res.changes ?? 0) === 0) fail(409, 'assistant_placement_conflict');
        return { action: 'acquire' as const, node_id: input.targetNodeId, epoch: nextEpoch, reused_placement: false };
      }

      // Cross-node migration: lock placement in 'migrating' with bumped epoch BEFORE stopping old container.
      const res = this.store.run(
        `UPDATE assistant_placements
         SET epoch=?, turn=?, state='migrating', lease_expires_at=?, updated_at=?
         WHERE owner=? AND epoch=?`,
        nextEpoch,
        input.turn,
        now + leaseTtlMs,
        nowIso,
        input.owner,
        existing.epoch,
      );
      if (Number(res.changes ?? 0) === 0) fail(409, 'assistant_placement_conflict');
      return {
        action: 'migrate' as const,
        from_node_id: existing.node_id,
        to_node_id: input.targetNodeId,
        epoch: nextEpoch,
        previous_generation: existing.generation,
        previous_lease_expired: !activeLease,
      };
    });
  }

  casCommitAssistantMigration(input: {
    owner: string;
    epoch: number;
    toNodeId: string;
    generation: number;
    turn: string;
    leaseTtlMs?: number;
    affinityMs?: number;
    now?: number;
  }): number {
    const now = input.now ?? this.now();
    const nowIso = new Date(now).toISOString();
    const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_ASSISTANT_LEASE_TTL_MS;
    const affinityMs = input.affinityMs ?? DEFAULT_ASSISTANT_AFFINITY_MS;
    const nextEpoch = input.epoch + 1;
    const res = this.store.run(
      `UPDATE assistant_placements
       SET node_id=?, epoch=?, generation=?, turn=?, state='acquiring', lease_expires_at=?, affinity_until=?, updated_at=?
       WHERE owner=? AND epoch=? AND state='migrating'`,
      input.toNodeId,
      nextEpoch,
      input.generation,
      input.turn,
      now + leaseTtlMs,
      now + affinityMs,
      nowIso,
      input.owner,
      input.epoch,
    );
    if (Number(res.changes ?? 0) === 0) fail(409, 'assistant_placement_conflict');
    return nextEpoch;
  }

  casAbortAssistantMigration(owner: string, epoch: number): void {
    const nowIso = new Date(this.now()).toISOString();
    this.store.run(
      `UPDATE assistant_placements SET state='idle', turn=NULL, lease_expires_at=0, updated_at=?
       WHERE owner=? AND epoch=? AND state='migrating'`,
      nowIso,
      owner,
      epoch,
    );
  }

  casActivateAssistantPlacement(input: {
    owner: string;
    nodeId: string;
    epoch: number;
    turn: string;
    leaseTtlMs?: number;
    affinityMs?: number;
    now?: number;
  }): boolean {
    const now = input.now ?? this.now();
    const nowIso = new Date(now).toISOString();
    const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_ASSISTANT_LEASE_TTL_MS;
    const affinityMs = input.affinityMs ?? DEFAULT_ASSISTANT_AFFINITY_MS;
    const res = this.store.run(
      `UPDATE assistant_placements
       SET state='busy', lease_expires_at=?, affinity_until=?, updated_at=?
       WHERE owner=? AND node_id=? AND epoch=? AND turn=? AND state IN ('acquiring','busy')`,
      now + leaseTtlMs,
      now + affinityMs,
      nowIso,
      input.owner,
      input.nodeId,
      input.epoch,
      input.turn,
    );
    return Number(res.changes ?? 0) > 0;
  }

  casRenewAssistantPlacement(input: {
    owner: string;
    nodeId: string;
    turn: string;
    epoch?: number;
    leaseTtlMs?: number;
    now?: number;
  }): { renewed: boolean; epoch: number | null; lease_expires_at: number | null } {
    const now = input.now ?? this.now();
    const nowIso = new Date(now).toISOString();
    const leaseExpiresAt = now + (input.leaseTtlMs ?? DEFAULT_ASSISTANT_LEASE_TTL_MS);
    return this.store.transaction(() => {
      const existing = this.getAssistantPlacement(input.owner);
      if (
        !existing ||
        existing.node_id !== input.nodeId ||
        existing.turn !== input.turn ||
        existing.state !== 'busy' ||
        (input.epoch !== undefined && existing.epoch !== input.epoch)
      ) {
        return { renewed: false, epoch: existing?.epoch ?? null, lease_expires_at: null };
      }
      const res = this.store.run(
        `UPDATE assistant_placements SET lease_expires_at=?, updated_at=?
         WHERE owner=? AND node_id=? AND epoch=? AND turn=? AND state='busy'`,
        leaseExpiresAt,
        nowIso,
        input.owner,
        input.nodeId,
        existing.epoch,
        input.turn,
      );
      return {
        renewed: Number(res.changes ?? 0) > 0,
        epoch: existing.epoch,
        lease_expires_at: leaseExpiresAt,
      };
    });
  }

  casReleaseAssistantPlacement(input: {
    owner: string;
    nodeId: string;
    turn?: string | null;
    epoch?: number;
    remove?: boolean;
    affinityMs?: number;
    now?: number;
  }): boolean {
    const now = input.now ?? this.now();
    const nowIso = new Date(now).toISOString();
    const affinityUntil = now + (input.affinityMs ?? DEFAULT_ASSISTANT_AFFINITY_MS);
    return this.store.transaction(() => {
      const existing = this.getAssistantPlacement(input.owner);
      if (!existing || existing.node_id !== input.nodeId) return false;
      if (input.turn && existing.turn && existing.turn !== input.turn) return false;
      if (input.epoch !== undefined && existing.epoch !== input.epoch) return false;
      if (input.remove) {
        const res = this.store.run(
          'DELETE FROM assistant_placements WHERE owner=? AND node_id=? AND epoch=?',
          input.owner,
          input.nodeId,
          existing.epoch,
        );
        return Number(res.changes ?? 0) > 0;
      }
      const res = this.store.run(
        `UPDATE assistant_placements
         SET state='idle', turn=NULL, lease_expires_at=0, affinity_until=?, updated_at=?
         WHERE owner=? AND node_id=? AND epoch=?`,
        affinityUntil,
        nowIso,
        input.owner,
        input.nodeId,
        existing.epoch,
      );
      return Number(res.changes ?? 0) > 0;
    });
  }

  deleteAssistantPlacement(owner: string, expectedNodeId?: string): void {
    if (expectedNodeId) {
      this.store.run('DELETE FROM assistant_placements WHERE owner=? AND node_id=?', owner, expectedNodeId);
    } else {
      this.store.run('DELETE FROM assistant_placements WHERE owner=?', owner);
    }
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
