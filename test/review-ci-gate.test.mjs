import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from './helpers.mjs';
import { queueWebhook, reviewNewHead, enqueue } from '../dist/review/queue.js';
import { evaluateCiGate, ciEventSha, requiredCheckNames, skipComment, commentMarker, advancePrReviewCiWaits, applyPrReviewCiResult } from '../dist/review/ci-gate.js';
import { releasePrCi } from './review-ci-helpers.mjs';

const user = { id: 5, login: 'alice', type: 'User' };
const headA = 'a'.repeat(40), headB = 'b'.repeat(40);
const pr = (sha = headA, extra = {}) => ({ number: 7, state: 'open', draft: false, title: 'Change', user, head: { sha }, base: { ref: 'main' }, ...extra });
const ready = { state: 'ready', checks: ['unit'] };

async function fixture(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  return h;
}

test('evaluateCiGate waits for required checks and is ready only when all are green', () => {
  const now = 10_000, waitingSince = 0;
  const required = ['unit', 'e2e'];
  assert.deepEqual(evaluateCiGate({ required, checks: [], now, waitingSince }), { state: 'waiting', pending: ['unit', 'e2e'] });
  assert.deepEqual(evaluateCiGate({ required, checks: [
    { name: 'unit', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'in_progress', conclusion: null },
  ], now, waitingSince }), { state: 'waiting', pending: ['e2e'] });
  assert.deepEqual(evaluateCiGate({ required, checks: [
    { name: 'unit', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'completed', conclusion: 'success' },
  ], now, waitingSince }), { state: 'ready', checks: ['unit', 'e2e'] });
  assert.equal(evaluateCiGate({ required, checks: [
    { name: 'unit', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'completed', conclusion: 'skipped' },
  ], now, waitingSince }).state, 'ready');
});

test('evaluateCiGate uses the latest check of each name and treats failed required checks as failed', () => {
  const result = evaluateCiGate({
    required: ['e2e'],
    checks: [
      { name: 'e2e', status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z' },
      { name: 'e2e', status: 'completed', conclusion: 'failure', started_at: '2026-01-01T00:10:00Z' },
    ],
    now: 1, waitingSince: 0,
  });
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.failed, [{ name: 'e2e', conclusion: 'failure' }]);
});

test('evaluateCiGate with no required checks waits for a grace period, then proceeds if none appear', () => {
  assert.deepEqual(evaluateCiGate({ required: [], checks: [], now: 60_000, waitingSince: 0, graceMs: 120_000 }), { state: 'waiting', pending: [] });
  assert.deepEqual(evaluateCiGate({ required: [], checks: [], now: 180_000, waitingSince: 0, graceMs: 120_000 }), { state: 'ready', checks: [] });
  assert.equal(evaluateCiGate({
    required: [],
    checks: [{ name: 'lint', status: 'in_progress' }],
    now: 180_000, waitingSince: 0, graceMs: 120_000,
  }).state, 'waiting');
  assert.equal(evaluateCiGate({
    required: [],
    checks: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
    now: 180_000, waitingSince: 0,
  }).state, 'ready');
  assert.equal(evaluateCiGate({
    required: [],
    checks: [{ name: 'lint', status: 'completed', conclusion: 'failure' }],
    now: 180_000, waitingSince: 0,
  }).state, 'failed');
});

test('evaluateCiGate times out still-pending checks and maps commit statuses', () => {
  const timed = evaluateCiGate({
    required: ['unit'], checks: [{ name: 'unit', status: 'queued' }],
    now: 3_600_000, waitingSince: 0, timeoutMs: 3_600_000,
  });
  assert.deepEqual(timed, { state: 'timed_out', pending: ['unit'] });
  assert.equal(evaluateCiGate({
    required: ['ci/travis'], checks: [], statuses: [{ context: 'ci/travis', state: 'success', updated_at: '2026-01-01T00:00:00Z' }],
    now: 1, waitingSince: 0,
  }).state, 'ready');
  assert.equal(evaluateCiGate({
    required: ['ci/travis'], checks: [], statuses: [{ context: 'ci/travis', state: 'pending' }],
    now: 1, waitingSince: 0,
  }).state, 'waiting');
});

