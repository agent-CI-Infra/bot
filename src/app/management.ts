import { identityProjection } from '../identity/storage.js';
import { syncEventFilters } from '../work/settings.js';
import { projectActivityColumns, projectActivityJoin } from './project-activity.js';
import { projectListPage } from './project-list.js';
import { PERMISSIONS_FRESH_MS, permissionGap } from './installations.js';
import { missingEvents } from '../github/client.js';
import { accessGaps } from './access.js';
import { createPrivateKey } from 'node:crypto';
import { Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from './auth.js';
import { fail, fields, hashPassword, password, randomId, text, type Json } from '../core/security.js';
import { loadAutomationConfig, parseAutomationConfig } from '../automation/config.js';
import { dropUninstalledIntegrations } from '../projects/integrations.js';
import { concurrencyValue, defaultConcurrency } from './settings.js';
import { policyView, roleBoard, roleConcurrency, roleConcurrencyValue } from '../roles/board.js';
import { activateActions } from '../actions/storage.js';
import { authorize, listEffectiveProjectAccess, listEffectiveScopes } from '../identity/authorization.js';

export const publicUser = (row: Row) => ({ id: row.id, username: row.username, role: row.role, active: !!row.active });
// A user created by signing in with GitHub has no local password: the column is NOT NULL, so it carries this sentinel
// (src/identity/github.ts). Its username is opaque on purpose and is never a local account.
const EXTERNAL_ONLY_PASSWORD = '!external-only';
function userAccessView(store: Store, row: Row): Json {
  // One GitHub identity per host and actor; a pending one outranks a revoked one so a re-bind in flight stays visible.
  const identity = store.get("SELECT display_name,status FROM external_identities WHERE principal_id=? AND provider='github' AND host='github.com' "
    + "ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending_verification' THEN 1 ELSE 2 END, verified_at DESC LIMIT 1", row.id);
  const scopes = listEffectiveScopes(store, row.id), status = identity ? String(identity.status) : null;
  // #547: an unbound account is told exactly that. The login it used before is not kept on the page: once the binding is
  // revoked the name is no longer a way in, and showing it would read as if the account could still use it.
  const revoked = status === 'revoked';
  const github = !identity ? null : revoked ? { status } : { login: identity.display_name, status };
  const binding = !identity ? 'none' : status === 'active' ? 'bound' : String(status);
  const local = String(row.password_hash ?? EXTERNAL_ONLY_PASSWORD) !== EXTERNAL_ONLY_PASSWORD;
  // github_login stays for the callers that already read it (session header, older console helpers); the new fields carry
  // the state it could not express.
  return { ...publicUser(row), ...(github?.login ? { github_login: github.login } : {}),
    local_login: local, local_account: local ? row.username : null, github, github_binding: binding,
    // Both ways in, as the server reads them: the password sentinel for local sign-in and a live GitHub identity for OAuth.
    login_methods: [...(local ? ['local'] : []), ...(github && !revoked ? ['github'] : [])],
    // What an administrator reads, and what the list sorts on: the GitHub login, else the local name.
    display_name: github?.login ? String(github.login) : row.username,
    access: { projects: listEffectiveProjectAccess(store, row.id), github_pending: status === 'pending_verification' ||
      scopes.some(g => g.source === 'github_derived' && g.state === 'pending_verification') } };
}
interface Grants { repositories?: string[]; organizations?: string[] }
function grantIds(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length > 1000) return fail(400, code);
  return [...new Set(value.map(v => text(v)))];
}
// A project administrator holds single repositories and whole organizations (owner_id); the two are independent and add up.
// A repository may still be installed but not enabled: enabling keeps its id, so the grant applies then. An organization
// must own a repository that is installed now, or already be granted to the user being edited: one whose repositories all
// left the installation is kept until an administrator deselects it. A list left out stays as it is.
function grants(store: Store, body: Json, userId: string | null = null): Grants {
  const repositories = body.repository_ids === undefined ? undefined : grantIds(body.repository_ids, 'invalid_repository_ids');
  const organizations = body.organization_ids === undefined ? undefined : grantIds(body.organization_ids, 'invalid_organization_ids');
  if (repositories?.some(id => !store.get(`SELECT 1 FROM installed_repositories WHERE repository_id=? AND installed=1
    UNION ALL SELECT 1 FROM repositories WHERE id=?`, id, id))) fail(400, 'repository_not_found');
  if (organizations?.some(id => !store.get(`SELECT 1 FROM installed_repositories WHERE owner_id=? AND installed=1
    UNION ALL SELECT 1 FROM project_admin_organizations WHERE owner_id=? AND user_id=?`, id, id, userId))) fail(400, 'organization_not_found');
  return { repositories, organizations };
}
function saveGrants(store: Store, userId: string, { repositories, organizations }: Grants, grantor: string): void {
  // Only rows that change are written: removing one raises the authorization revision (identity trigger), keeping or
  // adding one does not, so saving an unchanged list leaves background content in place (#521).
  if (repositories) {
    store.run('DELETE FROM project_admin_assignments WHERE user_id=? AND repository_id NOT IN (SELECT value FROM json_each(?))', userId, JSON.stringify(repositories));
    for (const id of repositories) store.run('INSERT OR IGNORE INTO project_admin_assignments VALUES(?,?)', userId, id);
  }
  if (organizations) {
    store.run('DELETE FROM project_admin_organizations WHERE user_id=? AND owner_id NOT IN (SELECT value FROM json_each(?))', userId, JSON.stringify(organizations));
    for (const id of organizations) store.run('INSERT OR IGNORE INTO project_admin_organizations VALUES(?,?)', userId, id);
  }
  identityProjection(store);
  store.run("UPDATE scoped_grants SET grantor_id=?,verified_at=?,evidence='console manual authorization' WHERE principal_id=? AND policy='legacy'", grantor, Date.now(), userId);
}
// What grants can be chosen from: installed repositories, one group per owner_id named by the newest login GitHub reported.
function installedOrganizations(store: Store): Json[] {
  const groups = new Map<string, { owner_id: string; owner_login: string; repositories: Json[] }>();
  const registered = new Set(store.all('SELECT id FROM repositories').map(row => String(row.id)));
  for (const row of store.all('SELECT repository_id,full_name,owner_id,owner_login FROM installed_repositories WHERE installed=1 ORDER BY synced_at DESC')) {
    const owner = String(row.owner_id), group = groups.get(owner) ?? { owner_id: owner, owner_login: '', repositories: [] };
    groups.set(owner, group); group.owner_login ||= row.owner_login;
    // The same repository may be listed by more than one account.
    if (!group.repositories.some(repo => repo.id === row.repository_id)) group.repositories.push({ id: row.repository_id, full_name: row.full_name, registered: registered.has(row.repository_id) });
  }
  const name = (value: Json) => String(value.full_name);
  return [...groups.values()].map(group => ({ ...group, owner_login: group.owner_login || name(group.repositories[0]!).split('/')[0]!,
    repositories: group.repositories.sort((a, b) => name(a).localeCompare(name(b))) })).sort((a, b) => a.owner_login.localeCompare(b.owner_login));
}
// What the account detail page needs about one installation, from the last listing GitHub returned: the repositories it
// still covers and what the grant is short of. An unread grant stays null, and an installation GitHub removed is kept as
// history (`installed: false`) instead of disappearing from the account.
function accountInstallations(store: Store, row: Row, now: number): Json[] {
  const groups = new Map<string, { installation_id: string; owner_login: string; installed: boolean; repositories: number;
    permissions: string | null; events: string | null; permissions_at: string | null }>();
  for (const seen of store.all(`SELECT installation_id,owner_login,installed,permissions,events,permissions_at
    FROM installed_repositories WHERE account_id=? AND installation_id IS NOT NULL ORDER BY installation_id`, row.id)) {
    const id = String(seen.installation_id), group = groups.get(id) ?? { installation_id: id, owner_login: '', installed: false,
      repositories: 0, permissions: null, events: null, permissions_at: null };
    groups.set(id, group);
    group.owner_login ||= String(seen.owner_login || '');
    group.repositories += Number(seen.installed) ? 1 : 0;
    group.installed ||= !!Number(seen.installed);
    // A listing without permissions keeps the grant read before, so the first one present is the newest reading here.
    group.permissions ??= seen.permissions as string | null;
    group.events ??= seen.events as string | null;
    group.permissions_at ??= seen.permissions_at as string | null;
  }
  return [...groups.values()].sort((a, b) => a.installation_id.localeCompare(b.installation_id)).map(installation => {
    let events: unknown = null; try { events = installation.events ? JSON.parse(installation.events) : null; } catch { events = null; }
    return { installation_id: installation.installation_id, owner_login: installation.owner_login,
      installed: installation.installed, repositories: installation.repositories,
      missing_permissions: permissionGap(String(row.type), installation.permissions),
      missing_events: events === null ? null : missingEvents(events),
      // The same gaps as the repository rows, with the features each one stops: an unread grant stays null.
      access_gaps: accessGaps(String(row.type), installation.permissions, installation.events),
      permissions_checked_at: installation.permissions_at,
      permissions_stale: !installation.permissions_at || events === null || now - Date.parse(installation.permissions_at) > PERMISSIONS_FRESH_MS };
  });
}
function accountView(store: Store, row: Row): Json {
  const secret = store.secrets.open(row.credentials, `account:${row.id}`);
  return { id: row.id, name: row.name, type: row.type, app_id: row.app_id,
    credentials_configured: !!(secret.private_key || secret.token), created_at: row.created_at,
    endpoints: store.all('SELECT id,secret FROM endpoints WHERE account_id=?', row.id).map(e => ({
      id: e.id, webhook_path: `/hooks/github/${row.id}/${e.id}`,
      secret_configured: !!store.secrets.open(e.secret, `endpoint:${e.id}`).value })),
    // The account's own installations, always a list so an empty one is stated rather than left out.
    installations: accountInstallations(store, row, Date.now()),
    // Projects (the console's registered repositories) that were started on this account.
    project_count: Number(store.get('SELECT count(*) AS n FROM repositories WHERE account_id=?', row.id)!.n) };
}
function credential(type: string, value: unknown): string {
  const result = text(value, 32768).replaceAll('\\n', '\n');
  if (type === 'github_app') {
    try { if (createPrivateKey(result).asymmetricKeyType !== 'rsa') throw new Error(); }
    catch { return fail(400, 'invalid_rsa_private_key'); }
  }
  return result;
}

