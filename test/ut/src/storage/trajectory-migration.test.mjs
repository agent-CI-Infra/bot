import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Store } from '../../../../dist/storage/database.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { operationId, Redactor } from '../../../../dist/agent/common.js';
import { PayloadMigration, migrationKey } from '../../../../dist/storage/migration.js';
import { TrajectoryError } from '../../../../dist/storage/trajectories.js';
import { deliveryBody } from '../../../../dist/storage/webhook-bodies.js';
import { deliveryResult } from '../../../../dist/review/delivery.js';
import { blobValue, logContent, modelSnapshot, operationRequestText, operationResult } from '../../../../dist/storage/payloads.js';
import { taskTrace, traceSnapshot, traceSource } from '../../../../dist/tasks/trace.js';

const key = Buffer.alloc(32, 9);
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trajectory-migration-')), path = join(directory, 'control.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path;
}
const open = (t, path) => { const store = new Store(path, key); t.after(() => { try { store.close(); } catch {} }); return store; };

// Rows as a deployment before #436 wrote them: whole payloads in the rows, copied into task_history by the triggers,
// conversation payloads sealed.
function legacy(store, { tasks = 3, operations = 4, size = 3000, runs = true } = {}) {
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project','10','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101','http://model','fixture',NULL,'now')");
  const ids = [];
  for (let t = 0; t < tasks; t++) {
    const task = 'task-' + t;
    const input = { request: 'r ' + t, snapshot_files: Array.from({ length: 100 }, (_, i) => ({ path: `f${t}-${i}.ts`, sha: String(i).padStart(40, '0'), mode: '100644' })), files: [] };
    store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,'101','task.request','running','Fixture',?,1,1,'w')", task, JSON.stringify(input));
    for (let o = 0; o < operations; o++) {
      const id = `${task}-op-${o}`, request = { operation_id: id, generation: 1, request: { type: 'workspace_command', command: 'npm test ' + o, workspace_id: 'w' } };
      store.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES(?,?,?,NULL,'pending')", id, task, JSON.stringify(request));
      if (o < operations - 1) store.run("UPDATE task_tools SET state='completed',result=? WHERE id=?", JSON.stringify({ exit_code: o, output: `out ${id} `.repeat(size / 10), tree_sha: 'b'.repeat(40) }), id);
      ids.push(id);
    }
    store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,'now')", task + '-log', task, JSON.stringify({ type: 'tool', name: 'run_command', detail: 'why', output: 'L'.repeat(size) }));
    // Pre-#1266 historical runtime_log row in task_history: must still migrate cleanly and read identically.
    store.run("INSERT INTO task_history(task_id,type,data,created_at,source_ref) VALUES(?,'runtime_log',trace_snapshot(?),'now',?)", task, JSON.stringify({ type: 'tool', name: 'run_command', detail: 'why', output: 'L'.repeat(size) }), 'task_logs:' + task + '-log');
    store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,'now')", task + '-small', task, JSON.stringify({ type: 'phase', phase: 'prepare' }));
    // Runs as written before #1403: whole snapshots in the row. Two runs start on the same context; a small configuration
    // stays; a snapshot that is not the canonical JSON text of its value stays as well.
    const context = traceSnapshot({ input, recovery: null }), run = (id, contextSnapshot, configSnapshot) => runs && store.run(
      "INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot) VALUES(?,?,'execution',1,1,'now','succeeded',?,?)", id, task, contextSnapshot, configSnapshot);
    run(task + '-run-0', context, traceSnapshot({ prompt: 'first '.repeat(size / 6) }));
    run(task + '-run-1', context, traceSnapshot({ prompt: 'small' }));
    run(task + '-run-2', JSON.stringify(JSON.parse(context), null, 1), traceSnapshot({ prompt: 'third '.repeat(size / 6) }));
    store.run(`INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,finished_at,state,request_snapshot,response_snapshot)
      VALUES(?,?,'101','r','m','fixture','now','now','received',?,?)`, task + '-mr', task,
      JSON.stringify({ schema_version: 1, sha256: 'x', original_bytes: 10, complete: true, data: { messages: [{ role: 'user', content: 'Q'.repeat(size) }] } }),
      JSON.stringify({ schema_version: 1, sha256: 'y', original_bytes: 10, complete: true, data: { choices: [{ message: { content: 'answer ' + task } }] } }));
  }
  // A call Workspace.call recorded for task-0 under the key 'replay'.
  const replay = operationId('task-0:1:replay');
  store.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES(?,'task-0',?,?,'completed')", replay,
    JSON.stringify({ operation_id: replay, generation: 1, request: { type: 'workspace_read', path: 'a.txt', workspace_id: 'w' } }), JSON.stringify({ content: 'recorded '.repeat(500) }));
  // A conversation turn's sealed operation and model snapshots.
  store.run("INSERT INTO role_conversations(id,project_id,created_at) VALUES('conv','101',0)");
  store.run("INSERT INTO role_conversation_turns(id,conversation_id,source_message,project_id,role_id,fence,snapshot_id,state,created_at,updated_at) VALUES('turn','conv','s','101','reviewer','f','snap','completed',0,0)");
  store.run("INSERT INTO role_conversation_operations(id,turn_id,request,result,state) VALUES('conv-op','turn',?,?,'completed')",
    store.secrets.seal({ operation_id: 'conv-op', request: { type: 'workspace_read', path: 'secret-note.txt' } }, 'conversation-operation:conv-op:request'),
    store.secrets.seal({ content: 'private conversation file' }, 'conversation-operation:conv-op:result'));
  store.run(`INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,finished_at,state,conversation_id,request_snapshot,response_snapshot)
    VALUES('conv-mr',NULL,'101','r','m','fixture','now','now','received','conv',?,?)`,
    store.secrets.seal({ snapshot: JSON.stringify({ schema_version: 1, complete: true, data: { messages: [{ content: 'conversation question' }] } }) }, 'conversation-model-request:conv-mr'),
    store.secrets.seal({ snapshot: JSON.stringify({ schema_version: 1, complete: true, data: { content: 'conversation answer' } }) }, 'conversation-model-response:conv-mr'));
  return ids;
}

