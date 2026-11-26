import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { latestRoleCandidate } from '../../../../dist/roles/schedule.js';
import { runEvents, scopeUsage, toolReceipts } from '../../../../dist/roles/role-run.js';
import { queries } from '../../../../dist/app/queries.js';
import { deliveryResult } from '../../../../dist/review/delivery.js';
import { pruneRejectedArchive, rejectedArchiveState, rejectedAudit } from '../../../../dist/app/delivery-audit.js';
import { ProjectService } from '../../../../dist/projects/service.js';
import { Dispatcher } from '../../../../dist/dispatch/worker.js';
import { pruneDispatchThreads } from '../../../../dist/dispatch/store.js';
import { botPrWakeRevisionFacts, BOT_PR_WAKE_TASK_ROWS_SQL } from '../../../../dist/review/bot-pr-wake.js';
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
  const engine = [...literal('../../../../dist/agent/engine.js'), ...literal('../../../../dist/roles/recovery.js')];
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

// Production (#1350): the dispatch worker's thread lookups also filtered by repository_id. SQLite then read them through
// dispatch_events_repository(repository_id,created_at) and visited every earlier event of the repository, 3–4.5 s per tick;
// the tick runs every 2 s and after each decided event, so v0.4.12's control plane stayed unhealthy. A thread key starts
// with its repository id, so thread_key alone selects the same rows through the covering dispatch_events_thread index.
test('dispatch thread lookups read the thread index instead of every earlier event of the repository', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  const at = i => new Date(Date.parse('2026-11-24T00:00:00Z') + i * 1000).toISOString();
  const insert = store.db.prepare(`INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,thread_key,created_at)
    VALUES(?,?,?,?,'github',?,?,'','{}','[]',?,?,?)`);
  store.transaction(() => {
    // As in production: many decided events of the repository before the few that wait.
    for (let i = 0; i < 2000; i++) insert.run(`old${i}`, 'r1', `old${i}`, 'issue_comment.created', 'issue', i % 50 + 1, 'decided', `r1:issue:${i % 50 + 1}`, at(i));
    insert.run('other', 'r2', 'other', 'issue_comment.created', 'issue', 7, 'pending', 'r2:issue:7', at(2999));
    insert.run('issue', 'r1', 'issue', 'issue_comment.created', 'issue', 7, 'pending', 'r1:issue:7', at(3000));
    // The bot PR of Issue 7 shares its thread: only the thread lookup holds it back, the object lookup does not.
    insert.run('pr', 'r1', 'pr', 'pull_request.updated', 'pr', 88, 'pending', 'r1:issue:7', at(3001));
    insert.run('push', 'r1', 'push', 'push', null, null, 'pending', 'r1:event:push', at(3002));
    for (const [key, number] of [['r1:issue:7', 7], ['r1:issue:3', 3]])
      store.run("INSERT INTO dispatch_threads(thread_key,repository_id,object_type,object_number,updated_at) VALUES(?,'r1','issue',?,?)", key, number, at(0));
  });
  const seen = [], claimed = [], all = store.all.bind(store), get = store.get.bind(store), run = store.run.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  // Claims are refused, so the tick only shows which events it would start, without deciding them.
  store.run = (sql, ...args) => {
    if (/^UPDATE dispatch_events SET state='dispatching'/.test(sql)) { claimed.push(args[2]); return { changes: 0 }; }
    seen.push(sql); return run(sql, ...args);
  };
  new Dispatcher(store, async () => assert.fail('no event is decided')).tick();
  const pruned = pruneDispatchThreads(store, 'r1', at(10_000));
  store.all = all; store.get = get; store.run = run;
  assert.deepEqual(claimed.sort(), ['issue', 'other', 'push'], 'each thread starts its oldest waiting event; the bot PR waits for its Issue');
  assert.equal(pruned, 1);
  assert.deepEqual(all('SELECT thread_key FROM dispatch_threads').map(row => row.thread_key), ['r1:issue:7'], 'a thread with waiting events is kept');

  const plan = sql => all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | ');
  // The open bot PR patrol only runs inside the GitHub reconcile loop; its lookup is read from the compiled module.
  const patrol = [...readFileSync(new URL('../../../../dist/review/bot-pr-wake.js', import.meta.url), 'utf8')
    .matchAll(/"(SELECT [^"]*FROM dispatch_events WHERE [^"]*thread_key=\?[^"]*)"/g)].map(match => match[1]);
  assert.equal(patrol.length, 1, patrol.join('\n'));
  const lookups = [...new Set(seen.filter(sql => /FROM dispatch_events\b[^)]*\bthread_key=/.test(sql))), ...patrol];
  assert.equal(lookups.length, 4, `tick, its per-event recheck, thread pruning and the patrol:\n${lookups.join('\n')}`);
  for (const sql of lookups) {
    assert.match(plan(sql), /USING COVERING INDEX dispatch_events_thread \(thread_key=\? AND state=\?\)/, `${sql}\n${plan(sql)}`);
    assert.doesNotMatch(plan(sql), /dispatch_events_repository|dispatch_events_object \(repository_id=\?\)/, `${sql}\n${plan(sql)}`);
  }
});

