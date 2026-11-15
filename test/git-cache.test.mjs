import { acceptanceFixture } from './acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, rmSync, symlinkSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitServer, git } from './git-server.mjs';
import { GitCache } from '../dist/agent/git-cache.js';
import { Workspace } from '../dist/agent/workspace.js';
import { Redactor } from '../dist/agent/common.js';
import { workspace as runnerWorkspace } from '../runner/workspace.mjs';
import { storeOperation, pruneStore } from '../runner/store.mjs';
import { listTaskDirectories, removeTaskDirectories } from '../runner/task-dirs.mjs';
import { environment } from '../runner/command.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, pinLegacyTaskConfiguration } from './helpers.mjs';
import { Workspace as ControlWorkspace } from '../dist/agent/workspace.js';
import { TaskEngine } from '../dist/agent/engine.js';
import { queueWebhook } from '../dist/review/queue.js';
import { dispatchContext } from '../dist/dispatch/store.js';
import { Store } from '../dist/storage/database.js';
import { listWorkspaces, workspaceTool, workspaceCoverage } from '../dist/agent/workspace-tools.js';

const token = 'ghs_' + 'f'.repeat(36);
// A task gets its worktree when it first needs one (#769). The fixture's agent reads a repository file before anything
// else: its runner asks the control plane for the task's worktree, as runner/pi-entry.mjs does, and the session goes on once
// the answer arrived. Returns the reply to send for a mailbox call, or null for the fixture's own answer.
function agentReadsFirst(asked) {
  return request => {
    if (request.type === 'workspace_agent_tool') {
      const entry = [...asked.values()].find(item => item.id === request.request_id);
      if (entry) { entry.reply = (entry.reply || '') + Buffer.from(request.base64, 'base64').toString('utf8'); entry.answered ||= request.final; }
      return { ok: true, result: { written: true } };
    }
    if (request.type !== 'workspace_agent_poll') return null;
    let entry = asked.get(request.workspace_id); if (!entry) asked.set(request.workspace_id, entry = { id: randomBytes(24).toString('hex') });
    return entry.answered ? null : { ok: true, result: { state: 'running', tool_requests: [{ id: entry.id, name: 'ensure_workspace', arguments: {}, kind: 'workspace' }] } };
  };
}
// An upstream repository with a regular file, an executable, a symlink and a submodule entry, served over Git HTTP.
async function upstream(t, options) {
  const root = mkdtempSync(join(tmpdir(), 'git-cache-')), work = join(root, 'work'), bare = join(root, 'server', 'fixture', 'project-101.git');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = { HOME: environment.HOME, TMPDIR: environment.TMPDIR }; Object.assign(environment, { HOME: root, TMPDIR: root });
  t.after(() => Object.assign(environment, previous));
  mkdirSync(join(work, 'src'), { recursive: true }); git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), 'first\n'); writeFileSync(join(work, 'src', 'run.sh'), '#!/bin/sh\necho run\n'); chmodSync(join(work, 'src', 'run.sh'), 0o755);
  symlinkSync('README.md', join(work, 'link.md'));
  git(work, 'add', '.'); git(work, 'update-index', '--add', '--cacheinfo', '160000,' + 'c'.repeat(40) + ',vendor/module');
  git(work, 'commit', '-qm', 'first'); const first = git(work, 'rev-parse', 'HEAD');
  // `commit -a` would drop the submodule entry, whose directory does not exist; stage the one changed file instead.
  writeFileSync(join(work, 'README.md'), 'second\n'); git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'second'); const second = git(work, 'rev-parse', 'HEAD');
  mkdirSync(bare, { recursive: true }); git(bare, 'init', '-q', '--bare'); git(work, 'push', '-q', bare, `${second}:refs/heads/main`);
  const server = await gitServer(t, join(root, 'server'), token, options);
  return { root, work, bare, first, second, server, url: server.url + '/fixture/project-101.git', cache: new GitCache(join(root, 'cache')) };
}
// A task workspace backed by the real runner in a directory; the GitHub stub records every REST request it gets.
function task(root, reads, mirrorTree) {
  const notes = join(root, 'project-notes'); mkdirSync(notes, { recursive: true });
  const id = randomBytes(24).toString('hex'), logs = [], redactor = new Redactor(); redactor.add(token);
  const workspace = new Workspace(null, null, { id: 'task', attempt: 1, workspace_id: id }, redactor, async () => {}, value => logs.push(value));
  workspace.call = (_key, request) => runnerWorkspace({ ...request, workspace_id: id }, join(root, 'tasks'), undefined, notes).catch(error => ({ error: 'runner_operation_failed', detail: error.message }));
  const github = { path: path => path, authorEmail: () => '999+fixture-bot@users.noreply.github.com',
    async request(_method, path) { reads.push(path); return mirrorTree(path); },
    async snapshotBlob(sha) { reads.push('/git/blobs/' + sha); return mirrorTree('/git/blobs/' + sha); } };
  // Preparation logs its phase and progress first; the snapshot summary comes last.
  return { id, logs, workspace, github, repo: join(root, 'tasks', id, 'repo'), snapshot: () => logs.find(entry => entry.type === 'snapshot') };
}
const files = directory => readdirSync(directory, { recursive: true }).map(name => join(directory, name)).filter(path => statSync(path).isFile());
// GitHub's Git data API for the upstream commit, answered from the bare repository.
function restApi(u) {
  const tree = git(u.bare, 'rev-parse', u.second + '^{tree}');
  const listing = git(u.bare, 'ls-tree', '-r', '-l', u.second).split('\n').map(row => { const [meta, path] = row.split('\t'), [mode, type, sha, size] = meta.split(/\s+/); return { path, mode, type, sha, ...(size !== '-' ? { size: Number(size) } : {}) }; });
  const blob = sha => execFileSync('git', ['cat-file', 'blob', sha], { cwd: u.bare }).toString('base64');
  return path => path.startsWith('/git/commits/') ? { tree: { sha: tree } } : path.startsWith('/git/trees/') ? { tree: listing, truncated: false } : { encoding: 'base64', content: blob(path.split('/').at(-1)) };
}

test('a mirror fetches a task commit once with a one-time token; later tasks copy it without asking GitHub again', async t => {
  const u = await upstream(t), reads = [];
  const first = await u.cache.open('101', { url: u.url, token, commits: [u.second], refs: ['refs/heads/main'] });
  assert.equal(first.state, 'fetched'); assert.ok(first.has(u.second)); const contacted = u.server.requests.length; assert.ok(contacted > 0);
  const one = task(u.root, reads, () => assert.fail('no GitHub API request expected'));
  const snapshot = await one.workspace.prepare(one.github, u.second, first);
  assert.deepEqual(reads, []); assert.equal(snapshot.files.length, 3); assert.deepEqual(snapshot.skipped_files.map(f => f.path), ['vendor/module']);
  assert.match(one.snapshot().detail, /vendor\/module.*160000.*子模块不克隆/);
  assert.deepEqual([one.snapshot().source, one.snapshot().cache], ['git_cache', 'fetched']);
  // The second task on the same commit: no fetch, no blob or tree request, and a workspace of its own.
  const again = await u.cache.open('101', { url: u.url, token, commits: [u.second], refs: ['refs/heads/main'] });
  assert.equal(again.state, 'hit'); assert.equal(u.server.requests.length, contacted);
  const two = task(u.root, reads, () => assert.fail('no GitHub API request expected'));
  assert.notEqual(two.id, one.id);
  assert.equal((await two.workspace.prepare(two.github, u.second, again)).tree_sha, snapshot.tree_sha);
  assert.deepEqual(reads, []); assert.deepEqual([two.snapshot().source, two.snapshot().cache], ['git_cache', 'hit']);
  assert.equal(readFileSync(join(two.repo, 'README.md'), 'utf8'), 'second\n'); assert.equal(statSync(join(two.repo, 'src', 'run.sh')).mode & 0o111, 0o111);
  assert.equal(git(two.repo, 'rev-parse', 'HEAD^{tree}'), snapshot.tree_sha);
  // The token is in no file of the mirror or of either task copy, and the mirror has no remote holding a URL.
  for (const path of [...files(u.cache.path('101')), ...files(join(u.root, 'tasks'))]) assert.ok(!readFileSync(path).includes(token), path);
  assert.doesNotMatch(readFileSync(join(u.cache.path('101'), 'config'), 'utf8'), /remote|url|extraheader/i);
  assert.doesNotMatch(readFileSync(join(two.repo, '.git', 'config'), 'utf8'), /remote|url|extraheader|x-access-token/i);
});

