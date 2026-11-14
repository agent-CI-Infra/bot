import { statfsSync } from 'node:fs';

// The free-space guard (#671). Background work that writes (the payload migration here, the ledger migration in the
// manager, manager/disk.mjs) pauses while the data disk has less than its reserve left, the smaller of 5 % of the disk
// and 50 GiB; the storage page shows an alert and the log says once when that starts and ends. A task does not start
// preparing while less than its floor is left, and a write that fails because the disk is full stops it as disk_full,
// waiting for space, instead of as a runtime fault; so does a write or command in the project computer that fails for
// want of space (runner/disk.mjs).
const GiB = 1024 ** 3;
export const reserveBytes = (total: number) => Math.min(Math.floor(total * 0.05), 50 * GiB);
/**
 * The task-start floor: room for a task's checkouts, dependency installs and test output. 10 GiB (5 % of a disk under
 * 200 GiB), or three times what one task of the project recently took on its computer when that is more
 * (taskUsageBytes, src/projects/workspace-cleanup.ts), but never more than a quarter of the disk. It is separate from
 * the reserve: a large disk below its reserve still starts tasks.
 */
export const floorBytes = (total: number, taskBytes = 0) =>
  Math.min(Math.max(Math.min(Math.floor(total * 0.05), 10 * GiB), 3 * taskBytes), Math.floor(total * 0.25));

export interface DiskState { free_bytes: number; total_bytes: number; used_bytes: number; reserve_bytes: number; floor_bytes: number; low: boolean }

/** Free and total bytes of the file system holding path, with its reserve and task-start floor; null when it cannot be read. */
export function diskState(path: string): DiskState | null {
  try {
    const stats = statfsSync(path), free = stats.bavail * stats.bsize, total = stats.blocks * stats.bsize, reserve = reserveBytes(total), floor = floorBytes(total);
    // used: blocks in use, without the blocks reserved for root that free_bytes (what a process can still write) leaves out.
    return { free_bytes: free, total_bytes: total, used_bytes: (stats.blocks - stats.bfree) * stats.bsize, reserve_bytes: reserve, floor_bytes: floor, low: free < reserve };
  } catch { return null; }
}

/** An error that means the disk (or the database on it) is full. */
export function diskFull(error: unknown): boolean {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  // node:sqlite reports SQLITE_FULL (13, possibly as an extended code) in errcode.
  return ['ENOSPC', 'EDQUOT'].includes(String(value?.code)) || (Number(value?.errcode) & 0xff) === 13
    || /no space left on device|database or disk is full/i.test(String(value?.message ?? ''));
}

export class DiskGuard {
  private at = 0;
  private last: DiskState | null = null;
  private low = false;
  constructor(readonly path: string, private readonly options: { ttlMs?: number; log?: (line: string) => void; state?: (path: string) => DiskState | null } = {}) {}
  /** The disk now, statfs at most once per ttlMs; logs when the free space falls below the reserve and when it is back. */
  check(): DiskState | null {
    if (Date.now() - this.at < (this.options.ttlMs ?? 10_000)) return this.last;
    this.at = Date.now(); this.last = (this.options.state ?? diskState)(this.path);
    const low = !!this.last?.low;
    if (low !== this.low) (this.options.log ?? console.warn)(low
      ? `[disk] ${this.path}: ${gib(this.last!.free_bytes)} free, below the reserve of ${gib(this.last!.reserve_bytes)}; background writes pause`
      : `[disk] ${this.path}: ${gib(this.last?.free_bytes ?? 0)} free again; background writes resume`);
    this.low = low;
    return this.last;
  }
}
const gib = (bytes: number) => (bytes / GiB).toFixed(1) + ' GiB';
