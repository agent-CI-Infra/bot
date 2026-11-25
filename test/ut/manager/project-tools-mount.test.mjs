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
    ['bot_project-tools', { Name: 'bot_project-tools', Labels: { 'department.bot.kind': 'project-tools' } }],
    ['bot_assistant-homes', { Name: 'bot_assistant-homes', Labels: { 'com.docker.compose.volume': 'assistant-homes' } }],
    ['bot_model-gateway', { Name: 'bot_model-gateway', Labels: { 'department.bot.kind': 'model-gateway' } }],
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

test('manager mounts project-tools read-only subpath, reports tools_pending, rotates on refresh and unmounts on clear', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mgr-pt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ptRoot = join(dir, 'project-tools');
  await mkdir(join(ptRoot, '101', 'rev-1'), { recursive: true });
  await mkdir(join(ptRoot, '101', 'rev-2'), { recursive: true });

  const docker = makeDockerMock({ volumeNameByTarget: { [ptRoot]: 'bot_project-tools' } });
  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'testdep',
    image: 'test/project:local',
    tools: null,
    projectTools: ptRoot,
  });

  await projects.register('101');
  let desc = projects.describe('101');
  assert.equal(desc.computer.tools_revision, null);
  assert.equal(desc.computer.applied_tools_revision, null);
  assert.equal(desc.computer.tools_pending, false);
  assert.equal(docker.createdConfigs.at(-1).body.HostConfig.Mounts.some(m => m.Target === '/opt/project-tools'), false);

  // Set desired tools revision 1 without interrupting running container
  desc = projects.setToolsRevision('101', 1);
  assert.equal(desc.computer.tools_revision, 1);
  assert.equal(desc.computer.applied_tools_revision, null);
  assert.equal(desc.computer.tools_pending, true);
  assert.equal(docker.createdConfigs.length, 1, 'setToolsRevision must not recreate container immediately');

  // Idle refresh switches container to rev-1 read-only subpath mount
  await projects.operate('101', 'refresh', { operation_id: 'a'.repeat(48), generation: 1 });
  desc = projects.describe('101');
  assert.equal(desc.computer.applied_tools_revision, 1);
  assert.equal(desc.computer.tools_pending, false);
  const m1 = docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/opt/project-tools');
  assert.deepEqual(m1, {
    Type: 'volume',
    Source: 'bot_project-tools',
    Target: '/opt/project-tools',
    ReadOnly: true,
    VolumeOptions: { NoCopy: true, Subpath: '101/rev-1' },
  });
  assert.deepEqual(projects.activeProjectToolMounts().mounts, [{ repository_id: '101', revision: 1, kind: 'project' }]);

  // Rotate to rev-2 on idle refresh
  projects.setToolsRevision('101', 2);
  assert.equal(projects.describe('101').computer.tools_pending, true);
  await projects.operate('101', 'refresh', { operation_id: 'b'.repeat(48), generation: 1 });
  const m2 = docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/opt/project-tools');
  assert.equal(m2.VolumeOptions.Subpath, '101/rev-2');

  // Clear revision -> unmount /opt/project-tools on idle refresh
  projects.setToolsRevision('101', null);
  assert.equal(projects.describe('101').computer.tools_pending, true);
  await projects.operate('101', 'refresh', { operation_id: 'c'.repeat(48), generation: 1 });
  assert.equal(projects.describe('101').computer.tools_pending, false);
  assert.equal(docker.createdConfigs.at(-1).body.HostConfig.Mounts.some(m => m.Target === '/opt/project-tools'), false);

  // Symlinked rev dir must be refused
  await symlink(join(ptRoot, '101', 'rev-1'), join(ptRoot, '101', 'rev-9'));
  projects.setToolsRevision('101', 9);
  await assert.rejects(
    () => projects.operate('101', 'refresh', { operation_id: 'd'.repeat(48), generation: 1 }),
    err => err?.message === 'project_tools_revision_missing',
  );
});

