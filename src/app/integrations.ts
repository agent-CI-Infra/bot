import { superAdmin, type Actor } from './auth.js';
import { fail, fields, text, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import type { IntegrationChecker } from '../projects/integrations.js';

/** Connection status of installed repositories; the check is read-only and cached. */
export async function integrationsApi(store: Store, checker: IntegrationChecker, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
  if (!url.pathname.startsWith('/api/integrations')) return undefined;
  superAdmin(user);
  if (method === 'GET' && url.pathname === '/api/integrations') return { integrations: checker.cached() };
  if (method === 'POST' && url.pathname === '/api/integrations/check') {
    fields(input, ['repository_id']);
    const ids = input.repository_id ? [text(input.repository_id)]
      : store.all('SELECT repository_id FROM installed_repositories WHERE installed=1 ORDER BY full_name').map(row => String(row.repository_id)).slice(0, 30);
    for (let index = 0; index < ids.length; index += 4) await Promise.all(ids.slice(index, index + 4).map(id => checker.check(id)));
    return { integrations: checker.cached() };
  }
  return fail(404, 'not_found');
}
