import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { Workspace } from '../dist/agent/workspace.js';
import { operationId, Redactor } from '../dist/agent/common.js';
import { runScope, TrajectoryError } from '../dist/storage/trajectories.js';
import { blobValue, insertTaskLog, logContent, modelSnapshot, operationResult, storedInput } from '../dist/storage/payloads.js';
import { beginRun, endRun, taskTrace, traceSource, traceSnapshot } from '../dist/tasks/trace.js';

const key = Buffer.alloc(32, 7);
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trajectories-')), path = join(directory, 'control.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path };
}
function seed(store) {
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project','10','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','101','task.request','running','Fixture','{}')");
}
const changes = store => store.get('SELECT total_changes() n').n;
const fileOf = (store, ref) => store.get('SELECT * FROM trajectory_files WHERE id=?', ref.split(':')[0]);

test('a file is opened and closed with one write each; appending a record never writes SQLite', async t => {
  const { directory, path } = database(t), store = new Store(path, key); t.after(() => store.close());
  const scope = runScope('101', 't', 'run-1');
  const before = changes(store), first = store.trajectories.append(scope, 'log', 'l1', { text: 'one' });
  assert.equal(changes(store) - before, 1, 'opening inserts the entry');
  const opened = changes(store);
  for (let i = 0; i < 20; i++) store.trajectories.append(scope, i % 2 ? 'tool_call' : 'tool_result', 'op' + i, { i, body: 'x'.repeat(100) });
  assert.equal(changes(store), opened, 'appending writes only the file');
  store.trajectories.close(scope.key);
  // One UPDATE of the entry plus the usage totals it adds to, in the same commit.
  const entry = fileOf(store, first);
  assert.equal(entry.records, 21); assert.equal(entry.repository_id, '101'); assert.equal(entry.run_id, 'run-1');
  assert.equal(entry.bytes, statSync(join(directory, 'trajectories', entry.path)).size);
  assert.deepEqual(Object.keys(JSON.parse(entry.counts)).sort(), ['log', 'tool_call', 'tool_result']);
  assert.equal(store.get("SELECT count FROM trajectory_usage WHERE repository_id='101' AND kind='files'").count, 1);
  assert.equal(store.get("SELECT count FROM trajectory_usage WHERE repository_id='101' AND kind='records:tool_call'").count, 10);
  assert.equal(entry.path, '101/t/run-1.jsonl');
  assert.equal(statSync(join(directory, 'trajectories', entry.path)).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'trajectories', '101')).mode & 0o777, 0o700);
  // The lines form a hash chain anchored by the close.
  const lines = await store.trajectories.lines(entry.id);
  assert.deepEqual(lines.map(line => line.seq), Array.from({ length: 21 }, (_, i) => i + 1));
  assert.equal(lines[0].prev, null); assert.equal(store.trajectories.read(first).data.text, 'one');
  // A record after the close opens a continuation file instead of appending to the closed one.
  const later = store.trajectories.append(scope, 'log', 'late', {});
  assert.notEqual(later.split(':')[0], first.split(':')[0]); assert.equal(fileOf(store, later).path, '101/t/run-1.2.jsonl');
});

test('a modified or truncated file is reported when it is read', async t => {
  const { directory, path } = database(t), store = new Store(path, key); t.after(() => store.close());
  const scope = runScope('101', 't', 'run-2'), refs = ['a', 'b', 'c'].map(id => store.trajectories.append(scope, 'tool_result', id, { output: 'value ' + id }));
  store.trajectories.close(scope.key); await store.trajectories.settle();
  const entry = fileOf(store, refs[0]), file = join(directory, 'trajectories', entry.path), original = readFileSync(file);
  writeFileSync(file, original.toString().replace('value b', 'value B'));
  assert.equal(store.trajectories.read(refs[0]).data.output, 'value a');
  assert.throws(() => store.trajectories.read(refs[1]), error => error instanceof TrajectoryError && error.code === 'trajectory_corrupt');
  await assert.rejects(store.trajectories.lines(entry.id), error => error.code === 'trajectory_corrupt');
  writeFileSync(file, original); truncateSync(file, original.length - 10);
  assert.throws(() => store.trajectories.read(refs[2]), error => error.code === 'trajectory_truncated');
  await assert.rejects(store.trajectories.lines(entry.id), error => error.code === 'trajectory_truncated');
  // Cutting off whole lines keeps every remaining line valid; the anchor recorded at close still catches it.
  writeFileSync(file, original.subarray(0, original.indexOf('\n') + 1));
  assert.equal(store.trajectories.read(refs[0]).data.output, 'value a');
  await assert.rejects(store.trajectories.lines(entry.id), error => error.code === 'trajectory_truncated');
  // Readers turn it into an unavailable record instead of a wrong one.
  assert.throws(() => store.trajectories.read(refs[1]), error => error.code === 'trajectory_truncated');
});

