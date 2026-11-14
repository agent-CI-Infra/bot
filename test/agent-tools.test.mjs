import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../dist/storage/database.js';
import { beginRun, endRun } from '../dist/tasks/trace.js';
import { Redactor } from '../dist/agent/common.js';
import { activeCliVersions, allocateLease, recordRunCliVersion, roleRunStorage } from '../dist/roles/role-run.js';
import { registerRoleHarness } from '../dist/roles/harness.js';
import { runRole } from '../dist/roles/run.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { roleApi } from '../dist/roles/api.js';
import { agentToolsApi } from '../dist/app/agent-tools.js';
import {
  AgentToolManager,
  COMPATIBLE_CLI_RANGES,
  extractTarGz,
  inspectAgentTools,
  parseSemver,
  satisfiesCliRange,
  selectCompatibleCliVersion,
} from '../dist/harness/agent-tools.js';
import { Projects } from '../manager/projects.mjs';
import { RunEnvironments } from '../manager/run-environments.mjs';
import { verifyRunEnvironment } from '../dist/projects/run-environment.js';
import { FakeDocker } from './fake-docker.mjs';

const hex48 = () => randomBytes(24).toString('hex');

/** Builds a minimal USTAR .tar.gz archive in memory for deterministic tests. */
function buildTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    assert.ok(nameBytes.length <= 100, `test tar entry name > 100 bytes: ${entry.name}`);
    nameBytes.copy(header, 0);
    const mode = entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644);
    const body = entry.type === 'directory' || entry.type === 'symlink'
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8');

    header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156); // checksum placeholder
    header[156] = (entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0').charCodeAt(0);
    if (entry.type === 'symlink') {
      Buffer.from(entry.linkname, 'utf8').copy(header, 157);
    }
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

    blocks.push(header);
    if (body.length > 0) {
      blocks.push(body);
      const rem = body.length % 512;
      if (rem > 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function hashes(bytes) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  };
}

async function startMockToolUpstream(t, arch = 'x64') {
  const nodeArch = arch === 'x64' ? 'x64' : 'arm64';
  const rustArch = arch === 'x64' ? 'x86_64' : 'aarch64';

  const nodeTar = buildTarGz([
    {
      name: `node-v22.15.0-linux-${nodeArch}/bin/node`,
      mode: 0o755,
      content: '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo "v22.15.0"; exit 0; fi\nexec /bin/sh "$@"\n',
    },
    { name: `node-v22.15.0-linux-${nodeArch}/LICENSE`, mode: 0o644, content: 'MIT\n' },
  ]);
  const nodeHash = hashes(nodeTar);

  const claudeVersions = new Map();
  for (const ver of ['1.9.0', '2.1.310', '2.1.319', '3.0.0']) {
    const pkgTar = buildTarGz([
      {
        name: 'package/package.json',
        mode: 0o644,
        content: JSON.stringify({ name: '@anthropic-ai/claude-code', version: ver }),
      },
      {
        name: 'package/cli.js',
        mode: 0o755,
        content: `echo "${ver} (Claude Code) node=$(command -v node)"\n`,
      },
    ]);
    const nativeTar = buildTarGz([
      {
        name: 'package/claude',
        mode: 0o755,
        content: `#!/bin/sh\necho "${ver} (Claude Code) path=$PATH"\n`,
      },
    ]);
    claudeVersions.set(ver, {
      pkgTar,
      pkgHash: hashes(pkgTar),
      nativeTar,
      nativeHash: hashes(nativeTar),
      hasNative: ver !== '2.1.310', // exercise both native binary and JS-via-bundled-Node launch modes!
    });
  }

  const codexVersions = new Map();
  for (const ver of ['0.165.0', '0.166.0', '0.167.0', '1.0.0']) {
    const binName = `codex-${rustArch}-unknown-linux-musl`;
    const tar = buildTarGz([
      {
        name: binName,
        mode: 0o755,
        content: `#!/bin/sh\necho "codex-cli ${ver}"\n`,
      },
    ]);
    codexVersions.set(ver, { tar, hash: hashes(tar), assetName: `${binName}.tar.gz` });
  }

  let tamperClaudeHash = false;
  let untrustedRedirect = false;

  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const u = new URL(req.url, base);

    if (u.pathname === '/node-dist/v22.15.0/SHASUMS256.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${nodeHash.sha256}  node-v22.15.0-linux-${nodeArch}.tar.gz\n`);
      return;
    }
    if (u.pathname === `/node-dist/v22.15.0/node-v22.15.0-linux-${nodeArch}.tar.gz`) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(nodeTar);
      return;
    }

    const claudeMeta = /^\/npm\/@anthropic-ai%2fclaude-code\/([^/]+)$/.exec(u.pathname);
    if (claudeMeta) {
      const ver = claudeMeta[1];
      const item = claudeVersions.get(ver);
      if (!item) { res.writeHead(404); res.end('{}'); return; }
      const badSha1 = '0'.repeat(40);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: '@anthropic-ai/claude-code',
        version: ver,
        optionalDependencies: item.hasNative ? { [`@anthropic-ai/claude-code-linux-${arch}-musl`]: ver } : {},
        dist: {
          tarball: `${base}/npm/@anthropic-ai/claude-code/-/claude-code-${ver}.tgz`,
          shasum: tamperClaudeHash ? badSha1 : item.pkgHash.sha1,
          integrity: item.pkgHash.integrity,
        },
      }));
      return;
    }

    const nativeMeta = new RegExp(`^/npm/@anthropic-ai%2fclaude-code-linux-${arch}-musl/([^/]+)$`).exec(u.pathname);
    if (nativeMeta) {
      const ver = nativeMeta[1];
      const item = claudeVersions.get(ver);
      if (!item) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: `@anthropic-ai/claude-code-linux-${arch}-musl`,
        version: ver,
        dist: {
          tarball: `${base}/npm/@anthropic-ai/claude-code-linux-${arch}-musl/-/claude-code-linux-${arch}-musl-${ver}.tgz`,
          shasum: item.nativeHash.sha1,
          integrity: item.nativeHash.integrity,
        },
      }));
      return;
    }

    const claudeTarMatch = /^\/npm\/@anthropic-ai\/claude-code\/-\/claude-code-([^/]+)\.tgz$/.exec(u.pathname);
    if (claudeTarMatch) {
      const item = claudeVersions.get(claudeTarMatch[1]);
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(item.pkgTar);
      return;
    }

    const nativeTarMatch = new RegExp(`^/npm/@anthropic-ai/claude-code-linux-${arch}-musl/-/claude-code-linux-${arch}-musl-([^/]+)\\.tgz$`).exec(u.pathname);
    if (nativeTarMatch) {
      const item = nativeVersionsOr(claudeVersions, nativeTarMatch[1]);
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(item.nativeTar);
      return;
    }

    const codexRelMatch = /^\/gh-api\/repos\/openai\/codex\/releases\/tags\/rust-v([^/]+)$/.exec(u.pathname);
    if (codexRelMatch) {
      const ver = codexRelMatch[1];
      const item = codexVersions.get(ver);
      if (!item) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: `rust-v${ver}`,
        assets: [{
          name: item.assetName,
          digest: `sha256:${item.hash.sha256}`,
          browser_download_url: `${base}/gh-dl/openai/codex/releases/download/rust-v${ver}/${item.assetName}`,
        }],
      }));
      return;
    }

    const codexDlMatch = /^\/gh-dl\/openai\/codex\/releases\/download\/rust-v([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (codexDlMatch) {
      if (untrustedRedirect) {
        res.writeHead(302, { location: 'https://evil.example.invalid/codex.tar.gz' });
        res.end();
        return;
      }
      const item = codexVersions.get(codexDlMatch[1]);
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(item.tar);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    sources: {
      npmRegistryBase: `${origin}/npm`,
      nodeDistBase: `${origin}/node-dist`,
      githubApiBase: `${origin}/gh-api`,
      githubDownloadOrigins: [`${origin}/gh-dl`],
      allowLoopbackHttp: true,
    },
    setTamperClaudeHash: v => { tamperClaudeHash = v; },
    setUntrustedRedirect: v => { untrustedRedirect = v; },
  };
}

function nativeVersionsOr(map, ver) {
  return map.get(ver);
}

test('semver parsing and compatibility range checks reject malformed and pre-release versions', () => {
  assert.deepEqual(parseSemver('2.1.319'), { major: 2, minor: 1, patch: 319, raw: '2.1.319' });
  for (const bad of ['', '2.1', 'v2.1.0', '2.1.0-beta.1', '../2.1.0', '02.1.0']) {
    assert.equal(parseSemver(bad), null, `expected ${bad} to be rejected`);
  }
  assert.equal(satisfiesCliRange('claude_code', '2.0.9'), false);
  assert.equal(satisfiesCliRange('claude_code', '2.1.0'), true);
  assert.equal(satisfiesCliRange('claude_code', '2.1.319'), true);
  assert.equal(satisfiesCliRange('claude_code', '3.0.0'), false);
  assert.equal(satisfiesCliRange('codex', '0.165.9'), false);
  assert.equal(satisfiesCliRange('codex', '0.166.0'), true);
  assert.equal(satisfiesCliRange('codex', '1.0.0'), false);
});

test('installs Claude Code (with bundled Node runtime) and Codex (static build), selects newest compatible version, rejects tampered/untrusted downloads, and prunes keeping latest N', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');

  // Use root as both volumeRoot and containerRoot so generated launcher scripts can be executed directly on host.
  const manager = new AgentToolManager({
    volumeRoot: root,
    containerRoot: root,
    arch: 'x64',
    sources: upstream.sources,
  });

  // Empty volume reports cli_not_installed.
  const initial = inspectAgentTools(root, { containerRoot: root, arch: 'x64' });
  assert.equal(initial.volume_present, true);
  assert.equal(initial.clis.claude_code.available, false);
  assert.equal(initial.clis.claude_code.reason, 'cli_not_installed');
  assert.equal(initial.clis.codex.reason, 'cli_not_installed');

  // Tampered checksum is rejected and leaves no partial CLI installation.
  upstream.setTamperClaudeHash(true);
  await assert.rejects(manager.install({ cli: 'claude_code', version: '2.1.319' }), { code: 'agent_tool_hash_mismatch' });
  assert.equal(existsSync(join(root, 'claude_code', '2.1.319')), false);
  upstream.setTamperClaudeHash(false);

  // Redirect to untrusted origin is rejected.
  upstream.setUntrustedRedirect(true);
  await assert.rejects(manager.install({ cli: 'codex', version: '0.166.0' }), { code: 'agent_tool_download_failed' });
  upstream.setUntrustedRedirect(false);

  // Install incompatible versions first -> reported as cli_version_incompatible and never selected!
  await manager.install({ cli: 'claude_code', version: '3.0.0' });
  await manager.install({ cli: 'codex', version: '0.165.0' });
  const onlyIncompat = manager.status();
  assert.equal(onlyIncompat.clis.claude_code.available, false);
  assert.equal(onlyIncompat.clis.claude_code.reason, 'cli_version_incompatible');
  assert.deepEqual(onlyIncompat.clis.claude_code.incompatible_versions, ['3.0.0']);
  assert.throws(() => selectCompatibleCliVersion(root, 'claude_code', { containerRoot: root, arch: 'x64' }), { code: 'cli_version_incompatible' });

  // Install compatible versions: JS-based 2.1.310, native-based 2.1.319, older 1.9.0; Codex 0.166.0, 0.167.0, 1.0.0.
  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  const selected210 = manager.select('claude_code');
  assert.equal(selected210.version, '2.1.310');
  const out210 = execFileSync(selected210.host_executable, ['--version'], { encoding: 'utf8' });
  assert.match(out210, /2\.1\.310 \(Claude Code\)/);
  assert.ok(out210.includes(join(root, 'node', '22.15.0', 'bin', 'node')), 'JS package ran under bundled Node runtime');

  await manager.install({ cli: 'claude_code', version: '2.1.319' });
  await manager.install({ cli: 'claude_code', version: '1.9.0' });
  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  await manager.install({ cli: 'codex', version: '1.0.0' });

  // Runtime selector picks newest compatible version (2.1.319 and 0.167.0), ignoring 3.0.0 and 1.0.0!
  const claudeSel = manager.select('claude_code');
  assert.equal(claudeSel.version, '2.1.319');
  assert.equal(claudeSel.compatible_range, COMPATIBLE_CLI_RANGES.claude_code.range);
  assert.match(execFileSync(claudeSel.host_executable, ['--version'], { encoding: 'utf8' }), /2\.1\.319 \(Claude Code\)/);

  const codexSel = manager.select('codex');
  assert.equal(codexSel.version, '0.167.0');
  assert.match(execFileSync(codexSel.host_executable, ['--version'], { encoding: 'utf8' }), /codex-cli 0\.167\.0/);

  // Prune keeping latest 2 versions per CLI: keeps [2.1.319, 2.1.310] and [0.167.0, 0.166.0], removing out-of-range/older ones!
  const pruned = await manager.prune({ retainCount: 2 });
  assert.deepEqual(pruned.pruned.claude_code.sort(), ['1.9.0', '3.0.0']);
  assert.deepEqual(pruned.pruned.codex.sort(), ['0.165.0', '1.0.0']);
  assert.deepEqual(pruned.status.clis.claude_code.compatible_versions, ['2.1.319', '2.1.310']);
  assert.deepEqual(pruned.status.clis.claude_code.incompatible_versions, []);
  assert.deepEqual(pruned.status.clis.codex.compatible_versions, ['0.167.0', '0.166.0']);
  assert.deepEqual(pruned.status.node_versions, ['22.15.0']);
});

