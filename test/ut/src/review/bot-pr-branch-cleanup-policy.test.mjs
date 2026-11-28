// Unit tests for #1424 Bot PR remote temporary branch cleanup policy, schema migration,
// index usage, state-machine transitions, ref encoding, and active-task / open-PR guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import {
  BOT_PR_CLOSED_BRANCH_RETENTION_MS,
  computeBotPrBranchCleanupPlan,
  encodeGitRefPath,
  ensureBotPrBranchCleanupColumns,
  findActiveTasksBoundToBranch,
  hasOtherOpenLocalBotPrOnBranch,
} from '../../../../dist/review/bot-pr-branch-cleanup.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-pr-branch-cleanup-ut-'));
  const dbPath = join(dir, 'control.sqlite');
  const store = new Store(dbPath, randomBytes(32));
  t.after(() => {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dbPath };
}

test('ensureBotPrBranchCleanupColumns migrates legacy bot_pr_states idempotently and partial index serves due query', t => {
  const { store } = tempStore(t);

  // Recreate a legacy pre-#1424 bot_pr_states table without the new branch-cleanup columns.
  store.db.exec(`
    DROP TABLE IF EXISTS bot_pr_states;
    CREATE TABLE bot_pr_states(
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      draft INTEGER NOT NULL DEFAULT 0,
      base_ref TEXT,
      base_sha TEXT,
      head_sha TEXT,
      mergeable INTEGER,
      mergeable_state TEXT,
      title TEXT,
      html_url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, number)
    );
  `);
  store.run(
    "INSERT INTO bot_pr_states VALUES('101',10,'closed',0,'main',?,?,0,'clean','Legacy closed PR',NULL,'2026-10-01T00:00:00.000Z')",
    'a'.repeat(40),
    'b'.repeat(40),
  );

  // A fresh Store instance is not in the module's migrated WeakSet if we open a second Store handle on the same DB.
  const dir = mkdtempSync(join(tmpdir(), 'bot-pr-branch-cleanup-mig-'));
  const dbPath = join(dir, 'legacy.sqlite');
  const key = randomBytes(32);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = new Store(dbPath, key);
  first.db.exec(`
    DROP TABLE bot_pr_states;
    CREATE TABLE bot_pr_states(
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      draft INTEGER NOT NULL DEFAULT 0,
      base_ref TEXT,
      base_sha TEXT,
      head_sha TEXT,
      mergeable INTEGER,
      mergeable_state TEXT,
      title TEXT,
      html_url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, number)
    );
  `);
  first.run(
    "INSERT INTO bot_pr_states VALUES('101',10,'closed',0,'main',?,?,0,'clean','Legacy closed PR',NULL,'2026-10-01T00:00:00.000Z')",
    'a'.repeat(40),
    'b'.repeat(40),
  );
  first.close();

  // Reopening runs botPrWakeStorage -> ensureBotPrBranchCleanupColumns.
  const reopened = new Store(dbPath, key);
  t.after(() => { try { reopened.close(); } catch {} });
  ensureBotPrBranchCleanupColumns(reopened);

  const cols = new Set(reopened.all('PRAGMA table_info(bot_pr_states)').map(c => String(c.name)));
  for (const col of [
    'merged',
    'closed_at',
    'branch_delete_due_at',
    'branch_cleanup_status',
    'branch_cleanup_reason',
    'branch_cleanup_at',
    'branch_cleanup_attempts',
  ]) {
    assert.ok(cols.has(col), `missing migrated column: ${col}`);
  }

  // Legacy closed row stays unscheduled at migration time (`branch_cleanup_status = NULL`) so DB open never mass-writes;
  // bounded legacy backfill incrementally live-verifies and schedules these rows using the partial index below.
  const legacyRow = reopened.get("SELECT merged,closed_at,branch_delete_due_at,branch_cleanup_status,branch_cleanup_attempts FROM bot_pr_states WHERE repository_id='101' AND number=10");
  assert.deepEqual({ ...legacyRow }, {
    merged: 0,
    closed_at: null,
    branch_delete_due_at: null,
    branch_cleanup_status: null,
    branch_cleanup_attempts: 0,
  });

  // Verify the due-cleanup query uses the partial covering index rather than a full table scan.
  const plan = reopened.all(
    `EXPLAIN QUERY PLAN
     SELECT s.repository_id, s.number
     FROM bot_pr_states s
     JOIN bot_pull_requests b ON b.repository_id=s.repository_id AND b.number=s.number
     JOIN repositories r ON r.id=s.repository_id
     WHERE s.branch_cleanup_status='pending'
       AND s.branch_delete_due_at IS NOT NULL
       AND s.branch_delete_due_at <= ?
     ORDER BY s.branch_delete_due_at ASC, s.number ASC`,
    Date.now(),
  );
  assert.ok(
    plan.some(row => String(row.detail || '').includes('bot_pr_states_branch_cleanup_due')),
    `expected partial index in query plan, got: ${JSON.stringify(plan)}`,
  );

  // Verify BOTH legacy-closed backfill queries use the dedicated partial index rather than scanning all closed rows.
  const legacyRepoPlan = reopened.all(
    `EXPLAIN QUERY PLAN
     SELECT DISTINCT s.repository_id
     FROM bot_pr_states s
     CROSS JOIN bot_pull_requests b ON b.repository_id=s.repository_id AND b.number=s.number
     JOIN policies p ON p.repository_id=s.repository_id
     WHERE p.enabled=1
       AND lower(s.state)='closed'
       AND s.branch_cleanup_status IS NULL
     ORDER BY s.repository_id ASC`,
  );
  assert.ok(
    legacyRepoPlan.some(row => String(row.detail || '').includes('bot_pr_states_branch_cleanup_legacy_closed')),
    `expected legacy partial index in repo discovery query plan, got: ${JSON.stringify(legacyRepoPlan)}`,
  );

  const legacyPlan = reopened.all(
    `EXPLAIN QUERY PLAN
     SELECT b.*, s.base_ref AS saved_base_ref
     FROM bot_pr_states s
     CROSS JOIN bot_pull_requests b ON b.repository_id=s.repository_id AND b.number=s.number
     WHERE s.repository_id=?
       AND lower(s.state)='closed'
       AND s.branch_cleanup_status IS NULL
     ORDER BY s.number ASC
     LIMIT 10`,
    '101',
  );
  assert.ok(
    legacyPlan.some(row => String(row.detail || '').includes('bot_pr_states_branch_cleanup_legacy_closed')),
    `expected legacy partial index in query plan, got: ${JSON.stringify(legacyPlan)}`,
  );
});

