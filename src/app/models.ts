import { Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from './auth.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';

function publicModel(row: Row): Json {
  return { id: row.id, repository_id: row.repository_id, api_url: row.api_url, model_name: row.model_name,
    key_configured: row.api_key !== null, trusted: true, version: row.version, updated_at: row.updated_at };
}
function apiUrl(value: unknown): string {
  const result = text(value, 2048);
  try { const url = new URL(result); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(); }
  catch { return fail(400, 'invalid_api_url'); }
  return result;
}
export function models(store: Store, user: Actor, method: string, url: URL, body: Json): Json | undefined {
  const path = url.pathname;
  if (!path.startsWith('/api/models')) return undefined;
  const modelScope = scope(user, 'm.repository_id'), sharedScope = scope(user, 'mp.repository_id');
  const visible = user.role === 'super_admin' ? { sql: '1=1', args: [] } : {
    sql: `(${modelScope.sql} OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND ${sharedScope.sql})))`,
    args: [...modelScope.args, ...sharedScope.args] };
  if (path === '/api/models' && method === 'GET') {
    const repo = url.searchParams.get('repository_id');
    if (repo) repository(store, user, repo);
    const extra = repo ? ' AND (m.repository_id=? OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?)))' : '';
    return { models: store.all(`SELECT m.* FROM models m WHERE ${visible.sql}${extra} ORDER BY m.updated_at`, ...visible.args, ...(repo ? [repo, repo] : [])).map(publicModel) };
  }
  if (path === '/api/models' && method === 'POST') {
    fields(body, ['repository_id', 'api_url', 'api_key', 'model_name']);
    const repo = body.repository_id == null ? null : text(body.repository_id);
    if (repo) repository(store, user, repo); else superAdmin(user);
    const id = randomId(), endpoint = apiUrl(body.api_url), key = text(body.api_key, 32768), model = text(body.model_name);
    return store.transaction(() => {
      store.run('INSERT INTO models VALUES(?,?,?,?,?,?,?)', id, repo, endpoint, model, store.secrets.seal({ value: key }, `model:${id}`), 1, new Date().toISOString());
      store.audit(user.id, 'model.created', id, repo);
      return { model: publicModel(store.get('SELECT * FROM models WHERE id=?', id)!) };
    });
  }
  const id = path.split('/')[3] || '';
  const row = store.get(`SELECT m.* FROM models m WHERE m.id=? AND ${visible.sql}`, id, ...visible.args);
  if (!row) return fail(404, 'model_not_found');
  if (path === `/api/models/${id}` && method === 'GET') return { model: publicModel(row) };
  if (row.repository_id) repository(store, user, row.repository_id); else superAdmin(user);
  if (path === `/api/models/${id}` && method === 'PATCH') {
    fields(body, ['api_url', 'api_key', 'model_name', 'version']);
    if (body.version !== row.version) fail(409, 'version_conflict');
    const endpoint = body.api_url === undefined ? row.api_url : apiUrl(body.api_url);
    const model = body.model_name === undefined ? row.model_name : text(body.model_name);
    const key = body.api_key === undefined || typeof body.api_key === 'string' && !body.api_key.trim() ? row.api_key : store.secrets.seal({ value: text(body.api_key, 32768) }, `model:${id}`);
    return store.transaction(() => {
      const changed = store.run('UPDATE models SET api_url=?,model_name=?,api_key=?,version=version+1,updated_at=? WHERE id=? AND version=?', endpoint, model, key, new Date().toISOString(), id, row.version);
      if (!changed.changes) fail(409, 'version_conflict');
      store.audit(user.id, 'model.updated', id, row.repository_id);
      return { model: publicModel(store.get('SELECT * FROM models WHERE id=?', id)!) };
    });
  }
  if (path === `/api/models/${id}/credentials/revoke` && method === 'POST') {
    fields(body, []);
    return store.transaction(() => {
      store.run('UPDATE models SET api_key=NULL,version=version+1,updated_at=? WHERE id=?', new Date().toISOString(), id);
      store.audit(user.id, 'model.key_revoked', id, row.repository_id);
      return { model: publicModel(store.get('SELECT * FROM models WHERE id=?', id)!) };
    });
  }
  if (path === `/api/models/${id}/projects` && method === 'PUT') {
    superAdmin(user); fields(body, ['repository_ids']);
    if (row.repository_id || !Array.isArray(body.repository_ids)) return fail(400, 'shared_model_required');
    const ids = [...new Set(body.repository_ids.map(value => text(value)))];
    ids.forEach(repo => repository(store, user, repo));
    return store.transaction(() => {
      store.run('DELETE FROM model_projects WHERE model_id=?', id);
      ids.forEach(repo => store.run('INSERT INTO model_projects VALUES(?,?)', id, repo));
      store.audit(user.id, 'model.sharing_updated', id);
      return { ok: true };
    });
  }
  return undefined;
}
