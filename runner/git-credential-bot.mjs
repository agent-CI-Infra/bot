// Git credential helper for in-container CLI harnesses (#705, #1279).
// Answers `get` for the configured GitHub host by requesting a cached short-lived read-only repository token
// from `runner/harness-entry.mjs` or `runner/pi-entry.mjs`'s local loopback helper. Never stores or writes credentials to disk.

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Extracts `owner/repo` from Git's `path` credential attribute (enabled via `credential.useHttpPath=true`).
 * Accepts `owner/repo`, `owner/repo.git`, `/owner/repo.git`, or deeper paths like `owner/repo.git/info/refs`.
 * Returns null if missing or invalid.
 */
export function parseRepositoryPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const cleaned = rawPath.trim().replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null;
  return `${owner}/${repo}`;
}

export function buildGitConfigEnv(existingEnv, gitCredentialScript, allowHttp = false) {
  const entries = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['commit.gpgsign', 'false'],
    ['gc.auto', '0'],
    ['credential.useHttpPath', 'true'],
    ['credential.helper', `!${process.execPath} ${gitCredentialScript}`],
  ];
  if (allowHttp) entries.push(['http.extraHeader', '']);
  const out = { ...existingEnv, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k;
    out[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return out;
}

function parseCredentialInput(raw) {
  const attrs = new Map();
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line) break;
    const eq = line.indexOf('=');
    if (eq > 0) attrs.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return attrs;
}

export async function resolveGitCredential({
  operation,
  stdinText,
  helperUrl = process.env.BOT_CREDENTIAL_HELPER_URL || '',
  helperSecret = process.env.BOT_CREDENTIAL_HELPER_SECRET || '',
  allowedHost = process.env.BOT_GITHUB_HOST || 'github.com',
  allowHttpHost = process.env.BOT_ALLOW_HTTP_GIT_CREDENTIAL === 'true',
  fetcher = fetch,
}) {
  if (operation !== 'get' || !helperUrl || !helperSecret) return null;
  const attrs = parseCredentialInput(stdinText);
  const protocol = (attrs.get('protocol') || '').toLowerCase();
  const host = (attrs.get('host') || '').toLowerCase();
  const expectedHost = String(allowedHost || 'github.com').toLowerCase();
  if (!host || host !== expectedHost) return null;
  if (protocol !== 'https' && !(allowHttpHost && protocol === 'http')) return null;

  const rawPath = attrs.get('path');
  const repository = rawPath ? parseRepositoryPath(rawPath) : null;
  if (rawPath && !repository) return null;

  const query = new URLSearchParams({ purpose: 'git' });
  if (repository) query.set('repository', repository);
  const res = await fetcher(`${helperUrl.replace(/\/$/, '')}/github-read-token?${query.toString()}`, {
    method: 'POST',
    headers: { 'x-bot-helper-secret': helperSecret },
    signal: AbortSignal.timeout(125_000),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body || typeof body.token !== 'string' || !body.token) return null;
  return `protocol=${protocol}\nhost=${host}\nusername=x-access-token\npassword=${body.token}\n\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const operation = process.argv[2] || '';
  if (operation !== 'get') process.exit(0);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const out = await resolveGitCredential({
    operation,
    stdinText: Buffer.concat(chunks).toString('utf8'),
  }).catch(() => null);
  if (out) process.stdout.write(out);
}
