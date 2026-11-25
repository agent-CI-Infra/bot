import { createServer } from 'node:http';
import { accessSync, createReadStream, createWriteStream, constants, existsSync, readFileSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureRunnerDirs,
  executeRunnerRequest,
  healthResult,
  idPattern,
  journal,
  readJournalRecord,
  reapOperation,
  saveJournalRecord,
  tailOperation,
} from './executor.mjs';
import { commandFailure, commandTooLong, runnerRequestLimit } from './command-policy.mjs';
import { assistant, tasksDirectory } from './paths.mjs';
import { storeRoot, git as storeGit } from './store.mjs';
import { MAX_ARTIFACT_COMPRESSED_BYTES } from './artifact-zip.mjs';
import { MAX_ASSISTANT_ARCHIVE_COMPRESSED_BYTES } from './assistant-files.mjs';
import { MAX_CLI_CONFIG_BYTES } from './cli-config.mjs';
import { refuseFull, volume as readVolume } from './disk.mjs';
import { closeAllMailboxWatchers, watchMailbox } from './mailbox-watch.mjs';
import {
  DEFAULT_COMMAND_HEARTBEAT_MS,
  DEFAULT_LONG_POLL_WAIT_MS,
  DEFAULT_RUNNER_SOCKET_DIR,
  DEFAULT_RUNNER_SOCKET_PATH,
  DEFAULT_RUNNER_TOKEN_FILE,
  bearerTokenMatches,
  readJsonBody,
  upgradeHttpToWs,
} from './wire-protocol.mjs';

const SHA40_RE = /^[a-f0-9]{40}$/;
const STAGE_ID_RE = /^[a-f0-9]{16,48}$/;
const MAX_GIT_PACK_BYTES = 512 * 1024 * 1024;
const MAX_INMEM_COMMAND_CHUNKS_BYTES = 512 * 1024;
const COMMAND_RETENTION_MS = 5 * 60_000;
// Must cover a full MAX_CLI_CONFIG_BYTES (32 KiB) payload base64-encoded (~44 KiB) in x-bot-cli-config-b64 plus normal HTTP headers.
const DAEMON_MAX_HEADER_SIZE = Math.max(64 * 1024, Math.ceil(MAX_CLI_CONFIG_BYTES * 4 / 3) + 16 * 1024);
const ALLOWED_LONG_POLL_BUCKETS_MS = Object.freeze([100, 150, 200, 250, 500, 1000, 2000, 5000, 10000, 15000, 20000, DEFAULT_LONG_POLL_WAIT_MS]);
const EXPOSED_ERRORS = Object.freeze({
  invalid_json: { status: 400, code: 'invalid_json' },
  invalid_input: { status: 400, code: 'invalid_input' },
  invalid_operation_id: { status: 400, code: 'invalid_operation_id' },
  invalid_command: { status: 400, code: 'invalid_command' },
  blob_too_large: { status: 413, code: 'blob_too_large' },
  upload_aborted: { status: 499, code: 'upload_aborted' },
});

