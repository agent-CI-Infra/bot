import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { beginRun, endRun } from '../../../../dist/tasks/trace.js';
import { Redactor, TaskError } from '../../../../dist/agent/common.js';
import { activeCliVersions, allocateLease, recordRunCliVersion, roleRunStorage } from '../../../../dist/roles/role-run.js';
import { registerRoleHarness } from '../../../../dist/roles/harness.js';
import { runRole } from '../../../../dist/roles/run.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { agentToolsApi } from '../../../../dist/app/agent-tools.js';
import {
  AGENT_PRODUCT_REGISTRY,
  AGENT_TOOL_PRODUCTS,
  AgentToolManager,
  AgentToolsAutoInstaller,
  COMPATIBLE_CLI_RANGES,
  detectElfInterpreterLibc,
  detectHostLibc,
  inspectAgentTools,
  parseSemver,
  satisfiesCliRange,
  satisfiesProductVersion,
  selectCompatibleCliVersion,
} from '../../../../dist/harness/agent-tools.js';
import { Projects } from '../../../../manager/projects.mjs';
import { FakeDocker } from '../../../fixtures/fake-docker.mjs';

import { buildTarGz, createMockAcpBuilder, hashes, startMockToolUpstream } from '../../../fixtures/agent-tools-fixture.mjs';

const hex48 = () => randomBytes(24).toString('hex');

test('semver parsing and compatibility range checks reject malformed and pre-release versions', () => {
  assert.deepEqual(parseSemver('2.1.319'), { major: 2, minor: 1, patch: 319, raw: '2.1.319' });
  for (const bad of ['', '2.1', 'v2.1.0', '2.1.0-beta.1', '../2.1.0', '02.1.0']) {
    assert.equal(parseSemver(bad), null, `expected ${bad} to be rejected`);
  }
  assert.equal(satisfiesCliRange('claude_code', '2.0.9'), false);
  assert.equal(satisfiesCliRange('claude_code', '2.1.0'), true);
  assert.equal(satisfiesCliRange('claude_code', '2.1.319'), true);
  assert.equal(satisfiesCliRange('claude_code', '3.0.0'), false);
  assert.equal(satisfiesCliRange('codex', '0.165.9'), false);
  assert.equal(satisfiesCliRange('codex', '0.166.0'), true);
  assert.equal(satisfiesCliRange('codex', '1.0.0'), false);
});

test('installs Claude Code (with bundled Node runtime) and Codex (static build), selects newest compatible version, rejects tampered/untrusted downloads, and prunes keeping latest N', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');

  // Use root as both volumeRoot and containerRoot so generated launcher scripts can be executed directly on host.
  const manager = new AgentToolManager({
    volumeRoot: root,
    containerRoot: root,
    arch: 'x64',
    sources: upstream.sources,
  });

  // Empty volume reports cli_not_installed.
  const initial = inspectAgentTools(root, { containerRoot: root, arch: 'x64' });
  assert.equal(initial.volume_present, true);
  assert.equal(initial.clis.claude_code.available, false);
  assert.equal(initial.clis.claude_code.reason, 'cli_not_installed');
  assert.equal(initial.clis.codex.reason, 'cli_not_installed');

  // Tampered checksum is rejected and leaves no partial CLI installation.
  upstream.setTamperClaudeHash(true);
  await assert.rejects(manager.install({ cli: 'claude_code', version: '2.1.319' }), { code: 'agent_tool_hash_mismatch' });
  assert.equal(existsSync(join(root, 'claude_code', '2.1.319')), false);
  upstream.setTamperClaudeHash(false);

  // Redirect to untrusted origin is rejected.
  upstream.setUntrustedRedirect(true);
  await assert.rejects(manager.install({ cli: 'codex', version: '0.166.0' }), { code: 'agent_tool_download_failed' });
  upstream.setUntrustedRedirect(false);

  // Install incompatible versions first -> reported as cli_version_incompatible and never selected!
  await manager.install({ cli: 'claude_code', version: '3.0.0' });
  await manager.install({ cli: 'codex', version: '0.165.0' });
  const onlyIncompat = manager.status();
  assert.equal(onlyIncompat.clis.claude_code.available, false);
  assert.equal(onlyIncompat.clis.claude_code.reason, 'cli_version_incompatible');
  assert.deepEqual(onlyIncompat.clis.claude_code.incompatible_versions, ['3.0.0']);
  assert.throws(() => selectCompatibleCliVersion(root, 'claude_code', { containerRoot: root, arch: 'x64' }), { code: 'cli_version_incompatible' });

  // Install compatible versions: JS-based 2.1.310, native-based 2.1.319, older 1.9.0; Codex 0.166.0, 0.167.0, 1.0.0.
  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  const selected210 = manager.select('claude_code');
  assert.equal(selected210.version, '2.1.310');
  const out210 = execFileSync(selected210.host_executable, ['--version'], { encoding: 'utf8' });
  assert.match(out210, /2\.1\.310 \(Claude Code\)/);
  assert.ok(out210.includes(join(root, 'node', '22.15.0', 'bin', 'node')), 'JS package ran under bundled Node runtime');

  await manager.install({ cli: 'claude_code', version: '2.1.319' });
  await manager.install({ cli: 'claude_code', version: '1.9.0' });
  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  await manager.install({ cli: 'codex', version: '1.0.0' });

  // Runtime selector picks newest compatible version (2.1.319 and 0.167.0), ignoring 3.0.0 and 1.0.0!
  // On glibc (project/run base image node:22-bookworm-slim), installer selects @anthropic-ai/claude-code-linux-x64, never -musl.
  const claudeSel = manager.select('claude_code');
  assert.equal(claudeSel.version, '2.1.319');
  assert.equal(claudeSel.compatible_range, COMPATIBLE_CLI_RANGES.claude_code.range);
  assert.match(execFileSync(claudeSel.host_executable, ['--version'], { encoding: 'utf8' }), /2\.1\.319 \(Claude Code\) libc=glibc/);
  const nativeArtifact = claudeSel.manifest.artifacts.find(a => a.role === 'native_binary');
  assert.ok(nativeArtifact?.source_url.includes('/@anthropic-ai/claude-code-linux-x64/-/'));
  assert.equal(nativeArtifact?.source_url.includes('-musl'), false);

  const codexSel = manager.select('codex');
  assert.equal(codexSel.version, '0.167.0');
  assert.match(execFileSync(codexSel.host_executable, ['--version'], { encoding: 'utf8' }), /codex-cli 0\.167\.0/);

  // Prune keeping latest 2 versions per CLI: keeps [2.1.319, 2.1.310] and [0.167.0, 0.166.0], removing out-of-range/older ones!
  const pruned = await manager.prune({ retainCount: 2 });
  assert.deepEqual(pruned.pruned.claude_code.sort(), ['1.9.0', '3.0.0']);
  assert.deepEqual(pruned.pruned.codex.sort(), ['0.165.0', '1.0.0']);
  assert.deepEqual(pruned.status.clis.claude_code.compatible_versions, ['2.1.319', '2.1.310']);
  assert.deepEqual(pruned.status.clis.claude_code.incompatible_versions, []);
  assert.deepEqual(pruned.status.clis.codex.compatible_versions, ['0.167.0', '0.166.0']);
  assert.deepEqual(pruned.status.node_versions, ['22.15.0']);
});

