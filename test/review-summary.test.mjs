import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from './helpers.mjs';
import { enqueue } from '../dist/review/queue.js';
import { GitHub } from '../dist/github/client.js';
import { Publisher } from '../dist/github/publisher.js';
import { Redactor } from '../dist/agent/common.js';
import { validateReview } from '../dist/review/findings.js';
import { reviewLanguage, summaryComment, promptedBy, humanItems, implementationText } from '../dist/github/text.js';
import { appGaps } from '../dist/app/access.js';

// A fake GitHub for one pull request (#7): conversation comments that can be edited, reviews with inline comments, and the
// GraphQL review threads those comments start. `deny` makes GraphQL refuse the way GitHub does for a missing permission.
async function fixture(t) {
  const state = { comments: [], reviewComments: [], reviews: [], threads: [], requests: [], mutations: [], tokens: [], revoked: [], deny: false, grant: true, next: 100 };
  const repo = '/repos/fixture/project-101';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, path = new URL(req.url, 'http://fixture').pathname;
    state.requests.push(`${req.method} ${path}`);
    const auth = String(req.headers.authorization || '').replace('Bearer ', '');
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const comment = /^\/repos\/fixture\/project-101\/issues\/comments\/(\d+)$/.exec(path);
    if (path === repo + '/issues/7/comments') {
      if (req.method === 'POST') { const value = { id: state.next++, body: body.body, user: { id: 999 }, html_url: `https://github.invalid/pull/7#issuecomment-${state.next}` }; state.comments.push(value); return send(value, 201); }
      return send(state.comments);
    }
    if (comment) {
      const found = state.comments.find(c => String(c.id) === comment[1]); if (!found) return send({ message: 'Not Found' }, 404);
      if (req.method === 'PATCH') found.body = body.body;
      return send(found);
    }
    if (path === repo + '/pulls/7/reviews' && req.method === 'POST') {
      const review = { id: state.next++, user: { id: 999 }, commit_id: body.commit_id, body: body.body, html_url: 'https://github.invalid/pull/7#review' };
      state.reviews.push(review);
      for (const c of body.comments) {
        const id = state.next++, value = { id, body: c.body, path: c.path, line: c.line, user: { id: 999 }, in_reply_to_id: null, commit_id: body.commit_id, original_commit_id: body.commit_id,
          pull_request_review_id: review.id, html_url: `https://github.invalid/pull/7#discussion_r${id}` };
        state.reviewComments.push(value); state.threads.push({ id: 'thread-' + id, isResolved: false, first: id });
      }
      return send(review);
    }
    if (path === repo + '/pulls/7/reviews') return send(state.reviews);
    const reviewComments = /^\/repos\/fixture\/project-101\/pulls\/7\/reviews\/(\d+)\/comments$/.exec(path);
    if (reviewComments) return send(state.reviewComments.filter(c => String(c.pull_request_review_id) === reviewComments[1]));
    if (path === repo + '/pulls/7/comments') return send(state.reviewComments);
    // The App mints a token for one installation; GitHub refuses permissions the installation was not granted.
    if (path === '/app/installations/55/access_tokens') {
      if (!state.grant) return send({ message: 'The permissions requested are not granted to this installation.' }, 422);
      state.tokens.push(body); return send({ token: 'ghs_scoped_' + state.tokens.length }, 201);
    }
    if (path === '/installation/token' && req.method === 'DELETE') { state.revoked.push(auth); res.writeHead(204); return res.end(); }
    if (path === '/graphql') {
      if (state.deny) return send({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
      if (body.query.startsWith('mutation')) { state.mutations.push(auth); const thread = state.threads.find(th => th.id === body.variables.id); thread.isResolved = true; return send({ data: { resolveReviewThread: { thread } } }); }
      return send({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null },
        nodes: state.threads.map(th => ({ id: th.id, isResolved: th.isResolved, comments: { nodes: [{ databaseId: th.first }] } })) } } } } });
    }
    send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const logs = [];
  // Each review is its own task at its own head, as the engine queues them.
  const review = async (head, result, options = { language: 'zh' }, app = true) => {
    const id = enqueue(h.store, '101', 'review.pr', 7, head.repeat(40), { number: 7 }), task = h.store.get('SELECT * FROM tasks WHERE id=?', id);
    const github = new GitHub(h.store, h.store.get("SELECT * FROM repositories WHERE id='101'"), new Redactor(), async () => {}, 'http://127.0.0.1:' + server.address().port);
    // An App account keeps its JWT and installation from connect, which the fixture skips.
    Object.assign(github, { token: 'ghs_fixture', fullName: 'fixture/project-101', actorId: '999' }, app ? { jwt: 'eyJfixture', installationId: '55' } : {});
    const outputs = await new Publisher(h.store, github, task, async () => {}, undefined, entry => logs.push(entry)).review(
      { findings: [], coverage: ['all files'], ...result, reviewed_sha: head.repeat(40) }, files, options);
    h.store.run("UPDATE tasks SET status='succeeded' WHERE id=?", id);
    return { id, outputs };
  };
  return { h, state, review, logs };
}
const files = [{ filename: 'src/parse.js', patch: '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = a + 1;\n const c = 3;' }];
const inlineFinding = { id: 'f-inline', body: 'Off by one: `b` should be `a`.', format: 'inline', selection_reason: 'line', path: 'src/parse.js', line: 2, side: 'RIGHT', requires_human_decision: false };
const decision = { id: 'f-decision', body: 'Whether the old parser stays as a fallback is not decided.\n\nKeeping it doubles the test matrix.', format: 'discussion', selection_reason: 'design',
  requires_human_decision: true, human_action: '决定旧解析器是否保留为回退路径' };

