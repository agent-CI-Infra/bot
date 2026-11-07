import { acceptanceFixture } from './acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, symlinkSync, chmodSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitServer, git } from './git-server.mjs';
import { GitCache } from '../dist/agent/git-cache.js';
import { Workspace } from '../dist/agent/workspace.js';
import { Redactor } from '../dist/agent/common.js';
import { workspace as runnerWorkspace } from '../runner/workspace.mjs';
import { storeOperation, pruneTasks } from '../runner/store.mjs';
import { environment } from '../runner/command.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository } from './helpers.mjs';
import { Workspace as ControlWorkspace } from '../dist/agent/workspace.js';
import { TaskEngine } from '../dist/agent/engine.js';

const token = 'ghs_' + 'f'.repeat(36);
// An upstream repository with a regular file, an executable, a symlink and a submodule entry, served over Git HTTP.
async function upstream(t, options) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.tmp/git-cache-')), work = join(root, 'work'), bare = join(root, 'server', 'fixture', 'project-101.git');
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
  const rest = [], manager = { call: async (_method, path, body) => {
    if (!path.endsWith('/execute')) return { repository_id: '101', state: 'ready', generation: 1, desired: 'ready', revision: 1 };
    const request = body.request;
    // The real runner operations, with the computer's task and store directories under the test root.
    const answer = run => run.then(result => ({ ok: true, result }), error => ({ ok: false, error: 'runner_operation_failed', detail: error.message }));
    if (['workspace_init', 'workspace_write', 'workspace_snapshot', 'workspace_checkout', 'workspace_context', 'workspace_read'].includes(request.type)) return answer(runnerWorkspace(request, join(u.root, 'tasks'), join(u.root, 'store')));
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
  const run = async () => { engine.tick(); await Promise.all(engine.active.values()); };
  await run(); const fetched = u.server.requests.length; await run();
  const tasks = h.store.all('SELECT * FROM tasks ORDER BY object_number');
  assert.deepEqual(tasks.map(task => task.status), ['succeeded', 'succeeded']); assert.ok(fetched > 0); assert.equal(u.server.requests.length, fetched);
  assert.deepEqual(rest.filter(path => /\/git\/(?:blobs|trees|commits)\//.test(path)), []);
  const snapshots = tasks.map(task => JSON.parse(h.store.get("SELECT content FROM task_logs WHERE task_id=? AND json_extract(content,'$.type')='snapshot'", task.id).content));
  // Each task has its own worktree; the store got the history once.
  assert.deepEqual(snapshots.map(log => [log.source, log.cache, log.files, log.pack_bytes > 0]), [['git_worktree', 'fetched', 3, true], ['git_worktree', 'hit', 3, false]]);
  for (const task of tasks) {
    const repo = join(u.root, 'tasks', task.workspace_id, 'repo');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'second\n'); assert.equal(git(repo, 'rev-parse', 'HEAD'), u.second);
    // The history is there, and the Issue and its comments are files next to the checkout.
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal(JSON.parse(readFileSync(join(u.root, 'tasks', task.workspace_id, 'context', 'object.json'), 'utf8')).title, 'Review');
  }
  assert.ok(!JSON.stringify(h.store.all('SELECT content FROM task_logs')).includes(token));
});

// A task on a project computer: the real runner's workspace and store operations, in directories under the test root.
function computerTask(root) {
  const id = randomBytes(24).toString('hex'), logs = [], redactor = new Redactor(); redactor.add(token);
  const workspace = new Workspace(null, null, { id: 'task-' + id, attempt: 1, workspace_id: id }, redactor, async () => {}, value => logs.push(value));
  const run = request => (request.type.startsWith('git_') ? storeOperation(request, join(root, 'store')) : runnerWorkspace({ ...request, workspace_id: id }, join(root, 'tasks'), join(root, 'store')))
    .catch(error => ({ error: 'runner_operation_failed', detail: error.message }));
  workspace.call = (_key, request) => run(request); workspace.deliver = request => run(request);
  return { id, logs, workspace, run, github: { authorEmail: () => '999+fixture-bot@users.noreply.github.com' }, root: join(root, 'tasks', id), repo: join(root, 'tasks', id, 'repo'),
    snapshot: () => logs.find(entry => entry.type === 'snapshot') };
}

test('a task checks out a git worktree with the history; the computer store receives only the commits it lacks', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second, u.first] });
  const a = computerTask(u.root), snapshot = await a.workspace.checkout(a.github, u.second, mirror, [u.first]);
  assert.equal(snapshot.history, true); assert.equal(snapshot.tree_sha, git(u.bare, 'rev-parse', u.second + '^{tree}'));
  assert.deepEqual(snapshot.files.map(f => f.path).sort(), ['README.md', 'link.md', 'src/run.sh']); assert.deepEqual(snapshot.skipped_files.map(f => f.path), ['vendor/module']);
  // The files are the commit's, with modes and links; the history and a pull request's base are there for git.
  assert.equal(readFileSync(join(a.repo, 'README.md'), 'utf8'), 'second\n'); assert.ok(statSync(join(a.repo, 'src', 'run.sh')).mode & 0o100);
  assert.equal(git(a.repo, 'rev-list', '--count', 'HEAD'), '2'); assert.match(git(a.repo, 'diff', '--stat', `${u.first}...${u.second}`), /README\.md/);
  assert.ok(a.snapshot().pack_bytes > 0); assert.equal(a.snapshot().source, 'git_worktree');
  // Another task on the same commit gets its own worktree and nothing travels.
  const b = computerTask(u.root); await b.workspace.checkout(b.github, u.second, mirror);
  assert.equal(b.snapshot().pack_bytes, 0); assert.equal(git(b.repo, 'rev-parse', 'HEAD'), u.second);
  // A new upstream commit: only it is sent.
  writeFileSync(join(u.work, 'README.md'), 'third\n'); git(u.work, 'add', 'README.md'); git(u.work, 'commit', '-qm', 'third');
  const third = git(u.work, 'rev-parse', 'HEAD'); git(u.work, 'push', '-q', u.bare, `${third}:refs/heads/main`);
  const next = await u.cache.open('101', { url: u.url, token, commits: [third] }), c = computerTask(u.root); await c.workspace.checkout(c.github, third, next);
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

