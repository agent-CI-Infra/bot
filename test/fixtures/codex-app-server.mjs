// Protocol fixture of `codex app-server` 0.166.0 (stdio JSON-RPC lines without a "jsonrpc" member). It is a contract test
// double for the client, never a substitute for a real Codex run. Scenarios are selected with FIXTURE_* variables.
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

if (process.argv.includes('--version')) {
  console.log(`codex-cli 0.166.0 uid=${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`);
  process.exit(0);
}

const env = process.env, home = env.CODEX_HOME, threads = join(home, 'threads');
mkdirSync(threads, { recursive: true });
const flag = name => env['FIXTURE_' + name] === 'true';
const log = (file, value) => appendFileSync(join(home, file), JSON.stringify(value) + '\n');
writeFileSync(join(home, 'pid'), String(process.pid));
{
  const cfgPath = join(home, 'config.toml');
  const authPath = join(home, 'auth.json');
  writeFileSync(join(home, 'launch.json'), JSON.stringify({
    args: process.argv.slice(2),
    env_names: Object.keys(process.env),
    staged_files: {
      config_toml: existsSync(cfgPath) ? { exists: true, mode: statSync(cfgPath).mode & 0o777, content: readFileSync(cfgPath, 'utf8') } : { exists: false },
      auth_json: existsSync(authPath) ? { exists: true, mode: statSync(authPath).mode & 0o777 } : { exists: false },
    },
  }));
}

// Output is one ordered byte stream; FRAGMENT writes it in 7-byte pieces, splitting lines and multi-byte characters.
let queue = Promise.resolve();
const write = text => {
  queue = queue.then(async () => {
    const data = Buffer.from(text);
    if (!flag('FRAGMENT')) { process.stdout.write(data); return; }
    for (let i = 0; i < data.length; i += 7) {
      process.stdout.write(data.subarray(i, i + 7));
      await new Promise(r => setImmediate(r));
    }
  });
  return queue;
};
const send = m => write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const load = id => (existsSync(join(threads, id + '.json')) ? JSON.parse(readFileSync(join(threads, id + '.json'), 'utf8')) : null);
const store = t => writeFileSync(join(threads, t.id + '.json'), JSON.stringify(t));

let thread = null, mcpConfig = null, policy = null;
let extraSkillRoots = [];
const disabledSkillPaths = new Set();
let mcpChild = null, mcpSeq = 1;

function scanSkillsDir(dir, scope) {
  if (!dir || !existsSync(dir)) return [];
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const content = readFileSync(skillMd, 'utf8');
    const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || entry.name;
    const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
    const disabled = disabledSkillPaths.has(skillMd) && !flag('IGNORE_SKILL_DISABLE');
    entries.push({ name, description, path: skillMd, scope, enabled: !disabled });
  }
  return entries;
}
const mcpPending = new Map();

function stopMcpChild() {
  if (!mcpChild) return;
  try { mcpChild.stdin.end(); } catch {}
  try { mcpChild.kill('SIGTERM'); } catch {}
  mcpChild = null;
  for (const [, pending] of mcpPending) pending.reject(new Error('mcp_closed'));
  mcpPending.clear();
}
process.on('exit', stopMcpChild);
process.stdin.on('end', stopMcpChild);

// Match Codex 0.166.0 `codex_utils_pty::Command::new` (`env_clear()`) + `create_env_for_mcp_server`:
// stdio MCP servers inherit ONLY `DEFAULT_ENV_VARS`, explicit `mcp_servers.<name>.env`, and names listed in `env_vars`.
const CODEX_MCP_DEFAULT_ENV_VARS = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ'];

function buildMcpEnv(cfg) {
  const out = {};
  for (const key of CODEX_MCP_DEFAULT_ENV_VARS) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  if (cfg?.env && typeof cfg.env === 'object') {
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  if (Array.isArray(cfg?.env_vars)) {
    for (const key of cfg.env_vars) {
      if (typeof key === 'string' && process.env[key] !== undefined) out[key] = process.env[key];
    }
  }
  return out;
}

function ensureStdioMcp() {
  if (mcpChild || !mcpConfig?.command) return;
  mcpChild = spawn(mcpConfig.command, mcpConfig.args ?? [], {
    env: buildMcpEnv(mcpConfig),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcpChild.unref();
  mcpChild.stdin.unref();
  mcpChild.stdout.unref();
  createInterface({ input: mcpChild.stdout }).on('line', line => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && mcpPending.has(msg.id)) {
      const entry = mcpPending.get(msg.id);
      mcpPending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'mcp_rpc_error'));
      else entry.resolve(msg.result);
    }
  });
}