test('extractTarGz rejects path traversal and escaping symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tar-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const traversal = buildTarGz([{ name: '../escaped.txt', content: 'nope' }]);
  assert.throws(() => extractTarGz(traversal, dir), { code: 'agent_tool_archive_invalid' });

  const badSymlink = buildTarGz([{ name: 'bin/escape', type: 'symlink', linkname: '../../outside' }]);
  assert.throws(() => extractTarGz(badSymlink, dir), { code: 'agent_tool_archive_invalid' });
});

test('records selected CLI version on task_runs and serves super-admin /api/agent-tools endpoints', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const tools = new AgentToolManager({ volumeRoot: root, containerRoot: '/opt/agent-tools', arch: 'x64', sources: upstream.sources });

  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };
  const projAdmin = { id: 'u-proj', role: 'project_admin', repositories: ['r'] };

  await assert.rejects(() => agentToolsApi(store, tools, projAdmin, 'GET', '/api/agent-tools', {}), { status: 403 });

  const installed = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'codex',
    version: '0.166.0',
    retain_count: 2,
  });
  assert.equal(installed.compatible, true);
  assert.equal(installed.status.clis.codex.selected_version, '0.166.0');
  assert.equal(installed.status.clis.codex.container_executable, '/opt/agent-tools/codex/0.166.0/bin/codex');

  const pruned = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', { retain_count: 2 });
  assert.equal(pruned.status.retain_count, 2);

  // Record actual CLI version on a role run and verify /api/tasks/:id/roles surfaces cli_version.
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  const rolesView = roleApi(store, projAdmin, 'GET', new URL('http://local/api/tasks/t1/roles'), {});
  assert.equal(rolesView.runs.length, 1);
  assert.equal(rolesView.runs[0].cli_version, '0.166.0');
  assert.deepEqual(activeCliVersions(store, 'codex'), ['0.166.0']);

  // While run is active on 0.166.0, installing newer versions with retain_count=1 and calling prune MUST retain 0.166.0!
  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'codex',
    version: '0.167.0',
    retain_count: 1,
  });
  assert.deepEqual(inspectAgentTools(root, { arch: 'x64' }).clis.codex.compatible_versions, ['0.167.0', '0.166.0']);
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);

  const prunedWhileRunning = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', {
    cli: 'codex',
    retain_count: 1,
  });
  assert.deepEqual(prunedWhileRunning.pruned.codex, []);
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);

  // Installing an out-of-range version (1.0.0) while retain_count=1 compatible versions exist MUST NOT delete 1.0.0 during install!
  const outOfRangeInstall = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'codex',
    version: '1.0.0',
    retain_count: 1,
  });
  assert.equal(outOfRangeInstall.compatible, false);
  assert.equal(existsSync(join(root, 'codex', '1.0.0', 'bin', 'codex')), true);
  assert.deepEqual(outOfRangeInstall.status.clis.codex.incompatible_versions, ['1.0.0']);

  // Once the active run finishes, pruning with retain_count=1 removes both 0.166.0 and out-of-range 1.0.0, keeping newest compatible 0.167.0.
  endRun(store, run, 'completed', null);
  assert.deepEqual(activeCliVersions(store, 'codex'), []);
  const prunedAfterFinish = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/prune', {
    cli: 'codex',
    retain_count: 1,
  });
  assert.deepEqual(prunedAfterFinish.pruned.codex.sort(), ['0.166.0', '1.0.0']);
  assert.deepEqual(prunedAfterFinish.status.clis.codex.compatible_versions, ['0.167.0']);
  assert.deepEqual(prunedAfterFinish.status.clis.codex.incompatible_versions, []);

  // Production runRole path records cli_version automatically via session_bound / harnessBinding.
  registerRoleHarness(
    {
      id: 'cli-version-probe-705',
      version: '1',
      session: 'external_session',
      events: 'probe_events',
      kinds: ['writer', 'observer', 'evaluator'],
      externalModel: true,
      capabilities: {
        raw_evidence: 'control_plane_tools',
        cancel: 'protocol_then_kill',
        isolation: 'none',
        version_binding: true,
        output_validation: true,
        fresh_context: true,
        recovery: ['rebuilt_from_task_records'],
      },
    },
    spec => async () => {
      spec.onHarnessEvent?.({ type: 'session_bound', sessionRef: 's1', recoveryMode: 'new_session', version: '0.167.0' });
      return spec.finish.validate({ summary: 'done', findings: [], inspected_scope: ['README.md'], unknowns: [] });
    },
  );
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t2','r','task.request','running','probe','{}',1,1)");
  new TaskRecords(store).contract('t2', { goal: 'probe', scope: ['README.md'], criteria: ['record cli version'], endpoint: 'artifact' });
  const rolesUrl = new URL('http://local/api/repositories/r/roles');
  roleApi(store, projAdmin, 'PUT', rolesUrl, {
    expected_revision: roleApi(store, projAdmin, 'GET', rolesUrl, {}).revision,
    enabled: true,
    roles: [{ role_id: 'reviewer', harness_ref: { id: 'cli-version-probe-705' } }],
  });
  const finishTool = { type: 'function', function: { name: 'finish', description: 'finish', parameters: { type: 'object', additionalProperties: true } } };
  await runRole(
    {
      store,
      task: store.get("SELECT * FROM tasks WHERE id='t2'"),
      redactor: new Redactor(),
      guard: async () => {},
      system: 'sys',
      prompt: '{}',
      tools: [finishTool],
      finish: { name: 'finish', validate: v => v },
      maxTurns: 4,
    },
    'reviewer',
  );
  const probeRun = store.get("SELECT cli_version FROM task_runs WHERE task_id='t2' AND role='reviewer'");
  assert.equal(probeRun.cli_version, '0.167.0');
});

