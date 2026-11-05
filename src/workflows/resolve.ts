import type { Store, Row } from '../storage/database.js';
import { stop } from '../agent/common.js';
import { builtinWorkflow, clampPermissions, customCeiling, defaultPermissions, type WorkflowPermissions } from './catalog.js';

// The workflow a task belongs to: a custom workflow's id, or the built-in task kind.
export const taskWorkflow = (task: { kind: string; workflow_id?: string | null }) => String(task.workflow_id || task.kind);
export const savedWorkflow = (store: Store, repositoryId: string, id: string): Row | undefined =>
  store.get('SELECT * FROM workflows WHERE repository_id=? AND id=?', repositoryId, id);

/** The saved permissions of a workflow, clamped to its ceiling; read from trusted storage on every task. */
export function workflowPermissions(store: Store, repositoryId: string, id: string): WorkflowPermissions {
  const builtin = builtinWorkflow(id), row = savedWorkflow(store, repositoryId, id);
  if (!builtin && !row) return stop('workflow_not_found', 'cancelled', `工作流 ${id} 已删除。`);
  if (!row?.permissions) return defaultPermissions(id);
  try { return clampPermissions(JSON.parse(row.permissions), builtin?.ceiling ?? customCeiling); }
  catch { return stop('workflow_permissions_invalid', 'waiting_configuration', `工作流 ${id} 的权限配置无效，请在「工作流」页重新保存。`); }
}
export interface CustomWorkflow { id: string; name: string; enabled: boolean; prompt: string; triggers: { id: string; label?: string }[]; model_id: string | null }
export function customWorkflow(row: Row): CustomWorkflow {
  let saved: any = []; try { saved = JSON.parse(row.triggers || '[]'); } catch { saved = []; }
  return { id: String(row.id), name: String(row.name), enabled: !!row.enabled, prompt: String(row.prompt ?? ''), model_id: row.model_id ? String(row.model_id) : null,
    triggers: Array.isArray(saved) ? saved.filter((trigger: any) => trigger && typeof trigger.id === 'string') : [] };
}
export const customWorkflows = (store: Store, repositoryId: string): CustomWorkflow[] =>
  store.all("SELECT * FROM workflows WHERE repository_id=? AND id LIKE 'custom.%' ORDER BY created_at,id", repositoryId).map(customWorkflow);