const rpc = async (method, params) => {
  if (mcpConfig?.command) {
    ensureStdioMcp();
    const id = mcpSeq++;
    return new Promise((resolveRpc, rejectRpc) => {
      mcpPending.set(id, { resolve: resolveRpc, reject: rejectRpc });
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', err => {
        if (err) {
          mcpPending.delete(id);
          rejectRpc(err);
        }
      });
    });
  }
  const r = await fetch(mcpConfig.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
};
const tool = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).content[0].text);
// A tool call after the client stopped the run must be refused; the outcome is logged for the test.
const lateTool = () =>
  setTimeout(
    () =>
      tool('finish', { summary: 'after stop' }).then(
        r => log('late-tools.jsonl', { accepted: !r?.error, r }),
        e => log('late-tools.jsonl', { accepted: false, error: String(e) }),
      ),
    50,
  );

const threadView = t => ({
  id: t.id,
  cwd: t.cwd,
  model: t.model,
  modelProvider: t.modelProvider,
  cliVersion: '0.166.0',
  ephemeral: false,
  preview: '',
  sessionId: t.id,
  status: { type: 'idle' },
  turns: [],
  createdAt: 1,
  updatedAt: 1,
  source: 'appServer',
});

const cliProjectDocZero = process.argv.some((arg, idx) => arg === '-c' && process.argv[idx + 1] === 'project_doc_max_bytes=0');
function configuredModelProvider() {
  for (let idx = 0; idx < process.argv.length; idx++) {
    if (process.argv[idx] === '-c' && typeof process.argv[idx + 1] === 'string') {
      const m = /^model_provider\s*=\s*"?([A-Za-z0-9._-]+)"?$/.exec(process.argv[idx + 1].trim());
      if (m) return m[1];
    }
  }
  const cfgPath = join(home, 'config.toml');
  if (existsSync(cfgPath)) {
    const content = readFileSync(cfgPath, 'utf8');
    const m = /^model_provider\s*=\s*"([^"]+)"/m.exec(content);
    if (m) return m[1];
  }
  return 'openai';
}
const processModelProvider = configuredModelProvider();

// The applied policy echoes what the client asked for; SANDBOX_IGNORED and FEATURE_IGNORED model a server that did not apply it.
const opened = t => ({
  thread: threadView(t),
  model: t.model,
  modelProvider: t.modelProvider,
  cwd: t.cwd,
  approvalPolicy: flag('APPROVAL_IGNORED') ? 'on-request' : policy.approvalPolicy,
  approvalsReviewer: 'user',
  sandbox: flag('SANDBOX_IGNORED')
    ? { type: 'readOnly' }
    : policy.sandbox === 'danger-full-access'
      ? { type: 'dangerFullAccess' }
      : policy.sandbox === 'read-only'
        ? { type: 'readOnly' }
        : { type: 'workspaceWrite', writableRoots: [t.cwd] },
  instructionSources:
    existsSync(join(t.cwd, 'AGENTS.md')) && (flag('IGNORE_PROJECT_DOC_LIMIT') || (policy.project_doc_max_bytes !== 0 && !cliProjectDocZero))
      ? [join(t.cwd, 'AGENTS.md')]
      : [],
});

const featureNames = ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'apps', 'plugins', 'goals', 'sleep_tool', 'hooks', 'memories'];
const bind = params => {
  policy = {
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
    features: params.config?.features ?? {},
    web_search: params.config?.web_search ?? null,
  };
  const projectDocMaxBytes = params.config?.project_doc_max_bytes ?? null;
  policy.project_doc_max_bytes = projectDocMaxBytes;
  const { project_doc_max_bytes: _omitted, ...legacyPolicy } = policy;
  log('thread-params.jsonl', { method: params.threadId ? 'thread/resume' : 'thread/start', ...legacyPolicy });
  log('doc-params.jsonl', { project_doc_max_bytes: projectDocMaxBytes, developerInstructions: params.developerInstructions ?? null });
  log('mcp-params.jsonl', { mcp_env_vars: params.config?.mcp_servers?.bot?.env_vars ?? null });
  stopMcpChild();
  mcpConfig = params.config.mcp_servers.bot;
};

