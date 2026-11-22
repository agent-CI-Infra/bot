import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../../../../manager/projects.mjs';
import { ManagerError } from '../../../../manager/docker.mjs';
import { FakeDocker } from '../../../fixtures/fake-docker.mjs';
import { fail } from '../../../../dist/core/security.js';
import { harness, setup, account, repository, testPassword } from '../../../fixtures/helpers.mjs';
import { ManagementService } from '../../../../dist/management/service.js';
import { RuleService, computerRequest } from '../../../../dist/rules/service.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { resolvePrincipalActor } from '../../../../dist/identity/authorization.js';

const id = () => randomBytes(24).toString('hex');
const mib = 1024 * 1024;

function managerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'unified-api-'));
  const docker = new FakeDocker();
  docker.info = { NCPU: 8, MemTotal: 32768 * mib };
  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(async () => { await projects.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const route = async (method, path, input) => {
    if (path === '/v1/defaults') return method === 'PUT' ? projects.setDefaults(input) : projects.defaultsView();
    if (path === '/v1/defaults/build/cancel' && method === 'POST') return projects.cancelGlobalBuild();
    if (path === '/v1/precompiled-images' && method === 'GET') return projects.listPrecompiledImages();
    if (path === '/v1/precompiled-images/prune' && method === 'POST') return projects.prunePrecompiledImages([], { force: true });
    if (path === '/v1/storage') return projects.storage();
    const cancel = /^\/v1\/projects\/(\d+)\/build\/cancel$/.exec(path);
    if (cancel && method === 'POST') return projects.cancelBuild(cancel[1]);
    const match = /^\/v1\/projects\/(\d+)(?:\/(\w+))?$/.exec(path);
    if (!match) fail(404, 'not_found');
    const [, repo, action] = match;
    if (action === 'parallel') return projects.parallelism(repo, input.tasks);
    if (method === 'GET' && !action) return projects.describe(repo);
    if (method === 'PUT') return projects.register(repo);
    return projects.operate(repo, action, input);
  };
  const call = (method, path, input) => route(method, path, input).catch(error => error instanceof ManagerError ? fail(error.status, error.message) : Promise.reject(error));
  return { docker, projects, manager: { call } };
}

test('project admins can configure single-project software overlays and cancel builds, while resources, egress and global defaults stay super_admin only', async t => {
  const f = managerFixture(t);
  const h = await harness(t, f.manager);
  const { admin } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');
  for (let i = 0; i < 2; i++) await h.projects.reconcile();

  const password = testPassword();
  await admin('/api/users', 'POST', { username: 'proj-admin', password, role: 'project_admin', repository_ids: ['101'] });
  const member = h.client();
  await member('/api/auth/login', 'POST', { username: 'proj-admin', password });

  // Hold builds in flight so we can observe queued/building state and test manual cancel.
  let activeAbort = null;
  f.docker.onBuild = ({ tag, options }) => new Promise((resolve, reject) => {
    options?.onOutput?.(`building ${tag}\n`, `building ${tag}\n`);
    activeAbort = {
      succeed: () => {
        f.docker.images.set(tag, { Id: 'sha256:' + tag.split(':')[1], Size: 4 * mib });
        resolve(`building ${tag}\ndone\n`);
      },
    };
    options?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output: `building ${tag}\ncancelled` }));
    }, { once: true });
  });

  // Project admin is forbidden from changing resources/egress or another project or global defaults.
  for (const forbiddenSpec of [{ cpus: 4 }, { memory_mb: 8192 }, { pids: 2048 }, { tmp_mb: 2048 }, { egress: false }]) {
    assert.equal((await member('/api/environments/101/configure', 'POST', { operation_id: id(), generation: 1, spec: forbiddenSpec })).status, 403, JSON.stringify(forbiddenSpec));
  }
  assert.equal((await member('/api/environments/202/configure', 'POST', { operation_id: id(), generation: 1, spec: { packages: ['jq'] } })).status, 403);
  assert.equal((await member('/api/environments/202/build/cancel', 'POST', {})).status, 403);
  assert.equal((await member('/api/settings/computer-defaults/build/cancel', 'POST', {})).status, 403);
  assert.equal((await member('/api/storage/precompiled-images')).status, 403);

  // Project admin CAN configure project software overlay (packages + setup_script + env) and see live build progress.
  const cfg = await member('/api/environments/101/configure', 'POST', {
    operation_id: id(), generation: 1,
    spec: { packages: ['ripgrep'], setup_script: 'echo proj-sdk', env: { SDK_VERSION: '2' } },
  });
  assert.ok([200, 201].includes(cfg.status));
  await new Promise(r => setImmediate(r));
  const detail = await member('/api/environments/101');
  assert.equal(detail.status, 200);
  assert.equal(detail.value.environment.computer.build.state, 'building');
  assert.equal(detail.value.environment.computer.build.can_cancel, true);

  // Project admin CAN manually stop the build!
  const stopped = await member('/api/environments/101/build/cancel', 'POST', {});
  assert.ok([200, 201].includes(stopped.status));
  assert.equal(stopped.value.cancelled, true);
  await f.projects.waitForBuild('101');
  const afterCancel = await member('/api/environments/101');
  assert.equal(afterCancel.value.environment.computer.build.state, 'cancelled');

  // Super admin can update global defaults, cancel global builds, and inspect/prune precompiled images.
  const globalUpdate = await admin('/api/settings', 'PATCH', { computer_defaults: { packages: ['jq'], setup_script: 'echo global-sdk' } });
  assert.equal(globalUpdate.status, 200);
  await new Promise(r => setImmediate(r));
  activeAbort.succeed();
  await f.projects.waitForGlobalBuild();
  const images = await admin('/api/storage/precompiled-images');
  assert.equal(images.status, 200);
  const readyImages = images.value.images.filter(i => i.state === 'ready');
  assert.equal(readyImages.length, 1);
  assert.equal(readyImages[0].protected, true);
  const pruned = await admin('/api/storage/precompiled-images/prune', 'POST', {});
  assert.ok([200, 201].includes(pruned.status));
  // The cancelled unreferenced record is pruned while the protected global image is kept.
  assert.equal(pruned.value.removed.length, 1);
  assert.equal(pruned.value.kept, 1);
});

