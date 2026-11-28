// #1427: Unit tests for Merge Queue branch parsing, pull_request.dequeued CI-failure classification,
// pull_request.checks_failed event filter defaults/overrides, control-plane non-bot PR write refusal,
// and edited comment/review prompt labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import {
  parseMergeQueueBranch,
  isDequeuedCheckFailureReason,
  botWakePreflightPlan,
  isMergeGroupRunFresh,
} from '../../../../dist/review/bot-pr-wake.js';
import { eventFilters, saveManager } from '../../../../dist/dispatch/settings.js';
import { dispatchContext, recordEvent, genericRefusal } from '../../../../dist/dispatch/store.js';
import { promptedBy } from '../../../../dist/github/text.js';

function repoFixture(t, policyCols = {}) {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','fixture/project','o','a')");
  store.run(
    "INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r','http://127.0.0.1:9/v1','fixture',?,'now')",
    store.secrets.seal({ value: 'fixture-key' }, 'model:m'),
  );
  const enabled = policyCols.enabled ?? 1;
  const reviewPrs = policyCols.review_pull_requests ?? 1;
  const ceiling = policyCols.capability_ceiling ?? 'develop';
  const filters = JSON.stringify(policyCols.event_filters ?? {});
  store.run(
    'INSERT INTO policies(repository_id,enabled,model_id,review_pull_requests,capability_ceiling,event_filters) VALUES(?,?,?,?,?,?)',
    'r',
    enabled,
    'm',
    reviewPrs,
    ceiling,
    filters,
  );
  return store;
}

test('parseMergeQueueBranch extracts simple and slashed base branches, PR number, and base SHA prefix; rejects malformed refs', () => {
  assert.deepEqual(
    parseMergeQueueBranch('gh-readonly-queue/main/pr-1427-0123456789abcdef0123456789abcdef01234567'),
    {
      branch: 'gh-readonly-queue/main/pr-1427-0123456789abcdef0123456789abcdef01234567',
      baseRef: 'main',
      prNumber: 1427,
      baseShaPrefix: '0123456789abcdef0123456789abcdef01234567',
    },
  );
  assert.deepEqual(
    parseMergeQueueBranch('gh-readonly-queue/main/pr-42-ABCDEF1'),
    {
      branch: 'gh-readonly-queue/main/pr-42-ABCDEF1',
      baseRef: 'main',
      prNumber: 42,
      baseShaPrefix: 'abcdef1',
    },
  );
  assert.deepEqual(
    parseMergeQueueBranch('gh-readonly-queue/release/v1/pr-88-a1b2c3d4e5'),
    {
      branch: 'gh-readonly-queue/release/v1/pr-88-a1b2c3d4e5',
      baseRef: 'release/v1',
      prNumber: 88,
      baseShaPrefix: 'a1b2c3d4e5',
    },
  );
  assert.deepEqual(
    parseMergeQueueBranch('gh-readonly-queue/team/release/2026.11/pr-9-1234567'),
    {
      branch: 'gh-readonly-queue/team/release/2026.11/pr-9-1234567',
      baseRef: 'team/release/2026.11',
      prNumber: 9,
      baseShaPrefix: '1234567',
    },
  );

  for (const invalid of [
    null,
    undefined,
    '',
    'main',
    'bot/issue-42',
    'gh-readonly-queue//pr-1-abcdef1',
    'gh-readonly-queue/a//b/pr-1-abcdef1',
    'gh-readonly-queue/main/pr-0-abcdef1',
    'gh-readonly-queue/main/pr-1-123456',
    'gh-readonly-queue/main/pr-1-zzzzzzz',
    'gh-readonly-queue/a b/pr-1-abcdef1',
    'gh-readonly-queue/main/pr-1-' + 'a'.repeat(41),
  ]) {
    assert.equal(parseMergeQueueBranch(invalid), null, `expected null for ${JSON.stringify(invalid)}`);
  }
});

test('isDequeuedCheckFailureReason accepts CI/check/timeout dequeue reasons and rejects merge/manual/closed/conflict reasons', () => {
  for (const ok of [
    'CI_FAILURE',
    'ci_failure',
    'CHECKS_FAILED',
    'STATUS_CHECK_FAILURE',
    'REQUIRED_STATUS_CHECK_FAILED',
    'TIMEOUT',
    'TIMED_OUT',
    'MERGE_GROUP_TIMEOUT',
  ]) {
    assert.equal(isDequeuedCheckFailureReason(ok), true, ok);
  }
  for (const nope of [
    'MERGE',
    'MANUAL',
    'PR_CLOSED',
    'PR_CONVERTED_TO_DRAFT',
    'MERGE_CONFLICT',
    'BRANCH_PROTECTION',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isDequeuedCheckFailureReason(nope), false, String(nope));
  }
});

