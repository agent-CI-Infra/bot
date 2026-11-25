import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { RetentionCleanup, retentionSettings, saveRetention, trajectoryDays } from '../../../../dist/storage/retention.js';
import { executeSubmitFeedback } from '../../../../dist/feedback/tool.js';
import { getFeedbackEntry } from '../../../../dist/feedback/storage.js';
import { runScope, TrajectoryError } from '../../../../dist/storage/trajectories.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { beginRun } from '../../../../dist/tasks/trace.js';
import { removableWorkspaces } from '../../../../dist/projects/workspace-cleanup.js';
import { externalStorage } from '../../../../dist/external/storage.js';
import { browserEvidenceRoot } from '../../../../dist/browser/evidence.js';
import { browserEvidenceDir } from '../../../../dist/browser/runtime.js';
import { harness, setup, testPassword } from '../../../fixtures/helpers.mjs';
import { managerFixture } from '../../../fixtures/project-manager-fixture.mjs';

// #671 C: cleanup by days. Settings in one place, validated and audited; a daily job removes payloads past their
// windows and keeps rows, accounting, audit and hashes.
const day = 24 * 3600_000, daysAgo = days => new Date(Date.now() - days * day).toISOString(), id = () => randomBytes(24).toString('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'storage-retention-')), store = new Store(join(directory, 'control.sqlite'), Buffer.alloc(32, 8));
  // A test may close the store itself (a shutdown).
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  for (const repo of ['101', '102']) { store.run('INSERT INTO repositories VALUES(?,?,?,?)', repo, 'fixture/project-' + repo, '10', 'a'); store.run('INSERT INTO policies(repository_id) VALUES(?)', repo); }
  return { store, directory };
}
const task = (store, taskId, repo, status, updated = new Date().toISOString()) =>
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?)', taskId, repo, 'review.issue', status, 'fixture', 1, updated, updated);
// A closed run file of a task with one tool call and its result; returns the result ref.
function runFile(store, repo, taskId, run, closedDaysAgo) {
  const scope = runScope(repo, taskId, run);
  store.trajectories.append(scope, 'tool_call', 'op-' + run, { request: { type: 'workspace_read' } });
  const ref = store.trajectories.append(scope, 'tool_result', 'op-' + run, { output: 'x'.repeat(4000) });
  store.trajectories.close(scope.key);
  store.run('UPDATE trajectory_files SET closed_at=? WHERE id=?', daysAgo(closedDaysAgo), ref.split(':')[0]);
  return ref;
}
const usage = (store, repo) => Object.fromEntries(store.all('SELECT kind,count,bytes FROM trajectory_usage WHERE repository_id=?', repo).map(row => [row.kind, row]));

test('settings default to keeping everything, validate their ranges per field, and every change is audited', t => {
  const { store } = fixture(t);
  assert.deepEqual(retentionSettings(store), { trajectory_days: null, trajectory_days_by_project: {}, manager_payload_days: 2, workspace_finished_days: 1, workspace_failed_days: 7, webhook_payload_days: null, project_notes_keep_versions: 50, project_notes_keep_days: 30, feedback_days: null });
  const refused = (input, field) => assert.throws(() => saveRetention(store, 'admin', input), error => error.code === 'storage_retention_invalid' && error.field === field, JSON.stringify(input));
  refused({ trajectory_days: 0 }, 'trajectory_days'); refused({ trajectory_days: 3651 }, 'trajectory_days'); refused({ trajectory_days: 1.5 }, 'trajectory_days');
  refused({ manager_payload_days: null }, 'manager_payload_days'); refused({ webhook_payload_days: 6 }, 'webhook_payload_days');
  refused({ feedback_days: 0 }, 'feedback_days'); refused({ feedback_days: 3651 }, 'feedback_days');
  refused({ workspace_failed_days: '7' }, 'workspace_failed_days'); refused({ unknown: 1 }, 'unknown');
  refused({ trajectory_days_by_project: { 999: 5 } }, 'trajectory_days_by_project'); refused({ trajectory_days_by_project: { 101: 0 } }, 'trajectory_days_by_project');
  assert.throws(() => saveRetention(store, 'admin', {}), error => error.code === 'storage_retention_invalid');
  assert.equal(store.get("SELECT count(*) n FROM audit WHERE action='storage.retention.updated'").n, 0, 'a refused change is neither saved nor audited');
  const saved = saveRetention(store, 'admin', { trajectory_days: 30, trajectory_days_by_project: { 102: 90 }, webhook_payload_days: 7, workspace_finished_days: 3 });
  assert.deepEqual([saved.trajectory_days, saved.trajectory_days_by_project, saved.webhook_payload_days, saved.workspace_finished_days, saved.manager_payload_days], [30, { 102: 90 }, 7, 3, 2]);
  assert.deepEqual([trajectoryDays(saved, '101'), trajectoryDays(saved, '102')], [30, 90]);
  // A later change keeps the other fields; null removes a project's override or turns a window off.
  const next = saveRetention(store, 'admin', { trajectory_days_by_project: { 102: null }, trajectory_days: null });
  assert.deepEqual([next.trajectory_days, next.trajectory_days_by_project, next.webhook_payload_days], [null, {}, 7]);
  assert.deepEqual(store.all("SELECT user_id,action,resource_id FROM audit WHERE action='storage.retention.updated'").map(row => [row.user_id, row.resource_id]), [['admin', 'storage_retention'], ['admin', 'storage_retention']]);
});

