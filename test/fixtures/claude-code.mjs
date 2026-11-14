#!/usr/bin/env node
// Protocol fixture only. This executable is not Claude Code and is never used as live-model evidence.
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
if (process.argv.includes('--version')) {
  console.log('2.1.319 (Claude Code)');
  process.exit();
}

const sid = arg('--resume') ?? arg('--session-id');
const send = value => process.stdout.write(JSON.stringify({ session_id: sid, ...value }) + '\n');

// Connect to the bot MCP server (stdio command/args in container mode, or legacy HTTP url).
const mcpConfig = JSON.parse(arg('--mcp-config') || '{}')?.mcpServers?.bot ?? {};
let mcpChild = null;
const mcpPending = new Map();
let mcpSeq = 1;

function ensureStdioMcp() {
  if (mcpChild || !mcpConfig.command) return;
  mcpChild = spawn(mcpConfig.command, mcpConfig.args ?? [], {
    env: { ...process.env, ...(mcpConfig.env ?? {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcpChild.unref();
  mcpChild.stdin.unref();
  mcpChild.stdout.unref();
  createInterface({ input: mcpChild.stdout }).on('line', line => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && mcpPending.has(msg.id)) {
      const resolveRpc = mcpPending.get(msg.id);
      mcpPending.delete(msg.id);
      resolveRpc(msg);
    }
  });
  process.on('exit', () => {
    try { mcpChild?.kill('SIGTERM'); } catch {}
  });
}

async function mcpRpc(method, params, customId) {
  const id = customId ?? `init-${mcpSeq++}`;
  if (mcpConfig.command) {
    ensureStdioMcp();
    return new Promise((resolveRpc, rejectRpc) => {
      mcpPending.set(id, resolveRpc);
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', err => {
        if (err) {
          mcpPending.delete(id);
          rejectRpc(err);
        }
      });
    });
  }
  const response = await fetch(mcpConfig.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return response.json();
}

let initialized = false;
let offeredMcpTools = [];
let mode = 'normal';

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    process.exit();
  }
  if (m.type !== 'user') continue;

  const prompt = m.message.content[0].text;
  const parsedMode = /"fixture_mode":"([a-z0-9_-]+)"/.exec(prompt)?.[1];
  if (parsedMode) mode = parsedMode;

  if (mode === 'malformed') { process.stdout.write('{no\n'); continue; }
  if (mode === 'invalid_utf8') { process.stdout.write(Buffer.from([0xff, 0x0a])); continue; }
  if (mode === 'truncated') { process.stdout.write('{"type":'); process.exit(); }

  if (!initialized) {
    initialized = true;
    await mcpRpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-fixture', version: '2.1.319' } });
    const listed = await mcpRpc('tools/list', {});
    offeredMcpTools = (listed?.result?.tools ?? []).map(t => 'mcp__bot__' + t.name);

    const disallowed = (arg('--disallowedTools') ?? '').split(',').filter(Boolean);
    const nativeBuiltins = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent'];
    if (!disallowed.includes('WebFetch')) nativeBuiltins.push('WebFetch', 'WebSearch');
    const allTools = [...nativeBuiltins, ...offeredMcpTools];

    const persisted = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
    mkdirSync(persisted, { recursive: true });
    writeFileSync(join(persisted, sid + '.jsonl'), '{}\n');
    writeFileSync(
      join(process.env.HOME, 'launch.json'),
      JSON.stringify({
        args: process.argv.slice(2),
        env_names: Object.keys(process.env),
        cwd: process.cwd(),
        resumed: process.argv.includes('--resume'),
        mcp_config: mcpConfig,
      }),
    );

    send({
      type: 'system',
      subtype: 'init',
      model: arg('--model'),
      tools: mode === 'extra_tool' ? [...allTools, 'EnterWorktree'] : allTools,
      mcp_servers: [{ name: 'bot', status: 'connected' }],
    });
  }

  if (['auth_error', 'model_error', 'rate_error', 'transport_error'].includes(mode)) {
    if (mode === 'rate_error') {
      const reply = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ model: arg('--model'), max_tokens: 256, messages: [{ role: 'user', content: 'fixture rate limit probe' }], tools: [] }),
      });
      await reply.text();
    }
    const error = ({ auth_error: 'authentication_failed', model_error: 'invalid_request', rate_error: 'rate_limit', transport_error: 'server_error' })[mode];
    send({ type: 'system', subtype: 'api_retry', attempt: 1, error });
    send({ type: 'assistant', error, message: { id: 'fault-1', content: [{ type: 'text', text: 'Fixture provider failure' }] } });
    send({ type: 'result', subtype: 'success', is_error: true, num_turns: 0 });
    process.exitCode = 1;
    break;
  }

  if (mode === 'wait' || mode === 'late') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(join(process.env.HOME, 'child.pid'), String(child.pid));
    if (mode === 'wait') continue;
    await new Promise(r => setTimeout(r, 800));
  }

  const call = async (name, args) => {
    const id = 'rpc-' + name + '-' + Math.random().toString(36).slice(2);
    send({
      type: 'assistant',
      message: {
        id,
        content: [
          { type: 'thinking', thinking: 'PRIVATE_FIXTURE_REASONING' },
          { type: 'tool_use', id, name: 'mcp__bot__' + name, input: args },
        ],
        ...(mode === 'unknown_usage' ? {} : { usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 2 } }),
      },
    });
    const body = await mcpRpc('tools/call', { name, arguments: args }, id);
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'PRIVATE_RAW_OBSERVATION' }] } });
    return body.result?.content ? JSON.parse(body.result.content[0].text) : body;
  };

  if (mode === 'permission') {
    send({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'gh pr create' } } });
  }

  if (mode === 'conversation') {
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: arg('--model'), max_tokens: 256, messages: [{ role: 'user', content: 'Fixture provider request' }], tools: [] }),
    });
    await response.json();
    await call('search_conversation_history', {});
    await call('finish', { message: 'A source-bound response' });
    send({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, usage: { input_tokens: 22, output_tokens: 14 } });
    continue;
  }

  const taskRef = /"task_ref":"(task:[a-zA-Z0-9_-]+)"/.exec(prompt)?.[1] ?? 'task:t';

  if (mode === 'native_workspace') {
    // Exercise native file edit, native shell command, model relay, and optional gh/git credential helpers inside <task_dir>/repo.
    const targetFile = join(process.cwd(), 'native-claude.txt');
    writeFileSync(targetFile, 'written natively by claude_code\n');
    const shellOut = execFileSync('/bin/sh', ['-c', 'cat native-claude.txt'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    let ghOut = null;
    if (process.env.FIXTURE_TEST_GH === 'true') {
      ghOut = execFileSync('gh', ['pr', 'view', '705'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    }
    let gitCredMatched = false;
    if (/"fixture_test_git_cred":true/.test(prompt)) {
      const filled = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=' + (process.env.BOT_GITHUB_HOST || 'github.com') + '\n\n',
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      gitCredMatched = /username=x-access-token/.test(filled) && /password=\S+/.test(filled);
      send({
        type: 'assistant',
        message: {
          id: 'cred-probe-1',
          content: [{ type: 'text', text: 'cred=' + filled.trim() }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    }
    send({
      type: 'assistant',
      message: {
        id: 'native-bash-1',
        content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'cat native-claude.txt' } }],
        usage: { input_tokens: 5, output_tokens: 4 },
      },
    });
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_1', content: shellOut }] } });
    const relayResp = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: arg('--model'), max_tokens: 128, messages: [{ role: 'user', content: 'native workspace check' }], tools: [] }),
    });
    await relayResp.json();
    const record = await call('read_task_record', { ref: taskRef });
    await call('finish', {
      summary: 'native container tools verified',
      fact: record.task?.contract?.goal ?? record.contract?.goal ?? 'read',
      cwd: process.cwd(),
      shellOut,
      ghOut,
      gitCredMatched,
      fileContent: readFileSync(targetFile, 'utf8').trim(),
    });
    send({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, usage: { input_tokens: 22, output_tokens: 14 } });
    continue;
  }

  const record = await call('read_task_record', { ref: taskRef });
  if (mode === 'wrong_ref') await call('read_task_record', { ref: 'task:o' });
  if (mode === 'exit') process.exit(4);
  if (mode === 'no_result') process.exit();
  if (mode === 'fragmented') {
    const b = Buffer.from(JSON.stringify({ type: 'assistant', session_id: sid, message: { id: 'text-1', content: [{ type: 'text', text: '核对通过' }], usage: { input_tokens: 1, output_tokens: 3 } } }) + '\n');
    for (const byte of b) process.stdout.write(Buffer.from([byte]));
  }
  if (mode === 'long_text') {
    send({ type: 'assistant', message: { id: 'long-1', content: [{ type: 'text', text: 'x'.repeat(70_000) }], usage: { input_tokens: 1, output_tokens: 3 } } });
  }
  if (mode !== 'no_submit') {
    await call('finish', { summary: mode === 'bad_report' ? '' : 'read through gateway', fact: record.task?.contract?.goal ?? record.contract?.goal ?? 'read' });
  }
  const result = {
    type: 'result',
    subtype: mode === 'budget' ? 'error_max_turns' : 'success',
    is_error: mode === 'budget',
    num_turns: 2,
    ...(mode === 'unknown_usage' ? {} : { usage: { input_tokens: 22, output_tokens: 14, cache_read_input_tokens: 4 } }),
  };
  send(result);
  if (result.is_error) {
    process.exitCode = 1;
    break;
  }
  if (mode === 'after_result') {
    send({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: 'late' }] } });
  }
}
try {
  mcpChild?.stdin.end();
  mcpChild?.kill('SIGTERM');
} catch {}
