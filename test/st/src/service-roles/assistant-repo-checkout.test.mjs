import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { GitCache } from '../../../../dist/agent/git-cache.js';
import { ScopedReadTokens } from '../../../../dist/harness/container-session.js';
import { executeCheckoutRepository, normalizeCheckoutDestination } from '../../../../dist/service-roles/checkout.js';
import { AssistantComputers, assistantDefaults } from '../../../../manager/assistant-computers.mjs';
import { Projects, resourceBounds } from '../../../../manager/projects.mjs';
import { FakeDocker } from '../../../fixtures/fake-docker.mjs';
import { assistantFile } from '../../../../runner/assistant-files.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const appPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function createMockGitHub(t, repos) {
  const minted = [];
  const revoked = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : {};
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.method === 'DELETE' && url.pathname === '/installation/token') {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      revoked.push(tok);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/app') {
      return json(200, { id: 1, slug: 'test-launchpad-bot' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/users/')) {
      return json(200, { id: 9001, login: 'test-launchpad-bot[bot]' });
    }
    if (req.method === 'GET' && url.pathname === '/user') {
      return json(200, { id: 9002, login: 'pat-bot-user' });
    }
    const instMatch = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname);
    if (req.method === 'GET' && instMatch) {
      const repo = repos.find(r => r.full_name.toLowerCase() === instMatch[1].toLowerCase());
      if (!repo) return json(404, { message: 'Not Found' });
      return json(200, {
        id: Number(repo.installation_id || 700),
        account: { id: Number(repo.owner_id), login: repo.full_name.split('/')[0] },
        permissions: { contents: 'read', metadata: 'read', issues: 'read', pull_requests: 'read', actions: 'read' },
        events: ['issues', 'pull_request'],
      });
    }
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (req.method === 'POST' && tokenMatch) {
      const repoId = String(body.repository_ids?.[0] ?? '');
      const repo = repos.find(r => r.id === repoId);
      const token = `ghs_ro_${repoId}_${minted.length + 1}_${'x'.repeat(16)}`;
      minted.push({ repoId, fullName: repo?.full_name, permissions: body.permissions, token });
      return json(201, {
        token,
        expires_at: '2099-01-01T00:00:00Z',
        permissions: body.permissions,
      });
    }
    const repoByIdMatch = /^\/repositories\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && repoByIdMatch) {
      const repo = repos.find(r => r.id === repoByIdMatch[1]);
      if (!repo) return json(404, { message: 'Not Found' });
      return json(200, {
        id: Number(repo.id),
        full_name: repo.full_name,
        owner: { id: Number(repo.owner_id), login: repo.full_name.split('/')[0] },
        default_branch: repo.default_branch || 'main',
        clone_url: repo.clone_url || '',
      });
    }
    const prMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && prMatch) {
      const repo = repos.find(r => r.full_name.toLowerCase() === prMatch[1].toLowerCase());
      const pr = repo?.prs?.[prMatch[2]];
      if (!pr) return json(404, { message: 'Not Found' });
      return json(200, pr);
    }
    const commitMatch = /^\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && commitMatch) {
      const repo = repos.find(r => r.full_name.toLowerCase() === commitMatch[1].toLowerCase());
      const ref = decodeURIComponent(commitMatch[2]);
      const sha = repo?.refs?.[ref];
      if (!sha) return json(404, { message: 'Not Found' });
      return json(200, { sha });
    }
    const gitCommitMatch = /^\/repos\/([^/]+\/[^/]+)\/git\/commits\/([a-f0-9]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && gitCommitMatch) {
      const repo = repos.find(r => r.full_name.toLowerCase() === gitCommitMatch[1].toLowerCase());
      const treeSha = repo?.commitTrees?.[gitCommitMatch[2]];
      if (!treeSha) return json(404, { message: 'Not Found' });
      return json(200, { sha: gitCommitMatch[2], tree: { sha: treeSha } });
    }
    const gitTreeMatch = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([a-f0-9]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && gitTreeMatch) {
      const repo = repos.find(r => r.full_name.toLowerCase() === gitTreeMatch[1].toLowerCase());
      const tree = repo?.trees?.[gitTreeMatch[2]];
      if (!tree) return json(404, { message: 'Not Found' });
      return json(200, { sha: gitTreeMatch[2], truncated: false, tree });
    }
    const gitBlobMatch = /^\/repos\/([^/]+\/[^/]+)\/git\/blobs\/([a-f0-9]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && gitBlobMatch) {
      const repo = repos.find(r => r.full_name.toLowerCase() === gitBlobMatch[1].toLowerCase());
      const content = repo?.blobs?.[gitBlobMatch[2]];
      if (content === undefined) return json(404, { message: 'Not Found' });
      return json(200, { sha: gitBlobMatch[2], encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    return json(404, { message: `Unhandled ${req.method} ${url.pathname}` });
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    t.after(() => server.close());
    return {
      url: `http://127.0.0.1:${server.address().port}`,
      minted,
      revoked,
    };
  });
}