test('only super administrators read and change the settings through the console API', async t => {
  const h = await harness(t), { admin } = await setup(h);
  const view = await admin('/api/storage/retention');
  assert.equal(view.status, 200); assert.equal(view.value.settings.manager_payload_days, 2); assert.deepEqual(view.value.bounds.webhook_payload_days, [7, 3650]);
  assert.equal((await admin('/api/storage/retention', 'PUT', { trajectory_days: 0 })).value.error, 'storage_retention_invalid');
  const saved = await admin('/api/storage/retention', 'PUT', { trajectory_days: 14 });
  assert.equal(saved.status, 200); assert.equal(saved.value.settings.trajectory_days, 14);
  const password = testPassword(); await admin('/api/users', 'POST', { username: 'member', password, role: 'project_admin', repository_ids: [] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member('/api/storage/retention')).status, 403); assert.equal((await member('/api/storage/retention', 'PUT', { trajectory_days: 1 })).status, 403);
});

test('the daily cleanup removes the files of ended tasks past their window and keeps rows, accounting and the rest', async t => {
  const { store, directory } = fixture(t);
  task(store, 'done', '101', 'succeeded'); task(store, 'retrying', '101', 'retry_wait'); task(store, 'other', '102', 'failed');
  const old = runFile(store, '101', 'done', 'r1', 40), recent = runFile(store, '101', 'done', 'r2', 2), waiting = runFile(store, '101', 'retrying', 'r3', 40), kept = runFile(store, '102', 'other', 'r4', 40);
  // A conversation's turns are read again when it continues: never removed here.
  const turn = store.trajectories.scopeOf({ id: 'turn-1', conversation_id: 'c1', repository_id: '101' });
  const conversation = store.trajectories.append(turn, 'log', 'l', { text: 'hello' }); store.trajectories.close(turn.key);
  store.run('UPDATE trajectory_files SET closed_at=? WHERE id=?', daysAgo(40), conversation.split(':')[0]);
  saveRetention(store, 'admin', { trajectory_days: 30, trajectory_days_by_project: { 102: 60 } });
  const before = usage(store, '101'), oldEntry = store.get('SELECT * FROM trajectory_files WHERE id=?', old.split(':')[0]);
  const result = await new RetentionCleanup(store, undefined, { pauseMs: 0, batch: 1 }).run();
  assert.deepEqual(result.trajectories, { count: 1, bytes: oldEntry.bytes, failed: 0 });
  const entry = store.get('SELECT * FROM trajectory_files WHERE id=?', old.split(':')[0]);
  assert.ok(entry.expired_at && entry.deleted_at); assert.equal(existsSync(join(directory, 'trajectories', entry.path)), false);
  assert.throws(() => store.trajectories.read(old), error => error instanceof TrajectoryError && error.code === 'trajectory_expired');
  for (const ref of [recent, waiting, kept, conversation]) assert.ok(store.trajectories.read(ref), 'within its window, a task still going, a longer project window, a conversation');
  const after = usage(store, '101');
  assert.equal(after.files.count, before.files.count - 1); assert.equal(after.files.bytes, before.files.bytes - oldEntry.bytes);
  assert.deepEqual([after.expired.count, after.expired.bytes], [1, oldEntry.bytes]); assert.equal(after['records:tool_result'].count, before['records:tool_result'].count - 1);
  assert.equal(new RetentionCleanup(store).state().trajectories.count, 1);
  // The task ended long ago; if it ran again with the same keys, the removed result is answered as expired, never run.
  const calls = [], manager = { async call(...args) { calls.push(args); return { ok: true, result: {} }; } };
  const done = store.get("SELECT * FROM tasks WHERE id='done'"), runRow = beginRun(store, done, 'attempt', {});
  const workspace = new Workspace(store, manager, { ...done, attempt: 1, generation: 1, workspace_id: 'w', trace_run_id: runRow.id }, new Redactor(), async () => {}, () => {});
  await workspace.call('step', { type: 'workspace_read', path: 'a.txt' });
  const row = store.get("SELECT * FROM task_tools WHERE task_id='done'");
  store.trajectories.close(runScope('101', 'done', runRow.id).key);
  store.trajectories.expire([store.get('SELECT * FROM trajectory_files WHERE id=?', row.result_ref.split(':')[0])]);
  await assert.rejects(workspace.call('step', { type: 'workspace_read', path: 'a.txt' }), error => error.code === 'operation_result_expired' && error.state === 'waiting_environment');
  assert.equal(calls.length, 1); assert.ok(store.get("SELECT 1 FROM task_tools WHERE task_id='done'"), 'the row stays');
});

