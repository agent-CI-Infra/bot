import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../dist/storage/database.js';
import { latestRoleCandidate } from '../dist/roles/schedule.js';
import { runEvents, scopeUsage, toolReceipts } from '../dist/roles/role-run.js';
import { queries } from '../dist/app/queries.js';
import { deliveryResult } from '../dist/review/delivery.js';
import { pruneRejectedArchive, rejectedArchiveState, rejectedAudit } from '../dist/app/delivery-audit.js';
import { ProjectService } from '../dist/projects/service.js';
import { readFileSync } from 'node:fs';

// Production: latestRoleCandidate joined task_history on 'task_history:'||h.id, which cannot use the key, so every call
// scanned the whole table (65 ms at 100k rows). The engine's task guard ran it several times a second per task, and with
// ten tasks the control plane's single thread had no time left.
test('role event lookups reach task_history by its key instead of scanning it', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  const seen = [], get = store.get.bind(store), all = store.all.bind(store);
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  assert.equal(latestRoleCandidate(store, 'task'), null);
  assert.equal(runEvents(store, 'run').events.length, 0);
  store.get = get; store.all = all;
  const lookups = seen.filter(sql => /JOIN task_history h/.test(sql));
  assert.equal(lookups.length, 2);
  for (const sql of lookups) {
    const plan = store.all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail);
    assert.ok(!plan.some(detail => /^SCAN h\b/.test(detail)), plan.join(' | '));
    assert.ok(plan.some(detail => /^SEARCH h USING INTEGER PRIMARY KEY/.test(detail)), plan.join(' | '));
  }
  const candidate = store.all('EXPLAIN QUERY PLAN ' + lookups[0]).map(row => row.detail);
  assert.ok(candidate.some(detail => /SEARCH e USING INDEX role_run_event_task/.test(detail)), candidate.join(' | '));
});

// Production: each checkpoint of a role run read its tool receipts by run_id, which no index covered, so the two reads
// scanned task_history (0.8 s each); the console's event list sorted every archived delivery with its payload (100 s).
test('run receipts and the console event list are read through indexes, never by sorting or scanning whole tables', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  const seen = [], all = store.all.bind(store), get = store.get.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  toolReceipts(store, 'run');
  queries(store, { id: 'admin', role: 'super_admin' }, new URL('http://local/api/events?limit=50'));
  store.all = all; store.get = get;
  const plan = sql => store.all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
  for (const sql of seen.filter(sql => /FROM task_history WHERE run_id=\?/.test(sql))) {
    assert.match(plan(sql), /SEARCH task_history USING INDEX task_history_run_type/, sql);
  }
  const [page, rows] = seen.filter(sql => /FROM deliveries/.test(sql));
  assert.match(page, /^SELECT id FROM deliveries/);
  assert.doesNotMatch(plan(page), /TEMP B-TREE|SCAN deliveries\b(?! USING)/, 'the page is read in index order');
  assert.match(rows, /WHERE id IN/);
});

// Production: when a role run ended, recording its usage counted the runs' tool observations, usage reports and external
// usage with run_id IN (…) queries; each scanned task_history (0.86 s at 131k rows), about 4 s per ended run. Budget
// checks during a run use the same queries.
test('role usage reads history and model requests by run through indexes', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,lease_scope) VALUES('run','task','role',1,1,?,'succeeded','{}','{}','scope')", new Date().toISOString());
  const seen = [], all = store.all.bind(store), get = store.get.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  assert.equal(scopeUsage(store, 'scope').runs, 1);
  store.all = all; store.get = get;
  const reads = seen.filter(sql => /FROM (task_history|model_requests)\b/.test(sql));
  assert.ok(reads.length >= 5, `usage queries seen: ${reads.length}`);
  for (const sql of reads) {
    const plan = store.all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
    assert.doesNotMatch(plan, /\bSCAN (task_history|model_requests|[a-z])\b(?! USING)/, `${sql}\n${plan}`);
  }
});

