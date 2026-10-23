import { projectActivityColumns, projectActivityJoin } from './project-activity.js';
import { type Store, type Row } from '../storage/database.js';
import { type Actor, superAdmin } from './auth.js';
import { fail, fields, text, type Json } from '../core/security.js';
import { appJwt, appPermissions, missingPermissions } from '../github/client.js';
import { dropUninstalledIntegrations } from '../projects/integrations.js';

// Installation scope: which repositories each account can see on GitHub. Seeing a repository never registers or
// enables it; an administrator starts it in the console, and can disable it again.
interface Installed { repository_id: string; installation_id: string | null; full_name: string; owner_id: string; owner_login: string; private: boolean }

function installed(repo: Json, installationId: string | null): Installed | null {
  const owner = repo.owner as Json | undefined;
  if (!/^[1-9]\d*$/.test(String(repo.id || '')) || !/^[\w.-]+\/[\w.-]+$/.test(String(repo.full_name || '')) || !/^[1-9]\d*$/.test(String(owner?.id || ''))) return null;
  return { repository_id: String(repo.id), installation_id: installationId, full_name: String(repo.full_name), owner_id: String(owner!.id),
    owner_login: String(owner!.login || ''), private: repo.private === true };
}
function upsert(store: Store, accountId: string, rows: Installed[], now: string): void {
  for (const r of rows) store.run(`INSERT INTO installed_repositories(account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at)
    VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(account_id,repository_id) DO UPDATE SET installation_id=excluded.installation_id,full_name=excluded.full_name,
    owner_id=excluded.owner_id,owner_login=excluded.owner_login,private=excluded.private,installed=1,synced_at=excluded.synced_at`,
  accountId, r.repository_id, r.installation_id, r.full_name, r.owner_id, r.owner_login, Number(r.private), now);
}

// Applied inside the signed delivery's transaction. Returns whether a full sync should follow.
export function recordInstallationEvent(store: Store, accountId: string, event: string, payload: Json): boolean {
  if (event !== 'installation' && event !== 'installation_repositories') return false;
  const installation = payload.installation as Json | undefined, account = installation?.account as Json | undefined;
  const installationId = installation?.id ? String(installation.id) : null, now = new Date().toISOString();
  // Repository items in these events carry no owner; it is the installation account.
  const rows = (list: unknown) => (Array.isArray(list) ? list : []).map(r => installed({ ...(r as Json), owner: account }, installationId)).filter((r): r is Installed => !!r);
  if (event === 'installation_repositories') {
    upsert(store, accountId, rows(payload.repositories_added), now);
    for (const r of Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [])
      store.run('UPDATE installed_repositories SET installed=0 WHERE account_id=? AND repository_id=?', accountId, String((r as Json)?.id || ''));
  } else if (['created', 'new_permissions_accepted', 'unsuspend'].includes(String(payload.action))) upsert(store, accountId, rows(payload.repositories), now);
  else if (['deleted', 'suspend'].includes(String(payload.action)) && installationId)
    store.run('UPDATE installed_repositories SET installed=0 WHERE account_id=? AND installation_id=?', accountId, installationId);
  // A repository that left every installation is no longer checked, so its cached status would stay stale for good.
  dropUninstalledIntegrations(store);
  return true;
}

