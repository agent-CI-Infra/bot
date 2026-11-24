import {addColumns,operationRefColumns} from '../storage/trajectories.js';
import type { Store, Row } from '../storage/database.js';
import { modelServes } from '../models/sharing.js';
import { fail, fields, object, randomId, text, type Json } from '../core/security.js';
import { stop } from '../agent/common.js';
import { openModel } from '../agent/model.js';
import { permissionItems, fullPermissions, normalizePermissions, type RolePermissions } from '../roles/permissions.js';
import { releaseConsolidationModels } from '../memory/consolidation-storage.js';

// Platform assistant outside project work: the console/personal management assistant (#1249).
// Group chat assistants now store their model, prompt and harness directly on each group binding (channel_service_bindings);
// legacy rows in service_roles are preserved read-only so upgraded bindings keep their authorization fence and historical usage.
// Project work roles (Manager, Dev, QA ...) stay in each project's role configuration.
export const managementAssistant = 'management-assistant';
export const repositoryAssistant = 'repository-assistant';
export const groupAssistant = 'group-assistant';
export const defaultGroupAssistantPrompt = '查询 GitHub Issue 和 PR、解释代码仓；能否写入和派活由本群的权限配置决定。';

const now = () => new Date().toISOString();
/** The backends a service assistant may run on: only Pi (#1337), for the management assistant and every group binding. A
 * request naming another backend is refused; the field is still accepted with `pi` so older clients can save. */
export const serviceHarnesses: readonly string[] = ['pi'];
export const serviceItems = permissionItems;
/** What the repository assistant granted before #849; bindings migrated from it read as the read level. */
export const repositoryAssistantPermissions: RolePermissions = normalizePermissions({ github: 'read' });
const managementBuiltin = {
  id: managementAssistant,
  name: '管理助手',
  permissions: fullPermissions(),
  responsibility: '控制台管理对话和个人私聊使用的助手。使用统一权限机制，固定允许全部已接入能力，实际操作仍受当前用户有效授权和项目范围约束。',
};
const migratedRepositoryResponsibility = '群聊默认推荐的助手：查询 GitHub Issue 和 PR、解释代码仓；能否写入和派活由本群的权限档位决定。';
// The responsibility the repository assistant was seeded with before #849. It reaches the system prompt, so a group at the
// dispatch level would be told never to delegate; an administrator's own wording is kept.
const retiredResponsibility = '群聊默认推荐的助手：查询 GitHub Issue 和 PR、解释代码仓，不给工作角色派活。';