function seedStore(t, accounts, repositories) {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-checkout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'control.sqlite'), Buffer.alloc(32, 7));
  t.after(() => store.close());
  for (const acc of accounts) {
    store.run(
      'INSERT INTO accounts(id,name,type,app_id,credentials,created_at) VALUES(?,?,?,?,?,?)',
      acc.id, acc.name, acc.type, acc.app_id ?? null,
      store.secrets.seal(acc.credentials, `account:${acc.id}`),
      '2026-01-01T00:00:00.000Z',
    );
  }
  for (const repo of repositories) {
    store.run(
      'INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES(?,?,?,?)',
      repo.id, repo.full_name, repo.owner_id, repo.account_id,
    );
  }
  return { dir, store };
}

test('ScopedReadTokens issues per-repo short-lived tokens for multi-repo assistants, enforces scopes, redacts, and revokes all', async t => {
  const repos = [
    { id: '101', full_name: 'acme/alpha', owner_id: '500', account_id: 'acc-app' },
    { id: '102', full_name: 'acme/beta', owner_id: '500', account_id: 'acc-app' },
    { id: '103', full_name: 'acme/pat-repo', owner_id: '500', account_id: 'acc-pat' },
    { id: '104', full_name: 'other/secret', owner_id: '600', account_id: 'acc-app' },
  ];
  const gh = await createMockGitHub(t, repos);
  const { store } = seedStore(t, [
    { id: 'acc-app', name: 'App', type: 'github_app', app_id: '42', credentials: { private_key: appPem } },
    { id: 'acc-pat', name: 'PAT', type: 'bot_account', credentials: { token: 'ghp_super_secret_pat_value_999999' } },
  ], repos);

  const allowedNames = new Set(['acme/alpha', 'acme/beta', 'acme/pat-repo']);
  let liveScopes = ['contents', 'issues', 'pull_requests'];
  const redactor = new Redactor();
  const denied = [];

  const broker = new ScopedReadTokens({
    store,
    task: { id: 'turn-1', repository_id: null },
    redactor,
    guard: async () => {},
    system: '',
    prompt: '',
    onDenied: (tool, reason) => denied.push({ tool, reason }),
    containerOptions: {
      githubApiUrl: gh.url,
      resolveGithubRepository: name => {
        if (!name || !allowedNames.has(name.toLowerCase())) return null;
        return store.get('SELECT * FROM repositories WHERE lower(full_name)=?', name.toLowerCase()) ?? null;
      },
      githubReadScopes: () => liveScopes,
    },
  });

  assert.equal(broker.available, true);

  // Missing repository in multi-repo mode asks caller to specify repository.
  const missingRepo = await broker.issue('git');
  assert.equal(missingRepo.error, 'repository_required');

  // Out-of-scope repository is rejected.
  const outOfScope = await broker.issue('git', 'other/secret');
  assert.equal(outOfScope.error, 'repository_out_of_scope');

  // Authorized repo A (git): strictly contents:read + metadata:read, registered in redactor.
  const tokA = await broker.issue('git', 'acme/alpha');
  assert.ok(typeof tokA.token === 'string' && tokA.token.startsWith('ghs_ro_101_'));
  assert.deepEqual(tokA.permissions, { contents: 'read', metadata: 'read' });
  assert.equal(redactor.text(`leaked ${tokA.token}`), 'leaked [REDACTED]');

  // Authorized repo B (gh): includes allowed read scopes only.
  const tokB = await broker.issue('gh', 'acme/beta');
  assert.ok(typeof tokB.token === 'string' && tokB.token.startsWith('ghs_ro_102_'));
  assert.equal(tokB.permissions.contents, 'read');
  assert.equal(tokB.permissions.issues, 'read');
  assert.equal(redactor.text(`leaked ${tokB.token}`), 'leaked [REDACTED]');

  // PAT repository refuses container token and instructs checkout_repository without leaking PAT.
  const patReply = await broker.issue('git', 'acme/pat-repo');
  assert.equal(patReply.error, 'github_app_required');
  assert.match(String(patReply.instruction), /checkout_repository/);
  assert.equal(JSON.stringify(patReply).includes('ghp_super_secret_pat_value_999999'), false);

  // Removing contents scope blocks git token dynamically.
  liveScopes = ['issues'];
  const noContents = await broker.issue('git', 'acme/alpha');
  assert.equal(noContents.error, 'github_read_token_not_allowed');

  // Revoke tears down every minted token across all accessed repositories.
  await broker.revoke();
  assert.ok(gh.revoked.includes(tokA.token));
  assert.ok(gh.revoked.includes(tokB.token));
  assert.ok(denied.some(d => d.reason === 'repository_out_of_scope'));
  assert.ok(denied.some(d => d.reason === 'github_read_token_not_allowed'));
});

