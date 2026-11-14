import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { StorageReport } from '../dist/app/storage.js';
import { PayloadMigration, migrationKey } from '../dist/storage/migration.js';
import { DiskGuard, diskFull, diskState, floorBytes, reserveBytes } from '../dist/storage/disk.js';
import { automaticState, explainFailure, failureCause, isAttemptFailure } from '../dist/agent/failures.js';
import { HttpError } from '../dist/core/security.js';
import { emptyRepositoryFixture } from './empty-repository-helpers.mjs';

// #671: the free-space guard, and how tasks and the storage page see a full disk or an expired manager result.
const GiB = 1024 ** 3;
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write '/data/git-cache/x'"), { code: 'ENOSPC' });
const disk = (free, total = 1000 * GiB) => ({ free_bytes: free, total_bytes: total, reserve_bytes: reserveBytes(total), floor_bytes: floorBytes(total), low: free < reserveBytes(total), full: free < floorBytes(total) });

test('the reserve is the smaller of 5 % and 50 GiB, the floor the smaller of 1 % and 1 GiB; full-disk errors are recognized', () => {
  assert.equal(reserveBytes(1000 * GiB), 50 * GiB); assert.equal(reserveBytes(200 * GiB), 10 * GiB);
  assert.equal(floorBytes(1000 * GiB), GiB); assert.equal(floorBytes(50 * GiB), Math.floor(0.5 * GiB));
  const state = diskState(tmpdir()); assert.ok(state.total_bytes > 0 && state.reserve_bytes > 0 && typeof state.low === 'boolean');
  assert.equal(diskState('/nonexistent-' + Date.now()), null);
  for (const error of [enospc(), Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 }), { errcode: 13 | (1 << 8) }, new Error('write failed: No space left on device')])
    assert.equal(diskFull(error), true, String(error?.message));
  for (const error of [new Error('ECONNRESET'), Object.assign(new Error('busy'), { errcode: 5 }), null]) assert.equal(diskFull(error), false);
  // The guard reads the disk at most once per ttl and logs when the space falls below the reserve and when it is back.
  const lines = [], states = [disk(10 * GiB), disk(10 * GiB), disk(80 * GiB)];
  const guard = new DiskGuard('/data', { ttlMs: 0, log: line => lines.push(line), state: () => states.shift() });
  assert.equal(guard.check().low, true); assert.equal(guard.check().low, true); assert.equal(guard.check().low, false);
  assert.deepEqual(lines, ['[disk] /data: 10.0 GiB free, below the reserve of 50.0 GiB; background writes pause', '[disk] /data: 80.0 GiB free again; background writes resume']);
  const cached = new DiskGuard('/data', { ttlMs: 60_000, log: () => {}, state: () => disk(5 * GiB) });
  assert.equal(cached.check(), cached.check());
});

test('a full disk waits for space without using up retries; an expired manager result starts a new attempt', () => {
  assert.equal(failureCause('disk_full', 'waiting_environment'), 'environment');
  assert.equal(failureCause('operation_result_expired', 'waiting_environment'), 'environment');
  assert.equal(isAttemptFailure('disk_full', 'waiting_environment'), false);
  assert.equal(isAttemptFailure('operation_result_expired', 'waiting_environment'), true);
  assert.equal(automaticState('disk_full', 'waiting_environment'), 'waiting_environment');
  const explained = explainFailure('disk_full', 'waiting_environment');
  assert.equal(explained.automatic, true); assert.match(explained.action, /「存储」/); assert.match(explained.action, /自动继续/);
  assert.match(explainFailure('operation_result_expired', 'waiting_environment').action, /新的尝试/);
});

test('a task does not prepare on an all but full disk, and continues once there is space', async t => {
  const h = await emptyRepositoryFixture(t); h.setBranch('ready');
  let state = disk(100 * 1024 ** 2);
  t.mock.method(h.store.disk, 'check', () => state);
  let task = await h.run();
  assert.deepEqual([task.status, task.error_code], ['waiting_environment', 'disk_full']);
  assert.deepEqual(h.operations, [], 'nothing was written to the computer');
  assert.equal(task.retry_count, 0, 'waiting for space is not a failed attempt');
  state = disk(500 * GiB); h.due();
  task = await h.run(); assert.equal(task.status, 'succeeded');
});

