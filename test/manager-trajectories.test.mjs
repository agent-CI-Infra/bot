import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { managerFixture } from './project-manager-fixture.mjs';
import { once } from 'node:events';
import { LedgerMigration, TrajectoryExpiry } from '../manager/trajectories.mjs';
import { createManagerServer } from '../manager/server.mjs';
import { ManagerClient } from '../dist/projects/service.js';

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
  const report = await f.projects.storage(), usage = kind => report.usage.find(row => row.repository_id === '101' && row.kind === kind);
  assert.equal(usage('files').count, 1, 'the reap closed the workspace file'); assert.equal(usage('records:tool_result').count, 2);
  assert.equal(usage('open').count, 1, 'the workspace file reopened after the reap is still open'); assert.ok(usage('open').bytes > 2000);
  assert.ok(report.database.bytes > 0 && Number.isSafeInteger(report.database.free_pages)); assert.ok(report.disk.total_bytes > 0);
  assert.ok('operations' in report.migration.remaining);
  assert.deepEqual(report.host.docker, { images_bytes: 1000, containers_bytes: 20, volumes_bytes: 30, build_cache_bytes: 40 });
});

// #671: the manager's copies of runner-call bodies are removed once nothing replays them.
const daysAgo = days => new Date(Date.now() - days * 24 * 3600_000).toISOString();
const entries = projects => projects.db.prepare('SELECT * FROM trajectory_files ORDER BY created_at').all();
const exists = (f, entry) => { try { statSync(join(f.root, 'trajectories', entry.path)); return true; } catch { return false; } };

test('files closed longer ago than the window go in the background; their calls replay as expired, running calls stay', async t => {
  const f = await managerFixture(t), generation = await ready(f), other = 'b'.repeat(48), recent = 'c'.repeat(48);
  f.projects.parallelism('101', 4);
  let ran = 0; f.docker.runner = async (_container, request) => { ran++; return { ok: true, result: { exit_code: 0, output: 'done ' + request.command } }; };
  const old = call(generation, { type: 'workspace_command', command: 'old' }), fresh = { ...call(generation, { type: 'workspace_command', command: 'fresh' }), request: { type: 'workspace_command', command: 'fresh', workspace_id: recent } };
  await f.projects.operate('101', 'execute', old);
  await f.projects.operate('101', 'execute', { operation_id: id(), generation, request: { type: 'reap', workspace_id: workspace } });
  await f.projects.operate('101', 'execute', fresh);
  // A long command: its input is in a file that closed on idle while it runs; its result goes to a new file.
  const started = Promise.withResolvers(), finish = Promise.withResolvers(), long = { operation_id: id(), generation, request: { type: 'workspace_command', command: 'long', workspace_id: other } };
  f.docker.runner = async (_container, request) => { if (request.command === 'long') { started.resolve(); await finish.promise; } return { ok: true, result: { exit_code: 0, output: 'done ' + request.command } }; };
  const running = f.projects.operate('101', 'execute', long); await started.promise;
  f.projects.trajectories.closeAll();
  // Everything but the fresh workspace's file closed three days ago.
  const freshFile = f.projects.db.prepare('SELECT input_ref FROM operations WHERE id=?').get(fresh.operation_id).input_ref.slice(0, 16);
  f.projects.db.prepare('UPDATE trajectory_files SET closed_at=? WHERE id<>?').run(daysAgo(3), freshFile);
  const before = Object.fromEntries(f.projects.db.prepare("SELECT kind,count,bytes FROM trajectory_usage WHERE repository_id='101'").all().map(row => [row.kind, row]));
  const removed = await new TrajectoryExpiry(f.projects.db, f.projects.trajectories, { batch: 1, pauseMs: 0 }).pass();
  const rows = entries(f.projects), byWorkspace = name => rows.filter(row => row.workspace_id === name);
  assert.equal(removed.files, 1, 'the old workspace file goes');
  for (const row of byWorkspace(workspace)) { assert.ok(row.expired_at && row.deleted_at, row.path); assert.equal(exists(f, row), false, row.path); }
  for (const row of [...byWorkspace(other), ...byWorkspace(recent)]) { assert.equal(row.expired_at, null, row.path); assert.equal(exists(f, row), true, row.path); }
  // Their calls are answered as expired, never run again or replayed with something else; the recent one still replays.
  ran = 0;
  await assert.rejects(f.projects.operate('101', 'execute', old), error => error.message === 'operation_result_expired' && error.status === 410);
  assert.equal((await f.projects.operate('101', 'execute', fresh)).result.output, 'done fresh'); assert.equal(ran, 0);
  // The ledger rows stay; the usage counters move the removed bytes to 'expired'.
  assert.ok(f.projects.db.prepare('SELECT input_ref,input_sha256 FROM operations WHERE id=?').get(old.operation_id).input_sha256);
  const after = Object.fromEntries(f.projects.db.prepare("SELECT kind,count,bytes FROM trajectory_usage WHERE repository_id='101'").all().map(row => [row.kind, row]));
  assert.equal(after.expired.count, 1); assert.equal(after.expired.bytes, removed.bytes);
  assert.equal(after.files.count, before.files.count - 1); assert.equal(after.files.bytes, before.files.bytes - removed.bytes);
  assert.ok(after['records:tool_result'].count < before['records:tool_result'].count);
  // Once the long command ends its input file goes too, and the call still replays from its result's file.
  finish.resolve(); assert.equal((await running).result.output, 'done long');
  f.projects.db.prepare('UPDATE trajectory_files SET closed_at=? WHERE workspace_id=? AND closed_at IS NOT NULL').run(daysAgo(3), other);
  assert.equal((await new TrajectoryExpiry(f.projects.db, f.projects.trajectories, { pauseMs: 0 }).pass()).files, 1);
  assert.equal((await f.projects.operate('101', 'execute', long)).result.output, 'done long'); assert.equal(ran, 0);
  const state = new TrajectoryExpiry(f.projects.db, f.projects.trajectories).state();
  assert.equal(state.window_days, 2); assert.equal(state.last_pass.files, 1); assert.equal((await f.projects.storage()).expiry.window_days, 2);
});

