// These legacy protocol fixtures exercise the explicitly enabled gateway transport.
process.env.BOT_HARNESS_MODEL_TRANSPORT='gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../dist/storage/database.js';
import { Redactor, TaskError } from '../dist/agent/common.js';
import { Workspace } from '../dist/agent/workspace.js';
import { withContainerHarnessSession } from '../dist/harness/container-session.js';
import { prepareClaudeCode } from '../dist/harness/claude-code.js';
import { prepareCodex } from '../dist/harness/codex.js';
import { roleHarness } from '../dist/roles/harness.js';
import { createToolDispatch } from '../runner/tool-dispatch.mjs';
import { refuseFull } from '../runner/disk.mjs';
import { managerFixture } from './project-manager-fixture.mjs';

const hex48 = () => randomBytes(24).toString('hex');
const runnerScript = resolve('runner/runner.mjs');

function makeRunAccess() {
  const token = `rrt_${randomBytes(9).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
  return {
    token,
    check(presented) {
      if (presented !== token) throw new TaskError('run_token_invalid', 'failed');
    },
  };
}

function execLocalRunner(workspaceRoot, input, timeoutMs = 15_000) {
  return new Promise((resolveResult, reject) => {
    const payload = { operation_id: hex48(), ...input };
    const child = spawn(process.execPath, [runnerScript, Buffer.from(JSON.stringify(payload)).toString('base64url')], {
      env: {
        PATH: dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        BOT_LOCAL_EXECUTION: 'true',
        BOT_LOCAL_WORKSPACE: workspaceRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('runner_timeout')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        resolveResult({ ok: false, error: 'runner_exit_' + code, detail: err });
        return;
      }
      resolveResult(JSON.parse(out));
    });
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    if (state === 'Z') return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = await predicate();
    if (val) return val;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await delay(stepMs);
  }
}

test('M1: restarting harness in the same workspace reaps prior harness and child group, fences stale instance_id, and verifies PID ownership before signaling', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-m1-'));
  const wsId = hex48();
  mkdirSync(join(root, 'tasks', wsId, 'repo'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'project-notes'), { recursive: true, mode: 0o700 });

  const cliScript = join(root, 'fake-cli.mjs');
  writeFileSync(
    cliScript,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const marker = process.env.FIXTURE_CLI_MARKER_FILE;
const bg = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
writeFileSync(marker, JSON.stringify({ cliPid: process.pid, bgPid: bg.pid }));
process.stdout.write(JSON.stringify({ ready: process.env.FIXTURE_CLI_TAG, pid: process.pid, bg: bg.pid }) + '\\n');
process.stdin.on('data', chunk => {
  process.stdout.write('ECHO:' + chunk.toString('utf8'));
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );

  t.after(async () => {
    await execLocalRunner(root, { type: 'reap', workspace_id: wsId }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const writeConfigAndStart = async (instId, tag, markerFile) => {
    const cfg = {
      instance_id: instId,
      harness: 'codex',
      executable: process.execPath,
      executable_args: [cliScript],
      run_token: 'rrt_' + hex48(),
      model: 'gpt-5-codex',
      system_prompt: '',
      max_turns: 4,
      max_output_tokens: 1024,
      session_id: null,
      resume: false,
      session_key: 'default',
      state_workspace_id: wsId,
      egress: false,
      github_host: 'github.com',
      allow_http_git: false,
      extra_env: { FIXTURE_CLI_TAG: tag, FIXTURE_CLI_MARKER_FILE: markerFile },
      mcp_tools: [],
    };
    const raw = Buffer.from(JSON.stringify(cfg), 'utf8');
    const saved = await execLocalRunner(root, {
      type: 'workspace_harness_config',
      workspace_id: wsId,
      base64: raw.toString('base64'),
      offset: 0,
      final: true,
    });
    assert.equal(saved.ok, true);
    const started = await execLocalRunner(root, {
      type: 'workspace_harness_start',
      workspace_id: wsId,
      instance_id: instId,
    });
    assert.equal(started.ok, true);
    assert.equal(started.result.started, true);
    return started.result;
  };

  const instA = hex48(), markerA = join(root, 'marker-a.json');
  const startA = await writeConfigAndStart(instA, 'session-A', markerA);
  const pidsA = await waitFor(() => existsSync(markerA) ? JSON.parse(readFileSync(markerA, 'utf8')) : null);
  assert.equal(isPidAlive(startA.pid), true);
  assert.equal(isPidAlive(pidsA.cliPid), true);
  assert.equal(isPidAlive(pidsA.bgPid), true);

  // Starting session B in the same workspace must reap session A's harness-entry, CLI child, and process-group grandchild.
  const instB = hex48(), markerB = join(root, 'marker-b.json');
  const startB = await writeConfigAndStart(instB, 'session-B', markerB);
  const pidsB = await waitFor(() => existsSync(markerB) ? JSON.parse(readFileSync(markerB, 'utf8')) : null);

  await waitFor(() => !isPidAlive(startA.pid) && !isPidAlive(pidsA.cliPid) && !isPidAlive(pidsA.bgPid));
  assert.equal(isPidAlive(startB.pid), true);
  assert.equal(isPidAlive(pidsB.cliPid), true);

  // Stale instance_id poll reports 'superseded', and stale stdin / interrupt are ignored without touching session B!
  const stalePoll = await execLocalRunner(root, {
    type: 'workspace_harness_poll',
    workspace_id: wsId,
    offset: 0,
    instance_id: instA,
  });
  assert.equal(stalePoll.ok, true);
  assert.equal(stalePoll.result.state, 'superseded');
  assert.equal(stalePoll.result.instance_id, instB);

  const staleStdin = await execLocalRunner(root, {
    type: 'workspace_harness_stdin',
    workspace_id: wsId,
    instance_id: instA,
    base64: Buffer.from('POISON\n').toString('base64'),
    final: true,
  });
  assert.equal(staleStdin.ok, true);
  assert.equal(staleStdin.result.written, false);
  assert.equal(staleStdin.result.stale_instance, true);

  const staleKill = await execLocalRunner(root, {
    type: 'workspace_harness_interrupt',
    workspace_id: wsId,
    mode: 'kill',
    instance_id: instA,
  });
  assert.equal(staleKill.ok, true);
  assert.equal(staleKill.result.interrupted, false);
  assert.equal(staleKill.result.stale_instance, true);
  assert.equal(isPidAlive(startB.pid), true);
  assert.equal(isPidAlive(pidsB.cliPid), true);

  // Active session B continues receiving its own stdin and emitting stdout undisturbed.
  const okStdin = await execLocalRunner(root, {
    type: 'workspace_harness_stdin',
    workspace_id: wsId,
    instance_id: instB,
    base64: Buffer.from('HELLO_B\n').toString('base64'),
  });
  assert.equal(okStdin.result.written, true);
  const liveOut = await waitFor(async () => {
    const p = await execLocalRunner(root, { type: 'workspace_harness_poll', workspace_id: wsId, offset: 0, instance_id: instB });
    const text = Buffer.from(p.result.stdout_base64 || '', 'base64').toString('utf8');
    return text.includes('ECHO:HELLO_B') ? text : null;
  });
  assert.ok(!liveOut.includes('POISON'));

  // Cleanly kill session B, then verify PID ownership check refuses to signal an unrelated process recorded in harness-state.json!
  await execLocalRunner(root, { type: 'workspace_harness_interrupt', workspace_id: wsId, mode: 'kill', instance_id: instB });
  await waitFor(() => !isPidAlive(startB.pid) && !isPidAlive(pidsB.cliPid));

  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { bystander.kill('SIGKILL'); } catch {} });
  const statePath = join(root, 'tasks', wsId, 'agent', 'harness-state.json');
  const forgedInst = hex48();
  writeFileSync(statePath, JSON.stringify({
    state: 'running',
    pid: bystander.pid,
    cli_pid: bystander.pid,
    boot: startB.boot,
    instance_id: forgedInst,
  }));
  await execLocalRunner(root, {
    type: 'workspace_harness_interrupt',
    workspace_id: wsId,
    mode: 'kill',
    instance_id: forgedInst,
  });
  assert.equal(isPidAlive(bystander.pid), true, 'unrelated PID without harness-entry cmdline or workspace tag must never be killed');
  bystander.kill('SIGKILL');
});

test('M1: immediate CLI startup failure returns started:false and stops with execution_interrupted (waiting_environment), and superseded session teardown does not reap the active session', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-startup-fail-'));
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  const sharedWsId = hex48();
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,workspace_id) VALUES('t1','r','task.request','running','test','{}',1,?)", sharedWsId);

  const baseSpec = () => ({
    store,
    task: store.get("SELECT * FROM tasks WHERE id='t1'"),
    redactor: new Redactor(),
    guard: async () => {},
    runAccess: makeRunAccess(),
    system: 'test',
    prompt: 'test',
    tools: [],
  });

  // 1. Missing / immediate-error binary reports started:false -> stops with execution_interrupted (waiting_environment).
  await assert.rejects(
    withContainerHarnessSession(
      baseSpec(),
      {
        cli: 'codex',
        model: 'gpt-5-codex',
        localWorkspaceRoot: root,
        executableOverride: { executable: join(root, 'missing-binary-does-not-exist'), version: '0.166.0' },
      },
      new AbortController().signal,
      () => {},
      async session => session.waitExit(),
    ),
    err => err instanceof TaskError && err.code === 'execution_interrupted' && err.state === 'waiting_environment',
  );

  // 2. When session B supersedes session A in the same workspace, session A's finally teardown must NOT kill session B!
  const steadyCli = join(root, 'steady-cli.mjs');
  writeFileSync(
    steadyCli,
    `#!/usr/bin/env node
process.stdout.write('READY:' + (process.env.FIXTURE_SESSION || '') + '\\n');
process.stdin.on('data', chunk => {
  if (chunk.toString().includes('EXIT_NOW')) process.exit(0);
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );

  let sessionAReady;
  const readyAPromise = new Promise(r => { sessionAReady = r; });
  const runA = withContainerHarnessSession(
    baseSpec(),
    {
      cli: 'codex',
      model: 'gpt-5-codex',
      localWorkspaceRoot: root,
      pollWaitMs: 25,
      extraEnv: { FIXTURE_SESSION: 'A' },
      executableOverride: { executable: process.execPath, args: [steadyCli], version: '0.166.0' },
    },
    new AbortController().signal,
    chunk => { if (chunk.toString().includes('READY:A')) sessionAReady(); },
    async session => session.waitExit(),
  );

  const runASettled = assert.rejects(runA, err => err instanceof TaskError && err.code === 'execution_interrupted' && err.state === 'waiting_environment');
  await readyAPromise;

  let outB = '';
  const exitB = await withContainerHarnessSession(
    baseSpec(),
    {
      cli: 'codex',
      model: 'gpt-5-codex',
      localWorkspaceRoot: root,
      pollWaitMs: 25,
      extraEnv: { FIXTURE_SESSION: 'B' },
      executableOverride: { executable: process.execPath, args: [steadyCli], version: '0.166.0' },
    },
    new AbortController().signal,
    chunk => { outB += chunk.toString('utf8'); },
    async session => {
      // Wait until session A detects supersession and finishes its finally block while session B is alive!
      await runASettled;
      await session.writeStdin('EXIT_NOW\n', true);
      return session.waitExit();
    },
  );
  assert.equal(exitB.state, 'completed');
  assert.equal(exitB.exit_code, 0);
  assert.ok(outB.includes('READY:B'));
});

