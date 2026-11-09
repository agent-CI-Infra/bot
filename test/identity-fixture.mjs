import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { GitHubIdentity } from '../dist/identity/github.js';
import { GitHubLogin } from '../dist/identity/github-login.js';
import { harness, setup, account, repository } from './helpers.mjs';

// Real HTTP OAuth and GitHub endpoints, confined to this test's random loopback port.
export async function identityFixture(t, options = {}) {
  const { wizardOnly = false, ...serverOptions } = options;
  const state = { id: 42, login: 'administrator', owner: true, admin: false, type: 'Organization', selection: 'all', failure: 0,
    accessible: ['101'], codes: new Map(), exchanges: 0, requests: [], refreshed: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), path = url.pathname;
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    let raw = ''; for await (const b of req) raw += b; const body = raw ? JSON.parse(raw) : {};
    state.requests.push({ path, method: req.method });
    if (path === '/login/oauth/authorize') {
      const code = 'code-' + state.codes.size; state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), id: state.id });
      const redirect = new URL(url.searchParams.get('redirect_uri')); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(303, { Location: redirect.toString() }); res.end(); return;
    }
    if (path === '/login/oauth/access_token') {
      state.exchanges++; await state.exchangeGate?.();
      if (body.grant_type === 'refresh_token') { state.refreshed++; return send({ access_token: 'fixture-user-' + state.id, refresh_token: 'fixture-refresh', expires_in: 28800, refresh_token_expires_in: 15897600 }); }
      const saved = state.codes.get(body.code);
      if (!saved || saved.used || createHash('sha256').update(body.code_verifier).digest('base64url') !== saved.challenge) return send({ error: 'bad_verification_code' });
      saved.used = true; return send({ access_token: 'fixture-user-' + saved.id, refresh_token: 'fixture-refresh', expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (state.failure) return send({ error: 'blocked' }, state.failure);
    await state.apiGate?.(path);
    if (path === '/user') return send({ id: Number(String(req.headers.authorization).split('-').at(-1)), login: state.login, email: 'same@example.com' });
    const target = { id: state.type === 'User' ? 42 : 10, login: 'fixture', type: state.type };
    if (path === '/user/installations') return send({ total_count: 1, installations: [{ id: 77, app_id: 123, account: target, repository_selection: state.selection }] });
    if (path === '/user/installations/77/repositories') return send({ total_count: state.accessible.length, repositories: state.accessible.map(id => ({ id: Number(id), full_name: 'fixture/project-' + id, owner: target, permissions: { admin: state.admin } })) });
    if (path === '/user/memberships/orgs/fixture') return send({ state: 'active', role: state.owner ? 'admin' : 'member', organization: target });
    send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t?.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let identity, githubLogin;
  const h = await harness(t, undefined, store => { identity = new GitHubIdentity(store, { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'http://127.0.0.1/auth/github/callback', apiUrl: base, webUrl: base }); githubLogin = wizardOnly ? new GitHubLogin(store, { apiUrl: base, webUrl: base }) : undefined; return { ...(githubLogin ? { githubLogin } : { githubIdentity: identity }), ...serverOptions }; });
  identity.config.redirectUri = h.admin + '/auth/github/callback';
  const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  // Another tenant has an enabled project. It is never in the user's App installation.
  await repository(admin, a.id, '201'); h.store.run("UPDATE repositories SET owner_id='20',full_name='other/project-201' WHERE id='201'");
  const projectOwner = () => state.type === 'User' ? '42' : '10';
  const snapshot = () => {
    h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,target_login,
      repository_selection,status,completeness,revision,scope_pending,updated_at) VALUES('github.com/123/77','github.com','123','77',?,?,?,'fixture',?,'active','complete',1,0,?)
      ON CONFLICT(ref) DO UPDATE SET target_id=excluded.target_id,target_type=excluded.target_type,repository_selection=excluded.repository_selection,revision=revision+1`,
      a.id, projectOwner(), state.type, state.selection, new Date().toISOString());
    h.store.run("UPDATE repositories SET owner_id=? WHERE id='101'", projectOwner());
    h.store.run(`INSERT OR REPLACE INTO installation_repositories VALUES('github.com/123/77','101','fixture/project-101',?,'fixture',1,1,?)`, projectOwner(), new Date().toISOString());
  }; snapshot();
  async function login(mode = 'login', session = '', browser = 'test-browser') {
    const begun = identity.begin(browser, mode, session), url = new URL(begun.url);
    const authorized = await fetch(begun.url, { redirect: 'manual' }), code = new URL(authorized.headers.get('location')).searchParams.get('code');
    return { result: await identity.callback(browser, url.searchParams.get('state'), code, session), url, code, browser };
  }
  return { h, admin, password, state, a, get identity() { return identity; }, get githubLogin() { return githubLogin; }, base, snapshot, login, close: async () => { await h.stop(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}