// Production: pruning and reporting refused deliveries filtered with status<>'accepted', which cannot use the first
// column of delivery_status_time, so each refusal scanned every accepted row (30k rows: ~25-35 ms per refused
// transaction) and the state query behind GET /api/events scanned the table again (~8 ms per event list read). The
// bounds here only ever touch refused rows, so every one of the four statements must reach the index by status.
test('refused archive pruning and its counters read deliveries by status and time, never by scanning it', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  const now = Date.parse('2026-11-11T12:00:00Z');
  const insert = store.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < rejectedAudit.maxRows; i++) {
    insert.run(`r${i}`, null, null, null, `d${i}`, 'push', '/', 'invalid_signature', 0,
      new Date(now - i * 60_000).toISOString(), 401, '{}', Buffer.from('{}'), 1, '');
  }
  const seen = [], run = store.run.bind(store), get = store.get.bind(store), all = store.all.bind(store);
  store.run = (sql, ...args) => { seen.push(sql); return run(sql, ...args); };
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  pruneRejectedArchive(store, now);
  const state = rejectedArchiveState(store);
  store.run = run; store.get = get; store.all = all;
  assert.equal(state.rows, rejectedAudit.maxRows - 1, 'the cap removal happened, so the state query saw the capped rows');
  const statements = seen.filter(sql => /(?:FROM|DELETE FROM) deliveries\b/.test(sql));
  assert.equal(statements.length, 4, statements.join('\n'));
  for (const sql of statements) {
    assert.match(sql, /status IN \(/, 'every refusal query filters a closed status set');
    const plan = all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
    assert.doesNotMatch(plan, /\bSCAN deliveries\b/, `${sql}\n${plan}`);
    assert.match(plan, /INDEX delivery_status_time/, `${sql}\n${plan}`);
  }
});

// Production: after #306 paged the event list, each of its rows still looked up the tasks its delivery created by
// source_delivery_id, which no index covered and which a tasks row stores after the task input (about 1 MB): every row
// scanned all tasks through their inputs' overflow pages, and a page of 50 blocked the control plane for 55 s.
test('the tasks a delivery created are read from a covering index, without visiting task rows', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  const seen = [], all = store.all.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  deliveryResult(store, { id: 'delivery', event: 'issues', status: 'accepted', repository_id: null, payload: Buffer.from('{}') });
  store.all = all;
  const [sql] = seen.filter(sql => /FROM tasks WHERE source_delivery_id=\?/.test(sql));
  assert.ok(sql, 'deliveryResult reads tasks by source_delivery_id');
  const plan = store.all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
  assert.match(plan, /SEARCH tasks USING COVERING INDEX task_source_delivery \(source_delivery_id=\?\)/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
});

// Production: task_logs had no index on task_id, so every read of one task's logs scanned the whole table (1.04M rows,
// ~0.35 s each). A running task does it on each phase start, snapshot and fault it logs, the task list does it per row
// for the fault detail, and the log pages per page: about a tenth of the control plane's thread after v0.4.0 started.
test("one task's logs are read through task_logs_task, never by scanning task_logs", async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('repo','o/r','o','a')");
  store.run("INSERT INTO policies(repository_id) VALUES('repo')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,error_code) VALUES('task','repo','review','failed','s','model_unavailable')");
  const seen = [], all = store.all.bind(store), get = store.get.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  const admin = { id: 'admin', role: 'super_admin' };
  for (const path of ['/api/tasks?limit=50', '/api/tasks/task', '/api/tasks/task/logs', '/api/tasks/task/logs?before=9', '/api/tasks/task/logs?after=1'])
    queries(store, admin, new URL('http://local' + path));
  await new ProjectService(store, { call: async () => { throw new Error('manager_unavailable'); } }).detail('repo').catch(() => {});
  store.all = all; store.get = get;
  const plan = sql => all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
  // The running task's own lookups (phase start, snapshot, tool replay, fault) and restart recovery, as compiled.
  const literal = file => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/"(SELECT [^"]*FROM task_logs WHERE task_id=\?[^"]*)"/g)].map(match => match[1]);
  const engine = [...literal('../dist/agent/engine.js'), ...literal('../dist/roles/recovery.js')];
  assert.ok(engine.length >= 5, engine.join('\n'));
  const byTask = [...seen.filter(sql => /FROM task_logs WHERE task_id=/.test(sql)), ...engine];
  assert.ok(byTask.some(sql => /task_id=tasks\.id/.test(sql)), 'the task list and detail read the fault detail by task');
  assert.ok(byTask.some(sql => /ORDER BY rowid (ASC|DESC) LIMIT/.test(sql)), 'the log page reads by task');
  for (const sql of byTask) {
    assert.match(plan(sql), /SEARCH task_logs USING (COVERING )?INDEX task_logs_task \(task_id=/, `${sql}\n${plan(sql)}`);
    assert.doesNotMatch(plan(sql), /\bSCAN task_logs\b/, `${sql}\n${plan(sql)}`);
  }
  // A computer's recent commands walk the newest logs of all tasks until 500 of this project: with the task index the
  // planner would instead gather every log of the project's tasks and sort them.
  const [recent] = seen.filter(sql => /FROM task_logs l\b/.test(sql));
  assert.ok(recent, 'the computer detail reads its recent commands');
  assert.match(plan(recent), /^SCAN l\b/, plan(recent));
  assert.doesNotMatch(plan(recent), /TEMP B-TREE/, plan(recent));
});