test('AgentToolManager selects musl native package only when libc=musl and refuses musl-only wrapper packages on glibc', async t => {
  const upstream = await startMockToolUpstream(t, 'x64');

  const glibcRoot = mkdtempSync(join(tmpdir(), 'agent-tools-glibc-'));
  t.after(() => rmSync(glibcRoot, { recursive: true, force: true }));
  const glibcManager = new AgentToolManager({
    volumeRoot: glibcRoot,
    containerRoot: glibcRoot,
    arch: 'x64',
    libc: 'glibc',
    sources: upstream.sources,
  });
  await assert.rejects(
    glibcManager.install({ cli: 'claude_code', version: '2.1.315' }),
    { code: 'agent_tool_archive_invalid' },
  );
  assert.equal(existsSync(join(glibcRoot, 'claude_code', '2.1.315')), false);

  const muslRoot = mkdtempSync(join(tmpdir(), 'agent-tools-musl-'));
  t.after(() => rmSync(muslRoot, { recursive: true, force: true }));
  const muslManager = new AgentToolManager({
    volumeRoot: muslRoot,
    containerRoot: muslRoot,
    arch: 'x64',
    libc: 'musl',
    sources: upstream.sources,
  });
  await muslManager.install({ cli: 'claude_code', version: '2.1.315' });
  const muslSel = muslManager.select('claude_code');
  assert.equal(muslSel.manifest.libc, 'musl');
  assert.match(execFileSync(muslSel.host_executable, ['--version'], { encoding: 'utf8' }), /2\.1\.315 \(Claude Code\) libc=musl/);
  assert.ok(muslSel.manifest.artifacts.find(a => a.role === 'native_binary')?.source_url.includes('-musl'));

  // A glibc runtime rejects a volume entry built for musl — both when manifest.libc is recorded and on legacy manifests
  // that only have the -musl native_binary source_url — instead of selecting a binary whose dynamic loader is missing.
  const glibcOnMuslVolume = new AgentToolManager({
    volumeRoot: muslRoot,
    containerRoot: muslRoot,
    arch: 'x64',
    libc: 'glibc',
    sources: upstream.sources,
  });
  assert.equal(glibcOnMuslVolume.status().clis.claude_code.available, false);
  assert.equal(glibcOnMuslVolume.status().clis.claude_code.reason, 'cli_not_installed');
  assert.throws(() => glibcOnMuslVolume.select('claude_code'), { code: 'cli_not_installed' });

  const legacyManifestPath = join(muslRoot, 'claude_code', '2.1.315', 'manifest.json');
  const legacyManifest = JSON.parse(readFileSync(legacyManifestPath, 'utf8'));
  delete legacyManifest.libc;
  writeFileSync(legacyManifestPath, JSON.stringify(legacyManifest, null, 2));
  assert.equal(glibcOnMuslVolume.status().clis.claude_code.available, false);
  assert.throws(() => glibcOnMuslVolume.select('claude_code'), { code: 'cli_not_installed' });
  assert.equal(muslManager.select('claude_code').version, '2.1.315');
});

test('records selected CLI version on task_runs and serves super-admin /api/agent-tools endpoints', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const tools = new AgentToolManager({ volumeRoot: root, containerRoot: '/opt/agent-tools', arch: 'x64', sources: upstream.sources });

  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };
  const projAdmin = { id: 'u-proj', role: 'project_admin', repositories: ['r'] };

  await assert.rejects(() => agentToolsApi(store, tools, projAdmin, 'GET', '/api/agent-tools', {}), { status: 403 });

  const installed = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'codex',
    version: '0.166.0',
    retain_count: 2,
  });
  assert.equal(installed.compatible, true);
  assert.equal(installed.status.clis.codex.selected_version, '0.166.0');
  assert.equal(installed.status.clis.codex.container_executable, '/opt/agent-tools/codex/0.166.0/bin/codex');

  const pruned = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', { retain_count: 2 });
  assert.equal(pruned.status.retain_count, 2);

  // Record actual CLI version on a role run and verify /api/tasks/:id/roles surfaces cli_version.
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  const rolesView = roleApi(store, projAdmin, 'GET', new URL('http://local/api/tasks/t1/roles'), {});
  assert.equal(rolesView.runs.length, 1);
  assert.equal(rolesView.runs[0].cli_version, '0.166.0');
  assert.deepEqual(activeCliVersions(store, 'codex'), ['0.166.0']);

  // While run is active on 0.166.0, installing newer versions with retain_count=1 and calling prune MUST retain 0.166.0!
  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'codex',
    version: '0.167.0',
    retain_count: 1,
  });
  assert.deepEqual(inspectAgentTools(root, { arch: 'x64' }).clis.codex.compatible_versions, ['0.167.0', '0.166.0']);
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);

  const prunedWhileRunning = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', {
    cli: 'codex',
    retain_count: 1,
  });
  assert.deepEqual(prunedWhileRunning.pruned.codex, []);
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);

  // Installing an out-of-range version (1.0.0) while retain_count=1 compatible versions exist MUST NOT delete 1.0.0 during install!
  const outOfRangeInstall = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'codex',
    version: '1.0.0',
    retain_count: 1,
  });
  assert.equal(outOfRangeInstall.compatible, false);
  assert.equal(existsSync(join(root, 'codex', '1.0.0', 'bin', 'codex')), true);
  assert.deepEqual(outOfRangeInstall.status.clis.codex.incompatible_versions, ['1.0.0']);

  // Once the active run finishes, pruning with retain_count=1 removes both 0.166.0 and out-of-range 1.0.0, keeping newest compatible 0.167.0.
  endRun(store, run, 'completed', null);
  assert.deepEqual(activeCliVersions(store, 'codex'), []);
  const prunedAfterFinish = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', {
    cli: 'codex',
    retain_count: 1,
  });
  assert.deepEqual(prunedAfterFinish.pruned.codex.sort(), ['0.166.0', '1.0.0']);
  assert.deepEqual(prunedAfterFinish.status.clis.codex.compatible_versions, ['0.167.0']);
  assert.deepEqual(prunedAfterFinish.status.clis.codex.incompatible_versions, []);

  // Production runRole path records cli_version automatically via session_bound / harnessBinding.
  registerRoleHarness(
    {
      id: 'cli-version-probe-705',
      version: '1',
      session: 'external_session',
      events: 'probe_events',
      kinds: ['writer', 'observer', 'evaluator'],
      externalModel: true,
      capabilities: {
        raw_evidence: 'control_plane_tools',
        cancel: 'protocol_then_kill',
        isolation: 'none',
        version_binding: true,
        output_validation: true,
        fresh_context: true,
        recovery: ['rebuilt_from_task_records'],
      },
    },
    spec => async () => {
      spec.onHarnessEvent?.({ type: 'session_bound', sessionRef: 's1', recoveryMode: 'new_session', version: '0.167.0' });
      return spec.finish.validate({ summary: 'done', findings: [], inspected_scope: ['README.md'], unknowns: [] });
    },
  );
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t2','r','task.request','running','probe','{}',1,1)");
  new TaskRecords(store).contract('t2', { goal: 'probe', scope: ['README.md'], criteria: ['record cli version'], endpoint: 'artifact' });
  const rolesUrl = new URL('http://local/api/repositories/r/roles');
  roleApi(store, projAdmin, 'PUT', rolesUrl, {
    expected_revision: roleApi(store, projAdmin, 'GET', rolesUrl, {}).revision,
    enabled: true,
    roles: [{ role_id: 'reviewer', harness_ref: { id: 'cli-version-probe-705' } }],
  });
  const finishTool = { type: 'function', function: { name: 'finish', description: 'finish', parameters: { type: 'object', additionalProperties: true } } };
  await runRole(
    {
      store,
      task: store.get("SELECT * FROM tasks WHERE id='t2'"),
      redactor: new Redactor(),
      guard: async () => {},
      system: 'sys',
      prompt: '{}',
      tools: [finishTool],
      finish: { name: 'finish', validate: v => v },
      maxTurns: 4,
    },
    'reviewer',
  );
  const probeRun = store.get("SELECT cli_version FROM task_runs WHERE task_id='t2' AND role='reviewer'");
  assert.equal(probeRun.cli_version, '0.167.0');
});