async function startTools() {
  notify('mcpServer/startupStatus/updated', { threadId: thread.id, name: 'bot',status: 'starting', error: null });
  if (flag('MCP_FAIL')) {
    notify('mcpServer/startupStatus/updated', { threadId: thread.id, name: 'bot', status: 'failed', error: 'connection refused' });
    return;
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.166.0' } });
  thread.tools = (await rpc('tools/list', {})).tools.map(t => t.name);
  // EARLY_USAGE: the thread grew by 110 tokens the client never saw; resuming restates that same total while the client is
  // still verifying the session, before it commits the new binding.
  if (flag('EARLY_USAGE')) {
    const t = load(thread.id);
    if (!t.early) {
      const u = t.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
      t.usage = { inputTokens: u.inputTokens + 100, cachedInputTokens: u.cachedInputTokens + 20, outputTokens: u.outputTokens + 10, reasoningOutputTokens: u.reasoningOutputTokens + 5, totalTokens: u.totalTokens + 110 };
      t.early = true;
      store(t);
      thread.usage = t.usage;
    }
    notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: 'earlier-turn', tokenUsage: { total: t.usage, last: t.usage } });
  }
  notify('mcpServer/startupStatus/updated', { threadId: thread.id, name: 'bot', status: 'ready', error: null });
}

const turnView = (id, status, error = null) => ({ id, items: [], itemsView: 'notLoaded', status, error, startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: status === 'inProgress' ? null : 5 });
const item = async (phase, turnId, it) => notify('item/' + phase, { threadId: thread.id, turnId, item: it, ...(phase === 'started' ? { startedAtMs: 1 } : { completedAtMs: 2 }) });

