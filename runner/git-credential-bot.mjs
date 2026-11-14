// Git credential helper for in-container CLI harnesses (#705).
// Answers `get` for the configured GitHub host by requesting a cached short-lived read-only repository token
// from `runner/harness-entry.mjs`'s local loopback helper. Never stores or writes credentials to disk.

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

  const res = await fetcher(`${helperUrl.replace(/\/$/, '')}/github-read-token?purpose=git`, {
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
