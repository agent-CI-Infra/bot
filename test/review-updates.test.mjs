import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { pullRequestNeeded, queueWebhook, updateTrigger } from '../dist/review/queue.js';
import { emptyRepositoryFixture } from './empty-repository-helpers.mjs';

// Reviews of what a person changes after an Issue or PR was opened: edits, comments, reviews and replies to review comments.
const user = { type: 'User', login: 'alice', id: 5 };
const finish = h => h.store.run("UPDATE tasks SET status='succeeded'");
const updates = h => h.store.all("SELECT * FROM tasks WHERE unique_key LIKE '%:update:%' ORDER BY created_at,rowid");

test('Issue edits and comments queue another review, merged while one waits; the bot and closed Issues never trigger', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const issue = { number: 1, state: 'open', title: 'Fix the parser', body: 'The parser drops the last line.', user: { id: 5 } };
  const send = (delivery, payload, event = 'issues') => h.hook(a.path, a.secret, delivery, { repository: { id: 101 }, sender: user, ...payload }, { 'X-GitHub-Event': event });
  assert.equal((await send('opened', { action: 'opened', issue })).value.tasks_created, 1); finish(h);

  // An edited body: the review sees what was there before.
  const edited = { action: 'edited', issue: { ...issue, body: 'The parser drops the last line of CRLF files.' }, changes: { body: { from: issue.body } } };
  assert.equal((await send('edited', edited)).value.tasks_created, 1);
  const [first] = updates(h), input = JSON.parse(first.input);
  assert.equal(first.kind, 'review.issue'); assert.equal(first.head_sha, null); assert.match(first.unique_key, /^101:review\.issue:1:update:/);
  assert.deepEqual(input.trigger, { event: 'issues', action: 'edited', reason: 'issue_edited', actor: 'alice', changed: ['body'], previous: { body: issue.body } });
  assert.equal((await send('edited', edited)).value.duplicate, true);
  // While that review waits, another edit and a comment join it instead of queueing more.
  assert.equal((await send('edited-again', { ...edited, changes: { title: { from: 'Old title' } } })).value.tasks_created, 0);
  assert.equal((await send('comment-while-waiting', { action: 'created', issue, comment: { id: 11, body: 'Also CR-only files.' } }, 'issue_comment')).value.tasks_created, 0);
  // The waiting review is told about both.
  assert.deepEqual(JSON.parse(updates(h)[0].input).merged_updates.map(update => update.reason), ['issue_edited', 'comment']);
  assert.equal(updates(h).length, 1); finish(h);

  // A comment from someone who neither wrote the Issue nor has a role in the repository reviews nothing; a collaborator's does.
  const stranger = { type: 'User', login: 'mallory', id: 9 };
  assert.equal((await send('stranger', { action: 'created', sender: stranger, issue, comment: { id: 17, body: 'Please.', author_association: 'NONE' } }, 'issue_comment')).value.tasks_created, 0);
  assert.equal((await send('collaborator', { action: 'created', sender: stranger, issue, comment: { id: 18, body: 'Confirmed.', author_association: 'COLLABORATOR' } }, 'issue_comment')).value.tasks_created, 1);
  finish(h);

  // A plain reply in the conversation reviews again with the comment as the trigger.
  const comment = { id: 12, body: 'I attached a sample file.', html_url: 'https://github.invalid/issue/1#issuecomment-12' };
  assert.equal((await send('comment', { action: 'created', issue, comment }, 'issue_comment')).value.tasks_created, 1);
  const reply = JSON.parse(updates(h).at(-1).input);
  assert.deepEqual(reply.comment, comment); assert.deepEqual(reply.trigger, { event: 'issue_comment', action: 'created', reason: 'comment', actor: 'alice', url: comment.html_url }); finish(h);

  // Nothing the bot writes, no edit that leaves the title and body alone, and nothing on a closed Issue triggers.
  for (const [delivery, payload, event] of [
    ['bot-app-comment', { action: 'created', sender: { type: 'Bot', login: 'app[bot]' }, issue, comment: { id: 13, body: 'Summary' } }, 'issue_comment'],
    ['bot-account-comment', { action: 'created', issue, comment: { id: 14, body: 'Summary\n\n<!-- dept-bot:abc -->' } }, 'issue_comment'],
    ['bot-edit', { ...edited, sender: { type: 'Bot' } }],
    ['other-edit', { ...edited, changes: { milestone: { from: null } } }],
    ['closed-edit', { ...edited, issue: { ...edited.issue, state: 'closed' } }],
    ['closed-comment', { action: 'created', issue: { ...issue, state: 'closed' }, comment: { id: 15, body: 'Reopen?' } }, 'issue_comment'],
    ['edited-comment', { action: 'edited', issue, comment: { id: 12, body: 'I attached two sample files.' } }, 'issue_comment'],
  ]) assert.equal((await send(delivery, payload, event)).value.tasks_created, 0, delivery);

  // Each switch turns its trigger off; Issue updates also need Issue review on.
  await admin('/api/repositories/101/policy', 'PATCH', { review_issue_updates: false });
  assert.equal((await send('updates-off', { action: 'created', issue, comment: { id: 16, body: 'More detail.' } }, 'issue_comment')).value.tasks_created, 0);
  await admin('/api/repositories/101/policy', 'PATCH', { review_issue_updates: true, review_issues: false });
  assert.equal((await send('issues-off', { ...edited, changes: { title: { from: 'x' } } })).value.tasks_created, 0);
  assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { review_pr_discussion: 'yes' })).status, 400);
  const policy = (await admin('/api/repositories/101')).value.policy; assert.deepEqual([policy.review_issue_updates, policy.review_pr_discussion], [1, 1]);
  assert.equal(updates(h).length, 3);
});

