import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projects } from '../../../manager/projects.mjs';
import { AssistantComputers } from '../../../manager/assistant-computers.mjs';

function makeDockerMock({ volumeNameByTarget = {} } = {}) {
  const containers = new Map();
  const networks = new Map();
  const volumes = new Map([
    ['bot_skill-store', { Name: 'bot_skill-store', Labels: { 'department.bot.kind': 'skill-store' } }],
    ['bot_assistant-homes', { Name: 'bot_assistant-homes', Labels: { 'com.docker.compose.volume': 'assistant-homes' } }],
  ]);
  const createdConfigs = [];
  let seq = 0;
  return {
    containers,
    createdConfigs,
    async volumeName(target) {
      return volumeNameByTarget[target] ?? null;
    },
    async volumeSource() {
      return null;
    },
    async request(method, path, body) {
      if (method === 'GET' && path === '/info') return { NCPU: 8, MemTotal: 32 * 1024 ** 3 };
      if (method === 'GET' && path.startsWith('/images/')) {
        return { Id: 'sha256:base-image', Config: { Labels: { 'department.bot.toolchain': 'Node 22' } } };
      }
      if (method === 'GET' && path.startsWith('/volumes/')) {
        const name = decodeURIComponent(path.slice('/volumes/'.length));
        return volumes.get(name) ?? null;
      }
      if (method === 'POST' && path === '/volumes/create') {
        volumes.set(body.Name, { Name: body.Name, Labels: body.Labels ?? {} });
        return { Name: body.Name };
      }
      if (method === 'DELETE' && path.startsWith('/volumes/')) {
        const name = decodeURIComponent(path.slice('/volumes/'.length).split('?')[0]);
        volumes.delete(name);
        return null;
      }
      if (method === 'GET' && path.startsWith('/networks/')) {
        const name = decodeURIComponent(path.slice('/networks/'.length));
        return networks.get(name) ?? null;
      }
      if (method === 'POST' && path === '/networks/create') {
        networks.set(body.Name, { Name: body.Name, Internal: !!body.Internal, Options: body.Options ?? {}, Labels: body.Labels ?? {} });
        return { Id: body.Name };
      }
      if (method === 'DELETE' && path.startsWith('/networks/')) {
        const name = decodeURIComponent(path.slice('/networks/'.length));
        networks.delete(name);
        return null;
      }
      if (method === 'POST' && path.startsWith('/containers/create?name=')) {
        const name = path.slice('/containers/create?name='.length);
        seq++;
        const record = {
          Id: `cid-${seq}`,
          Name: `/${name}`,
          Image: body.Image,
          Config: { Labels: body.Labels ?? {}, Env: body.Env ?? [], User: body.User },
          HostConfig: body.HostConfig,
          State: { Running: false, StartedAt: '' },
        };
        containers.set(name, record);
        createdConfigs.push({ name, seq, body });
        return { Id: record.Id };
      }
      if (method === 'GET' && path.endsWith('/json') && path.startsWith('/containers/')) {
        const name = path.slice('/containers/'.length, -'/json'.length);
        return containers.get(name) ?? null;
      }
      if (method === 'POST' && path.endsWith('/start') && path.startsWith('/containers/')) {
        const name = path.slice('/containers/'.length, -'/start'.length);
        const c = containers.get(name);
        if (c) { c.State.Running = true; c.State.StartedAt = `2026-11-24T00:00:0${seq}Z`; }
        return null;
      }
      if (method === 'POST' && path.includes('/stop') && path.startsWith('/containers/')) {
        const name = path.slice('/containers/'.length).split('/')[0];
        const c = containers.get(name);
        if (c) c.State.Running = false;
        return null;
      }
      if (method === 'DELETE' && path.startsWith('/containers/')) {
        const name = path.slice('/containers/'.length).split('?')[0];
        containers.delete(name);
        return null;
      }
      return null;
    },
    async runner(_name, req) {
      if (req.type === 'health') return { ok: true, result: { ready: true, runner_version: 1 } };
      if (req.type === 'reap' || req.type === 'journal_clear' || req.type === 'prune') return { ok: true, result: { ok: true } };
      return { ok: true, result: {} };
    },
  };
}