// close() would close the open files as a clean shutdown does; db.close() stops like a crashed process.
const crash = store => store.db.close();
function workspaceFixture(t, path, responses) {
  const store = new Store(path, key); t.after(() => { try { store.close(); } catch {} });
  if (!store.get("SELECT 1 FROM repositories WHERE id='101'")) seed(store);
  const calls = [], manager = { async call(...args) { calls.push(args); return responses.shift() ?? { ok: true, result: { output: 'default' } }; } };
  const task = { id: 't', repository_id: '101', attempt: 1, generation: 1, workspace_id: 'w' };
  return { store, calls, task, manager };
}

test('a call repeated after a restart returns the recorded result from its file without running again', async t => {
  const { path } = database(t);
  let f = workspaceFixture(t, path, [{ ok: true, result: { exit_code: 0, output: 'O'.repeat(5000), tree_sha: 'a'.repeat(40) } }]);
  const run = beginRun(f.store, f.task, 'attempt', {}); f.task.trace_run_id = run.id;
  const workspace = new Workspace(f.store, f.manager, f.task, new Redactor(), async () => {}, () => {});
  const first = await workspace.call('tests', { type: 'workspace_command', command: 'npm test' });
  const id = operationId('t:1:tests'), row = f.store.get('SELECT * FROM task_tools WHERE id=?', id);
  // The row keeps small fields and refs; the bodies are in the run's file.
  assert.ok(row.request_ref && row.result_ref && row.request_sha256);
  assert.equal(JSON.parse(row.result).tree_sha, 'a'.repeat(40)); assert.equal(JSON.parse(row.result).output, undefined);
  assert.equal(JSON.parse(row.request).request.command, 'npm test');
  assert.ok(row.result.length < 200 && row.request.length < 300);
  assert.equal(f.store.get("SELECT json_extract(request,'$.request.type') type FROM task_tools WHERE id=?", id).type, 'workspace_command');
  crash(f.store);
  // A new process: the run was never ended (crash); its file is open in the database until the sealer closes it.
  f = workspaceFixture(t, path, []);
  assert.equal(f.store.get('SELECT closed_at FROM trajectory_files').closed_at, null);
  assert.equal(await f.store.trajectories.seal(), 1);
  assert.equal(f.store.get('SELECT records FROM trajectory_files').records, 2);
  const again = await new Workspace(f.store, f.manager, f.task, new Redactor(), async () => {}, () => {}).call('tests', { type: 'workspace_command', command: 'npm test' });
  assert.deepEqual(again, first); assert.equal(f.calls.length, 0);
  // The same key with another request is still a conflict, named by field.
  await assert.rejects(new Workspace(f.store, f.manager, f.task, new Redactor(), async () => {}, () => {}).call('tests', { type: 'workspace_command', command: 'npm run other' }),
    error => error.code === 'tool_operation_conflict' && /command/.test(error.detail));
});