test('webhook bodies past their window are emptied with their hash kept; a body an executor still needs stays; a cursor saves rereading', async t => {
  const { store } = fixture(t);
  externalStorage(store);
  const insert = (key, days, body) => store.run(`INSERT INTO deliveries(id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,http_status,request_headers,payload,body_complete,response)
    VALUES(?,'a',NULL,'101',?,'issues','app','accepted',0,?,202,'{}',?,1,'{}')`, key, key, daysAgo(days), Buffer.from(body));
  insert('old', 10, '{"action":"opened","body":"' + 'x'.repeat(500) + '"}'); insert('forwarding', 10, '{"action":"edited"}'); insert('new', 1, '{"action":"closed"}');
  store.run("INSERT INTO external_clients(id,repository_id,name,auth_type,trust,created_at) VALUES('client','101','fixture','token','trusted',?)", new Date().toISOString());
  store.run("INSERT INTO external_subscriptions(id,client_id,repository_id,name,url,secret,filters,created_at) VALUES('sub','client','101','fixture','https://x.invalid','s','{}',?)", new Date().toISOString());
  store.run("INSERT INTO external_deliveries(id,subscription_id,repository_id,source_id,version,state,created_at) VALUES('x','sub','101','forwarding',1,'retry',?)", new Date().toISOString());
  saveRetention(store, 'admin', { webhook_payload_days: 7 });
  const body = store.get("SELECT payload FROM deliveries WHERE id='old'").payload;
  const result = await new RetentionCleanup(store, undefined, { pauseMs: 0 }).run();
  assert.deepEqual(result.deliveries, { count: 1, bytes: body.length, failed: 0 });
  const old = store.get("SELECT * FROM deliveries WHERE id='old'");
  assert.equal(old.payload.length, 0); assert.equal(old.payload_sha256, createHash('sha256').update(body).digest('hex')); assert.equal(old.payload_bytes, body.length);
  assert.ok(old.payload_removed_at); assert.deepEqual([old.status, old.http_status, old.request_headers], ['accepted', 202, '{}']);
  assert.ok(store.get("SELECT payload FROM deliveries WHERE id='forwarding'").payload.length > 0); assert.ok(store.get("SELECT payload FROM deliveries WHERE id='new'").payload.length > 0);
  assert.deepEqual((await new RetentionCleanup(store, undefined, { pauseMs: 0 }).run()).deliveries, { count: 0, bytes: 0, failed: 0 }, 'rows behind the cursor are not read again');
  // Once the executor has been sent the delivery, its body goes at the next pass even though the cursor moved on.
  store.run("UPDATE external_deliveries SET state='succeeded' WHERE id='x'");
  assert.deepEqual((await new RetentionCleanup(store, undefined, { pauseMs: 0 }).run()).deliveries.count, 1);
  assert.equal(store.get("SELECT length(payload) n FROM deliveries WHERE id='forwarding'").n, 0);
  assert.deepEqual(new RetentionCleanup(store).state().deliveries_skipped, []);
});

