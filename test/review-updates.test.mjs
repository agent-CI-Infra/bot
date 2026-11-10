import { acceptanceFixture } from './acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from './helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { recordRevision } from '../dist/github/publisher.js';
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
  assert.deepEqual(input.trigger, { event: 'pull_request_review_comment', action: 'created', reason: 'review_reply', actor: 'alice', url: replyComment.html_url, path: 'src/parse.js', line: 12, source: { type: 'review_comment', id: 21 }, actor_id: '5' });
  // The review GitHub wraps around that reply has no body and joins the same review; so does anything else while it waits.
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'commented', body: null } }), 0);
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { state: 'commented', body: 'Please look again.' } }), 0);
  assert.equal(updates(h).length, 1); finish(h);

  // A submitted review with a body, or one asking for changes, reviews again.
  assert.equal(queue('pull_request_review', { action: 'submitted', pull_request: pr, review: { id: 30, state: 'commented', body: 'Please look again.', html_url: 'https://github.invalid/pull/7#pullrequestreview-30' } }), 1);
  assert.deepEqual(JSON.parse(updates(h).at(-1).input).trigger, { event: 'pull_request_review', action: 'submitted', reason: 'review_submitted', actor: 'alice', state: 'commented', body: 'Please look again.', url: 'https://github.invalid/pull/7#pullrequestreview-30', source: { type: 'review', id: 30 }, actor_id: '5' }); finish(h);
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

// A bot pull request, the Issue development that opened it, and a GitHub that holds the text of the comments a review cites.
// `offered` are the comments a review answered, as the queue lets them in: members' and other bots', never strangers'.
async function botPullRequest(t, maxRevisions = 1) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true, max_revisions: maxRevisions });
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number) VALUES('source','101','development.issue','pr_opened','source',?,1)", JSON.stringify({ review: { implementation_goal: 'Reject shipments larger than the stock.' } }));
  // The PR has used up its revision budget: requests do not need it.
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',7,'55','999','101','bot/issue-1-source',?,'source',5)", 'c'.repeat(40));
  const engine = new TaskEngine(h.store, {}, undefined, undefined, acceptanceFixture); engine.owned = () => h.store.get('SELECT * FROM bot_pull_requests WHERE number=7');
  const text = { '/issues/comments/11': 'Please name the SKU in the error.', '/issues/comments/15': 'Also log it.', '/pulls/comments/21': 'This branch is untested.',
    '/pulls/comments/22': 'Rename the variable.', '/pulls/7/reviews/31': 'Line too long.', '/issues/comments/13': 'Summary' };
  const github = { actorId: '999', path: path => path, request: async (_method, path) => { if (!(path in text)) throw new Error('404 ' + path); return { body: text[path] }; } };
  const offer = (type, id, author, author_id, author_type = 'User') => ({ type, id, author, author_id, author_type, url: `https://github.invalid/${type}/${id}` });
  const offered = [offer('comment', 11, 'alice', '5'), offer('comment', 15, 'alice', '5'), offer('review_comment', 21, 'copilot[bot]', '77', 'Bot'),
    offer('review_comment', 22, 'copilot[bot]', '77', 'Bot'), offer('review', 31, 'lint[bot]', '78', 'Bot'), offer('comment', 13, 'fixture-bot', '999', 'Bot')];
  const task = { id: 'review', repository_id: '101', kind: 'review.pr', object_number: 7, head_sha: 'c'.repeat(40), source_delivery_id: null };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,object_number) VALUES('review','101','review.pr','succeeded','review',7)");
  const finding = (requested_in, body = 'F1') => ({ body, format: 'discussion', selection_reason: 'x', actionable: true, within_goal: true, requires_human_decision: false, ...(requested_in ? { requested_in } : {}) });
  const review = async (findings, input = { object: {}, trigger: { reason: 'comment', actor: 'alice' } }) => {
    const result = { requires_code_change: true, clarification_required: false, findings };
    input = { ...input, context: { discussion_requests: input.context?.discussion_requests ?? offered } };
    const requests = await engine.revisionRequests(github, task, result, input);
    engine.queueDevelopment(github, task, input, result, false, requests);
    return requests;
  };
  const revisions = () => h.store.all("SELECT * FROM tasks WHERE kind='development.pr' ORDER BY created_at,rowid");
  const finish = () => h.store.run("UPDATE tasks SET status='completed' WHERE kind='development.pr'");
  return { h, engine, review, finding, revisions, finish, offered, task };
}