test('a crash between appending a result and committing its ref leaves no dangling reference', async t => {
  const { path } = database(t);
  let f = workspaceFixture(t, path, [{ ok: true, result: { output: 'first run' } }]);
  const run = beginRun(f.store, f.task, 'attempt', {}); f.task.trace_run_id = run.id;
  // The guard after the runner call fails as a process dying there would: the result line is written, the row is not.
  let guards = 0;
  const workspace = new Workspace(f.store, f.manager, f.task, new Redactor(), async () => { if (++guards === 2) throw new Error('process stopped'); }, () => {});
  await assert.rejects(workspace.call('step', { type: 'workspace_read', path: 'a.txt' }), /process stopped/);
  const id = operationId('t:1:step'), pending = f.store.get('SELECT * FROM task_tools WHERE id=?', id);
  assert.equal(pending.state, 'pending'); assert.equal(pending.result_ref, null);
  crash(f.store);
  f = workspaceFixture(t, path, [{ ok: true, result: { output: 'second run' } }]);
  await f.store.trajectories.seal();
  // Every ref in the database resolves; the orphan result line is ignored and the call runs again.
  for (const row of f.store.all('SELECT request_ref,result_ref FROM task_tools')) for (const ref of [row.request_ref, row.result_ref].filter(Boolean)) f.store.trajectories.read(ref);
  const file = f.store.get('SELECT * FROM trajectory_files');
  assert.equal(file.records, 2, 'the request and the unreferenced result line');
  f.task.trace_run_id = beginRun(f.store, f.task, 'attempt', {}).id;
  const result = await new Workspace(f.store, f.manager, f.task, new Redactor(), async () => {}, () => {}).call('step', { type: 'workspace_read', path: 'a.txt' });
  assert.equal(result.output, 'second run'); assert.equal(f.calls.length, 1);
  assert.equal(operationResult(f.store, 'task_tools', f.store.get('SELECT * FROM task_tools WHERE id=?', id)).output, 'second run');
});

test('a recorded result whose file was altered stops the call instead of running it again', async t => {
  const { directory, path } = database(t), f = workspaceFixture(t, path, [{ ok: true, result: { output: 'kept' } }]);
  f.task.trace_run_id = beginRun(f.store, f.task, 'attempt', {}).id;
  const workspace = new Workspace(f.store, f.manager, f.task, new Redactor(), async () => {}, () => {});
  await workspace.call('once', { type: 'workspace_read', path: 'a.txt' });
  const row = f.store.get('SELECT * FROM task_tools'), file = join(directory, 'trajectories', fileOf(f.store, row.result_ref).path);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"kept"', '"KEPT"'));
  await assert.rejects(workspace.call('once', { type: 'workspace_read', path: 'a.txt' }), error => error.code === 'trajectory_unreadable');
  assert.equal(f.calls.length, 1);
});

// The same operation and log recorded the old way (payload in the row, copied into task_history by the triggers) and
// the new way (payload in the run's file, refs in the row) read the same through every source.
function recordBoth(t) {
  const stores = ['legacy', 'files'].map(mode => {
    const { path } = database(t), store = new Store(path, key); t.after(() => store.close()); seed(store);
    const run = beginRun(store, { id: 't' }, 'execution', {}), scope = runScope('101', 't', run.id);
    const request = { operation_id: 'op', generation: 1, request: { type: 'workspace_command', command: 'npm test', token: 'ghp_SECRET123456789012345678901234567890', workspace_id: 'w' } };
    const result = { exit_code: 0, output: 'observed '.repeat(1500) };
    if (mode === 'legacy') {
      store.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES('op','t',?,NULL,'pending')", JSON.stringify(request));
      store.run("UPDATE task_tools SET state='completed',result=? WHERE id='op'", JSON.stringify(result));
    } else {
      store.run("INSERT INTO task_tools(id,task_id,request,result,state,request_ref,request_sha256) VALUES('op','t','{}',NULL,'pending',?,'h')", store.trajectories.append(scope, 'tool_call', 'op', request));
      store.run("UPDATE task_tools SET state='completed',result='{}',result_ref=? WHERE id='op'", store.trajectories.append(scope, 'tool_result', 'op', result));
    }
    const log = JSON.stringify({ type: 'tool', name: 'run_command', attempt: 1, detail: 'd'.repeat(3000), result: { exit_code: 0 }, output: 'o'.repeat(4000) });
    if (mode === 'legacy') store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES('log','t',?,'now')", log);
    else insertTaskLog(store, { id: 't', repository_id: '101', trace_run_id: run.id }, log, 'now', 'log');
    return { store, run, log };
  });
  return { legacy: stores[0], files: stores[1] };
}

