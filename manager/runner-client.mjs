import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { ManagerError } from './docker.mjs';
import { requestTooLarge, runnerRequestLimit } from '../runner/command-policy.mjs';
import { DEFAULT_LONG_POLL_WAIT_MS, connectWs } from '../runner/wire-protocol.mjs';

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const COMMAND_TYPES = new Set(['command', 'workspace_command']);

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function extractCliConfigHeader(extraEnv) {
  if (!Array.isArray(extraEnv)) return null;
  for (const entry of extraEnv) {
    if (typeof entry === 'string' && entry.startsWith('BOT_CLI_CONFIG_B64=')) {
      return entry.slice('BOT_CLI_CONFIG_B64='.length);
    }
  }
  return null;
}

/**
 * Unified HTTP/1.1 + WebSocket client for the resident in-container runner daemon (`runner/daemon.mjs`).
 * Supports both local private Unix Domain Sockets (`/run/bot-runner/runner.sock`) and controlled
 * TCP/HTTPS endpoints for future remote execution nodes, with automatic fallback from WebSocket
 * streaming to bounded <=25s HTTP long-polling.
 */
export class RunnerClient {
  constructor({
    socketPath = null,
    baseUrl = null,
    token = null,
    preferWs = true,
    heartbeatTimeoutMs = 30_000,
    longPollWaitMs = DEFAULT_LONG_POLL_WAIT_MS,
    wsPingMs = 15_000,
  } = {}) {
    if (!socketPath && !baseUrl) {
      throw new ManagerError('runner_endpoint_missing', 503);
    }
    this.socketPath = socketPath || null;
    this.baseUrl = baseUrl ? new URL(baseUrl) : null;
    this.isHttps = this.baseUrl?.protocol === 'https:';
    this.token = token || null;
    this.preferWs = preferWs !== false;
    this.heartbeatTimeoutMs = Math.max(1_000, Number(heartbeatTimeoutMs) || 30_000);
    this.longPollWaitMs = Math.max(100, Math.min(DEFAULT_LONG_POLL_WAIT_MS, Number(longPollWaitMs) || DEFAULT_LONG_POLL_WAIT_MS));
    this.wsPingMs = Math.max(1_000, Number(wsPingMs) || 15_000);

    this.agent = new (this.isHttps ? https.Agent : http.Agent)({ keepAlive: true, maxSockets: 16 });
    this.closed = false;
    this._ws = null;
    this._wsConnecting = null;
    this._wsUnsupported = false;
    this._wsPingTimer = null;
    this._commandListeners = new Map(); // operationId -> Set<fn>
    this._mailboxListeners = new Map(); // workspaceId -> Set<fn>
  }

