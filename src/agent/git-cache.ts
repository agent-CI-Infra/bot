import { spawn } from 'node:child_process';
import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { safePath } from './common.js';

// Bare mirrors of enabled repositories on the control plane's own volume (<root>/<repository id>.git). A task first
// makes the mirror hold its commit, then copies files out of it at that fixed commit; nothing is checked out here and
// no task ever writes into a mirror. The installation token is passed to one fetch through the environment only:
// it is never part of a remote URL, a config file, FETCH_HEAD or an error message.
export interface MirrorEntry { path: string; mode: string; type: string; sha: string; size?: number }
export class Mirror {
  constructor(readonly cache: GitCache, readonly repository: string, readonly present: ReadonlySet<string>,
    readonly state: 'hit' | 'fetched' | 'unavailable', readonly error?: string) {}
  has(commit: string): boolean { return this.present.has(commit); }
  listing(commit: string) { return this.cache.listing(this.repository, commit); }
  blob(sha: string) { return this.cache.blob(this.repository, sha); }
}
type Run = { stdout: Buffer; stderr: string; code: number | null };
const objectId = /^[a-f0-9]{40}$/;
// Only branch and pull request head refs are fetched by name, and only when GitHub refuses a commit by SHA.
const fetchableRef = /^refs\/(?:heads\/(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]+|pull\/\d+\/head)$/;
export class GitCache {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly root: string, readonly fetchTimeoutMs = 30 * 60_000) {}
  path(repository: string): string {
    if (!/^[1-9]\d{0,19}$/.test(repository)) throw new Error('invalid_repository');
    return join(this.root, repository + '.git');
  }
  private git(args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Run> {
    // No global or system config, no prompts: only what this process passes applies.
    const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: this.root, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', ...options.env };
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }), out: Buffer[] = [];
      let stderr = '';
      const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : undefined;
      child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr, code }); });
    });
  }
  private async checked(args: string[], cwd: string): Promise<Buffer> {
    const run = await this.git(args, { cwd });
    if (run.code !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim() || 'exit ' + run.code}`);
    return run.stdout;
  }
  private serial<T>(repository: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(repository) || Promise.resolve(), next = previous.catch(() => {}).then(fn);
    this.queues.set(repository, next);
    return next.finally(() => { if (this.queues.get(repository) === next) this.queues.delete(repository); });
  }
  private async hasCommit(dir: string, sha: string): Promise<boolean> {
    return objectId.test(sha) && (await this.git(['cat-file', '-e', sha + '^{commit}'], { cwd: dir })).code === 0;
  }
  private async ensure(dir: string): Promise<void> {
    if (await access(join(dir, 'HEAD')).then(() => true, () => false)) return;
    await rm(dir, { recursive: true, force: true }); await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.checked(['init', '--bare', '--quiet', dir], this.root);
    // Maintenance runs inside the serialized update instead of detaching into the background.
    await this.checked(['config', 'gc.autoDetach', 'false'], dir);
  }
  // Makes the mirror hold every commit, fetching only what is missing. Updates of one mirror run one at a time.
  // Never throws: a failure leaves the task to read through the GitHub API, with the reason in `error`.
  async open(repository: string, { url, token, commits, refs = [] }: { url: string; token: string; commits: string[]; refs?: string[] }): Promise<Mirror> {
    const wanted = [...new Set(commits.filter(sha => objectId.test(sha)))];
    try {
      return await this.serial(repository, async () => {
        const dir = this.path(repository); await this.ensure(dir);
        const has = async () => new Set((await Promise.all(wanted.map(async sha => await this.hasCommit(dir, sha) ? sha : null))).filter((sha): sha is string => !!sha));
        let present = await has();
        if (wanted.every(sha => present.has(sha))) return new Mirror(this, repository, present, 'hit');
        const target = new URL(url);
        if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('unsupported clone URL');
        // The header applies to this origin only and lives in this process's environment for one command.
        const env = { GIT_ALLOW_PROTOCOL: target.protocol.slice(0, -1), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${target.origin}/.extraheader`,
          GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64') };
        const fetch = (specs: string[]) => this.git(['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', target.href, ...specs], { cwd: dir, env, timeoutMs: this.fetchTimeoutMs });
        // Each fetched commit is pinned under refs/bot/commits/<sha>, so maintenance never prunes what a later task reads.
        const missing = wanted.filter(sha => !present.has(sha));
        let run = await fetch(missing.map(sha => `+${sha}:refs/bot/commits/${sha}`));
        present = await has();
        const named = refs.filter(ref => fetchableRef.test(ref));
        if (wanted.some(sha => !present.has(sha)) && named.length) {
          run = await fetch(named.map((ref, index) => `+${ref}:refs/bot/fetch/${index}`));
          for (const sha of wanted.filter(sha => !present.has(sha))) if (await this.hasCommit(dir, sha)) await this.checked(['update-ref', 'refs/bot/commits/' + sha, sha], dir);
          for (let index = 0; index < named.length; index++) await this.git(['update-ref', '-d', `refs/bot/fetch/${index}`], { cwd: dir });
          present = await has();
        }
        const lacking = wanted.filter(sha => !present.has(sha));
        const error = lacking.length ? `git fetch did not provide ${lacking.join(', ')}: ${run.stderr.replaceAll(token, '[REDACTED]').trim() || 'exit ' + run.code}` : undefined;
        return new Mirror(this, repository, present, present.size ? 'fetched' : 'unavailable', error);
      });
    } catch (error) {
      return new Mirror(this, repository, new Set(), 'unavailable', String((error as Error)?.message || error).replaceAll(token, '[REDACTED]').slice(0, 2000));
    }
  }
  // Every non-directory entry of a commit's tree, in the shape of GitHub's recursive tree listing.
  async listing(repository: string, commit: string): Promise<{ tree_sha: string; tree: MirrorEntry[] }> {
    const dir = this.path(repository);
    const tree = (await this.checked(['rev-parse', '--verify', '--quiet', commit + '^{tree}'], dir)).toString().trim();
    const entries: MirrorEntry[] = [];
    for (const row of (await this.checked(['ls-tree', '-r', '-l', '-z', '--full-tree', commit], dir)).toString('utf8').split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t'), [mode, type, sha, size] = row.slice(0, tab).trim().split(/\s+/);
      entries.push({ path: safePath(row.slice(tab + 1)), mode: mode!, type: type!, sha: sha!, ...(size && size !== '-' ? { size: Number(size) } : {}) });
    }
    return { tree_sha: tree, tree: entries };
  }
  // A blob's bytes, or null when the mirror does not have it.
  async blob(repository: string, sha: string): Promise<Buffer | null> {
    if (!objectId.test(sha)) return null;
    const run = await this.git(['cat-file', 'blob', sha], { cwd: this.path(repository) });
    return run.code === 0 ? run.stdout : null;
  }
}
