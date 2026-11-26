import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Redactor, TaskError } from '../../../../dist/agent/common.js';
import { openModel } from '../../../../dist/agent/model.js';
import { withContainerHarnessSession } from '../../../../dist/harness/container-session.js';
import { agentBackends } from '../../../../dist/roles/backends.js';
import { resolveRole } from '../../../../dist/roles/definition.js';
import { roleKind } from '../../../../dist/roles/catalog.js';
import { harnesses, registerRoleHarness, roleHarness } from '../../../../dist/roles/harness.js';
import { acpHarness } from '../../../../dist/harness/acp.js';
import { SubmissionError } from '../../../../dist/roles/submission-error.js';
import { serviceRolesApi } from '../../../../dist/service-roles/api.js';
import { Store } from '../../../../dist/storage/database.js';
import { icodeTestedVersion, readAcpProduct, workswarmLaunch, workswarmRelease } from '../../../../runner/acp-products.mjs';
import { configureWorkSwarm } from '../../../../runner/workswarm.mjs';
import { configureICode, icodeAnswer } from '../../../../runner/icode.mjs';
import { writeICodeProduct } from '../../../fixtures/icode-product.mjs';

// The shared ACP session code runs iCode and WorkSwarm, which both need a project computer. These tests drive it in local
// mode through a test-only product registered like them but unlisted (#1339: there is no generic ACP backend to use).
const id = 'acp_fixture';
registerRoleHarness({ ...harnesses.find(driver => driver.id === 'icode'), id, listed: false }, spec => acpHarness(spec, id));
const exec = promisify(execFile);
const runner = resolve('runner/runner.mjs');
const hash = content => createHash('sha256').update(content).digest('hex');
const newId = () => randomBytes(24).toString('hex');
const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } });

// Writes the fixture product as an installed ACP product: test/fixtures/acp-product/fixture.py run by this machine's Python.
function writeAcpFixture(root, version = '1.0.0') {
  const [python, pythonVersion] = execFileSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 11); print(sys.executable); print(sys.version.split()[0])'], { encoding: 'utf8' }).trim().split('\n');
  const launch = {
    args: ['{product}/fixture.py', 'agent'], mcp: 'http', access: 'native', untrustedCheckout: false,
    env: { FIXTURE_RUN: '{run}', FIXTURE_MODEL_URL: '{relay}', FIXTURE_MODEL_TOKEN: '{token}', FIXTURE_MODEL: '{model}' },
    answers: { '_fixture/input': { answer: 'unattended' } },
    sidecars: [{ name: 'fixture', args: ['{product}/fixture.py', 'sidecar', '{port:fixture}'], healthPath: '/ready' }],
  };
  const tools = join(root, 'tools'), product = join(tools, 'acp', id), directory = join(product, version);
  const interpreter = realpathSync(python), fixtureSource = readFileSync(resolve('test/fixtures/acp-product/fixture.py'));
  mkdirSync(join(directory, 'venv', 'bin'), { recursive: true });
  mkdirSync(join(directory, 'source'));
  writeFileSync(join(directory, 'source', 'fixture.py'), fixtureSource);
  symlinkSync(interpreter, join(directory, 'venv', 'bin', 'python'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema: 'bot.acp-product/1', id, version, python: pythonVersion, interpreter,
    source: 'test/fixtures/acp-product', sourceSha256: hash(fixtureSource), lockSha256: hash(fixtureSource), launch }));
  writeFileSync(join(product, 'selected'), version + '\n');
  return tools;
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
  const tools = writeAcpFixture(root);
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

