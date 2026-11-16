import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { modelServes } from '../dist/models/sharing.js';
import { modelGaps } from '../dist/service-roles/roles.js';
import { visibleModel } from '../dist/agent/model.js';

// Shared models serve every project unless a super administrator restricts them (#850).

test('upgrading keeps every project to the shared models it had: a model granted to all serves all, others stay restricted', t => {
  const directory = mkdtempSync(join(tmpdir(), 'model-sharing-')), database = join(directory, 'control.sqlite'), key = Buffer.alloc(32, 5);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A database from before #850: shared models serve only the projects in model_projects.
  let store = new Store(database, key);
  store.db.exec('ALTER TABLE models DROP COLUMN restricted');
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  for (const id of ['r1', 'r2']) store.run('INSERT INTO repositories VALUES(?,?,?,?)', id, 'fixture/' + id, '1', 'a');
  const model = (id, repository) => store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES(?,?,'https://model.invalid/v1','fixture',NULL,1,'now')", id, repository);
  model('everywhere', null); model('partly', null); model('nowhere', null); model('own', 'r1');
  for (const [id, repository] of [['everywhere', 'r1'], ['everywhere', 'r2'], ['partly', 'r1']]) store.run('INSERT INTO model_projects VALUES(?,?)', id, repository);
  store.close(); store = new Store(database, key); t.after(() => store.close());

  assert.deepEqual(store.all('SELECT id,restricted FROM models ORDER BY id').map(row => [row.id, row.restricted]),
    [['everywhere', 0], ['nowhere', 1], ['own', 0], ['partly', 1]]);
  const serves = id => ['r1', 'r2'].filter(project => modelServes(store, store.get('SELECT * FROM models WHERE id=?', id), project));
  assert.deepEqual(serves('everywhere'), ['r1', 'r2']); assert.deepEqual(serves('partly'), ['r1']); assert.deepEqual(serves('nowhere'), []); assert.deepEqual(serves('own'), ['r1']);
  // A project started later gets the model granted to all, not the restricted one.
  store.run("INSERT INTO repositories VALUES('r3','fixture/r3','1','a')");
  assert.ok(visibleModel(store, 'r3', 'everywhere')); assert.equal(visibleModel(store, 'r3', 'partly'), undefined);
  // The group model rule (#849) reads the same answer: a group over r1 and r2 may use only the model that serves both.
  assert.deepEqual(modelGaps(store, 'everywhere', ['r1', 'r2']), []);
  assert.deepEqual(modelGaps(store, 'partly', ['r1', 'r2']).map(gap => gap.id), ['r2']);
});