test('project computer recreates once to mount /opt/agent-tools read-only and manager rejects invalid agent-tools volumes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const docker = new FakeDocker();
  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(() => projects.db.close());

  // 1. Existing project computer created before /opt/agent-tools volume was mounted on manager.
  await projects.register('101');
  await projects.operate('101', 'start', { operation_id: hex48(), generation: 1 });
  const createdBefore = docker.created;
  const containerName = projects.names('101', 1).container;
  assert.equal(docker.containers.get(containerName).HostConfig.Mounts.some(m => m.Target === '/opt/agent-tools'), false);

  // 2. Deployment upgrades so manager now has agent-tools mounted at /opt/agent-tools:
  //    existing project computer is recreated ONCE to attach /opt/agent-tools read-only while keeping /workspace!
  docker.toolsMount = '/opt/agent-tools';
  await projects.operate('101', 'start', { operation_id: hex48(), generation: 1 });
  assert.equal(docker.created, createdBefore + 1);
  const mountsAfterUpgrade = docker.containers.get(containerName).HostConfig.Mounts;
  assert.deepEqual(
    mountsAfterUpgrade.find(m => m.Target === '/opt/agent-tools'),
    { Type: 'volume', Source: 'fixture-agent-tools', Target: '/opt/agent-tools', ReadOnly: true },
  );
  assert.ok(mountsAfterUpgrade.some(m => m.Target === '/workspace' && m.Source === projects.names('101', 1).volume));

  // 3. Subsequent provisions (e.g. after installing new CLI versions into the volume) do NOT recreate the container!
  await projects.operate('101', 'start', { operation_id: hex48(), generation: 1 });
  assert.equal(docker.created, createdBefore + 1);

  // 4. Every other deployment/project volume (including Compose underscore-prefixed ones and unlabeled agent-tools) is refused by manager!
  for (const badMount of [
    { name: 'dbot-fixture-101-notes', labels: { 'department.bot.kind': 'notes' } },
    { name: 'dbot-fixture-101-g1-work', labels: { 'department.bot.kind': 'volume' } },
    { name: 'myproject_assistant-homes', labels: { 'com.docker.compose.volume': 'assistant-homes' } },
    { name: 'myproject_bot-data', labels: { 'com.docker.compose.volume': 'bot-data' } },
    { name: 'myproject_bot-keys', labels: { 'com.docker.compose.volume': 'bot-keys' } },
    { name: 'myproject_internal-keys', labels: { 'com.docker.compose.volume': 'internal-keys' } },
    { name: 'myproject_manager-data', labels: { 'com.docker.compose.volume': 'manager-data' } },
    { name: 'myproject_tunnel-keys', labels: { 'com.docker.compose.volume': 'tunnel-keys' } },
    { name: 'myproject_agent-tools', labels: {} },
  ]) {
    docker.toolsVolumeName = badMount.name;
    docker.toolsVolumeLabels = badMount.labels;
    await assert.rejects(() => projects.agentToolsVolume(), /agent_tools_volume_invalid/, `manager must reject ${badMount.name}`);
  }
});

const toolApiScaffold = async (t, prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const tools = new AgentToolManager({ volumeRoot: root, containerRoot: '/opt/agent-tools', arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");
  return { root, tools, store, upstream, superUser: { id: 'u-super', role: 'super_admin', repositories: [] } };
};

test('reinstalling the CLI version an active run is using is refused with 409 and leaves the install untouched (#735)', async t => {
  const { root, tools, store, superUser } = await toolApiScaffold(t, 'agent-tools-in-use-');

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  const versionDir = join(root, 'codex', '0.166.0');
  const sentinel = join(versionDir, 'SENTINEL');
  writeFileSync(sentinel, 'must survive');
  const manifestBefore = readFileSync(join(versionDir, 'manifest.json'));

  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 }),
    { status: 409, code: 'agent_tool_version_in_use' },
    'reinstalling the version an active run holds is refused, not mapped to 503',
  );
  assert.equal(existsSync(sentinel), true, 'the in-use directory must not be removed before the replacement is ready');
  assert.deepEqual(readFileSync(join(versionDir, 'manifest.json')), manifestBefore, 'the in-use manifest is byte-for-byte unchanged');

  // A version that no run holds can still be installed next to the in-use one.
  const other = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.167.0', retain_count: 2 });
  assert.equal(other.installed.version, '0.167.0');

  // Once the run finishes the same request is allowed again and really reinstalls.
  endRun(store, run, 'completed', null);
  const again = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  assert.equal(again.installed.version, '0.166.0');
  assert.equal(existsSync(sentinel), false, 'the reinstall after the run finished replaces the directory');
});

test('a claude install that would replace the Node runtime an active claude run uses is refused with 409 (#735)', async t => {
  const { root, tools, store, superUser } = await toolApiScaffold(t, 'agent-tools-node-in-use-');

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'claude_code', version: '2.1.319', retain_count: 2 });
  const nodeDir = join(root, 'node', '22.15.0');
  const sentinel = join(nodeDir, 'SENTINEL');
  writeFileSync(sentinel, 'node must survive');
  const nodeBinBefore = readFileSync(join(nodeDir, 'bin', 'node'));

  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  recordRunCliVersion(store, run.id, '2.1.319');

  // A reusable Node runtime is left alone: another claude version still installs beside the active one.
  const reused = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'claude_code', version: '1.9.0', retain_count: 2 });
  assert.equal(reused.installed.version, '1.9.0');
  assert.equal(existsSync(sentinel), true, 'the reusable Node runtime is not touched');

  // An invalid Node manifest sends the next claude install down the replace path.
  rmSync(join(nodeDir, 'manifest.json'));

  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'claude_code', version: '2.1.310', retain_count: 2 }),
    { status: 409, code: 'agent_tool_version_in_use' },
    'replacing the Node runtime an active claude run depends on is refused',
  );
  assert.equal(existsSync(sentinel), true, 'the Node directory is not removed');
  assert.deepEqual(readFileSync(join(nodeDir, 'bin', 'node')), nodeBinBefore, 'the Node binary is byte-for-byte unchanged');
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310')), false, 'the refused install leaves nothing behind');
});

