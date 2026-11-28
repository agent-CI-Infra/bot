import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectRepo } from './scripts/collect.mjs';
import { GitHubClient } from './scripts/lib/github.mjs';
import { loadConfig } from './scripts/lib/config.mjs';

const [full, output, state] = process.argv.slice(2), [owner, name] = full.split('/');
const reconcileRaw = process.env.BOT_PUBLIC_BOARD_RECONCILE_MS?.trim();
let fullReconcileMs;
if (reconcileRaw !== undefined && reconcileRaw !== '') {
  const parsed = /^\d+$/.test(reconcileRaw) ? Number(reconcileRaw) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || (parsed > 0 && parsed < 60_000)) {
    throw new Error(`BOT_PUBLIC_BOARD_RECONCILE_MS must be 0 or an integer >= 60000, got ${JSON.stringify(process.env.BOT_PUBLIC_BOARD_RECONCILE_MS)}`);
  }
  fullReconcileMs = parsed;
}
process.chdir(import.meta.dirname);
const writeAtomic = async (name, value) => {
  const target = path.join(output, name), tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, target);
};
await promisify(execFile)('python3', [path.resolve('collect.py'), full, output, state],
  { timeout: 11 * 60_000, maxBuffer: 1024 * 1024 });
process.env.MONITOR_REPOS = full;
const prevDir = process.env.BOT_PUBLIC_BOARD_PREV_DIR || '';
const dirtyScopes = process.env.BOT_PUBLIC_BOARD_DIRTY_SCOPES
  ? process.env.BOT_PUBLIC_BOARD_DIRTY_SCOPES.split(',').map(s => s.trim()).filter(Boolean)
  : undefined;
const cfg = loadConfig(prevDir ? path.join(prevDir, 'public/data') : path.join(output, 'public/data'));
// Classification rules are unchanged; collect only this installation's repository with its own token.
cfg.outDir = path.join(output, 'public/data');
cfg.config.internalContributors = { [full]: cfg.config.internalContributors[full] || [] };
const summary = await collectRepo(
  { owner, name, fullName: full },
  cfg,
  new GitHubClient({ token: process.env.GITHUB_TOKEN, apiBase: process.env.BOT_GITHUB_API_URL }),
  new Date(),
  () => {},
  {
    prevDir: prevDir ? path.join(prevDir, 'public/data') : undefined,
    stateFile: path.join(state, '.community-sync.json'),
    dirtyScopes,
    fullReconcileMs,
  },
);
await writeAtomic('summary.json', summary);
await writeAtomic('config.json', cfg.config);
// The gate page's data (#938): an older snapshot copied into this one may still have it.
await rm(path.join(output, 'gate.json'), { force: true });
