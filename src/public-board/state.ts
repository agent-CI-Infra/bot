import type { Store, Row } from '../storage/database.js';
import { installationExecutionDenied } from '../installations/archive.js';

export const DEFAULT_BOARD_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_BOARD_RECONCILE_MS = 24 * 60 * 60_000;
export const MIN_BOARD_RECONCILE_MS = 60_000;
export type BoardScope = 'repo' | 'issues' | 'pulls' | 'contributors' | 'releases' | 'ci' | 'reviews' | 'all';
const validScopes = new Set<BoardScope>(['repo', 'issues', 'pulls', 'contributors', 'releases', 'ci', 'reviews', 'all']);

export interface PublicBoardRuntimeOptions {
  cooldownMs?: number;
  reconcileMs?: number;
  now?: () => number;
}

export interface QueueBoardOptions {
  scopes?: readonly BoardScope[];
  immediate?: boolean;
  cooldownMs?: number;
  now?: number;
}

const runtimeOptions = new WeakMap<Store, PublicBoardRuntimeOptions>();

export function configurePublicBoard(store: Store, options: PublicBoardRuntimeOptions): void {
  const prev = runtimeOptions.get(store) ?? {};
  runtimeOptions.set(store, { ...prev, ...options });
}

export function resolveBoardCooldownMs(store?: Store, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const configured = store ? runtimeOptions.get(store)?.cooldownMs : undefined;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  const envRaw = process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS?.trim();
  if (envRaw !== undefined && envRaw !== '') {
    const parsed = /^\d+$/.test(envRaw) ? Number(envRaw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`BOT_PUBLIC_BOARD_COOLDOWN_MS must be an integer >= 0, got ${JSON.stringify(process.env.BOT_PUBLIC_BOARD_COOLDOWN_MS)}`);
    }
    return parsed;
  }
  return DEFAULT_BOARD_COOLDOWN_MS;
}

export function resolveBoardReconcileMs(store?: Store, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const configured = store ? runtimeOptions.get(store)?.reconcileMs : undefined;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  const envRaw = process.env.BOT_PUBLIC_BOARD_RECONCILE_MS?.trim();
  if (envRaw !== undefined && envRaw !== '') {
    const parsed = /^\d+$/.test(envRaw) ? Number(envRaw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0 || (parsed > 0 && parsed < MIN_BOARD_RECONCILE_MS)) {
      throw new Error(`BOT_PUBLIC_BOARD_RECONCILE_MS must be 0 or an integer >= ${MIN_BOARD_RECONCILE_MS}, got ${JSON.stringify(process.env.BOT_PUBLIC_BOARD_RECONCILE_MS)}`);
    }
    return parsed;
  }
  return DEFAULT_BOARD_RECONCILE_MS;
}

export function resolveBoardNow(store?: Store, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  const clock = store ? runtimeOptions.get(store)?.now : undefined;
  return clock ? clock() : Date.now();
}

export function parseBoardScopes(raw: unknown): BoardScope[] {
  if (typeof raw !== 'string' || !raw.trim()) return ['all'];
  const parsed = raw.split(',').map(part => part.trim() as BoardScope).filter(part => validScopes.has(part));
  if (!parsed.length || parsed.includes('all')) return ['all'];
  return [...new Set(parsed)].sort();
}

export function mergeBoardScopes(existing: unknown, incoming: readonly BoardScope[] | undefined, pending: boolean): string {
  const next = (incoming ?? []).filter(scope => validScopes.has(scope));
  if (!next.length || next.includes('all')) return 'all';
  if (!pending) return [...new Set(next)].sort().join(',');
  if (typeof existing !== 'string' || !existing.trim()) return 'all';
  const prev = parseBoardScopes(existing);
  if (prev.includes('all')) return 'all';
  return [...new Set([...prev, ...next])].sort().join(',');
}

/**
 * Maps a GitHub webhook to the public-board domains it affects, or null for noise events
 * (such as ping, status, check_run, check_suite, workflow_job and deployment events) that
 * neither the single-repository board nor the multi-repository dashboard consumes.
 */
