import type { Store, Row } from '../storage/database.js';
import { installationExecutionDenied } from '../installations/archive.js';

export const validRepository = (full: string) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(full) && !full.split('/').some(p => p === '.' || p === '..');
export function boardLocation(origin: string, full: string) {
  const key = full.toLowerCase();
  return { key, url: `${origin.replace(/\/$/, '')}/boards/${key}/` };
}
export function publicOrigin(store: Store): string {
  const row = store.get("SELECT value FROM settings WHERE key='onboarding.public'");
  return row ? String(JSON.parse(row.value).origin || '') : '';
}
/** Saved publication choices persist; only repositories without a choice use visibility defaults. */
export function publishedRepositories(store: Store): Row[] {
  const rows = store.all(`SELECT i.*,j.active_path,j.generation,j.collected_generation FROM installed_repositories i
    LEFT JOIN public_board_jobs j ON j.account_id=i.account_id AND j.repository_id=i.repository_id
    LEFT JOIN public_board_settings s ON s.repository_id=i.repository_id
    WHERE i.installed=1 AND (s.enabled=1 OR (s.repository_id IS NULL AND i.private=0))
    ORDER BY i.full_name,i.account_id`).filter(row => validRepository(String(row.full_name)) && !installationExecutionDenied(store, String(row.account_id), String(row.repository_id)));
  // Multiple App accounts can cover the same GitHub repository; publish one dataset per repository.
  return [...new Map(rows.reverse().map(row => [String(row.repository_id), row])).values()].reverse();
}
/** Live publication state, independent of project activation and cached integration checks. */
export function boardStatus(store: Store, repositoryId: string) {
  const row = publishedRepositories(store).find(repo => String(repo.repository_id) === repositoryId);
  const origin = publicOrigin(store);
  return { enabled: !!row, state: !row ? 'off' : row.active_path ? 'published' : 'collecting',
    url: row && origin ? boardLocation(origin, String(row.full_name)).url : null };
}
export function queueBoard(store: Store, accountId: string, repositoryId: string): void {
  store.run(`INSERT INTO public_board_jobs(account_id,repository_id,generation) VALUES(?,?,1)
    ON CONFLICT(account_id,repository_id) DO UPDATE SET generation=generation+1,next_attempt=0`, accountId, repositoryId);
}
/** Called inside the verified delivery's transaction, including for installed but inactive repositories. */
export function boardWebhook(store: Store, accountId: string, event: string, payload: Record<string, any>): void {
  const repo = payload.repository;
  if (!repo || event === 'ping') return;
  const installed = store.get('SELECT * FROM installed_repositories WHERE account_id=? AND repository_id=? AND installed=1', accountId, String(repo.id || ''));
  if (!installed) return;
  // Visibility changes take effect before a response or a new public read can see the old snapshot.
  if (typeof repo.private === 'boolean') store.run('UPDATE installed_repositories SET private=? WHERE repository_id=?', Number(repo.private), installed.repository_id);
  if (publishedRepositories(store).some(row => row.account_id === accountId && row.repository_id === installed.repository_id)) queueBoard(store, accountId, String(installed.repository_id));
}