test('a repository file holding a task credential stops the checkout before anything is sent to the computer', async t => {
  const u = await upstream(t);
  writeFileSync(join(u.work, 'leak.txt'), `token=${token}\n`); git(u.work, 'add', 'leak.txt'); git(u.work, 'commit', '-qm', 'leak');
  const leaked = git(u.work, 'rev-parse', 'HEAD'); git(u.work, 'push', '-q', u.bare, `${leaked}:refs/heads/main`);
  const mirror = await u.cache.open('101', { url: u.url, token, commits: [leaked] }), a = computerTask(u.root);
  await assert.rejects(a.workspace.checkout(a.github, leaked, mirror), { code: 'credential_in_repository', detail: 'Credential found in repository file: leak.txt' });
  assert.deepEqual((await a.run({ type: 'git_have' })).commits, []);
});

test('task directories untouched for three days go with their worktree registrations; recent ones stay', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second] });
  const old = computerTask(u.root), recent = computerTask(u.root);
  await old.workspace.checkout(old.github, u.second, mirror); await recent.workspace.checkout(recent.github, u.second, mirror);
  const later = Date.now() + 4 * 24 * 3600 * 1000;
  // The recent task's agent is still writing its events.
  mkdirSync(join(recent.root, 'agent'), { recursive: true }); writeFileSync(join(recent.root, 'agent', 'events.jsonl'), '');
  utimesSync(join(recent.root, 'agent', 'events.jsonl'), later / 1000, later / 1000);
  assert.deepEqual(await pruneTasks(join(u.root, 'tasks') + '/', 3 * 24 * 3600 * 1000, later, join(u.root, 'store')), { removed: 1 });
  assert.deepEqual(readdirSync(join(u.root, 'tasks')), [recent.id]);
  assert.doesNotMatch(git(join(u.root, 'store', 'repo.git'), 'worktree', 'list'), new RegExp(old.id));
});

