import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { StorageReport } from '../dist/app/storage.js';
import { harness, setup } from './helpers.mjs';
import { managerFixture } from './project-manager-fixture.mjs';

// What the manager stores from one pass over /system/df, and what the storage page reads back from GET /v1/storage.
const dockerUsage = { read_at: '2026-10-01T12:00:00.000Z',
  images: { count: 2, bytes: 1200, unused_count: 1, reclaimable_bytes: 800 },
  containers: { count: 2, bytes: 30 },
  build_cache: { count: 2, bytes: 900, reclaimable_bytes: 900 },
  volumes: { count: 2, bytes: 400 }, assistant_homes: null };

test("the manager reads Docker's images and build cache in one background pass, its containers in another and its volumes in a third", async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 1200, Images: [{ Size: 900, Containers: 0, SharedSize: 100 }, { Size: 900, Containers: 1 }],
    Containers: [{ SizeRw: 10, SizeRootFs: 5000 }, { SizeRw: 20, SizeRootFs: 6000 }],
    Volumes: [{ UsageData: { Size: 100 } }, { UsageData: { Size: 300 } }], BuildCache: [{ Size: 400 }, { Size: 500 }] };
  await f.projects.readDockerUsage(Date.parse(dockerUsage.read_at));
  // Images and the build cache are the quick read; the containers and the volumes get a request each (#680, #968).
  assert.deepEqual(f.docker.calls, ['GET /system/df?type=image&type=build-cache', 'GET /system/df?type=container', 'GET /system/df?type=volume']);
  // The container and volume reads get a longer limit than the default request() would, because Docker walks each
  // writable layer and each volume.
  assert.deepEqual(f.docker.timeouts.map(read => read.timeout), [90000, 300000, 300000]);
  assert.deepEqual(f.projects.storage().docker, dockerUsage);
  // Unlabelled volumes are outside what the table counts, so they are Docker's own footprint; no assistant HOME here.
  assert.deepEqual(f.projects.storage().docker.volumes, { count: 2, bytes: 400 });
  assert.equal(f.projects.storage().docker.assistant_homes, null);
  // Read at most every half hour, so the page never waits for Docker and a many-image host is read once, not per load.
  await f.projects.readDockerUsage(Date.parse(dockerUsage.read_at) + 29 * 60_000);
  assert.equal(f.docker.calls.length, 3);
});

test('a volume the deployment already counts is left out, a volume outside it is counted, and assistant-homes is its own row', async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 1000, Images: [{ Size: 1000, Containers: 0 }], Containers: [], BuildCache: [],
    Volumes: [
      // Compose's own label and the manager's department.bot.* labels both mean `known` already counts the bytes in
      // that volume: bot-data and manager-data are the two databases and their trajectory directories, a *-work volume
      // is a project computer, and agent-tools is the trusted CLI volume.
      { Name: 'bot_bot-data', Labels: { 'com.docker.compose.volume': 'bot-data' }, UsageData: { Size: 500 } },
      { Name: 'bot_manager-data', Labels: { 'com.docker.compose.volume': 'manager-data' }, UsageData: { Size: 300 } },
      { Name: 'bot_agent-tools', Labels: { 'com.docker.compose.volume': 'agent-tools', 'department.bot.kind': 'agent-tools' }, UsageData: { Size: 100 } },
      { Name: 'bot_project-101-work', Labels: { 'department.bot.repository': '101', 'department.bot.kind': 'work' }, UsageData: { Size: 400 } },
      // The assistant HOME is the bot's data as well, but it used to land in "other": it gets a row of its own.
      { Name: 'bot_assistant-homes', Labels: { 'com.docker.compose.volume': 'assistant-homes' }, UsageData: { Size: 200 } },
      // A volume Docker keeps for something else: nothing else counts it, so it is Docker's own footprint.
      { Name: 'unrelated-cache', UsageData: { Size: 50 } }
    ] };
  await f.projects.readDockerUsage();
  const docker = f.projects.storage().docker;
  assert.deepEqual(docker.volumes, { count: 1, bytes: 50 }, 'only the volume outside the deployment is counted, so no byte is counted twice');
  assert.deepEqual(docker.assistant_homes, { bytes: 200 });
  assert.equal(docker.images.bytes, 1000);
  assert.deepEqual(f.docker.calls.at(-1), 'GET /system/df?type=volume');
});

