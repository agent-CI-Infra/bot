import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../dist/storage/database.js';
import { botPrWakeRevisionFacts, BOT_PR_WAKE_TASK_ROWS_SQL } from '../../../../dist/review/bot-pr-wake.js';

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
