import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  assert.match(call.dockerfile, /RUN HOME=\/opt\/preinstalled\/home \/bin\/sh -eu -c '\. \/tmp\/bot-setup-env\.sh && \/bin\/sh -eu \/tmp\/bot-setup\.sh'/);
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