// Everything a reader can see of those rows.
function view(store) {
  const tasks = store.all('SELECT id FROM tasks ORDER BY id').map(row => row.id), out = {};
  for (const task of tasks) {
    const url = type => new URL(`http://local/api/tasks/${task}/events?include_data=1&limit=100&type=${type}`);
    out[task] = {
      sources: Object.fromEntries([...store.all('SELECT id FROM task_tools WHERE task_id=?', task).map(r => 'task_tools:' + r.id), ...store.all('SELECT id FROM task_logs WHERE task_id=?', task).map(r => 'task_logs:' + r.id),
        `model_requests:${task}-mr:request`, `model_requests:${task}-mr:response`].map(source => [source, traceSource(store, task, source)])),
      history: store.all("SELECT id FROM task_history WHERE task_id=? AND type IN ('operation','runtime_log') ORDER BY id", task).map(r => traceSource(store, task, 'task_history:' + r.id)),
      runs: store.all('SELECT id FROM task_runs WHERE task_id=? ORDER BY id', task).flatMap(r => ['context', 'config'].map(part => traceSource(store, task, `task_runs:${r.id}:${part}`))),
      events: ['operation', 'runtime_log'].flatMap(type => taskTrace(store, task, url(type), 'events').events.map(({ data, body_chars, source_ref }) => ({ data, body_chars, source_ref }))),
      results: store.all('SELECT * FROM task_tools WHERE task_id=? ORDER BY id', task).map(row => [operationRequestText(store, 'task_tools', row), operationResult(store, 'task_tools', row)]),
      logs: store.all('SELECT * FROM task_logs WHERE task_id=? ORDER BY id', task).map(row => logContent(store, row)),
      input: Object.fromEntries(Object.entries(JSON.parse(store.get('SELECT input FROM tasks WHERE id=?', task).input)).map(([key, value]) => [key, blobValue(store, value)])),
    };
  }
  const conversation = store.get("SELECT * FROM role_conversation_operations WHERE id='conv-op'"), model = store.get("SELECT * FROM model_requests WHERE id='conv-mr'");
  out.conversation = [operationRequestText(store, 'role_conversation_operations', conversation), operationResult(store, 'role_conversation_operations', conversation),
    modelSnapshot(store, model, 'request'), modelSnapshot(store, model, 'response')];
  return out;
}
const finished = store => { const row = store.get('SELECT value FROM settings WHERE key=?', migrationKey); return row ? JSON.parse(row.value) : null; };
async function migrate(store, options = {}) {
  const migration = new PayloadMigration(store, { idleMs: 60_000, pauseMs: 1, ...options });
  migration.start();
  for (let i = 0; i < 2000; i++) {
    const state = store.get('SELECT value FROM settings WHERE key=?', migrationKey);
    if (state && ['task_tools', 'role_conversation_operations', 'model_requests', 'task_logs', 'task_history'].every(name => JSON.parse(state.value).phases[name]?.finished_at) && JSON.parse(state.value).phases.tasks?.finished_at) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await migration.stop();
  return migration;
}

test('migrated rows read the same as before; their payloads leave the rows', async t => {
  const store = open(t, database(t)); legacy(store);
  const before = view(store);
  const migration = await migrate(store);
  assert.deepEqual(view(store), before);
  // The payload columns hold headers and refs only.
  for (const row of store.all("SELECT * FROM task_tools WHERE state='completed' AND id LIKE '%-op-%'")) {
    assert.ok(row.request_ref && row.result_ref && row.request_sha256); assert.ok(row.result.length < 200); assert.equal(JSON.parse(row.result).tree_sha, 'b'.repeat(40));
  }
  assert.equal(store.get("SELECT count(*) n FROM task_tools WHERE state='pending' AND request_ref IS NULL").n, 3, 'pending calls stay until they finish');
  assert.equal(store.get('SELECT count(*) n FROM model_requests WHERE request_snapshot IS NOT NULL OR response_snapshot IS NOT NULL').n, 0);
  assert.equal(store.get("SELECT count(*) n FROM task_logs WHERE content_ref IS NULL AND length(content)>2048").n, 0);
  assert.equal(store.get("SELECT count(*) n FROM task_history WHERE type IN ('operation','runtime_log') AND length(data)>2048").n, 0);
  assert.ok(store.all('SELECT input FROM tasks').every(row => JSON.parse(row.input).snapshot_files.$blob && row.input.length < 300));
  // Run snapshots: the large ones hold a header and a ref; runs of a task on the same context share one record.
  const runs = Object.fromEntries(store.all('SELECT id,context_snapshot,config_snapshot FROM task_runs').map(row => [row.id, row]));
  assert.equal(JSON.parse(runs['task-0-run-0'].context_snapshot).$trajectory, JSON.parse(runs['task-0-run-1'].context_snapshot).$trajectory);
  assert.ok(JSON.parse(runs['task-0-run-0'].config_snapshot).$trajectory && JSON.parse(runs['task-0-run-2'].config_snapshot).$trajectory);
  assert.ok(runs['task-0-run-1'].config_snapshot.startsWith('{"schema_version":1') && runs['task-0-run-2'].context_snapshot.startsWith('{\n'));
  assert.equal(store.get("SELECT count(*) n FROM task_runs WHERE length(context_snapshot)>400 OR length(config_snapshot)>400").n, 3, 'only the non-canonical contexts stay');
  const conversation = store.get("SELECT * FROM role_conversation_operations WHERE id='conv-op'");
  assert.equal(conversation.request, '{}'); assert.equal(conversation.result, null);
  assert.equal(store.get("SELECT conversation_id FROM trajectory_files WHERE id=?", conversation.request_ref.split(':')[0]).conversation_id, 'conv');
  // Migrated files are closed with their counts; progress is in settings.
  assert.equal(store.get('SELECT count(*) n FROM trajectory_files WHERE closed_at IS NULL').n, 0);
  const state = finished(store);
  assert.equal(state.phases.task_tools.migrated, 10); assert.equal(state.phases.task_tools.failed, 0);
  assert.equal(migration.state().remaining.task_tools, 0);
  assert.equal(state.phases.task_runs.migrated, 9); assert.equal(state.phases.task_runs.failed, 0); assert.equal(migration.state().remaining.task_runs, 0);
  // A call repeated after the migration returns its recorded result from the file without running again.
  const calls = [], manager = { async call() { calls.push(1); return { ok: true, result: {} }; } };
  const workspace = new Workspace(store, manager, { id: 'task-0', repository_id: '101', attempt: 1, generation: 1, workspace_id: 'w' }, new Redactor(), async () => {}, () => {});
  assert.equal((await workspace.call('replay', { type: 'workspace_read', path: 'a.txt' })).content, 'recorded '.repeat(500));
  assert.equal(calls.length, 0);
  await assert.rejects(workspace.call('replay', { type: 'workspace_read', path: 'b.txt' }), error => error.code === 'tool_operation_conflict' && /path/.test(error.detail));
});

test('the migration resumes from its cursor after a restart and never moves a row twice', async t => {
  const path = database(t);
  let store = open(t, path); legacy(store, { tasks: 6, operations: 6 });
  const before = view(store);
  // Stop after the first slice of task_tools.
  const first = new PayloadMigration(store, { readMs: 0, pauseMs: 1, idleMs: 60_000 });
  first.start();
  for (let i = 0; i < 500 && !(finished(store)?.phases?.task_tools?.cursor > 0); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await first.stop();
  const cursor = finished(store).phases.task_tools.cursor;
  assert.ok(cursor > 0 && cursor < store.get('SELECT max(rowid) n FROM task_tools').n, 'stopped part way');
  store.close();
  store = open(t, path);
  await migrate(store);
  assert.deepEqual(view(store), before);
  const state = finished(store);
  assert.equal(state.phases.task_tools.migrated, 31);
  // Each completed call has one request and one result record referenced.
  const refs = store.all('SELECT request_ref,result_ref FROM task_tools WHERE result_ref IS NOT NULL');
  assert.equal(new Set(refs.flatMap(row => [row.request_ref, row.result_ref])).size, 62);
});

test('stopping during a file sync commits the current slice without waiting for another pause', async t => {
  // Without runs, the first slice synced is one of task_tools.
  const store = open(t, database(t)); legacy(store, { tasks: 1, operations: 2, runs: false });
  const migration = new PayloadMigration(store, { readMs: 0, pauseMs: 60_000 });
  const syncing = Promise.withResolvers(), release = Promise.withResolvers();
  const sync = store.trajectories.sync.bind(store.trajectories);
  t.mock.method(store.trajectories, 'sync', async ref => {
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
    // The sync can now finish; drain its continuations without a timer keeping the migration alive.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, true, 'stop must not wait for a pause registered after the stop request');
    await stopping;
    assert.equal(finished(store).phases.task_tools.migrated, 1);
    const row = store.get("SELECT * FROM task_tools WHERE id='task-0-op-0'");
    assert.ok(row.request_ref && row.result_ref);
    assert.equal(operationResult(store, 'task_tools', row).output.startsWith('out task-0-op-0'), true);
    assert.equal(store.get('SELECT count(*) n FROM trajectory_files WHERE closed_at IS NULL').n, 0);
  } finally {
    await migration.stop();
    await store.trajectories.settle();
  }
});

test('slices stay short: the event loop is never blocked for long while the migration runs', async t => {
  const store = open(t, database(t));
  // Prepare the legacy state before timing migration, without a durable commit for every fixture write.
  store.transaction(() => legacy(store, { tasks: 20, operations: 30, size: 40_000 }));
  const delay = monitorEventLoopDelay({ resolution: 5 }); delay.enable();
  await migrate(store, { readMs: 25 });
  delay.disable();
  assert.equal(finished(store).phases.task_tools.migrated, 581);
  // The 1 s limit of the acceptance with a wide margin for a loaded test machine.
  assert.ok(delay.max / 1e6 < 500, `longest block ${(delay.max / 1e6).toFixed(0)} ms`);
});

test('moving run snapshots keeps at most openFiles migration files open, however many tasks there are', async t => {
  const store = open(t, database(t));
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project','10','a')");
  // Only runs: no later phase appends to (and so closes) the same task files.
  store.transaction(() => {
    for (let i = 0; i < 40; i++) {
      const task = 'runs-' + i;
      store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES(?,'101','task.request','running','Fixture','{}')", task);
      for (let r = 0; r < 2; r++) store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot) VALUES(?,?,'execution',1,1,'now','succeeded',?,?)",
        `${task}-${r}`, task, traceSnapshot({ request: 'C'.repeat(3000), task }), traceSnapshot({ prompt: `P${r} `.repeat(1000) }));
    }
  });
  const openEntries = () => store.get('SELECT count(*) n FROM trajectory_files WHERE closed_at IS NULL').n;
  let most = 0;
  const sync = store.trajectories.sync.bind(store.trajectories);
  t.mock.method(store.trajectories, 'sync', ref => { most = Math.max(most, openEntries()); return sync(ref); });
  await migrate(store, { readMs: 0, openFiles: 4 });
  const state = finished(store);
  assert.equal(state.phases.task_runs.migrated, 80); assert.equal(state.phases.task_runs.failed, 0);
  // Sampled before each slice closes files beyond openFiles: the kept 4 plus the slice's own.
  assert.ok(most <= 5, `${most} migration files open at once`);
  assert.equal(openEntries(), 0);
  await store.trajectories.settle();
  if (existsSync('/proc/self/fd')) {
    const held = readdirSync('/proc/self/fd').filter(fd => { try { return readlinkSync('/proc/self/fd/' + fd).startsWith(store.trajectories.root); } catch { return false; } });
    assert.equal(held.length, 0, 'no descriptor into the trajectory files is left open');
  }
});

test('a row that runs out of descriptors is moved after a pause instead of being counted failed and passed', async t => {
  const store = open(t, database(t)); legacy(store, { tasks: 2, operations: 1 });
  const before = view(store), append = store.trajectories.append.bind(store.trajectories);
  let thrown = 0;
  t.mock.method(store.trajectories, 'append', (...args) => {
    if (!thrown && String(args[2]).startsWith('task_runs:task-1-run-0')) { thrown++; throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }); }
    return append(...args);
  });
  await migrate(store, { exhaustedMs: 5, log: () => {} });
  assert.equal(thrown, 1);
  const state = finished(store);
  assert.equal(state.phases.task_runs.failed, 0); assert.equal(state.phases.task_runs.migrated, 6);
  assert.match(store.get("SELECT context_snapshot FROM task_runs WHERE id='task-1-run-0'").context_snapshot, /^\{"\$trajectory":/);
  assert.deepEqual(view(store), before);
});