test('a later fetch into the mirror leaves an earlier task copy on its own commit', async t => {
  const u = await upstream(t), reads = [];
  const before = task(u.root, reads, () => assert.fail('no GitHub API request expected'));
  const snapshot = await before.workspace.prepare(before.github, u.second, await u.cache.open('101', { url: u.url, token, commits: [u.second] }));
  // Upstream moves on with a force-push; a new task brings that commit into the mirror.
  writeFileSync(join(u.work, 'README.md'), 'rewritten\n'); git(u.work, 'add', 'README.md'); git(u.work, 'commit', '-q', '--amend', '-m', 'rewritten'); const rewritten = git(u.work, 'rev-parse', 'HEAD');
  git(u.work, 'push', '-q', '--force', u.bare, `${rewritten}:refs/heads/main`);
  const later = await u.cache.open('101', { url: u.url, token, commits: [rewritten] });
  assert.equal(later.state, 'fetched'); assert.ok(later.has(rewritten));
  assert.equal(git(before.repo, 'rev-parse', 'HEAD^{tree}'), snapshot.tree_sha); assert.equal(readFileSync(join(before.repo, 'README.md'), 'utf8'), 'second\n');
  assert.equal(git(before.repo, 'status', '--porcelain'), '');
  // The older commit stays pinned in the mirror for tasks that still name it.
  assert.equal((await u.cache.open('101', { url: u.url, token, commits: [u.second] })).state, 'hit');
  const after = task(u.root, reads, () => assert.fail('no GitHub API request expected'));
  await after.workspace.prepare(after.github, rewritten, later);
  assert.equal(readFileSync(join(after.repo, 'README.md'), 'utf8'), 'rewritten\n'); assert.equal(readFileSync(join(before.repo, 'README.md'), 'utf8'), 'second\n');
});

test('a commit GitHub will not send by SHA comes through its named ref; an unreachable mirror falls back to the GitHub API', async t => {
  const u = await upstream(t, { version0: true });
  // In protocol v0 only ref tips may be asked for; the first commit is an ancestor of main.
  const mirror = await u.cache.open('101', { url: u.url, token, commits: [u.first], refs: ['refs/heads/main', 'refs/heads/bad:name', '../../escape'] });
  assert.equal(mirror.state, 'fetched'); assert.ok(mirror.has(u.first));
  assert.doesNotMatch(git(u.cache.path('101'), 'for-each-ref', '--format=%(refname)'), /refs\/bot\/fetch|(?:^|\/)(?:escape|bad:name)(?:\/|$)/m);
  const wrong = await new GitCache(join(u.root, 'other-cache')).open('101', { url: u.url, token: 'ghs_' + 'b'.repeat(36), commits: [u.second] });
  assert.equal(wrong.state, 'unavailable'); assert.ok(!wrong.has(u.second)); assert.doesNotMatch(wrong.error, /ghs_b{36}/);
  // Without the mirror the snapshot reads the listing and blobs through the GitHub API, as before, and says why.
  const reads = [], fallback = task(u.root, reads, restApi(u));
  await fallback.workspace.prepare(fallback.github, u.second, wrong);
  assert.equal(reads.filter(path => path.startsWith('/git/blobs/')).length, 3);
  assert.deepEqual([fallback.snapshot().source, fallback.snapshot().cache], ['github_api', 'unavailable']); assert.match(fallback.snapshot().detail, /Git 缓存不可用/);
});

test('a mirror that holds the commit but cannot be read any more falls back to the GitHub API instead of failing the task', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second] });
  assert.ok(mirror.has(u.second));
  // The cache directory disappears between open() and the copy (cleaned by hand, disk failure).
  rmSync(u.cache.path('101'), { recursive: true, force: true });
  const reads = [], copy = task(u.root, reads, restApi(u)), snapshot = await copy.workspace.prepare(copy.github, u.second, mirror);
  assert.equal(snapshot.files.length, 3); assert.equal(reads.filter(path => path.startsWith('/git/blobs/')).length, 3);
  const log = copy.logs.find(entry => entry.type === 'snapshot');
  assert.deepEqual([log.source, log.cache], ['github_api', 'unavailable']); assert.match(log.detail, /Git 缓存读不出（.+），文件改经 GitHub API 读取/);
  assert.equal(readFileSync(join(copy.repo, 'README.md'), 'utf8'), 'second\n');
});