test('evidence references read the same content from a file as from the old columns', t => {
  const { legacy, files } = recordBoth(t);
  for (const source of ['task_tools:op', 'task_logs:log']) assert.deepEqual(traceSource(files.store, 't', source), traceSource(legacy.store, 't', source));
  assert.doesNotMatch(JSON.stringify(traceSource(files.store, 't', 'task_tools:op')), /SECRET/);
  // The history rows the triggers wrote are small; read through task_history they expand to the old snapshots.
  const history = store => store.all("SELECT id,length(data) n FROM task_history WHERE type IN ('operation','runtime_log') ORDER BY id");
  const old = history(legacy.store), current = history(files.store);
  assert.deepEqual(current.map(row => row.id), old.map(row => row.id));
  assert.ok(current.every(row => row.n < 4000)); assert.ok(old.some(row => row.n > 8192));
  for (const row of old) assert.deepEqual(traceSource(files.store, 't', 'task_history:' + row.id), traceSource(legacy.store, 't', 'task_history:' + row.id));
  // The console's event list shows the same: small snapshots inline, large ones by size.
  const events = store => ['operation', 'runtime_log'].flatMap(type => taskTrace(store, 't', new URL('http://local/api/tasks/t/events?include_data=1&type=' + type), 'events').events)
    .map(({ data, body_chars }) => ({ data, body_chars }));
  assert.deepEqual(events(files.store), events(legacy.store));
  // The large log's row keeps its header for queries and a ref for the whole text; a small log stays inline.
  const row = files.store.get("SELECT * FROM task_logs WHERE id='log'");
  assert.ok(row.content_ref); assert.equal(JSON.parse(row.content).name, 'run_command'); assert.equal(JSON.parse(row.content).detail.length, 3000);
  assert.equal(logContent(files.store, row), files.log);
  insertTaskLog(files.store, { id: 't', repository_id: '101', trace_run_id: files.run.id }, JSON.stringify({ type: 'phase', phase: 'prepare' }), 'now', 'small');
  assert.equal(files.store.get("SELECT content_ref FROM task_logs WHERE id='small'").content_ref, null);
  endRun(files.store, files.run, 'succeeded');
  assert.ok(files.store.get('SELECT closed_at FROM trajectory_files WHERE run_id=?', files.run.id).closed_at, 'ending the run closes its file');
});

test('model requests are written as the messages added since the previous request and read back whole', t => {
  const { path } = database(t), store = new Store(path, key); t.after(() => store.close());
  const scope = runScope('101', 't', 'run-m'), system = { role: 'system', content: 'S'.repeat(3000) };
  const bodies = [[system, { role: 'user', content: 'one' }], [system, { role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }]];
  bodies.push([system, { role: 'user', content: 'compacted' }]);
  bodies.push([...bodies[2], { role: 'assistant', content: 'four' }]);
  const refs = bodies.map((messages, i) => store.trajectories.appendModelRequest(scope, 'm' + i, { model: 'fixture', messages, stream: true }));
  const lines = refs.map(ref => store.trajectories.read(ref).data);
  assert.equal(lines[0].previous, undefined); assert.equal(lines[1].from, 2); assert.equal(lines[1].body.messages.length, 2);
  assert.equal(lines[2].previous, undefined, 'a changed prefix writes the whole request');
  assert.equal(lines[3].body.messages.length, 1);
  assert.ok(Number(refs[1].split(':')[2]) < 600, 'the delta does not repeat the system prompt');
  refs.forEach((ref, i) => assert.deepEqual(store.trajectories.readModelRequest(ref), { model: 'fixture', messages: bodies[i], stream: true }));
  const row = { request_ref: refs[1], response_ref: store.trajectories.append(scope, 'model_response', 'm1', { choices: [{ message: { content: 'ok' } }] }) };
  assert.equal(modelSnapshot(store, row, 'request'), traceSnapshot({ model: 'fixture', messages: bodies[1], stream: true }));
  assert.equal(modelSnapshot(store, row, 'response'), traceSnapshot({ choices: [{ message: { content: 'ok' } }] }));
});

