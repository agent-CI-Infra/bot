import type { Row, Store } from '../storage/database.js';
import { fail } from '../core/security.js';
import { modelEndpoints } from './endpoints.js';
import { modelInterfaceTypes, type ModelInterfaceType } from './catalog.js';

// A provider is the models of one scope (one project, or the shared ones) saved under the same name (#1332). Its URL and
// key are still stored on every member and updated together; its interface is every member's manual interface_type.
const nameLimit = 100;

export function providerName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > nameLimit || /[\x00-\x1f\x7f]/.test(value)) return fail(400, 'invalid_provider_name');
  return value.trim();
}
/** The provider interface a form sends: null is "auto" (keep inferring per model), otherwise one manual interface. */
export function providerInterface(value: unknown): ModelInterfaceType | null {
  if (value === null || value === 'auto') return null;
  if (typeof value === 'string' && modelInterfaceTypes.includes(value as ModelInterfaceType)) return value as ModelInterfaceType;
  return fail(400, 'invalid_model_interface');
}
export function providerMembers(store: Store, repo: string | null, name: string | null): Row[] {
  return store.all('SELECT * FROM models WHERE repository_id IS ? AND provider_name IS ?', repo, name);
}
/** Names compare without case, so "DeepSeek" and "deepseek" cannot be two providers of one scope. */
export function providerNameTaken(store: Store, repo: string | null, name: string, own: string | null = null): boolean {
  return !!store.get('SELECT 1 FROM models WHERE repository_id IS ? AND lower(provider_name)=lower(?) AND provider_name IS NOT ?', repo, name, own);
}
/** The address host, with -2, -3 … when the scope already has that name: what an unnamed provider is called. */
export function defaultProviderName(store: Store, repo: string | null, apiUrl: string): string {
  let host = 'provider'; try { host = new URL(apiUrl).host || host; } catch { /* Saved URLs were validated on write. */ }
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : '-' + n, name = host.slice(0, nameLimit - suffix.length) + suffix;
    if (!providerNameTaken(store, repo, name)) return name;
  }
}
export function saveProviderInterface(store: Store, modelId: string, interfaceType: ModelInterfaceType | null): void {
  store.run(`INSERT INTO model_catalog_overrides(model_id,interface_type) VALUES(?,?)
    ON CONFLICT(model_id) DO UPDATE SET interface_type=excluded.interface_type`, modelId, interfaceType);
}

/**
 * Adds models.provider_name and names every unnamed model. Before #1332 a provider was the models of one scope with the
 * same request address, so each such group gets one name and stays one provider. A group whose members were given
 * different manual interfaces through the API is split by interface, so every provider has exactly one interface and
 * no model changes the protocol it uses. Groups are named in address order, so the same data always gets the same names.
 */
export function providerStorage(store: Store): void {
  const unnamed = () => store.get('SELECT 1 FROM models WHERE provider_name IS NULL LIMIT 1');
  const column = () => store.all('PRAGMA table_info(models)').some(c => c.name === 'provider_name');
  if (column() && !unnamed()) return;
  store.transaction(() => {
    if (!column()) store.db.exec('ALTER TABLE models ADD COLUMN provider_name TEXT');
    const groups = new Map<string, { repo: string | null; url: string; ids: string[] }>();
    for (const row of store.all(`SELECT m.id,m.repository_id,m.api_url,o.interface_type FROM models m
      LEFT JOIN model_catalog_overrides o ON o.model_id=m.id WHERE m.provider_name IS NULL`)) {
      const manual = modelInterfaceTypes.includes(row.interface_type) ? row.interface_type : '';
      const key = JSON.stringify([row.repository_id, modelEndpoints(String(row.api_url)).chat_url, manual]);
      if (!groups.has(key)) groups.set(key, { repo: row.repository_id, url: String(row.api_url), ids: [] });
      groups.get(key)!.ids.push(String(row.id));
    }
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key)!, name = defaultProviderName(store, group.repo, group.url);
      for (const id of group.ids) store.run('UPDATE models SET provider_name=? WHERE id=?', name, id);
    }
  });
}