async function runTurn(turnId, prompt) {
  log('prompts.jsonl', { turnId, prompt });
  const t = load(thread.id);
  t.turns.push({ id: turnId, status: 'inProgress' });
  store(t);
  notify('turn/started', { threadId: thread.id, turn: turnView(turnId, 'inProgress') });
  if (flag('WAIT') || flag('LATE')) return;
  // A total restated after resume is not new usage; the client must not count it again.
  if (t.usage) notify('thread/tokenUsage/updated', { threadId: thread.id, turnId, tokenUsage: { total: t.usage, last: t.usage } });
  await item('started', turnId, { type: 'reasoning', id: 'r-' + turnId, summary: [], content: [] });
  await item('completed', turnId, { type: 'reasoning', id: 'r-' + turnId, summary: ['PRIVATE_FIXTURE_REASONING'], content: ['PRIVATE_FIXTURE_REASONING'] });
  await item('completed', turnId, { type: 'agentMessage', id: 'm-' + turnId, text: '公开输出 fixture public output ' + (env.FIXTURE_TOKEN ?? ''), phase: null });

  // Unapproved dynamic/web/foreign-MCP items still stop the run immediately.
  if (flag('DYNAMIC_TOOL')) {
    await item('started', turnId, { type: 'dynamicToolCall', id: 'dyn-' + turnId, tool: 'host_escape', arguments: {} });
    lateTool();
    return;
  }
  if (flag('WEB_SEARCH')) {
    await item('started', turnId, { type: 'webSearch', id: 'web-' + turnId, query: 'secret exfil' });
    lateTool();
    return;
  }
  if (flag('FOREIGN_MCP')) {
    await item('started', turnId, { type: 'mcpToolCall', id: 'fmcp-' + turnId, server: 'github', tool: 'push_files', arguments: {} });
    await item('completed', turnId, { type: 'mcpToolCall', id: 'fmcp-' + turnId, server: 'github', tool: 'push_files', arguments: {}, status:'completed',result:{} });
  }

  // Native container tools (commandExecution, fileChange, subAgentActivity) are allowed inside <task_dir>/repo and are NOT logged one-by-one.
  await item('started', turnId, { type: 'commandExecution', id: 'cmd-' + turnId, command: 'git status --short', cwd: thread.cwd, commandActions: [], status: 'inProgress' });
  await item('completed', turnId, { type: 'commandExecution', id: 'cmd-' + turnId, command: 'git status --short', cwd: thread.cwd, commandActions: [], status: 'completed', exitCode: 0, aggregatedOutput: '' });
  await item('started', turnId, { type: 'fileChange', id: 'f-' + turnId, changes: [{ path: join(thread.cwd, 'notes.md'), kind: { type: 'add' }, diff: '+notes' }], status: 'inProgress' });
  await item('completed', turnId, { type: 'fileChange', id: 'f-' + turnId, changes: [{ path: join(thread.cwd, 'notes.md'), kind: { type: 'add' }, diff: '+notes' }], status: 'completed' });
  await item('started', turnId, { type: 'subAgentActivity', id: 'sub-' + turnId, agentPath: '/root/child', agentThreadId: randomUUID(), kind: 'spawned' });
  await item('completed', turnId, { type: 'subAgentActivity', id: 'sub-' + turnId, agentPath: '/root/child', agentThreadId: randomUUID(), kind: 'completed' });

  if (flag('PERMISSIONS')) {
    const base = { threadId: thread.id, turnId, startedAtMs: 1 };
    for (const [method, params] of [
      ['item/commandExecution/requestApproval', { ...base, itemId: 'c-' + turnId, command: 'npm test', reason: 'workspace command' }],
      ['item/fileChange/requestApproval', { ...base, itemId: 'f-' + turnId, reason: 'workspace edit' }],
      ['item/permissions/requestApproval', { ...base, itemId: 'p-' + turnId, cwd: thread.cwd, permissions: { network: { enabled: true } } }],
      ['mcpServer/elicitation/request', { threadId: thread.id, turnId, serverName: 'bot', mode: 'form', message: 'Allow read_task_record?', requestedSchema: { type: 'object', properties: {} } }],
      ['mcpServer/elicitation/request', { threadId: thread.id, turnId, serverName: 'github', mode: 'form', message: 'Allow create_issue?', requestedSchema: { type: 'object', properties: {} } }],
      ['mcpServer/elicitation/request', { threadId: thread.id, turnId, serverName: 'bot', mode: 'url', elicitationId: 'e-' + turnId, message: 'Sign in', url: 'https://example.invalid/login' }],
      ['item/tool/requestUserInput', { threadId: thread.id, turnId, itemId: 'q-' + turnId, isBlocking: true, questions: [] }],
      ['item/tool/call', { threadId: thread.id, turnId, callId: 'd-' + turnId, tool: 'publish', arguments: {} }],
      ['account/chatgptAuthTokens/refresh', { reason: 'unauthorized' }],
      ['attestation/generate', { threadId: thread.id, turnId }],
      ['applyPatchApproval', { conversationId: thread.id, callId: 'ap-' + turnId, fileChanges: {}, reason: null, grantRoot: null }],
      ['execCommandApproval', { conversationId: thread.id, callId: 'ec-' + turnId, command: ['ls'], cwd: thread.cwd, reason: null, parsedCmd: [] }],
      ['item/commandExecution/requestApproval', { threadId: 'foreign-thread', turnId, itemId: 'x', startedAtMs: 1 }],
    ]) {
      log('responses.jsonl', { method, response: await ask(method, params) });
    }
  }

  if (flag('DISCONNECT')) { await queue; process.exit(0); }

  const taskRef = /"task_ref":"(task:[a-zA-Z0-9_-]+)"/.exec(String(prompt))?.[1] ?? 'task:t';
  if (flag('MULTIMODAL') || /"fixture_mode":"multimodal"/.test(String(prompt))) {
    const wsPath = /"fixture_workspace_path":"([^"]+)"/.exec(String(prompt))?.[1] ?? null;
    let toolName = 'view_message_image';
    let toolArgs = {};
    if (wsPath) {
      toolName = 'view_workspace_image';
      toolArgs = { path: wsPath };
    } else {
      const listed = await tool('list_message_resources', {});
      toolArgs = { resource_id: listed.resources?.[0]?.resource_id ?? '' };
    }
    const mcpResult = await rpc('tools/call', { name: toolName, arguments: toolArgs });
    const content = Array.isArray(mcpResult?.content) ? mcpResult.content : [];
    const textPart = content.find(b => b?.type === 'text')?.text ?? '';
    const imageParts = content.filter(b => b?.type === 'image' && typeof b.data === 'string');
    await item('completed', turnId, {
      type: 'mcpToolCall',
      id: 'mcp-img-' + turnId,
      server: 'bot',
      tool: toolName,
      arguments: toolArgs,
      status: 'completed',
      result: { content },
    });
    const outputItems = [
      ...(textPart ? [{ type: 'input_text', text: textPart }] : []),
      ...imageParts.map(img => ({ type: 'input_image', image_url: `data:${img.mimeType};base64,${img.data}` })),
    ];
    const relayResp = await fetch(env.OPENAI_BASE_URL + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: thread.model,
        stream: false,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Inspect the image via MCP tool.' }] },
          { type: 'function_call', call_id: 'call_img_1', name: toolName, arguments: JSON.stringify(toolArgs) },
          { type: 'function_call_output', call_id: 'call_img_1', output: outputItems },
        ],
      }),
    });
    await relayResp.text();
    await tool('finish', {
      message: JSON.stringify({ tool: toolName, image_blocks: imageParts.length, relay_status: relayResp.status }),
    });
    finish(turnId, 'completed');
    return;
  }
  if (flag('NATIVE_WORKSPACE') || /"fixture_mode":"native_workspace"/.test(String(prompt))) {
    const target = join(thread.cwd, 'native-codex.txt');
    writeFileSync(target, 'written natively by codex\n');
    const shellOut = execFileSync('/bin/bash', ['-lc', 'cat native-codex.txt'], { cwd: thread.cwd, encoding: 'utf8' }).trim();
    const projectToolOut = env.FIXTURE_PROJECT_TOOL ? execFileSync('/bin/bash',['-lc',env.FIXTURE_PROJECT_TOOL],{cwd:thread.cwd,encoding:'utf8'}).trim() : null;
    const loginGhPath = execFileSync('/bin/bash', ['-lc', 'command -v gh'], { cwd: thread.cwd, encoding: 'utf8' }).trim();
    const relayResp = await fetch(env.OPENAI_BASE_URL + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: thread.model, input: 'native codex relay check' }),
    });
    const relayJson = await relayResp.json();
    const tools = (await rpc('tools/list', {})).tools.map(t => t.name);
    if (tools.includes('read_task_record')) await tool('read_task_record', { ref: taskRef });
    const observerFields = /"fixture_observer":true/.test(String(prompt)) ? { findings: [], inspected_scope: ['a.txt'], unknowns: [] } : {};
    await tool('finish', { summary: 'codex native container verified', ...observerFields, cwd: thread.cwd, shellOut, projectToolOut, loginGhPath, relayStatus: relayResp.status, relayId: relayJson.id ?? null });
    finish(turnId, 'completed');
    return;
  }

  const tools = (await rpc('tools/list', {})).tools.map(t => t.name);
  if (flag('SKILL')) {
    if (tools.some(n => ['read_playbook', 'select_playbooks'].includes(n)) || /playbook_catalog|Discover optional playbooks/.test(String(prompt))) {
      throw new Error('retired_guidance_offered');
    }
    const listing = await tool('read_skill', {});
    const file = await tool('read_skill', { path: listing.files[0].path });
    await tool('finish', { summary: file.content, bundle: listing.bundle, sha256: file.sha256, provided_tools: tools });
    finish(turnId, 'completed');
    return;
  }
  if (flag('KNOWLEDGE')) {
    const search = await tool('search_project_memory', { query: 'socket reset' });
    const itemEntry = search.items?.[0];
    const read = await tool('read_project_memory', { id: itemEntry?.id, revision: itemEntry?.revision });
    const note = await tool('remember_project_memory', { key: 'external.candidate', body: 'Observed fixture transport behavior' });
    await tool('finish', { summary: 'knowledge fixture', read_revision: read.revision, search_preview: itemEntry?.preview ?? null, note_id: note.id ?? null, note_path: note.path ?? null, write_error: note.error, read_error: read.error });
    finish(turnId, 'completed');
    return;
  }
  if (tools.includes('read_task_record')) {
    await tool('read_task_record', { ref: taskRef });
    await item('completed', turnId, { type: 'mcpToolCall', id: 'mcp-' + turnId, server: 'bot', tool: 'read_task_record', arguments: { ref: taskRef }, status: 'completed', result: { content: [] } });
  }
  const now = load(thread.id).usage;
  const usage = {
    inputTokens: (now?.inputTokens ?? 0) + 100,
    cachedInputTokens: (now?.cachedInputTokens ?? 0) + 20,
    outputTokens: (now?.outputTokens ?? 0) + 10,
    reasoningOutputTokens: (now?.reasoningOutputTokens ?? 0) + 5,
    totalTokens: (now?.totalTokens ?? 0) + 110,
  };
  if (!flag('NO_USAGE')) {
    notify('thread/tokenUsage/updated', { threadId: thread.id, turnId, tokenUsage: { total: usage, last: usage } });
    const saved = load(thread.id);
    saved.usage = usage;
    store(saved);
  }
  // Duplicate and unknown events must not change the result.
  await item('completed', turnId, { type: 'plan', id: 'plan-' + turnId, text: 'step 1' });
  await item('completed', turnId, { type: 'plan', id: 'plan-' + turnId, text: 'step 1' });
  notify('fixture/unknownNotification', { threadId: thread.id });
  send({ id: 99999, result: {} });
  if (flag('REROUTE')) { notify('model/rerouted', { threadId: thread.id, turnId, fromModel: thread.model, toModel: 'other-model', reason: 'highRiskCyberActivity' }); lateTool(); return; }
  if (flag('FAIL')) { finish(turnId, 'failed', { message: 'unexpected status 401 Unauthorized', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null }); return; }
  if (!flag('NO_SUBMIT')) await tool('finish', flag('CONVERSATION') ? { message: 'A source-bound response' } : { summary: 'actual fixture result' });
  finish(turnId, 'completed');
}