test('PR comments, reviews, replies to review comments and description edits review the current head once', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const head = 'c'.repeat(40), pr = { number: 7, state: 'open', draft: false, head: { sha: head }, user: { id: 5 }, body: 'Adds CRLF support.' };
  let delivery = 0; const queue = (event, payload, current) => queueWebhook(h.store, '101', event, { repository: { id: 101 }, sender: user, ...payload }, 'delivery-' + (++delivery), current);

  // A reply to a review comment: reviewed at the PR head, with the reply as the trigger comment.
  const replyComment = { id: 21, body: 'Fixed in the latest push.', in_reply_to_id: 20, path: 'src/parse.js', line: 12, html_url: 'https://github.invalid/pull/7#discussion_r21' };
  assert.equal(queue('pull_request_review_comment', { action: 'created', pull_request: pr, comment: replyComment }), 1);
  let task = updates(h).at(-1), input = JSON.parse(task.input);
  assert.equal(task.kind, 'review.pr'); assert.equal(task.head_sha, head); assert.deepEqual(input.comment, replyComment);
  assert.deepEqual(input.trigger, { event: 'pull_request_review_comment', action: 'created', reason: 'review_reply', actor: 'alice', url: replyComment.html_url, path: 'src/parse.js', line: 12 });
  // The review GitHub wraps around that reply has no body and joins the same review; so does anything else while it waits.
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'commented', body: null } }), 0);
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'commented', body: 'Please look again.' } }), 0);
  assert.equal(updates(h).length, 1); finish(h);

  // A submitted review with a body, or one asking for changes, reviews again.
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { id: 30, state: 'commented', body: 'Please look again.', html_url: 'https://github.invalid/pull/7#pullrequestreview-30' } }), 1);
  assert.deepEqual(JSON.parse(updates(h).at(-1).input).trigger, { event: 'pull_request_review', action: 'submitted', reason: 'review_submitted', actor: 'alice', state: 'commented', body: 'Please look again.', url: 'https://github.invalid/pull/7#pullrequestreview-30' }); finish(h);
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'changes_requested', body: '' } }), 1); finish(h);
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'approved', body: '' } }), 0);

  // An edited description reviews again; a conversation comment needs the PR read from GitHub for its head.
  assert.equal(queue('pull_request', { action: 'edited', pull_request: { ...pr, body: 'Adds CRLF and CR support.' }, changes: { body: { from: pr.body } } }), 1);
  assert.equal(JSON.parse(updates(h).at(-1).input).trigger.reason, 'pull_request_edited'); finish(h);
  const conversation = { action: 'created', issue: { number: 7, state: 'open', user: { id: 5 }, pull_request: { url: 'https://api.github.invalid/pulls/7' } }, comment: { id: 40, body: 'Ready for another look.' } };
  assert.equal(pullRequestNeeded(h.store, '101', 'issue_comment', { repository: { id: 101 }, sender: user, ...conversation }), true);
  assert.equal(queue('issue_comment', conversation), 0);
  assert.equal(queue('issue_comment', { ...conversation, comment: { id: 41, body: 'Ready.' } }, { ...pr, head: { sha: 'd'.repeat(40) } }), 1);
  assert.equal(updates(h).at(-1).head_sha, 'd'.repeat(40)); finish(h);

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
  ]) assert.equal(queue(event, payload), 0, JSON.stringify(payload).slice(0, 80));
  // Reviews and review comments from strangers do not count; a member's do.
  const stranger = { type: 'User', login: 'mallory', id: 9 };
  assert.equal(queue('pull_request_review_comment', { action: 'created', sender: stranger, pull_request: pr, comment: { ...replyComment, id: 60, author_association: 'NONE' } }), 0);
  assert.equal(queue('pull_request_review', { action: 'submitted', sender: stranger, pull_request: pr, review: { id: 61, state: 'commented', body: 'LGTM?', author_association: 'CONTRIBUTOR' } }), 0);
  assert.equal(queue('pull_request_review', { action: 'submitted', sender: stranger, pull_request: pr, review: { id: 62, state: 'commented', body: 'Check the CR case.', author_association: 'MEMBER' } }), 1); finish(h);
  // A person editing the bot's PR description still counts.
  assert.equal(queue('pull_request', { action: 'edited', sender: { type: 'User', login: 'bob', id: 6 }, pull_request: { ...pr, body: 'Implemented.\n\n<!-- dept-bot:z -->' }, changes: { title: { from: 'x' } } }), 1); finish(h);

  await admin('/api/repositories/101/policy', 'PATCH', { review_pr_discussion: false });
  assert.equal(queue('pull_request_review_comment', { action: 'created', pull_request: pr, comment: replyComment }), 0);
  assert.equal(pullRequestNeeded(h.store, '101', 'issue_comment', { repository: { id: 101 }, sender: user, ...conversation }), false);
  assert.equal(updateTrigger('issue_comment', { action: 'created', sender: user, ...conversation }).kind, 'review.pr');
});