test('a run admitted while the download is in flight still blocks the replacement (#735)', async t => {
  const { root, tools, store, upstream, superUser } = await toolApiScaffold(t, 'agent-tools-admit-');

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  const versionDir = join(root, 'codex', '0.166.0');
  const sentinel = join(versionDir, 'SENTINEL');
  writeFileSync(sentinel, 'must survive');
  const manifestBefore = readFileSync(join(versionDir, 'manifest.json'));
  const inodeBefore = statSync(versionDir).ino;

  // Nothing is active when install() starts; the run is admitted while the codex archive is being downloaded, so only
  // the check at the replacement point can see it.
  let admitted = null;
  upstream.setBeforeCodexDownload(version => {
    if (version !== '0.166.0' || admitted) return;
    admitted = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
    store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", admitted.id);
    recordRunCliVersion(store, admitted.id, '0.166.0');
  });

  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 }),
    { status: 409, code: 'agent_tool_version_in_use' },
    'the replacement is refused even though the entry check saw no active run',
  );
  upstream.setBeforeCodexDownload(null);
  assert.notEqual(admitted, null, 'the mock admitted the run during the download');
  assert.equal(existsSync(sentinel), true, 'the in-use directory is not removed by the in-flight install');
  assert.deepEqual(readFileSync(join(versionDir, 'manifest.json')), manifestBefore, 'the in-use manifest is byte-for-byte unchanged');
  assert.equal(statSync(versionDir).ino, inodeBefore, 'the in-use directory is the same inode, never replaced');

  endRun(store, admitted, 'completed', null);
  const again = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  assert.equal(again.installed.version, '0.166.0');
  assert.equal(existsSync(sentinel), false, 'after the run finished the replacement really happens');
});


test('prune keeps a protected version whose manifest is no longer readable and reports it instead of deleting it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  // The running task executes 0.166.0 while that directory's manifest has become unreadable. The directory is still
  // the one the run executes, so the sweep must keep it and report it, not delete it as a broken leftover.
  writeFileSync(join(root, 'codex', '0.166.0', 'manifest.json'), '{"schema":');
  const pruned = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.codex, ['0.166.0']);
  assert.deepEqual(pruned.pruned.codex, []);
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);
});

test('the directory kept for an active run is cleared by the next prune once that run ends', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-invalid-after-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');
  writeFileSync(join(root, 'codex', '0.166.0', 'manifest.json'), '{"schema":');

  const kept = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(kept.protected_invalid.codex, ['0.166.0']);
  assert.equal(existsSync(join(root, 'codex', '0.166.0')), true);

  // Nothing protects the directory once the run is over, so the very next sweep clears it and reports nothing left.
  endRun(store, run, 'completed', null);
  const after = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(after.protected_invalid.codex, []);
  assert.deepEqual(after.pruned.codex, []);
  assert.equal(existsSync(join(root, 'codex', '0.166.0')), false);
});

test('prune keeps the Node runtime a protected claude_code directory can no longer name', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-node-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  // The JS-package claude_code version launches through the bundled Node runtime, named only in its manifest.
  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '2.1.310');

  // The run executes 2.1.310 and its manifest has become unreadable, so nothing can say which Node runtime it needs.
  // Keeping the directory but deleting that runtime would still take the binary away from the run.
  writeFileSync(join(root, 'claude_code', '2.1.310', 'manifest.json'), '{"schema":');
  const pruned = await manager.prune({ cli: 'claude_code', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.claude_code, ['2.1.310']);
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310', 'bin', 'claude')), true);
  assert.equal(existsSync(join(root, 'node', '22.15.0', 'bin', 'node')), true, 'the Node runtime the kept directory executes is kept too');

  // With the run over, the directory goes and the runtime it was the last user of goes with it.
  endRun(store, run, 'completed', null);
  const after = await manager.prune({ cli: 'claude_code', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(after.protected_invalid.claude_code, []);
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310')), false);
  assert.equal(existsSync(join(root, 'node', '22.15.0')), false);
});

test('a broken version no run holds is still cleared while the protected one is kept', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-and-broken-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  // Two directories stopped parsing: one is executed by the run, the other is a broken leftover no run points at.
  writeFileSync(join(root, 'codex', '0.166.0', 'manifest.json'), '{"schema":');
  writeFileSync(join(root, 'codex', '0.167.0', 'manifest.json'), '{"schema":');
  const pruned = await manager.prune({ cli: 'codex', retainCount: 2, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.codex, ['0.166.0'], 'only the protected directory is reported');
  assert.deepEqual(pruned.pruned.codex, [], 'a leftover broken directory is cleared silently, not reported as pruned');
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);
  assert.equal(existsSync(join(root, 'codex', '0.167.0')), false, 'the unprotected broken directory is still cleared');
});

test('a codex-only prune never reclaims Node runtimes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-node-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '2.1.310');
  writeFileSync(join(root, 'claude_code', '2.1.310', 'manifest.json'), '{"schema":');

  // Node runtimes are launched by claude_code alone and only its manifests name them, so a codex-only sweep cannot
  // know which runtime a kept claude_code directory executes. It must not walk node/ at all: the directory here is
  // protected and its manifest unreadable, exactly the case the claude_code pass keeps the runtime for.
  const pruned = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.pruned.codex, ['0.166.0']);
  assert.deepEqual(pruned.protected_invalid.codex, [], 'the claude_code directory is not the codex pass to judge');
  assert.equal(existsSync(join(root, 'node', '22.15.0', 'bin', 'node')), true, 'a codex-only prune leaves the Node runtimes alone');
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310', 'bin', 'claude')), true, 'the claude_code directory is untouched by it too');
});

test('an unreadable manifest still names the Node runtime to keep', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-node-lenient-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  // A second runtime left behind by an earlier claude_code install, which nothing on the volume references any more.
  mkdirSync(join(root, 'node', '23.9.9', 'bin'), { recursive: true });
  writeFileSync(join(root, 'node', '23.9.9', 'bin', 'node'), '');
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '2.1.310');

  // The manifest stopped parsing, but its text still names the runtime the directory launches. Reading that name out of
  // the raw file keeps exactly one runtime instead of keeping every runtime on the volume for one more sweep.
  writeFileSync(join(root, 'claude_code', '2.1.310', 'manifest.json'), '{"schema": "broken", "node_version": "22.15.0", ');
  const pruned = await manager.prune({ cli: 'claude_code', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.claude_code, ['2.1.310']);
  assert.equal(existsSync(join(root, 'node', '22.15.0', 'bin', 'node')), true, 'the runtime the manifest text names is kept');
  assert.equal(existsSync(join(root, 'node', '23.9.9')), false, 'the runtime nothing names is still reclaimed');
});

test('install verifies optional native_sha256 for claude_code and sweeps leftover .staging directories on install and prune', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-native-sha-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', libc: 'glibc', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };

  // Leftover .staging directory from an interrupted process is swept automatically on install.
  mkdirSync(join(root, '.staging', 'interrupted-claude-run'), { recursive: true });
  writeFileSync(join(root, '.staging', 'interrupted-claude-run', 'partial.bin'), 'stale');

  await assert.rejects(
    () => agentToolsApi(store, manager, superUser, 'POST', '/api/agent-tools/install', {
      cli: 'codex',
      version: '0.166.0',
      native_sha256: 'a'.repeat(64),
    }),
    { status: 400, code: 'invalid_agent_tool_native_sha256' },
  );

  await assert.rejects(
    () => agentToolsApi(store, manager, superUser, 'POST', '/api/agent-tools/install', {
      cli: 'claude_code',
      version: '2.1.319',
      native_sha256: 'f'.repeat(64),
    }),
    { status: 502, code: 'agent_tool_hash_mismatch' },
  );
  assert.equal(existsSync(join(root, 'claude_code', '2.1.319')), false);
  assert.equal(existsSync(join(root, '.staging', 'interrupted-claude-run')), false, 'install swept stale .staging directory');

  const expectedNativeSha256 = upstream.claudeVersions.get('2.1.319').glibcNativeHash.sha256;
  const installed = await agentToolsApi(store, manager, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'claude_code',
    version: '2.1.319',
    native_sha256: expectedNativeSha256,
  });
  assert.equal(installed.compatible, true);
  assert.equal(installed.status.clis.claude_code.selected_version, '2.1.319');

  // Leftover .staging directory is also swept during prune.
  mkdirSync(join(root, '.staging', 'another-crashed-stage'), { recursive: true });
  writeFileSync(join(root, '.staging', 'another-crashed-stage', 'partial.bin'), 'stale');
  await manager.prune({ retainCount: 2 });
  assert.equal(existsSync(join(root, '.staging', 'another-crashed-stage')), false);
  assert.equal(existsSync(join(root, 'claude_code', '2.1.319', 'bin', 'claude')), true);
});

