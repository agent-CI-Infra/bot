import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, mkdir, mkdtemp, cp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store, Row } from '../storage/database.js';
import { GitHub, revokeInstallationToken } from '../github/client.js';
import { Redactor } from '../agent/common.js';
import { fail } from '../core/security.js';
import { publishedRepositories, queueBoard } from './state.js';

const run = promisify(execFile);
const readPermissions = { contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read', metadata: 'read' };
export interface Collection { repository: Row; token: string; apiUrl: string; directory: string; stateDirectory: string; allowPrivate: boolean; }
export async function collectBoard(input: Collection): Promise<void> {
  // Only the source read token enters the subprocess. App keys and the host's credentials stay in the control plane.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
    GITHUB_TOKEN: input.token, BOT_GITHUB_API_URL: input.apiUrl,
    GSB_ALLOW_PRIVATE: input.allowPrivate ? '1' : '0', GSB_DATA_DIR: join(input.stateDirectory, '.data'),
    GSB_CACHE_DIR: join(input.stateDirectory, '.cache') };
  await run(process.execPath, [resolve('public-board/collect.mjs'), String(input.repository.full_name), input.directory, input.stateDirectory],
    { env, timeout: 12 * 60_000, maxBuffer: 1024 * 1024 });
}

/** A durable, coalescing queue: collection never holds up GitHub's delivery response. */
export class PublicBoards {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(readonly store: Store, readonly directory: string,
    readonly apiUrl = 'https://api.github.com', readonly collector = collectBoard) {}
  start(): void {
    this.seed();
    this.timer = setInterval(() => { this.seed(); void this.drain(); }, 1000);
    this.timer.unref(); void this.drain();
  }
  seed(): void {
    for (const repo of publishedRepositories(this.store)) if (repo.generation == null) queueBoard(this.store, repo.account_id, repo.repository_id);
  }
  drain(): Promise<void> {
    return this.running ||= this.work().finally(() => { this.running = undefined; });
  }
  private async work(): Promise<void> {
    for (const repo of publishedRepositories(this.store)) {
      const job = this.store.get(`SELECT * FROM public_board_jobs WHERE account_id=? AND repository_id=?
        AND generation>collected_generation AND next_attempt<=?`, repo.account_id, repo.repository_id, Date.now());
      if (!job) continue;
      const root = resolve(this.directory, repo.account_id, repo.repository_id), github = new GitHub(this.store, { ...repo, id: repo.repository_id }, new Redactor(), async () => {}, this.apiUrl);
      let staging: string | undefined;
      try {
        const meta = await github.connect(false, undefined, readPermissions, false);
        if (meta.full_name.toLowerCase() !== String(repo.full_name).toLowerCase()) throw new Error('repository_changed');
        if (typeof meta.private !== 'boolean') throw new Error('repository_visibility_unknown');
        this.store.run('UPDATE installed_repositories SET private=? WHERE repository_id=?', Number(meta.private), repo.repository_id);
        const eligible = () => publishedRepositories(this.store).some(row => row.account_id === repo.account_id && row.repository_id === repo.repository_id);
        if (!eligible()) continue;
        await mkdir(root, { recursive: true }); staging = await mkdtemp(join(root, 'snapshot-'));
        if (job.active_path) await cp(job.active_path, staging, { recursive: true });
        await this.collector({ repository: repo, token: github.token, apiUrl: this.apiUrl, directory: staging, stateDirectory: join(root, 'state'), allowPrivate: !!meta.private });
        // Validate before publishing. Failed collection leaves the last good snapshot readable.
        const snapshot = JSON.parse(await readFile(join(staging, 'board/data/snapshot.json'), 'utf8'));
        if (String(snapshot.repository?.name).toLowerCase() !== String(repo.full_name).toLowerCase()) throw new Error('snapshot_scope_changed');
        if (!eligible()) continue;
        this.store.run(`UPDATE public_board_jobs SET active_path=?,collected_generation=?,attempts=0,next_attempt=0,last_error=NULL
          WHERE account_id=? AND repository_id=?`, staging, job.generation, repo.account_id, repo.repository_id);
        staging = undefined;
        // Let requests which already selected the previous generation finish reading it.
        if (job.active_path) setTimeout(() => { void rm(job.active_path, { recursive: true, force: true }).catch(() => {}); }, 60_000).unref();
      } catch {
        const attempts = Number(job.attempts) + 1;
        this.store.run(`UPDATE public_board_jobs SET attempts=?,next_attempt=?,last_error='collection_failed' WHERE account_id=? AND repository_id=?`,
          attempts, Date.now() + Math.min(15 * 60_000, 1000 * 2 ** Math.min(attempts, 10)), repo.account_id, repo.repository_id);
      } finally {
        if (staging) await rm(staging, { recursive: true, force: true });
        if (github.token && this.store.get('SELECT type FROM accounts WHERE id=?', repo.account_id)?.type === 'github_app') await revokeInstallationToken(this.apiUrl, github.token).catch(() => false);
      }
    }
  }
  async close(): Promise<void> { clearInterval(this.timer); await this.running; }
  async serve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!/^\/(dashboard|boards)(\/|$)/.test(path)) return false;
    if (!['GET', 'HEAD'].includes(req.method || '')) return fail(404, 'not_found');
    if (path === '/dashboard') { res.writeHead(308, { Location: '/dashboard/' }); res.end(); return true; }
    const repos = publishedRepositories(this.store), available = repos.filter(row => row.active_path);
    const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value)); return true; };
    const load = async (repo: Row, name: string) => JSON.parse(await readFile(join(repo.active_path, name), 'utf8'));
    if (path === '/dashboard/data/index.json') return json({ generatedAt: new Date().toISOString(), repos: await Promise.all(available.map(row => load(row, 'summary.json'))) });
    if (path === '/dashboard/data/gate/index.json') return json({ generatedAt: new Date().toISOString(), windowDays: 7,
      sources: (await Promise.all(available.map(row => load(row, 'gate.json')))).filter(data => data.branchData.length).map(data => { return { id: data.id, owner: data.owner, name: data.name, file: `${data.owner}/${data.name}.json`, level: data.level, stage: data.stage, boardUrl: data.boardUrl }; }) });
    if (path === '/dashboard/data/config.json') {
      const configs = await Promise.all(available.map(row => load(row, 'config.json')));
      return json({ ...(configs[0] || { bots: [], longOpenIssueDays: 30 }), internalContributors: Object.assign({}, ...configs.map(c => c.internalContributors)) });
    }
    if (path === '/boards' || path === '/dashboard/boards/') { res.writeHead(308, { Location: '/boards/' }); res.end(); return true; }
    if (path === '/boards/') {
      const moduleUrl = pathToFileURL(resolve('public-board/index.mjs')).href;
      const { renderIndex } = await import(moduleUrl);
      const html = renderIndex(await Promise.all(repos.map(async row => ({ repository: { name: row.full_name }, label: row.full_name,
        boardUrl: `/boards/${String(row.full_name).toLowerCase()}/`, generatedAt: row.active_path ? (await load(row, 'board/data/snapshot.json')).generated_at : null }))));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : html); return true;
    }
    const gate = /^\/dashboard\/data\/gate\/([^/]+\/[^/]+)\.json$/.exec(path);
    const community = /^\/dashboard\/data\/([^/]+\/[^/]+)\/(meta|latest|history|pulls|issues|contributors|releases)\.json$/.exec(path);
    const board = /^\/boards\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(path);
    let file: string;
    if (gate || community || board) {
      const key = (gate?.[1] || community?.[1] || board?.[1] || '').toLowerCase(), repo = repos.find(row => String(row.full_name).toLowerCase() === key);
      if (!repo) return fail(404, 'not_found');
      if (gate || community) {
        if (!repo.active_path) return fail(503, 'board_collecting');
        file = gate ? join(repo.active_path, 'gate.json') : join(repo.active_path, 'public/data', repo.full_name, community![2] + '.json');
      } else {
        if (!path.endsWith('/') && !board![2]) { res.writeHead(308, { Location: `/boards/${key}/` }); res.end(); return true; }
        let asset: string;
        try { asset = decodeURIComponent(board![2] || 'index.html'); } catch { return fail(404, 'not_found'); }
        if (/^[a-z0-9-]+\.(html|css|js)$/.test(asset)) file = resolve('public-board/single-repo/static', asset);
        else {
          // Only exported evidence is reachable. Collector state and arbitrary filesystem paths never are.
          if (!/^(data|e2e)\//.test(asset) || /[\x00-\x1f\\]/.test(asset) || asset.split('/').some(p => p === '.' || p === '..' || p.startsWith('.'))) return fail(404, 'not_found');
          if (!repo.active_path) return fail(503, 'board_collecting');
          file = join(repo.active_path, 'board', asset);
        }
      }
    } else if (path.startsWith('/dashboard/') && !path.startsWith('/dashboard/data/')) {
      const asset = path.slice('/dashboard/'.length) || 'index.html';
      if (!/^[a-zA-Z0-9_./-]+$/.test(asset) || asset.split('/').some(p => p === '.' || p === '..' || p.startsWith('.'))) return fail(404, 'not_found');
      file = resolve('public-board/dashboard/dist', asset);
    } else return fail(404, 'not_found');
    try {
      const bytes = await readFile(file);
      const mime: Record<string,string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.zip': 'application/zip', '.txt': 'text/plain' };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : bytes); return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail(404, 'not_found'); throw error; }
  }
}
