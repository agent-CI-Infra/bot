import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { Redactor, TaskError } from '../dist/agent/common.js';
import { runRole, roleRuns } from '../dist/roles/run.js';
import { roleApi } from '../dist/roles/api.js';
import { resolveRole, roleConfiguration, saveConfiguration } from '../dist/roles/definition.js';
import { instanceUsage, revokeRunTokens } from '../dist/roles/role-run.js';
import { claudeCodeRuntime, ClaudeJsonStream } from '../dist/harness/claude-code-protocol.js';
import { claudeBinary } from '../dist/harness/claude-code.js';
import { contentHash } from '../dist/roles/protocol.js';

const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const model = 'claude-sonnet-4-5-20250929';

export async function claudeFixture(t, { mode = 'normal', native = false, respond, gatewayStatus = 200, wrongModel = false, extraEnv } = {}) {
  mkdirSync('.tmp/claude-tests', { recursive: true, mode: 0o700 });
  chmodSync('.tmp/claude-tests', 0o700);
  const root = mkdtempSync(resolve('.tmp/claude-tests/run-'));
  chmodSync(root, 0o700);
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionsDir, 0o700);

  const s = new Store(join(root, 'db'), randomBytes(32));
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/OpenToday','o','a')");
  s.run("INSERT INTO repositories VALUES('other','private/other','o','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt) VALUES('t','r','task.request','running','Claude protocol fixture','{}',1)");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('o','other','task.request','running','Secret other task','{}')");
  const records = new TaskRecords(s);
  records.contract('t', { goal: 'read a random fact ' + randomBytes(16).toString('hex'), scope: ['fixture'], criteria: ['Read via broker'], endpoint: 'report' });

  let modelCalls = 0;
  const server = createServer(async (req, res) => {
    try {
      const token = req.headers['x-api-key'];
      assert.equal(token, 'service-key-fixture-170');
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(gatewayStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: wrongModel ? 'unavailable' : model }] }));
        return;
      }
      modelCalls++;
      if (respond) { await respond(req, res, modelCalls, s); return; }
      res.writeHead(mode === 'rate_error' ? 429 : 503);
      res.end('{}');
    } catch {
      res.writeHead(401);
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const file = join(root, 'config.json');
  const credentialFile = join(root, 'service.key');
  writeFileSync(credentialFile, 'service-key-fixture-170', { mode: 0o600 });
  const config = {
    command: native ? claudeBinary() : resolve('test/fixtures/claude-code.mjs'),
    version: claudeCodeRuntime.version,
    stateDirectory: sessionsDir,
    model,
    timeoutMs: native ? 30_000 : 5000,
    ...(extraEnv ? { env: extraEnv } : {}),
    provider: { baseUrl: 'http://127.0.0.1:' + server.address().port, credentialFile },
  };
  writeFileSync(file, JSON.stringify(config));
  const old = process.env.BOT_CLAUDE_CODE_CONFIG;
  process.env.BOT_CLAUDE_CODE_CONFIG = file;

  t.after(async () => {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    s.close();
    if (old === undefined) delete process.env.BOT_CLAUDE_CODE_CONFIG;
    else process.env.BOT_CLAUDE_CODE_CONFIG = old;
    rmSync(root, { recursive: true, force: true });
  });

  const spec = {
    store: s,
    task: s.get("SELECT * FROM tasks WHERE id='t'"),
    redactor: new Redactor(),
    guard: async () => {},
    system: 'Execute only the assigned protocol probe.',
    prompt: JSON.stringify({ task_ref: 'task:t', fixture_mode: mode }),
    maxTurns: 8,
    tools: [tool('read_task_record'), tool('finish')],
    finish: {
      name: 'finish',
      validate: v => {
        if (!v?.summary) throw new TaskError('role_result_invalid', 'retry_wait');
        return v;
      },
    },
  };
  const cliHome = st => join(config.stateDirectory, 'tasks', st.stateWorkspaceId, 'cli-state', st.sessionKey, 'home');
  return {
    s,
    spec,
    root,
    config,
    file,
    cliHome,
    get modelCalls() { return modelCalls; },
    state(role = 'dev') {
      const row = s.get('SELECT harness_state FROM role_instances WHERE role=?', role);
      return row?.harness_state ? JSON.parse(row.harness_state) : {};
    },
  };
}

