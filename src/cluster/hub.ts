import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PassThrough, type Duplex } from 'node:stream';
import { fail, fields, HttpError, object, randomId, type Json } from '../core/security.js';
import type { SyncTokenService } from '../sync/storage.js';
import { isSyncNamespaceName } from '../sync/namespaces.js';
import type { SyncMode, SyncNamespaceName } from '../sync/types.js';
import { defaultModelGateway, maxGatewayRequestBytes, type ModelGatewayHub } from '../harness/model-gateway.js';
import { upgradeHttpToWs, type WsConnection } from '../../runner/wire-protocol.mjs';
import {
  DEFAULT_NODE_HEARTBEAT_MS,
  DEFAULT_NODE_LONG_POLL_MS,
  DEFAULT_NODE_OFFLINE_AFTER_MS,
  MAX_NODE_CONTROL_FRAME_BYTES,
  MAX_NODE_LONG_POLL_MS,
  NODE_AGENT_PROTOCOL_VERSION,
} from '../../runner/node-protocol.mjs';
import { ClusterStore, LOCAL_NODE_ID, type NodeMetrics } from './storage.js';

export interface NodeDispatchOptions {
  operationId?: string;
  bindingEpoch?: number;
  timeoutMs?: number;
  onProgress?: (event: { seq: number; chunk?: string; progress?: Json }) => void;
}

export interface NodeTunnelStream extends Duplex {
  readonly tunnelId: string;
  readonly nodeId: string;
  readonly host: string;
  readonly port: number;
}

