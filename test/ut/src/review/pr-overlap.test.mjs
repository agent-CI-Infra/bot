import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import {
  extractLinkedIssueNumbers,
  queryRepositoryActiveWork,
  hasRepositoryActiveWork,
  emitReviewOverlapEvents,
} from '../../../../dist/review/pr-overlap.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { dispatchContext, isBotPrOpen } from '../../../../dist/dispatch/store.js';
import { ruleDecision } from '../../../../dist/dispatch/rules.js';
import { validateReviewDelivery } from '../../../../dist/tasks/github-write.js';
import { setGrant } from '../../../../dist/tasks/grants.js';
import { captureTaskConfiguration } from '../../../../dist/tasks/configuration.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_BOT = 'c'.repeat(40);

function createStore(t) {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  const now = '2026-11-28T06:00:00.000Z';
  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'gh-tok' }, 'account:a'), now);
  store.run("INSERT INTO repositories VALUES('101','acme/demo','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:9/v1', 'fixture', store.secrets.seal({ value: 'k' }, 'model:m'), now);
  store.run("INSERT INTO policies(repository_id,model_id,enabled,review_enabled,development_enabled,capability_ceiling) VALUES('101','m',1,1,1,'develop')");
  scriptedRoles(store, '101');

  const seedTask = (id, {
    kind = 'task.request',
    status = 'running',
    objectNumber = 12,
    target = { type: 'issue', number: 12 },
    headSha = HEAD_BOT,
    writes = ['pull_request'],
    summary = `Task ${id}`,
  } = {}) => {
    const input = { generic: kind === 'task.request', target, round: 1 };
    store.run(
      `INSERT INTO tasks(id,repository_id,kind,status,phase,summary,input,object_number,head_sha,attempt,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`,
      id, '101', kind, status, 'model', summary, JSON.stringify(input), objectNumber, headSha, now, now,
    );
    if (writes.length) setGrant(store, { id, repository_id: '101' }, writes, 'role:manager', null);
    captureTaskConfiguration(store, id);
    return store.get('SELECT * FROM tasks WHERE id=?', id);
  };

  return { store, now, seedTask };
}

test('extractLinkedIssueNumbers parses GitHub closing keywords accurately and ignores code blocks and cross-repo refs', () => {
  const body = [
    'This PR fixes #12, #13 and #14.',
    'Also closes: acme/demo#20 and resolves https://github.com/Acme/Demo/issues/21?view=full.',
    'Fixes #30 and adds tests for #99.',
    'Closes other/repo#40 and fixes https://github.com/other/repo/issues/41.',
    'Inline example: `Fixes #50` should be ignored.',
    '```markdown',
    'Closes #60',
    '```',
    '~~~',
    'Resolves #61',
    '~~~',
    'Fixes #12 again (duplicate) and closes #77 (self).',
  ].join('\n');

  assert.deepEqual(
    extractLinkedIssueNumbers(body, 'acme/demo', 77),
    [12, 13, 14, 20, 21, 30],
  );
  assert.deepEqual(extractLinkedIssueNumbers('See #12 without closing keyword', 'acme/demo'), []);
  assert.deepEqual(extractLinkedIssueNumbers('', 'acme/demo'), []);
});

test('idle repository keeps pull_request.opened fast path with zero linked-Issue events and no repository_active_work', t => {
  const { store } = createStore(t);
  const pr50 = {
    number: 50,
    state: 'open',
    draft: false,
    title: 'Fix parser bug',
    body: 'Closes #12',
    head: { sha: HEAD_A, ref: 'fix/parser' },
    base: { ref: 'main' },
    user: { id: 5, login: 'alice' },
    html_url: 'https://github.com/acme/demo/pull/50',
  };

  assert.equal(queueWebhook(store, '101', 'pull_request', {
    action: 'opened',
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: pr50,
  }, 'deliv-idle-1'), 1);

  const events = store.all('SELECT * FROM dispatch_events ORDER BY rowid');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pull_request.opened');
  const facts = JSON.parse(events[0].facts);
  assert.equal(facts.repository_active_work, undefined);

  const ctx = dispatchContext(store, events[0]);
  const ruled = ruleDecision(store, ctx, () => true);
  assert.equal(ruled?.decision, 'create');
  assert.equal(ruled?.role, 'reviewer');
  assert.deepEqual(ruled?.writes, ['review']);
});

