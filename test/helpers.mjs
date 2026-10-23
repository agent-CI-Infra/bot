import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { randomBytes, createHmac } from 'node:crypto';
import { Store } from '../dist/storage/database.js';
import { createControlPlane } from '../dist/server.js';
import { ProjectService } from '../dist/projects/service.js';

export const testPassword = () => randomBytes(20).toString('hex');
export async function harness(t, manager, options = {}) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const directory = mkdtempSync(resolve('.tmp/test-')), database = join(directory, 'control.sqlite'), key = randomBytes(32);
  let store, servers;
  const h = { directory, database, key };
  h.start = async () => {
    store = new Store(database, key);
    h.projects = manager ? new ProjectService(store, manager) : undefined;
    const extra = typeof options === 'function' ? options(store) : options; h.external = extra.external;
    servers = createControlPlane({ store, staticDirectory: resolve('static'), maxBodyBytes: 2048, projects: h.projects, ...extra });
    for (const server of Object.values(servers)) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    Object.assign(h, { store, admin: `http://127.0.0.1:${servers.admin.address().port}`, webhook: `http://127.0.0.1:${servers.webhook.address().port}` });
  };
  // A browser page may still hold open connections (including speculative ones without a request) when a test stops
  // its servers; close them instead of waiting for the browser to give them up.
  h.stop = async () => { await h.external?.forwarder.close(); await Promise.all(Object.values(servers).map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); store.close(); };
  h.client = () => {
    let cookie = '', csrf = '';
    const client = async (path, method = 'GET', data, headers = {}) => {
      const r = await fetch(h.admin + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const value = await r.json(); if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
      if (value.csrf_token) csrf = value.csrf_token;
      return { status: r.status, value, headers: r.headers };
    };
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
