import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BUNDLED_UV_RELEASE, icodeReleases, workswarmLaunch, workswarmReleases } from '../../runner/agent-products.mjs';

// The mock download upstream for the agent tool volume: an in-memory npm registry, a Node dist server, a GitHub
// release API, raw GitHub source endpoints, and GitHub download origins serving deterministic archives for all 4
// managed agents (Claude Code, Codex, iCode, WorkSwarm) plus Node and uv runtimes.
/** Builds a minimal USTAR .tar.gz archive in memory for deterministic tests. */
export function buildTarGz(entries) {
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

export function hashes(bytes) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  };
}

function stageBundleDigest(files) {
  const digest = createHash('sha256');
  for (const [name, content] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    digest.update(JSON.stringify([name, createHash('sha256').update(content).digest('hex')]) + '\n');
  }
  return digest.digest('hex');
}

export function createMockAcpBuilder(volumeRoot) {
  const calls = [];
  const builder = async req => {
    calls.push({ ...req });
    const release = workswarmReleases.get(req.version);
    const versionDir = join(volumeRoot, 'acp', req.product, req.version);
    mkdirSync(join(versionDir, 'venv', 'bin'), { recursive: true });
    const pyBin = join(versionDir, 'venv', 'bin', 'python');
    writeFileSync(pyBin, '#!/bin/sh\necho "workswarm-mock-python"\n', { mode: 0o755 });
    chmodSync(pyBin, 0o755);
    writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify({
      schema: 'bot.acp-product/1',
      id: req.product,
      version: req.version,
      python: release?.python ?? '3.13.18',
      installed_at: new Date().toISOString(),
      source: `https://github.com/${release?.repo ?? 'openJiuwen-ai/jiuwenswarm'}/commit/${release?.commit ?? '0'.repeat(40)}`,
      sourceSha256: release?.sourceSha256 ?? '0'.repeat(64),
      lockSha256: release?.lockSha256 ?? '0'.repeat(64),
      launch: workswarmLaunch,
    }, null, 2) + '\n', { mode: 0o644 });
  };
  return { builder, calls };
}