test('a slice whose read-back runs out of descriptors is read again instead of failing its rows', async t => {
  const store = open(t, database(t)); legacy(store, { tasks: 2, operations: 1 });
  const before = view(store), read = store.trajectories.read.bind(store.trajectories);
  // A file that cannot be opened is reported as truncated, with the file system error as its cause: that cause is what
  // tells running out of descriptors apart from a missing file.
  const probe = open(t, ':memory:'), scope = { key: 'probe', path: 'probe/file', repository_id: null, task_id: null, run_id: null, conversation_id: null, turn_id: null };
  const ref = probe.trajectories.append(scope, 'event', 'probe', {}); probe.trajectories.close('probe'); await probe.trajectories.settle();
  rmSync(join(probe.trajectories.root, 'probe/file.jsonl'));
  assert.throws(() => probe.trajectories.read(ref), error => error instanceof TrajectoryError && error.code === 'trajectory_truncated' && error.cause?.code === 'ENOENT');
  assert.throws(() => probe.trajectories.getBlob('f'.repeat(64)), error => error instanceof TrajectoryError && error.cause?.code === 'ENOENT');
  let thrown = 0;
  t.mock.method(store.trajectories, 'read', ref => {
    if (!thrown) { thrown++; throw new TrajectoryError('trajectory_truncated', 'file is missing', { cause: Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }) }); }
    return read(ref);
  });
  await migrate(store, { exhaustedMs: 5, log: () => {} });
  assert.equal(thrown, 1);
  const state = finished(store);
  assert.equal(state.phases.task_runs.failed, 0); assert.equal(state.phases.task_runs.migrated, 6);
  assert.deepEqual(view(store), before);
});