test('project computer recreates once to mount /opt/agent-tools read-only and RunEnvironments enforce read-only /opt/agent-tools isolation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const docker = new FakeDocker();
  const projects = new Projects({ database: join(dir, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  t.after(() => projects.db.close());

  // 1. Existing project computer created before /opt/agent-tools volume was mounted on manager.
  await projects.register('101');
  await projects.operate('101', 'start', { operation_id: hex48(), generation: 1 });
  const createdBefore = docker.created;
  const containerName = projects.names('101', 1).container;
  assert.equal(docker.containers.get(containerName).HostConfig.Mounts.some(m => m.Target === '/opt/agent-tools'), false);

  // 2. Deployment upgrades so manager now has agent-tools mounted at /opt/agent-tools:
  //    existing project computer is recreated ONCE to attach /opt/agent-tools read-only while keeping /workspace!
  docker.toolsMount = '/opt/agent-tools';
  await projects.operate('101', 'start', { operation_id: hex48(), generation: 1 });
  assert.equal(docker.created, createdBefore + 1);
  const mountsAfterUpgrade = docker.containers.get(containerName).HostConfig.Mounts;
  assert.deepEqual(
    mountsAfterUpgrade.find(m => m.Target === '/opt/agent-tools'),
    { Type: 'volume', Source: 'fixture-agent-tools', Target: '/opt/agent-tools', ReadOnly: true },
  );
  assert.ok(mountsAfterUpgrade.some(m => m.Target === '/workspace' && m.Source === projects.names('101', 1).volume));

  // 3. Subsequent provisions (e.g. after installing new CLI versions into the volume) do NOT recreate the container!
  await projects.operate('101', 'start', { operation_id: hex48(), generation: 1 });
  assert.equal(docker.created, createdBefore + 1);

  // 4. Isolated RunEnvironments mount /opt/agent-tools strictly read-only and pass control-plane verification;
  //    writable /opt/agent-tools or mounts elsewhere are rejected with external_mount.
  const runs = new RunEnvironments(projects);
  const runId = hex48();
  const described = await runs.create('101', { run_id: runId, task_id: 't1', lease_epoch: 1, profile: 'writer' });
  assert.deepEqual(described.container.mounts, [
    {
      type: 'volume',
      name: 'fixture-agent-tools',
      source: 'fixture-agent-tools',
      destination: '/opt/agent-tools',
      rw: false,
      labels: { 'com.docker.compose.volume': 'agent-tools', 'department.bot.kind': 'agent-tools' },
    },
  ]);
  assert.deepEqual(verifyRunEnvironment(described, { run_id: runId, network: 'none' }), { verified: true, violations: [] });

  // Compose-prefixed agent-tools volume with Compose label passes verification.
  const composePrefixedGood = {
    ...described,
    container: {
      ...described.container,
      mounts: [{
        type: 'volume',
        name: 'myproject_agent-tools',
        source: 'myproject_agent-tools',
        destination: '/opt/agent-tools',
        rw: false,
        labels: { 'com.docker.compose.project': 'myproject', 'com.docker.compose.volume': 'agent-tools' },
      }],
    },
  };
  assert.deepEqual(verifyRunEnvironment(composePrefixedGood, { run_id: runId, network: 'none' }), { verified: true, violations: [] });

  // Writable /opt/agent-tools mount is refused!
  const writableTools = {
    ...described,
    container: {
      ...described.container,
      mounts: [{
        type: 'volume',
        name: 'fixture-agent-tools',
        source: 'fixture-agent-tools',
        destination: '/opt/agent-tools',
        rw: true,
        labels: { 'com.docker.compose.volume': 'agent-tools', 'department.bot.kind': 'agent-tools' },
      }],
    },
  };
  assert.deepEqual(verifyRunEnvironment(writableTools, { run_id: runId, network: 'none' }).violations, ['external_mount']);

  // Every other deployment/project volume (including Compose underscore-prefixed ones and unlabeled agent-tools) is refused by both verifier and manager!
  for (const badMount of [
    { name: 'dbot-fixture-101-notes', labels: { 'department.bot.kind': 'notes' } },
    { name: 'dbot-fixture-101-g1-work', labels: { 'department.bot.kind': 'volume' } },
    { name: 'myproject_assistant-homes', labels: { 'com.docker.compose.volume': 'assistant-homes' } },
    { name: 'myproject_bot-data', labels: { 'com.docker.compose.volume': 'bot-data' } },
    { name: 'myproject_bot-keys', labels: { 'com.docker.compose.volume': 'bot-keys' } },
    { name: 'myproject_internal-keys', labels: { 'com.docker.compose.volume': 'internal-keys' } },
    { name: 'myproject_manager-data', labels: { 'com.docker.compose.volume': 'manager-data' } },
    { name: 'myproject_tunnel-keys', labels: { 'com.docker.compose.volume': 'tunnel-keys' } },
    { name: 'myproject_agent-tools', labels: {} },
  ]) {
    const candidate = {
      ...described,
      container: {
        ...described.container,
        mounts: [{ type: 'volume', name: badMount.name, source: badMount.name, destination: '/opt/agent-tools', rw: false, labels: badMount.labels }],
      },
    };
    assert.deepEqual(verifyRunEnvironment(candidate, { run_id: runId, network: 'none' }).violations, ['external_mount'], `verifier must reject ${badMount.name}`);

    docker.toolsVolumeName = badMount.name;
    docker.toolsVolumeLabels = badMount.labels;
    await assert.rejects(() => projects.agentToolsVolume(), /agent_tools_volume_invalid/, `manager must reject ${badMount.name}`);
  }
});
