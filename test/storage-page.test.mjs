import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { StorageReport } from '../dist/app/storage.js';
import { runScope } from '../dist/storage/trajectories.js';
import { storedInput } from '../dist/storage/payloads.js';
import { harness, setup } from './helpers.mjs';
import { loadConsole } from './console-page.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'storage-page-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 4));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  for (const id of ['101', '102']) store.run('INSERT INTO repositories VALUES(?,?,?,?)', id, 'fixture/project-' + id, '10', 'a');
  // Two finished runs of project 101, one of 102, and one still being written; a blob of 101.
  for (const [repo, run] of [['101', 'r1'], ['101', 'r2'], ['102', 'r3']]) {
    const scope = runScope(repo, 't-' + run, run);
    store.trajectories.append(scope, 'model_request', 'm', { body: { messages: [{ content: 'x'.repeat(500) }] } });
    store.trajectories.append(scope, 'tool_call', 'c', { request: {} }); store.trajectories.append(scope, 'tool_result', 'c', { output: 'y'.repeat(1000) });
    store.trajectories.close(scope.key);
  }
  store.trajectories.append(runScope('101', 't-open', 'open'), 'log', 'l', { output: 'z'.repeat(300) });
  storedInput(store, { snapshot_files: Array.from({ length: 200 }, (_, i) => ({ path: 'f' + i })) }, '101');
  // The manager's own numbers, as its /v1/storage answers.
  const manager = { async call(method, path) {
    assert.equal(`${method} ${path}`, 'GET /v1/storage');
    return { usage: [{ repository_id: '101', kind: 'files', count: 4, bytes: 4000 }, { repository_id: '101', kind: 'records:tool_result', count: 9, bytes: 3000 }, { repository_id: '202', kind: 'files', count: 1, bytes: 10 }, { repository_id: '101', kind: 'open', count: 1, bytes: 7 }],
      database: { bytes: 8192, free_pages: 1, free_bytes: 4096 }, disk: { free_bytes: 1, total_bytes: 2 }, migration: { phases: { operations: { migrated: 3 } }, remaining: { operations: 0 } } };
  } };
  return { store, report: new StorageReport(store, manager) };
}
const superAdmin = { id: 'admin', role: 'super_admin', repositories: [] }, projectAdmin = { id: 'p', role: 'project_admin', repositories: ['102'] };

test('each project lists its files, records by type and blobs; platform administrators also see the totals', async t => {
  const { store, report } = fixture(t);
  const view = await report.api(superAdmin, 'GET', '/api/storage');
  const project = id => view.projects.find(row => row.repository_id === id);
  assert.equal(project('101').name, 'fixture/project-101');
  assert.equal(project('101').files.count, 2); assert.ok(project('101').files.bytes > 3000);
  assert.equal(project('101').records.tool_result.count, 2); assert.equal(project('101').records.model_request.count, 2);
  assert.equal(project('101').blobs.count, 1); assert.ok(project('101').blobs.bytes > 2048);
  assert.equal(project('101').open.count, 1); assert.ok(project('101').open.bytes > 300, 'the file still being written is sized by the refresh');
  assert.deepEqual(project('101').manager.files, { count: 4, bytes: 4000 }); assert.deepEqual(project('101').manager.open, { count: 1, bytes: 7 }); assert.equal(project('101').manager.records.tool_result.count, 9);
  assert.equal(project('102').files.count, 1); assert.equal(project('102').manager, null);
  // A project only the manager still knows (deleted here) is listed for platform administrators by its id.
  assert.equal(project('202').manager.files.count, 1);
  assert.ok(view.totals.control.database.bytes > 0); assert.ok(Number.isSafeInteger(view.totals.control.database.free_pages));
  assert.ok(view.totals.control.disk.total_bytes > 0); assert.ok('task_tools' in view.totals.control.migration.remaining);
  assert.equal(view.totals.manager.database.bytes, 8192); assert.equal(view.totals.manager.migration.phases.operations.migrated, 3);
  assert.ok(view.refreshed_at);
  void store;
});

test('project administrators see only their own projects and no platform totals', async t => {
  const { report } = fixture(t);
  const view = await report.api(projectAdmin, 'GET', '/api/storage');
  assert.deepEqual(view.projects.map(row => row.repository_id), ['102']); assert.equal(view.totals, undefined);
  assert.equal(view.projects[0].files.count, 1);
  const none = await report.api({ id: 'n', role: 'project_admin', repositories: [] }, 'GET', '/api/storage');
  assert.deepEqual(none.projects, []);
});

test('loading the page reads counters only: it never touches trajectory files, payload tables or the manager', async t => {
  const { store, report } = fixture(t);
  await report.refresh();
  const seen = [], all = store.all.bind(store), get = store.get.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  const calls = []; report.manager = { call: (...args) => { calls.push(args); return Promise.resolve(null); } };
  for (let i = 0; i < 3; i++) await report.api(superAdmin, 'GET', '/api/storage');
  store.all = all; store.get = get;
  assert.equal(calls.length, 0);
  assert.ok(seen.length > 0);
  for (const sql of seen) assert.match(sql, /FROM (repositories|trajectory_usage)\b/, sql);
  for (const sql of seen) assert.doesNotMatch(store.all('EXPLAIN QUERY PLAN ' + sql.replace(/\?/g, "'x'")).map(row => row.detail).join(' | '), /SCAN (task_tools|task_logs|model_requests|task_history|trajectory_files)/);
});

