import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Docker } from '../manager/docker.mjs';
import { managerFixture } from './project-manager-fixture.mjs';

// A Docker daemon stand-in on a unix socket; the path stays relative to the checkout because a unix socket path may not
// exceed 107 bytes. `calls` records "METHOD path" so a test can tell which endpoint was read.
async function socketDaemon(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), 'host-storage-')), socket = join(relative(process.cwd(), directory), 'docker.sock');
  const daemon = createServer(handler);
  t.after(async () => { await new Promise(done => daemon.close(done)); rmSync(directory, { recursive: true, force: true }); });
  daemon.listen(socket); await once(daemon, 'listening');
  return { directory, socket };
}

test("Docker's whole-host usage counts images, containers, volumes and the build cache", async t => {
  const calls = [];
  const { socket } = await socketDaemon(t, (req, res) => {
    calls.push(req.method + ' ' + req.url);
    // Images share layers: LayersSize is what they take on disk, not the sum of the per-image sizes.
    res.end(JSON.stringify({ LayersSize: 1200, Images: [{ Size: 900 }, { Size: 900 }], Containers: [{ SizeRw: 10 }, { SizeRw: 20 }],
      Volumes: [{ UsageData: { Size: 100 } }, { UsageData: { Size: 300 } }], BuildCache: [{ Size: 400 }, { Size: 500 }] }));
  });
  assert.deepEqual(await new Docker(socket).diskUsage(),
    { images_bytes: 1200, containers_bytes: 30, volumes_bytes: 400, build_cache_bytes: 900 });
  assert.deepEqual(calls, ['GET /v1.47/system/df']);
});

test('an answer without LayersSize falls back to the listed image sizes, and missing rows count zero', async t => {
  const { socket } = await socketDaemon(t, (req, res) => res.end(JSON.stringify({ Images: [{ Size: 700 }, { Size: 300 }] })));
  assert.deepEqual(await new Docker(socket).diskUsage(),
    { images_bytes: 1000, containers_bytes: 0, volumes_bytes: 0, build_cache_bytes: 0 });
});

test('a /system/df answer past the 4 MB cap reads as unreadable instead of failing the storage page', async t => {
  const body = JSON.stringify({ LayersSize: 1, Pad: 'x'.repeat(5 * 1024 * 1024) });
  const { socket } = await socketDaemon(t, (_req, res) => { res.on('error', () => {}); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body); });
  assert.equal(await new Docker(socket).diskUsage(), null);
});

test('an unreachable Docker socket reads as null, never as an error', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'host-storage-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(await new Docker(join(relative(process.cwd(), directory), 'missing.sock')).diskUsage(), null);
});

test("the manager's storage reports the host's Docker usage, or null when Docker cannot be read", async t => {
  const f = await managerFixture(t), usage = { images_bytes: 11, containers_bytes: 22, volumes_bytes: 33, build_cache_bytes: 44 };
  f.docker.df = usage;
  assert.deepEqual((await f.projects.storage()).host, { docker: usage });
  f.docker.df = null;
  assert.deepEqual((await f.projects.storage()).host, { docker: null });
});