  _request(method, path, {
    body = undefined,
    contentType = null,
    headers = {},
    timeoutMs = 90_000,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    raw = false,
  } = {}) {
    if (this.closed) return Promise.reject(new ManagerError('runner_closed', 503));
    const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_RESPONSE_BYTES;
    const isStream = body instanceof Readable;
    let payload = null;
    const reqHeaders = { ...headers };
    if (this.token) reqHeaders.Authorization = 'Bearer ' + this.token;
    if (!isStream && body !== undefined) {
      if (Buffer.isBuffer(body)) {
        payload = body;
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = contentType || 'application/octet-stream';
      } else if (typeof body === 'string') {
        payload = Buffer.from(body, 'utf8');
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = contentType || 'application/json';
      } else {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = contentType || 'application/json';
      }
      reqHeaders['Content-Length'] = String(payload.length);
    } else if (isStream && contentType && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = contentType;
    }

    return new Promise((resolve, reject) => {
      let req;
      if (this.socketPath) {
        req = http.request({
          socketPath: this.socketPath,
          agent: this.agent,
          method,
          path,
          headers: reqHeaders,
        });
      } else {
        const target = new URL(path, this.baseUrl);
        const transport = this.isHttps ? https : http;
        req = transport.request(target, {
          agent: this.agent,
          method,
          headers: reqHeaders,
        });
      }

      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value);
      };

      req.on('response', res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > limit) {
            req.destroy(Object.assign(new ManagerError('runner_response_too_large', 503), { limit, size }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode || 0;
          if (status === 401) {
            finish(new ManagerError('runner_unauthorized', 503));
            return;
          }
          if (status === 413) {
            let parsed = null;
            try { parsed = JSON.parse(buf.toString('utf8')); } catch {}
            if (parsed?.error === 'runner_request_too_large') {
              finish(Object.assign(new ManagerError('runner_request_too_large', 413), parsed));
              return;
            }
            finish(Object.assign(new ManagerError(parsed?.error || 'payload_too_large', 413), parsed || {}));
            return;
          }
          if (raw) {
            finish(null, { status, headers: res.headers, body: buf });
            return;
          }
          let parsed = null;
          if (buf.length > 0) {
            try {
              parsed = JSON.parse(buf.toString('utf8'));
            } catch {
              finish(new ManagerError('runner_protocol_failed', 503));
              return;
            }
          }
          finish(null, { status, headers: res.headers, body: parsed });
        });
        res.on('error', err => finish(err));
      });

      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => req.destroy(new Error('docker_timeout')));
      }
      req.on('error', err => {
        if (err instanceof ManagerError || err?.message === 'docker_timeout') {
          finish(err);
          return;
        }
        finish(Object.assign(new ManagerError('runner_failed', 503), {
          code: err?.code,
          detail: String(err?.message || err),
        }));
      });

      if (isStream) {
        body.on('error', err => req.destroy(err));
        body.pipe(req);
      } else {
        req.end(payload);
      }
    });
  }

  async health(timeoutMs = 5_000) {
    const res = await this._request('GET', '/v1/health', { timeoutMs });
    if (res.status !== 200 || !res.body) throw new ManagerError('runner_not_ready', 503);
    return res.body;
  }

  async waitReady({ timeoutMs = 15_000, isAlive = null } = {}) {
    const deadline = Date.now() + Math.max(100, timeoutMs);
    let backoff = 20;
    let lastCheckAlive = 0;
    let lastError = null;
    while (!this.closed && Date.now() < deadline) {
      const remaining = Math.max(100, deadline - Date.now());
      try {
        const res = await this.health(Math.min(2_000, remaining));
        if (res?.ok && res.result?.ready) return res;
      } catch (err) {
        if (err instanceof ManagerError && err.message === 'runner_unauthorized') throw err;
        lastError = err;
      }
      const now = Date.now();
      if (isAlive && now - lastCheckAlive >= 250) {
        lastCheckAlive = now;
        const alive = await isAlive().catch(() => true);
        if (!alive) {
          throw Object.assign(new ManagerError('runner_not_ready', 503), {
            detail: 'container exited before runner daemon became ready',
          });
        }
      }
      const sleepMs = Math.min(backoff, Math.max(10, deadline - Date.now()));
      if (sleepMs > 0) await delay(sleepMs);
      backoff = Math.min(100, backoff * 2);
    }
    throw Object.assign(new ManagerError('runner_not_ready', 503), {
      detail: lastError?.detail || lastError?.message || 'runner daemon health timeout',
    });
  }

  async ensureWs() {
    if (this.closed || !this.preferWs || this._wsUnsupported) return null;
    if (this._ws?.open) return this._ws;
    if (this._wsConnecting) return this._wsConnecting;

    this._wsConnecting = (async () => {
      try {
        const ws = await connectWs({
          socketPath: this.socketPath,
          baseUrl: this.baseUrl ? this.baseUrl.toString() : null,
          path: '/v1/ws',
          token: this.token,
          timeoutMs: 5_000,
          maxMessageBytes: runnerRequestLimit + 1024 * 1024,
        });
        if (this.closed) {
          ws.close(1000, 'client_closed');
          return null;
        }
        this._ws = ws;
        this._attachWsHandlers(ws);
        // Re-subscribe active mailbox watches after reconnect.
        for (const wsId of this._mailboxListeners.keys()) {
          ws.sendJson({ type: 'mailbox.watch', workspace_id: wsId });
        }
        return ws;
      } catch (err) {
        if (err?.code === 'ws_upgrade_rejected' && [400, 404, 426, 501].includes(err.status)) {
          this._wsUnsupported = true;
        }
        return null;
      } finally {
        this._wsConnecting = null;
      }
    })();

    return this._wsConnecting;
  }

  _attachWsHandlers(ws) {
    clearInterval(this._wsPingTimer);
    this._wsPingTimer = setInterval(() => {
      if (this._ws === ws && ws.open) ws.ping();
    }, this.wsPingMs);
    this._wsPingTimer.unref?.();

    const onDisconnect = () => {
      if (this._ws === ws) {
        this._ws = null;
        clearInterval(this._wsPingTimer);
        this._wsPingTimer = null;
      }
      for (const listeners of this._commandListeners.values()) {
        for (const fn of [...listeners]) fn({ type: 'ws.disconnected' });
      }
    };

    ws.on('close', onDisconnect);
    ws.on('error', onDisconnect);
    ws.on('text', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'command.output' || msg.type === 'command.heartbeat' || msg.type === 'command.done' || msg.type === 'command.missing') {
        const listeners = this._commandListeners.get(msg.operation_id);
        if (listeners) {
          for (const fn of [...listeners]) fn(msg);
        }
        return;
      }
      if (msg.type === 'mailbox.event') {
        const listeners = this._mailboxListeners.get(msg.workspace_id);
        if (listeners) {
          for (const fn of [...listeners]) {
            try { fn(msg); } catch {}
          }
        }
      }
    });
  }

  async startCommand(input, { timeoutMs = 30_000 } = {}) {
    const tooLarge = requestTooLarge(input);
    if (tooLarge) throw Object.assign(new ManagerError(tooLarge.error, 413), tooLarge);
    const res = await this._request('POST', '/v1/commands', { body: input, timeoutMs });
    if ((res.status !== 200 && res.status !== 202) || !res.body?.ok) {
      throw Object.assign(new ManagerError(res.body?.error || 'runner_failed', res.status >= 400 && res.status < 500 ? res.status : 503), res.body || {});
    }
    return res.body;
  }

  async commandStatus(operationId, { timeoutMs = 15_000 } = {}) {
    const res = await this._request('GET', `/v1/commands/${encodeURIComponent(operationId)}`, { timeoutMs });
    if (res.status === 404) return null;
    if (res.status !== 200 || !res.body) throw new ManagerError('runner_failed', 503);
    return res.body;
  }

  async waitCommand(operationId, { offset = 0, timeoutMs = this.longPollWaitMs } = {}) {
    const waitMs = Math.max(100, Math.min(DEFAULT_LONG_POLL_WAIT_MS, Number(timeoutMs) || this.longPollWaitMs));
    const query = `offset=${Math.max(0, Number(offset) || 0)}&timeout_ms=${waitMs}`;
    const res = await this._request('GET', `/v1/commands/${encodeURIComponent(operationId)}/wait?${query}`, {
      timeoutMs: waitMs + 15_000,
    });
    return res;
  }

  async cancelCommand(operationId, { timeoutMs = 15_000 } = {}) {
    const res = await this._request('POST', `/v1/commands/${encodeURIComponent(operationId)}/cancel`, { timeoutMs });
    if (res.status !== 200 || !res.body) throw new ManagerError('runner_failed', 503);
    return res.body;
  }

  async _awaitCommandCompletion(operationId, { timeoutMs = 0, onOutput = null } = {}) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    let offset = 0;

    // 1. Primary path: live WebSocket streaming with heartbeats.
    const ws = await this.ensureWs();
    if (ws?.open) {
      const wsResult = await new Promise((resolve, reject) => {
        let settled = false;
        let heartbeatTimer = null;
        let deadlineTimer = null;

        const cleanup = () => {
          clearTimeout(heartbeatTimer);
          clearTimeout(deadlineTimer);
          const set = this._commandListeners.get(operationId);
          if (set) {
            set.delete(onMessage);
            if (!set.size) this._commandListeners.delete(operationId);
          }
          if (ws.open) {
            ws.sendJson({ type: 'command.unsubscribe', operation_id: operationId });
          }
        };

        const done = (err, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) reject(err);
          else resolve(value);
        };

        const armHeartbeat = () => {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = setTimeout(() => {
            // No heartbeat or output on WS within window: hand off cleanly to HTTP long-poll probe.
            done(null, { fallback: true });
          }, this.heartbeatTimeoutMs);
          heartbeatTimer.unref?.();
        };

        const onMessage = msg => {
          if (msg.type === 'client.closed') {
            done(new ManagerError('runner_closed', 503));
            return;
          }
          if (msg.type === 'ws.disconnected') {
            done(null, { fallback: true });
            return;
          }
          if (msg.type === 'command.missing') {
            done(new ManagerError('runner_failed', 503));
            return;
          }
          if (msg.type === 'command.heartbeat') {
            armHeartbeat();
            return;
          }
          if (msg.type === 'command.output') {
            armHeartbeat();
            const nextOffset = Number(msg.output_bytes);
            if (Number.isFinite(nextOffset) && nextOffset > offset) {
              offset = nextOffset;
            }
            try { onOutput?.(msg); } catch {}
            return;
          }
          if (msg.type === 'command.done') {
            done(null, { done: true, response: msg.response });
          }
        };

        let set = this._commandListeners.get(operationId);
        if (!set) { set = new Set(); this._commandListeners.set(operationId, set); }
        set.add(onMessage);

        armHeartbeat();
        if (Number.isFinite(deadline)) {
          const remaining = Math.max(1, deadline - Date.now());
          deadlineTimer = setTimeout(() => done(new Error('docker_timeout')), remaining);
          deadlineTimer.unref?.();
        }

        if (!ws.sendJson({ type: 'command.subscribe', operation_id: operationId, offset })) {
          done(null, { fallback: true });
        }
      });

      if (wsResult?.done) return wsResult.response;
    }

    // 2. Fallback / recovery path: bounded <=25s HTTP long-poll loop (immune to 100s gateway timeouts).
    while (!this.closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('docker_timeout');
      const stepWait = Number.isFinite(remaining)
        ? Math.max(100, Math.min(this.longPollWaitMs, remaining))
        : this.longPollWaitMs;
      const res = await this.waitCommand(operationId, { offset, timeoutMs: stepWait });
      if (res.status === 404) throw new ManagerError('runner_failed', 503);
      if (res.status !== 200 || !res.body?.ok) throw new ManagerError('runner_failed', 503);
      const body = res.body;
      if (body.data) {
        try {
          onOutput?.({
            type: 'command.output',
            operation_id: operationId,
            offset,
            data: body.data,
            output_bytes: body.output_bytes ?? body.offset,
          });
        } catch {}
      }
      if (Number.isFinite(body.offset) && body.offset > offset) {
        offset = body.offset;
      }
      if (body.state === 'completed') {
        return body.response;
      }
    }
    throw new ManagerError('runner_closed', 503);
  }

  async execute(input, { timeoutMs = 90_000, extraEnv = [], onOutput = null } = {}) {
    const tooLarge = requestTooLarge(input);
    if (tooLarge) throw Object.assign(new ManagerError(tooLarge.error, 413), tooLarge);

    if (COMMAND_TYPES.has(input?.type)) {
      const submitTimeout = timeoutMs > 0 ? Math.min(timeoutMs, 30_000) : 30_000;
      const started = await this.startCommand(input, { timeoutMs: submitTimeout });
      if (started.state === 'completed' && started.response) return started.response;
      return this._awaitCommandCompletion(input.operation_id, { timeoutMs, onOutput });
    }

    const cliConfigB64 = extractCliConfigHeader(extraEnv);
    const headers = cliConfigB64 ? { 'x-bot-cli-config-b64': cliConfigB64 } : {};
    const res = await this._request('POST', '/v1/execute', {
      body: input,
      headers,
      timeoutMs,
    });
    if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
      throw Object.assign(new ManagerError('runner_failed', 503), {
        detail: `POST /v1/execute -> HTTP ${res.status}`,
      });
    }
    return res.body;
  }

  async uploadBlob(kind, id, dataOrStream, { workspaceId = null, timeoutMs = 300_000 } = {}) {
    const headers = workspaceId ? { 'x-bot-workspace-id': workspaceId } : {};
    const res = await this._request('PUT', `/v1/blobs/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
      body: dataOrStream,
      contentType: 'application/octet-stream',
      headers,
      timeoutMs,
    });
    if (res.status !== 200 || !res.body?.ok) {
      throw Object.assign(new ManagerError(res.body?.error || 'blob_upload_failed', res.status || 503), res.body || {});
    }
    return res.body.result;
  }

  async downloadBlob(kind, id, { workspaceId = null, offset = 0, timeoutMs = 300_000, maxBytes = 64 * 1024 * 1024 } = {}) {
    const headers = workspaceId ? { 'x-bot-workspace-id': workspaceId } : {};
    const query = offset > 0 ? `?offset=${Math.max(0, Number(offset) || 0)}` : '';
    const res = await this._request('GET', `/v1/blobs/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${query}`, {
      headers,
      timeoutMs,
      maxBytes,
      raw: true,
    });
    if (res.status !== 200) {
      let parsed = null;
      try { parsed = JSON.parse(res.body.toString('utf8')); } catch {}
      throw Object.assign(new ManagerError(parsed?.error || 'blob_download_failed', res.status || 503), parsed || {});
    }
    return {
      buffer: res.body,
      totalSize: Number(res.headers['x-bot-blob-size'] || res.body.length),
    };
  }

  async watchMailbox(workspaceId, onEvent) {
    let set = this._mailboxListeners.get(workspaceId);
    const first = !set;
    if (!set) { set = new Set(); this._mailboxListeners.set(workspaceId, set); }
    set.add(onEvent);
    if (first) {
      const ws = await this.ensureWs();
      if (ws?.open) ws.sendJson({ type: 'mailbox.watch', workspace_id: workspaceId });
    }
    return () => {
      const cur = this._mailboxListeners.get(workspaceId);
      if (!cur) return;
      cur.delete(onEvent);
      if (!cur.size) {
        this._mailboxListeners.delete(workspaceId);
        if (this._ws?.open) this._ws.sendJson({ type: 'mailbox.unwatch', workspace_id: workspaceId });
      }
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._wsPingTimer);
    this._wsPingTimer = null;
    for (const listeners of this._commandListeners.values()) {
      for (const fn of [...listeners]) fn({ type: 'client.closed' });
    }
    this._commandListeners.clear();
    this._mailboxListeners.clear();
    if (this._ws) {
      try { this._ws.close(1000, 'client_closed'); } catch {}
      this._ws = null;
    }
    this.agent.destroy();
  }
}
