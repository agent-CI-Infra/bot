import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { StorageReport } from '../dist/app/storage.js';
import { harness, setup } from './helpers.mjs';
import { managerFixture } from './project-manager-fixture.mjs';

// What the manager stores from one /system/df, and what the storage page reads back from GET /v1/storage.
const dockerUsage = { read_at: '2026-10-01T12:00:00.000Z',
  images: { count: 2, bytes: 1200, unused_count: 1, reclaimable_bytes: 800 },
  containers: { count: 2, bytes: 30 }, volumes: { count: 2, bytes: 400 },
  build_cache: { count: 2, bytes: 900, reclaimable_bytes: 900 } };

test("the manager reads Docker's images, containers, volumes and build cache in one background pass", async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 1200, Images: [{ Size: 900, Containers: 0, SharedSize: 100 }, { Size: 900, Containers: 1 }],
    Containers: [{ SizeRw: 10, SizeRootFs: 5000 }, { SizeRw: 20, SizeRootFs: 6000 }],
    Volumes: [{ UsageData: { Size: 100 } }, { UsageData: { Size: 300 } }], BuildCache: [{ Size: 400 }, { Size: 500 }] };
  await f.projects.readDockerUsage(Date.parse(dockerUsage.read_at));
  // One answer carries all four kinds; asking Docker to size the volumes only happens here, off the storage request.
  assert.deepEqual(f.docker.calls, ['GET /system/df']);
  assert.deepEqual(f.projects.storage().docker, dockerUsage);
  // Read at most every half hour, so the page never waits for Docker and a many-image host is read once, not per load.
  await f.projects.readDockerUsage(Date.parse(dockerUsage.read_at) + 29 * 60_000);
  assert.deepEqual(f.docker.calls, ['GET /system/df']);
});

test('a container counts its writable layer and a volume its data, and a daemon that leaves sizes out counts zero', async t => {
  const f = await managerFixture(t);
  f.docker.df = { Images: [{ Size: 700, Containers: 0 }, { Size: 300, Containers: 0 }], Containers: [{ SizeRootFs: 5000 }] };
  await f.projects.readDockerUsage();
  const docker = f.projects.storage().docker;
  // Without LayersSize the listed image sizes are the fallback; a container without a writable layer adds nothing.
  assert.deepEqual(docker.images, { count: 2, bytes: 1000, unused_count: 2, reclaimable_bytes: 1000 });
  assert.deepEqual(docker.containers, { count: 1, bytes: 0 });
  assert.deepEqual(docker.volumes, { count: 0, bytes: 0 });
});

test('a read Docker cannot answer keeps the last numbers and never fails the storage call', async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 5, Containers: [{ SizeRw: 7 }], Volumes: [{ UsageData: { Size: 9 } }], BuildCache: [] };
  await f.projects.readDockerUsage();
  const first = f.projects.storage().docker;
  assert.deepEqual([first.containers, first.volumes], [{ count: 1, bytes: 7 }, { count: 1, bytes: 9 }]);
  f.docker.request = async () => { throw new Error('docker_response_too_large'); };
  f.projects.dockerUsageAt = 0;
  await f.projects.readDockerUsage();
  assert.deepEqual(f.projects.storage().docker, first);
});

function reportFixture(t, docker) {
  const directory = mkdtempSync(join(tmpdir(), 'host-storage-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 4));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run('INSERT INTO repositories VALUES(?,?,?,?)', '101', 'fixture/project-101', '10', 'a');
  const manager = { async call(method, path) {
    assert.equal(`${method} ${path}`, 'GET /v1/storage');
    return { usage: [], database: { bytes: 8192, free_pages: 1, free_bytes: 4096 }, disk: { free_bytes: 1, total_bytes: 2 }, migration: {}, expiry: {}, docker };
  } };
  return new StorageReport(store, manager);
}
const superAdmin = { id: 'admin', role: 'super_admin', repositories: [] };

test("the disk's storage table counts Docker's containers and volumes in what it knows", async t => {
  const view = await reportFixture(t, dockerUsage).api(superAdmin, 'GET', '/api/storage');
  assert.deepEqual(view.totals.manager.docker, dockerUsage);
  assert.equal(view.host.known.docker_containers, 30);
  assert.equal(view.host.known.docker_volumes, 400);
  assert.ok(!view.host.unmeasured.includes('docker_containers'));
  assert.ok(!view.host.unmeasured.includes('docker_volumes'));
});

test('Docker read not at all yet leaves those rows unmeasured and the page at 200', async t => {
  const h = await harness(t, { async call() { return { usage: [], database: {}, disk: {}, migration: {}, expiry: {}, docker: null }; } });
  const { admin } = await setup(h);
  const response = await admin('/api/storage');
  assert.equal(response.status, 200);
  assert.equal(response.value.totals.manager.docker, null);
  for (const key of ['docker_images', 'docker_containers', 'docker_volumes', 'docker_build_cache'])
    assert.equal(response.value.host.known[key], null, key);
  assert.ok(response.value.host.unmeasured.includes('docker_volumes'));
});
