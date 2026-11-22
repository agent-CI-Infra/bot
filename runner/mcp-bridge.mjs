import { createServer } from 'node:http';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createToolDispatch } from './tool-dispatch.mjs';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 3_600_000;

function buildMcpToolResult(reply) {
  if (reply && typeof reply === 'object' && !Array.isArray(reply) && reply.__bot_tool_content === true && Array.isArray(reply.content)) {
    const content = [];
    for (const block of reply.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
      }
    }
    if (!content.length) {
      content.push({ type: 'text', text: JSON.stringify(reply.observation ?? null) });
    }
    const isError = typeof reply.isError === 'boolean'
      ? reply.isError
      : Boolean(reply.observation && typeof reply.observation === 'object' && reply.observation.error);
    return { content, isError };
  }
  const isError = Boolean(reply && typeof reply === 'object' && reply.error);
  return {
    content: [{ type: 'text', text: JSON.stringify(reply ?? null) }],
    isError,
  };
}

function createMcpHandler(agentDir, token, timeoutMs, pollMs) {
  if (!agentDir || typeof agentDir !== 'string') throw new Error('mcp_bridge_agent_dir_required');
  const dir = resolve(agentDir);
  const toolsFile = dir + '/mcp-tools.json';
  const dispatch = createToolDispatch(dir, { token, kind: 'mcp_tool', timeoutMs, pollMs });
  const inFlight = new Map();

  const loadTools = async () => {
    const raw = await readFile(toolsFile, 'utf8').catch(err => {
      if (err?.code === 'ENOENT') return '[]';
      throw err;
    });
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.name === 'string' && item.name.length > 0)
      .map(item => ({
        name: item.name,
        description: typeof item.description === 'string' ? item.description : '',
        inputSchema: item.inputSchema && typeof item.inputSchema === 'object'
          ? item.inputSchema
          : { type: 'object', properties: {}, additionalProperties: false },
      }));
  };

  const handleMessage = async (message, send, signal) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid_request' } });
      return;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;

    if (method === 'notifications/cancelled') {
      const targetKey = params?.requestId !== undefined ? JSON.stringify(params.requestId) : null;
      if (targetKey && inFlight.has(targetKey)) inFlight.get(targetKey).abort();
      return;
    }
    if (isNotification) return;

    if (typeof method !== 'string') {
      send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid_request' } });
      return;
    }

    if (method === 'initialize') {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'bot', version: '1.0.0' },
        },
      });
      return;
    }

    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      const tools = await loadTools();
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }

    if (method === 'resources/list') {
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    }

    if (method === 'resources/templates/list') {
      send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } });
      return;
    }

    if (method === 'prompts/list') {
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    }

    if (method === 'tools/call') {
      const name = typeof params?.name === 'string' ? params.name : '';
      if (!name) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'tool_name_required' } });
        return;
      }
      const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {};
      const controller = new AbortController();
      const key = JSON.stringify(id);
      if (inFlight.has(key)) {
        send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'request_id_in_use' } });
        return;
      }
      inFlight.set(key, controller);
      try {
        // Always forward to control plane even when not in tools/list so unapproved attempts
        // are authoritatively rejected and recorded as capability_denied.
        const reply = await dispatch(name, args, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, token, timeoutMs });
        if (controller.signal.aborted || signal?.aborted) return;
        send({
          jsonrpc: '2.0',
          id,
          result: buildMcpToolResult(reply),
        });
      } catch (err) {
        if (!controller.signal.aborted && !signal?.aborted) {
          send({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: String(err?.message || 'mcp_tool_dispatch_failed').slice(0, 500) },
          });
        }
      } finally {
        inFlight.delete(key);
      }
      return;
    }

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_found' } });
  };

  return {
    handleMessage,
    close() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    },
  };
}