test('review tasks on one commit share the mirror and the computer store: the second fetches and sends nothing, and neither reads files through the API', async t => {
  const asked = new Map(), reads = agentReadsFirst(asked), rest = [], manager = { call: async (_method, path, body) => {
    if (!path.endsWith('/execute')) return { repository_id: '101', state: 'ready', generation: 1, desired: 'ready', revision: 1 };
    const request = body.request, read = reads(request); if (read) return read;
    // The real runner operations, with the computer's task and store directories under the test root.
    const answer = run => run.then(result => ({ ok: true, result }), error => ({ ok: false, error: 'runner_operation_failed', detail: error.message }));
    if (['workspace_init', 'workspace_write', 'workspace_snapshot', 'workspace_worktree_create', 'workspace_worktree_bind', 'workspace_context', 'workspace_read'].includes(request.type)) return answer(runnerWorkspace(request, join(u.root, 'tasks'), join(u.root, 'store'), undefined, join(u.root, 'worktrees')));
    if (request.type.startsWith('git_')) return answer(storeOperation(request, join(u.root, 'store')));
    if (request.type === 'workspace_agent_poll') return { ok: true, result: { state: 'completed', result: { summary: 'Reviewed.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' } } };
    return { ok: true, result: {} };
  } };
  let engine; const u = await upstream(t);
  const github = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    rest.push(path);
    if (path === '/user') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main', clone_url: u.url });
    if (path.endsWith('/git/ref/heads/main')) return send({ object: { sha: u.second } });
    if (/\/issues\/\d+$/.test(path)) return send({ number: Number(path.split('/').at(-1)), state: 'open', title: 'Review', body: 'Please review.' });
    if (path.endsWith('/comments')) return send(req.method === 'POST' ? { id: rest.length, body: JSON.parse(raw).body, user: { id: 999 }, html_url: 'https://github.invalid/c' } : [], req.method === 'POST' ? 201 : 200);
    if (path.endsWith('/labels')) return send([]);
    return send({}, 404);
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening'); t.after(() => new Promise(resolve => github.close(resolve)));
  const h = await harness(t, manager, store => ({ engine: engine = new TaskEngine(store, manager, 'http://127.0.0.1:' + github.address().port, u.cache, acceptanceFixture) }));
  t.after(() => engine.close());
  // The bot account's token is the one the Git server accepts.
  const { admin } = await setup(h), a = await account(admin, { token }); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'fixture-model-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, model_id: model.id });
  for (const number of [1, 2]) await h.hook(a.path, a.secret, 'issue-' + number, { repository: { id: 101 }, action: 'opened', issue: { number, title: 'Review', body: 'Please review.' } });
  const run = async () => { pinLegacyTaskConfiguration(h.store); engine.tick(); await Promise.all(engine.active.values()); };
  await run(); const fetched = u.server.requests.length; await run();
  const tasks = h.store.all('SELECT * FROM tasks ORDER BY object_number');
  assert.deepEqual(tasks.map(task => task.status), ['succeeded', 'succeeded']); assert.ok(fetched > 0); assert.equal(u.server.requests.length, fetched);
  assert.deepEqual(rest.filter(path => /\/git\/(?:blobs|trees|commits)\//.test(path)), []);
  const snapshots = tasks.map(task => JSON.parse(h.store.get("SELECT content FROM task_logs WHERE task_id=? AND json_extract(content,'$.type')='snapshot'", task.id).content));
  // The store got the history once.
  assert.deepEqual(snapshots.map(log => [log.source, log.cache, log.files, log.pack_bytes > 0]), [['git_worktree', 'fetched', 3, true], ['git_worktree', 'hit', 3, false]]);
  // #769: the second review took over the worktree the first made, which had ended, instead of checking out another copy.
  // Neither agent chose, so the system's choice applied when each first read a repository file.
  const bound = tasks.map(task => JSON.parse(h.store.get("SELECT data FROM task_history WHERE task_id=? AND type='workspace_bound'", task.id).data));
  assert.deepEqual(bound.map(entry => [entry.mode, entry.reused, entry.head_sha, entry.decided_by]), [['read', false, u.second, 'system'], ['read', true, u.second, 'system']]);
  assert.deepEqual([...asked.values()].map(entry => Object.keys(JSON.parse(entry.reply))), [['worktree'], ['worktree']]);
  assert.deepEqual(tasks.map(task => ({ ...h.store.get('SELECT state,decided_by FROM worktree_plans WHERE task_id=?', task.id) })), [{ state: 'bound', decided_by: 'system' }, { state: 'bound', decided_by: 'system' }]);
  assert.equal(bound[1].worktree_id, bound[0].worktree_id); assert.deepEqual(readdirSync(join(u.root, 'worktrees')), [bound[0].worktree_id]);
  assert.deepEqual(h.store.all('SELECT task_id,release_reason FROM worktree_bindings ORDER BY id').map(row => [row.task_id, row.release_reason]), [[tasks[0].id, 'task_ended'], [tasks[1].id, 'task_ended']]);
  for (const task of tasks) {
    const repo = join(u.root, 'tasks', task.workspace_id, 'repo');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'second\n'); assert.equal(git(repo, 'rev-parse', 'HEAD'), u.second);
    // The history is there, and the Issue and its comments are files next to the checkout.
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal(JSON.parse(readFileSync(join(u.root, 'tasks', task.workspace_id, 'context', 'object.json'), 'utf8')).title, 'Review');
  }
  assert.ok(!JSON.stringify(h.store.all('SELECT content FROM task_logs')).includes(token));
});

test('#769 without a role team the review agent chooses its workspace: no_workspace leaves the computer untouched and the summary says so', async t => {
  const u = await upstream(t), configs = {}, replies = {}, published = [], choice = '2'.repeat(48);
  const manager = { call: async (_method, path, body) => {
    if (!path.endsWith('/execute')) return { repository_id: '101', state: 'ready', generation: 1, desired: 'ready', revision: 1 };
    const request = body.request, answer = run => run.then(result => ({ ok: true, result }), error => ({ ok: false, error: 'runner_operation_failed', detail: error.message }));
    if (request.type.startsWith('git_')) return answer(storeOperation(request, join(u.root, 'store')));
    if (['workspace_context', 'workspace_read', 'workspace_worktree_create', 'workspace_worktree_bind', 'workspace_worktree_inspect'].includes(request.type))
      return answer(runnerWorkspace(request, join(u.root, 'tasks'), join(u.root, 'store'), undefined, join(u.root, 'worktrees')));
    if (request.type === 'workspace_agent_config') { configs[request.workspace_id] = (configs[request.workspace_id] || '') + Buffer.from(request.base64, 'base64').toString('utf8'); return { ok: true, result: { written: true } }; }
    if (request.type === 'workspace_agent_tool') { replies[request.request_id] = (replies[request.request_id] || '') + Buffer.from(request.base64, 'base64').toString('utf8'); return { ok: true, result: { written: true } }; }
    if (request.type !== 'workspace_agent_poll') return { ok: true, result: {} };
    // The agent's first call: this Issue needs no repository files.
    if (!replies[choice]) return { ok: true, result: { state: 'running', tool_requests: [{ id: choice, name: 'no_workspace', arguments: { reason: 'The Issue asks about the release process.' }, kind: 'control' }] } };
    return { ok: true, result: { state: 'completed', result: { summary: 'Answered.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' } } };
  } };
  const github = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'POST') published.push({ path, body: raw ? JSON.parse(raw) : null });
    if (path === '/user') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main', clone_url: u.url });
    if (path.endsWith('/git/ref/heads/main')) return send({ object: { sha: u.second } });
    if (/\/issues\/\d+$/.test(path)) return send({ number: 1, state: 'open', title: 'Release', body: 'How do releases work?' });
    if (path.endsWith('/comments')) return send(req.method === 'POST' ? { id: 1, body: JSON.parse(raw).body, user: { id: 999 }, html_url: 'https://github.invalid/c' } : [], req.method === 'POST' ? 201 : 200);
    if (path.endsWith('/labels')) return send([]);
    return send({}, 404);
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening'); t.after(() => new Promise(resolve => github.close(resolve)));
  let engine; const h = await harness(t, manager, store => ({ engine: engine = new TaskEngine(store, manager, 'http://127.0.0.1:' + github.address().port, u.cache, acceptanceFixture) }));
  t.after(() => engine.close());
  const { admin } = await setup(h), a = await account(admin, { token }); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'fixture-model-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, model_id: model.id });
  await h.hook(a.path, a.secret, 'issue-1', { repository: { id: 101 }, action: 'opened', issue: { number: 1, title: 'Release', body: 'How do releases work?' } });
  // This fixture exercises the historical route without a role team; current projects use Manager by default.
  pinLegacyTaskConfiguration(h.store); engine.tick(); await Promise.all(engine.active.values());
  const task = h.store.get('SELECT * FROM tasks');
  assert.equal(task.status, 'succeeded', task.error_code);
  // The agent was offered the four tools, as control-plane tools, with the rule in its system prompt and its commit in context.
  const config = JSON.parse(configs[task.workspace_id]);
  assert.deepEqual(['list_workspaces', 'use_workspace', 'create_workspace', 'no_workspace'].map(name => [config.tools.some(tool => tool.function.name === name), config.control_tools.includes(name)]), Array(4).fill([true, true]));
  assert.match(config.system, /Repository workspace: this task holds no worktree until it first needs repository files/);
  assert.deepEqual(JSON.parse(task.input).context.workspace, { commit: u.second, mode: 'read', worktree: 'not_bound', binding: 'The first repository read or command binds an unchanged worktree of this commit that no task holds, or a new one.' });
  assert.equal(JSON.parse(replies[choice]).result.ok, true);
  // No worktree was made or taken, and the published summary does not claim a checkout.
  assert.deepEqual([exists(join(u.root, 'worktrees')), exists(join(u.root, 'tasks', task.workspace_id, 'repo')), h.store.get('SELECT count(*) n FROM worktree_bindings').n], [false, false, 0]);
  assert.deepEqual({ ...h.store.get('SELECT state,decided_by,reason FROM worktree_plans WHERE task_id=?', task.id) }, { state: 'none', decided_by: 'agent', reason: 'The Issue asks about the release process.' });
  const summary = published.find(entry => entry.path.endsWith('/issues/1/comments')).body.body;
  assert.match(summary, /Coverage: No checkout: the agent worked without the repository files \(The Issue asks about the release process\.\)/);
  const logs = h.store.all('SELECT content FROM task_logs WHERE task_id=?', task.id).map(row => JSON.parse(row.content));
  assert.deepEqual(logs.filter(log => log.type === 'workspace_chosen').map(log => [log.decided_by, log.choice, log.detail]), [['agent', 'none', '执行 agent 决定不用工作区：The Issue asks about the release process.']]);
});

