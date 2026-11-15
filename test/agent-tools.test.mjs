import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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
  detectElfInterpreterLibc,
  detectHostLibc,
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
  for (const ver of ['1.9.0', '2.1.310', '2.1.315', '2.1.319', '3.0.0']) {
    const muslOnlyWrapper = ver === '2.1.315';
    const pkgTar = buildTarGz([
      {
        name: 'package/package.json',
        mode: 0o644,
        content: JSON.stringify({ name: '@anthropic-ai/claude-code', version: ver }),
      },
      muslOnlyWrapper
        ? {
            name: 'package/cli-wrapper.cjs',
            mode: 0o755,
            content: 'throw new Error("cli-wrapper.cjs requires node_modules");\n',
          }
        : {
            name: 'package/cli.js',
            mode: 0o755,
            content: `echo "${ver} (Claude Code) node=$(command -v node)"\n`,
          },
    ]);
    const glibcNativeTar = buildTarGz([
      {
        name: 'package/claude',
        mode: 0o755,
        content: `#!/bin/sh\necho "${ver} (Claude Code) libc=glibc path=$PATH"\n`,
      },
    ]);
    const muslNativeTar = buildTarGz([
      {
        name: 'package/claude',
        mode: 0o755,
        content: `#!/bin/sh\necho "${ver} (Claude Code) libc=musl path=$PATH"\n`,
      },
    ]);
    claudeVersions.set(ver, {
      pkgTar,
      pkgHash: hashes(pkgTar),
      glibcNativeTar,
      glibcNativeHash: hashes(glibcNativeTar),
      muslNativeTar,
      muslNativeHash: hashes(muslNativeTar),
      hasGlibcNative: ver !== '2.1.310' && !muslOnlyWrapper,
      hasMuslNative: ver !== '2.1.310',
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
  let rateLimitGithubApi = false;
  // Runs while the codex archive is being served, i.e. after install() passed its entry check and before the replace.
  let beforeCodexDownload = null;

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
      const optionalDependencies = {
        ...(item.hasGlibcNative ? { [`@anthropic-ai/claude-code-linux-${arch}`]: ver } : {}),
        ...(item.hasMuslNative ? { [`@anthropic-ai/claude-code-linux-${arch}-musl`]: ver } : {}),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: '@anthropic-ai/claude-code',
        version: ver,
        optionalDependencies,
        dist: {
          tarball: `${base}/npm/@anthropic-ai/claude-code/-/claude-code-${ver}.tgz`,
          shasum: tamperClaudeHash ? badSha1 : item.pkgHash.sha1,
          integrity: item.pkgHash.integrity,
        },
      }));
      return;
    }

    const glibcNativeMeta = new RegExp(`^/npm/@anthropic-ai%2fclaude-code-linux-${arch}/([^/]+)$`).exec(u.pathname);
    if (glibcNativeMeta) {
      const ver = glibcNativeMeta[1];
      const item = claudeVersions.get(ver);
      if (!item || !item.hasGlibcNative) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: `@anthropic-ai/claude-code-linux-${arch}`,
        version: ver,
        dist: {
          tarball: `${base}/npm/@anthropic-ai/claude-code-linux-${arch}/-/claude-code-linux-${arch}-${ver}.tgz`,
          shasum: item.glibcNativeHash.sha1,
          integrity: item.glibcNativeHash.integrity,
        },
      }));
      return;
    }

    const muslNativeMeta = new RegExp(`^/npm/@anthropic-ai%2fclaude-code-linux-${arch}-musl/([^/]+)$`).exec(u.pathname);
    if (muslNativeMeta) {
      const ver = muslNativeMeta[1];
      const item = claudeVersions.get(ver);
      if (!item || !item.hasMuslNative) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: `@anthropic-ai/claude-code-linux-${arch}-musl`,
        version: ver,
        dist: {
          tarball: `${base}/npm/@anthropic-ai/claude-code-linux-${arch}-musl/-/claude-code-linux-${arch}-musl-${ver}.tgz`,
          shasum: item.muslNativeHash.sha1,
          integrity: item.muslNativeHash.integrity,
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

    const glibcNativeTarMatch = new RegExp(`^/npm/@anthropic-ai/claude-code-linux-${arch}/-/claude-code-linux-${arch}-([^/]+)\\.tgz$`).exec(u.pathname);
    if (glibcNativeTarMatch) {
      const item = nativeVersionsOr(claudeVersions, glibcNativeTarMatch[1]);
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(item.glibcNativeTar);
      return;
    }

    const muslNativeTarMatch = new RegExp(`^/npm/@anthropic-ai/claude-code-linux-${arch}-musl/-/claude-code-linux-${arch}-musl-([^/]+)\\.tgz$`).exec(u.pathname);
    if (muslNativeTarMatch) {
      const item = nativeVersionsOr(claudeVersions, muslNativeTarMatch[1]);
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(item.muslNativeTar);
      return;
    }

    const codexRelMatch = /^\/gh-api\/repos\/openai\/codex\/releases\/tags\/rust-v([^/]+)$/.exec(u.pathname);
    if (codexRelMatch) {
      if (rateLimitGithubApi) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
        return;
      }
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
      beforeCodexDownload?.(codexDlMatch[1]);
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
    setRateLimitGithubApi: v => { rateLimitGithubApi = v; },
    setBeforeCodexDownload: fn => { beforeCodexDownload = fn; },
    claudeVersions,
    codexVersions,
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
  // On glibc (project/run base image node:22-bookworm-slim), installer selects @anthropic-ai/claude-code-linux-x64, never -musl.
  const claudeSel = manager.select('claude_code');
  assert.equal(claudeSel.version, '2.1.319');
  assert.equal(claudeSel.compatible_range, COMPATIBLE_CLI_RANGES.claude_code.range);
  assert.match(execFileSync(claudeSel.host_executable, ['--version'], { encoding: 'utf8' }), /2\.1\.319 \(Claude Code\) libc=glibc/);
  const nativeArtifact = claudeSel.manifest.artifacts.find(a => a.role === 'native_binary');
  assert.ok(nativeArtifact?.source_url.includes('/@anthropic-ai/claude-code-linux-x64/-/'));
  assert.equal(nativeArtifact?.source_url.includes('-musl'), false);

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

test('AgentToolManager selects musl native package only when libc=musl and refuses musl-only wrapper packages on glibc', async t => {
  const upstream = await startMockToolUpstream(t, 'x64');

  const glibcRoot = mkdtempSync(join(tmpdir(), 'agent-tools-glibc-'));
  t.after(() => rmSync(glibcRoot, { recursive: true, force: true }));
  const glibcManager = new AgentToolManager({
    volumeRoot: glibcRoot,
    containerRoot: glibcRoot,
    arch: 'x64',
    libc: 'glibc',
    sources: upstream.sources,
  });
  await assert.rejects(
    glibcManager.install({ cli: 'claude_code', version: '2.1.315' }),
    { code: 'agent_tool_archive_invalid' },
  );
  assert.equal(existsSync(join(glibcRoot, 'claude_code', '2.1.315')), false);

  const muslRoot = mkdtempSync(join(tmpdir(), 'agent-tools-musl-'));
  t.after(() => rmSync(muslRoot, { recursive: true, force: true }));
  const muslManager = new AgentToolManager({
    volumeRoot: muslRoot,
    containerRoot: muslRoot,
    arch: 'x64',
    libc: 'musl',
    sources: upstream.sources,
  });
  await muslManager.install({ cli: 'claude_code', version: '2.1.315' });
  const muslSel = muslManager.select('claude_code');
  assert.equal(muslSel.manifest.libc, 'musl');
  assert.match(execFileSync(muslSel.host_executable, ['--version'], { encoding: 'utf8' }), /2\.1\.315 \(Claude Code\) libc=musl/);
  assert.ok(muslSel.manifest.artifacts.find(a => a.role === 'native_binary')?.source_url.includes('-musl'));

  // A glibc runtime rejects a volume entry built for musl — both when manifest.libc is recorded and on legacy manifests
  // that only have the -musl native_binary source_url — instead of selecting a binary whose dynamic loader is missing.
  const glibcOnMuslVolume = new AgentToolManager({
    volumeRoot: muslRoot,
    containerRoot: muslRoot,
    arch: 'x64',
    libc: 'glibc',
    sources: upstream.sources,
  });
  assert.equal(glibcOnMuslVolume.status().clis.claude_code.available, false);
  assert.equal(glibcOnMuslVolume.status().clis.claude_code.reason, 'cli_not_installed');
  assert.throws(() => glibcOnMuslVolume.select('claude_code'), { code: 'cli_not_installed' });

  const legacyManifestPath = join(muslRoot, 'claude_code', '2.1.315', 'manifest.json');
  const legacyManifest = JSON.parse(readFileSync(legacyManifestPath, 'utf8'));
  delete legacyManifest.libc;
  writeFileSync(legacyManifestPath, JSON.stringify(legacyManifest, null, 2));
  assert.equal(glibcOnMuslVolume.status().clis.claude_code.available, false);
  assert.throws(() => glibcOnMuslVolume.select('claude_code'), { code: 'cli_not_installed' });
  assert.equal(muslManager.select('claude_code').version, '2.1.315');
});

test('extractTarGz rejects path traversal, symlink-chain escapes, and symlink loops while allowing safe internal symlinks', t => {
  const outer = mkdtempSync(join(tmpdir(), 'tar-guard-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const dir = join(outer, 'a', 'b', 'c');
  mkdirSync(dir, { recursive: true });

  const traversal = buildTarGz([{ name: '../escaped.txt', content: 'nope' }]);
  assert.throws(() => extractTarGz(traversal, dir), { code: 'agent_tool_archive_invalid' });

  const badSymlink = buildTarGz([{ name: 'bin/escape', type: 'symlink', linkname: '../../outside' }]);
  assert.throws(() => extractTarGz(badSymlink, join(dir, 's1')), { code: 'agent_tool_archive_invalid' });

  // Multi-hop symlink chain: lexically `x/x/x/../../../outside.txt` stays at `<dest>/outside.txt`,
  // but `x -> .` keeps traversal at `<dest>` so `../../..` escapes 3 directories upward (#705 M8).
  const chainEscape = buildTarGz([
    { name: 'x', type: 'symlink', linkname: '.' },
    { name: 'q', type: 'symlink', linkname: 'x/x/x/../../../escaped-chain.txt' },
    { name: 'q', content: 'escaped!' },
  ]);
  assert.throws(() => extractTarGz(chainEscape, join(dir, 's2')), { code: 'agent_tool_archive_invalid' });
  assert.equal(existsSync(join(outer, 'escaped-chain.txt')), false);
  assert.equal(existsSync(join(outer, 'a', 'escaped-chain.txt')), false);

  // Dangling symlink chain without a trailing file write is also rejected on verification.
  const danglingChain = buildTarGz([
    { name: 'x', type: 'symlink', linkname: '.' },
    { name: 'q', type: 'symlink', linkname: 'x/x/x/../../../dangling-target' },
  ]);
  assert.throws(() => extractTarGz(danglingChain, join(dir, 's3')), { code: 'agent_tool_archive_invalid' });

  // Directory write through a symlinked parent component is rejected.
  const dirViaSymlink = buildTarGz([
    { name: 'sub', type: 'symlink', linkname: '.' },
    { name: 'escape_dir', type: 'symlink', linkname: 'sub/sub/../../escaped-dir' },
    { name: 'escape_dir/pwn.txt', content: 'nope' },
  ]);
  assert.throws(() => extractTarGz(dirViaSymlink, join(dir, 's4')), { code: 'agent_tool_archive_invalid' });
  assert.equal(existsSync(join(outer, 'a', 'escaped-dir')), false);

  // Symlink cycle is rejected cleanly rather than recursing infinitely.
  const loopArchive = buildTarGz([
    { name: 'loopA', type: 'symlink', linkname: 'loopB' },
    { name: 'loopB', type: 'symlink', linkname: 'loopA' },
  ]);
  assert.throws(() => extractTarGz(loopArchive, join(dir, 's5')), { code: 'agent_tool_archive_invalid' });

  // Benign internal relative symlink remains supported.
  const okDir = join(dir, 'ok');
  const benignSymlink = buildTarGz([
    { name: 'lib/entry.txt', content: 'safe-internal\n' },
    { name: 'bin/entry', type: 'symlink', linkname: '../lib/entry.txt' },
  ]);
  extractTarGz(benignSymlink, okDir);
  assert.equal(readFileSync(join(okDir, 'bin', 'entry'), 'utf8'), 'safe-internal\n');

  // Short writes loop until full body is written; zero/partial failure unlinks the truncated file instead of succeeding.
  const payload = Buffer.alloc(614400, 0x61);
  const largeArchive = buildTarGz([{ name: 'bin/big', mode: 0o755, content: payload }]);
  const chunkedDir = join(dir, 'chunked');
  let writeCalls = 0;
  let injectedEintr = false;
  extractTarGz(largeArchive, chunkedDir, {
    writeImpl: (fd, buf, off, len) => {
      writeCalls++;
      if (!injectedEintr && writeCalls === 3) {
        injectedEintr = true;
        throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
      }
      return writeSync(fd, buf, off, Math.min(len, 65536));
    },
  });
  assert.ok(injectedEintr && writeCalls >= 11);
  assert.equal(readFileSync(join(chunkedDir, 'bin', 'big')).length, payload.length);

  const stalledDir = join(dir, 'stalled');
  assert.throws(
    () =>
      extractTarGz(largeArchive, stalledDir, {
        writeImpl: (fd, buf, off, len) => (off === 0 ? writeSync(fd, buf, off, Math.min(len, 409600)) : 0),
      }),
    { code: 'agent_tool_archive_invalid' },
  );
  assert.equal(existsSync(join(stalledDir, 'bin', 'big')), false);

  if (process.platform === 'linux') {
    const rlimitDir = join(dir, 'rlimit');
    const archiveFile = join(dir, 'large.tgz');
    writeFileSync(archiveFile, largeArchive);
    assert.throws(() =>
      execFileSync(
        'bash',
        [
          '-c',
          'ulimit -f 400 && exec "$1" --input-type=module -e "import { readFileSync } from \'node:fs\'; import { extractTarGz } from \'./dist/harness/agent-tools.js\'; process.on(\'SIGXFSZ\', () => {}); extractTarGz(readFileSync(process.argv[1]), process.argv[2]);" -- "$2" "$3"',
          'bash',
          process.execPath,
          archiveFile,
          rlimitDir,
        ],
        { cwd: process.cwd(), stdio: 'pipe' },
      ),
    );
    assert.equal(existsSync(join(rlimitDir, 'bin', 'big')), false);
  }
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

const toolApiScaffold = async (t, prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const tools = new AgentToolManager({ volumeRoot: root, containerRoot: '/opt/agent-tools', arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");
  return { root, tools, store, upstream, superUser: { id: 'u-super', role: 'super_admin', repositories: [] } };
};

test('reinstalling the CLI version an active run is using is refused with 409 and leaves the install untouched (#735)', async t => {
  const { root, tools, store, superUser } = await toolApiScaffold(t, 'agent-tools-in-use-');

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  const versionDir = join(root, 'codex', '0.166.0');
  const sentinel = join(versionDir, 'SENTINEL');
  writeFileSync(sentinel, 'must survive');
  const manifestBefore = readFileSync(join(versionDir, 'manifest.json'));

  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 }),
    { status: 409, code: 'agent_tool_version_in_use' },
    'reinstalling the version an active run holds is refused, not mapped to 503',
  );
  assert.equal(existsSync(sentinel), true, 'the in-use directory must not be removed before the replacement is ready');
  assert.deepEqual(readFileSync(join(versionDir, 'manifest.json')), manifestBefore, 'the in-use manifest is byte-for-byte unchanged');

  // A version that no run holds can still be installed next to the in-use one.
  const other = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.167.0', retain_count: 2 });
  assert.equal(other.installed.version, '0.167.0');

  // Once the run finishes the same request is allowed again and really reinstalls.
  endRun(store, run, 'completed', null);
  const again = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  assert.equal(again.installed.version, '0.166.0');
  assert.equal(existsSync(sentinel), false, 'the reinstall after the run finished replaces the directory');
});

test('a claude install that would replace the Node runtime an active claude run uses is refused with 409 (#735)', async t => {
  const { root, tools, store, superUser } = await toolApiScaffold(t, 'agent-tools-node-in-use-');

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'claude_code', version: '2.1.319', retain_count: 2 });
  const nodeDir = join(root, 'node', '22.15.0');
  const sentinel = join(nodeDir, 'SENTINEL');
  writeFileSync(sentinel, 'node must survive');
  const nodeBinBefore = readFileSync(join(nodeDir, 'bin', 'node'));

  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  recordRunCliVersion(store, run.id, '2.1.319');

  // A reusable Node runtime is left alone: another claude version still installs beside the active one.
  const reused = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'claude_code', version: '1.9.0', retain_count: 2 });
  assert.equal(reused.installed.version, '1.9.0');
  assert.equal(existsSync(sentinel), true, 'the reusable Node runtime is not touched');

  // An invalid Node manifest sends the next claude install down the replace path.
  rmSync(join(nodeDir, 'manifest.json'));

  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'claude_code', version: '2.1.310', retain_count: 2 }),
    { status: 409, code: 'agent_tool_version_in_use' },
    'replacing the Node runtime an active claude run depends on is refused',
  );
  assert.equal(existsSync(sentinel), true, 'the Node directory is not removed');
  assert.deepEqual(readFileSync(join(nodeDir, 'bin', 'node')), nodeBinBefore, 'the Node binary is byte-for-byte unchanged');
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310')), false, 'the refused install leaves nothing behind');
});

