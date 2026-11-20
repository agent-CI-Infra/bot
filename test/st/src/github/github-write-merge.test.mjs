import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { githubWrite, writeRoute, githubWriteInstructions, withMergePolicy, githubWriteTool } from '../../../../dist/github/write.js';
import { mergeBoundary, scopedMergeBoundary } from '../../../../dist/github/merge-policy.js';
import { defaultPermissions, githubWriteAllowed, updatePermissions } from '../../../../dist/roles/permissions.js';

// #1170: merging through github_write follows the project's auto-merge policy. Merging and enqueueing are one action that
// takes the develop ceiling and Contents plus Pull requests write; where the policy needs a maintainer's request, the call
// names it and the control plane checks who made it. The base branch's merge queue decides between PUT merge and enqueue.
const head = 'a'.repeat(40), merged = 'b'.repeat(40);
async function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 3)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-bot-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('r','fixture/r','10','a')");
  store.run("INSERT INTO policies(repository_id,enabled,capability_ceiling) VALUES('r',1,'develop')");
  // #8 is the bot's own pull request; #7 someone else's; #9 targets a branch whose ruleset requires a merge queue.
  store.run("INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id) VALUES('r',8,'PR_8','900','r','bot/issue-1',?,'t')", head);
  // The platform's collaborator cache (#1158): 501 writes, 502 only reads.
  store.run("INSERT INTO github_repository_collaborators VALUES('i','r','501','maintainer','write'),('i','r','502','reader','read')");
  // Platform people: u1 administers the project (tasks.write), u2 has no grant there.
  store.run("INSERT INTO users(id,username,password_hash,role) VALUES('u1','maintainer','x','project_admin'),('u2','visitor','x','project_admin')");
  store.run("INSERT INTO project_admin_assignments VALUES('u1','r')");
  const comments = {
    11: { id: 11, user: { id: 501, login: 'maintainer', type: 'User' }, body: 'Please merge this.', issue_url: 'https://api.github.com/repos/fixture/r/issues/7', html_url: 'https://github.com/fixture/r/pull/7#issuecomment-11' },
    12: { id: 12, user: { id: 502, login: 'reader', type: 'User' }, body: 'Merge it!', issue_url: 'https://api.github.com/repos/fixture/r/issues/8', html_url: 'https://github.com/fixture/r/pull/8#issuecomment-12' },
    13: { id: 13, user: { id: 900, login: 'fixture-bot', type: 'User' }, body: 'merge <!-- dept-bot-write:x -->', issue_url: 'https://api.github.com/repos/fixture/r/issues/8', html_url: 'https://github.com/fixture/r/pull/8#issuecomment-13' },
    14: { id: 14, user: { id: 501, login: 'maintainer', type: 'User' }, body: 'Merge #8 please.', issue_url: 'https://api.github.com/repos/fixture/r/issues/8', html_url: 'https://github.com/fixture/r/pull/8#issuecomment-14' },
  };
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path, body });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/repositories/r') return send({ id: 'r', owner: { id: '10' }, full_name: 'fixture/r', default_branch: 'main' });
    // The bot account's own identity (a bot account writes as this user).
    if (path === '/user') return send({ id: 900, login: 'fixture-bot' });
    let match = /^\/repos\/fixture\/r\/pulls\/(\d+)$/.exec(path);
    if (match && req.method === 'GET') {
      // #10 was opened by the bot through github_write (not in bot_pull_requests); #11's author cannot be read; #13 targets
      // a branch whose rules cannot be read; #15 targets 'late', and reading its rules (after the policy check) is when a
      // project administrator tightens the policy.
      const number = Number(match[1]), user = number === 10 ? { id: 900, login: 'fixture-bot', type: 'User' } : number === 11 ? null : { id: 501, login: 'maintainer', type: 'User' };
      return send({ number, node_id: 'PR_' + number, html_url: 'https://github.com/fixture/r/pull/' + number, state: 'open', user, head: { sha: head }, base: { ref: number === 9 ? 'queued' : number === 13 ? 'opaque' : number === 15 ? 'late' : 'main' } });
    }
    if (path.startsWith('/repos/fixture/r/contents/') && ['PUT', 'DELETE'].includes(req.method)) return send({ content: { path: path.slice(26), sha: 'f'.repeat(40) }, commit: { sha: merged } }, 201);
    if (path.startsWith('/repos/fixture/r/git/refs/heads/') && req.method === 'PATCH') return send({ ref: 'refs/heads/' + path.slice(32), object: { sha: merged, type: 'commit' } });
    if (path === '/repos/fixture/r/merges' && req.method === 'POST') return send({ sha: merged }, 201);
    if (path === '/repos/fixture/r/rules/branches/opaque' || path === '/repos/fixture/r/branches/opaque') return send({ message: 'Resource not accessible by integration' }, 403);
    if (path === '/graphql' && /mergeQueue\(branch/.test(body?.query) && body.variables?.branch === 'opaque') return send({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
    if ((match = /^\/repos\/fixture\/r\/pulls\/(\d+)\/merge$/.exec(path)) && req.method === 'PUT') return send({ sha: merged, merged: true, message: 'Pull Request successfully merged' });
    if ((match = /^\/repos\/fixture\/r\/issues\/comments\/(\d+)$/.exec(path)) && comments[match[1]]) return send(comments[match[1]]);
    if (path === '/repos/fixture/r/pulls/7/reviews/21') return send({ id: 21, user: { id: 501, login: 'maintainer', type: 'User' }, body: 'Approved, merge it.', pull_request_url: 'https://api.github.com/repos/fixture/r/pulls/7', html_url: 'https://github.com/fixture/r/pull/7#pullrequestreview-21' });
    if (path === '/repos/fixture/r/rules/branches/main') return send([]);
    if (path === '/repos/fixture/r/rules/branches/late') { store.run("UPDATE policies SET auto_merge_policy='disallow' WHERE repository_id='r'"); return send([]); }
    if (path === '/repos/fixture/r/branches/late') return send({ name: 'late', protected: false });
    if (path === '/repos/fixture/r/rules/branches/queued') return send([{ type: 'merge_queue', ruleset_id: 5 }]);
    if (path === '/repos/fixture/r/branches/main') return send({ name: 'main', protected: false });
    if (path === '/graphql' && /enqueuePullRequest/.test(body?.query)) return send({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_9', position: 2, state: 'QUEUED' } } } });
    send({ message: 'Not Found' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  let role = defaultPermissions('manager', 'controller'), speaker;
  const repository = store.get("SELECT * FROM repositories WHERE id='r'");
  const write = (args, scope = 'task:merge') => githubWrite({ store, repository, redactor: new Redactor(), guard: async () => {}, apiUrl: 'http://127.0.0.1:' + server.address().port,
    scope, actor: { kind: 'task', role: 'manager', task_id: 'merge' }, allowed: (resource, operation) => githubWriteAllowed(role, resource, operation),
    ...(speaker !== undefined ? { speaker: () => speaker } : {}) }, args);
  const merges = () => requests.filter(r => r.method === 'PUT' && r.path.endsWith('/merge')).map(r => r.path);
  const branchWrites = () => requests.filter(r => ['PUT', 'DELETE', 'PATCH'].includes(r.method) && /\/(contents|git\/refs)\//.test(r.path) || r.method === 'POST' && r.path.endsWith('/merges')).map(r => r.method + ' ' + r.path);
  const enqueues = () => requests.filter(r => r.path === '/graphql' && /enqueuePullRequest/.test(r.body?.query)).map(r => r.body.variables);
  return { store, write, merges, enqueues, requests, branchWrites, setRole: value => { role = value; }, setSpeaker: value => { speaker = value; },
    setPolicy: level => store.run("UPDATE policies SET auto_merge_policy=? WHERE repository_id='r'", level) };
}
const merge = (number, extra = {}) => ({ method: 'PUT', path: `/pulls/${number}/merge`, key: `merge-${number}-${Object.keys(extra).join('-')}`, body: { merge_method: 'rebase' }, ...extra });

test('the merge route is the one merge action; merge_request belongs to it alone (#1170)', async t => {
  assert.deepEqual([writeRoute('PUT', '/pulls/7/merge')?.merge, writeRoute('PUT', '/pulls/7/merge')?.number, writeRoute('PUT', '/pulls/7/merge')?.resource], [true, 7, 'contents']);
  assert.equal(writeRoute('POST', '/merges')?.merge, undefined);
  const f = await fixture(t);
  const misplaced = await f.write({ method: 'POST', path: '/issues/7/comments', key: 'c', body: { body: 'hi' }, merge_request: 'current_message' });
  assert.equal(misplaced.error, 'invalid_arguments');
  assert.equal((await f.write({ ...merge(7), merge_request: 7 })).error, 'invalid_arguments');
  assert.equal(f.requests.length, 0);
});

test('disallow (the default) refuses a merge without a verified maintainer request and accepts one with it (#1170)', async t => {
  const f = await fixture(t);
  assert.equal(f.store.get("SELECT auto_merge_policy FROM policies WHERE repository_id='r'").auto_merge_policy, 'disallow');
  // Without a request: refused before any write token, naming the level; the ledger and audit keep the refusal.
  const bare = await f.write(merge(7));
  assert.deepEqual([bare.error, bare.policy, bare.bot_pull_request], ['auto_merge_not_allowed', 'disallow', false]);
  assert.match(bare.detail, /auto-merge policy is disallow/);
  assert.equal(f.store.get("SELECT state FROM github_writes WHERE key=?", merge(7).key).state, 'refused');
  // Requests that are not a maintainer's: another pull request's comment, a reader, the bot itself, a malformed link.
  for (const [number, request, reason] of [
    [7, 'https://github.com/fixture/r/pull/8#issuecomment-14', /pull request #7/],
    [8, 'https://github.com/fixture/r/pull/8#issuecomment-12', /@reader has no write access/],
    [8, 'https://github.com/fixture/r/pull/8#issuecomment-13', /written by a bot/],
    [7, 'https://github.com/other/r/pull/7#issuecomment-11', /merge_request must be the link/],
    [7, 'LGTM from the maintainer', /merge_request must be the link/],
    [7, 'current_message', /no conversation message/],
  ]) {
    const refused = await f.write(merge(number, { merge_request: request }));
    assert.equal(refused.error, 'auto_merge_not_allowed', request); assert.match(refused.detail, reason, request);
  }
  assert.deepEqual(f.merges(), []);
  // A maintainer's comment or review on this pull request: merged directly (main has no merge queue), the request cited.
  const done = await f.write(merge(7, { merge_request: 'https://github.com/fixture/r/pull/7#issuecomment-11' }));
  assert.deepEqual(done, { sha: merged, merged: true, message: 'Pull Request successfully merged', via: 'merge', merge_request: 'https://github.com/fixture/r/pull/7#issuecomment-11', status: 200 });
  const byReview = await f.write(merge(7, { merge_request: 'https://github.com/fixture/r/pull/7#pullrequestreview-21' }), 'task:review');
  assert.equal(byReview.merge_request, 'https://github.com/fixture/r/pull/7#pullrequestreview-21');
  assert.deepEqual(f.merges(), ['/repos/fixture/r/pulls/7/merge', '/repos/fixture/r/pulls/7/merge']);
  const sent = f.store.get("SELECT * FROM github_writes WHERE state='sent' ORDER BY rowid LIMIT 1");
  assert.equal(sent.html_url, 'https://github.com/fixture/r/pull/7');
  assert.equal(JSON.parse(sent.response).merge_request, 'https://github.com/fixture/r/pull/7#issuecomment-11');
});

test('a conversation request rests on its sender: a linked person with write authority in the project (#1170)', async t => {
  const f = await fixture(t);
  f.setSpeaker(null);
  assert.match((await f.write(merge(7, { merge_request: 'current_message' }))).detail, /not linked to a platform account/);
  f.setSpeaker('u2');
  assert.match((await f.write(merge(7, { merge_request: 'current_message' }))).detail, /does not have write access/);
  f.setSpeaker('u1');
  const done = await f.write(merge(7, { merge_request: 'current_message' }));
  assert.deepEqual([done.merged, done.merge_request], [true, 'current_message']);
});

test('non_bot_only merges other pull requests on its own but the bot\'s own only on request; allow_all merges both (#1170)', async t => {
  const f = await fixture(t);
  f.setPolicy('non_bot_only');
  assert.equal((await f.write(merge(7))).merged, true);
  const own = await f.write(merge(8));
  assert.deepEqual([own.error, own.policy, own.bot_pull_request], ['auto_merge_not_allowed', 'non_bot_only', true]);
  assert.match(own.detail, /#8 is the bot's own pull request/);
  assert.equal((await f.write(merge(8, { merge_request: 'https://github.com/fixture/r/pull/8#issuecomment-14' }))).merged, true);
  f.setPolicy('allow_all');
  assert.equal((await f.write(merge(8), 'task:all')).merged, true);
  // Junk in an unneeded request is ignored rather than refused: the policy does not ask for one.
  assert.equal((await f.write(merge(8, { merge_request: 'whatever' }), 'task:all')).merged, true);
  assert.deepEqual(f.merges(), ['/repos/fixture/r/pulls/7/merge', '/repos/fixture/r/pulls/8/merge', '/repos/fixture/r/pulls/8/merge', '/repos/fixture/r/pulls/8/merge']);
});

test('a base branch that requires a merge queue gets the pull request enqueued instead of merged, under the same gate (#1170)', async t => {
  const f = await fixture(t);
  f.setPolicy('allow_all');
  const queued = await f.write(merge(9, { body: { sha: head, merge_method: 'squash' } }));
  assert.deepEqual(queued, { number: 9, merged: false, queued: true, sha: head, merge_queue: { id: 'MQE_9', position: 2, state: 'QUEUED' }, via: 'merge_queue', status: 200 });
  assert.deepEqual(f.enqueues(), [{ id: 'PR_9', head }]);
  assert.deepEqual(f.merges(), []);
  // Replayed from the ledger under the same key, never enqueued twice.
  assert.deepEqual(await f.write(merge(9, { body: { sha: head, merge_method: 'squash' } })), { ...queued, replayed: true });
  assert.equal(f.enqueues().length, 1);
  // The same policy refusal applies to enqueueing.
  f.setPolicy('disallow');
  assert.equal((await f.write(merge(9), 'task:other')).error, 'auto_merge_not_allowed');
  assert.equal(f.enqueues().length, 1);
});

test('merging needs Contents and Pull requests write and the develop ceiling (#1170)', async t => {
  const f = await fixture(t);
  f.setPolicy('allow_all');
  f.setRole(updatePermissions(defaultPermissions('manager', 'controller'), { github_pull_requests: 'read' }));
  const noPulls = await f.write(merge(7));
  assert.equal(noPulls.error, 'github_resource_forbidden'); assert.match(noPulls.detail, /Contents and Pull requests/);
  f.setRole(updatePermissions(defaultPermissions('manager', 'controller'), { github_contents: 'read' }));
  assert.equal((await f.write(merge(7))).error, 'github_resource_forbidden');
  f.setRole(defaultPermissions('manager', 'controller'));
  f.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='r'");
  const ceiling = await f.write(merge(7));
  assert.deepEqual([ceiling.error, ceiling.needed], ['capability_ceiling', 'develop']);
  assert.deepEqual(f.merges(), []);
});

test('the bot\'s own pull request is known by its live author too, and an unreadable author counts as the bot\'s (#1170)', async t => {
  const f = await fixture(t);
  f.setPolicy('non_bot_only');
  // #10 was opened through github_write POST /pulls, so bot_pull_requests does not list it; its author is the bot account.
  const opened = await f.write(merge(10));
  assert.deepEqual([opened.error, opened.bot_pull_request], ['auto_merge_not_allowed', true]);
  const unknown = await f.write(merge(11));
  assert.deepEqual([unknown.error, unknown.bot_pull_request], ['auto_merge_not_allowed', true]);
  assert.equal((await f.write(merge(7))).merged, true);
  assert.deepEqual(f.merges(), ['/repos/fixture/r/pulls/7/merge']);
});

test('an unreadable merge-queue requirement refuses the merge instead of merging directly (#1170)', async t => {
  const f = await fixture(t);
  f.setPolicy('allow_all');
  const refused = await f.write(merge(13));
  assert.deepEqual([refused.error, refused.base], ['merge_queue_unknown', 'opaque']); assert.match(refused.detail, /Nothing was sent/);
  assert.deepEqual([f.merges(), f.enqueues()], [[], []]);
  assert.equal(f.store.get("SELECT state FROM github_writes WHERE path='/pulls/13/merge'").state, 'refused');
});

test('a policy tightened while the merge is prepared refuses it before sending (#1170)', async t => {
  const f = await fixture(t);
  f.setPolicy('allow_all');
  const refused = await f.write(merge(15));
  assert.deepEqual([refused.error, refused.policy], ['auto_merge_not_allowed', 'disallow']); assert.match(refused.detail, /policy changed while the merge was prepared/);
  assert.deepEqual(f.merges(), []);
});

test('writes that move the default branch without a pull request follow the same policy (#1170)', async t => {
  const f = await fixture(t);
  const file = { message: 'docs', content: Buffer.from('hello\n').toString('base64') };
  const moves = [
    { method: 'PUT', path: '/contents/docs/a.md', body: file },
    { method: 'PUT', path: '/contents/docs/a.md', body: { ...file, branch: 'main' } },
    { method: 'PATCH', path: '/git/refs/heads/main', body: { sha: merged } },
    { method: 'POST', path: '/merges', body: { base: 'main', head: 'feature' } },
  ];
  // disallow (and non_bot_only): a default-branch move needs a maintainer's request; nothing is sent without one.
  for (const level of ['disallow', 'non_bot_only']) {
    f.setPolicy(level);
    for (const [i, move] of moves.entries()) {
      const refused = await f.write({ ...move, key: `${level}-${i}` });
      assert.deepEqual([refused.error, refused.policy, refused.default_branch], ['auto_merge_not_allowed', level, 'main'], move.method + ' ' + move.path);
      assert.match(refused.detail, /moves the default branch \(main\)/);
    }
  }
  assert.deepEqual(f.branchWrites(), []);
  f.setPolicy('disallow');
  // Other branches are ordinary Contents writes; a tag ref is not a branch.
  assert.equal((await f.write({ method: 'PUT', path: '/contents/docs/a.md', key: 'feature', body: { ...file, branch: 'feature' } })).status, 201);
  assert.equal((await f.write({ method: 'PATCH', path: '/git/refs/heads/feature', key: 'feature-ref', body: { sha: merged } })).status, 200);
  // A maintainer's comment anywhere in the repository, or the conversation's sender, is a verified request for it.
  const asked = await f.write({ ...moves[3], key: 'asked', merge_request: 'https://github.com/fixture/r/pull/8#issuecomment-14' });
  assert.deepEqual([asked.status, asked.merge_request], [201, 'https://github.com/fixture/r/pull/8#issuecomment-14']);
  assert.equal((await f.write({ ...moves[0], key: 'reader', merge_request: 'https://github.com/fixture/r/pull/8#issuecomment-12' })).error, 'auto_merge_not_allowed');
  f.setSpeaker('u1');
  assert.equal((await f.write({ ...moves[2], key: 'conversation', merge_request: 'current_message' })).status, 200);
  // allow_all: the repository's own branch rules decide.
  f.setPolicy('allow_all');
  assert.equal((await f.write({ ...moves[0], key: 'all' })).status, 201);
  assert.deepEqual(f.branchWrites(), ['PUT /repos/fixture/r/contents/docs/a.md', 'PATCH /repos/fixture/r/git/refs/heads/feature', 'POST /repos/fixture/r/merges',
    'PATCH /repos/fixture/r/git/refs/heads/main', 'PUT /repos/fixture/r/contents/docs/a.md']);
});

test('every prompt that can merge states the current level instead of a fixed ban (#1170)', () => {
  assert.match(mergeBoundary('disallow'), /auto-merge policy is disallow: never merge a pull request on your own, the bot's own included/);
  assert.match(mergeBoundary('non_bot_only'), /may merge a pull request the bot did not open when the repository's rules allow it\. A pull request the bot opened is merged only when/);
  assert.match(mergeBoundary('allow_all'), /may merge any pull request, the bot's own included, when the repository's rules allow it/);
  // The Manager and tasks have no conversation message to pass: their requests are GitHub links; assistants also have theirs.
  assert.doesNotMatch(mergeBoundary('disallow'), /message you are answering/); assert.match(mergeBoundary('disallow'), /merged by the assistant there/);
  assert.match(mergeBoundary('disallow', true), /or in the message you are answering/);
  for (const level of ['disallow', 'non_bot_only', 'allow_all']) {
    assert.match(mergeBoundary(level), /merge queue when its base branch requires one/);
    assert.match(mergeBoundary(level), /moves the default branch without a pull request/);
    assert.ok(githubWriteInstructions(level).includes(mergeBoundary(level)));
    assert.doesNotMatch(githubWriteInstructions(level), /Never merge a pull request/);
    // Role runs keep the entry's tools, not its system prompt: the level travels in the tool's description.
    const [tool] = withMergePolicy([githubWriteTool], level);
    assert.ok(tool.function.description.endsWith(mergeBoundary(level)));
  }
  const scoped = scopedMergeBoundary([{ full_name: 'o/a', policy: 'allow_all' }, { full_name: 'o/b', policy: 'disallow' }]);
  assert.match(scoped, /o\/a: allow_all; o\/b: disallow/);
  assert.match(scoped, /disallow: never merge/); assert.match(scoped, /allow_all: you may merge any pull request/);
  assert.doesNotMatch(scoped, /non_bot_only:/);
});
