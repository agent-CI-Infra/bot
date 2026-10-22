import { createPrivateKey } from 'node:crypto';
import { Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from './auth.js';
import { fail, fields, hashPassword, password, randomId, text, type Json } from '../core/security.js';
import { loadAutomationConfig, parseAutomationConfig } from '../automation/config.js';

export const publicUser = (row: Row) => ({ id: row.id, username: row.username, role: row.role, active: !!row.active });
function repoIds(store: Store, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) return fail(400, 'invalid_repository_ids');
  const ids = [...new Set(value.map(v => text(v)))];
  if (ids.some(id => !store.get('SELECT id FROM repositories WHERE id=?', id))) fail(400, 'repository_not_found');
  return ids;
}
function accountView(store: Store, row: Row): Json {
  const secret = store.secrets.open(row.credentials, `account:${row.id}`);
  return { id: row.id, name: row.name, type: row.type, app_id: row.app_id,
    credentials_configured: !!(secret.private_key || secret.token), created_at: row.created_at,
    endpoints: store.all('SELECT id,secret FROM endpoints WHERE account_id=?', row.id).map(e => ({
      id: e.id, webhook_path: `/hooks/github/${row.id}/${e.id}`,
      secret_configured: !!store.secrets.open(e.secret, `endpoint:${e.id}`).value })) };
}
function credential(type: string, value: unknown): string {
  const result = text(value, 32768).replaceAll('\\n', '\n');
  if (type === 'github_app') {
    try { if (createPrivateKey(result).asymmetricKeyType !== 'rsa') throw new Error(); }
    catch { return fail(400, 'invalid_rsa_private_key'); }
  }
  return result;
}