export function serviceRoleStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS service_roles(id TEXT PRIMARY KEY,builtin INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,responsibility TEXT NOT NULL DEFAULT '',prompt TEXT NOT NULL DEFAULT '',model_id TEXT,permissions TEXT,budget TEXT,
    revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS service_harness_sessions(id TEXT PRIMARY KEY,service_role_id TEXT NOT NULL,turn_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS service_harness_turn ON service_harness_sessions(turn_id);CREATE TABLE IF NOT EXISTS service_harness_events(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES service_harness_sessions(id),type TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS service_role_operations(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT,state TEXT NOT NULL);`);
  addColumns(store.db,'service_role_operations',operationRefColumns);
  // Pi is the default backend (#1255); a database from before it moves its Native roles over once (src/roles/native-to-pi.ts).
  if(!store.all('PRAGMA table_info(service_roles)').some(c=>c.name==='harness'))store.db.exec("ALTER TABLE service_roles ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi'");
  // The project column is kept for existing pre-#1249 rows.
  if (!store.all('PRAGMA table_info(service_roles)').some(c => c.name === 'project_id')) store.db.exec('ALTER TABLE service_roles ADD COLUMN project_id TEXT');
  const model = defaultSharedModel(store), time = now();
  // Built-in management assistant is written once and then belongs to the administrator; a restart never overwrites edits.
  store.run(`INSERT OR IGNORE INTO service_roles(id,builtin,enabled,name,responsibility,prompt,model_id,permissions,budget,harness,revision,created_at,updated_at)
    VALUES(?,1,1,?,?,'',?,?,NULL,'pi',1,?,?)`, managementBuiltin.id, managementBuiltin.name, managementBuiltin.responsibility, model, JSON.stringify(managementBuiltin.permissions), time, time);
  if (store.run('UPDATE service_roles SET responsibility=?,revision=revision+1,updated_at=? WHERE id=? AND responsibility=?', migratedRepositoryResponsibility, time, repositoryAssistant, retiredResponsibility).changes)
    store.audit('system', 'service_role.responsibility_migrated', repositoryAssistant);
  const old = store.get('SELECT permissions FROM service_roles WHERE id=?',managementAssistant);
  if (old && !old.permissions) {
    store.run('UPDATE service_roles SET permissions=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(fullPermissions()),now(),managementAssistant);
    store.audit('system','service_role.permissions_migrated',managementAssistant);
  }
}
export function defaultSharedModel(store: Store): string | null {
  const id = store.get("SELECT json_extract(value,'$') id FROM settings WHERE key='onboarding.model' AND json_valid(value)")?.id;
  return typeof id === 'string' && store.get('SELECT 1 FROM models WHERE id=? AND repository_id IS NULL', id) ? id : null;
}
/** Choosing the wizard's default shared model also gives it to the management assistant if it has none yet; a chosen model is kept. */
export function adoptDefaultModel(store: Store, modelId: string, userId: string): void {
  if (store.run('UPDATE service_roles SET model_id=?,revision=revision+1,updated_at=? WHERE id=? AND model_id IS NULL', modelId, now(), managementAssistant).changes) {
    store.audit(userId, 'service_role.model_adopted', managementAssistant);
  }
}
/** A deleted model leaves the management assistant and any group bindings that used it without a model; they wait for configuration instead of switching. */
export function releaseModel(store: Store, modelId: string, userId: string): void {
  for (const row of store.all('SELECT id FROM service_roles WHERE model_id=?', modelId)) {
    store.run('UPDATE service_roles SET model_id=NULL,revision=revision+1,updated_at=? WHERE id=?', now(), row.id);
    store.audit(userId, 'service_role.model_cleared', row.id);
  }
  if (store.hasTable('channel_service_bindings') && store.all('PRAGMA table_info(channel_service_bindings)').some(c => c.name === 'model_id')) {
    const time = Date.now();
    for (const row of store.all('SELECT id FROM channel_service_bindings WHERE model_id=?', modelId)) {
      store.run('UPDATE channel_service_bindings SET model_id=NULL,revision=revision+1,updated_at=? WHERE id=?', time, row.id);
      store.audit(userId, 'channel.service_binding.model_cleared', row.id);
    }
  }
  releaseConsolidationModels(store, [modelId], userId);
}

export function serviceRole(store: Store, id: string): Row | undefined {
  const row=store.get('SELECT * FROM service_roles WHERE id=?', id);
  return row ? {...row,permissions:JSON.stringify(id===managementAssistant?fullPermissions():normalizePermissions(JSON.parse(row.permissions??'{}'),true))} : undefined;
}
/** Whether a model serves a project (see models/sharing.ts): the group model rule reads it for every project in scope. */
export { modelServes };
/** The projects (id and full name) among `projects` a model may not serve, in their order. */
export function modelGaps(store: Store, modelId: string, projects: string[]): { id: string; full_name: string }[] {
  const model = store.get('SELECT * FROM models WHERE id=?', modelId);
  return projects.filter(project => !model || !modelServes(store, model, project))
    .map(id => ({ id, full_name: String(store.get('SELECT full_name FROM repositories WHERE id=?', id)?.full_name ?? id) }));
}
/** A group binding's model for one turn (#1249): the model stored on the binding, available to every project in the group's scope.
 * When it is not configured or not authorized, the turn stops naming the projects; it never switches to another model. */
export function groupBindingModel(store: Store, binding: Row, projects: string[]) {
  const row = binding.model_id ? store.get('SELECT * FROM models WHERE id=?', binding.model_id) : undefined;
  if (!row?.api_key) return stop('channel_service_model_not_configured', 'waiting_configuration', '本群聊助手尚未配置可用的模型，请维护人在控制台「个人设置 → 飞书绑定」为本群选择模型；不会改用其他模型。');
  const gaps = modelGaps(store, row.id, projects);
  if (gaps.length) return stop('channel_service_model_unavailable', 'waiting_configuration', `模型「${row.model_name}」没有授权给 ${gaps.map(p => p.full_name).join('、')}；不会改用其他模型。`);
  return openModel(store, row);
}
/** The management assistant's own shared model, opened for one run. Without one the run stops; it never borrows a project's model. */
export function serviceRoleModel(store: Store, id: string) {
  const role = serviceRole(store, id);
  if (!role?.enabled) return stop('service_role_unavailable', 'waiting_configuration', `管理助手 ${id} 不存在或已停用。`);
  const row = role.model_id ? store.get('SELECT * FROM models WHERE id=? AND repository_id IS NULL', role.model_id) : undefined;
  if (!row?.api_key) return stop('service_role_model_not_configured', 'waiting_configuration', `管理助手「${role.name}」尚未配置可用的共享模型，请超级管理员在「全局设置 → 管理助手」中选择；不会改用其他模型。`);
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
  const model = row.model_id ? store.get('SELECT id,provider_name,model_name,api_url,api_key,repository_id FROM models WHERE id=?', row.model_id) : undefined;
  return { id: row.id, builtin: !!row.builtin, enabled: !!row.enabled, name: row.name, responsibility: row.responsibility, prompt: row.prompt,
    harness: row.harness??'pi',
    project: row.project_id ? { id: row.project_id, full_name: store.get('SELECT full_name FROM repositories WHERE id=?', row.project_id)?.full_name ?? row.project_id } : null,
    model_id: row.model_id, model: model ? { id: model.id, provider_name: model.provider_name ?? null, model_name: model.model_name, api_url: model.api_url, key_configured: !!model.api_key, project_id: model.repository_id ?? null } : null,
    ...(row.id === managementAssistant ? { permissions: fullPermissions() } : {}), permissions_fixed: row.id===managementAssistant,
    revision: row.revision, created_at: row.created_at, updated_at: row.updated_at, usage: serviceRoleUsage(store, row.id) };
}

function optionalText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return fail(400, 'invalid_field');
  return value.trim();
}
/** A global template uses a shared model; a project's role may also use that project's own model or a shared one it is
 * authorized to. */
function roleModel(store: Store, value: unknown, project: string | null): string | null {
  if (value === null) return null;
  const id = text(value, 128), model = store.get('SELECT * FROM models WHERE id=?', id);
  if (!project) { if (model?.repository_id !== null) fail(400, 'shared_model_required', 'model_id'); }
  else if (!model || !modelServes(store, model, project)) fail(400, 'project_model_required', 'model_id');
  return id;
}
// Accept legacy budget payloads for older clients; definition ignores them and clears the stored value.
const editable = ['name', 'responsibility', 'prompt', 'model_id', 'permissions', 'budget', 'enabled', 'harness'];
/** Field values for an insert or update; `current` is the stored row when editing. */
function definition(store: Store, input: Json, current?: Row, project?: string | null) {
  if(input.harness!==undefined&&!serviceHarnesses.includes(String(input.harness)))fail(400,'unknown_role_harness','harness');
  const builtin = !!current?.builtin, fixed = current?.id === managementAssistant;
  if (input.permissions !== undefined && fixed) {
    const given=object(input.permissions),full=fullPermissions();
    if(Object.keys(given).length!==Object.keys(full).length||Object.entries(full).some(([key,mode])=>given[key]!==mode))fail(400,'service_role_permissions_fixed','permissions');
  }
  // A group's permissions are set on its binding; a role edit can no longer change what any group may do.
  if (input.permissions !== undefined && !fixed) fail(400, 'service_role_permissions_moved', 'permissions');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail(400, 'invalid_field', 'enabled');
  if (builtin && input.enabled === false) fail(409, 'builtin_service_role_required', 'enabled');
  return {
    name: input.name !== undefined ? text(input.name, 80) : current?.name ?? fail(400, 'invalid_field', 'name'),
    responsibility: input.responsibility !== undefined ? optionalText(input.responsibility, 2000) : current?.responsibility ?? '',
    prompt: input.prompt !== undefined ? optionalText(input.prompt, 32000) : current?.prompt ?? '',
    model_id: input.model_id !== undefined ? roleModel(store, input.model_id, current ? current.project_id ?? null : project ?? null) : current?.model_id ?? null,
    // Kept as they were: only bindings migrated before #849 read them, once. New roles carry none.
    permissions: fixed ? JSON.stringify(fullPermissions()) : current ? store.get('SELECT permissions FROM service_roles WHERE id=?', current.id)?.permissions ?? null : null,
    harness: input.harness??current?.harness??'pi',
    budget: null,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : current?.enabled ?? 1,
  };
}
function revisionOf(input: Json): number {
  if (!Number.isSafeInteger(input.expected_revision)) fail(400, 'expected_revision_required', 'expected_revision');
  return input.expected_revision as number;
}

/** Super administrators maintain the global templates, project administrators the roles of their projects (the caller checks
 * who); every change checks the expected revision and leaves an audit record. A role's project never changes. */
export function createServiceRole(store: Store, userId: string, input: Json, project: string | null = null): Json {
  fields(input, [...editable, 'project_id']);
  const id = 'custom-' + randomId().slice(0, 12), value = definition(store, input, undefined, project), time = now();
  store.transaction(() => {
    store.run(`INSERT INTO service_roles(id,builtin,enabled,name,responsibility,prompt,model_id,permissions,budget,revision,created_at,updated_at,project_id)
      VALUES(?,0,?,?,?,?,?,?,?,1,?,?,?)`, id, value.enabled, value.name, value.responsibility, value.prompt, value.model_id, value.permissions, value.budget, time, time, project);
    store.audit(userId, 'service_role.created', id, project);
    store.run('UPDATE service_roles SET harness=? WHERE id=?',value.harness,id);
  });
  return serviceRoleView(store, serviceRole(store, id)!);
}
/** `modelCheck` refuses a new model a group bound to the role could not use (#849); it runs inside the transaction. */
export function updateServiceRole(store: Store, userId: string, id: string, input: Json, modelCheck?: (role: Row, model: string) => void): Json {
  fields(input, [...editable, 'expected_revision']);
  const expected = revisionOf(input);
  return store.transaction(() => {
    const current = serviceRole(store, id);
    if (!current) return fail(404, 'service_role_not_found');
    if (current.revision !== expected) return fail(409, 'service_role_revision_conflict', 'expected_revision');
    const value = definition(store, input, current);
    if (value.model_id && value.model_id !== current.model_id) modelCheck?.(current, value.model_id);
    store.run(`UPDATE service_roles SET name=?,responsibility=?,prompt=?,model_id=?,permissions=?,budget=?,enabled=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=?`, value.name, value.responsibility, value.prompt, value.model_id, value.permissions, value.budget, value.enabled, now(), id, expected);
    store.audit(userId, 'service_role.updated', id, current.project_id ?? null);
    store.run('UPDATE service_roles SET harness=? WHERE id=?',value.harness,id);
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
    store.audit(userId, 'service_role.deleted', id, current.project_id ?? null);
    return { ok: true, id };
  });
}
/** Only the singleton platform management assistant is exposed here (#1249); group assistants live on channel_service_bindings. */
export function listServiceRoles(store: Store): Json {
  const rows = store.all('SELECT * FROM service_roles WHERE id=?', managementAssistant);
  return { service_roles: rows.map(row => serviceRoleView(store, row)), permission_items: serviceItems };
}
