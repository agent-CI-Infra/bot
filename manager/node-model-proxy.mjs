import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;

function extractRunToken(headers) {
  const auth = typeof headers.authorization === 'string' ? headers.authorization.trim() : '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const xApiKey = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'].trim() : '';
  if (xApiKey) return xApiKey;
  const xGoog = typeof headers['x-goog-api-key'] === 'string' ? headers['x-goog-api-key'].trim() : '';
  if (xGoog) return xGoog;
  return '';
}

function readRequestBody(req, limit = MAX_PROXY_REQUEST_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        rejectBody(Object.assign(new Error('gateway_request_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

/**
 * Node-local UDS passthrough model gateway (`/run/model-gateway/gateway.sock`).
 * Containers authenticate with their short-lived `rrt_...` run token and never see a long-term API key.
 * Requests are streamed to the control plane either over the active authenticated node WS connection
 * (`model.request` / `model.response.*`) or over HTTPS streaming `POST /cluster/nodes/model-proxy`.
 */
export class NodeModelProxy {
  constructor(options) {
    this.socketPath = resolve(options.socketPath || '/run/model-gateway/gateway.sock');
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.getSessionToken = options.getSessionToken;
    this.sendWsFrame = options.sendWsFrame ?? null;
    this.isWsOpen = options.isWsOpen ?? (() => false);
    this.server = null;
    this._wsStreams = new Map(); // streamId -> { res, headSent }
  }

  async start() {
    if (this.server) return this.socketPath;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o755 });
    await unlink(this.socketPath).catch(() => {});

    const server = http.createServer((req, res) => {
      void this._handleRequest(req, res);
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;

    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.socketPath, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    await chmod(this.socketPath, 0o660).catch(() => {});
    this.server = server;
    return this.socketPath;
  }

  /**
   * Routes incoming `model.response.*` frames received on the node WebSocket to pending local UDS responses.
   */
  handleWsFrame(msg) {
    const streamId = String(msg?.stream_id || '');
    const entry = this._wsStreams.get(streamId);
    if (!entry) return false;
    const { res } = entry;
    const type = String(msg.type || '');

    if (type === 'model.response.head') {
      if (!entry.headSent && !res.headersSent && !res.destroyed) {
        entry.headSent = true;
        const status = Number.isSafeInteger(msg.status) ? msg.status : 200;
        const headers = msg.headers && typeof msg.headers === 'object' ? { ...msg.headers } : {};
        delete headers['transfer-encoding'];
        delete headers['connection'];
        res.writeHead(status, headers);
      }
      return true;
    }

    if (type === 'model.response.chunk') {
      if (!res.destroyed && !res.writableEnded) {
        if (!entry.headSent && !res.headersSent) {
          entry.headSent = true;
          res.writeHead(200);
        }
        const chunk = Buffer.from(String(msg.data_b64 || ''), 'base64');
        if (chunk.length) res.write(chunk);
      }
      return true;
    }

    if (type === 'model.response.end') {
      this._wsStreams.delete(streamId);
      if (!res.destroyed && !res.writableEnded) res.end();
      return true;
    }

    if (type === 'model.response.error') {
      this._wsStreams.delete(streamId);
      if (!res.headersSent && !res.destroyed) {
        const status = Number.isSafeInteger(msg.status) ? msg.status : 502;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: String(msg.error || 'model_gateway_error') } }));
      } else if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
      return true;
    }

    return false;
  }

  failAllWsStreams(reason = 'node_ws_disconnected') {
    for (const [streamId, entry] of [...this._wsStreams.entries()]) {
      this._wsStreams.delete(streamId);
      if (!entry.res.headersSent && !entry.res.destroyed) {
        entry.res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        entry.res.end(JSON.stringify({ error: { message: reason } }));
      } else if (!entry.res.destroyed && !entry.res.writableEnded) {
        entry.res.end();
      }
    }
  }

  async _handleRequest(req, res) {
    req.setTimeout(0);
    res.setTimeout(0);
    const runToken = extractRunToken(req.headers);
    if (!runToken) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'missing_run_token' } }));
      return;
    }

    let bodyBuf;
    try {
      bodyBuf = await readRequestBody(req);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err?.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: err?.message || 'invalid_request' } }));
      }
      return;
    }

    const reqPath = req.url || '/v1/chat/completions';
    const method = req.method || 'POST';

    // Prefer multiplexing over active authenticated node WS; fallback to streaming HTTP `/cluster/nodes/model-proxy`.
    if (this.sendWsFrame && this.isWsOpen()) {
      const streamId = randomBytes(12).toString('hex');
      const forwardHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (['host', 'connection', 'transfer-encoding', 'content-length'].includes(lk)) continue;
        if (v !== undefined) forwardHeaders[lk] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      this._wsStreams.set(streamId, { res, headSent: false });
      res.once('close', () => {
        if (this._wsStreams.delete(streamId)) {
          this.sendWsFrame({ type: 'model.abort', stream_id: streamId });
        }
      });
      const sent = this.sendWsFrame({
        type: 'model.request',
        stream_id: streamId,
        method,
        path: reqPath,
        headers: forwardHeaders,
        body_b64: bodyBuf.toString('base64'),
      });
      if (sent) return;
      this._wsStreams.delete(streamId);
    }

    const sessionToken = this.getSessionToken?.();
    if (!sessionToken || !this.baseUrl) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'node_model_gateway_disconnected' } }));
      return;
    }

    const proxyUrl = new URL('/cluster/nodes/model-proxy', this.baseUrl);
    proxyUrl.searchParams.set('path', reqPath);
    proxyUrl.searchParams.set('method', method);

    const headers = {
      Authorization: `Bearer ${sessionToken}`,
      'x-bot-run-token': runToken,
      'Content-Type': String(req.headers['content-type'] || 'application/json'),
      'Content-Length': String(bodyBuf.length),
    };
    if (typeof req.headers.accept === 'string') headers.Accept = req.headers.accept;
    if (typeof req.headers['anthropic-version'] === 'string') headers['anthropic-version'] = req.headers['anthropic-version'];
    if (typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta'];

    const transport = proxyUrl.protocol === 'https:' ? https : http;
    const upstream = transport.request(proxyUrl, { method: 'POST', headers }, upRes => {
      const respHeaders = { ...upRes.headers };
      delete respHeaders['transfer-encoding'];
      delete respHeaders['connection'];
      if (!res.headersSent) {
        res.writeHead(upRes.statusCode || 502, respHeaders);
      }
      upRes.pipe(res);
    });
    upstream.setTimeout(0);
    upstream.on('error', err => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: err?.code || 'model_proxy_failed' } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    res.once('close', () => {
      if (!upstream.destroyed) upstream.destroy();
    });
    upstream.end(bodyBuf);
  }

  async close() {
    this.failAllWsStreams('node_model_proxy_closed');
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise(resolveClose => {
        srv.close(() => resolveClose());
        srv.closeAllConnections?.();
      });
    }
    await unlink(this.socketPath).catch(() => {});
  }
}