test('a credential inside a binary file stops the checkout too', async t => {
  const u = await upstream(t);
  writeFileSync(join(u.work, 'build.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(token), Buffer.from([0])])); git(u.work, 'add', 'build.bin'); git(u.work, 'commit', '-qm', 'binary');
  const sha = git(u.work, 'rev-parse', 'HEAD'); git(u.work, 'push', '-q', u.bare, `${sha}:refs/heads/main`);
  const mirror = await u.cache.open('101', { url: u.url, token, commits: [sha] }), a = computerTask(u.root);
  await assert.rejects(a.workspace.checkout(a.github, sha, mirror), { code: 'credential_in_repository', detail: 'Credential found in repository file: build.bin' });
});

test('a workspace holding an earlier file copy of the same tree is replaced by a worktree with the history', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second] }), a = computerTask(u.root);
  // The copy keeps the tree but is its own one-commit repository.
  await a.workspace.prepare(a.github, u.second, mirror);
  assert.equal(git(a.repo, 'rev-list', '--count', 'HEAD'), '1'); assert.notEqual(git(a.repo, 'rev-parse', 'HEAD'), u.second);
  const snapshot = await a.workspace.checkout(a.github, u.second, mirror);
  assert.equal(snapshot.history, true); assert.equal(git(a.repo, 'rev-parse', 'HEAD'), u.second); assert.equal(git(a.repo, 'rev-list', '--count', 'HEAD'), '2');
});

test('checkouts in two workspaces of one task attempt are separate operations, and import and checkout wait as long as they run', async t => {
  const u = await upstream(t), mirror = await u.cache.open('101', { url: u.url, token, commits: [u.second] });
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,generation,attempt) VALUES('keys','101','review.issue','running','',1,1)");
  const task = { ...h.store.get("SELECT * FROM tasks WHERE id='keys'"), workspace_id: randomBytes(24).toString('hex') }, waits = {};
  // The real control-plane calls, recorded per task, with the runner operations behind a stand-in manager.
  const manager = { call: async (_method, _path, input, wait) => {
    const request = input.request; waits[request.type] = wait;
    const result = await (request.type.startsWith('git_') ? storeOperation(request, join(u.root, 'store')) : runnerWorkspace(request, join(u.root, 'tasks'), join(u.root, 'store')))
      .then(value => ({ ok: true, result: value }), error => ({ ok: false, error: 'runner_operation_failed', detail: error.message }));
    return result;
  } };
  const redactor = new Redactor(); redactor.add(token);
  const workspace = new ControlWorkspace(h.store, manager, task, redactor, async () => {}, () => {}), github = { authorEmail: () => '999+fixture-bot@users.noreply.github.com' };
  assert.equal((await workspace.checkout(github, u.second, mirror)).history, true);
  // The same attempt moves to another workspace (as after a fallback) and checks out again.
  task.workspace_id = randomBytes(24).toString('hex');
  assert.equal((await workspace.checkout(github, u.second, mirror)).history, true);
  assert.equal(git(join(u.root, 'tasks', task.workspace_id, 'repo'), 'rev-parse', 'HEAD'), u.second);
  assert.deepEqual([waits.git_import, waits.workspace_checkout], [0, 0]);
});

test('a pack left by an interrupted transfer is removed after a few hours', async t => {
  mkdirSync(resolve('.tmp'), { recursive: true }); const root = mkdtempSync(resolve('.tmp/store-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = 'a'.repeat(48);
  await storeOperation({ type: 'git_pack', pack_id: pack, base64: Buffer.from('PACK').toString('base64'), offset: 0 }, root);
  assert.deepEqual(readdirSync(join(root, 'incoming')), [pack + '.pack']);
  await pruneTasks(join(root, 'tasks') + '/', 3 * 24 * 3600 * 1000, Date.now() + 60_000, root); assert.equal(readdirSync(join(root, 'incoming')).length, 1);
  await pruneTasks(join(root, 'tasks') + '/', 3 * 24 * 3600 * 1000, Date.now() + 7 * 3600 * 1000, root); assert.deepEqual(readdirSync(join(root, 'incoming')), []);
});
