import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { managerFixture } from './project-manager-fixture.mjs';
import { LedgerMigration } from '../manager/trajectories.mjs';

const id = () => randomBytes(24).toString('hex'), workspace = 'a'.repeat(48);
const call = (generation, request, operation = id()) => ({ operation_id: operation, generation, request: { workspace_id: workspace, ...request } });
async function ready(f) { const project = await f.projects.register('101'); return project.generation; }
const migrated = projects => JSON.parse(projects.db.prepare("SELECT value FROM settings WHERE key='trajectory_migration'").get()?.value ?? 'null');

test('a runner call is recorded in the project file and replayed from it after a restart', async t => {
  const f = await managerFixture(t), generation = await ready(f);
  const output = 'O'.repeat(20000);
  f.docker.runner = async () => ({ ok: true, result: { exit_code: 0, output } });
  const input = call(generation, { type: 'workspace_command', command: 'npm test' });
  const result = await f.projects.operate('101', 'execute', input);
  const row = f.projects.db.prepare('SELECT * FROM operations WHERE id=?').get(input.operation_id);
  assert.ok(row.input_ref && row.result_ref && row.input_sha256); assert.equal(row.result, null);
  assert.deepEqual(JSON.parse(row.input), { operation_id: input.operation_id, generation, request: { type: 'workspace_command', workspace_id: workspace } });
  const entry = f.projects.db.prepare('SELECT * FROM trajectory_files WHERE id=?').get(row.input_ref.split(':')[0]);
  assert.equal(entry.path, `101/${workspace}.jsonl`); assert.equal(entry.repository_id, '101');
  assert.equal(statSync(join(f.root, 'trajectories', entry.path)).mode & 0o777, 0o600);
  // A restart without a clean shutdown: the repeated call returns the recorded result without running again.
  f.restart(); await f.projects.trajectories.seal();
  let ran = 0; f.docker.runner = async () => { ran++; return { ok: true, result: {} }; };
  assert.deepEqual(await f.projects.operate('101', 'execute', input), result); assert.equal(ran, 0);
  await assert.rejects(f.projects.operate('101', 'execute', { ...input, request: { ...input.request, command: 'other' } }), /operation_id_conflict/);
  // A recorded result that fails its hash is refused, not run again.
  const file = join(f.root, 'trajectories', entry.path);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"exit_code":0', '"exit_code":9'));
  await assert.rejects(f.projects.operate('101', 'execute', input), /operation_record_unreadable/); assert.equal(ran, 0);
});