test('checkout_repository checks out default branch, PR ref, and PAT repo via GitCache and API fallback without leaking credentials', async t => {
  const patSecret = 'ghp_pat_never_leaves_control_plane_12345';
  const mainSha = '1'.repeat(40);
  const prSha = '2'.repeat(40);
  const mainTreeSha = 'a'.repeat(40);
  const prTreeSha = 'b'.repeat(40);
  const blob1 = 'c'.repeat(40);
  const blob2 = 'd'.repeat(40);

  const repos = [
    {
      id: '201',
      full_name: 'acme/app-repo',
      owner_id: '500',
      account_id: 'acc-app',
      default_branch: 'main',
      refs: { main: mainSha, [mainSha]: mainSha, [prSha]: prSha },
      prs: { '42': { number: 42, head: { sha: prSha, ref: 'feat/untrusted' } } },
      commitTrees: { [mainSha]: mainTreeSha, [prSha]: prTreeSha },
      trees: {
        [mainTreeSha]: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob1 }],
        [prTreeSha]: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob2 }],
      },
      blobs: { [blob1]: 'hello from main\n', [blob2]: 'hello from pr 42\n' },
    },
    {
      id: '202',
      full_name: 'acme/pat-private',
      owner_id: '500',
      account_id: 'acc-pat',
      default_branch: 'main',
      refs: { main: mainSha },
      commitTrees: { [mainSha]: mainTreeSha },
      trees: { [mainTreeSha]: [{ path: 'index.js', mode: '100644', type: 'blob', sha: blob1 }] },
      blobs: { [blob1]: 'export const ok = true;\n' },
    },
  ];
  const gh = await createMockGitHub(t, repos);
  const { dir, store } = seedStore(t, [
    { id: 'acc-app', name: 'App', type: 'github_app', app_id: '42', credentials: { private_key: appPem } },
    { id: 'acc-pat', name: 'PAT', type: 'bot_account', credentials: { token: patSecret } },
  ], repos);

  // Destination validation strictly blocks HOME (~ / /home/assistant), roots, and traversal.
  assert.equal(normalizeCheckoutDestination(undefined, 'acme/app-repo'), '/workspace/app-repo');
  assert.equal(normalizeCheckoutDestination('my-dir', 'acme/app-repo'), '/workspace/my-dir');
  assert.equal(normalizeCheckoutDestination('/tmp/build-dir', 'acme/app-repo'), '/tmp/build-dir');
  for (const bad of ['~', '~/repo', '/home/assistant/repo', '/workspace', '/tmp', '../escape', '/workspace/../etc/passwd', '/etc/app']) {
    assert.throws(() => normalizeCheckoutDestination(bad, 'acme/app-repo'), /invalid_destination/, bad);
  }

  // Capture archives delivered to the assistant computer and verify contents + zero credential leakage.
  const extractedCalls = [];
  const fakeComputer = {
    async extractArchive(archive, destination, opts) {
      const buf = Buffer.isBuffer(archive) ? archive : readFileSync(archive.file);
      assert.equal(buf.toString('latin1').includes(patSecret), false, 'PAT must never appear in archive');
      const unpackDir = mkdtempSync(join(dir, 'unpack-'));
      const tarFile = join(unpackDir, 'in.tar.gz');
      writeFileSync(tarFile, buf);
      execFileSync('tar', ['-xzf', tarFile, '-C', unpackDir]);
      const files = execFileSync('tar', ['-tzf', tarFile], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      extractedCalls.push({ destination, opts, files, unpackDir });
      return { path: destination, files: files.length, bytes: buf.length };
    },
  };

  const resolveRepo = name => {
    const row = store.get('SELECT * FROM repositories WHERE lower(full_name)=?', String(name).toLowerCase());
    if (!row) throw Object.assign(new Error('repository_not_found'), { status: 404, code: 'repository_not_found' });
    return row;
  };

  // 1. Default branch checkout via API fallback (trusted_checkout: true) + App token revoked.
  const resMain = await executeCheckoutRepository({
    store,
    redactor: new Redactor(),
    guard: async () => {},
    resolveRepository: resolveRepo,
    scopes: () => ['contents', 'pull_requests'],
    computer: fakeComputer,
    apiUrl: gh.url,
  }, { repository: 'acme/app-repo' });
  assert.equal(resMain.trusted_checkout, true);
  assert.equal(resMain.path, '/workspace/app-repo');
  assert.equal(resMain.commit_sha, mainSha);
  assert.equal(readFileSync(join(extractedCalls[0].unpackDir, 'README.md'), 'utf8'), 'hello from main\n');
  assert.equal(gh.revoked.length, 1, 'short-lived App token revoked immediately after checkout');

  // 2. PR checkout marks untrusted_checkout and requires pull_requests read scope.
  const deniedPr = await executeCheckoutRepository({
    store,
    redactor: new Redactor(),
    guard: async () => {},
    resolveRepository: resolveRepo,
    scopes: () => ['contents'],
    computer: fakeComputer,
    apiUrl: gh.url,
  }, { repository: 'acme/app-repo', ref: 'pr/42' });
  assert.equal(deniedPr.error, 'github_read_token_not_allowed');

  const resPr = await executeCheckoutRepository({
    store,
    redactor: new Redactor(),
    guard: async () => {},
    resolveRepository: resolveRepo,
    scopes: () => ['contents', 'pull_requests'],
    computer: fakeComputer,
    apiUrl: gh.url,
  }, { repository: 'acme/app-repo', ref: 'pr/42', destination: '/tmp/pr-42', overwrite: true });
  assert.equal(resPr.trusted_checkout, false);
  assert.match(String(resPr.untrusted_notice), /untrusted data/);
  assert.equal(resPr.path, '/tmp/pr-42');
  assert.equal(readFileSync(join(extractedCalls[1].unpackDir, 'README.md'), 'utf8'), 'hello from pr 42\n');

  // 3. PAT account repository succeeds via checkout_repository without leaking PAT.
  const resPat = await executeCheckoutRepository({
    store,
    redactor: new Redactor(),
    guard: async () => {},
    resolveRepository: resolveRepo,
    scopes: () => ['contents'],
    computer: fakeComputer,
    apiUrl: gh.url,
  }, { repository: 'acme/pat-private', destination: 'pat-checkout' });
  assert.equal(resPat.repository, 'acme/pat-private');
  assert.equal(resPat.path, '/workspace/pat-checkout');
  assert.equal(JSON.stringify(resPat).includes(patSecret), false);
  assert.equal(readFileSync(join(extractedCalls[2].unpackDir, 'index.js'), 'utf8'), 'export const ok = true;\n');

  // 4. Missing contents scope is refused.
  const noContents = await executeCheckoutRepository({
    store,
    redactor: new Redactor(),
    guard: async () => {},
    resolveRepository: resolveRepo,
    scopes: () => ['issues'],
    computer: fakeComputer,
    apiUrl: gh.url,
  }, { repository: 'acme/app-repo' });
  assert.equal(noContents.error, 'github_read_token_not_allowed');
});

