import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Store } from '../dist/storage/database.js';
import { Workspace } from '../dist/agent/workspace.js';
import { operationId, Redactor } from '../dist/agent/common.js';
import { PayloadMigration, migrationKey } from '../dist/storage/migration.js';
import { blobValue, logContent, modelSnapshot, operationRequestText, operationResult } from '../dist/storage/payloads.js';
import { taskTrace, traceSource } from '../dist/tasks/trace.js';

const key = Buffer.alloc(32, 9);
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trajectory-migration-')), path = join(directory, 'control.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path;
}
const open = (t, path) => { const store = new Store(path, key); t.after(() => { try { store.close(); } catch {} }); return store; };

// Rows as a deployment before #436 wrote them: whole payloads in the rows, copied into task_history by the triggers,
// conversation payloads sealed.
function legacy(store, { tasks = 3, operations = 4, size = 3000 } = {}) {
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
    store.run("INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,'now')", task + '-small', task, JSON.stringify({ type: 'phase', phase: 'prepare' }));
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
  const conversation = store.get("SELECT * FROM role_conversation_operations WHERE id='conv-op'");
  assert.equal(conversation.request, '{}'); assert.equal(conversation.result, null);
  assert.equal(store.get("SELECT conversation_id FROM trajectory_files WHERE id=?", conversation.request_ref.split(':')[0]).conversation_id, 'conv');
  // Migrated files are closed with their counts; progress is in settings.
  assert.equal(store.get('SELECT count(*) n FROM trajectory_files WHERE closed_at IS NULL').n, 0);
  const state = finished(store);
  assert.equal(state.phases.task_tools.migrated, 10); assert.equal(state.phases.task_tools.failed, 0);
  assert.equal(migration.state().remaining.task_tools, 0);
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
  const store = open(t, database(t)); legacy(store, { tasks: 1, operations: 2 });
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
  const store = open(t, database(t)); legacy(store, { tasks: 20, operations: 30, size: 40_000 });
  const delay = monitorEventLoopDelay({ resolution: 5 }); delay.enable();
  await migrate(store, { readMs: 25 });
  delay.disable();
  assert.equal(finished(store).phases.task_tools.migrated, 581);
  // The 1 s limit of the acceptance with a wide margin for a loaded test machine.
  assert.ok(delay.max / 1e6 < 500, `longest block ${(delay.max / 1e6).toFixed(0)} ms`);
});

test('the migration reads tables by rowid ranges', t => {
  const store = open(t, ':memory:');
  for (const table of ['task_tools', 'model_requests', 'task_logs', 'task_history', 'role_conversation_operations', 'tasks']) {
    const plan = store.all(`EXPLAIN QUERY PLAN SELECT rowid AS migration_rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1`).map(row => row.detail).join(' | ');
    assert.match(plan, /SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid>\?\)/, plan);
  }
});