test('deleting a project after its files expired leaves no totals behind', async t => {
  const { store } = fixture(t);
  task(store, 'done', '101', 'succeeded'); runFile(store, '101', 'done', 'r1', 40); runFile(store, '101', 'done', 'r2', 40); runFile(store, '101', 'done', 'r3', 1);
  saveRetention(store, 'admin', { trajectory_days: 30 });
  await new RetentionCleanup(store, undefined, { pauseMs: 0 }).run();
  assert.equal(usage(store, '101').expired.count, 2);
  store.trajectories.remove({ repository_id: '101' });
  assert.deepEqual(store.all("SELECT kind,count,bytes FROM trajectory_usage WHERE repository_id='101'"), []);
  assert.equal(store.get("SELECT count(*) n FROM trajectory_files WHERE repository_id='101'").n, 0);
  // A conversation removed after its project's files expired adjusts only its own totals.
  task(store, 'other', '102', 'failed'); runFile(store, '102', 'other', 'r4', 40);
  const turn = store.trajectories.scopeOf({ id: 'turn-1', conversation_id: 'c1', repository_id: '102' }); store.trajectories.append(turn, 'log', 'l', {}); store.trajectories.close(turn.key);
  await new RetentionCleanup(store, undefined, { pauseMs: 0 }).run();
  store.trajectories.remove({ conversation_id: 'c1' });
  const left = usage(store, '102');
  assert.deepEqual([left.files.count, left.expired.count], [0, 1]); assert.ok(Object.values(left).every(row => row.count >= 0 && row.bytes >= 0));
});

test('one file that cannot be removed is counted and left for later; the rest of the pass goes on', async t => {
  const { store } = fixture(t);
  externalStorage(store);
  task(store, 'done', '101', 'succeeded'); const ref = runFile(store, '101', 'done', 'r1', 40);
  // An entry marked by a stopped pass whose path is not under the trajectories directory.
  store.run("INSERT INTO trajectory_files(id,repository_id,path,created_at,closed_at,bytes,records,counts,expired_at) VALUES('bad0bad0bad0bad0','101','../../escape',?,?,1,1,'{}',?)", daysAgo(50), daysAgo(50), daysAgo(1));
  store.run(`INSERT INTO deliveries(id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,http_status,request_headers,payload,body_complete,response)
    VALUES('d','a',NULL,'101','d','issues','app','accepted',0,?,202,'{}',?,1,'{}')`, daysAgo(10), Buffer.from('{"action":"opened"}'));
  saveRetention(store, 'admin', { trajectory_days: 30, webhook_payload_days: 7 });
  t.mock.method(console, 'error', () => {});
  const result = await new RetentionCleanup(store, undefined, { pauseMs: 0 }).run();
  assert.equal(result.trajectories.failed, 1); assert.equal(result.trajectories.count, 1); assert.match(result.last_error, /trajectory_ref_invalid/);
  assert.throws(() => store.trajectories.read(ref), error => error.code === 'trajectory_expired');
  assert.equal(result.deliveries.count, 1); assert.equal(store.get("SELECT length(payload) n FROM deliveries WHERE id='d'").n, 0);
  assert.equal(store.get("SELECT deleted_at FROM trajectory_files WHERE id='bad0bad0bad0bad0'").deleted_at, null, 'kept for a later pass');
});