test('a run admitted while the download is in flight still blocks the replacement (#735)', async t => {
  const { root, tools, store, upstream, superUser } = await toolApiScaffold(t, 'agent-tools-admit-');

  await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  const versionDir = join(root, 'codex', '0.166.0');
  const sentinel = join(versionDir, 'SENTINEL');
  writeFileSync(sentinel, 'must survive');
  const manifestBefore = readFileSync(join(versionDir, 'manifest.json'));
  const inodeBefore = statSync(versionDir).ino;

  // Nothing is active when install() starts; the run is admitted while the codex archive is being downloaded, so only
  // the check at the replacement point can see it.
  let admitted = null;
  upstream.setBeforeCodexDownload(version => {
    if (version !== '0.166.0' || admitted) return;
    admitted = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
    store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", admitted.id);
    recordRunCliVersion(store, admitted.id, '0.166.0');
  });

  await assert.rejects(
    () => agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 }),
    { status: 409, code: 'agent_tool_version_in_use' },
    'the replacement is refused even though the entry check saw no active run',
  );
  upstream.setBeforeCodexDownload(null);
  assert.notEqual(admitted, null, 'the mock admitted the run during the download');
  assert.equal(existsSync(sentinel), true, 'the in-use directory is not removed by the in-flight install');
  assert.deepEqual(readFileSync(join(versionDir, 'manifest.json')), manifestBefore, 'the in-use manifest is byte-for-byte unchanged');
  assert.equal(statSync(versionDir).ino, inodeBefore, 'the in-use directory is the same inode, never replaced');

  endRun(store, admitted, 'completed', null);
  const again = await agentToolsApi(store, tools, superUser, 'POST', '/api/agent-tools/install', { cli: 'codex', version: '0.166.0', retain_count: 2 });
  assert.equal(again.installed.version, '0.166.0');
  assert.equal(existsSync(sentinel), false, 'after the run finished the replacement really happens');
});


