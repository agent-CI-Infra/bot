import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildGitConfigEnv, parseRepositoryPath, resolveGitCredential } from '../../../runner/git-credential-bot.mjs';
import { extractGhRepository } from '../../../runner/gh-wrapper.mjs';
import { startCredentialHelperServer } from '../../../runner/credential-helper.mjs';

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

test('parseRepositoryPath and buildGitConfigEnv enable per-repository HTTP credential paths safely', () => {
  assert.equal(parseRepositoryPath('acme/service.git'), 'acme/service');
  assert.equal(parseRepositoryPath('/acme/service.git'), 'acme/service');
  assert.equal(parseRepositoryPath('acme/service/info/refs'), 'acme/service');
  assert.equal(parseRepositoryPath('acme/service'), 'acme/service');
  for (const bad of ['', '/', 'only-owner', '../secret', 'acme/..', 'acme/repo with space', '.']) {
    assert.equal(parseRepositoryPath(bad), null, bad);
  }
  const env = buildGitConfigEnv({ PATH: '/usr/bin' }, '/opt/runner/git-credential-bot.mjs', false);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  const pairs = new Map();
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) pairs.set(env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]);
  assert.equal(pairs.get('core.hooksPath'), '/dev/null');
  assert.equal(pairs.get('core.fsmonitor'), 'false');
  assert.equal(pairs.get('credential.useHttpPath'), 'true');
  assert.match(pairs.get('credential.helper'), /git-credential-bot\.mjs$/);
});

test('git-credential-bot exchanges short-lived token for matching host, HTTPS/local HTTP, and repository path', async t => {
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

  // Valid HTTPS request without path (single-repo compatibility) succeeds.
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

  // With path (useHttpPath=true), forwards parsed owner/repo to the helper.
  const withPath = await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=https\nhost=github.com\npath=acme/private-app.git\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: 'github.com',
  });
  assert.equal(withPath, 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_short_lived_ro_token_123456\n\n');
  assert.equal(requests[1].url, '/github-read-token?purpose=git&repository=acme%2Fprivate-app');

  // Invalid path never calls the helper.
  assert.equal(await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=https\nhost=github.com\npath=../escape\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: 'github.com',
  }), null);
  assert.equal(requests.length, 2);

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
  assert.equal(requests.length, 2);

  // Explicit local HTTP fixture host is allowed when allowHttpHost=true.
  const httpLocal = await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=http\nhost=127.0.0.1:19000\npath=acme/local.git\n\n',
    helperUrl,
    helperSecret: 'helper-secret-xyz',
    allowedHost: '127.0.0.1:19000',
    allowHttpHost: true,
  });
  assert.equal(httpLocal, 'protocol=http\nhost=127.0.0.1:19000\nusername=x-access-token\npassword=ghs_short_lived_ro_token_123456\n\n');
  assert.equal(requests[2].url, '/github-read-token?purpose=git&repository=acme%2Flocal');

  // Wrong helper secret returns null.
  assert.equal(await resolveGitCredential({
    operation: 'get',
    stdinText: 'protocol=https\nhost=github.com\n\n',
    helperUrl,
    helperSecret: 'wrong-secret',
    allowedHost: 'github.com',
  }), null);
});

test('extractGhRepository resolves target repository from flags, api paths, repo subcommands, and GH_REPO', () => {
  const emptyCwd = mkdtempSync(join(tmpdir(), 'gh-extract-'));
  const ceilingEnv = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: resolve(emptyCwd, '..') };
  try {
    assert.equal(extractGhRepository(['pr', 'view', '12', '-R', 'acme/alpha'], { env: ceilingEnv, cwd: emptyCwd }), 'acme/alpha');
    assert.equal(extractGhRepository(['issue', 'list', '--repo=https://github.com/acme/beta.git'], { env: ceilingEnv, cwd: emptyCwd }), 'acme/beta');
    assert.equal(extractGhRepository(['pr', 'list', '-Racme/gamma'], { env: ceilingEnv, cwd: emptyCwd }), 'acme/gamma');
    assert.equal(extractGhRepository(['api', 'repos/acme/delta/pulls/5'], { env: ceilingEnv, cwd: emptyCwd }), 'acme/delta');
    assert.equal(extractGhRepository(['api', '/repos/acme/delta/contents/README.md'], { env: ceilingEnv, cwd: emptyCwd }), 'acme/delta');
    assert.equal(extractGhRepository(['repo', 'clone', 'acme/epsilon', '/workspace/epsilon'], { env: ceilingEnv, cwd: emptyCwd }), 'acme/epsilon');
    assert.equal(extractGhRepository(['issue', 'list'], { env: { ...ceilingEnv, GH_REPO: 'acme/from-env' }, cwd: emptyCwd }), 'acme/from-env');
    assert.equal(extractGhRepository(['pr', 'list', '-R', 'https://evil.example/acme/alpha'], { env: ceilingEnv, cwd: emptyCwd }), null);
    assert.equal(extractGhRepository(['issue', 'list'], { env: ceilingEnv, cwd: emptyCwd }), null);
  } finally {
    rmSync(emptyCwd, { recursive: true, force: true });
  }
});