test('M2: workspace_harness_poll returns seen-ID stubs, enforces 1.5 MiB request budget and >2 MiB oversized replies, wakes early from wait_ms, leaves zero .runner-journal files, and exempts stdin/interrupt from disk_full refusal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-m2-'));
  const wsId = hex48();
  const agentDir = join(root, 'tasks', wsId, 'agent');
  mkdirSync(join(root, 'tasks', wsId, 'repo'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentDir, 'tool-requests'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentDir, 'token-requests'), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentDir, 'model-requests'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'project-notes'), { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(refuseFull({ type: 'workspace_harness_poll' }, () => ({ full: true, free_bytes: 0, total_bytes: 100 })), null);
  assert.equal(refuseFull({ type: 'workspace_harness_stdin' }, () => ({ full: true, free_bytes: 0, total_bytes: 100 })), null);
  assert.equal(refuseFull({ type: 'workspace_harness_interrupt' }, () => ({ full: true, free_bytes: 0, total_bytes: 100 })), null);
  assert.equal(refuseFull({ type: 'workspace_command' }, () => ({ full: true, free_bytes: 0, total_bytes: 100 }))?.error, 'disk_full');

  const tool1 = '1'.repeat(48), tool2 = '2'.repeat(48), tool3 = '3'.repeat(48), toolHuge = '4'.repeat(48);
  const tok1 = '5'.repeat(48), mod1 = '6'.repeat(48);

  // Three ~650 KiB tool requests (~1.95 MiB total) exceed the 1.5 MiB per-poll budget -> 2 delivered, 3rd deferred with has_more=true.
  const bigArg = 'x'.repeat(650 * 1024);
  writeFileSync(join(agentDir, 'tool-requests', `${tool1}.json`), JSON.stringify({ id: tool1, name: 't1', arguments: { data: bigArg } }));
  await delay(10);
  writeFileSync(join(agentDir, 'tool-requests', `${tool2}.json`), JSON.stringify({ id: tool2, name: 't2', arguments: { data: bigArg } }));
  await delay(10);
  writeFileSync(join(agentDir, 'tool-requests', `${tool3}.json`), JSON.stringify({ id: tool3, name: 't3', arguments: { data: bigArg } }));
  writeFileSync(join(agentDir, 'token-requests', `${tok1}.json`), JSON.stringify({ id: tok1, purpose: 'git', token: 'rrt_secret' }));
  writeFileSync(join(agentDir, 'model-requests', `${mod1}.json`), JSON.stringify({ id: mod1, path: '/v1/messages', body: { ok: true } }));

  const poll1 = await execLocalRunner(root, {
    type: 'workspace_harness_poll',
    workspace_id: wsId,
    offset: 0,
  });
  assert.equal(poll1.ok, true);
  assert.equal(poll1.result.has_more, true, '3rd 650 KiB request deferred past 1.5 MiB budget');
  assert.deepEqual(poll1.result.tool_requests.map(r => r.id), [tool1, tool2]);
  assert.equal(poll1.result.token_requests.length, 1);
  assert.equal(poll1.result.model_requests.length, 1);

  // Zero .runner-journal records written by workspace_harness_poll!
  assert.deepEqual(readdirSync(join(root, '.runner-journal')), []);

  // Poll 2 passes tool1, tool2, tok1, mod1 as known IDs -> receives lightweight { id, stub: true } without re-reading bodies, plus full tool3!
  const poll2 = await execLocalRunner(root, {
    type: 'workspace_harness_poll',
    workspace_id: wsId,
    offset: 0,
    known_tool_ids: [tool1, tool2],
    known_token_ids: [tok1],
    known_model_ids: [mod1],
  });
  assert.equal(poll2.ok, true);
  assert.equal(poll2.result.has_more, false);
  assert.deepEqual(poll2.result.tool_requests[0], { id: tool1, stub: true });
  assert.deepEqual(poll2.result.tool_requests[1], { id: tool2, stub: true });
  assert.equal(poll2.result.tool_requests[2].id, tool3);
  assert.equal(poll2.result.tool_requests[2].arguments.data.length, bigArg.length);
  assert.deepEqual(poll2.result.token_requests, [{ id: tok1, stub: true }]);
  assert.equal(poll2.result.model_requests[0].stub, true);
  assert.equal(poll2.result.model_requests[0].data, undefined);

  // Oversized (>2 MiB) tool request is flagged with { id, oversized: true } instead of blowing up runner stdout.
  writeFileSync(join(agentDir, 'tool-requests', `${toolHuge}.json`), JSON.stringify({ id: toolHuge, name: 'huge', arguments: { blob: 'z'.repeat(2_200_000) } }));
  const pollHuge = await execLocalRunner(root, {
    type: 'workspace_harness_poll',
    workspace_id: wsId,
    offset: 0,
    known_tool_ids: [tool1, tool2, tool3],
    known_token_ids: [tok1],
    known_model_ids: [mod1],
  });
  const hugeEntry = pollHuge.result.tool_requests.find(r => r.id === toolHuge);
  assert.equal(hugeEntry.oversized, true);

  // wait_ms blocks quietly when idle and wakes immediately when new stdout arrives!
  const instLive = hex48();
  rmSync(join(agentDir, 'tool-requests'), { recursive: true, force: true });
  rmSync(join(agentDir, 'token-requests'), { recursive: true, force: true });
  rmSync(join(agentDir, 'model-requests'), { recursive: true, force: true });

  const holdCli = join(root, 'hold-cli.mjs');
  writeFileSync(holdCli, `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const cfg = {
    instance_id: instLive,
    harness: 'codex',
    executable: process.execPath,
    executable_args: [holdCli],
    run_token: 'rrt_' + hex48(),
    model: 'gpt-5-codex',
    system_prompt: '',
    max_turns: 2,
    max_output_tokens: 512,
    session_id: null,
    resume: false,
    session_key: 'default',
    state_workspace_id: wsId,
    egress: false,
    github_host: 'github.com',
    allow_http_git: false,
    mcp_tools: [],
  };
  await execLocalRunner(root, {
    type: 'workspace_harness_config',
    workspace_id: wsId,
    base64: Buffer.from(JSON.stringify(cfg)).toString('base64'),
    offset: 0,
    final: true,
  });
  await execLocalRunner(root, { type: 'workspace_harness_start', workspace_id: wsId, instance_id: instLive });
  t.after(async () => {
    await execLocalRunner(root, { type: 'workspace_harness_interrupt', workspace_id: wsId, mode: 'kill', instance_id: instLive }).catch(() => {});
  });

  const t0 = Date.now();
  setTimeout(() => {
    writeFileSync(join(agentDir, 'harness-stdout.bin'), 'WAKE_NOW\n');
  }, 60);
  const woken = await execLocalRunner(root, {
    type: 'workspace_harness_poll',
    workspace_id: wsId,
    offset: 0,
    instance_id: instLive,
    wait_ms: 900,
  });
  const elapsed = Date.now() - t0;
  assert.equal(Buffer.from(woken.result.stdout_base64, 'base64').toString('utf8'), 'WAKE_NOW\n');
  assert.ok(elapsed < 600, `expected early wakeup from wait_ms=900, took ${elapsed}ms`);
});

test('M2: manager executes workspace_harness_poll without SQLite/trajectory writes or 1-slot command contention, and redacts harness secrets in trajectories', async t => {
  const f = await managerFixture(t);
  const project = await f.projects.register('101');
  const generation = project.generation;
  const wsId = hex48();

  let cmdStarted, releaseCmd;
  const startedPromise = new Promise(r => { cmdStarted = r; });
  const releasePromise = new Promise(r => { releaseCmd = r; });

  f.docker.runner = async (_container, req) => {
    if (req.type === 'workspace_command') {
      cmdStarted();
      await releasePromise;
      return { ok: true, result: { exit_code: 0, output: 'done' } };
    }
    if (req.type === 'workspace_harness_poll') {
      return { ok: true, result: { state: 'running', stdout_base64: '', next_offset: 0, stdout_size: 0, has_more: false, token_requests: [], tool_requests: [], model_requests: [] } };
    }
    return { ok: true, result: { written: true } };
  };

  // Start a blocking workspace_command occupying the default parallel=1 slot.
  const longCmd = f.projects.operate('101', 'execute', {
    operation_id: hex48(),
    generation,
    request: { type: 'workspace_command', workspace_id: wsId, command: 'sleep 10' },
  });
  await startedPromise;

  // Run 5 workspace_harness_poll calls while the parallel=1 slot is busy: must complete immediately and write 0 operations/trajectories!
  const opsBefore = f.projects.db.prepare('SELECT count(*) n FROM operations').get().n;
  for (let i = 0; i < 5; i++) {
    const res = await f.projects.operate('101', 'execute', {
      operation_id: hex48(),
      generation,
      request: { type: 'workspace_harness_poll', workspace_id: wsId, offset: 0, wait_ms: 50 },
    });
    assert.equal(res.ok, true);
    assert.equal(res.result.state, 'running');
  }
  const opsAfterPolls = f.projects.db.prepare('SELECT count(*) n FROM operations').get().n;
  assert.equal(opsAfterPolls, opsBefore, 'workspace_harness_poll must not insert rows into manager operations table');

  releaseCmd();
  await longCmd;

  // Execute workspace_harness_config and workspace_agent_token containing sensitive run tokens and GitHub tokens:
  // verify manager trajectories redact base64 payloads and token fields on disk!
  const secretRunToken = 'rrt_' + '9'.repeat(48);
  const secretGhToken = 'ghs_super_secret_github_token_value';
  const cfgPayload = Buffer.from(JSON.stringify({ run_token: secretRunToken, model: 'claude' })).toString('base64');
  const tokPayload = Buffer.from(JSON.stringify({ token: secretGhToken })).toString('base64');

  await f.projects.operate('101', 'execute', {
    operation_id: hex48(),
    generation,
    request: { type: 'workspace_harness_config', workspace_id: wsId, base64: cfgPayload, offset: 0, final: true },
  });
  await f.projects.operate('101', 'execute', {
    operation_id: hex48(),
    generation,
    request: { type: 'workspace_agent_token', workspace_id: wsId, request_id: hex48(), base64: tokPayload },
  });
  await f.projects.trajectories.settle();

  const dbDump = JSON.stringify(f.projects.db.prepare('SELECT input, result FROM operations').all());
  assert.ok(!dbDump.includes(secretRunToken) && !dbDump.includes(cfgPayload));
  assert.ok(!dbDump.includes(secretGhToken) && !dbDump.includes(tokPayload));

  const trajFiles = f.projects.db.prepare('SELECT path FROM trajectory_files').all();
  assert.ok(trajFiles.length >= 1);
  for (const row of trajFiles) {
    const content = readFileSync(join(f.root, 'trajectories', row.path), 'utf8');
    assert.ok(!content.includes(secretRunToken), 'run_token must not leak into manager trajectory jsonl');
    assert.ok(!content.includes(cfgPayload), 'workspace_harness_config base64 must be redacted in manager trajectory');
    assert.ok(!content.includes(secretGhToken), 'GitHub token must not leak into manager trajectory jsonl');
    assert.ok(!content.includes(tokPayload), 'workspace_agent_token base64 must be redacted in manager trajectory');
  }
});

test('M5 & oversized tool requests: failed tool handler is never re-executed on subsequent polls, and >2 MiB tool request receives tool_request_too_large error reply', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-m5-'));
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt) VALUES('t1','r','task.request','running','test','{}',1)");

  // Part 1: Oversized (>2 MiB) tool request receives { error: 'tool_request_too_large' } and session continues cleanly!
  const oversizedCli = join(root, 'oversized-cli.mjs');
  writeFileSync(
    oversizedCli,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const agentDir = join(process.cwd(), '..', 'agent');
mkdirSync(join(agentDir, 'tool-requests'), { recursive: true });
const id = 'a'.repeat(48);
const reqTmp = join(agentDir, 'tool-requests', id + '.tmp');
const reqJson = join(agentDir, 'tool-requests', id + '.json');
writeFileSync(reqTmp, JSON.stringify({ id, name: 'echo_tool', token: process.env.BOT_RUN_TOKEN, arguments: { huge: 'X'.repeat(2_200_000) } }));
renameSync(reqTmp, reqJson);
const replyPath = join(agentDir, 'tool-replies', id + '.json');
const deadline = Date.now() + 8000;
const timer = setInterval(() => {
  if (existsSync(replyPath)) {
    const reply = JSON.parse(readFileSync(replyPath, 'utf8'));
    process.stdout.write(JSON.stringify(reply) + '\\n');
    clearInterval(timer);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    process.stdout.write('{"error":"timeout"}\\n');
    clearInterval(timer);
    process.exit(1);
  }
}, 25);
`,
    { mode: 0o755 },
  );

  let stdoutText = '';
  await withContainerHarnessSession(
    {
      store,
      task: store.get("SELECT * FROM tasks WHERE id='t1'"),
      redactor: new Redactor(),
      guard: async () => {},
      runAccess: makeRunAccess(),
      system: 'test',
      prompt: 'test',
      tools: [{ type: 'function', function: { name: 'echo_tool', description: 'echo', parameters: { type: 'object', properties: {} } } }],
      execute: async () => ({ ok: true }),
    },
    {
      cli: 'codex',
      model: 'gpt-5-codex',
      localWorkspaceRoot: root,
      pollWaitMs: 25,
      executableOverride: { executable: process.execPath, args: [oversizedCli], version: '0.166.0' },
    },
    new AbortController().signal,
    chunk => { stdoutText += chunk.toString('utf8'); },
    async session => session.waitExit(),
  );
  assert.deepEqual(JSON.parse(stdoutText.trim()), { error: 'tool_request_too_large' });

  // Part 2: M5 — A tool handler that rejects while its request file remains on disk is invoked ONCE and never re-dispatched!
  const failingCli = join(root, 'failing-cli.mjs');
  writeFileSync(
    failingCli,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const agentDir = join(process.cwd(), '..', 'agent');
mkdirSync(join(agentDir, 'tool-requests'), { recursive: true });
const id = 'b'.repeat(48);
writeFileSync(join(agentDir, 'tool-requests', id + '.tmp'), JSON.stringify({ id, name: 'boom_tool', token: process.env.BOT_RUN_TOKEN, arguments: {} }));
renameSync(join(agentDir, 'tool-requests', id + '.tmp'), join(agentDir, 'tool-requests', id + '.json'));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );

  let boomCalls = 0;
  await assert.rejects(
    withContainerHarnessSession(
      {
        store,
        task: store.get("SELECT * FROM tasks WHERE id='t1'"),
        redactor: new Redactor(),
        guard: async () => {},
        runAccess: makeRunAccess(),
        system: 'test',
        prompt: 'test',
        tools: [{ type: 'function', function: { name: 'boom_tool', description: 'boom', parameters: { type: 'object', properties: {} } } }],
        execute: async () => {
          boomCalls++;
          await delay(40);
          throw new TaskError('fatal_tool_explosion', 'failed', 'boom');
        },
      },
      {
        cli: 'codex',
        model: 'gpt-5-codex',
        localWorkspaceRoot: join(root, 'ws2'),
        pollWaitMs: 10,
        executableOverride: { executable: process.execPath, args: [failingCli], version: '0.166.0' },
      },
      new AbortController().signal,
      () => {},
      async session => session.waitExit(),
    ),
    { code: 'fatal_tool_explosion' },
  );
  assert.equal(boomCalls, 1, 'failing tool must execute at most once even while its request file stays on disk');
});