// A task on a project computer: the real runner's workspace and store operations, in directories under the test root, and
// the control plane's records of the computer's worktrees in one store per computer (#769). `kind` decides nothing here:
// the caller passes the mode to bind().
const computers = new Map();
function computerStore(root) {
  if (!computers.has(root)) { const store = new Store(':memory:', Buffer.alloc(32, 9));
    store.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}',?)", new Date().toISOString()); store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')"); computers.set(root, store); }
  return computers.get(root);
}
function computerTask(root, kind = 'development.issue') {
  const id = randomBytes(24).toString('hex'), logs = [], redactor = new Redactor(), store = computerStore(root); redactor.add(token);
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,generation,attempt,workspace_id) VALUES(?,'101',?,'running','',1,1,?)", 'task-' + id, kind, id);
  const workspace = new Workspace(store, null, { id: 'task-' + id, repository_id: '101', kind, attempt: 1, generation: 1, workspace_id: id }, redactor, async () => {}, value => logs.push(value));
  const run = request => (request.type.startsWith('git_') ? storeOperation(request, join(root, 'store')) : runnerWorkspace({ ...request, workspace_id: id }, join(root, 'tasks'), join(root, 'store'), undefined, join(root, 'worktrees')))
    .catch(error => ({ error: 'runner_operation_failed', detail: error.message }));
  workspace.call = (_key, request) => run(request); workspace.deliver = request => run(request);
  return { id, logs, workspace, run, store, github: { authorEmail: () => '999+fixture-bot@users.noreply.github.com' }, root: join(root, 'tasks', id), repo: join(root, 'tasks', id, 'repo'),
    snapshot: () => logs.find(entry => entry.type === 'snapshot'), finish: () => store.run("UPDATE tasks SET status='succeeded' WHERE id=?", 'task-' + id) };
}

// The same task with the control plane's own calls (#769): operations are recorded, and a call that needs the files binds
// the task's worktree first.
function plannedTask(root, kind = 'review.pr') {
  const id = randomBytes(24).toString('hex'), logs = [], calls = [], redactor = new Redactor(), store = computerStore(root); redactor.add(token);
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,generation,attempt,workspace_id) VALUES(?,'101',?,'running','',1,1,?)", 'task-' + id, kind, id);
  const run = request => request.type.startsWith('git_') ? storeOperation(request, join(root, 'store')) : runnerWorkspace(request, join(root, 'tasks'), join(root, 'store'), undefined, join(root, 'worktrees'));
  const manager = { call: async (_method, _path, body) => { calls.push(body.request.type); return run(body.request).then(result => ({ ok: true, result }), error => ({ ok: false, error: 'runner_operation_failed', detail: error.message })); } };
  const workspace = new Workspace(store, manager, { id: 'task-' + id, repository_id: '101', kind, attempt: 1, generation: 1, workspace_id: id }, redactor, async () => {}, value => logs.push(value));
  return { id, logs, calls, workspace, store, github: { authorEmail: () => '999+fixture-bot@users.noreply.github.com' }, repo: join(root, 'tasks', id, 'repo'), context: join(root, 'tasks', id, 'context'),
    plan: (sha, mirror, mode = kind.startsWith('review.') ? 'read' : 'write') => workspace.plan({ authorEmail: () => '999+fixture-bot@users.noreply.github.com' }, sha, mirror, [], mode),
    history: type => store.all('SELECT data FROM task_history WHERE task_id=? AND type=? ORDER BY id', 'task-' + id, type).map(row => JSON.parse(row.data)),
    finish: () => store.run("UPDATE tasks SET status='succeeded' WHERE id=?", 'task-' + id) };
}
const exists = path => !!lstatSync(path, { throwIfNoEntry: false });

test('#769 a planned task holds no worktree until a call needs its files; then the system\'s choice applies once', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.first, u.second] });
  const a = plannedTask(u.root), planned = await a.plan(u.second, mirror);
  assert.equal(planned.worktree, null); assert.equal(planned.tree_sha, git(u.bare, 'rev-parse', u.second + '^{tree}'));
  assert.deepEqual(planned.files.map(f => f.path).sort(), ['README.md', 'link.md', 'src/run.sh']); assert.equal(planned.history, true);
  assert.match(a.logs.find(entry => entry.type === 'snapshot').detail, /worktree 在第一次用到文件时建立/);
  assert.deepEqual({ ...a.workspace.plannedWorktree(), created_at: undefined }, { task_id: 'task-' + a.id, workspace_id: a.id, repository_id: '101', head_sha: u.second, tree_sha: planned.tree_sha, mode: 'read',
    author_email: '999+fixture-bot@users.noreply.github.com', state: 'planned', decided_by: null, reason: null, created_at: undefined, decided_at: null });
  // The task context needs no worktree.
  await a.workspace.context({ 'object.json': '{"title":"Fix"}' });
  assert.equal((await a.workspace.call('context', { type: 'workspace_read', path: '../context/object.json' })).content, '{"title":"Fix"}');
  assert.equal(exists(a.repo), false); assert.equal(exists(join(u.root, 'worktrees')), false);
  // The first repository read binds the system's choice: no other worktree of the commit, so a new one for reading.
  assert.equal((await a.workspace.call('read', { type: 'workspace_read', path: 'README.md' })).content, 'second\n');
  assert.equal((await a.workspace.call('again', { type: 'workspace_read', path: 'README.md' })).content, 'second\n');
  assert.deepEqual(a.calls.filter(type => type.startsWith('workspace_worktree_')), ['workspace_worktree_create']);
  const [first] = a.history('workspace_bound');
  assert.deepEqual([first.mode, first.reused, first.head_sha, first.decided_by], ['read', false, u.second, 'system']);
  assert.deepEqual(a.logs.filter(entry => entry.type === 'workspace_chosen').map(entry => [entry.decided_by, entry.choice, entry.mode]), [['system', 'create', 'read']]);
  assert.equal(a.workspace.plannedWorktree().state, 'bound');
  // The next reader of the commit takes it over once a ended; a writer always gets its own.
  a.finish(); const b = plannedTask(u.root); await b.plan(u.second, mirror);
  assert.deepEqual([(await b.workspace.ensure()).worktree.reused, realpathSync(b.repo)], [true, realpathSync(a.repo)]);
  b.finish(); const c = plannedTask(u.root, 'development.issue'); await c.plan(u.second, mirror);
  assert.equal((await c.workspace.ensure()).worktree.reused, false); assert.notEqual(realpathSync(c.repo), realpathSync(a.repo));
  // A review whose pull request moves before it read anything follows the new head by its plan alone.
  const d = plannedTask(u.root); await d.plan(u.first, mirror);
  const moved = await d.workspace.advance(u.second, mirror, [], '1');
  assert.deepEqual([moved.previous_sha, moved.saved, moved.tree_sha, d.workspace.plannedWorktree().head_sha, exists(d.repo)], [u.first, null, planned.tree_sha, u.second, false]);
});

