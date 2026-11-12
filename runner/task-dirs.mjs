import { lstat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tasksDirectory } from './paths.mjs';
import { git, storeRoot } from './store.mjs';

// Task directories for the control plane's workspace cleanup. The control plane decides from its records which
// directories go; the computer only lists /workspace/tasks/<id> (names and when each was last active) and removes the
// directories it is sent, a few per call. Nothing outside the tasks directory can be named: an entry is a 48-hex id, the
// tasks directory itself must be a real directory, and an entry that is a symbolic link or no directory is left alone.
const idPattern = /^[a-f0-9]{48}$/;
export const listLimit = 5000, removeLimit = 20;

// When a task directory was last active: the newest modification of the directory and of the files a task keeps
// touching while it runs (its agent's events and state, the checkout's top level, its context, the reuse cache).
export async function activeAt(dir) {
  const times = await Promise.all(['', '/agent', '/agent/events.jsonl', '/agent/state.json', '/repo', '/context', '/review-cache.json']
    .map(name => lstat(dir + name).then(info => info.mtimeMs, () => 0)));
  return Math.floor(Math.max(...times));
}
// False when there is no tasks directory yet; a symbolic link or file in its place is refused.
async function tasksRoot(root) {
  const info = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && !info.isDirectory()) throw new Error('invalid_tasks_directory');
  return !!info;
}
/** The task directories, least recently active first, at most listLimit of them; total counts them all. */
export async function listTaskDirectories(root = tasksDirectory) {
  if (!await tasksRoot(root)) return { entries: [], total: 0 };
  const entries = [];
  for (const name of await readdir(root)) {
    if (!idPattern.test(name) || !(await lstat(root + '/' + name).catch(() => null))?.isDirectory()) continue;
    entries.push({ name, active_at: await activeAt(root + '/' + name) });
  }
  entries.sort((a, b) => a.active_at - b.active_at || (a.name < b.name ? -1 : 1));
  return { entries: entries.slice(0, listLimit), total: entries.length };
}
const run = (command, args, timeout = 0) => new Promise(resolve =>
  execFile(command, args, { timeout, maxBuffer: 65536 }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) })));
// Disk space a directory uses in bytes, or null when du cannot tell within a minute.
async function diskUsage(path) {
  const { error, stdout } = await run('du', ['-skx', '--', path], 60000), kib = Number(stdout.split('\t')[0]);
  return error || !Number.isFinite(kib) ? null : kib * 1024;
}
// rm does not follow symbolic links and stays on this file system. A directory an agent made read-only (a Go module
// cache, for example) keeps rm from deleting its entries, so after a failure the tree is made writable and rm runs again.
async function removeTree(path) {
  if (!(await run('rm', ['-rf', '--one-file-system', '--', path])).error) return;
  await run('chmod', ['-R', 'u+rwx', '--', path]);
  const { error, stderr } = await run('rm', ['-rf', '--one-file-system', '--', path]);
  if (error) throw new Error(stderr.trim().slice(-500) || error.message);
}
/**
 * Removes the listed task directories. Each entry carries the active_at the listing reported; a directory active since
 * then is in use again and stays (skipped as changed). Returns what was removed with the bytes it used, and what was not.
 */
export async function removeTaskDirectories(entries, root = tasksDirectory, gitRoot = storeRoot) {
  if (!Array.isArray(entries) || !entries.length || entries.length > removeLimit
    || entries.some(entry => !idPattern.test(entry?.name || '') || !Number.isSafeInteger(entry.active_at) || entry.active_at < 0)) throw new Error('invalid_entries');
  if (!await tasksRoot(root)) return { removed: [], skipped: entries.map(({ name }) => ({ name, reason: 'missing' })) };
  const removed = [], skipped = [];
  for (const { name, active_at: listed } of entries) {
    const path = root + '/' + name, info = await lstat(path).catch(() => null);
    if (!info) { skipped.push({ name, reason: 'missing' }); continue; }
    if (!info.isDirectory()) { skipped.push({ name, reason: 'not_directory' }); continue; }
    // Measured first, so the check for new activity sits right before the removal.
    const bytes = await diskUsage(path);
    if (await activeAt(path) > listed) { skipped.push({ name, reason: 'changed' }); continue; }
    try { await removeTree(path); removed.push({ name, bytes }); }
    catch (error) { skipped.push({ name, reason: 'remove_failed', detail: error.message }); }
  }
  // A removed checkout was a worktree of the computer's git store; its registration goes too.
  if (removed.length) await git(['worktree', 'prune'], { cwd: gitRoot + '/repo.git' }).catch(() => {});
  return { removed, skipped };
}