test('stopping waits for a pass in progress, which ends at its next step, before the store closes', async t => {
  const { store } = fixture(t);
  task(store, 'done', '101', 'succeeded');
  for (let i = 0; i < 5; i++) runFile(store, '101', 'done', 'r' + i, 40);
  saveRetention(store, 'admin', { trajectory_days: 30 });
  const cleanup = new RetentionCleanup(store, undefined, { pauseMs: 60_000, batch: 1 }), errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const running = cleanup.run();
  await new Promise(resolve => setTimeout(resolve, 50));
  await cleanup.stop();
  store.close();
  assert.deepEqual(await running, {}); assert.deepEqual(errors, []);
  assert.deepEqual(await cleanup.run(), {}, 'a stopped cleanup does not start another pass');
});

test('the manager window follows the setting, and the manager checks it', async t => {
  const { store } = fixture(t), calls = [];
  let window = 2;
  const manager = { async call(method, path, input) { calls.push([method, path, input]); if (method === 'GET') return { expiry: { window_days: window } }; if (method === 'PUT' && path === '/v1/storage/retention') window = input.payload_days; return {}; } };
  const cleanup = new RetentionCleanup(store, manager, { pauseMs: 0 });
  await cleanup.run(); assert.deepEqual(calls.filter(call => call[0] === 'PUT'), [], 'already in step');
  saveRetention(store, 'admin', { manager_payload_days: 5 });
  assert.equal((await cleanup.run()).manager_window, 5); assert.deepEqual(calls.filter(call => call[1] === '/v1/storage/retention').at(-1), ['PUT', '/v1/storage/retention', { payload_days: 5 }]);
  const failing = new RetentionCleanup(store, { call: async () => { throw new Error('manager_unavailable'); } }, { pauseMs: 0 });
  t.mock.method(console, 'error', () => {});
  assert.equal((await failing.run()).manager_window, null);
  const f = await managerFixture(t);
  for (const days of [0, 366, 1.5, '3']) assert.throws(() => f.projects.setRetention({ payload_days: days }), /invalid_retention/);
  assert.throws(() => f.projects.setRetention({ payload_days: 3, other: 1 }), /invalid_retention/);
  assert.equal(f.projects.setRetention({ payload_days: 9 }).window_days, 9); assert.equal(f.projects.storage().expiry.window_days, 9);
});

test('task workspaces follow the configured days', t => {
  const { store } = fixture(t), finished = id(), failed = id(), unowned = id(), now = Date.now();
  task(store, 'f1', '101', 'succeeded', daysAgo(2)); task(store, 'f2', '101', 'failed', daysAgo(4));
  for (const [workspace, taskId] of [[finished, 'f1'], [failed, 'f2']])
    store.run("INSERT INTO task_workspaces(repository_id,workspace_id,task_id,task_kind,object_number,kind,created_at) VALUES('101',?,?,'review.issue',1,'task',?)", workspace, taskId, daysAgo(5));
  // Last active five days ago; the finished task was updated two days ago, the failed one four.
  const entries = [finished, failed, unowned].map(name => ({ name, active_at: now - 5 * day }));
  const removable = () => removableWorkspaces(store, '101', entries, now).map(entry => entry.name).sort();
  assert.deepEqual(removable(), [finished, unowned].sort(), 'defaults: a day after finishing, a week after failing');
  saveRetention(store, 'admin', { workspace_finished_days: 3, workspace_failed_days: 3 });
  assert.deepEqual(removable(), [failed, unowned].sort(), 'three days for both; a directory no record names follows the finished days');
  saveRetention(store, 'admin', { workspace_finished_days: 6 });
  assert.deepEqual(removable(), [failed]);
});

