import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../../../manager/projects.mjs';
import { AssistantComputers } from '../../../manager/assistant-computers.mjs';
import { createManagerServer } from '../../../manager/server.mjs';
import { ManagerError, tarFiles } from '../../../manager/docker.mjs';
import { generateLayerDockerfile, shellEnvScript } from '../../../manager/precompiled-images.mjs';
import { FakeDocker } from '../../fixtures/fake-docker.mjs';
import { ManagerClient } from '../../../dist/projects/service.js';

const hex = n => randomBytes(n).toString('hex');
const opId = () => hex(24);
const mib = 1024 * 1024;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'precompiled-'));
  const homes = join(dir, 'homes');
  mkdirSync(homes, { recursive: true });
  const docker = new FakeDocker();
  docker.homesMount = homes;
  docker.info = { NCPU: 8, MemTotal: 32768 * mib };
  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  const assistants = new AssistantComputers({
    docker, db: projects.db, deployment: 'fixture', image: 'approved', homes,
    globalEnvironment: () => projects.assistantGlobalEnvironment(),
  });
  t.after(async () => {
    await assistants.shutdown();
    await projects.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, homes, docker, projects, assistants };
}

test('security hardening: non-root setup_script, tar injection immunity, resource caps, no timeout, isolated build net, extended reservedEnv', async t => {
  const f = fixture(t);
  await f.projects.register('101');
  const configure = request => f.projects.operate('101', 'configure', { operation_id: opId(), generation: 1, request });

  // Extended reservedEnv blocks dynamic runner/shell injection variables.
  for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PYTHONPATH', 'BASH_ENV', 'UV_TOOL_BIN_DIR', 'CARGO_HOME']) {
    await assert.rejects(configure({ env: { [name]: '/tmp/evil' } }), /invalid_env/, name);
    await assert.rejects(f.projects.setDefaults({ env: { [name]: '/tmp/evil' } }), /invalid_env/, `global ${name}`);
  }

  // Attempt Dockerfile directive injection inside setup_script & env values.
  const hostileScript = 'USER 0\nRUN chmod +w /opt/runner/runner.mjs\necho ok';
  const hostileEnv = { MY_VAR: "a'b\nUSER 0\nRUN id" };
  await configure({ cpus: 3, memory_mb: 6144, packages: ['ripgrep'], setup_script: hostileScript, env: hostileEnv });
  await f.projects.waitForBuild('101');

  assert.equal(f.docker.buildCalls.length, 1);
  const call = f.docker.buildCalls[0];
  // Dockerfile never contains raw setup_script or env values; setup runs strictly as UID 10001 from tar-injected files.
  assert.ok(!call.dockerfile.includes('chmod +w /opt/runner'), 'setup_script must not be interpolated into Dockerfile');
  assert.ok(!call.dockerfile.includes("a'b"), 'env values must not be interpolated into Dockerfile');
  assert.match(call.dockerfile, /USER 10001:10001\nCOPY --chown=10001:10001 env\.sh \/tmp\/bot-setup-env\.sh\nCOPY --chown=10001:10001 setup\.sh \/tmp\/bot-setup\.sh/);
  assert.match(call.dockerfile, /RUN HOME=\/opt\/preinstalled\/home PREINSTALLED_DIR=\/opt\/preinstalled NPM_CONFIG_PREFIX=\/opt\/preinstalled\/npm-global UV_TOOL_DIR=\/opt\/preinstalled\/uv-tools UV_TOOL_BIN_DIR=\/opt\/preinstalled\/bin PYTHONUSERBASE=\/opt\/preinstalled\/python CARGO_HOME=\/opt\/preinstalled\/cargo GOPATH=\/opt\/preinstalled\/go \/bin\/sh -eu -c '\. \/tmp\/bot-setup-env\.sh && \/bin\/sh -eu \/tmp\/bot-setup\.sh'/);
  assert.equal(call.options.files['setup.sh'], hostileScript + '\n');
  assert.equal(call.options.files['env.sh'], shellEnvScript(hostileEnv));

  // Build resource limits match the project ceiling, with no swap and no build timeout (timeout === 0).
  assert.equal(call.options.timeout, 0);
  assert.equal(call.options.memory, 6144 * mib);
  assert.equal(call.options.memswap, 6144 * mib);
  assert.equal(call.options.cpuperiod, 100000);
  assert.equal(call.options.cpuquota, 300000);

  // Build uses dedicated ICC-disabled egress bridge network when egress is enabled.
  assert.equal(call.options.networkmode, 'dbot-fixture-build-egress');
  const buildNet = f.docker.networks.get('dbot-fixture-build-egress');
  assert.deepEqual(buildNet, {
    Labels: { 'department.bot.deployment': 'fixture', 'department.bot.kind': 'build' },
    Internal: false,
    Options: { 'com.docker.network.bridge.enable_icc': 'false' },
  });

  // When egress is disabled on the project, build networkmode switches to none.
  await configure({ egress: false, setup_script: 'echo offline' });
  await f.projects.waitForBuild('101');
  assert.equal(f.docker.buildCalls.at(-1).options.networkmode, 'none');

  // tarFiles produces valid multi-entry ustar archives containing both Dockerfile and setup.sh.
  const archive = tarFiles([{ name: 'Dockerfile', data: Buffer.from(generateLayerDockerfile({ fromImageId: 'sha256:base', hasSetupScript: true })) }, { name: 'setup.sh', data: Buffer.from('echo hi\n') }]);
  assert.ok(archive.includes(Buffer.from('Dockerfile')));
  assert.ok(archive.includes(Buffer.from('setup.sh')));
  assert.ok(archive.includes(Buffer.from('echo hi\n')));
});