test('a member\'s request on the bot\'s own PR revises it without a budget; questions, strangers and the bot itself do not', async t => {
  const { h, review, finding, revisions, finish } = await botPullRequest(t);
  // Only a comment the review answered counts: a stranger's never got in (12), the bot's own is refused (13), and one the
  // review did not answer (14, another PR) is unknown. The bot's own finding of the same review goes along.
  const requests = await review([finding({ type: 'comment', id: 11 }, 'F1'), finding({ type: 'comment', id: 12 }), finding({ type: 'comment', id: 13 }), finding({ type: 'comment', id: 14 }), finding(null, 'F2')]);
  assert.deepEqual(requests.map(r => [r.type, r.id, r.author, r.author_type, r.body]), [['comment', '11', 'alice', 'User', 'Please name the SKU in the error.']]);
  let [revision] = revisions(), input = JSON.parse(revision.input);
  assert.equal(revisions().length, 1);
  assert.deepEqual([input.revision.source, input.revision.requests.map(r => r.id), input.review.findings.map(f => f.body)], ['request', ['11'], ['F1', 'F2']]);
  assert.match(revision.unique_key, /:requests:comment:11$/);
  finish();
  // The same comment never revises twice; a review that only answers a question revises nothing.
  await review([finding({ type: 'comment', id: 11 })]); assert.equal(revisions().length, 1);
  await review([{ ...finding(null), actionable: false }]); assert.equal(revisions().length, 1);
  // A request the review leaves to a person (requires_human_decision) is not acted on.
  await review([{ ...finding({ type: 'comment', id: 15 }), requires_human_decision: true }]); assert.equal(revisions().length, 1);
  // A later request of a member revises again, still without a budget.
  await review([finding({ type: 'comment', id: 15 })]); assert.equal(revisions().length, 2); finish();
  assert.deepEqual(h.store.all("SELECT source_id,state FROM bot_pr_requests ORDER BY source_id").map(r => [r.source_id, r.state]), [['11', 'done'], ['15', 'done']]);
});

test('a member\'s comment that started the review stands for the changes it found when the review named no request', async t => {
  const { review, finding, revisions, finish } = await botPullRequest(t);
  const asked = (source, extra = {}) => ({ object: {}, trigger: { reason: 'comment', actor: 'alice', source, ...extra } });
  // Another bot's comment never stands in, merged updates make the trigger ambiguous, and a review with nothing to change
  // (it answered a question) revises nothing.
  await review([finding(null)], asked({ type: 'review_comment', id: 21 }, { actor_type: 'Bot', actor: 'copilot[bot]' })); assert.equal(revisions().length, 0);
  await review([finding(null)], { ...asked({ type: 'comment', id: 11 }), merged_updates: [{ reason: 'comment' }] }); assert.equal(revisions().length, 0);
  await review([{ ...finding(null), actionable: false }], asked({ type: 'comment', id: 11 })); assert.equal(revisions().length, 0);
  // The member's comment that started it: its changes revise the PR, once, each finding once.
  await review([finding(null, 'F1'), finding(null, 'F2')], asked({ type: 'comment', id: 11 }));
  const input = JSON.parse(revisions()[0].input);
  assert.deepEqual([revisions().length, input.revision.requests.map(r => r.id), input.review.findings.map(f => f.body)], [1, ['11'], ['F1', 'F2']]);
  finish();
  await review([finding(null)], asked({ type: 'comment', id: 11 })); assert.equal(revisions().length, 1);
  // A trigger the queue never let in (a stranger) is not among the comments the review answered.
  await review([finding(null)], asked({ type: 'comment', id: 12 })); assert.equal(revisions().length, 1);
});

