import { type Store } from '../storage/database.js';
import { type Actor, superAdmin } from './auth.js';
import { fail, fields, type Json } from '../core/security.js';

// Tasks one project computer runs at the same time: a global default, optionally overridden per project.
export const concurrencyBounds = [1, 32] as const;
const concurrencyKey = 'tasks.concurrency';
export function concurrencyValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < concurrencyBounds[0] || (value as number) > concurrencyBounds[1]) return fail(400, 'invalid_task_concurrency');
  return value as number;
}
export function defaultConcurrency(store: Store): number {
  const value = Number(store.get('SELECT value FROM settings WHERE key=?', concurrencyKey)?.value);
  return Number.isSafeInteger(value) && value >= concurrencyBounds[0] && value <= concurrencyBounds[1] ? value : 1;
}
export function repositoryConcurrency(store: Store, repositoryId: string): number {
  const own = store.get('SELECT task_concurrency FROM policies WHERE repository_id=?', repositoryId)?.task_concurrency;
  return own == null ? defaultConcurrency(store) : Number(own);
}
// The image tag the control plane runs, from BOT_IMAGE_TAG; empty means it runs from a source checkout.
export function runningVersion(imageTag: string | undefined): Json {
  const tag = String(imageTag || '').trim().slice(0, 128);
  return tag ? { image_tag: tag, source: 'image' } : { image_tag: null, source: 'source' };
}
export function settingsApi(store: Store, user: Actor, method: string, path: string, input: Json, imageTag?: string): Json | undefined {
  if (path !== '/api/settings' && path !== '/api/version') return undefined;
  superAdmin(user);
  if (path === '/api/version') return method === 'GET' ? runningVersion(imageTag) : undefined;
  const view = () => ({ settings: { task_concurrency: defaultConcurrency(store), task_concurrency_bounds: [...concurrencyBounds] }, version: runningVersion(imageTag) });
  if (method === 'GET') return view();
  if (method !== 'PATCH') return undefined;
  fields(input, ['task_concurrency']);
  const value = concurrencyValue(input.task_concurrency);
  store.transaction(() => {
    store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', concurrencyKey, String(value));
    store.audit(user.id, 'settings.updated', concurrencyKey);
  });
  return view();
}