test('group assistant mounts authorized project tools read-only and rotates only between turns (never mid-turn)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mgr-ac-pt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ptRoot = join(dir, 'project-tools');
  const homesRoot = join(dir, 'assistant-homes');
  const owner = 'a'.repeat(32);
  const fence = 'f'.repeat(32);
  await mkdir(join(homesRoot, owner, 'home-1'), { recursive: true });
  await mkdir(join(ptRoot, '101', 'rev-1'), { recursive: true });
  await mkdir(join(ptRoot, '101', 'rev-2'), { recursive: true });

  const docker = makeDockerMock({
    volumeNameByTarget: {
      [ptRoot]: 'bot_project-tools',
      [homesRoot]: 'bot_assistant-homes',
    },
  });
  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'testdep',
    image: 'test/project:local',
    tools: null,
    projectTools: ptRoot,
  });
  const assistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'testdep',
    image: 'test/project:local',
    homes: homesRoot,
    projectToolsMount: ptRoot,
    projectToolsVolume: () => projects.projectToolsVolume(),
  });

  // Turn 1 mounts 101/rev-1 read-only under /opt/project-tools/acme__alpha
  const acq1 = await assistants.acquire(owner, {
    turn: 'turn-1',
    fence,
    home_generation: 1,
    home_mode: 'rw',
    project_tools: [{ repository_id: '101', mount_name: 'acme__alpha', revision: 1 }],
  });
  assert.equal(acq1.state, 'ready');
  assert.equal(acq1.reused, false);
  const mount1 = docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/opt/project-tools/acme__alpha');
  assert.deepEqual(mount1, {
    Type: 'volume',
    Source: 'bot_project-tools',
    Target: '/opt/project-tools/acme__alpha',
    ReadOnly: true,
    VolumeOptions: { NoCopy: true, Subpath: '101/rev-1' },
  });
  assert.deepEqual(projects.activeProjectToolMounts(assistants).mounts, [
    { repository_id: '101', revision: 1, kind: 'assistant', owner },
  ]);

  // Mid-turn retry (same turn-1) with rev-2 must NOT interrupt running container!
  const midRetry = await assistants.acquire(owner, {
    turn: 'turn-1',
    fence,
    home_generation: 1,
    home_mode: 'rw',
    project_tools: [{ repository_id: '101', mount_name: 'acme__alpha', revision: 2 }],
  });
  assert.equal(midRetry.state, 'ready');
  assert.equal(docker.createdConfigs.length, 1, 'running turn must keep its mounted rev-1 container');

  // Release turn-1 to idle, then start turn-2 with rev-1 -> reuses container
  await assistants.release(owner, { turn: 'turn-1', remove: false });
  const acq2 = await assistants.acquire(owner, {
    turn: 'turn-2',
    fence,
    home_generation: 1,
    home_mode: 'rw',
    project_tools: [{ repository_id: '101', mount_name: 'acme__alpha', revision: 1 }],
  });
  assert.equal(acq2.reused, true);
  assert.equal(docker.createdConfigs.length, 1);

  // Release turn-2, then start turn-3 with rev-2 -> rotates cleanly to new container mounting rev-2!
  await assistants.release(owner, { turn: 'turn-2', remove: false });
  const acq3 = await assistants.acquire(owner, {
    turn: 'turn-3',
    fence,
    home_generation: 1,
    home_mode: 'rw',
    project_tools: [{ repository_id: '101', mount_name: 'acme__alpha', revision: 2 }],
  });
  assert.equal(acq3.reused, false);
  assert.equal(docker.createdConfigs.length, 2);
  const mount3 = docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/opt/project-tools/acme__alpha');
  assert.equal(mount3.VolumeOptions.Subpath, '101/rev-2');

  // Missing project-tools volume degrades gracefully without failing the assistant turn
  await assistants.release(owner, { turn: 'turn-3', remove: true });
  const degradedAssistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'testdep',
    image: 'test/project:local',
    homes: homesRoot,
    projectToolsMount: ptRoot,
    projectToolsVolume: async () => null,
  });
  const acqDegraded = await degradedAssistants.acquire(owner, {
    turn: 'turn-4',
    fence,
    home_generation: 1,
    home_mode: 'rw',
    project_tools: [{ repository_id: '101', mount_name: 'acme__alpha', revision: 2 }],
  });
  assert.equal(acqDegraded.state, 'ready');
  assert.equal(docker.createdConfigs.at(-1).body.HostConfig.Mounts.some(m => m.Target.startsWith('/opt/project-tools/')), false);
  assert.deepEqual(projects.activeProjectToolMounts(degradedAssistants).mounts, []);
});