test('prune keeps a protected version whose manifest is no longer readable and reports it instead of deleting it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  // The running task executes 0.166.0 while that directory's manifest has become unreadable. The directory is still
  // the one the run executes, so the sweep must keep it and report it, not delete it as a broken leftover.
  writeFileSync(join(root, 'codex', '0.166.0', 'manifest.json'), '{"schema":');
  const pruned = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.codex, ['0.166.0']);
  assert.deepEqual(pruned.pruned.codex, []);
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);
});

test('the directory kept for an active run is cleared by the next prune once that run ends', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-invalid-after-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');
  writeFileSync(join(root, 'codex', '0.166.0', 'manifest.json'), '{"schema":');

  const kept = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(kept.protected_invalid.codex, ['0.166.0']);
  assert.equal(existsSync(join(root, 'codex', '0.166.0')), true);

  // Nothing protects the directory once the run is over, so the very next sweep clears it and reports nothing left.
  endRun(store, run, 'completed', null);
  const after = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(after.protected_invalid.codex, []);
  assert.deepEqual(after.pruned.codex, []);
  assert.equal(existsSync(join(root, 'codex', '0.166.0')), false);
});

test('prune keeps the Node runtime a protected claude_code directory can no longer name', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-node-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  // The JS-package claude_code version launches through the bundled Node runtime, named only in its manifest.
  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '2.1.310');

  // The run executes 2.1.310 and its manifest has become unreadable, so nothing can say which Node runtime it needs.
  // Keeping the directory but deleting that runtime would still take the binary away from the run.
  writeFileSync(join(root, 'claude_code', '2.1.310', 'manifest.json'), '{"schema":');
  const pruned = await manager.prune({ cli: 'claude_code', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.claude_code, ['2.1.310']);
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310', 'bin', 'claude')), true);
  assert.equal(existsSync(join(root, 'node', '22.15.0', 'bin', 'node')), true, 'the Node runtime the kept directory executes is kept too');

  // With the run over, the directory goes and the runtime it was the last user of goes with it.
  endRun(store, run, 'completed', null);
  const after = await manager.prune({ cli: 'claude_code', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(after.protected_invalid.claude_code, []);
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310')), false);
  assert.equal(existsSync(join(root, 'node', '22.15.0')), false);
});

test('a broken version no run holds is still cleared while the protected one is kept', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-protected-and-broken-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '0.166.0');

  // Two directories stopped parsing: one is executed by the run, the other is a broken leftover no run points at.
  writeFileSync(join(root, 'codex', '0.166.0', 'manifest.json'), '{"schema":');
  writeFileSync(join(root, 'codex', '0.167.0', 'manifest.json'), '{"schema":');
  const pruned = await manager.prune({ cli: 'codex', retainCount: 2, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.codex, ['0.166.0'], 'only the protected directory is reported');
  assert.deepEqual(pruned.pruned.codex, [], 'a leftover broken directory is cleared silently, not reported as pruned');
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);
  assert.equal(existsSync(join(root, 'codex', '0.167.0')), false, 'the unprotected broken directory is still cleared');
});