function buildSyntheticElf64WithInterp(interp) {
  const interpBytes = Buffer.from(interp + '\0', 'utf8');
  const hdrSize = 64;
  const phdrSize = 56;
  const interpOffset = hdrSize + phdrSize;
  const buf = Buffer.alloc(interpOffset + interpBytes.length);
  // ELF magic + 64-bit little-endian
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  buf[4] = 2; // EI_CLASS = ELFCLASS64
  buf[5] = 1; // EI_DATA = ELFDATA2LSB
  buf[6] = 1; // EI_VERSION
  buf.writeBigUInt64LE(BigInt(hdrSize), 32); // e_phoff
  buf.writeUInt16LE(phdrSize, 54); // e_phentsize
  buf.writeUInt16LE(1, 56); // e_phnum
  // Program header 0: PT_INTERP (p_type = 3)
  buf.writeUInt32LE(3, hdrSize);
  buf.writeBigUInt64LE(BigInt(interpOffset), hdrSize + 8); // p_offset
  buf.writeBigUInt64LE(BigInt(interpBytes.length), hdrSize + 32); // p_filesz
  interpBytes.copy(buf, interpOffset);
  return buf;
}

test('detectElfInterpreterLibc and detectHostLibc avoid process.report.getReport event-loop stalls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tools-elf-libc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const glibcElf = join(dir, 'node-glibc');
  writeFileSync(glibcElf, buildSyntheticElf64WithInterp('/lib64/ld-linux-x86-64.so.2'));
  assert.equal(detectElfInterpreterLibc(glibcElf), 'glibc');

  const muslX64Elf = join(dir, 'node-musl-x64');
  writeFileSync(muslX64Elf, buildSyntheticElf64WithInterp('/lib/ld-musl-x86_64.so.1'));
  assert.equal(detectElfInterpreterLibc(muslX64Elf), 'musl');

  const muslArm64Elf = join(dir, 'node-musl-arm64');
  writeFileSync(muslArm64Elf, buildSyntheticElf64WithInterp('/lib/ld-musl-aarch64.so.1'));
  assert.equal(detectElfInterpreterLibc(muslArm64Elf), 'musl');

  const nonElf = join(dir, 'not-an-elf');
  writeFileSync(nonElf, '#!/bin/sh\necho hi\n');
  assert.equal(detectElfInterpreterLibc(nonElf), null);

  const origGetReport = process.report?.getReport;
  if (process.report && typeof origGetReport === 'function') {
    process.report.getReport = () => {
      throw new Error('process.report.getReport must never be called by detectHostLibc or inspectAgentTools');
    };
    t.after(() => { process.report.getReport = origGetReport; });
  }

  const libc = detectHostLibc();
  assert.ok(libc === 'glibc' || libc === 'musl');
  const status = inspectAgentTools(dir, { arch: 'x64' });
  assert.equal(status.volume_present, true);
});

test('installCodex falls back to deterministic release URL when GitHub API is rate-limited and sha256 is pinned', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-codex-ratelimit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  upstream.setRateLimitGithubApi(true);
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });

  // Without a pinned sha256, rate-limited GitHub API must still fail rather than trusting an unverified archive.
  await assert.rejects(
    () => manager.install({ cli: 'codex', version: '0.166.0' }),
    { code: 'agent_tool_download_failed' },
  );

  // With a pinned sha256, a wrong digest is still rejected.
  await assert.rejects(
    () => manager.install({ cli: 'codex', version: '0.166.0', sha256: '0'.repeat(64) }),
    { code: 'agent_tool_hash_mismatch' },
  );

  // With the authentic pinned sha256, installation succeeds directly from the configured download origin,
  // even when process.umask(0o077) is active as in src/main.ts.
  const prevUmask = process.umask(0o077);
  t.after(() => { process.umask(prevUmask); });
  const expectedSha256 = upstream.codexVersions.get('0.166.0').hash.sha256;
  const out = await manager.install({ cli: 'codex', version: '0.166.0', sha256: expectedSha256 });
  assert.equal(out.compatible, true);
  assert.equal(out.installed.version, '0.166.0');
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);
  assert.equal(statSync(join(root, 'codex')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'codex', '0.166.0')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'codex', '0.166.0', 'bin')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'codex', '0.166.0', 'manifest.json')).mode & 0o777, 0o644);
  const claudeOut = await manager.install({ cli: 'claude_code', version: '2.1.319' });
  assert.equal(claudeOut.compatible, true);
  assert.equal(statSync(join(root, 'claude_code')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'claude_code', '2.1.319')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'claude_code', '2.1.319', 'bin')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'claude_code', '2.1.319', 'manifest.json')).mode & 0o777, 0o644);
  assert.equal(statSync(join(root, 'node')).mode & 0o777, 0o755);
});

test('install saves retain_count only after it succeeds, and a later prune without the field keeps using it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-retain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const tools = new AgentToolManager({ volumeRoot: root, containerRoot: '/opt/agent-tools', arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };
  const installed = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  assert.equal(installed.status.retain_count, 2, 'the install response reports the value it saved');
  assert.equal((await agentToolsApi(store, tools, superUser, 'GET', '/api/agent-tools', {})).retain_count, 2);
  // Installs that omit the field keep the saved default; a prune that omits it prunes to 2, not to the built-in 3.
  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.167.0' });
  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.165.0' });
  const pruned = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', { cli: 'codex' });
  assert.deepEqual(pruned.pruned.codex, ['0.165.0']);
  assert.equal(pruned.status.retain_count, 2);
});

test('a failed install or prune never changes the saved retain_count', async t => {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };
  const failing = { status: () => ({ clis: {} }),
    install: async () => { throw new TaskError('agent_tool_invalid'); },
    prune: async () => { throw new TaskError('agent_tool_invalid'); } };
  await assert.rejects(agentToolsApi(store, failing, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 }),
    { status: 400, code: 'agent_tool_invalid' });
  assert.equal(store.get('SELECT value FROM settings WHERE key=?', 'agent_tools.retain_count'), undefined);
  await assert.rejects(agentToolsApi(store, failing, superUser, 'POST', '/api/agent-tools/prune', { retain_count: 1 }),
    { status: 400, code: 'agent_tool_invalid' });
  assert.equal(store.get('SELECT value FROM settings WHERE key=?', 'agent_tools.retain_count'), undefined, 'a failed prune leaves no saved count behind');
  assert.equal((await agentToolsApi(store, failing, superUser, 'GET', '/api/agent-tools', {})).retain_count, 3);
});