test('the sealer closes files a stopped process left open and drops an incomplete last line', async t => {
  const { directory, path } = database(t);
  let store = new Store(path, key);
  const scope = runScope('101', 't', 'run-s'), ref = store.trajectories.append(scope, 'event', 'e1', { ok: true });
  store.trajectories.append(scope, 'event', 'e2', { ok: true });
  const file = join(directory, 'trajectories', fileOf(store, ref).path);
  appendFileSync(file, '{"seq":3,"at":"');
  crash(store);
  store = new Store(path, key); t.after(() => store.close());
  assert.equal(await store.trajectories.seal(), 1);
  const entry = fileOf(store, ref);
  assert.equal(entry.records, 2); assert.equal(entry.bytes, statSync(file).size); assert.ok(entry.closed_at);
  assert.equal((await store.trajectories.lines(entry.id)).length, 2);
  assert.equal(await store.trajectories.seal(), 0);
});

test('removing a project deletes its trajectory files, entries and totals', t => {
  const { directory, path } = database(t), store = new Store(path, key); t.after(() => store.close());
  const scope = runScope('101', 't', 'run-r'); store.trajectories.append(scope, 'log', 'l', {}); store.trajectories.close(scope.key);
  store.trajectories.append(runScope('102', 'u', 'run-o'), 'log', 'l', {});
  store.trajectories.remove({ repository_id: '101' });
  assert.equal(store.get("SELECT count(*) n FROM trajectory_files WHERE repository_id='101'").n, 0);
  assert.equal(store.get("SELECT count(*) n FROM trajectory_usage WHERE repository_id='101'").n, 0, 'no totals of the removed project are left');
  assert.throws(() => statSync(join(directory, 'trajectories', '101')));
  assert.equal(store.get("SELECT count(*) n FROM trajectory_files WHERE repository_id='102'").n, 1);
});

test('trajectory lookups use their indexes', t => {
  const store = new Store(':memory:', key); t.after(() => store.close());
  const plan = sql => store.all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
  assert.match(plan('SELECT * FROM trajectory_files WHERE closed_at IS NULL ORDER BY created_at'), /trajectory_files_open/);
  assert.match(plan("SELECT * FROM trajectory_files WHERE repository_id='1'"), /trajectory_files_repository/);
  assert.match(plan("SELECT * FROM trajectory_files WHERE conversation_id='c'"), /trajectory_files_conversation/);
  assert.match(plan("SELECT path FROM trajectory_files WHERE id='x'"), /USING INDEX sqlite_autoindex_trajectory_files_1/);
});

test('large task file lists are stored once as blobs and read back through their references', t => {
  const { directory, path } = database(t), store = new Store(path, key); t.after(() => store.close());
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `src/file-${i}.ts`, sha: String(i).padStart(40, '0'), mode: '100644' }));
  const input = { request: 'keep', files: [{ filename: 'small.ts', patch: '+x' }], snapshot_files: files, skipped_files: [] };
  const text = storedInput(store, input, '101'), stored = JSON.parse(text);
  assert.deepEqual(stored.files, input.files, 'small values stay inline'); assert.equal(stored.request, 'keep');
  assert.match(stored.snapshot_files.$blob, /^[a-f0-9]{64}$/); assert.ok(text.length < 400);
  assert.deepEqual(blobValue(store, stored.snapshot_files), files); assert.deepEqual(blobValue(store, input.files), input.files);
  const file = join(directory, 'blobs', 'sha256', stored.snapshot_files.$blob.slice(0, 2), stored.snapshot_files.$blob);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The same value again, from this or another project, is not written twice; each project counts it.
  storedInput(store, input, '101'); storedInput(store, input, '102');
  assert.equal(store.get("SELECT count FROM trajectory_usage WHERE repository_id='101' AND kind='blobs'").count, 1);
  assert.equal(store.get("SELECT count FROM trajectory_usage WHERE repository_id='102' AND kind='blobs'").count, 1);
  // Removing one project keeps the file the other still holds; removing the last removes it.
  store.trajectories.remove({ repository_id: '101' }); assert.deepEqual(blobValue(store, stored.snapshot_files), files);
  store.trajectories.remove({ repository_id: '102' }); assert.throws(() => blobValue(store, stored.snapshot_files), error => error.code === 'trajectory_truncated');
  // A changed blob is reported.
  const again = JSON.parse(storedInput(store, input, '103')).snapshot_files.$blob;
  writeFileSync(file, readFileSync(file, 'utf8').replace('file-1', 'file-X'));
  assert.equal(again, stored.snapshot_files.$blob); assert.throws(() => blobValue(store, stored.snapshot_files), error => error.code === 'trajectory_corrupt');
});