test('a volume read that times out leaves only the volume rows unmeasured', async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 500, Images: [{ Size: 500, Containers: 1 }], Containers: [{ SizeRw: 7 }], BuildCache: [{ Size: 40 }],
    Volumes: [{ Name: 'scratch', UsageData: { Size: 9 } }] };
  await f.projects.readDockerUsage();
  assert.deepEqual(f.projects.storage().docker.volumes, { count: 1, bytes: 9 });
  // The next pass answers the other three reads and times out on the volumes: only the two volume rows become unknown.
  f.projects.dockerUsageAt = 0;
  f.docker.dfFailure = 'type=volume';
  await f.projects.readDockerUsage();
  const docker = f.projects.storage().docker;
  assert.equal(docker.volumes, null);
  assert.equal(docker.assistant_homes, null);
  assert.deepEqual([docker.images.bytes, docker.containers.bytes, docker.build_cache.bytes], [500, 7, 40], 'the reads that answered are kept');
});

test('a volume Docker did not size leaves the row unmeasured instead of a short total', async t => {
  const f = await managerFixture(t);
  f.docker.df = { Images: [], Containers: [], BuildCache: [],
    Volumes: [{ Name: 'sized', UsageData: { Size: 10 } }, { Name: 'unsized', UsageData: {} }] };
  await f.projects.readDockerUsage();
  assert.deepEqual(f.projects.storage().docker.volumes, { count: 2, bytes: null });
});

test('a container counts its writable layer, and a container Docker did not size leaves that kind unmeasured', async t => {
  const f = await managerFixture(t);
  f.docker.df = { Images: [{ Size: 700, Containers: 0 }, { Size: 300, Containers: 0 }], Containers: [{ SizeRootFs: 5000 }] };
  await f.projects.readDockerUsage();
  const docker = f.projects.storage().docker;
  // Without LayersSize the listed image sizes are the fallback.
  assert.deepEqual(docker.images, { count: 2, bytes: 1000, unused_count: 2, reclaimable_bytes: 1000 });
  // A container without SizeRw was not sized: the count stays, the bytes are unknown, not a measured 0.
  assert.deepEqual(docker.containers, { count: 1, bytes: null });
});

test('an image or build-cache row Docker did not size leaves that kind unmeasured instead of a short total', async t => {
  const f = await managerFixture(t);
  // moby answers -1 for a total it could not compute; the per-image fallback is only as good as the rows behind it.
  f.docker.df = { LayersSize: -1, Images: [{ Size: 700, Containers: 0 }, {}], Containers: [], BuildCache: [{ Size: 40 }, {}] };
  await f.projects.readDockerUsage();
  let docker = f.projects.storage().docker;
  assert.equal(docker.images.bytes, null, 'one image without a size makes the layer total unknown, not 700');
  assert.deepEqual([docker.build_cache.bytes, docker.build_cache.reclaimable_bytes], [null, null], 'a cache row without a size is unknown, not 40');
  // Every row sized: the totals are numbers again.
  f.projects.dockerUsageAt = 0;
  f.docker.df = { LayersSize: 1000, Images: [{ Size: 700, Containers: 0, SharedSize: 100 }, { Size: 300, Containers: 0 }], Containers: [], BuildCache: [{ Size: 40 }] };
  await f.projects.readDockerUsage();
  docker = f.projects.storage().docker;
  assert.deepEqual([docker.images.bytes, docker.build_cache.bytes], [1000, 40]);
});

test('a container read that times out leaves the images and build cache it did not touch measured', async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 500, Images: [{ Size: 500, Containers: 1 }], Containers: [{ SizeRw: 7 }], BuildCache: [{ Size: 40 }] };
  await f.projects.readDockerUsage();
  const first = f.projects.storage().docker;
  assert.deepEqual(first.containers, { count: 1, bytes: 7 });
  // The next pass answers the quick read and times out on the containers: the two rows stand, only containers is unknown.
  f.projects.dockerUsageAt = 0;
  f.docker.df = { LayersSize: 500, Images: [{ Size: 500, Containers: 1 }], Containers: [], BuildCache: [{ Size: 60 }] };
  f.docker.dfFailure = 'type=container';
  await f.projects.readDockerUsage();
  const docker = f.projects.storage().docker;
  assert.deepEqual([docker.images.bytes, docker.build_cache.bytes], [500, 60], 'the pass that answered is kept');
  assert.equal(docker.containers, null, 'the kind that timed out is not measured, and is not the old number either');
});

