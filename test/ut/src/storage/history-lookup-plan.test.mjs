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
import { pruneDispatchThreads, pruneFiltered } from '../../../../dist/dispatch/store.js';
import { botPrWakeRevisionFacts, BOT_PR_WAKE_TASK_ROWS_SQL } from '../../../../dist/review/bot-pr-wake.js';
import { revisionFacts } from '../../../../dist/review/queue.js';
import { roleBoard, roleCapacity } from '../../../../dist/roles/board.js';
import { listBoardPrs, boardPrDetail } from '../../../../dist/board/prs.js';
import { listBoardIssues, boardIssueDetail } from '../../../../dist/board/issues.js';
import { beginRun, endRun, traceEvent } from '../../../../dist/tasks/trace.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
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
  const insert = store.db.prepare(`INSERT INTO deliveries(id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,
    http_status,request_headers,payload,body_complete,response) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
  assert.doesNotMatch(plan, /SEARCH t USING INDEX (?:board_task_(?:object|latest|cover)|tasks_repo_created) \(repository_id=\?\)/, plan);
  assert.doesNotMatch(plan, /dispatch_events_object \(repository_id=\?\)/, plan);
  assert.doesNotMatch(plan, /board_task_object \(repository_id=\?\).*dispatch_events_object \(repository_id=\?\)/, plan);
  // The rows here are enough to reproduce the statement this replaced: it reads the repository's tasks and the
  // repository's events. Both are asserted without an order, and the task index by name loosely, because a SQLite
  // version picks both itself: 3.47.2 (Node 22.13.0/22.14.0) reads the tasks through `board_task_latest`, 3.50.4 and
  // 3.54.1 through `board_task_object` or `tasks_repo_created`, and a version with statistics may use `board_task_cover`.
  // What matters here is that the two full-repository reads are there.
  const legacyPlan = explain(legacySql, legacyArgs);
  assert.match(legacyPlan, /SEARCH t USING INDEX (?:board_task_(?:object|latest|cover)|tasks_repo_created) \(repository_id=\?\)/, legacyPlan);
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

// Hard guard: never add a new index on task_history (13.6M rows in production would scan the whole table and exhaust
// the 512 MB /tmp tmpfs during startup). Framework-level task_continued reads use task_history_run(task_id,run_id,id)
// with run_id IS NULL, while delivery reads combine run_id IS NULL with run_id IN (SELECT id FROM task_runs WHERE task_id=?)
// through task_history_run_type so both active-attempt deliveries (non-null run_id) and runless deliveries are found
// without walking child run history or sorting in a temp B-tree.
test('task_continued and delivery lookups use existing task_history indexes without adding any index on task_history', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  const historyIndexes = store.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_history'").map(r => r.name).sort();
  assert.deepEqual(historyIndexes, ['task_history_run', 'task_history_run_type'], 'no new index on task_history');

  const at = i => new Date(Date.parse('2026-11-24T00:00:00Z') + i * 1000).toISOString();
  store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('r1','o/r1','o','a')");
  store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input,created_at,updated_at) VALUES('t1','r1','task.request','pr_opened','fix',2468,?,?,?)",
    JSON.stringify({ round: 2 }),
    at(0),
    at(50),
  );
  store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,created_at)
     VALUES('wake-1','r1','r1:w1','pull_request.conflicted','github','pr',2468,'','{}','[]','decided',?),
           ('wake-2','r1','r1:w2','pull_request.checks_failed','github','pr',2468,'','{}','[]','decided',?)`,
    at(1),
    at(30),
  );
  store.run("INSERT INTO task_events(task_id,event_id,relation,created_at) VALUES('t1','wake-1','wake',?),('t1','wake-2','wake',?)", at(1), at(30));

  const records = new TaskRecords(store);
  // Round 1 delivery written while attemptRun is running -> trace_history_scope stamps run_id = attemptRun.id (non-null!).
  const run1 = beginRun(store, { id: 't1', repository_id: 'r1', attempt: 1, head_sha: null, workspace_id: null }, 'attempt', {});
  assert.ok(run1?.id);
  for (let i = 0; i < 40; i++) {
    traceEvent(store, 't1', 'tool_observation', { i }, run1.id, 'tool');
  }
  records.history('t1', 'delivery', { summary: 'Round 1 PR opened', pr_url: 'https://github.com/o/r1/pull/2468' });
  const r1Delivery = store.get("SELECT id, run_id FROM task_history WHERE task_id='t1' AND type='delivery' ORDER BY id DESC LIMIT 1");
  assert.equal(r1Delivery.run_id, run1.id, 'delivery written during an active attemptRun keeps non-null run_id');
  endRun(store, run1, 'succeeded');

  // Even if an orphaned running run existed, trace_history_scope must keep task_continued at run_id IS NULL.
  const strayRun = beginRun(store, { id: 't1', repository_id: 'r1', attempt: 2, head_sha: null, workspace_id: null }, 'attempt', {});
  traceEvent(store, 't1', 'task_continued', { round: 2, event_id: 'wake-2' }, null, 'framework');
  const contRow = store.get("SELECT id, run_id FROM task_history WHERE task_id='t1' AND type='task_continued'");
  assert.equal(contRow.run_id, null, 'task_continued stays run_id IS NULL');
  endRun(store, strayRun, 'succeeded');

  // Round 2 delivery written outside any running run -> run_id IS NULL.
  records.history('t1', 'delivery', { summary: 'Round 2 checks fixed', pr_url: 'https://github.com/o/r1/pull/2468' });
  const r2Delivery = store.get("SELECT id, run_id FROM task_history WHERE task_id='t1' AND type='delivery' ORDER BY id DESC LIMIT 1");
  assert.equal(r2Delivery.run_id, null, 'delivery written outside an active run stays run_id IS NULL');

  // bot_pr_requests spanning round 1 and round 2 for revisionFacts + botPrWakeRevisionFacts.
  const contAt = store.get("SELECT created_at FROM task_history WHERE id=?", contRow.id).created_at;
  const beforeCont = new Date(Date.parse(contAt) - 5000).toISOString();
  const afterCont = new Date(Date.parse(contAt) + 5000).toISOString();
  store.run(
    `INSERT INTO bot_pr_requests(repository_id,number,source_type,source_id,author,author_id,author_type,url,state,task_id,created_at)
     VALUES('r1',2468,'comment','101','alice','5','User','u1','done','t1',?),
           ('r1',2468,'comment','102','alice','5','User','u2','done','t1',?)`,
    beforeCont,
    afterCont,
  );

  const seen = [], all = store.all.bind(store);
  store.all = (sql, ...args) => { seen.push({ sql, args }); return all(sql, ...args); };
  const rev = revisionFacts(store, 'r1', 2468, '5');
  const wake = botPrWakeRevisionFacts(store, 'r1', 2468);
  store.all = all;

  assert.equal(rev.for_requests, 2);
  assert.equal(rev.for_this_author, 2);
  assert.equal(wake.for_requests, 2);
  assert.equal(wake.rounds.length, 2);
  assert.equal(wake.rounds[0].summary, 'Round 1 PR opened', 'non-null run_id delivery is found for round 1');
  assert.equal(wake.rounds[1].summary, 'Round 2 checks fixed', 'run_id IS NULL delivery is found for round 2');

  const explain = ({ sql, args }) => all('EXPLAIN QUERY PLAN ' + sql, ...args).map(r => r.detail).join(' | ');
  const historyReads = seen.filter(entry => /\bFROM task_history\b/.test(entry.sql));
  assert.ok(historyReads.length >= 5, `expected revisionFacts + botPrWakeRevisionFacts history reads, got ${historyReads.length}`);
  for (const entry of historyReads) {
    const plan = explain(entry);
    assert.doesNotMatch(plan, /TEMP B-TREE/, `${entry.sql}\n${plan}`);
    assert.doesNotMatch(plan, /SEARCH task_history USING INDEX task_history_run \(task_id=\?\)/, `${entry.sql}\n${plan}`);
    if (/run_id IS NULL/.test(entry.sql)) {
      assert.match(plan, /SEARCH task_history USING INDEX task_history_run \(task_id=\? AND run_id=\?\)/, `${entry.sql}\n${plan}`);
    } else {
      assert.match(plan, /SEARCH task_history USING INDEX task_history_run_type \(run_id=\? AND type=\?\)/, `${entry.sql}\n${plan}`);
      assert.match(plan, /SEARCH task_runs USING COVERING INDEX task_run_task \(task_id=\?\)/, `${entry.sql}\n${plan}`);
    }
  }
});

