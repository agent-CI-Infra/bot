// Each operand is an owned location. One du invocation counts hard-linked files once. Report only
// first-level repository directories and the inclusive total, never file names from inside them.
import { filesystemId } from '../runner/filesystem-id.mjs';
import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function incompleteKinds(error, roots) {
  const all = () => [...roots.values()].map(root => root.kind);
  if (error.code !== 1) return all();
  const kinds = new Set();
  // GNU du still prints measured subtotals for directories it could only partly read. Attribute
  // its ordinary C-locale diagnostics to the operand; an ambiguous error affects the whole scan.
  for (const line of (error.stderr ?? '').trimEnd().split('\n')) {
    const path = /^du: cannot (?:access|read directory) '([^']+)': /.exec(line)?.[1];
    const root = path && [...roots.keys()].find(root => path === root || path.startsWith(root + sep));
    if (!root) return all();
    kinds.add(roots.get(root).kind);
  }
  return kinds;
}

export async function storageFootprint(database, locations) {
  const devices = new Map(), roots = new Map(), missing = new Set(), entries = [];
  const operands = [
    ...['', '-wal', '-shm'].map(suffix => ['database', database + suffix, false]),
    ...locations,
  ];
  // /data is the installation's dedicated volume. An arbitrary database directory in a source
  // installation may also hold unrelated files, so measure only named locations there.
  if (dirname(database) === '/data') {
    const named = new Set(operands.map(([, path]) => resolve(path)));
    try {
      for (const name of await readdir('/data')) {
        const path = join('/data', name);
        if (!named.has(path)) operands.push(['other', path, false]);
      }
    } catch { missing.add('other'); }
  }
  for (const [kind, path, byProject, label] of operands) {
    try {
      const stat = await lstat(path), canonical = await realpath(path);
      if (stat.isSymbolicLink() || [...roots.keys()].some(other => other === canonical || other.startsWith(canonical + sep) || canonical.startsWith(other + sep))) {
        missing.add(kind);
        continue;
      }
      if (!devices.has(stat.dev)) devices.set(stat.dev, await filesystemId(path, stat.dev));
      roots.set(canonical, { kind, label, device: devices.get(stat.dev), byProject, projects: {}, bytes: null });
    } catch (error) {
      if (error.code !== 'ENOENT' || path === database) missing.add(kind);
      else if (label) entries.push({ kind, label, bytes: 0, device: null, projects: {} });
    }
  }
  if (roots.size) {
    // --one-file-system excludes nested volumes. NUL delimiters also handle tabs/newlines in names.
    try {
      const { stdout } = await execute('nice', ['-n', '19', 'du', '-x', '-B1', '--max-depth=1', '--null', '--', ...roots.keys()],
        { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', QUOTING_STYLE: 'shell-escape-always' } }).catch(error => {
          for (const kind of incompleteKinds(error, roots)) missing.add(kind);
          return { stdout: error.stdout ?? '' };
        });
      for (const line of stdout.split('\0').slice(0, -1)) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const path = line.slice(tab + 1), bytes = Number(line.slice(0, tab)), root = roots.get(path);
        if (!Number.isSafeInteger(bytes) || bytes < 0) continue;
        if (root) root.bytes = bytes;
        else {
          const parent = roots.get(dirname(path)), id = path.slice(dirname(path).length + 1);
          if (parent?.byProject && /^[1-9]\d{0,19}$/.test(id)) parent.projects[id] = bytes;
        }
      }
      for (const root of roots.values()) {
        if (root.bytes === null) missing.add(root.kind);
        else entries.push({ kind: root.kind, label: root.label, device: root.device, bytes: root.bytes, projects: root.projects });
      }
    } catch {
      for (const root of roots.values()) missing.add(root.kind);
    }
  }
  return { measured_at: new Date().toISOString(), entries, missing: [...missing] };
}

export function managerLocations(database) {
  const data = dirname(resolve(database));
  return [['trajectories', join(data, 'trajectories'), true], ['knowledge', join(data, 'project-notes'), true]];
}