test('#769 the task\'s own choice: share a reader\'s worktree, take a changed one only with reset or keep_changes, make one, or none', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.first, u.second] });
  const a = plannedTask(u.root); await a.plan(u.second, mirror); const held = (await a.workspace.ensure()).worktree, path = join(u.root, 'worktrees', held.id);
  // The system would not give a running reader's worktree to another task; the task itself may share it for reading.
  const b = plannedTask(u.root); await b.plan(u.second, mirror);
  const listed = await listWorkspaces(b.workspace);
  assert.deepEqual(listed.task, { commit: u.second, tree_sha: held && git(u.bare, 'rev-parse', u.second + '^{tree}'), mode: 'read', holds: null, system_choice: { action: 'create', mode: 'read' } });
  assert.deepEqual(listed.worktrees.map(w => [w.worktree_id, w.head, w.at_task_commit, w.made_for, w.changed_count, w.holders.map(h => [h.task_id, h.kind, h.mode, h.running])]),
    [[held.id, u.second, true, 'read', 0, [['task-' + a.id, 'review.pr', 'read', true]]]]);
  const shared = await workspaceTool(b.workspace, 'use_workspace', { worktree_id: held.id, mode: 'read' }, 'agent', '1'.repeat(48));
  assert.deepEqual([shared.worktree_id, shared.mode, shared.head, shared.changed_count], [held.id, 'read', u.second, 0]); assert.equal(realpathSync(b.repo), path);
  assert.deepEqual(b.history('workspace_bound').map(entry => [entry.worktree_id, entry.mode, entry.reused, entry.decided_by]), [[held.id, 'read', true, 'agent']]);
  // Once bound, the task keeps its worktree for the attempt.
  assert.equal((await workspaceTool(b.workspace, 'create_workspace', {}, 'agent')).error, 'workspace_already_bound');
  // A writer: never read-only, never without files, and only a worktree nobody holds.
  const c = plannedTask(u.root, 'development.issue'); await c.plan(u.second, mirror);
  assert.deepEqual(await Promise.all([{ worktree_id: held.id }, { worktree_id: held.id, mode: 'read' }].map(args => workspaceTool(c.workspace, 'use_workspace', args, 'agent').then(r => r.error))), ['workspace_busy', 'workspace_mode_not_allowed']);
  assert.equal((await workspaceTool(c.workspace, 'no_workspace', { reason: 'none' }, 'agent')).error, 'workspace_required');
  assert.equal((await workspaceTool(c.workspace, 'use_workspace', { worktree_id: 'x' }, 'agent')).error, 'invalid_arguments');
  // With the readers done, a reader's leftover change is taken only with on_changes; a refused choice changes nothing.
  a.finish(); b.finish(); writeFileSync(join(path, 'README.md'), 'changed by a reader\n');
  const dirty = await workspaceTool(c.workspace, 'use_workspace', { worktree_id: held.id }, 'agent');
  assert.deepEqual([dirty.error, dirty.changed_count, dirty.changed], ['workspace_dirty', 1, ['README.md']]); assert.match(dirty.message, /on_changes reset/);
  assert.deepEqual([{ ...c.store.get('SELECT state FROM worktrees WHERE id=?', held.id) }, exists(c.repo), readFileSync(join(path, 'README.md'), 'utf8')], [{ state: 'ready' }, false, 'changed by a reader\n']);
  const reset = await workspaceTool(c.workspace, 'use_workspace', { worktree_id: held.id, on_changes: 'reset' }, 'manager');
  assert.deepEqual([reset.worktree_id, reset.mode, reset.changed_count, reset.saved_changes.count], [held.id, 'write', 0, 1]);
  assert.match(readFileSync(join(c.context, reset.saved_changes.path.slice('../context/'.length)), 'utf8'), /\+changed by a reader/);
  assert.equal((await c.workspace.call('read', { type: 'workspace_read', path: 'README.md' })).content, 'second\n');
  assert.deepEqual(c.logs.filter(entry => entry.type === 'workspace_chosen').map(entry => [entry.decided_by, entry.choice, entry.mode, entry.on_changes]), [['manager', 'use', 'write', 'reset']]);
  assert.match(c.logs.find(entry => entry.type === 'workspace_chosen').detail, /^主控 manager 选用 worktree .*，先还原，原有改动（1 个文件）已保存到 \.\.\/context\/saved-changes-/);
  // keep_changes: the next writer works on top of the changes the last one left, at the task's commit.
  c.finish(); writeFileSync(join(path, 'README.md'), 'work in progress\n');
  const e = plannedTask(u.root, 'development.issue'); await e.plan(u.second, mirror);
  const kept = await workspaceTool(e.workspace, 'use_workspace', { worktree_id: held.id, on_changes: 'keep_changes' }, 'agent');
  assert.deepEqual([kept.changed_count, (await e.workspace.call('read', { type: 'workspace_read', path: 'README.md' })).content], [1, 'work in progress\n']);
  // A reader that needs no files: nothing is made, a repository call says why, and the review's coverage says so too.
  const f = plannedTask(u.root); await f.plan(u.second, mirror);
  assert.equal((await workspaceTool(f.workspace, 'no_workspace', {}, 'agent')).error, 'invalid_arguments');
  assert.equal((await workspaceTool(f.workspace, 'no_workspace', { reason: 'The question is about the release process.' }, 'agent')).ok, true);
  const refused = await f.workspace.call('read', { type: 'workspace_read', path: 'README.md' });
  assert.deepEqual([refused.error, exists(f.repo)], ['no_workspace', false]); assert.match(refused.message, /\(The question is about the release process\.\)/);
  assert.deepEqual(workspaceCoverage(f.workspace, ['Checkout: 3 files at x', 'Other']), ['No checkout: the agent worked without the repository files (The question is about the release process.)', 'Other']);
  assert.deepEqual(f.history('workspace_none').map(entry => [entry.decided_by, entry.reason]), [['agent', 'The question is about the release process.']]);
  // It may still change its mind before it holds one.
  const made = await workspaceTool(f.workspace, 'create_workspace', {}, 'agent');
  assert.deepEqual([made.created, made.mode, (await f.workspace.call('read2', { type: 'workspace_read', path: 'README.md' })).content], [true, 'read', 'second\n']);
  assert.notEqual(made.worktree_id, held.id);
});