test('a failed prune that finishes after a successful install does not overwrite the saved count', async t => {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };
  let release; const gate = new Promise(resolve => { release = resolve; });
  const tools = { status: () => ({ clis: {} }),
    install: async () => ({ installed: { cli: 'codex', version: '0.166.0' }, compatible: true, pruned: { claude_code: [], codex: [] }, protected_invalid: [] }),
    prune: async () => { await gate; throw new TaskError('agent_tool_invalid'); } };
  const pending = agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', { retain_count: 1 });
  const installed = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  assert.equal(installed.status.retain_count, 2);
  release();
  await assert.rejects(pending, { status: 400, code: 'agent_tool_invalid' });
  assert.equal(store.get('SELECT value FROM settings WHERE key=?', 'agent_tools.retain_count').value, '2');
});

test('#1260 unified product registry covers all third-party agents except Pi and every default version satisfies compatibility', () => {
  assert.deepEqual([...AGENT_TOOL_PRODUCTS], ['claude_code', 'codex', 'icode', 'workswarm']);
  assert.equal(AGENT_TOOL_PRODUCTS.includes('pi'), false, 'built-in Pi must not be in tool volume registry');
  for (const product of AGENT_PRODUCT_REGISTRY) {
    assert.equal(satisfiesProductVersion(product.id, product.defaultVersion, 'x64'), true, `${product.id}@${product.defaultVersion} must satisfy range`);
  }
});

test('#1260 installs iCode and WorkSwarm (via isolated acpBuilder + uv on volume), rejects tampered/unverified/unisolated builds', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-acp-1260-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');

  // Without acpBuilder, WorkSwarm fails closed with agent_tool_isolated_installer_required (never executes uv pip sync in control plane).
  const noBuilder = new AgentToolManager({ volumeRoot: root, containerRoot: '/opt/agent-tools', arch: 'x64', sources: upstream.sources });
  await assert.rejects(
    () => noBuilder.install({ cli: 'workswarm', version: '0.2.9' }),
    { code: 'agent_tool_isolated_installer_required' },
  );

  // Unverified ACP versions are rejected.
  await assert.rejects(() => noBuilder.install({ cli: 'icode', version: '9.9.9' }), { code: 'agent_tool_version_unverified' });
  await assert.rejects(() => noBuilder.install({ cli: 'workswarm', version: '9.9.9' }), { code: 'agent_tool_version_unverified' });

  // Tampered iCode archive is rejected and leaves no partial directory.
  upstream.setTamperICodeHash(true);
  await assert.rejects(() => noBuilder.install({ cli: 'icode', version: '0.36.0' }), { code: 'agent_tool_hash_mismatch' });
  assert.equal(existsSync(join(root, 'acp', 'icode', '0.36.0')), false);
  upstream.setTamperICodeHash(false);

  // Authentic iCode installation succeeds and sets selected pointer.
  const icodeOut = await noBuilder.install({ cli: 'icode', version: '0.36.0' });
  assert.equal(icodeOut.compatible, true);
  assert.equal(icodeOut.installed.version, '0.36.0');
  assert.equal(readFileSync(join(root, 'acp', 'icode', 'selected'), 'utf8').trim(), '0.36.0');
  assert.equal(noBuilder.status().clis.icode.available, true);
  assert.equal(noBuilder.status().clis.icode.selected_version, '0.36.0');

  // With isolated acpBuilder, WorkSwarm downloads uv into volume, verifies hashes, stages source, and delegates build.
  const mockBuilder = createMockAcpBuilder(root);
  const withBuilder = new AgentToolManager({
    volumeRoot: root,
    containerRoot: '/opt/agent-tools',
    arch: 'x64',
    sources: upstream.sources,
    acpBuilder: mockBuilder.builder,
  });

  upstream.setTamperWorkSwarmHash(true);
  await assert.rejects(() => withBuilder.install({ cli: 'workswarm', version: '0.2.9' }), { code: 'agent_tool_hash_mismatch' });
  assert.equal(mockBuilder.calls.length, 0, 'tampered wheel never reaches isolated builder');
  upstream.setTamperWorkSwarmHash(false);

  const wsOut = await withBuilder.install({ cli: 'workswarm', version: '0.2.9' });
  assert.equal(wsOut.compatible, true);
  assert.equal(wsOut.installed.version, '0.2.9');
  assert.equal(mockBuilder.calls.length, 1);
  assert.match(mockBuilder.calls[0].containerUvBin, /^\/opt\/agent-tools\/uv\/0\.13\.9\/bin\/uv$/);
  assert.match(mockBuilder.calls[0].containerSourceDir, /^\/opt\/agent-tools\/\.staging\/workswarm-src-0\.2\.9-/);
  assert.equal(withBuilder.status().uv_versions.includes('0.13.9'), true);
  assert.equal(withBuilder.status().clis.workswarm.available, true);
  assert.equal(withBuilder.status().clis.workswarm.selected_version, '0.2.9');
});

test('#1260 auto-install reconciles empty volume idempotently, respects opt-out/backoff, and honors manual remove across restarts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-auto-1260-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const mockBuilder = createMockAcpBuilder(root);
  let now = Date.parse('2026-11-23T00:00:00.000Z');
  const makeManager = (opts = {}) => new AgentToolManager({
    volumeRoot: root,
    containerRoot: '/opt/agent-tools',
    arch: 'x64',
    sources: upstream.sources,
    acpBuilder: mockBuilder.builder,
    clock: () => now,
    ...opts,
  });

  // 1. Opt-out disables auto-install completely (0 network requests).
  const disabled = makeManager({ autoInstallEnabled: false });
  const disabledRes = await disabled.reconcileAutoInstall();
  assert.equal(upstream.requestCount, 0);
  assert.deepEqual(disabledRes.installed, []);
  assert.equal(disabled.status().auto_install_enabled, false);

  // 2. Partial failure (codex returns 502) does not block claude_code, icode, workswarm; persists error & backoff.
  upstream.setFailProduct('codex', true);
  const mgr1 = makeManager({ autoInstallEnabled: true });
  const res1 = await mgr1.reconcileAutoInstall();
  assert.deepEqual(res1.installed.sort(), ['claude_code@2.1.319', 'icode@0.36.0', 'workswarm@0.2.9']);
  assert.equal(res1.failed.length, 1);
  assert.equal(res1.failed[0].product, 'codex');
  const st1 = mgr1.status();
  assert.equal(st1.clis.claude_code.available, true);
  assert.equal(st1.clis.icode.available, true);
  assert.equal(st1.clis.workswarm.available, true);
  assert.equal(st1.clis.codex.available, false);
  assert.equal(st1.clis.codex.auto_install_state, 'failed');
  assert.equal(st1.clis.codex.last_error, 'agent_tool_download_failed');
  assert.ok(st1.clis.codex.next_retry_at);

  // 3. Restart within backoff window skips all 4 agents (0 requests).
  upstream.resetRequestCount();
  upstream.setFailProduct('codex', false);
  const mgr2 = makeManager({ autoInstallEnabled: true });
  const res2 = await mgr2.reconcileAutoInstall();
  assert.equal(upstream.requestCount, 0, 'within backoff window, no downloads occur');
  assert.deepEqual(res2.installed, []);

  // 4. Advance clock past 5-minute backoff -> codex installs cleanly; next reconcile is 100% idempotent.
  now += 6 * 60_000;
  const res3 = await mgr2.reconcileAutoInstall();
  assert.deepEqual(res3.installed, ['codex@0.166.0']);
  assert.equal(mgr2.status().clis.codex.available, true);
  assert.equal(mgr2.status().clis.codex.last_error, null);

  upstream.resetRequestCount();
  const res4 = await makeManager({ autoInstallEnabled: true }).reconcileAutoInstall();
  assert.equal(upstream.requestCount, 0, 'idempotent second run does zero network downloads');
  assert.deepEqual(res4.installed, []);

  // 5. Whole-agent remove sets removed: true -> restart does NOT reinstall! Manual install clears removed.
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };

  const removed = await agentToolsApi(store, mgr2, superUser, 'POST', '/api/agent-tools/remove', { cli: 'icode' });
  assert.equal(removed.removed_agent, true);
  assert.deepEqual(removed.removed, ['0.36.0']);
  assert.equal(removed.status.clis.icode.available, false);
  assert.equal(removed.status.clis.icode.removed, true);
  assert.equal(removed.status.clis.icode.auto_install_state, 'removed');

  upstream.resetRequestCount();
  const afterRestart = await makeManager({ autoInstallEnabled: true }).reconcileAutoInstall();
  assert.equal(upstream.requestCount, 0, 'removed agent is NOT reinstalled on restart');
  assert.deepEqual(afterRestart.installed, []);

  const reinstalled = await agentToolsApi(store, makeManager(), superUser, 'POST', '/api/agent-tools/install', { cli: 'icode' });
  assert.equal(reinstalled.status.clis.icode.available, true);
  assert.equal(reinstalled.status.clis.icode.removed, false);

  // 6. AgentToolsAutoInstaller start/stop lifecycle runs cleanly without throwing.
  const runner = new AgentToolsAutoInstaller(makeManager({ autoInstallEnabled: false }));
  runner.start();
  runner.stop();
});