test('computeBotPrBranchCleanupPlan handles merged immediate, unmerged 48h retention, reopen cancel, idempotency, and re-close', () => {
  assert.equal(BOT_PR_CLOSED_BRANCH_RETENTION_MS, 2 * DAY);

  const t0 = Date.parse('2026-11-28T00:00:00.000Z');
  const t0Iso = new Date(t0).toISOString();

  // 1. Merged PR schedules immediate deletion.
  const mergedPlan = computeBotPrBranchCleanupPlan(
    { state: 'open', merged: 0, branch_cleanup_status: null },
    'closed',
    { state: 'closed', merged: true, merged_at: '2026-11-27T23:59:50.000Z', closed_at: '2026-11-27T23:59:50.000Z' },
    t0Iso,
    t0,
  );
  assert.deepEqual(mergedPlan, {
    merged: 1,
    closedAt: '2026-11-27T23:59:50.000Z',
    branchDeleteDueAt: t0,
    branchCleanupStatus: 'pending',
    branchCleanupReason: 'merged',
    branchCleanupAt: null,
    branchCleanupAttempts: 0,
    cancelledPending: false,
  });

  // 2. Unmerged closed PR schedules deletion at closed_at + 48h.
  const closedAt = '2026-11-27T12:00:00.000Z';
  const unmergedPlan = computeBotPrBranchCleanupPlan(
    { state: 'open', merged: 0, branch_cleanup_status: null },
    'closed',
    { state: 'closed', merged: false, closed_at: closedAt },
    t0Iso,
    t0,
  );
  assert.deepEqual(unmergedPlan, {
    merged: 0,
    closedAt,
    branchDeleteDueAt: Date.parse(closedAt) + 48 * HOUR,
    branchCleanupStatus: 'pending',
    branchCleanupReason: 'closed_retention_wait',
    branchCleanupAt: null,
    branchCleanupAttempts: 0,
    cancelledPending: false,
  });

  // 3. Reopening a pending closed PR clears schedule and flags cancelledPending.
  const reopenedPlan = computeBotPrBranchCleanupPlan(
    {
      state: 'closed',
      merged: 0,
      closed_at: closedAt,
      branch_delete_due_at: Date.parse(closedAt) + 48 * HOUR,
      branch_cleanup_status: 'pending',
      branch_cleanup_reason: 'closed_retention_wait',
      branch_cleanup_attempts: 2,
    },
    'open',
    { state: 'open' },
    new Date(t0 + HOUR).toISOString(),
    t0 + HOUR,
  );
  assert.deepEqual(reopenedPlan, {
    merged: 0,
    closedAt: null,
    branchDeleteDueAt: null,
    branchCleanupStatus: null,
    branchCleanupReason: null,
    branchCleanupAt: null,
    branchCleanupAttempts: 0,
    cancelledPending: true,
  });

  // 4. Duplicate sync on a pending PR with active backoff preserves retry schedule & attempt counter.
  const backoffDue = t0 + 15 * 60_000;
  const dupBackoff = computeBotPrBranchCleanupPlan(
    {
      state: 'closed',
      merged: 1,
      closed_at: t0Iso,
      branch_delete_due_at: backoffDue,
      branch_cleanup_status: 'pending',
      branch_cleanup_reason: 'github_unavailable',
      branch_cleanup_at: t0Iso,
      branch_cleanup_attempts: 3,
    },
    'closed',
    { state: 'closed', merged: true, closed_at: t0Iso },
    new Date(t0 + 1000).toISOString(),
    t0 + 1000,
  );
  assert.equal(dupBackoff.branchDeleteDueAt, backoffDue);
  assert.equal(dupBackoff.branchCleanupAttempts, 3);
  assert.equal(dupBackoff.branchCleanupReason, 'github_unavailable');

  // 5. Duplicate sync on an already-terminal cleanup state never resets back to pending.
  for (const terminal of ['deleted', 'already_deleted', 'skipped', 'blocked']) {
    const keepTerminal = computeBotPrBranchCleanupPlan(
      {
        state: 'closed',
        merged: 1,
        closed_at: t0Iso,
        branch_delete_due_at: null,
        branch_cleanup_status: terminal,
        branch_cleanup_reason: 'done_reason',
        branch_cleanup_at: t0Iso,
        branch_cleanup_attempts: 0,
      },
      'closed',
      { state: 'closed', merged: true, closed_at: t0Iso },
      new Date(t0 + HOUR).toISOString(),
      t0 + HOUR,
    );
    assert.equal(keepTerminal.branchCleanupStatus, terminal);
    assert.equal(keepTerminal.branchDeleteDueAt, null);
    assert.equal(keepTerminal.branchCleanupReason, 'done_reason');
  }

  // 6. Partial closed payload without `merged` preserves previously known `merged=1`.
  const partialMerged = computeBotPrBranchCleanupPlan(
    {
      state: 'closed',
      merged: 1,
      closed_at: t0Iso,
      branch_delete_due_at: t0,
      branch_cleanup_status: 'pending',
      branch_cleanup_reason: 'merged',
      branch_cleanup_attempts: 0,
    },
    'closed',
    { state: 'closed' },
    new Date(t0 + 5000).toISOString(),
    t0 + 5000,
  );
  assert.equal(partialMerged.merged, 1);

  // 7. Re-closed PR with a strictly newer closed_at (e.g. missed reopen webhook) starts a fresh 48h window.
  const t2 = t0 + 5 * DAY;
  const t2Iso = new Date(t2).toISOString();
  const reclosed = computeBotPrBranchCleanupPlan(
    {
      state: 'closed',
      merged: 0,
      closed_at: closedAt,
      branch_delete_due_at: null,
      branch_cleanup_status: 'skipped',
      branch_cleanup_reason: 'head_sha_changed',
      branch_cleanup_at: t0Iso,
      branch_cleanup_attempts: 0,
    },
    'closed',
    { state: 'closed', merged: false, closed_at: t2Iso },
    t2Iso,
    t2,
  );
  assert.equal(reclosed.branchCleanupStatus, 'pending');
  assert.equal(reclosed.closedAt, t2Iso);
  assert.equal(reclosed.branchDeleteDueAt, t2 + 48 * HOUR);
});