export async function startMockToolUpstream(t, arch = 'x64') {
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

  const uvAsset = BUNDLED_UV_RELEASE.assets[arch];
  const uvTar = buildTarGz([
    {
      name: uvAsset.entry,
      mode: 0o755,
      content: `#!/bin/sh\necho "uv ${BUNDLED_UV_RELEASE.version}"\n`,
    },
  ]);
  const uvHash = hashes(uvTar);

  const claudeVersions = new Map();
  for (const ver of ['1.9.0', '2.1.310', '2.1.315', '2.1.319', '2.1.320', '3.0.0']) {
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
  for (const ver of ['0.165.0', '0.166.0', '0.167.0', '0.168.0', '1.0.0']) {
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

  const icodeRelease = icodeReleases.get('0.36.0');
  const icodeTar = buildTarGz([
    {
      name: 'icode',
      mode: 0o755,
      content: '#!/bin/sh\necho "icode 0.36.0"\n',
    },
  ]);
  const icodeHash = hashes(icodeTar);

  const wsRelease = workswarmReleases.get('0.2.9');
  const wsPyproject = Buffer.from('[project]\nname = "workswarm"\nversion = "0.2.9"\n', 'utf8');
  const wsLock = Buffer.from('version = 1\n# mock uv.lock for 0.2.9\n', 'utf8');
  const wsWheel = Buffer.from('PK\x03\x04mock-workswarm-0.2.9-wheel', 'utf8');
  const wsDigests = {
    pyprojectSha256: hashes(wsPyproject).sha256,
    lockSha256: hashes(wsLock).sha256,
    wheelSha256: hashes(wsWheel).sha256,
    sourceSha256: stageBundleDigest({
      'pyproject.toml': wsPyproject,
      'uv.lock': wsLock,
      [wsRelease.wheel]: wsWheel,
    }),
  };

  let tamperClaudeHash = false;
  let tamperICodeHash = false;
  let tamperWorkSwarmHash = false;
  let untrustedRedirect = false;
  let rateLimitGithubApi = false;
  const failingProducts = new Set();
  let requestCount = 0;
  // Runs while the codex archive is being served, i.e. after install() passed its entry check and before the replace.
  let beforeCodexDownload = null;

  const server = createServer((req, res) => {
    requestCount++;
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

    if (u.pathname === `/gh-dl/${BUNDLED_UV_RELEASE.repo}/releases/download/${BUNDLED_UV_RELEASE.version}/${uvAsset.name}`) {
      if (failingProducts.has('uv')) { res.writeHead(502); res.end('uv failed'); return; }
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(uvTar);
      return;
    }

    if (u.pathname === `/gh-dl/${icodeRelease.repo}/releases/download/${icodeRelease.tag}/${icodeRelease.assets[arch]}`) {
      if (failingProducts.has('icode')) { res.writeHead(502); res.end('icode failed'); return; }
      if (untrustedRedirect) {
        res.writeHead(302, { location: 'https://evil.example.invalid/icode.tar.gz' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(tamperICodeHash ? Buffer.concat([icodeTar, Buffer.from('x')]) : icodeTar);
      return;
    }

    if (u.pathname === `/gh-raw/${wsRelease.repo}/${wsRelease.commit}/pyproject.toml`) {
      if (failingProducts.has('workswarm')) { res.writeHead(502); res.end('workswarm failed'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(wsPyproject);
      return;
    }
    if (u.pathname === `/gh-raw/${wsRelease.repo}/${wsRelease.commit}/uv.lock`) {
      if (failingProducts.has('workswarm')) { res.writeHead(502); res.end('workswarm failed'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(wsLock);
      return;
    }
    if (u.pathname === `/gh-dl/${wsRelease.repo}/releases/download/${wsRelease.tag}/${wsRelease.wheel}`) {
      if (failingProducts.has('workswarm')) { res.writeHead(502); res.end('workswarm failed'); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tamperWorkSwarmHash ? Buffer.concat([wsWheel, Buffer.from('bad')]) : wsWheel);
      return;
    }

    const claudeMeta = /^\/npm\/@anthropic-ai%2fclaude-code\/([^/]+)$/.exec(u.pathname);
    if (claudeMeta) {
      if (failingProducts.has('claude_code')) { res.writeHead(502); res.end('claude failed'); return; }
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
      if (failingProducts.has('codex')) { res.writeHead(502); res.end('codex failed'); return; }
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
      if (failingProducts.has('codex')) { res.writeHead(502); res.end('codex failed'); return; }
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
      rawGithubOrigins: [`${origin}/gh-raw`],
      allowLoopbackHttp: true,
      testDigests: {
        uv: { [arch]: uvHash.sha256 },
        icode: { [`0.36.0:${arch}`]: icodeHash.sha256 },
        workswarm: { '0.2.9': wsDigests },
      },
    },
    setTamperClaudeHash: v => { tamperClaudeHash = v; },
    setTamperICodeHash: v => { tamperICodeHash = v; },
    setTamperWorkSwarmHash: v => { tamperWorkSwarmHash = v; },
    setUntrustedRedirect: v => { untrustedRedirect = v; },
    setRateLimitGithubApi: v => { rateLimitGithubApi = v; },
    setFailProduct: (name, fail) => { if (fail) failingProducts.add(name); else failingProducts.delete(name); },
    setBeforeCodexDownload: fn => { beforeCodexDownload = fn; },
    get requestCount() { return requestCount; },
    resetRequestCount: () => { requestCount = 0; },
    claudeVersions,
    codexVersions,
    icodeHash,
    uvHash,
    wsDigests,
  };
}

export function nativeVersionsOr(map, ver) {
  return map.get(ver);
}
