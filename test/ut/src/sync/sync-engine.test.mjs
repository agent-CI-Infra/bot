import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import {
  FileSyncEngine,
  LocalDiskBlobStore,
  SYNC_NAMESPACE_NAMES,
  SYNC_NAMESPACE_POLICIES,
  SyncTokenService,
  buildConflictCopyPath,
  createAssistantHomesAdapter,
  createProjectNotesDirectoryAdapter,
  normalizeSyncPath,
  sha256Buffer,
  validateInternalSymlinkTarget,
} from '../../../../dist/sync/index.js';
import { publicText, Redactor } from '../../../../runner/credential-redaction.mjs';

function makeStore(dir) {
  return new Store(join(dir, 'control.sqlite'), randomBytes(32));
}

test('declarative policies cover all 6 platform directories with expected mode/history/redaction rules', () => {
  assert.deepEqual(
    [...SYNC_NAMESPACE_NAMES].sort(),
    ['agent-tools', 'assistant-homes', 'project-notes', 'project-tools', 'skill-store', 'tool-results'],
  );
  assert.equal(SYNC_NAMESPACE_POLICIES['tool-results'].mode, 'ro');
  assert.equal(SYNC_NAMESPACE_POLICIES['tool-results'].immutable, true);
  assert.equal(SYNC_NAMESPACE_POLICIES['project-tools'].mode, 'ro');
  assert.equal(SYNC_NAMESPACE_POLICIES['agent-tools'].mode, 'ro');
  assert.equal(SYNC_NAMESPACE_POLICIES['skill-store'].mode, 'ro');
  assert.equal(SYNC_NAMESPACE_POLICIES['skill-store'].immutable, true);

  for (const rw of ['project-notes', 'assistant-homes']) {
    const p = SYNC_NAMESPACE_POLICIES[rw];
    assert.equal(p.mode, 'rw');
    assert.equal(p.conflictPolicy, 'merge_or_conflict_copy');
    assert.equal(p.redact, true);
    assert.equal(p.history, true);
    assert.equal(p.allowInternalSymlinks, false);
  }
});

test('path validation blocks traversal, control chars, reserved internals, sensitive paths, and escaping symlinks', () => {
  for (const bad of [
    '',
    '/abs/path.md',
    '../escape.md',
    'a/../b.md',
    'a/./b.md',
    'a//b.md',
    'a\\b.md',
    'C:/windows.md',
    'notes\0bad.md',
    'notes\nbad.md',
    '.git/config',
    '.write-history/file-tree.json',
    '.write-lock/owner',
    '.sync-base.json',
    '.sync-base.json.tmp',
    '.sync-tmp-abc',
  ]) {
    assert.throws(() => normalizeSyncPath(bad), /sync_invalid_path/, `expected invalid path: ${JSON.stringify(bad)}`);
  }

  for (const sensitive of ['.env', '.env.production', 'keys/server.pem', 'certs/app.key', '.ssh/id_rsa', '.aws/credentials', 'secrets.json']) {
    assert.throws(() => normalizeSyncPath(sensitive, { rejectSensitivePaths: true }), /sync_sensitive_path/, sensitive);
  }

  assert.equal(normalizeSyncPath('guides/testing.md', { rejectSensitivePaths: true }), 'guides/testing.md');
  assert.equal(normalizeSyncPath('bot/.claude-plugin/plugin.json', { rejectSensitivePaths: true }), 'bot/.claude-plugin/plugin.json');

  assert.equal(validateInternalSymlinkTarget('bin/tool', '../lib/tool/cli.js'), '../lib/tool/cli.js');
  assert.throws(() => validateInternalSymlinkTarget('bin/tool', '../../etc/passwd'), /sync_symlink_forbidden/);
  assert.throws(() => validateInternalSymlinkTarget('bin/tool', '/etc/passwd'), /sync_symlink_forbidden/);
});

test('buildConflictCopyPath formats <stem>.conflict-<actorTag>-<ts><ext> and avoids collisions', () => {
  const ts = Date.UTC(2026, 10, 25, 5, 12, 34);
  const first = buildConflictCopyPath('guides/testing.md', 'Agent:Task/42', ts);
  assert.equal(first, 'guides/testing.conflict-agent-task-42-20261125T051234Z.md');

  const second = buildConflictCopyPath('guides/testing.md', 'Agent:Task/42', ts, new Set([first]));
  assert.equal(second, 'guides/testing.conflict-agent-task-42-20261125T051234Z-1.md');

  const noExt = buildConflictCopyPath('README', 'worker', ts);
  assert.equal(noExt, 'README.conflict-worker-20261125T051234Z');
});