test('needs a person are named first and listed last; later reviews edit the first summary comment and resolve fixed threads', async t => {
  const f = await fixture(t);
  // The first review: an inline finding and one a maintainer has to decide.
  await f.review('a', { summary: '检视了解析器改动，发现两个问题。', findings: [inlineFinding, decision] });
  assert.equal(f.state.comments.length, 1);
  const first = f.state.comments[0].body, [top] = first.split('\n\n');
  assert.equal(top, '> [!IMPORTANT]\n> 需要人工处理 1 项：决定旧解析器是否保留为回退路径。汇总见文末。');
  // Items that end in their own punctuation run together in the alert without it.
  assert.match(summaryComment({ language: 'zh', overview: 'o', discussion: [], coverage: 'c', resolved: [], human: [{ text: '确认比例。' }, { text: '确认叠加规则；' }] }),
    /^> \[!IMPORTANT\]\n> 需要人工处理 2 项：确认比例；确认叠加规则。汇总见文末。/);
  assert.match(first, /\*\*\[需要人工处理\]\*\* Whether the old parser stays/);
  assert.match(first, /### 需要人工处理（1 项）\n\n1\. 决定旧解析器是否保留为回退路径\n\n<!-- dept-bot:[a-f0-9]+ -->$/);
  assert.ok(!first.includes('第 1 次检视'));

  // The author pushes a fix and replies; the second review edits the same comment, names whom it answers and resolves the thread.
  const inline = f.state.reviewComments[0];
  const second = await f.review('b', { summary: '修复已确认。', resolved_comments: [inline.id], findings: [decision] }, { language: 'zh', trigger: { actor: 'alice', url: 'https://github.invalid/c/1' } });
  assert.equal(f.state.comments.length, 1, 'no second summary comment');
  assert.ok(f.state.requests.includes(`PATCH /repos/fixture/project-101/issues/comments/${f.state.comments[0].id}`));
  const edited = f.state.comments[0].body;
  assert.match(edited, /^\*第 2 次检视，更新于 \d{4}-\d\d-\d\d \d\d:\d\d UTC，检视提交 bbbbbbb；回应 @alice 的\[评论\]\(https:\/\/github\.invalid\/c\/1\)\*\n\n> \[!IMPORTANT\]/);
  assert.match(edited, new RegExp(`已关闭 1 条后续提交已修复的行内意见：\\[src/parse\\.js:2\\]\\(${inline.html_url.replace(/[.?]/g, '\\$&')}\\)。`));
  assert.equal(f.state.threads[0].isResolved, true);
  // Resolving takes contents: write, which the review token lacks: a token for this repository is made for it and revoked.
  assert.deepEqual(f.state.tokens, [{ repository_ids: [101], permissions: { contents: 'write', pull_requests: 'write' } }]);
  assert.deepEqual([f.state.mutations, f.state.revoked], [['ghs_scoped_1'], ['ghs_scoped_1']]);
  assert.deepEqual(second.outputs.at(-1).resolved_threads, [inline.id]);
  assert.deepEqual(f.logs.filter(l => l.type === 'review_threads_resolved').map(l => l.comments), [[inline.id]]);
});

test('only the bot\'s own top-level comments on an earlier commit are resolved; a refused permission leaves threads open', async t => {
  const f = await fixture(t);
  await f.review('a', { summary: 'first', findings: [inlineFinding] }, { language: 'en' });
  const own = f.state.reviewComments[0];
  // A person's comment, a reply, and a bot comment on the head being reviewed are never resolved.
  f.state.reviewComments.push({ ...own, id: 501, user: { id: 5 } }, { ...own, id: 502, in_reply_to_id: own.id }, { ...own, id: 503, original_commit_id: 'c'.repeat(40) });
  f.state.threads.push(...[501, 502, 503].map(id => ({ id: 'thread-' + id, isResolved: false, first: id })));
  await f.review('c', { summary: 'second', resolved_comments: [501, 502, 503] }, { language: 'en' });
  assert.ok(f.state.threads.every(th => !th.isResolved));
  assert.deepEqual([f.state.mutations, f.state.tokens], [[], []]);
  // An installation that does not grant contents: write: the review is published anyway and the task log says why.
  f.state.grant = false;
  const { outputs } = await f.review('d', { summary: 'third', resolved_comments: [own.id] }, { language: 'en' });
  assert.equal(f.state.threads[0].isResolved, false); assert.equal(outputs.at(-1).resolved_threads, undefined);
  assert.deepEqual(f.logs.filter(l => l.type === 'review_threads_unresolved').map(l => l.code), ['github_http_422']);
  assert.match(f.state.comments[0].body, /^\*Review 3, updated .* UTC, reviewed commit ddddddd\*\n\nthird/);
  // A Token account resolves with its own token; GitHub refusing the mutation is logged the same way.
  f.state.deny = true;
  await f.review('e', { summary: 'fourth', resolved_comments: [own.id] }, { language: 'en' }, false);
  assert.deepEqual(f.logs.filter(l => l.type === 'review_threads_unresolved').map(l => l.code), ['github_http_422', 'github_permission_graphql']);
  assert.equal(f.state.comments.length, 1);
});

test('a finding that is an earlier inline comment still applying is not posted again; the summary links to it', async t => {
  const f = await fixture(t);
  await f.review('a', { summary: '第一次检视。', findings: [{ ...inlineFinding, requires_human_decision: true, human_action: '决定边界是否包含 10' }] });
  const earlier = f.state.reviewComments[0];
  assert.match(earlier.body, /^\*\*\[需要人工处理\]\*\* Off by one/);
  // The model copies the earlier body, mark included, and names the comment it repeats.
  await f.review('b', { summary: '仍有一个问题。', findings: [{ ...inlineFinding, id: 'f-again', body: earlier.body.split('\n\n<!--')[0], requires_human_decision: true, human_action: '决定边界是否包含 10', comment_id: earlier.id }] });
  assert.equal(f.state.reviewComments.length, 1, 'no second inline comment'); assert.equal(f.state.reviews.length, 1);
  const body = f.state.comments[0].body;
  assert.ok(body.includes(`之前的行内意见仍未解决 1 条：[src/parse.js:2](${earlier.html_url})。`), body);
  assert.ok(body.includes(`1. 决定边界是否包含 10（[行内意见](${earlier.html_url})）`), body);
  assert.ok(!body.includes('Off by one'), 'the finding stays in its inline comment');
  // A comment that is not the bot's is posted as a new inline comment instead.
  f.state.reviewComments.push({ ...earlier, id: 700, user: { id: 5 } });
  await f.review('c', { summary: 'third', findings: [{ ...inlineFinding, id: 'f-other', comment_id: 700 }] });
  assert.equal(f.state.reviewComments.filter(c => c.user.id === 999).length, 2);
  assert.ok(!f.state.reviewComments.at(-1).body.startsWith('**[需要人工处理]** **['));
});

test('a summary comment someone deleted is posted again, and later reviews edit the new one', async t => {
  const f = await fixture(t);
  await f.review('a', { summary: 'first' }, { language: 'en' });
  const gone = f.state.comments.pop();
  await f.review('b', { summary: 'second' }, { language: 'en' });
  assert.equal(f.state.comments.length, 1); assert.notEqual(f.state.comments[0].id, gone.id);
  assert.equal(f.h.store.get('SELECT comment_id FROM review_summaries').comment_id, String(f.state.comments[0].id));
  await f.review('c', { summary: 'third' }, { language: 'en' });
  assert.equal(f.state.comments.length, 1); assert.match(f.state.comments[0].body, /^\*Review 3,.*\n\nthird/);
});

test('an object reviewed before summaries were recorded keeps its earliest summary comment', async t => {
  const f = await fixture(t);
  // Reviews published before review_summaries existed left only their own publication records.
  await f.review('a', { summary: 'oldest' }, { language: 'en' });
  const earliest = f.state.comments[0].id;
  f.state.comments.push({ id: 900, body: 'a later comment of an older review', user: { id: 999 } });
  f.h.store.run('DELETE FROM review_summaries');
  await f.review('b', { summary: 'newest' }, { language: 'en' });
  assert.deepEqual(f.state.comments.map(c => c.id), [earliest, 900]);
  assert.match(f.state.comments[0].body, /^\*Review 2,.*\n\nnewest/);
});

test('the summary comment speaks the review language; findings validate their new fields', () => {
  assert.deepEqual([reviewLanguage('zh', 'x'), reviewLanguage('en', '中文'), reviewLanguage('auto', '修复已确认'), reviewLanguage('auto', 'Looks good')], ['zh', 'en', 'zh', 'en']);
  const body = summaryComment({ language: 'en', overview: 'Looks good.', discussion: [], coverage: 'Reviewed commit: x', resolved: [],
    human: [{ text: 'Decide whether the old parser stays', url: 'https://github.invalid/r/1' }, { text: 'Grant the App the workflows permission' }] });
  assert.equal(body, '> [!IMPORTANT]\n> Needs a person (2): Decide whether the old parser stays; Grant the App the workflows permission. Summary at the end.\n\nLooks good.\n\nReviewed commit: x'
    + '\n\n### Needs a person (2)\n\n1. Decide whether the old parser stays ([inline comment](https://github.invalid/r/1))\n2. Grant the App the workflows permission');
  // Nothing for a person: no alert and no closing list.
  assert.equal(summaryComment({ language: 'zh', overview: '没有问题。', discussion: [], coverage: 'c', resolved: [], human: [] }), '没有问题。\n\nc');
  const valid = { summary: 's', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' };
  assert.doesNotThrow(() => validateReview({ ...valid, resolved_comments: [12], findings: [{ ...decision, human_action: 'Decide' }] }));
  assert.throws(() => validateReview({ ...valid, resolved_comments: ['12'] }), /model_review_invalid/);
  assert.throws(() => validateReview({ ...valid, findings: [{ ...decision, human_action: 3 }] }), /model_finding_invalid/);
  // A finding may name the comment that asked for it; anything else in that field is refused.
  assert.doesNotThrow(() => validateReview({ ...valid, findings: [{ ...decision, requested_in: { type: 'review_comment', id: 21 } }] }));
  for (const requested_in of [{ type: 'issue', id: 1 }, { type: 'comment', id: '21' }, { type: 'comment', id: 0 }, null])
    assert.throws(() => validateReview({ ...valid, findings: [{ ...decision, requested_in }] }), /model_finding_invalid/, JSON.stringify(requested_in));
});

test('the first line names what the person did, and an Issue ready for development says what it waits for', () => {
  const base = { overview: 'Ready for development.', discussion: [], coverage: 'Reviewed commit: x', resolved: [], human: [] };
  const header = (language, what, url = 'https://github.invalid/u/1') => summaryComment({ ...base, language, review: { count: 2, at: '2026-11-06 00:10 UTC', sha: 'a'.repeat(40), actor: 'alice', url, what } }).split('\n')[0];
  assert.equal(header('en', 'edit', null), "*Review 2, updated 2026-11-06 00:10 UTC, reviewed commit aaaaaaa; responding to @alice's edit*");
  assert.equal(header('en', 'review'), "*Review 2, updated 2026-11-06 00:10 UTC, reviewed commit aaaaaaa; responding to @alice's [review](https://github.invalid/u/1)*");
  assert.equal(header('en', 'review_comment'), "*Review 2, updated 2026-11-06 00:10 UTC, reviewed commit aaaaaaa; responding to @alice's [inline comment](https://github.invalid/u/1)*");
  assert.equal(header('en', 'label', null), '*Review 2, updated 2026-11-06 00:10 UTC, reviewed commit aaaaaaa; responding to the label @alice added*');
  assert.equal(header('zh', 'edit', null), '*第 2 次检视，更新于 2026-11-06 00:10 UTC，检视提交 aaaaaaa；回应 @alice 的修改*');
  assert.equal(header('zh', 'comment'), '*第 2 次检视，更新于 2026-11-06 00:10 UTC，检视提交 aaaaaaa；回应 @alice 的[评论](https://github.invalid/u/1)*');
  assert.deepEqual(['issue_edited', 'pull_request_edited', 'review_submitted', 'review_reply', 'review_comment', 'labeled', 'comment', 'mention'].map(promptedBy),
    ['edit', 'edit', 'review', 'review_comment', 'review_comment', 'label', 'comment', 'comment']);
  // Why development has not started follows the overview.
  const waiting = (language, development) => summaryComment({ ...base, language, development }).split('\n\n')[1];
  assert.equal(waiting('en', { reason: 'label', label: 'bot-develop', assignees: [] }), 'Development has not started: it waits for a person to add the `bot-develop` label.');
  assert.equal(waiting('en', { reason: 'assigned', label: 'bot-develop', assignees: ['alice', 'bob'] }),
    'Development has not started: the Issue is assigned to `alice`, `bob`, so the bot leaves it to them. To have the bot develop it, unassign it and add the `bot-develop` label again.');
  assert.equal(waiting('en', { reason: 'app', label: 'bot-develop', assignees: [] }), 'Development has not started: a person, not an app, has to add the `bot-develop` label.');
  assert.equal(waiting('zh', { reason: 'assigned', label: 'bot-develop', assignees: ['alice'] }), '开发还没开始：这个 Issue 已指派给 `alice`，bot 不会接手。要让 bot 开发，请取消指派，再重新加一次 `bot-develop` 标签。');
  assert.equal(summaryComment({ ...base, language: 'en', development: null }), 'Ready for development.\n\nReviewed commit: x');
});

test('an installation with contents: read reports that fixed review threads are not closed', () => {
  const granted = { metadata: 'read', contents: 'read', issues: 'write', pull_requests: 'write', statuses: 'write', actions: 'write', checks: 'write', workflows: 'write' };
  const contents = appGaps(granted, ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'workflow_run']).find(gap => gap.name === 'contents');
  assert.deepEqual(contents, { kind: 'permission', name: 'contents', required: 'write', current: 'read', features: ['review_threads', 'development', 'release', 'gate'] });
});

test('what a person must do keeps identifiers as written: underscores and code spans stay, emphasis and heading marks go', () => {
  const finding = (human_action, body = 'x') => ({ id: 'f', body, requires_human_decision: true, ...(human_action ? { human_action } : {}) });
  const items = humanItems('en', { findings: [
    finding('Decide whether total_value should skip SKUs missing from prices'),
    finding('Decide whether `low_stock` and `__init__.py` change'),
    finding('', '## **[Needs a person]** Decide on `max_revisions`\nDetails follow.'),
    finding('> Confirm the **release** checklist'),
  ] }, new Map());
  assert.deepEqual(items.map(item => item.text), ['Decide whether total_value should skip SKUs missing from prices', 'Decide whether `low_stock` and `__init__.py` change',
    '[Needs a person] Decide on `max_revisions`', 'Confirm the release checklist']);
  // The alert's short form closes a code span the length limit cuts, so the rest of the comment is not swallowed into it.
  const body = summaryComment({ language: 'en', overview: 'o', discussion: [], coverage: 'c', resolved: [], human: [{ text: 'Decide ' + 'x'.repeat(100) + ' `a_very_long_identifier_name` now' }] });
  const alert = body.split('\n')[1];
  assert.equal((alert.match(/`/g) || []).length % 2, 0);
  assert.match(alert, /`…/);
});

test('a development PR body links its Issue once, also when the summary already closes it', () => {
  const candidate = summary => ({ summary, change_title: 'Fix it', validation: { source: 'policy', command: 'make test', exit_code: 0 }, test_command: 'make test', remote_sha: 'a'.repeat(40) });
  const count = text => (text.match(/(?:closes|fixes|resolves):? #3\b/gi) || []).length;
  assert.equal(count(implementationText(candidate('Rejects over-shipping.'), 3).body), 1);
  for (const summary of ['Rejects over-shipping.\n\nCloses #3', 'Fixes #3: rejects over-shipping.', 'resolves: #3', 'Resolved octo/hello#3 too'])
    assert.ok(implementationText(candidate(summary), 3).body.startsWith(summary + '\n\nTests: make test\n'), summary);
  // Another Issue's number is not this Issue.
  assert.match(implementationText(candidate('Closes #31'), 3).body, /^Closes #3$/m);
});
