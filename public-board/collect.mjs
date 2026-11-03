import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectRepo } from './scripts/collect.mjs';
import { GitHubClient } from './scripts/lib/github.mjs';
import { loadConfig } from './scripts/lib/config.mjs';
import { boardGateMeta, lanesToBranch, snapshotCoverage } from './scripts/lib/status-board.mjs';

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

const snapshot = JSON.parse(await readFile(path.join(output, 'board/data/snapshot.json'), 'utf8'));
const boardUrl = `/boards/${full.toLowerCase()}/`, defaultBranch = snapshot.repository.default_branch;
const source = { id: full, owner, name, defaultBranch, boardBaseUrl: boardUrl };
const coverage = snapshotCoverage(snapshot), meta = boardGateMeta(snapshot, defaultBranch, defaultBranch);
const laneBlocks = [snapshot.sections?.ci?.data?.lanes,
  ...Object.values(snapshot.line_sections || {}).map(line => line?.ci?.data?.lanes)].filter(block => block?.lanes?.length);
const branchData = laneBlocks.map(block => lanesToBranch(block, source)).filter(Boolean).map(branch => {
  const gateMeta = boardGateMeta(snapshot, branch.name, defaultBranch);
  return { ...branch, coverage: branch.name === defaultBranch ? coverage?.coverage ?? null : null,
    ...(branch.name === defaultBranch && coverage ? { coverageDetail: coverage.coverageDetail, coverageLink: boardUrl + '#tests' } : {}),
    stats: branch.stats.map(stat => ({ ...stat,
      ...(gateMeta?.latestByCategory?.get(stat.category) ? { latest: gateMeta.latestByCategory.get(stat.category) } : {}) })) };
});
await write('gate.json', { id: full, owner, name, defaultBranch, url: boardUrl, boardUrl,
  generatedAt: snapshot.generated_at, sourceUrl: boardUrl + 'data/snapshot.json', windowDays: 7,
  ...(meta?.level ? { level: meta.level } : {}), ...(meta?.stage ? { stage: meta.stage } : {}),
  ...(meta?.caseSummary ? { caseSummary: meta.caseSummary } : {}), branchData });
