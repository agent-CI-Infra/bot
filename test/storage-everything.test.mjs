import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { storageScan } from '../runner/storage-scan.mjs';
import { Store } from '../dist/storage/database.js';
import { StorageReport, directoryBytes } from '../dist/app/storage.js';
import { workspaceClasses } from '../dist/projects/workspace-cleanup.js';
import { managerFixture } from './project-manager-fixture.mjs';

// #671: the storage page shows every kind of storage: the computers' volumes from a background scan, Docker's images and
// build cache, the control plane's directories, "other", what can be reclaimed and what the last cleanups freed.
const GiB = 1024 ** 3, id = () => randomBytes(24).toString('hex');
const tree = (t, files) => {
  const root = mkdtempSync(join(tmpdir(), 'storage-scan-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), randomBytes(bytes)); }
  return root;
};

test('a computer scan splits the work volume into task workspaces, journal, git store, HOME and other files', async t => {
  const a = id(), b = id(), root = tree(t, { [`tasks/${a}/repo/big`]: 400_000, [`tasks/${b}/f`]: 100_000, '.runner-journal/x.json': 10_000, 'git/repo.git/pack': 50_000,
    'home/.cache/pip/w': 200_000, 'home/.npm/n': 30_000, 'tmp/t': 20_000, 'stray/s': 60_000, 'loose-file': 70_000,
    // The project notes are another volume mounted in; their history directory is not readable by the computer's user.
    'project-notes/notes.md': 90_000, 'project-notes/.write-history/x': 10, [`tasks/${b}/project-notes/kept`]: 30_000 });
  chmodSync(join(root, 'project-notes/.write-history'), 0o000);
  const scan = await storageScan(root);
  chmodSync(join(root, 'project-notes/.write-history'), 0o700);
  assert.equal(scan.complete, true, 'the notes mount is left out, so its unreadable history does not mark the scan incomplete'); assert.equal(scan.task_count, 2);
  assert.ok(!scan.other_entries.some(entry => entry.name === 'project-notes')); assert.ok(scan.tasks.find(entry => entry.name === b).bytes >= 130_000, 'a directory of that name inside a task still counts');
  assert.deepEqual(scan.tasks.map(entry => entry.name), [a, b], 'largest first');
  assert.ok(scan.tasks[0].bytes >= 400_000 && scan.tasks_bytes >= 500_000);
  assert.ok(scan.journal_bytes >= 10_000 && scan.store_bytes >= 50_000 && scan.tmp_bytes >= 20_000);
  assert.deepEqual(scan.home_entries.map(entry => entry.name), ['.cache', '.npm']); assert.ok(scan.home_bytes >= 230_000);
  assert.deepEqual(scan.other_entries.map(entry => entry.name), ['stray']);
  assert.ok(scan.other_bytes >= 130_000, 'the stray directory and the loose file');
  const parts = scan.tasks_bytes + scan.journal_bytes + scan.store_bytes + scan.home_bytes + scan.tmp_bytes + scan.other_bytes;
  assert.equal(parts, scan.total_bytes, 'the groups add up to the volume');
  assert.ok(scan.disk.total_bytes > 0);
  // The runner answers it as a repeatable call that is never journaled.
  const request = Buffer.from(JSON.stringify({ operation_id: id(), type: 'storage_scan' })).toString('base64url');
  const answer = await new Promise((resolve, reject) => execFile(process.execPath, ['runner/runner.mjs', request], { env: { ...process.env, BOT_LOCAL_EXECUTION: 'true', BOT_LOCAL_WORKSPACE: root } },
    (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
  assert.equal(answer.ok, true); assert.equal(answer.result.task_count, 2);
  assert.equal((await directoryBytes(join(root, 'missing'))), 0); assert.ok(await directoryBytes(join(root, 'git')) >= 50_000);
});

test('the manager scans one running computer at a time every six hours and reads Docker usage in the background', async t => {
  const f = await managerFixture(t);
  for (const repo of ['101', '102']) await f.projects.register(repo);
  const scans = [], pending = [];
  f.docker.runner = async (container, input) => {
    if (input.type !== 'storage_scan') return { ok: true, result: { ready: true } };
    scans.push(container); const gate = Promise.withResolvers(); pending.push(gate); await gate.promise;
    return { ok: true, result: { scanned_at: new Date().toISOString(), complete: true, total_bytes: 1000, tasks: [{ name: 'a'.repeat(48), bytes: 600 }], tasks_bytes: 600 } };
  };
  const settle = async () => { while (pending.length) { pending.shift().resolve(); await new Promise(resolve => setImmediate(resolve)); } await new Promise(resolve => setImmediate(resolve)); };
  f.projects.scanStorage(); f.projects.scanStorage();
  assert.equal(scans.length, 1, 'one scan at a time');
  await settle(); f.projects.scanStorage(); await settle();
  assert.equal(scans.length, 2); assert.match(scans[0], /-101-g1$/); assert.match(scans[1], /-102-g1$/);
  f.projects.scanStorage(); assert.equal(scans.length, 2, 'both were scanned within six hours');
  // Six hours later both are due again; a reset computer (new generation) is due at once.
  f.projects.scanStorage(Date.now() + 6 * 3600_000 + 1000); await settle(); assert.equal(scans.length, 3);
  f.projects.db.prepare("UPDATE projects SET generation=2 WHERE repository_id='102'").run();
  const resources = f.projects.db.prepare("INSERT INTO resources VALUES('102',2,'approved')"); resources.run();
  f.docker.containers.set(f.projects.names('102', 2).container, { Config: { Labels: f.projects.labels('102', 2, 'container') }, State: { Running: true } });
  f.projects.scanStorage(); await settle(); assert.match(scans.at(-1), /-102-g2$/);
  // A failed scan is kept with its error and waits for the next interval.
  f.docker.runner = async () => ({ ok: false, error: 'storage_scan_failed' });
  t.mock.method(console, 'error', () => {});
  f.projects.db.prepare("UPDATE computer_storage SET scanned_at='2000-01-01T00:00:00Z' WHERE repository_id='101'").run();
  f.projects.scanStorage(); await settle();
  const report = f.projects.storage(), row = report.computers.find(entry => entry.repository_id === '101');
  assert.equal(row.result.error, 'storage_scan_failed');
  assert.equal(report.computers.find(entry => entry.repository_id === '102').result.total_bytes, 1000);
  // Docker: images and the build cache, with what no container uses.
  f.docker.df = { LayersSize: 9 * GiB,
    Images: [{ Size: 5 * GiB, SharedSize: GiB, Containers: 2 }, { Size: 3 * GiB, SharedSize: GiB, Containers: 0 }, { Size: GiB, SharedSize: 0, Containers: 0 }],
    BuildCache: [{ Size: 2 * GiB, InUse: false, Shared: false }, { Size: GiB, InUse: true, Shared: false }] };
  await f.projects.readDockerUsage(); await f.projects.readDockerUsage();
  assert.equal(f.docker.calls.filter(call => call.startsWith('GET /system/df')).length, 1, 'read at most every half hour');
  const docker = f.projects.storage().docker;
  assert.deepEqual(docker.images, { count: 3, bytes: 9 * GiB, unused_count: 2, reclaimable_bytes: 3 * GiB });
  assert.deepEqual(docker.build_cache, { count: 2, bytes: 3 * GiB, reclaimable_bytes: 2 * GiB });
});

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'storage-everything-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 6));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  for (const repo of ['101', '102']) { store.run('INSERT INTO repositories VALUES(?,?,?,?)', repo, 'fixture/project-' + repo, '10', 'a'); store.run('INSERT INTO policies(repository_id) VALUES(?)', repo); }
  return { store, directory };
}
// A task using a workspace, in a given state.
function owned(store, repo, workspace, task, status, kind = 'review.issue', number = 1) {
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES(?,?,?,?,?,?)', task, repo, kind, status, 'fixture', number);
  store.run("INSERT INTO task_workspaces(repository_id,workspace_id,task_id,task_kind,object_number,kind,created_at) VALUES(?,?,?,?,?,'task',?)", repo, workspace, task, kind, number, new Date().toISOString());
}

test('task workspaces are counted as running, kept for an open pull request or waiting for removal', t => {
  const { store } = storeFixture(t), [running, pr, done, failed, unowned] = [id(), id(), id(), id(), id()];
  owned(store, '101', running, 't-running', 'running');
  owned(store, '101', pr, 't-pr', 'pr_opened', 'development.pr', 7);
  owned(store, '101', done, 't-done', 'succeeded', 'review.issue', 2);
  owned(store, '101', failed, 't-failed', 'failed', 'review.issue', 3);
  const classes = workspaceClasses(store, '101', [[running, 10], [pr, 20], [done, 30], [failed, 40], [unowned, 50]].map(([name, bytes]) => ({ name, bytes })));
  assert.deepEqual(classes, { active: { count: 1, bytes: 10 }, pull_request: { count: 1, bytes: 20 }, expiring: { count: 3, bytes: 120 } });
});

test('the view lists each computer, the host disk with other, what can be reclaimed and what cleanups freed; page loads read no new tables', async t => {
  const { store } = storeFixture(t), [running, done] = [id(), id()];
  owned(store, '101', running, 't-running', 'running'); owned(store, '101', done, 't-done', 'succeeded', 'review.issue', 2);
  store.run("INSERT INTO trajectory_usage VALUES('101','files',3,4000)");
  store.run("INSERT INTO settings VALUES('workspace_cleanup',?)", JSON.stringify({ 101: { at: '2026-11-14T01:00:00Z', removed: 4, bytes: 4000, skipped: 0 }, 102: { at: '2026-11-14T02:00:00Z', removed: 1, bytes: 1000, skipped: 0 } }));
  t.mock.method(store.disk, 'check', () => ({ free_bytes: 400 * GiB, total_bytes: 1000 * GiB, used_bytes: 600 * GiB, reserve_bytes: 50 * GiB, floor_bytes: GiB, low: false, full: false }));
  let calls = 0;
  const manager = { async call(method, path) {
    calls++; assert.equal(`${method} ${path}`, 'GET /v1/storage');
    return { usage: [{ repository_id: '101', kind: 'files', count: 1, bytes: 2 * GiB }],
      database: { bytes: 10 * GiB, free_pages: 2, free_bytes: 8 * GiB, wal_bytes: 0 }, disk: null, migration: null, expiry: { window_days: 2, last_pass: { finished_at: '2026-11-14T03:00:00Z', files: 9, bytes: 90 * GiB } },
      docker: { images: { count: 3, bytes: 9 * GiB, unused_count: 2, reclaimable_bytes: 3 * GiB }, build_cache: { count: 2, bytes: 3 * GiB, reclaimable_bytes: 2 * GiB } },
      computers: [{ repository_id: '101', generation: 1, scanned_at: '2026-11-14T00:00:00Z', result: { complete: true, total_bytes: 100 * GiB, tasks_bytes: 70 * GiB, journal_bytes: GiB, store_bytes: 4 * GiB,
        home_bytes: 20 * GiB, home_entries: [{ name: '.cache', bytes: 15 * GiB }], tmp_bytes: 0, other_bytes: 5 * GiB, tasks: [{ name: running, bytes: 30 * GiB }, { name: done, bytes: 40 * GiB }] } }] };
  } };
  const report = new StorageReport(store, manager, { git_cache: join(tmpdir(), 'missing-' + id()) });
  await report.refresh();
  const admin = { id: 'admin', role: 'super_admin', repositories: [] }, view = report.view(admin), project = view.projects.find(row => row.repository_id === '101');
  assert.deepEqual(project.computer.workspaces, { active: { count: 1, bytes: 30 * GiB }, pull_request: { count: 0, bytes: 0 }, expiring: { count: 1, bytes: 40 * GiB } });
  assert.equal(project.computer.tasks, undefined, 'the per-directory list stays in the snapshot');
  assert.equal(project.computer.home_entries[0].name, '.cache'); assert.equal(project.computer.cleanup.bytes, 4000);
  assert.equal(view.projects.find(row => row.repository_id === '102').computer, null);
  assert.equal(view.host.known.computers, 100 * GiB); assert.equal(view.host.known.docker_images, 9 * GiB); assert.equal(view.host.known.manager_database, 10 * GiB);
  assert.equal(view.host.known.git_cache, 0); assert.equal(view.host.used_bytes, 600 * GiB);
  assert.equal(view.host.other_bytes, 600 * GiB - view.host.known_bytes); assert.ok(view.host.other_bytes > 0); assert.deepEqual(view.host.unmeasured, []);
  const reclaim = Object.fromEntries(view.reclaimable.map(item => [item.key, item]));
  assert.equal(reclaim.manager_free_pages.bytes, 8 * GiB); assert.deepEqual([reclaim.expiring_workspaces.bytes, reclaim.expiring_workspaces.count], [40 * GiB, 1]);
  assert.equal(reclaim.docker_build_cache.bytes, 2 * GiB); assert.equal(reclaim.docker_unused_images.bytes, 3 * GiB);
  const freed = Object.fromEntries(view.freed.map(item => [item.key, item]));
  assert.deepEqual([freed.manager_expiry.count, freed.manager_expiry.bytes], [9, 90 * GiB]);
  assert.deepEqual([freed.workspace_cleanup.at, freed.workspace_cleanup.count, freed.workspace_cleanup.bytes], ['2026-11-14T02:00:00Z', 5, 5000]);
  // A project administrator sees the computer of their project, nothing of the host.
  const own = report.view({ id: 'p', role: 'project_admin', repositories: ['101'] });
  assert.equal(own.projects[0].computer.total_bytes, 100 * GiB); assert.equal(own.host, undefined); assert.equal(own.reclaimable, undefined);
  // Page loads read counters and the snapshot: no classification, scan or manager call.
  const seen = [], all = store.all.bind(store), get = store.get.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); }; store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  const before = calls;
  for (let i = 0; i < 3; i++) await report.api(admin, 'GET', '/api/storage');
  store.all = all; store.get = get;
  assert.equal(calls, before);
  for (const sql of seen) assert.match(sql, /FROM (repositories|trajectory_usage)\b/, sql);
  // The classification runs again only for a new scan.
  let classified = 0; const classify = store.all.bind(store);
  store.all = (sql, ...args) => { if (/FROM task_workspaces/.test(sql)) classified++; return classify(sql, ...args); };
  await report.refresh(); store.all = classify;
  assert.equal(classified, 0);
});

test('items not measured yet are null and named, not a measured zero', async t => {
  const { store } = storeFixture(t);
  t.mock.method(store.disk, 'check', () => ({ free_bytes: 400 * GiB, total_bytes: 1000 * GiB, used_bytes: 600 * GiB, reserve_bytes: 50 * GiB, floor_bytes: GiB, low: false, full: false }));
  // The manager does not answer, and the git cache could not be measured.
  const report = new StorageReport(store, { call: async () => { throw new Error('manager_unavailable'); } }, { git_cache: join(tmpdir(), 'missing-' + id()) });
  await report.refresh();
  report.directories.values.git_cache.bytes = null;
  const view = report.view({ id: 'admin', role: 'super_admin', repositories: [] });
  for (const key of ['manager_database', 'manager_trajectories', 'computers', 'docker_images', 'docker_build_cache', 'git_cache']) assert.equal(view.host.known[key], null, key);
  assert.deepEqual(view.host.unmeasured.sort(), ['computers', 'docker_build_cache', 'docker_images', 'git_cache', 'manager_database', 'manager_trajectories']);
  assert.equal(view.host.other_bytes, 600 * GiB - view.host.known_bytes);
  const reclaim = Object.fromEntries(view.reclaimable.map(item => [item.key, item]));
  assert.equal(reclaim.manager_free_pages.bytes, null); assert.equal(reclaim.docker_build_cache.bytes, null); assert.equal(reclaim.docker_unused_images.count, null);
});
