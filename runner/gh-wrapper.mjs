import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskedStream } from './command-output.mjs';
import { parseRepositoryPath } from './git-credential-bot.mjs';

// Wrapper around the real `gh` CLI inside the container (#705, #1279):
// 1. Blocks `gh auth token` / `--show-token` so commands cannot ask `gh` to echo the raw credential.
// 2. Resolves the target repository from CLI flags (`-R`/`--repo`), `gh api repos/<owner>/<repo>/...`,
//    `gh repo <subcmd> <owner>/<repo>`, `GH_REPO`, or the local git remote when inside a cloned repo.
// 3. Obtains a cached short-lived read-only repository token via the loopback credential helper.
// 4. Injects `GH_TOKEN`/`GITHUB_TOKEN` only into the spawned `gh` child process and masks any echoed token
//    from stdout/stderr before output reaches the CLI conversation transcript.

function findRealGh(wrapperBinDir) {
  if (process.env.BOT_REAL_GH_BIN) return process.env.BOT_REAL_GH_BIN;
  const skip = wrapperBinDir ? resolve(wrapperBinDir) : '';
  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (skip && resolve(dir) === skip) continue;
    const candidate = resolve(dir, 'gh');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return '/usr/bin/gh';
}

export function isTokenDumpCommand(args) {
  const positional = args.filter(a => !a.startsWith('-'));
  if (positional[0] === 'auth' && positional[1] === 'token') return true;
  if (args.some(a => a === '--show-token' || a.startsWith('--show-token='))) return true;
  return false;
}

export function normalizeRepoSpec(raw, allowedHost = 'github.com') {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const expectedHost = String(allowedHost || 'github.com').toLowerCase();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.host.toLowerCase() !== expectedHost) return null;
      return parseRepositoryPath(parsed.pathname);
    } catch {
      return null;
    }
  }
  const parts = trimmed.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length === 2) return parseRepositoryPath(trimmed);
  if (parts.length >= 3 && parts[0].toLowerCase() === expectedHost) {
    return parseRepositoryPath(parts.slice(1).join('/'));
  }
  return null;
}

function repoFromGitRemote(cwd, allowedHost, env = process.env) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (!out) return null;
    if (/^https?:\/\//i.test(out)) return normalizeRepoSpec(out, allowedHost);
    const scp = /^[^@]+@([^:]+):(.+)$/.exec(out);
    if (scp && scp[1].toLowerCase() === String(allowedHost || 'github.com').toLowerCase()) {
      return parseRepositoryPath(scp[2]);
    }
    return null;
  } catch {
    return null;
  }
}

export function extractGhRepository(args, { env = process.env, allowedHost = env.BOT_GITHUB_HOST || 'github.com', cwd = process.cwd() } = {}) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '-R' || arg === '--repo') {
      const next = args[i + 1];
      if (next) return normalizeRepoSpec(next, allowedHost);
    } else if (arg.startsWith('--repo=')) {
      return normalizeRepoSpec(arg.slice('--repo='.length), allowedHost);
    } else if (arg.startsWith('-R') && arg.length > 2) {
      return normalizeRepoSpec(arg.slice(2), allowedHost);
    }
  }

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      if (['-f', '-F', '-H', '-X', '--method', '--field', '--raw-field', '--header', '--jq', '--template', '--hostname', '--input'].includes(arg)) i++;
      continue;
    }
    positional.push(arg);
  }

  // `gh api repos/<owner>/<repo>/...` or `gh api /repos/<owner>/<repo>/...`
  if (positional[0] === 'api' && positional[1]) {
    const cleaned = positional[1].replace(/^\/+/, '');
    if (cleaned.startsWith('repos/')) {
      const repo = parseRepositoryPath(cleaned.slice('repos/'.length));
      if (repo) return repo;
    }
  }

  // `gh repo clone|view|fork|list ... <owner>/<repo>`
  if (positional[0] === 'repo' && ['clone', 'view', 'fork', 'sync'].includes(positional[1]) && positional[2]) {
    const repo = normalizeRepoSpec(positional[2], allowedHost);
    if (repo) return repo;
  }

  if (env.GH_REPO) {
    const repo = normalizeRepoSpec(env.GH_REPO, allowedHost);
    if (repo) return repo;
  }

  return repoFromGitRemote(cwd, allowedHost, env);
}

async function fetchReadToken(helperUrl, helperSecret, repository) {
  if (!helperUrl || !helperSecret) return { error: 'github_read_token_unavailable' };
  const query = new URLSearchParams({ purpose: 'gh' });
  if (repository) query.set('repository', repository);
  const res = await fetch(`${helperUrl.replace(/\/$/, '')}/github-read-token?${query.toString()}`, {
    method: 'POST',
    headers: { 'x-bot-helper-secret': helperSecret },
    signal: AbortSignal.timeout(125_000),
  }).catch(() => null);
  if (!res) return { error: 'github_read_token_unavailable' };
  const body = await res.json().catch(() => ({ error: 'github_read_token_unavailable' }));
  return body || { error: 'github_read_token_unavailable' };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (isTokenDumpCommand(args)) {
    process.stderr.write('gh: raw token inspection is disabled in Bot container runs; repository access uses short-lived read-only credentials automatically.\n');
    process.exit(1);
  }

  const helperUrl = process.env.BOT_CREDENTIAL_HELPER_URL || '';
  const helperSecret = process.env.BOT_CREDENTIAL_HELPER_SECRET || '';
  const wrapperBinDir = process.env.BOT_WRAPPER_BIN_DIR || '';
  const realGh = findRealGh(wrapperBinDir);
  const repository = extractGhRepository(args);

  const grant = await fetchReadToken(helperUrl, helperSecret, repository);
  if (!grant?.token) {
    const detail = grant?.instruction || grant?.error || 'github_read_token_unavailable';
    process.stderr.write(`gh: short-lived GitHub read token unavailable (${detail}).\n`);
    process.exit(1);
  }

  const secrets = [grant.token, process.env.BOT_RUN_TOKEN].filter(s => typeof s === 'string' && s.length >= 8);
  const outMask = maskedStream(secrets, text => process.stdout.write(text));
  const errMask = maskedStream(secrets, text => process.stderr.write(text));

  const cleanEnv = { ...process.env };
  delete cleanEnv.BOT_CREDENTIAL_HELPER_SECRET;
  delete cleanEnv.BOT_CREDENTIAL_HELPER_URL;
  cleanEnv.GH_TOKEN = grant.token;
  cleanEnv.GITHUB_TOKEN = grant.token;
  cleanEnv.GH_PROMPT_DISABLED = '1';
  if (process.env.BOT_GITHUB_HOST && process.env.BOT_GITHUB_HOST !== 'github.com') {
    cleanEnv.GH_HOST = process.env.BOT_GITHUB_HOST;
    cleanEnv.GH_ENTERPRISE_TOKEN = grant.token;
  }

  const child = spawn(realGh, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: cleanEnv,
  });

  child.stdout.on('data', chunk => outMask.data(chunk));
  child.stderr.on('data', chunk => errMask.data(chunk));
  child.on('error', err => {
    errMask.data(Buffer.from(`gh: ${err.message}\n`, 'utf8'));
    outMask.end();
    errMask.end();
    process.exit(127);
  });
  child.on('close', (code, signal) => {
    outMask.end();
    errMask.end();
    if (signal) process.exit(128);
    process.exit(code ?? 1);
  });
}
