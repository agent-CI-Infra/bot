import type { Store, Row } from '../storage/database.js';
import { fail, fields, object, randomId, text, type Json } from '../core/security.js';
import { stop } from '../agent/common.js';
import { openModel } from '../agent/model.js';
import { permissionItems, fullPermissions, normalizePermissions, updatePermissions, validPermissionInput, type RolePermissions } from '../roles/permissions.js';

// Service roles are platform-level assistants (the console/personal management assistant, group chat assistants). They are
// not bound to one project: their model comes from the shared models, their usage is billed to the role, not a project.
// Project work roles (Manager, Dev, QA ...) stay in each project's role configuration.
export const managementAssistant = 'management-assistant';
export const repositoryAssistant = 'repository-assistant';

const now = () => new Date().toISOString();
export const serviceItems = permissionItems;
export const repositoryAssistantPermissions: RolePermissions = normalizePermissions({ github: 'read' });
const builtins = [
  { id: managementAssistant, name: '管理助手', permissions: fullPermissions(),
    responsibility: '控制台管理对话和个人私聊使用的助手。使用统一权限机制，固定允许全部已接入能力，实际操作仍受当前用户有效授权和项目范围约束。' },
  { id: repositoryAssistant, name: '仓库问答助手', permissions: repositoryAssistantPermissions,
    responsibility: '群聊默认推荐的助手：查询 GitHub Issue 和 PR、解释代码仓，不给工作角色派活。' },
];