// Production: GET /api/repositories/:id/role-board took up to 10.98 s because SQLite drove the running-runs join from
// every historical task of the repository. With the partial index task_runs_running (only live rows) and CROSS JOIN,
// both roleBoard and roleCapacity drive from task_runs_running and never sort or scan tasks.
test('roleBoard and roleCapacity drive live task_runs joins from the task_runs_running partial index', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  const at = i => new Date(Date.parse('2026-11-24T00:00:00Z') + i * 1000).toISOString();
  store.transaction(() => {
    store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('r1','o/r1','o','a'),('r2','o/r2','o','a')");
    store.run("INSERT INTO policies(repository_id,role_concurrency) VALUES('r1','{\"dev\":3}'),('r2','{}')");
    const insTask = store.db.prepare("INSERT INTO tasks(id,repository_id,kind,status,summary,input,created_at,updated_at) VALUES(?,?,?,?,?,'{}',?,?)");
    const insRun = store.db.prepare("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role,role_instance_id) VALUES(?,?,'role',1,1,?,?,'{}','{}',?,?)");
    for (let i = 0; i < 600; i++) {
      insTask.run(`hist-${i}`, 'r1', 'task.request', 'completed', 'old', at(i), at(i));
      insRun.run(`run-hist-${i}`, `hist-${i}`, at(i), 'succeeded', 'dev', `inst-${i}`);
    }
    insTask.run('live-1', 'r1', 'task.request', 'running', 'live 1', at(1000), at(1000));
    insTask.run('live-2', 'r1', 'task.request', 'running', 'live 2', at(1001), at(1001));
    insTask.run('live-other', 'r2', 'task.request', 'running', 'other repo', at(1002), at(1002));
    insRun.run('run-live-2', 'live-2', at(1001), 'running', 'dev', 'inst-live-2');
    insRun.run('run-live-1', 'live-1', at(1000), 'running', 'dev', 'inst-live-1');
    insRun.run('run-live-other', 'live-other', at(1002), 'running', 'dev', 'inst-live-other');
  });

  const seen = [], all = store.all.bind(store), get = store.get.bind(store);
  store.all = (sql, ...args) => { seen.push({ sql, args }); return all(sql, ...args); };
  store.get = (sql, ...args) => { seen.push({ sql, args }); return get(sql, ...args); };
  const board = roleBoard(store, 'r1');
  const cap = roleCapacity(store, 'r1', 'dev', 'writer');
  store.all = all; store.get = get;

  const devRole = board.roles.find(r => r.role === 'dev');
  assert.deepEqual(devRole.running.map(r => r.run_id), ['run-live-1', 'run-live-2'], 'ordered by started_at, id');
  assert.deepEqual(cap, { limit: 3, running: 2 });

  const joinQueries = seen.filter(entry => /FROM task_runs r\b/.test(entry.sql));
  assert.equal(joinQueries.length, 2, joinQueries.map(q => q.sql).join('\n'));
  for (const entry of joinQueries) {
    const plan = all('EXPLAIN QUERY PLAN ' + entry.sql, ...entry.args).map(r => r.detail).join(' | ');
    assert.match(plan, /^(?:SCAN|SEARCH) r USING INDEX task_runs_running/, `${entry.sql}\n${plan}`);
    assert.match(plan, /SEARCH t USING INDEX sqlite_autoindex_tasks_1 \(id=\?\)/, `${entry.sql}\n${plan}`);
    assert.doesNotMatch(plan, /TEMP B-TREE/, `${entry.sql}\n${plan}`);
  }
});

