import type { Store, Row } from '../storage/database.js';
import { stop } from '../agent/common.js';
import { builtinWorkflow, workflowAccess, triggerOptions, triggers as catalog, type WorkflowPermissions } from './catalog.js';

// The workflow a task belongs to: a custom workflow's id, or the built-in task kind.
export const taskWorkflow = (task: { kind: string; workflow_id?: string | null }) => String(task.workflow_id || task.kind);
export const savedWorkflow = (store: Store, repositoryId: string, id: string): Row | undefined =>
  store.get('SELECT * FROM workflows WHERE repository_id=? AND id=?', repositoryId, id);

/**
 * What a task's agent may do, decided on every task from the workflow's type: reading is open, writing follows the type.
 * Permissions saved before reading was opened up are ignored. A deleted custom workflow runs nothing.
 */
export function workflowPermissions(store: Store, repositoryId: string, id: string): WorkflowPermissions {
  if (!builtinWorkflow(id) && !savedWorkflow(store, repositoryId, id)) return stop('workflow_not_found', 'cancelled', `工作流 ${id} 已删除。`);
  return workflowAccess(id);
}
export interface CustomWorkflow { id: string; name: string; enabled: boolean; prompt: string; triggers: { id: string; label?: string }[]; model_id: string | null }
export function customWorkflow(row: Row): CustomWorkflow {
  let saved: any = []; try { saved = JSON.parse(row.triggers || '[]'); } catch { saved = []; }
  return { id: String(row.id), name: String(row.name), enabled: !!row.enabled, prompt: String(row.prompt ?? ''), model_id: row.model_id ? String(row.model_id) : null,
    triggers: Array.isArray(saved) ? saved.filter((trigger: any) => trigger && typeof trigger.id === 'string') : [] };
}
export const customWorkflows = (store: Store, repositoryId: string): CustomWorkflow[] =>
  store.all("SELECT * FROM workflows WHERE repository_id=? AND id LIKE 'custom.%' ORDER BY created_at,id", repositoryId).map(customWorkflow);

export interface Trigger { id: string; label?: string }
const parse = (text: unknown): Trigger[] | null => {
  if (text == null) return null;
  try { const value = JSON.parse(String(text)); return Array.isArray(value) ? value.filter((t: any) => t && typeof t.id === 'string') : null; } catch { return null; }
};
// The review switches of the policy, read the way they always were (Issue updates and mentions need Issue reviews on, PR
// discussion and mentions need PR reviews on), for a review workflow nobody has given its own trigger list yet.
function policyTriggers(id: string, policy: Row | undefined): Trigger[] {
  const on = (key: string) => !!policy?.[key];
  if (id === 'review.issue') return [...(on('review_issues') ? [{ id: 'issue.opened' }, { id: 'comment.mention' }] : []), ...(on('review_issues') && on('review_issue_updates') ? [{ id: 'issue.updated' }] : [])];
  if (id === 'review.pr') return [...(on('review_pull_requests') ? [{ id: 'pull_request.opened' }, { id: 'comment.mention' }] : []), ...(on('review_pr_updates') ? [{ id: 'pull_request.synchronize' }] : []),
    ...(on('review_pull_requests') && on('review_pr_discussion') ? [{ id: 'pull_request.updated' }] : [])];
  // Other built-in workflows start with every trigger they can have, except the label triggers that need a label.
  return triggerOptions(id).filter(trigger => id.startsWith('development.') || !catalog.find(entry => entry.id === trigger)?.label).map(trigger => ({ id: trigger }));
}
/** A workflow's trigger list: its own saved list, or for a built-in workflow without one, the policy switches. */
export function workflowTriggers(store: Store, repositoryId: string, id: string): Trigger[] {
  const row = savedWorkflow(store, repositoryId, id), allowed = new Set(triggerOptions(id));
  const saved = builtinWorkflow(id) ? parse(row?.trigger_list) : parse(row?.triggers);
  return (saved ?? policyTriggers(id, store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId))).filter(trigger => allowed.has(trigger.id));
}
/** The workflow's own switch. Actions failure handling keeps its policy switch; other built-in workflows default to on. */
export function workflowEnabled(store: Store, repositoryId: string, id: string): boolean {
  if (id === 'actions.failures') return !!store.get('SELECT actions_failures_enabled FROM policies WHERE repository_id=?', repositoryId)?.actions_failures_enabled;
  const row = savedWorkflow(store, repositoryId, id);
  return builtinWorkflow(id) ? row ? !!row.enabled : true : !!row?.enabled;
}
/** Runs now: the project is on, its review or development switch is on for those workflows, and the workflow is on. */
export function workflowActive(store: Store, repositoryId: string, id: string): boolean {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  if (!policy?.enabled || !workflowEnabled(store, repositoryId, id)) return false;
  if (id.startsWith('review.')) return !!policy.review_enabled;
  if (id.startsWith('development.')) return !!policy.development_enabled;
  return true;
}
/** The active workflow's trigger with this id (and label, for label triggers), or undefined. */
export function activeTrigger(store: Store, repositoryId: string, id: string, trigger: string, label?: string): Trigger | undefined {
  if (!workflowActive(store, repositoryId, id)) return undefined;
  return workflowTriggers(store, repositoryId, id).find(entry => entry.id === trigger && (label === undefined || !entry.label || entry.label.toLowerCase() === label.toLowerCase()));
}
// The review switches of the policy mirror the matching triggers of the review workflows, for the policy API.
export const policyColumns: Record<string, Record<string, string>> = {
  'review.issue': { 'issue.opened': 'review_issues', 'issue.updated': 'review_issue_updates' },
  'review.pr': { 'pull_request.opened': 'review_pull_requests', 'pull_request.synchronize': 'review_pr_updates', 'pull_request.updated': 'review_pr_discussion' }
};
/** A policy PATCH of a review switch adds or removes the matching trigger of a review workflow that has its own list. */
export function syncPolicyTriggers(store: Store, repositoryId: string, changes: Record<string, unknown>) {
  for (const [id, columns] of Object.entries(policyColumns)) {
    const row = store.get('SELECT trigger_list FROM workflows WHERE repository_id=? AND id=?', repositoryId, id);
    if (row?.trigger_list == null) continue;
    let list: Trigger[] = parse(row.trigger_list) ?? [];
    for (const [trigger, column] of Object.entries(columns)) if (changes[column] !== undefined)
      list = changes[column] ? (list.some(entry => entry.id === trigger) ? list : [...list, { id: trigger }]) : list.filter(entry => entry.id !== trigger);
    store.run('UPDATE workflows SET trigger_list=? WHERE repository_id=? AND id=?', JSON.stringify(list), repositoryId, id);
  }
}
