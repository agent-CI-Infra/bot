import type { Store, Row } from '../storage/database.js';
import type { Redactor } from '../agent/common.js';
import { githubWrite } from '../github/write.js';
import { githubWriteAllowed } from '../roles/permissions.js';
import { taskActingRole, taskRolePolicies } from './management.js';

/**
 * github_write for a task (#381): the task's repository only, keys unique per task (so a retried attempt never writes twice),
 * allowed while every policy over the acting role allows the route's resource: the role itself, the source roles that
 * delegated the task and a group binding's service role. A role never lends a write it does not hold.
 */
export function taskGithubWrite(store: Store, task: Row, redactor: Redactor, guard: () => Promise<void>, apiUrl?: string) {
  return (args: unknown) => {
    const repository = store.get('SELECT * FROM repositories WHERE id=?', task.repository_id)!;
    return githubWrite({ store, repository, redactor, guard, apiUrl, scope: 'task:' + task.id,
      actor: { kind: 'task', role: taskActingRole(store, task), task_id: String(task.id) },
      allowed: (resource, operation) => taskRolePolicies(store, task).every(policy => githubWriteAllowed(policy, resource, operation)) }, args);
  };
}
