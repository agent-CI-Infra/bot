import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { StallMonitor } from '../dist/core/stalls.js';
import { Store, sqlFingerprint } from '../dist/storage/database.js';
import { PayloadMigration } from '../dist/storage/migration.js';

test('a blocked event loop is logged with the requests in flight, and a slow request with its path only', async t => {
  const lines = [], monitor = new StallMonitor({ stallMs: 500, slowMs: 1000, log: line => lines.push(line) });
  monitor.start(100); t.after(() => monitor.stop());
  const done = monitor.request('GET', '/api/tasks/abc/logs?token=secret-value');
  // Synchronous work, like a heavy query: nothing else runs until it returns.
  for (const end = Date.now() + 1200; Date.now() < end;);
  await new Promise(resolve => setTimeout(resolve, 300));
  done(); done();
  const stall = lines.find(line => line.startsWith('[stall]'));
  assert.ok(stall, lines.join('\n'));
  assert.match(stall, /event loop blocked ~1\.\d s; requests finished while blocked: none; requests in flight: GET \/api\/tasks\/abc\/logs \(1\.\d s\)/);
  assert.deepEqual(lines.filter(line => line.startsWith('[slow]')).length, 1, 'a request is reported once');
  assert.match(lines.find(line => line.startsWith('[slow]')), /^\[slow\] GET \/api\/tasks\/abc\/logs \d+ ms$/);
  assert.ok(!lines.join('\n').includes('secret-value'), 'query strings are never logged');
});

test('a block with no request in flight says so, and ordinary timer jitter is not reported', async t => {
  const lines = [], monitor = new StallMonitor({ stallMs: 500, log: line => lines.push(line) });
  monitor.start(100); t.after(() => monitor.stop());
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(lines, []);
  for (const end = Date.now() + 800; Date.now() < end;);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(lines.join('\n'), /requests in flight: none$/m);
});

test('a request whose own handler blocked the loop is named as finished while blocked', async t => {
  // Production: GET /api/events held the thread 104 s and finished just before the timer ran, so the stall line showed
  // only the requests that were waiting behind it.
  const lines = [], monitor = new StallMonitor({ stallMs: 500, log: line => lines.push(line) });
  monitor.start(100); t.after(() => monitor.stop());
  await new Promise(resolve => setTimeout(resolve, 150));
  const done = monitor.request('GET', '/api/events?limit=50');
  for (const end = Date.now() + 900; Date.now() < end;);
  done();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(lines.join('\n'), /requests finished while blocked: GET \/api\/events \(0\.9 s\); requests in flight: none/);
});

test('sqlFingerprint normalizes literals, comments and placeholder lists without leaking parameter or literal values', () => {
  const raw = `SELECT /* 'secret-in-comment' */ id, status
    FROM tasks -- sk-secret-line-comment
    WHERE summary = 'it''s -- secret-literal' AND unique_key = "quoted-secret"
      AND payload = X'deadbeef' AND attempt > 42 AND id IN (?, ?, ?, ?, ?)`;
  const fingerprint = sqlFingerprint(raw);
  assert.equal(fingerprint, 'SELECT id, status FROM tasks WHERE summary = ? AND unique_key = ? AND payload = ? AND attempt > ? AND id IN (?,?...)');
  for (const leaked of ['secret-in-comment', 'sk-secret-line-comment', 'secret-literal', 'quoted-secret', 'deadbeef', '42']) {
    assert.ok(!fingerprint.includes(leaked), `${leaked} leaked in ${fingerprint}`);
  }
});