test('two-level additive stacking: project overlays on top of global precompiled image without rebuilding global layer, and reset reuses cache', async t => {
  const f = fixture(t);
  await f.projects.register('101');

  // 1. Configure global defaults -> builds Level 1 global image.
  await f.projects.setDefaults({ packages: ['jq', 'ripgrep'], setup_script: 'echo global-tool', env: { SHARED: '1', OVER: 'global' } });
  await f.projects.waitForGlobalBuild();
  assert.equal(f.docker.buildCalls.length, 1);
  assert.match(f.docker.buildCalls[0].dockerfile, /^FROM sha256:fixture\n/);
  assert.match(f.docker.buildCalls[0].dockerfile, /-- jq ripgrep/);
  const globalImage = f.projects.currentGlobalImage();
  assert.ok(globalImage?.id && globalImage.tag.startsWith('department-bot-computer-precompiled:'));

  // 2. Project stacks extra package + setup_script + env -> Level 2 builds FROM global image with delta packages only.
  await f.projects.operate('101', 'configure', {
    operation_id: opId(), generation: 1,
    request: { packages: ['ffmpeg', 'jq'], setup_script: 'echo project-tool', env: { OVER: 'project', ONLY_PROJ: '2' } },
  });
  await f.projects.waitForBuild('101');
  assert.equal(f.docker.buildCalls.length, 2, 'global layer was reused without rebuilding');
  assert.match(f.docker.buildCalls[1].dockerfile, new RegExp(`^FROM ${globalImage.id}\\n`));
  assert.match(f.docker.buildCalls[1].dockerfile, /-- ffmpeg \\/);
  assert.ok(!f.docker.buildCalls[1].dockerfile.includes('jq'), 'global packages already in Level 1 are not reinstalled in Level 2');
  assert.equal(f.docker.buildCalls[1].options.files['setup.sh'], 'echo project-tool\n');
  assert.match(f.docker.buildCalls[1].options.files['env.sh'], /export OVER='project'/);
  assert.match(f.docker.buildCalls[1].options.files['env.sh'], /export SHARED='1'/);
  assert.match(f.docker.buildCalls[1].options.files['env.sh'], /export ONLY_PROJ='2'/);

  const described = f.projects.describe('101').computer;
  assert.deepEqual(described.packages, ['ffmpeg', 'jq', 'ripgrep']);
  assert.deepEqual(described.own.packages, ['ffmpeg', 'jq']);
  assert.deepEqual(described.global_defaults.packages, ['jq', 'ripgrep']);
  assert.deepEqual(described.env, { SHARED: '1', OVER: 'project', ONLY_PROJ: '2' });
  assert.equal(described.build.state, 'ready');
  assert.equal(described.setup.mode, 'precompiled');
  assert.equal(described.setup.state, 'succeeded');

  // 3. Reset reuses cached precompiled image: zero docker builds and zero runtime setup commands.
  const runsBefore = f.docker.runs.filter(r => r.type === 'command').length;
  await f.projects.operate('101', 'reset', { operation_id: opId(), generation: 1 });
  assert.equal(f.docker.buildCalls.length, 2);
  assert.equal(f.docker.runs.filter(r => r.type === 'command').length, runsBefore);
});

