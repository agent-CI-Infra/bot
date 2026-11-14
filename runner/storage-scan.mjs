import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { relative, sep } from 'node:path';

// What a project computer's work volume holds (#671), for the storage page. One `du` pass two levels deep, at the lowest
// CPU priority and bounded in time; the manager runs it in the background every few hours and keeps the last answer, so
// the page never waits for it. Sizes are disk usage in bytes (du -k). The top level of /workspace is split into the
// task workspaces (each /workspace/tasks/<id>), the runner journal, the computer's git store, HOME (with its largest
// entries, the caches tools keep there), /workspace/tmp and everything else. The project notes at
// /workspace/project-notes are another volume (the manager's notes directory, mounted in) and are left out; their
// history directory is the manager's alone, so the computer's user could not read it anyway.
const idPattern = /^[a-f0-9]{48}$/, known = { tasks: 'tasks', '.runner-journal': 'journal', git: 'store', home: 'home', tmp: 'tmp' };
export const scanLimits = { timeoutMs: 30 * 60_000, tasks: 5000, entries: 20 };

export async function storageScan(root, { timeoutMs = scanLimits.timeoutMs } = {}) {
  const started = Date.now();
  // du reports what it measured even when it cannot read a directory or is stopped at the time limit; complete says so.
  const { error, stdout } = await new Promise(resolve => execFile('nice', ['-n', '19', 'du', '-kx', '--max-depth=2', `--exclude=${root}/project-notes`, '--', root],
    { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (failure, out) => resolve({ error: failure, stdout: String(out ?? '') })));
  const top = new Map(), tasks = [], home = [], others = new Map();
  let total = null;
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t'), kib = Number(line.slice(0, tab)), path = line.slice(tab + 1);
    if (tab < 0 || !Number.isFinite(kib)) continue;
    const parts = relative(root, path).split(sep).filter(Boolean), bytes = kib * 1024;
    if (!parts.length) total = bytes;
    else if (parts.length === 1) top.set(parts[0], bytes);
    else if (parts[0] === 'tasks' && idPattern.test(parts[1])) tasks.push({ name: parts[1], bytes });
    else if (parts[0] === 'home') home.push({ name: parts[1], bytes });
  }
  const groups = { tasks: 0, journal: 0, store: 0, home: 0, tmp: 0, other: 0 };
  for (const [name, bytes] of top) {
    if (known[name]) groups[known[name]] += bytes;
    else { groups.other += bytes; others.set(name, bytes); }
  }
  // Files directly in /workspace have no line of their own: they are the total less the directories.
  if (total !== null) groups.other += Math.max(0, total - [...top.values()].reduce((sum, bytes) => sum + bytes, 0));
  const largest = list => list.sort((a, b) => b.bytes - a.bytes).slice(0, scanLimits.entries);
  let disk = null; try { const stats = await statfs(root); disk = { free_bytes: stats.bavail * stats.bsize, total_bytes: stats.blocks * stats.bsize }; } catch {}
  return { scanned_at: new Date().toISOString(), duration_ms: Date.now() - started, complete: !error, total_bytes: total, ...Object.fromEntries(Object.entries(groups).map(([key, value]) => [key + '_bytes', value])),
    tasks: tasks.sort((a, b) => b.bytes - a.bytes).slice(0, scanLimits.tasks), task_count: tasks.length,
    home_entries: largest(home), other_entries: largest([...others].map(([name, bytes]) => ({ name, bytes }))), disk };
}
