export { publicText, registeredRedactor as actionsRedactor } from '../core/redaction.js';
import type { Store } from '../storage/database.js';
import { covers, projectCeiling } from '../projects/ceiling.js';

// Configuration errors that stop Actions failure handling until an App manager or installation owner acts.
export const actionsConfigurationErrors = ['actions_permission_missing', 'actions_workflow_run_subscription_missing'];
/**
 * The first missing piece of the installation's Actions setup, or null. workflow_run is a webhook event subscription
 * (GitHub's "Workflow run"), not the Workflows permission: GitHub offers it only to an App with at least Actions read, so
 * an installation without Actions access is reported as such rather than as a missing subscription it cannot have.
 */
export function actionsConfigurationError(github: { installationPermissions: Record<string, string> | null; installationEvents: string[] | null }) {
  if (github.installationPermissions && !github.installationPermissions.actions) return 'actions_permission_missing';
  if (!github.installationEvents?.includes('workflow_run')) return 'actions_workflow_run_subscription_missing';
  return null;
}

// Revisions of a bot PR retain the original Issue's feature and approval boundary.
export function actionsSourceIssue(store: Store, task: { repository_id: string; kind: string; object_number: number; input?: string }): number | null {
  if (task.kind.endsWith('.issue')) return store.get('SELECT number FROM actions_failure_issues WHERE repository_id=? AND number=?', task.repository_id, task.object_number)?.number ?? null;
  if (task.kind === 'task.request' && task.object_number != null) {
    try {
      const target = typeof task.input === 'string' ? JSON.parse(task.input)?.target : null;
      if (target?.type === 'issue') return store.get('SELECT number FROM actions_failure_issues WHERE repository_id=? AND number=?', task.repository_id, task.object_number)?.number ?? null;
    } catch { /* ignore */ }
  }
  return store.get(`SELECT a.number FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
    JOIN actions_failure_issues a ON a.repository_id=t.repository_id AND a.number=t.object_number
    WHERE p.repository_id=? AND p.number=? AND (t.kind='development.issue' OR (t.kind='task.request' AND json_extract(t.input,'$.target.type')='issue'))`, task.repository_id, task.object_number)?.number ?? null;
}

/**
 * An Issue filed from an Actions failure is developed like any other the Manager judges (#1104): its classification, structure,
 * review conclusion and assignees are facts for the Manager, not gates. What stays are the project's switches: the project is
 * enabled, Actions failure handling is on, and the capability ceiling allows development.
 */
export const actionsReport = (store: Store, id: string, number: number) => !!store.get('SELECT 1 FROM actions_failure_issues WHERE repository_id=? AND number=?', id, number);
export function actionsDevelopmentAllowed(store: Store, id: string, number: number, _issue?: any, _result?: any) {
  if (!actionsReport(store, id, number)) return true;
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', id);
  return !!policy?.enabled && !!policy.actions_failures_enabled && covers(projectCeiling(store, id, policy), 'develop');
}