test('gh-wrapper blocks token-dump subcommands, forwards repository query, strips helper env, and masks tokens', async t => {
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

  const helperUrls = [];
  let grantPayload = { token: 'ghs_ephemeral_secret_token_999888', expires_at: '2099-01-01T00:00:00Z' };
  const server = createServer((req, res) => {
    helperUrls.push(req.url);
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
  const dump1 = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'auth', 'token'], { env: baseEnv, cwd: dir });
  assert.equal(dump1.code, 1);
  assert.match(dump1.stderr, /raw token inspection is disabled/);
  const dump2 = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'auth', 'status', '--show-token'], { env: baseEnv, cwd: dir });
  assert.equal(dump2.code, 1);
  assert.equal(helperUrls.length, 0);

  // 2. Normal read command with -R forwards repository, strips helper env, and masks echoed secrets.
  const ok = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'pr', 'view', '705', '-R', 'acme/repo-one'], { env: baseEnv, cwd: dir });
  assert.equal(ok.code, 0);
  assert.deepEqual(helperUrls, ['/github-read-token?purpose=gh&repository=acme%2Frepo-one']);
  assert.equal(ok.stdout.includes('ghs_ephemeral_secret_token_999888'), false);
  assert.equal(ok.stderr.includes('ghs_ephemeral_secret_token_999888'), false);
  assert.equal(ok.stdout.includes('rrt_run_identity_secret_777666'), false);
  const parsed = JSON.parse(ok.stdout.trim());
  assert.deepEqual(parsed.args, ['pr', 'view', '705', '-R', 'acme/repo-one']);
  assert.equal(parsed.hasHelperUrl, false);
  assert.equal(parsed.hasHelperSecret, false);
  assert.equal(parsed.ghHost, 'ghe.internal.example');
  assert.equal(parsed.echoedToken, '[REDACTED]');
  assert.equal(parsed.echoedRunToken, '[REDACTED]');

  // 3. Structured-only / unavailable token surfaces clear instruction without leaking secrets.
  grantPayload = { error: 'structured_tools_only', instruction: 'Use bot MCP read tools for PAT repositories.' };
  const denied = await runProcess(process.execPath, [resolve('runner/gh-wrapper.mjs'), 'issue', 'list'], { env: baseEnv, cwd: dir });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Use bot MCP read tools for PAT repositories/);
});

test('credential-helper caches and isolates tokens by (purpose, repository)', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'cred-helper-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  mkdirSync(join(agentDir, 'token-requests'), { recursive: true });
  mkdirSync(join(agentDir, 'token-replies'), { recursive: true });

  const secrets = [];
  const seen = [];
  const helper = await startCredentialHelperServer({
    agentDir,
    runToken: 'rrt_test_run_token_123456',
    addSecret: s => secrets.push(s),
  });
  t.after(() => helper.close());

  let responderStop = false;
  const responder = (async () => {
    while (!responderStop) {
      const files = readdirSync(join(agentDir, 'token-requests')).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const reqPath = join(agentDir, 'token-requests', file);
        const req = JSON.parse(readFileSync(reqPath, 'utf8'));
        if (seen.some(s => s.id === req.id)) continue;
        seen.push(req);
        const reply = {
          token: `ghs_${req.purpose}_${(req.repository || 'default').replace('/', '_')}_tok12345`,
          expires_at: '2099-01-01T00:00:00Z',
          repository: req.repository || 'default/repo',
        };
        writeFileSync(join(agentDir, 'token-replies', `${req.id}.json`), JSON.stringify(reply));
      }
      await new Promise(r => setTimeout(r, 15));
    }
  })();
  t.after(async () => { responderStop = true; await responder; });

  const ask = async (query) => {
    const res = await fetch(`${helper.url}/github-read-token?${query}`, {
      method: 'POST',
      headers: { 'x-bot-helper-secret': helper.secret },
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  const gitA1 = await ask('purpose=git&repository=Acme/RepoA');
  const gitA2 = await ask('purpose=git&repository=acme/repoa');
  const gitB = await ask('purpose=git&repository=acme/repoB');
  const ghA = await ask('purpose=gh&repository=acme/repoA');

  assert.equal(gitA1.token, gitA2.token, 'same (purpose, repository) hits cache case-insensitively');
  assert.notEqual(gitA1.token, gitB.token, 'different repositories never share cached tokens');
  assert.notEqual(gitA1.token, ghA.token, 'different purposes never share cached tokens');
  assert.equal(seen.length, 3);
  assert.ok(secrets.includes(gitA1.token) && secrets.includes(gitB.token) && secrets.includes(ghA.token));
});