test('serial build queue (concurrency = 1), live streaming progress, single-flight dedup, and manual cancel leave running containers untouched', async t => {
  const f = fixture(t);
  await f.projects.register('101');
  await f.projects.register('202');
  await f.projects.register('303');
  const origImage101 = f.docker.containers.get(f.projects.names('101', 1).container).Image;

  let activeCount = 0, maxActive = 0;
  const gates = new Map();
  f.docker.onBuild = ({ tag, options }) => new Promise((resolve, reject) => {
    activeCount++;
    maxActive = Math.max(maxActive, activeCount);
    options?.onOutput?.(`building ${tag}...\n`, `building ${tag}...\n`);
    const onAbort = () => {
      activeCount--;
      reject(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true, output: `building ${tag}...\n[aborted]` }));
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    gates.set(tag, {
      emit: line => options?.onOutput?.(line, `building ${tag}...\n${line}`),
      succeed: () => {
        options?.signal?.removeEventListener('abort', onAbort);
        activeCount--;
        f.docker.images.set(tag, { Id: 'sha256:' + tag.split(':')[1], Size: 2 * mib });
        resolve(`building ${tag}...\ndone\n`);
      },
    });
  });

  // Start builds for 101 and 202 (different scripts) + 303 (same script as 202 -> single-flight!).
  const r101 = await f.projects.operate('101', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo sdk-101' } });
  const r202 = await f.projects.operate('202', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo shared-sdk' } });
  const r303 = await f.projects.operate('303', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo shared-sdk' } });
  await new Promise(r => setImmediate(r));

  assert.equal(maxActive, 1, 'concurrency is strictly capped at 1');
  assert.equal(r101.computer.build.can_cancel, true);
  assert.equal(f.projects.describe('101').computer.build.state, 'building');
  assert.equal(f.projects.describe('101').computer.build.can_cancel, true);
  assert.equal(f.projects.describe('202').computer.build.state, 'queued');
  assert.equal(f.projects.describe('202').computer.build.queue_position, 1);
  assert.equal(f.projects.describe('303').computer.build.state, 'queued');
  assert.equal(f.projects.describe('303').computer.build.queue_position, 1);

  // Live streaming output appears immediately in describe().
  const tag101 = f.docker.buildCalls[0].tag;
  gates.get(tag101).emit('downloading 45%...\n');
  assert.match(f.projects.describe('101').computer.build.output, /downloading 45%/);

  // Cancel 303 while queued (shared with 202): 303 cancels, 202 stays queued!
  const cancel303 = f.projects.cancelBuild('303');
  assert.equal(cancel303.cancelled, true);
  await f.projects.waitForBuild('303');
  assert.equal(f.projects.describe('303').computer.build.state, 'cancelled');
  assert.equal(f.projects.describe('202').computer.build.state, 'queued');

  // Cancel active build 101: aborts Docker build, leaves 101 running on original image, and starts queued 202!
  const cancel101 = f.projects.cancelBuild('101');
  assert.equal(cancel101.cancelled, true);
  await f.projects.waitForBuild('101');
  await new Promise(r => setImmediate(r));
  assert.equal(f.projects.describe('101').computer.build.state, 'cancelled');
  assert.equal(f.docker.containers.get(f.projects.names('101', 1).container).Image, origImage101, 'running container untouched on cancel');
  assert.equal(f.projects.own('101').setup_script, undefined, 'failed/cancelled spec not committed');

  // Now 202 is building!
  assert.equal(maxActive, 1);
  assert.equal(f.projects.describe('202').computer.build.state, 'building');
  const tag202 = f.docker.buildCalls[1].tag;
  gates.get(tag202).succeed();
  await f.projects.waitForBuild('202');
  assert.equal(f.projects.describe('202').computer.build.state, 'ready');
  assert.equal(f.docker.containers.get(f.projects.names('202', 1).container).Image, 'sha256:' + tag202.split(':')[1]);
});

test('assistant computers inherit global precompiled image, env, and unified defaults, and GC protects active images & parents', async t => {
  const f = fixture(t);
  await f.projects.register('101');
  const owner = hex(16);
  mkdirSync(join(f.homes, owner, 'home-1'), { recursive: true });

  // Update global defaults: resources + packages + setup_script + env.
  await f.projects.setDefaults({ cpus: 3, memory_mb: 6144, packages: ['ripgrep'], setup_script: 'echo global-v1', env: { TOOL_MODE: 'strict' } });
  await f.projects.waitForGlobalBuild();
  const globalV1 = f.projects.currentGlobalImage();
  assert.ok(globalV1?.id);

  // Assistant computer automatically acquires the global precompiled image, env, and unified resource defaults.
  const turn1 = await f.assistants.acquire(owner, { turn: 't1', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(turn1.computer.image, globalV1.id);
  assert.equal(turn1.computer.resources.cpus, 3);
  assert.equal(turn1.computer.resources.memory_mb, 6144);
  const asstContainer = f.docker.containers.get(f.assistants.name(owner));
  assert.ok(asstContainer.Config.Env.includes('TOOL_MODE=strict'));
  assert.ok(asstContainer.Config.Env.includes('BOT_PROJECT_ENV_KEYS=TOOL_MODE'));

  // Build project 101 overlay on top of globalV1 so globalV1 is a parent layer of 101's image.
  await f.projects.operate('101', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo proj-v1' } });
  await f.projects.waitForBuild('101');
  const projV1Tag = f.projects.describe('101').computer.build.tag;

  // Build a second global image (globalV2), leaving globalV1 still referenced by assistant & as parent of project 101.
  await f.projects.setDefaults({ setup_script: 'echo global-v2' });
  await f.projects.waitForGlobalBuild();
  const globalV2 = f.projects.currentGlobalImage();
  assert.notEqual(globalV2.id, globalV1.id);

  // Build an unreferenced third project image by configuring 101 to a new script, then pruning.
  await f.projects.operate('101', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo proj-v2' } });
  await f.projects.waitForBuild('101');
  const projV2Tag = f.projects.describe('101').computer.build.tag;

  // Release assistant turn & start next turn -> automatically switches to globalV2!
  await f.assistants.release(owner, { turn: 't1' });
  const turn2 = await f.assistants.acquire(owner, { turn: 't2', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(turn2.reused, false);
  assert.equal(turn2.computer.image, globalV2.id);

  // Now globalV1 and projV1 are unreferenced, while globalV2 and projV2 are protected!
  const beforeList = await f.projects.listPrecompiledImages(f.assistants.activeImages());
  assert.equal(beforeList.images.find(i => i.tag === globalV2.tag).protected, true);
  assert.equal(beforeList.images.find(i => i.tag === projV2Tag).protected, true);
  assert.equal(beforeList.images.find(i => i.tag === globalV1.tag).protected, false);
  assert.equal(beforeList.images.find(i => i.tag === projV1Tag).protected, false);

  const pruned = await f.projects.prunePrecompiledImages(f.assistants.activeImages(), { force: true });
  assert.deepEqual(pruned.removed.map(r => r.tag).sort(), [globalV1.tag, projV1Tag].sort());
  assert.ok(f.docker.images.has(globalV2.tag));
  assert.ok(f.docker.images.has(projV2Tag));
  assert.ok(!f.docker.images.has(globalV1.tag));
  assert.ok(!f.docker.images.has(projV1Tag));
});

test('manager HTTP server exposes precompiled image list, prune, and build cancel endpoints', async t => {
  const f = fixture(t);
  await f.projects.register('101');
  const token = randomBytes(32);
  const { server, recovered } = createManagerServer({ projects: f.projects, token, assistants: f.assistants });
  server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  await recovered;
  t.after(() => server.close());

  const client = new ManagerClient(`http://127.0.0.1:${server.address().port}`, token);
  const defaults = await client.call('PUT', '/v1/defaults', { packages: ['jq'] });
  assert.deepEqual(defaults.environment.packages, ['jq']);
  await f.projects.waitForGlobalBuild();

  const listed = await client.call('GET', '/v1/precompiled-images');
  assert.equal(listed.images.length, 1);
  assert.equal(listed.images[0].protected, true);

  const cancelledGlobal = await client.call('POST', '/v1/defaults/build/cancel', {});
  assert.equal(cancelledGlobal.cancelled, false);

  const cancelledProj = await client.call('POST', '/v1/projects/101/build/cancel', {});
  assert.equal(cancelledProj.cancelled, false);

  const pruned = await client.call('POST', '/v1/precompiled-images/prune', {});
  assert.equal(pruned.removed.length, 0);
});

test('project-computer.Dockerfile keeps runtime install prefixes unset in ENV while build RUN scopes them to /opt/preinstalled', () => {
  const dockerfile = readFileSync(new URL('../../../docker/project-computer.Dockerfile', import.meta.url), 'utf8');
  for (const name of ['NPM_CONFIG_PREFIX=', 'UV_TOOL_DIR=', 'UV_TOOL_BIN_DIR=', 'PYTHONUSERBASE=', 'CARGO_HOME=', 'GOPATH=']) {
    assert.ok(!dockerfile.includes(name), `runtime ENV must not set ${name}`);
  }
  assert.match(dockerfile, /PREINSTALLED_DIR=\/opt\/preinstalled/);
  assert.match(dockerfile, /PATH=\/opt\/preinstalled\/bin:/);
  const layer = generateLayerDockerfile({ fromImageId: 'sha256:base', hasSetupScript: true });
  assert.match(layer, /RUN HOME=\/opt\/preinstalled\/home PREINSTALLED_DIR=\/opt\/preinstalled NPM_CONFIG_PREFIX=\/opt\/preinstalled\/npm-global/);
});

test('single-flight build sharing isolates egress policy and resource ceilings, reusing cache only if earlier build succeeds', async t => {
  const f = fixture(t);
  await f.projects.register('101');
  await f.projects.register('202');
  await f.projects.register('303');
  await f.projects.operate('101', 'configure', { operation_id: opId(), generation: 1, request: { cpus: 1, memory_mb: 1024, egress: true } });
  await f.projects.operate('202', 'configure', { operation_id: opId(), generation: 1, request: { cpus: 4, memory_mb: 4096, egress: true } });
  await f.projects.operate('303', 'configure', { operation_id: opId(), generation: 1, request: { cpus: 4, memory_mb: 4096, egress: false } });

  const gates = [];
  f.docker.onBuild = ({ tag, options }) => new Promise((resolve, reject) => {
    gates.push({
      tag, options,
      fail: () => reject(Object.assign(new ManagerError('image_build_failed', 502), { output: 'oom\n' })),
      succeed: () => {
        f.docker.images.set(tag, { Id: 'sha256:' + tag.split(':')[1], Size: 2 * mib });
        resolve('ok\n');
      },
    });
  });

  // 101 starts building with cpus=1/1024MB, egress=true.
  await f.projects.operate('101', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo heavy-sdk' } });
  await new Promise(r => setImmediate(r));
  // 202 has identical script & egress=true, but HIGHER resources (4 CPU/4096MB): must NOT share 101's lower-ceiling building job!
  await f.projects.operate('202', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo heavy-sdk' } });
  // 303 has egress=false: must NOT share egress=true job either!
  await f.projects.operate('303', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo heavy-sdk' } });
  await new Promise(r => setImmediate(r));

  assert.equal(f.projects.describe('101').computer.build.state, 'building');
  assert.equal(f.projects.describe('202').computer.build.state, 'queued');
  assert.equal(f.projects.describe('303').computer.build.state, 'queued');

  // If 101 fails under its low ceiling (OOM), 202 still runs its own build with its 4 CPU/4096MB ceiling!
  gates[0].fail();
  await f.projects.waitForBuild('101');
  await new Promise(r => setImmediate(r));
  assert.equal(f.projects.describe('101').computer.build.state, 'failed');
  assert.equal(f.projects.describe('202').computer.build.state, 'building');
  assert.equal(gates[1].options.cpuquota, 400000);
  assert.equal(gates[1].options.memory, 4096 * mib);
  assert.equal(gates[1].options.networkmode, 'dbot-fixture-build-egress');

  gates[1].succeed();
  await f.projects.waitForBuild('202');
  await new Promise(r => setImmediate(r));
  // F5: 303 has egress=false so it MUST NOT reuse 202's egress=true image; it gets a distinct image key/tag and runs with networkmode=none.
  assert.equal(f.projects.describe('303').computer.build.state, 'building');
  assert.equal(gates.length, 3);
  assert.equal(gates[2].options.networkmode, 'none');
  assert.notEqual(gates[2].tag, gates[1].tag, 'egress=false must produce a distinct image tag from egress=true');
  gates[2].succeed();
  await f.projects.waitForBuild('303');
  assert.equal(f.projects.describe('202').computer.build.state, 'ready');
  assert.equal(f.projects.describe('303').computer.build.state, 'ready');

  // Sequential check: a new project with egress=false reuses 303's no-egress image, NOT 202's egress image.
  f.docker.onBuild = null;
  await f.projects.register('404');
  await f.projects.operate('404', 'configure', { operation_id: opId(), generation: 1, request: { egress: false, setup_script: 'echo heavy-sdk' } });
  assert.equal(f.projects.describe('404').computer.build.tag, gates[2].tag);
  assert.equal(f.docker.buildCalls.length, 3, 'reused cached egress=false image with zero extra builds');
});

test('recovery reconciles interrupted builds, base image upgrades invalidate stale global precompiled image, and corrupt rows / queued parents stay safe', async t => {
  const f = fixture(t);
  await f.projects.register('101');
  const owner = hex(16);
  mkdirSync(join(f.homes, owner, 'home-1'), { recursive: true });

  // Build a global precompiled image on approved base image.
  await f.projects.setDefaults({ packages: ['jq'], setup_script: 'echo global-base' });
  await f.projects.waitForGlobalBuild();
  const globalImg = f.projects.currentGlobalImage();
  assert.ok(globalImg?.id);

  // Start a project build and hold it mid-flight, then inspect prune protection for its parent (globalImg) while queued.
  await f.projects.register('202');
  const gates = [];
  f.docker.onBuild = ({ tag, options }) => new Promise((resolve, reject) => {
    gates.push({
      tag, options,
      succeed: () => {
        f.docker.images.set(tag, { Id: 'sha256:' + tag.split(':')[1], Size: 2 * mib });
        resolve('done\n');
      },
    });
    options?.signal?.addEventListener('abort', () => reject(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true })), { once: true });
  });
  await f.projects.operate('101', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo p101' } });
  await f.projects.operate('202', 'configure', { operation_id: opId(), generation: 1, request: { setup_script: 'echo p202' } });
  await new Promise(r => setImmediate(r));

  // Even if global_precompiled_image were cleared, 202's queued build still protects its parentImageId (globalImg) from prune.
  f.projects.db.prepare("DELETE FROM settings WHERE key='global_precompiled_image'").run();
  // Corrupt one spec_json row in precompiled_images: listPrecompiledImages must not throw.
  f.projects.db.prepare(
    "INSERT INTO precompiled_images(image_key, tag, kind, parent_image_id, base_image_id, spec_json, state, last_used_at, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run('corruptkey123456', 'department-bot-computer-precompiled:corruptkey123456', 'project', null, 'sha256:fixture', '{not-json', 'failed', new Date().toISOString(), new Date().toISOString());

  const listed = await f.projects.listPrecompiledImages();
  assert.equal(listed.images.find(i => i.tag === globalImg.tag).protected, true, 'parent of queued build must stay protected');
  assert.deepEqual(listed.images.find(i => i.image_key === 'corruptkey123456').spec, {});

  // Cancel both builds and restore global image record.
  f.projects.cancelBuild('101');
  f.projects.cancelBuild('202');
  await f.projects.waitForBuild('101');
  await f.projects.waitForBuild('202');
  f.docker.onBuild = null;

  // Simulate an unclean manager crash while builds were queued/building in SQLite.
  f.projects.db.prepare("UPDATE precompiled_images SET state='building' WHERE image_key=?").run(globalImg.image_key);
  f.projects.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('global_build', ?)").run(JSON.stringify({ state: 'building', can_cancel: true }));
  f.projects.db.prepare("UPDATE projects SET build=? WHERE repository_id='101'").run(JSON.stringify({ state: 'queued', can_cancel: true }));
  f.projects.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('global_precompiled_image', ?)").run(JSON.stringify(globalImg));

  // Recover with same base image first: interrupted builds are marked failed with build_interrupted and can_cancel=false.
  await f.projects.recover();
  assert.equal(f.projects.describe('101').computer.build.state, 'failed');
  assert.equal(f.projects.describe('101').computer.build.error, 'build_interrupted');
  assert.equal(f.projects.describe('101').computer.build.can_cancel, false);
  const globalAfterRecover = await f.projects.defaultsView();
  assert.equal(globalAfterRecover.build.state, 'failed');
  assert.equal(globalAfterRecover.build.error, 'build_interrupted');

  // Now simulate upgrading the approved base image to a new digest, hold the auto-rebuild, and run reconcileGlobalImage():
  let releaseUpgradeBuild;
  f.docker.onBuild = ({ tag }) => new Promise(resolve => {
    releaseUpgradeBuild = () => {
      f.docker.images.set(tag, { Id: 'sha256:' + tag.split(':')[1], Size: 4 * mib });
      resolve('rebuilt\n');
    };
  });
  f.docker.images.set('approved', { Id: 'sha256:upgraded-base-v2', Size: 10 * mib });
  await f.projects.reconcileGlobalImage();

  // Base image changed -> stale global_precompiled_image was invalidated immediately so assistant uses approved base while rebuilding!
  assert.equal(f.projects.currentGlobalImage(), null);
  const asstTurn = await f.assistants.acquire(owner, { turn: 't-upgraded', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(asstTurn.computer.image, 'approved');
  await f.assistants.release(owner, { turn: 't-upgraded' });

  // Finish the automatic global rebuild on top of upgraded-base-v2.
  releaseUpgradeBuild();
  await f.projects.waitForGlobalBuild();
  const rebuilt = f.projects.currentGlobalImage();
  assert.ok(rebuilt?.id);
  assert.equal(rebuilt.base_image_id, 'sha256:upgraded-base-v2');

  // Verify AssistantComputers.acquire falls back to approved base image if the precompiled image is deleted from Docker.
  f.docker.onBuild = null;
  f.docker.images.delete(rebuilt.id);
  f.docker.images.delete(rebuilt.tag);
  const fallbackTurn = await f.assistants.acquire(owner, { turn: 't-fallback', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(fallbackTurn.computer.image, 'approved');
});

test('F3 & F4: failed/cancelled global build does not retry in a 5s check loop, and stale image check validates stored image ID not just tag', async t => {
  const f = fixture(t);
  const owner = hex(16);
  mkdirSync(join(f.homes, owner, 'home-1'), { recursive: true });

  // F3: failing global build records backoff + attempt cap; repeated check() calls must NOT rebuild every 5s.
  let buildAttempts = 0;
  f.docker.onBuild = () => {
    buildAttempts++;
    return Promise.reject(Object.assign(new ManagerError('image_build_failed', 502), { output: 'bad package\n' }));
  };
  await f.projects.setDefaults({ packages: ['broken-pkg'], setup_script: 'exit 1' });
  await f.projects.waitForGlobalBuild();
  assert.equal(buildAttempts, 1);
  assert.equal((await f.projects.defaultsView()).build.state, 'failed');

  // Simulate multiple 5-second health checks AND concurrent reconcileGlobalImage calls: zero extra builds inside backoff!
  await Promise.all([f.projects.check(), f.projects.reconcileGlobalImage(), f.projects.reconcileGlobalImage()]);
  await f.projects.check();
  await f.projects.waitForGlobalBuild();
  assert.equal(buildAttempts, 1, 'check() must not immediately retry a failed global build');

  // Even advancing past backoff stops at the 3-attempt cap and never loops forever.
  for (let i = 0; i < 6; i++) {
    f.projects.globalReconcileState.nextRetryAt = 0;
    await f.projects.check();
    await f.projects.reconcilingGlobal;
    await f.projects.waitForGlobalBuild();
  }
  assert.equal(buildAttempts, 3, 'automatic reconcile retries are strictly capped at 3 attempts');

  // Cancelled global build is NEVER auto-retried by check().
  let cancelCount = 0;
  f.docker.onBuild = ({ options }) => new Promise((_resolve, reject) => {
    cancelCount++;
    options?.signal?.addEventListener('abort', () => reject(Object.assign(new ManagerError('image_build_cancelled', 409), { cancelled: true })), { once: true });
  });
  await f.projects.setDefaults({ packages: ['other-pkg'], setup_script: 'sleep 99' });
  await new Promise(r => setImmediate(r));
  f.projects.cancelGlobalBuild();
  await f.projects.waitForGlobalBuild();
  assert.equal(cancelCount, 1);
  await f.projects.check();
  await f.projects.check();
  assert.equal(cancelCount, 1, 'cancelled global build must never auto-retry on check()');

  // F4: stored image ID missing while tag was moved to a rebuilt image on the SAME approved base -> adopt new ID!
  f.docker.onBuild = null;
  await f.projects.setDefaults({ packages: ['jq'], setup_script: 'echo ok' });
  await f.projects.waitForGlobalBuild();
  const saved = f.projects.currentGlobalImage();
  assert.ok(saved?.id && saved?.tag);

  // Simulate tag moved to a new ID (sha256:rebuilt-moved-id) with matching base_image_id, while old saved.id was pruned!
  f.docker.images.delete(saved.id);
  f.docker.images.set(saved.tag, {
    Id: 'sha256:rebuilt-moved-id',
    Size: 3 * mib,
    Config: { Labels: { 'department.bot.base_image_id': saved.base_image_id } },
  });
  f.docker.images.set('sha256:rebuilt-moved-id', f.docker.images.get(saved.tag));

  const movedTurn = await f.assistants.acquire(owner, { turn: 't-moved', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(movedTurn.computer.image, 'sha256:rebuilt-moved-id', 'assistant must use verified existing ID, not deleted stored.id');
  await f.projects.reconcileGlobalImage();
  assert.equal(f.projects.currentGlobalImage().id, 'sha256:rebuilt-moved-id', 'reconcile updates stored id to match verified tag');
  await f.assistants.release(owner, { turn: 't-moved' });

  // Simulate tag belonging to a DIFFERENT base_image_id while stored.id is pruned -> assistant must fall back to approved base!
  f.docker.images.delete('sha256:rebuilt-moved-id');
  f.docker.images.set(saved.tag, {
    Id: 'sha256:wrong-base-img',
    Size: 3 * mib,
    Config: { Labels: { 'department.bot.base_image_id': 'sha256:old-stale-base' } },
  });
  const staleTurn = await f.assistants.acquire(owner, { turn: 't-stale-tag', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(staleTurn.computer.image, 'approved', 'assistant must fall back to approved base when stored.id is missing and tag has stale base_image_id');
  await f.assistants.release(owner, { turn: 't-stale-tag' });
});
