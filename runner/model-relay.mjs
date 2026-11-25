import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';

export const DEFAULT_MODEL_GATEWAY_SOCKET = '/run/model-gateway/gateway.sock';
const isLocalExecution = () => process.env.BOT_LOCAL_EXECUTION === 'true';

export function resolveModelBridgeTarget({ socketPath, targetUrl } = {}, isLocal = isLocalExecution()) {
  // In container mode, always pin to the read-only mounted control-plane UDS socket.
  // Never honor arbitrary URLs or paths from task config files.
  if (!isLocal) {
    return { kind: 'uds', path: DEFAULT_MODEL_GATEWAY_SOCKET };
  }
  if (typeof socketPath === 'string' && socketPath.startsWith('/')) {
    return { kind: 'uds', path: socketPath };
  }
  if (typeof targetUrl === 'string' && targetUrl) {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new Error('model_gateway_url_invalid');
    }
    const host = parsed.hostname;
    const port = Number(parsed.port);
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]', '::1'].includes(host) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error('model_gateway_url_invalid');
    }
    return { kind: 'tcp', host: host === '[::1]' ? '::1' : host, port };
  }
  return { kind: 'uds', path: DEFAULT_MODEL_GATEWAY_SOCKET };
}

/**
 * Pure in-memory loopback TCP -> control-plane UDS (or local loopback TCP) byte pipe.
 * Performs zero disk I/O, zero JSON parsing, and zero protocol translation.
 * All authentication, protocol checks, credential injection, scrubbing, and accounting
 * happen inside the control-plane HTTP model gateway.
 */
export async function startModelBridge({ socketPath, targetUrl, resolveTarget, signal } = {}) {
  const localMode = isLocalExecution();
  const initialTarget = resolveModelBridgeTarget({ socketPath, targetUrl }, localMode);
  const sockets = new Set();

  const server = createServer(client => {
    sockets.add(client);
    let target = initialTarget;
    if (localMode && typeof resolveTarget === 'function') {
      try {
        const dynamic = resolveTarget();
        if (dynamic && (dynamic.socketPath || dynamic.targetUrl)) {
          target = resolveModelBridgeTarget(dynamic, true);
        }
      } catch {}
    }
    const upstream = target.kind === 'uds'
      ? createConnection({ path: target.path })
      : createConnection({ host: target.host, port: target.port });
    sockets.add(upstream);

    const teardown = () => {
      if (!client.destroyed) client.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };
    client.on('error', teardown);
    upstream.on('error', teardown);
    client.on('close', () => {
      sockets.delete(client);
      if (!upstream.destroyed) upstream.end();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      if (!client.destroyed) client.end();
    });

    client.pipe(upstream);
    upstream.pipe(client);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    for (const sock of sockets) {
      try { sock.destroy(); } catch {}
    }
    sockets.clear();
    if (server.listening) {
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
  const onAbort = () => { void close(); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return { url, port, target: initialTarget, close };
}