test('a task checks out a git worktree with the history; the computer store receives only the commits it lacks', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second, u.first] });
  const a = computerTask(u.root), snapshot = await a.workspace.bind(a.github, u.second, mirror, [u.first], 'write');
  assert.equal(snapshot.history, true); assert.equal(snapshot.tree_sha, git(u.bare, 'rev-parse', u.second + '^{tree}'));
  assert.deepEqual(snapshot.files.map(f => f.path).sort(), ['README.md', 'link.md', 'src/run.sh']); assert.deepEqual(snapshot.skipped_files.map(f => f.path), ['vendor/module']);
  // The files are the commit's, with modes and links; the history and a pull request's base are there for git.
  assert.equal(readFileSync(join(a.repo, 'README.md'), 'utf8'), 'second\n'); assert.ok(statSync(join(a.repo, 'src', 'run.sh')).mode & 0o100);
  assert.equal(git(a.repo, 'rev-list', '--count', 'HEAD'), '2'); assert.match(git(a.repo, 'diff', '--stat', `${u.first}...${u.second}`), /README\.md/);
  assert.ok(a.snapshot().pack_bytes > 0); assert.equal(a.snapshot().source, 'git_worktree');
  // Another task that writes on the same commit gets its own worktree and nothing travels.
  const b = computerTask(u.root); await b.workspace.bind(b.github, u.second, mirror, [], 'write');
  assert.notEqual(realpathSync(b.repo), realpathSync(a.repo));
  assert.equal(b.snapshot().pack_bytes, 0); assert.equal(git(b.repo, 'rev-parse', 'HEAD'), u.second);
  // A new upstream commit: only it is sent.
  writeFileSync(join(u.work, 'README.md'), 'third\n'); git(u.work, 'add', 'README.md'); git(u.work, 'commit', '-qm', 'third');
  const third = git(u.work, 'rev-parse', 'HEAD'); git(u.work, 'push', '-q', u.bare, `${third}:refs/heads/main`);
  const next = await u.cache.open('101', { url: u.url, token, commits: [third] }), c = computerTask(u.root); await c.workspace.bind(c.github, third, next, [], 'write');
  assert.ok(c.snapshot().pack_bytes > 0 && c.snapshot().pack_bytes < a.snapshot().pack_bytes, String(c.snapshot().pack_bytes));
  // Task context sits next to the checkout and is read as ../context/<path>; it cannot reach the repository from there.
  await a.workspace.context({ 'object.json': '{"title":"Fix"}', 'skills/ci/SKILL.md': '# CI\nRun the checks.\n' });
  assert.equal((await a.run({ type: 'workspace_read', path: '../context/skills/ci/SKILL.md' })).content, '# CI\nRun the checks.\n');
  assert.equal((await a.run({ type: 'workspace_read', path: '../context/../repo/README.md' })).error, 'runner_operation_failed');
  // A context file of a normal pull request is far larger than one chunk; it arrives whole.
  const files = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ filename: `src/file-${i}.js`, patch: '@@ -1 +1 @@\n-old\n+new line ' + 'x'.repeat(200) })));
  await a.workspace.context({ 'files.json': files }); assert.ok(files.length > 100000);
  assert.equal((await a.run({ type: 'workspace_read', path: '../context/files.json' })).content, files);
  assert.equal(git(a.repo, 'status', '--porcelain'), '');
  // A development candidate leaves the submodule entry as the base tree has it.
  writeFileSync(join(a.repo, 'README.md'), 'changed\n');
  const candidate = await a.run({ type: 'workspace_finalize' });
  assert.deepEqual(candidate.files.map(f => f.path).sort(), ['README.md', 'link.md', 'src/run.sh']);
});

test('#769 a reader takes a free, unchanged worktree of its commit; writers and changed or held worktrees are never handed over', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.first, u.second] });
  const a = computerTask(u.root, 'review.pr'), first = await a.workspace.bind(a.github, u.second, mirror, [], 'read');
  assert.deepEqual([first.worktree.mode, first.worktree.reused], ['read', false]);
  // While its task runs, the worktree is held: another reader gets its own.
  const b = computerTask(u.root, 'review.pr'), held = await b.workspace.bind(b.github, u.second, mirror, [], 'read');
  assert.equal(held.worktree.reused, false); assert.notEqual(held.worktree.id, first.worktree.id);
  // Once its task ended, the next reader takes it over.
  a.finish();
  const c = computerTask(u.root, 'review.pr'), reused = await c.workspace.bind(c.github, u.second, mirror, [], 'read');
  assert.deepEqual([reused.worktree.id, reused.worktree.reused], [first.worktree.id, true]); assert.equal(realpathSync(c.repo), realpathSync(a.repo));
  assert.match(c.snapshot().detail, /已复用 worktree/);
  // A writer never gets a reader's worktree, and a reader never gets a writer's.
  c.finish(); const d = computerTask(u.root), written = await d.workspace.bind(d.github, u.second, mirror, [], 'write');
  assert.notEqual(written.worktree.id, first.worktree.id); d.finish();
  const e = computerTask(u.root, 'review.pr'), notWriters = await e.workspace.bind(e.github, u.second, mirror, [], 'read');
  assert.equal(notWriters.worktree.id, first.worktree.id); e.finish();
  // A reader that changed a tracked file leaves a worktree that fails the check: the next reader gets a new one, and the
  // changed worktree is not offered again.
  writeFileSync(join(e.repo, 'README.md'), 'changed by a reader\n');
  const f = computerTask(u.root, 'review.pr'), fresh = await f.workspace.bind(f.github, u.second, mirror, [], 'read');
  assert.notEqual(fresh.worktree.id, first.worktree.id);
  assert.deepEqual(f.logs.filter(entry => entry.worktree_refused).map(entry => [entry.type, entry.worktree_refused.worktree_id, entry.worktree_refused.reason, entry.worktree_refused.changed_count]),
    [['snapshot_progress', first.worktree.id, 'workspace_dirty', 1]]);
  assert.deepEqual([a.store.get('SELECT state,state_reason FROM worktrees WHERE id=?', first.worktree.id)].map(row => [row.state, row.state_reason]), [['refused', 'workspace_dirty']]);
  assert.equal(readFileSync(join(u.root, 'worktrees', first.worktree.id, 'README.md'), 'utf8'), 'changed by a reader\n', 'nothing was discarded');
  // Another commit is another worktree.
  f.finish(); const g = computerTask(u.root, 'review.pr'), older = await g.workspace.bind(g.github, u.first, mirror, [], 'read');
  assert.equal(older.worktree.reused, false); assert.equal(git(g.repo, 'rev-parse', 'HEAD'), u.first);
  // The same workspace preparing again (a retry of the same attempt) takes its own worktree back after the check; asked
  // for another commit, it lets go of it without marking it, and another reader can take it.
  const again = await g.workspace.bind(g.github, u.first, mirror, [], 'read');
  assert.deepEqual([again.worktree.id, again.worktree.reused], [older.worktree.id, true]);
  const moved = await g.workspace.bind(g.github, u.second, mirror, [], 'read');
  assert.notEqual(moved.worktree.id, older.worktree.id); assert.equal(git(g.repo, 'rev-parse', 'HEAD'), u.second);
  assert.deepEqual([a.store.get('SELECT state FROM worktrees WHERE id=?', older.worktree.id).state,
    a.store.get('SELECT release_reason FROM worktree_bindings WHERE worktree_id=? ORDER BY id DESC LIMIT 1', older.worktree.id).release_reason], ['ready', 'task_commit_changed']);
  g.finish(); const h = computerTask(u.root, 'review.pr');
  assert.equal((await h.workspace.bind(h.github, u.first, mirror, [], 'read')).worktree.id, older.worktree.id);
  // Every binding is recorded with its task, mode and commit, and the cleanup knows each task used the worktree.
  assert.deepEqual(a.store.all("SELECT task_id FROM task_workspaces WHERE workspace_id=? AND kind='worktree' ORDER BY task_id", first.worktree.id).map(row => row.task_id).sort(),
    ['task-' + a.id, 'task-' + c.id, 'task-' + e.id, 'task-' + f.id].sort());
});

test('a repository file holding a task credential stops the checkout before anything is sent to the computer', async t => {
  const u = await upstream(t);
  writeFileSync(join(u.work, 'leak.txt'), `token=${token}\n`); git(u.work, 'add', 'leak.txt'); git(u.work, 'commit', '-qm', 'leak');
  const leaked = git(u.work, 'rev-parse', 'HEAD'); git(u.work, 'push', '-q', u.bare, `${leaked}:refs/heads/main`);
  const mirror = await u.cache.open('101', { url: u.url, token, commits: [leaked] }), a = computerTask(u.root);
  await assert.rejects(a.workspace.bind(a.github, leaked, mirror, [], 'read'), { code: 'credential_in_repository', detail: 'Credential found in repository file: leak.txt' });
  assert.deepEqual((await a.run({ type: 'git_have' })).commits, []);
});

