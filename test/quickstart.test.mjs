import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { harness, setup, account, testPassword } from './helpers.mjs';
import { Quickstart, boardLocation, quickstartPermissions } from '../dist/projects/quickstart.js';
import { GitHub, agentReadPermissions } from '../dist/github/client.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { Redactor } from '../dist/agent/common.js';
import { workflowSet } from '../dist/projects/gate-templates.js';
import { releaseWorkflow } from '../dist/releases/workflow.js';
import { releaseFixture } from './release-fixtures.mjs';
import { parse } from 'yaml';

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
    tokens: new Map(), revoked: [], requests: [], repo, collectMissing: false, createMissing: false,
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
      target.dispatched = { workflow: m[1], ...body };
      if (m[1] === 'board-collect.yml' || m[1] === 'board-create.yml') {
        const id = 800 + (target.runs?.length || 0), now = new Date().toISOString();
        const missing = m[1] === 'board-create.yml' ? state.createMissing : state.collectMissing;
        (target.runs ||= []).push({ id, workflow: m[1], status: 'completed', conclusion: missing ? 'failure' : 'success',
          run_started_at: now, html_url: `https://github.com/${full}/actions/runs/${id}` });
        (target.jobsById ||= {})[id] = [{ steps: [{ name: 'Check PRIVATE_SOURCE_TOKEN', status: 'completed',
          conclusion: missing ? 'failure' : 'success' }] }];
      }
      return send(204);
    }
    if ((m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest)) && method === 'GET')
      return send(200, { workflow_runs: (target.runs || []).filter(run => run.workflow === m[1]) });
    if ((m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest)) && method === 'GET') return send(200, { jobs: (target.jobsById || {})[m[1]] || [] });
    return send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t, { type = 'github_app', templateRepo = 'agent-CI-Infra/CI-workflow' } = {}) {
  const github = await fakeGitHub(t);
  let quickstart;
  const h = await harness(t, undefined, store => ({ quickstart: quickstart = new Quickstart(store, github.url, templateRepo) }));
  h.store.run("INSERT INTO settings VALUES('onboarding.public',?)", JSON.stringify({ origin: 'https://bot.example' }));
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
const boardUrl = 'https://bot.example/boards/octo/hello/';

test('the board uses the verified webhook origin and a lowercase stable path', () => {
  assert.deepEqual(boardLocation('https://bot.example/', 'My-Org/Hello'),
    { key: 'my-org/hello', url: 'https://bot.example/boards/my-org/hello/' });
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
  assert.ok(releaseWorkflow(branch['.github/workflows/release.yml'], 'v1.2.3').matched);
  assert.ok(Object.values(JSON.parse(branch['.github/ci-gates.json']).lanes).every(lane => lane.commands.length === 0));
  for (const request of state.requests.filter(r => r.path.startsWith('/repos/octo/hello') && !r.path.endsWith('/installation'))) assert.equal(request.auth, sourceToken, request.path);
  assert.ok(state.requests.filter(r => r.path.startsWith('/repos/agent-CI-Infra/CI-workflow/contents')).every(r => r.auth === templateToken));
  assert.ok(!state.requests.some(r => r.path.startsWith('/repos/agent-CI-Infra/dashboard')));
  assert.deepEqual(state.revoked, [sourceToken, templateToken]);
  assert.ok(!JSON.stringify(result).includes('ghs_'));
});

test('a repository without build or test scripts gets the upstream release framework recognized by preflight', async t => {
  const { state, run } = await fixture(t);
  state.repos['octo/hello'].files['package.json'] = JSON.stringify({ name: 'hello' });
  const upstream = workflowSet({})['.github/workflows/release.yml'] + '\n# Upstream template\n';
  state.repos['agent-CI-Infra/CI-workflow'].files['template/.github/workflows/release.yml'] = upstream;
  const result = await run(['gate_pr']); assert.equal(step(result, 'gate_pr').status, 'done', JSON.stringify(result));
  const pull = state.repos['octo/hello'].pulls[0], branch = state.repos['octo/hello'].branches[pull.head];
  assert.equal(branch['.github/workflows/release.yml'], upstream);
  assert.match(pull.body, /仓库开发者填写/); assert.match(pull.body, /PyPI、npm 包或镜像/);
  const f = await releaseFixture(t); f.state.files = branch;
  for (const version of ['v1.2.3', 'v1.2.3-beta.1']) {
    const preview = await f.preview(version); assert.equal(preview.available, true, JSON.stringify(preview));
  }
});

test('bundled release gates accept missing scripts and never choose repository check or publishing commands', async t => {
  for (const scripts of [{}, { test: 'node --test' }, { build: 'tsc', test: 'node --test', lint: 'eslint .' }]) {
    await t.test(JSON.stringify(scripts), async t => {
      const { state, run } = await fixture(t);
      state.repos['octo/hello'].files['package.json'] = JSON.stringify({ name: 'hello', scripts });
      const result = await run(['gate_pr']); assert.equal(step(result, 'gate_pr').status, 'done', JSON.stringify(result));
      const pull = state.repos['octo/hello'].pulls[0], branch = state.repos['octo/hello'].branches[pull.head];
      const config = JSON.parse(branch['.github/ci-gates.json']);
      assert.deepEqual(config.lanes, Object.fromEntries(['build', 'pr-ready', 'pr-merge', 'daily', 'release'].map(lane => [lane, { commands: [] }])));
      const release = branch['.github/workflows/release.yml']; assert.ok(releaseWorkflow(release, 'v1.2.3').matched);
      const workflow = parse(release);
      assert.deepEqual(workflow.permissions, { contents: 'read' });
      assert.deepEqual(Object.keys(workflow.jobs), ['gate']);
      assert.deepEqual(workflow.jobs.gate.steps.filter(step => step.run).map(step => step.run),
        ['npm ci --no-audit --no-fund', 'node scripts/gate/gate.mjs run --lane release']);
      assert.deepEqual(workflow.jobs.gate.steps.filter(step => step.uses).map(step => step.uses),
        ['actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@v4']);
    });
  }
});

test('board and dashboard are local operations and do not require an external dashboard installation', async t => {
  const { h, state, run } = await fixture(t);
  delete state.installations['agent-CI-Infra'];
  const result = await run(['board', 'dashboard']);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.equal(step(result, 'board').url, boardUrl);
  assert.equal(step(result, 'dashboard').url, 'https://bot.example/dashboard/');
  assert.deepEqual(writes(state), []);
  assert.equal(tokensFor(state, 3).length, 0);
  assert.ok(h.store.get('SELECT * FROM public_board_jobs WHERE repository_id=?', '101'));
  assert.ok(!state.requests.some(r => r.path.includes('/dashboard')));
  assert.ok([...state.tokens.values()].every(grant => Object.values(grant.permissions).every(value => value === 'read')));
});

test('private publication requires an explicit local board or dashboard item and dry runs never consent', async t => {
  const { h, state, run, owner } = await fixture(t);
  state.repos['octo/hello'].private = true;
  h.store.run('UPDATE installed_repositories SET private=1');
  let result = await run(['dashboard'], true);
  assert.equal(result.state, 'planned');
  assert.equal(h.store.get('SELECT count(*) n FROM public_board_consents').n, 0);
  assert.equal(h.store.get('SELECT count(*) n FROM public_board_jobs').n, 0);
  result = await run(['dashboard']);
  assert.equal(result.state, 'done', JSON.stringify(result));
  assert.ok(h.store.get('SELECT * FROM public_board_consents WHERE account_id=? AND repository_id=?', owner.id, '101'));
  assert.deepEqual(writes(state), []);
  assert.match(step(result, 'dashboard').detail, /私有仓快照对外公开/);
});

test('an unavailable gate permission affects only the gate, while hosted boards still enable locally', async t => {
  const { state, run } = await fixture(t);
  delete state.installations.octo.permissions.workflows;
  const result = await run();
  assert.equal(result.state, 'partial');
  assert.deepEqual(outcome(result, 'gate_pr'), ['blocked', 'app_permissions_missing']);
  assert.equal(step(result, 'board').status, 'done');
  assert.equal(step(result, 'dashboard').status, 'done');
  assert.deepEqual(writes(state), []);
});

test('a repository on a bot account is not onboarded and its long-lived token is never sent', async t => {
  const { state, run } = await fixture(t, { type: 'bot_account' });
  const result = await run();
  assert.deepEqual([result.state, result.error], ['blocked', 'github_app_required']);
  assert.deepEqual(['gate_pr', 'board', 'dashboard'].map(id => step(result, id).status), ['blocked', 'blocked', 'blocked']);
  assert.deepEqual(state.requests, []);
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

test('deleting a project removes only its control-plane records, in one transaction, without calling GitHub', async t => {
  const { h, admin, state } = await fixture(t);
  assert.equal((await admin('/api/installations/101/activate', 'POST', {})).status, 201);
  h.store.run("INSERT INTO project_environments(repository_id) VALUES('101')");
  h.store.run("INSERT INTO environment_operations VALUES('op-1','101','start','{}','completed',NULL)");
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('task-1','101','review.pr','succeeded','done')");
  h.store.run("INSERT INTO task_logs VALUES('log-1','task-1','{}','2026-01-01T00:00:00.000Z')");
  h.store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES('model-1','101','https://model.invalid/v1','m',NULL,1,'2026-01-01T00:00:00.000Z')");
  h.store.run("UPDATE policies SET model_id='model-1' WHERE repository_id='101'");
  h.store.run("INSERT INTO model_projects VALUES('model-1','101')");
  h.store.run("INSERT INTO quickstart_runs VALUES('run-1','101','done','[]',NULL,NULL,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  // A pending environment operation would still write back after the rows are gone, so the delete refuses and keeps everything.
  h.store.run("INSERT INTO environment_operations VALUES('op-2','101','start','{}','pending',NULL)");
  let refused = await admin('/api/projects/101', 'DELETE', {});
  assert.deepEqual([refused.status, refused.value.error], [409, 'project_account_pending']);
  assert.ok(h.store.get("SELECT 1 FROM repositories WHERE id='101'"));
  h.store.run("UPDATE environment_operations SET state='completed' WHERE id='op-2'");
  const sent = state.requests.length;
  const deleted = await admin('/api/projects/101', 'DELETE', {});
  assert.deepEqual([deleted.status, deleted.value], [200, { deleted: true }]);
  // GitHub was never called: no repository, App installation or token request was made.
  assert.equal(state.requests.length, sent);
  assert.deepEqual(state.revoked, []);
  for (const table of ['repositories', 'policies', 'project_environments', 'environment_operations', 'quickstart_runs', 'installed_repositories',
    'tasks', 'models', 'model_projects']) {
    const column = table === 'repositories' ? 'id' : 'repository_id';
    assert.equal(h.store.get(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`, '101').n, 0, table);
  }
  assert.equal(h.store.get('SELECT count(*) AS n FROM task_logs').n, 0);
  assert.equal(h.store.get("SELECT action FROM audit WHERE action='repository.deleted' AND resource_id='101'").action, 'repository.deleted');
  // Unknown projects are a 404, and the route is for super administrators only.
  assert.equal((await admin('/api/projects/999', 'DELETE', {})).status, 404);
  const password = testPassword(), member = h.client();
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] });
  await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member('/api/projects/101', 'DELETE', {})).status, 403);
});