test('GitCache.archive exports a fixed commit without .git directory and integrates with checkout_repository', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitcache-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheDir = join(dir, 'git-cache');
  const cache = new GitCache(cacheDir);
  const mirrorDir = cache.path('301');
  const srcRepo = join(dir, 'src-repo');
  mkdirSync(srcRepo, { recursive: true });
  const git = (args, cwd = srcRepo) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();

  git(['init', '-b', 'main']);
  writeFileSync(join(srcRepo, 'hello.txt'), 'from git cache\n');
  git(['add', 'hello.txt']);
  git(['commit', '-m', 'init']);
  const sha = git(['rev-parse', 'HEAD']);

  // Seed bare mirror directly (simulating a warm GitCache hit).
  mkdirSync(cacheDir, { recursive: true });
  execFileSync('git', ['clone', '--bare', srcRepo, mirrorDir]);
  execFileSync('git', ['update-ref', `refs/bot/commits/${sha}`, sha], { cwd: mirrorDir });

  const archived = await cache.archive('301', sha);
  t.after(() => rmSync(archived.file, { force: true }));
  assert.ok(archived.size > 0);
  const listed = execFileSync('tar', ['-tzf', archived.file], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(listed, ['hello.txt']);
  assert.equal(listed.some(name => name.includes('.git')), false, 'git archive never includes .git/hooks');
});

