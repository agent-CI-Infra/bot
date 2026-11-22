import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcpHttp } from './mcp-bridge.mjs';
import { validateAcpLaunch } from './acp-products.mjs';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const STARTUP_MS = 15_000;
const agentDir = process.argv[2];
const root = process.cwd();
const token = process.env.BOT_RUN_TOKEN;
const abort = new AbortController();
const children = [];
let agent, sessionId, mcp, prompting = false, closing = false, cancelled = false;
let sequence = 0;
const pending = new Map();
const write = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const event = body => write({ type: 'event', event: body });

class AcpError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function close(error) {
  if (closing) return;
  closing = true;
  if (error) {
    process.exitCode = 1;
    write({ type: 'fault', code: error instanceof AcpError ? error.code : 'acp_runtime_failed', message: String(error.message ?? error).slice(0, 1000) });
  }
  abort.abort(error);
  for (const request of pending.values()) request.reject(error ?? new AcpError('acp_connection_closed'));
  pending.clear();
  process.stdin.destroy();
  for (const child of children) child.kill('SIGTERM');
  // The mailbox group owner kills every remaining descendant, including ones still holding pipes open.
  void mcp?.close();
  for (const child of children) child.unref();
  for (const child of children) {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

function start(executable, args, env, name, protocol = false) {
  const child = spawn(executable, args, { cwd: root, env, stdio: [protocol ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.pipe(process.stderr, { end: false });
  if (!protocol) child.stdout.pipe(process.stderr, { end: false });
  child.once('error', error => close(new AcpError('acp_process_failed', `${name}: ${error.message}`)));
  child.once('exit', (code, signal) => {
    if (!closing) close(new AcpError('acp_process_exited', `${name}: ${signal ?? code}`));
  });
  child.stdin?.on('error', () => close(new AcpError('acp_connection_closed')));
  return child;
}

function send(frame) {
  if (!agent?.stdin.writable) throw new AcpError('acp_connection_closed');
  agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
}

async function request(method, params, timeout) {
  const id = ++sequence;
  const reply = Promise.withResolvers();
  pending.set(id, reply);
  const timer = timeout ? setTimeout(() => reply.reject(new AcpError('acp_request_timeout', method)), timeout) : undefined;
  try {
    send({ id, method, params });
    return await reply.promise;
  } finally {
    clearTimeout(timer);
    pending.delete(id);
  }
}

function handleUpdate(update) {
  if (!update || typeof update !== 'object') return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (typeof update.content?.text === 'string') event({ type: 'message', channel: 'assistant', text: update.content.text });
      break;
    case 'tool_call':
    case 'tool_call_update':
      event({ type: 'tool', tool_call_id: update.toolCallId, title: update.title, status: update.status, kind: update.kind,
        phase: ['completed', 'failed'].includes(update.status) ? 'completed' : 'started' });
      break;
    case 'plan':
      event({ type: 'configuration', entries: update.entries });
      break;
    case 'usage_update':
      event({ type: 'usage', source: 'acp_session_context', used: update.used, size: update.size });
      break;
    case 'session_info_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'available_commands_update':
      event({ type: 'configuration', update });
      break;
  }
}

function handle(frame, answers) {
  if (frame?.jsonrpc !== '2.0' || Array.isArray(frame)) throw new AcpError('acp_invalid_frame');
  const { id, method, params } = frame;
  if (typeof method === 'string') {
    if (method === 'session/update' && id === undefined) {
      if (params?.sessionId === sessionId) handleUpdate(params.update);
      return;
    }
    if (id === undefined) return;
    if (method === 'session/request_permission') {
      const option = !cancelled && !closing && sessionId && params?.sessionId === sessionId && Array.isArray(params.options)
        ? params.options.find(item => item?.kind === 'allow_once' && typeof item.optionId === 'string') ??
          params.options.find(item => item?.kind === 'allow_always' && typeof item.optionId === 'string') : undefined;
      const outcome = option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
      send({ id, result: { outcome } });
      event({ type: 'permission', allowed: Boolean(option), tool_call_id: params?.toolCall?.toolCallId, ...outcome });
    } else if (Object.hasOwn(answers, method)) {
      send({ id, result: answers[method] });
    } else {
      send({ id, error: { code: -32601, message: 'Method not found' } });
    }
    return;
  }
  const waiting = pending.get(id);
  if (frame.error) waiting?.reject(new AcpError('acp_rpc_error', String(frame.error.message ?? 'ACP request failed')));
  else if (Object.hasOwn(frame, 'result')) waiting?.resolve(frame.result);
  else if (waiting) waiting.reject(new AcpError('acp_invalid_response'));
}

function consumeProtocol(stream, onFrame) {
  let buffer = Buffer.alloc(0);
  stream.on('data', chunk => {
    if (closing) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    try {
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        if (newline > MAX_FRAME_BYTES) throw new AcpError('acp_frame_too_large');
        onFrame(JSON.parse(buffer.toString('utf8', 0, newline)));
        buffer = buffer.subarray(newline + 1);
      }
      if (buffer.length > MAX_FRAME_BYTES) throw new AcpError('acp_frame_too_large');
    } catch (error) {
      close(error instanceof AcpError ? error : new AcpError('acp_invalid_frame', 'ACP stdout must contain newline-delimited JSON-RPC frames.'));
    }
  });
}

async function loopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitHealthy(url) {
  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(500)]);
    const response = await fetch(url, { signal, redirect: 'error' }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) return;
    await delay(50, undefined, { signal: abort.signal });
  }
  throw new AcpError('acp_sidecar_unhealthy');
}