test('pull_request.checks_failed event filter follows review_pull_requests by default and toggles independently', t => {
  const s1 = repoFixture(t, { review_pull_requests: 1 });
  assert.equal(eventFilters(s1, 'r')['pull_request.checks_failed'], true);

  saveManager(s1, 'r', { expected_revision: 0, events: { 'pull_request.checks_failed': false } }, 'owner');
  assert.equal(eventFilters(s1, 'r')['pull_request.checks_failed'], false);
  assert.equal(eventFilters(s1, 'r')['pull_request.opened'], true);

  const s2 = repoFixture(t, { review_pull_requests: 0 });
  assert.equal(eventFilters(s2, 'r')['pull_request.checks_failed'], false);
  saveManager(s2, 'r', { expected_revision: 0, events: { 'pull_request.checks_failed': true } }, 'owner');
  assert.equal(eventFilters(s2, 'r')['pull_request.checks_failed'], true);
});

test('genericRefusal enforces non_bot_pr_write_forbidden for non-bot PR pull_request writes while allowing read/github writes and bot PR writes', t => {
  const store = repoFixture(t, { capability_ceiling: 'develop' });
  const head = 'a'.repeat(40);
  const nonBotKey = 'r:pull_request.checks_failed:90:' + head + ':run:1:1';
  recordEvent(store, {
    repositoryId: 'r',
    key: nonBotKey,
    type: 'pull_request.checks_failed',
    source: 'github',
    summary: '他人 PR #90 检查失败',
    facts: { bot_pull_request: false, pr_number: 90, head_sha: head },
    object: { type: 'pr', number: 90 },
    options: [],
  });
  const ctxNonBot = dispatchContext(store, store.get('SELECT * FROM dispatch_events WHERE event_key=?', nonBotKey));

  // Attempting to grant `pull_request` write on a non-bot PR (targeting PR #90 or even a different target) is hard-refused.
  assert.equal(genericRefusal(store, ctxNonBot, 'dev', ['pull_request'], { type: 'pr', number: 90 })?.code, 'non_bot_pr_write_forbidden');
  assert.equal(genericRefusal(store, ctxNonBot, null, ['pull_request'], { type: 'branch', ref: 'alice/feat' })?.code, 'non_bot_pr_write_forbidden');
  // Read-only or comment-only analysis tasks remain allowed.
  assert.equal(genericRefusal(store, ctxNonBot, 'reviewer', [], { type: 'pr', number: 90 }), null);
  assert.equal(genericRefusal(store, ctxNonBot, 'dev', ['github'], { type: 'pr', number: 90 }), null);

  // Owned bot PR #88 is NOT blocked by `non_bot_pr_write_forbidden`.
  store.run("INSERT INTO bot_pull_requests VALUES('r',88,'5088','999','r','bot/issue-42',?,'src-88',0)", head);
  const botKey = 'r:pull_request.checks_failed:88:' + head + ':run:2:1';
  recordEvent(store, {
    repositoryId: 'r',
    key: botKey,
    type: 'pull_request.checks_failed',
    source: 'github',
    summary: 'bot PR #88 检查失败',
    facts: { bot_pull_request: true, pr_number: 88, head_sha: head },
    object: { type: 'pr', number: 88 },
    options: [],
  });
  const ctxBot = dispatchContext(store, store.get('SELECT * FROM dispatch_events WHERE event_key=?', botKey));
  assert.equal(genericRefusal(store, ctxBot, null, ['pull_request'], { type: 'pr', number: 88 }), null);
});

test('promptedBy maps edited review and review comment reasons consistently', () => {
  assert.equal(promptedBy('review_edited'), 'review');
  assert.equal(promptedBy('review_comment_edited'), 'review_comment');
  assert.equal(promptedBy('review_reply_edited'), 'review_comment');
  assert.equal(promptedBy('comment_edited'), 'comment');
});

