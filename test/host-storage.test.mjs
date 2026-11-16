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
  build_cache: { count: 2, bytes: 900, reclaimable_bytes: 900 } };

test("the manager reads Docker's images and build cache in one background pass and its containers in another", async t => {
  const f = await managerFixture(t);
  f.docker.df = { LayersSize: 1200, Images: [{ Size: 900, Containers: 0, SharedSize: 100 }, { Size: 900, Containers: 1 }],
    Containers: [{ SizeRw: 10, SizeRootFs: 5000 }, { SizeRw: 20, SizeRootFs: 6000 }],
    Volumes: [{ UsageData: { Size: 100 } }, { UsageData: { Size: 300 } }], BuildCache: [{ Size: 400 }, { Size: 500 }] };
  await f.projects.readDockerUsage(Date.parse(dockerUsage.read_at));
  // Images and the build cache are the quick read; the containers get a request of their own (#680).
  assert.deepEqual(f.docker.calls, ['GET /system/df?type=image&type=build-cache', 'GET /system/df?type=container']);
  // The container read gets a longer limit than the default request() would, because Docker walks each writable layer.
  assert.deepEqual(f.docker.timeouts.map(read => read.timeout), [90000, 300000]);
  assert.deepEqual(f.projects.storage().docker, dockerUsage);
  // Volumes are not read: /system/df lists the ones the table already counts as a computer, a database or "other".
  assert.equal(f.projects.storage().docker.volumes, undefined);
  // Read at most every half hour, so the page never waits for Docker and a many-image host is read once, not per load.
  await f.projects.readDockerUsage(Date.parse(dockerUsage.read_at) + 29 * 60_000);
  assert.equal(f.docker.calls.length, 2);
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

test("the disk's storage table counts Docker's containers in what it knows, and has no volume row", async t => {
  const view = await reportFixture(t, dockerUsage).api(superAdmin, 'GET', '/api/storage');
  assert.deepEqual(view.totals.manager.docker, dockerUsage);
  assert.equal(view.host.known.docker_containers, 30);
  assert.equal(view.host.known.docker_images, 1200);
  assert.ok(!view.host.unmeasured.includes('docker_containers'));
  assert.equal('docker_volumes' in view.host.known, false, 'a volume is counted once, as the computer or database that holds it');
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
  for (const key of ['docker_images', 'docker_containers', 'docker_build_cache'])
    assert.equal(response.value.host.known[key], null, key);
  assert.ok(response.value.host.unmeasured.includes('docker_containers'));
});
