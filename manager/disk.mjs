import { statfsSync } from 'node:fs';

// The free-space guard (#671), the same rules as the control plane's src/storage/disk.ts: background work that writes
// (the ledger migration) pauses while the data disk has less than its reserve left, the smaller of 5 % of the disk and
// 50 GiB, and logs once when that starts and ends. Removing expired files frees space, so it never pauses.
const GiB = 1024 ** 3;
export const reserveBytes = total => Math.min(Math.floor(total * 0.05), 50 * GiB);

/** Free and total bytes of the file system holding path with its reserve; null when it cannot be read. */
export function diskState(path) {
  try {
    const stats = statfsSync(path), free = stats.bavail * stats.bsize, total = stats.blocks * stats.bsize, reserve = reserveBytes(total);
    return { free_bytes: free, total_bytes: total, reserve_bytes: reserve, low: free < reserve };
  } catch { return null; }
}

/** An error that means the disk (or the database on it) is full. */
export function diskFull(error) {
  // node:sqlite reports SQLITE_FULL (13, possibly as an extended code) in errcode.
  return ['ENOSPC', 'EDQUOT'].includes(error?.code) || (Number(error?.errcode) & 0xff) === 13 || /no space left on device|database or disk is full/i.test(String(error?.message ?? ''));
}

export class DiskGuard {
  constructor(path, { ttlMs = 10_000, log = line => console.warn(line), state = diskState } = {}) { this.path = path; this.ttlMs = ttlMs; this.log = log; this.read = state; this.at = 0; this.last = null; this.low = false; }
  /** The disk now, statfs at most once per ttlMs; logs when the free space falls below the reserve and when it is back. */
  check() {
    if (Date.now() - this.at < this.ttlMs) return this.last;
    this.at = Date.now(); this.last = this.read(this.path);
    const low = !!this.last?.low;
    if (low !== this.low) this.log(low ? `[disk] ${this.path}: ${gib(this.last.free_bytes)} free, below the reserve of ${gib(this.last.reserve_bytes)}; background writes pause`
      : `[disk] ${this.path}: ${gib(this.last?.free_bytes ?? 0)} free again; background writes resume`);
    this.low = low;
    return this.last;
  }
}
const gib = bytes => (bytes / GiB).toFixed(1) + ' GiB';