test('removing a task directory removes its worktree registration too; a directory active since the listing stays', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second] });
  const old = computerTask(u.root), recent = computerTask(u.root), tasks = join(u.root, 'tasks'), store = join(u.root, 'store');
  // Each has a checkout of its own in its directory, as workspace_checkout makes it (an isolated run environment); the
  // first bind only brings the commit into the computer's store.
  const tree = git(u.bare, 'rev-parse', u.second + '^{tree}'); await old.workspace.bind(old.github, u.second, mirror, [], 'write');
  for (const one of [old, recent]) assert.equal((await one.run({ type: 'workspace_checkout', sha: u.second, tree_sha: tree })).tree_sha, tree);
  const listed = await listTaskDirectories(tasks);
  assert.equal(listed.total, 2); assert.deepEqual(listed.entries.map(entry => entry.name).sort(), [old.id, recent.id].sort());
  // The recent task's agent writes its events after the listing.
  const later = (Date.now() + 60_000) / 1000; mkdirSync(join(recent.root, 'agent'), { recursive: true });
  writeFileSync(join(recent.root, 'agent', 'events.jsonl'), ''); utimesSync(join(recent.root, 'agent', 'events.jsonl'), later, later);
  const result = await removeTaskDirectories(listed.entries, tasks, store);
  assert.deepEqual(result.removed.map(entry => entry.name), [old.id]); assert.ok(result.removed[0].bytes > 0);
  assert.deepEqual(result.skipped, [{ name: recent.id, reason: 'changed' }]);
  assert.deepEqual(readdirSync(tasks), [recent.id]);
  const worktrees = git(join(store, 'repo.git'), 'worktree', 'list');
  assert.doesNotMatch(worktrees, new RegExp(old.id)); assert.match(worktrees, new RegExp(recent.id));
});

test('a credential inside a binary file stops the checkout too', async t => {
  const u = await upstream(t);
  writeFileSync(join(u.work, 'build.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(token), Buffer.from([0])])); git(u.work, 'add', 'build.bin'); git(u.work, 'commit', '-qm', 'binary');
  const sha = git(u.work, 'rev-parse', 'HEAD'); git(u.work, 'push', '-q', u.bare, `${sha}:refs/heads/main`);
  const mirror = await u.cache.open('101', { url: u.url, token, commits: [sha] }), a = computerTask(u.root);
  await assert.rejects(a.workspace.bind(a.github, sha, mirror, [], 'read'), { code: 'credential_in_repository', detail: 'Credential found in repository file: build.bin' });
});

test('a workspace holding an earlier file copy of the same tree is replaced by a worktree with the history', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second] }), a = computerTask(u.root);
  // The copy keeps the tree but is its own one-commit repository.
  await a.workspace.prepare(a.github, u.second, mirror);
  assert.equal(git(a.repo, 'rev-list', '--count', 'HEAD'), '1'); assert.notEqual(git(a.repo, 'rev-parse', 'HEAD'), u.second);
  const snapshot = await a.workspace.bind(a.github, u.second, mirror, [], 'write');
  assert.equal(snapshot.history, true); assert.equal(git(a.repo, 'rev-parse', 'HEAD'), u.second); assert.equal(git(a.repo, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(lstatSync(a.repo).isSymbolicLink(), true, 'the copy made way for a link to the shared worktree');
});

test('checkouts in two workspaces of one task attempt are separate operations, and import and checkout wait as long as they run', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second] });
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,generation,attempt) VALUES('keys','101','review.issue','running','',1,1)");
  const task = { ...h.store.get("SELECT * FROM tasks WHERE id='keys'"), workspace_id: randomBytes(24).toString('hex') }, waits = {};
  // The real control-plane calls, recorded per task, with the runner operations behind a stand-in manager.
  const manager = { call: async (_method, _path, input, wait) => {
    const request = input.request; waits[request.type] = wait;
    const result = await (request.type.startsWith('git_') ? storeOperation(request, join(u.root, 'store')) : runnerWorkspace(request, join(u.root, 'tasks'), join(u.root, 'store'), undefined, join(u.root, 'worktrees')))
      .then(value => ({ ok: true, result: value }), error => ({ ok: false, error: 'runner_operation_failed', detail: error.message }));
    return result;
  } };
  const redactor = new Redactor(); redactor.add(token);
  const workspace = new ControlWorkspace(h.store, manager, task, redactor, async () => {}, () => {}), github = { authorEmail: () => '999+fixture-bot@users.noreply.github.com' };
  const first = await workspace.bind(github, u.second, mirror, [], 'read'); assert.equal(first.history, true); assert.equal(first.worktree.reused, false);
  // The same attempt moves to another workspace (as after a fallback) and binds again: its earlier binding ends, so the
  // worktree it made is free and checked again for the new workspace.
  task.workspace_id = randomBytes(24).toString('hex');
  const second = await workspace.bind(github, u.second, mirror, [], 'read');
  assert.deepEqual([second.history, second.worktree.id, second.worktree.reused], [true, first.worktree.id, true]);
  assert.equal(git(join(u.root, 'tasks', task.workspace_id, 'repo'), 'rev-parse', 'HEAD'), u.second);
  assert.deepEqual([waits.git_import, waits.workspace_worktree_create, waits.workspace_worktree_bind], [0, 0, 0]);
});