test('LocalDiskBlobStore deduplicates, verifies hash on put/get, and detects corruption fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-blobs-'));
  try {
    const blobs = new LocalDiskBlobStore(dir);
    const data = Buffer.from('hello cas world\n', 'utf8');
    const sha = sha256Buffer(data);

    const first = await blobs.put(data, sha);
    assert.equal(first.deduplicated, false);
    assert.equal(first.sha256, sha);

    const second = await blobs.put(data, sha);
    assert.equal(second.deduplicated, true);

    assert.deepEqual(await blobs.get(sha), data);
    await assert.rejects(() => blobs.put(data, '0'.repeat(64)), /sync_blob_hash_mismatch/);

    // Corrupt blob on disk -> get fails closed with sync_blob_corrupt.
    const blobFile = join(dir, 'blobs', 'sha256', sha.slice(0, 2), sha.slice(2, 4), sha);
    writeFileSync(blobFile, 'tampered');
    await assert.rejects(() => blobs.get(sha), /sync_blob_corrupt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SyncTokenService enforces scope, mode, expiry, revocation, and Redactor auto-masks bsync_ tokens', () => {
  let now = 1_700_000_000_000;
  const tokens = new SyncTokenService(() => now);
  const issued = tokens.issue({
    actor: 'agent:task-9',
    actorTag: 'task-9',
    grants: [{ namespace: 'project-notes', scope: '42', mode: 'ro' }],
    ttlMs: 10_000,
  });
  assert.match(issued.token, /^bsync_[a-f0-9]{12}\.[a-f0-9]{48}$/);

  // Redactor recognizes bsync_ self-identifying tokens automatically.
  assert.equal(publicText(`Authorization: Bearer ${issued.token}`, new Redactor()), 'Authorization: Bearer [REDACTED]');

  const principal = tokens.authenticate(`Bearer ${issued.token}`, 'project-notes', '42', 'ro');
  assert.equal(principal.actor, 'agent:task-9');

  assert.throws(() => tokens.authenticate(`Bearer ${issued.token}`, 'project-notes', '42', 'rw'), /sync_write_forbidden/);
  assert.throws(() => tokens.authenticate(`Bearer ${issued.token}`, 'project-notes', '99', 'ro'), /sync_scope_forbidden/);
  assert.throws(() => tokens.authenticate(`Bearer ${issued.token}`, 'assistant-homes', '42', 'ro'), /sync_scope_forbidden/);
  assert.throws(() => tokens.authenticate('Bearer invalid', 'project-notes', '42', 'ro'), /sync_unauthorized/);

  now += 20_000;
  assert.throws(() => tokens.authenticate(`Bearer ${issued.token}`, 'project-notes', '42', 'ro'), /sync_unauthorized/);

  const active = tokens.issue({ actor: 'node:gpu-1', grants: [{ namespace: '*', scope: '*', mode: 'rw' }] });
  assert.equal(tokens.authenticate(`Bearer ${active.token}`, 'assistant-homes', 'a'.repeat(32), 'rw').actor, 'node:gpu-1');
  tokens.revoke(active.token_id);
  assert.throws(() => tokens.authenticate(`Bearer ${active.token}`, 'assistant-homes', 'a'.repeat(32), 'ro'), /sync_unauthorized/);
});