test('another review bot revises the bot\'s PR at most once, and a request waits while a revision runs', async t => {
  const { h, review, finding, revisions, finish, task } = await botPullRequest(t);
  await review([finding({ type: 'review_comment', id: 21 })]); assert.equal(revisions().length, 1);
  assert.equal(JSON.parse(revisions()[0].input).revision.requests[0].author_type, 'Bot'); finish();
  // The same bot again, on another comment: no second revision. A different bot gets its one.
  await review([finding({ type: 'review_comment', id: 22 })]); assert.equal(revisions().length, 1);
  await review([finding({ type: 'review', id: 31 })]); assert.equal(revisions().length, 2);
  // While that revision is queued, a member's request waits as pending, and a later review lists it again.
  await review([finding({ type: 'comment', id: 15 })]); assert.equal(revisions().length, 2);
  assert.equal(h.store.get("SELECT state FROM bot_pr_requests WHERE source_id='15'").state, 'pending');
  assert.ok(h.store.all("SELECT content FROM task_logs WHERE task_id='review'").some(l => JSON.parse(l.content).type === 'revision_deferred'));
  const { discussionRequests } = await import('../dist/agent/engine.js');
  assert.deepEqual(discussionRequests(h.store, task, {}).map(r => [r.type, r.id, r.author, r.pending]), [['comment', 15, 'alice', true]]);
  finish();
  await review([finding({ type: 'comment', id: 15 })], { object: {}, context: { discussion_requests: discussionRequests(h.store, task, {}) } });
  assert.equal(revisions().length, 3);
  assert.equal(h.store.get("SELECT state FROM bot_pr_requests WHERE source_id='15'").state, 'done');
});

test('without a request, an update review of the bot\'s PR never revises, and its own findings keep the revision budget', async t => {
  const { h, engine, finding, revisions } = await botPullRequest(t, 1);
  const task = { id: 'review', repository_id: '101', kind: 'review.pr', object_number: 7, head_sha: 'c'.repeat(40), source_delivery_id: null };
  const result = { requires_code_change: true, clarification_required: false, findings: [finding(null)] };
  engine.queueDevelopment({}, task, { object: {}, trigger: { reason: 'pull_request_edited' } }, result, true);
  assert.equal(revisions().length, 0);
  // A head review with only its own findings: the budget (5 used of 1) stops it.
  engine.queueDevelopment({}, task, { object: {} }, result, true); assert.equal(revisions().length, 0);
  h.store.run('UPDATE bot_pull_requests SET revisions=0');
  engine.queueDevelopment({}, task, { object: {} }, result, true); assert.equal(revisions().length, 1);
  assert.equal(JSON.parse(revisions()[0].input).revision.source, 'review');
});

test('a revision someone asked for does not use the revision budget; one from the bot\'s own review does', async t => {
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
  assert.equal(queue('pull_request_review', { action: 'submitted', sender: other, pull_request: pr, review: { id: 91, state: 'commented', body: 'Two findings.', author_association: 'NONE' } }), 1); finish(h);
  const conversation = { action: 'created', sender: other, issue: { number: 7, state: 'open', user: { id: 999 }, pull_request: {} }, comment: { id: 92, body: 'Summary of changes.', author_association: 'NONE' } };
  assert.equal(pullRequestNeeded(h.store, '101', 'issue_comment', { repository: { id: 101 }, ...conversation }), true);
  assert.equal(queue('issue_comment', conversation, pr), 1); finish(h);
  for (const [name, payload] of [
    ['this bot', { action: 'created', sender: { type: 'Bot', login: 'fixture-bot[bot]', id: 999 }, pull_request: pr, comment: { ...comment, id: 93 } }],
    ['marked', { action: 'created', sender: other, pull_request: pr, comment: { ...comment, id: 94, body: 'x\n\n<!-- dept-bot:abc -->' } }],
    ['a person\'s PR', { action: 'created', sender: other, pull_request: { ...pr, number: 8, user: { id: 5 } }, comment: { ...comment, id: 95 } }],
  ]) assert.equal(queue('pull_request_review_comment', payload), 0, name);
});

