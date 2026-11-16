import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { fixtureStore } from './database-fixture.mjs';

function databases(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-database-fixture-')), stores = new Set();
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    open(name, create = fixtureStore) {
      const key = randomBytes(32), path = join(root, name), store = create === Store ? new Store(path, key) : create(path, key);
      stores.add(store); return { store, key, path };
    },
    close(store) { store.close(); stores.delete(store); },
  };
}
const contents = store => Object.fromEntries(store.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map(({ name }) => [name, store.all('SELECT * FROM "' + name.replaceAll('"', '""') + '"')]));

test('schema fixtures have fresh Store defaults, isolated data and the same durability settings', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const f = databases(t), fresh = f.open('fresh', Store), first = f.open('first'), second = f.open('second');
  assert.deepEqual(contents(first.store), contents(fresh.store));
  assert.deepEqual(contents(second.store), contents(fresh.store));
  assert.notDeepEqual(first.key, second.key);
  for (const { store } of [fresh, first, second]) {
    assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(store.get('PRAGMA synchronous').synchronous, 2);
    assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  }
  first.store.run("INSERT INTO accounts VALUES('fixture','fixture','github_app','1','{}','now')");
  assert.equal(second.store.get('SELECT count(*) n FROM accounts').n, 0);
});

test('schema fixtures generate current timestamps and reopening retains that database instead of reseeding it', t => {
  const now = Date.parse('2026-02-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = databases(t), first = f.open('first'), roles = store => store.all('SELECT id,created_at FROM service_roles ORDER BY id');
  assert.ok(roles(first.store).length > 0);
  assert.ok(roles(first.store).every(row => row.created_at === new Date(now).toISOString()));
  t.mock.timers.tick(60_000);
  const second = f.open('second');
  assert.ok(roles(second.store).every(row => row.created_at === new Date(now + 60_000).toISOString()));
  first.store.run("INSERT INTO accounts VALUES('kept','kept','github_app','1','{}','now')");
  f.close(first.store);
  const reopened = fixtureStore(first.path, first.key);
  try {
    assert.equal(reopened.get("SELECT count(*) n FROM accounts WHERE id='kept'").n, 1);
    assert.ok(roles(reopened).every(row => row.created_at === new Date(now).toISOString()));
  } finally { reopened.close(); }
});