test('a pack left by an interrupted transfer is removed after a few hours', async t => {
  const root = mkdtempSync(join(tmpdir(), 'store-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = 'a'.repeat(48);
  await storeOperation({ type: 'git_pack', pack_id: pack, base64: Buffer.from('PACK').toString('base64'), offset: 0 }, root);
  assert.deepEqual(readdirSync(join(root, 'incoming')), [pack + '.pack']);
  assert.deepEqual(await pruneStore(Date.now() + 60_000, root), { packs: 0 }); assert.equal(readdirSync(join(root, 'incoming')).length, 1);
  assert.deepEqual(await pruneStore(Date.now() + 7 * 3600 * 1000, root), { packs: 1 }); assert.deepEqual(readdirSync(join(root, 'incoming')), []);
});

test('a worktree moves to a new head in place: untracked files stay, and changes are saved as a patch first', async t => {
  const u = await upstream(t);
  // A third commit adds a file the task already has, untracked.
  writeFileSync(join(u.work, 'NEW.md'), 'upstream\n'); git(u.work, 'add', 'NEW.md'); git(u.work, 'commit', '-qm', 'third');
  const third = git(u.work, 'rev-parse', 'HEAD'); git(u.work, 'push', '-q', u.bare, `${third}:refs/heads/main`);
  const mirror = await u.cache.open('101', { url: u.url, token, commits: [u.first, third] }), a = computerTask(u.root);
  await a.workspace.bind(a.github, u.first, mirror, [], 'read');
  writeFileSync(join(a.repo, 'README.md'), 'edited by the agent\n'); writeFileSync(join(a.repo, 'NEW.md'), 'mine\n');
  mkdirSync(join(a.repo, 'build')); writeFileSync(join(a.repo, 'build', 'out.txt'), 'kept\n');
  const moved = await a.workspace.advance(third, mirror, [], '1');
  assert.equal(git(a.repo, 'rev-parse', 'HEAD'), third); assert.equal(moved.previous_sha, u.first); assert.equal(moved.tree_sha, git(u.bare, 'rev-parse', third + '^{tree}'));
  assert.equal(readFileSync(join(a.repo, 'README.md'), 'utf8'), 'second\n'); assert.equal(readFileSync(join(a.repo, 'NEW.md'), 'utf8'), 'upstream\n');
  assert.equal(readFileSync(join(a.repo, 'build', 'out.txt'), 'utf8'), 'kept\n');
  assert.deepEqual([moved.saved.path, moved.saved.count, [...moved.saved.files].sort()], [`../context/saved-changes-${u.first.slice(0, 12)}.patch`, 2, ['NEW.md', 'README.md']]);
  const patch = readFileSync(join(a.root, 'context', `saved-changes-${u.first.slice(0, 12)}.patch`), 'utf8');
  assert.match(patch, /^\+edited by the agent$/m); assert.match(patch, /^\+mine$/m);
  // At the commit already there is nothing to move or save; a file copy has no worktree to move.
  assert.equal((await a.workspace.advance(third, mirror, [], '2')).saved, null);
  const copy = computerTask(u.root); await copy.workspace.prepare(copy.github, u.first, mirror);
  assert.equal(await copy.workspace.advance(third, mirror, [], '1'), null);
});

test('a push while a review runs joins it: the worktree moves to the new head and the agent hears what changed (#770)', async t => {
  const u = await upstream(t), user = { type: 'User', login: 'alice', id: 5 }, replies = {}, published = [], reads = agentReadsFirst(new Map());
  let pr = { number: 7, state: 'open', draft: false, title: 'Change', body: 'Please review.', user: { id: 5 }, head: { sha: u.first, ref: 'feature' }, base: { sha: u.first, ref: 'main' } };
  let engine, h, polls = 0, joined = 0, context;
  const manager = { call: async (_method, path, body) => {
    if (!path.endsWith('/execute')) return { repository_id: '101', state: 'ready', generation: 1, desired: 'ready', revision: 1 };
    const request = body.request, read = reads(request); if (read) return read;
    const answer = run => run.then(result => ({ ok: true, result }), error => ({ ok: false, error: 'runner_operation_failed', detail: error.message }));
    if (['workspace_init', 'workspace_write', 'workspace_snapshot', 'workspace_worktree_create', 'workspace_worktree_bind', 'workspace_advance', 'workspace_context', 'workspace_read'].includes(request.type))
      return answer(runnerWorkspace(request, join(u.root, 'tasks'), join(u.root, 'store'), undefined, join(u.root, 'worktrees')));
    if (request.type.startsWith('git_')) return answer(storeOperation(request, join(u.root, 'store')));
    if (request.type === 'workspace_agent_boundary') {
      replies[request.request_id] = (replies[request.request_id] || '') + Buffer.from(request.base64, 'base64').toString('utf8'); return { ok: true, result: {} };
    }
    if (request.type !== 'workspace_agent_poll') return { ok: true, result: {} };
    if (++polls === 1) return { ok: true, result: { state: 'running', boundary: { id: '1'.repeat(48), stage: 'start' } } };
    if (polls === 2) {
      // The author pushes while the agent works. The push joins this review instead of starting another one.
      pr = { ...pr, head: { ...pr.head, sha: u.second } };
      joined = queueWebhook(h.store, '101', 'pull_request', { repository: { id: 101 }, action: 'synchronize', before: u.first, pull_request: pr, sender: user }, 'push');
      context = dispatchContext(h.store, h.store.get("SELECT * FROM dispatch_events WHERE type='pull_request.synchronize'"));
      return { ok: true, result: { state: 'running', boundary: { id: '2'.repeat(48), stage: 'turn' } } };
    }
    return { ok: true, result: { state: 'completed', result: { summary: 'Reviewed.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' } } };
  } };
  const github = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://fixture').pathname, send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'POST') published.push({ path, body: raw ? JSON.parse(raw) : null });
    if (path === '/user') return send({ id: 999, login: 'fixture-bot' });
    if (path === '/repositories/101') return send({ id: 101, owner: { id: 10 }, full_name: 'fixture/project-101', default_branch: 'main', clone_url: u.url });
    if (path.endsWith('/git/ref/heads/main')) return send({ object: { sha: u.first } });
    if (path.endsWith('/pulls/7')) return send(pr);
    if (path.endsWith(`/compare/${u.first}...${u.second}`)) return send({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      commits: [{ sha: u.second, author: { login: 'alice' }, commit: { message: 'second\n\nWith a body.' } }], files: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 1 }] });
    if (path.endsWith('/pulls/7/files')) return send([{ filename: 'README.md', status: 'modified', patch: '@@ -1 +1 @@\n-first\n+second' }]);
    if (/\/(pulls\/7\/(reviews|comments)|issues\/7\/comments)$/.test(path)) return req.method === 'POST' ? send({ id: published.length, html_url: 'https://github.invalid/r', user: { id: 999 } }, 201) : send([]);
    if (path.endsWith('/labels')) return send([]);
    return send({}, 404);
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening'); t.after(() => new Promise(resolve => github.close(resolve)));
  h = await harness(t, manager, store => ({ engine: engine = new TaskEngine(store, manager, 'http://127.0.0.1:' + github.address().port, u.cache, acceptanceFixture) }));
  t.after(() => engine.close());
  const { admin } = await setup(h), a = await account(admin, { token }); await repository(admin, a.id, '101');
  const model = (await admin('/api/models', 'POST', { repository_id: '101', api_url: 'https://model.invalid/v1', api_key: 'fixture-model-key', model_name: 'fixture' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, model_id: model.id });
  assert.equal(queueWebhook(h.store, '101', 'pull_request', { repository: { id: 101 }, action: 'opened', pull_request: pr, sender: user }, 'opened'), 1);
  pinLegacyTaskConfiguration(h.store); engine.tick(); await Promise.all(engine.active.values());

  const task = h.store.get('SELECT * FROM tasks');
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 1); assert.equal(joined, 0);
  // While a review can take the push, a second review of the PR is not even offered.
  assert.deepEqual([context.continuations.map(option => option.task_id), context.options.some(option => option.id === 'review')], [[task.id], false]);
  assert.deepEqual([task.status, task.head_sha], ['succeeded', u.second]);
  assert.equal(git(join(u.root, 'tasks', task.workspace_id, 'repo'), 'rev-parse', 'HEAD'), u.second);
  // The worktree's record names the new head, so the next review of it can take this worktree over (#769).
  const worktree = h.store.get('SELECT w.* FROM worktrees w JOIN worktree_bindings b ON b.worktree_id=w.id WHERE b.task_id=?', task.id);
  assert.deepEqual([worktree.head_sha, worktree.tree_sha, worktree.state], [u.second, git(u.bare, 'rev-parse', u.second + '^{tree}'), 'ready']);
  const result = JSON.parse(task.result);
  assert.deepEqual([result.reviewed_sha, result.reviewed_heads], [u.second, [u.first, u.second]]);
  // The agent got one message for the push: both heads, the commits and files between them, and who pushed.
  const [message, ...others] = JSON.parse(replies['2'.repeat(48)]).messages.map(text => JSON.parse(text));
  assert.deepEqual(others, []); assert.match(message.instruction, /^The task you are working on has an update: the pull request has new commits/);
  assert.deepEqual([message.update.reason, message.update.previous_head, message.update.current_head, message.update.pushed_by, message.reviewed_sha],
    ['pull_request_head_changed', u.first, u.second, ['alice'], u.second]);
  assert.deepEqual(message.update.compare.commits, [{ sha: u.second, author: 'alice', message: 'second' }]);
  assert.deepEqual(message.update.compare.files, [{ path: 'README.md', status: 'modified', additions: 1, deletions: 1 }]);
  assert.equal(message.update.saved_changes, null);
  // The published review is of the new head.
  // The published summary is of the new head and names the head the review read before it.
  const summary = published.find(entry => entry.path.endsWith('/issues/7/comments')).body.body;
  assert.match(summary, new RegExp(`Reviewed commit: ${u.second}\nEarlier heads this review also read: ${u.first}\n`));
  const logs = h.store.all('SELECT content FROM task_logs WHERE task_id=?', task.id).map(row => JSON.parse(row.content));
  assert.ok(logs.some(log => log.type === 'head_moved' && log.current_head === u.second));
  assert.deepEqual(logs.filter(log => log.type === 'fault'), []);
});
