import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Category, Footprint } from '../../manager/storage-footprint.mjs';

type Filesystem = {device: string; total: number; free: number};
export interface MachineSample { measured_at: string; filesystems: Filesystem[] }
const validBytes = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Accept only a recent, same-boot host inventory. Container statfs is never a machine fallback. */
export async function machineSample(directory: string | undefined, bootIdFile = '/proc/sys/kernel/random/boot_id'): Promise<MachineSample | null> {
  if (!directory) return null;
  try {
    const file = await open(join(directory, 'filesystems.json'), 'r');
    let data;
    try {
      const buffer = Buffer.alloc(65537), { bytesRead } = await file.read(buffer);
      if (bytesRead === buffer.length) return null;
      data = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } finally { await file.close(); }
    const boot = (await readFile(bootIdFile, 'utf8')).trim();
    const age = Date.now() - Date.parse(data.measured_at), devices = new Set<string>();
    if (data.version !== 1 || data.boot_id !== boot || !Number.isFinite(age) || age < 0 || age > 15 * 60_000 ||
        !Array.isArray(data.filesystems) || !data.filesystems.length) return null;
    for (const fs of data.filesystems) {
      if (typeof fs.device !== 'string' || !/^\d+:[a-f\d]+$/.test(fs.device) || devices.has(fs.device) ||
          !validBytes(fs.total) || !fs.total || !validBytes(fs.free) || fs.free > fs.total) return null;
      devices.add(fs.device);
    }
    return { measured_at: data.measured_at, filesystems: data.filesystems };
  } catch { return null; }
}

interface Project { repository_id: string | null; name: string; computer?: Record<string, any> }
const categories: Category[] = ['database', 'trajectories', 'knowledge', 'workspaces', 'other'];
export function storageOverview(projects: Project[], control: Footprint | null, manager: Footprint | null,
  workspaceProjects: string[] | undefined, sample: MachineSample | null) {
  const amounts = { database: 0, trajectories: 0, knowledge: 0, workspaces: 0, other: 0 };
  const missing = new Set<Category>();
  for (const kind of control?.missing ?? ['database', 'trajectories', 'other'] as const) missing.add(kind);
  for (const kind of manager?.missing ?? ['database', 'trajectories', 'knowledge'] as const) missing.add(kind);
  const rows = new Map(projects.filter(p => p.repository_id).map(p => [p.repository_id!, { id: p.repository_id!, name: p.name, bytes: 0 }]));
  const deviceBytes = new Map<string, number>();
  const entries = [...control?.entries ?? [], ...manager?.entries ?? []];
  if (!Array.isArray(workspaceProjects)) missing.add('workspaces');
  const computers = new Map(projects.map(p => [p.repository_id, p.computer]));
  for (const id of workspaceProjects ?? []) {
    const scan = computers.get(id);
    if (!scan || scan.complete !== true || !validBytes(scan.total_bytes)) { missing.add('workspaces'); continue; }
    entries.push({ kind: 'workspaces', bytes: scan.total_bytes, device: scan.disk?.device ?? null, projects: { [id]: scan.total_bytes } });
  }
  for (const entry of entries) {
    if (!categories.includes(entry.kind) || !validBytes(entry.bytes)) continue;
    amounts[entry.kind] += entry.bytes;
    if (entry.device) deviceBytes.set(entry.device, (deviceBytes.get(entry.device) ?? 0) + entry.bytes);
    for (const [id, bytes] of Object.entries(entry.projects)) {
      const row = rows.get(id);
      if (row) row.bytes += bytes;
    }
  }
  const total = Object.values(amounts).reduce((a, b) => a + b, 0);
  const ranked = [...rows.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const shared = total - ranked.reduce((sum, row) => sum + row.bytes, 0);
  let machine = null;
  if (sample) {
    const capacity = sample.filesystems.reduce((sum, fs) => sum + fs.total, 0);
    const free = sample.filesystems.reduce((sum, fs) => sum + fs.free, 0);
    // Only verified bytes on each reported device may be subtracted. Snapshots are asynchronous:
    // if a device's attributed bytes exceed its current use, leave its split unknown.
    const consistent = sample.filesystems.every(fs => (deviceBytes.get(fs.device) ?? 0) <= fs.total - fs.free);
    const owned = consistent && deviceBytes.size ? sample.filesystems.reduce((sum, fs) => sum + (deviceBytes.get(fs.device) ?? 0), 0) : null;
    machine = { measured_at: sample.measured_at, filesystems: sample.filesystems.length, total: capacity, free,
      used: capacity - free, launchpad: owned, other: owned === null ? null : capacity - free - owned };
  }
  return { machine, total, amounts, missing: [...missing], rows: ranked, shared, control_at: control?.measured_at ?? null, manager_at: manager?.measured_at ?? null };
}