// Production: hourly pruneFiltered scanned dispatch_events (~3.7 s), and GET /api/board/prs & /api/board/issues loaded
// every historical closed PR/Issue context row across the whole repository (3.1-7.8 s).
test('pruneFiltered uses its partial index and board context maps narrow queries to displayed object numbers across chunks', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  const nowMs = Date.parse('2026-11-28T00:00:00Z');
  const oldIso = new Date(nowMs - 40 * 86400_000).toISOString();
  const recentIso = new Date(nowMs - 2 * 86400_000).toISOString();

  store.transaction(() => {
    store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('r1','o/r1','o','a')");
    store.run("INSERT INTO policies(repository_id) VALUES('r1')");

    const insEvent = store.db.prepare(
      `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,decision,reason,created_at,decided_at)
       VALUES(?,'r1',?,?,'github',?,?,'','{}','[]',?,?,?,?,?)`,
    );
    for (let i = 0; i < 300; i++) {
      insEvent.run(`dec-${i}`, `dec-${i}`, 'pull_request.opened', 'pr', 1000 + i, 'decided', 'ignore', 'old', oldIso, oldIso);
    }
    for (let i = 0; i < 10; i++) {
      insEvent.run(`filt-old-${i}`, `filt-old-${i}`, 'pull_request.opened', 'pr', 2000 + i, 'filtered', 'ignore', 'old filtered', oldIso, oldIso);
      insEvent.run(`filt-new-${i}`, `filt-new-${i}`, 'pull_request.opened', 'pr', 2100 + i, 'filtered', 'ignore', 'new filtered', recentIso, recentIso);
    }

    // Closed historical PRs and Issues (should NOT be scanned when listing open objects) + open objects + >500 closed
    // objects to exercise multi-chunk IN batching when include_closed=1.
    const insObj = store.db.prepare(
      'INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,last_seen) VALUES(?,?,?,?,?,?,?)',
    );
    const insTask = store.db.prepare(
      "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,result,created_at,updated_at) VALUES(?,'r1',?,?,?,?,?,?,?,?)",
    );
    for (let n = 1; n <= 520; n++) {
      const state = n <= 3 ? 'open' : 'closed';
      insObj.run('r1', 'pr', n, `PR #${n}`, state, 0, recentIso);
      insObj.run('r1', 'issue', n, `Issue #${n}`, state, null, recentIso);
    }
    // Open Issue #1 -> development task -> bot PR #1 with checks + review task + dispatch events + progress.
    const sha1 = '1'.repeat(40);
    const sha2 = '2'.repeat(40);
    insTask.run('dev-issue-1', 'development.issue', 'pr_opened', 'dev 1', 1, sha1, JSON.stringify({ pr_number: 1, pr_url: 'https://github.com/o/r1/pull/1' }), recentIso, recentIso);
    insTask.run('rev-pr-1', 'review.pr', 'succeeded', 'rev pr 1', 1, sha1, JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'LGTM' }), recentIso, recentIso);
    insTask.run('rev-pr-2', 'review.pr', 'succeeded', 'rev pr 2', 2, sha2, JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Looks fine' }), recentIso, recentIso);
    insTask.run('rev-pr-515', 'review.pr', 'succeeded', 'rev closed 515', 515, sha2, JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Chunk 2 PR' }), recentIso, recentIso);
    insTask.run('dev-issue-515', 'development.issue', 'pr_opened', 'dev closed 515', 515, sha2, JSON.stringify({ pr_number: 515 }), recentIso, recentIso);
    store.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('r1',1,'PR_1','9','r1','bot/1',?,'dev-issue-1',2)", sha1);
    store.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('r1',515,'PR_515','9','r1','bot/515',?,'dev-issue-515',1)", sha2);
    store.run("INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,updated_at) VALUES('r1',?,'ci','CI','completed','success',?),('r1',?,'ci','CI','completed','failure',?)", sha1, recentIso, sha2, recentIso);
    insEvent.run('ev-pr-1', 'ev-pr-1', 'review.published', 'pr', 1, 'decided', 'ignore', 'reviewed', recentIso, recentIso);
    insEvent.run('ev-issue-1', 'ev-issue-1', 'issue.opened', 'issue', 1, 'decided', 'create', 'started', recentIso, recentIso);
    store.run("INSERT INTO issue_development_progress(task_id,repository_id,number,language,milestones,final,next_at,created_at,updated_at) VALUES('dev-issue-1','r1',1,'en',?,0,0,?,?)", JSON.stringify({ plan: { conclusion: 'plan ok' } }), recentIso, recentIso);
  });

  // 1. pruneFiltered partial index plan + behavior
  const pruneSeen = [], run = store.run.bind(store);
  store.run = (sql, ...args) => { pruneSeen.push({ sql, args }); return run(sql, ...args); };
  const pruned = pruneFiltered(store, nowMs);
  store.run = run;
  assert.equal(pruned, 10, 'pruned only expired filtered events');
  assert.equal(store.get("SELECT count(*) n FROM dispatch_events WHERE state='filtered'").n, 10);
  const prunePlan = store.all('EXPLAIN QUERY PLAN ' + pruneSeen[0].sql, ...pruneSeen[0].args).map(r => r.detail).join(' | ');
  assert.match(prunePlan, /SEARCH dispatch_events USING INDEX dispatch_events_filtered_created \(state=\? AND created_at<\?\)/, prunePlan);
  assert.doesNotMatch(prunePlan, /\bSCAN dispatch_events\b/, prunePlan);

  // 2. Open PR & Issue board list + detail queries narrow by object_number
  const admin = { id: 'admin', role: 'super_admin' };
  const seen = [], all = store.all.bind(store);
  store.all = (sql, ...args) => { seen.push({ sql, args }); return all(sql, ...args); };
  const openPrs = listBoardPrs(store, admin, new URL('http://local/api/board/prs?repository_id=r1&limit=20'));
  const prDetail = boardPrDetail(store, admin, 'r1', 1);
  const openIssues = listBoardIssues(store, admin, new URL('http://local/api/board/issues?repository_id=r1&limit=20'));
  const issueDetail = boardIssueDetail(store, admin, 'r1', 1);
  // Multi-chunk include_closed=1 (>500 objects) exercises batching and verifies chunk-2 data (PR/Issue #515).
  const allPrs = listBoardPrs(store, admin, new URL('http://local/api/board/prs?repository_id=r1&include_closed=1&q=515'));
  const allClosedPrs = listBoardPrs(store, admin, new URL('http://local/api/board/prs?repository_id=r1&include_closed=1&limit=100'));
  const allClosedIssues = listBoardIssues(store, admin, new URL('http://local/api/board/issues?repository_id=r1&include_closed=1&limit=100'));
  store.all = all;

  assert.equal(openPrs.total, 3);
  const openPr1 = openPrs.prs.find(p => p.number === 1);
  assert.equal(openPr1.is_bot_pr, true);
  assert.equal(openPr1.bot_pr.source_issue_number, 1);
  assert.equal(openPr1.checks.passed, 1);
  assert.equal(openPr1.review.recommendation, 'LGTM');
  assert.equal(openPrs.prs.find(p => p.number === 2).checks.failed, 1);
  assert.equal(prDetail.pr.number, 1);
  assert.equal(prDetail.pr.checks.passed, 1);

  assert.equal(openIssues.total, 3);
  const openIssue1 = openIssues.issues.find(i => i.number === 1);
  assert.equal(openIssue1.pr.number, 1);
  assert.equal(openIssue1.pr.checks.passed, 1);
  assert.equal(issueDetail.issue.pr.number, 1);

  assert.equal(allPrs.prs[0].review.recommendation, 'Chunk 2 PR');
  assert.equal(allClosedPrs.total, 520, 'multi-chunk include_closed PR list returns all 520 objects');
  assert.equal(allClosedIssues.total, 520, 'multi-chunk include_closed Issue list returns all 520 objects');

  const explain = ({ sql, args }) => all('EXPLAIN QUERY PLAN ' + sql, ...args).map(r => r.detail).join(' | ');
  const contextQueries = seen.filter(entry =>
    /FROM (?:board_pr_tasks|board_issue_tasks|bot_pull_requests|commit_checks)\b/.test(entry.sql)
    || (/FROM dispatch_events\b/.test(entry.sql) && /row_number\(\)/.test(entry.sql)),
  );
  assert.ok(contextQueries.length >= 12, `expected narrowed context queries, got ${contextQueries.length}`);
  for (const entry of contextQueries) {
    const plan = explain(entry);
    assert.doesNotMatch(plan, /\bSCAN (?:board_pr_tasks|board_issue_tasks|bot_pull_requests|commit_checks|dispatch_events|t|p)\b/, `${entry.sql}\n${plan}`);
    if (/FROM board_pr_tasks t\b/.test(entry.sql)) {
      assert.match(plan, /SEARCH t USING INDEX board_pr_tasks_repo_num \(repository_id=\? AND object_number=\?\)/, `${entry.sql}\n${plan}`);
    } else if (/FROM board_issue_tasks t\b/.test(entry.sql) && /CROSS JOIN bot_pull_requests p/.test(entry.sql)) {
      assert.match(plan, /SEARCH t USING INDEX board_issue_tasks_repo_num \(repository_id=\? AND object_number=\? AND role_kind=\?\)/, `${entry.sql}\n${plan}`);
      assert.match(plan, /SEARCH p USING INDEX bot_pull_requests_source_task \(source_task_id=\?\)/, `${entry.sql}\n${plan}`);
    } else if (/FROM board_issue_tasks t\b/.test(entry.sql)) {
      assert.match(plan, /SEARCH t USING INDEX board_issue_tasks_repo_num \(repository_id=\? AND object_number=\?\)/, `${entry.sql}\n${plan}`);
    } else if (/FROM bot_pull_requests p\b/.test(entry.sql)) {
      assert.match(plan, /SEARCH p USING INDEX sqlite_autoindex_bot_pull_requests_1 \(repository_id=\? AND number=\?\)/, `${entry.sql}\n${plan}`);
    } else if (/FROM commit_checks\b/.test(entry.sql)) {
      assert.match(plan, /SEARCH commit_checks USING INDEX sqlite_autoindex_commit_checks_1 \(repository_id=\? AND head_sha=\?\)/, `${entry.sql}\n${plan}`);
    } else if (/FROM dispatch_events\b/.test(entry.sql)) {
      assert.match(plan, /SEARCH dispatch_events USING INDEX dispatch_events_object \(repository_id=\? AND object_type=\? AND object_number=\?\)/, `${entry.sql}\n${plan}`);
    }
  }
});

