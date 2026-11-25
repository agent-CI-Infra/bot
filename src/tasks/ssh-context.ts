import { sshAccess, type SshGrantPayload } from '../projects/ssh-access.js';
import { taskCheckoutContext } from '../roles/run.js';
import type { Row, Store } from '../storage/database.js';

/**
 * The SSH context of a command the control plane runs for a task on its project computer (#1379): the project's test
 * command before a pull request, after an integration and in the independent QA gate. The run is the task's current
 * claim; trust is the task's checkout as decided when it started, and role is the role the check serves. The grant ends
 * with the command; a cancel or a new claim refuses SSH even before that.
 */
export async function withTaskSsh<T>(store: Store, task: Row, role: string, use: (ssh: SshGrantPayload | undefined) => Promise<T>): Promise<T> {
  const start = store.get('SELECT claim_token,attempt FROM tasks WHERE id=?', task.id);
  const grant = start ? sshAccess.issue({
    store, repository: String(task.repository_id), task: String(task.id), role, trusted: taskCheckoutContext(store, task).trustedCheckout,
    live: () => {
      const now = store.get('SELECT status,claim_token,attempt FROM tasks WHERE id=?', task.id);
      return now?.status === 'running' && now.claim_token === start.claim_token && now.attempt === start.attempt;
    },
  }) : null;
  try { return await use(grant?.payload); } finally { grant?.close(); }
}
