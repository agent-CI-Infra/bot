import { readdirSync } from 'node:fs';
import { type Store } from '../storage/database.js';

// A committed deletion removes the rows first and deletes the notes volume afterwards, best effort (#753, #758). When
// the manager cannot delete the volume the API has already answered 200, so the volume has to be reclaimed later and
// must not stay invisible until then: this module finds such volumes on the manager, retries them with a bounded
// backoff, reports the ones that stay behind with their age, and clears stale notes before a repository is reconnected.

export const notesRemovalFailed = 'repository.notes_removal_failed';
export const notesVolumeReclaimed = 'repository.notes_volume_reclaimed';
export const notesRemovalAbandoned = 'repository.notes_removal_abandoned';

export interface NotesOrphan { repository_id: string; name: string; first_failed_at: string | null; node_id?: string }
export interface OrphanTrajectory { repository_id: string; path: string }
export interface NotesVolumes { notesVolumes(): Promise<{ name: string; repository_id: string; created_at: string | null; node_id?: string }[]> ; reclaimNotes(id: string, waitMs?: number, nodeId?: string): Promise<void> }

/**
 * Deletions whose notes volume was never deleted: the failed-removal audit that no *later* reclaim audit answers.
 * The comparison is on timestamps, not on existence: a repository connected again, deleted again and failed again has a
 * new intent even though an older reclaim answered the previous one (#771).
 */
export function notesOrphanIntents(store: Store): { repository_id: string; first_failed_at: string }[] {
  return store.all(`SELECT f.repository_id repository_id, max(f.created_at) first_failed_at FROM audit f
    WHERE f.action=? AND f.repository_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.action=? AND r.repository_id=f.repository_id AND r.created_at >= f.created_at)
    GROUP BY f.repository_id ORDER BY first_failed_at, f.repository_id`, notesRemovalFailed, notesVolumeReclaimed)
    .map(row => ({ repository_id: String(row.repository_id), first_failed_at: String(row.first_failed_at) }));
}

/**
 * Volumes on the manager whose repository id no row claims. The manager names them `dbot-<deployment>-<repo>-notes`, so
 * a volume stays findable after every row that referred to it is gone.
 */
export async function orphanNotesVolumes(store: Store, projects: NotesVolumes): Promise<NotesOrphan[]> {
  const intents = new Map(notesOrphanIntents(store).map(orphan => [orphan.repository_id, orphan.first_failed_at]));
  const known = new Set(store.all('SELECT id FROM repositories').map(row => String(row.id)));
  const volumes = await projects.notesVolumes();
  const byRepo = new Map<string, { repository_id: string; name: string; first_failed_at: string | null; node_id?: string }>();
  for (const volume of volumes) {
    const repository_id = volume.repository_id || /-(\d+)-notes$/.exec(volume.name)?.[1] || '';
    if (!repository_id || known.has(repository_id)) continue;
    const nodeId = typeof volume.node_id === 'string' && volume.node_id ? volume.node_id : undefined;
    const key = nodeId ? `${nodeId}:${repository_id}` : repository_id;
    byRepo.set(key, {
      repository_id,
      name: volume.name,
      first_failed_at: intents.get(repository_id) ?? volume.created_at,
      ...(nodeId ? { node_id: nodeId } : {}),
    });
  }
  // An intent without a volume is already gone (a retry finished without recording it, or the volume never existed).
  return [...byRepo.values()]
    .sort((a, b) => (a.first_failed_at ?? '').localeCompare(b.first_failed_at ?? '') || a.repository_id.localeCompare(b.repository_id) || (a.node_id ?? '').localeCompare(b.node_id ?? ''));
}

/**
 * The orphan list of a surface that has to answer while the manager is unreachable. A failed read keeps the durable
 * intents in its place and says so, so the maintenance listing and the readiness report name the same orphans instead
 * of one of them turning into a 503, and a caller can still tell an empty list from an unreadable one (#808).
 */
export async function listNotesOrphans(store: Store, projects: NotesVolumes | undefined): Promise<{ orphans: NotesOrphan[]; unreadable: boolean }> {
  const intents = () => notesOrphanIntents(store).map(intent => ({ ...intent, name: '' }));
  if (!projects) return { orphans: intents(), unreadable: false };
  try { return { orphans: await orphanNotesVolumes(store, projects), unreadable: false }; }
  catch { return { orphans: intents(), unreadable: true }; }
}

