import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { harness, setup, account } from './helpers.mjs';
import { GateOnboarding } from '../dist/projects/gate-onboarding.js';

// Gate onboarding against an in-memory GitHub and a scripted project model, shared by the unit tests and the browser journey.
// `t` only needs `after(fn)`, so a Playwright test passes its own cleanup list.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const b64 = text => Buffer.from(text).toString('base64');
const rank = { read: 1, write: 2 };
const everything = () => ({ metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', checks: 'write', actions: 'write', workflows: 'write' });
export const pyproject = '[project]\nname = "hello"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
export const makefile = 'build:\n\tpython -m build\n\ntest:\n\tpython -m pytest\n\nlint:\n\truff check .\n';

// An in-memory GitHub: installation tokens reach only the repositories they were minted for and only do what their permissions
// allow; rulesets, branch protection and GraphQL's mergeQueue are per repository (`queue`: 'ruleset' | 'graphql' | 'hidden' | null).
export async function fakeGitHub(t) {
  const repo = (id, extra = {}) => ({ id, private: false, default_branch: 'main', files: {}, branches: {}, pulls: [], languages: {}, queue: null, protected: false, ...extra });
  const state = {
    installations: { octo: { id: 1, account: { id: 10, login: 'octo' }, permissions: everything() },
      'agent-CI-Infra': { id: 3, account: { id: 30, login: 'agent-CI-Infra' }, permissions: everything() } },
    repos: {
      'octo/hello': repo(101, { languages: { Python: 9000, Makefile: 200 }, files: { 'pyproject.toml': pyproject, Makefile: makefile, 'src/hello/__init__.py': '' } }),
      'agent-CI-Infra/CI-workflow': repo(201, { files: { 'scripts/gate/gate.mjs': '// gate\n' } }),
    },
    tokens: new Map(), revoked: [], requests: [], repo,
  };
  let counter = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fake'), path = decodeURIComponent(url.pathname), method = req.method, body = raw ? JSON.parse(raw) : undefined;
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '') || null, grant = auth ? state.tokens.get(auth) : undefined;
    const jwt = !!auth && !grant && auth.split('.').length === 3;
    state.requests.push({ method, path, auth, body, query: url.search });
    const send = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(value === undefined ? '' : JSON.stringify(value)); };
    let m;
    if (path === '/app') return jwt ? send(200, { slug: 'dept-bot' }) : send(401, {});
    if ((m = /^\/users\/(.+)$/.exec(path))) return send(200, { id: 999, login: m[1] });
    if (path === '/installation/token' && method === 'DELETE') { if (grant) state.revoked.push(auth); return send(204); }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
      if (!jwt) return send(401, {});
      const token = 'ghs_' + randomBytes(12).toString('hex'); state.tokens.set(token, { installation: Number(m[1]), ...body });
      return send(201, { token, expires_at: '2099-01-01T00:00:00Z', permissions: body.permissions });
    }
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) {
      const found = Object.entries(state.repos).find(([, r]) => String(r.id) === m[1]);
      return found ? send(200, { id: found[1].id, full_name: found[0], owner: { id: 10 }, default_branch: found[1].default_branch }) : send(404, {});
    }
    if (path === '/graphql' && method === 'POST') {
      const target = state.repos[`${body.variables.owner}/${body.variables.name}`];
      if (!grant || !target || target.queue === 'hidden') return send(200, { errors: [{ message: 'Resource not accessible by integration' }] });
      return send(200, { data: { repository: { mergeQueue: target.queue ? { id: 'MQ_1' } : null } } });
    }
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) return send(404, {});
    const [, owner, name, rest = ''] = m, full = `${owner}/${name}`, target = state.repos[full], installation = state.installations[owner];
    if (rest === '/installation') return !jwt ? send(401, {}) : target && installation ? send(200, installation) : send(404, {});
    if (!target) return send(404, {});
    let covered = false;
    if (grant) {
      covered = grant.installation === installation?.id && (!grant.repository_ids || grant.repository_ids.includes(target.id)) && (!grant.repositories || grant.repositories.includes(name));
      if (!covered && (method !== 'GET' || target.private)) return send(404, {});
    } else if (auth || method !== 'GET' || target.private) return send(auth ? 401 : 404, {});
    const can = (permission, level = 'write') => covered ? (rank[grant.permissions[permission]] || 0) >= rank[level] : level === 'read';
    const ref = url.searchParams.get('ref'), files = ref && target.branches[ref] ? { ...target.files, ...target.branches[ref] } : target.files;
    if (rest === '' && method === 'GET') return send(200, { id: target.id, full_name: full, private: target.private, default_branch: target.default_branch });
    if (rest === '/languages') return send(200, target.languages);
    if (rest.startsWith('/git/trees/')) {
      const entries = new Map();
      for (const file of Object.keys(target.files)) { const [first, ...more] = file.split('/'); entries.set(first, more.length ? 'tree' : 'blob'); }
      return send(200, { tree: [...entries].map(([path, type]) => ({ path, type })), truncated: false });
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      const file = m[1];
      if (method === 'GET') {
        if (!can('contents', 'read')) return send(403, {});
        if (file in files) return send(200, { type: 'file', encoding: 'base64', content: b64(files[file]), sha: 'sha-' + file });
        const children = Object.keys(files).filter(item => item.startsWith(file + '/')).map(item => item.slice(file.length + 1));
        if (children.length) return send(200, [...new Set(children.map(item => item.split('/')[0]))].map(item => ({ name: item, path: `${file}/${item}`, type: children.includes(item) ? 'file' : 'dir' })));
        return send(404, {});
      }
      if (method === 'PUT') {
        if (!can('contents') || file.startsWith('.github/workflows/') && !can('workflows')) return send(403, {});
        const branch = body.branch || 'main', content = Buffer.from(body.content, 'base64').toString('utf8');
        if (branch === 'main') target.files[file] = content; else (target.branches[branch] ||= {})[file] = content;
        return send(201, { content: { path: file } });
      }
    }
    if (rest.startsWith('/git/ref/heads/') && method === 'GET') {
      const branch = rest.slice('/git/ref/heads/'.length);
      if (branch === 'main' && !Object.keys(target.files).length) return send(409, { message: 'Git Repository is empty.' });
      return branch === 'main' || target.branches[branch] ? send(200, { object: { sha: 'a'.repeat(40) } }) : send(404, {});
    }
    if (rest.startsWith('/rules/branches/')) return target.queue === 'hidden' ? send(403, {}) : send(200, target.queue === 'ruleset' ? [{ type: 'pull_request' }, { type: 'merge_queue', ruleset_id: 77 }] : []);
    if (rest.startsWith('/branches/')) return send(200, { name: 'main', protected: target.protected || target.queue === 'graphql' || target.queue === 'hidden' });
    if (rest === '/git/refs' && method === 'POST') { if (!can('contents')) return send(403, {}); target.branches[body.ref.replace('refs/heads/', '')] = {}; return send(201, { ref: body.ref }); }
    if (rest === '/pulls' && method === 'POST') {
      if (!can('pull_requests')) return send(403, {});
      const number = ++counter; target.pulls.push({ number, ...body, head: { ref: body.head } }); return send(201, { number, html_url: `https://github.com/${full}/pull/${number}` });
    }
    if (rest === '/pulls' && method === 'GET') return send(200, target.pulls.map(pull => ({ ...pull, html_url: `https://github.com/${full}/pull/${pull.number}` })));
    return send(404, {});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