test('the cleanup reads files and deliveries through their indexes', t => {
  const { store } = fixture(t); new RetentionCleanup(store); externalStorage(store);
  const plan = sql => store.all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
  const files = plan(`SELECT id FROM trajectory_files WHERE repository_id=? AND expired_at IS NULL AND closed_at IS NOT NULL AND conversation_id IS NULL AND closed_at<? AND (closed_at,id)>(?,?) ORDER BY closed_at,id LIMIT ?`);
  assert.match(files, /SEARCH trajectory_files USING INDEX trajectory_files_expiry/, files); assert.doesNotMatch(files, /TEMP B-TREE/, files);
  const marked = plan('SELECT id,path FROM trajectory_files WHERE expired_at IS NOT NULL AND deleted_at IS NULL ORDER BY expired_at LIMIT 1000');
  assert.match(marked, /trajectory_files_removal/, marked); assert.doesNotMatch(marked, /TEMP B-TREE/, marked);
  const deliveries = plan('SELECT id,received_at,payload FROM deliveries WHERE received_at<? AND (received_at,id)>(?,?) ORDER BY received_at,id LIMIT ?');
  assert.match(deliveries, /SEARCH deliveries USING INDEX delivery_time/, deliveries); assert.doesNotMatch(deliveries, /TEMP B-TREE/, deliveries);
  const forwarding = plan("SELECT DISTINCT source_id FROM external_deliveries WHERE state IN ('pending','retry','sending')");
  assert.match(forwarding, /external_retry_due/, forwarding);
});

test('browser evidence cleanup counts real file bytes and leaves unsanitized names alone', async t => {
  const { store } = fixture(t);
  saveRetention(store, 'admin', { trajectory_days: 30 });
  task(store, 'ev-old', '101', 'succeeded', daysAgo(40));
  const root = browserEvidenceRoot(store);
  const dir = browserEvidenceDir(root, 'ev-old');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = Buffer.alloc(2048, 7);
  writeFileSync(join(dir, 'step-1.png'), payload);
  writeFileSync(join(dir, 'steps.json'), '{"steps":[1]}');
  const expected = payload.length + Buffer.byteLength('{"steps":[1]}');
  const odd = join(root, 'bad name');
  mkdirSync(odd, { recursive: true, mode: 0o700 });
  writeFileSync(join(odd, 'x.bin'), Buffer.alloc(512, 1));
  const result = await new RetentionCleanup(store, undefined, { pauseMs: 0, batch: 1 }).run();
  assert.equal(result.evidence.count, 1);
  assert.equal(result.evidence.bytes, expected);
  assert.equal(result.evidence.failed, 0);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(odd), true, 'a directory whose name would be rewritten must not be deleted');
});

test('dispatch failure evidence follows the explicit project trajectory window; default keep preserves records',async t=>{
 const {store}=fixture(t);
 for(const [event,repo] of [['bounded','101'],['keep','102']]){store.run("INSERT INTO dispatch_events(id,repository_id,event_key,type,source,summary,facts,options,state,created_at) VALUES(?,?,?,'probe','fixture','retention','{}','[]','pending',?)",event,repo,event,daysAgo(10));for(const [attempt,age] of [[1,5],[2,0]])store.run('INSERT INTO dispatch_failures VALUES(?,?,?,?,?,?)',event,attempt,daysAgo(age),JSON.stringify({code:'fixture_failure'}),0,0);}
 let cleanup=new RetentionCleanup(store,undefined,{pauseMs:0});t.after(()=>cleanup.stop());await cleanup.run();assert.equal(store.get('SELECT count(*) n FROM dispatch_failures').n,4);
 saveRetention(store,'admin',{trajectory_days_by_project:{101:1}});const result=await cleanup.run();assert.equal(result.dispatch_failures.count,1);
 assert.deepEqual(store.all('SELECT event_id,attempt FROM dispatch_failures ORDER BY event_id,attempt').map(r=>[r.event_id,r.attempt]),[['bounded',2],['keep',1],['keep',2]]);
 assert.equal(store.get("SELECT state FROM dispatch_events WHERE id='bounded'").state,'pending','retention never stops retries');
});

test('#1122 inactive dispatch_threads past the project trajectory window are pruned while active or pending threads stay',async t=>{
 const {store}=fixture(t);
 task(store,'active-task','101','running',daysAgo(10));
 store.run("INSERT INTO dispatch_threads(thread_key,repository_id,object_type,object_number,messages,summary,active_task_id,updated_at) VALUES('101:event:old','101','event',NULL,'[]','old',NULL,?)",daysAgo(5));
 store.run("INSERT INTO dispatch_threads(thread_key,repository_id,object_type,object_number,messages,summary,active_task_id,updated_at) VALUES('101:issue:9','101','issue',9,'[]','active','active-task',?)",daysAgo(5));
 store.run("INSERT INTO dispatch_threads(thread_key,repository_id,object_type,object_number,messages,summary,active_task_id,updated_at) VALUES('102:event:keep','102','event',NULL,'[]','keep',NULL,?)",daysAgo(5));
 saveRetention(store,'admin',{trajectory_days_by_project:{101:1}});
 const cleanup=new RetentionCleanup(store,undefined,{pauseMs:0});t.after(()=>cleanup.stop());
 const result=await cleanup.run();
 assert.equal(result.dispatch_threads.count,1);
 assert.deepEqual(store.all('SELECT thread_key FROM dispatch_threads ORDER BY thread_key').map(r=>r.thread_key),['101:issue:9','102:event:keep']);
});