test('Claude Code protocol fixture: seven RoleRun operations, container stdio MCP + relay, exact resume and cumulative usage', async t => {
  const f = await claudeFixture(t);
  const prepared = await roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code');
  assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, 0, 'prepare never starts the agent');
  const handle = await roleRuns.start(prepared);
  assert.equal(await roleRuns.start(prepared), handle);
  const result = await roleRuns.collect(handle);
  const state = f.state();
  assert.equal(result.result.summary, 'read through gateway');
  const page = roleRuns.events(f.s, handle.run_id);
  assert.ok(page.ended);
  assert.ok(page.events.some(e => e.type === 'session_bound'));
  assert.equal(page.events.at(-1).data.candidate_ref.kind, 'artifact');

  const first = f.s.get('SELECT * FROM task_runs ORDER BY rowid DESC LIMIT 1');
  assert.equal(first.cli_version, claudeCodeRuntime.version);
  const legacyHash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
  const ctx = JSON.parse(first.run_context);
  assert.match(state.stateWorkspaceId, /^[a-f0-9]{48}$/);
  assert.equal(state.configurationHash, legacyHash({ ...prepared.wrapped.harnessPreparation.config, command: prepared.wrapped.harnessPreparation.command, protocol: claudeCodeRuntime.protocol }));
  assert.equal(state.inputHash, legacyHash({ source: ctx.source_ref, contract: ctx.contract_revision, candidate: ctx.candidate_ref, role: ctx.role_revision, policy: ctx.policy_revision, skills: ctx.skill_revisions, model: ctx.model_revision }));

  const recovered = await roleRuns.recover(f.spec, 'dev', undefined, first.id, null, 'claude_code');
  await roleRuns.collect(recovered.handle);
  assert.equal(f.state().sessionId, state.sessionId);
  assert.equal(f.state().recoveryMode, 'native_resume');
  assert.notEqual(recovered.handle.run_id, first.id);
  assert.ok(recovered.handle.lease_epoch > first.lease_epoch);
  assert.equal(f.s.get('SELECT protocol_recovery FROM task_runs WHERE id=?', recovered.handle.run_id).protocol_recovery, 'native_resume');

  const usage = instanceUsage(f.s, result.instance_id);
  assert.equal(usage.model_requests, 4);
  assert.equal(usage.output_tokens, 28);
  assert.equal(usage.unpriced_requests, 4);
  assert.equal(f.s.get('SELECT count(*) n FROM model_requests').n, 0);
  assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status, 'running');

  const trace = JSON.stringify(f.s.all('SELECT * FROM task_history'));
  assert.ok(!trace.includes('PRIVATE_FIXTURE_REASONING'));
  assert.ok(!trace.includes('PRIVATE_RAW_OBSERVATION'));
  assert.ok(!trace.includes('rrt_'));

  const launch = JSON.parse(readFileSync(join(f.cliHome(state), 'launch.json'), 'utf8'));
  assert.ok(launch.args.includes('--tools') && launch.args[launch.args.indexOf('--tools') + 1] === 'default');
  assert.ok(launch.args.includes('--disallowedTools'));
  const disallowed = launch.args[launch.args.indexOf('--disallowedTools') + 1].split(',');
  for (const name of ['EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'CronCreate', 'Monitor']) {
    assert.ok(disallowed.includes(name), name);
  }
  assert.ok(launch.args.includes('--dangerously-skip-permissions'));
  assert.ok(launch.args.includes('--strict-mcp-config'));
  assert.ok(!launch.args.includes('--bare'));
  assert.ok(launch.mcp_config.command);
  assert.ok(launch.mcp_config.args[0].endsWith('/mcp-bridge.mjs'));
  assert.ok(!launch.env_names.includes('NODE_OPTIONS'));
  assert.ok(!launch.env_names.includes('GH_TOKEN'));
  assert.ok(!launch.env_names.includes('GITHUB_TOKEN'));
});

test('Claude Code protocol fixture: reviewers and QA use fresh contexts; missing native session rebuilds honestly', async t => {
  const f = await claudeFixture(t);
  await runRole(f.spec, 'dev', undefined, 'claude_code');
  const dev = f.state();
  await runRole(f.spec, 'reviewer', undefined, 'claude_code');
  await runRole(f.spec, 'qa', undefined, 'claude_code');
  await runRole(f.spec, 'qa');
  const sessions = f.s.all('SELECT role,harness_state FROM role_instances').map(r => ({ role: r.role, state: JSON.parse(r.harness_state) }));
  assert.equal(new Set(sessions.map(r => r.state.sessionId)).size, 3);
  assert.equal(sessions.find(r => r.role === 'qa').state.recoveryMode, 'fresh_evaluation');
  rmSync(join(f.cliHome(dev), '.claude', 'projects'), { recursive: true, force: true });
  await runRole(f.spec, 'dev');
  assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records');
  assert.notEqual(f.state().sessionId, dev.sessionId);
});

test('Claude Code protocol fixture: cross-task session binding is refused before resuming; changed contract rebuilds', async t => {
  const f = await claudeFixture(t);
  await runRole(f.spec, 'dev', undefined, 'claude_code');
  const state = f.state();
  f.s.run("UPDATE role_instances SET harness_state=? WHERE role='dev'", JSON.stringify({ ...state, scope: { ...state.scope, task_id: 'o' } }));
  await assert.rejects(runRole(f.spec, 'dev'), { code: 'claude_session_scope_mismatch' });
  f.s.run("UPDATE role_instances SET harness_state=? WHERE role='dev'", JSON.stringify(state));
  f.s.run("UPDATE task_records SET revision=revision+1 WHERE task_id='t'");
  await runRole(f.spec, 'dev');
  assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records');
  const prior = f.state().sessionId;
  f.s.run("UPDATE tasks SET head_sha=? WHERE id='t'", 'a'.repeat(40));
  f.spec.task.head_sha = 'a'.repeat(40);
  await runRole(f.spec, 'dev');
  assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records');
  assert.notEqual(f.state().sessionId, prior);
  const legacy = f.state();
  delete legacy.scope;
  legacy.version = 'other-backend';
  f.s.run("UPDATE role_instances SET harness_state=? WHERE role='dev'", JSON.stringify(legacy));
  await runRole(f.spec, 'dev');
  assert.equal(f.state().recoveryMode, 'rebuilt_from_task_records');
  assert.notEqual(f.state().sessionId, legacy.sessionId);
});