test('manager mounts model-gateway read-only on project and assistant computers and recreates stale containers missing it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mgr-mgw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mgwRoot = join(dir, 'model-gateway');
  const homesRoot = join(dir, 'assistant-homes');
  const owner = 'b'.repeat(32);
  const fence = 'c'.repeat(32);
  await mkdir(mgwRoot, { recursive: true });
  await mkdir(join(homesRoot, owner, 'home-1'), { recursive: true });

  const docker = makeDockerMock({
    volumeNameByTarget: {
      [mgwRoot]: 'bot_model-gateway',
      [homesRoot]: 'bot_assistant-homes',
    },
  });
  const projects = new Projects({
    database: join(dir, 'manager.sqlite'),
    docker,
    deployment: 'testdep',
    image: 'test/project:local',
    tools: null,
    modelGateway: mgwRoot,
  });

  // 1. Project computer gets read-only /run/model-gateway mount.
  await projects.register('101');
  const projMount = docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/run/model-gateway');
  assert.deepEqual(projMount, {
    Type: 'volume',
    Source: 'bot_model-gateway',
    Target: '/run/model-gateway',
    ReadOnly: true,
  });

  // 2. Assistant computer gets read-only /run/model-gateway mount even with egress disabled (NetworkMode: none).
  const assistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'testdep',
    image: 'test/project:local',
    homes: homesRoot,
    modelGateway: () => projects.modelGatewayVolume(),
    globalEnvironment: () => ({ defaults: { egress: false } }),
  });
  const acq = await assistants.acquire(owner, { turn: 't-mgw', fence, home_generation: 1, home_mode: 'rw' });
  assert.equal(acq.state, 'ready');
  const asstConfig = docker.createdConfigs.at(-1).body;
  assert.equal(asstConfig.HostConfig.NetworkMode, 'none');
  const asstMount = asstConfig.HostConfig.Mounts.find(m => m.Target === '/run/model-gateway');
  assert.deepEqual(asstMount, {
    Type: 'volume',
    Source: 'bot_model-gateway',
    Target: '/run/model-gateway',
    ReadOnly: true,
  });
  await assistants.release(owner, { turn: 't-mgw', remove: true });

  // 3. Stale container created before model-gateway existed (missing /run/model-gateway mount) is recreated on recover().
  const containerName = [...docker.containers.keys()][0];
  const existing = docker.containers.get(containerName);
  existing.HostConfig.Mounts = existing.HostConfig.Mounts.filter(m => m.Target !== '/run/model-gateway');
  existing.Mounts = existing.HostConfig.Mounts
    .map(m => ({ Type: m.Type, Name: m.Source, Source: m.Source, Destination: m.Target, RW: !m.ReadOnly }));
  const countBefore = docker.createdConfigs.length;
  await projects.recover();
  assert.equal(docker.createdConfigs.length, countBefore + 1, 'recover must recreate container missing read-only /run/model-gateway mount');
  const recreatedMount = docker.createdConfigs.at(-1).body.HostConfig.Mounts.find(m => m.Target === '/run/model-gateway');
  assert.deepEqual(recreatedMount, {
    Type: 'volume',
    Source: 'bot_model-gateway',
    Target: '/run/model-gateway',
    ReadOnly: true,
  });
});
