import { acceptanceFixture } from '../../../fixtures/acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { recordRevision } from '../../../../dist/github/publisher.js';
import { enqueueRefusal, pullRequestNeeded, queueWebhook, updateTrigger } from '../../../../dist/review/queue.js';
import { emptyRepositoryFixture } from '../../../fixtures/empty-repository-helpers.mjs';

// Reviews of what a person changes after an Issue or PR was opened: edits, comments, reviews and replies to review comments.
const user = { type: 'User', login: 'alice', id: 5 };
// A review's run answers the updates it took (its first turn moves the cursor past them) and publishes.
const finish = h => h.store.run("UPDATE tasks SET status='succeeded',review_update_cursor=coalesce((SELECT max(id) FROM review_updates WHERE task_id=tasks.id),0)");
const updates = h => h.store.all("SELECT * FROM tasks WHERE unique_key LIKE '%:update:%' ORDER BY created_at,rowid");

test('Issue edits and comments continue the finished review as its next round, merged while it waits; the bot and closed Issues never trigger', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const issue = { number: 1, state: 'open', title: 'Fix the parser', body: 'The parser drops the last line.', user: { id: 5 } };
  const send = (delivery, payload, event = 'issues') => h.hook(a.path, a.secret, delivery, { repository: { id: 101 }, sender: user, ...payload }, { 'X-GitHub-Event': event });
  const review = () => h.store.get("SELECT * FROM tasks WHERE kind='review.issue'"), round = () => JSON.parse(review().input).round ?? 1;
  assert.equal((await send('opened', { action: 'opened', issue })).value.tasks_created, 1); finish(h);

  // An edited body: the Issue's review continues as its next round (#770) and sees what was there before.
  const edited = { action: 'edited', issue: { ...issue, body: 'The parser drops the last line of CRLF files.' }, changes: { body: { from: issue.body } } };
  assert.equal((await send('edited', edited)).value.tasks_created, 0);
  const first = review(), input = JSON.parse(first.input);
  assert.equal(first.status, 'queued'); assert.equal(input.round, 2); assert.equal(first.head_sha, null); assert.equal(first.unique_key, '101:review.issue:1:opened');
  assert.deepEqual(input.trigger, { event: 'issues', action: 'edited', reason: 'issue_edited', actor: 'alice', changed: ['body'], previous: { body: issue.body } });
  assert.equal((await send('edited', edited)).value.duplicate, true);
  // While that round waits, another edit and a comment join it instead of starting more.
  assert.equal((await send('edited-again', { ...edited, changes: { title: { from: 'Old title' } } })).value.tasks_created, 0);
  assert.equal((await send('comment-while-waiting', { action: 'created', issue, comment: { id: 11, body: 'Also CR-only files.' } }, 'issue_comment')).value.tasks_created, 0);
  // The waiting round is told about both.
  assert.deepEqual(JSON.parse(review().input).merged_updates.map(update => update.reason), ['issue_edited', 'comment']);
  assert.equal(round(), 2); finish(h);

  // A comment from someone who neither wrote the Issue nor has a role in the repository reviews nothing; a collaborator's does.
  const stranger = { type: 'User', login: 'mallory', id: 9 };
  assert.equal((await send('stranger', { action: 'created', sender: stranger, issue, comment: { id: 17, body: 'Please.', author_association: 'NONE' } }, 'issue_comment')).value.tasks_created, 0);
  assert.equal(review().status, 'succeeded');
  assert.equal((await send('collaborator', { action: 'created', sender: stranger, issue, comment: { id: 18, body: 'Confirmed.', author_association: 'COLLABORATOR' } }, 'issue_comment')).value.tasks_created, 0);
  assert.equal(review().status, 'queued'); assert.equal(round(), 3);
  finish(h);

  // A plain reply in the conversation reviews again with the comment as the trigger.
  const comment = { id: 12, body: 'I attached a sample file.', html_url: 'https://github.invalid/issue/1#issuecomment-12' };
  assert.equal((await send('comment', { action: 'created', issue, comment }, 'issue_comment')).value.tasks_created, 0);
  const reply = JSON.parse(review().input);
  assert.equal(reply.round, 4); assert.deepEqual(reply.merged_updates, []);
  assert.deepEqual(reply.comment, comment); assert.deepEqual(reply.trigger, { event: 'issue_comment', action: 'created', reason: 'comment', actor: 'alice', url: comment.html_url, source: { type: 'comment', id: 12 }, actor_id: '5' }); finish(h);

  // Nothing the bot writes, no edit that leaves the title and body alone, and nothing on a closed Issue triggers.
  for (const [delivery, payload, event] of [
    ['bot-app-comment', { action: 'created', sender: { type: 'Bot', login: 'app[bot]' }, issue, comment: { id: 13, body: 'Summary' } }, 'issue_comment'],
    ['bot-account-comment', { action: 'created', issue, comment: { id: 14, body: 'Summary\n\n<!-- dept-bot:abc -->' } }, 'issue_comment'],
    ['bot-edit', { ...edited, sender: { type: 'Bot' } }],
    ['other-edit', { ...edited, changes: { milestone: { from: null } } }],
    ['closed-edit', { ...edited, issue: { ...edited.issue, state: 'closed' } }],
    ['closed-comment', { action: 'created', issue: { ...issue, state: 'closed' }, comment: { id: 15, body: 'Reopen?' } }, 'issue_comment'],
    ['edited-comment', { action: 'edited', issue, comment: { id: 12, body: 'I attached two sample files.' } }, 'issue_comment'],
  ]) { assert.equal((await send(delivery, payload, event)).value.tasks_created, 0, delivery); assert.equal(review().status, 'succeeded', delivery); }

  // Each switch turns its trigger off; Issue updates also need Issue review on.
  await admin('/api/repositories/101/policy', 'PATCH', { review_issue_updates: false });
  assert.equal((await send('updates-off', { action: 'created', issue, comment: { id: 16, body: 'More detail.' } }, 'issue_comment')).value.tasks_created, 0);
  await admin('/api/repositories/101/policy', 'PATCH', { review_issue_updates: true, review_issues: false });
  assert.equal((await send('issues-off', { ...edited, changes: { title: { from: 'x' } } })).value.tasks_created, 0);
  assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { review_pr_discussion: 'yes' })).status, 400);
  const policy = (await admin('/api/repositories/101')).value.policy; assert.deepEqual([policy.review_issue_updates, policy.review_pr_discussion], [1, 1]);
  assert.equal(review().status, 'succeeded'); assert.equal(round(), 4);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1);
});

