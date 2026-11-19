import type { Row, Store } from '../storage/database.js';
import { roleConfiguration } from '../roles/definition.js';

// A board or inbox page may mix projects. Resolve names from each visible task's effective project
// configuration once per project, without sending the configuration itself to the browser.
export function taskOriginsForDisplay(store: Store, taskIds: string[], includeParent = false) {
  const origins = new Map<string, Row>();
  if (!taskIds.length) return origins;
  const rows = store.all(`SELECT o.task_id, t.repository_id, o.source_kind, o.source_role, o.executor_role,
    o.conversation_id, o.source_message${includeParent ? ', o.source_task_id' : ''}
    FROM task_origins o JOIN tasks t ON t.id=o.task_id WHERE o.task_id IN (${taskIds.map(() => '?').join(',')})`, ...taskIds);
  const projectNames = new Map<string, Map<string, string>>();
  for (const { task_id, repository_id, ...origin } of rows) {
    let names = projectNames.get(repository_id);
    if (!names && (origin.source_role || origin.executor_role)) {
      names = new Map(roleConfiguration(store, repository_id).roles.map(role => [role.role_id, role.name || role.role_id]));
      projectNames.set(repository_id, names);
    }
    origins.set(task_id, { ...origin, source_role_name: names?.get(origin.source_role) ?? origin.source_role,
      executor_role_name: names?.get(origin.executor_role) ?? origin.executor_role });
  }
  return origins;
}