test('#1260 upgrade semantics, single-version vs whole-agent remove, in-use 409 protection, and ACP selected pointer protection', async t => {
  const { root, tools, store, superUser } = await toolApiScaffold(t, 'agent-tools-ops-1260-');

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0' });
  // Upgrade refuses same or lower version for CLIs.
  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/upgrade', { cli: 'codex', version: '0.166.0' }),
    { status: 400, code: 'agent_tool_invalid' },
  );
  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/upgrade', { cli: 'codex', version: '0.165.0' }),
    { status: 400, code: 'agent_tool_invalid' },
  );
  // Upgrade to strictly higher version succeeds.
  const upgraded = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/upgrade', { cli: 'codex', version: '0.167.0' });
  assert.equal(upgraded.status.clis.codex.selected_version, '0.167.0');

  // Single non-last version remove does NOT mark agent as removed.
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  recordRunCliVersion(store, run.id, '0.166.0');
  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/remove', { cli: 'codex', version: '0.166.0' }),
    { status: 409, code: 'agent_tool_version_in_use' },
  );
  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/remove', { cli: 'codex' }),
    { status: 409, code: 'agent_tool_version_in_use' },
  );
  endRun(store, run, 'completed', null);

  const singleDel = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/remove', { cli: 'codex', version: '0.166.0' });
  assert.equal(singleDel.removed_agent, false);
  assert.equal(singleDel.status.clis.codex.removed, false);
  assert.equal(singleDel.status.clis.codex.selected_version, '0.167.0');

  // Deleting the LAST remaining version marks removed: true.
  const lastDel = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/remove', { cli: 'codex', version: '0.167.0' });
  assert.equal(lastDel.removed_agent, true);
  assert.equal(lastDel.status.clis.codex.removed, true);

  // ACP selected pointer protection on prune and auto-switch/clear on single-version delete (F4).
  const { icodeReleases } = await import('../../../../runner/agent-products.mjs');
  const rel36 = icodeReleases.get('0.36.0');
  icodeReleases.set('0.35.0', { ...rel36, version: '0.35.0' });
  t.after(() => icodeReleases.delete('0.35.0'));

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'icode', version: '0.36.0' });
  // Create a synthetic older 0.35.0 ACP directory + manifest and select 0.35.0 to test selected protection.
  const acpBase = join(root, 'acp', 'icode');
  const olderDir = join(acpBase, '0.35.0');
  mkdirSync(join(olderDir, 'bin'), { recursive: true });
  writeFileSync(join(olderDir, 'bin', 'icode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const manifest36 = JSON.parse(readFileSync(join(acpBase, '0.36.0', 'manifest.json'), 'utf8'));
  writeFileSync(join(olderDir, 'manifest.json'), JSON.stringify({ ...manifest36, version: '0.35.0' }, null, 2));
  writeFileSync(join(acpBase, 'selected'), '0.35.0\n');

  const prunedAcp = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', { cli: 'icode', retain_count: 1 });
  assert.equal(existsSync(olderDir), true, 'ACP selected version 0.35.0 is protected from prune');
  assert.equal(readFileSync(join(acpBase, 'selected'), 'utf8').trim(), '0.35.0');
  assert.deepEqual(prunedAcp.pruned.icode, []);

  // Deleting selected 0.35.0 -> auto-switches selected pointer to remaining 0.36.0!
  const delSelected = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/remove', { cli: 'icode', version: '0.35.0' });
  assert.equal(delSelected.removed_agent, false);
  assert.equal(readFileSync(join(acpBase, 'selected'), 'utf8').trim(), '0.36.0');
  assert.equal(delSelected.status.clis.icode.selected_version, '0.36.0');

  // Deleting last remaining 0.36.0 clears selected pointer and marks removed: true.
  const delLastAcp = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/remove', { cli: 'icode', version: '0.36.0' });
  assert.equal(delLastAcp.removed_agent, true);
  assert.equal(existsSync(join(acpBase, 'selected')), false);
});

