import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { maskedStream } from './command-output.mjs';

// Wrapper around the real `gh` CLI inside the container (#705):
// 1. Blocks `gh auth token` / `--show-token` so commands cannot ask `gh` to echo the raw credential.
// 2. Obtains a cached short-lived read-only repository token via `harness-entry.mjs`'s loopback helper.
// 3. Injects `GH_TOKEN`/`GITHUB_TOKEN` only into the spawned `gh` child process and masks any echoed token
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

function isTokenDumpCommand(args) {
  const positional = args.filter(a => !a.startsWith('-'));
  if (positional[0] === 'auth' && positional[1] === 'token') return true;
  if (args.some(a => a === '--show-token' || a.startsWith('--show-token='))) return true;
  return false;
}

async function fetchReadToken(helperUrl, helperSecret) {
  if (!helperUrl || !helperSecret) return { error: 'github_read_token_unavailable' };
  const res = await fetch(`${helperUrl.replace(/\/$/, '')}/github-read-token?purpose=gh`, {
    method: 'POST',
    headers: { 'x-bot-helper-secret': helperSecret },
    signal: AbortSignal.timeout(125_000),
  }).catch(() => null);
  if (!res) return { error: 'github_read_token_unavailable' };
  const body = await res.json().catch(() => ({ error: 'github_read_token_unavailable' }));
  return body || { error: 'github_read_token_unavailable' };
}

const args = process.argv.slice(2);
if (isTokenDumpCommand(args)) {
  process.stderr.write('gh: raw token inspection is disabled in Bot container runs; repository access uses short-lived read-only credentials automatically.\n');
  process.exit(1);
}

const helperUrl = process.env.BOT_CREDENTIAL_HELPER_URL || '';
const helperSecret = process.env.BOT_CREDENTIAL_HELPER_SECRET || '';
const wrapperBinDir = process.env.BOT_WRAPPER_BIN_DIR || '';
const realGh = findRealGh(wrapperBinDir);

const grant = await fetchReadToken(helperUrl, helperSecret);
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
