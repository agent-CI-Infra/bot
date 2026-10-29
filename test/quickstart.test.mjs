import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { harness, setup, account } from './helpers.mjs';
import { Quickstart, boardLocation, quickstartPermissions } from '../dist/projects/quickstart.js';
import { GitHub, agentReadPermissions } from '../dist/github/client.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { Redactor } from '../dist/agent/common.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const b64 = text => Buffer.from(text).toString('base64');
const rank = { read: 1, write: 2 };
// Everything an installation could grant, including what one-click onboarding adds.
const everything = () => ({ metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', checks: 'write',
  actions: 'write', workflows: 'write', pages: 'write', administration: 'write' });
const onboardingOnly = ['workflows', 'pages', 'administration'];

// An in-memory GitHub. Installation tokens only reach the repositories they were minted for and only do what their
// permissions allow, so a step that uses the wrong token, or a token without the permission, fails like it would on GitHub.
async function fakeGitHub(t) {
  const repo = (id, extra = {}) => ({ id, private: false, default_branch: 'main', files: {}, branches: {}, pulls: [], ...extra });
  const state = {
    app: { slug: 'dept-bot' },
    installations: { octo: { id: 1, account: { id: 10, login: 'octo' }, permissions: everything() },
      'agent-CI-Infra': { id: 3, account: { id: 30, login: 'agent-CI-Infra' }, permissions: everything() } },
    repos: {
      'octo/hello': repo(101, { files: { 'package.json': JSON.stringify({ name: 'hello', scripts: { build: 'tsc', test: 'node --test' } }), 'package-lock.json': '{}' } }),
      'agent-CI-Infra/CI-workflow': repo(201, { files: { 'template/.github/workflows/ci.yml': 'name: CI\n', 'scripts/gate/gate.mjs': '// gate\n' } }),
      'agent-CI-Infra/dashboard': repo(301, { files: { 'config/gate-sources.json': '{"sources":[]}\n', 'config/internal-contributors.json': '{}\n' } }),
    },
    tokens: new Map(), revoked: [], requests: [], repo,
  };
  let counter = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fake'), path = decodeURIComponent(url.pathname), method = req.method, body = raw ? JSON.parse(raw) : undefined;
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '') || null, grant = auth ? state.tokens.get(auth) : undefined;
    const jwt = !!auth && !grant && auth.split('.').length === 3;
    state.requests.push({ method, path, auth, body });
    const send = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(value === undefined ? '' : JSON.stringify(value)); };
    let m;
    if (path === '/app') return jwt ? send(200, state.app) : send(401, {});
    if ((m = /^\/users\/(.+)$/.exec(path))) return send(200, { id: 999, login: m[1] });
    if (path === '/installation/token' && method === 'DELETE') { if (grant) state.revoked.push(auth); return send(204); }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
      if (!jwt) return send(401, {});
      const token = 'ghs_' + randomBytes(12).toString('hex'); state.tokens.set(token, { installation: Number(m[1]), ...body });
      return send(201, { token, expires_at: '2099-01-01T00:00:00Z', permissions: body.permissions });
    }
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) {
      const found = Object.entries(state.repos).find(([, r]) => String(r.id) === m[1]);
      return found ? send(200, { id: found[1].id, full_name: found[0], owner: { id: 10 }, default_branch: 'main' }) : send(404, {});
    }
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) return send(404, {});
    const [, owner, name, rest = ''] = m, full = `${owner}/${name}`, target = state.repos[full], installation = state.installations[owner];
    // `hidden` is a repository the App's installation does not cover.
    if (rest === '/installation') return !jwt ? send(401, {}) : target && installation && !target.hidden ? send(200, installation) : send(404, {});
    if (!target) return send(404, {});
    // Like GitHub, any valid token (or none) can read a public repository; anything else needs a token that covers it.
    let covered = false;
    if (grant) {
      covered = grant.installation === installation?.id && !target.hidden && (!grant.repository_ids || grant.repository_ids.includes(target.id))
        && (!grant.repositories || grant.repositories.includes(name));
      if (!covered && (method !== 'GET' || target.private)) return send(404, {});
    } else if (auth || method !== 'GET' || target.private) return send(auth ? 401 : 404, {});
    const can = (permission, level = 'write') => covered ? (rank[grant.permissions[permission]] || 0) >= rank[level] : level === 'read';
    const workflowFiles = paths => paths.some(p => p.startsWith('.github/workflows/'));
    if (rest === '' && method === 'GET') return send(200, { id: target.id, full_name: full, private: target.private, default_branch: target.default_branch, description: target.description || null });
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      const file = m[1], ref = url.searchParams.get('ref');
      if (method === 'GET') {
        if (!can('contents', 'read')) return send(403, {});
        const files = ref && ref !== 'main' ? { ...target.files, ...target.branches[ref] } : target.files;
        return file in files ? send(200, { type: 'file', content: b64(files[file]), sha: 'sha-' + file }) : send(404, {});
      }
      if (method === 'PUT') {
        if (!can('contents') || workflowFiles([file]) && !can('workflows')) return send(403, {});
        const branch = body.branch || 'main', content = Buffer.from(body.content, 'base64').toString('utf8');
        if (branch === 'main') target.files[file] = content; else (target.branches[branch] ||= {})[file] = content;
        return send(201, { content: { path: file } });
      }
    }
    if (rest.startsWith('/git/ref/heads/') && method === 'GET') {
      const branch = rest.slice('/git/ref/heads/'.length);
      return branch === 'main' && Object.keys(target.files).length || target.branches[branch] ? send(200, { object: { sha: `head-${name}-${branch}` } }) : send(404, {});
    }
    if (rest === '/git/refs' && method === 'POST') { if (!can('contents')) return send(403, {}); target.branches[body.ref.replace('refs/heads/', '')] = {}; return send(201, { ref: body.ref }); }
    if (rest === '/pulls' && method === 'POST') {
      if (!can('pull_requests')) return send(403, {});
      const number = ++counter; target.pulls.push({ number, ...body }); return send(201, { number, html_url: `https://github.com/${full}/pull/${number}` });
    }
    if (rest === '/pulls' && method === 'GET') return send(200, []);
    if ((m = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest)) && method === 'POST') {
      if (!can('actions')) return send(403, {});
      target.dispatched = { workflow: m[1], ...body }; return send(204);
    }
    return send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t, { type = 'github_app', templateRepo = 'agent-CI-Infra/CI-workflow' } = {}) {
  const github = await fakeGitHub(t);
  let quickstart;
  const h = await harness(t, undefined, store => ({ quickstart: quickstart = new Quickstart(store, github.url, templateRepo, 'agent-CI-Infra/dashboard') }));
  const { admin } = await setup(h);
  const owner = type === 'github_app' ? await account(admin, { type, app_id: '123', private_key: privateKey, token: undefined }) : await account(admin);
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,?,?,?,?,0,1,?)`, owner.id, '101', '1', 'octo/hello', '10', 'octo', new Date().toISOString());
  // Runs execute in the background; wait for the outcome and for every minted token to be revoked.
  const run = async (steps, dryRun = false) => {
    const started = quickstart.start('101', dryRun, steps);
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = quickstart.get(started.id);
      if (!['queued', 'running'].includes(value.state) && github.state.revoked.length === github.state.tokens.size) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('quickstart did not finish');
  };
  return { h, admin, owner, github, state: github.state, quickstart, run };
}
const step = (run, id) => run.steps.find(item => item.id === id);
const outcome = (run, id) => [step(run, id).status, step(run, id).code || null];
const grantOf = (state, token) => state.tokens.get(token);
// Writes to GitHub, leaving out minting and revoking installation tokens.
const writes = state => state.requests.filter(r => r.method !== 'GET' && !r.path.endsWith('/access_tokens') && r.path !== '/installation/token');
const tokensFor = (state, installation) => [...state.tokens.values()].filter(grant => grant.installation === installation);
const gated = state => { state.repos['octo/hello'].files['.github/ci-gates.json'] = '{}'; };
const boardUrl = 'https://agent-ci-infra.github.io/dashboard/boards/octo/hello/';

test('the board lives on a lowercase branch of the dashboard repository', () => {
  assert.deepEqual(boardLocation('agent-CI-Infra/dashboard', 'octo/hello'),
    { key: 'octo/hello', branch: 'board/octo/hello', url: 'https://agent-ci-infra.github.io/dashboard/boards/octo/hello/' });
  assert.deepEqual(boardLocation('My-Org/Dashboard', 'My-Org/Hello'),
    { key: 'my-org/hello', branch: 'board/my-org/hello', url: 'https://my-org.github.io/Dashboard/boards/my-org/hello/' });
});

test('the gate PR runs on its own with a source-only App token that may write workflows, and every token is revoked', async t => {
  const { state, run } = await fixture(t);
  const result = await run(['gate_pr']);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(step(result, 'gate_pr').status, 'done');
  assert.deepEqual(['board', 'dashboard'].map(id => [step(result, id).selected, step(result, id).status]), [[false, 'skipped'], [false, 'skipped']]);
  // A source token, and a read-only token for the template repository the App is installed on.
  assert.deepEqual([...state.tokens.values()], [{ installation: 1, repository_ids: [101], permissions: quickstartPermissions.source },
    { installation: 3, repositories: ['CI-workflow'], permissions: quickstartPermissions.template }]);
  const [sourceToken, templateToken] = state.tokens.keys();
  const pull = state.repos['octo/hello'].pulls[0], branch = state.repos['octo/hello'].branches[pull.head];
  assert.ok(branch['.github/workflows/ci.yml'] && branch['.github/ci-gates.json'] && branch['scripts/gate/gate.mjs']);
  for (const request of state.requests.filter(r => r.path.startsWith('/repos/octo/hello') && !r.path.endsWith('/installation'))) assert.equal(request.auth, sourceToken, request.path);
  assert.ok(state.requests.filter(r => r.path.startsWith('/repos/agent-CI-Infra/CI-workflow/contents')).every(r => r.auth === templateToken));
  assert.ok(!state.requests.some(r => r.path.startsWith('/repos/agent-CI-Infra/dashboard')));
  assert.deepEqual(state.revoked, [sourceToken, templateToken]);
  assert.ok(!JSON.stringify(result).includes('ghs_'));
});

test('without the App on the dashboard repository the board and dashboard items stop, while the gate PR still goes ahead', async t => {
  const { state, run } = await fixture(t);
  delete state.installations['agent-CI-Infra'];
  const result = await run();
  assert.equal(result.state, 'partial', JSON.stringify(result));
  assert.deepEqual([outcome(result, 'gate_pr'), outcome(result, 'board'), outcome(result, 'dashboard')],
    [['done', null], ['blocked', 'dashboard_app_not_installed'], ['blocked', 'dashboard_app_not_installed']]);
  assert.match(step(result, 'board').detail, /需要把同一个 GitHub App 安装到 agent-CI-Infra\/dashboard，才能创建单仓看板/);
  assert.match(step(result, 'dashboard').detail, /需要把同一个 GitHub App 安装到 agent-CI-Infra\/dashboard/);
  assert.ok(!writes(state).some(r => r.path.startsWith('/repos/agent-CI-Infra/')));
  assert.ok(!state.repos['agent-CI-Infra/dashboard'].dispatched);
});

test('the board item dispatches Create board with an actions-only dashboard token, then the dashboard registers it', async t => {
  const { state, run } = await fixture(t);
  gated(state);
  const result = await run();
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.deepEqual([outcome(result, 'gate_pr'), outcome(result, 'board'), outcome(result, 'dashboard')], [['skipped', null], ['done', null], ['done', null]]);
  // The dispatch goes to the dashboard repository with the source repository as input.
  const dispatch = state.requests.find(r => r.method === 'POST' && r.path === '/repos/agent-CI-Infra/dashboard/actions/workflows/board-create.yml/dispatches');
  assert.ok(dispatch, JSON.stringify(state.requests));
  assert.deepEqual(dispatch.body, { ref: 'main', inputs: { source_repository: 'octo/hello' } });
  assert.deepEqual(grantOf(state, dispatch.auth), { installation: 3, repositories: ['dashboard'], permissions: quickstartPermissions.board });
  assert.deepEqual(state.repos['agent-CI-Infra/dashboard'].dispatched, { workflow: 'board-create.yml', ...dispatch.body });
  assert.equal(step(result, 'board').url, boardUrl);
  assert.match(step(result, 'board').detail, /已触发「Create board」/);
  // No repository is created; the board token is only issued for the dashboard.
  assert.deepEqual(tokensFor(state, 3).map(grant => [grant.repositories, grant.permissions]),
    [[['dashboard'], quickstartPermissions.board], [['dashboard'], quickstartPermissions.dashboard]]);
  const registration = state.repos['agent-CI-Infra/dashboard'], pull = registration.pulls[0];
  const source = JSON.parse(registration.branches[pull.head]['config/gate-sources.json']).sources[0];
  assert.deepEqual([source.id, source.name, source.owner, source.defaultBranch, source.type], ['octo/hello', 'hello', 'octo', 'main', 'status-board-lanes']);
  assert.deepEqual([source.url, source.dashboardUrl, source.boardUrl], [boardUrl + 'data/snapshot.json', boardUrl, boardUrl]);
  assert.deepEqual(source.channelMap, [{ channel: 'gate', workflow: ['CI'] }]);
  assert.ok(!Object.keys(state.repos).some(full => full.startsWith('octo/') && full !== 'octo/hello'));
  assert.equal(state.revoked.length, 3);
  assert.ok(!JSON.stringify(result).includes('ghs_'));
});

test('an existing board branch makes the board item skip without dispatching', async t => {
  const { state, run } = await fixture(t);
  state.repos['agent-CI-Infra/dashboard'].branches['board/octo/hello'] = {};
  const result = await run(['board']);
  assert.deepEqual([result.state, ...outcome(result, 'board')], ['done', 'skipped', null]);
  assert.equal(step(result, 'board').url, boardUrl);
  assert.match(step(result, 'board').detail, /看板分支 board\/octo\/hello 已存在，数据由「Collect board data」定期更新/);
  assert.ok(!state.requests.some(r => r.path.includes('/dispatches')));
  assert.deepEqual(writes(state), []);
  assert.equal(state.revoked.length, 2);
});

test('a dry run checks the branch but dispatches nothing', async t => {
  const { state, run } = await fixture(t);
  const result = await run(['board'], true);
  assert.deepEqual([result.state, ...outcome(result, 'board')], ['planned', 'skipped', null]);
  assert.equal(step(result, 'board').url, undefined);
  assert.match(step(result, 'board').detail, /预演：将在 agent-CI-Infra\/dashboard 触发「Create board」创建分支 board\/octo\/hello/);
  assert.ok(!state.requests.some(r => r.path.includes('/dispatches')));
  assert.deepEqual(writes(state), []);
  assert.equal(state.revoked.length, 2);
});

test('a missing permission stops only the item that needs it, listed in GitHub names, and that item writes nothing', async t => {
  const { state, run } = await fixture(t);
  delete state.installations.octo.permissions.workflows;
  delete state.installations['agent-CI-Infra'].permissions.actions;
  let result = await run();
  assert.equal(result.state, 'blocked', JSON.stringify(result));
  assert.deepEqual([outcome(result, 'gate_pr'), outcome(result, 'board'), outcome(result, 'dashboard')],
    [['blocked', 'app_permissions_missing'], ['blocked', 'app_permissions_missing'], ['blocked', 'board_not_ready']]);
  assert.match(step(result, 'gate_pr').detail, /octo 的安装里同意：Workflows（Read and write）$/);
  assert.match(step(result, 'board').detail, /agent-CI-Infra 的安装里同意：Actions（Read and write）$/);
  assert.deepEqual(writes(state), []);
  // With the source permissions back, the gate PR is opened while the board still waits for its own.
  state.installations.octo.permissions.workflows = 'write';
  result = await run();
  assert.equal(result.state, 'partial');
  assert.deepEqual([outcome(result, 'gate_pr'), outcome(result, 'board'), outcome(result, 'dashboard')],
    [['done', null], ['blocked', 'app_permissions_missing'], ['blocked', 'board_not_ready']]);
  assert.ok(writes(state).every(r => r.path.startsWith('/repos/octo/hello/')));
});

test('a private source repository can still get the gate PR, but no public board or dashboard registration', async t => {
  const { state, run } = await fixture(t);
  state.repos['octo/hello'].private = true;
  const result = await run();
  assert.equal(result.state, 'partial', JSON.stringify(result));
  assert.deepEqual([outcome(result, 'gate_pr'), outcome(result, 'board'), outcome(result, 'dashboard')],
    [['done', null], ['blocked', 'private_repository'], ['blocked', 'private_repository']]);
  assert.ok(!writes(state).some(r => r.path.startsWith('/repos/agent-CI-Infra/')));
  assert.ok(!state.repos['agent-CI-Infra/dashboard'].dispatched);
  assert.ok(writes(state).every(r => r.path.startsWith('/repos/octo/hello/')));
});

test('a repository on a bot account is not onboarded and its long-lived token is never sent', async t => {
  const { state, run } = await fixture(t, { type: 'bot_account' });
  const result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'github_app_required']);
  assert.deepEqual(['gate_pr', 'board', 'dashboard'].map(id => step(result, id).status), ['blocked', 'blocked', 'blocked']);
  assert.deepEqual(state.requests, []);
});

test('the dashboard item on its own waits for the board branch and then registers its URL', async t => {
  const { state, run, admin } = await fixture(t);
  gated(state);
  let result = await run(['dashboard']);
  assert.deepEqual([result.state, ...outcome(result, 'dashboard')], ['blocked', 'blocked', 'board_not_ready']);
  assert.match(step(result, 'dashboard').detail, /单仓看板 board\/octo\/hello 还没有就绪，先执行「单仓看板」这一项/);
  assert.deepEqual(writes(state), []);
  // Only the dashboard-scoped board token is needed for the readiness check.
  assert.deepEqual(tokensFor(state, 3), [{ installation: 3, repositories: ['dashboard'], permissions: quickstartPermissions.board }]);
  state.repos['agent-CI-Infra/dashboard'].branches['board/octo/hello'] = {};
  result = await run(['dashboard']);
  assert.deepEqual([result.state, ...outcome(result, 'dashboard')], ['done', 'done', null]);
  const registration = state.repos['agent-CI-Infra/dashboard'], pull = registration.pulls[0];
  const source = JSON.parse(registration.branches[pull.head]['config/gate-sources.json']).sources[0];
  assert.deepEqual([source.type, source.url, source.dashboardUrl, source.boardUrl],
    ['status-board-lanes', boardUrl + 'data/snapshot.json', boardUrl, boardUrl]);
  assert.ok(!state.requests.some(r => r.path.includes('/dispatches')));
  // Each item keeps its latest result from the run that executed it.
  const latest = (await admin('/api/projects/101/quickstart')).value.items;
  assert.deepEqual([latest.dashboard.status, latest.board, latest.gate_pr], ['done', undefined, undefined]);
  for (const steps of [[], ['nope'], 'board']) assert.equal((await admin('/api/projects/101/quickstart', 'POST', { steps })).status, 400);
});

test('a private template repository is read through the App installed on it, or the gate item asks to install it', async t => {
  const { state, run } = await fixture(t, { templateRepo: 'tmpl-org/CI-workflow' });
  state.repos['tmpl-org/CI-workflow'] = state.repo(202, { private: true, files: { 'template/.github/workflows/ci.yml': 'name: CI\n', 'scripts/gate/gate.mjs': '// gate\n' } });
  let result = await run(['gate_pr']);
  assert.deepEqual(outcome(result, 'gate_pr'), ['blocked', 'template_app_not_installed']);
  assert.match(step(result, 'gate_pr').detail, /需要把同一个 GitHub App 安装到该仓库/);
  assert.deepEqual(writes(state), []);
  state.installations['tmpl-org'] = { id: 4, account: { id: 40, login: 'tmpl-org' }, permissions: everything() };
  result = await run(['gate_pr']);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.deepEqual(tokensFor(state, 4), [{ installation: 4, repositories: ['CI-workflow'], permissions: quickstartPermissions.template }]);
});

test('review, development and read tokens still never ask for workflows, pages or administration', async t => {
  const { h, owner, state, github } = await fixture(t);
  const repository = { id: '101', full_name: 'octo/hello', owner_id: '10', account_id: owner.id };
  for (const development of [false, true]) await new GitHub(h.store, repository, new Redactor(), async () => {}, github.url).connect(development);
  const tokens = new ReadTokens(h.store, repository, new Redactor(), async () => {}, github.url);
  await tokens.issue(); await tokens.revoke();
  const requested = [...state.tokens.values()].map(grant => grant.permissions);
  assert.equal(requested.length, 3);
  assert.deepEqual(requested[1], { contents: 'write', issues: 'write', pull_requests: 'write' });
  for (const permissions of requested) for (const key of onboardingOnly) assert.ok(!(key in permissions), key);
  for (const key of onboardingOnly) assert.ok(!(key in agentReadPermissions), key);
});
