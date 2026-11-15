import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsole } from './console-page.mjs';
import { Store } from '../dist/storage/database.js';
import { StorageReport } from '../dist/app/storage.js';

// The storage page keeps the last manager snapshot when a read fails (#793): a timeout or a 5xx must not turn the
// project computers, the manager's database and Docker figures and the disk alert into "unknown", and the page has to
// say which read the numbers come from.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'storage-stale-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 4));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  const state = { error: null, reads: 0, answer: null };
  const manager = { async call(method, path) {
    assert.equal(`${method} ${path}`, 'GET /v1/storage'); state.reads++;
    if (state.error) throw new Error(state.error);
    return state.answer;
  } };
  state.answer = {
    usage: [{ repository_id: '101', kind: 'files', count: 4, bytes: 4000 }],
    database: { bytes: 8192, free_pages: 1, free_bytes: 4096 },
    // The manager's own disk, below its reserve: the page raises an alert for it.
    disk: { free_bytes: 100, total_bytes: 1000, reserve_bytes: 500, low: true },
    migration: { phases: {}, remaining: {} },
    // A project computer's last scan, as the manager carries it.
    computers: [{ repository_id: '101', generation: 1, scanned_at: '2026-01-01T00:00:00.000Z',
      result: { total_bytes: 9000, journal_bytes: 10, store_bytes: 20, home_bytes: 30, other_bytes: 5, tmp_bytes: 1, task_count: 0 } }],
  };
  return { store, report: new StorageReport(store, manager), state };
}
const admin = { id: 'admin', role: 'super_admin', repositories: [] };
const project = (view, id) => view.projects.find(row => row.repository_id === id);

test('a manager read that fails keeps the last snapshot and says so; a recovery clears the error', async t => {
  const { report, state } = fixture(t);
  const first = await report.api(admin, 'GET', '/api/storage');
  assert.equal(first.manager_error, null, 'a successful read records no error');
  assert.ok(first.manager_read_at, 'a successful read records when it happened');
  assert.equal(first.totals.manager.database.bytes, 8192);
  assert.equal(project(first, '101').computer.total_bytes, 9000);
  assert.equal(project(first, '101').manager.files.count, 4);
  assert.deepEqual(first.alerts.map(alert => [alert.where, alert.stale]), [['manager', false]]);

  // The manager answers 503 this time: the page keeps the numbers it already had.
  state.error = 'manager answered 503'; await report.refresh();
  const stale = await report.api(admin, 'GET', '/api/storage');
  assert.equal(stale.manager_error, 'manager answered 503', 'the failed read is reported');
  assert.equal(stale.manager_read_at, first.manager_read_at, 'the time of the last successful read stays');
  assert.equal(stale.totals.manager.database.bytes, 8192, 'the manager database figure stays');
  assert.equal(stale.totals.manager.disk.free_bytes, 100, 'and so does its disk figure');
  assert.equal(project(stale, '101').computer.total_bytes, 9000, 'the project computer keeps its last scan');
  assert.equal(project(stale, '101').manager.files.count, 4, 'and the manager usage of the project stays');
  assert.deepEqual(stale.alerts.map(alert => [alert.where, alert.stale]), [['manager', true]], 'the disk alert stays, marked stale');
  assert.equal(state.reads, 2);

  // The manager comes back with different numbers: the error clears and the figures move.
  state.error = null;
  state.answer = { ...state.answer, database: { bytes: 16384, free_pages: 2, free_bytes: 8192 }, disk: { free_bytes: 900, total_bytes: 1000, reserve_bytes: 500, low: false },
    computers: [{ ...state.answer.computers[0], generation: 2, result: { ...state.answer.computers[0].result, total_bytes: 12000 } }] };
  await report.refresh();
  const back = await report.api(admin, 'GET', '/api/storage');
  assert.equal(back.manager_error, null, 'the error is cleared by a successful read');
  assert.ok(back.manager_read_at >= first.manager_read_at, 'the read time moves forward');
  assert.equal(back.totals.manager.database.bytes, 16384);
  assert.equal(project(back, '101').computer.total_bytes, 12000);
  assert.deepEqual(back.alerts, [], 'the stale alert goes once the disk is above its reserve again');
  assert.equal(state.reads, 3);
});

test('a manager that never answered reports the error without inventing numbers', async t => {
  const { report, state } = fixture(t);
  state.error = 'manager did not answer';
  await report.refresh();
  const view = await report.api(admin, 'GET', '/api/storage');
  assert.equal(view.manager_error, 'manager did not answer');
  assert.equal(view.manager_read_at, null, 'no read has succeeded yet');
  assert.equal(view.totals.manager, null, 'no manager figures are made up');
  assert.deepEqual(view.alerts, []);
  assert.equal(project(view, '101').computer, null);
});

// The page says which read the numbers come from, and marks the alert it kept (#793).
const scripts = ['static/app.js', 'static/views.js', 'static/costs.js', 'static/project.js', 'static/settings.js', 'static/onboarding.js'];
const textOf = node => [node.textContent, ...node.children.flatMap(textOf)].join(' ');
test('the storage page says the manager read failed and marks the alert it kept', async () => {
  let view = { refreshed_at: '2026-11-15T08:00:00.000Z', manager_read_at: '2026-11-15T07:55:00.000Z', manager_error: 'manager answered 503', projects: [],
    alerts: [{ where: 'manager', free_bytes: 1024, total_bytes: 4096, reserve_bytes: 2048, stale: true }] };
  const page = loadConsole(scripts, (method, path) => {
    if (method === 'GET' && path === '/api/storage') return [200, view];
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/storage';");
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel'), shown = textOf(panel);
  assert.match(shown, /上次读取于/, 'the page names when the numbers were read');
  assert.match(shown, /manager 读取失败/, 'and says this read failed');
  assert.match(shown, /可能过期/, 'so the reader knows they may be stale');
  assert.match(shown, /manager所在磁盘/, 'the alert it kept is still shown');
  assert.match(shown, /上次已知状态/, 'marked as the last known state');
  // A read that succeeded has neither sentence.
  view = { refreshed_at: '2026-11-15T08:05:00.000Z', manager_read_at: '2026-11-15T08:05:00.000Z', manager_error: null, projects: [], alerts: [] };
  await page.run('renderSettings(renderVersion)');
  const fresh = textOf(page.$('settings-panel'));
  assert.doesNotMatch(fresh, /manager 读取失败/);
  assert.doesNotMatch(fresh, /可能过期/);
});
