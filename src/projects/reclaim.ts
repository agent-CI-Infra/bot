import { readdirSync } from 'node:fs';
import { type Store } from '../storage/database.js';

// A committed deletion removes the rows first and deletes the notes volume afterwards, best effort (#753, #758). When
// the manager cannot delete the volume the API has already answered 200, so the volume has to be reclaimed later and
// must not stay invisible until then: this module finds such volumes on the manager, retries them with a bounded
// backoff, reports the ones that stay behind with their age, and clears stale notes before a repository is reconnected.

export const notesRemovalFailed = 'repository.notes_removal_failed';
export const notesVolumeReclaimed = 'repository.notes_volume_reclaimed';
export const notesRemovalAbandoned = 'repository.notes_removal_abandoned';

export interface NotesOrphan { repository_id: string; name: string; first_failed_at: string | null }
export interface OrphanTrajectory { repository_id: string; path: string }
export interface NotesVolumes { notesVolumes(): Promise<{ name: string; repository_id: string; created_at: string | null }[]> ; reclaimNotes(id: string, waitMs?: number): Promise<void> }

/** Deletions whose notes volume was never deleted: the failed-removal audit that no reclaim audit answers. */
export function notesOrphanIntents(store: Store): { repository_id: string; first_failed_at: string }[] {
  return store.all(`SELECT f.repository_id repository_id, min(f.created_at) first_failed_at FROM audit f
    WHERE f.action=? AND f.repository_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM audit r WHERE r.action=? AND r.repository_id=f.repository_id)
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
  const byRepo = new Map<string, { name: string; first_failed_at: string | null }>();
  for (const volume of volumes) {
    const repository_id = volume.repository_id || /-(\d+)-notes$/.exec(volume.name)?.[1] || '';
    if (!repository_id || known.has(repository_id)) continue;
    byRepo.set(repository_id, { name: volume.name, first_failed_at: intents.get(repository_id) ?? volume.created_at });
  }
  // An intent without a volume is already gone (a retry finished without recording it, or the volume never existed).
  return [...byRepo].map(([repository_id, volume]) => ({ repository_id, name: volume.name, first_failed_at: volume.first_failed_at }))
    .sort((a, b) => (a.first_failed_at ?? '').localeCompare(b.first_failed_at ?? '') || a.repository_id.localeCompare(b.repository_id));
}

/** Trajectory directories under this deployment's disk that no repository row claims. */
export function orphanTrajectoryDirectories(store: Store): OrphanTrajectory[] {
  const known = new Set(store.all('SELECT id FROM repositories').map(row => String(row.id)));
  // The root also holds the content-addressed blob store and the tool-result files, which are not per-project.
  const reserved = new Set(['.blobs', 'sha256', 'results', 'tmp']);
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
      const state = this.attempts.get(orphan.repository_id) ?? { attempts: 0, nextAt: 0, abandoned: false };
      this.attempts.set(orphan.repository_id, state);
      if (state.abandoned || now < state.nextAt) continue;
      try {
        await this.projects.reclaimNotes(orphan.repository_id);
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
      this.attempts.delete(orphan.repository_id);
    }
    return orphanNotesVolumes(this.store, this.projects);
  }

  /** Counts and ages for the health surface; a provider failure reports the durable intents instead of hiding them. */
  async report(threshold = 10, maxAgeMs = 7 * 24 * 3600_000, warnAgeMs = 24 * 3600_000, now = this.now()): Promise<ReclaimReport> {
    let orphans: NotesOrphan[];
    try { orphans = await orphanNotesVolumes(this.store, this.projects); }
    catch { orphans = notesOrphanIntents(this.store).map(intent => ({ ...intent, name: '' })); }
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