test('the console API serves the storage view to signed-in users only', async t => {
  const h = await harness(t);
  assert.equal((await h.client()('/api/storage')).status, 401);
  const { admin } = await setup(h);
  const response = await admin('/api/storage');
  assert.equal(response.status, 200); assert.ok(Array.isArray(response.value.projects)); assert.ok(response.value.totals.control.database.bytes > 0);
});

test('#671 S1: the split names what a VACUUM would hand back and the part of the disk that is not itemised yet', async t => {
  const { report } = fixture(t), view = await report.api(superAdmin, 'GET', '/api/storage');
  const page = loadConsole(['static/settings/page.js'], () => [404, { error: 'not_found' }]);
  const usageBytes = (usage, kinds, records) => {
    if (!usage) return 0;
    let bytes = 0;
    for (const kind of kinds) bytes += usage[kind]?.bytes ?? 0;
    if (records) for (const record of Object.values(usage.records ?? {})) bytes += record.bytes ?? 0;
    return bytes;
  };
  // Exactly the detail the table lists: both database files with their WAL, each project's own numbers, and the
  // manager's files and open payloads — its record copies are not a column here and so stay in 其它.
  let controlKnown = view.totals.control.database.bytes + (view.totals.control.database.wal_bytes ?? 0);
  let managerKnown = view.totals.manager.database.bytes + (view.totals.manager.database.wal_bytes ?? 0);
  for (const project of view.projects) { controlKnown += usageBytes(project, ['files', 'blobs', 'open'], true); managerKnown += usageBytes(project.manager, ['files', 'open'], false); }
  page.run('var view = ' + JSON.stringify(view));
  const split = page.run('storageSplit(view)');
  assert.deepEqual([split.controlKnown, split.managerKnown], [controlKnown, managerKnown]);
  // 可回收 is the sum of both databases' free pages: 1 GiB and 2 GiB must read 3 GiB, never one of them, never the WAL.
  const stubbed = { ...view, totals: { ...view.totals,
    control: { ...view.totals.control, database: { ...view.totals.control.database, free_bytes: 1024 ** 3, wal_bytes: 999 } },
    manager: { ...view.totals.manager, database: { ...view.totals.manager.database, free_bytes: 2 * 1024 ** 3, wal_bytes: 777 } } } };
  page.run('var stubbed = ' + JSON.stringify(stubbed));
  assert.equal(page.run('storageSplit(stubbed).reclaimable'), 3 * 1024 ** 3);
  assert.equal(split.reclaimable, view.totals.control.database.free_bytes + view.totals.manager.database.free_bytes);
  // One file system for both databases: a single 其它 row, and it subtracts every number the table lists.
  const disk = { free_bytes: 20 * 1024 ** 3, total_bytes: 100 * 1024 ** 3 };
  const sharedView = { ...view, totals: { ...view.totals, control: { ...view.totals.control, disk }, manager: { ...view.totals.manager, disk } } };
  page.run('var sharedView = ' + JSON.stringify(sharedView));
  const shared = page.run('storageSplit(sharedView)');
  assert.equal(shared.sameDisk, true); assert.equal(shared.others.length, 1);
  assert.equal(shared.others[0].bytes, 100 * 1024 ** 3 - 20 * 1024 ** 3 - controlKnown - managerKnown);
  // The two databases on different disks: one row each, each with its own disk and its own detail.
  const wide = { ...sharedView, totals: { ...sharedView.totals, manager: { ...sharedView.totals.manager, disk: { free_bytes: 5 * 1024 ** 3, total_bytes: 10 * 1024 ** 3 } } } };
  page.run('var wide = ' + JSON.stringify(wide));
  const split2 = page.run('storageSplit(wide)');
  assert.equal(split2.sameDisk, false);
  assert.deepEqual([...split2.others.map(row => row.where)], ['控制面', 'manager']);
  assert.deepEqual([...split2.others.map(row => row.bytes)],
    [100 * 1024 ** 3 - 20 * 1024 ** 3 - controlKnown, 10 * 1024 ** 3 - 5 * 1024 ** 3 - managerKnown]);
  // The same size with a free space a moment apart is still one file system; a different size is not.
  page.run('var apart = ' + JSON.stringify({ ...sharedView, totals: { ...sharedView.totals, manager: { ...sharedView.totals.manager, disk: { ...disk, free_bytes: disk.free_bytes - 1024 ** 2 } } } }));
  assert.equal(page.run('storageSplit(apart).sameDisk'), true);
  page.run('var bigger = ' + JSON.stringify({ ...sharedView, totals: { ...sharedView.totals, manager: { ...sharedView.totals.manager, disk: { ...disk, total_bytes: disk.total_bytes * 2 } } } }));
  assert.equal(page.run('storageSplit(bigger).sameDisk'), false);
  // A deployment that cannot stat its file system draws no 其它 row at all, never a made-up number.
  page.run('var none = ' + JSON.stringify({ ...view, totals: { ...view.totals, control: { ...view.totals.control, disk: null }, manager: null } }));
  const missing = page.run('storageSplit(none)');
  assert.deepEqual([missing.sameDisk, missing.others.length], [false, 0]);
  // Counters that overshoot the disk clamp at zero instead of showing a negative other.
  page.run('var over = ' + JSON.stringify({ ...sharedView, totals: { ...sharedView.totals, control: { ...sharedView.totals.control, disk: { free_bytes: 0, total_bytes: 10 } }, manager: { ...sharedView.totals.manager, disk: { free_bytes: 0, total_bytes: 10 } } } }));
  assert.deepEqual([...page.run('storageSplit(over).others.map(row => row.bytes)')], [0]);
});
