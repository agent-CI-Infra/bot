import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, walSizeLimit } from '../dist/storage/database.js';

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-initialization-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { path: join(directory, 'control.sqlite'), key: randomBytes(32) };
}

test('a fresh schema is durable on reopen with foreign keys, WAL and full synchronous writes', t => {
  const { path, key } = database(t);
  let store = new Store(path, key);
  t.after(() => store.close());
  store.run("INSERT INTO settings VALUES('initialization-probe','retained')");
  const schema = () => store.all("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
  const before = schema();
  assert.ok(before.some(row => row.name === 'task_workspaces'), 'late schema modules were initialized');
  assert.ok(store.get("SELECT 1 FROM settings WHERE key='task_metrics_v1'"), 'nested initialization transactions committed');
  store.close();
  store = new Store(path, key);
  assert.deepEqual(schema(), before);
  assert.equal(store.get("SELECT value FROM settings WHERE key='initialization-probe'").value, 'retained');
  assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(store.get('PRAGMA synchronous').synchronous, 2);
  assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(store.get('PRAGMA journal_size_limit').journal_size_limit, walSizeLimit);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  assert.equal(store.get('PRAGMA integrity_check').integrity_check, 'ok');
});

test('a late initialization failure rolls back the new schema and the empty file can be initialized again', t => {
  const { path, key } = database(t), exec = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS task_workspaces')) throw new Error('initialization-probe-failure');
    return exec.call(this, sql);
  });
  assert.throws(() => new Store(path, key), /initialization-probe-failure/);
  fault.mock.restore();
  const db = new DatabaseSync(path);
  try { assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n, 0); }
  finally { db.close(); }
  const store = new Store(path, key);
  t.after(() => store.close());
  assert.ok(store.hasTable('task_workspaces'));
  assert.equal(store.get('PRAGMA integrity_check').integrity_check, 'ok');
});
