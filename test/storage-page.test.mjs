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
