import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectWs } from '../runner/wire-protocol.mjs';
import {
  DEFAULT_NODE_HEARTBEAT_MS,
  DEFAULT_NODE_LONG_POLL_MS,
  MAX_NODE_CONTROL_FRAME_BYTES,
  NODE_AGENT_MIN_PROTOCOL_VERSION,
  NODE_AGENT_PROTOCOL_VERSION,
  NODE_RESULT_CHUNK_BYTES,
  normalizeNodeArch,
  normalizeNodeLabels,
  normalizeNodeOs,
  parseLabelsText,
  signNodeAssertion,
} from '../runner/node-protocol.mjs';
import { ManagerError } from './docker.mjs';
import { createComputeDriver } from './compute-driver.mjs';
import { NodeSyncManager } from './node-sync.mjs';
import { NodeModelProxy } from './node-model-proxy.mjs';

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

/**
 * Remote Linux Docker compute node agent (`manager/node-agent.mjs`).
 *
 * Connects outbound to the control plane (WebSocket preferred, <=25s HTTPS long-poll fallback),
 * authenticates via one-time pairing token (`bnode_...`) -> Ed25519 keypair -> short-lived session (`bnsess_...`),
 * executes async `operation_id` tasks with resumable chunked result delivery against local `DockerComputeDriver`,
 * syncs shared directories strictly via `SyncClient`, proxies container UDS model traffic through `ModelGatewayHub`,
 * and provides a default-deny TCP tunnel primitive (`allowTunnel` defaults to `false`).
 */