test('a codex-only prune never reclaims Node runtimes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-node-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  await manager.install({ cli: 'codex', version: '0.166.0' });
  await manager.install({ cli: 'codex', version: '0.167.0' });
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '2.1.310');
  writeFileSync(join(root, 'claude_code', '2.1.310', 'manifest.json'), '{"schema":');

  // Node runtimes are launched by claude_code alone and only its manifests name them, so a codex-only sweep cannot
  // know which runtime a kept claude_code directory executes. It must not walk node/ at all: the directory here is
  // protected and its manifest unreadable, exactly the case the claude_code pass keeps the runtime for.
  const pruned = await manager.prune({ cli: 'codex', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.pruned.codex, ['0.166.0']);
  assert.deepEqual(pruned.protected_invalid.codex, [], 'the claude_code directory is not the codex pass to judge');
  assert.equal(existsSync(join(root, 'node', '22.15.0', 'bin', 'node')), true, 'a codex-only prune leaves the Node runtimes alone');
  assert.equal(existsSync(join(root, 'claude_code', '2.1.310', 'bin', 'claude')), true, 'the claude_code directory is untouched by it too');
});

test('an unreadable manifest still names the Node runtime to keep', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-node-lenient-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  store.run("INSERT INTO accounts VALUES('a','org','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('r','org/repo','org','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t1','r','task.request','running','test','{}',1,1)");

  await manager.install({ cli: 'claude_code', version: '2.1.310' });
  // A second runtime left behind by an earlier claude_code install, which nothing on the volume references any more.
  mkdirSync(join(root, 'node', '23.9.9', 'bin'), { recursive: true });
  writeFileSync(join(root, 'node', '23.9.9', 'bin', 'node'), '');
  const run = beginRun(store, store.get("SELECT * FROM tasks WHERE id='t1'"), 'execution', {});
  store.run("UPDATE task_runs SET role='developer',harness='claude_code',harness_version='1' WHERE id=?", run.id);
  allocateLease(store, 't1', 'assign-1', run.id);
  recordRunCliVersion(store, run.id, '2.1.310');

  // The manifest stopped parsing, but its text still names the runtime the directory launches. Reading that name out of
  // the raw file keeps exactly one runtime instead of keeping every runtime on the volume for one more sweep.
  writeFileSync(join(root, 'claude_code', '2.1.310', 'manifest.json'), '{"schema": "broken", "node_version": "22.15.0", ');
  const pruned = await manager.prune({ cli: 'claude_code', retainCount: 1, protectedVersions: c => activeCliVersions(store, c) });
  assert.deepEqual(pruned.protected_invalid.claude_code, ['2.1.310']);
  assert.equal(existsSync(join(root, 'node', '22.15.0', 'bin', 'node')), true, 'the runtime the manifest text names is kept');
  assert.equal(existsSync(join(root, 'node', '23.9.9')), false, 'the runtime nothing names is still reclaimed');
});