test('botWakePreflightPlan enables commit->pulls lookup for check_run/check_suite with empty pull_requests even when review is off and no local task exists', t => {
  const store = repoFixture(t, {
    review_pull_requests: 0,
    capability_ceiling: 'comment',
    event_filters: {
      'pull_request.opened': false,
      'pull_request.synchronize': false,
      'pull_request.checks_failed': true,
    },
  });
  const head = 'b'.repeat(40);

  const crPlan = botWakePreflightPlan(store, 'r', 'check_run', {
    action: 'completed',
    check_run: { id: 101, name: 'ci', status: 'completed', conclusion: 'failure', head_sha: head, check_suite: { id: 201, head_branch: 'alice/feat' }, pull_requests: [] },
  });
  assert.equal(crPlan?.kind, 'check_failure');
  assert.equal(crPlan?.lookupPullsByCommit, true);
  assert.deepEqual(crPlan?.prNumbers, []);

  const csPlan = botWakePreflightPlan(store, 'r', 'check_suite', {
    action: 'completed',
    check_suite: { id: 202, status: 'completed', conclusion: 'startup_failure', head_sha: head, head_branch: 'alice/feat', pull_requests: [] },
  });
  assert.equal(csPlan?.kind, 'check_failure');
  assert.equal(csPlan?.lookupPullsByCommit, true);

  // Fork PR opened from `fork:main` -> `upstream:main` with empty pull_requests[] still triggers commit->pulls lookup.
  const forkMainCr = botWakePreflightPlan(store, 'r', 'check_run', {
    action: 'completed',
    check_run: { id: 102, name: 'ci', status: 'completed', conclusion: 'failure', head_sha: head, check_suite: { id: 203, head_branch: 'main' }, pull_requests: [] },
  });
  assert.equal(forkMainCr?.lookupPullsByCommit, true);

  // Non-PR workflow_runs (schedule, workflow_dispatch, push to default branch) do not issue unnecessary commit->pulls lookups.
  for (const wf of [
    { id: 301, event: 'schedule', head_branch: 'main', head_sha: head, status: 'completed', conclusion: 'failure', pull_requests: [] },
    { id: 302, event: 'workflow_dispatch', head_branch: 'main', head_sha: head, status: 'completed', conclusion: 'failure', pull_requests: [] },
    { id: 303, event: 'push', head_branch: 'main', head_sha: head, status: 'completed', conclusion: 'failure', pull_requests: [] },
  ]) {
    assert.equal(botWakePreflightPlan(store, 'r', 'workflow_run', { action: 'completed', workflow_run: wf }), null, wf.event);
  }

  // Feature-branch push workflow_run with empty pull_requests[] enables commit->pulls lookup.
  const featPush = botWakePreflightPlan(store, 'r', 'workflow_run', {
    action: 'completed',
    workflow_run: { id: 304, event: 'push', head_branch: 'alice/feat', head_sha: head, status: 'completed', conclusion: 'failure', pull_requests: [] },
  });
  assert.equal(featPush?.lookupPullsByCommit, true);
});

test('isMergeGroupRunFresh clamps lower bound with authoritative headCommitDate so late head_updated_at never drops genuine runs', () => {
  const target = { baseRef: 'main', createdAt: '2026-11-26T08:00:00Z', headUpdatedAt: '2026-11-26T13:30:00Z' };
  const genuineRun = { mergeGroupBaseRef: 'main', createdAt: '2026-11-26T13:05:00Z', completedAt: '2026-11-26T13:08:00Z' };
  const staleRun = { mergeGroupBaseRef: 'main', createdAt: '2026-11-26T12:55:00Z', completedAt: '2026-11-26T12:58:00Z' };
  const inFlightOldRun = { mergeGroupBaseRef: 'main', createdAt: '2026-11-26T12:59:00Z', completedAt: '2026-11-26T13:02:00Z' };

  assert.equal(isMergeGroupRunFresh(genuineRun, target, '2026-11-26T13:00:00Z'), true);
  assert.equal(isMergeGroupRunFresh(staleRun, target, '2026-11-26T13:00:00Z'), false);
  assert.equal(isMergeGroupRunFresh(inFlightOldRun, target, '2026-11-26T13:00:00Z'), false);
  // Without headCommitDate, falls back to headUpdatedAt.
  assert.equal(isMergeGroupRunFresh(genuineRun, target, null), false);
  assert.equal(isMergeGroupRunFresh({ mergeGroupBaseRef: 'release/v1', createdAt: '2026-11-26T13:05:00Z', completedAt: '2026-11-26T13:08:00Z' }, target, '2026-11-26T13:00:00Z'), false);
});