test('Store logs slow SQL statements, slow commits and multi-statement transactions without parameter values', t => {
  let clock = 0, step = 0;
  const lines = [];
  const store = new Store(':memory:', randomBytes(32), {
    slowSqlMs: 100,
    now: () => { const value = clock; clock += step; return value; },
    log: line => lines.push(line),
  });
  t.after(() => store.close());
  assert.deepEqual(lines, [], 'fast schema bootstrap is quiet');

  // 1. Single slow statement: logs fingerprint, never bound parameters or inline literals.
  step = 140;
  store.get("SELECT value FROM settings WHERE key=? AND value<>'inline-secret-token'", 'bound-secret-key');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '[slow-sql] 140 ms get SELECT value FROM settings WHERE key=? AND value<>?');
  assert.ok(!lines[0].includes('bound-secret-key') && !lines[0].includes('inline-secret-token'));

  // 2. Transaction with one slow child statement: logs only the offending statement, not a duplicate transaction summary.
  // Sequence: txStarted, after BEGIN, get start, get end (155 ms), commit start, commit end (10 ms), total end.
  const seq = [1000, 1005, 1005, 1160, 1165, 1175, 1175];
  let p = 0;
  const store2 = new Store(':memory:', randomBytes(32), {
    slowSqlMs: 100,
    now: () => (p < seq.length ? seq[p++] : 0),
    log: line => lines.push(line),
  });
  t.after(() => store2.close());
  lines.length = 0; p = 0;
  store2.transaction(() => {
    store2.get('SELECT value FROM settings WHERE key=?', 'secret-arg');
  });
  assert.deepEqual(lines, ['[slow-sql] 155 ms get SELECT value FROM settings WHERE key=?']);

  // 3. Transaction where individual statements are fast (40 ms each) and COMMIT is fast (20 ms), but total reaches 110 ms.
  lines.length = 0; p = 0;
  const multi = [2000, 2005, 2005, 2045, 2045, 2085, 2090, 2110, 2110];
  const store3 = new Store(':memory:', randomBytes(32), {
    slowSqlMs: 100,
    now: () => (p < multi.length ? multi[p++] : 0),
    log: line => lines.push(line),
  });
  t.after(() => store3.close());
  lines.length = 0; p = 0;
  store3.transaction(() => {
    store3.run('INSERT INTO settings VALUES(?,?)', 'k1', 'secret-1');
    store3.run('INSERT INTO settings VALUES(?,?)', 'k2', 'secret-2');
  });
  assert.deepEqual(lines, ['[slow-sql] 110 ms transaction (2 statements, commit 20 ms)']);

  // 4. Transaction where COMMIT fsync itself takes >= 100 ms.
  lines.length = 0; p = 0;
  const slowCommit = [3000, 3002, 3002, 3010, 3010, 3145, 3145];
  const store4 = new Store(':memory:', randomBytes(32), {
    slowSqlMs: 100,
    now: () => (p < slowCommit.length ? slowCommit[p++] : 0),
    log: line => lines.push(line),
  });
  t.after(() => store4.close());
  lines.length = 0; p = 0;
  store4.transaction(() => {
    store4.run('INSERT INTO settings VALUES(?,?)', 'k3', 'secret-3');
  });
  assert.deepEqual(lines, ['[slow-sql] 135 ms commit COMMIT']);
});

test('PayloadMigration logs slow synchronous read, verify and apply slice steps', async t => {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run("INSERT INTO repositories VALUES('101','fixture/project','10','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t0','101','task.request','running','Fixture','{}',1,1,'w')");
  store.run("INSERT INTO task_tools(id,task_id,request,result,state) VALUES('op0','t0',?,?,'completed')",
    JSON.stringify({ operation_id: 'op0', request: { type: 'workspace_read', path: 'secret-path.txt' } }),
    JSON.stringify({ content: 'x'.repeat(3000) }));

  let now = 0;
  const lines = [];
  const migration = new PayloadMigration(store, {
    readMs: 0,
    pauseMs: 1,
    idleMs: 60_000,
    slowSliceMs: 200,
    now: () => (now += 250),
    log: line => lines.push(line),
  });
  migration.start();
  for (let i = 0; i < 200 && !lines.some(line => line.includes('task_tools apply')); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await migration.stop();
  const taskToolLines = lines.filter(line => line.startsWith('[slow-migration] task_tools '));
  assert.ok(taskToolLines.some(line => /^\[slow-migration\] task_tools read \d+ ms \(1 rows\)$/.test(line)), taskToolLines.join('\n'));
  assert.ok(taskToolLines.some(line => /^\[slow-migration\] task_tools verify \d+ ms \(1 rows\)$/.test(line)), taskToolLines.join('\n'));
  assert.ok(taskToolLines.some(line => /^\[slow-migration\] task_tools apply \d+ ms \(1 rows\)$/.test(line)), taskToolLines.join('\n'));
  assert.ok(!lines.join('\n').includes('secret-path.txt'));
});