test('install verifies optional native_sha256 for claude_code and sweeps leftover .staging directories on install and prune', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-native-sha-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', libc: 'glibc', sources: upstream.sources });
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  roleRunStorage(store);
  const superUser = { id: 'u-super', role: 'super_admin', repositories: [] };

  // Leftover .staging directory from an interrupted process is swept automatically on install.
  mkdirSync(join(root, '.staging', 'interrupted-claude-run'), { recursive: true });
  writeFileSync(join(root, '.staging', 'interrupted-claude-run', 'partial.bin'), 'stale');

  await assert.rejects(
    () => agentToolsApi(store, manager, superUser, 'POST', '/api/agent-tools/install', {
      cli: 'codex',
      version: '0.166.0',
      native_sha256: 'a'.repeat(64),
    }),
    { status: 400, code: 'invalid_agent_tool_native_sha256' },
  );

  await assert.rejects(
    () => agentToolsApi(store, manager, superUser, 'POST', '/api/agent-tools/install', {
      cli: 'claude_code',
      version: '2.1.319',
      native_sha256: 'f'.repeat(64),
    }),
    { status: 502, code: 'agent_tool_hash_mismatch' },
  );
  assert.equal(existsSync(join(root, 'claude_code', '2.1.319')), false);
  assert.equal(existsSync(join(root, '.staging', 'interrupted-claude-run')), false, 'install swept stale .staging directory');

  const expectedNativeSha256 = upstream.claudeVersions.get('2.1.319').glibcNativeHash.sha256;
  const installed = await agentToolsApi(store, manager, superUser, 'POST', '/api/agent-tools/install', {
    cli: 'claude_code',
    version: '2.1.319',
    native_sha256: expectedNativeSha256,
  });
  assert.equal(installed.compatible, true);
  assert.equal(installed.status.clis.claude_code.selected_version, '2.1.319');

  // Leftover .staging directory is also swept during prune.
  mkdirSync(join(root, '.staging', 'another-crashed-stage'), { recursive: true });
  writeFileSync(join(root, '.staging', 'another-crashed-stage', 'partial.bin'), 'stale');
  await manager.prune({ retainCount: 2 });
  assert.equal(existsSync(join(root, '.staging', 'another-crashed-stage')), false);
  assert.equal(existsSync(join(root, 'claude_code', '2.1.319', 'bin', 'claude')), true);
});