test('global and assistant computer resource defaults are 16 GB RAM and 20 GB ephemeral disk space, with inheritance aligned', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'defaults-20g-16g-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const homes = join(dir, 'homes');
  mkdirSync(homes, { recursive: true });
  const docker = new FakeDocker();
  docker.homesMount = homes;
  docker.info = { NCPU: 16, MemTotal: 64 * 1024 ** 3 };

  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(() => projects.db.close());
  const assistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'fixture',
    image: 'approved',
    homes,
    globalEnvironment: () => projects.assistantGlobalEnvironment(),
  });

  // Bounds raised to 65536 MB for tmp_mb / workspace_mb.
  assert.deepEqual(resourceBounds.tmp_mb, [16, 65536]);
  assert.equal(assistantDefaults.memory_mb, 16384);
  assert.equal(assistantDefaults.tmp_mb, 20480);
  assert.equal(assistantDefaults.workspace_mb, 20480);

  // Global defaults have 16 GB RAM and RAM-safe 4 GB tmpfs; assistant settings inherit 16 GB RAM and keep 20 GB disk-backed /workspace & /tmp.
  assert.deepEqual(projects.resourceDefaults(), { cpus: 2, memory_mb: 16384, pids: 1024, tmp_mb: 4096 });
  const effective = assistants.settings();
  assert.equal(effective.memory_mb, 16384);
  assert.equal(effective.tmp_mb, 20480);
  assert.equal(effective.workspace_mb, 20480);

  // Acquired assistant container uses ephemeral disk volumes (not tmpfs) so 20G space does not exhaust 16G RAM.
  const owner = 'a'.repeat(32);
  mkdirSync(join(homes, owner, 'home-1'), { recursive: true });
  await assistants.acquire(owner, { turn: 't-20g', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  const container = docker.containers.get(assistants.name(owner));
  assert.equal(container.HostConfig.Memory, 16384 * 1024 * 1024);
  assert.equal(container.HostConfig.MemorySwap, 16384 * 1024 * 1024);
  assert.equal(container.HostConfig.Tmpfs, undefined);
  assert.ok(container.HostConfig.Mounts.some(m => m.Target === '/workspace' && m.Source === assistants.workspaceVolumeName(owner)));
  assert.ok(container.HostConfig.Mounts.some(m => m.Target === '/tmp' && m.Source === assistants.tmpVolumeName(owner)));

  // Removal cleans up both container and ephemeral scratch volumes with zero leaks.
  await assistants.remove(owner);
  await Promise.all([...assistants.removing.values()]);
  assert.equal(docker.containers.has(assistants.name(owner)), false);
  assert.equal(docker.volumes.has(assistants.workspaceVolumeName(owner)), false);
  assert.equal(docker.volumes.has(assistants.tmpVolumeName(owner)), false);
});