test('manager gracefully handles missing skill-store dir on upgrade boot, reports skills_pending once created, mounts ro subpath on refresh and refuses symlinks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mgr-ss-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ssRoot = join(dir, 'skill-store');
  await mkdir(ssRoot, { recursive: true });

  const docker = makeDockerMock({ volumeNameByTarget: { [ssRoot]: 'bot_skill-store' } });
  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'testdep',
    image: 'test/project:local',
    tools: null,
    skillStore: ssRoot,
  });

  // Boot order: projects/101 does not exist yet (manager starts before bot)
  await projects.register('101');
  let desc = projects.describe('101');
  assert.equal(desc.computer.skills_mounted, false);
  assert.equal(desc.computer.skills_pending, false);
  assert.equal(docker.createdConfigs.at(-1).body.HostConfig.Mounts.some(m => m.Target === '/opt/bot-skills'), false);

  // Bot creates projects/101 -> manager immediately reports skills_pending without interrupting running container
  await mkdir(join(ssRoot, 'projects', '101', 'sets'), { recursive: true });
  desc = projects.describe('101');
  assert.equal(desc.computer.skills_mounted, false);
  assert.equal(desc.computer.skills_pending, true);
  assert.equal(docker.createdConfigs.length, 1);

  // Idle refresh attaches /opt/bot-skills:ro subpath projects/101
  await projects.operate('101', 'refresh', { operation_id: 'a'.repeat(48), generation: 1 });
  desc = projects.describe('101');
  assert.equal(desc.computer.skills_mounted, true);
  assert.equal(desc.computer.skills_pending, false);
  assert.deepEqual(
    docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/opt/bot-skills'),
    {
      Type: 'volume',
      Source: 'bot_skill-store',
      Target: '/opt/bot-skills',
      ReadOnly: true,
      VolumeOptions: { NoCopy: true, Subpath: 'projects/101' },
    },
  );

  // Symlinked scope directory must fail closed with 409 skill_store_path_invalid
  await symlink(join(ssRoot, 'projects', '101'), join(ssRoot, 'projects', '202'));
  await assert.rejects(
    () => projects.register('202'),
    err => err?.message === 'skill_store_path_invalid' && err?.status === 409,
  );
});

test('assistant computer mounts service skill-store read-only subpath, rotates idle container when available and refuses symlink', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mgr-ac-ss-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ssRoot = join(dir, 'skill-store');
  const homesRoot = join(dir, 'assistant-homes');
  const owner = 'a'.repeat(32);
  const fence = 'f'.repeat(32);
  await mkdir(ssRoot, { recursive: true });
  await mkdir(join(homesRoot, owner, 'home-1'), { recursive: true });

  const docker = makeDockerMock({
    volumeNameByTarget: {
      [ssRoot]: 'bot_skill-store',
      [homesRoot]: 'bot_assistant-homes',
    },
  });
  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'testdep',
    image: 'test/project:local',
    tools: null,
    skillStore: ssRoot,
  });
  const assistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'testdep',
    image: 'test/project:local',
    homes: homesRoot,
    skillStoreMount: projects.skillStoreMount,
    skillStoreVolume: () => projects.skillStoreVolume(),
  });

  // Acquire before service/ dir exists -> starts cleanly without /opt/bot-skills
  const first = await assistants.acquire(owner, { turn: 'turn-1', fence, home_generation: 1, home_mode: 'rw', harness: true });
  assert.equal(first.state, 'ready');
  assert.equal(docker.createdConfigs.at(-1).body.HostConfig.Mounts.some(m => m.Target === '/opt/bot-skills'), false);
  await assistants.release(owner, { turn: 'turn-1' });

  // Bot initializes service/ dir -> next acquire replaces idle container to attach /opt/bot-skills:ro (Subpath: service)
  await mkdir(join(ssRoot, 'service', 'sets'), { recursive: true });
  const second = await assistants.acquire(owner, { turn: 'turn-2', fence, home_generation: 1, home_mode: 'rw', harness: true });
  assert.equal(second.reused, false);
  assert.deepEqual(
    docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/opt/bot-skills'),
    {
      Type: 'volume',
      Source: 'bot_skill-store',
      Target: '/opt/bot-skills',
      ReadOnly: true,
      VolumeOptions: { NoCopy: true, Subpath: 'service' },
    },
  );
  await assistants.release(owner, { turn: 'turn-2' });

  // Subsequent acquire reuses the mounted idle container
  const third = await assistants.acquire(owner, { turn: 'turn-3', fence, home_generation: 1, home_mode: 'rw', harness: true });
  assert.equal(third.reused, true);
  await assistants.release(owner, { turn: 'turn-3', remove: true });

  // Symlinked service/ directory fails closed
  await rm(join(ssRoot, 'service'), { recursive: true, force: true });
  await symlink(homesRoot, join(ssRoot, 'service'));
  await assert.rejects(
    () => assistants.acquire(owner, { turn: 'turn-4', fence, home_generation: 1, home_mode: 'rw', harness: true }),
    err => err?.message === 'skill_store_path_invalid' && err?.status === 409,
  );
});
