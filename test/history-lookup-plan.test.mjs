import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../dist/storage/database.js';
import { latestRoleCandidate } from '../dist/roles/schedule.js';
import { runEvents, scopeUsage, toolReceipts } from '../dist/roles/role-run.js';
import { queries } from '../dist/app/queries.js';
import { pruneRejectedArchive, rejectedArchiveState, rejectedAudit } from '../dist/app/delivery-audit.js';

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
