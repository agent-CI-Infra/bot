import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export const defaultRelayIdleMs = 135_000;
export const defaultMaxRequestBytes = 8 * 1024 * 1024;

function extractRunToken(headers) {
  const rawKey = headers['x-api-key'];
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : Array.isArray(rawKey) && typeof rawKey[0] === 'string' ? rawKey[0].trim() : '';
  const rawAuth = typeof headers.authorization === 'string' ? headers.authorization.trim() : '';
  const bearerMatch = rawAuth ? /^Bearer\s+(\S+)$/i.exec(rawAuth) : null;
  if (rawAuth && !bearerMatch) return null;
  const bearer = bearerMatch ? bearerMatch[1] : '';
  if (apiKey && bearer && apiKey !== bearer) return null;
  const token = apiKey || bearer;
  return token && !/\s/.test(token) && token.length <= 4096 ? token : null;
}

function classifyEndpoint(method, pathname) {
  if (method === 'GET' && pathname === '/v1/models') return 'models';
  if (method === 'POST' && pathname === '/v1/messages') return 'messages';
  if (method === 'POST' && pathname === '/v1/responses') return 'responses';
  if (method === 'POST' && pathname === '/v1/chat/completions') return 'chat_completions';
  return null;
}

function formatErrorBody(endpoint, code, message = code) {
  if (endpoint === 'messages') return JSON.stringify({ type: 'error', error: { type: code, message } });
  return JSON.stringify({ error: { message, type: code, code } });
}

function pickForwardHeaders(headers) {
  const out = {};
  for (const name of ['anthropic-beta', 'anthropic-version', 'openai-beta']) {
    const val = headers[name];
    if (typeof val === 'string' && val.length > 0 && val.length <= 4096) out[name] = val;
  }
  return out;
}