test('the window follows the saved setting, and a restart removes the files a stopped pass had marked', async t => {
  const f = await managerFixture(t), generation = await ready(f);
  f.docker.runner = async () => ({ ok: true, result: { exit_code: 0, output: 'x' } });
  await f.projects.operate('101', 'execute', call(generation, { type: 'workspace_command', command: 'a' }));
  f.projects.trajectories.closeAll();
  f.projects.db.prepare('UPDATE trajectory_files SET closed_at=?').run(daysAgo(3));
  f.projects.db.prepare("INSERT INTO settings VALUES('payload_retention',?)").run(JSON.stringify({ days: 5 }));
  assert.equal((await new TrajectoryExpiry(f.projects.db, f.projects.trajectories, { pauseMs: 0 }).pass()).files, 0, 'within a 5-day window');
  // A pass marked the entries and stopped before removing their files.
  const [entry] = entries(f.projects);
  f.projects.db.prepare('UPDATE trajectory_files SET expired_at=?').run(new Date().toISOString());
  f.restart();
  await new TrajectoryExpiry(f.projects.db, f.projects.trajectories, { pauseMs: 0 }).pass();
  assert.equal(exists(f, entry), false); assert.ok(entries(f.projects)[0].deleted_at);
});

test('the expiry reads files and running calls through their indexes', async t => {
  const f = await managerFixture(t), plan = sql => f.projects.db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => row.detail).join(' | ');
  const candidates = plan(`SELECT id,repository_id,path,bytes,counts,closed_at FROM trajectory_files
    WHERE expired_at IS NULL AND closed_at IS NOT NULL AND closed_at<? AND (closed_at,id)>(?,?) ORDER BY closed_at,id LIMIT ?`);
  assert.match(candidates, /SEARCH trajectory_files USING INDEX trajectory_files_expiry/, candidates); assert.doesNotMatch(candidates, /TEMP B-TREE/, candidates);
  const running = plan("SELECT input_ref FROM operations WHERE state='running' AND input_ref IS NOT NULL");
  assert.match(running, /operations USING INDEX operations_running/, running);
  const marked = plan('SELECT id,path FROM trajectory_files WHERE expired_at IS NOT NULL AND deleted_at IS NULL ORDER BY expired_at LIMIT 100');
  assert.match(marked, /trajectory_files USING INDEX trajectory_files_removal/, marked); assert.doesNotMatch(marked, /TEMP B-TREE/, marked);
});

test('the ledger migration waits while the disk is below its reserve or full, and moves the rows it left once there is space', async t => {
  const f = await managerFixture(t), generation = await ready(f), insert = f.projects.db.prepare('INSERT INTO operations(id,repository_id,action,generation,input,state,result) VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 6; i++) { const input = call(generation, { type: 'workspace_command', command: 'row ' + i }); insert.run(input.operation_id, '101', 'execute', generation, JSON.stringify(input), 'completed', JSON.stringify({ output: 'out ' + i })); }
  let low = true, full = 3;
  const guard = { check: () => ({ low }) }, append = f.projects.trajectories.append.bind(f.projects.trajectories);
  t.mock.method(f.projects.trajectories, 'append', (...args) => { if (!low && full > 0 && JSON.stringify(args[3]).includes('row 3')) { full--; throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); } return append(...args); });
  const migration = new LedgerMigration(f.projects.db, f.projects.trajectories, { readMs: 0, pauseMs: 1, idleMs: 60_000, lowDiskMs: 5, guard });
  const wait = async until => { for (let i = 0; i < 1000 && !until(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(until()); };
  migration.start(); t.after(() => migration.stop());
  await wait(() => migration.state().paused === 'low_disk');
  assert.equal(migration.state().phases.operations.migrated, 0);
  low = false;
  await wait(() => migration.state().phases.operations.finished_at);
  const done = migration.state().phases.operations;
  assert.equal(done.migrated, 6, 'the row that hit the full disk moved later'); assert.equal(done.failed, 0); assert.equal(migration.state().paused, null);
  assert.equal(f.projects.db.prepare('SELECT count(*) n FROM operations WHERE input_ref IS NULL').get().n, 0);
});

test('the manager answers a write that failed on a full disk with disk_full', async t => {
  const f = await managerFixture(t), generation = await ready(f), token = Buffer.from('disk-fixture');
  const { server, recovered } = createManagerServer({ projects: f.projects, token }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); await recovered;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  t.mock.method(console, 'error', () => {});
  t.mock.method(f.projects.trajectories, 'append', () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); });
  const client = new ManagerClient(`http://127.0.0.1:${server.address().port}`, token);
  await assert.rejects(client.call('POST', '/v1/projects/101/execute', call(generation, { type: 'workspace_command', command: 'a' })), error => error.code === 'disk_full' && error.status === 507);
});
