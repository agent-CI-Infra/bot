import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarGz, extractTarGzAsync } from '../../../../dist/harness/agent-tools.js';
import { buildTarGz } from '../../../fixtures/agent-tools-fixture.mjs';

test('archive entry points preserve filtering, modes, safe links, and failure cleanup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tar-entry-points-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = buildTarGz([
    { name: 'package/lib/value', content: 'kept', mode: 0o644 },
    { name: 'package/bin/value', type: 'symlink', linkname: '../lib/value' },
    { name: 'package/bin/run', content: 'executable', mode: 0o755 },
    { name: 'package/ignore.txt', content: 'excluded' },
  ]);
  for (const [name, extract] of [['sync', extractTarGz], ['async', extractTarGzAsync]]) {
    await t.test(name, async () => {
      const dest = join(root, name);
      await extract(archive, dest, { stripComponents: 1, include: path => path !== 'ignore.txt' });
      assert.equal(readFileSync(join(dest, 'bin/value'), 'utf8'), 'kept');
      assert.equal(statSync(join(dest, 'lib/value')).mode & 0o777, 0o644);
      assert.equal(statSync(join(dest, 'bin/run')).mode & 0o777, 0o755);
      assert.equal(existsSync(join(dest, 'ignore.txt')), false);
      await assert.rejects(async () => extract(Buffer.from('invalid gzip'), join(dest, 'bad')), { code: 'agent_tool_archive_invalid' });
      await assert.rejects(async () => extract(buildTarGz([
        { name: 'escape', type: 'symlink', linkname: '../../outside' },
      ]), join(dest, 'links')), { code: 'agent_tool_archive_invalid' });
      await assert.rejects(async () => extract(archive, join(dest, 'partial'), {
        stripComponents: 1, writeImpl: () => 0,
      }), { code: 'agent_tool_archive_invalid' });
      assert.equal(existsSync(join(dest, 'partial/lib/value')), false);
    });
  }
});

test('extractTarGz accepts the ordinary ./ prefix of tar writers and still refuses .. escapes', t => {
  const outer = mkdtempSync(join(tmpdir(), 'tar-dot-prefix-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  // Many tar writers prefix every entry with `./`; that is not a traversal and must not fail the install.
  const archive = buildTarGz([
    { name: './bin/tool', content: 'cli', mode: 0o755 },
    { name: './lib/value', content: 'kept' },
    { name: './', type: 'directory' },
  ]);
  const dest = join(outer, 'plain');
  extractTarGz(archive, dest);
  assert.equal(readFileSync(join(dest, 'bin/tool'), 'utf8'), 'cli');
  assert.equal(statSync(join(dest, 'bin/tool')).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(dest, 'lib/value'), 'utf8'), 'kept');
  // The dot segment is dropped before stripComponents counts, so `./package/...` strips like `package/...`.
  const stripped = join(outer, 'stripped');
  extractTarGz(archive, stripped, { stripComponents: 1 });
  assert.equal(readFileSync(join(stripped, 'tool'), 'utf8'), 'cli');
  assert.equal(readFileSync(join(stripped, 'value'), 'utf8'), 'kept');
  // A real escape is still refused, with or without a dot prefix.
  for (const name of ['../outside', './../outside', 'a/./../../outside'])
    assert.throws(() => extractTarGz(buildTarGz([{ name, content: 'nope' }]), join(outer, 'bad-' + name.replace(/\W+/g, '_'))),
      { code: 'agent_tool_archive_invalid' });
  assert.equal(existsSync(join(outer, 'outside')), false);
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
