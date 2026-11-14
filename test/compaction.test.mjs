import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compactDatabase, databasePages, IncrementalVacuum, requiredBytes } from '../manager/compaction.mjs';

// #671: each service compacts its database once at start when free pages are most of it, then returns later free pages
// in small steps.
const GiB = 1024 ** 3;
function database(t, { rows = 6000, keep = 4 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'compaction-')), path = join(directory, 'control.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE ops(id INTEGER PRIMARY KEY, task TEXT, body TEXT); CREATE INDEX ops_task ON ops(task); CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare('INSERT INTO ops(task,body) VALUES(?,?)');
  db.exec('BEGIN'); for (let i = 0; i < rows; i++) insert.run('t' + (i % 50), 'x'.repeat(6000) + i); db.exec('COMMIT');
  db.exec(`DELETE FROM ops WHERE id % ${keep} <> 0`);
  return { directory, path, db };
}
const options = { minFreeBytes: 0, log: () => {} };

test('a database whose free pages are most of it is rewritten without them, keeping every row, its WAL and its indexes', async t => {
  const { directory, path, db } = database(t), before = databasePages(db);
  // Rows still in the WAL (no checkpoint yet) belong to the database too.
  db.prepare("INSERT INTO settings VALUES('in-wal','kept')").run();
  const rows = db.prepare('SELECT count(*) n FROM ops').get().n, sum = db.prepare('SELECT sum(length(body)) s FROM ops').get().s;
  db.close();
  assert.ok(before.free_pages > before.pages * 0.5 && before.auto_vacuum === 0);
  const lines = [], result = await compactDatabase(path, { ...options, log: line => lines.push(line) });
  assert.equal(result.action, 'compacted', JSON.stringify(result));
  assert.ok(result.after_bytes < before.bytes / 2); assert.equal(result.freed_bytes, before.bytes - result.after_bytes);
  assert.equal(statSync(path).size, result.after_bytes);
  assert.deepEqual(readdirSync(directory).sort(), ['control.sqlite'], 'no copy, link or WAL is left');
  const after = new DatabaseSync(path);
  assert.equal(after.prepare('SELECT count(*) n FROM ops').get().n, rows); assert.equal(after.prepare('SELECT sum(length(body)) s FROM ops').get().s, sum);
  assert.equal(after.prepare("SELECT value FROM settings WHERE key='in-wal'").get().value, 'kept');
  assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.match(after.prepare("EXPLAIN QUERY PLAN SELECT id FROM ops WHERE task='t1'").all().map(row => row.detail).join(), /ops_task/);
  const pages = databasePages(after);
  assert.equal(pages.auto_vacuum, 2, 'the copy returns later free pages incrementally'); assert.equal(pages.free_pages, 0);
  assert.match(lines[0], /compacting .*control\.sqlite/); assert.match(lines.at(-1), /compacted .*freed/);
  // Once compacted (incremental) it is not rewritten again.
  after.close();
  assert.deepEqual([(await compactDatabase(path, options)).action, (await compactDatabase(path, options)).reason], ['not_needed', 'incremental']);
});

test('without enough disk for the copy, or with few free pages, the database stays as it is and the reason is kept', async t => {
  const { path, db } = database(t), before = databasePages(db); db.close();
  const size = statSync(path).size;
  const skipped = await compactDatabase(path, { ...options, diskFree: async () => requiredBytes(before.live_bytes) - 1 });
  assert.deepEqual([skipped.action, skipped.reason, skipped.required_bytes], ['skipped', 'disk_space', requiredBytes(before.live_bytes)]);
  assert.ok(skipped.required_bytes >= before.live_bytes + GiB);
  assert.equal(statSync(path).size, size);
  const few = await compactDatabase(path, { log: () => {} });
  assert.deepEqual([few.action, few.reason], ['not_needed', 'few_free_pages'], 'below 1 GiB of free pages by default');
  const ratio = await compactDatabase(path, { ...options, minFreeRatio: 0.99 });
  assert.deepEqual([ratio.action, ratio.reason], ['not_needed', 'few_free_pages']);
  assert.equal((await compactDatabase(join(path, '..', 'missing.sqlite'), options)).reason, 'no_database');
});