test('an update review of a PR never starts a bot PR revision or a head-triggered review', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  const engine = new TaskEngine(h.store, {}), result = { requires_code_change: true, clarification_required: false, findings: [{ actionable: true, within_goal: true, requires_human_decision: false }] };
  let ownershipChecks = 0; engine.owned = () => { ownershipChecks++; return { source_task_id: 'source', revisions: 0 }; };
  const task = { id: 'review', repository_id: '101', kind: 'review.pr', object_number: 7, head_sha: 'c'.repeat(40), source_delivery_id: null };
  engine.queueDevelopment({}, task, { object: {}, trigger: { reason: 'pull_request_edited' } }, result, true);
  assert.equal(ownershipChecks, 0); assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.pr'").n, 0);
});

test('an Issue review continues the bot PR for that Issue only within the revision budget', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true, max_revisions: 2 });
  const engine = new TaskEngine(h.store, {}), result = { requires_code_change: true, clarification_required: false, findings: [] };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,summary) VALUES('dev-1','101','development.issue',1,'pr_opened','')");
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',9,'9009','999','101','bot/issue-1-dev-1','a',?,2)", 'dev-1');
  const task = { id: 'review', repository_id: '101', kind: 'review.issue', object_number: 1, source_delivery_id: null };
  const object = { title: 'Fix it', body: 'Please fix the parser.', labels: [] }, development = () => h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.issue' AND id<>'dev-1'").n;
  const requested = { ...result, request_quote: 'Please fix the parser.', issue_requests_code: true, implementation_goal: 'Fix the parser.' };
  engine.queueDevelopment({}, task, { object, trigger: { reason: 'comment' } }, requested, true); assert.equal(development(), 0);
  h.store.run("UPDATE bot_pull_requests SET revisions=1"); h.store.run("UPDATE tasks SET status='completed' WHERE id='dev-1'");
  engine.queueDevelopment({}, task, { object, trigger: { reason: 'comment' } }, requested, true); assert.equal(development(), 1);
});

test('a stale PR update review is superseded without queueing a head-triggered review', async t => {
  const current = { number: 1, state: 'open', draft: false, head: { sha: 'd'.repeat(40) } };
  const h = await emptyRepositoryFixture(t, { github: (path, send) => { if (path.endsWith('/pulls/1')) { send(current); return true; } } });
  h.store.run("UPDATE tasks SET kind='review.pr',head_sha=?,unique_key='101:review.pr:1:update:x',input=? WHERE id=?", 'c'.repeat(40), JSON.stringify({ trigger: { reason: 'pull_request_edited' } }), h.taskId);
  const task = await h.run(); assert.equal(task.status, 'superseded'); assert.equal(task.error_code, 'pull_request_head_changed');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1);
});
