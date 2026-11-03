import { superAdmin, type Actor } from './auth.js';
import { fail, fields, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import { quickstartItems, type Item, type Quickstart } from '../projects/quickstart.js';

/** Start and inspect one-click onboarding runs; `steps` picks the items to execute (all of them by default). */
export async function quickstartApi(store: Store, quickstart: Quickstart | undefined, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
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