test('management assistant queries and commands enforce tiered permissions for global defaults and project environments', async t => {
  const f = managerFixture(t);
  const h = await harness(t, f.manager);
  const { admin } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');
  await h.projects.reconcile();

  const password = testPassword();
  await admin('/api/users', 'POST', { username: 'pa', password, role: 'project_admin', repository_ids: ['101'] });
  const superPrincipal = h.store.get("SELECT p.id FROM principals p JOIN users u ON u.id=p.user_id WHERE u.role='super_admin'").id;
  const memberPrincipal = h.store.get("SELECT p.id FROM principals p JOIN users u ON u.id=p.user_id WHERE u.username='pa'").id;
  const superActor = resolvePrincipalActor(h.store, superPrincipal, undefined, undefined, 'console');
  const memberActor = resolvePrincipalActor(h.store, memberPrincipal, undefined, undefined, 'console');

  const rules = new RuleService(h.store, f.manager);
  const tasks = new TaskCommands(h.store);
  const mgmt = new ManagementService(h.store, rules, tasks, f.manager);

  // Super admin queries global defaults and updates them via management_command.
  const defaultsBefore = await mgmt.query(superActor, { operation: 'get_computer_defaults', target: {}, arguments: {} });
  assert.ok(defaultsBefore.revision);
  const updateGlobal = await mgmt.submit(superActor, {
    operation: 'computer.update_defaults',
    target: { project_id: 'platform' },
    arguments: { packages: ['jq'], setup_script: 'echo global-tool', env: { GLOBAL_FLAG: 'on' } },
    expected_revision: defaultsBefore.revision,
    idempotency_key: id(),
    source_conversation: 'console:c1',
    source_message: 'm1',
  });
  assert.equal(updateGlobal.state, 'succeeded');
  await f.projects.waitForGlobalBuild();

  const images = await mgmt.query(superActor, { operation: 'list_precompiled_images', target: {}, arguments: {} });
  assert.equal(images.images.length, 1);

  // Project admin can read global defaults baseline (read-only) and get_environment, but cannot list_precompiled_images or update global defaults.
  const memberDefaults = await mgmt.query(memberActor, { operation: 'get_computer_defaults', target: {}, arguments: {} });
  assert.equal(memberDefaults.read_only, true);
  assert.deepEqual(memberDefaults.environment.packages, ['jq']);
  await assert.rejects(mgmt.query(memberActor, { operation: 'list_precompiled_images', target: {}, arguments: {} }), /super_admin_required|forbidden/);
  await assert.rejects(mgmt.submit(memberActor, {
    operation: 'computer.update_defaults',
    target: { project_id: 'platform' },
    arguments: { packages: ['curl'] },
    expected_revision: defaultsBefore.revision,
    idempotency_key: id(),
    source_conversation: 'console:c2',
    source_message: 'm2',
  }), /super_admin_required|forbidden/);

  // Project admin CAN configure project software overlay via environment.configure, but NOT cpus/egress.
  const envBefore = await mgmt.query(memberActor, { operation: 'get_environment', target: { project_id: '101' }, arguments: {} });
  await assert.rejects(mgmt.submit(memberActor, {
    operation: 'environment.configure',
    target: { project_id: '101' },
    arguments: { cpus: 4 },
    expected_revision: envBefore.revision,
    idempotency_key: id(),
    source_conversation: 'console:c2',
    source_message: 'm3',
  }), /super_admin_required|forbidden/);

  const projCfg = await mgmt.submit(memberActor, {
    operation: 'environment.configure',
    target: { project_id: '101' },
    arguments: { packages: ['ffmpeg'], setup_script: 'echo proj-tool' },
    expected_revision: envBefore.revision,
    idempotency_key: id(),
    source_conversation: 'console:c2',
    source_message: 'm4',
  });
  assert.equal(projCfg.state, 'succeeded');
  await f.projects.waitForBuild('101');
  const envAfter = await mgmt.query(memberActor, { operation: 'get_environment', target: { project_id: '101' }, arguments: {} });
  assert.deepEqual(envAfter.environment.computer.packages, ['ffmpeg', 'jq']);
  assert.equal(envAfter.environment.computer.build.state, 'ready');

  // Lifecycle reset reuses precompiled image.
  const resetReceipt = await mgmt.submit(memberActor, {
    operation: 'environment.lifecycle',
    target: { project_id: '101' },
    arguments: { action: 'reset' },
    expected_revision: envAfter.revision,
    idempotency_key: id(),
    source_conversation: 'console:c2',
    source_message: 'm5',
  });
  assert.equal(resetReceipt.state, 'succeeded');
  assert.equal(resetReceipt.result.environment.generation, 2);

  // Minor #3: non-super actor receives sanitized global_defaults (no raw global setup_script or env values).
  const memberEnv = envAfter.environment.computer;
  assert.equal(memberEnv.global_defaults.has_setup_script, true);
  assert.deepEqual(memberEnv.global_defaults.env_keys, ['GLOBAL_FLAG']);
  assert.equal(memberEnv.global_defaults.setup_script, undefined);
  assert.equal(memberEnv.global_defaults.env, undefined);
});