export async function management(store: Store, user: Actor, method: string, url: URL, body: Json): Promise<Json | undefined> {
  const path = url.pathname;
  if (path === '/api/users') {
    superAdmin(user);
    if (method === 'GET') {
      // Ordered by what the table shows (#547): the placeholder username of a GitHub-only account sorts under "g" and
      // would put @zoe before every local name starting later in the alphabet.
      const users = store.all('SELECT id,username,role,active,password_hash FROM users').map(row => userAccessView(store, row));
      users.sort((left, right) => String(left.display_name).localeCompare(String(right.display_name), 'zh-CN')
        || String(left.username).localeCompare(String(right.username)));
      return { users };
    }
    if (method === 'POST') {
      fields(body, ['username', 'password', 'role', 'repository_ids', 'organization_ids']);
      const username = text(body.username, 100), encoded = await hashPassword(password(body.password));
      const role = body.role ?? 'project_admin';
      if (!['super_admin', 'project_admin'].includes(String(role))) fail(400, 'invalid_role');
      const id = randomId();
      return store.transaction(() => {
        // A super administrator sees every project, so grants sent with one are ignored.
        const granted = role === 'project_admin' ? grants(store, { repository_ids: body.repository_ids ?? [], organization_ids: body.organization_ids ?? [] }) : {};
        if (store.get('SELECT id FROM users WHERE username=?', username)) fail(409, 'username_exists');
        store.run('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', id, username, encoded, String(role));
        saveGrants(store, id, granted, user.id);
        store.audit(user.id, 'user.created', id);
        return { user: publicUser(store.get('SELECT * FROM users WHERE id=?', id)!) };
      });
    }
  }
  if (path.startsWith('/api/users/')) {
    superAdmin(user);
    const id = path.split('/')[3]!;
    if (method === 'PATCH' && path === `/api/users/${id}`) {
      fields(body, ['active']);
      if (typeof body.active !== 'boolean') fail(400, 'invalid_active');
      return store.transaction(() => {
        const row = store.get('SELECT * FROM users WHERE id=?', id);
        if (!row) return fail(404, 'user_not_found');
        if (!body.active && row.role === 'super_admin' && store.get("SELECT count(*) AS n FROM users WHERE role='super_admin' AND active=1")!.n <= 1) fail(409, 'last_super_admin');
        store.run('UPDATE users SET active=? WHERE id=?', Number(body.active), id);
        if (!body.active) store.run('DELETE FROM sessions WHERE user_id=?', id);
        store.audit(user.id, 'user.updated', id);
        return { user: publicUser(store.get('SELECT * FROM users WHERE id=?', id)!) };
      });
    }
    // Deleting a user ends its sessions, drops its repository and organization grants and personal board, and frees the login name.
    // The audit keeps its records; deleting yourself needs another active super administrator, as disabling does.
    if (method === 'DELETE' && path === `/api/users/${id}`) {
      fields(body, ['confirm']); if (body.confirm !== true) fail(400, 'confirmation_required');
      return store.transaction(() => {
        const row = store.get('SELECT * FROM users WHERE id=?', id);
        if (!row) return fail(404, 'user_not_found');
        if (row.role === 'super_admin' && row.active && store.get("SELECT count(*) AS n FROM users WHERE role='super_admin' AND active=1")!.n <= 1) fail(409, 'last_super_admin');
        const boardFields = 'SELECT id FROM board_fields WHERE user_id=?';
        for (const [sql, count] of [['DELETE FROM sessions WHERE user_id=?', 1], ['DELETE FROM project_admin_assignments WHERE user_id=?', 1],
          ['DELETE FROM project_admin_organizations WHERE user_id=?', 1],
          [`DELETE FROM board_values WHERE user_id=? OR field_id IN (${boardFields})`, 2], [`DELETE FROM board_options WHERE field_id IN (${boardFields})`, 1],
          ['DELETE FROM board_fields WHERE user_id=?', 1], ['DELETE FROM board_views WHERE user_id=?', 1], ['DELETE FROM users WHERE id=?', 1]] as const) store.run(sql, ...Array<string>(count).fill(id));
        if (store.hasTable('app_manifest_states')) store.run('DELETE FROM app_manifest_states WHERE user_id=?', id);
        store.audit(user.id, 'user.deleted', id);
        return { deleted: true, id, self: id === user.id };
      });
    }
  }
  if (path === '/api/project-admin-assignments') {
    superAdmin(user);
    if (method === 'GET') return { assignments: store.all('SELECT * FROM project_admin_assignments ORDER BY user_id,repository_id'),
      organization_assignments: store.all('SELECT * FROM project_admin_organizations ORDER BY user_id,owner_id'), organizations: installedOrganizations(store) };
    if (method === 'PUT') {
      fields(body, ['user_id', 'repository_ids', 'organization_ids']);
      const id = text(body.user_id);
      if (body.repository_ids === undefined && body.organization_ids === undefined) fail(400, 'invalid_repository_ids');
      if (!store.get("SELECT id FROM users WHERE id=? AND role='project_admin'", id)) fail(400, 'project_admin_not_found');
      return store.transaction(() => {
        saveGrants(store, id, grants(store, body, id), user.id);
        store.audit(user.id, 'assignments.updated', id);
        return { ok: true };
      });
    }
  }
  if (path === '/api/accounts' || path.startsWith('/api/accounts/')) {
    superAdmin(user);
    if (path === '/api/accounts' && method === 'GET') return { accounts: store.all('SELECT * FROM accounts ORDER BY created_at').map(r => accountView(store, r)) };
    if (path === '/api/accounts' && method === 'POST') {
      fields(body, ['name', 'type', 'app_id', 'private_key', 'token', 'webhook_secret']);
      const type = text(body.type), name = text(body.name);
      if (!['github_app', 'bot_account'].includes(type)) fail(400, 'invalid_account_type');
      const appId = type === 'github_app' ? text(body.app_id) : null;
      if (appId && !/^\d+$/.test(appId)) fail(400, 'invalid_app_id');
      if (type === 'github_app' && body.token !== undefined || type === 'bot_account' && (body.private_key !== undefined || body.app_id !== undefined)) fail(400, 'conflicting_credentials');
      const key = type === 'github_app' ? 'private_key' : 'token';
      const value = credential(type, body[key]), webhookSecret = text(body.webhook_secret, 32768), id = randomId(), endpoint = randomId();
      return store.transaction(() => {
        store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', id, name, type, appId, store.secrets.seal({ [key]: value }, `account:${id}`), new Date().toISOString());
        store.run('INSERT INTO endpoints VALUES(?,?,?)', endpoint, id, store.secrets.seal({ value: webhookSecret }, `endpoint:${endpoint}`));
        store.audit(user.id, 'account.created', id);
        return { account: accountView(store, store.get('SELECT * FROM accounts WHERE id=?', id)!) };
      });
    }
    const id = path.split('/')[3] || '', row = store.get('SELECT * FROM accounts WHERE id=?', id);
    if (!row) return fail(404, 'account_not_found');
    if (path === `/api/accounts/${id}` && method === 'GET') return { account: accountView(store, row) };
    if (path === `/api/accounts/${id}` && method === 'PATCH') {
      fields(body, ['name', 'private_key', 'token']);
      const key = row.type === 'github_app' ? 'private_key' : 'token', wrong = key === 'token' ? 'private_key' : 'token';
      if (body[wrong] !== undefined) fail(400, 'conflicting_credentials');
      const secrets = store.secrets.open(row.credentials, `account:${id}`);
      if (body[key] !== undefined && !(typeof body[key] === 'string' && !body[key].trim())) secrets[key] = credential(row.type, body[key]);
      return store.transaction(() => {
        store.run('UPDATE accounts SET name=?,credentials=? WHERE id=?', body.name === undefined ? row.name : text(body.name), store.secrets.seal(secrets, `account:${id}`), id);
        store.audit(user.id, 'account.updated', id);
        return { account: accountView(store, store.get('SELECT * FROM accounts WHERE id=?', id)!) };
      });
    }
    // Removes the account from this system only: GitHub keeps the App installed and every repository as it is.
    // Projects on the account must be deleted first; its webhook endpoints, installation listing and sealed credentials go with it.
    if (path === `/api/accounts/${id}` && method === 'DELETE') {
      fields(body, ['confirm']); if (body.confirm !== true) fail(400, 'confirmation_required');
      return store.transaction(() => {
        if (store.get('SELECT 1 FROM repositories WHERE account_id=?', id)) fail(409, 'account_has_projects');
        for (const table of ['endpoints', 'installation_syncs', 'installed_repositories', 'processed_deliveries']) store.run(`DELETE FROM ${table} WHERE account_id=?`, id);
        if (store.hasTable('app_manifest_states')) store.run('DELETE FROM app_manifest_states WHERE account_id=?', id);
        // The onboarding wizard must not keep offering an App that is gone.
        store.run("DELETE FROM settings WHERE key='onboarding.app' AND json_valid(value) AND json_extract(value,'$.account_id')=?", id);
        dropUninstalledIntegrations(store);
        store.run('DELETE FROM accounts WHERE id=?', id);
        store.audit(user.id, 'account.deleted', id);
        return { deleted: true, id };
      });
    }
    // Revoking only reports the outcome: the sealed account is empty now, and the console re-reads the account when it
    // needs the rest. No credential value, installation listing or webhook path rides along with the revocation.
    if (path === `/api/accounts/${id}/credentials/revoke` && method === 'POST') {
      fields(body, []);
      return store.transaction(() => {
        store.run('UPDATE accounts SET credentials=? WHERE id=?', store.secrets.seal({}, `account:${id}`), id);
        store.audit(user.id, 'account.credentials_revoked', id);
        return { revoked: true };
      });
    }
    if (path === `/api/accounts/${id}/endpoints` && method === 'POST') {
      fields(body, ['webhook_secret']);
      const endpoint = randomId(), secret = text(body.webhook_secret, 32768);
      return store.transaction(() => {
        store.run('INSERT INTO endpoints VALUES(?,?,?)', endpoint, id, store.secrets.seal({ value: secret }, `endpoint:${endpoint}`));
        store.audit(user.id, 'endpoint.created', endpoint);
        return { id: endpoint, webhook_path: `/hooks/github/${id}/${endpoint}` };
      });
    }
    const endpoint = path.split('/')[5];
    if (endpoint && path === `/api/accounts/${id}/endpoints/${endpoint}` && method === 'PATCH') {
      fields(body, ['webhook_secret', 'revoke']);
      if (!store.get('SELECT id FROM endpoints WHERE id=? AND account_id=?', endpoint, id)) fail(404, 'endpoint_not_found');
      if (body.revoke !== undefined && body.revoke !== true) fail(400, 'invalid_revoke');
      if (body.revoke === true && body.webhook_secret) fail(400, 'conflicting_credentials');
      const value = body.revoke === true ? '' : typeof body.webhook_secret === 'string' && !body.webhook_secret.trim() ? null : text(body.webhook_secret, 32768);
      return store.transaction(() => {
        if (value !== null) store.run('UPDATE endpoints SET secret=? WHERE id=?', store.secrets.seal({ value }, `endpoint:${endpoint}`), endpoint);
        store.audit(user.id, 'endpoint.updated', endpoint);
        return { ok: true };
      });
    }
  }
  if (path === '/api/repositories') {
    if (method === 'GET') {
      const filter = scope(user, 'r.id');
      return { repositories: projectListPage(store.all(`SELECT r.*,p.model_id,p.review_enabled,p.development_enabled,p.enabled,p.automation,${projectActivityColumns} FROM repositories r
        JOIN policies p ON p.repository_id=r.id ${projectActivityJoin} WHERE ${filter.sql} ORDER BY r.full_name`, ...filter.args), url) };
    }
  }
  const roleBoardMatch = /^\/api\/repositories\/([^/]+)\/role-board$/.exec(path);
  if (roleBoardMatch) {
    // Read-only projection: the same project grant as every other /api/repositories/:id read, and no audit entry.
    repository(store, user, roleBoardMatch[1]!);
    if (method !== 'GET') return fail(405, 'method_not_allowed');
    return roleBoard(store, roleBoardMatch[1]!, url);
  }
  const repoMatch = /^\/api\/repositories\/([^/]+)(\/policy)?$/.exec(path);
  if (repoMatch) {
    const id = repoMatch[1]!; repository(store, user, id);
    // The project's own concurrency is task_concurrency (null follows the default); the default comes with it so a project
    // administrator sees what an empty field means without reading the global settings.
    const concurrency = () => ({ task_concurrency_default: defaultConcurrency(store) });
    const canConfigure = () => { try { if (user.context) authorize(user.context, 'config.write', { project_id: id }); return true; } catch { return false; } };
    if (method === 'GET') return { repository: store.get('SELECT * FROM repositories WHERE id=?', id)!, can_configure: canConfigure(), policy: policyView(store, store.get('SELECT * FROM policies WHERE repository_id=?', id), id)!,
      actions_failures: store.get('SELECT enabled_at,next_scan,error FROM actions_failure_scans WHERE repository_id=?', id) || null,
      // Role limits have no default on purpose: an empty map means "no per-role limit", not a number we picked.
      role_concurrency_default: null, ...concurrency() };
    if (method === 'PATCH' && repoMatch[2]) {
      return updatePolicy(store,user,id,body);
    }
  }
  if (path === '/api/automation') {
    if (method !== 'GET') return undefined;
    const filter = scope(user, 'r.id');
    return {
      runs: store.all(`SELECT a.* FROM automation_runs a JOIN repositories r ON r.id=a.repository_id
        WHERE ${filter.sql} ORDER BY a.created_at DESC LIMIT 100`, ...filter.args),
    };
  }
  return undefined;
}