for (const [mode, code] of Object.entries({
  malformed: 'claude_protocol_incompatible',
  invalid_utf8: 'claude_protocol_incompatible',
  truncated: 'claude_stream_truncated',
  exit: 'claude_process_exit',
  no_result: 'claude_result_missing',
  no_submit: 'claude_submission_required',
  bad_report: 'claude_submission_required',
  extra_tool: 'claude_capability_mismatch',
  budget: 'claude_budget_exhausted',
  after_result: 'claude_protocol_incompatible',
  auth_error: 'claude_authentication_failed',
  model_error: 'claude_model_unavailable',
  rate_error: 'claude_rate_limited',
  transport_error: 'claude_transport_error',
})) {
  test('Claude Code protocol fixture refuses ' + mode, async t => {
    const f = await claudeFixture(t, { mode });
    await assert.rejects(runRole(f.spec, 'dev', undefined, 'claude_code'), { code });
    assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0);
    assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status, 'running');
  });
}

for (const [options, code] of [
  [{ gatewayStatus: 401 }, 'claude_authentication_failed'],
  [{ gatewayStatus: 429 }, 'claude_rate_limited'],
  [{ wrongModel: true }, 'claude_model_unavailable'],
]) {
  test('Claude Code pre-start gateway validation: ' + code, async t => {
    const f = await claudeFixture(t, options);
    await assert.rejects(runRole(f.spec, 'dev', undefined, 'claude_code'), { code });
    assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='harness_event' AND json_extract(data,'$.type')='session_bound'").n, 0);
  });
}

test('Claude Code protocol fixture: bounded text, fragmented UTF-8, denied prompts and foreign task refs', async t => {
  for (const mode of ['fragmented', 'long_text', 'permission', 'wrong_ref']) {
    await t.test(mode, async t => {
      const f = await claudeFixture(t, { mode });
      await runRole(f.spec, 'dev', undefined, 'claude_code');
      const trace = JSON.stringify(f.s.all('SELECT data FROM task_history'));
      assert.ok(!trace.includes('Secret other task'));
      if (mode === 'fragmented') assert.ok(trace.includes('核对通过'));
      if (mode === 'long_text') assert.ok(trace.includes('output_truncated'));
      if (mode === 'permission') assert.ok(f.s.all("SELECT data FROM task_history WHERE type='harness_event'").map(r => JSON.parse(r.data)).some(e => e.type === 'permission' && e.decision === 'deny'));
      if (mode === 'wrong_ref') assert.ok(trace.includes('task_record_not_found'));
    });
  }
});