test('PR comments, reviews, replies to review comments and description edits review the current head once', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const head = 'c'.repeat(40), pr = { number: 7, state: 'open', draft: false, head: { sha: head }, user: { id: 5 }, body: 'Adds CRLF support.' };
  let delivery = 0; const queue = (event, payload, current) => queueWebhook(h.store, '101', event, { repository: { id: 101 }, sender: user, ...payload }, 'delivery-' + (++delivery), current);
  // The PR's one review: each later update continues it as its next round (#770). `reviewed` counts the rounds that wait.
  const review = () => h.store.get("SELECT * FROM tasks WHERE kind='review.pr'"), reviewed = () => h.store.get("SELECT count(*) n FROM tasks WHERE status='queued'").n;

  // A reply to a review comment: reviewed at the PR head, with the reply as the trigger comment.
  const replyComment = { id: 21, body: 'Fixed in the latest push.', in_reply_to_id: 20, path: 'src/parse.js', line: 12, html_url: 'https://github.invalid/pull/7#discussion_r21' };
  assert.equal(queue('pull_request_review_comment', { action: 'created', pull_request: pr, comment: replyComment }), 1);
  let task = review(), input = JSON.parse(task.input);
  assert.equal(task.kind, 'review.pr'); assert.equal(task.head_sha, head); assert.deepEqual(input.comment, replyComment);
  assert.deepEqual(input.trigger, { event: 'pull_request_review_comment', action: 'created', reason: 'review_reply', actor: 'alice', url: replyComment.html_url, path: 'src/parse.js', line: 12, source: { type: 'review_comment', id: 21 }, actor_id: '5' });
  // The review GitHub wraps around that reply has no body and joins the same review; so does anything else while it waits.
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'commented', body: null } }), 0);
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'commented', body: 'Please look again.' } }), 0);
  assert.equal(updates(h).length, 1); finish(h);

  // A submitted review with a body, or one asking for changes, reviews again.
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { id: 30, state: 'commented', body: 'Please look again.', html_url: 'https://github.invalid/pull/7#pullrequestreview-30' } }), 0);
  assert.equal(reviewed(), 1); assert.equal(JSON.parse(review().input).round, 2);
  assert.deepEqual(JSON.parse(review().input).trigger, { event: 'pull_request_review', action: 'submitted', reason: 'review_submitted', actor: 'alice', state: 'commented', body: 'Please look again.', url: 'https://github.invalid/pull/7#pullrequestreview-30', source: { type: 'review', id: 30 }, actor_id: '5' }); finish(h);
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'changes_requested', body: '' } }), 0); assert.equal(reviewed(), 1); finish(h);
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'approved', body: '' } }), 0); assert.equal(reviewed(), 0);

  // An edited description reviews again; a conversation comment needs the PR read from GitHub for its head.
  assert.equal(queue('pull_request', { action: 'edited', pull_request: { ...pr, body: 'Adds CRLF and CR support.' }, changes: { body: { from: pr.body } } }), 0);
  assert.equal(JSON.parse(review().input).trigger.reason, 'pull_request_edited'); finish(h);
  const conversation = { action: 'created', issue: { number: 7, state: 'open', user: { id: 5 }, pull_request: { url: 'https://api.github.invalid/pulls/7' } }, comment: { id: 40, body: 'Ready for another look.' } };
  assert.equal(pullRequestNeeded(h.store, '101', 'issue_comment', { repository: { id: 101 }, sender: user, ...conversation }), true);
  assert.equal(queue('issue_comment', conversation), 0); assert.equal(reviewed(), 0);
  // The round prepares the head GitHub has then, as a review moves to a new head.
  assert.equal(queue('issue_comment', { ...conversation, comment: { id: 41, body: 'Ready.' } }, { ...pr, head: { sha: 'd'.repeat(40) } }), 0);
  assert.equal(reviewed(), 1); assert.equal(JSON.parse(review().input).trigger.source.id, 41); finish(h);

  // The bot's own review comments, reviews and PR description edits, drafts and closed PRs never trigger.
  const botFinding = { ...replyComment, id: 50, in_reply_to_id: undefined, body: 'Off by one.\n\n<!-- dept-bot-finding:x -->' };
  for (const [event, payload] of [
    ['pull_request_review_comment', { action: 'created', pull_request: pr, comment: botFinding }],
    ['pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'commented', body: 'Reviewed commit.\n\n<!-- dept-bot:y -->' } }],
    ['pull_request_review', { action: 'submitted', sender: { type: 'Bot' }, pull_request: pr, review: { state: 'commented', body: 'Reviewed.' } }],
    ['pull_request', { action: 'edited', pull_request: { ...pr, body: 'Implemented.\n\n<!-- dept-bot:z -->' }, changes: { body: { from: 'x' } } }],
    ['pull_request_review_comment', { action: 'created', pull_request: { ...pr, draft: true }, comment: replyComment }],
    ['pull_request_review_comment', { action: 'created', pull_request: { ...pr, state: 'closed' }, comment: replyComment }],
    ['pull_request_review_comment', { action: 'edited', pull_request: pr, comment: replyComment }],
  ]) { assert.equal(queue(event, payload), 0, JSON.stringify(payload).slice(0, 80)); assert.equal(reviewed(), 0, JSON.stringify(payload).slice(0, 80)); }
  // Reviews and review comments from strangers do not count; a member's do.
  const stranger = { type: 'User', login: 'mallory', id: 9 };
  assert.equal(queue('pull_request_review_comment', { action: 'created', sender: stranger, pull_request: pr, comment: { ...replyComment, id: 60, author_association: 'NONE' } }), 0);
  assert.equal(queue('pull_request_review', { action: 'submitted', sender: stranger, pull_request: pr, review: { id: 61, state: 'commented', body: 'LGTM?', author_association: 'CONTRIBUTOR' } }), 0);
  assert.equal(reviewed(), 0);
  assert.equal(queue('pull_request_review', { action: 'submitted', sender: stranger, pull_request: pr, review: { id: 62, state: 'commented', body: 'Check the CR case.', author_association: 'MEMBER' } }), 0); assert.equal(reviewed(), 1); finish(h);
  // A person editing the bot's PR description still counts.
  assert.equal(queue('pull_request', { action: 'edited', sender: { type: 'User', login: 'bob', id: 6 }, pull_request: { ...pr, body: 'Implemented.\n\n<!-- dept-bot:z -->' }, changes: { title: { from: 'x' } } }), 0); assert.equal(reviewed(), 1); finish(h);

  await admin('/api/repositories/101/policy', 'PATCH', { review_pr_discussion: false });
  assert.equal(queue('pull_request_review_comment', { action: 'created', pull_request: pr, comment: replyComment }), 0);
  assert.equal(pullRequestNeeded(h.store, '101', 'issue_comment', { repository: { id: 101 }, sender: user, ...conversation }), false);
  assert.equal(updateTrigger('issue_comment', { action: 'created', sender: user, ...conversation }).kind, 'review.pr');
});