export async function management(store: Store, user: Actor, method: string, path: string, body: Json): Promise<Json | undefined> {
  if (path === '/api/users') {
    superAdmin(user);
    if (method === 'GET') return { users: store.all('SELECT id,username,role,active FROM users ORDER BY username').map(publicUser) };
    if (method === 'POST') {
      fields(body, ['username', 'password', 'role', 'repository_ids']);
      const username = text(body.username, 100), encoded = await hashPassword(password(body.password));
      const role = body.role ?? 'project_admin';
      if (!['super_admin', 'project_admin'].includes(String(role))) fail(400, 'invalid_role');
      const ids = repoIds(store, body.repository_ids ?? []), id = randomId();
      return store.transaction(() => {
        if (store.get('SELECT id FROM users WHERE username=?', username)) fail(409, 'username_exists');
        store.run('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', id, username, encoded, String(role));
        for (const repo of ids) store.run('INSERT INTO project_admin_assignments VALUES(?,?)', id, repo);
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
  }
  if (path === '/api/project-admin-assignments') {
    superAdmin(user);
    if (method === 'GET') return { assignments: store.all('SELECT * FROM project_admin_assignments ORDER BY user_id,repository_id') };
    if (method === 'PUT') {
      fields(body, ['user_id', 'repository_ids']);
      const id = text(body.user_id), ids = repoIds(store, body.repository_ids);
      if (!store.get("SELECT id FROM users WHERE id=? AND role='project_admin'", id)) fail(400, 'project_admin_not_found');
      return store.transaction(() => {
        store.run('DELETE FROM project_admin_assignments WHERE user_id=?', id);
        for (const repo of ids) store.run('INSERT INTO project_admin_assignments VALUES(?,?)', id, repo);
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
    if (path === `/api/accounts/${id}/credentials/revoke` && method === 'POST') {
      fields(body, []);
      return store.transaction(() => {
        store.run('UPDATE accounts SET credentials=? WHERE id=?', store.secrets.seal({}, `account:${id}`), id);
        store.audit(user.id, 'account.credentials_revoked', id);
        return { account: accountView(store, store.get('SELECT * FROM accounts WHERE id=?', id)!) };
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
      return { repositories: store.all(`SELECT r.*,p.model_id,p.review_enabled,p.development_enabled,p.enabled,p.automation FROM repositories r
        JOIN policies p ON p.repository_id=r.id WHERE ${filter.sql} ORDER BY r.full_name`, ...filter.args) };
    }
    if (method === 'POST') {
      superAdmin(user); fields(body, ['id', 'full_name', 'owner_id', 'account_id']);
      const id = text(body.id), name = text(body.full_name), owner = text(body.owner_id), account = text(body.account_id);
      if (!/^[1-9]\d*$/.test(id) || !/^[1-9]\d*$/.test(owner) || !/^[\w.-]+\/[\w.-]+$/.test(name)) fail(400, 'invalid_repository');
      if (!store.get('SELECT id FROM accounts WHERE id=?', account)) fail(400, 'account_not_found');
      return store.transaction(() => {
        if (store.get('SELECT id FROM repositories WHERE id=? OR full_name=?', id, name)) fail(409, 'repository_exists');
        store.run('INSERT INTO repositories VALUES(?,?,?,?)', id, name, owner, account);
        store.run('INSERT INTO policies(repository_id) VALUES(?)', id);
        store.audit(user.id, 'repository.created', id, id);
        return { repository: store.get('SELECT * FROM repositories WHERE id=?', id)! };
      });
    }
  }
  const repoMatch = /^\/api\/repositories\/([^/]+)(\/policy)?$/.exec(path);
  if (repoMatch) {
    const id = repoMatch[1]!; repository(store, user, id);
    if (method === 'GET') return { repository: store.get('SELECT * FROM repositories WHERE id=?', id)!, policy: store.get('SELECT * FROM policies WHERE repository_id=?', id)! };
    if (method === 'PATCH' && repoMatch[2]) {
      fields(body, ['model_id', 'review_enabled', 'development_enabled', 'enabled','test_command','max_revisions','base_branch','review_label','automation',
        'review_issues','review_pull_requests','review_pr_updates','review_language','review_instructions']);
      for (const key of ['review_issues', 'review_pull_requests', 'review_pr_updates']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_policy');
      if (body.review_language !== undefined && (typeof body.review_language !== 'string' || !['auto', 'zh', 'en'].includes(body.review_language))) fail(400, 'invalid_review_language');
      if (body.review_instructions !== undefined && (typeof body.review_instructions !== 'string' || body.review_instructions.length > 8000 || body.review_instructions.includes('\0'))) fail(400, 'invalid_review_instructions');
      for (const key of ['review_enabled', 'development_enabled', 'enabled']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_policy');
      const previous = store.get('SELECT * FROM policies WHERE repository_id=?', id)!;
      if(body.test_command!==undefined&&(typeof body.test_command!=='string'||body.test_command.length>2048))fail(400,'invalid_test_command');
      if(body.base_branch!==undefined&&(typeof body.base_branch!=='string'||body.base_branch.length>256||body.base_branch.includes('\0')))fail(400,'invalid_base_branch');
      // GitHub label names are at most 50 characters; an empty string leaves review results unlabeled.
      if(body.review_label!==undefined&&(typeof body.review_label!=='string'||body.review_label.length>50||body.review_label!==body.review_label.trim()||/\p{Cc}/u.test(body.review_label)))fail(400,'invalid_review_label');
      if(body.max_revisions!==undefined&&(!Number.isSafeInteger(body.max_revisions)||Number(body.max_revisions)<0||Number(body.max_revisions)>10))fail(400,'invalid_revision_budget');
      const model = body.model_id === undefined ? previous.model_id : body.model_id === null ? null : text(body.model_id);
      // A super administrator choosing a deployment-shared model also makes it available to this repository.
      const grant = !!model && user.role === 'super_admin' && !!store.get('SELECT id FROM models WHERE id=? AND repository_id IS NULL', model);
      if (model && !grant && !store.get(`SELECT id FROM models WHERE id=? AND (repository_id=? OR (repository_id IS NULL AND EXISTS
        (SELECT 1 FROM model_projects WHERE model_id=models.id AND repository_id=?)))`, model, id, id)) fail(400, 'model_not_available');
      let automation = previous.automation as string;
      if (body.automation !== undefined) {
        if (!body.automation || typeof body.automation !== 'object' || Array.isArray(body.automation)) fail(400, 'invalid_automation_config');
        try { automation = JSON.stringify(parseAutomationConfig(body.automation, loadAutomationConfig(previous.automation).config)); }
        catch { fail(400, 'invalid_automation_config'); }
      }
      return store.transaction(() => {
        store.run('UPDATE policies SET model_id=?,review_enabled=?,development_enabled=?,enabled=? WHERE repository_id=?', model,
          body.review_enabled === undefined ? previous.review_enabled : Number(body.review_enabled),
          body.development_enabled === undefined ? previous.development_enabled : Number(body.development_enabled),
          body.enabled === undefined ? previous.enabled : Number(body.enabled), id);
        if (grant) store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', model, id);
        const keep = (key: string, value: unknown) => body[key] === undefined ? previous[key] : value;
        store.run('UPDATE policies SET review_issues=?,review_pull_requests=?,review_pr_updates=?,review_language=?,review_instructions=? WHERE repository_id=?',
          keep('review_issues', Number(body.review_issues)), keep('review_pull_requests', Number(body.review_pull_requests)), keep('review_pr_updates', Number(body.review_pr_updates)),
          keep('review_language', body.review_language), keep('review_instructions', body.review_instructions), id);
        store.audit(user.id, 'policy.updated', id, id);
        store.run('UPDATE policies SET test_command=?,max_revisions=?,base_branch=?,review_label=?,automation=? WHERE repository_id=?',body.test_command===undefined?previous.test_command:String(body.test_command),body.max_revisions===undefined?previous.max_revisions:Number(body.max_revisions),body.base_branch===undefined?previous.base_branch:String(body.base_branch),body.review_label===undefined?previous.review_label:String(body.review_label),automation,id);
        return { policy: store.get('SELECT * FROM policies WHERE repository_id=?', id)!, execution_available: true };
      });
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