export function serviceRoleStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS service_roles(id TEXT PRIMARY KEY,builtin INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,responsibility TEXT NOT NULL DEFAULT '',prompt TEXT NOT NULL DEFAULT '',model_id TEXT,permissions TEXT,budget TEXT,
    revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  // Built-in roles are written once and then belong to the administrator; a restart never overwrites their edits.
  // A deployment that already chose a default shared model in the wizard starts them with it.
  const model = defaultSharedModel(store), time = now();
  for (const role of builtins) store.run(`INSERT OR IGNORE INTO service_roles(id,builtin,enabled,name,responsibility,prompt,model_id,permissions,budget,revision,created_at,updated_at)
    VALUES(?,1,1,?,?,'',?,?,NULL,1,?,?)`, role.id, role.name, role.responsibility, model, role.permissions ? JSON.stringify(role.permissions) : null, time, time);
  const old = store.get('SELECT permissions FROM service_roles WHERE id=?',managementAssistant);
  if (old && !old.permissions) {
    store.run('UPDATE service_roles SET permissions=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(fullPermissions()),now(),managementAssistant);
    store.audit('system','service_role.permissions_migrated',managementAssistant);
  }
}
function defaultSharedModel(store: Store): string | null {
  const id = store.get("SELECT json_extract(value,'$') id FROM settings WHERE key='onboarding.model' AND json_valid(value)")?.id;
  return typeof id === 'string' && store.get('SELECT 1 FROM models WHERE id=? AND repository_id IS NULL', id) ? id : null;
}
/** Choosing the wizard's default shared model also gives it to built-in roles that have none yet; a chosen model is kept. */
export function adoptDefaultModel(store: Store, modelId: string, userId: string): void {
  for (const row of store.all('SELECT id FROM service_roles WHERE builtin=1 AND model_id IS NULL')) {
    store.run('UPDATE service_roles SET model_id=?,revision=revision+1,updated_at=? WHERE id=? AND model_id IS NULL', modelId, now(), row.id);
    store.audit(userId, 'service_role.model_adopted', row.id);
  }
}
/** A deleted shared model leaves the roles that used it without a model; they wait for configuration instead of switching. */
export function releaseModel(store: Store, modelId: string, userId: string): void {
  for (const row of store.all('SELECT id FROM service_roles WHERE model_id=?', modelId)) {
    store.run('UPDATE service_roles SET model_id=NULL,revision=revision+1,updated_at=? WHERE id=?', now(), row.id);
    store.audit(userId, 'service_role.model_cleared', row.id);
  }
}

export function serviceRole(store: Store, id: string): Row | undefined {
  const row=store.get('SELECT * FROM service_roles WHERE id=?', id);
  return row ? {...row,permissions:JSON.stringify(id===managementAssistant?fullPermissions():normalizePermissions(JSON.parse(row.permissions??'{}'),true))} : undefined;
}
/** The role's own shared model, opened for one run. Without one the run stops; it never borrows a project's model. */
export function serviceRoleModel(store: Store, id: string) {
  const role = serviceRole(store, id);
  if (!role?.enabled) return stop('service_role_unavailable', 'waiting_configuration', `服务角色 ${id} 不存在或已停用。`);
  const row = role.model_id ? store.get('SELECT * FROM models WHERE id=? AND repository_id IS NULL', role.model_id) : undefined;
  if (!row?.api_key) return stop('service_role_model_not_configured', 'waiting_configuration', `服务角色「${role.name}」尚未配置可用的共享模型，请超级管理员在「全局设置 → 服务角色」中选择；不会改用其他模型。`);
  return openModel(store, row);
}
export function serviceRoleUsage(store: Store, id: string): Json {
  const total = store.get(`SELECT count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(cached_input_tokens) cached_input_tokens,
    sum(CASE WHEN finished_at IS NULL OR input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) usage_missing_requests,
    sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced_requests,max(requested_at) last_requested_at FROM model_requests WHERE service_role_id=?`, id)!;
  const costs = store.all('SELECT currency,sum(cost) amount FROM model_requests WHERE service_role_id=? AND cost IS NOT NULL GROUP BY currency ORDER BY currency', id);
  return { requests: total.requests, input_tokens: total.input_tokens, output_tokens: total.output_tokens, cached_input_tokens: total.cached_input_tokens,
    usage_missing_requests: total.usage_missing_requests ?? 0, unpriced_requests: total.unpriced_requests ?? 0, last_requested_at: total.last_requested_at, costs };
}
export function serviceRoleView(store: Store, row: Row): Json {
  const model = row.model_id ? store.get('SELECT id,model_name,api_url,api_key FROM models WHERE id=? AND repository_id IS NULL', row.model_id) : undefined;
  return { id: row.id, builtin: !!row.builtin, enabled: !!row.enabled, name: row.name, responsibility: row.responsibility, prompt: row.prompt,
    model_id: row.model_id, model: model ? { id: model.id, model_name: model.model_name, api_url: model.api_url, key_configured: !!model.api_key } : null,
    permissions: row.id===managementAssistant?fullPermissions():normalizePermissions(JSON.parse(row.permissions??'{}'),true), permissions_inherited: false, permissions_fixed: row.id===managementAssistant,
    revision: row.revision, created_at: row.created_at, updated_at: row.updated_at, usage: serviceRoleUsage(store, row.id) };
}

function optionalText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return fail(400, 'invalid_field');
  return value.trim();
}
function permissionsInput(value: unknown, base: RolePermissions): RolePermissions {
  const given = object(value);
  for (const [key,mode] of Object.entries(given)) if (!validPermissionInput(key,mode,base)) fail(400,'invalid_service_role_permission','permissions.'+key);
  return updatePermissions(base,given as RolePermissions,true);
}
function sharedModel(store: Store, value: unknown): string | null {
  if (value === null) return null;
  const id = text(value, 128);
  if (!store.get('SELECT 1 FROM models WHERE id=? AND repository_id IS NULL', id)) fail(400, 'shared_model_required', 'model_id');
  return id;
}
// Accept legacy budget payloads for older clients; definition ignores them and clears the stored value.
const editable = ['name', 'responsibility', 'prompt', 'model_id', 'permissions', 'budget', 'enabled'];
/** Field values for an insert or update; `current` is the stored row when editing. */
function definition(store: Store, input: Json, current?: Row) {
  const builtin = !!current?.builtin, fixed = current?.id === managementAssistant;
  if (input.permissions !== undefined && fixed) {
    const given=object(input.permissions),full=fullPermissions();
    if(Object.keys(given).length!==Object.keys(full).length||Object.entries(full).some(([key,mode])=>given[key]!==mode))fail(400,'service_role_permissions_fixed','permissions');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail(400, 'invalid_field', 'enabled');
  if (builtin && input.enabled === false) fail(409, 'builtin_service_role_required', 'enabled');
  const base = current?.permissions ? normalizePermissions(JSON.parse(current.permissions),true) : repositoryAssistantPermissions;
  return {
    name: input.name !== undefined ? text(input.name, 80) : current?.name ?? fail(400, 'invalid_field', 'name'),
    responsibility: input.responsibility !== undefined ? optionalText(input.responsibility, 2000) : current?.responsibility ?? '',
    prompt: input.prompt !== undefined ? optionalText(input.prompt, 32000) : current?.prompt ?? '',
    model_id: input.model_id !== undefined ? sharedModel(store, input.model_id) : current?.model_id ?? null,
    permissions: JSON.stringify(fixed?fullPermissions():input.permissions !== undefined ? permissionsInput(input.permissions,base):base),
    budget: null,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : current?.enabled ?? 1,
  };
}
function revisionOf(input: Json): number {
  if (!Number.isSafeInteger(input.expected_revision)) fail(400, 'expected_revision_required', 'expected_revision');
  return input.expected_revision as number;
}

/** Super administrators maintain service roles; every change checks the expected revision and leaves an audit record. */
export function createServiceRole(store: Store, userId: string, input: Json): Json {
  fields(input, editable);
  const id = 'custom-' + randomId().slice(0, 12), value = definition(store, input), time = now();
  store.transaction(() => {
    store.run(`INSERT INTO service_roles(id,builtin,enabled,name,responsibility,prompt,model_id,permissions,budget,revision,created_at,updated_at)
      VALUES(?,0,?,?,?,?,?,?,?,1,?,?)`, id, value.enabled, value.name, value.responsibility, value.prompt, value.model_id, value.permissions, value.budget, time, time);
    store.audit(userId, 'service_role.created', id);
  });
  return serviceRoleView(store, serviceRole(store, id)!);
}
export function updateServiceRole(store: Store, userId: string, id: string, input: Json): Json {
  fields(input, [...editable, 'expected_revision']);
  const expected = revisionOf(input);
  return store.transaction(() => {
    const current = serviceRole(store, id);
    if (!current) return fail(404, 'service_role_not_found');
    if (current.revision !== expected) return fail(409, 'service_role_revision_conflict', 'expected_revision');
    const value = definition(store, input, current);
    store.run(`UPDATE service_roles SET name=?,responsibility=?,prompt=?,model_id=?,permissions=?,budget=?,enabled=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=?`, value.name, value.responsibility, value.prompt, value.model_id, value.permissions, value.budget, value.enabled, now(), id, expected);
    store.audit(userId, 'service_role.updated', id);
    return serviceRoleView(store, serviceRole(store, id)!);
  });
}
export function deleteServiceRole(store: Store, userId: string, id: string, input: Json): Json {
  fields(input, ['expected_revision']);
  const expected = revisionOf(input);
  return store.transaction(() => {
    const current = serviceRole(store, id);
    if (!current) return fail(404, 'service_role_not_found');
    if (current.builtin) return fail(409, 'builtin_service_role_required');
    if (current.revision !== expected) return fail(409, 'service_role_revision_conflict', 'expected_revision');
    // A group still bound to the role would lose its assistant silently; the maintainer rebinds or disables it first.
    if (store.get('SELECT 1 FROM channel_service_bindings WHERE service_role_id=? AND enabled=1', id)) return fail(409, 'service_role_in_use');
    // The usage ledger keeps service_role_id: past requests stay attributed to the deleted role.
    store.run('DELETE FROM service_roles WHERE id=?', id);
    store.audit(userId, 'service_role.deleted', id);
    return { ok: true, id };
  });
}
export function listServiceRoles(store: Store): Json {
  // Built-in roles first, then custom roles in creation order.
  const rows = store.all('SELECT * FROM service_roles ORDER BY builtin DESC,CASE id WHEN ? THEN 0 ELSE 1 END,created_at,id', managementAssistant);
  return { service_roles: rows.map(row => serviceRoleView(store, row)), permission_items: serviceItems };
}