test('encodeGitRefPath preserves slash separators while percent-encoding segment characters', () => {
  assert.equal(encodeGitRefPath('bot/issue-42'), 'bot/issue-42');
  assert.equal(encodeGitRefPath('bot/issue-42/fix-1'), 'bot/issue-42/fix-1');
  assert.equal(encodeGitRefPath('bot/issue#42/a b'), 'bot/issue%2342/a%20b');
});

test('findActiveTasksBoundToBranch and hasOtherOpenLocalBotPrOnBranch isolate active bindings from terminal records', t => {
  const { store } = tempStore(t);
  const now = '2026-11-28T00:00:00.000Z';
  store.run("INSERT INTO accounts(id,name,type,credentials,created_at) VALUES('acc','A','bot_account','{}',?)", now);
  store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('101','fixture/r','10','acc')");
  store.run("INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('202','fixture/other','10','acc')");

  const owned = { repository_id: '101', number: 88, branch: 'bot/issue-42', source_task_id: 't-src' };

  const addTask = (id, repo, kind, status, objectNumber, input) => {
    store.run(
      "INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,input,created_at,updated_at) VALUES(?,?,?,?,?,'" + (objectNumber ?? '') + "',?,?,?)",
      id,
      repo,
      kind,
      status,
      id,
      typeof input === 'string' ? input : JSON.stringify(input ?? {}),
      now,
      now,
    );
    if (objectNumber == null) store.run('UPDATE tasks SET object_number=NULL WHERE id=?', id);
    else store.run('UPDATE tasks SET object_number=? WHERE id=?', objectNumber, id);
  };

  // Terminal tasks + corrupt JSON task + other-repo active task must NOT block cleanup.
  addTask('t-src', '101', 'task.request', 'pr_opened', 42, { target: { type: 'issue', number: 42 } });
  addTask('t-done', '101', 'task.request', 'completed', 88, { target: { type: 'pr', number: 88 } });
  addTask('t-failed', '101', 'task.request', 'failed', 88, { branch: 'bot/issue-42' });
  addTask('t-cancelled', '101', 'development.pr', 'cancelled', 88, { branch: 'bot/issue-42' });
  addTask('t-corrupt', '101', 'task.request', 'running', null, '{bad-json');
  addTask('t-other-repo', '202', 'task.request', 'running', 88, { branch: 'bot/issue-42' });
  assert.deepEqual(findActiveTasksBoundToBranch(store, '101', 88, 'bot/issue-42', owned), []);

  // Each active binding mechanism independently blocks cleanup.
  addTask('t-branch-input', '101', 'task.request', 'queued', null, { target: { type: 'branch', ref: 'bot/issue-42' } });
  assert.deepEqual(findActiveTasksBoundToBranch(store, '101', 88, 'bot/issue-42', owned).map(r => r.id), ['t-branch-input']);
  store.run("UPDATE tasks SET status='completed' WHERE id='t-branch-input'");

  addTask('t-bot-branch-owner', '101', 'task.request', 'waiting_environment', null, {});
  store.run("INSERT INTO bot_branches VALUES('101','bot/issue-42','t-bot-branch-owner')");
  assert.deepEqual(findActiveTasksBoundToBranch(store, '101', 88, 'bot/issue-42', owned).map(r => r.id), ['t-bot-branch-owner']);
  store.run("UPDATE tasks SET status='cancelled' WHERE id='t-bot-branch-owner'");

  addTask('t-cand', '101', 'task.request', 'paused', null, {});
  store.run("INSERT INTO development_candidates VALUES('t-cand',?)", JSON.stringify({ branch: 'bot/issue-42' }));
  assert.deepEqual(findActiveTasksBoundToBranch(store, '101', 88, 'bot/issue-42', owned).map(r => r.id), ['t-cand']);
  store.run("UPDATE tasks SET status='superseded' WHERE id='t-cand'");

  addTask('t-pr-target', '101', 'task.request', 'running', 88, { target: { type: 'pr', number: 88 } });
  assert.deepEqual(findActiveTasksBoundToBranch(store, '101', 88, 'bot/issue-42', owned).map(r => r.id), ['t-pr-target']);
  store.run("UPDATE tasks SET status='succeeded' WHERE id='t-pr-target'");

  store.run("UPDATE tasks SET status='implementing' WHERE id='t-src'");
  assert.deepEqual(findActiveTasksBoundToBranch(store, '101', 88, 'bot/issue-42', owned).map(r => r.id), ['t-src']);

  // Local other open bot PR check: blocks both shared head branch AND stacked open PR whose base_ref is this branch.
  store.run("INSERT INTO bot_pull_requests VALUES('101',88,'5088','999','101','bot/issue-42',?,'t-src',0)", 'a'.repeat(40));
  store.run("INSERT INTO bot_pull_requests VALUES('101',89,'5089','999','101','bot/issue-42',?,'t-src',0)", 'a'.repeat(40));
  store.run("INSERT INTO bot_pull_requests VALUES('101',90,'5090','999','101','bot/stacked-90',?,'t-src',0)", 'b'.repeat(40));
  store.run("INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,updated_at) VALUES('101',88,'closed',0,'main',?)", now);
  store.run("INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,updated_at) VALUES('101',89,'closed',0,'main',?)", now);
  store.run("INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,updated_at) VALUES('101',90,'closed',0,'bot/issue-42',?)", now);
  assert.equal(hasOtherOpenLocalBotPrOnBranch(store, '101', 'bot/issue-42', 88), false);
  store.run("UPDATE bot_pr_states SET state='open' WHERE repository_id='101' AND number=89");
  assert.equal(hasOtherOpenLocalBotPrOnBranch(store, '101', 'bot/issue-42', 88), true);
  store.run("UPDATE bot_pr_states SET state='closed' WHERE repository_id='101' AND number=89");
  store.run("UPDATE bot_pr_states SET state='open' WHERE repository_id='101' AND number=90");
  assert.equal(hasOtherOpenLocalBotPrOnBranch(store, '101', 'bot/issue-42', 88), true);
});