/** Trajectory directories under this deployment's disk that no repository row claims. */
export function orphanTrajectoryDirectories(store: Store): OrphanTrajectory[] {
  const known = new Set(store.all('SELECT id FROM repositories').map(row => String(row.id)));
  // The root also holds the content-addressed blob store and the tool-result files, which are not per-project.
  const reserved = new Set(['.blobs', 'sha256', 'results', 'tmp', 'conversations']);
  return readdirSync(store.trajectories.root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !reserved.has(entry.name) && !known.has(entry.name))
    .map(entry => ({ repository_id: entry.name, path: store.trajectories.root + '/' + entry.name }))
    .sort((a, b) => a.repository_id.localeCompare(b.repository_id));
}

export interface ReclaimReport {
  orphans: number; threshold: number; oldest_seconds: number | null; max_age_seconds: number; warn_age_seconds: number;
  retrying: number; abandoned: number; trajectory_orphans: number; over_threshold: boolean; over_age: boolean;
}

export interface ReclaimOptions {
  /** Attempts before an orphan is left to the aging alert instead of being retried forever. */
  maxAttempts?: number;
  /** First retry delay; each further attempt doubles it, up to maxDelayMs. */
  baseDelayMs?: number; maxDelayMs?: number;
  now?: () => number;
}

interface Attempt { attempts: number; nextAt: number; abandoned: boolean }

/**
 * Reclaims the notes volumes a committed deletion could not delete. The manager call is name-based and idempotent, so a
 * retry still works after the project row is gone, and a retry that finds nothing also closes the intent.
 */
export class NotesReclaimer {
  private readonly attempts = new Map<string, Attempt>();
  constructor(private readonly store: Store, private readonly projects: NotesVolumes, private readonly options: ReclaimOptions = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private get maxAttempts(): number { return this.options.maxAttempts ?? 6; }
  private delay(attempts: number): number {
    return Math.min((this.options.baseDelayMs ?? 60_000) * 2 ** Math.min(attempts - 1, 8), this.options.maxDelayMs ?? 3600_000);
  }

  /** One reconciliation pass. Returns the volumes that are still unreclaimed afterwards. */
  async sweep(): Promise<NotesOrphan[]> {
    const now = this.now();
    for (const orphan of await orphanNotesVolumes(this.store, this.projects)) {
      const attemptKey = orphan.node_id ? `${orphan.node_id}:${orphan.repository_id}` : orphan.repository_id;
      const state = this.attempts.get(attemptKey) ?? { attempts: 0, nextAt: 0, abandoned: false };
      this.attempts.set(attemptKey, state);
      if (state.abandoned || now < state.nextAt) continue;
      try {
        await this.projects.reclaimNotes(orphan.repository_id, undefined, orphan.node_id);
      } catch (error) {
        state.attempts += 1; state.nextAt = now + this.delay(state.attempts);
        if (state.attempts >= this.maxAttempts) {
          state.abandoned = true;
          this.store.audit('system', notesRemovalAbandoned, orphan.repository_id, orphan.repository_id);
          console.error(`[reclaim] notes volume ${orphan.repository_id} left after ${state.attempts} attempts:`, error);
        }
        continue;
      }
      // The intent is closed only after the manager answered; the audit row is what the readiness check counts.
      this.store.audit('system', notesVolumeReclaimed, orphan.repository_id, orphan.repository_id);
      this.attempts.delete(attemptKey);
    }
    return orphanNotesVolumes(this.store, this.projects);
  }

  /** Counts and ages for the health surface; a provider failure reports the durable intents instead of hiding them. */
  async report(threshold = 10, maxAgeMs = 7 * 24 * 3600_000, warnAgeMs = 24 * 3600_000, now = this.now()): Promise<ReclaimReport> {
    const orphans = (await listNotesOrphans(this.store, this.projects)).orphans;
    const ages = orphans.map(orphan => orphan.first_failed_at).filter((value): value is string => !!value)
      .map(value => Date.parse(value)).filter(value => Number.isFinite(value));
    const oldest = ages.length ? Math.max(0, Math.round((now - Math.min(...ages)) / 1000)) : null;
    const abandoned = [...this.attempts.values()].filter(state => state.abandoned).length;
    const retrying = [...this.attempts.values()].filter(state => !state.abandoned).length;
    return {
      orphans: orphans.length, threshold, oldest_seconds: oldest, max_age_seconds: Math.round(maxAgeMs / 1000),
      warn_age_seconds: Math.round(warnAgeMs / 1000), retrying, abandoned, trajectory_orphans: orphanTrajectoryDirectories(this.store).length,
      over_threshold: orphans.length > threshold, over_age: oldest !== null && oldest * 1000 > maxAgeMs,
    };
  }
}