function cancel() {
  if (closing || cancelled) return;
  cancelled = true;
  if (!sessionId || !agent) return close();
  try { send({ method: 'session/cancel', params: { sessionId } }); }
  catch { return close(); }
  setTimeout(() => close(), 750).unref();
}
process.on('SIGTERM', cancel);

try {
  const config = JSON.parse(await readFile(join(agentDir, 'harness.json'), 'utf8'));
  const launch = validateAcpLaunch(config.acp_product.launch);
  const executable = process.argv[3];
  const productDir = dirname(dirname(dirname(executable)));
  const runDir = join(agentDir, 'acp-' + config.instance_id);
  await mkdir(runDir, { mode: 0o700 });
  const variables = {
    product: join(productDir, 'source'), state: process.env.HOME, run: runDir,
    model: config.model, relay: process.env.BOT_ACP_RELAY_URL + '/v1', token,
    workspace: root, access: JSON.stringify(config.execution_access ?? {}),
  };
  // Close provisional listeners before starting the sidecars; each process binds its own per-run loopback port.
  const allocated = new Set();
  for (const sidecar of launch.sidecars) {
    let port;
    do { port = await loopbackPort(); } while (allocated.has(port));
    allocated.add(port);
    variables[`port:${sidecar.name}`] = String(port);
  }
  const expand = (template, values = variables) => template.replace(/\{(product|state|run|model|relay|token|workspace|access|port:[\w-]+)\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new AcpError('acp_invalid_launch_variable', key);
    return values[key];
  });
  const environment = (values = variables) => ({ ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
    ...Object.fromEntries(Object.entries(launch.env).map(([key, value]) => [key, expand(value, values)])),
    BOT_ACP_INSTANCE_ID: config.instance_id,
  });
  for (const sidecar of launch.sidecars) {
    if (closing) break;
    const state = join(runDir, sidecar.name);
    const tmp = join(state, 'tmp');
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    if (closing) break;
    const values = { ...variables, state };
    start(executable, sidecar.args.map(arg => expand(arg, values)), { ...environment(values), HOME: state, TMPDIR: tmp }, sidecar.name);
  }
  await Promise.all(launch.sidecars.map(sidecar => waitHealthy(`http://127.0.0.1:${variables[`port:${sidecar.name}`]}${sidecar.healthPath}`)));
  if (closing) throw new AcpError('acp_connection_closed');
  let mcpServer;
  if (launch.mcp === 'http') {
    mcp = await startMcpHttp({ agentDir, token, signal: abort.signal });
    mcpServer = { type: 'http', name: 'bot', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] };
  } else {
    mcpServer = { name: 'bot', command: process.execPath, args: [join(import.meta.dirname, 'mcp-bridge.mjs'), agentDir], env: [{ name: 'BOT_RUN_TOKEN', value: token }] };
  }
  if (closing) throw new AcpError('acp_connection_closed');
  agent = start(executable, launch.args.map(arg => expand(arg)), environment(), 'agent', true);
  consumeProtocol(agent.stdout, frame => handle(frame, launch.answers));
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'launchpad', version: '1' } }, STARTUP_MS);
  if (initialized?.protocolVersion !== 1) throw new AcpError('acp_protocol_version_unsupported');
  const capabilities = initialized.agentCapabilities ?? {};
  event({ type: 'configuration', protocol_version: 1, capabilities, agent: initialized.agentInfo });
  const sessionParams = { cwd: root, mcpServers: [mcpServer] };
  let recoveryMode = config.resume ? 'rebuilt_from_task_records' : 'new_session';
  if (config.resume && config.session_id && capabilities.loadSession === true) {
    sessionId = config.session_id; // During load the agent can replay session/update notifications.
    try {
      await request('session/load', { ...sessionParams, sessionId }, STARTUP_MS);
      recoveryMode = 'native_resume';
    } catch (error) {
      if (error.code !== 'acp_rpc_error') throw error;
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    const created = await request('session/new', sessionParams, STARTUP_MS);
    sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 8192) throw new AcpError('acp_invalid_session');
  }
  write({ type: 'ready', session_id: sessionId, recoveryMode });

  const input = createInterface({ input: process.stdin });
  input.once('close', () => close());
  input.on('line', async line => {
    if (closing || prompting) return;
    prompting = true;
    try {
      const prompt = JSON.parse(line);
      if (typeof prompt.text !== 'string') throw new AcpError('acp_invalid_prompt');
      const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt.text }] });
      if (typeof result?.stopReason !== 'string') throw new AcpError('acp_invalid_prompt_response');
      write({ type: 'turn', stop_reason: result.stopReason });
      if (cancelled) close();
    } catch (error) {
      close(error);
    } finally {
      prompting = false;
    }
  });
} catch (error) {
  close(error);
}
