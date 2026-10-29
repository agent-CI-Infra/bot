import { superAdmin, type Actor } from './auth.js';
import { fail, fields, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import { deleteProjectRecords } from '../projects/removal.js';
import { quickstartItems, type Item, type Quickstart } from '../projects/quickstart.js';

/**
 * Removes a project's control-plane state only. GitHub is never called: the repository and the App installation stay as
 * they are, and a later installation sync can list the repository again like a new one. A pending environment operation or
 * an active public-configuration run would still write after the rows are gone, so the delete waits for those to finish.
 */
export function deleteProject(store: Store, user: Actor, id: string): Json {
  return store.transaction(() => {
    if (!store.get('SELECT 1 FROM repositories WHERE id=?', id)) return fail(404, 'repository_not_found');
    const busy = store.get("SELECT 1 FROM environment_operations WHERE repository_id=? AND state='pending'", id)
      || store.get("SELECT 1 FROM quickstart_runs WHERE repository_id=? AND state IN ('queued','running')", id);
    if (busy) return fail(409, 'project_account_pending');
    // Children before parents; the audit outlives the repository and is written in the same transaction.
    deleteProjectRecords(store, id);
    store.audit(user.id, 'repository.deleted', id, id);
    return { deleted: true };
  });
}

/** Start and inspect one-click onboarding runs; `steps` picks the items to execute (all of them by default). */
export async function quickstartApi(store: Store, quickstart: Quickstart | undefined, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
  const project = /^\/api\/projects\/([1-9]\d*)$/.exec(url.pathname);
  if (project) {
    superAdmin(user);
    if (method !== 'DELETE') return fail(404, 'not_found');
    fields(input, ['confirm']);
    return deleteProject(store, user, project[1]!);
  }
  const runs = /^\/api\/projects\/([1-9]\d*)\/quickstart$/.exec(url.pathname);
  if (runs) {
    superAdmin(user);
    if (!quickstart) return fail(404, 'not_found');
    if (method === 'POST') {
      fields(input, ['dry_run', 'steps']);
      const steps = input.steps === undefined ? [...quickstartItems] : input.steps;
      if (!Array.isArray(steps) || !steps.length || steps.some(item => !quickstartItems.includes(item as Item))) return fail(400, 'invalid_quickstart_steps');
      return { run: quickstart.start(runs[1]!, input.dry_run === true, steps as Item[]) };
    }
    if (method === 'GET') return { run: quickstart.latest(runs[1]!), items: quickstart.items(runs[1]!) };
    return fail(404, 'not_found');
  }
  const run = /^\/api\/quickstart\/([a-f0-9]{48})$/.exec(url.pathname);
  if (run) {
    superAdmin(user);
    if (!quickstart) return fail(404, 'not_found');
    if (method !== 'GET') return fail(404, 'not_found');
    const value = quickstart.get(run[1]!);
    if (!value) return fail(404, 'quickstart_not_found');
    return { run: value };
  }
  return undefined;
}