function finish(turnId, status, error = null) {
  const t = load(thread.id);
  const turn = t.turns.find(x => x.id === turnId);
  if (turn) turn.status = status;
  store(t);
  notify('turn/completed', { threadId: thread.id, turn: turnView(turnId, status, error) });
}

createInterface({ input: process.stdin }).on('line', async line => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m.error ? { error: m.error } : m.result);
    waiting.delete(m.id);
    return;
  }
  const reply = result => send({ id: m.id, result }), error = (code, message, data) => send({ id: m.id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  log('requests.jsonl', { method: m.method, keys: Object.keys(m.params ?? {}).sort() });
  if (m.method === 'initialize') {
    reply({ userAgent: `${m.params.clientInfo.name}/${env.FIXTURE_VERSION ?? '0.166.0'} (fixture) unknown`, codexHome: env.FIXTURE_HOME ?? home, platformFamily: 'unix', platformOs: 'linux' });
  } else if (m.method === 'initialized') {
  } else if (m.method === 'skills/extraRoots/set') {
    extraSkillRoots = Array.isArray(m.params?.extraRoots) ? m.params.extraRoots.map(String) : [];
    log('skills-rpc.jsonl', { method: m.method, extraRoots: extraSkillRoots });
    reply({});
  } else if (m.method === 'skills/list') {
    const cwds = Array.isArray(m.params?.cwds) && m.params.cwds.length ? m.params.cwds.map(String) : [process.cwd()];
    const data = cwds.map(cwdPath => ({
      cwd: cwdPath,
      skills: [
        ...scanSkillsDir(join(cwdPath, '.agents', 'skills'), 'repo'),
        ...scanSkillsDir(join(cwdPath, '.codex', 'skills'), 'repo'),
        ...scanSkillsDir(join(home, 'skills'), 'user'),
        ...extraSkillRoots.flatMap(rootDir => scanSkillsDir(rootDir, 'user')),
      ],
      errors: [],
    }));
    log('skills-rpc.jsonl', { method: m.method, cwds, count: data.reduce((n, g) => n + g.skills.length, 0) });
    reply({ data });
  } else if (m.method === 'skills/config/write') {
    const targetPath = String(m.params?.path ?? '');
    const enabled = Boolean(m.params?.enabled);
    if (!flag('IGNORE_SKILL_DISABLE')) {
      if (enabled) disabledSkillPaths.delete(targetPath);
      else disabledSkillPaths.add(targetPath);
    }
    const effectiveEnabled = flag('IGNORE_SKILL_DISABLE') ? true : enabled;
    log('skills-rpc.jsonl', { method: m.method, path: targetPath, enabled, effectiveEnabled });
    reply({ effectiveEnabled });
  } else if (m.method === 'thread/start') {
    if (flag('PROVIDER_MISMATCH')) {
      error(-32600, `model provider mismatch: server=${processModelProvider}`, {
        codexErrorInfo: { modelProviderMismatch: { expected: processModelProvider, actual: m.params?.modelProvider ?? 'openai' } },
      });
      return;
    }
    bind(m.params);
    thread = { id: randomUUID(), cwd: m.params.cwd, model: env.FIXTURE_MODEL ?? m.params.model ?? 'gpt-fixture', modelProvider: env.FIXTURE_PROVIDER ?? m.params.modelProvider ?? processModelProvider, turns: [], usage: null };
    store(thread);
    reply(opened(thread));
    notify('thread/started', { thread: threadView(thread) });
    await startTools();
  } else if (m.method === 'thread/resume') {
    if (flag('PROVIDER_MISMATCH')) {
      error(-32600, `model provider mismatch: server=${processModelProvider}`, {
        codexErrorInfo: { modelProviderMismatch: { expected: processModelProvider, actual: m.params?.modelProvider ?? 'openai' } },
      });
      return;
    }
    if (env.FIXTURE_RESUME_ERROR) {
      const [code, ...message] = env.FIXTURE_RESUME_ERROR.split(':');
      error(Number(code), message.join(':'));
      return;
    }
    const t = load(m.params.threadId);
    if (!t) { error(-32600, 'no rollout found for thread id ' + m.params.threadId); return; }
    bind(m.params);
    thread = { ...t, model: env.FIXTURE_MODEL ?? t.model, modelProvider: env.FIXTURE_PROVIDER ?? t.modelProvider };
    for (const turn of t.turns) if (turn.status === 'inProgress') turn.status = 'interrupted';
    store(t);
    reply(opened(flag('FOREIGN_CWD') ? { ...thread, cwd: '/elsewhere' } : thread));
    await startTools();
  } else if (m.method === 'thread/turns/list') {
    reply({ data: load(m.params.threadId).turns.slice(-1).reverse().map(t => turnView(t.id, t.status)), nextCursor: null });
  } else if (m.method === 'experimentalFeature/list') {
    const all = featureNames.map(name => ({
      name,
      stage: 'stable',
      defaultEnabled: true,
      enabled:
        name === 'apps' && flag('FEATURE_IGNORED')
          ? true
          : name === 'shell_tool' && flag('MISSING_NATIVE_FEATURE')
            ? false
            : policy.features[name] !== false,
    }));
    reply(m.params.cursor ? { data: all.slice(5), nextCursor: null } : { data: all.slice(0, 5), nextCursor: 'page-2' });
  } else if (m.method === 'mcpServerStatus/list') {
    const tools = Object.fromEntries((thread.tools ?? []).map(name => [name, { name, inputSchema: { type: 'object' } }]));
    reply({
      data: [
        { name: 'bot', runtimeStatus: 'connected', tools, resources: [], resourceTemplates: [], authStatus: 'unsupported' },
        ...(flag('EXTRA_SERVER') ? [{ name: 'github', runtimeStatus: 'connected', tools: {}, resources: [], resourceTemplates: [], authStatus: 'unsupported' }] : []),
      ],
      nextCursor: null,
    });
  } else if (m.method === 'turn/start') {
    if (flag('EXIT')) process.exit(7);
    if (flag('STALE_TERMINAL') || flag('STALE_HINT') || flag('STALE_BEFORE')) {
      const turnId = randomUUID(), older = load(thread.id).turns.at(-2)?.id;
      const late = JSON.stringify({ method: 'item/completed', params: { threadId: thread.id, turnId: older, item: { type: 'agentMessage', id: 'late-' + older, text: 'late', phase: null }, completedAtMs: 2 } }) + '\n';
      // STALE_STOP adds, last in the same chunk, an unapproved dynamic tool item of C that stops the run immediately.
      const stop = flag('STALE_STOP') ? JSON.stringify({ method: 'item/started', params: { threadId: thread.id, turnId, item: { type: 'dynamicToolCall', id: 'dyn-' + turnId, tool: 'host_escape', arguments: {} }, startedAtMs: 1 } }) + '\n' : '';
      if (flag('STALE_BEFORE')) {
        write(late + JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn: turnView(older, 'completed') } }) + '\n' + JSON.stringify({ id: m.id, result: { turn: turnView(turnId, 'inProgress') } }) + '\n');
        void runTurn(turnId, m.params.input[0].text);
        return;
      }
      if (flag('STALE_TERMINAL')) {
        write(JSON.stringify({ id: m.id, result: { turn: turnView(turnId, 'inProgress') } }) + '\n' + late + JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn: turnView(older, 'completed') } }) + '\n' + stop);
        void runTurn(turnId, m.params.input[0].text);
        return;
      }
      const t = load(thread.id);
      t.turns.push({ id: turnId, status: 'inProgress' });
      store(t);
      log('unanswered.jsonl', { turnId });
      write(late);
      notify('turn/started', { threadId: thread.id, turn: turnView(turnId, 'inProgress') });
      await queue;
      process.exit(0);
    }
    if (flag('START_REFUSED')) { error(-32600, 'turn start refused'); return; }
    if (flag('TURN_PROVIDER_MISMATCH')) {
      error(-32600, 'model provider mismatch on turn/start', {
        codexErrorInfo: { modelProviderMismatch: { expected: 'bot_relay', actual: 'openai' } },
      });
      return;
    }
    if (flag('START_HANG')) {
      const turnId = randomUUID(), t = load(thread.id);
      t.turns.push({ id: turnId, status: 'inProgress' });
      store(t);
      log('unanswered.jsonl', { turnId });
      notify('turn/started', { threadId: thread.id, turn: turnView(turnId, 'inProgress') });
      return;
    }
    if (flag('START_UNANSWERED') || flag('START_SILENT')) {
      const turnId = randomUUID(), t = load(thread.id), previous = t.turns.at(-1)?.id;
      t.turns.push({ id: turnId, status: 'inProgress' });
      log('unanswered.jsonl', { turnId });
      if (flag('LATE_PREVIOUS') && previous) {
        notify('item/completed', { threadId: thread.id, turnId: previous, item: { type: 'agentMessage', id: 'late-' + previous, text: 'late', phase: null }, completedAtMs: 2 });
      }
      if (flag('START_UNANSWERED')) {
        const u = t.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
        t.usage = { inputTokens: u.inputTokens + 100, cachedInputTokens: u.cachedInputTokens + 20, outputTokens: u.outputTokens + 10, reasoningOutputTokens: u.reasoningOutputTokens + 5, totalTokens: u.totalTokens + 110 };
        store(t);
        notify('turn/started', { threadId: thread.id, turn: turnView(turnId, 'inProgress') });
        notify('thread/tokenUsage/updated', { threadId: thread.id, turnId, tokenUsage: { total: t.usage, last: t.usage } });
      } else {
        store(t);
      }
      await queue;
      process.exit(0);
    }
    const turnId = randomUUID();
    if (flag('SAME_CHUNK')) {
      const t = load(thread.id);
      t.turns.push({ id: turnId, status: 'inProgress' });
      store(t);
      write(
        JSON.stringify({ id: m.id, result: { turn: turnView(turnId, 'inProgress') } }) + '\n' +
        JSON.stringify({ method: 'item/started', params: { threadId: thread.id, turnId, item: { type: 'dynamicToolCall', id: 'dyn-' + turnId, tool: 'host_escape', arguments: {} }, startedAtMs: 1 } }) + '\n',
      );
      lateTool();
      return;
    }
    reply({ turn: turnView(turnId, 'inProgress') });
    void runTurn(turnId, m.params.input[0].text);
  } else if (m.method === 'turn/interrupt') {
    log('interrupts.jsonl', m.params);
    reply({});
    if (flag('IGNORE_INTERRUPT')) return;
    if (flag('LATE')) {
      await tool('finish', { summary: 'late result' }).catch(() => {});
      finish(m.params.turnId, 'completed');
      return;
    }
    finish(m.params.turnId, 'interrupted');
  } else {
    error(-32601, 'method not found');
  }
});