test('a start after a stopped compaction removes its partial copy and the link to the old file', async t => {
  const { directory, path, db } = database(t); db.close();
  writeFileSync(path + '.compact', 'partial'); writeFileSync(path + '.before-compact', 'old');
  const result = await compactDatabase(path, { ...options, minFreeRatio: 1.1 });
  assert.equal(result.action, 'not_needed');
  assert.deepEqual(readdirSync(directory).sort(), ['control.sqlite']); assert.ok(existsSync(path));
});

test('the incremental vacuum returns free pages of a compacted database in steps and leaves others alone', async t => {
  const { path, db } = database(t); db.close();
  await compactDatabase(path, options);
  const after = new DatabaseSync(path); t.after(() => after.close());
  after.exec('PRAGMA journal_mode=WAL'); after.exec('DELETE FROM ops WHERE id % 8 = 0');
  const free = databasePages(after).free_pages, size = databasePages(after).bytes;
  assert.ok(free > 100);
  const vacuum = new IncrementalVacuum(after, { step: 50, minPages: 10, pauseMs: 0 });
  assert.equal(vacuum.state().auto_vacuum, 2);
  const returned = await vacuum.run();
  assert.ok(returned >= free - 10, `${returned} of ${free}`); assert.ok(databasePages(after).free_pages <= 10);
  assert.ok(databasePages(after).bytes < size); assert.equal(vacuum.state().last.pages, returned);
  // A database not compacted yet (auto_vacuum=NONE) keeps its pages for the next start.
  const other = database(t, { rows: 500 }), untouched = new IncrementalVacuum(other.db, { minPages: 0, pauseMs: 0 });
  assert.equal(await untouched.run(), 0); other.db.close();
});

test('the storage page shows each database compaction at the last start and its incremental vacuum', async t => {
  const { Store } = await import('../dist/storage/database.js'), { StorageReport } = await import('../dist/app/storage.js'), { managerFixture } = await import('./project-manager-fixture.mjs');
  const f = await managerFixture(t);
  f.projects.db.prepare("INSERT INTO settings VALUES('compaction',?)").run(JSON.stringify({ action: 'skipped', reason: 'disk_space', at: '2026-11-14T00:00:00Z', required_bytes: 11 * GiB, disk_free_bytes: GiB }));
  const manager = f.projects.storage();
  assert.equal(manager.compaction.reason, 'disk_space'); assert.equal(manager.vacuum.auto_vacuum, 0); assert.equal(manager.database.auto_vacuum, 0);
  const directory = mkdtempSync(join(tmpdir(), 'compaction-view-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 9));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO settings VALUES('compaction',?)", JSON.stringify({ action: 'compacted', at: '2026-11-14T00:00:00Z', before: { bytes: 128 * GiB }, after_bytes: 27 * GiB, duration_ms: 1000 }));
  const vacuum = { state: () => ({ auto_vacuum: 2, last: { finished_at: '2026-11-14T01:00:00Z', pages: 10, bytes: 40960 } }) };
  const report = new StorageReport(store, { call: async () => manager }, {}, vacuum);
  await report.refresh();
  const view = report.view({ id: 'admin', role: 'super_admin', repositories: [] });
  assert.equal(view.totals.control.compaction.after_bytes, 27 * GiB); assert.equal(view.totals.control.vacuum.last.bytes, 40960);
  assert.equal(view.totals.manager.compaction.reason, 'disk_space'); assert.equal(view.totals.manager.vacuum.auto_vacuum, 0);
  assert.equal(view.totals.control.database.auto_vacuum, 0);
});