export class NodeAgent extends EventEmitter {
  constructor(options = {}) {
    super();
    this.centerUrl = String(options.centerUrl || process.env.BOT_CENTER_URL || process.env.BOT_CONTROL_PLANE_URL || '').replace(/\/+$/, '');
    this.pairingToken = options.pairingToken ?? process.env.BOT_NODE_PAIRING_TOKEN ?? '';
    this.driverKind = String(options.driverKind || process.env.BOT_NODE_DRIVER || 'docker').toLowerCase();
    this.dataDir = resolve(options.dataDir || process.env.BOT_NODE_DATA_DIR || '/data');
    this.identityFile = resolve(options.identityFile || join(this.dataDir, 'node-identity.json'));
    this.agentVersion = String(options.agentVersion || process.env.BOT_IMAGE_TAG || 'dev');
    this.protocolVersion = Number.isSafeInteger(options.protocolVersion)
      ? options.protocolVersion
      : NODE_AGENT_PROTOCOL_VERSION;
    this.minProtocolVersion = Number.isSafeInteger(options.minProtocolVersion)
      ? options.minProtocolVersion
      : NODE_AGENT_MIN_PROTOCOL_VERSION;
    this.labels =
      options.labels && typeof options.labels === 'object'
        ? normalizeNodeLabels(options.labels)
        : parseLabelsText(process.env.BOT_NODE_LABELS || '');
    this.directUrl = options.directUrl ?? (process.env.BOT_NODE_DIRECT_URL || null);
    this.preferLongPoll =
      options.preferLongPoll !== undefined
        ? Boolean(options.preferLongPoll)
        : String(process.env.BOT_NODE_TRANSPORT || '').toLowerCase() === 'long_poll';
    this.allowTunnel =
      options.allowTunnel !== undefined
        ? Boolean(options.allowTunnel)
        : process.env.BOT_NODE_ALLOW_TUNNEL === 'true';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_NODE_HEARTBEAT_MS;
    this.longPollTimeoutMs = Math.min(25_000, Math.max(200, options.longPollTimeoutMs ?? DEFAULT_NODE_LONG_POLL_MS));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_500;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.chunkBytes = options.chunkBytes ?? NODE_RESULT_CHUNK_BYTES;

    this.driver =
      options.driver ||
      createComputeDriver(this.driverKind, {
        dataDir: this.dataDir,
        database: options.database || process.env.BOT_MANAGER_DATABASE || join(this.dataDir, 'manager.sqlite'),
        docker: options.docker,
        dockerSocketPath: options.dockerSocketPath,
        deployment: options.deployment,
        deploymentSeed: options.deploymentSeed || this.dataDir,
        image: options.image || process.env.BOT_PROJECT_IMAGE,
        egress: options.egress,
        toolsDir: options.toolsDir,
        projectToolsDir: options.projectToolsDir,
        skillStoreDir: options.skillStoreDir,
        modelGatewayDir: options.modelGatewayDir,
        runnerSocketsDir: options.runnerSocketsDir,
        toolResultsDir: options.toolResultsDir,
        assistantHomesDir: options.assistantHomesDir,
        assistantImage: options.assistantImage,
        compactOnStart: options.compactOnStart,
      });

    this.enableSync = options.enableSync !== false;
    this.sync =
      options.sync ||
      (this.enableSync
        ? new NodeSyncManager({
            baseUrl: this.centerUrl,
            getSessionToken: () => this.sessionToken,
            getNodeId: () => this.identity?.node_id || null,
            cacheDir: options.syncCacheDir || process.env.BOT_SYNC_CACHE_DIR || join(this.dataDir, 'sync-cache'),
            fetchImpl: this.fetchImpl,
            roots: {
              agentTools: options.toolsDir ?? (process.env.BOT_AGENT_TOOLS_DIR || null),
              skillStore: options.skillStoreDir ?? (process.env.BOT_SKILL_STORE_DIR || null),
              projectTools: options.projectToolsDir ?? (process.env.BOT_PROJECT_TOOLS_DIR || null),
              toolResults: options.toolResultsDir ?? (process.env.BOT_TOOL_RESULTS_DIR || null),
              projectNotes: options.projectNotesDir ?? join(this.dataDir, 'project-notes'),
              assistantHomes: options.assistantHomesDir ?? (process.env.BOT_ASSISTANT_HOMES || null),
            },
          })
        : null);

    this.modelGatewaySocketPath =
      options.modelGatewaySocketPath ??
      (options.modelGatewayDir
        ? join(options.modelGatewayDir, 'gateway.sock')
        : process.env.BOT_MODEL_GATEWAY_DIR
          ? join(process.env.BOT_MODEL_GATEWAY_DIR, 'gateway.sock')
          : null);
    this.modelProxy = this.modelGatewaySocketPath
      ? new NodeModelProxy({
          socketPath: this.modelGatewaySocketPath,
          baseUrl: this.centerUrl,
          getSessionToken: () => this.sessionToken,
          sendWsFrame: frame => this._sendWsFrame(frame),
          isWsOpen: () => Boolean(this._ws?.open),
        })
      : null;

    this.healthPort = options.healthPort ?? null;
    this._healthServer = null;

    this.identity = null;
    this.sessionId = null;
    this.sessionToken = null;
    this.sessionExpiresAt = 0;
    this.connected = false;
    this.revoked = false;
    this.transport = this.preferLongPoll ? 'long_poll' : 'websocket';

    this._ws = null;
    this._stopping = false;
    this._loopPromise = null;
    this._heartbeatTimer = null;
    this._pollAbort = null;
    this._operations = new Map(); // operationId -> { status, progressFrames, resultFrames, updatedAt }
    this._tunnels = new Map(); // tunnelId -> net.Socket
    this._operationHook = options.onBeforeOperation ?? null;
  }

  get nodeId() {
    return this.identity?.node_id || null;
  }