test('#1260 manager installAcpProduct runs one-shot hardened container mounting ONLY agent-tools volume', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-acp-installer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = new FakeDocker();
  docker.toolsMount = '/opt/agent-tools';
  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(() => projects.db.close());

  let capturedContainerConfig = null;
  const origRequest = docker.request.bind(docker);
  docker.request = async (method, path, body, raw, timeout) => {
    if (path.startsWith('/containers/create')) capturedContainerConfig = body;
    return origRequest(method, path, body, raw, timeout);
  };

  const out = await projects.installAcpProduct({
    product: 'workswarm',
    version: '0.2.9',
    source_dir: '/opt/agent-tools/.staging/workswarm-src-0.2.9-abc123',
    uv_bin: '/opt/agent-tools/uv/0.13.9/bin/uv',
  });
  assert.equal(out.ok, true);
  assert.ok(capturedContainerConfig, 'installer container was created');
  assert.equal(capturedContainerConfig.Image, 'sha256:fixture');
  assert.equal(capturedContainerConfig.User, '10001:10001');
  assert.equal(capturedContainerConfig.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(capturedContainerConfig.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(capturedContainerConfig.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  // Security boundary (F1): ONLY agent-tools volume is mounted; ZERO control-plane secrets/DB/sockets!
  assert.deepEqual(capturedContainerConfig.HostConfig.Mounts, [
    { Type: 'volume', Source: 'fixture-agent-tools', Target: '/opt/agent-tools', ReadOnly: false },
  ]);
  assert.ok(capturedContainerConfig.HostConfig.NetworkMode.includes('build'), 'uses isolated build egress network, never control network');
  assert.equal(docker.containers.size, 0, 'one-shot installer container is removed after exit');

  // Path traversal in source_dir or uv_bin is rejected.
  await assert.rejects(
    () => projects.installAcpProduct({ product: 'workswarm', version: '0.2.9', source_dir: '/keys/master.key', uv_bin: '/opt/agent-tools/uv/0.13.9/bin/uv' }),
    /invalid_input/,
  );
  await assert.rejects(
    () => projects.installAcpProduct({ product: 'workswarm', version: '0.2.9', source_dir: '/opt/agent-tools/.staging/../keys', uv_bin: '/opt/agent-tools/uv/0.13.9/bin/uv' }),
    /invalid_input/,
  );
});

test('#1260 /api/environments/:id/cli-config proxies to manager without storing or echoing file contents in control plane', async t => {
  const { ProjectService } = await import('../../../../dist/projects/service.js');
  const { inspectCliConfigs, writeCliConfig, deleteCliConfig } = await import('../../../../runner/cli-config.mjs');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cli-config-api-'));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('101','org/repo','org','a')");
  store.run("INSERT INTO policies(repository_id,enabled) VALUES('101',1)");

  const manager = {
    async call(method, path, body) {
      if (path === '/v1/projects/101/cli-config') {
        if (method === 'GET') return { available: true, clis: await inspectCliConfigs(workspaceRoot) };
        if (method === 'PUT') return await writeCliConfig(workspaceRoot, body.cli, body.file, body.content);
        if (method === 'DELETE') return await deleteCliConfig(workspaceRoot, body.cli, body.file);
      }
      throw new Error(`unexpected manager call ${method} ${path}`);
    },
  };
  const service = new ProjectService(store, manager);
  const admin = { id: 'u-admin', role: 'super_admin', repositories: ['101'] };
  const viewer = { id: 'u-view', role: 'project_admin', repositories: ['101'] };
  const secretToken = 'sk-local-cli-secret-must-never-persist-1260';

  // Read-only viewer cannot write or delete CLI configs.
  await assert.rejects(
    () => service.api(viewer, 'PUT', new URL('http://local/api/environments/101/cli-config'), { cli: 'claude_code', file: '.credentials.json', content: secretToken }),
    { status: 403 },
  );

  // Admin writes config -> response contains metadata only, never content.
  const written = await service.api(admin, 'PUT', new URL('http://local/api/environments/101/cli-config'), {
    cli: 'claude_code',
    file: '.credentials.json',
    content: JSON.stringify({ accessToken: secretToken }),
  });
  assert.equal(written.exists, true);
  assert.equal(JSON.stringify(written).includes(secretToken), false);

  const status = await service.api(admin, 'GET', new URL('http://local/api/environments/101/cli-config'), {});
  assert.equal(status.available, true);
  assert.equal(status.clis.claude_code.configured, true);
  assert.equal(status.clis.claude_code.files['.credentials.json'].exists, true);
  assert.equal(JSON.stringify(status).includes(secretToken), false);

  // Control-plane SQLite (audit & settings) contains ZERO secret content.
  assert.equal(JSON.stringify(store.all('SELECT * FROM audit')).includes(secretToken), false);
  assert.equal(JSON.stringify(store.all('SELECT * FROM settings')).includes(secretToken), false);

  const deleted = await service.api(admin, 'DELETE', new URL('http://local/api/environments/101/cli-config'), {
    cli: 'claude_code',
    file: '.credentials.json',
  });
  assert.equal(deleted.exists, false);
  const afterDelete = await service.api(admin, 'GET', new URL('http://local/api/environments/101/cli-config'), {});
  assert.equal(afterDelete.clis.claude_code.configured, false);

  // Oversized content is rejected cleanly with 400 invalid_cli_config_content before hitting Docker/runner limits.
  await assert.rejects(
    () => service.api(admin, 'PUT', new URL('http://local/api/environments/101/cli-config'), {
      cli: 'claude_code',
      file: 'settings.json',
      content: JSON.stringify({ pad: 'x'.repeat(40 * 1024) }),
    }),
    err => err?.status === 400 && err?.message === 'invalid_cli_config_content',
  );
});

test('#1260 deleteCliConfig rejects symlinked parent directory and manager forwards content via env not argv', async t => {
  const { chmodSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { writeCliConfig, deleteCliConfig, MAX_CLI_CONFIG_BYTES } = await import('../../../../runner/cli-config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cli-config-sec-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'cli-config-outside-'));
  t.after(() => {
    try { chmodSync(join(dir, 'home', '.codex'), 0o700); } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // Symlink parent attack: project agent replaces /workspace/home/.claude with symlink to outside directory.
  const victim = join(outsideDir, 'settings.json');
  writeFileSync(victim, '{"keep":true}', 'utf8');
  mkdirSync(join(dir, 'home'), { recursive: true });
  symlinkSync(outsideDir, join(dir, 'home', '.claude'));
  await assert.rejects(
    () => deleteCliConfig(dir, 'claude_code', 'settings.json'),
    /unsafe_cli_config_path/,
  );
  assert.equal(existsSync(victim), true, 'symlink target outside /workspace/home must never be unlinked');

  // Failed unlink surfaces an error instead of returning exists: false (chmod 0500 only restricts non-root users).
  await writeCliConfig(dir, 'codex', 'config.toml', 'model = "gpt-5.4"\n');
  if (process.getuid?.() !== 0) {
    chmodSync(join(dir, 'home', '.codex'), 0o500);
    await assert.rejects(() => deleteCliConfig(dir, 'codex', 'config.toml'));
    chmodSync(join(dir, 'home', '.codex'), 0o700);
  }
  const removed = await deleteCliConfig(dir, 'codex', 'config.toml');
  assert.equal(removed.exists, false);

  // Manager forwards PUT content via BOT_CLI_CONFIG_B64 env (never in Cmd argv) and enforces MAX_CLI_CONFIG_BYTES.
  const mgrDir = mkdtempSync(join(tmpdir(), 'mgr-cli-cfg-'));
  t.after(() => rmSync(mgrDir, { recursive: true, force: true }));
  const docker = new FakeDocker();
  docker.cliConfigRoot = join(mgrDir, 'ws');
  const projects = new Projects({ database: join(mgrDir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(() => projects.db.close());
  await projects.register('101');
  await projects.operate('101', 'start', { operation_id: randomBytes(24).toString('hex'), generation: 1 });

  const secret = 'sk-env-not-argv-1260';
  const putRes = await projects.cliConfig('101', 'PUT', {
    cli: 'claude_code',
    file: 'settings.json',
    content: JSON.stringify({ env: { ANTHROPIC_API_KEY: secret } }),
  });
  assert.equal(putRes.exists, true);
  const writeCall = docker.runs.find(r => r.type === 'cli_config_write');
  assert.ok(writeCall, 'manager invoked cli_config_write');
  assert.equal(writeCall.content, undefined, 'config content must not be in runner argv JSON');
  assert.ok(
    Array.isArray(writeCall.extraEnv) && writeCall.extraEnv.some(e => e.startsWith('BOT_CLI_CONFIG_B64=')),
    'config content is forwarded via BOT_CLI_CONFIG_B64 env',
  );
  await assert.rejects(
    () => projects.cliConfig('101', 'PUT', { cli: 'codex', file: 'config.toml', content: 'x'.repeat(MAX_CLI_CONFIG_BYTES + 1) }),
    err => err?.status === 400 && err?.message === 'invalid_cli_config_content',
  );
});