test('ciEventSha reads check, suite, workflow and status payloads', () => {
  assert.equal(ciEventSha('check_run', { check_run: { head_sha: headA } }), headA);
  assert.equal(ciEventSha('check_suite', { check_suite: { head_sha: headB } }), headB);
  assert.equal(ciEventSha('workflow_run', { workflow_run: { head_sha: headA } }), headA);
  assert.equal(ciEventSha('status', { sha: headB }), headB);
  assert.equal(ciEventSha('pull_request', { pull_request: { head: { sha: headA } } }), null);
  assert.equal(ciEventSha('check_run', { check_run: { head_sha: 'short' } }), null);
});

test('requiredCheckNames reads rulesets and classic protection', () => {
  assert.deepEqual(requiredCheckNames([
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'unit' }, { context: 'e2e' }] } },
  ], { contexts: ['unit', 'lint'] }), ['unit', 'e2e', 'lint']);
});

test('skip comments are stable and carry the bot marker prefix', () => {
  assert.match(skipComment('zh', { state: 'failed', failed: [{ name: 'e2e', conclusion: 'failure' }] }), /e2e: failure/);
  assert.match(skipComment('en', { state: 'timed_out', pending: ['unit'] }, 60 * 60 * 1000), /60 minutes/);
  assert.match(commentMarker('abc'), /<!-- dept-bot:ci-gate:abc -->/);
});

test('opening or pushing a PR holds the review until CI is green; the same head is reviewed once', async t => {
  const h = await fixture(t);
  assert.equal(queueWebhook(h.store, '101', 'pull_request', { action: 'opened', pull_request: pr(), sender: user }, 'open'), 0);
  assert.equal(h.store.all("SELECT * FROM tasks WHERE kind='review.pr'").length, 0);
  assert.equal(h.store.get("SELECT state,head_sha FROM pr_review_ci_waits WHERE number=7").state, 'waiting');
  const waiting = releasePrCi(h.store, { state: 'waiting', pending: ['unit'] });
  assert.equal(waiting.created, 0);
  assert.equal(releasePrCi(h.store, ready).created, 1);
  assert.equal(h.store.all("SELECT * FROM tasks WHERE kind='review.pr'").length, 1);
  assert.equal(h.store.get("SELECT state FROM pr_review_ci_waits WHERE number=7").state, 'released');
  assert.equal(queueWebhook(h.store, '101', 'pull_request', { action: 'synchronize', pull_request: pr(), sender: user }, 'same-head'), 0);
  assert.equal(releasePrCi(h.store, ready).created, 0);
  assert.equal(h.store.all("SELECT * FROM tasks WHERE kind='review.pr'").length, 1);
});

test('a new head supersedes the previous wait and is reviewed only after its own CI passes', async t => {
  const h = await fixture(t);
  assert.equal(queueWebhook(h.store, '101', 'pull_request', { action: 'opened', pull_request: pr(headA), sender: user }, 'open'), 0);
  assert.equal(queueWebhook(h.store, '101', 'pull_request', { action: 'synchronize', pull_request: pr(headB), sender: user }, 'push'), 0);
  const rows = h.store.all('SELECT head_sha,state FROM pr_review_ci_waits ORDER BY head_sha');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].head_sha, headA); assert.equal(rows[0].state, 'superseded');
  assert.equal(rows[1].head_sha, headB); assert.equal(rows[1].state, 'waiting');
  assert.equal(releasePrCi(h.store, ready).created, 1);
  const task = h.store.get("SELECT head_sha FROM tasks WHERE kind='review.pr'");
  assert.equal(task.head_sha, headB);
});