test('a read Docker cannot answer keeps the last numbers and never fails the storage call', async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 5, Containers: [{ SizeRw: 7 }], BuildCache: [] };
  await f.projects.readDockerUsage();
  const first = f.projects.storage().docker;
  assert.deepEqual(first.containers, { count: 1, bytes: 7 });
  f.docker.request = async () => { throw new Error('docker_response_too_large'); };
  f.projects.dockerUsageAt = 0;
  await f.projects.readDockerUsage();
  assert.deepEqual(f.projects.storage().docker, first);
});

function reportFixture(t, docker, disk = { free_bytes: 1, total_bytes: 2 }) {
  const directory = mkdtempSync(join(tmpdir(), 'host-storage-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 4));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run('INSERT INTO repositories VALUES(?,?,?,?)', '101', 'fixture/project-101', '10', 'a');
  const manager = { async call(method, path) {
    assert.equal(`${method} ${path}`, 'GET /v1/storage');
    return { usage: [], database: { bytes: 8192, free_pages: 1, free_bytes: 4096 }, disk, migration: {}, expiry: {}, docker };
  } };
  return new StorageReport(store, manager);
}
const superAdmin = { id: 'admin', role: 'super_admin', repositories: [] };

test("the disk's storage table counts Docker's containers and only the volumes outside what it already knows", async t => {
  const view = await reportFixture(t, dockerUsage).api(superAdmin, 'GET', '/api/storage');
  assert.deepEqual(view.totals.manager.docker, dockerUsage);
  assert.equal(view.host.known.docker_containers, 30);
  assert.equal(view.host.known.docker_images, 1200);
  assert.ok(!view.host.unmeasured.includes('docker_containers'));
  // A volume the table counts as a computer, a database or the assistant HOME is not added a second time: the manager
  // already leaves those out, and the row carries only the remainder.
  assert.equal(view.host.known.docker_volumes, 400);
  assert.equal(view.host.known.assistant_homes, null, 'this reading has no assistant HOME volume');
  assert.ok(view.host.unmeasured.includes('assistant_homes'));
});

test('assistant-homes is its own row, so it no longer lands in "other"', async t => {
  const usage = { ...dockerUsage, volumes: { count: 1, bytes: 50 }, assistant_homes: { bytes: 200 } };
  const view = await reportFixture(t, usage).api(superAdmin, 'GET', '/api/storage');
  assert.equal(view.host.known.docker_volumes, 50);
  assert.equal(view.host.known.assistant_homes, 200);
  assert.ok(!view.host.unmeasured.includes('docker_volumes'));
  assert.ok(!view.host.unmeasured.includes('assistant_homes'));
  // Both rows are inside `known`, and "other" is still used minus every known row, so the bytes that used to hide in
  // "other" are now named above it.
  assert.ok(view.host.known_bytes >= 250);
  assert.equal(view.host.other_bytes, view.host.used_bytes - view.host.known_bytes);
});

test('a Docker total the manager could not measure lists that row as unmeasured on the storage page', async t => {
  const usage = { ...dockerUsage, containers: null };
  const view = await reportFixture(t, usage).api(superAdmin, 'GET', '/api/storage');
  assert.equal(view.host.known.docker_containers, null);
  assert.ok(view.host.unmeasured.includes('docker_containers'));
  assert.equal(view.host.known.docker_images, 1200, 'the rows read in the other request are still measured');
});

test('Docker read not at all yet leaves those rows unmeasured and the page at 200', async t => {
  const h = await harness(t, { async call() { return { usage: [], database: {}, disk: {}, migration: {}, expiry: {}, docker: null }; } });
  const { admin } = await setup(h);
  const response = await admin('/api/storage');
  assert.equal(response.status, 200);
  assert.equal(response.value.totals.manager.docker, null);
  for (const key of ['docker_images', 'docker_containers', 'docker_build_cache', 'docker_volumes', 'assistant_homes'])
    assert.equal(response.value.host.known[key], null, key);
  assert.ok(response.value.host.unmeasured.includes('docker_containers'));
});