test('ledger rows written before move to files in the background, resume after a restart and read the same', async t => {
  const f = await managerFixture(t), generation = await ready(f), rows = [];
  const insert = f.projects.db.prepare('INSERT INTO operations(id,repository_id,action,generation,input,state,result) VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 40; i++) {
    const input = call(generation, { type: 'workspace_command', command: 'step ' + i + ' ' + 'x'.repeat(3000) }), state = i % 10 === 9 ? 'interrupted' : 'completed';
    insert.run(input.operation_id, '101', 'execute', generation, JSON.stringify(input), state, state === 'completed' ? JSON.stringify({ exit_code: 0, output: 'out ' + i + ' '.repeat(5000) }) : null);
    rows.push({ input, state });
  }
  const running = call(generation, { type: 'workspace_command', command: 'still running' });
  insert.run(running.operation_id, '101', 'execute', generation, JSON.stringify(running), 'running', null);
  // Stop part way, restart, finish.
  let migration = new LedgerMigration(f.projects.db, f.projects.trajectories, { readMs: 0, pauseMs: 1, idleMs: 60_000 });
  migration.start();
  for (let i = 0; i < 500 && !(migrated(f.projects)?.phases?.operations?.cursor > 5); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await migration.stop();
  const cursor = migrated(f.projects).phases.operations.cursor; assert.ok(cursor > 0 && cursor < 41);
  f.restart(); await f.projects.trajectories.seal();
  migration = new LedgerMigration(f.projects.db, f.projects.trajectories, { pauseMs: 1, idleMs: 60_000 });
  migration.start();
  for (let i = 0; i < 1000 && !migrated(f.projects)?.phases?.operations?.finished_at; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await migration.stop();
  const state = migration.state();
  assert.equal(state.phases.operations.migrated, 40); assert.equal(state.remaining.operations, 0); assert.equal(state.phases.operations.failed, 0);
  assert.equal(f.projects.db.prepare("SELECT count(*) n FROM operations WHERE input_ref IS NULL").get().n, 1, 'the running call stays as it was');
  assert.equal(f.projects.db.prepare("SELECT count(*) n FROM operations WHERE input_ref IS NOT NULL AND (length(input)>300 OR result IS NOT NULL)").get().n, 0);
  // Completed calls replay from their files exactly; an interrupted one is still interrupted; each is referenced once.
  let ran = 0; f.docker.runner = async () => { ran++; return { ok: true, result: {} }; };
  for (const { input, state } of rows) {
    if (state === 'completed') assert.equal((await f.projects.operate('101', 'execute', input)).output.startsWith('out '), true);
    else await assert.rejects(f.projects.operate('101', 'execute', input), /operation_interrupted/);
  }
  assert.equal(ran, 0);
  const refs = f.projects.db.prepare('SELECT input_ref,result_ref FROM operations WHERE input_ref IS NOT NULL').all().flatMap(row => [row.input_ref, row.result_ref].filter(Boolean));
  assert.equal(new Set(refs).size, 76);
  assert.equal(f.projects.db.prepare('SELECT count(*) n FROM trajectory_files WHERE closed_at IS NULL').get().n, 0);
});

test('the ledger migration reads operations by rowid ranges', async t => {
  const f = await managerFixture(t);
  const plan = f.projects.db.prepare('EXPLAIN QUERY PLAN SELECT rowid AS migration_rowid,* FROM operations WHERE rowid>? ORDER BY rowid LIMIT 1').all().map(row => row.detail).join(' | ');
  assert.match(plan, /SEARCH operations USING INTEGER PRIMARY KEY \(rowid>\?\)/, plan);
});

test('stopping a ledger migration during a file sync commits the slice and closes its files', async t => {
  const f = await managerFixture(t), generation = await ready(f);
  const input = call(generation, { type: 'workspace_command', command: 'recorded command' });
  f.projects.db.prepare('INSERT INTO operations(id,repository_id,action,generation,input,state,result) VALUES(?,?,?,?,?,?,?)')
    .run(input.operation_id, '101', 'execute', generation, JSON.stringify(input), 'completed', JSON.stringify({ exit_code: 0, output: 'recorded result' }));
  const migration = new LedgerMigration(f.projects.db, f.projects.trajectories, { readMs: 0, pauseMs: 60_000 });
  const syncing = Promise.withResolvers(), release = Promise.withResolvers();
  const sync = f.projects.trajectories.sync.bind(f.projects.trajectories);
  t.mock.method(f.projects.trajectories, 'sync', async ref => {
    await sync(ref);
    syncing.resolve();
    await release.promise;
  });
  migration.start();
  await syncing.promise;
  let stopped = false;
  const stopping = migration.stop().then(() => { stopped = true; });
  release.resolve();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, true, 'stop must not wait for a pause registered after the stop request');
    await stopping;
    assert.equal(migration.state().phases.operations.migrated, 1);
    f.docker.runner = async () => { throw new Error('a migrated operation must replay without running'); };
    assert.deepEqual(await f.projects.operate('101', 'execute', input), { exit_code: 0, output: 'recorded result' });
    assert.equal(f.projects.db.prepare('SELECT count(*) n FROM trajectory_files WHERE closed_at IS NULL').get().n, 0);
  } finally {
    await migration.stop();
    await f.projects.trajectories.settle();
  }
});

test('the manager reports its storage for the storage page without reading the ledger', async t => {
  const f = await managerFixture(t), generation = await ready(f);
  f.docker.runner = async () => ({ ok: true, result: { output: 'x'.repeat(2000) } });
  const reap = { operation_id: id(), generation, request: { type: 'reap', workspace_id: workspace } };
  await f.projects.operate('101', 'execute', call(generation, { type: 'workspace_command', command: 'a' }));
  await f.projects.operate('101', 'execute', reap);
  await f.projects.operate('101', 'execute', call(generation, { type: 'workspace_read', path: 'b' }, id()));
  const report = f.projects.storage(), usage = kind => report.usage.find(row => row.repository_id === '101' && row.kind === kind);
  assert.equal(usage('files').count, 1, 'the reap closed the workspace file'); assert.equal(usage('records:tool_result').count, 2);
  assert.equal(usage('open').count, 1, 'the workspace file reopened after the reap is still open'); assert.ok(usage('open').bytes > 2000);
  assert.ok(report.database.bytes > 0 && Number.isSafeInteger(report.database.free_pages)); assert.ok(report.disk.total_bytes > 0);
  assert.ok('operations' in report.migration.remaining);
});