test('FileSyncEngine handles 3-layer conflict resolution, nightly human-edit skip, redaction, and .write-history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-engine-'));
  const store = makeStore(dir);
  try {
    // Register a configured model API key secret in SQLite so configuredRedactor scrubs it.
    const registeredSecret = 'my-registered-secret-value-987654321';
    const sealed = store.secrets.seal({ value: registeredSecret }, 'model:m1');
    store.run(
      "INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES('m1',NULL,'https://example.test','gpt-test',?,1,?)",
      sealed,
      new Date().toISOString(),
    );

    let clockMs = Date.UTC(2026, 10, 25, 6, 0, 0);
    const notesRoot = join(dir, 'project-notes');
    const homesRoot = join(dir, 'assistant-homes');
    const engine = new FileSyncEngine({
      store,
      blobStore: new LocalDiskBlobStore(join(dir, 'cas')),
      adapters: [
        createProjectNotesDirectoryAdapter(notesRoot),
        createAssistantHomesAdapter(undefined, homesRoot),
      ],
      clock: () => clockMs,
    });

    const putText = async (ns, scope, text) => {
      const buf = Buffer.from(text, 'utf8');
      const res = await engine.putBlobs(ns, scope, [{ sha256: sha256Buffer(buf), content_base64: buf.toString('base64') }]);
      return res.stored[0];
    };

    // 1. Redaction on putBlobs scrubs both registered secret and GitHub token BEFORE touching disk BlobStore.
    const leaky = `token=${registeredSecret}\ngithub=ghp_${'A'.repeat(36)}\n`;
    const putLeaky = await putText('project-notes', '42', leaky);
    assert.equal(putLeaky.redacted, true);
    const cleanedBlob = await engine.blobStore.get(putLeaky.sha256);
    assert.equal(cleanedBlob.toString('utf8'), 'token=[REDACTED]\ngithub=[REDACTED]\n');
    assert.equal(await engine.blobStore.has(sha256Buffer(Buffer.from(leaky))), false);

    // Binary containing registered secret is rejected fail-closed.
    const leakyBinary = Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0xff]), Buffer.from(registeredSecret)]);
    await assert.rejects(
      () => engine.putBlobs('project-notes', '42', [{ sha256: sha256Buffer(leakyBinary), content_base64: leakyBinary.toString('base64') }]),
      /sync_secret_detected/,
    );

    // 2. Seed initial file rev 1.
    const baseText = '# Architecture\n\n## Part 1\nbase-one\n\n## Part 2\nbase-two\n';
    const b0 = await putText('project-notes', '42', baseText);
    const c1 = await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'user:alice',
      changes: [{ path: 'arch.md', base_revision: 0, content_sha256: b0.sha256 }],
    });
    assert.equal(c1.ok, true);
    assert.equal(c1.results[0].status, 'committed');
    assert.equal(c1.results[0].revision, 1);

    // 3. Server advances Part 1 (rev 2), while another client edits Part 2 from base rev 1 -> auto 3-way merge (rev 3)!
    const serverText = baseText.replace('base-one', 'server-one');
    const bs = await putText('project-notes', '42', serverText);
    const c2 = await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'agent:task-1',
      changes: [{ path: 'arch.md', base_revision: 1, base_sha256: b0.sha256, content_sha256: bs.sha256 }],
    });
    assert.equal(c2.results[0].revision, 2);

    const clientText = baseText.replace('base-two', 'client-two');
    const bc = await putText('project-notes', '42', clientText);
    const c3 = await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'agent:task-2',
      changes: [{ path: 'arch.md', base_revision: 1, base_sha256: b0.sha256, content_sha256: bc.sha256 }],
    });
    assert.equal(c3.ok, true);
    assert.equal(c3.results[0].status, 'merged');
    assert.equal(c3.results[0].revision, 3);
    const mergedText = Buffer.from(c3.results[0].merged_content_base64, 'base64').toString('utf8');
    assert.match(mergedText, /server-one/);
    assert.match(mergedText, /client-two/);

    // 4. Layer 2 (interactive): true same-line conflict returns ok:false + sync_conflict with base/current/local diff,
    //    while a different file in the same commit succeeds independently (single-file granularity!).
    const otherFile = await putText('project-notes', '42', 'independent note\n');
    const conflictLocal = baseText.replace('base-one', 'conflicting-local-one');
    const bConf = await putText('project-notes', '42', conflictLocal);
    const c4 = await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'agent:task-3',
      changes: [
        { path: 'other.md', base_revision: 0, content_sha256: otherFile.sha256 },
        { path: 'arch.md', base_revision: 1, base_sha256: b0.sha256, content_sha256: bConf.sha256 },
      ],
    });
    assert.equal(c4.ok, false);
    assert.equal(c4.error, 'sync_conflict');
    assert.equal(c4.results[0].status, 'committed');
    assert.equal(c4.results[1].status, 'conflict');
    assert.equal(c4.conflicts.length, 1);
    assert.equal(c4.conflicts[0].current_revision, 3);
    assert.match(c4.conflicts[0].base_content, /base-one/);
    assert.match(c4.conflicts[0].current_content, /server-one/);
    assert.match(c4.conflicts[0].local_content, /conflicting-local-one/);
    assert.match(c4.conflicts[0].conflict_markers, /<<<<<<< current/);

    // 5. Layer 3 (background): same conflict preserves main file untouched and writes conflict copy + history + conflict record.
    const c5 = await engine.commit('project-notes', '42', {
      mode: 'background',
      actor: 'agent:task-3',
      actor_tag: 'task-3',
      changes: [{ path: 'arch.md', base_revision: 1, base_sha256: b0.sha256, content_sha256: bConf.sha256 }],
    });
    assert.equal(c5.ok, true);
    assert.equal(c5.results[0].status, 'conflict_copy');
    assert.equal(c5.results[0].conflict_path, 'arch.conflict-task-3-20261125T060000Z.md');
    // Main file stayed at merged rev 3 untouched!
    assert.equal(readFileSync(join(notesRoot, '42', 'arch.md'), 'utf8'), mergedText);
    assert.equal(readFileSync(join(notesRoot, '42', c5.results[0].conflict_path), 'utf8'), conflictLocal);

    // .write-history tracks both main file revisions (1..3) and the conflict copy (rev 1).
    const mainHist = await engine.fileHistory('project-notes', '42', 'arch.md');
    assert.equal(mainHist.versions.length, 3);
    const copyHist = await engine.fileHistory('project-notes', '42', c5.results[0].conflict_path);
    assert.equal(copyHist.versions.length, 1);

    // 6. Nightly consolidation guard: if a human edited the file after base_revision, skip cleanly!
    const humanEdit = await putText('project-notes', '42', mergedText + '\nhuman note\n');
    const cHuman = await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'user:bob',
      changes: [{ path: 'arch.md', base_revision: 3, base_sha256: c3.results[0].sha256, content_sha256: humanEdit.sha256 }],
    });
    assert.equal(cHuman.results[0].revision, 4);

    const nightlyRewrite = await putText('project-notes', '42', '# Completely reorganized by nightly\n');
    const cNightly = await engine.commit('project-notes', '42', {
      mode: 'background',
      actor: 'consolidation:nightly',
      skip_if_human_edited: true,
      changes: [{ path: 'arch.md', base_revision: 3, base_sha256: c3.results[0].sha256, content_sha256: nightlyRewrite.sha256 }],
    });
    assert.equal(cNightly.ok, true);
    assert.equal(cNightly.results[0].status, 'skipped_human_edited');
    assert.equal(cNightly.results[0].current_actor, 'user:bob');
    assert.equal(readFileSync(join(notesRoot, '42', 'arch.md'), 'utf8'), mergedText + '\nhuman note\n');

    // Conflict audit table recorded interactive rejection, conflict_copy, and skipped_human_edited.
    const conflicts = engine.listConflicts('project-notes', '42');
    assert.equal(conflicts.length, 3);
    assert.deepEqual(
      conflicts.map(c => c.resolution).sort(),
      ['conflict_copy', 'rejected_interactive', 'skipped_human_edited'],
    );

    // 7. Symlink placed directly in notes directory cannot be overwritten or escaped.
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'secret outside file');
    symlinkSync(outside, join(notesRoot, '42', 'escape.md'));
    const probeBlob = await putText('project-notes', '42', 'overwrite attempt');
    await assert.rejects(
      () => engine.commit('project-notes', '42', {
        mode: 'interactive',
        actor: 'agent:task-4',
        changes: [{ path: 'escape.md', base_revision: 0, content_sha256: probeBlob.sha256 }],
      }),
      /sync_(?:invalid_path|symlink_forbidden)/,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'secret outside file');

    // 8. Same engine works identically on `assistant-homes` namespace.
    const ownerHash = 'a'.repeat(32);
    const memBlob = await putText('assistant-homes', ownerHash, '# Group Memory\nPreference: concise\n');
    const cMem = await engine.commit('assistant-homes', ownerHash, {
      mode: 'interactive',
      actor: 'assistant:group-1',
      changes: [{ path: 'INDEX.md', base_revision: 0, content_sha256: memBlob.sha256 }],
    });
    assert.equal(cMem.ok, true);
    assert.equal(readFileSync(join(homesRoot, ownerHash, 'home-1', 'memory', 'INDEX.md'), 'utf8'), '# Group Memory\nPreference: concise\n');
    const memHist = await engine.fileHistory('assistant-homes', ownerHash, 'INDEX.md');
    assert.equal(memHist.versions.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