test('the ACP installer takes only iCode and WorkSwarm, and selects or removes their installed versions', t => {
  const root = mkdtempSync(join(tmpdir(), 'acp-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, 'tools'), source = join(root, 'source');
  mkdirSync(tools);
  mkdirSync(source);
  const { product, directory, manifest } = writeICodeProduct(tools);
  // A second pinned iCode release, only in the installer subprocess: the production release map stays unchanged.
  const other = '0.0.1', products = pathToFileURL(resolve('runner/acp-products.mjs')).href;
  cpSync(directory, join(product, other), { recursive: true });
  writeFileSync(join(product, other, 'manifest.json'), JSON.stringify({ ...manifest, version: other }));
  const release = ['--import', 'data:text/javascript,' + encodeURIComponent(`import { icodeReleases } from ${JSON.stringify(products)};\n` +
    `icodeReleases.set(${JSON.stringify(other)}, icodeReleases.get(${JSON.stringify(icodeTestedVersion)}));`)];
  const call = (action, productId, version, args = []) => spawnSync(process.execPath, [...release, resolve('scripts/install-acp-product.mjs'),
    action, '--root', tools, '--product', productId, '--version', version, ...args], { encoding: 'utf8' });
  const selected = () => readFileSync(join(product, 'selected'), 'utf8').trim();
  const success = result => assert.equal(result.status, 0, result.stderr);

  // The generic Python product path is gone: no other product, no preset, no source hashing.
  for (const action of ['install', 'select', 'remove']) assert.match(call(action, 'container_acp', '1.0.0', ['--source', source]).stderr, /acp_product_unsupported/);
  assert.match(call('install', 'workswarm', workswarmRelease.version, ['--source', source, '--preset', join(root, 'preset.json')]).stderr, /Unknown option '--preset'/);
  const hashSource = spawnSync(process.execPath, [resolve('scripts/install-acp-product.mjs'), 'hash-source', '--source', source], { encoding: 'utf8' });
  assert.match(hashSource.stderr, /Expected install, select or remove/);
  assert.deepEqual(readdirSync(join(tools, 'acp')).sort(), ['icode']);

  success(call('select', 'icode', other));
  assert.equal(selected(), other);
  assert.match(call('remove', 'icode', other).stderr, /acp_product_version_selected/);
  success(call('select', 'icode', icodeTestedVersion));
  success(call('remove', 'icode', other));
  assert.equal(readAcpProduct(tools, 'icode').version, icodeTestedVersion);
  assert.deepEqual(readdirSync(product).sort(), [icodeTestedVersion, 'selected']);
});

test('iCode installs only the executable from a verified offline archive and preserves an existing selection on rejection', t => {
  const root = mkdtempSync(join(tmpdir(), 'icode-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, 'tools'), source = join(root, 'source'), archive = join(root, 'icode.tar.gz');
  mkdirSync(tools);
  mkdirSync(source);
  const executable = '#!/bin/sh\nexit 0\n';
  writeFileSync(join(source, 'icode'), executable);
  writeFileSync(join(source, 'extra.txt'), 'ignored package content');
  execFileSync('tar', ['-czf', archive, '-C', source, 'icode', 'extra.txt']);
  const script = resolve('scripts/install-acp-product.mjs');
  const dataImport = code => ['--import', 'data:text/javascript,' + encodeURIComponent(code)];
  const install = (args, preload = []) => spawnSync(process.execPath, [...preload, script, 'install',
    '--root', tools, '--product', 'icode', '--version', icodeTestedVersion, ...args], { encoding: 'utf8' });

  // Pin the tiny synthetic archive in the installer subprocess. The production release map remains unchanged.
  const products = pathToFileURL(resolve('runner/acp-products.mjs')).href;
  const sha256 = hash(readFileSync(archive));
  const fixtureRelease = dataImport(`import { icodeReleases } from ${JSON.stringify(products)};\n` +
    `icodeReleases.get(${JSON.stringify(icodeTestedVersion)}).sha256[process.arch] = ${JSON.stringify(sha256)};`);
  const installed = install(['--archive', archive], fixtureRelease);
  assert.equal(installed.status, 0, installed.stderr);
  const product = join(tools, 'acp', 'icode'), versionDir = join(product, icodeTestedVersion);
  const selected = join(product, 'selected'), manifestPath = join(versionDir, 'manifest.json');
  assert.equal(readFileSync(selected, 'utf8'), icodeTestedVersion + '\n');
  assert.equal(readFileSync(join(versionDir, 'bin', 'icode'), 'utf8'), executable);
  assert.deepEqual(readdirSync(join(versionDir, 'bin')), ['icode']);
  assert.deepEqual(readdirSync(versionDir).sort(), ['bin', 'manifest.json']);
  const manifest = readFileSync(manifestPath, 'utf8');
  assert.deepEqual([JSON.parse(manifest).distribution, JSON.parse(manifest).sourceSha256], ['linux-offline', sha256]);

  for (const [args, preload, error] of [
    [[], [], /icode_offline_archive_required/],
    [['--archive', archive], [], /icode_archive_hash_mismatch/],
    [['--archive', archive], dataImport("Object.defineProperty(process, 'arch', { value: 'ia32' });"), /icode_release_unsupported/],
  ]) {
    const rejected = install(args, preload);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, error);
    assert.equal(readFileSync(selected, 'utf8'), icodeTestedVersion + '\n');
    assert.equal(readFileSync(manifestPath, 'utf8'), manifest);
    assert.deepEqual(readdirSync(product).sort(), [icodeTestedVersion, 'selected']);
  }
});

const inputAnswer = { values: ['No human is available. Use your judgment based on the task.'], note: '' };

test('iCode config restricts project inputs and builtins, and selects the model relay protocol', async t => {
  const root = mkdtempSync(join(tmpdir(), 'icode-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = [
    { type: 'openai-chat-completions', provider: 'openai', style: 'chat_completions', files: 'write', trusted: true, commands: true,
      memoryFiles: ['AGENTS.md'], mountedSkillDir: '/opt/bot-skills/sets/abc/bot/skills', expectPaths: ['/opt/bot-skills/sets/abc/bot/skills'], tools: ['filesystem.read', 'search', 'filesystem.write', 'shell'] },
    { type: 'openai-responses', provider: 'openai', style: 'responses', files: 'read', trusted: false, commands: false,
      memoryFiles: [], mountedSkillDir: '/opt/bot-skills/sets/def/bot/skills', expectPaths: ['/opt/bot-skills/sets/def/bot/skills'], tools: ['filesystem.read', 'search'] },
    { type: 'anthropic-messages', provider: 'anthropic', style: undefined, files: 'none', trusted: true, commands: false,
      memoryFiles: [], mountedSkillDir: '/opt/bot-skills/sets/ghi/bot/skills', expectPaths: null, tools: [] },
  ];
  for (const { type, provider, style, files, trusted, commands, memoryFiles, mountedSkillDir, expectPaths, tools } of cases) {
    const home = join(root, type);
    await configureICode({
      model: 'test-model', acp_model: { interface_type: type, context_window: 100000, max_output_tokens: 4096, image_input: false },
      execution_access: { fileTools: files, workspace: 'write', commands, trustedCheckout: trusted },
    }, { HOME: home, BOT_ACP_RELAY_URL: 'http://127.0.0.1:3210', BOT_MOUNTED_SKILLS_DIR: mountedSkillDir });
    const profile = json(join(home, '.chrys', 'models', 'launchpad.yaml'));
    const agent = json(join(home, '.chrys', 'agents', 'launchpad.yaml'));
    assert.deepEqual(json(join(home, '.chrys', 'settings.yaml')), {
      project: { config_enabled: false, hooks_enabled: false, skills_enabled: false },
    });
    assert.deepEqual(agent.memory.files, memoryFiles);
    assert.deepEqual(agent.skills, {
      ...(expectPaths ? { paths: expectPaths } : {}),
      auto_load_user_agents_skills: false,
      auto_load_cwd_agents_skills: false,
      ...(commands ? {} : { script_extensions: [] }),
    });
    assert.deepEqual(agent.tools.builtins, ['ask_user', 'todo', ...tools]);
    assert.equal(agent.model.profile_id, profile.id);
    assert.equal(profile.provider, provider);
    assert.equal(profile.api_style, style);
    assert.equal(profile.base_url, 'http://127.0.0.1:3210' + (provider === 'openai' ? '/v1' : ''));
    assert.equal(profile.api_key, '{{BOT_RUN_TOKEN}}');
  }
  assert.deepEqual(icodeAnswer({ questions: [{}] }), { answers: [inputAnswer], cancelled: false });
  assert.deepEqual(icodeAnswer({ questions: [{}, {}] }), { answers: [inputAnswer, inputAnswer], cancelled: false });
  assert.deepEqual(icodeAnswer({}), { cancelled: true });
});

async function driveICodeEntry(t, handshake, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'icode-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rootTools = join(root, 'tools'), agentDir = join(root, 'agent'), home = join(root, 'home');
  mkdirSync(agentDir);
  mkdirSync(home);
  const executable = '#!/usr/bin/env python3\n' + readFileSync('test/fixtures/acp-product/fixture.py', 'utf8');
  const { directory } = writeICodeProduct(rootTools, executable, {
    env: { FIXTURE_RUN: '{run}', FIXTURE_ICODE: handshake, FIXTURE_PRODUCT_SOURCE: '{product}' },
  });
  const instanceId = newId();
  writeFileSync(join(agentDir, 'harness.json'), JSON.stringify({
    acp_product: readAcpProduct(rootTools, 'icode'), instance_id: instanceId, model: 'fixture',
    acp_model: { interface_type: 'openai-chat-completions', context_window: 10000, max_output_tokens: 1024, image_input: false },
    ...(options.executionAccess ? { execution_access: options.executionAccess } : {}),
  }));

  // The local runner correctly rejects iCode. Exercise the ACP entry point without changing that restriction.
  const child = spawn(process.execPath, [resolve('runner/acp-entry.mjs'), agentDir, join(directory, 'bin', 'icode')], {
    cwd: root, signal: AbortSignal.timeout(20_000),
    env: {
      ...process.env, HOME: home, BOT_RUN_TOKEN: 'fixture-run-token', BOT_ACP_RELAY_URL: 'http://127.0.0.1:3210',
      ...(options.mountedSkillsDir ? { BOT_MOUNTED_SKILLS_DIR: options.mountedSkillsDir } : {}),
    },
  });
  const closed = once(child, 'close');
  const frames = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  for await (const line of createInterface({ input: child.stdout })) {
    const frame = JSON.parse(line);
    frames.push(frame);
    if (frame.type === 'ready') child.stdin.write(JSON.stringify({ text: 'Answer the questions.' }) + '\n');
    if (frame.type === 'turn') child.stdin.end();
  }
  const [status] = await closed;
  return { frames, status, stderr, run: join(agentDir, 'acp-' + instanceId) };
}

test('iCode negotiates HTTP MCP, answers only the current session and closes it', async t => {
  const { frames, status, stderr, run } = await driveICodeEntry(t, 'supported');
  assert.equal(status, 0, JSON.stringify(frames) + stderr);
  assert.equal(frames.find(frame => frame.event?.type === 'configuration').event.agent.version, icodeTestedVersion);
  assert.equal(frames.find(frame => frame.type === 'turn').stop_reason, 'end_turn');
  assert.equal(frames.find(frame => frame.type === 'ready').skills, undefined, 'without mounted skills dir, ready must omit skills');
  assert.deepEqual(json(join(run, 'wrong-session.json')), { cancelled: true });
  assert.deepEqual(json(join(run, 'input.json')), { answers: [inputAnswer, inputAnswer], cancelled: false });
  assert.equal(json(join(run, 'close.json')), true);
});

test('#1359 iCode ready frame reports only runner-applied mounted skills and omits them when fileTools=none or mount is absent', async t => {
  const skillsDir = mkdtempSync(join(tmpdir(), 'icode-mounted-skills-'));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  mkdirSync(join(skillsDir, 'alpha-ops'), { recursive: true });
  writeFileSync(join(skillsDir, 'alpha-ops', 'SKILL.md'), '---\nname: alpha-ops\ndescription: Alpha.\n---\nBody.\n');

  const withRead = await driveICodeEntry(t, 'supported', {
    executionAccess: { fileTools: 'read', workspace: 'read', commands: false, trustedCheckout: false },
    mountedSkillsDir: skillsDir,
  });
  assert.equal(withRead.status, 0, withRead.stderr);
  const readyRead = withRead.frames.find(frame => frame.type === 'ready');
  assert.deepEqual(readyRead.skills, ['alpha-ops']);
  assert.deepEqual(readyRead.skill_paths, [skillsDir]);

  const withNone = await driveICodeEntry(t, 'supported', {
    executionAccess: { fileTools: 'none', workspace: 'none', commands: false, trustedCheckout: false },
    mountedSkillsDir: skillsDir,
  });
  assert.equal(withNone.status, 0, withNone.stderr);
  const readyNone = withNone.frames.find(frame => frame.type === 'ready');
  assert.equal(readyNone.skills, undefined, 'fileTools=none must not report skills in ready');
  assert.equal(readyNone.skill_paths, undefined, 'fileTools=none must not report skill_paths in ready');

  // Control plane ACP driver (src/harness/acp.ts) must also never echo spec.harnessSkillSet when runner reported no skills.
  const f = await fixture(t);
  f.spec.harnessSkillSet = {
    setHash: 'a'.repeat(64),
    scope: 'projects/1',
    storeRoot: skillsDir,
    hostRoot: skillsDir,
    containerPluginDir: '/opt/bot-skills/sets/' + 'a'.repeat(64) + '/bot',
    containerSkillsDir: '/opt/bot-skills/sets/' + 'a'.repeat(64) + '/bot/skills',
    skills: [{ slug: 'alpha-ops', name: 'alpha-ops', description: 'Alpha.' }],
  };
  const session = roleHarness(id).createSession(f.spec, {});
  t.after(() => session.close());
  assert.deepEqual(await session.run(), { summary: 'verified fact' });
  const bound = f.events.find(event => event.type === 'session_bound');
  assert.equal(bound.skills, undefined, 'session_bound must not claim harnessSkillSet skills when runner did not configure them');
});

for (const mode of ['wrong-protocol', 'wrong-version', 'no-http', 'no-close']) {
  test(`iCode rejects the ${mode} handshake before creating a session`, async t => {
    const { frames, status, run } = await driveICodeEntry(t, mode);
    assert.equal(status, 1);
    assert.equal(frames.find(frame => frame.type === 'fault')?.code, 'icode_protocol_unsupported');
    assert.equal(frames.some(frame => frame.type === 'ready'), false);
    assert.equal(existsSync(join(run, 'session.json')), false);
  });
}

test('iCode and WorkSwarm are the ACP backends: their role kinds are declared in project configuration and refused for service roles', () => {
  const store = new Store(':memory:', randomBytes(32));
  try {
    const backends = agentBackends();
    const actor = { id: 'admin', role: 'super_admin' };
    for (const backend of ['icode', 'workswarm']) {
      const metadata = backends.find(item => item.id === backend);
      for (const role of ['dev', 'test', 'reviewer', 'ux', 'custom']) assert.ok(metadata.kinds.includes(roleKind(role)));
      for (const role of ['manager', 'qa']) {
        assert.ok(!metadata.kinds.includes(roleKind(role)));
        assert.throws(() => resolveRole(store, '1', role, 'development.issue', { harness: backend }), error => error.code === 'harness_role_unsupported');
      }
      assert.deepEqual(metadata.supported_model_sources, ['gateway']);
      assert.throws(() => serviceRolesApi(store, actor, 'PATCH', '/api/service-roles/management-assistant', { expected_revision: 1, harness: backend }), /unknown_role_harness/);
    }
    assert.equal(backends.find(item => item.id === 'icode').runtime_status.source, 'tool_volume');
    // The generic container ACP backend (#1339), the older ACP backend (#705) and the unlisted test product are not offered.
    assert.deepEqual(backends.filter(item => harnesses.find(driver => driver.id === item.id)?.events === 'acp_v1').map(item => item.id).sort(), ['icode', 'workswarm']);
    for (const retired of ['container_acp', 'acp']) assert.throws(() => roleHarness(retired), /unknown_role_harness/);
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
      const ran = withContainerHarnessSession(f.spec, { cli: 'acp', backendId: id, acpProduct: product, model: 'acp-model', acpLocalLeaseMs: 4000 },
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
      let settled = false;
      const markSettled = () => { settled = true; };
      task.then(markSettled, markSettled);
      await waitFor(() => settled || f.runs().some(run => existsSync(join(run, 'prompt.json'))));
      if (settled) {
        await task; // Surface the original send error before attempting to interrupt the fixture.
        assert.fail('ACP hold prompt completed before interruption');
      }
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


test('WorkSwarm pins the interpreter, wheel and dependency lock', t => {
  const root = mkdtempSync(join(tmpdir(), 'workswarm-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, 'tools'), source = join(root, 'source');
  mkdirSync(tools);
  mkdirSync(source);
  writeFileSync(join(source, workswarmRelease.wheel), 'unrecognized artifact');
  const call = version => spawnSync(process.execPath, [resolve('scripts/install-acp-product.mjs'),
    'install', '--root', tools, '--product', 'workswarm', '--version', version, '--source', source], { encoding: 'utf8' });
  assert.match(call('0.0.1').stderr, /workswarm_release_unsupported/);
  assert.match(call(workswarmRelease.version).stderr, /acp_source_hash_mismatch/);
  assert.deepEqual(readdirSync(join(tools, 'acp', 'workswarm')), []);
});

test('WorkSwarm prepares the private profile without importing template tool grants', async t => {
  const home = mkdtempSync(join(tmpdir(), 'workswarm-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const modules = join(home, 'modules');
  const common = join(modules, 'jiuwenswarm', 'common');
  mkdirSync(common, { recursive: true });
  writeFileSync(join(modules, 'yaml.py'), 'from json import loads as safe_load\n');
  writeFileSync(join(common, 'utils.py'), `
import json
import os
from pathlib import Path

def prepare_runtime_workspace(*, migrate_config=True):
    if migrate_config or os.environ.get("FIXTURE_CHANGES_POLICY") == "1":
        path = Path(os.environ["JIUWENSWARM_DATA_DIR"]) / "config" / "config.yaml"
        config = json.loads(path.read_text())
        config["permissions"]["tools"]["native_fixture"] = "allow"
        path.write_text(json.dumps(config))
`);
  const relay = process.env.BOT_ACP_RELAY_URL;
  process.env.BOT_ACP_RELAY_URL = 'http://127.0.0.1:4321';
  t.after(() => {
    if (relay === undefined) delete process.env.BOT_ACP_RELAY_URL;
    else process.env.BOT_ACP_RELAY_URL = relay;
  });
  writeFileSync(join(home, 'mcp-tools.json'), JSON.stringify([{ name: 'read_file' }]));
  const configure = (target, overrides = {}) => configureWorkSwarm({
    model: 'chosen-model', acp_model: { interface_type: 'openai-chat-completions', context_window: 16000, max_output_tokens: 1024 },
  }, target, { agent: 1234, web: 1235, gateway: 1236 }, { url: 'http://127.0.0.1:4322/mcp' }, 'test-run-token', home, {
    executable: 'python3', environment: { ...process.env, PYTHONPATH: modules, PYTHONDONTWRITEBYTECODE: '1', ...overrides },
  });
  const { env, workspace } = await configure(home);
  const cfg = json(join(home, 'data/config/config.yaml'));
  assert.equal(workspace, join(home, 'workspace'));
  assert.equal(env.JIUWENSWARM_DATA_DIR, join(home, 'data'));
  assert.equal(env.JIUWENSWARM_RUNTIME_SOCKET, 'worker.sock');
  assert.equal(env.JIUWENSWARM_RUNTIME_WORKSPACE_READY, '1');
  assert.deepEqual([env.AGENT_SERVER_PORT, env.WEB_PORT, env.GATEWAY_PORT], ['1234', '1235', '1236']);
  assert.deepEqual([env.AGENT_SERVER_HOST, env.WEB_HOST, env.GATEWAY_HOST], Array(3).fill('127.0.0.1'));
  assert.equal(cfg.models.defaults[0].model_client_config.api_base, 'http://127.0.0.1:4321/v1');
  assert.equal(cfg.models.defaults[0].model_client_config.api_key, '${API_KEY}');
  assert.deepEqual(cfg.mcp.servers[0].headers, { Authorization: 'Bearer test-run-token' });
  assert.deepEqual(cfg.permissions.defaults, { '*': 'deny' });
  assert.deepEqual(cfg.permissions.tools, { mcp_bot_read_file: 'allow' });
  assert.equal(cfg.hooks.disable_all_hooks, true);
  assert.ok(!('channels' in cfg) && !('cron' in cfg));
  assert.deepEqual(workswarmLaunch.sidecars.map(s => s.name), ['agent-server', 'gateway']);
  assert.deepEqual(roleHarness('workswarm').capabilities.recovery, ['rebuilt_from_task_records']);
  await assert.rejects(configure(join(home, 'changed-policy'), { FIXTURE_CHANGES_POLICY: '1' }),
    /WorkSwarm permissions changed during workspace preparation/);
});

test('concurrent WorkSwarm runs reserve distinct ports and release only their own reservations', t => {
  const root = mkdtempSync(join(tmpdir(), 'workswarm-ports-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const module = pathToFileURL(resolve('runner/workswarm.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readdir } from 'node:fs/promises';
    import { reserveWorkSwarmPorts, releaseWorkSwarmPorts } from ${JSON.stringify(module)};
    const dev = 'a'.repeat(48), reviewer = 'b'.repeat(48);
    const allocated = await Promise.all([reserveWorkSwarmPorts(dev), reserveWorkSwarmPorts(reviewer)]);
    assert.equal(new Set(allocated.flatMap(Object.values)).size, 6);
    await releaseWorkSwarmPorts(dev);
    const directory = process.env.BOT_LOCAL_WORKSPACE + '/.workswarm-ports';
    assert.deepEqual((await readdir(directory)).sort(), Object.values(allocated[1]).map(String).sort());
    await releaseWorkSwarmPorts(reviewer);
    assert.deepEqual(await readdir(directory), []);
  `], { env: { ...process.env, BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: root }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