interface PendingOp {
  operationId: string;
  nodeId: string;
  method: string;
  path: string;
  input: Json | undefined;
  bindingEpoch?: number;
  acked: boolean;
  lastSeq: number;
  chunks: Map<number, Buffer>;
  totalChunks: number | null;
  onProgress?: NodeDispatchOptions['onProgress'];
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface PollWaiter {
  nodeId: string;
  sessionId: string;
  resolve: (messages: Json[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveWsSession {
  nodeId: string;
  sessionId: string;
  ws: WsConnection;
  pingTimer: ReturnType<typeof setInterval>;
}

interface PendingTunnel {
  tunnelId: string;
  nodeId: string;
  host: string;
  port: number;
  opened: boolean;
  stream: PassThrough;
  onOpenResolve?: (stream: NodeTunnelStream) => void;
  onOpenReject?: (error: Error) => void;
  openTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

interface ActiveWsModelStream {
  streamId: string;
  nodeId: string;
  reqStream: PassThrough;
  aborted: boolean;
}

async function readJsonPayload(req: IncomingMessage, limit: number): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) fail(413, 'payload_too_large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return object(JSON.parse(raw));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return fail(400, 'invalid_json');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export interface ClusterHubOptions {
  clusterStore: ClusterStore;
  syncTokens?: SyncTokenService;
  modelGateway?: ModelGatewayHub;
  imageTag?: string;
  heartbeatIntervalMs?: number;
  offlineAfterMs?: number;
  longPollMaxMs?: number;
  /** Optional policy hook for assistant project-tools mount authorization on a node. */
  isProjectToolAuthorizedOnNode?: (nodeId: string, repositoryId: string) => boolean;
}

/**
 * Control-plane bidirectional transport hub for remote Linux Docker `node-agent` instances.
 * Supports WebSocket primary channel, bounded <=25s HTTPS long-polling fallback, optional intranet direct HTTP,
 * async `operation_id` submission with resumable streams & chunked results, scoped `SyncTokenService` brokering,
 * control-plane `ModelGatewayHub` streaming proxy, and a default-deny TCP tunnel primitive for #1379.
 */
export class ClusterHub extends EventEmitter {
  readonly clusterStore: ClusterStore;
  private syncTokens?: SyncTokenService;
  private readonly modelGateway: ModelGatewayHub;
  private readonly imageTag: string | null;
  private readonly heartbeatIntervalMs: number;
  private readonly offlineAfterMs: number;
  private readonly longPollMaxMs: number;
  private readonly isProjectToolAuthorizedOnNode?: (nodeId: string, repositoryId: string) => boolean;

  private readonly wsSessions = new Map<string, ActiveWsSession>();
  private readonly pollWaiters = new Map<string, PollWaiter>();
  private readonly outboundQueues = new Map<string, Json[]>();
  private readonly operations = new Map<string, PendingOp>();
  private readonly tunnels = new Map<string, PendingTunnel>();
  private readonly wsModelStreams = new Map<string, ActiveWsModelStream>();
  private readonly directSessions = new Map<string, string>(); // nodeId -> latest bearer token for optional direct calls
  private staleTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: ClusterHubOptions) {
    super();
    this.clusterStore = options.clusterStore;
    this.syncTokens = options.syncTokens;
    this.modelGateway = options.modelGateway ?? defaultModelGateway;
    this.imageTag = options.imageTag?.trim() || null;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_NODE_HEARTBEAT_MS;
    this.offlineAfterMs = options.offlineAfterMs ?? DEFAULT_NODE_OFFLINE_AFTER_MS;
    this.longPollMaxMs = Math.min(MAX_NODE_LONG_POLL_MS, Math.max(1_000, options.longPollMaxMs ?? DEFAULT_NODE_LONG_POLL_MS));
    this.isProjectToolAuthorizedOnNode = options.isProjectToolAuthorizedOnNode;
  }

  setSyncTokens(tokens: SyncTokenService): void {
    this.syncTokens = tokens;
  }

  start(): void {
    if (this.staleTimer || this.closed) return;
    this.staleTimer = setInterval(() => {
      try { this.sweepStaleNodes(); } catch { /* never crash event loop */ }
    }, Math.min(10_000, Math.max(2_000, Math.floor(this.offlineAfterMs / 3))));
    this.staleTimer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.staleTimer);
    this.staleTimer = undefined;

    for (const active of [...this.wsSessions.values()]) {
      clearInterval(active.pingTimer);
      try { active.ws.close(1001, 'center_shutdown'); } catch {}
    }
    this.wsSessions.clear();

    for (const waiter of [...this.pollWaiters.values()]) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.pollWaiters.clear();

    for (const op of [...this.operations.values()]) {
      clearTimeout(op.timer);
      op.reject(new HttpError(503, 'manager_unavailable'));
    }
    this.operations.clear();

    for (const tunnel of [...this.tunnels.values()]) {
      this._teardownTunnel(tunnel, new HttpError(503, 'node_disconnected'));
    }
    this.tunnels.clear();

    for (const ms of [...this.wsModelStreams.values()]) {
      ms.aborted = true;
      ms.reqStream.destroy();
    }
    this.wsModelStreams.clear();
  }

  isNodeConnected(nodeId: string): boolean {
    if (nodeId === LOCAL_NODE_ID) return true;
    const ws = this.wsSessions.get(nodeId);
    if (ws?.ws.open) return true;
    if (this.pollWaiters.has(nodeId)) return true;
    const node = this.clusterStore.getNode(nodeId);
    if (!node || !['online', 'draining'].includes(node.status)) return false;
    if (node.last_heartbeat_at) {
      const seen = Date.parse(node.last_heartbeat_at);
      if (Number.isFinite(seen) && this.clusterStore.now() - seen <= this.offlineAfterMs) return true;
    }
    return false;
  }

  connectedNodeIds(): Set<string> {
    const out = new Set<string>();
    for (const node of this.clusterStore.listNodes()) {
      if (node.id === LOCAL_NODE_ID && node.status === 'online') out.add(node.id);
      else if (node.kind === 'remote' && this.isNodeConnected(node.id)) out.add(node.id);
    }
    return out;
  }

  sweepStaleNodes(now = this.clusterStore.now()): string[] {
    const offlined: string[] = [];
    for (const node of this.clusterStore.listNodes()) {
      if (node.kind !== 'remote' || !['online', 'draining'].includes(node.status)) continue;
      if (this.wsSessions.get(node.id)?.ws.open || this.pollWaiters.has(node.id)) continue;
      const seen = node.last_heartbeat_at ? Date.parse(node.last_heartbeat_at) : 0;
      if (!Number.isFinite(seen) || now - seen > this.offlineAfterMs) {
        if (node.status === 'online') {
          this.clusterStore.markNodeOffline(node.id);
          offlined.push(node.id);
        }
      }
    }
    return offlined;
  }

  disconnectNode(nodeId: string, reason = 'node_revoked'): void {
    const active = this.wsSessions.get(nodeId);
    if (active) {
      clearInterval(active.pingTimer);
      this.wsSessions.delete(nodeId);
      try { active.ws.close(4003, reason); } catch {}
    }
    const waiter = this.pollWaiters.get(nodeId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pollWaiters.delete(nodeId);
      waiter.resolve([]);
    }
    this.outboundQueues.delete(nodeId);
    this.directSessions.delete(nodeId);
    for (const op of [...this.operations.values()]) {
      if (op.nodeId === nodeId) {
        clearTimeout(op.timer);
        this.operations.delete(op.operationId);
        op.reject(new HttpError(503, reason === 'node_revoked' ? 'node_revoked' : 'manager_unavailable'));
      }
    }
    for (const tunnel of [...this.tunnels.values()]) {
      if (tunnel.nodeId === nodeId) {
        this._teardownTunnel(tunnel, new HttpError(503, reason));
      }
    }
  }

  sendControlMessage(nodeId: string, message: Json): boolean {
    const active = this.wsSessions.get(nodeId);
    if (active?.ws.open) {
      return active.ws.sendJson(message);
    }
    const waiter = this.pollWaiters.get(nodeId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pollWaiters.delete(nodeId);
      const queued = this.outboundQueues.get(nodeId) ?? [];
      this.outboundQueues.delete(nodeId);
      waiter.resolve([...queued, message]);
      return true;
    }
    let queue = this.outboundQueues.get(nodeId);
    if (!queue) {
      queue = [];
      this.outboundQueues.set(nodeId, queue);
    }
    if (queue.length < 512) queue.push(message);
    return false;
  }

  /**
   * Dispatches a Manager-compatible RPC to a remote `node-agent` asynchronously via `operation_id`.
   * Long operations (e.g. 35m start/configure/refresh) never block a 25s HTTP poll; progress and
   * chunked results stream asynchronously and resume idempotently across reconnects.
   */
  async callNode(
    nodeId: string,
    method: string,
    path: string,
    input?: Json,
    options: NodeDispatchOptions = {},
  ): Promise<any> {
    if (this.closed) return fail(503, 'manager_unavailable');
    const node = this.clusterStore.getNode(nodeId);
    if (!node || node.kind !== 'remote') return fail(404, 'node_not_found');
    if (node.status === 'revoked') return fail(403, 'node_revoked');

    // Intranet direct-connect fallback when no reverse WS/long-poll session is active and direct_url is configured.
    if (!this.wsSessions.get(nodeId)?.ws.open && !this.pollWaiters.has(nodeId) && node.direct_url && this.directSessions.has(nodeId)) {
      return this.callDirectNode(node.direct_url, this.directSessions.get(nodeId)!, method, path, input, options.timeoutMs ?? 90_000);
    }

    if (!this.isNodeConnected(nodeId)) {
      fail(503, 'manager_unavailable');
    }

    const operationId =
      options.operationId ||
      (typeof input?.operation_id === 'string' && /^[a-f0-9]{48}$/.test(input.operation_id) ? input.operation_id : randomId());
    const timeoutMs = options.timeoutMs ?? 90_000;

    return new Promise((resolve, reject) => {
      const op: PendingOp = {
        operationId,
        nodeId,
        method,
        path,
        input,
        bindingEpoch: options.bindingEpoch,
        acked: false,
        lastSeq: 0,
        chunks: new Map(),
        totalChunks: null,
        onProgress: options.onProgress,
        resolve,
        reject,
      };
      if (timeoutMs > 0) {
        op.timer = setTimeout(() => {
          if (this.operations.get(operationId) === op) {
            this.operations.delete(operationId);
            reject(new HttpError(503, 'manager_unavailable'));
          }
        }, timeoutMs);
        op.timer.unref?.();
      }
      this.operations.set(operationId, op);

      this.sendControlMessage(nodeId, {
        type: 'op.submit',
        operation_id: operationId,
        node_id: nodeId,
        method,
        path,
        ...(input !== undefined ? { input } : {}),
        ...(options.bindingEpoch !== undefined ? { binding_epoch: options.bindingEpoch } : {}),
      });
    });
  }

  private async callDirectNode(
    directUrl: string,
    sessionToken: string,
    method: string,
    path: string,
    input: Json | undefined,
    timeoutMs: number,
  ): Promise<any> {
    const url = new URL(directUrl + path);
    const body = input !== undefined ? JSON.stringify(input) : undefined;
    let status = 0;
    let text = '';
    try {
      ({ status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            method,
            headers: {
              Authorization: 'Bearer ' + sessionToken,
              'Content-Type': 'application/json',
              ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            },
          },
          res => {
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', err => { clearTimeout(timer); reject(err); });
            res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }); });
          },
        );
        const timer = timeoutMs > 0 ? setTimeout(() => req.destroy(new Error('node_direct_timeout')), timeoutMs) : undefined;
        req.on('error', err => { clearTimeout(timer); reject(err); });
        req.end(body);
      }));
    } catch {
      return fail(503, 'manager_unavailable');
    }
    let parsed: Json;
    try { parsed = JSON.parse(text); } catch { return fail(503, 'manager_unavailable'); }
    if (status < 200 || status >= 300) {
      fail(status, typeof parsed.error === 'string' ? parsed.error : 'manager_unavailable');
    }
    return parsed.result;
  }

  /**
   * Default-deny TCP forwarding primitive over an authenticated node WebSocket session (reserved for #1379).
   * Only the control plane can initiate a tunnel, naming the exact target host:port; remote nodes default-deny
   * unless explicitly enabled and never allow containers to pick arbitrary destinations.
   */
  openTcpTunnel(
    nodeId: string,
    target: { host: string; port: number; timeoutMs?: number },
  ): Promise<NodeTunnelStream> {
    const active = this.wsSessions.get(nodeId);
    if (!active?.ws.open) {
      return Promise.reject(new HttpError(503, 'node_tunnel_requires_websocket'));
    }
    const host = String(target.host || '').trim();
    const port = Number(target.port);
    if (!host || host.length > 255 || /[\s\u0000-\u001f]/.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new HttpError(400, 'invalid_tunnel_target'));
    }
    const tunnelId = randomId().slice(0, 24);
    const timeoutMs = target.timeoutMs ?? 15_000;
    const stream = new PassThrough();

    return new Promise<NodeTunnelStream>((resolve, reject) => {
      const pending: PendingTunnel = {
        tunnelId,
        nodeId,
        host,
        port,
        opened: false,
        stream,
        onOpenResolve: resolve,
        onOpenReject: reject,
        closed: false,
      };
      pending.openTimer = setTimeout(() => {
        this._teardownTunnel(pending, new HttpError(504, 'tunnel_open_timeout'));
      }, timeoutMs);
      pending.openTimer.unref?.();

      const wrapped = new PassThrough();
      (wrapped as any)._write = (chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) => {
        if (pending.closed) { cb(new Error('tunnel_closed')); return; }
        const ok = this.sendControlMessage(nodeId, {
          type: 'tunnel.data',
          tunnel_id: tunnelId,
          data_b64: Buffer.from(chunk).toString('base64'),
        });
        cb(ok ? null : new Error('node_disconnected'));
      };
      const closeOutbound = () => {
        if (!pending.closed) {
          this.sendControlMessage(nodeId, { type: 'tunnel.close', tunnel_id: tunnelId });
          pending.closed = true;
          clearTimeout(pending.openTimer);
          this.tunnels.delete(tunnelId);
        }
      };
      wrapped.on('finish', closeOutbound);
      wrapped.on('close', closeOutbound);
      stream.on('data', chunk => { wrapped.push(chunk); });
      stream.on('end', () => { wrapped.push(null); });
      stream.on('error', err => { wrapped.destroy(err); });

      const publicTunnel = Object.assign(wrapped, {
        tunnelId,
        nodeId,
        host,
        port,
      }) as unknown as NodeTunnelStream;

      pending.onOpenResolve = () => resolve(publicTunnel);
      this.tunnels.set(tunnelId, pending);

      const sent = active.ws.sendJson({
        type: 'tunnel.open',
        tunnel_id: tunnelId,
        host,
        port,
      });
      if (!sent) {
        this._teardownTunnel(pending, new HttpError(503, 'node_disconnected'));
      }
    });
  }

  private _teardownTunnel(tunnel: PendingTunnel, error?: Error): void {
    if (tunnel.closed) return;
    tunnel.closed = true;
    clearTimeout(tunnel.openTimer);
    this.tunnels.delete(tunnel.tunnelId);
    if (!tunnel.opened && tunnel.onOpenReject) {
      tunnel.onOpenReject(error ?? new HttpError(502, 'tunnel_closed'));
    } else if (error) {
      tunnel.stream.destroy(error);
    } else {
      tunnel.stream.end();
    }
  }

  /**
   * Authorizes and mints a short-lived scoped `bsync_...` token strictly for namespaces/scopes
   * this authenticated `nodeId` is currently allowed to access.
   */
  issueNodeSyncToken(nodeId: string, namespaceRaw: unknown, scopeRaw: unknown, modeRaw: unknown): Json {
    if (!this.syncTokens) return fail(503, 'sync_not_configured');
    const node = this.clusterStore.getNode(nodeId);
    if (!node || node.kind !== 'remote') return fail(401, 'node_unauthorized');
    if (node.status === 'revoked') return fail(403, 'node_revoked');

    if (!isSyncNamespaceName(namespaceRaw)) return fail(400, 'sync_namespace_not_found');
    const namespace: SyncNamespaceName = namespaceRaw as SyncNamespaceName;
    const scope = typeof scopeRaw === 'string' ? scopeRaw.trim() : '';
    if (!scope || scope.length > 256 || /[\u0000-\u001f\u007f]/.test(scope)) fail(400, 'sync_invalid_scope');
    const mode: SyncMode = modeRaw === 'rw' ? 'rw' : modeRaw === 'ro' ? 'ro' : fail(400, 'sync_invalid_mode');

    const repoBoundToNode = (repoId: string, allowPreviousDuringRebind = false): boolean => {
      const binding = this.clusterStore.getRepositoryBinding(repoId);
      if (binding.node_id === nodeId) return true;
      if (allowPreviousDuringRebind && binding.state === 'rebinding' && binding.previous_node_id === nodeId) return true;
      return false;
    };

    const allowed = (() => {
      if (namespace === 'agent-tools') {
        return mode === 'ro';
      }
      if (namespace === 'skill-store') {
        if (mode !== 'ro') return false;
        if (scope === 'service' || scope.startsWith('service/sets/')) return true;
        const projMatch = /^projects\/([1-9]\d{0,19})(?:\/sets\/[a-f0-9]{16,64})?$/.exec(scope);
        return Boolean(projMatch && repoBoundToNode(projMatch[1]!));
      }
      if (namespace === 'project-tools') {
        if (mode !== 'ro') return false;
        const match = /^([1-9]\d{0,19})(?:@rev-[1-9]\d*)?$/.exec(scope);
        if (!match) return false;
        const repoId = match[1]!;
        return repoBoundToNode(repoId) || Boolean(this.isProjectToolAuthorizedOnNode?.(nodeId, repoId));
      }
      if (namespace === 'tool-results') {
        if (mode !== 'ro') return false;
        const projMatch = /^project_([1-9]\d{0,19})$/.exec(scope);
        if (projMatch) return repoBoundToNode(projMatch[1]!);
        const asstMatch = /^assistant_([a-f0-9]{32})$/.exec(scope);
        if (asstMatch) {
          const placement = this.clusterStore.getAssistantPlacement(asstMatch[1]!);
          return Boolean(placement && placement.node_id === nodeId);
        }
        return false;
      }
      if (namespace === 'project-notes') {
        if (!/^[1-9]\d{0,19}$/.test(scope)) return false;
        // Allow rw for the node currently bound to this repo, OR the previous node while flushing during rebind.
        return repoBoundToNode(scope, true);
      }
      if (namespace === 'assistant-homes') {
        const match = /^([a-f0-9]{32}):([1-9]\d*)$/.exec(scope);
        if (!match) return false;
        const owner = match[1]!;
        const generation = Number(match[2]);
        const placement = this.clusterStore.getAssistantPlacement(owner);
        if (!placement || placement.node_id !== nodeId) return false;
        if (placement.generation !== generation) return false;
        return true;
      }
      return false;
    })();

    if (!allowed) {
      fail(403, 'node_scope_forbidden', undefined, {
        detail: `Node '${nodeId}' is not authorized for ${namespace}/${scope} (${mode}).`,
      });
    }

    const issued = this.syncTokens.issue({
      actor: `node:${nodeId}`,
      actorTag: `node-${nodeId}`,
      grants: [{ namespace, scope, mode }],
      ttlMs: 15 * 60 * 1000,
      createdBy: `node:${nodeId}`,
    });
    return issued as unknown as Json;
  }

  /**
   * Handles incoming RFC 6455 WebSocket upgrade on `/cluster/nodes/ws`.
   * Returns `true` if handled (including auth rejections), `false` for unrelated paths.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (pathname !== '/cluster/nodes/ws') return false;

    let session;
    try {
      session = this.clusterStore.authenticateSession(req.headers.authorization);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 401;
      const code = err instanceof HttpError ? err.code : 'node_unauthorized';
      socket.write(`HTTP/1.1 ${status} Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ error: code })}`);
      socket.destroy();
      return true;
    }

    const ws = upgradeHttpToWs(req, socket, head, { maxMessageBytes: MAX_NODE_CONTROL_FRAME_BYTES });
    if (!ws) return true;

    const { node_id: nodeId, session_id: sessionId } = session;
    const prev = this.wsSessions.get(nodeId);
    if (prev) {
      clearInterval(prev.pingTimer);
      try { prev.ws.close(1000, 'replaced_by_new_session'); } catch {}
    }

    const pingTimer = setInterval(() => {
      if (this.wsSessions.get(nodeId)?.ws === ws && ws.open) ws.ping();
    }, this.heartbeatIntervalMs);
    pingTimer.unref?.();

    const active: ActiveWsSession = { nodeId, sessionId, ws, pingTimer };
    this.wsSessions.set(nodeId, active);
    this.clusterStore.recordHeartbeat(nodeId, { transport: 'websocket' });

    // Cancel any active HTTP long-poll waiter since WS is now live.
    const waiter = this.pollWaiters.get(nodeId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pollWaiters.delete(nodeId);
      waiter.resolve([]);
    }

    ws.on('text', (raw: string) => {
      let msg: Json;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      this.handleNodeMessage(nodeId, sessionId, msg, ws);
    });

    const onDisconnect = () => {
      if (this.wsSessions.get(nodeId) === active) {
        clearInterval(active.pingTimer);
        this.wsSessions.delete(nodeId);
      }
      // Close active tunnels on this WS connection; operations stay pending so reconnect can resume by operation_id!
      for (const tunnel of [...this.tunnels.values()]) {
        if (tunnel.nodeId === nodeId) {
          this._teardownTunnel(tunnel, new HttpError(503, 'node_disconnected'));
        }
      }
      for (const [id, ms] of [...this.wsModelStreams.entries()]) {
        if (ms.nodeId === nodeId) {
          ms.aborted = true;
          ms.reqStream.destroy(new Error('node_disconnected'));
          this.wsModelStreams.delete(id);
        }
      }
    };
    ws.on('close', onDisconnect);
    ws.on('error', onDisconnect);

    // Flush queued outbound messages AND resume any in-flight operations by operation_id.
    const queued = this.outboundQueues.get(nodeId) ?? [];
    this.outboundQueues.delete(nodeId);
    for (const item of queued) ws.sendJson(item);
    this._resumeOperationsForNode(nodeId);

    this.emit('node.connected', { node_id: nodeId, transport: 'websocket' });
    return true;
  }

  private _resumeOperationsForNode(nodeId: string): void {
    for (const op of this.operations.values()) {
      if (op.nodeId !== nodeId) continue;
      if (op.acked) {
        this.sendControlMessage(nodeId, {
          type: 'op.resume',
          operation_id: op.operationId,
          after_seq: op.lastSeq,
        });
      } else {
        this.sendControlMessage(nodeId, {
          type: 'op.submit',
          operation_id: op.operationId,
          node_id: op.nodeId,
          method: op.method,
          path: op.path,
          ...(op.input !== undefined ? { input: op.input } : {}),
          ...(op.bindingEpoch !== undefined ? { binding_epoch: op.bindingEpoch } : {}),
        });
      }
    }
  }

  private handleNodeMessage(nodeId: string, _sessionId: string, msg: Json, ws?: WsConnection): void {
    const type = String(msg.type || '');
    // Always enforce that any node_id field in payload cannot spoof another node.
    if (msg.node_id !== undefined && String(msg.node_id) !== nodeId) {
      ws?.sendJson({ type: 'error', error: 'node_identity_mismatch' });
      return;
    }

    if (type === 'heartbeat') {
      try {
        this.clusterStore.recordHeartbeat(nodeId, {
          metrics: (msg.metrics as NodeMetrics | undefined) ?? undefined,
          transport: ws ? 'websocket' : 'long_poll',
          os: typeof msg.os === 'string' ? msg.os : undefined,
          arch: typeof msg.arch === 'string' ? msg.arch : undefined,
          agentVersion: typeof msg.agent_version === 'string' ? msg.agent_version : undefined,
        });
      } catch { /* ignore heartbeat on revoked node */ }
      return;
    }

    if (type === 'op.ack') {
      const op = this.operations.get(String(msg.operation_id || ''));
      if (op && op.nodeId === nodeId) op.acked = true;
      return;
    }

    if (type === 'op.progress') {
      const op = this.operations.get(String(msg.operation_id || ''));
      if (!op || op.nodeId !== nodeId) return;
      op.acked = true;
      const seq = Number(msg.seq || 0);
      if (Number.isSafeInteger(seq) && seq > op.lastSeq) {
        op.lastSeq = seq;
        try {
          op.onProgress?.({
            seq,
            chunk: typeof msg.chunk === 'string' ? msg.chunk : undefined,
            progress: msg.progress && typeof msg.progress === 'object' ? (msg.progress as Json) : undefined,
          });
        } catch {}
      }
      return;
    }

    if (type === 'op.chunk') {
      const op = this.operations.get(String(msg.operation_id || ''));
      if (!op || op.nodeId !== nodeId) return;
      op.acked = true;
      const idx = Number(msg.chunk_index);
      const total = Number(msg.total_chunks);
      if (!Number.isSafeInteger(idx) || idx < 0 || !Number.isSafeInteger(total) || total < 1 || idx >= total || total > 1024) return;
      op.totalChunks = total;
      op.chunks.set(idx, Buffer.from(String(msg.data_b64 || ''), 'base64'));
      return;
    }

    if (type === 'op.result') {
      const opId = String(msg.operation_id || '');
      const op = this.operations.get(opId);
      if (!op || op.nodeId !== nodeId) return;
      clearTimeout(op.timer);
      this.operations.delete(opId);

      if (msg.chunked === true && op.totalChunks !== null) {
        const parts: Buffer[] = [];
        for (let i = 0; i < op.totalChunks; i++) {
          const part = op.chunks.get(i);
          if (!part) {
            op.reject(new HttpError(503, 'node_incomplete_chunked_result'));
            return;
          }
          parts.push(part);
        }
        let reassembled: any;
        try {
          reassembled = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch {
          op.reject(new HttpError(503, 'manager_unavailable'));
          return;
        }
        if (msg.ok) {
          op.resolve(reassembled);
        } else {
          const status = Number.isSafeInteger(msg.status) && Number(msg.status) >= 400 && Number(msg.status) < 600
            ? Number(msg.status)
            : 503;
          const code = typeof msg.error === 'string' && msg.error ? msg.error : 'manager_unavailable';
          const extra = msg.extra && typeof msg.extra === 'object' ? (msg.extra as Json) : undefined;
          op.reject(new HttpError(status, code, undefined, extra));
        }
        return;
      }

      if (msg.ok) {
        op.resolve(msg.result);
      } else {
        const status = Number.isSafeInteger(msg.status) && Number(msg.status) >= 400 && Number(msg.status) < 600
          ? Number(msg.status)
          : 503;
        const code = typeof msg.error === 'string' && msg.error ? msg.error : 'manager_unavailable';
        const extra = msg.extra && typeof msg.extra === 'object' ? (msg.extra as Json) : undefined;
        op.reject(new HttpError(status, code, undefined, extra));
      }
      return;
    }

    if (type === 'op.missing') {
      const opId = String(msg.operation_id || '');
      const op = this.operations.get(opId);
      if (!op || op.nodeId !== nodeId) return;
      clearTimeout(op.timer);
      this.operations.delete(opId);
      op.reject(new HttpError(503, 'operation_interrupted'));
      return;
    }

    if (type === 'tunnel.opened') {
      const tunnel = this.tunnels.get(String(msg.tunnel_id || ''));
      if (!tunnel || tunnel.nodeId !== nodeId || tunnel.opened) return;
      clearTimeout(tunnel.openTimer);
      tunnel.opened = true;
      tunnel.onOpenResolve?.(tunnel.stream as any);
      return;
    }

    if (type === 'tunnel.data') {
      const tunnel = this.tunnels.get(String(msg.tunnel_id || ''));
      if (!tunnel || tunnel.nodeId !== nodeId || tunnel.closed) return;
      const bytes = Buffer.from(String(msg.data_b64 || ''), 'base64');
      if (bytes.length) tunnel.stream.write(bytes);
      return;
    }

    if (type === 'tunnel.close' || type === 'tunnel.error') {
      const tunnel = this.tunnels.get(String(msg.tunnel_id || ''));
      if (!tunnel || tunnel.nodeId !== nodeId) return;
      const err = type === 'tunnel.error' ? new HttpError(502, String(msg.error || 'tunnel_failed')) : undefined;
      this._teardownTunnel(tunnel, err);
      return;
    }

    // WS-tunneled model gateway request from a remote node's local /run/model-gateway/gateway.sock proxy.
    if (type === 'model.request' && ws) {
      this._handleWsModelRequest(nodeId, msg, ws);
      return;
    }
    if (type === 'model.abort') {
      const streamId = String(msg.stream_id || '');
      const active = this.wsModelStreams.get(streamId);
      if (active && active.nodeId === nodeId) {
        active.aborted = true;
        active.reqStream.destroy(new Error('client_cancelled'));
        this.wsModelStreams.delete(streamId);
      }
    }
  }

  private _handleWsModelRequest(nodeId: string, msg: Json, ws: WsConnection): void {
    const streamId = String(msg.stream_id || '');
    const method = String(msg.method || 'POST').toUpperCase();
    const reqPath = String(msg.path || '/v1/chat/completions');
    const headers = msg.headers && typeof msg.headers === 'object' && !Array.isArray(msg.headers)
      ? Object.fromEntries(Object.entries(msg.headers as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]))
      : {};
    const bodyBuf = typeof msg.body_b64 === 'string' && msg.body_b64 ? Buffer.from(msg.body_b64, 'base64') : Buffer.alloc(0);
    if (!streamId || bodyBuf.length > maxGatewayRequestBytes) {
      ws.sendJson({ type: 'model.response.error', stream_id: streamId, status: 413, error: 'request_too_large' });
      return;
    }

    const reqStream = new PassThrough();
    const virtualReq = Object.assign(reqStream, {
      method,
      url: reqPath,
      headers,
    }) as unknown as IncomingMessage;
    const state: ActiveWsModelStream = { streamId, nodeId, reqStream, aborted: false };
    this.wsModelStreams.set(streamId, state);

    let headSent = false;
    let statusCode = 200;
    const respHeaders: Record<string, string> = {};
    const virtualRes = new EventEmitter() as unknown as ServerResponse & {
      writableEnded: boolean;
      destroyed: boolean;
      headersSent: boolean;
    };
    virtualRes.writableEnded = false;
    virtualRes.destroyed = false;
    virtualRes.headersSent = false;
    virtualRes.setHeader = ((name: string, value: any) => {
      respHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      return virtualRes;
    }) as any;
    virtualRes.getHeader = ((name: string) => respHeaders[name.toLowerCase()]) as any;
    virtualRes.writeHead = ((status: number, hdrs?: Record<string, any>) => {
      statusCode = status;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) respHeaders[k.toLowerCase()] = String(v);
      }
      if (!headSent && !state.aborted && ws.open) {
        headSent = true;
        virtualRes.headersSent = true;
        ws.sendJson({ type: 'model.response.head', stream_id: streamId, status: statusCode, headers: respHeaders });
      }
      return virtualRes;
    }) as any;
    virtualRes.flushHeaders = () => {};
    virtualRes.write = ((chunk: Buffer | string) => {
      if (state.aborted || !ws.open) return false;
      if (!headSent) virtualRes.writeHead(statusCode, respHeaders);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buf.length) {
        ws.sendJson({ type: 'model.response.chunk', stream_id: streamId, data_b64: buf.toString('base64') });
      }
      return true;
    }) as any;
    virtualRes.end = ((chunk?: Buffer | string) => {
      if (virtualRes.writableEnded) return virtualRes;
      if (chunk !== undefined && chunk !== null && chunk !== '') virtualRes.write(chunk);
      if (!headSent && !state.aborted && ws.open) virtualRes.writeHead(statusCode, respHeaders);
      virtualRes.writableEnded = true;
      this.wsModelStreams.delete(streamId);
      if (!state.aborted && ws.open) {
        ws.sendJson({ type: 'model.response.end', stream_id: streamId });
      }
      virtualRes.emit('finish');
      virtualRes.emit('close');
      return virtualRes;
    }) as any;

    this.modelGateway.handleIncoming(virtualReq, virtualRes);
    reqStream.end(bodyBuf);
  }

  /**
   * Serves control-plane `/cluster/nodes/*` HTTP endpoints (paired node auth, never browser cookies).
   * Returns `true` if the path matched `/cluster/nodes/*` and was handled.
   */
  async handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/cluster/nodes/')) return false;
    const method = req.method || 'GET';
    const path = url.pathname;

    if (path === '/cluster/nodes/pair') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const input = await readJsonPayload(req, 64 * 1024);
      fields(input, [
        'public_key', 'protocol_version', 'min_protocol_version', 'agent_version',
        'driver', 'os', 'arch', 'labels', 'transport', 'direct_url', 'metrics',
      ]);
      const paired = this.clusterStore.pairNode({
        authorization: req.headers.authorization,
        publicKey: typeof input.public_key === 'string' ? input.public_key : '',
        protocolVersion: input.protocol_version,
        minProtocolVersion: input.min_protocol_version,
        agentVersion: typeof input.agent_version === 'string' ? input.agent_version : undefined,
        driver: typeof input.driver === 'string' ? input.driver : undefined,
        os: typeof input.os === 'string' ? input.os : undefined,
        arch: typeof input.arch === 'string' ? input.arch : undefined,
        labels: input.labels as Record<string, string> | undefined,
        transport: typeof input.transport === 'string' ? input.transport : undefined,
        directUrl: typeof input.direct_url === 'string' ? input.direct_url : undefined,
        metrics: input.metrics as NodeMetrics | undefined,
      });
      this.directSessions.set(paired.node.id, paired.session_token);
      sendJson(res, 200, {
        node: paired.node,
        node_id: paired.node.id,
        session_id: paired.session_id,
        session_token: paired.session_token,
        session_expires_at: paired.session_expires_at,
        protocol_version: paired.protocol_version,
        center_protocol_version: NODE_AGENT_PROTOCOL_VERSION,
        center_image_tag: this.imageTag,
        heartbeat_interval_ms: this.heartbeatIntervalMs,
        long_poll_timeout_ms: this.longPollMaxMs,
      });
      return true;
    }

    if (path === '/cluster/nodes/session') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const input = await readJsonPayload(req, 64 * 1024);
      fields(input, [
        'node_id', 'assertion', 'protocol_version', 'min_protocol_version',
        'agent_version', 'os', 'arch', 'transport', 'metrics',
      ]);
      const exchanged = this.clusterStore.exchangeSession({
        nodeId: typeof input.node_id === 'string' ? input.node_id : '',
        assertion: input.assertion,
        protocolVersion: input.protocol_version,
        minProtocolVersion: input.min_protocol_version,
        agentVersion: typeof input.agent_version === 'string' ? input.agent_version : undefined,
        os: typeof input.os === 'string' ? input.os : undefined,
        arch: typeof input.arch === 'string' ? input.arch : undefined,
        transport: typeof input.transport === 'string' ? input.transport : undefined,
        metrics: input.metrics as NodeMetrics | undefined,
      });
      this.directSessions.set(exchanged.node.id, exchanged.session_token);
      sendJson(res, 200, {
        node: exchanged.node,
        node_id: exchanged.node.id,
        session_id: exchanged.session_id,
        session_token: exchanged.session_token,
        session_expires_at: exchanged.session_expires_at,
        protocol_version: exchanged.protocol_version,
        center_protocol_version: NODE_AGENT_PROTOCOL_VERSION,
        center_image_tag: this.imageTag,
        heartbeat_interval_ms: this.heartbeatIntervalMs,
        long_poll_timeout_ms: this.longPollMaxMs,
      });
      return true;
    }

    // All remaining `/cluster/nodes/*` endpoints require an active per-node short-lived session token (`bnsess_...`).
    const session = this.clusterStore.authenticateSession(req.headers.authorization);
    const { node_id: nodeId, session_id: sessionId } = session;

    if (path === '/cluster/nodes/heartbeat') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const input = await readJsonPayload(req, 512 * 1024);
      if (input.node_id !== undefined && String(input.node_id) !== nodeId) fail(403, 'node_identity_mismatch');
      const node = this.clusterStore.recordHeartbeat(nodeId, {
        metrics: (input.metrics as NodeMetrics | undefined) ?? undefined,
        transport: input.transport === 'long_poll' ? 'long_poll' : input.transport === 'direct' ? 'direct' : 'websocket',
        os: typeof input.os === 'string' ? input.os : undefined,
        arch: typeof input.arch === 'string' ? input.arch : undefined,
        agentVersion: typeof input.agent_version === 'string' ? input.agent_version : undefined,
      });
      sendJson(res, 200, { ok: true, node_id: nodeId, status: node.status, server_time: new Date(this.clusterStore.now()).toISOString() });
      return true;
    }

    if (path === '/cluster/nodes/poll') {
      if (method !== 'GET') fail(405, 'method_not_allowed');
      req.setTimeout(0);
      res.setTimeout(0);
      const requestedWait = Number(url.searchParams.get('timeout_ms') || this.longPollMaxMs);
      const waitMs = Number.isFinite(requestedWait)
        ? Math.max(100, Math.min(this.longPollMaxMs, Math.trunc(requestedWait)))
        : this.longPollMaxMs;
      this.clusterStore.recordHeartbeat(nodeId, { transport: 'long_poll' });
      if (url.searchParams.get('resume') === '1') {
        this._resumeOperationsForNode(nodeId);
      }

      const immediate = this.outboundQueues.get(nodeId);
      if (immediate && immediate.length > 0) {
        this.outboundQueues.delete(nodeId);
        sendJson(res, 200, { messages: immediate, server_time: new Date(this.clusterStore.now()).toISOString() });
        return true;
      }

      // Cancel any older long-poll from the same node so at most one poll holds open.
      const prev = this.pollWaiters.get(nodeId);
      if (prev) {
        clearTimeout(prev.timer);
        this.pollWaiters.delete(nodeId);
        prev.resolve([]);
      }

      const messages = await new Promise<Json[]>(resolve => {
        const timer = setTimeout(() => {
          if (this.pollWaiters.get(nodeId) === waiter) this.pollWaiters.delete(nodeId);
          resolve([]);
        }, waitMs);
        timer.unref?.();
        const waiter: PollWaiter = { nodeId, sessionId, resolve, timer };
        this.pollWaiters.set(nodeId, waiter);
        req.once('close', () => {
          if (this.pollWaiters.get(nodeId) === waiter) {
            clearTimeout(timer);
            this.pollWaiters.delete(nodeId);
            resolve([]);
          }
        });
      });

      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 200, { messages, server_time: new Date(this.clusterStore.now()).toISOString() });
      }
      return true;
    }

    if (path === '/cluster/nodes/ack') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const input = await readJsonPayload(req, MAX_NODE_CONTROL_FRAME_BYTES);
      const batch = Array.isArray(input.messages) ? (input.messages as Json[]) : [input];
      for (const item of batch) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          if (item.node_id !== undefined && String(item.node_id) !== nodeId) fail(403, 'node_identity_mismatch');
          this.handleNodeMessage(nodeId, sessionId, item);
        }
      }
      sendJson(res, 200, { ok: true, accepted: batch.length });
      return true;
    }

    if (path === '/cluster/nodes/sync-token') {
      if (method !== 'POST') fail(405, 'method_not_allowed');
      const input = await readJsonPayload(req, 16 * 1024);
      fields(input, ['namespace', 'scope', 'mode', 'node_id']);
      if (input.node_id !== undefined && String(input.node_id) !== nodeId) fail(403, 'node_identity_mismatch');
      const issued = this.issueNodeSyncToken(nodeId, input.namespace, input.scope, input.mode);
      sendJson(res, 201, issued);
      return true;
    }

    if (path === '/cluster/nodes/model-proxy') {
      // HTTP streaming proxy fallback for container model requests (rrt_... presented in x-bot-run-token / x-api-key).
      // Node session token authenticates the transport hop; `ModelGatewayHub` authenticates the inner `rrt_` run token.
      const targetPath = url.searchParams.get('path') || '/v1/chat/completions';
      const innerMethod = (url.searchParams.get('method') || method).toUpperCase();
      if (!targetPath.startsWith('/')) fail(400, 'invalid_model_proxy_path');
      const runToken = typeof req.headers['x-bot-run-token'] === 'string' ? req.headers['x-bot-run-token'].trim() : '';
      if (!runToken) fail(401, 'run_token_invalid');

      const forwardedHeaders: IncomingMessage['headers'] = { ...req.headers };
      // Strip the node session bearer and substitute the container's `rrt_` run token for ModelGatewayHub.
      forwardedHeaders.authorization = `Bearer ${runToken}`;
      delete forwardedHeaders['x-bot-run-token'];
      if (typeof forwardedHeaders['x-api-key'] === 'string' && forwardedHeaders['x-api-key'] !== runToken) {
        delete forwardedHeaders['x-api-key'];
      }
      const proxyStream = new PassThrough();
      req.pipe(proxyStream);
      req.once('aborted', () => {
        proxyStream.emit('aborted');
        proxyStream.destroy();
      });
      const proxiedReq = Object.assign(proxyStream, {
        method: innerMethod,
        url: targetPath,
        headers: forwardedHeaders,
      }) as unknown as IncomingMessage;
      req.setTimeout(0);
      res.setTimeout(0);
      await new Promise<void>(resolveDone => {
        const done = () => {
          res.off('close', done);
          res.off('finish', done);
          resolveDone();
        };
        res.once('close', done);
        res.once('finish', done);
        this.modelGateway.handleIncoming(proxiedReq, res);
      });
      return true;
    }

    return fail(404, 'not_found');
  }
}