/** Stateless Streamable HTTP. The bearer authenticates the same run as the stdio bridge. */
export async function startMcpHttp({ agentDir, token, signal, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 25 }) {
  if (!token) throw new Error('mcp_http_token_required');
  const expected = Buffer.from(`Bearer ${token}`);
  const handler = createMcpHandler(agentDir, token, timeoutMs, pollMs);
  let authority;
  const server = createServer(async (req, res) => {
    const reply = (status, payload) => {
      if (res.destroyed || res.writableEnded) return;
      if (payload === undefined) res.writeHead(status).end();
      else res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    };
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== `http://${authority}`)) return reply(403);
    if (req.url !== '/mcp') return reply(404);
    const presented = Buffer.from(req.headers.authorization ?? '');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return reply(401);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(405);
    }
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415);
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    let id = null;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > MAX_FRAME_BYTES) {
          res.setHeader('Connection', 'close');
          return reply(413);
        }
        chunks.push(chunk);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse_error' } }); }
      id = message?.id ?? null;
      if (message?.jsonrpc !== '2.0' || Array.isArray(message)) {
        return reply(400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid_request' } });
      }
      await handler.handleMessage(message, payload => reply(200, payload), controller.signal);
      reply(202);
    } catch {
      reply(500, { jsonrpc: '2.0', id, error: { code: -32603, message: 'mcp_dispatch_failed' } });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  authority = `127.0.0.1:${server.address().port}`;
  let closing;
  const close = () => closing ??= new Promise(resolveClose => {
    signal?.removeEventListener('abort', close);
    handler.close();
    server.close(resolveClose);
    server.closeAllConnections();
  });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) await close();
  return { url: `http://${authority}/mcp`, close };
}

/** Starts the stdio MCP server over newline or Content-Length framing. */
export function startMcpBridge({
  agentDir,
  input = process.stdin,
  output = process.stdout,
  token = process.env.BOT_RUN_TOKEN || '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = 25,
}) {
  const handler = createMcpHandler(agentDir, token, timeoutMs, pollMs);
  let framing = null;
  let buffer = Buffer.alloc(0);
  let closed = false;

  const send = payload => {
    if (closed) return;
    const json = JSON.stringify(payload);
    if (framing === 'content-length') {
      const bytes = Buffer.from(json, 'utf8');
      output.write(`Content-Length: ${bytes.length}\r\n\r\n`);
      output.write(bytes);
    } else {
      output.write(json + '\n');
    }
  };

  const dispatchFrame = rawText => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse_error' } });
      return;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      void handler.handleMessage(item, send).catch(() => {
        send({ jsonrpc: '2.0', id: item?.id ?? null, error: { code: -32603, message: 'mcp_dispatch_failed' } });
      });
    }
  };

  const drainBuffer = () => {
    while (buffer.length > 0 && !closed) {
      if (!framing) {
        const leading = buffer.toString('utf8', 0, Math.min(buffer.length, 32)).trimStart();
        if (!leading) return;
        framing = /^content-length:/i.test(leading) ? 'content-length' : 'line';
      }
      if (framing === 'content-length') {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (buffer.length > 16384) {
            buffer = Buffer.alloc(0);
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'header_too_large' } });
          }
          return;
        }
        const headerText = buffer.toString('utf8', 0, headerEnd);
        const match = /content-length:\s*(\d+)/i.exec(headerText);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'missing_content_length' } });
          continue;
        }
        const byteLength = Number(match[1]);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_FRAME_BYTES) {
          buffer = Buffer.alloc(0);
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'frame_too_large' } });
          return;
        }
        if (buffer.length < headerEnd + 4 + byteLength) return;
        const body = buffer.toString('utf8', headerEnd + 4, headerEnd + 4 + byteLength);
        buffer = buffer.subarray(headerEnd + 4 + byteLength);
        dispatchFrame(body);
      } else {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) {
          if (buffer.length > MAX_FRAME_BYTES) {
            buffer = Buffer.alloc(0);
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'frame_too_large' } });
          }
          return;
        }
        const line = buffer.toString('utf8', 0, nl);
        buffer = buffer.subarray(nl + 1);
        dispatchFrame(line);
      }
    }
  };

  const onData = chunk => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
    drainBuffer();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    input.off('data', onData);
    handler.close();
  };

  input.on('data', onData);
  input.once('end', close);
  input.once('close', close);
  input.once('error', close);

  return { close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agentDir = process.argv[2] || process.env.BOT_AGENT_DIR;
  if (!agentDir) {
    process.stderr.write('mcp-bridge: missing agent directory\n');
    process.exit(2);
  }
  startMcpBridge({ agentDir });
}
