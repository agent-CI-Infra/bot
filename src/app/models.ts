import { Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from './auth.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';
import { pricingFor, savePricing, validatePricing } from '../metrics/accounting.js';
import { modelEndpoints } from '../agent/model.js';
import { listUpstreamModels, testUpstreamModel } from './model-probe.js';

function publicModel(store: Store, row: Row): Json {
  return { id: row.id, repository_id: row.repository_id, api_url: row.api_url, model_name: row.model_name,
    key_configured: row.api_key !== null, trusted: true, version: row.version, updated_at: row.updated_at, pricing: pricingFor(store,String(row.id)),
    endpoints: modelEndpoints(String(row.api_url)) };
}
/**
 * Which projects use these models, as one query for a whole list instead of one per model. It is the same projection
 * the single-model read has always returned — the project default plus per-task overrides — deliberately without
 * roles: #230 keeps the list to the projects that reference a model, and role references are a separate contract.
 */
function usageByModel(store: Store, user: Actor, ids: string[]): Record<string, Json[]> {
  const usage: Record<string, Json[]> = {}, usedScope = scope(user, 'p.repository_id'), marks = ids.map(() => '?').join(',');
  if (!ids.length) return usage;
  const wanted = new Set(ids);
  const rows = store.all(`SELECT p.model_id,p.task_models,p.repository_id,r.full_name FROM policies p JOIN repositories r ON r.id=p.repository_id
    WHERE (p.model_id IN (${marks}) OR EXISTS(SELECT 1 FROM json_each(p.task_models) WHERE value IN (${marks}))) AND ${usedScope.sql}
    ORDER BY p.repository_id`, ...ids, ...ids, ...usedScope.args);
  for (const row of rows) {
    const used = new Set<string>();
    if (row.model_id !== null && wanted.has(String(row.model_id))) used.add(String(row.model_id));
    let overrides: unknown;
    try { overrides = JSON.parse(String(row.task_models ?? '{}')); } catch { overrides = null; }
    for (const value of overrides && typeof overrides === 'object' ? Object.values(overrides as Record<string, unknown>) : [])
      if (wanted.has(String(value))) used.add(String(value));
    for (const id of used) (usage[id] ??= []).push({ repository_id: row.repository_id, full_name: row.full_name });
  }
  return usage;
}
// Routes are appended to the URL text, so a query or fragment, even an empty "?" or "#", would swallow the route and
// leave the requested path to whoever wrote the URL. Such a URL never reached a model route, so it is refused.
function apiUrl(value: unknown): string {
  const result = text(value, 2048);
  try { const url = new URL(result); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(result)) throw new Error(); }
  catch { return fail(400, 'invalid_api_url'); }
  return result;
}
function modelNames(value: unknown, required = false): string[] {
  if (!Array.isArray(value) || value.length > 200 || required && !value.length) return fail(400, 'invalid_model_names');
  const names = value.map(name => text(name, 200));
  if (new Set(names).size !== names.length) return fail(400, 'duplicate_model_names');
  return names;
}
function providerModels(store: Store, row: Row): Row[] {
  const address = modelEndpoints(String(row.api_url)).chat_url;
  return store.all('SELECT * FROM models WHERE repository_id IS ?', row.repository_id).filter(model => modelEndpoints(String(model.api_url)).chat_url === address);
}
function createModel(store: Store, repo: string | null, endpoint: string, key: string, name: string): Row {
  const id = randomId();
  store.run('INSERT INTO models VALUES(?,?,?,?,?,?,?)', id, repo, endpoint, name, store.secrets.seal({value:key}, `model:${id}`), 1, new Date().toISOString());
  return store.get('SELECT * FROM models WHERE id=?', id)!;
}
export async function models(store: Store, user: Actor, method: string, url: URL, body: Json): Promise<Json | undefined> {
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
    const rows = store.all(`SELECT m.* FROM models m WHERE ${visible.sql}${extra} ORDER BY m.updated_at`, ...visible.args, ...(repo ? [repo, repo] : []));
    const usage = usageByModel(store, user, rows.map(row => String(row.id)));
    return { models: rows.map(row => ({ ...publicModel(store, row), used_by: usage[String(row.id)] ?? [] })) };
  }
  if (path === '/api/models/provider' && method === 'POST') {
    fields(body, ['repository_id','api_url','api_key','model_names']);
    const repo = body.repository_id == null ? null : text(body.repository_id);
    if (repo) repository(store,user,repo); else superAdmin(user);
    const endpoint = apiUrl(body.api_url), key = text(body.api_key,32768), names = modelNames(body.model_names,true);
    return store.transaction(() => {
      if (providerModels(store,{repository_id:repo,api_url:endpoint}).length) fail(409,'provider_already_exists');
      const added = names.map(name => createModel(store,repo,endpoint,key,name));
      store.audit(user.id,'model.provider_created',added[0]!.id,repo);
      return {models:added.map(row => publicModel(store,row))};
    });
  }
  if (path === '/api/models' && method === 'POST') {
    fields(body, ['repository_id', 'api_url', 'api_key', 'model_name', 'pricing', 'key_from']);
    const repo = body.repository_id == null ? null : text(body.repository_id);
    if (repo) repository(store, user, repo); else superAdmin(user);
    // key_from adds another model of the same provider: the URL and key come from that saved model, which must belong
    // to the same project (or both are shared), so a key never reaches a scope it was not given to.
    let endpoint: string, key: string;
    if (body.key_from !== undefined) {
      if (body.api_url !== undefined || body.api_key !== undefined) fail(400, 'invalid_model_source');
      const source = store.get('SELECT * FROM models WHERE id=? AND repository_id IS ?', text(body.key_from), repo);
      if (!source) return fail(404, 'model_not_found');
      key = source.api_key === null ? '' : String(store.secrets.open(source.api_key, `model:${source.id}`).value || '');
      if (!key) return fail(409, 'model_key_missing');
      endpoint = apiUrl(source.api_url);
    } else { endpoint = apiUrl(body.api_url); key = text(body.api_key, 32768); }
    const id = randomId(), model = text(body.model_name);
    const pricing=body.pricing===undefined?null:validatePricing(body.pricing);
    return store.transaction(() => {
      store.run('INSERT INTO models VALUES(?,?,?,?,?,?,?)', id, repo, endpoint, model, store.secrets.seal({ value: key }, `model:${id}`), 1, new Date().toISOString());
      savePricing(store,id,pricing);
      store.audit(user.id, 'model.created', id, repo);
      return { model: publicModel(store,store.get('SELECT * FROM models WHERE id=?', id)!) };
    });
  }
  // Where a URL sends requests; it needs no key, so the forms can show it while the address is typed.
  if (path === '/api/models/endpoints' && method === 'GET') return modelEndpoints(apiUrl(url.searchParams.get('api_url')));
  // Listing and testing an unsaved model need the right to create it there. Nothing is stored and nothing is audited.
  if (['/api/models/upstream', '/api/models/test'].includes(path) && method === 'POST') {
    const test = path.endsWith('/test');
    fields(body, ['repository_id', 'api_url', 'api_key', ...(test ? ['model_name'] : [])]);
    const repo = body.repository_id == null ? null : text(body.repository_id);
    if (repo) repository(store, user, repo); else superAdmin(user);
    const endpoint = apiUrl(body.api_url), key = text(body.api_key, 32768);
    return test ? testUpstreamModel(endpoint, key, text(body.model_name)) : listUpstreamModels(endpoint, key);
  }
  const id = path.split('/')[3] || '';
  const row = store.get(`SELECT m.* FROM models m WHERE m.id=? AND ${visible.sql}`, id, ...visible.args);
  if (!row) return fail(404, 'model_not_found');
  if (path === `/api/models/${id}` && method === 'GET') {
    const model = publicModel(store,row);
    if (user.role === 'super_admin' || row.repository_id && user.repositories.includes(row.repository_id)) {
      const usedScope = scope(user, 'p.repository_id');
      model.used_by = store.all(`SELECT p.repository_id,r.full_name FROM policies p JOIN repositories r ON r.id=p.repository_id
        WHERE (p.model_id=? OR EXISTS(SELECT 1 FROM json_each(p.task_models) WHERE value=?)) AND ${usedScope.sql} ORDER BY p.repository_id`, id, id, ...usedScope.args);
    }
    return { model };
  }
  if (row.repository_id) repository(store, user, row.repository_id); else superAdmin(user);
  if (path === `/api/models/${id}/provider` && method === 'PATCH') {
    fields(body, ['versions','api_url','api_key','revoke_key','model_names']);
    if (body.revoke_key !== undefined && body.revoke_key !== true) fail(400,'invalid_revoke');
    if (body.revoke_key && (body.api_key !== undefined || body.api_url !== undefined || body.model_names !== undefined)) fail(400,'conflicting_credentials');
    const endpoint = body.api_url === undefined ? row.api_url : apiUrl(body.api_url);
    const key = body.api_key === undefined || typeof body.api_key === 'string' && !body.api_key.trim() ? null : text(body.api_key,32768);
    const names = body.model_names === undefined ? [] : modelNames(body.model_names);
    return store.transaction(() => {
      const members = providerModels(store,row), versions = body.versions;
      // Membership and every version form one snapshot: concurrent additions, deletion or key rotation must not be lost.
      if (!Array.isArray(versions) || versions.length !== members.length || members.some(model => !versions.some(v => v && typeof v === 'object' && (v as Json).id === model.id && (v as Json).version === model.version))) fail(409,'version_conflict');
      const ids = new Set(members.map(model => model.id));
      if (providerModels(store,{...row,api_url:endpoint}).some(model => !ids.has(model.id))) fail(409,'provider_already_exists');
      if (names.some(name => members.some(model => model.model_name === name))) fail(409,'model_already_exists');
      const source = members.find(model => model.api_key !== null);
      const addKey = key || (source ? String(store.secrets.open(source.api_key,`model:${source.id}`).value || '') : '');
      if (names.length && !addKey) fail(409,'model_key_missing');
      const now = new Date().toISOString();
      for (const model of members) {
        const sealed = body.revoke_key ? null : key ? store.secrets.seal({value:key},`model:${model.id}`) : model.api_key;
        store.run('UPDATE models SET api_url=?,api_key=?,version=version+1,updated_at=? WHERE id=?',endpoint,sealed,now,model.id);
      }
      const added = names.map(name => createModel(store,row.repository_id,endpoint,addKey,name));
      store.audit(user.id,body.revoke_key?'model.provider_key_revoked':'model.provider_updated',id,row.repository_id);
      return {models:[...members.map(model => store.get('SELECT * FROM models WHERE id=?',model.id)!),...added].map(model => publicModel(store,model))};
    });
  }
  if (path === `/api/models/${id}` && method === 'DELETE') {
    fields(body, []);
    return store.transaction(() => {
      const cleared = store.all('SELECT repository_id FROM policies WHERE model_id=? ORDER BY repository_id', id);
      // Clear the default foreign key. Keep task overrides as unavailable references (fail closed),
      // rather than silently moving those tasks to a potentially different/default provider.
      store.run('UPDATE policies SET model_id=NULL WHERE model_id=?', id);
      store.run('DELETE FROM model_pricing WHERE model_id=?', id);
      store.run('DELETE FROM model_projects WHERE model_id=?', id);
      // The wizard's default shared model is a settings pointer, not a foreign key: it must not outlive the model.
      store.run("DELETE FROM settings WHERE key='onboarding.model' AND json_valid(value) AND json_extract(value,'$')=?", id);
      store.run('DELETE FROM models WHERE id=?', id);
      store.audit(user.id, 'model.deleted', id, row.repository_id);
      return { ok: true, cleared_repository_ids: cleared.map(row => row.repository_id) };
    });
  }
  if (path === `/api/models/${id}` && method === 'PATCH') {
    fields(body, ['api_url', 'api_key', 'model_name', 'version', 'pricing']);
    if (body.version !== row.version) fail(409, 'version_conflict');
    const endpoint = body.api_url === undefined ? row.api_url : apiUrl(body.api_url);
    const model = body.model_name === undefined ? row.model_name : text(body.model_name);
    const pricing=body.pricing===undefined?undefined:validatePricing(body.pricing);
    const key = body.api_key === undefined || typeof body.api_key === 'string' && !body.api_key.trim() ? row.api_key : store.secrets.seal({ value: text(body.api_key, 32768) }, `model:${id}`);
    return store.transaction(() => {
      const changed = store.run('UPDATE models SET api_url=?,model_name=?,api_key=?,version=version+1,updated_at=? WHERE id=? AND version=?', endpoint, model, key, new Date().toISOString(), id, row.version);
      if (!changed.changes) fail(409, 'version_conflict');
      if(pricing!==undefined)savePricing(store,id,pricing);
      store.audit(user.id, 'model.updated', id, row.repository_id);
      return { model: publicModel(store,store.get('SELECT * FROM models WHERE id=?', id)!) };
    });
  }
  // Draft connection tests reuse the saved key under the same edit authorization, without writing configuration.
  if ([`/api/models/${id}/upstream`, `/api/models/${id}/test`].includes(path) && method === 'POST') {
    const test = path.endsWith('/test');
    fields(body, ['api_url','api_key','version', ...(test ? ['model_name'] : [])]);
    if (test && Object.keys(body).length && body.version === undefined) fail(400,'model_version_required');
    if (body.version !== undefined && body.version !== row.version) fail(409,'version_conflict');
    const key = typeof body.api_key === 'string' && body.api_key.trim() ? text(body.api_key,32768) : row.api_key === null ? '' : String(store.secrets.open(row.api_key, `model:${id}`).value || '');
    if (!key) return fail(409, 'model_key_missing');
    // A URL saved before the query/fragment rule is checked again rather than probed as written.
    const endpoint = apiUrl(body.api_url !== undefined ? body.api_url : row.api_url);
    store.audit(user.id, test ? 'model.tested' : 'model.upstream_listed', id, row.repository_id);
    return test ? testUpstreamModel(endpoint, key, body.model_name === undefined ? row.model_name : text(body.model_name)) : listUpstreamModels(endpoint, key);
  }
  if (path === `/api/models/${id}/credentials/revoke` && method === 'POST') {
    fields(body, []);
    return store.transaction(() => {
      store.run('UPDATE models SET api_key=NULL,version=version+1,updated_at=? WHERE id=?', new Date().toISOString(), id);
      store.audit(user.id, 'model.key_revoked', id, row.repository_id);
      return { model: publicModel(store,store.get('SELECT * FROM models WHERE id=?', id)!) };
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
