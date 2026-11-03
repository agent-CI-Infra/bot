import { opendir, stat, unlink, readFile } from 'node:fs/promises';

// A journal record lets a repeated operation id get its first result back, and lets tail read a finished command's
// output; both only matter shortly after the call. Without removal a computer keeps one file per call it ever ran
// (over a million on a busy one), so records older than the retention are deleted.
export const journalRetentionMs = 24 * 3600 * 1000;
// Commands have no time limit, so a record still marked running, and its live output, stay for a week.
export const runningRetentionMs = 7 * 24 * 3600 * 1000;
const recordName = /^[a-f0-9]{48}\.(json|json\.tmp|out)$/;
const running = path => readFile(path, 'utf8').then(text => JSON.parse(text).state === 'running', () => false);

// Streams the directory instead of listing it at once. Only small records are read: a finished one carries its result,
// while {"state":"running"} is a few bytes.
export async function pruneJournal(dir, { olderThanMs = journalRetentionMs, now = Date.now() } = {}) {
  let removed = 0, kept = 0;
  const directory = await opendir(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!directory) return { removed, kept };
  for await (const entry of directory) {
    const path = `${dir}/${entry.name}`, info = entry.isFile() && recordName.test(entry.name) ? await stat(path).catch(() => null) : null;
    const age = info ? now - info.mtimeMs : 0;
    if (!info || age <= olderThanMs) { kept++; continue; }
    // An output file stays while its command is recorded as running (the record goes after a week, and the output with it).
    const live = entry.name.endsWith('.out') ? await running(path.slice(0, -4) + '.json')
      : entry.name.endsWith('.json') && info.size < 64 && age <= runningRetentionMs && await running(path);
    if (live) { kept++; continue; }
    if (await unlink(path).then(() => true, () => false)) removed++; else kept++;
  }
  return { removed, kept };
}