// A bot pull request and the Issue development that opened it (#1104): what a review of it found that the bot can change is
// offered to the Manager as a revision, with no budget; people's comments reach the Manager directly (dispatch.test.mjs).
async function botPullRequest(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('source','101','development.issue','pr_opened','source',?,1)", JSON.stringify({ review: { implementation_goal: 'Reject shipments larger than the stock.' } }));
  // Many revisions already: there is no budget any more.
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-source',?,'source',9)", 'c'.repeat(40));
  const engine = new TaskEngine(h.store, {}, undefined, undefined, acceptanceFixture); engine.owned = () => h.store.get('SELECT * FROM bot_pull_requests WHERE number=7');
  const task = { id: 'review', repository_id: '101', kind: 'review.pr', object_number: 7, head_sha: 'c'.repeat(40), source_delivery_id: null };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('review','101','review.pr','succeeded','review',7)");
  const finding = (body, actionable = true) => ({ body, format: 'discussion', selection_reason: 'x', actionable, within_goal: true, requires_human_decision: false });
  const revisions = () => h.store.all("SELECT * FROM tasks WHERE kind='development.pr' ORDER BY created_at,rowid");
  return { h, engine, task, finding, revisions };
}

test('a review of the bot\'s own pull request offers what it found as a revision, with no budget and one at a time (#1104)', async t => {
  const { h, engine, task, finding, revisions } = await botPullRequest(t);
  // Nothing the bot can change: nothing is offered.
  engine.queueDevelopment({}, task, { object: {} }, { findings: [finding('A question answered.', false)] }, true);
  assert.equal(revisions().length, 0);
  // Actionable findings become one revision, whatever triggered the review; only those findings go along.
  engine.queueDevelopment({}, task, { object: {}, comment: { id: 501, body: '@bot please review' } }, { findings: [finding('F1'), finding('Noted.', false)] }, true);
  assert.equal(revisions().length, 1);
  const input = JSON.parse(revisions()[0].input);
  assert.deepEqual([input.revision.source, input.review.implementation_goal, input.review.findings.map(f => f.body)], ['review', 'Reject shipments larger than the stock.', ['F1']]);
  // A second review while that revision is queued: still one revision of the pull request.
  engine.queueDevelopment({}, task, { object: {} }, { findings: [finding('F2')] }, true); assert.equal(revisions().length, 1);
  h.store.run("UPDATE tasks SET status='completed' WHERE kind='development.pr'");
  engine.queueDevelopment({}, { ...task, head_sha: 'd'.repeat(40) }, { object: {} }, { findings: [finding('F3')] }, true); assert.equal(revisions().length, 2);
});