function selectLongPollWaitMs(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LONG_POLL_WAIT_MS;
  for (let i = ALLOWED_LONG_POLL_BUCKETS_MS.length - 1; i >= 0; i--) {
    if (parsed >= ALLOWED_LONG_POLL_BUCKETS_MS[i]) return ALLOWED_LONG_POLL_BUCKETS_MS[i];
  }
  return ALLOWED_LONG_POLL_BUCKETS_MS[0];
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function parseListenSpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const idx = raw.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = raw.slice(0, idx).replace(/^\[|\]$/g, '');
  const port = Number(raw.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { host, port };
}

function loadToken({ token, tokenFile }) {
  if (typeof token === 'string' && token.length > 0) return token;
  if (tokenFile) {
    try {
      const value = readFileSync(tokenFile, 'utf8').trim();
      try { unlinkSync(tokenFile); } catch {}
      if (value) return value;
    } catch {}
  }
  const envToken = process.env.BOT_RUNNER_TOKEN;
  if (envToken !== undefined) {
    delete process.env.BOT_RUNNER_TOKEN;
    if (envToken.trim()) return envToken.trim();
  }
  return null;
}

async function streamToFile(req, filePath, maxBytes) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  let size = 0;
  try {
    const out = createWriteStream(null, { fd: handle.fd, autoClose: false });
    await new Promise((resolveStream, rejectStream) => {
      let failed = false;
      const fail = err => {
        if (failed) return;
        failed = true;
        out.destroy();
        rejectStream(err);
      };
      req.on('data', chunk => {
        if (failed) return;
        size += chunk.length;
        if (size > maxBytes) {
          fail(Object.assign(new Error('blob_too_large'), { status: 413, code: 'blob_too_large', limit: maxBytes, length: size }));
          return;
        }
        if (!out.write(chunk)) {
          req.pause();
          out.once('drain', () => req.resume());
        }
      });
      req.on('end', () => { if (!failed) out.end(); });
      req.on('aborted', () => fail(Object.assign(new Error('upload_aborted'), { status: 499, code: 'upload_aborted' })));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => { if (!failed) resolveStream(); });
    });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(filePath).catch(() => {});
    throw error;
  }
  await handle.close();
  return size;
}

