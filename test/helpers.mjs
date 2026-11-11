import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { randomBytes, createHmac } from 'node:crypto';
import { Store } from '../dist/storage/database.js';
import { createControlPlane } from '../dist/server.js';
import { ProjectService } from '../dist/projects/service.js';
import { configureDispatch, ruleDecider } from '../dist/dispatch/worker.js';

// Tests that exercise what happens after dispatch decide events at once, with the control plane's pre-#207 rules; the
// Manager's own model call is tested in test/dispatch.test.mjs, which turns this off.
configureDispatch(ruleDecider);

export const testPassword = () => randomBytes(20).toString('hex');
// A workspace that runs real host processes (LocalManager, runner modules) tags them with its id, and a reap ends every
// host process with that id, also those of other test sets running at the same time; such workspaces need fresh ids.
export const randomWorkspaceId = () => randomBytes(24).toString('hex');
export async function harness(t, manager, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'test-')), database = join(directory, 'control.sqlite'), key = randomBytes(32);
  let store, server;
  const h = { directory, database, key };
  h.start = async () => {
    store = new Store(database, key);
    h.projects = manager ? new ProjectService(store, manager) : undefined;
    const extra = typeof options === 'function' ? options(store) : options; h.external = extra.external;
    const { trustedProxies, security, ...rest } = extra;
    ({ server } = createControlPlane({ store, staticDirectory: resolve('static'), maxBodyBytes: 2048, projects: h.projects, ...rest },
      security ?? (trustedProxies ? { trustedProxies } : {})));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    // One listener serves the console and every delivery path; both names stay so tests read as the caller would use them.
    const base = `http://127.0.0.1:${server.address().port}`;
    Object.assign(h, { store, admin: base, webhook: base });
  };
  // A browser page may still hold open connections (including speculative ones without a request) when a test stops
  // its servers; close them instead of waiting for the browser to give them up.
  h.stop = async () => { await h.external?.forwarder.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); store.close(); };
  h.client = () => {
    let cookie = '', csrf = '';
    const client = async (path, method = 'GET', data, headers = {}) => {
      const r = await fetch(h.admin + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const value = await r.json(); if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
      if (value.csrf_token) csrf = value.csrf_token;
      return { status: r.status, value, headers: r.headers };
    };
    // The session of this client, for requests that read a response other than JSON (such as a stream).
    client.cookie = () => cookie; client.csrf = () => csrf;
    client.harness = h; return client;
  };
  h.hook = async (endpoint, secret, delivery, payload, headers = {}) => {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const r = await fetch(h.webhook + endpoint, { method: 'POST', headers: { 'X-GitHub-Delivery': delivery, 'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'), ...headers }, body: raw });
    return { status: r.status, value: await r.json() };
  };
  await h.start();
  if (t) t.after(async () => { await h.stop(); rmSync(directory, { recursive: true, force: true }); });
  return h;
}
export async function setup(h) {
  const admin = h.client(), password = testPassword();
  const result = await admin('/api/setup', 'POST', { username: 'administrator', password });
  if (result.status !== 201) throw new Error('setup failed');
  return { admin, password };
}
export async function account(admin, overrides = {}) {
  const secret = randomBytes(24).toString('hex'), token = randomBytes(24).toString('hex');
  const result = await admin('/api/accounts', 'POST', { name: 'Test account', type: 'bot_account', token, webhook_secret: secret, ...overrides });
  if (result.status !== 201) throw new Error(JSON.stringify(result));
  return { ...result.value.account, secret, token, path: result.value.account.endpoints[0].webhook_path };
}
// Repositories appear through installation sync and a super administrator starts them; tests take the same path.
export async function repository(admin, accountId, id) {
  admin.harness.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,?,?,?,0,1,?) ON CONFLICT DO NOTHING`, accountId, id, `fixture/project-${id}`, '10', 'fixture', new Date().toISOString());
  const result = await admin(`/api/installations/${id}/activate`, 'POST', { account_id: accountId });
  if (result.status !== 201) throw new Error(JSON.stringify(result));
  // Starting turns review on; tests begin from a registered repository with review off.
  const policy = await admin(`/api/repositories/${id}/policy`, 'PATCH', { review_enabled: false });
  if (policy.status !== 200) throw new Error(JSON.stringify(policy));
  return (await admin('/api/repositories/' + id)).value.repository;
}
// Saves part of a project's Manager configuration (prompt `content`, `work` settings or `events` filters) at its current revision.
export async function saveManager(admin, id, change) {
  const current = await admin(`/api/repositories/${id}/manager`);
  if (current.status !== 200) throw new Error(JSON.stringify(current));
  return admin(`/api/repositories/${id}/manager`, 'PUT', { expected_revision: current.value.manager.prompt.revision, ...change });
}
// The text a Manager section takes effect with (a repository file, the project's section, or the built-in text).
export const managerSection = async (admin, id, section) => (await admin(`/api/repositories/${id}/manager`)).value.manager.sections.find(entry => entry.id === section).effective;