test('a revision from a review that comments started counts for their authors, and the next review event carries the counts (#1104)', async t => {
  const { h, engine, task, finding, revisions } = await botPullRequest(t);
  const byBot = id => ({ object: {}, trigger: { reason: 'review_comment', actor: 'copilot[bot]', actor_id: '77', actor_type: 'Bot', url: `https://github.invalid/pull/7#discussion_r${id}`, source: { type: 'review_comment', id } } });
  engine.queueDevelopment({}, task, byBot(101), { findings: [finding('F1')] }, true);
  assert.equal(revisions().length, 1);
  assert.deepEqual(JSON.parse(revisions()[0].input).revision.asked_by.map(r => [r.id, r.author_type]), [['101', 'Bot']]);
  assert.equal(h.store.get("SELECT task_id FROM bot_pr_requests WHERE source_id='101'").task_id, revisions()[0].id);
  h.store.run("UPDATE tasks SET status='completed' WHERE kind='development.pr'");
  // The bot asks again through another review: the event tells the Manager the pull request was already revised for it.
  engine.queueDevelopment({}, { ...task, head_sha: 'd'.repeat(40) }, byBot(102), { findings: [finding('F2')] }, true);
  const last = h.store.get("SELECT facts FROM dispatch_events WHERE type='review.published' ORDER BY rowid DESC");
  assert.deepEqual(JSON.parse(last.facts).revisions, { for_requests: 1, for_this_author: 1 });
});