test('an Issue review continues the bot PR for that Issue only within the revision budget', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true, max_revisions: 2 });
  const engine = new TaskEngine(h.store, {}, undefined, undefined, acceptanceFixture), result = { requires_code_change: true, clarification_required: false, findings: [] };
  h.store.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,summary) VALUES('dev-1','101','development.issue',1,'pr_opened','')");
  h.store.run("INSERT INTO bot_pull_requests VALUES('101',9,'9009','999','101','bot/issue-1-dev-1','a',?,2)", 'dev-1');
  const task = { id: 'review', repository_id: '101', kind: 'review.issue', object_number: 1, source_delivery_id: null };
  const object = { title: 'Fix it', body: 'Please fix the parser.', labels: [] }, development = () => h.store.get("SELECT count(*) n FROM tasks WHERE kind='development.issue' AND id<>'dev-1'").n;
  const requested = { ...result, request_quote: 'Please fix the parser.', issue_requests_code: true, implementation_goal: 'Fix the parser.' };
  const goAhead = { label: 'bot-develop', labeled_by: 'alice', assignees: [] };
  engine.queueDevelopment({}, task, { object, trigger: { reason: 'comment' } }, requested, goAhead); assert.equal(development(), 0);
  h.store.run("UPDATE bot_pull_requests SET revisions=1"); h.store.run("UPDATE tasks SET status='completed' WHERE id='dev-1'");
  engine.queueDevelopment({}, task, { object, trigger: { reason: 'comment' } }, requested, goAhead); assert.equal(development(), 1);
});

test('a stale PR update review is superseded without queueing a head-triggered review', async t => {
  const current = { number: 1, state: 'open', draft: false, head: { sha: 'd'.repeat(40) } };
  const h = await emptyRepositoryFixture(t, { github: (path, send) => { if (path.endsWith('/pulls/1')) { send(current); return true; } } });
  h.store.run("UPDATE tasks SET kind='review.pr',head_sha=?,unique_key='101:review.pr:1:update:x',input=? WHERE id=?", 'c'.repeat(40), JSON.stringify({ trigger: { reason: 'pull_request_edited' } }), h.taskId);
  const task = await h.run(); assert.equal(task.status, 'superseded'); assert.equal(task.error_code, 'pull_request_head_changed');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1);
});

test('an Issue the review found ready says why development has not started: no label or an app\'s label; an assignee is the Manager\'s judgement', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  const engine = new TaskEngine(h.store, {}, undefined, undefined, acceptanceFixture), task = { id: 'review', repository_id: '101', kind: 'review.issue', object_number: 1 };
  const object = { title: 'Fix it', body: 'Please fix the parser.' };
  const result = { requires_code_change: true, clarification_required: false, issue_requests_code: true, implementation_goal: 'Fix the parser.', request_quote: 'Please fix the parser.', findings: [] };
  let issue = {}, events = [];
  const github = { path: path => path, object: async () => issue, pages: async () => events };
  const wait = () => engine.developmentWait(github, task, { object }, result);
  issue = { labels: [], assignees: [] }; assert.deepEqual(await wait(), { reason: 'label', label: 'bot-develop' });
  // Someone assigned does not hold development back by itself: the Manager reads the assignees when it is offered.
  issue = { labels: [{ name: 'Bot-Develop' }], assignees: [] }; events = [{ event: 'labeled', label: { name: 'bot-develop' }, actor: { type: 'Bot' } }];
  assert.deepEqual(await wait(), { reason: 'app', label: 'bot-develop' });
  events.push({ event: 'labeled', label: { name: 'bot-develop' }, actor: { type: 'User' } }); assert.equal(await wait(), null);
  issue = { labels: [{ name: 'bot-develop' }], assignees: [{ login: 'alice' }] }; assert.equal(await wait(), null);
  // Nothing to say when the review found no explicit code request, or development is off.
  issue = { labels: [], assignees: [] };
  assert.equal(await engine.developmentWait(github, task, { object }, { ...result, issue_requests_code: false }), null);
  await admin('/api/repositories/101/policy', 'PATCH', { development_enabled: false }); assert.equal(await wait(), null);
});
