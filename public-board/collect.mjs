import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectRepo } from './scripts/collect.mjs';
import { GitHubClient } from './scripts/lib/github.mjs';
import { loadConfig } from './scripts/lib/config.mjs';

const [full, output, state] = process.argv.slice(2), [owner, name] = full.split('/');
process.chdir(import.meta.dirname);
const write = (name, value) => writeFile(path.join(output, name), JSON.stringify(value));
await promisify(execFile)('python3', [path.resolve('collect.py'), full, output, state],
  { timeout: 11 * 60_000, maxBuffer: 1024 * 1024 });
process.env.MONITOR_REPOS = full;
const cfg = loadConfig(path.join(output, 'public/data'));
// Classification rules are unchanged; collect only this installation's repository with its own token.
cfg.outDir = path.join(output, 'public/data');
cfg.config.internalContributors = { [full]: cfg.config.internalContributors[full] || [] };
const summary = await collectRepo({ owner, name, fullName: full }, cfg,
  new GitHubClient({ token: process.env.GITHUB_TOKEN, apiBase: process.env.BOT_GITHUB_API_URL }), new Date(), () => {});
await write('summary.json', summary);
await write('config.json', cfg.config);
// The gate page's data (#938): an older snapshot copied into this one may still have it.
await rm(path.join(output, 'gate.json'), { force: true });