test('another review bot\'s requests have no limit of the control plane\'s own; the Manager gets the counts (#1104)', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-source',?,'source',0)", 'c'.repeat(40));
  const done = (id, author_id, author_type, task) => h.store.run("INSERT INTO bot_pr_requests VALUES('101',7,'review_comment',?,'x',?,?,'u','done',?,?)", String(id), author_id, author_type, task, new Date().toISOString());
  for (let i = 1; i <= 5; i++) done(i, '77', 'Bot', 'rev-' + i);
  done(6, '5', 'User', 'rev-6');
  const request = { type: 'review_comment', id: '20', author: 'copilot[bot]', author_id: '77', author_type: 'Bot', url: 'u', body: 'b' };
  assert.equal(enqueueRefusal(h.store, '101', 'development.pr', 7, 'c'.repeat(40), { revision: { source: 'request', requests: [request] } }), null);
  // The next comment of that bot reaches the Manager with how often the pull request was revised, and for whom.
  const pr = { number: 7, state: 'open', draft: false, head: { sha: 'c'.repeat(40) }, user: { id: 999 } }, copilot = { type: 'Bot', login: 'copilot[bot]', id: 77 };
  assert.equal(queueWebhook(h.store, '101', 'pull_request_review_comment', { repository: { id: 101 }, action: 'created', sender: copilot, pull_request: pr,
    comment: { id: 21, body: 'Still untested.', author_association: 'NONE', html_url: 'https://github.invalid/pull/7#discussion_r21', path: 'a.js', line: 3 } }, 'bot-21'), 1);
  const facts = JSON.parse(h.store.get("SELECT facts FROM dispatch_events WHERE type='pull_request.updated' ORDER BY rowid DESC").facts);
  assert.deepEqual(facts.revisions, { for_requests: 6, for_this_author: 5 });
});

test('the revision count of a bot pull request counts the revisions nobody asked for (informational since #1104)', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-source',?,'source',0)", 'a'.repeat(40));
  const count = () => ({ ...h.store.get('SELECT revisions,sha FROM bot_pull_requests WHERE number=7') });
  recordRevision(h.store, { repository_id: '101', input: JSON.stringify({ revision: { source: 'request' } }) }, 7, 'b'.repeat(40));
  assert.deepEqual(count(), { revisions: 0, sha: 'b'.repeat(40) });
  recordRevision(h.store, { repository_id: '101', input: JSON.stringify({ revision: { source: 'review' } }) }, 7, 'c'.repeat(40));
  recordRevision(h.store, { repository_id: '101', input: JSON.stringify({ revision: { source: 'review' } }) }, 7, 'c'.repeat(40));
  assert.deepEqual(count(), { revisions: 1, sha: 'c'.repeat(40) });
  // An older revision task without a recorded source counts, as before.
  recordRevision(h.store, { repository_id: '101', input: '{}' }, 7, 'd'.repeat(40)); assert.equal(count().revisions, 2);
});