test('read-only project reader without config.write cannot configure or cancel builds, and console computer spec stays decoupled from merged globals across async builds', async t => {
  const f = managerFixture(t);
  const h = await harness(t, f.manager);
  const { admin } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');
  await h.projects.reconcile();

  // Create a project user whose scoped grant only has read capabilities (no config.write).
  const readerPw = testPassword();
  await admin('/api/users', 'POST', { username: 'proj-reader', password: readerPw, role: 'project_admin', repository_ids: ['101'] });
  const readerPrincipal = h.store.get("SELECT p.id FROM principals p JOIN users u ON u.id=p.user_id WHERE u.username='proj-reader'").id;
  h.store.run("UPDATE scoped_grants SET capabilities=? WHERE principal_id=?", JSON.stringify(['tasks.read', 'config.read']), readerPrincipal);
  const reader = h.client();
  await reader('/api/auth/login', 'POST', { username: 'proj-reader', password: readerPw });

  // Configure global defaults with secret-like env & setup_script and verify sanitization for non-super actors.
  await admin('/api/settings', 'PATCH', {
    computer_defaults: { packages: ['jq'], setup_script: 'echo internal-global-script', env: { GLOBAL_TOKEN_HINT: 'val-123' } },
  });
  await f.projects.waitForGlobalBuild();

  const readerDetail = await reader('/api/environments/101');
  assert.equal(readerDetail.status, 200);
  assert.equal(readerDetail.value.can_configure, false);
  const gd = readerDetail.value.environment.computer.global_defaults;
  assert.equal(gd.has_setup_script, true);
  assert.deepEqual(gd.env_keys, ['GLOBAL_TOKEN_HINT']);
  assert.equal(gd.setup_script, undefined);
  assert.equal(gd.env, undefined);

  // Read-only user is forbidden from BOTH configure and build/cancel (Blocking #8).
  assert.equal((await reader('/api/environments/101/configure', 'POST', { operation_id: id(), generation: 1, spec: { packages: ['ripgrep'] } })).status, 403);
  assert.equal((await reader('/api/environments/101/build/cancel', 'POST', {})).status, 403);

  // Blocking #3: consoleComputer() must NOT capture merged global packages/setup_script/env into project's own console spec,
  // and computerRequest(effective, live) must return null (no spurious reconfigure/restart).
  const rules = new RuleService(h.store, f.manager);
  const liveAfterGlobal = f.projects.describe('101').computer;
  const savedAfterGlobal = rules.consoleComputer('101', liveAfterGlobal);
  assert.deepEqual(savedAfterGlobal.packages, []);
  assert.equal(savedAfterGlobal.setup_script, '');
  assert.deepEqual(savedAfterGlobal.env, {});
  assert.equal(computerRequest(savedAfterGlobal, liveAfterGlobal), null);

  // Blocking #4: async configure via Console API commits to computer_console_specs once the build finishes
  // (spec_revision advances), so a later consoleComputer() + computerRequest() does NOT revert the project's spec.
  let releaseBuild;
  f.docker.onBuild = ({ tag }) => new Promise(resolve => {
    releaseBuild = () => {
      f.docker.images.set(tag, { Id: 'sha256:' + tag.split(':')[1], Size: 4 * mib });
      resolve('ok\n');
    };
  });
  const asyncCfg = await admin('/api/environments/101/configure', 'POST', {
    operation_id: id(), generation: 1,
    spec: { packages: ['ripgrep'], setup_script: 'echo async-proj', env: { PROJ_KEY: 'v1' } },
  });
  assert.ok([200, 201].includes(asyncCfg.status));
  await new Promise(r => setImmediate(r));
  // While building, computerRequest must suppress drift reconciliation.
  const liveBuilding = f.projects.describe('101').computer;
  assert.equal(liveBuilding.build.state, 'building');
  assert.equal(computerRequest(rules.consoleComputer('101', liveBuilding), liveBuilding), null);

  releaseBuild();
  await f.projects.waitForBuild('101');
  const liveReady = f.projects.describe('101').computer;
  assert.equal(liveReady.build.state, 'ready');
  assert.ok(liveReady.spec_revision > 0);
  // Detail read syncs computer_console_specs from the higher spec_revision.
  const adminDetail = await admin('/api/environments/101');
  assert.equal(adminDetail.status, 200);
  const syncedConsole = rules.consoleComputer('101', liveReady);
  assert.deepEqual(syncedConsole.packages, ['ripgrep']);
  assert.equal(syncedConsole.setup_script, 'echo async-proj');
  assert.deepEqual(syncedConsole.env, { PROJ_KEY: 'v1' });
  assert.equal(computerRequest(syncedConsole, liveReady), null, 'completed async build must not be reverted on next reconcile');
});
