import { mkdir, open, rm, stat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { environment } from './command.mjs';
import { workspaceRoot } from './paths.mjs';

// One git object store per project computer, in its work volume, shared by the tasks on it. The control plane keeps the
// repository's mirror and the credentials; it sends what this store lacks as a pack, and each task gets its own worktree
// of a fixed commit. Commits the control plane sent are pinned under refs/bot/commits/<sha>, which is also how it learns
// what to leave out next time. Nothing here talks to GitHub.
// root is a parameter for tests; on a computer it is always /workspace/git.
export const storeRoot = workspaceRoot + '/git';
const paths = root => ({ store: root + '/repo.git', incoming: root + '/incoming' });
const objectId = /^[a-f0-9]{40}$/, packId = /^[a-f0-9]{48}$/;
export function git(args, { cwd = paths(storeRoot).store, input, output } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [], child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { cwd, env: { ...environment, GIT_TERMINAL_PROMPT: '0' }, stdio: [input ? 'pipe' : 'ignore', output ?? 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout?.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', () => reject(new Error(`git ${args[0]} could not start`)));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args[0]} failed: ${stderr.trim() || code}`)));
    if (input) { child.stdin.on('error', () => {}); input.pipe ? input.pipe(child.stdin) : child.stdin.end(input); }
  });
}
async function ensureStore(root) {
  const { store, incoming } = paths(root);
  await mkdir(incoming, { recursive: true, mode: 0o700 });
  if (await stat(store + '/HEAD').then(() => true, () => false)) return;
  await rm(store, { recursive: true, force: true });
  await git(['init', '--bare', '--quiet', store], { cwd: root });
  for (const [key, value] of [['core.autocrlf', 'false'], ['gc.autoDetach', 'false'], ['commit.gpgsign', 'false']]) await git(['config', key, value], { cwd: store });
}
export async function storeOperation(input, root = storeRoot) {
  await ensureStore(root); const { store, incoming } = paths(root), run = (args, options = {}) => git(args, { cwd: store, ...options });
  // The commits this store holds, so the control plane sends only what is missing.
  if (input.type === 'git_have') return { commits: (await run(['for-each-ref', '--format=%(objectname)', 'refs/bot/commits/'])).toString().split('\n').filter(sha => objectId.test(sha)) };
  if (!packId.test(input.pack_id || '')) throw new Error('invalid_pack');
  const file = `${incoming}/${input.pack_id}.pack`;
  // A pack arrives in chunks, each written at its offset; a repeated chunk is rejected rather than appended twice.
  if (input.type === 'git_pack') {
    if (typeof input.base64 !== 'string' || !Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('invalid_content');
    const data = Buffer.from(input.base64, 'base64'), handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (input.offset === 0 ? constants.O_TRUNC : 0), 0o600);
    try { if ((await handle.stat()).size !== input.offset) throw new Error('offset_mismatch'); await handle.write(data, 0, data.length, input.offset); await handle.sync(); } finally { await handle.close(); }
    return { written: true, size: input.offset + data.length };
  }
  // The other direction: the objects of one commit (its tree and blobs, not its history) as a pack read in chunks. A run
  // container gets a fixed candidate this way instead of a mount of the computer that produced it.
  if (input.type === 'git_export') {
    if (!objectId.test(input.sha || '') || !Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('invalid_export');
    const out = `${incoming}/${input.pack_id}.export`;
    if (input.offset === 0) {
      await run(['cat-file', '-e', input.sha + '^{commit}']);
      const objects = await run(['rev-list', '--objects', '--no-walk', input.sha]), pack = await run(['pack-objects', '--stdout', '-q'], { input: objects });
      const handle = await open(out, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await handle.write(pack); } finally { await handle.close(); }
    }
    const handle = await open(out, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = (await handle.stat()).size, buffer = Buffer.alloc(Math.max(0, Math.min(45000, size - input.offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset), next = input.offset + bytesRead;
      if (next >= size) await rm(out, { force: true });
      return { base64: buffer.subarray(0, bytesRead).toString('base64'), offset: input.offset, size, done: next >= size };
    } finally { await handle.close(); }
  }
  if (input.type === 'git_import') {
    if (!Array.isArray(input.commits) || !input.commits.length || input.commits.some(sha => !objectId.test(sha))) throw new Error('invalid_commits');
    // index-pack checks every object it stores; the commits must then be complete in the store.
    try {
      const pack = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await run(['index-pack', '--stdin', '--fix-thin'], { input: pack.createReadStream() }); } finally { await pack.close().catch(() => {}); }
      for (const sha of input.commits) { await run(['cat-file', '-e', sha + '^{commit}']); await run(['update-ref', 'refs/bot/commits/' + sha, sha]); }
    } finally { await rm(file, { force: true }); }
    return { imported: input.commits };
  }
  throw new Error('unsupported_store_operation');
}
// Old task directories go after three days without activity, with their worktree registrations; the store is repacked
// when git thinks it is due. A task still running keeps touching its agent files.
export async function pruneTasks(tasksRoot, olderThanMs = 3 * 24 * 3600 * 1000, now = Date.now(), root = storeRoot) {
  const { store, incoming } = paths(root);
  // A pack whose transfer stopped halfway is of no use to anyone after a few hours.
  for (const name of await readdir(incoming).catch(() => [])) {
    const path = incoming + '/' + name, modified = await stat(path).then(s => s.mtimeMs, () => now);
    if (now - modified > 6 * 3600 * 1000) await rm(path, { force: true });
  }
  let removed = 0;
  for (const name of await readdir(tasksRoot).catch(() => [])) {
    if (!/^[a-f0-9]{48}$/.test(name)) continue;
    const root = tasksRoot + name, times = await Promise.all([root, root + '/agent', root + '/agent/events.jsonl', root + '/agent/state.json'].map(path => stat(path).then(s => s.mtimeMs, () => 0)));
    if (now - Math.max(...times) <= olderThanMs) continue;
    await rm(root, { recursive: true, force: true }); removed++;
  }
  if (await stat(store + '/HEAD').then(() => true, () => false)) { await git(['worktree', 'prune'], { cwd: store }).catch(() => {}); await git(['gc', '--auto', '--quiet'], { cwd: store }).catch(() => {}); }
  return { removed };
}