test('runner assistant_archive_stage and assistant_archive_extract unpack safely and reject traversal, escaping symlinks, HOME target, and over-limit archives', async t => {
  const sandbox = mkdtempSync(join(tmpdir(), 'assistant-extract-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const workspaceRoot = join(sandbox, 'workspace');
  const tmpRoot = join(sandbox, 'tmp');
  const homeRoot = join(sandbox, 'home');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });
  const opts = { workspaceRoot, tmpRoot, homeRoot, env: { BOT_WORKSPACE_LIMIT_MB: '10', BOT_TMP_LIMIT_MB: '10' } };

  const stageAndExtract = async (tarGzBuf, destination, extra = {}) => {
    const stageId = (extra.stageId || 'a'.repeat(46) + String(Math.floor(Math.random() * 90 + 10))).slice(0, 48);
    for (let offset = 0; offset < tarGzBuf.length; offset += 20000) {
      await assistantFile({
        type: 'assistant_archive_stage',
        stage_id: stageId,
        base64: tarGzBuf.subarray(offset, offset + 20000).toString('base64'),
        offset,
      }, extra.opts || opts);
    }
    return assistantFile({
      type: 'assistant_archive_extract',
      stage_id: stageId,
      destination,
      overwrite: extra.overwrite === true,
    }, extra.opts || opts);
  };

  // Build a valid tar.gz archive from a temp source folder.
  const srcOk = join(sandbox, 'src-ok');
  mkdirSync(join(srcOk, 'sub'), { recursive: true });
  writeFileSync(join(srcOk, 'hello.txt'), 'hello world\n');
  writeFileSync(join(srcOk, 'sub', 'a.txt'), 'nested\n');
  const okTarPath = join(sandbox, 'ok.tar.gz');
  execFileSync('tar', ['-czf', okTarPath, '-C', srcOk, '.']);
  const okTar = readFileSync(okTarPath);

  // 1. Valid extract into /workspace/demo succeeds and cleans up stage file.
  const extracted = await stageAndExtract(okTar, join(workspaceRoot, 'demo'));
  assert.equal(extracted.path, join(workspaceRoot, 'demo'));
  assert.equal(extracted.files, 2);
  assert.equal(readFileSync(join(workspaceRoot, 'demo', 'hello.txt'), 'utf8'), 'hello world\n');
  assert.equal(readFileSync(join(workspaceRoot, 'demo', 'sub', 'a.txt'), 'utf8'), 'nested\n');

  // 2. Existing destination without overwrite fails with destination_exists; with overwrite=true replaces cleanly.
  await assert.rejects(stageAndExtract(okTar, join(workspaceRoot, 'demo'), { overwrite: false }), /destination_exists/);
  const replaced = await stageAndExtract(okTar, join(workspaceRoot, 'demo'), { overwrite: true });
  assert.equal(replaced.files, 2);

  // 3. HOME destination is strictly refused.
  await assert.rejects(stageAndExtract(okTar, join(homeRoot, 'repo')), /invalid_path/);

  // 4. Escaping symlink inside archive is refused and leaves no target behind.
  const srcLink = join(sandbox, 'src-link');
  mkdirSync(srcLink, { recursive: true });
  execFileSync('ln', ['-s', '../../etc/passwd', join(srcLink, 'evil-link')]);
  const linkTarPath = join(sandbox, 'link.tar.gz');
  execFileSync('tar', ['-czf', linkTarPath, '-C', srcLink, '.']);
  await assert.rejects(stageAndExtract(readFileSync(linkTarPath), join(workspaceRoot, 'evil-target')), /unsafe_archive_symlink/);
  assert.equal(existsSync(join(workspaceRoot, 'evil-target')), false);

  // 5. Configured BOT_WORKSPACE_LIMIT_MB blocks oversized archives with ENOSPC.
  const bigSrc = join(sandbox, 'src-big');
  mkdirSync(bigSrc, { recursive: true });
  writeFileSync(join(bigSrc, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0x41));
  const bigTarPath = join(sandbox, 'big.tar.gz');
  execFileSync('tar', ['-czf', bigTarPath, '-C', bigSrc, '.']);
  await assert.rejects(
    stageAndExtract(readFileSync(bigTarPath), join(workspaceRoot, 'too-big'), {
      opts: { workspaceRoot, tmpRoot, homeRoot, env: { BOT_WORKSPACE_LIMIT_MB: '1', BOT_TMP_LIMIT_MB: '1' } },
    }),
    /ENOSPC/,
  );

  // 6. Invalid stage id is rejected.
  await assert.rejects(
    assistantFile({ type: 'assistant_archive_stage', stage_id: 'bad-id', base64: '', offset: 0 }, opts),
    /invalid_stage_id/,
  );

  // 7. assistant_write enforces soft limit via cached usage (no per-chunk tree walk) and does not double-count multi-chunk appends.
  const writeRoot = join(sandbox, 'write-ws');
  const writeTmp = join(sandbox, 'write-tmp');
  mkdirSync(writeRoot, { recursive: true });
  mkdirSync(writeTmp, { recursive: true });
  let measureCalls = 0;
  const writeOpts = {
    workspaceRoot: writeRoot,
    tmpRoot: writeTmp,
    homeRoot,
    env: { BOT_WORKSPACE_LIMIT_MB: '0.5' }, // 512 KiB soft limit
    measureUsage: async () => { measureCalls++; return 0; },
  };
  const chunk40k = Buffer.alloc(40 * 1024, 0x61);
  // Append 10 chunks = 400 KiB (< 512 KiB). Must succeed without double-counting and scan only once.
  for (let i = 0; i < 10; i++) {
    const res = await assistantFile({
      type: 'assistant_write',
      path: join(writeRoot, 'stream.bin'),
      base64: chunk40k.toString('base64'),
      offset: i * chunk40k.length,
    }, writeOpts);
    assert.equal(res.size, (i + 1) * chunk40k.length);
  }
  assert.equal(measureCalls, 1, 'cached usage avoids walking the volume on every 40 KiB chunk');
  assert.equal(readFileSync(join(writeRoot, 'stream.bin')).length, 400 * 1024);
  // Appending 4 more chunks pushes past 512 KiB -> refused cleanly at chunk 13 (520 KiB > 512 KiB).
  await assistantFile({ type: 'assistant_write', path: join(writeRoot, 'stream.bin'), base64: chunk40k.toString('base64'), offset: 10 * chunk40k.length }, writeOpts);
  await assistantFile({ type: 'assistant_write', path: join(writeRoot, 'stream.bin'), base64: chunk40k.toString('base64'), offset: 11 * chunk40k.length }, writeOpts);
  await assert.rejects(
    assistantFile({ type: 'assistant_write', path: join(writeRoot, 'stream.bin'), base64: chunk40k.toString('base64'), offset: 12 * chunk40k.length }, writeOpts),
    /ENOSPC/,
  );
  assert.equal(measureCalls, 1, 'subsequent chunks continue using cached incremental accounting');

  // 8. Overwrite extraction accounts for peak usage (existing destination + staging tree) and preserves old destination on ENOSPC.
  const peakRoot = join(sandbox, 'peak-ws');
  const peakTmp = join(sandbox, 'peak-tmp');
  mkdirSync(join(peakRoot, 'repo'), { recursive: true });
  mkdirSync(peakTmp, { recursive: true });
  writeFileSync(join(peakRoot, 'repo', 'old.bin'), Buffer.alloc(2 * 1024 * 1024, 0x42));
  await assert.rejects(
    stageAndExtract(readFileSync(bigTarPath), join(peakRoot, 'repo'), {
      overwrite: true,
      opts: { workspaceRoot: peakRoot, tmpRoot: peakTmp, homeRoot, env: { BOT_WORKSPACE_LIMIT_MB: '3', BOT_TMP_LIMIT_MB: '10' } },
    }),
    /ENOSPC.*peak usage/,
  );
  assert.equal(readFileSync(join(peakRoot, 'repo', 'old.bin')).length, 2 * 1024 * 1024, 'failed peak overwrite preserves existing destination');

  // 9. assistant_write refuses when volume.full is reported.
  await assert.rejects(
    assistantFile({ type: 'assistant_write', path: join(workspaceRoot, 'full.txt'), base64: Buffer.from('x').toString('base64'), offset: 0 }, {
      workspaceRoot, tmpRoot, homeRoot, volume: () => ({ free_bytes: 0, total_bytes: 100 * 1024 ** 3, full: true, low: true }),
    }),
    /ENOSPC/,
  );
  assert.ok(gzipSync(Buffer.alloc(0)).length > 0);
});