// Production: GET /api/environments/:id sorted a repository's tasks with TEMP B-TREE FOR ORDER BY (2.28 s).
test('repository task history pages read tasks_repo_created in order without a temp B-tree', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('repo','o/r','o','a')");
  store.run("INSERT INTO policies(repository_id) VALUES('repo')");
  for (let i = 0; i < 30; i++) {
    const ts = new Date(Date.parse('2026-11-24T00:00:00Z') + i * 1000).toISOString();
    store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,created_at,updated_at) VALUES(?,'repo','review.pr','succeeded','s',?,?)", `t-${i}`, ts, ts);
  }
  const seen = [], all = store.all.bind(store);
  store.all = (sql, ...args) => { seen.push({ sql, args }); return all(sql, ...args); };
  await new ProjectService(store, { call: async () => null }).detail('repo');
  queries(store, { id: 'admin', role: 'super_admin' }, new URL('http://local/api/tasks?repository_id=repo&limit=20'));
  store.all = all;

  const taskPages = seen.filter(entry => /FROM tasks WHERE (?:1=1 AND )?repository_id=\?/.test(entry.sql) && /ORDER BY created_at DESC,\s*id DESC LIMIT/.test(entry.sql));
  assert.equal(taskPages.length, 2, taskPages.map(e => e.sql).join('\n'));
  for (const entry of taskPages) {
    const plan = all('EXPLAIN QUERY PLAN ' + entry.sql, ...entry.args).map(r => r.detail).join(' | ');
    assert.match(plan, /SEARCH tasks USING INDEX tasks_repo_created \(repository_id=\?\)/, `${entry.sql}\n${plan}`);
    assert.doesNotMatch(plan, /TEMP B-TREE/, `${entry.sql}\n${plan}`);
  }
});
