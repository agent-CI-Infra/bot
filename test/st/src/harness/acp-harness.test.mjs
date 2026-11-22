import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { Redactor, TaskError } from '../../../../dist/agent/common.js';
import { openModel } from '../../../../dist/agent/model.js';
import { withContainerHarnessSession } from '../../../../dist/harness/container-session.js';
import { agentBackends } from '../../../../dist/roles/backends.js';
import { resolveRole } from '../../../../dist/roles/definition.js';
import { roleKind } from '../../../../dist/roles/catalog.js';
import { roleHarness } from '../../../../dist/roles/harness.js';
import { SubmissionError } from '../../../../dist/roles/submission-error.js';
import { serviceRolesApi } from '../../../../dist/service-roles/api.js';
import { Store } from '../../../../dist/storage/database.js';
import { readAcpProduct } from '../../../../runner/acp-products.mjs';

const id = 'container_acp';
const uvAvailable = spawnSync('uv', ['--version']).status === 0;
const exec = promisify(execFile);
const runner = resolve('runner/runner.mjs');
const hash = content => createHash('sha256').update(content).digest('hex');
const newId = () => randomBytes(24).toString('hex');
const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } });

function fixtureInstaller(root) {
  const [python, version] = execFileSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 11); print(sys.executable); print(sys.version.split()[0])'], { encoding: 'utf8' }).trim().split('\n');
  const sourcePath = 'test/fixtures/acp-product';
  const source = resolve(sourcePath);
  const sourceSha256 = hash(readdirSync(source).sort().map(name => JSON.stringify([name, hash(readFileSync(join(source, name)))]) + '\n').join(''));
  const launch = {
    args: ['{product}/fixture.py', 'agent'], mcp: 'http', access: 'native', untrustedCheckout: false,
    env: { FIXTURE_RUN: '{run}', FIXTURE_MODEL_URL: '{relay}', FIXTURE_MODEL_TOKEN: '{token}', FIXTURE_MODEL: '{model}' },
    answers: { '_fixture/input': { answer: 'unattended' } },
    sidecars: [{ name: 'fixture', args: ['{product}/fixture.py', 'sidecar', '{port:fixture}'], healthPath: '/ready' }],
  };
  const tools = join(root, 'tools');
  mkdirSync(tools);
  const env = { ...process.env };
  if (!uvAvailable) {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'uv'), readFileSync(resolve('test/fixtures/acp-uv.mjs')), { mode: 0o755 });
    env.PATH = [bin, dirname(process.execPath), env.PATH].filter(Boolean).join(':');
  }
  const call = (action, productVersion, args = []) => spawnSync(process.execPath, [resolve('scripts/install-acp-product.mjs'),
    action, '--root', tools, '--product', id, '--version', productVersion, ...args], { env, encoding: 'utf8' });
  const install = (productVersion, overrides = {}) => {
    const preset = join(root, 'preset.json');
    writeFileSync(preset, JSON.stringify({ python: version, lock: 'uv.lock', source: sourcePath, sourceSha256, launch, ...overrides }));
    return call('install', productVersion, ['--source', source, '--preset', preset, '--offline', '--python-executable', python]);
  };
  return { tools, install, call, sourceSha256, lockSha256: hash(readFileSync(join(source, 'uv.lock'))), python: realpathSync(python) };
}