test('webhook bodies written before #1403 move to their own files and read the same; refused, small and removed ones stay', async t => {
  const store = open(t, database(t));
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project','10','a')");
  const insert = (id, status, body, removed = null, repository = '101') => store.run(`INSERT INTO deliveries(id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,
    http_status,request_headers,payload,body_complete,response,payload_removed_at) VALUES(?,'a',NULL,?,?,'pull_request','pull_request.opened',?,0,'2026-11-01T00:00:00Z',200,'{}',?,1,'{}',?)`,
    id, repository, id, status, Buffer.from(body), removed);
  const pr = number => JSON.stringify({ action: 'opened', number, repository: { full_name: 'fixture/project' }, pull_request: { number, draft: false, head: { sha: String(number).repeat(40).slice(0, 40) }, body: 'P'.repeat(4000) } }, null, 1);
  insert('pr-1', 'accepted', pr(1)); insert('pr-2', 'accepted', pr(2)); insert('unregistered', 'accepted', pr(3), null, null);
  insert('small', 'accepted', JSON.stringify({ action: 'closed' })); insert('refused', 'invalid_signature', 'R'.repeat(4000)); insert('removed', 'accepted', '', '2026-11-10T00:00:00Z');
  const view = () => store.all('SELECT * FROM deliveries ORDER BY id').map(row => [row.id, deliveryBody(store, row).toString('utf8'), deliveryResult(store, row)]);
  const before = view();
  await migrate(store);
  assert.deepEqual(view(), before);
  const state = finished(store).phases.deliveries;
  assert.equal(state.migrated, 3); assert.equal(state.failed, 0);
  const rows = Object.fromEntries(store.all('SELECT * FROM deliveries').map(row => [row.id, row]));
  for (const id of ['pr-1', 'pr-2', 'unregistered']) {
    const row = rows[id];
    assert.equal(row.payload.length, 0); assert.ok(row.payload_ref && row.payload_sha256 && row.payload_summary);
    assert.equal(statSync(join(store.webhookBodiesDir, row.payload_ref)).mode & 0o777, 0o600);
  }
  assert.ok(rows.unregistered.payload_ref.startsWith('_/'), 'a body without a project is filed under _');
  for (const id of ['small', 'refused', 'removed']) assert.equal(rows[id].payload_ref, null, id);
  assert.equal(Buffer.from(rows.refused.payload).toString('utf8'), 'R'.repeat(4000));
});

test('the migration reads tables by rowid ranges', t => {
  const store = open(t, ':memory:');
  for (const table of ['task_runs', 'deliveries', 'task_tools', 'model_requests', 'task_logs', 'task_history', 'role_conversation_operations', 'tasks']) {
    const plan = store.all(`EXPLAIN QUERY PLAN SELECT rowid AS migration_rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1`).map(row => row.detail).join(' | ');
    assert.match(plan, /SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid>\?\)/, plan);
  }
});