// Links shown to the administrator stay on the GitHub host the App lives on.
function githubOrigin(value: unknown): string {
  try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.origin : 'https://github.com'; } catch { return 'https://github.com'; }
}
function githubLink(value: unknown, origin: string): string | null {
  try { const url = new URL(String(value)); return url.origin === origin ? url.href : null; } catch { return null; }
}
export class InstallationSync {
  private readonly running = new Map<string, Promise<Json>>();
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com') {}
  schedule(accountId: string): void { void this.sync(accountId).catch(() => {}); }
  async syncAll(): Promise<Json[]> {
    const results: Json[] = [];
    for (const account of this.store.all('SELECT id FROM accounts ORDER BY created_at'))
      results.push(await this.sync(account.id).catch(error => ({ account_id: account.id, error: (error as Error).message })));
    return results;
  }
  sync(accountId: string): Promise<Json> {
    const current = this.running.get(accountId); if (current) return current;
    const run = this.run(accountId).finally(() => this.running.delete(accountId)); this.running.set(accountId, run); return run;
  }
  private async request(path: string, token: string, method = 'GET', body?: Json): Promise<any> {
    let response: Response;
    try { response = await fetch(this.apiUrl.replace(/\/$/, '') + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new Error('github_unavailable'); }
    if (!response.ok) throw new Error('github_http_' + response.status);
    return response.json();
  }
  private async pages(path: string, token: string, key?: string): Promise<Json[]> {
    const rows: Json[] = [];
    for (let page = 1; page <= 100; page++) {
      const value = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token), list = key ? value?.[key] : value;
      if (!Array.isArray(list)) throw new Error('github_invalid_page');
      rows.push(...list); if (list.length < 100) return rows;
    }
    throw new Error('github_pagination_limit');
  }
  // GitHub has no API that changes an App's permissions, so this only measures the gap and links the two pages that
  // close it: the App's permission settings (one save by the App owner), then each installation's review of the request.
  async permissions(accountId: string): Promise<Json> {
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', accountId); if (!account) return fail(404, 'account_not_found');
    if (account.type !== 'github_app') return fail(409, 'github_app_required');
    const secrets = this.store.secrets.open(account.credentials, `account:${account.id}`); if (!secrets.private_key) return fail(409, 'github_credentials_missing');
    const jwt = appJwt(String(account.app_id), String(secrets.private_key));
    let app: any, installations: Json[];
    try { app = await this.request('/app', jwt); installations = await this.pages('/app/installations', jwt); }
    catch (error) { return fail(502, /^[a-z_0-9]+$/.test((error as Error).message) ? (error as Error).message : 'github_unavailable'); }
    const slug = encodeURIComponent(String(app.slug || '')), owner = app.owner as Json | undefined, origin = githubOrigin(app.html_url);
    const settings = owner?.type === 'Organization' ? `${origin}/organizations/${encodeURIComponent(String(owner.login))}/settings/apps/${slug}/permissions` : `${origin}/settings/apps/${slug}/permissions`;
    const appMissing = missingPermissions(app.permissions), rows = installations.map(i => ({ id: String(i.id), account: String((i.account as Json | undefined)?.login || ''),
      suspended: !!i.suspended_at, missing: missingPermissions(i.permissions), review_url: githubLink(i.html_url, origin) }));
    return { required: appPermissions, app: { slug: String(app.slug || ''), owner: String(owner?.login || ''), missing: appMissing, settings_url: settings },
      installations: rows, ok: !appMissing.length && rows.every(row => row.suspended || !row.missing.length) };
  }
  private async run(accountId: string): Promise<Json> {
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', accountId); if (!account) throw new Error('account_not_found');
    const secrets = this.store.secrets.open(account.credentials, `account:${account.id}`), rows: Installed[] = [];
    try {
      if (account.type === 'github_app') {
        if (!secrets.private_key) throw new Error('github_credentials_missing');
        const jwt = appJwt(String(account.app_id), String(secrets.private_key));
        for (const installation of await this.pages('/app/installations', jwt)) {
          if (installation.suspended_at) continue;
          // A metadata-only token is enough to list the installation's repositories.
          const access = await this.request(`/app/installations/${installation.id}/access_tokens`, jwt, 'POST', { permissions: { metadata: 'read' } });
          for (const repo of await this.pages('/installation/repositories', String(access.token || ''), 'repositories')) {
            const row = installed(repo, String(installation.id)); if (row) rows.push(row);
          }
        }
      } else {
        if (!secrets.token) throw new Error('github_credentials_missing');
        for (const repo of await this.pages('/user/repos', String(secrets.token))) { const row = installed(repo, null); if (row) rows.push(row); }
      }
    } catch (error) {
      const code = /^[a-z_0-9]+$/.test((error as Error).message) ? (error as Error).message : 'sync_failed';
      this.store.run(`INSERT INTO installation_syncs(account_id,synced_at,error,repositories) VALUES(?,NULL,?,NULL)
        ON CONFLICT(account_id) DO UPDATE SET error=excluded.error`, accountId, code);
      throw new Error(code);
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      upsert(this.store, accountId, rows, now);
      // A full listing is authoritative: anything not seen is no longer installed. Enabled repositories stay as they are.
      this.store.run('UPDATE installed_repositories SET installed=0 WHERE account_id=? AND synced_at<>?', accountId, now);
      dropUninstalledIntegrations(this.store);
      this.store.run(`INSERT INTO installation_syncs VALUES(?,?,NULL,?) ON CONFLICT(account_id) DO UPDATE SET synced_at=excluded.synced_at,error=NULL,
        repositories=excluded.repositories`, accountId, now, rows.length);
    });
    return { account_id: accountId, repositories: rows.length, synced_at: now };
  }
}

