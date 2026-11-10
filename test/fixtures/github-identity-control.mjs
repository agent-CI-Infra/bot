import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from '../../dist/storage/database.js';
import { GitHubIdentity } from '../../dist/identity/github.js';
import { createControlPlane } from '../../dist/server.js';

const key = '/data/master.key'; if (!existsSync(key)) writeFileSync(key, randomBytes(32));
const store = new Store('/data/identity.sqlite', readFileSync(key)), codes = new Map(); let owner = true;
const config = { clientId: 'docker-fixture', clientSecret: 'docker-fixture-secret', redirectUri: 'http://127.0.0.1/auth/github/callback',
  apiUrl: 'http://127.0.0.1:8080', webUrl: 'http://127.0.0.1:8080' };
const identity = new GitHubIdentity(store, config);
// Browser and server use different loopback ports across the container boundary.
let browserFixtureOrigin = '';
const begin = identity.begin.bind(identity);
identity.begin = (...args) => { const result = begin(...args), url = new URL(result.url); return { url: browserFixtureOrigin + url.pathname + url.search }; };
const fixture = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture'); let raw = ''; for await (const b of req) raw += b;
  const body = raw ? JSON.parse(raw) : {}, send = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname === '/fixture/config') { config.redirectUri = body.origin + '/auth/github/callback'; browserFixtureOrigin = body.fixture; return send({ ok: true }); }
  if (url.pathname === '/fixture/owner') { owner = !!body.owner; return send({ ok: true }); }
  if (url.pathname === '/fixture/seed') {
    store.run(`INSERT OR IGNORE INTO accounts VALUES('fixture','fixture','bot_account',NULL,?,'fixture')`, store.secrets.seal({}, 'account:fixture'));
    store.run("INSERT OR IGNORE INTO repositories VALUES('101','fixture/project-101','10','fixture')");
    store.run("INSERT OR IGNORE INTO policies(repository_id) VALUES('101')");
    store.run(`INSERT OR IGNORE INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,target_login,
      repository_selection,status,completeness,revision,scope_pending,updated_at) VALUES('github.com/123/77','github.com','123','77','fixture','10','Organization','fixture','all','active','complete',1,0,'fixture')`);
    store.run("INSERT OR IGNORE INTO installation_repositories VALUES('github.com/123/77','101','fixture/project-101','10','fixture',1,1,'fixture')"); return send({ ok: true });
  }
  if (url.pathname === '/login/oauth/authorize') {
    const code = randomBytes(12).toString('hex'); codes.set(code, url.searchParams.get('code_challenge'));
    const redirect = new URL(config.redirectUri); redirect.search = new URLSearchParams({ code, state: url.searchParams.get('state') }).toString();
    res.writeHead(303, { Location: redirect.toString() }); res.end(); return;
  }
  if (url.pathname === '/login/oauth/access_token') {
    if (codes.get(body.code) !== createHash('sha256').update(body.code_verifier || '').digest('base64url')) return send({ error: 'invalid_code' });
    codes.delete(body.code); return send({ access_token: 'docker-fixture-user', expires_in: 28800 });
  }
  const target = { id: 10, type: 'Organization', login: 'fixture' };
  if (url.pathname === '/user') return send({ id: 42, login: 'docker-user' });
  if (url.pathname === '/user/installations') return send({ total_count: 1, installations: [{ id: 77, app_id: 123, account: target }] });
  if (url.pathname === '/user/installations/77/repositories') return send({ total_count: 1, repositories: [{ id: 101, owner: target, permissions: { admin: false } }] });
  if (url.pathname === '/user/memberships/orgs/fixture') return send({ state: 'active', role: owner ? 'admin' : 'member', organization: target });
  send({}, 404);
});
fixture.listen(8080, '0.0.0.0');
const { server } = createControlPlane({ store, staticDirectory: '/app/static', githubIdentity: identity });
server.listen(8791, '0.0.0.0');
process.on('SIGTERM', () => { server.close(); fixture.close(); store.close(); process.exit(0); });
