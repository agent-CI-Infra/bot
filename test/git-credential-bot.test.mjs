import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveGitCredential } from '../runner/git-credential-bot.mjs';

function runProcess(cmd, args, options = {}) {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c.toString('utf8'); });
    child.stderr.on('data', c => { stderr += c.toString('utf8'); });
    child.on('error', rejectDone);
    child.on('close', code => resolveDone({ code, stdout, stderr }));
    if (options.stdinText !== undefined) child.stdin.end(options.stdinText);
    else child.stdin.end();
  });
}

test('git-credential-bot exchanges short-lived token only for matching host and HTTPS (or explicit local HTTP)', async t => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, secret: req.headers['x-bot-helper-secret'] });
    if (req.headers['x-bot-helper-secret'] !== 'helper-secret-xyz') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'ghs_short_lived_ro_token_123456', expires_at: '2099-01-01T00:00:00Z' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const helperUrl = `http://127.0.0.1:${server.address().port}`;

  // Valid HTTPS request for configured host succeeds.
  const ok = await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=https\nhost=github.com\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: 'github.com',
  });
  assert.equal(ok, 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_short_lived_ro_token_123456\n\n');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/github-read-token?purpose=git');

  // Non-get operations, foreign hosts, and plain HTTP (without allowHttpHost) never call the helper.
  assert.equal(await resolveGitCredential({
    operation: 'store',
    stdinText: 'protocol=https\nhost=github.com\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: 'github.com',
  }), null);
  assert.equal(await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=https\nhost=evil.example.com\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: 'github.com',
  }), null);
  assert.equal(await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=http\nhost=github.com\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: 'github.com',
    allowHttpHost: false,
  }), null);
  assert.equal(requests.length, 1);

  // Explicit local HTTP fixture host is allowed when allowHttpHost=true.
  const httpLocal = await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=http\nhost=127.0.0.1:19000\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: '127.0.0.1:19000',
    allowHttpHost: true,
  });
  assert.equal(httpLocal, 'protocol=http\nhost=127.0.0.1:19000\nusername=x-access-token\npassword=ghs_short_lived_ro_token_123456\n\n');

  // Wrong helper secret returns null.
  assert.equal(await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=https\nhost=github.com\n\n',
    helperUrl,
    helperSecret: 'wrong-secret',
    allowedHost: 'github.com',
  }), null);
});

test('gh-wrapper blocks token-dump subcommands, strips helper env, and masks short-lived and run tokens from output', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-wrapper-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fakeGh = join(dir, 'fake-gh');
  writeFileSync(
    fakeGh,
    `#!${process.execPath}
const out = {
  args: process.argv.slice(2),
  hasHelperUrl: Boolean(process.env.BOT_CREDENTIAL_HELPER_URL),
  hasHelperSecret: Boolean(process.env.BOT_CREDENTIAL_HELPER_SECRET),
  ghHost: process.env.GH_HOST || null,
  echoedToken: process.env.GH_TOKEN,
  echoedRunToken: process.env.BOT_RUN_TOKEN,
};
process.stdout.write(JSON.stringify(out) + "\\n");
process.stderr.write("debug header Authorization: Bearer " + process.env.GH_TOKEN + "\\n");
`,
    { mode: 0o755 },
  );
  chmodSync(fakeGh, 0o755);

  let helperHits = 0;
  let grantPayload = { token: 'ghs_ephemeral_secret_token_999888', expires_at: '2099-01-01T00:00:00Z' };
  const server = createServer((req, res) => {
    helperHits += 1;
    res.writeHead(grantPayload.token ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(grantPayload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const helperUrl = `http://127.0.0.1:${server.address().port}`;

  const baseEnv = {
    ...process.env,
    BOT_REAL_GH_BIN: fakeGh,
    BOT_CREDENTIAL_HELPER_URL: helperUrl,
    BOT_CREDENTIAL_HELPER_SECRET: 'secret-abc',
    BOT_RUN_TOKEN: 'rrt_run_identity_secret_777666',
    BOT_GITHUB_HOST: 'ghe.internal.example',
  };

  // 1. `gh auth token` and `--show-token` are refused before contacting the credential helper.
  const dump1 = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'auth', 'token'], { env: baseEnv });
  assert.equal(dump1.code, 1);
  assert.match(dump1.stderr, /raw token inspection is disabled/);
  const dump2 = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'auth', 'status', '--show-token'], { env: baseEnv });
  assert.equal(dump2.code, 1);
  assert.equal(helperHits, 0);

  // 2. Normal read command receives GH_TOKEN, never sees helper URL/secret, and any echoed secrets are redacted.
  const ok = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'pr', 'view', '705'], { env: baseEnv });
  assert.equal(ok.code, 0);
  assert.equal(helperHits, 1);
  assert.equal(ok.stdout.includes('ghs_ephemeral_secret_token_999888'), false);
  assert.equal(ok.stderr.includes('ghs_ephemeral_secret_token_999888'), false);
  assert.equal(ok.stdout.includes('rrt_run_identity_secret_777666'), false);
  const parsed = JSON.parse(ok.stdout.trim());
  assert.deepEqual(parsed.args, ['pr', 'view', '705']);
  assert.equal(parsed.hasHelperUrl, false);
  assert.equal(parsed.hasHelperSecret, false);
  assert.equal(parsed.ghHost, 'ghe.internal.example');
  assert.equal(parsed.echoedToken, '[REDACTED]');
  assert.equal(parsed.echoedRunToken, '[REDACTED]');

  // 3. Structured-only / unavailable token surfaces clear instruction without leaking secrets.
  grantPayload = { error: 'structured_tools_only', instruction: 'Use bot MCP read tools for PAT repositories.' };
  const denied = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'issue', 'list'], { env: baseEnv });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Use bot MCP read tools for PAT repositories/);
});