test('minor lifecycle fixes: createToolDispatch handles JSON null replies, Workspace.deliverCleanup bypasses cancelled guard, piHarness halts on abort, and prepareClaudeCode/prepareCodex pin executableOverride in volume mode', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-minor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 1. createToolDispatch resolves JSON `null` immediately without mistaking it for a missing reply file.
  const dispatchDir = join(root, 'mailbox');
  const dispatch = createToolDispatch(dispatchDir, { pollMs: 10, timeoutMs: 1000 });
  const responder = (async () => {
    const reqDir = join(dispatchDir, 'tool-requests');
    const id = await waitFor(() => {
      if (!existsSync(reqDir)) return null;
      const f = readdirSync(reqDir).find(n => n.endsWith('.json'));
      return f ? f.slice(0, -5) : null;
    });
    mkdirSync(join(dispatchDir, 'tool-replies'), { recursive: true });
    writeFileSync(join(dispatchDir, 'tool-replies', `${id}.json`), 'null');
  })();
  const t0 = Date.now();
  const nullResult = await dispatch('nullable_tool', { a: 1 });
  await responder;
  assert.equal(nullResult, null);
  assert.ok(Date.now() - t0 < 500);

  // 2. Workspace.deliverCleanup delivers interrupt/reap to manager even after task guard throws task_cancelled.
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('101','org/repo','org','a')");
  const wsId = hex48();
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t1','101','task.request','cancelled','test','{}',1,1,?)", wsId);

  const delivered = [];
  const fakeManager = {
    async call(_method, _path, input) {
      delivered.push(input.request);
      return { ok: true, result: { interrupted: true } };
    },
  };
  const workspace = new Workspace(
    store,
    fakeManager,
    store.get("SELECT * FROM tasks WHERE id='t1'"),
    new Redactor(),
    async () => { throw new TaskError('task_cancelled', 'cancelled'); },
    () => {},
  );
  await assert.rejects(workspace.deliver({ type: 'workspace_harness_interrupt', mode: 'kill' }), { code: 'task_cancelled' });
  assert.equal(delivered.length, 0);
  const cleanupRes = await workspace.deliverCleanup({ type: 'workspace_harness_interrupt', mode: 'kill' });
  assert.equal(cleanupRes.interrupted, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 'workspace_harness_interrupt');

  // 3. piHarness wires executionSignal abort directly to dispatcher.halt().
  const cancelAc = new AbortController();
  const piRunAccess = makeRunAccess();
  let polledCount = 0;
  const piWorkspace = new Workspace(
    store,
    {
      async call(_method, _path, input) {
        const type = input.request.type;
        if (type === 'workspace_agent_config') return { ok: true, result: { written: true } };
        if (type === 'workspace_agent_start') return { ok: true, result: { started: true } };
        if (type === 'workspace_agent_poll') {
          polledCount++;
          const toolId = 'f'.repeat(48);
          return {
            ok: true,
            result: {
              state: 'running',
              events: [],
              offset: 0,
              has_more: false,
              token_requests: [],
              model_requests: [],
              tool_requests: polledCount === 1 ? [{ id: toolId, name: 'slow_tool', arguments: {}, token: piRunAccess.token }] : [],
            },
          };
        }
        return { ok: true, result: { written: true } };
      },
    },
    store.get("SELECT * FROM tasks WHERE id='t1'"),
    new Redactor(),
    async () => {},
    () => {},
  );
  const piSession = roleHarness('pi').createSession(
    {
      store,
      task: store.get("SELECT * FROM tasks WHERE id='t1'"),
      redactor: new Redactor(),
      guard: async () => {},
      runAccess: piRunAccess,
      cancelSignal: cancelAc.signal,
      pi: { workspace: piWorkspace },
      system: 's',
      prompt: 'p',
      tools: [{ type: 'function', function: { name: 'slow_tool', description: 'slow', parameters: { type: 'object', properties: {} } } }],
      execute: async () => {
        cancelAc.abort(new TaskError('harness_cancelled', 'cancelled'));
        await delay(200);
        return { ok: true };
      },
    },
    { guard: async () => {}, model: { id: 'm1', model: 'test' }, request: async () => ({ value: {} }) },
  );
  await assert.rejects(piSession.run(), { code: 'harness_cancelled' });
  await piSession.close();

  // 4. prepareClaudeCode and prepareCodex pin executableOverride in volume mode so CLI upgrades after prepare do not switch mid-run.
  const toolsVol = join(root, 'agent-tools');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  mkdirSync(join(toolsVol, 'node', '22.15.0', 'bin'), { recursive: true });
  writeFileSync(join(toolsVol, 'node', '22.15.0', 'bin', 'node'), '#!/bin/sh\necho v22.15.0\n', { mode: 0o755 });
  chmodSync(join(toolsVol, 'node', '22.15.0', 'bin', 'node'), 0o755);
  writeFileSync(join(toolsVol, 'node', '22.15.0', 'manifest.json'), JSON.stringify({
    schema: 'bot.agent-tools-node/1',
    version: '22.15.0',
    arch,
    sha256: 'a'.repeat(64),
  }));
  const writeVolumeCli = (cli, ver) => {
    const binName = cli === 'claude_code' ? 'claude' : 'codex';
    const verDir = join(toolsVol, cli, ver);
    mkdirSync(join(verDir, 'bin'), { recursive: true });
    const binPath = join(verDir, 'bin', binName);
    writeFileSync(binPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    chmodSync(binPath, 0o755);
    writeFileSync(join(verDir, 'manifest.json'), JSON.stringify({
      schema: 'bot.agent-tools/1',
      cli,
      version: ver,
      arch,
      libc: 'glibc',
      installed_at: new Date().toISOString(),
      container_executable: `/opt/agent-tools/${cli}/${ver}/bin/${binName}`,
      node_version: cli === 'claude_code' ? '22.15.0' : null,
      container_node_executable: cli === 'claude_code' ? '/opt/agent-tools/node/22.15.0/bin/node' : null,
      artifacts: [{
        role: cli === 'claude_code' ? 'native_binary' : 'static_binary',
        source_url: 'https://example.test/bin',
        sha256: 'a'.repeat(64),
        bytes: 16,
      }],
    }));
  };
  writeVolumeCli('claude_code', '2.1.310');
  writeVolumeCli('codex', '0.166.0');

  const prevToolsDir = process.env.BOT_AGENT_TOOLS_DIR;
  const prevClaudeCfg = process.env.BOT_CLAUDE_CODE_CONFIG;
  const prevCodexCfg = process.env.BOT_CODEX_CONFIG;
  process.env.BOT_AGENT_TOOLS_DIR = toolsVol;
  delete process.env.BOT_CLAUDE_CODE_CONFIG;
  delete process.env.BOT_CODEX_CONFIG;
  t.after(() => {
    if (prevToolsDir === undefined) delete process.env.BOT_AGENT_TOOLS_DIR; else process.env.BOT_AGENT_TOOLS_DIR = prevToolsDir;
    if (prevClaudeCfg !== undefined) process.env.BOT_CLAUDE_CODE_CONFIG = prevClaudeCfg;
    if (prevCodexCfg !== undefined) process.env.BOT_CODEX_CONFIG = prevCodexCfg;
  });

  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m1','101','http://127.0.0.1:9/v1','claude-sonnet-4-5',?,'now')",
    store.secrets.seal({ value: 'k' }, 'model:m1'));
  store.run("INSERT INTO policies(repository_id,enabled,model_id) VALUES('101',1,'m1')");
  const baseSpec = {
    store,
    task: store.get("SELECT * FROM tasks WHERE id='t1'"),
    redactor: new Redactor(),
    guard: async () => {},
    system: 's',
    prompt: 'p',
    tools: [{ type: 'function', function: { name: 'finish', description: 'finish', parameters: { type: 'object', properties: {} } } }],
    finish: { name: 'finish', validate: v => v },
  };

  const prepClaude = await prepareClaudeCode(baseSpec);
  const prepCodex = await prepareCodex(baseSpec);
  // Install newer compatible versions AFTER prepare:
  writeVolumeCli('claude_code', '2.1.319');
  writeVolumeCli('codex', '0.167.0');

  assert.equal(prepClaude.version, '2.1.310');
  assert.equal(prepClaude.command, '/opt/agent-tools/claude_code/2.1.310/bin/claude');
  assert.equal(prepCodex.version, '0.166.0');
  assert.equal(prepCodex.command, '/opt/agent-tools/codex/0.166.0/bin/codex');
});