function buildSyntheticElf64WithInterp(interp) {
  const interpBytes = Buffer.from(interp + '\0', 'utf8');
  const hdrSize = 64;
  const phdrSize = 56;
  const interpOffset = hdrSize + phdrSize;
  const buf = Buffer.alloc(interpOffset + interpBytes.length);
  // ELF magic + 64-bit little-endian
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
  buf[4] = 2; // EI_CLASS = ELFCLASS64
  buf[5] = 1; // EI_DATA = ELFDATA2LSB
  buf[6] = 1; // EI_VERSION
  buf.writeBigUInt64LE(BigInt(hdrSize), 32); // e_phoff
  buf.writeUInt16LE(phdrSize, 54); // e_phentsize
  buf.writeUInt16LE(1, 56); // e_phnum
  // Program header 0: PT_INTERP (p_type = 3)
  buf.writeUInt32LE(3, hdrSize);
  buf.writeBigUInt64LE(BigInt(interpOffset), hdrSize + 8); // p_offset
  buf.writeBigUInt64LE(BigInt(interpBytes.length), hdrSize + 32); // p_filesz
  interpBytes.copy(buf, interpOffset);
  return buf;
}

test('detectElfInterpreterLibc and detectHostLibc avoid process.report.getReport event-loop stalls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tools-elf-libc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const glibcElf = join(dir, 'node-glibc');
  writeFileSync(glibcElf, buildSyntheticElf64WithInterp('/lib64/ld-linux-x86-64.so.2'));
  assert.equal(detectElfInterpreterLibc(glibcElf), 'glibc');

  const muslX64Elf = join(dir, 'node-musl-x64');
  writeFileSync(muslX64Elf, buildSyntheticElf64WithInterp('/lib/ld-musl-x86_64.so.1'));
  assert.equal(detectElfInterpreterLibc(muslX64Elf), 'musl');

  const muslArm64Elf = join(dir, 'node-musl-arm64');
  writeFileSync(muslArm64Elf, buildSyntheticElf64WithInterp('/lib/ld-musl-aarch64.so.1'));
  assert.equal(detectElfInterpreterLibc(muslArm64Elf), 'musl');

  const nonElf = join(dir, 'not-an-elf');
  writeFileSync(nonElf, '#!/bin/sh\necho hi\n');
  assert.equal(detectElfInterpreterLibc(nonElf), null);

  const origGetReport = process.report?.getReport;
  if (process.report && typeof origGetReport === 'function') {
    process.report.getReport = () => {
      throw new Error('process.report.getReport must never be called by detectHostLibc or inspectAgentTools');
    };
    t.after(() => { process.report.getReport = origGetReport; });
  }

  const libc = detectHostLibc();
  assert.ok(libc === 'glibc' || libc === 'musl');
  const status = inspectAgentTools(dir, { arch: 'x64' });
  assert.equal(status.volume_present, true);
});

