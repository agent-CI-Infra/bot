import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { GitHubIdentity } from '../../dist/identity/github.js';
import { GitHubLogin } from '../../dist/identity/github-login.js';
import { harness, setup, account, repository } from './helpers.mjs';

function roleFlags(role) {
  const value = String(role || '').toLowerCase();
  return {
    admin: value === 'admin',
    maintain: ['admin', 'maintain'].includes(value),
    push: ['admin', 'maintain', 'write'].includes(value),
    triage: ['admin', 'maintain', 'write', 'triage'].includes(value),
    pull: ['admin', 'maintain', 'write', 'triage', 'read'].includes(value),
  };
}

// Real HTTP OAuth and GitHub endpoints, confined to this test's random loopback port. Supports both multi-user
// `state.owners` / `state.collaborators` lists and single-user `state.owner` / `state.permission` / `state.admin` shorthands.
export async function githubIdentityServer(t) {
  const state = { id: 42, login: 'administrator', owner: true, admin: false, type: 'Organization', selection: 'all', failure: 0,
    accessible: ['101'], codes: new Map(), exchanges: 0, requests: [], refreshed: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), path = url.pathname;
    const send = (value, status = 200, extraHeaders = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
      res.end(JSON.stringify(value));
    };
    const sendWithEtag = (items, key) => {
      const page = Number(url.searchParams.get('page') || 1);
      const etag = `"${key}-${createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16)}"`;
      if (state.etag !== false && page === 1 && items.length < 100 && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      const slice = items.slice((page - 1) * 100, page * 100);
      send(slice, 200, items.length < 100 && page === 1 ? { ETag: etag } : {});
    };
    let raw = ''; for await (const b of req) raw += b; const body = raw ? JSON.parse(raw) : {};
    state.requests.push({
      path, query: url.search, method: req.method, authorization: req.headers.authorization,
      ifNoneMatch: req.headers['if-none-match'] || null, body, scope: url.searchParams.get('scope'),
    });
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
    if (state.failure) return send({ error: 'blocked' }, state.failure, state.failure === 429 ? { 'Retry-After': '1' } : {});
    await state.apiGate?.(path);
    // A test's own routes (repository contents, labels ...) answer before the identity endpoints below.
    if (await state.route?.(path, req.method, body, send)) return;
    if (path === '/user') {
      const uid = Number(String(req.headers.authorization).split('-').at(-1));
      const named = Array.isArray(state.collaborators) ? state.collaborators.find(c => Number(c.id) === uid)?.login
        : Array.isArray(state.owners) ? state.owners.find(o => Number(o.id) === uid)?.login : undefined;
      return send({ id: uid, login: uid === Number(state.id) ? state.login : (named || state.login), email: 'same@example.com' });
    }
    const target = { id: state.type === 'User' ? 42 : 10, login: 'fixture', type: state.type };
    if (path === '/app/installations/77') return send({ id: 77, app_id: state.appId || 123, account: target, repository_selection: state.selection, permissions: { members: state.membersPermission === false ? undefined : 'read' }, suspended_at: state.suspended ? 'now' : null });
    if (path === '/app/installations/77/access_tokens') return send({ token: 'fixture-installation' });
    if (path === '/installation/token' && req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    if (path === '/installation/repositories') {
      const publicSet = new Set((state.publicRepos || []).map(String));
      return send({
        total_count: state.repositoryTotal || state.accessible.length,
        repositories: state.accessible.map(id => ({
          id: state.repositoryProofId && String(id) === '101' ? state.repositoryProofId : Number(id),
          full_name: 'fixture/project-' + id,
          private: !publicSet.has(String(id)),
          owner: target,
        })),
      });
    }
    if (path === '/orgs/fixture/members') {
      if (state.membershipFailure) return send({}, state.membershipFailure, state.membershipFailure === 429 ? { 'Retry-After': '1' } : {});
      const role = url.searchParams.get('role');
      const owners = Array.isArray(state.owners) ? state.owners
        : state.owner ? [{ id: state.membershipUserId ?? state.id, login: state.login }] : [];
      return sendWithEtag(role === 'admin' ? owners : [], 'owners');
    }
    if (path.startsWith('/orgs/fixture/memberships/')) return state.membershipFailure ? send({}, state.membershipFailure) : send({ state: 'active', role: state.owner ? 'admin' : 'member', organization: target, user: { id: state.membershipUserId || state.id } });
    if (/^\/repos\/fixture\/project-\d+$/.test(path)) return send({ id: state.repositoryMetaId ?? state.repositoryProofId ?? Number(path.split('-').at(-1)), owner: target });
    const collabMatch = /^\/repos\/fixture\/project-(\d+)\/collaborators$/.exec(path);
    if (collabMatch) {
      const repoId = collabMatch[1];
      if (state.collaboratorsFailure) return send({}, state.collaboratorsFailure, state.collaboratorsFailure === 429 ? { 'Retry-After': '1' } : {});
      let rawList;
      if (Array.isArray(state.collaborators)) rawList = state.collaborators;
      else if (state.collaborators && typeof state.collaborators === 'object') rawList = state.collaborators[repoId] || [];
      else if (!state.owner && state.permission === undefined && state.admin === undefined) {
        // Deliberately incomplete payload for fail-closed tests.
        rawList = [{ id: state.permissionUserId ?? state.id, login: state.login, role_name: null, raw: true }];
      } else {
        const perm = state.permission ?? (state.admin ? 'admin' : 'none');
        rawList = perm === 'none' ? [] : [{ id: state.permissionUserId ?? state.id, login: state.login, role_name: perm }];
      }
      const normalized = rawList.map(item => item.raw ? { id: item.id, login: item.login, role_name: item.role_name }
        : { id: item.id, login: item.login, role_name: item.role_name, permissions: item.permissions ?? roleFlags(item.role_name) });
      const permFilter = url.searchParams.get('permission');
      const filtered = permFilter === 'admin'
        ? normalized.filter(item => item.role_name === null && !item.permissions || item.role_name === 'admin' || item.permissions?.admin === true)
        : normalized;
      return sendWithEtag(filtered, `collab-${repoId}-${permFilter || 'all'}`);
    }
    const legacyPerm = /^\/repos\/fixture\/project-(\d+)\/collaborators\/[^/]+\/permission$/.exec(path);
    if (legacyPerm) {
      const repoId = legacyPerm[1], isPublic = (state.publicRepos || []).map(String).includes(repoId);
      const perm = state.permission ?? (state.admin === undefined ? (isPublic ? 'read' : null) : state.admin ? 'admin' : (isPublic ? 'read' : 'none'));
      return send({ permission: perm, role_name: perm, user: { id: state.permissionUserId || state.id } });
    }
    send({}, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t?.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, base, server };
}
/** The deployment's installation 77 of App 123, as the installation sync leaves it, covering repository 101. */
export function seedInstallation(h, accountId, state) {
  const projectOwner = () => state.type === 'User' ? '42' : '10';
  h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,target_login,
    repository_selection,status,completeness,revision,scope_pending,updated_at) VALUES('github.com/123/77','github.com','123','77',?,?,?,'fixture',?,'active','complete',1,0,?)
    ON CONFLICT(ref) DO UPDATE SET target_id=excluded.target_id,target_type=excluded.target_type,repository_selection=excluded.repository_selection,revision=revision+1`,
    accountId, projectOwner(), state.type, state.selection, new Date().toISOString());
  h.store.run("UPDATE repositories SET owner_id=? WHERE id='101'", projectOwner());
  h.store.run(`INSERT OR REPLACE INTO installation_repositories VALUES('github.com/123/77','101','fixture/project-101',?,'fixture',1,1,?)`, projectOwner(), new Date().toISOString());
}
/** Signs in through the fake GitHub as `state.id`. Signing in does not wait for the permission check (#708); this does. */
export async function githubSignIn(identity, mode = 'login', session = '', browser = 'test-browser') {
  const begun = identity.begin(browser, mode, session), url = new URL(begun.url);
  const authorized = await fetch(begun.url, { redirect: 'manual' }), code = new URL(authorized.headers.get('location')).searchParams.get('code');
  const result = await identity.callback(browser, url.searchParams.get('state'), code, session); await result.verification;
  return { result, url, code, browser };
}

export async function identityFixture(t, options = {}) {
  // github: the control plane's own GitHub API calls (installation tokens, repository reads) go to this fixture too.
  const { wizardOnly = false, github = false, extra, ...serverOptions } = options;
  const { state, base, server } = await githubIdentityServer(t);
  let identity, githubLogin;
  const h = await harness(t, undefined, store => { identity = new GitHubIdentity(store, { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'http://127.0.0.1/auth/github/callback', apiUrl: base, webUrl: base }); githubLogin = wizardOnly ? new GitHubLogin(store, { apiUrl: base, webUrl: base }) : undefined; return { ...(githubLogin ? { githubLogin } : { githubIdentity: identity }), ...(github ? { githubUrl: base } : {}), ...serverOptions, ...(extra?.(store) ?? {}) }; });
  identity.config.redirectUri = h.admin + '/auth/github/callback';
  const { admin, password } = await setup(h), a = await account(admin, { type: 'github_app', app_id: '123', token: undefined, private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }); await repository(admin, a.id, '101');
  // Another tenant has an enabled project. It is never in the user's App installation.
  await repository(admin, a.id, '201'); h.store.run("UPDATE repositories SET owner_id='20',full_name='other/project-201' WHERE id='201'");
  const snapshot = () => seedInstallation(h, a.id, state); snapshot();
  const login = (mode = 'login', session = '', browser = 'test-browser') => githubSignIn(identity, mode, session, browser);
  return { h, admin, password, state, a, get identity() { return identity; }, get githubLogin() { return githubLogin; }, base, snapshot, login, close: async () => { await h.stop(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}

export async function waitForIdentityPage(page) {
  const { expect } = await import('@playwright/test');
  // The heading is translated: 「我的 GitHub 连接」 / "My GitHub connection".
  await expect(page.locator('.identity-overview')).toBeVisible();
  await expect(page.getByRole('heading', { name: '正在读取身份与权限' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Loading identity and access' })).toHaveCount(0);
}

export async function openIdentityAdvanced(page) {
  const { expect } = await import('@playwright/test');
  await waitForIdentityPage(page);
  const details = page.locator('details.identity-advanced');
  const summary = details.locator(':scope > summary');
  await summary.waitFor({ state: 'visible' });
  // A late re-render after navigation can replace the fold with a fresh, collapsed one; retry the whole
  // open-and-check step until the fold that is on the page is open and showing its cards.
  await expect(async () => {
    if (!(await details.evaluate(el => el.open))) await summary.click();
    await expect(details).toHaveJSProperty('open', true, { timeout: 1000 });
    await expect(details.locator('.side-card').first()).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}