function installFixture(root) {
  const installation = fixtureInstaller(root);
  const result = installation.install('1.0.0');
  assert.equal(result.status, 0, result.stderr);
  return installation.tools;
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'acp-'));
  const workspace = newId();
  const agentDir = join(root, 'tasks', workspace, 'agent');
  mkdirSync(join(root, 'tasks', workspace, 'repo'), { recursive: true });
  const deliver = async input => {
    const request = Buffer.from(JSON.stringify({ operation_id: newId(), workspace_id: workspace, ...input })).toString('base64url');
    const { stdout } = await exec(process.execPath, [runner, request], { env: {
      PATH: dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: root, BOT_AGENT_TOOLS_DIR: join(root, 'tools'),
    } });
    const parsed = JSON.parse(stdout);
    return parsed.ok ? parsed.result : parsed;
  };
  const store = new Store(join(root, 'db'), randomBytes(32));
  const requests = [];
  const provider = createServer(async (req, res) => {
    let json = '';
    for await (const chunk of req) json += chunk;
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(json) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'model-response', model: 'acp-model', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture model' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(async () => {
    await deliver({ type: 'reap' });
    provider.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const tools = installFixture(root);
  const prior = process.env.BOT_AGENT_TOOLS_DIR;
  process.env.BOT_AGENT_TOOLS_DIR = tools;
  t.after(() => { if (prior === undefined) delete process.env.BOT_AGENT_TOOLS_DIR; else process.env.BOT_AGENT_TOOLS_DIR = prior; });
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('1','fixture/ACP','o','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('task','1','task.request','running','ACP fixture','{}')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('model','1',?,'acp-model',?,'now')",
    `http://127.0.0.1:${provider.address().port}/v1`, store.secrets.seal({ value: 'fixture-provider-key' }, 'model:model'));
  store.run("INSERT INTO policies(repository_id,enabled,model_id) VALUES('1',1,'model')");
  const events = [], checked = [], submissions = [];
  let binding = {}, revoked = false;
  const runToken = 'rrt_' + newId();
  const spec = {
    store, task: store.get("SELECT * FROM tasks WHERE id='task'"),
    roleWorkspace: { task: { workspace_id: workspace }, deliver, deliverCleanup: deliver },
    model: openModel(store, store.get("SELECT * FROM models WHERE id='model'")),
    redactor: new Redactor(), guard: async () => {}, system: 'Fixture system', prompt: 'Fixture task records',
    tools: [tool('read_fact'), tool('finish')], execute: async () => ({ fact: 'verified fact' }),
    finish: { name: 'finish', validate(args) {
      submissions.push(args.summary);
      if (!args.summary) throw new SubmissionError('fixture_invalid', { reason: 'summary_required' });
      return args;
    } },
    runAccess: { token: runToken, check(presented, capability) {
      assert.equal(presented, runToken);
      if (revoked) throw new TaskError('run_token_revoked', 'cancelled');
      checked.push(capability);
    } },
    harnessSessionKey: 'fixture',
    harnessState: { get value() { return binding; }, save(value) { binding = value; } },
    onHarnessEvent: event => events.push(event),
  };
  return { tools, deliver, spec, store, requests, submissions, events, checked, agentDir, runToken,
    revoke: () => { revoked = true; }, runs: () => (existsSync(agentDir) ? readdirSync(agentDir) : []).filter(name => name.startsWith('acp-')).map(name => join(agentDir, name)) };
}

async function waitFor(predicate) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  assert.fail('timed out waiting for ACP fixture');
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const alive = pid => {
  try { return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).startsWith('Z '); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
async function noProcesses(rundir) {
  const pids = [...json(join(rundir, 'pids.json')), json(join(rundir, 'sidecar.json'))];
  await waitFor(() => pids.every(pid => !alive(pid)));
}

test('ACP installer verifies inputs and switches the selected version after a successful install', t => {
  const root = mkdtempSync(join(tmpdir(), 'acp-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { tools, install, call, sourceSha256, lockSha256, python } = fixtureInstaller(root);
  const product = join(tools, 'acp', id);
  const selected = () => readAcpProduct(tools, id);
  const success = result => assert.equal(result.status, 0, result.stderr);
  success(install('1.0.0'));
  const first = selected();
  assert.deepEqual([first.version, first.sourceSha256, first.lockSha256, first.interpreter], ['1.0.0', sourceSha256, lockSha256, python]);

  for (const [preset, error] of [[{ sourceSha256: '0'.repeat(64) }, /acp_source_hash_mismatch/], [{ python: '0.0.0' }, /AssertionError/]]) {
    const failed = install('1.0.1', preset);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, error);
    assert.deepEqual(selected(), first);
    assert.ok(!existsSync(join(product, '1.0.1')));
  }

  success(install('1.0.1'));
  assert.equal(selected().version, '1.0.1');
  assert.match(call('remove', '1.0.1').stderr, /acp_product_version_selected/);
  success(call('select', '1.0.0'));
  success(call('remove', '1.0.1'));
  assert.deepEqual(selected(), first);
  assert.deepEqual(readdirSync(product).sort(), ['1.0.0', 'selected']);
});

test('ACP role kinds are declared in project configuration and refused for service roles', () => {
  const store = new Store(':memory:', randomBytes(32));
  try {
    const backends = agentBackends();
    const actor = { id: 'admin', role: 'super_admin' };
    for (const backend of [id, 'icode']) {
      const metadata = backends.find(item => item.id === backend);
      for (const role of ['dev', 'test', 'reviewer', 'ux', 'custom']) assert.ok(metadata.kinds.includes(roleKind(role)));
      for (const role of ['manager', 'coordinator', 'qa']) {
        assert.ok(!metadata.kinds.includes(roleKind(role)));
        assert.throws(() => resolveRole(store, '1', role, 'development.issue', { harness: backend }), error => error.code === 'harness_role_unsupported');
      }
      assert.deepEqual(metadata.supported_model_sources, ['gateway']);
      assert.throws(() => serviceRolesApi(store, actor, 'POST', '/api/service-roles', { name: 'fixture', harness: backend }), /unknown_role_harness/);
    }
    assert.equal(backends.find(item => item.id === id).runtime_status.source, 'declaration');
    assert.equal(backends.find(item => item.id === 'icode').runtime_status.source, 'tool_volume');
    assert.throws(() => roleHarness('acp'), /unknown_role_harness/);
  } finally { store.close(); }
});

test('ACP negotiates, streams, answers requests, validates HTTP MCP submissions, meters gateway use, and resumes or rebuilds', async t => {
  const f = await fixture(t);
  const driver = roleHarness(id);
  const session = driver.createSession(f.spec, {});
  t.after(() => session.close());
  assert.deepEqual(await session.run(), { summary: 'verified fact' });
  const binding = f.events.find(event => event.type === 'session_bound');
  assert.equal(binding.recoveryMode, 'new_session');
  assert.deepEqual(f.events.find(event => event.type === 'configuration').capabilities, { loadSession: true, sessionCapabilities: { close: {} } });
  assert.deepEqual(f.events.filter(event => event.type === 'message').map(event => event.text), ['检查', '完成']);
  assert.deepEqual(f.events.filter(event => event.type === 'tool').map(event => event.status), ['pending', 'completed']);
  assert.deepEqual(f.events.find(event => event.type === 'permission'), { type: 'permission', allowed: true, tool_call_id: 'T', outcome: 'selected', optionId: 'allow' });
  assert.ok(f.checked.includes('tools:invoke') && f.checked.includes('model:invoke'));
  assert.deepEqual(f.submissions, ['', 'verified fact']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/chat/completions');
  assert.equal(f.requests[0].auth, 'Bearer fixture-provider-key');
  const [usage] = f.store.all('SELECT input_tokens, output_tokens FROM model_requests');
  assert.deepEqual({ ...usage }, { input_tokens: 19, output_tokens: 7 });
  assert.equal(JSON.stringify(f.events).includes(f.runToken), false);
  assert.equal(json(join(f.runs()[0], 'close.json')), true);
  await noProcesses(f.runs()[0]);

  await session.send('continue');
  const resumed = f.events.filter(event => event.type === 'session_bound').at(-1);
  assert.equal(resumed.recoveryMode, 'native_resume');
  assert.equal(resumed.session_id, binding.session_id);
  const product = readAcpProduct(f.tools, id);
  const noLoad = { ...product, launch: { ...product.launch, env: { ...product.launch.env, FIXTURE_LOAD: '0' } } };
  // The on-disk binding still refers to the previous session. A product can stop offering loadSession even with the same binding.
  const prepared = { ...f.spec, harnessPreparation: noLoad, harnessBinding: { harness_revision: f.spec.harnessState.value.revision } };
  const rebuilding = driver.createSession(prepared, {});
  t.after(() => rebuilding.close());
  await rebuilding.send('from recorded facts');
  assert.equal(f.events.filter(event => event.type === 'session_bound').at(-1).recoveryMode, 'rebuilt_from_task_records');
  assert.ok(f.runs().some(run => existsSync(join(run, 'prompt.json')) && json(join(run, 'prompt.json')).includes('Rebuild context from the supplied task records')));
  await assert.rejects(session.send('error'), error => error.code === 'acp_rpc_error' && error.detail === 'fixture prompt error');
  await assert.rejects(session.send('bad stdout'), error => error.code === 'acp_invalid_frame');
});

for (const mode of ['cancel', 'close', 'timeout', 'revoked', 'lease expires', 'force kill']) {
  test(`ACP ${mode} stops the agent, its background child, and the sidecar`, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    if (mode === 'lease expires' || mode === 'force kill') {
      const product = readAcpProduct(f.tools, id);
      let renew = true;
      const deliver = f.spec.roleWorkspace.deliver;
      f.spec.roleWorkspace.deliver = request => deliver(renew ? request : { ...request, lease_heartbeat: false });
      const ran = withContainerHarnessSession(f.spec, { cli: id, acpProduct: product, model: 'acp-model', acpLocalLeaseMs: 4000 },
        controller.signal, () => {}, async session => {
          await waitFor(() => f.runs().some(run => existsSync(join(run, 'session.json'))));
          await session.writeStdin(JSON.stringify({ text: 'hold' }) + '\n');
          await waitFor(() => f.runs().some(run => existsSync(join(run, 'prompt.json'))));
          if (mode === 'force kill') await session.interrupt('kill');
          else renew = false;
          return session.waitExit();
        });
      // The poll observer stays alive after control-plane heartbeats stop.
      const result = await ran;
      if (mode === 'lease expires') assert.equal(result.error, 'acp_lease_expired');
      else assert.equal(result.state, 'interrupted');
    } else {
      const session = roleHarness(id).createSession({ ...f.spec, cancelSignal: controller.signal }, {});
      t.after(() => session.close());
      const task = session.send('hold');
      task.catch(() => {});
      await waitFor(() => f.runs().some(run => existsSync(join(run, 'prompt.json'))));
      if (mode === 'cancel') await session.cancel();
      else if (mode === 'close') await session.close();
      else if (mode === 'timeout') controller.abort(new TaskError('role_budget_exhausted', 'waiting_configuration'));
      else f.revoke();
      await assert.rejects(task, error => error instanceof TaskError && error.code === ({ cancel: 'harness_cancelled', close: 'harness_cancelled', timeout: 'role_budget_exhausted', revoked: 'run_token_revoked' })[mode]);
    }
    const [run] = f.runs();
    if (mode !== 'force kill') assert.equal(json(join(run, 'cancel.json')), true);
    await noProcesses(run);
  });
}