// Listing, starting and disabling need only the database; a full sync needs the configured GitHub client.
export async function installationApi(store: Store, sync: InstallationSync | undefined, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
  const path = url.pathname, check = /^\/api\/accounts\/([^/]+)\/permissions$/.exec(path);
  if (check && method === 'GET') { superAdmin(user); if (!sync) return fail(503, 'sync_not_configured'); return sync.permissions(check[1]!); }
  if (!path.startsWith('/api/installations')) return undefined;
  superAdmin(user);
  if (path === '/api/installations' && method === 'GET') return list(store);
  if (path === '/api/installations/sync' && method === 'POST') { fields(input, []); if (!sync) return fail(503, 'sync_not_configured'); const results = await sync.syncAll(); return { results, ...list(store) }; }
  const match = /^\/api\/installations\/([1-9]\d*)\/(activate|disable)$/.exec(path);
  if (!match || method !== 'POST') return fail(404, 'not_found');
  return match[2] === 'activate' ? activate(store, user, match[1]!, input) : disable(store, user, match[1]!, input);
}
// One row per repository: what GitHub shows as installed, merged with registration, policy and environment.
function list(store: Store): Json {
  const registered = new Map(store.all(`SELECT r.id,r.full_name,r.owner_id,r.account_id,p.enabled,p.review_enabled,p.development_enabled,p.model_id,
    e.state AS environment_state,${projectActivityColumns} FROM repositories r JOIN policies p ON p.repository_id=r.id LEFT JOIN project_environments e ON e.repository_id=r.id ${projectActivityJoin}`).map(r => [r.id, r]));
  const scope = new Map<string, Row>();
  for (const row of store.all('SELECT i.*,a.name AS account_name FROM installed_repositories i JOIN accounts a ON a.id=i.account_id ORDER BY i.installed DESC')) {
    const current = scope.get(row.repository_id), owner = registered.get(row.repository_id)?.account_id;
    if (!current || !current.installed && row.installed || row.account_id === owner && row.installed >= current.installed) scope.set(row.repository_id, row);
  }
  const ids = [...new Set([...scope.keys(), ...registered.keys()])];
  const repositories = ids.map(id => {
    const seen = scope.get(id), reg = registered.get(id);
    return { id, full_name: reg?.full_name || seen!.full_name, owner_id: reg?.owner_id || seen!.owner_id, owner_login: seen?.owner_login || '', private: !!seen?.private,
      account_id: reg?.account_id || seen!.account_id, account_name: seen?.account_name || null, installation_id: seen?.installation_id || null,
      installed: seen ? !!seen.installed : null, synced_at: seen?.synced_at || null, registered: !!reg, enabled: !!reg?.enabled,
      review_enabled: !!reg?.review_enabled, development_enabled: !!reg?.development_enabled, model_id: reg?.model_id || null, environment_state: reg?.environment_state || null,
      running_tasks: reg?.running_tasks || 0, queued_tasks: reg?.queued_tasks || 0 };
  }).sort((a, b) => Number(b.registered) - Number(a.registered) || a.full_name.localeCompare(b.full_name));
  return { repositories, syncs: store.all('SELECT s.*,a.name AS account_name FROM installation_syncs s JOIN accounts a ON a.id=s.account_id') };
}
function activate(store: Store, user: Actor, id: string, input: Json): Json {
  fields(input, ['account_id', 'model_id', 'development_enabled']);
  if (input.development_enabled !== undefined && typeof input.development_enabled !== 'boolean') fail(400, 'invalid_policy');
  const registered = store.get('SELECT * FROM repositories WHERE id=?', id);
  const candidates = store.all('SELECT * FROM installed_repositories WHERE repository_id=? AND installed=1', id);
  const chosen = input.account_id ? candidates.find(c => c.account_id === text(input.account_id)) : candidates[0];
  if (!registered && !chosen) return fail(404, 'repository_not_installed');
  const model = input.model_id === undefined || input.model_id === null || input.model_id === '' ? null : text(input.model_id);
  const modelRow = model ? store.get('SELECT * FROM models WHERE id=? AND (repository_id IS NULL OR repository_id=?)', model, id) : null;
  if (model && !modelRow) fail(400, 'model_not_available');
  return store.transaction(() => {
    if (!registered) {
      if (store.get('SELECT id FROM repositories WHERE full_name=?', chosen!.full_name)) fail(409, 'repository_exists');
      store.run('INSERT INTO repositories VALUES(?,?,?,?)', id, chosen!.full_name, chosen!.owner_id, chosen!.account_id);
      store.run('INSERT INTO policies(repository_id) VALUES(?)', id);
    }
    // A deployment-shared model becomes available to this repository when chosen here.
    if (modelRow && modelRow.repository_id === null) store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', model, id);
    const policy = store.get('SELECT * FROM policies WHERE repository_id=?', id)!;
    store.run('UPDATE policies SET enabled=1,review_enabled=1,development_enabled=?,model_id=? WHERE repository_id=?',
      input.development_enabled === undefined ? policy.development_enabled : Number(input.development_enabled), model ?? policy.model_id, id);
    store.audit(user.id, registered ? 'repository.enabled' : 'repository.activated', id, id);
    return { repository: (list(store).repositories as Json[]).find(r => r.id === id)! };
  });
}
function disable(store: Store, user: Actor, id: string, input: Json): Json {
  fields(input, []);
  if (!store.get('SELECT id FROM repositories WHERE id=?', id)) return fail(404, 'repository_not_registered');
  return store.transaction(() => {
    store.run('UPDATE policies SET enabled=0 WHERE repository_id=?', id);
    store.audit(user.id, 'repository.disabled', id, id);
    return { repository: (list(store).repositories as Json[]).find(r => r.id === id)! };
  });
}