  async _loadOrCreateKeypair() {
    await mkdir(dirname(this.identityFile), { recursive: true, mode: 0o700 });
    if (existsSync(this.identityFile)) {
      const raw = JSON.parse(await readFile(this.identityFile, 'utf8'));
      if (raw && raw.public_key_pem && raw.private_key_pem) {
        this.identity = {
          node_id: raw.node_id || null,
          public_key_pem: String(raw.public_key_pem),
          private_key_pem: String(raw.private_key_pem),
        };
        return this.identity;
      }
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.identity = {
      node_id: null,
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    await this._saveIdentity();
    return this.identity;
  }

  async _saveIdentity() {
    if (!this.identity) return;
    await mkdir(dirname(this.identityFile), { recursive: true, mode: 0o700 });
    await writeFile(this.identityFile, JSON.stringify(this.identity, null, 2) + '\n', { mode: 0o600 });
    await chmod(this.identityFile, 0o600).catch(() => {});
  }

  async authenticate() {
    if (!this.centerUrl) {
      throw Object.assign(new Error('BOT_CENTER_URL is required'), { code: 'center_url_missing', status: 400 });
    }
    const id = await this._loadOrCreateKeypair();
    const metrics = await this.driver.collectMetrics().catch(() => ({}));
    const osName = normalizeNodeOs(process.platform);
    const archName = normalizeNodeArch(process.arch);
    const preferredTransport = this.preferLongPoll ? 'long_poll' : 'websocket';

    if (id.node_id) {
      const assertion = signNodeAssertion(id.node_id, id.private_key_pem);
      const res = await this.fetchImpl(`${this.centerUrl}/cluster/nodes/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_id: id.node_id,
          assertion,
          protocol_version: this.protocolVersion,
          min_protocol_version: this.minProtocolVersion,
          agent_version: this.agentVersion,
          os: osName,
          arch: archName,
          transport: preferredTransport,
          metrics,
        }),
      });
      const text = await res.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch {}
      if (!res.ok) {
        const err = Object.assign(new Error(body.detail || body.error || `session_exchange_failed_${res.status}`), {
          code: body.error || 'session_exchange_failed',
          status: res.status,
          detail: body.detail || null,
        });
        if (res.status === 426) this.emit('protocol_incompatible', err);
        if (res.status === 403 && body.error === 'node_revoked') {
          this.revoked = true;
          this.emit('revoked', err);
        }
        throw err;
      }
      this.sessionId = String(body.session_id);
      this.sessionToken = String(body.session_token);
      this.sessionExpiresAt = body.session_expires_at ? Date.parse(body.session_expires_at) : Date.now() + 12 * 3600_000;
      if (Number.isSafeInteger(body.heartbeat_interval_ms) && body.heartbeat_interval_ms >= 500) {
        this.heartbeatIntervalMs = Math.min(this.heartbeatIntervalMs, body.heartbeat_interval_ms);
      }
      if (Number.isSafeInteger(body.long_poll_timeout_ms) && body.long_poll_timeout_ms >= 500) {
        this.longPollTimeoutMs = Math.min(this.longPollTimeoutMs, body.long_poll_timeout_ms);
      }
      return body;
    }

    if (!this.pairingToken) {
      throw Object.assign(new Error('BOT_NODE_PAIRING_TOKEN is required for first-time pairing'), {
        code: 'pairing_token_missing',
        status: 401,
      });
    }

    const res = await this.fetchImpl(`${this.centerUrl}/cluster/nodes/pair`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.pairingToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        public_key: id.public_key_pem,
        protocol_version: this.protocolVersion,
        min_protocol_version: this.minProtocolVersion,
        agent_version: this.agentVersion,
        driver: this.driverKind,
        os: osName,
        arch: archName,
        labels: this.labels,
        transport: preferredTransport,
        ...(this.directUrl ? { direct_url: this.directUrl } : {}),
        metrics,
      }),
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) {
      const err = Object.assign(new Error(body.detail || body.error || `pair_failed_${res.status}`), {
        code: body.error || 'pair_failed',
        status: res.status,
        detail: body.detail || null,
      });
      if (res.status === 426) this.emit('protocol_incompatible', err);
      if (res.status === 403 && body.error === 'node_revoked') {
        this.revoked = true;
        this.emit('revoked', err);
      }
      throw err;
    }

    this.identity.node_id = String(body.node_id);
    await this._saveIdentity();
    // Clear one-time pairing token from memory after persisting Ed25519 identity.
    this.pairingToken = '';
    this.sessionId = String(body.session_id);
    this.sessionToken = String(body.session_token);
    this.sessionExpiresAt = body.session_expires_at ? Date.parse(body.session_expires_at) : Date.now() + 12 * 3600_000;
    if (Number.isSafeInteger(body.heartbeat_interval_ms) && body.heartbeat_interval_ms >= 500) {
      this.heartbeatIntervalMs = Math.min(this.heartbeatIntervalMs, body.heartbeat_interval_ms);
    }
    if (Number.isSafeInteger(body.long_poll_timeout_ms) && body.long_poll_timeout_ms >= 500) {
      this.longPollTimeoutMs = Math.min(this.longPollTimeoutMs, body.long_poll_timeout_ms);
    }
    this.emit('paired', { node_id: this.identity.node_id });
    return body;
  }

  async start() {
    this._stopping = false;
    await this.driver.recover();
    if (typeof this.driver.startBackgroundChecks === 'function') {
      this.driver.startBackgroundChecks();
    }
    if (this.modelProxy) {
      await this.modelProxy.start();
    }
    if (this.healthPort) {
      await this._startHealthServer();
    }
    this._loopPromise = this._runLoop();
    return this._loopPromise;
  }

  async waitUntilConnected(timeoutMs = 15_000) {
    if (this.connected) return;
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        this.off('connected', onConn);
        this.off('protocol_incompatible', onErr);
        this.off('revoked', onErr);
        rejectReady(new Error('node_agent_connect_timeout'));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        this.off('connected', onConn);
        this.off('protocol_incompatible', onErr);
        this.off('revoked', onErr);
      };
      const onConn = () => { cleanup(); resolveReady(); };
      const onErr = err => { cleanup(); rejectReady(err); };
      this.on('connected', onConn);
      this.on('protocol_incompatible', onErr);
      this.on('revoked', onErr);
    });
  }

  /**
   * Simulates or performs an immediate transport drop (for failover/reconnect testing and graceful handoffs).
   */
  disconnectTransport() {
    if (this._ws) {
      try { this._ws.close(1001, 'reconnect'); } catch {}
    }
    if (this._pollAbort) {
      try { this._pollAbort.abort(); } catch {}
    }
  }

  async stop() {
    this._stopping = true;
    this.connected = false;
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
    this.disconnectTransport();
    this._closeAllTunnels();
    if (this._loopPromise) {
      await this._loopPromise.catch(() => {});
      this._loopPromise = null;
    }
    if (this.modelProxy) {
      await this.modelProxy.close().catch(() => {});
    }
    if (this._healthServer) {
      const srv = this._healthServer;
      this._healthServer = null;
      await new Promise(resolveClose => {
        srv.close(() => resolveClose());
        srv.closeAllConnections?.();
      });
    }
    await this.driver.shutdown().catch(() => {});
  }

  async _startHealthServer() {
    if (this._healthServer) return;
    const server = http.createServer((req, res) => {
      const ok = !this._stopping && !this.revoked && this.connected;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok,
          node_id: this.nodeId,
          transport: this.transport,
          connected: this.connected,
          revoked: this.revoked,
        }),
      );
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.healthPort, '127.0.0.1', () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    this._healthServer = server;
  }

  async _runLoop() {
    let backoff = this.reconnectDelayMs;
    let fallbackToLongPoll = this.preferLongPoll;

    while (!this._stopping && !this.revoked) {
      try {
        if (!this.sessionToken || Date.now() >= this.sessionExpiresAt - 120_000) {
          await this.authenticate();
          this.sync?.invalidateTokens();
        }
        backoff = this.reconnectDelayMs;

        if (!fallbackToLongPoll) {
          const wsResult = await this._runWebSocketSession();
          if (wsResult === 'fallback_long_poll') {
            fallbackToLongPoll = true;
            continue;
          }
          if (wsResult === 'reauth') {
            this.sessionToken = null;
            continue;
          }
        } else {
          const pollResult = await this._runLongPollLoop();
          if (pollResult === 'reauth') {
            this.sessionToken = null;
            continue;
          }
        }
      } catch (err) {
        this.connected = false;
        if (err?.status === 403 && err?.code === 'node_revoked') {
          this.revoked = true;
          await this.driver.revokeAll().catch(() => {});
          break;
        }
        if (err?.status === 426) {
          console.error(`[node-agent] protocol version incompatible: ${err.message}`);
          await sleep(Math.min(this.maxReconnectDelayMs, 15_000));
          continue;
        }
        if (err?.status === 401) {
          this.sessionToken = null;
        }
        this.emit('error_logged', err);
      }

      if (!this._stopping && !this.revoked) {
        await sleep(backoff);
        backoff = Math.min(this.maxReconnectDelayMs, Math.round(backoff * 1.7));
      }
    }
  }

  async _runWebSocketSession() {
    let ws;
    try {
      ws = await connectWs({
        baseUrl: this.centerUrl,
        path: '/cluster/nodes/ws',
        token: this.sessionToken,
        timeoutMs: 10_000,
        maxMessageBytes: MAX_NODE_CONTROL_FRAME_BYTES,
      });
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        if (err.status === 403) {
          this.revoked = true;
          this.emit('revoked', err);
        }
        return 'reauth';
      }
      // Proxy or gateway does not support WebSocket Upgrade -> fall back to bounded <=25s HTTPS long-poll.
      if (err?.code === 'ws_upgrade_rejected') {
        return 'fallback_long_poll';
      }
      throw err;
    }

    this._ws = ws;
    this.transport = 'websocket';
    this.connected = true;
    this.emit('connected', { node_id: this.nodeId, transport: 'websocket' });
    this._startHeartbeatLoop();

    return new Promise(resolveSession => {
      let done = false;
      const finish = outcome => {
        if (done) return;
        done = true;
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
        if (this._ws === ws) this._ws = null;
        this.connected = false;
        this._closeAllTunnels();
        this.modelProxy?.failAllWsStreams('node_ws_disconnected');
        this.emit('disconnected', { node_id: this.nodeId, transport: 'websocket', outcome });
        resolveSession(outcome);
      };

      ws.on('text', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
        void this._handleCenterMessage(msg);
      });
      ws.on('close', info => {
        if (info?.reason === 'node_revoked') {
          this.revoked = true;
          this.emit('revoked', new Error('node_revoked'));
        }
        finish(Date.now() >= this.sessionExpiresAt - 120_000 ? 'reauth' : 'closed');
      });
      ws.on('error', () => finish('error'));
    });
  }

  async _runLongPollLoop() {
    this.transport = 'long_poll';
    let needsResume = true;
    this._startHeartbeatLoop();

    try {
      while (!this._stopping && !this.revoked) {
        if (Date.now() >= this.sessionExpiresAt - 120_000) return 'reauth';

        const controller = new AbortController();
        this._pollAbort = controller;
        const pollUrl = new URL('/cluster/nodes/poll', this.centerUrl);
        pollUrl.searchParams.set('timeout_ms', String(this.longPollTimeoutMs));
        if (needsResume) pollUrl.searchParams.set('resume', '1');

        let res;
        try {
          res = await this.fetchImpl(pollUrl.toString(), {
            method: 'GET',
            headers: { Authorization: `Bearer ${this.sessionToken}` },
            signal: controller.signal,
          });
        } catch (err) {
          this._pollAbort = null;
          if (this._stopping) break;
          // Aborted intentionally via disconnectTransport(): mark needsResume=true and reconnect.
          if (err?.name === 'AbortError') {
            this.connected = false;
            needsResume = true;
            await sleep(50);
            continue;
          }
          throw err;
        }
        this._pollAbort = null;

        if (res.status === 401) return 'reauth';
        if (res.status === 403) {
          this.revoked = true;
          this.emit('revoked', new Error('node_revoked'));
          return 'revoked';
        }
        if (!res.ok) {
          throw Object.assign(new Error(`long_poll_failed_${res.status}`), { status: res.status });
        }

        if (!this.connected) {
          this.connected = true;
          this.emit('connected', { node_id: this.nodeId, transport: 'long_poll' });
        }
        needsResume = false;

        const body = await res.json().catch(() => ({}));
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        for (const msg of messages) {
          if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
            void this._handleCenterMessage(msg);
          }
        }
      }
      return 'stopped';
    } finally {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
      this.connected = false;
    }
  }

  _startHeartbeatLoop() {
    clearInterval(this._heartbeatTimer);
    const sendBeat = async () => {
      if (this._stopping || this.revoked || !this.sessionToken) return;
      const metrics = await this.driver.collectMetrics().catch(() => ({}));
      const payload = {
        type: 'heartbeat',
        node_id: this.nodeId,
        os: normalizeNodeOs(process.platform),
        arch: normalizeNodeArch(process.arch),
        agent_version: this.agentVersion,
        transport: this.transport,
        metrics,
      };
      if (this._ws?.open) {
        this._ws.sendJson(payload);
      } else {
        await this.fetchImpl(`${this.centerUrl}/cluster/nodes/heartbeat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.sessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    };
    void sendBeat();
    this._heartbeatTimer = setInterval(() => void sendBeat(), this.heartbeatIntervalMs);
    this._heartbeatTimer.unref?.();
  }

  _sendWsFrame(frame) {
    if (!this._ws?.open) return false;
    return this._ws.sendJson({ ...frame, node_id: this.nodeId });
  }

  async _sendControlFrame(frame) {
    const tagged = { ...frame, node_id: this.nodeId };
    if (this._ws?.open) {
      if (this._ws.sendJson(tagged)) return true;
    }
    if (!this.sessionToken || !this.centerUrl) return false;
    try {
      const res = await this.fetchImpl(`${this.centerUrl}/cluster/nodes/ack`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tagged),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async _handleCenterMessage(msg) {
    const type = String(msg.type || '');
    if (type.startsWith('model.response.')) {
      this.modelProxy?.handleWsFrame(msg);
      return;
    }
    if (type === 'op.submit') {
      await this._handleOpSubmit(msg);
      return;
    }
    if (type === 'op.resume') {
      await this._handleOpResume(msg);
      return;
    }
    if (type === 'tunnel.open') {
      this._handleTunnelOpen(msg);
      return;
    }
    if (type === 'tunnel.data') {
      const sock = this._tunnels.get(String(msg.tunnel_id || ''));
      if (sock && !sock.destroyed) {
        const data = Buffer.from(String(msg.data_b64 || ''), 'base64');
        if (data.length) sock.write(data);
      }
      return;
    }
    if (type === 'tunnel.close') {
      const id = String(msg.tunnel_id || '');
      const sock = this._tunnels.get(id);
      if (sock) {
        this._tunnels.delete(id);
        try { sock.destroy(); } catch {}
      }
    }
  }

  _pruneOldOperations() {
    if (this._operations.size <= 300) return;
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, rec] of this._operations) {
      if (rec.status === 'done' && rec.updatedAt < cutoff) {
        this._operations.delete(id);
      }
    }
  }

  async _handleOpSubmit(msg) {
    const operationId = String(msg.operation_id || '');
    if (!operationId) return;
    await this._sendControlFrame({ type: 'op.ack', operation_id: operationId });

    const existing = this._operations.get(operationId);
    if (existing) {
      // Idempotent duplicate submit: replay completed result frames if already done.
      if (existing.status === 'done') {
        for (const frame of existing.resultFrames) {
          await this._sendControlFrame(frame);
        }
      }
      return;
    }

    const record = {
      operationId,
      status: 'running',
      progressFrames: [],
      resultFrames: [],
      updatedAt: Date.now(),
    };
    this._operations.set(operationId, record);
    this._pruneOldOperations();

    try {
      if (this._operationHook) {
        await this._operationHook({
          operation_id: operationId,
          method: msg.method,
          path: msg.path,
          input: msg.input,
        });
      }
      const result = await this._executeOperation(String(msg.method || 'GET'), String(msg.path || '/'), msg.input);
      const serialized = JSON.stringify(result === undefined ? null : result);
      const payloadBuf = Buffer.from(serialized, 'utf8');

      if (payloadBuf.length > this.chunkBytes) {
        const totalChunks = Math.ceil(payloadBuf.length / this.chunkBytes);
        for (let i = 0; i < totalChunks; i++) {
          const slice = payloadBuf.subarray(i * this.chunkBytes, (i + 1) * this.chunkBytes);
          record.resultFrames.push({
            type: 'op.chunk',
            operation_id: operationId,
            chunk_index: i,
            total_chunks: totalChunks,
            data_b64: slice.toString('base64'),
          });
        }
        record.resultFrames.push({
          type: 'op.result',
          operation_id: operationId,
          ok: true,
          status: 200,
          chunked: true,
          total_chunks: totalChunks,
        });
      } else {
        record.resultFrames.push({
          type: 'op.result',
          operation_id: operationId,
          ok: true,
          status: 200,
          result: result === undefined ? null : result,
        });
      }
      record.status = 'done';
      record.updatedAt = Date.now();
    } catch (err) {
      const status = err instanceof ManagerError ? err.status : Number.isSafeInteger(err?.status) ? err.status : 503;
      const code = err instanceof ManagerError ? err.message : String(err?.code || err?.message || 'manager_unavailable');
      const resultFrame = {
        type: 'op.result',
        operation_id: operationId,
        ok: false,
        status,
        error: code,
        ...(typeof err?.detail === 'string' ? { detail: err.detail } : {}),
        ...(Number.isSafeInteger(err?.limit) ? { limit: err.limit } : {}),
        ...(Number.isSafeInteger(err?.length) ? { length: err.length } : {}),
      };
      record.resultFrames.push(resultFrame);
      record.status = 'done';
      record.updatedAt = Date.now();
    }

    for (const frame of record.resultFrames) {
      await this._sendControlFrame(frame);
    }
  }

  async _handleOpResume(msg) {
    const operationId = String(msg.operation_id || '');
    const afterSeq = Number(msg.after_seq || 0);
    if (!operationId) return;
    const record = this._operations.get(operationId);
    if (!record) {
      await this._sendControlFrame({
        type: 'op.result',
        operation_id: operationId,
        ok: false,
        status: 404,
        error: 'operation_not_found',
      });
      return;
    }
    await this._sendControlFrame({ type: 'op.ack', operation_id: operationId });
    for (const frame of record.progressFrames) {
      if (Number(frame.seq || 0) > afterSeq) {
        await this._sendControlFrame(frame);
      }
    }
    if (record.status === 'done') {
      for (const frame of record.resultFrames) {
        await this._sendControlFrame(frame);
      }
    }
  }

  async _executeOperation(methodRaw, rawPath, inputRaw) {
    const method = String(methodRaw || 'GET').toUpperCase();
    const url = new URL(rawPath, 'http://node');
    const path = url.pathname;
    const input = inputRaw && typeof inputRaw === 'object' && !Array.isArray(inputRaw) ? inputRaw : {};

    // Node-internal cluster coordination routes.
    const flushProjMatch = /^\/v1\/node\/projects\/([1-9]\d{0,19})\/flush-sync$/.exec(path);
    if (flushProjMatch && method === 'POST') {
      if (!this.sync) return { flushed: false };
      const res = await this.sync.flushProjectNotes(flushProjMatch[1]);
      return { flushed: true, result: res };
    }

    const reclaimProjMatch = /^\/v1\/node\/projects\/([1-9]\d{0,19})\/reclaim-local$/.exec(path);
    if (reclaimProjMatch && method === 'POST') {
      const repoId = reclaimProjMatch[1];
      const driverRes = await this.driver.reclaimLocalProject(repoId);
      await this.sync?.clearLocalProjectCache(repoId);
      return { reclaimed: true, ...driverRes };
    }

    const flushAsstMatch = /^\/v1\/node\/assistant-computers\/([a-f0-9]{32})\/flush-sync$/.exec(path);
    if (flushAsstMatch && method === 'POST') {
      if (!this.sync || !Number.isSafeInteger(Number(input.generation)) || Number(input.generation) < 1) {
        return { flushed: false };
      }
      const res = await this.sync.flushAssistantHome(flushAsstMatch[1], Number(input.generation));
      return { flushed: true, result: res };
    }

    if (path === '/v1/node/revoke' && method === 'POST') {
      this.revoked = true;
      const cleanup = await this.driver.revokeAll();
      this.emit('revoked', new Error(String(input.reason || 'node_revoked')));
      return { revoked: true, ...cleanup };
    }

    // Sync hooks before lifecycle operations so remote containers receive fresh synced state via SyncClient.
    if (this.sync) {
      const projLifecycle = /^\/v1\/projects\/([1-9]\d{0,19})\/(start|reset|refresh|configure)$/.exec(path);
      if (projLifecycle && method === 'POST') {
        await this.sync.pullProjectNotes(projLifecycle[1]).catch(() => {});
      }
      const asstAcquire = /^\/v1\/assistant-computers\/([a-f0-9]{32})$/.exec(path);
      if (asstAcquire && method === 'PUT' && Number.isSafeInteger(Number(input.home_generation))) {
        await this.sync.pullAssistantHome(asstAcquire[1], Number(input.home_generation)).catch(() => {});
      }
    }

    const result = await this.driver.dispatchLocalManagerRequest(method, rawPath, input);

    if (this.sync) {
      const asstRelease = /^\/v1\/assistant-computers\/([a-f0-9]{32})\/release$/.exec(path);
      if (asstRelease && method === 'POST' && Number.isSafeInteger(Number(result?.home_generation))) {
        await this.sync.flushAssistantHome(asstRelease[1], Number(result.home_generation)).catch(() => {});
      }
    }
    return result;
  }

  /**
   * Default-deny TCP tunnel handler reserved for #1379 (remote SSH target connectivity over node WS).
   * Connects ONLY when `allowTunnel === true` and ONLY to the exact `host:port` specified by control plane.
   */
  _handleTunnelOpen(msg) {
    const tunnelId = String(msg.tunnel_id || '');
    if (!tunnelId) return;
    if (!this.allowTunnel) {
      this._sendWsFrame({ type: 'tunnel.error', tunnel_id: tunnelId, error: 'tunnel_disabled' });
      return;
    }
    const host = typeof msg.host === 'string' ? msg.host.trim() : '';
    const port = Number(msg.port);
    if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      this._sendWsFrame({ type: 'tunnel.error', tunnel_id: tunnelId, error: 'invalid_tunnel_target' });
      return;
    }

    const sock = net.createConnection({ host, port });
    let opened = false;
    this._tunnels.set(tunnelId, sock);

    sock.once('connect', () => {
      opened = true;
      this._sendWsFrame({ type: 'tunnel.opened', tunnel_id: tunnelId });
    });
    sock.on('data', chunk => {
      this._sendWsFrame({
        type: 'tunnel.data',
        tunnel_id: tunnelId,
        data_b64: Buffer.from(chunk).toString('base64'),
      });
    });
    sock.once('error', err => {
      this._tunnels.delete(tunnelId);
      if (!opened) {
        this._sendWsFrame({
          type: 'tunnel.error',
          tunnel_id: tunnelId,
          error: err?.code || 'tunnel_connect_failed',
        });
      } else {
        this._sendWsFrame({ type: 'tunnel.close', tunnel_id: tunnelId });
      }
    });
    sock.once('close', () => {
      if (this._tunnels.delete(tunnelId)) {
        this._sendWsFrame({ type: 'tunnel.close', tunnel_id: tunnelId });
      }
    });
  }

  _closeAllTunnels() {
    for (const [id, sock] of [...this._tunnels.entries()]) {
      this._tunnels.delete(id);
      try { sock.destroy(); } catch {}
    }
  }
}

async function runCli() {
  process.umask(0o077);
  const centerUrl = process.env.BOT_CENTER_URL || process.env.BOT_CONTROL_PLANE_URL;
  if (!centerUrl) {
    console.error('[node-agent] BOT_CENTER_URL is required');
    process.exit(1);
  }
  const healthPort = process.env.BOT_NODE_HEALTH_PORT ? Number(process.env.BOT_NODE_HEALTH_PORT) : 8795;
  const agent = new NodeAgent({
    centerUrl,
    pairingToken: process.env.BOT_NODE_PAIRING_TOKEN || '',
    healthPort: Number.isSafeInteger(healthPort) && healthPort > 0 ? healthPort : 8795,
  });

  agent.on('paired', ({ node_id }) => console.log(`[node-agent] paired successfully as node ${node_id}`));
  agent.on('connected', ({ node_id, transport }) => console.log(`[node-agent] connected as ${node_id} via ${transport}`));
  agent.on('disconnected', ({ node_id, transport, outcome }) => console.warn(`[node-agent] disconnected (${node_id}/${transport}): ${outcome}`));
  agent.on('protocol_incompatible', err => console.error(`[node-agent] protocol version mismatch: ${err.message}`));
  agent.on('revoked', () => console.error('[node-agent] node has been revoked by control plane; stopping'));

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      void agent.stop().finally(() => process.exit(0));
    });
  }

  await agent.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch(err => {
    console.error('[node-agent] fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