test('installCodex falls back to deterministic release URL when GitHub API is rate-limited and sha256 is pinned', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-codex-ratelimit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await startMockToolUpstream(t, 'x64');
  upstream.setRateLimitGithubApi(true);
  const manager = new AgentToolManager({ volumeRoot: root, containerRoot: root, arch: 'x64', sources: upstream.sources });

  // Without a pinned sha256, rate-limited GitHub API must still fail rather than trusting an unverified archive.
  await assert.rejects(
    () => manager.install({ cli: 'codex', version: '0.166.0' }),
    { code: 'agent_tool_download_failed' },
  );

  // With a pinned sha256, a wrong digest is still rejected.
  await assert.rejects(
    () => manager.install({ cli: 'codex', version: '0.166.0', sha256: '0'.repeat(64) }),
    { code: 'agent_tool_hash_mismatch' },
  );

  // With the authentic pinned sha256, installation succeeds directly from the configured download origin,
  // even when process.umask(0o077) is active as in src/main.ts.
  const prevUmask = process.umask(0o077);
  t.after(() => { process.umask(prevUmask); });
  const expectedSha256 = upstream.codexVersions.get('0.166.0').hash.sha256;
  const out = await manager.install({ cli: 'codex', version: '0.166.0', sha256: expectedSha256 });
  assert.equal(out.compatible, true);
  assert.equal(out.installed.version, '0.166.0');
  assert.equal(existsSync(join(root, 'codex', '0.166.0', 'bin', 'codex')), true);
  assert.equal(statSync(join(root, 'codex')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'codex', '0.166.0')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'codex', '0.166.0', 'bin')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'codex', '0.166.0', 'manifest.json')).mode & 0o777, 0o644);
  const claudeOut = await manager.install({ cli: 'claude_code', version: '2.1.319' });
  assert.equal(claudeOut.compatible, true);
  assert.equal(statSync(join(root, 'claude_code')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'claude_code', '2.1.319')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'claude_code', '2.1.319', 'bin')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'claude_code', '2.1.319', 'manifest.json')).mode & 0o777, 0o644);
  assert.equal(statSync(join(root, 'node')).mode & 0o777, 0o755);
});