test('human PR linking an Issue with active dev task or open bot PR emits idempotent issue.linked_pull_request to Issue thread while keeping PR review fast path', t => {
  const { store, now, seedTask } = createStore(t);
  seedTask('dev-12', { status: 'running', objectNumber: 12, target: { type: 'issue', number: 12 }, summary: 'Implement Issue #12' });
  seedTask('dev-15', { status: 'pr_opened', objectNumber: 15, target: { type: 'issue', number: 15 }, summary: 'Implement Issue #15' });
  store.run("INSERT INTO bot_pull_requests VALUES('101',30,'pr-30','999','101','bot/issue-15',?,'dev-15',0)", HEAD_BOT);
  store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,head_sha,title,html_url,updated_at)
     VALUES('101',30,'open',0,'main',?,'Bot fix for #15','https://github.com/acme/demo/pull/30',?)`,
    HEAD_BOT, now,
  );
  assert.equal(isBotPrOpen(store, '101', 30), true);

  // Draft PR must NOT emit linked-Issue event yet.
  const draftPr = {
    number: 50,
    state: 'open',
    draft: true,
    title: 'Human fix',
    body: 'Fixes #12 and Closes #15',
    head: { sha: HEAD_A, ref: 'human/fix' },
    base: { ref: 'main' },
    user: { id: 5, login: 'alice' },
    html_url: 'https://github.com/acme/demo/pull/50',
  };
  assert.equal(queueWebhook(store, '101', 'pull_request', {
    action: 'opened',
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: draftPr,
  }, 'deliv-draft'), 0);
  assert.equal(store.all("SELECT * FROM dispatch_events WHERE type='issue.linked_pull_request'").length, 0);

  // Ready for review emits BOTH pull_request.opened (with repository_active_work) AND issue.linked_pull_request for #12 and #15.
  const readyPr = { ...draftPr, draft: false };
  assert.equal(queueWebhook(store, '101', 'pull_request', {
    action: 'ready_for_review',
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: readyPr,
  }, 'deliv-ready'), 3);

  const prOpened = store.get("SELECT * FROM dispatch_events WHERE type='pull_request.opened' AND state='pending'");
  assert.ok(prOpened);
  const prFacts = JSON.parse(prOpened.facts);
  assert.equal(prFacts.repository_active_work.active_development_tasks.length, 1);
  assert.equal(prFacts.repository_active_work.open_bot_pull_requests.length, 1);
  assert.equal(ruleDecision(store, dispatchContext(store, prOpened), () => true)?.decision, 'create', 'PR review fast path stays intact');

  const linked = store.all("SELECT * FROM dispatch_events WHERE type='issue.linked_pull_request' ORDER BY object_number");
  assert.equal(linked.length, 2);
  assert.equal(linked[0].thread_key, '101:issue:12');
  assert.equal(linked[1].thread_key, '101:issue:15');
  assert.equal(ruleDecision(store, dispatchContext(store, linked[0]), () => true), null, 'issue.linked_pull_request goes to Issue Manager, not standing rule');
  assert.equal(JSON.parse(linked[0].merge).head, null, 'merge.head must stay null so continue_task never moves bot PR head to human PR head');
  const facts12 = JSON.parse(linked[0].facts);
  assert.equal(facts12.linked_pull_request.number, 50);
  assert.equal(facts12.active_development_tasks[0].task_id, 'dev-12');
  const facts15 = JSON.parse(linked[1].facts);
  assert.equal(facts15.open_bot_pull_requests[0].number, 30);

  // Editing PR body without new linked Issues deduplicates cleanly; adding a new closing keyword emits once.
  seedTask('dev-18', { status: 'queued', objectNumber: 18, target: { type: 'issue', number: 18 }, summary: 'Implement Issue #18' });
  assert.equal(queueWebhook(store, '101', 'pull_request', {
    action: 'edited',
    changes: { body: { from: readyPr.body } },
    sender: { type: 'User', login: 'alice', id: 5 },
    pull_request: { ...readyPr, body: 'Fixes #12, Closes #15, Resolves #18' },
  }, 'deliv-edit'), 2); // 1 new issue.linked_pull_request (#18) + 1 pull_request.updated (#50)
  assert.equal(store.all("SELECT * FROM dispatch_events WHERE type='issue.linked_pull_request'").length, 3);

  // Bot's own PR opening never triggers issue.linked_pull_request.
  store.run("INSERT INTO bot_pull_requests VALUES('101',31,'pr-31','999','101','bot/issue-12',?,'dev-12',0)", HEAD_BOT);
  assert.equal(queueWebhook(store, '101', 'pull_request', {
    action: 'opened',
    sender: { type: 'Bot', login: 'launchpad[bot]', id: 999 },
    pull_request: {
      number: 31, state: 'open', draft: false, title: 'Bot PR', body: 'Fixes #12',
      head: { sha: HEAD_BOT, ref: 'bot/issue-12', repo: { id: '101' } }, base: { ref: 'main' },
      user: { id: 999, login: 'launchpad[bot]' },
    },
  }, 'deliv-bot-own'), 0);
  assert.equal(store.all("SELECT * FROM dispatch_events WHERE type='issue.linked_pull_request'").length, 3);
});

test('validateReviewDelivery and emitReviewOverlapEvents validate implicit overlap and route to matching Issue or standalone bot PR thread', t => {
  const { store, now, seedTask } = createStore(t);
  seedTask('dev-40', { status: 'pr_opened', objectNumber: 40, target: { type: 'issue', number: 40 }, summary: 'Issue #40 dev' });
  store.run("INSERT INTO bot_pull_requests VALUES('101',41,'pr-41','999','101','bot/issue-40',?,'dev-40',0)", HEAD_BOT);
  store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,head_sha,title,html_url,updated_at)
     VALUES('101',41,'open',0,'main',?,'Bot PR #41','https://github.com/acme/demo/pull/41',?)`,
    HEAD_BOT, now,
  );
  // Standalone bot PR without root issue
  seedTask('standalone-dev', { status: 'pr_opened', objectNumber: null, target: { type: 'branch', ref: 'main' }, summary: 'Standalone dev' });
  store.run("INSERT INTO bot_pull_requests VALUES('101',42,'pr-42','999','101','bot/standalone',?,'standalone-dev',0)", HEAD_BOT);
  store.run(
    `INSERT INTO bot_pr_states(repository_id,number,state,draft,base_ref,head_sha,title,html_url,updated_at)
     VALUES('101',42,'open',0,'main',?,'Standalone Bot PR #42','https://github.com/acme/demo/pull/42',?)`,
    HEAD_BOT, now,
  );

  const reviewTask = seedTask('rev-60', { status: 'running', objectNumber: 60, target: { type: 'pr', number: 60, ref: HEAD_B }, headSha: HEAD_B, writes: ['review'] });
  assert.equal(hasRepositoryActiveWork(queryRepositoryActiveWork(store, '101', 60)), true);

  // Validation rejects invalid overlapping_work shapes and accepts valid ones.
  assert.equal(validateReviewDelivery(reviewTask, { summary: 'Ok', overlapping_work: [{ reason: 'missing ref' }] }).ok, false);
  assert.equal(validateReviewDelivery(reviewTask, { summary: 'Ok', overlapping_work: [{ bot_pr_number: 41, reason: '' }] }).ok, false);
  const valid = validateReviewDelivery(reviewTask, {
    summary: 'Human PR #60 overlaps bot PR #41 and #42.',
    overlapping_work: [
      { bot_pr_number: 41, reason: 'Fixes the same parser edge case as bot PR #41.' },
      { bot_pr_number: 42, reason: 'Also overlaps standalone bot PR #42.' },
      { bot_pr_number: 9999, reason: 'Non-existent PR should be ignored by control plane.' },
    ],
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.overlapping_work?.length, 3);

  const pr60Input = {
    target: { type: 'pr', number: 60 },
    object: { number: 60, state: 'open', draft: false, title: 'Parser edge case fix', body: 'No Closes keyword', head: { sha: HEAD_B, ref: 'fix/edge' }, base: { ref: 'main' }, user: { login: 'bob' }, html_url: 'https://github.com/acme/demo/pull/60' },
  };
  assert.equal(emitReviewOverlapEvents(store, reviewTask, pr60Input, valid.value.overlapping_work), 2);
  // Repeating emits 0 (idempotent)
  assert.equal(emitReviewOverlapEvents(store, reviewTask, pr60Input, valid.value.overlapping_work), 0);

  const emitted = store.all("SELECT * FROM dispatch_events WHERE type='issue.linked_pull_request' ORDER BY thread_key");
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map(e => e.thread_key), ['101:issue:40', '101:pr:42']);
  assert.equal(JSON.parse(emitted[0].facts).linked_pull_request.matched_by, 'review_overlap');
  assert.equal(JSON.parse(emitted[0].facts).open_bot_pull_requests[0].number, 41);
  assert.equal(JSON.parse(emitted[1].facts).open_bot_pull_requests[0].number, 42);
});