// Production (#1353): botPrWakeRevisionFacts built the revision facts of every check failure, conflict and patrol with
// one statement whose `(e.object_number=? OR t.object_number=?)` spanned two tables. SQLite could only nest-loop every
// task of the repository (`board_task_object (repository_id=?)`) with every event of the repository
// (`dispatch_events_object (repository_id=?)`): 3.5 s per call on 5k tasks and 13k events, and each wake event calls it
// twice, so the control plane's thread stayed blocked for a quarter of the time. The two halves of the OR are now
// index-driven: the PR's wake events lead to their tasks, and the PR's own tasks lead to their linked wake events.
test('bot PR wake facts read the PR’s own events and tasks, never the repository board and event lists', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  const at = i => new Date(Date.parse('2026-11-24T00:00:00Z') + i * 1000).toISOString();
  store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('r1','o/r1','o','a')");
  store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('r2','o/r2','o','a')");
  const event = (id, repository, type, objectType, number, created) => store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,created_at)
     VALUES(?,?,?,?,'github',?,?,'','{}','[]','pending',?)`,
    id, repository, `${repository}:${id}`, type, objectType, number, created);
  const task = (id, repository, kind, number, created) => store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at) VALUES(?,?,?,'pr_opened','s',?,?,?)",
    id, repository, kind, number, created, created);
  const link = (taskId, eventId, created) => store.run('INSERT INTO task_events(task_id,event_id,relation,created_at) VALUES(?,?,?,?)',
    taskId, eventId, 'wake', created);
  store.transaction(() => {
    // A production-sized repository before v0.4.14: thousands of unrelated tasks (some only reviewed) and events.
    for (let i = 0; i < 2500; i++) task(`noise-task-${i}`, 'r1', 'review.pr', i % 200 + 1, at(i));
    for (let i = 0; i < 2500; i++) event(`noise-event-${i}`, 'r1', 'issue_comment.created', 'issue', i % 200 + 1, at(i));
    for (let i = 0; i < 200; i++) event(`other-pr-wake-${i}`, 'r1', 'pull_request.checks_failed', 'pr', 3000 + i, at(2500 + i));

    // The PR's wake event reaches a task that is numbered for its root Issue: the event branch alone selects it.
    event('wake-conflict', 'r1', 'pull_request.conflicted', 'pr', 2468, at(5000));
    task('task-event-only', 'r1', 'task.request', 2000, at(5001));
    link('task-event-only', 'wake-conflict', at(5002));
    // A task numbered for the PR is selected by the task branch even when its linked wake event is another PR's.
    task('task-number-only', 'r1', 'development.pr', 2468, at(5003));
    link('task-number-only', 'other-pr-wake-0', at(5004));
    // Both branches select the PR's own task, which must appear once and group both wake types into one round.
    task('task-overlap', 'r1', 'development.pr', 2468, at(5005));
    event('wake-patrol', 'r1', 'pull_request.patrol', 'pr', 2468, at(5006));
    link('task-overlap', 'wake-conflict', at(5007));
    link('task-overlap', 'wake-patrol', at(5008));
    // Not a wake type: the task branch must not match every event of the PR.
    task('task-issue-only', 'r1', 'review.pr', 2468, at(5009));
    event('issue-update', 'r1', 'issue.updated', 'issue', 2468, at(5010));
    link('task-issue-only', 'issue-update', at(5011));
    // Wake events and tasks of another repository never match.
    event('r2-wake', 'r2', 'pull_request.conflicted', 'pr', 2468, at(5012));
    task('r2-task', 'r2', 'development.pr', 2468, at(5013));
    link('r2-task', 'r2-wake', at(5014));
  });

  const seen = [], all = store.all.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  const facts = botPrWakeRevisionFacts(store, 'r1', 2468);
  store.all = all;

  // The facts statement the production path runs, not a copy of it, is the one under test.
  const [sql] = seen.filter(statement => statement === BOT_PR_WAKE_TASK_ROWS_SQL);
  assert.ok(sql, 'botPrWakeRevisionFacts reads its task rows with the exported statement');
  const columns = 't.id,t.kind,t.status,t.summary,t.head_sha,t.error_code,t.input,t.result,t.created_at,t.updated_at';
  const ids = rows => rows.map(row => row.id);
  assert.deepEqual(ids(all(sql, 'r1', 2468, 'r1', 2468, 'r1', 'r1')), ['task-event-only', 'task-number-only', 'task-overlap'],
    'the event branch, the task branch and their overlap (once) in created_at order');
  // The statement this replaced, kept here to show the new one returns the same rows for the same shapes.
  const legacySql = `SELECT DISTINCT ${columns}
     FROM tasks t
     JOIN task_events te ON te.task_id=t.id
     JOIN dispatch_events e ON e.id=te.event_id
     WHERE t.repository_id=? AND e.repository_id=?
       AND e.type IN ('pull_request.checks_failed','pull_request.conflicted','pull_request.patrol')
       AND (e.object_number=? OR t.object_number=?)
     ORDER BY t.created_at ASC, t.rowid ASC`;
  const legacyArgs = ['r1', 'r1', 2468, 2468];
  assert.deepEqual(ids(all(sql, 'r1', 2468, 'r1', 2468, 'r1', 'r1')), ids(all(legacySql, ...legacyArgs)));
  // The number-only task row is selected by the OR, as before, but its wake links belong to another PR, so it adds no
  // round: the facts only ever counted the PR's own wake events (the per-task links query already required that).
  assert.deepEqual(facts.rounds.map(round => [round.task_id, round.triggers.join(',')]), [
    ['task-event-only', 'pull_request.conflicted'],
    ['task-overlap', 'pull_request.conflicted,pull_request.patrol'],
  ], 'one round per task, both wake types of the overlapping task grouped');
  assert.equal(facts.for_conflicts, 2);
  assert.equal(facts.for_checks_failed, 0);
  assert.equal(facts.for_patrol, 1);

  const explain = (statement, args) => all('EXPLAIN QUERY PLAN ' + statement, ...args).map(row => row.detail).join(' | ');
  const plan = explain(sql, ['r1', 2468, 'r1', 2468, 'r1', 'r1']);
  // The PR's events through their object index, and the PR's tasks through their board index: both equalities, and no
  // loop of the repository's tasks against its events (the plan this test is about).
  assert.match(plan, /SEARCH e USING INDEX dispatch_events_object \(repository_id=\? AND object_type=\? AND object_number=\?\)/, plan);
  assert.match(plan, /SEARCH s USING (?:COVERING )?INDEX board_task_(?:object|latest|cover) \(repository_id=\? AND object_number=\?\)/, plan);
  // The cross joins pin the other three reads (#1353 review): the event branch's task links by event_id, and the task
  // branch's links by task_id followed by every event by its primary key. Left to itself, SQLite 3.50.4 puts
  // `dispatch_events_object (repository_id=?)` first in the task branch, i.e. it still walks the repository's events
  // once per task of the PR, so the join order must stay a property of the statement rather than of the planner.
  assert.match(plan, /SEARCH te USING (?:COVERING )?INDEX task_events_event \(event_id=\?\)/, plan);
  assert.match(plan, /SEARCH te USING (?:COVERING )?INDEX (?:task_events_event|sqlite_autoindex_task_events_1) \(task_id=\?\)/, plan);
  assert.match(plan, /SEARCH e USING (?:COVERING )?INDEX sqlite_autoindex_dispatch_events_1 \(id=\?\)/, plan);
  assert.doesNotMatch(plan, /SEARCH t USING INDEX board_task_(?:object|latest|cover) \(repository_id=\?\)/, plan);
  assert.doesNotMatch(plan, /dispatch_events_object \(repository_id=\?\)/, plan);
  assert.doesNotMatch(plan, /board_task_object \(repository_id=\?\).*dispatch_events_object \(repository_id=\?\)/, plan);
  // The rows here are enough to reproduce the statement this replaced: it reads the repository's tasks and the
  // repository's events. Both are asserted without an order, and the task index by name loosely, because a SQLite
  // version picks both itself: 3.47.2 (Node 22.13.0/22.14.0) reads the tasks through `board_task_latest`, 3.50.4 and
  // 3.54.1 through `board_task_object`, and a version with statistics may use `board_task_cover`. What matters here is
  // that the two full-repository reads are there.
  const legacyPlan = explain(legacySql, legacyArgs);
  assert.match(legacyPlan, /SEARCH t USING INDEX board_task_(?:object|latest|cover) \(repository_id=\?\)/, legacyPlan);
  assert.match(legacyPlan, /SEARCH e USING INDEX dispatch_events_object \(repository_id=\?\)/, legacyPlan);
});

// Production (#1398): the storage refresh (every five minutes) and the hourly sweep read each unfinished task's role
// checkouts with task_id=? AND type='role_candidate', which no index covers, so every history row of the task was read:
// 0.1-8 s per task, 66 s for one refresh. A task's candidates are now read once through indexes, then only the rows
// added since, by rowid.
test('role checkouts of unfinished tasks are read through indexes, never by walking a task history', async t => {
  const { unfinishedTaskWorkspaces } = await import('../../../../dist/projects/workspace-cleanup.js');
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  const now = new Date().toISOString(), ws = 'a'.repeat(48);
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,created_at,updated_at,workspace_id) VALUES('task','101','task.request','running','','{}',?,?,?)", now, now, ws);
  store.run("INSERT INTO task_workspaces(repository_id,workspace_id,task_id,kind,created_at) VALUES('101',?,'task','task',?)", ws, now);
  const candidate = runId => store.run("INSERT INTO task_history(task_id,type,data,created_at,run_id) VALUES('task','role_candidate',?,?,?)", JSON.stringify({ role: 'developer', workspace_id: ws }), now, runId);
  candidate('run-1'); candidate(null);
  const seen = [], all = store.all.bind(store), get = store.get.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  store.get = (sql, ...args) => { seen.push(sql); return get(sql, ...args); };
  unfinishedTaskWorkspaces(store, '101');
  candidate('run-2');
  unfinishedTaskWorkspaces(store, '101');
  store.all = all; store.get = get;
  const plans = [...new Set(seen.filter(sql => /\bFROM task_history\b/.test(sql)))]
    .map(sql => store.all('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join(' | '));
  for (const plan of plans) {
    assert.doesNotMatch(plan, /\bSCAN task_history\b(?! USING)/, plan);
    // Seeking by task_id alone reads each of the task's rows to compare its type.
    assert.doesNotMatch(plan, /SEARCH task_history USING INDEX task_history_run \(task_id=\?\)/, plan);
  }
  for (const expected of [
    /SEARCH task_history USING COVERING INDEX task_history_run \(task_id=\? AND run_id>\?\)/, // the task's runs
    /SEARCH task_history USING INDEX task_history_run_type \(run_id=\? AND type=\?\)/, // their candidates
    /SEARCH task_history USING INDEX task_history_run \(task_id=\? AND run_id=\?\)/, // its rows without a run
    /SEARCH task_history USING INTEGER PRIMARY KEY \(rowid>\?\)/, // the rows added since
  ]) assert.ok(plans.some(plan => expected.test(plan)), `${expected}\n${plans.join('\n')}`);
});

// Production (#1401): the wake facts read the human comments on a bot PR and its Issue with `repository_id=? AND
// object_number IN (…)`. Without statistics SQLite took dispatch_events_repository (repository_id,created_at), whose order
// spares the sort, and so read every event of the repository, about 40 KB each: 317 s a day, up to 24 s a call.
test('bot PR wake facts read the comments on the PR and its Issue through the object index', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  const at = i => new Date(Date.parse('2026-11-24T00:00:00Z') + i * 1000).toISOString();
  const comment = (id, body) => ({ comment: { id, author: 'maria', body, url: null }, trigger: { actor_type: 'User', actor_id: 5 } });
  const event = (id, type, objectType, number, created, facts) => store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,created_at)
     VALUES(?,'r1',?,?,'github',?,?,'',?,'[]','decided',?)`, id, 'r1:' + id, type, objectType, number, JSON.stringify(facts), created);
  store.transaction(() => {
    store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('r1','o/r1','o','a')");
    // Bot PR #2468 was opened for Issue #77.
    store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at) VALUES('dev-77','r1','development.issue','pr_opened','s',77,?,?)", at(0), at(0));
    store.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('r1',2468,'PR_1','99','r1','bot/77',?,'dev-77')", 'a'.repeat(40));
    for (let i = 0; i < 2500; i++) event(`noise-${i}`, i % 2 ? 'issue.updated' : 'pull_request.updated', i % 2 ? 'issue' : 'pr', 1000 + i % 200, at(i + 1), comment(i, 'another discussion'));
    event('on-pr', 'pull_request.updated', 'pr', 2468, at(3000), comment(9001, 'Please also cover the empty list.'));
    event('on-issue', 'issue.mention', 'issue', 77, at(3001), comment(9002, 'The CLI needs the same fix.'));
  });
  const seen = [], all = store.all.bind(store);
  store.all = (sql, ...args) => { seen.push(sql); return all(sql, ...args); };
  const facts = botPrWakeRevisionFacts(store, 'r1', 2468);
  store.all = all;
  assert.deepEqual(facts.new_human_comments.map(c => c.body_excerpt), ['Please also cover the empty list.', 'The CLI needs the same fix.']);
  const [sql] = seen.filter(statement => /FROM dispatch_events\s+WHERE repository_id=\? AND object_type IN/.test(statement));
  assert.ok(sql, seen.join('\n'));
  const plan = all('EXPLAIN QUERY PLAN ' + sql, 'r1', 2468, 77).map(row => row.detail).join(' | ');
  assert.match(plan, /^SEARCH dispatch_events USING INDEX dispatch_events_object \(repository_id=\? AND object_type=\? AND object_number=\?\)/, plan);
  assert.doesNotMatch(plan, /dispatch_events_repository/, plan);
  // The statement this replaced reads the whole repository's events.
  const legacySql = sql.replace(" AND object_type IN ('pr','issue')", '').replace('+created_at', 'created_at');
  const legacyPlan = all('EXPLAIN QUERY PLAN ' + legacySql, 'r1', 2468, 77).map(row => row.detail).join(' | ');
  assert.match(legacyPlan, /dispatch_events_(?:repository|object) \(repository_id=\?\)/, legacyPlan);
});