test('Claude Code protocol fixture: native container tools, loopback relay, gh wrapper token exchange and quiet per-command logging', async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const ghServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/app') {
      res.writeHead(200);
      res.end(JSON.stringify({ slug: 'fixture-bot' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/repos/fixture/OpenToday/installation') {
      res.writeHead(200);
      res.end(JSON.stringify({
        id: 1,
        account: { id: 'o', login: 'fixture' },
        events: ['issues', 'pull_request'],
        permissions: { contents: 'read', metadata: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' },
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/app/installations/1/access_tokens') {
      res.writeHead(201);
      res.end(JSON.stringify({
        token: 'ghs_short_lived_claude_ro_token_705',
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        permissions: { contents: 'read', metadata: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' },
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/users/fixture-bot%5Bbot%5D') {
      res.writeHead(200);
      res.end(JSON.stringify({ id: 99, login: 'fixture-bot[bot]' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/repositories/r') {
      res.writeHead(200);
      res.end(JSON.stringify({ id: 'r', full_name: 'fixture/OpenToday', default_branch: 'main', owner: { id: 'o' } }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/installation/token') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  ghServer.listen(0, '127.0.0.1');
  await once(ghServer, 'listening');
  t.after(() => ghServer.close());

  const f = await claudeFixture(t, {
    mode: 'native_workspace',
    extraEnv: { FIXTURE_TEST_GH: 'true' },
    respond: async (req, res) => {
      for await (const _ of req) {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_relay_705',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'relay ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 8 },
      }));
    },
  });

  // Configure GitHub App credentials + fake gh binary to verify short-lived read-only token injection and masking end-to-end.
  f.s.run("UPDATE accounts SET credentials=? WHERE id='a'", f.s.secrets.seal({ private_key: pem }, 'account:a'));
  const fakeGh = join(f.root, 'fake-gh');
  writeFileSync(fakeGh, `#!${process.execPath}\nconsole.log('gh-ok:' + Boolean(process.env.GH_TOKEN) + ':' + process.env.GH_TOKEN);\n`, { mode: 0o755 });
  chmodSync(fakeGh, 0o755);
  const prevRealGh = process.env.BOT_REAL_GH_BIN;
  process.env.BOT_REAL_GH_BIN = fakeGh;
  t.after(() => {
    if (prevRealGh === undefined) delete process.env.BOT_REAL_GH_BIN;
    else process.env.BOT_REAL_GH_BIN = prevRealGh;
  });

  f.spec.containerOptions = { githubApiUrl: `http://127.0.0.1:${ghServer.address().port}` };
  const out = await runRole(f.spec, 'dev', undefined, 'claude_code');
  assert.equal(out.result.summary, 'native container tools verified');
  assert.equal(out.result.fileContent, 'written natively by claude_code');
  assert.equal(out.result.ghOut, 'gh-ok:true:[REDACTED]');

  // Native Bash execution is NOT logged one-by-one as tool_started/tool_observation; only MCP tools and gateway model_requests are recorded.
  const toolEvents = f.s.all("SELECT data FROM task_history WHERE type='harness_event' AND json_extract(data,'$.type')='tool'").map(r => JSON.parse(r.data));
  assert.ok(toolEvents.every(e => e.name.startsWith('mcp__bot__')));
  assert.equal(f.s.get('SELECT count(*) n FROM model_requests').n, 1);
  const allTrace = JSON.stringify(f.s.all('SELECT data FROM task_history'));
  assert.equal(allTrace.includes('ghs_short_lived_claude_ro_token_705'), false);
});

test('Claude Code protocol fixture: checkpoint, cancellation reaps descendants and rejects late submission', async t => {
  const f = await claudeFixture(t, { mode: 'wait' });
  const p = await roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code');
  const h = await roleRuns.start(p);
  let cancelled = false;
  try {
    let state;
    const deadline = Date.now() + f.config.timeoutMs;
    while (Date.now() < deadline) {
      state = f.state();
      if (state.stateWorkspaceId && existsSync(join(f.cliHome(state), 'child.pid'))) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(state?.stateWorkspaceId && existsSync(join(f.cliHome(state), 'child.pid')), 'fixture child must be ready before checkpoint and cancellation');
    const checkpoint = await roleRuns.checkpoint(h);
    assert.equal(checkpoint.session.external_session.session_id, state.sessionId);
    assert.ok(checkpoint.session.external_session.sha256);
    const pid = Number(readFileSync(join(f.cliHome(state), 'child.pid'), 'utf8'));
    const receipt = await roleRuns.cancel(h, 'test');
    cancelled = true;
    assert.ok(receipt.settled);
    await assert.rejects(roleRuns.collect(h), { code: 'harness_cancelled' });
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 20));
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0);
  } finally {
    if (!cancelled) await roleRuns.cancel(h, 'test_cleanup');
  }
});

test('Claude Code protocol fixture: revoke a live lease and the driver stops without collecting', async t => {
  const f = await claudeFixture(t, { mode: 'late' });
  const p = await roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code');
  const h = await roleRuns.start(p);
  revokeRunTokens(f.s, h.run_id, 'test');
  await assert.rejects(roleRuns.collect(h), e => ['run_token_revoked', 'claude_authentication_failed'].includes(e.code));
});

test('Claude Code rejects invalid/personal config, accepts isolated-workspace profile, and reserves subscription mode explicitly', async t => {
  const f = await claudeFixture(t);
  for (const change of [{ version: 'latest' }, { model: 'sonnet' }, { env: { ANTHROPIC_API_KEY: 'personal' } }, { gatewayUrl: 'https://api.anthropic.com' }]) {
    writeFileSync(f.file, JSON.stringify({ ...f.config, ...change }));
    await assert.rejects(roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code'), e => ['claude_configuration_invalid', 'claude_restricted_gateway_required'].includes(e.code));
  }
  writeFileSync(f.file, JSON.stringify(f.config));

  const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
  const url = new URL('http://local/api/repositories/r/roles');
  const savedIsolated = roleApi(f.s, admin, 'PUT', url, {
    expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision,
    enabled: true,
    roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, environment_profile_ref: { id: 'isolated-workspace' } }],
  });
  assert.equal(savedIsolated.configuration.roles.find(r => r.role_id === 'dev').environment_profile_ref.id, 'isolated-workspace');

  // Subscription mode is reserved (#705): saving model_source: 'subscription' succeeds and fails closed at prepare/run with subscription_mode_not_implemented.
  const savedSub = roleApi(f.s, admin, 'PUT', url, {
    expected_revision: savedIsolated.configuration.revision,
    enabled: true,
    roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code', model_source: 'subscription' } }],
  });
  assert.equal(savedSub.configuration.roles.find(r => r.role_id === 'dev').harness_ref.model_source, 'subscription');
  const viewSub = roleApi(f.s, admin, 'GET', url, {});
  assert.equal(viewSub.preview.find(p => p.role === 'dev').error, 'subscription_mode_not_implemented');
  await assert.rejects(roleRuns.prepare(f.spec, 'dev'), { code: 'subscription_mode_not_implemented' });
});

test('wire parser rejects oversized and unterminated records without retaining private fields', () => {
  assert.throws(() => new ClaudeJsonStream(() => {}, 8).push(Buffer.from('xxxxxxxxx')), { code: 'claude_output_limit' });
  const stream = new ClaudeJsonStream(() => {});
  stream.push(Buffer.from('{"type":'));
  assert.throws(() => stream.end(), { code: 'claude_stream_truncated' });
});

test('Claude Code rejects model/config drift during recovery and accounts metered limits across runs', async t => {
  await t.test('model drift', async t => {
    const f = await claudeFixture(t);
    await runRole(f.spec, 'dev', undefined, 'claude_code');
    writeFileSync(f.file, JSON.stringify({ ...f.config, model: 'claude-opus-4-1-20250805' }));
    await assert.rejects(runRole(f.spec, 'dev'), { code: 'model_revision_changed' });
  });
  await t.test('cumulative requests', async t => {
    const f = await claudeFixture(t);
    const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
    const url = new URL('http://local/api/repositories/r/roles');
    roleApi(f.s, admin, 'PUT', url, {
      expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision,
      enabled: true,
      roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_model_requests: 3 } }],
    });
    await runRole(f.spec, 'dev');
    await assert.rejects(runRole(f.spec, 'dev'), { code: 'role_budget_exhausted' });
    assert.equal(instanceUsage(f.s, f.s.get("SELECT id FROM role_instances WHERE role='dev'").id).model_requests, 3);
    const count = f.s.get('SELECT count(*) n FROM task_runs').n;
    await assert.rejects(runRole(f.spec, 'dev'), { code: 'role_budget_exhausted' });
    assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, count);
  });
  await t.test('unknown monetary ledger', async t => {
    const f = await claudeFixture(t);
    const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
    const url = new URL('http://local/api/repositories/r/roles');
    roleApi(f.s, admin, 'PUT', url, {
      expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision,
      enabled: true,
      roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_cost: { amount: 1, currency: 'USD' } } }],
    });
    await runRole(f.spec, 'dev');
    assert.equal(f.s.get("SELECT status FROM task_runs WHERE role='dev' ORDER BY rowid DESC LIMIT 1").status, 'succeeded');
    const saved = roleApi(f.s, admin, 'GET', url, {});
    assert.equal(Object.hasOwn(saved.configuration.roles.find(r => r.role_id === 'dev').budget_policy_ref, 'max_cost'), false);
  });
  await t.test('missing CLI result usage remains unknown but does not permanently block retry', async t => {
    const f = await claudeFixture(t, { mode: 'unknown_usage' });
    const first = await runRole(f.spec, 'dev', undefined, 'claude_code');
    assert.equal(instanceUsage(f.s, first.instance_id).unknown_requests, 2);
    assert.equal(instanceUsage(f.s, first.instance_id).semantics, 'lower_bound');
    const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
    const url = new URL('http://local/api/repositories/r/roles');
    roleApi(f.s, admin, 'PUT', url, {
      expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision,
      enabled: true,
      roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_total_tokens: 1000 } }],
    });
    f.spec.prompt = JSON.stringify({ task_ref: 'task:t', fixture_mode: 'normal' });
    await runRole(f.spec, 'dev');
    assert.equal(instanceUsage(f.s, first.instance_id).unknown_requests, 2);
  });
});