export function classifyBoardWebhook(event: string, payload: Record<string, any>): BoardScope[] | null {
  const action = typeof payload.action === 'string' ? payload.action : '';
  switch (event) {
    case 'issues':
      return ['issues'];
    case 'label':
      return ['issues', 'pulls'];
    case 'issue_comment':
      if (action && action !== 'created' && action !== 'deleted') return null;
      return payload.issue?.pull_request ? ['issues', 'pulls'] : ['issues'];
    case 'pull_request':
      return action === 'closed' && payload.pull_request?.merged ? ['pulls', 'contributors'] : ['pulls'];
    case 'pull_request_review':
      if (action && action !== 'submitted' && action !== 'dismissed') return null;
      return ['reviews'];
    case 'workflow_run':
      if (action && action !== 'completed') return null;
      return ['ci'];
    case 'release':
      return ['releases'];
    case 'push':
      return ['repo', 'contributors'];
    case 'repository':
    case 'public':
    case 'star':
    case 'watch':
    case 'fork':
      return ['repo'];
    default:
      return null;
  }
}

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
  const rows = store.all(`SELECT i.*,j.active_path,j.generation,j.collected_generation,j.redaction_fingerprint FROM installed_repositories i
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
export function queueBoard(store: Store, accountId: string, repositoryId: string, options: QueueBoardOptions = {}): void {
  const cooldownMs = resolveBoardCooldownMs(store, options.cooldownMs);
  const now = resolveBoardNow(store, options.now);
  const existing = store.get(
    `SELECT generation,collected_generation,active_path,next_attempt,last_collected_at,last_error,dirty_scopes
     FROM public_board_jobs WHERE account_id=? AND repository_id=?`,
    accountId, repositoryId,
  );
  if (!existing) {
    const scopes = mergeBoardScopes('', options.scopes, false);
    store.run(
      `INSERT INTO public_board_jobs(account_id,repository_id,generation,next_attempt,dirty_scopes) VALUES(?,?,1,0,?)`,
      accountId, repositoryId, scopes,
    );
    return;
  }
  const pending = Number(existing.generation) > Number(existing.collected_generation);
  const scopes = mergeBoardScopes(existing.dirty_scopes, options.scopes, pending);
  let nextAttempt = 0;
  if (!options.immediate && cooldownMs > 0) {
    const existingNext = Number(existing.next_attempt) || 0;
    if (!existing.active_path) {
      // First collection runs immediately unless it already failed and is waiting in backoff.
      nextAttempt = existing.last_error && existingNext > now ? existingNext : 0;
    } else {
      const lastCollected = Number(existing.last_collected_at) || 0;
      const cooldownUntil = lastCollected > 0 ? lastCollected + cooldownMs : 0;
      const candidate = Math.max(cooldownUntil, existingNext > now ? existingNext : 0);
      nextAttempt = candidate > now ? candidate : 0;
    }
  }
  store.run(
    `UPDATE public_board_jobs SET generation=generation+1,next_attempt=?,dirty_scopes=? WHERE account_id=? AND repository_id=?`,
    nextAttempt, scopes, accountId, repositoryId,
  );
}
/** Called inside the verified delivery's transaction, including for installed but inactive repositories. */
export function boardWebhook(store: Store, accountId: string, event: string, payload: Record<string, any>, options: QueueBoardOptions = {}): void {
  const repo = payload.repository;
  if (!repo || event === 'ping') return;
  const installed = store.get('SELECT * FROM installed_repositories WHERE account_id=? AND repository_id=? AND installed=1', accountId, String(repo.id || ''));
  if (!installed) return;
  // Visibility changes take effect before a response or a new public read can see the old snapshot.
  const becamePublic = typeof repo.private === 'boolean' && Boolean(installed.private) && !repo.private;
  if (typeof repo.private === 'boolean') store.run('UPDATE installed_repositories SET private=? WHERE repository_id=?', Number(repo.private), installed.repository_id);
  const scopes = classifyBoardWebhook(event, payload) ?? (becamePublic ? ['all'] : null);
  if (!scopes) return;
  if (publishedRepositories(store).some(row => row.account_id === accountId && row.repository_id === installed.repository_id)) {
    queueBoard(store, accountId, String(installed.repository_id), { ...options, scopes });
  }
}