test('failed or timed-out CI skips the review and returns a skip comment once', async t => {
  const h = await fixture(t);
  queueWebhook(h.store, '101', 'pull_request', { action: 'opened', pull_request: pr(), sender: user }, 'open');
  const failed = releasePrCi(h.store, { state: 'failed', failed: [{ name: 'e2e', conclusion: 'failure' }] });
  assert.equal(failed.created, 0);
  assert.equal(h.store.all("SELECT * FROM tasks WHERE kind LIKE 'review.%'").length, 0);
  assert.equal(failed.comments.length, 1);
  assert.match(failed.comments[0].body, /e2e: failure/);
  assert.match(failed.comments[0].body, /<!-- dept-bot:ci-gate:/);
  assert.equal(h.store.get('SELECT state FROM pr_review_ci_waits').state, 'failed');
  h.store.run('UPDATE pr_review_ci_waits SET comment_url=?', 'https://example.test/comment');
  assert.equal(releasePrCi(h.store, { state: 'failed', failed: [{ name: 'e2e', conclusion: 'failure' }] }).comments.length, 0);

  queueWebhook(h.store, '101', 'pull_request', { action: 'synchronize', pull_request: pr(headB), sender: user }, 'later');
  const timed = releasePrCi(h.store, { state: 'timed_out', pending: ['unit'] });
  assert.equal(timed.created, 0);
  assert.equal(h.store.get("SELECT state FROM pr_review_ci_waits WHERE head_sha=?", headB).state, 'timed_out');
  assert.match(timed.comments[0].body, /60 分钟|unit/);
});

test('mentions and issue reviews still start immediately, and closing cancels a CI wait', async t => {
  const h = await fixture(t);
  const issue = { number: 3, state: 'open', title: 'Bug', user };
  assert.equal(queueWebhook(h.store, '101', 'issues', { action: 'opened', issue, sender: user }, 'issue-open'), 1);
  assert.equal(queueWebhook(h.store, '101', 'pull_request', { action: 'opened', pull_request: pr(), sender: user }, 'pr-open'), 0);
  assert.equal(queueWebhook(h.store, '101', 'issue_comment', {
    action: 'created', issue: { ...pr(), pull_request: {} }, sender: user,
    comment: { id: 11, body: '@bot please look', author_association: 'MEMBER' },
  }, 'mention', pr()), 1);
  assert.ok(h.store.get("SELECT 1 FROM dispatch_events WHERE type='pull_request.mention'"));
  queueWebhook(h.store, '101', 'pull_request', { action: 'closed', pull_request: { ...pr(), state: 'closed' }, sender: user }, 'close');
  assert.equal(h.store.get("SELECT state FROM pr_review_ci_waits WHERE head_sha=?", headA).state, 'cancelled');
  assert.equal(releasePrCi(h.store, ready).created, 0);
});

test('reviewNewHead also waits for CI, and a later check webhook only wakes the waiter', async t => {
  const h = await fixture(t);
  assert.equal(reviewNewHead(h.store, '101', pr(headB, { title: 'New head' })), 0);
  assert.equal(h.store.get("SELECT state,head_sha FROM pr_review_ci_waits").head_sha, headB);
  assert.equal(queueWebhook(h.store, '101', 'check_run', { action: 'completed', check_run: { head_sha: headB, name: 'unit', status: 'completed', conclusion: 'success' } }, 'checks'), 0);
  assert.equal(h.store.all("SELECT * FROM tasks WHERE kind='review.pr'").length, 0);
  assert.equal(releasePrCi(h.store, ready).created, 1);
});

test('applyPrReviewCiResult is a no-op on a wait that already left waiting', async t => {
  const h = await fixture(t);
  queueWebhook(h.store, '101', 'pull_request', { action: 'opened', pull_request: pr(), sender: user }, 'open');
  const wait = h.store.get('SELECT * FROM pr_review_ci_waits');
  assert.equal(applyPrReviewCiResult(h.store, wait, ready).created, 1);
  assert.equal(applyPrReviewCiResult(h.store, h.store.get('SELECT * FROM pr_review_ci_waits'), ready).created, 0);
  assert.equal(advancePrReviewCiWaits(h.store, () => ready).created, 0);
});