test('another review bot\'s comments on the bot\'s own PR are reviewed; on other PRs, and the bot\'s own, they are not', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-source',?,'source',0)", 'c'.repeat(40));
  const head = 'c'.repeat(40), pr = { number: 7, state: 'open', draft: false, head: { sha: head }, user: { id: 999 } }, other = { type: 'Bot', login: 'copilot[bot]', id: 77 };
  let delivery = 0; const queue = (event, payload, current) => queueWebhook(h.store, '101', event, { repository: { id: 101 }, ...payload }, 'bot-delivery-' + (++delivery), current);
  const comment = { id: 90, body: 'This branch is untested.', author_association: 'NONE', html_url: 'https://github.invalid/pull/7#discussion_r90', path: 'a.js', line: 3 };
  assert.equal(queue('pull_request_review_comment', { action: 'created', sender: other, pull_request: pr, comment }), 1);
  assert.deepEqual(JSON.parse(updates(h).at(-1).input).trigger, { event: 'pull_request_review_comment', action: 'created', reason: 'review_comment', actor: 'copilot[bot]', actor_type: 'Bot', url: comment.html_url, path: 'a.js', line: 3, source: { type: 'review_comment', id: 90 }, actor_id: '77' });
  finish(h);
  // Later ones continue the PR's review as its next round (#770), with the other bot as the trigger.
  const round = () => h.store.get("SELECT status,input FROM tasks WHERE kind='review.pr' AND object_number=7");
  assert.equal(queue('pull_request_review', { action: 'submitted', sender: other, pull_request: pr, review: { id: 91, state: 'commented', body: 'Two findings.', author_association: 'NONE' } }), 0);
  assert.equal(round().status, 'queued'); assert.equal(JSON.parse(round().input).trigger.actor_type, 'Bot'); finish(h);
  const conversation = { action: 'created', sender: other, issue: { number: 7, state: 'open', user: { id: 999 }, pull_request: {} }, comment: { id: 92, body: 'Summary of changes.', author_association: 'NONE' } };
  assert.equal(pullRequestNeeded(h.store, '101', 'issue_comment', { repository: { id: 101 }, ...conversation }), true);
  assert.equal(queue('issue_comment', conversation, pr), 0); assert.equal(round().status, 'queued'); assert.equal(JSON.parse(round().input).round, 3); finish(h);
  for (const [name, payload] of [
    ['this bot', { action: 'created', sender: { type: 'Bot', login: 'fixture-bot[bot]', id: 999 }, pull_request: pr, comment: { ...comment, id: 93 } }],
    ['marked', { action: 'created', sender: other, pull_request: pr, comment: { ...comment, id: 94, body: 'x\n\n<!-- dept-bot:abc -->' } }],
    ['a person\'s PR', { action: 'created', sender: other, pull_request: { ...pr, number: 8, user: { id: 5 } }, comment: { ...comment, id: 95 } }],
  ]) { assert.equal(queue('pull_request_review_comment', payload), 0, name); assert.equal(round().status, 'succeeded', name); }
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1);
});

test('an Issue review continues the bot PR for that Issue with no revision budget (#1104)', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  const engine = new TaskEngine(h.store, {}, undefined, undefined, acceptanceFixture), result = { requires_code_change: true, clarification_required: false, findings: [] };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,summary) VALUES('dev-1','101','development.issue',1,'pr_opened','')");
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',9,'9009','999','101','bot/issue-1-dev-1','a',?,5)", 'dev-1');
  const task = { id: 'review', repository_id: '101', kind: 'review.issue', object_number: 1, source_delivery_id: null };
  const object = { title: 'Fix it', body: 'Please fix the parser.', labels: [] };
  const goAhead = { label: 'bot-develop', labeled_by: 'alice', assignees: [] };
  engine.queueDevelopment({}, task, { object, trigger: { reason: 'comment' } }, { ...result, implementation_goal: 'Fix the parser.' }, goAhead);
  const event = h.store.get("SELECT facts FROM dispatch_events WHERE type='review.published'");
  assert.equal(JSON.parse(event.facts).development.bot_pull_request, true);
});

test('a queued PR update review prepares the current head instead of being superseded', async t => {
  // The fixture serves the files of commit a…a, the PR's head by now.
  const current = { number: 1, state: 'open', draft: false, title: 'Change', body: '', head: { sha: 'a'.repeat(40) }, base: { ref: 'main' } };
  const h = await emptyRepositoryFixture(t, { github: (path, send) => {
    if (path.endsWith('/pulls/1')) { send(current); return true; }
    if (/\/pulls\/1\/(files|reviews|comments)$/.test(path)) { send([]); return true; }
  } });
  h.setBranch('ready'); h.store.run("UPDATE tasks SET kind='review.pr',head_sha=?,unique_key='101:review.pr:1:update:x',input=? WHERE id=?", 'c'.repeat(40), JSON.stringify({ trigger: { reason: 'pull_request_edited' } }), h.taskId);
  const task = await h.run(); assert.equal(task.status, 'succeeded'); assert.equal(task.head_sha, current.head.sha);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1);
});

