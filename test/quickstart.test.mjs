import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { harness, setup, account } from './helpers.mjs';
import { Quickstart, boardRepository, quickstartPermissions } from '../dist/projects/quickstart.js';
import { GitHub, agentReadPermissions } from '../dist/github/client.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { Redactor } from '../dist/agent/common.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const b64 = text => Buffer.from(text).toString('base64');
const rank = { read: 1, write: 2 };
// Everything an installation could grant, including what one-click onboarding adds.
const everything = () => ({ metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', checks: 'write',
  actions: 'write', workflows: 'write', pages: 'write', repository_creation: 'write' });
const templateConfig = JSON.stringify({ review_sla_days: 3, deployments: { 'example/source': { environment: 'production', label: 'example', repository: 'example/board' } } });
const onboardingOnly = ['workflows', 'pages', 'repository_creation'];

// An in-memory GitHub. Installation tokens only reach the repositories they were minted for and only do what their
// permissions allow, so a step that uses the wrong token, or a token without the permission, fails like it would on GitHub.
async function fakeGitHub(t) {
  const repo = (id, extra = {}) => ({ id, private: false, default_branch: 'main', files: {}, branches: {}, pulls: [], ...extra });
  const state = {
    app: { slug: 'dept-bot', owner: { login: 'my-org', type: 'Organization' } },
    installations: { octo: { id: 1, account: { id: 10, login: 'octo' }, permissions: everything() },
      'my-org': { id: 2, account: { id: 20, login: 'my-org' }, permissions: everything() },
      'agent-CI-Infra': { id: 3, account: { id: 30, login: 'agent-CI-Infra' }, permissions: everything() } },
    repos: {
      'octo/hello': repo(101, { files: { 'package.json': JSON.stringify({ name: 'hello', scripts: { build: 'tsc', test: 'node --test' } }), 'package-lock.json': '{}' } }),
      'agent-CI-Infra/CI-workflow': repo(201, { files: { 'template/.github/workflows/ci.yml': 'name: CI\n', 'scripts/gate/gate.mjs': '// gate\n' } }),
      'agent-CI-Infra/dashboard': repo(301, { files: { 'config/gate-sources.json': '{"sources":[]}\n', 'config/internal-contributors.json': '{}\n',
        'single-repo/board-config.json': templateConfig, 'single-repo/.github/workflows/pages.yml': 'name: Pages\n', 'single-repo/.github/workflows/collect-selfhosted.yml': 'name: Collect\n' } }),
    },
    tokens: new Map(), revoked: [], objects: {}, requests: [], repo,
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
    if (path === '/installation/token' && method === 'DELETE') { if (grant) state.revoked.push(auth); return send(204); }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
      if (!jwt) return send(401, {});
      const token = 'ghs_' + randomBytes(12).toString('hex'); state.tokens.set(token, { installation: Number(m[1]), ...body });
      return send(201, { token, expires_at: '2099-01-01T00:00:00Z', permissions: body.permissions });
    }
    if ((m = /^\/orgs\/([^/]+)\/installation$/.exec(path))) return !jwt ? send(401, {}) : state.installations[m[1]] ? send(200, state.installations[m[1]]) : send(404, {});
    if ((m = /^\/orgs\/([^/]+)\/repos$/.exec(path)) && method === 'POST') {
      if (grant?.installation !== state.installations[m[1]]?.id || grant.permissions.repository_creation !== 'write') return send(403, {});
      const full = `${m[1]}/${body.name}`; if (state.repos[full]) return send(422, { message: 'name already exists on this account' });
      state.repos[full] = repo(900 + ++counter, { private: body.private, description: body.description, files: body.auto_init ? { 'README.md': '# init\n' } : {} });
      return send(201, { id: state.repos[full].id, full_name: full });
    }
    if ((m = /^\/users\/(.+)$/.exec(path))) return send(200, { id: 999, login: m[1] });
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) {
      const found = Object.entries(state.repos).find(([, r]) => String(r.id) === m[1]);
      return found ? send(200, { id: found[1].id, full_name: found[0], owner: { id: 10 }, default_branch: 'main' }) : send(404, {});
    }
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) return send(404, {});
    const [, owner, name, rest = ''] = m, full = `${owner}/${name}`, target = state.repos[full], installation = state.installations[owner];
    // `hidden` is a repository the App's installation does not cover.
    if (rest === '/installation') return !jwt ? send(401, {}) : target && installation && !target.hidden ? send(200, installation) : send(404, {});
    if (!target) return send(404, {});
    if (grant) {
      const covered = grant.installation === installation?.id && !target.hidden && (!grant.repository_ids || grant.repository_ids.includes(target.id))
        && (!grant.repositories || grant.repositories.includes(name));
      if (!covered) return send(404, {});
    } else if (auth || method !== 'GET' || target.private) return send(auth ? 401 : 404, {});
    const can = (permission, level = 'write') => grant ? (rank[grant.permissions[permission]] || 0) >= rank[level] : level === 'read';
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
    if ((m = /^\/git\/commits\/(.+)$/.exec(rest)) && method === 'GET') return send(200, { sha: m[1], tree: { sha: 'tree-' + m[1] } });
    if (rest.startsWith('/git/trees/') && method === 'GET') {
      if (!can('contents', 'read')) return send(403, {});
      return send(200, { tree: Object.keys(target.files).map(p => ({ path: p, type: 'blob', mode: '100644', sha: Buffer.from(p).toString('hex') })) });
    }
    if ((m = /^\/git\/blobs\/(.+)$/.exec(rest)) && method === 'GET') {
      const file = Buffer.from(m[1], 'hex').toString();
      return !can('contents', 'read') ? send(403, {}) : file in target.files ? send(200, { content: b64(target.files[file]), encoding: 'base64' }) : send(404, {});
    }
    if (['/git/blobs', '/git/trees', '/git/commits'].includes(rest) && method === 'POST') {
      if (!can('contents')) return send(403, {});
      const sha = rest.slice(5, -1) + ++counter;
      state.objects[sha] = rest === '/git/blobs' ? Buffer.from(body.content, 'base64').toString('utf8') : rest === '/git/trees' ? body.tree : body.tree;
      return send(201, { sha });
    }
    if (rest === '/git/refs/heads/main' && method === 'PATCH') {
      const tree = state.objects[state.objects[body.sha]] || [];
      if (!can('contents') || workflowFiles(tree.map(entry => entry.path)) && !can('workflows')) return send(403, {});
      for (const entry of tree) target.files[entry.path] = state.objects[entry.sha];
      return send(200, {});
    }
    if (rest === '/pulls' && method === 'POST') {
      if (!can('pull_requests')) return send(403, {});
      const number = ++counter; target.pulls.push({ number, ...body }); return send(201, { number, html_url: `https://github.com/${full}/pull/${number}` });
    }
    if (rest === '/pulls' && method === 'GET') return send(200, []);
    if (rest === '/pages' && method === 'POST') { if (!can('pages')) return send(403, {}); target.pages = body; return send(201, body); }
    if (rest === '/pages' && method === 'GET') return target.pages ? send(200, target.pages) : send(404, {});
    if (rest === '/actions/workflows' && method === 'GET') {
      return send(200, { workflows: Object.keys(target.files).filter(p => p.startsWith('.github/workflows/')).map((p, index) => ({ id: index + 1, path: p })) });
    }
    if (/^\/actions\/workflows\/\d+\/dispatches$/.test(rest) && method === 'POST') { if (!can('actions')) return send(403, {}); target.dispatched = true; return send(204); }
    return send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t, { type = 'github_app', templateRepo = 'agent-CI-Infra/CI-workflow' } = {}) {
  const h = await harness(t), { admin } = await setup(h);
  const owner = type === 'github_app' ? await account(admin, { type, app_id: '123', private_key: privateKey, token: undefined }) : await account(admin);
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,?,?,?,?,0,1,?)`, owner.id, '101', '1', 'octo/hello', '10', 'octo', new Date().toISOString());
  const github = await fakeGitHub(t), quickstart = new Quickstart(h.store, github.url, templateRepo, 'agent-CI-Infra/dashboard');
  // Runs execute in the background; wait for the outcome and for every minted token to be revoked.
  const run = async (dryRun = false) => {
    const started = quickstart.start('101', dryRun);
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = quickstart.get(started.id);
      if (!['queued', 'running'].includes(value.state) && github.state.revoked.length === github.state.tokens.size) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('quickstart did not finish');
  };
  return { h, owner, github, state: github.state, run };
}
const step = (run, id) => run.steps.find(item => item.id === id);
const grantOf = (state, token) => state.tokens.get(token);
// Writes to GitHub, leaving out minting and revoking installation tokens.
const writes = state => state.requests.filter(r => r.method !== 'GET' && !r.path.endsWith('/access_tokens') && r.path !== '/installation/token');
const tokensFor = (state, installation) => [...state.tokens.values()].filter(grant => grant.installation === installation);

test('the board repository is named after the source owner and repository and lives in the App organization', () => {
  assert.deepEqual(boardRepository('my-org', 'octo/hello'),
    { name: 'octo-hello-board', full: 'my-org/octo-hello-board', siteUrl: 'https://my-org.github.io/octo-hello-board/', valid: true });
  // The same name also when the source already belongs to the App's organization.
  assert.equal(boardRepository('My-Org', 'My-Org/hello').full, 'My-Org/My-Org-hello-board');
  assert.equal(boardRepository('My-Org', 'My-Org/hello').siteUrl, 'https://my-org.github.io/My-Org-hello-board/');
  assert.equal(boardRepository('my-org', `octo/${'x'.repeat(90)}`).valid, false);
});

test('the gate PR is opened with a source-only App token that may write workflows, and every token is revoked', async t => {
  const { state, run } = await fixture(t);
  const result = await run();
  assert.equal(result.state, 'awaiting_merge', JSON.stringify(result));
  assert.match(step(result, 'preflight').detail, /看板仓库 my-org\/octo-hello-board/);
  assert.equal(step(result, 'gate_pr').status, 'done');
  // One token, for the source repository only.
  assert.deepEqual([...state.tokens.values()], [{ installation: 1, repository_ids: [101], permissions: quickstartPermissions.source }]);
  const [sourceToken] = state.tokens.keys();
  const pull = state.repos['octo/hello'].pulls[0], branch = state.repos['octo/hello'].branches[pull.head];
  assert.ok(branch['.github/workflows/ci.yml'] && branch['.github/ci-gates.json'] && branch['scripts/gate/gate.mjs']);
  for (const request of state.requests.filter(r => r.path.startsWith('/repos/octo/hello') && !r.path.endsWith('/installation'))) assert.equal(request.auth, sourceToken, request.path);
  // The public template is read without credentials.
  assert.ok(state.requests.filter(r => r.path.startsWith('/repos/agent-CI-Infra/CI-workflow') && !r.path.endsWith('/installation')).every(r => r.auth === null));
  assert.deepEqual(state.revoked, [sourceToken]);
  assert.ok(!JSON.stringify(result).includes('ghs_'));
});

test('the board repository is created in the App organization with purpose-scoped tokens, then registered on the dashboard', async t => {
  const { state, run } = await fixture(t);
  state.repos['octo/hello'].files['.github/ci-gates.json'] = '{}';
  const result = await run();
  assert.equal(result.state, 'done', JSON.stringify(result));
  // Created as my-org/octo-hello-board, never under the source owner.
  const created = state.requests.filter(r => r.method === 'POST' && /^\/(orgs\/[^/]+|user)\/repos$/.test(r.path));
  assert.deepEqual(created.map(r => [r.path, r.body.name, r.body.private]), [['/orgs/my-org/repos', 'octo-hello-board', false]]);
  // Creation is not pinned to a repository; the board and dashboard tokens each cover one repository.
  assert.deepEqual(grantOf(state, created[0].auth), { installation: 2, permissions: { repository_creation: 'write' } });
  assert.deepEqual(tokensFor(state, 2).map(grant => grant.repositories || null), [null, ['octo-hello-board']]);
  assert.deepEqual(tokensFor(state, 2)[1].permissions, quickstartPermissions.board);
  assert.deepEqual(tokensFor(state, 3), [{ installation: 3, repositories: ['dashboard'], permissions: quickstartPermissions.dashboard }]);
  assert.ok(!tokensFor(state, 3)[0].permissions.workflows);
  const board = state.repos['my-org/octo-hello-board'];
  assert.equal(JSON.parse(board.files['board-config.json']).deployments['octo/hello'].repository, 'my-org/octo-hello-board');
  assert.ok(board.files['.github/workflows/pages.yml'] && board.dispatched);
  assert.deepEqual(board.pages, { build_type: 'workflow' });
  assert.equal(step(result, 'board').url, 'https://my-org.github.io/octo-hello-board/');
  const registration = state.repos['agent-CI-Infra/dashboard'], pull = registration.pulls[0];
  const source = JSON.parse(registration.branches[pull.head]['config/gate-sources.json']).sources[0];
  assert.deepEqual([source.id, source.owner, source.boardUrl, source.url], ['octo/hello', 'octo', 'https://my-org.github.io/octo-hello-board/',
    'https://my-org.github.io/octo-hello-board/data/snapshot.json']);
  assert.ok(!Object.keys(state.repos).some(full => full.startsWith('octo/') && full !== 'octo/hello'));
  assert.equal(state.revoked.length, 4);
  assert.ok(!JSON.stringify(result).includes('ghs_'));
});

test('missing Workflows, Pages, Repository creation or Actions stop preflight with their GitHub names and nothing is written', async t => {
  const { state, run } = await fixture(t);
  delete state.installations.octo.permissions.workflows;
  for (const key of ['pages', 'repository_creation', 'actions']) delete state.installations['my-org'].permissions[key];
  // Both phases check every installation the whole onboarding needs, so a gate PR is not opened for a board that cannot be built.
  for (const gated of [false, true]) {
    if (gated) state.repos['octo/hello'].files['.github/ci-gates.json'] = '{}';
    const result = await run();
    assert.deepEqual([result.state, result.error], ['blocked', 'app_permissions_missing']);
    const detail = step(result, 'preflight').detail;
    assert.match(detail, /octo 的安装缺 Workflows（Read and write）/);
    assert.match(detail, /my-org 的安装缺 Repository creation（Read and write）、Pages（Read and write）、Actions（Read and write）/);
    assert.deepEqual(['gate_pr', 'board', 'dashboard'].map(id => step(result, id).status), ['pending', 'pending', 'pending']);
  }
  assert.deepEqual(writes(state), []);
});

test('a private source repository stays at the private-repository gate even before the App has every permission', async t => {
  const { state, run } = await fixture(t);
  state.repos['octo/hello'].private = true;
  delete state.installations.octo.permissions.workflows; delete state.installations['my-org'].permissions.pages;
  const result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'private_repository']);
  assert.deepEqual(writes(state), []);
  assert.ok(!state.repos['my-org/octo-hello-board']);
});

test('without the App on the dashboard repository the dashboard step asks to install it and nothing is written', async t => {
  const { state, run } = await fixture(t);
  state.repos['octo/hello'].files['.github/ci-gates.json'] = '{}';
  delete state.installations['agent-CI-Infra'];
  const result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'dashboard_app_not_installed']);
  assert.equal(step(result, 'dashboard').status, 'blocked');
  assert.match(step(result, 'dashboard').detail, /需要把同一个 GitHub App 安装到 agent-CI-Infra\/dashboard/);
  assert.deepEqual(writes(state), []);
});

test('a repository on a bot account is not onboarded and its long-lived token is never sent', async t => {
  const { state, run } = await fixture(t, { type: 'bot_account' });
  const result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'github_app_required']);
  assert.deepEqual(state.requests, []);
});

test('an App owned by a user cannot host board repositories and stops in preflight', async t => {
  const { state, run } = await fixture(t);
  state.app.owner = { login: 'someone', type: 'User' };
  const result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'app_owner_not_organization']);
  assert.deepEqual(writes(state), []);
});

test('an existing board repository is updated only when it belongs to this source', async t => {
  const { state, run } = await fixture(t);
  state.repos['octo/hello'].files['.github/ci-gates.json'] = '{}';
  const pointing = source => JSON.stringify({ deployments: { [source]: { environment: 'production', label: 'x', repository: 'my-org/octo-hello-board' } } });
  state.repos['my-org/octo-hello-board'] = state.repo(500, { files: { 'board-config.json': pointing('someone/else'), '.github/workflows/pages.yml': 'name: Pages\n' } });
  let result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'board_repository_conflict']);
  assert.equal(JSON.parse(state.repos['my-org/octo-hello-board'].files['board-config.json']).deployments['someone/else'].label, 'x');
  assert.deepEqual(writes(state), []);
  // Present and pointing at this source: no creation permission is needed and the configuration is updated.
  delete state.installations['my-org'].permissions.repository_creation;
  state.repos['my-org/octo-hello-board'].files['board-config.json'] = pointing('octo/hello');
  result = await run();
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(JSON.parse(state.repos['my-org/octo-hello-board'].files['board-config.json']).label, 'hello');
  assert.ok(!state.requests.some(r => r.path === '/orgs/my-org/repos'));
});

test('a same-named repository the App cannot see is not overwritten', async t => {
  const { state, run } = await fixture(t);
  state.repos['octo/hello'].files['.github/ci-gates.json'] = '{}';
  state.repos['my-org/octo-hello-board'] = state.repo(500, { hidden: true, files: { 'README.md': 'someone else\n' } });
  const result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'board_repository_conflict']);
  assert.equal(writes(state).filter(r => r.path !== '/orgs/my-org/repos').length, 0);
  assert.deepEqual(state.repos['my-org/octo-hello-board'].files, { 'README.md': 'someone else\n' });
});

test('a private template repository is read through the App installed on it, or the gate step asks to install it', async t => {
  const { state, run } = await fixture(t, { templateRepo: 'tmpl-org/CI-workflow' });
  state.repos['tmpl-org/CI-workflow'] = state.repo(202, { private: true, files: { 'template/.github/workflows/ci.yml': 'name: CI\n', 'scripts/gate/gate.mjs': '// gate\n' } });
  let result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'template_app_not_installed']);
  assert.match(step(result, 'gate_pr').detail, /需要把同一个 GitHub App 安装到该仓库/);
  assert.deepEqual(writes(state), []);
  state.installations['tmpl-org'] = { id: 4, account: { id: 40, login: 'tmpl-org' }, permissions: everything() };
  result = await run();
  assert.equal(result.state, 'awaiting_merge', JSON.stringify(result));
  assert.deepEqual(tokensFor(state, 4), [{ installation: 4, repositories: ['CI-workflow'], permissions: quickstartPermissions.template }]);
});

test('review, development and read tokens still never ask for workflows, pages or repository creation', async t => {
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