test('a write that fails on a full disk stops the task as disk_full, in the control plane and in the manager', async t => {
  // The manager answers disk_full.
  let manager = true;
  const h = await emptyRepositoryFixture(t, { execute(request) { if (manager && request.type === 'workspace_init') throw new HttpError(507, 'disk_full'); } }); h.setBranch('ready');
  let task = await h.run();
  assert.deepEqual([task.status, task.error_code], ['waiting_environment', 'disk_full']);
  // The control plane's own write fails (here its trajectory file).
  manager = false;
  const append = h.store.trajectories.append.bind(h.store.trajectories); let failing = true;
  t.mock.method(h.store.trajectories, 'append', (...args) => { if (failing) throw enospc(); return append(...args); });
  t.mock.method(console, 'error', () => {});
  h.due(); task = await h.run();
  assert.deepEqual([task.status, task.error_code], ['waiting_environment', 'disk_full']);
  const fault = h.store.all('SELECT content FROM task_logs WHERE task_id=?', h.taskId).map(row => JSON.parse(row.content)).filter(log => log.type === 'fault').at(-1);
  assert.match(fault.detail, /数据盘空间不足/);
  failing = false; h.due(); task = await h.run(); assert.equal(task.status, 'succeeded');
});

test('a repeated call whose stored result the manager removed starts a new attempt instead of guessing', async t => {
  let expired = true;
  const h = await emptyRepositoryFixture(t, { execute(request) { if (expired && request.type === 'workspace_init') throw new HttpError(410, 'operation_result_expired'); } }); h.setBranch('ready');
  const before = h.store.get('SELECT attempt FROM tasks WHERE id=?', h.taskId).attempt;
  let task = await h.run();
  assert.deepEqual([task.status, task.error_code, task.attempt], ['waiting_environment', 'operation_result_expired', before + 1]);
  expired = false; h.due(); task = await h.run(); assert.equal(task.status, 'succeeded');
});

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'storage-guard-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 5));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','101','task.request','running','Fixture','{}')");
  return store;
}

test('the payload migration waits while the disk is below its reserve or full, and moves the rows it left once there is space', async t => {
  const store = storeFixture(t);
  for (let i = 0; i < 5; i++) store.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES(?,'t',?,?,'completed')", 'op' + i, JSON.stringify({ request: { type: 'workspace_read', path: 'row ' + i } }), JSON.stringify({ output: 'out ' + i }));
  let low = true, full = 2;
  const append = store.trajectories.append.bind(store.trajectories);
  t.mock.method(store.trajectories, 'append', (...args) => { if (full > 0 && JSON.stringify(args[3]).includes('row 2')) { full--; throw enospc(); } return append(...args); });
  const migration = new PayloadMigration(store, { readMs: 0, pauseMs: 1, idleMs: 60_000, lowDiskMs: 5, guard: { check: () => ({ low }) }, log: () => {} });
  const state = () => JSON.parse(store.get('SELECT value FROM settings WHERE key=?', migrationKey)?.value ?? '{}');
  const wait = async until => { for (let i = 0; i < 1000 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(until()); };
  migration.start(); t.after(() => migration.stop());
  await wait(() => state().paused === 'low_disk');
  assert.equal(store.get("SELECT count(*) n FROM task_tools WHERE request_ref IS NOT NULL").n, 0);
  low = false;
  await wait(() => state().phases?.task_tools?.finished_at);
  assert.equal(state().phases.task_tools.migrated, 5, 'the row that hit the full disk moved later'); assert.equal(state().phases.task_tools.failed, 0);
  assert.equal(state().paused, null);
});

test('platform administrators see an alert for each data disk below its reserve and the manager expiry; projects see removed manager files', async t => {
  const store = storeFixture(t);
  let control = disk(500 * GiB);
  t.mock.method(store.disk, 'check', () => control);
  const manager = { async call() {
    return { usage: [{ repository_id: '101', kind: 'files', count: 2, bytes: 200 }, { repository_id: '101', kind: 'expired', count: 3, bytes: 3000 }],
      database: { bytes: 8192, free_pages: 0, free_bytes: 0 }, disk: disk(20 * GiB), migration: { phases: {}, remaining: {} },
      expiry: { window_days: 2, last_pass: { started_at: '2026-11-14T00:00:00Z', finished_at: '2026-11-14T00:01:00Z', files: 3, bytes: 3000 }, last_error: null } };
  } };
  const report = new StorageReport(store, manager), admin = { id: 'admin', role: 'super_admin', repositories: [] };
  let view = await report.api(admin, 'GET', '/api/storage');
  assert.deepEqual(view.alerts.map(alert => alert.where), ['manager']);
  assert.equal(view.alerts[0].reserve_bytes, 50 * GiB);
  assert.equal(view.totals.manager.expiry.last_pass.files, 3);
  assert.deepEqual(view.projects.find(row => row.repository_id === '101').manager.expired, { count: 3, bytes: 3000 });
  // The control plane's own disk is read at each view (one statfs), not only at the refresh.
  control = disk(10 * GiB);
  view = await report.api(admin, 'GET', '/api/storage');
  assert.deepEqual(view.alerts.map(alert => alert.where), ['control', 'manager']);
  const project = await report.api({ id: 'p', role: 'project_admin', repositories: ['101'] }, 'GET', '/api/storage');
  assert.equal(project.alerts, undefined); assert.equal(project.totals, undefined);
});