// The project model: answers each turn with `respond(input, requestNumber)`, by default with the facts' certain candidates.
export async function fakeModel(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const reply = await respond(input, requests.length, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...reply } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
export const answer = (reply, plan = null) => ({ content: JSON.stringify({ reply, plan }) });

export async function gateFixture(t, { type = 'github_app', model, start = false } = {}) {
  const github = await fakeGitHub(t);
  let gate;
  const h = await harness(t, undefined, store => ({ maxBodyBytes: 64 * 1024, gateOnboarding: gate = new GateOnboarding(store, github.url) }));
  const { admin, password } = await setup(h);
  const owner = type === 'github_app' ? await account(admin, { type, app_id: '123', private_key: privateKey, token: undefined }) : await account(admin);
  h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,?,?,?,?,0,1,?)`, owner.id, '101', '1', 'octo/hello', '10', 'octo', new Date().toISOString());
  let llm = null;
  if (start || model) {
    assert.equal((await admin('/api/installations/101/activate', 'POST', { account_id: owner.id })).status, 201);
    if (model) {
      llm = await fakeModel(t, model);
      const created = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'gate-model', api_url: llm.url, api_key: 'gate-model-key-123456' })).value.model;
      assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { model_id: created.id, review_enabled: false })).status, 200);
    }
  }
  // Steps run in the background; wait until the session settles and every token it minted is revoked.
  const settle = async id => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = (await admin(`/api/gate-onboarding/${id}`)).value.session;
      if (!value.busy && !['collecting', 'thinking', 'creating'].includes(value.state) && github.state.revoked.length === github.state.tokens.size) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('gate onboarding did not settle');
  };
  const open = async () => settle((await admin('/api/projects/101/gate-onboarding', 'POST', {})).value.session.id);
  const say = async (session, content, extra = {}) => { const r = await admin(`/api/gate-onboarding/${session.id}/messages`, 'POST', { content, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.value)); return settle(session.id); };
  const confirm = async (session, extra = {}) => {
    const r = await admin(`/api/gate-onboarding/${session.id}/confirm`, 'POST', { revision: session.revision, ...extra });
    return r.status === 201 ? settle(session.id) : r;
  };
  return { h, admin, password, owner, github, state: github.state, gate, llm, open, say, confirm, settle };
}
// Writes to GitHub, leaving out minting and revoking installation tokens.
export const writes = state => state.requests.filter(r => r.method !== 'GET' && r.path !== '/graphql' && !r.path.endsWith('/access_tokens') && r.path !== '/installation/token');
export const branchOf = (state, full = 'octo/hello') => { const repo = state.repos[full], pull = repo.pulls.at(-1); return { pull, files: repo.branches[pull.head.ref] }; };