export async function startModelRelay({
  agentDir,
  signal,
  pollMs = 25,
  idleTimeoutMs = defaultRelayIdleMs,
  maxBodyBytes = defaultMaxRequestBytes,
}) {
  if (!agentDir || typeof agentDir !== 'string') throw new Error('model_relay_agent_dir_required');
  const reqDir = agentDir + '/model-requests';
  const repDir = agentDir + '/model-replies';
  await mkdir(reqDir, { recursive: true, mode: 0o700 });
  await mkdir(repDir, { recursive: true, mode: 0o700 });

  let closing = false;
  const inflight = new Set();
  let onDrained = null;

  const server = createServer(async (req, res) => {
    const tracker = Symbol();
    inflight.add(tracker);
    let url;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
    catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(formatErrorBody(null, 'invalid_request_error', 'invalid_url'));
      inflight.delete(tracker);
      if (!inflight.size && onDrained) onDrained();
      return;
    }
    const endpoint = classifyEndpoint(req.method || 'GET', url.pathname);
    const sendError = (status, code, message = code) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(formatErrorBody(endpoint, code, message));
    };

    if (closing || signal?.aborted) {
      sendError(401, 'run_token_revoked');
      inflight.delete(tracker);
      if (!inflight.size && onDrained) onDrained();
      return;
    }

    const token = extractRunToken(req.headers);
    if (!token) {
      sendError(401, 'authentication_error', 'missing_or_invalid_run_token');
      inflight.delete(tracker);
      if (!inflight.size && onDrained) onDrained();
      return;
    }

    if (!endpoint) {
      sendError(403, 'endpoint_not_allowed');
      inflight.delete(tracker);
      if (!inflight.size && onDrained) onDrained();
      return;
    }

    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      let bytes = 0;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > maxBodyBytes) {
            sendError(413, 'request_too_large');
            inflight.delete(tracker);
            if (!inflight.size && onDrained) onDrained();
            return;
          }
          chunks.push(chunk);
        }
      } catch {
        sendError(400, 'invalid_request_error', 'request_stream_aborted');
        inflight.delete(tracker);
        if (!inflight.size && onDrained) onDrained();
        return;
      }
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not_object');
      } catch {
        sendError(400, 'invalid_request_error');
        inflight.delete(tracker);
        if (!inflight.size && onDrained) onDrained();
        return;
      }
    }

    const id = randomBytes(24).toString('hex');
    const reqPath = `${reqDir}/${id}.json`;
    const reqTmp = `${reqDir}/${id}.tmp`;
    const streamPath = `${repDir}/${id}.stream`;
    const cursorPath = `${repDir}/${id}.cursor.json`;
    const cursorTmp = `${repDir}/${id}.cursor.tmp`;

    let clientClosed = false;
    const onClose = () => { if (!res.writableEnded) clientClosed = true; };
    req.once('aborted', () => { clientClosed = true; });
    res.once('close', onClose);

    try {
      const envelope = {
        id,
        endpoint,
        query: url.search || '',
        token,
        headers: pickForwardHeaders(req.headers),
        body,
      };
      await writeFile(reqTmp, JSON.stringify(envelope), { mode: 0o600 });
      await rename(reqTmp, reqPath);

      let readOffset = 0;
      let headersSent = false;
      let lastKeepalive = 0;
      let lastActivity = Date.now();

      while (!closing && !signal?.aborted && !clientClosed) {
        const cursor = await readFile(cursorPath, 'utf8').then(JSON.parse).catch(() => null);
        if (cursor) {
          if (Number.isInteger(cursor.keepalive) && cursor.keepalive > lastKeepalive) {
            lastKeepalive = cursor.keepalive;
            lastActivity = Date.now();
          }
          if (!headersSent && Number.isInteger(cursor.status)) {
            const outHeaders = cursor.headers && typeof cursor.headers === 'object' ? cursor.headers : { 'content-type': 'application/json' };
            res.writeHead(cursor.status, outHeaders);
            headersSent = true;
            lastActivity = Date.now();
          }
          const target = Number.isSafeInteger(cursor.written) ? cursor.written : 0;
          if (target > readOffset) {
            const handle = await open(streamPath, 'r').catch(() => null);
            if (handle) {
              try {
                while (readOffset < target && !clientClosed && !closing && !signal?.aborted) {
                  const len = Math.min(65536, target - readOffset);
                  const buf = Buffer.allocUnsafe(len);
                  const { bytesRead } = await handle.read(buf, 0, len, readOffset);
                  if (bytesRead <= 0) break;
                  readOffset += bytesRead;
                  lastActivity = Date.now();
                  const slice = bytesRead === len ? buf : buf.subarray(0, bytesRead);
                  if (!res.write(slice)) await once(res, 'drain');
                }
              } finally {
                await handle.close();
              }
            }
          }
          if (cursor.error) {
            if (!headersSent) sendError(502, 'api_error', String(cursor.error));
            else res.destroy();
            break;
          }
          if (cursor.done && readOffset >= target) {
            if (!headersSent) res.writeHead(200, { 'content-type': 'application/json' });
            res.end();
            break;
          }
        }
        if (Date.now() - lastActivity >= idleTimeoutMs) {
          sendError(504, 'provider_timeout');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      if ((closing || signal?.aborted) && !res.writableEnded) {
        sendError(401, 'run_token_revoked');
      }
    } catch {
      sendError(502, 'api_error');
    } finally {
      res.removeListener('close', onClose);
      await Promise.all([
        unlink(reqTmp).catch(() => {}),
        unlink(reqPath).catch(() => {}),
        unlink(streamPath).catch(() => {}),
        unlink(cursorPath).catch(() => {}),
        unlink(cursorTmp).catch(() => {}),
      ]);
      inflight.delete(tracker);
      if (!inflight.size && onDrained) onDrained();
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const close = async () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
    if (inflight.size) await new Promise(resolve => { onDrained = resolve; });
  };
  if (signal) {
    if (signal.aborted) await close();
    else signal.addEventListener('abort', () => { void close(); }, { once: true });
  }
  return { url: `http://127.0.0.1:${port}`, port, close };
}