export function taskModelEntries(value:unknown):[string,string][] {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>64)fail(400,'invalid_task_models');
  const entries=Object.entries(value!);
  if(entries.some(([kind,v])=>!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(kind)||kind.length>100||['constructor','prototype','__proto__'].includes(kind)||typeof v!=='string'||!v.trim()||v.length>200))fail(400,'invalid_task_models');
  return entries as [string,string][];
}
/** Shared policy mutation used by console and management commands. */
export function updatePolicy(store:Store,user:Actor,id:string,body:Json):Json {
  repository(store,user,id);
      // Review guidance and the review label are rule files (PUT /api/repositories/:id/rules), not policy fields.
      fields(body, ['model_id', 'review_enabled', 'development_enabled', 'actions_failures_enabled', 'enabled','test_command','max_revisions','base_branch','automation',
        'review_issues','review_pull_requests','review_pr_updates','review_issue_updates','review_pr_discussion','review_language','task_concurrency','task_models','role_concurrency']);
      const taskConcurrency = body.task_concurrency === undefined || body.task_concurrency === null ? body.task_concurrency : concurrencyValue(body.task_concurrency);
      // Per-role limits are an inner limit inside the project concurrency, never a replacement for it; null unsets one role.
      const roleConcurrencyLimits = body.role_concurrency === undefined ? undefined : roleConcurrencyValue(store, id, body.role_concurrency);
      for (const key of ['review_issues', 'review_pull_requests', 'review_pr_updates', 'review_issue_updates', 'review_pr_discussion']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_policy');
      if (body.review_language !== undefined && (typeof body.review_language !== 'string' || !['auto', 'zh', 'en'].includes(body.review_language))) fail(400, 'invalid_review_language');
      for (const key of ['review_enabled', 'development_enabled', 'actions_failures_enabled', 'enabled']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_policy');
      const previous = store.get('SELECT * FROM policies WHERE repository_id=?', id)!;
      if(body.test_command!==undefined&&(typeof body.test_command!=='string'||body.test_command.length>2048))fail(400,'invalid_test_command');
      if(body.base_branch!==undefined&&(typeof body.base_branch!=='string'||body.base_branch.length>256||body.base_branch.includes('\0')))fail(400,'invalid_base_branch');
      if(body.max_revisions!==undefined&&(!Number.isSafeInteger(body.max_revisions)||Number(body.max_revisions)<0||Number(body.max_revisions)>10))fail(400,'invalid_revision_budget');
      const model = body.model_id === undefined ? previous.model_id : body.model_id === null ? null : text(body.model_id);
      // A super administrator choosing a deployment-shared model also makes it available to this repository.
      const grant = !!model && user.role === 'super_admin' && !!store.get('SELECT id FROM models WHERE id=? AND repository_id IS NULL', model);
      if (model && !grant && !store.get(`SELECT id FROM models WHERE id=? AND (repository_id=? OR (repository_id IS NULL AND EXISTS
        (SELECT 1 FROM model_projects WHERE model_id=models.id AND repository_id=?)))`, model, id, id)) fail(400, 'model_not_available');
      // Replace the exact-profile map atomically; {} restores repository defaults for all profiles.
      let taskModels: Record<string, string> | undefined;
      const taskModelGrants: string[] = [];
      if (body.task_models !== undefined) {
        const entries=taskModelEntries(body.task_models);
        taskModels = Object.create(null) as Record<string, string>;
        for (const [kind, value] of entries) {
          const chosen = value as string;
          const shared = user.role === 'super_admin' && !!store.get('SELECT id FROM models WHERE id=? AND repository_id IS NULL', chosen);
          if (!shared && !store.get(`SELECT id FROM models WHERE id=? AND (repository_id=? OR (repository_id IS NULL AND EXISTS
            (SELECT 1 FROM model_projects WHERE model_id=models.id AND repository_id=?)))`, chosen, id, id)) fail(400, 'model_not_available');
          taskModels[kind] = chosen;
          if (shared) taskModelGrants.push(chosen);
        }
      }
      let automation = previous.automation as string;
      if (body.automation !== undefined) {
        if (!body.automation || typeof body.automation !== 'object' || Array.isArray(body.automation)) fail(400, 'invalid_automation_config');
        try { automation = JSON.stringify(parseAutomationConfig(body.automation, loadAutomationConfig(previous.automation).config)); }
        catch { fail(400, 'invalid_automation_config'); }
      }
      return store.transaction(() => {
        if (body.actions_failures_enabled !== undefined) {
          store.run('UPDATE policies SET actions_failures_enabled=? WHERE repository_id=?', Number(body.actions_failures_enabled), id);
          if (body.actions_failures_enabled && !previous.actions_failures_enabled) activateActions(store, id);
        }
        store.run('UPDATE policies SET model_id=?,review_enabled=?,development_enabled=?,enabled=? WHERE repository_id=?', model,
          body.review_enabled === undefined ? previous.review_enabled : Number(body.review_enabled),
          body.development_enabled === undefined ? previous.development_enabled : Number(body.development_enabled),
          body.enabled === undefined ? previous.enabled : Number(body.enabled), id);
        if (grant) store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', model, id);
        if (taskModels !== undefined) {
          for (const chosen of taskModelGrants) store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', chosen, id);
          store.run('UPDATE policies SET task_models=? WHERE repository_id=?', JSON.stringify(taskModels), id);
        }
        const keep = (key: string, value: unknown) => body[key] === undefined ? previous[key] : value;
        store.run('UPDATE policies SET review_issues=?,review_pull_requests=?,review_pr_updates=?,review_issue_updates=?,review_pr_discussion=?,review_language=? WHERE repository_id=?',
          keep('review_issues', Number(body.review_issues)), keep('review_pull_requests', Number(body.review_pull_requests)), keep('review_pr_updates', Number(body.review_pr_updates)),
          keep('review_issue_updates', Number(body.review_issue_updates)), keep('review_pr_discussion', Number(body.review_pr_discussion)),
          keep('review_language', body.review_language), id);
        // An explicit update switch of the Manager follows the review switch changed here.
        syncEventFilters(store, id, body);
        store.audit(user.id, 'policy.updated', id, id);
        store.run('UPDATE policies SET test_command=?,max_revisions=?,base_branch=?,automation=? WHERE repository_id=?',body.test_command===undefined?previous.test_command:String(body.test_command),body.max_revisions===undefined?previous.max_revisions:Number(body.max_revisions),body.base_branch===undefined?previous.base_branch:String(body.base_branch),automation,id);
        if (taskConcurrency !== undefined) store.run('UPDATE policies SET task_concurrency=? WHERE repository_id=?', taskConcurrency as number | null, id);
        // A PATCH changes the limits it names and leaves every other role alone: the body is a delta, not the whole map.
        if (roleConcurrencyLimits !== undefined) store.run('UPDATE policies SET role_concurrency=? WHERE repository_id=?', JSON.stringify({ ...roleConcurrency(store, id), ...roleConcurrencyLimits }), id);
        return { policy: policyView(store, store.get('SELECT * FROM policies WHERE repository_id=?', id), id)!, execution_available: true, role_concurrency_default: null, task_concurrency_default: defaultConcurrency(store) };
      });
}