function isWritableDir(dir) {
  try {
    if (!existsSync(dir)) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the resident runner daemon (HTTP/1.1 + WebSocket over private UDS and/or controlled TCP endpoint).
 * Dispatches runner operations directly in-process via ESM (`runner/executor.mjs`), supports asynchronous
 * streaming command execution with heartbeats, raw binary blob streaming, and inotify-backed mailbox push.
 */
export async function startRunnerDaemon(options = {}) {
  await ensureRunnerDirs();
  const socketPath = options.socketPath !== undefined
    ? options.socketPath
    : (process.env.BOT_RUNNER_SOCKET !== undefined ? (process.env.BOT_RUNNER_SOCKET || null)
      : (isWritableDir(DEFAULT_RUNNER_SOCKET_DIR) ? DEFAULT_RUNNER_SOCKET_PATH : null));
  const listen = options.listen !== undefined
    ? (typeof options.listen === 'string' ? parseListenSpec(options.listen) : options.listen)
    : parseListenSpec(process.env.BOT_RUNNER_LISTEN || '');
  const tokenFile = options.tokenFile !== undefined
    ? options.tokenFile
    : (process.env.BOT_RUNNER_TOKEN_FILE || (socketPath ? `${dirname(socketPath)}/.token` : DEFAULT_RUNNER_TOKEN_FILE));
  const authToken = loadToken({ token: options.token, tokenFile });
  const requireAuth = options.allowUnauthenticated === true ? Boolean(authToken) : true;
  if (listen && !authToken && options.allowUnauthenticated !== true) {
    throw new Error('runner_daemon_token_required_for_tcp');
  }
  const heartbeatMs = Math.max(200, Number(options.heartbeatMs ?? process.env.BOT_RUNNER_HEARTBEAT_MS) || DEFAULT_COMMAND_HEARTBEAT_MS);

  const activeOperations = new Map(); // operationId -> Set<pid>
  const commands = new Map(); // operationId -> CommandEntry
  const wsClients = new Set();

  const trackPid = (operationId, pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return;
    let set = activeOperations.get(operationId);
    if (!set) { set = new Set(); activeOperations.set(operationId, set); }
    set.add(pid);
  };
  const untrackOp = operationId => { activeOperations.delete(operationId); };

  const wakeCommandWaiters = (entry, payload = null) => {
    for (const waiter of [...entry.waiters]) {
      entry.waiters.delete(waiter);
      waiter(payload);
    }
  };

  const broadcastCommand = (entry, message) => {
    for (const ws of [...entry.subscribers]) {
      if (!ws.open) { entry.subscribers.delete(ws); continue; }
      ws.sendJson(message);
    }
  };

  const readMissingOutput = async (entry, fromOffset) => {
    const offset = Math.max(0, Number(fromOffset) || 0);
    if (offset >= entry.outputBytes) return { data: '', nextOffset: offset };
    if (entry.chunks.length && offset >= entry.chunks[0].offset) {
      let data = '';
      let cursor = offset;
      for (const part of entry.chunks) {
        const end = part.offset + part.bytes;
        if (end <= cursor) continue;
        if (part.offset >= cursor) {
          data += part.data;
          cursor = end;
        } else {
          const buf = Buffer.from(part.data, 'utf8');
          data += buf.subarray(cursor - part.offset).toString('utf8');
          cursor = end;
        }
      }
      return { data, nextOffset: cursor };
    }
    const tailed = await tailOperation({ operation_id: entry.operation_id, offset, limit: 512 * 1024 }).catch(() => null);
    if (!tailed) return { data: '', nextOffset: offset };
    return { data: tailed.data || '', nextOffset: tailed.offset ?? offset };
  };

  const startAsyncCommand = async request => {
    if (!idPattern.test(request.operation_id || '')) {
      throw Object.assign(new Error('invalid_operation_id'), { status: 400, code: 'invalid_operation_id' });
    }
    if (!['command', 'workspace_command'].includes(request.type)) {
      throw Object.assign(new Error('invalid_command'), { status: 400, code: 'invalid_command' });
    }
    const opId = request.operation_id;
    const live = commands.get(opId);
    if (live) {
      return live.state === 'completed'
        ? { status: 200, body: { ok: true, operation_id: opId, state: 'completed', output_bytes: live.outputBytes, started_at: live.started_at, finished_at: live.finished_at, response: live.response } }
        : { status: 202, body: { ok: true, operation_id: opId, state: 'running', output_bytes: live.outputBytes, started_at: live.started_at } };
    }
    const existing = await readJournalRecord(opId);
    if (existing) {
      const response = existing.state === 'completed' ? existing.result : { ok: false, error: 'operation_interrupted' };
      return { status: 200, body: { ok: true, operation_id: opId, state: 'completed', response } };
    }
    const refusal = refuseFull(request);
    if (refusal) return { status: 200, body: { ok: true, operation_id: opId, state: 'completed', response: refusal } };
    const tooLong = commandTooLong(request.command);
    if (tooLong) return { status: 200, body: { ok: true, operation_id: opId, state: 'completed', response: commandFailure(tooLong) } };

    // Persist running journal record BEFORE replying 202 so immediate `tail` / `GET /v1/commands/:id` observes `running`.
    await saveJournalRecord(opId, { state: 'running' });
    const entry = {
      operation_id: opId,
      state: 'running',
      started_at: Date.now(),
      finished_at: null,
      outputBytes: 0,
      chunks: [],
      chunkBytes: 0,
      response: null,
      subscribers: new Set(),
      waiters: new Set(),
      heartbeatTimer: null,
      cleanupTimer: null,
    };
    commands.set(opId, entry);

    entry.heartbeatTimer = setInterval(() => {
      if (entry.state !== 'running') return;
      broadcastCommand(entry, {
        type: 'command.heartbeat',
        operation_id: opId,
        state: 'running',
        elapsed_ms: Date.now() - entry.started_at,
        output_bytes: entry.outputBytes,
      });
    }, heartbeatMs);
    entry.heartbeatTimer.unref?.();

    const run = executeRunnerRequest(request, {
      daemon: true,
      preJournaled: true,
      activeOperations,
      onSpawn: pid => trackPid(opId, pid),
      onOutput: (text, offsetBefore, totalBytes) => {
        const bytes = Buffer.byteLength(text, 'utf8');
        entry.outputBytes = totalBytes;
        if (bytes > 0) {
          entry.chunks.push({ offset: offsetBefore, bytes, data: text });
          entry.chunkBytes += bytes;
          while (entry.chunkBytes > MAX_INMEM_COMMAND_CHUNKS_BYTES && entry.chunks.length > 1) {
            const dropped = entry.chunks.shift();
            entry.chunkBytes -= dropped.bytes;
          }
          broadcastCommand(entry, {
            type: 'command.output',
            operation_id: opId,
            offset: offsetBefore,
            data: text,
            output_bytes: totalBytes,
          });
          wakeCommandWaiters(entry, 'output');
        }
      },
    }).then(response => {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
      entry.state = 'completed';
      entry.finished_at = Date.now();
      entry.response = response;
      untrackOp(opId);
      broadcastCommand(entry, {
        type: 'command.done',
        operation_id: opId,
        state: 'completed',
        output_bytes: entry.outputBytes,
        response,
      });
      wakeCommandWaiters(entry, 'done');
      entry.cleanupTimer = setTimeout(() => {
        if (commands.get(opId) === entry) commands.delete(opId);
      }, COMMAND_RETENTION_MS);
      entry.cleanupTimer.unref?.();
    }, () => {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
      entry.state = 'completed';
      entry.finished_at = Date.now();
      entry.response = { ok: false, error: 'runner_operation_failed' };
      untrackOp(opId);
      broadcastCommand(entry, {
        type: 'command.done',
        operation_id: opId,
        state: 'completed',
        output_bytes: entry.outputBytes,
        response: entry.response,
      });
      wakeCommandWaiters(entry, 'done');
    });
    void run;

    return { status: 202, body: { ok: true, operation_id: opId, state: 'running', output_bytes: 0, started_at: entry.started_at } };
  };

  const authenticate = req => {
    if (!requireAuth) return true;
    return bearerTokenMatches(req.headers.authorization, authToken);
  };

  const handleHttp = async (req, res) => {
    try {
      if (!authenticate(req)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url || '/', 'http://runner');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/v1/health') {
        sendJson(res, 200, { ok: true, result: healthResult(true) });
        return;
      }

      if (req.method === 'POST' && path === '/v1/execute') {
        const input = await readJsonBody(req, runnerRequestLimit);
        const cliHeader = req.headers['x-bot-cli-config-b64'];
        const cliConfigB64 = typeof cliHeader === 'string' && cliHeader.length > 0 ? cliHeader : undefined;
        const opId = idPattern.test(input.operation_id || '') ? input.operation_id : null;
        try {
          const response = await executeRunnerRequest(input, {
            daemon: true,
            cliConfigB64,
            activeOperations,
            onSpawn: opId ? pid => trackPid(opId, pid) : undefined,
          });
          sendJson(res, 200, response);
        } finally {
          if (opId) untrackOp(opId);
        }
        return;
      }

      if (req.method === 'POST' && path === '/v1/commands') {
        const input = await readJsonBody(req, runnerRequestLimit);
        const started = await startAsyncCommand(input);
        sendJson(res, started.status, started.body);
        return;
      }

      const cmdMatch = /^\/v1\/commands\/([a-f0-9]{48})(?:\/(wait|cancel))?$/.exec(path);
      if (cmdMatch) {
        const opId = cmdMatch[1];
        const sub = cmdMatch[2] || null;
        if (req.method === 'GET' && !sub) {
          const live = commands.get(opId);
          if (live) {
            sendJson(res, 200, {
              ok: true,
              operation_id: opId,
              state: live.state,
              output_bytes: live.outputBytes,
              started_at: live.started_at,
              finished_at: live.finished_at,
              ...(live.state === 'completed' ? { response: live.response } : {}),
            });
            return;
          }
          const rec = await readJournalRecord(opId);
          if (!rec) { sendJson(res, 404, { ok: false, error: 'operation_not_found' }); return; }
          const response = rec.state === 'completed' ? rec.result : { ok: false, error: 'operation_interrupted' };
          sendJson(res, 200, { ok: true, operation_id: opId, state: rec.state, ...(rec.state === 'completed' ? { response } : {}) });
          return;
        }
        if (req.method === 'GET' && sub === 'wait') {
          const reqOffset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
          const waitMs = selectLongPollWaitMs(url.searchParams.get('timeout_ms'));
          const live = commands.get(opId);
          if (!live) {
            const rec = await readJournalRecord(opId);
            if (!rec) { sendJson(res, 404, { ok: false, error: 'operation_not_found' }); return; }
            const response = rec.state === 'completed' ? rec.result : { ok: false, error: 'operation_interrupted' };
            sendJson(res, 200, { ok: true, operation_id: opId, state: 'completed', data: '', offset: reqOffset, response });
            return;
          }
          if (live.state === 'running' && reqOffset >= live.outputBytes) {
            await new Promise(resolveWait => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                live.waiters.delete(done);
                req.off('close', done);
                resolveWait();
              };
              const timer = setTimeout(done, waitMs);
              timer.unref?.();
              live.waiters.add(done);
              req.once('close', done);
            });
          }
          if (req.destroyed) return;
          const { data, nextOffset } = await readMissingOutput(live, reqOffset);
          sendJson(res, 200, {
            ok: true,
            operation_id: opId,
            state: live.state,
            data,
            offset: nextOffset,
            output_bytes: live.outputBytes,
            ...(live.state === 'running' && !data ? { heartbeat: true } : {}),
            ...(live.state === 'completed' ? { response: live.response } : {}),
          });
          return;
        }
        if (req.method === 'POST' && sub === 'cancel') {
          const result = await reapOperation(opId, { activeOperations });
          sendJson(res, 200, { ok: true, operation_id: opId, cancelled: true, ...result });
          return;
        }
      }

      const blobMatch = /^\/v1\/blobs\/([a-z_]+)\/([a-f0-9]{16,48})$/.exec(path);
      if (blobMatch) {
        const [, kind, id] = blobMatch;
        if (req.method === 'PUT') {
          if (readVolume()?.full) {
            sendJson(res, 507, { ok: false, error: 'disk_full', detail: `${kind}: refused, work volume is full` });
            return;
          }
          if (kind === 'git_pack') {
            if (!idPattern.test(id)) { sendJson(res, 400, { ok: false, error: 'invalid_pack' }); return; }
            const target = `${storeRoot}/incoming/${id}.pack`;
            const size = await streamToFile(req, target, MAX_GIT_PACK_BYTES);
            sendJson(res, 200, { ok: true, result: { written: true, size } });
            return;
          }
          if (kind === 'workspace_artifact') {
            const wsId = String(req.headers['x-bot-workspace-id'] || '');
            if (!idPattern.test(wsId) || !STAGE_ID_RE.test(id)) { sendJson(res, 400, { ok: false, error: 'invalid_artifact_stage' }); return; }
            const target = `${tasksDirectory}/${wsId}/.artifact-stage-${id}`;
            const size = await streamToFile(req, target, MAX_ARTIFACT_COMPRESSED_BYTES);
            sendJson(res, 200, { ok: true, result: { staged: true, size } });
            return;
          }
          if (kind === 'assistant_archive') {
            if (!assistant || !idPattern.test(id)) { sendJson(res, 400, { ok: false, error: 'invalid_stage_id' }); return; }
            const target = `/tmp/.bot-archive-${id}.tar.gz`;
            const size = await streamToFile(req, target, MAX_ASSISTANT_ARCHIVE_COMPRESSED_BYTES);
            sendJson(res, 200, { ok: true, result: { staged: true, size } });
            return;
          }
          sendJson(res, 404, { ok: false, error: 'unsupported_blob_kind' });
          return;
        }
        if (req.method === 'GET') {
          let targetPath = null;
          if (kind === 'workspace_blob') {
            const wsId = String(req.headers['x-bot-workspace-id'] || '');
            if (!idPattern.test(wsId) || !SHA40_RE.test(id)) { sendJson(res, 400, { ok: false, error: 'invalid_blob' }); return; }
            const root = `${tasksDirectory}/${wsId}`;
            targetPath = `${root}/blob-${id}`;
            const exists = await stat(targetPath).then(s => s.isFile(), () => false);
            if (!exists) {
              const temp = `${targetPath}.tmp`;
              const out = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
              try {
                await storeGit(['cat-file', 'blob', id], { cwd: `${root}/repo`, output: out.fd });
              } finally {
                await out.close();
              }
              await import('node:fs/promises').then(fs => fs.rename(temp, targetPath));
            }
          } else if (kind === 'command_output') {
            if (!idPattern.test(id)) { sendJson(res, 400, { ok: false, error: 'invalid_operation_id' }); return; }
            targetPath = `${journal}/${id}.out`;
            const fileExists = await stat(targetPath).then(s => s.isFile(), () => false);
            if (!fileExists) {
              // Non-truncated completed commands unlink `.out` once finalized; serve from retained result if present.
              const live = commands.get(id);
              const rec = live?.state === 'completed' ? { state: 'completed', result: live.response } : await readJournalRecord(id);
              const inlineOut = rec?.state === 'completed' && rec.result?.ok && typeof rec.result?.result?.output === 'string'
                ? Buffer.from(rec.result.result.output, 'utf8')
                : null;
              if (inlineOut) {
                const off = Math.max(0, Math.min(inlineOut.length, Number(url.searchParams.get('offset') || 0) || 0));
                const slice = inlineOut.subarray(off);
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Length', String(slice.length));
                res.setHeader('X-Bot-Blob-Size', String(inlineOut.length));
                res.end(slice);
                return;
              }
            }
          } else if (kind === 'assistant_archive') {
            if (!assistant || !idPattern.test(id)) { sendJson(res, 400, { ok: false, error: 'invalid_pack_id' }); return; }
            targetPath = `/tmp/.bot-pack-${id}.tar.gz`;
          } else {
            sendJson(res, 404, { ok: false, error: 'unsupported_blob_kind' });
            return;
          }
          const info = await stat(targetPath).catch(() => null);
          if (!info?.isFile()) { sendJson(res, 404, { ok: false, error: 'blob_not_found' }); return; }
          const offset = Math.max(0, Math.min(info.size, Number(url.searchParams.get('offset') || 0) || 0));
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', String(info.size - offset));
          res.setHeader('X-Bot-Blob-Size', String(info.size));
          if (offset >= info.size) { res.end(); return; }
          const stream = createReadStream(targetPath, { start: offset });
          stream.on('error', () => { if (!res.destroyed) res.destroy(); });
          stream.pipe(res);
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      if (error?.code === 'runner_request_too_large') {
        const limit = Number.isSafeInteger(error.limit) ? error.limit : runnerRequestLimit;
        const length = Number.isSafeInteger(error.length) ? error.length : 0;
        sendJson(res, 413, {
          ok: false,
          error: 'runner_request_too_large',
          limit,
          length,
          detail: `The runner request is ${length} bytes once JSON-encoded; the transport limit is ${limit} bytes.`,
        });
        return;
      }
      const known = typeof error?.code === 'string' && Object.hasOwn(EXPOSED_ERRORS, error.code)
        ? EXPOSED_ERRORS[error.code]
        : null;
      if (known) {
        const limit = Number.isSafeInteger(error.limit) ? error.limit : undefined;
        const length = Number.isSafeInteger(error.length) ? error.length : undefined;
        sendJson(res, known.status, { ok: false, error: known.code, ...(limit !== undefined ? { limit, length } : {}) });
        return;
      }
      sendJson(res, 500, { ok: false, error: 'runner_daemon_error' });
    }
  };

  const handleUpgrade = (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://runner');
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authenticate(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ws = upgradeHttpToWs(req, socket, head, { maxMessageBytes: runnerRequestLimit + 1024 * 1024 });
    if (!ws) return;
    wsClients.add(ws);
    const subscribedOps = new Set();
    const mailboxUnsubs = new Map();

    const cleanupWs = () => {
      wsClients.delete(ws);
      for (const opId of subscribedOps) {
        commands.get(opId)?.subscribers.delete(ws);
      }
      subscribedOps.clear();
      for (const unsub of mailboxUnsubs.values()) unsub();
      mailboxUnsubs.clear();
    };
    ws.on('close', cleanupWs);
    ws.on('error', cleanupWs);

    ws.on('text', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { ws.sendJson({ type: 'error', error: 'invalid_json' }); return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ping') {
        ws.sendJson({ type: 'pong', ts: msg.ts ?? Date.now() });
        return;
      }

      if (msg.type === 'command.subscribe') {
        const opId = String(msg.operation_id || '');
        if (!idPattern.test(opId)) { ws.sendJson({ type: 'error', error: 'invalid_operation_id', operation_id: opId }); return; }
        const fromOffset = Math.max(0, Number(msg.offset || 0) || 0);
        const entry = commands.get(opId);
        if (entry) {
          if (entry.state === 'running' && fromOffset >= entry.outputBytes) {
            entry.subscribers.add(ws);
            subscribedOps.add(opId);
            return;
          }
          const finishSubscribe = ({ data, nextOffset }) => {
            if (!ws.open) return;
            if (data) {
              ws.sendJson({ type: 'command.output', operation_id: opId, offset: fromOffset, data, output_bytes: nextOffset });
            }
            if (entry.state === 'completed') {
              ws.sendJson({ type: 'command.done', operation_id: opId, state: 'completed', output_bytes: entry.outputBytes, response: entry.response });
            } else {
              entry.subscribers.add(ws);
              subscribedOps.add(opId);
            }
          };
          // Synchronous fast-path when all missing bytes are still in memory avoids ordering races with live broadcasts.
          if (entry.chunks.length && fromOffset >= entry.chunks[0].offset) {
            let data = '';
            let cursor = fromOffset;
            for (const part of entry.chunks) {
              const end = part.offset + part.bytes;
              if (end <= cursor) continue;
              if (part.offset >= cursor) { data += part.data; cursor = end; }
              else { data += Buffer.from(part.data, 'utf8').subarray(cursor - part.offset).toString('utf8'); cursor = end; }
            }
            finishSubscribe({ data, nextOffset: cursor });
            return;
          }
          void readMissingOutput(entry, fromOffset).then(finishSubscribe);
          return;
        }
        void readJournalRecord(opId).then(rec => {
          if (!ws.open) return;
          if (!rec) { ws.sendJson({ type: 'command.missing', operation_id: opId }); return; }
          const response = rec.state === 'completed' ? rec.result : { ok: false, error: 'operation_interrupted' };
          ws.sendJson({ type: 'command.done', operation_id: opId, state: 'completed', response });
        });
        return;
      }

      if (msg.type === 'command.unsubscribe') {
        const opId = String(msg.operation_id || '');
        commands.get(opId)?.subscribers.delete(ws);
        subscribedOps.delete(opId);
        return;
      }

      if (msg.type === 'mailbox.watch') {
        const wsId = String(msg.workspace_id || '');
        if (!idPattern.test(wsId)) { ws.sendJson({ type: 'error', error: 'invalid_workspace' }); return; }
        if (mailboxUnsubs.has(wsId)) {
          ws.sendJson({ type: 'mailbox.watching', workspace_id: wsId });
          return;
        }
        const dir = `${tasksDirectory}/${wsId}/agent`;
        const unsub = watchMailbox(dir, event => {
          if (!ws.open) return;
          ws.sendJson({
            type: 'mailbox.event',
            workspace_id: wsId,
            subdir: event.subdir,
            filename: event.filename,
            event: event.event,
            at: event.at,
          });
        });
        mailboxUnsubs.set(wsId, unsub);
        ws.sendJson({ type: 'mailbox.watching', workspace_id: wsId });
        return;
      }

      if (msg.type === 'mailbox.unwatch') {
        const wsId = String(msg.workspace_id || '');
        const unsub = mailboxUnsubs.get(wsId);
        if (unsub) { unsub(); mailboxUnsubs.delete(wsId); }
        return;
      }

      if (msg.type === 'rpc.request') {
        const rpcId = msg.id;
        const request = msg.request;
        const cliConfigB64 = typeof msg.cli_config_b64 === 'string' && msg.cli_config_b64.length > 0 ? msg.cli_config_b64 : undefined;
        const opId = idPattern.test(request?.operation_id || '') ? request.operation_id : null;
        void executeRunnerRequest(request, {
          daemon: true,
          cliConfigB64,
          activeOperations,
          onSpawn: opId ? pid => trackPid(opId, pid) : undefined,
        }).then(
          response => { if (ws.open) ws.sendJson({ type: 'rpc.response', id: rpcId, response }); },
          () => { if (ws.open) ws.sendJson({ type: 'rpc.response', id: rpcId, response: { ok: false, error: 'runner_operation_failed' } }); },
        ).finally(() => { if (opId) untrackOp(opId); });
      }
    });
  };

  const servers = [];
  const createListener = () => {
    const srv = createServer({ maxHeaderSize: DAEMON_MAX_HEADER_SIZE }, (req, res) => { void handleHttp(req, res); });
    srv.on('upgrade', handleUpgrade);
    srv.requestTimeout = 300_000;
    srv.headersTimeout = 10_000;
    srv.keepAliveTimeout = 60_000;
    return srv;
  };

  let boundSocketPath = null;
  let boundTcp = null;

  if (socketPath) {
    await mkdir(dirname(socketPath), { recursive: true });
    try { unlinkSync(socketPath); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    const udsServer = createListener();
    await new Promise((resolveListen, rejectListen) => {
      udsServer.once('error', rejectListen);
      udsServer.listen(socketPath, () => {
        udsServer.off('error', rejectListen);
        resolveListen();
      });
    });
    const parentMode = statSync(dirname(socketPath)).mode & 0o777;
    const sockMode = (parentMode & 0o007) === 0o007 || process.env.BOT_RUNNER_HOST_SOCKET === '1' ? 0o666 : 0o660;
    try { chmodSync(socketPath, sockMode); } catch {}
    boundSocketPath = socketPath;
    servers.push(udsServer);
  }

  if (listen) {
    const tcpServer = createListener();
    await new Promise((resolveListen, rejectListen) => {
      tcpServer.once('error', rejectListen);
      tcpServer.listen(listen.port, listen.host, () => {
        tcpServer.off('error', rejectListen);
        resolveListen();
      });
    });
    const addr = tcpServer.address();
    boundTcp = typeof addr === 'object' && addr ? { host: addr.address, port: addr.port, url: `http://${addr.address}:${addr.port}` } : null;
    servers.push(tcpServer);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const entry of commands.values()) {
      clearInterval(entry.heartbeatTimer);
      clearTimeout(entry.cleanupTimer);
      wakeCommandWaiters(entry, 'shutdown');
    }
    for (const ws of [...wsClients]) ws.close(1001, 'daemon_stopping');
    wsClients.clear();
    closeAllMailboxWatchers();
    await Promise.all(servers.map(srv => new Promise(resolveClose => {
      srv.closeIdleConnections?.();
      srv.close(() => resolveClose());
      setTimeout(() => { srv.closeAllConnections?.(); resolveClose(); }, 1500).unref?.();
    })));
    if (boundSocketPath) {
      try { unlinkSync(boundSocketPath); } catch {}
    }
  };

  return {
    socketPath: boundSocketPath,
    tcp: boundTcp,
    token: authToken,
    close,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const daemon = await startRunnerDaemon();
  // Keep alive even if no socket/TCP listener was configured (e.g., standalone image smoke check without /run/bot-runner mount).
  const keeper = (!daemon.socketPath && !daemon.tcp) ? setInterval(() => {}, 3_600_000) : null;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (keeper) clearInterval(keeper);
    void daemon.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
