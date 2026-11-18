import test from 'node:test';
import assert from 'node:assert/strict';
import { issueClaims } from '../dist/review/claims.js';
import { TaskError } from '../dist/agent/common.js';

// #1047: the facts a review and the Manager judge a claim from. The control plane gathers them from GitHub's own links and
// passes comments as written; it never decides from their text whether they are a claim.
const pr = (number, author, extra = {}) => ({ number, title: `PR ${number}`, url: `https://github.example/fixture/project-101/pull/${number}`, state: 'OPEN', isDraft: false,
  author: { login: author }, repository: { nameWithOwner: 'fixture/project-101' }, ...extra });
function client({ graphql, comments = [] } = {}) {
  const calls = [];
  return { calls, fullName: 'fixture/project-101', actorLogin: 'fixture-app[bot]', repository: { id: '101' }, path: suffix => '/repos/fixture/project-101' + suffix,
    graphql: async (query, variables) => { calls.push(['graphql', variables]); return graphql(query, variables); },
    pages: async path => { calls.push(['pages', path]); return comments; } };
}
// The bot's own pull requests are rows of bot_pull_requests.
const store = { all: () => [{ number: 7 }] };

test('claim facts list assignees and other people\'s open linked pull requests, marking those that close the Issue', async () => {
  const github = client({ graphql: () => ({ repository: { issue: {
    closedByPullRequestsReferences: { nodes: [pr(11, 'carol'), pr(7, 'fixture-app')] },
    timelineItems: { nodes: [
      { willCloseTarget: false, source: pr(12, 'dave', { isDraft: true }) },
      { willCloseTarget: false, source: pr(11, 'carol') },
      { willCloseTarget: false, source: pr(13, 'erin', { state: 'CLOSED' }) },
      { willCloseTarget: true, source: pr(4, 'frank', { url: 'https://github.example/other/repo/pull/4', repository: { nameWithOwner: 'other/repo' } }) },
      // The bot's own: a row of bot_pull_requests, or written by the bot's account.
      { willCloseTarget: true, source: pr(7, 'someone-else') }, { willCloseTarget: false, source: pr(20, 'fixture-app') },
      // A cross-reference from an Issue has no pull request fields.
      { willCloseTarget: false, source: {} }] } } } }) });
  const facts = await issueClaims(github, store, { number: 5, assignees: [{ login: 'alice' }] });
  assert.deepEqual(github.calls, [['graphql', { owner: 'fixture', name: 'project-101', number: 5 }]], 'comments are read only when asked for');
  assert.deepEqual(facts, { assignees: ['alice'], pull_requests: [
    { number: 11, title: 'PR 11', author: 'carol', draft: false, url: 'https://github.example/fixture/project-101/pull/11', closes: true },
    { number: 12, title: 'PR 12', author: 'dave', draft: true, url: 'https://github.example/fixture/project-101/pull/12', closes: false },
    { number: 4, repository: 'other/repo', title: 'PR 4', author: 'frank', draft: false, url: 'https://github.example/other/repo/pull/4', closes: true }] });
});

test('the Manager\'s claim facts add the latest comments as written, without the bot\'s own', async () => {
  const comment = (id, login, body) => ({ id, user: { login }, author_association: 'NONE', created_at: `2026-11-18T00:00:${String(id).padStart(2, '0')}Z`, body, html_url: 'https://github.example/c/' + id });
  const comments = [comment(1, 'fixture-app[bot]', 'Review summary'), comment(2, 'bob', 'Old remark'),
    ...Array.from({ length: 10 }, (_, i) => comment(10 + i, 'carol', i === 9 ? 'x'.repeat(2000) : `Comment ${i}`)),
    // A comment the bot wrote through another account still carries the bot's marker.
    comment(30, 'mirror', 'Mirrored\n<!-- dept-bot:abc -->')];
  const github = client({ graphql: () => ({ repository: { issue: { closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } } } }), comments });
  const facts = await issueClaims(github, store, { number: 5, assignees: [] }, { comments: true });
  assert.deepEqual(github.calls.map(call => call[0]), ['graphql', 'pages']);
  assert.equal(facts.comments.length, 10); assert.equal(facts.comments[0].id, '10');
  assert.deepEqual(facts.comments[0], { id: '10', author: 'carol', association: 'NONE', created_at: '2026-11-18T00:00:10Z', body: 'Comment 0', url: 'https://github.example/c/10' });
  assert.equal(facts.comments.at(-1).body.length, 1501, 'a long comment is clipped');
  assert.ok(!facts.comments.some(c => ['fixture-app[bot]', 'mirror'].includes(c.author)));
  // Comments already read are used as they are.
  const read = client({ graphql: () => ({}) }), given = await issueClaims(read, store, { number: 5 }, { comments: [comment(40, 'dave', 'I am on it')] });
  assert.deepEqual(read.calls.map(call => call[0]), ['graphql']); assert.deepEqual(given.comments.map(c => c.body), ['I am on it']);
});

test('a failed read is named, so an empty list never reads as "nobody"', async () => {
  const github = client({ graphql: () => { throw new TaskError('github_permission_404', 'waiting_permission', 'Not Found'); } });
  github.pages = async () => { throw new Error('socket hang up'); };
  const facts = await issueClaims(github, store, { number: 5, assignees: [{ login: 'alice' }] }, { comments: true });
  assert.deepEqual(facts, { assignees: ['alice'], pull_requests: [], unavailable: 'pull_requests: github_permission_404; comments: read_failed' });
});
