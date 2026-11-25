import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasCache, sha256Bytes, validateRelativeSyncPath } from '../../../runner/sync-client.mjs';

test('CasCache deduplicates, hardlinks non-executable ro targets, copies rw/executable targets, and fails closed on corruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-client-ut-'));
  try {
    const cas = new CasCache(join(dir, 'cas'));
    const data = Buffer.from('#!/bin/sh\necho hi\n', 'utf8');
    const sha = sha256Bytes(data);

    const p1 = await cas.put(data, sha);
    assert.equal(p1.deduplicated, false);
    const p2 = await cas.put(data, sha);
    assert.equal(p2.deduplicated, true);

    // Non-executable ro materialization uses hardlink (same inode).
    const roDest = join(dir, 'ro-file.txt');
    const roMat = await cas.materialize(sha, roDest, { mode: 0o444, allowHardlink: true });
    assert.equal(roMat.hardlinked, true);
    assert.equal(lstatSync(roDest).ino, lstatSync(cas.objectPath(sha)).ino);

    // Executable materialization copies so CAS inode stays 0o444 while target gets 0o755.
    const execDest = join(dir, 'tool.sh');
    const execMat = await cas.materialize(sha, execDest, { mode: 0o755, allowHardlink: true });
    assert.equal(execMat.hardlinked, false);
    assert.notEqual(lstatSync(execDest).ino, lstatSync(cas.objectPath(sha)).ino);
    assert.equal((lstatSync(execDest).mode & 0o111) !== 0, true);
    assert.equal((lstatSync(cas.objectPath(sha)).mode & 0o111) === 0, true);

    // rw materialization copies so local edits never corrupt CAS!
    const rwDest = join(dir, 'rw-file.md');
    const rwMat = await cas.materialize(sha, rwDest, { mode: 0o644, allowHardlink: false });
    assert.equal(rwMat.hardlinked, false);
    writeFileSync(rwDest, 'edited locally\n');
    assert.equal((await cas.get(sha)).toString('utf8'), '#!/bin/sh\necho hi\n');
    assert.equal(readFileSync(rwDest, 'utf8'), 'edited locally\n');

    // Corrupting CAS object fails closed on get.
    chmodSync(cas.objectPath(sha), 0o644);
    writeFileSync(cas.objectPath(sha), 'corrupted');
    await assert.rejects(() => cas.get(sha), /sync_cas_corrupt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateRelativeSyncPath refuses traversal, absolute, control chars, and internal metadata paths', () => {
  for (const bad of ['', '/etc/passwd', '../a', 'a/../b', 'a\\b', 'a\0b', '.git/HEAD', '.sync-base.json', '.write-history/x']) {
    assert.throws(() => validateRelativeSyncPath(bad), /sync_invalid_path/, bad);
  }
  assert.equal(validateRelativeSyncPath('notes/daily/2026.md'), 'notes/daily/2026.md');
});