test('feedback cleanup sweeps stale orphan files even when feedback_days is null, and prunes expired entries when feedback_days is set', async t => {
  const { store } = fixture(t);
  const oldRes = executeSubmitFeedback({
    store,
    idempotencyScope: 'ret:1',
    now: () => Date.now() - 40 * day,
    snapshot: () => ({
      source_kind: 'project_role',
      untrusted_context: false,
      repository_id: '101',
      repository_full_name: 'fixture/project-101',
      role: { role_id: 'dev', system_prompt: 'sys', offered_tools: ['submit_feedback'] },
      harness: { id: 'pi' },
      model: { name: 'm' },
    }),
  }, { category: 'tool', severity: 'medium', title: 'Old feedback', context: 'c', problem: 'p', suggestion: 's' });
  assert.equal(oldRes.accepted, true);
  const oldEntry = getFeedbackEntry(store, oldRes.feedback_id);
  const freshRes = executeSubmitFeedback({
    store,
    idempotencyScope: 'ret:2',
    now: () => Date.now() - day,
    snapshot: () => ({
      source_kind: 'project_role',
      untrusted_context: false,
      repository_id: '101',
      repository_full_name: 'fixture/project-101',
      role: { role_id: 'dev', system_prompt: 'sys', offered_tools: ['submit_feedback'] },
      harness: { id: 'pi' },
      model: { name: 'm' },
    }),
  }, { category: 'skill', severity: 'low', title: 'Fresh feedback', context: 'c', problem: 'p', suggestion: 's' });
  assert.equal(freshRes.accepted, true);
  const freshEntry = getFeedbackEntry(store, freshRes.feedback_id);
  const orphanShard = join(store.feedbackDir, 'ff');
  mkdirSync(orphanShard, { recursive: true, mode: 0o700 });
  const staleOrphan = join(orphanShard, 'ff00stale1.json.gz');
  const staleTmp = join(orphanShard, 'ff00stale2.json.gz.a1b2c3d4e5f6.tmp');
  const recentOrphan = join(orphanShard, 'ff00recent.json.gz');
  for (const p of [staleOrphan, staleTmp, recentOrphan]) writeFileSync(p, Buffer.from('orphan'));
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  utimesSync(staleOrphan, twoHoursAgo, twoHoursAgo);
  utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

  const cleanup = new RetentionCleanup(store, undefined, { pauseMs: 0 });
  t.after(() => cleanup.stop());
  // Default feedback_days = null: keeps both indexed entries, sweeps >1h orphans only.
  const first = await cleanup.run();
  assert.equal(first.feedback.count, 2);
  assert.equal(existsSync(staleOrphan), false);
  assert.equal(existsSync(staleTmp), false);
  assert.equal(existsSync(recentOrphan), true, 'orphans younger than 1 hour are left alone');
  assert.equal(store.get('SELECT count(*) n FROM feedback_entries').n, 2);

  // Explicit feedback_days = 30: removes oldEntry index + file, retains freshEntry.
  saveRetention(store, 'admin', { feedback_days: 30 });
  const second = await cleanup.run();
  assert.equal(second.feedback.count, 1);
  assert.equal(existsSync(join(store.feedbackDir, oldEntry.payload_relpath)), false);
  assert.equal(existsSync(join(store.feedbackDir, freshEntry.payload_relpath)), true);
  assert.deepEqual(store.all('SELECT id FROM feedback_entries').map(r => r.id), [freshEntry.id]);
});