test('assistant computers enforce small-host memory clamping, aggregate admission, DiskGuard refusal, archive timeout, and legacy default migration (#1279)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-guards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const homes = join(dir, 'homes');
  mkdirSync(homes, { recursive: true });
  const docker = new FakeDocker();
  docker.homesMount = homes;
  // Simulate an 8 GiB host with 4 CPUs.
  docker.info = { NCPU: 4, MemTotal: 8192 * 1024 * 1024 };

  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(() => projects.db.close());
  // Seed legacy saved assistant settings before constructing AssistantComputers to verify one-time migration.
  projects.db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  projects.db.prepare("INSERT INTO settings VALUES('assistant_computers',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ idle_minutes: 15, memory_mb: 2048, tmp_mb: 512, workspace_mb: 512, cpus: 2 }));

  let diskLow = false;
  const fakeDisk = { check: () => ({ free_bytes: diskLow ? 100 : 200 * 1024 ** 3, total_bytes: 500 * 1024 ** 3, reserve_bytes: 25 * 1024 ** 3, low: diskLow }) };
  const assistants = new AssistantComputers({
    docker,
    db: projects.db,
    deployment: 'fixture',
    image: 'approved',
    homes,
    disk: fakeDisk,
    globalEnvironment: () => projects.assistantGlobalEnvironment(),
  });

  // 1. One-time legacy default migration drops old 2048/512/512 defaults while preserving custom idle_minutes=15 & cpus=2.
  const raw = assistants.settings();
  assert.equal(raw.idle_minutes, 15);
  assert.equal(raw.cpus, 2);
  assert.equal(raw.memory_mb, 16384);
  assert.equal(raw.tmp_mb, 20480);
  assert.equal(raw.workspace_mb, 20480);

  // 2. Small host (8 GiB) clamps effective memory_mb to 6144 MiB (75% reserve) and rejects explicit equal-to-host (8192) and 16384.
  const view = await assistants.settingsView();
  assert.equal(view.settings.memory_mb, 6144);
  assert.deepEqual(view.host_clamped, { memory_mb: 6144, host_cap_mb: 6144 });
  await assert.rejects(assistants.setSettings({ memory_mb: 8192 }), /memory_exceeds_host/);
  await assert.rejects(assistants.setSettings({ memory_mb: 16384 }), /memory_exceeds_host/);

  // 2b. 16 GiB boundary host also clamps 16 GiB default to 12 GiB (75% reserve) and rejects explicit 16384.
  docker.info = { NCPU: 4, MemTotal: 16384 * 1024 * 1024 };
  const boundaryView = await assistants.settingsView();
  assert.equal(boundaryView.settings.memory_mb, 12288);
  assert.deepEqual(boundaryView.host_clamped, { memory_mb: 12288, host_cap_mb: 12288 });
  await assert.rejects(assistants.setSettings({ memory_mb: 16384 }), /memory_exceeds_host/);
  docker.info = { NCPU: 4, MemTotal: 8192 * 1024 * 1024 };

  // 3. Container receives clamped 6144 MiB; aggregate busy memory admission allows up to 2x 75% safe cap (= 12288 MiB) and queues the 3rd (18432 > 12288).
  const ownerA = 'a'.repeat(32), ownerB = 'b'.repeat(32), ownerC = 'c'.repeat(32);
  mkdirSync(join(homes, ownerA, 'home-1'), { recursive: true });
  mkdirSync(join(homes, ownerB, 'home-1'), { recursive: true });
  mkdirSync(join(homes, ownerC, 'home-1'), { recursive: true });
  const resA = await assistants.acquire(ownerA, { turn: 't-a', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(resA.state, 'ready');
  assert.equal(docker.containers.get(assistants.name(ownerA)).HostConfig.Memory, 6144 * 1024 * 1024);

  const resB = await assistants.acquire(ownerB, { turn: 't-b', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.equal(resB.state, 'ready');
  const queuedC = await assistants.acquire(ownerC, { turn: 't-c', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' });
  assert.deepEqual(queuedC, { state: 'queued', reason: 'capacity', position: 1 });
  await assistants.release(ownerB, { turn: 't-b' });
  await assistants.remove(ownerB);

  // 3b. /info error on a cold manager falls back conservatively to 4096 MiB instead of failing open to 16 GiB.
  const coldDocker = new FakeDocker();
  coldDocker.homesMount = homes;
  const origColdReq = coldDocker.request.bind(coldDocker);
  coldDocker.request = async (method, path, body, raw, timeout) => {
    if (path === '/info') throw new Error('docker_socket_unreachable');
    return origColdReq(method, path, body, raw, timeout);
  };
  const coldAssistants = new AssistantComputers({ docker: coldDocker, db: projects.db, deployment: 'cold', image: 'approved', homes });
  const coldView = await coldAssistants.settingsView();
  assert.equal(coldView.settings.memory_mb, 4096);
  await assert.rejects(coldAssistants.setSettings({ memory_mb: 8192 }), /memory_exceeds_host/);

  // 4. Archive extraction passes 180s timeout to docker.runner (matching control-plane timeout).
  await assistants.execute(ownerA, {
    turn: 't-a',
    operation_id: 'e'.repeat(48),
    request: { type: 'assistant_archive_extract', stage_id: 'c'.repeat(48), destination: '/workspace/repo', overwrite: true },
  });
  const extractCall = docker.runs.findLast(r => r.type === 'assistant_archive_extract');
  assert.equal(extractCall?.wait, 180_000);

  // 5. DiskGuard low-space admission refuses write/command calls while keeping read/delete available.
  diskLow = true;
  await assert.rejects(
    assistants.execute(ownerA, { turn: 't-a', operation_id: 'd'.repeat(48), request: { type: 'assistant_write', path: '/workspace/x', base64: 'YQ==', offset: 0 } }),
    err => err.message === 'disk_full' && err.status === 507,
  );
  await assert.rejects(
    assistants.execute(ownerA, { turn: 't-a', operation_id: 'f'.repeat(48), request: { type: 'command', command: 'echo hi' } }),
    err => err.message === 'disk_full' && err.status === 507,
  );
  const delOk = await assistants.execute(ownerA, { turn: 't-a', operation_id: '1'.repeat(48), request: { type: 'assistant_delete', path: '/workspace/x' } });
  assert.equal(delOk.ok, true, 'delete stays allowed under disk pressure so space can be reclaimed');

  // Releasing ownerA makes it idle; when ownerB acquires under disk pressure, idle ownerA is evicted first, then fails closed if disk stays low.
  await assistants.release(ownerA, { turn: 't-a' });
  await assert.rejects(
    assistants.acquire(ownerB, { turn: 't-b', fence: 'f'.repeat(64), home_generation: 1, home_mode: 'rw' }),
    err => err.message === 'disk_full' && err.status === 507,
  );
  assert.equal(assistants.leases.has(ownerA), false, 'idle container evicted under disk pressure to reclaim scratch volumes');
});

test('GitCache.archive streams with a hard byte cap and deletes the temp archive on overflow (#1279)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'git-cache-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'repo'), cacheRoot = join(dir, 'cache');
  mkdirSync(src, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: src });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: src });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: src });
  // Incompressible random bytes so the compressed tar.gz reliably exceeds 32 KiB.
  const { randomBytes } = await import('node:crypto');
  writeFileSync(join(src, 'random.bin'), randomBytes(128 * 1024));
  execFileSync('git', ['add', '.'], { cwd: src });
  execFileSync('git', ['commit', '-m', 'big random blob'], { cwd: src });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();

  const mirrorDir = join(cacheRoot, '777.git');
  mkdirSync(cacheRoot, { recursive: true });
  execFileSync('git', ['clone', '--bare', src, mirrorDir]);
  const cache = new GitCache(cacheRoot);

  // With a 32 KiB cap, streaming archive stops early, throws archive_too_large, and leaves no archive-*.tar.gz file behind.
  await assert.rejects(cache.archive('777', sha, 32 * 1024), err => err?.code === 'archive_too_large');
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(cacheRoot).filter(f => f.startsWith('archive-')), []);

  // With a generous cap, archive succeeds and returns exact size.
  const ok = await cache.archive('777', sha, 1024 * 1024);
  t.after(() => rmSync(ok.file, { force: true }));
  assert.ok(ok.size > 32 * 1024 && ok.size < 1024 * 1024);
});