// Synthetic Anthropic SSE; the native CLI, not this helper, produces the harness NDJSON events.
function providerReply(res, { id, content, args = {}, input = 5, output = 777, textBlock = false }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': id });
  const event = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
  event('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } });
  let index = 0;
  if (textBlock) {
    event('content_block_start', { index, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index, delta: { type: 'text_delta', text: 'Public preparation.' } });
    event('content_block_stop', { index });
    index++;
  }
  event('content_block_start', { index, content_block: content });
  if (content.type === 'tool_use') event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
  event('content_block_stop', { index });
  event('message_delta', { delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: output } });
  event('message_stop', {});
  res.end();
}

// Real pinned native executable + synthetic Anthropic wire server over the container stdio MCP bridge and loopback model relay.
test('pinned native Claude Code binary uses stream-json, native workspace tools, stdio MCP bridge and loopback model relay (synthetic provider)', async t => {
  let nativeToolCalls = 0, nativeRequests = 0;
  let activeRepo = '';
  const f = await claudeFixture(t, {
    native: true,
    respond: async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
      assert.equal(body.model, model);
      const sysText = Array.isArray(body.system) ? body.system.map(c => c.text ?? '').join('\n') : String(body.system ?? '');
      const observing = sysText.includes('INDEPENDENT_REVIEW_PROBE');
      if (observing) assert.ok(!raw.includes('DEV_PRIVATE_MARKER_170'));
      assert.ok(!raw.includes('MALICIOUS_AUTOLOADED_CONTEXT'));

      // Native container tools (Bash, Read, Write) ARE enabled; platform low-level write_file/run_command MCP tools and EnterWorktree/WebFetch are NOT offered.
      const names = body.tools.map(t => t.name);
      assert.ok(names.includes('mcp__bot__read_task_record'));
      assert.ok(names.includes('mcp__bot__finish'));
      assert.ok(names.includes('Bash'));
      assert.ok(names.includes('Read'));
      assert.ok(names.includes('Write'));
      assert.ok(!names.includes('mcp__bot__write_file'));
      assert.ok(!names.includes('mcp__bot__run_command'));
      assert.ok(!names.includes('EnterWorktree'));
      assert.ok(!names.includes('WebFetch'));

      const start = body.messages.findLastIndex(m => m.role === 'user' && (typeof m.content === 'string' ? m.content.includes('fixture_mode') : m.content?.some(c => c.type === 'text' && c.text.includes('fixture_mode'))));
      const current = body.messages.slice(Math.max(0, start));
      const called = name => current.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use' && c.name === name));
      const alreadyRead = called('mcp__bot__read_task_record');
      const submitted = called('mcp__bot__finish');
      const name = !alreadyRead
        ? 'mcp__bot__read_task_record'
        : !observing && !called('Read')
          ? 'Read'
          : !observing && !called('Write')
            ? 'Write'
            : !called('Bash')
              ? 'Bash'
              : 'mcp__bot__finish';
      const args = {
        mcp__bot__read_task_record: { ref: 'task:t' },
        Read: { file_path: join(activeRepo, 'add.mjs') },
        Write: { file_path: join(activeRepo, 'add.mjs'), content: 'export const add = (a, b) => a + b;\n' },
        Bash: { command: 'env -u NODE_TEST_CONTEXT node --test add.test.mjs' },
        mcp__bot__finish: observing
          ? { summary: 'Preseeded defect detected', findings: [{ description: 'add returns one too many', evidence: ['node --test add.test.mjs exited 1'] }], inspected_scope: ['add.mjs'], unknowns: [] }
          : { summary: 'Real CLI edited repo natively and reported via stdio MCP' },
      }[name];
      const content = submitted ? { type: 'text', text: 'Submitted.' } : { type: 'tool_use', id: 'toolu_native_' + (++nativeToolCalls), name, input: {} };
      providerReply(res, { id: 'msg_native_' + (++nativeRequests), content, args, textBlock: !submitted });
    },
  });

  const devWsId = '1'.repeat(48);
  const devRepo = join(f.config.stateDirectory, 'tasks', devWsId, 'repo');
  mkdirSync(devRepo, { recursive: true });
  writeFileSync(join(devRepo, 'add.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(devRepo, 'add.test.mjs'), 'import {add} from "./add.mjs"; import assert from "node:assert/strict"; assert.equal(add(2,3),5);\n');
  const commandOptions = { cwd: devRepo, encoding: 'utf8', timeout: 5000, env: { LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] };
  assert.throws(() => execFileSync(process.execPath, ['--test', 'add.test.mjs'], commandOptions), e => e.status === 1);

  activeRepo = devRepo;
  f.s.run("UPDATE tasks SET workspace_id=? WHERE id='t'", devWsId);
  f.spec.task.workspace_id = devWsId;
  // Low-level write_file/run_command passed in spec.tools are automatically filtered out in favor of native CLI tools (#705).
  f.spec.tools.push(tool('write_file'), tool('run_command'));
  saveConfiguration(f.s, 'r', { expected_revision: 0, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, persona_prompt: 'DEV_PRIVATE_MARKER_170' }] }, 'fixture');

  const output = await runRole(f.spec, 'dev', undefined, 'claude_code');
  assert.equal(output.result.summary, 'Real CLI edited repo natively and reported via stdio MCP');
  assert.equal(readFileSync(join(devRepo, 'add.mjs'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  assert.match(execFileSync(process.execPath, ['--test', 'add.test.mjs'], commandOptions), /pass 1/);
  assert.ok(f.modelCalls >= 2);

  let measured = instanceUsage(f.s, output.instance_id);
  assert.equal(measured.model_requests, nativeRequests);
  assert.equal(measured.output_tokens, nativeRequests * 777);
  assert.equal(measured.unknown_requests, 0);
  const reconciled = f.s.all("SELECT data FROM task_history WHERE type='harness_event' AND json_extract(data,'$.stage')='usage_reconciliation'").map(r => JSON.parse(r.data));
  assert.ok(reconciled.some(r => r.cli_result_usage.output_tokens === measured.output_tokens && r.matches));
  assert.equal(f.state().version, '2.1.319');
  assert.equal(f.s.get('SELECT count(*) n FROM model_requests').n, nativeRequests);

  // Poisoned project files in <task_dir>/repo must NOT execute hooks or load rogue MCP servers on resume.
  const state = f.state(), poison = join(f.root, 'hook-ran');
  mkdirSync(join(state.cwd, '.claude'), { recursive: true });
  writeFileSync(join(state.cwd, 'CLAUDE.md'), 'MALICIOUS_AUTOLOADED_CONTEXT');
  writeFileSync(join(state.cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch ' + poison }] }] } }));
  writeFileSync(join(state.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { poison: { command: 'touch', args: [poison] } } }));
  await runRole(f.spec, 'dev');
  assert.equal(f.state().recoveryMode, 'native_resume');
  assert.ok(!existsSync(poison));
  measured = instanceUsage(f.s, output.instance_id);
  assert.equal(measured.model_requests, nativeRequests);
  assert.equal(measured.output_tokens, nativeRequests * 777);
  assert.equal(measured.unknown_requests, 0);

  // Independent reviewer role runs in its own isolated repo checkout with fresh context.
  const revWsId = '2'.repeat(48);
  const revRepo = join(f.config.stateDirectory, 'tasks', revWsId, 'repo');
  mkdirSync(revRepo, { recursive: true });
  writeFileSync(join(revRepo, 'add.mjs'), 'export const add = (a, b) => a + b + 1;\n');
  writeFileSync(join(revRepo, 'add.test.mjs'), readFileSync(join(devRepo, 'add.test.mjs')));
  activeRepo = revRepo;
  f.s.run("UPDATE tasks SET workspace_id=? WHERE id='t'", revWsId);
  f.spec.task.workspace_id = revWsId;

  const fixedHash = contentHash(readFileSync(join(revRepo, 'add.mjs'), 'utf8'));
  const candidate = new TaskRecords(f.s).submit('t', [{ kind: 'file', reference: 'artifact:seeded-arithmetic', version: fixedHash, content: { path: 'add.mjs', content_hash: fixedHash } }], [], { fixture: true });
  saveConfiguration(f.s, 'r', { expected_revision: 1, enabled: true, roles: [{ role_id: 'reviewer', harness_ref: { id: 'claude_code' }, persona_prompt: 'INDEPENDENT_REVIEW_PROBE' }] }, 'fixture');
  const review = await runRole(
    {
      ...f.spec,
      finish: {
        name: 'finish',
        validate: value => {
          assert.ok(value.findings.length);
          return { ...value, candidate_hash: fixedHash };
        },
      },
    },
    'reviewer',
    undefined,
    'claude_code',
  );
  assert.ok(review.result.findings.length);
  assert.notEqual(f.state('reviewer').sessionId, state.sessionId);
  const reviewRun = f.s.get("SELECT id FROM task_runs WHERE role='reviewer' ORDER BY rowid DESC LIMIT 1");
  assert.equal(roleRuns.events(f.s, reviewRun.id).events.at(-1).data.input_candidate_ref.ref, 'candidate:' + candidate.id);
  assert.ok(!JSON.stringify(f.s.all('SELECT data FROM task_history')).includes('service-key-fixture-170'));
});

test('Claude collect uses the trusted workspace snapshot and fails closed if the snapshot is unavailable', async t => {
  await t.test('framework snapshot', async t => {
    const f = await claudeFixture(t), snapshot = { tree_sha: 'a'.repeat(40), local_sha: 'b'.repeat(40) };
    const p = await roleRuns.prepare({ ...f.spec, candidateSnapshot: async () => snapshot }, 'dev', undefined, 'claude_code');
    const result = await roleRuns.collect(await roleRuns.start(p));
    assert.equal(result.candidate_ref.kind, 'code');
    assert.equal(result.candidate_ref.tree_hash, snapshot.tree_sha);
    assert.equal(result.candidate_ref.commit_sha, snapshot.local_sha);
  });
  await t.test('snapshot failure', async t => {
    const f = await claudeFixture(t);
    const p = await roleRuns.prepare({ ...f.spec, candidateSnapshot: async () => null }, 'dev', undefined, 'claude_code');
    await assert.rejects(roleRuns.collect(await roleRuns.start(p)), { code: 'role_snapshot_unavailable' });
    assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n, 0);
    assert.equal(f.s.get('SELECT count(*) n FROM role_run_tokens WHERE revoked_at IS NULL').n, 0);
  });
});

test('pinned native CLI + synthetic provider: max-turns result exits 1 and is a non-retryable budget stop', async t => {
  const f = await claudeFixture(t, {
    native: true,
    respond: async (req, res, n) => {
      for await (const _ of req) {}
      providerReply(res, { id: 'msg_budget_' + n, content: { type: 'tool_use', id: 'toolu_budget_' + n, name: 'mcp__bot__read_task_record', input: {} }, args: { ref: 'task:t' } });
    },
  });
  await assert.rejects(runRole({ ...f.spec, maxTurns: 1 }, 'dev', undefined, 'claude_code'), e => e.code === 'claude_budget_exhausted' && e.state === 'needs_replan');
  const events = f.s.all("SELECT data FROM task_history WHERE type='harness_event'").map(r => JSON.parse(r.data));
  assert.ok(events.some(e => e.stage === 'process_exit' && e.result_subtype === 'error_max_turns' && e.exit_code === 1));
  const run = f.s.get('SELECT * FROM task_runs ORDER BY rowid DESC LIMIT 1');
  assert.equal(run.stop_reason, 'claude_budget_exhausted');
  const { explainFailure } = await import('../dist/agent/failures.js');
  assert.equal(explainFailure('claude_budget_exhausted', 'needs_replan').automatic, false);
  const measured = instanceUsage(f.s, run.role_instance_id);
  assert.equal(measured.output_tokens, 777);
  assert.equal(measured.model_requests, 1);
  assert.equal(measured.unknown_requests, 0);
});

test('Claude protocol fixture + synthetic provider: a metered 429 rejection can retry the same role instance', async t => {
  const f = await claudeFixture(t, {
    mode: 'rate_error',
    respond: async (req, res) => {
      for await (const _ of req) {}
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Synthetic rate limit' } }));
    },
  });
  const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
  const url = new URL('http://local/api/repositories/r/roles');
  roleApi(f.s, admin, 'PUT', url, {
    expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision,
    enabled: true,
    roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' }, budget_policy_ref: { id: 'metered', max_total_tokens: 100000 } }],
  });
  await assert.rejects(runRole(f.spec, 'dev'), e => e.code === 'claude_rate_limited' && e.state === 'retry_wait');
  const id = f.s.get("SELECT id FROM role_instances WHERE role='dev'").id;
  assert.equal(f.modelCalls, 1);
  assert.equal(instanceUsage(f.s, id).unknown_requests, 0);
  assert.equal(instanceUsage(f.s, id).model_requests, 1);
  f.spec.prompt = JSON.stringify({ task_ref: 'task:t', fixture_mode: 'normal' });
  const next = await runRole(f.spec, 'dev');
  assert.equal(next.instance_id, id);
  assert.equal(next.result.summary, 'read through gateway');
  assert.equal(instanceUsage(f.s, id).unknown_requests, 0);
});

test('Claude configuration refuses external gateway profiles and controller roles before CLI startup', async t => {
  const f = await claudeFixture(t);
  const { provider, ...external } = f.config;
  writeFileSync(f.file, JSON.stringify({ ...external, gatewayUrl: provider.baseUrl }));
  await assert.rejects(roleRuns.prepare(f.spec, 'dev', undefined, 'claude_code'), { code: 'claude_configuration_invalid' });
  writeFileSync(f.file, JSON.stringify(f.config));
  const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
  const url = new URL('http://local/api/repositories/r/roles');
  for (const role of ['coordinator', 'manager']) {
    assert.throws(
      () => roleApi(f.s, admin, 'PUT', url, { expected_revision: roleApi(f.s, admin, 'GET', url, {}).revision, enabled: true, roles: [{ role_id: role, harness_ref: { id: 'claude_code' } }] }),
      { code: 'harness_role_unsupported' },
    );
    await assert.rejects(runRole(f.spec, role, undefined, 'claude_code'), { code: 'harness_role_unsupported' });
  }
  const { runClaudeCode } = await import('../dist/harness/claude-code.js');
  await assert.rejects(
    runClaudeCode(
      { ...f.spec, harnessPreparation: { config: f.config, mode: 'config_file', command: f.config.command, version: f.config.version, model: f.config.model, configurationHash: 'h' }, runContext: () => ({ execution_context: { kind: 'controller' } }), runAccess: { token: 'unusable-capability', check() {} } },
      new AbortController().signal,
      () => {},
    ),
    { code: 'harness_role_unsupported' },
  );
  assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, 0);
});

test('Claude admission refuses legacy and stored V2 controllers, including explicit and pinned backend overrides', async t => {
  const f = await claudeFixture(t);
  const legacy = { enabled: true, harnesses: { coordinator: 'claude_code', manager: 'claude_code', dev: 'claude_code' } };
  const v2 = { ...roleConfiguration(f.s, 'r', legacy), revision: 1 };
  delete v2.legacy;
  for (const config of [legacy, v2]) {
    f.s.run("INSERT OR REPLACE INTO settings VALUES('roles:r',?)", JSON.stringify(config));
    for (const role of ['coordinator', 'manager']) {
      for (const options of [{}, { harness: 'claude_code' }, { harness: 'claude_code', pinned: true }]) {
        assert.throws(() => resolveRole(f.s, 'r', role, 'task.request', { ...options, persist: false }), { code: 'harness_role_unsupported' });
      }
      await assert.rejects(runRole(f.spec, role), { code: 'harness_role_unsupported' });
      await assert.rejects(runRole(f.spec, role, undefined, 'claude_code'), { code: 'harness_role_unsupported' });
    }
  }
  assert.equal(f.s.get('SELECT count(*) n FROM task_runs').n, 0, 'no controller run is started');
});

test('Claude protocol fixture: an explicitly saved dev backend is retained by configurable entry executors', async t => {
  const f = await claudeFixture(t);
  const admin = { id: 'admin', role: 'project_admin', repositories: ['r'] };
  const url = new URL('http://local/api/repositories/r/roles');
  const saved = roleApi(f.s, admin, 'PUT', url, { expected_revision: 0, enabled: true, roles: [{ role_id: 'dev', harness_ref: { id: 'claude_code' } }] }).configuration;
  assert.equal(saved.roles.find(r => r.role_id === 'dev').entry_harness_source, 'role');
  const resolved = resolveRole(f.s, 'r', 'dev', 'task.request', { entryExecutor: true, persist: false });
  assert.deepEqual([resolved.snapshot.kind, resolved.snapshot.harness.id, resolved.snapshot.model.source], ['writer', 'claude_code', 'external_harness']);
  const result = await runRole(f.spec, 'dev', undefined, undefined, { entryExecutor: true });
  assert.equal(result.result.summary, 'read through gateway');
  assert.equal(f.s.get("SELECT harness FROM task_runs WHERE role='dev' ORDER BY rowid DESC LIMIT 1").harness, 'claude_code');
});

test('Claude smoke probe requires an explicit public launch profile', () => {
  mkdirSync('.tmp/claude-smoke-env', { recursive: true });
  const root = resolve('.tmp/claude-smoke-env');
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/claude-code-smoke.mjs', join(root, 'must-not-create')], { env: { LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] }),
    e => e.status === 1 && String(e.stderr).includes('BOT_CLAUDE_CODE_CONFIG'),
  );
  assert.equal(existsSync(join(root, 'must-not-create')), false);
});
