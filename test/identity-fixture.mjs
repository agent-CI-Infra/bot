import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
    state.requests.push({ path, method: req.method, authorization: req.headers.authorization, body, scope: url.searchParams.get('scope') });
    if (path === '/login/oauth/authorize') {
      const code = 'code-' + state.codes.size; state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), id: state.id });
      const redirect = new URL(url.searchParams.get('redirect_uri')); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(303, { Location: redirect.toString() }); res.end(); return;
    }
    if (path === '/login/oauth/access_token') {
      state.exchanges++; await state.exchangeGate?.();
      if (body.grant_type === 'refresh_token') { state.refreshed++; return send({ scope: state.scope || '', access_token: 'fixture-user-' + state.id, refresh_token: 'fixture-refresh', expires_in: 28800, refresh_token_expires_in: 15897600 }); }
      const saved = state.codes.get(body.code);
      if (!saved || saved.used || createHash('sha256').update(body.code_verifier).digest('base64url') !== saved.challenge) return send({ error: 'bad_verification_code' });
      saved.used = true; return send({ scope: state.scope || '', access_token: 'fixture-user-' + saved.id, refresh_token: 'fixture-refresh', expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    if (state.failure) return send({ error: 'blocked' }, state.failure);
    await state.apiGate?.(path);
    if (path === '/user') return send({ id: Number(String(req.headers.authorization).split('-').at(-1)), login: state.login, email: 'same@example.com' });
    const target = { id: state.type === 'User' ? 42 : 10, login: 'fixture', type: state.type };
    if (path === '/app/installations/77') return send({ id: 77, app_id: state.appId || 123, account: target, repository_selection: state.selection, permissions: { members: state.membersPermission === false ? undefined : 'read' }, suspended_at: state.suspended ? 'now' : null });
    if (path === '/app/installations/77/access_tokens') return send({ token: 'fixture-installation' });
    if (path === '/installation/token' && req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    if (path === '/installation/repositories') return send({ total_count: state.repositoryTotal || state.accessible.length, repositories: state.accessible.map(id => ({ id: Number(id), full_name: 'fixture/project-' + id, owner: target })) });
    if (path.startsWith('/orgs/fixture/memberships/')) return state.membershipFailure ? send({}, state.membershipFailure) : send({ state: 'active', role: state.owner ? 'admin' : 'member', organization: target, user: { id: state.membershipUserId || state.id } });
    if (/^\/repos\/fixture\/project-\d+$/.test(path)) return send({ id: state.repositoryProofId || Number(path.split('-').at(-1)), owner: target });
    if (/^\/repos\/fixture\/project-\d+\/collaborators\/[^/]+\/permission$/.test(path)) return send({ permission: state.permission ?? (state.admin === undefined ? null : state.admin ? 'admin' : 'read'), user: { id: state.permissionUserId || state.id } });
    send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t?.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let identity, githubLogin;
  const h = await harness(t, undefined, store => { identity = new GitHubIdentity(store, { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'http://127.0.0.1/auth/github/callback', apiUrl: base, webUrl: base }); githubLogin = wizardOnly ? new GitHubLogin(store, { apiUrl: base, webUrl: base }) : undefined; return { ...(githubLogin ? { githubLogin } : { githubIdentity: identity }), ...serverOptions }; });
  identity.config.redirectUri = h.admin + '/auth/github/callback';
  const { admin, password } = await setup(h), a = await account(admin, { type: 'github_app', app_id: '123', token: undefined, private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }); await repository(admin, a.id, '101');
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
