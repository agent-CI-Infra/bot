import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { RetentionCleanup } from '../../../../dist/storage/retention.js';
import {
  FileSyncEngine,
  LocalDiskBlobStore,
  ManagerProjectNotesAdapter,
  SYNC_NAMESPACE_NAMES,
  SYNC_NAMESPACE_POLICIES,
  SyncTokenService,
  buildConflictCopyPath,
  createAssistantHomesAdapter,
  createProjectNotesDirectoryAdapter,
  deleteAssistantSyncData,
  deleteProjectSyncData,
  isSensitiveSyncPath,
  normalizeSyncPath,
  pruneSyncData,
  sha256Buffer,
  validateInternalSymlinkTarget,
} from '../../../../dist/sync/index.js';
import { isSensitiveSyncPath as clientIsSensitiveSyncPath } from '../../../../runner/sync-client.mjs';
import { HttpError } from '../../../../dist/core/security.js';
import { Notes } from '../../../../runner/notes.mjs';
import { noteComponent, notePath } from '../../../../runner/note-path.mjs';
import { FileTree } from '../../../../manager/file-tree.mjs';
import { publicText, Redactor } from '../../../../runner/credential-redaction.mjs';

function makeStore(dir, key = randomBytes(32)) {
  return new Store(join(dir, 'control.sqlite'), key);
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
    assert.equal(p.redactionPolicy, 'reject');
    assert.equal(p.history, true);
    assert.equal(p.allowInternalSymlinks, false);
  }
});

test('path validation blocks traversal, control chars, reserved internals (.sync-*), sensitive paths, and escaping symlinks', () => {
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
    '.sync-custom',
  ]) {
    assert.throws(() => normalizeSyncPath(bad), /sync_invalid_path/, `expected invalid path: ${JSON.stringify(bad)}`);
  }

  for (const internalSync of ['.sync-base.json', '.sync-base.json.tmp-1', '.sync-tmp-123']) {
    assert.throws(() => noteComponent(internalSync), /invalid_note_name/);
    assert.throws(() => notePath(internalSync), /invalid_note_path/);
  }

  for (const sensitive of [
    '.env',
    '.env.production',
    'keys/server.pem',
    'certs/app.key',
    '.ssh/id_rsa',
    '.aws/credentials',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    '.pgpass',
    '.my.cnf',
    '.git-credentials',
    'netrc',
    '_netrc',
    'auth.json',
    '.credentials.json',
    'service-account.json',
    'kubeconfig',
    '.kube/config',
    '.claude/.credentials.json',
    '.codex/auth.json',
    'manager.token',
    'shadow',
    'gshadow',
    '.htpasswd',
    'keys/ssh.ppk',
    'vault.kdbx',
    'corp.ovpn',
    'cert.pkcs12',
  ]) {
    assert.equal(isSensitiveSyncPath(sensitive), true, `server sensitive: ${sensitive}`);
    assert.equal(clientIsSensitiveSyncPath(sensitive), true, `client sensitive: ${sensitive}`);
    assert.throws(() => normalizeSyncPath(sensitive, { rejectSensitivePaths: true }), /sync_sensitive_path/, sensitive);
  }
  for (const benign of ['guides/testing.md', 'bot/.claude-plugin/plugin.json', 'src/credentials.ts', 'docs/auth-notes.md']) {
    assert.equal(isSensitiveSyncPath(benign), false, `server benign: ${benign}`);
    assert.equal(clientIsSensitiveSyncPath(benign), false, `client benign: ${benign}`);
  }

  assert.equal(normalizeSyncPath('guides/testing.md', { rejectSensitivePaths: true }), 'guides/testing.md');
  assert.equal(normalizeSyncPath('bot/.claude-plugin/plugin.json', { rejectSensitivePaths: true }), 'bot/.claude-plugin/plugin.json');

  assert.equal(validateInternalSymlinkTarget('bin/tool', '../lib/tool/cli.js'), '../lib/tool/cli.js');
  assert.throws(() => validateInternalSymlinkTarget('bin/tool', '../../etc/passwd'), /sync_symlink_forbidden/);
  assert.throws(() => validateInternalSymlinkTarget('bin/tool', '/etc/passwd'), /sync_symlink_forbidden/);
});

test('buildConflictCopyPath formats <stem>.conflict-<actorTag>-<ts><ext>, avoids collisions, and enforces <= 255 UTF-8 bytes even with huge extensions', async () => {
  const ts = Date.UTC(2026, 10, 25, 5, 12, 34);
  const first = buildConflictCopyPath('guides/testing.md', 'Agent:Task/42', ts);
  assert.equal(first, 'guides/testing.conflict-agent-task-42-20261125T051234Z.md');

  const second = buildConflictCopyPath('guides/testing.md', 'Agent:Task/42', ts, new Set([first]));
  assert.equal(second, 'guides/testing.conflict-agent-task-42-20261125T051234Z-1.md');

  const noExt = buildConflictCopyPath('README', 'worker', ts);
  assert.equal(noExt, 'README.conflict-worker-20261125T051234Z');

  // Edge cases: 201-byte extension (`a.` + 200 `'x'`), 255-byte ASCII stem, multi-byte UTF-8 CJK + emoji stem.
  const longExtInput = `sub/a.${'x'.repeat(200)}`;
  const longAsciiInput = `${'a'.repeat(252)}.md`;
  const longUtf8Input = `${'知'.repeat(80)}🔥.md`;
  const longTag = 'a'.repeat(40);
  for (const input of [longExtInput, longAsciiInput, longUtf8Input]) {
    const c1 = buildConflictCopyPath(input, longTag, ts);
    const c2 = buildConflictCopyPath(input, longTag, ts, new Set([c1]));
    for (const candidate of [c1, c2]) {
      const seg = posix.basename(candidate);
      assert.ok(Buffer.byteLength(seg) <= 255, `segment exceeded 255 bytes (${Buffer.byteLength(seg)}): ${seg}`);
      assert.equal(notePath(candidate), candidate);
    }
  }

  // Verify Notes.saveFile accepts the conflict copy generated from `a.` + 200 `'x'`.
  const dir = mkdtempSync(join(tmpdir(), 'sync-longext-'));
  try {
    const notes = new Notes(dir);
    const copyPath = buildConflictCopyPath(`a.${'x'.repeat(200)}`, longTag, ts);
    const saved = await notes.saveFile(copyPath, 'preserved conflict copy\n', 0, 'agent:worker');
    assert.equal(saved.revision, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('SyncTokenService persists across restarts, audits issue/revoke, enforces scope/mode/expiry, and Redactor auto-masks bsync_ tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-tokens-'));
  const key = randomBytes(32);
  let store = makeStore(dir, key);
  try {
    let now = 1_700_000_000_000;
    const tokens = new SyncTokenService(store, () => now);
    const issued = tokens.issue({
      actor: 'agent:task-9',
      actorTag: 'task-9',
      grants: [{ namespace: 'project-notes', scope: '42', mode: 'ro' }],
      ttlMs: 10_000,
      createdBy: 'admin-1',
    });
    assert.match(issued.token, /^bsync_[a-f0-9]{12}\.[a-f0-9]{48}$/);

    // Redactor recognizes bsync_ self-identifying tokens automatically.
    assert.equal(publicText(`Authorization: Bearer ${issued.token}`, new Redactor()), 'Authorization: Bearer [REDACTED]');

    // Listing exposes metadata only — never raw secret or hash.
    const listed = tokens.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].token_id, issued.token_id);
    assert.equal('token' in listed[0], false);
    assert.equal('secret_hash' in listed[0], false);

    // Reopen SQLite store to verify persistence across restarts!
    store.close();
    store = makeStore(dir, key);
    const reloaded = new SyncTokenService(store, () => now);

    const principal = reloaded.authenticate(`Bearer ${issued.token}`, 'project-notes', '42', 'ro');
    assert.equal(principal.actor, 'agent:task-9');

    assert.throws(() => reloaded.authenticate(`Bearer ${issued.token}`, 'project-notes', '42', 'rw'), /sync_write_forbidden/);
    assert.throws(() => reloaded.authenticate(`Bearer ${issued.token}`, 'project-notes', '99', 'ro'), /sync_scope_forbidden/);
    assert.throws(() => reloaded.authenticate(`Bearer ${issued.token}`, 'assistant-homes', '42', 'ro'), /sync_scope_forbidden/);
    assert.throws(() => reloaded.authenticate('Bearer invalid', 'project-notes', '42', 'ro'), /sync_unauthorized/);

    now += 20_000;
    assert.throws(() => reloaded.authenticate(`Bearer ${issued.token}`, 'project-notes', '42', 'ro'), /sync_unauthorized/);

    const active = reloaded.issue({ actor: 'node:gpu-1', grants: [{ namespace: '*', scope: '*', mode: 'rw' }], createdBy: 'admin-1' });
    assert.equal(reloaded.authenticate(`Bearer ${active.token}`, 'assistant-homes', 'a'.repeat(32), 'rw').actor, 'node:gpu-1');
    assert.equal(reloaded.revoke(active.token_id, 'admin-2'), true);
    assert.throws(() => reloaded.authenticate(`Bearer ${active.token}`, 'assistant-homes', 'a'.repeat(32), 'ro'), /sync_unauthorized/);

    // Audit rows recorded for issuance and revocation.
    const audits = store.all("SELECT user_id,action,resource_id FROM audit WHERE action LIKE 'sync.token.%' ORDER BY rowid");
    assert.deepEqual(
      audits.map(r => [r.user_id, r.action, r.resource_id]),
      [
        ['admin-1', 'sync.token.issued', issued.token_id],
        ['admin-1', 'sync.token.issued', active.token_id],
        ['admin-2', 'sync.token.revoked', active.token_id],
      ],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileSyncEngine handles 3-layer conflict resolution, nightly human-edit skip, fail-closed secret rejection, opt-in redaction, and .write-history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-engine-'));
  const store = makeStore(dir);
  try {
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
    mkdirSync(notesRoot, { recursive: true });
    mkdirSync(homesRoot, { recursive: true });
    const engine = new FileSyncEngine({
      store,
      blobStore: new LocalDiskBlobStore(store.syncBlobsDir),
      adapters: [
        createProjectNotesDirectoryAdapter(notesRoot, store),
        createAssistantHomesAdapter(undefined, homesRoot, store),
      ],
      clock: () => clockMs,
    });

    const putText = async (ns, scope, text) => {
      const buf = Buffer.from(text, 'utf8');
      const res = await engine.putBlobs(ns, scope, [{ sha256: sha256Buffer(buf), content_base64: buf.toString('base64') }]);
      return res.stored[0];
    };

    // 1. Default policy (`redactionPolicy: 'reject'`) fails closed on text & binary secrets without persisting blob!
    const leaky = `token=${registeredSecret}\ngithub=ghp_${'A'.repeat(36)}\n`;
    const leakyBuf = Buffer.from(leaky, 'utf8');
    await assert.rejects(
      () => engine.putBlobs('project-notes', '42', [{ sha256: sha256Buffer(leakyBuf), content_base64: leakyBuf.toString('base64') }]),
      err => {
        assert.equal(err.status, 400);
        assert.equal(err.code, 'sync_secret_detected');
        assert.equal(err.detail?.reason, 'registered_secret_or_token_pattern');
        assert.ok(!JSON.stringify(err.detail).includes(registeredSecret), 'error detail must never echo secret');
        return true;
      },
    );
    assert.equal(await engine.blobStore.has(sha256Buffer(leakyBuf)), false);

    const leakyBinary = Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0xff]), Buffer.from(registeredSecret)]);
    await assert.rejects(
      () => engine.putBlobs('project-notes', '42', [{ sha256: sha256Buffer(leakyBinary), content_base64: leakyBinary.toString('base64') }]),
      err => err.status === 400 && err.code === 'sync_secret_detected',
    );

    // Opt-in `redactionPolicy: 'redact'` still scrubs secrets in-place before writing to BlobStore.
    const redactEngine = new FileSyncEngine({
      store,
      blobStore: new LocalDiskBlobStore(join(dir, 'redact-cas')),
      adapters: [
        createProjectNotesDirectoryAdapter(notesRoot, store, {
          ...SYNC_NAMESPACE_POLICIES['project-notes'],
          redactionPolicy: 'redact',
        }),
      ],
      clock: () => clockMs,
    });
    const putRedacted = (await redactEngine.putBlobs('project-notes', '42', [{ sha256: sha256Buffer(leakyBuf), content_base64: leakyBuf.toString('base64') }])).stored[0];
    assert.equal(putRedacted.redacted, true);
    assert.equal((await redactEngine.blobStore.get(putRedacted.sha256)).toString('utf8'), 'token=[REDACTED]\ngithub=[REDACTED]\n');
    assert.equal(await redactEngine.blobStore.has(sha256Buffer(leakyBuf)), false);

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

    // Verify `.sync-base.json` placed alongside project-notes is ignored by Notes, FileTree, and FileSyncEngine.manifest!
    writeFileSync(join(notesRoot, '42', '.sync-base.json'), JSON.stringify({ schema: 'bot.sync-base/1', revision: 1, files: {} }));
    writeFileSync(join(notesRoot, '42', '.sync-tmp-deadbeef'), 'temp');
    const notesDirect = new Notes(join(notesRoot, '42'));
    assert.deepEqual((await notesDirect.list()).map(f => f.name), ['arch.md']);
    const treeDirect = new FileTree(join(notesRoot, '42'));
    assert.deepEqual((await treeDirect.list()).files.map(f => f.path), ['arch.md']);
    const manifestWithSyncFiles = await engine.manifest('project-notes', '42');
    assert.deepEqual(manifestWithSyncFiles.entries.map(e => e.path), ['arch.md']);

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
    assert.equal(readFileSync(join(notesRoot, '42', 'arch.md'), 'utf8'), mergedText);
    assert.equal(readFileSync(join(notesRoot, '42', c5.results[0].conflict_path), 'utf8'), conflictLocal);

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

test('cross-scope CAS isolation blocks stealing blobs via content_sha256 and leaking base_content via base_sha256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-cas-iso-'));
  const store = makeStore(dir);
  try {
    const notesRoot = join(dir, 'project-notes');
    mkdirSync(notesRoot, { recursive: true });
    const engine = new FileSyncEngine({
      store,
      blobStore: new LocalDiskBlobStore(store.syncBlobsDir),
      adapters: [createProjectNotesDirectoryAdapter(notesRoot, store)],
    });

    // Victim scope 42 uploads & commits private content.
    const victimContent = 'CONFIDENTIAL PROJECT 42 ROADMAP\n';
    const victimBuf = Buffer.from(victimContent, 'utf8');
    const victimSha = sha256Buffer(victimBuf);
    await engine.putBlobs('project-notes', '42', [{ sha256: victimSha, content_base64: victimBuf.toString('base64') }]);
    const vc = await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'user:victim',
      changes: [{ path: 'secret.md', base_revision: 0, content_sha256: victimSha }],
    });
    assert.equal(vc.ok, true);

    // Attack A: Attacker scope 99 attempts to copy victim's CAS blob directly by sha256!
    await assert.rejects(
      () => engine.commit('project-notes', '99', {
        mode: 'interactive',
        actor: 'agent:attacker',
        changes: [{ path: 'stolen.md', base_revision: 0, content_sha256: victimSha }],
      }),
      err => err.status === 400 && err.code === 'sync_blob_missing',
    );
    assert.equal(existsSync(join(notesRoot, '99', 'stolen.md')), false);

    // Attack B: Attacker scope 99 creates a file rev 1 -> rev 2, then triggers 409 passing victimSha as base_sha256!
    const a1Buf = Buffer.from('attacker v1\n', 'utf8');
    const a2Buf = Buffer.from('attacker v2\n', 'utf8');
    const a3Buf = Buffer.from('attacker v3\n', 'utf8');
    const a1Sha = sha256Buffer(a1Buf);
    const a2Sha = sha256Buffer(a2Buf);
    const a3Sha = sha256Buffer(a3Buf);
    await engine.putBlobs('project-notes', '99', [
      { sha256: a1Sha, content_base64: a1Buf.toString('base64') },
      { sha256: a2Sha, content_base64: a2Buf.toString('base64') },
      { sha256: a3Sha, content_base64: a3Buf.toString('base64') },
    ]);
    await engine.commit('project-notes', '99', {
      mode: 'interactive',
      actor: 'agent:attacker',
      changes: [{ path: 'probe.md', base_revision: 0, content_sha256: a1Sha }],
    });
    await engine.commit('project-notes', '99', {
      mode: 'interactive',
      actor: 'agent:attacker',
      changes: [{ path: 'probe.md', base_revision: 1, base_sha256: a1Sha, content_sha256: a2Sha }],
    });

    const probeRes = await engine.commit('project-notes', '99', {
      mode: 'interactive',
      actor: 'agent:attacker',
      changes: [{ path: 'probe.md', base_revision: 1, base_sha256: victimSha, content_sha256: a3Sha }],
    });
    assert.equal(probeRes.ok, false);
    assert.equal(probeRes.conflicts[0].base_content, null);
    assert.equal(probeRes.conflicts[0].base_sha256, null);
    assert.ok(!JSON.stringify(probeRes).includes('CONFIDENTIAL PROJECT 42'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing or unmounted backing directories fail closed (503 sync_scope_unavailable) instead of emitting empty manifests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-failclosed-'));
  const store = makeStore(dir);
  try {
    const notesRoot = join(dir, 'project-notes');
    const homesRoot = join(dir, 'assistant-homes');
    mkdirSync(notesRoot, { recursive: true });
    mkdirSync(homesRoot, { recursive: true });
    const engine = new FileSyncEngine({
      store,
      blobStore: new LocalDiskBlobStore(store.syncBlobsDir),
      adapters: [
        createProjectNotesDirectoryAdapter(notesRoot, store),
        createAssistantHomesAdapter(undefined, homesRoot, store),
      ],
    });

    // Brand-new empty scope is allowed when root volume exists.
    const emptyManifest = await engine.manifest('project-notes', '42');
    assert.equal(emptyManifest.revision, 0);
    assert.deepEqual(emptyManifest.entries, []);

    // Commit a file -> scope 42 now has revision > 0 in sync_scope_revisions.
    const buf = Buffer.from('important note\n', 'utf8');
    const sha = sha256Buffer(buf);
    await engine.putBlobs('project-notes', '42', [{ sha256: sha, content_base64: buf.toString('base64') }]);
    await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'user:alice',
      changes: [{ path: 'note.md', base_revision: 0, content_sha256: sha }],
    });

    // Simulate backing scope directory disappearing -> MUST fail closed 503, NEVER emit deletions!
    rmSync(join(notesRoot, '42'), { recursive: true, force: true });
    await assert.rejects(
      () => engine.manifest('project-notes', '42'),
      err => err.status === 503 && err.code === 'sync_scope_unavailable',
    );

    // Simulate entire volume root missing -> MUST fail closed 503 even for a brand-new scope!
    rmSync(notesRoot, { recursive: true, force: true });
    await assert.rejects(
      () => engine.manifest('project-notes', '88'),
      err => err.status === 503 && err.code === 'sync_scope_unavailable',
    );

    // Assistant homes: synced scope whose directory disappears fails closed 503.
    const owner = 'c'.repeat(32);
    const mb = Buffer.from('assistant memory\n', 'utf8');
    const ms = sha256Buffer(mb);
    await engine.putBlobs('assistant-homes', owner, [{ sha256: ms, content_base64: mb.toString('base64') }]);
    await engine.commit('assistant-homes', owner, {
      mode: 'interactive',
      actor: 'assistant:1',
      changes: [{ path: 'INDEX.md', base_revision: 0, content_sha256: ms }],
    });
    rmSync(join(homesRoot, owner), { recursive: true, force: true });
    await assert.rejects(
      () => engine.manifest('assistant-homes', owner),
      err => err.status === 503 && err.code === 'sync_scope_unavailable',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sync lifecycle cleanup: project/assistant deletion and RetentionCleanup sweep SQL rows, tokens, conflicts, and unreferenced blobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-lifecycle-'));
  const store = makeStore(dir);
  try {
    const notesRoot = join(dir, 'project-notes');
    const homesRoot = join(dir, 'assistant-homes');
    mkdirSync(notesRoot, { recursive: true });
    mkdirSync(homesRoot, { recursive: true });
    let now = Date.UTC(2026, 10, 25, 0, 0, 0);

    const engine = new FileSyncEngine({
      store,
      blobStore: new LocalDiskBlobStore(store.syncBlobsDir),
      adapters: [
        createProjectNotesDirectoryAdapter(notesRoot, store),
        createAssistantHomesAdapter(undefined, homesRoot, store),
      ],
      clock: () => now,
    });
    const tokens = new SyncTokenService(store, () => now);

    // Seed shared blob (in both project 42 and project 99) + unique blob in 42 + abandoned staged blob in 99.
    const sharedBuf = Buffer.from('shared content across projects\n', 'utf8');
    const sharedSha = sha256Buffer(sharedBuf);
    const only42Buf = Buffer.from('exclusive to project 42\n', 'utf8');
    const only42Sha = sha256Buffer(only42Buf);
    const stagedBuf = Buffer.from('abandoned staged upload\n', 'utf8');
    const stagedSha = sha256Buffer(stagedBuf);

    await engine.putBlobs('project-notes', '42', [
      { sha256: sharedSha, content_base64: sharedBuf.toString('base64') },
      { sha256: only42Sha, content_base64: only42Buf.toString('base64') },
    ]);
    await engine.commit('project-notes', '42', {
      mode: 'interactive',
      actor: 'user:alice',
      changes: [
        { path: 'shared.md', base_revision: 0, content_sha256: sharedSha },
        { path: 'only42.md', base_revision: 0, content_sha256: only42Sha },
      ],
    });

    await engine.putBlobs('project-notes', '99', [
      { sha256: sharedSha, content_base64: sharedBuf.toString('base64') },
      { sha256: stagedSha, content_base64: stagedBuf.toString('base64') },
    ]);
    await engine.commit('project-notes', '99', {
      mode: 'interactive',
      actor: 'user:bob',
      changes: [{ path: 'shared.md', base_revision: 0, content_sha256: sharedSha }],
    });

    // Delete project 42 sync data -> only42 blob is swept from disk, while sharedSha stays because project 99 still references it!
    const del42 = deleteProjectSyncData(store, '42', { files: true });
    assert.equal(del42.count, 1);
    assert.equal(await engine.blobStore.has(only42Sha), false);
    assert.equal(await engine.blobStore.has(sharedSha), true);
    assert.equal(store.get("SELECT count(*) n FROM sync_scope_revisions WHERE scope='42'").n, 0);

    // Assistant home sync data deletion cleans assistant blobs.
    const owner = 'd'.repeat(32);
    const memBuf = Buffer.from('ephemeral assistant memory\n', 'utf8');
    const memSha = sha256Buffer(memBuf);
    await engine.putBlobs('assistant-homes', owner, [{ sha256: memSha, content_base64: memBuf.toString('base64') }]);
    await engine.commit('assistant-homes', owner, {
      mode: 'interactive',
      actor: 'assistant:1',
      changes: [{ path: 'INDEX.md', base_revision: 0, content_sha256: memSha }],
    });
    assert.equal(await engine.blobStore.has(memSha), true);
    const delAsst = deleteAssistantSyncData(store, owner, { files: true });
    assert.equal(delAsst.count, 1);
    assert.equal(await engine.blobStore.has(memSha), false);

    // Issue a short-lived token + drop a stale `.tmp-` file in sync-blobs -> advance clock by 10 days -> RetentionCleanup prunes them!
    const shortTok = tokens.issue({
      actor: 'agent:ephemeral',
      grants: [{ namespace: 'project-notes', scope: '99', mode: 'ro' }],
      ttlMs: 60_000,
    });
    const staleTmpDir = join(store.syncBlobsDir, 'blobs', 'sha256', 'aa', 'bb');
    mkdirSync(staleTmpDir, { recursive: true });
    const staleTmpFile = join(staleTmpDir, `${'a'.repeat(64)}.tmp-old123`);
    writeFileSync(staleTmpFile, 'abandoned temp');
    const oldTime = new Date(now - 2 * 3600_000);
    utimesSync(staleTmpFile, oldTime, oldTime);

    const futureNow = now + 10 * 24 * 3600_000;
    const retention = new RetentionCleanup(store, undefined, { now: () => futureNow, pauseMs: 0 });
    const pass = await retention.run();
    assert.ok(pass.sync.count >= 3, `expected sync cleanup count >= 3, got ${JSON.stringify(pass.sync)}`);
    assert.equal(pass.sync.failed, 0);
    assert.equal(await engine.blobStore.has(stagedSha), false, 'abandoned staged blob > 24h removed');
    assert.equal(await engine.blobStore.has(sharedSha), true, 'recent committed blob (< 30d) retained');
    assert.equal(existsSync(staleTmpFile), false, 'stale .tmp-* file removed');
    assert.equal(tokens.exists(shortTok.token_id), false, 'expired token > 7d removed');

    // Direct pruneSyncData 40 days later prunes cached blob refs too.
    const later = pruneSyncData(store, { now: now + 40 * 24 * 3600_000 });
    assert.ok(later.refs_pruned >= 1);
    assert.equal(await engine.blobStore.has(sharedSha), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ManagerProjectNotesAdapter passes require_existing=1 for persisted scopes and fails closed on empty/unavailable manager responses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-mgr-failclosed-'));
  const store = makeStore(dir);
  try {
    const calls = [];
    let mode = 'present';
    const mockManager = {
      async call(method, path) {
        calls.push(`${method} ${path}`);
        if (mode === 'unavailable') throw new HttpError(503, 'notes_volume_unavailable');
        if (mode === 'empty') return { files: [] };
        return {
          files: [
            { id: 'f:1', path: 'doc.md', revision: 1, sha256: sha256Buffer(Buffer.from('hi')), bytes: 2, deleted: false },
          ],
        };
      },
    };
    const engine = new FileSyncEngine({
      store,
      blobStore: new LocalDiskBlobStore(store.syncBlobsDir),
      adapters: [new ManagerProjectNotesAdapter(mockManager, store)],
    });

    // First manifest: not persisted yet -> does NOT require_existing, advances persisted scope to rev 1.
    const m1 = await engine.manifest('project-notes', '55');
    assert.equal(m1.revision, 1);
    assert.equal(m1.entries.length, 1);
    assert.ok(!calls[0].includes('require_existing=1'));

    // Subsequent manifest on persisted scope passes require_existing=1 and maps notes_volume_unavailable -> 503 sync_scope_unavailable.
    mode = 'unavailable';
    await assert.rejects(
      () => engine.manifest('project-notes', '55'),
      err => err.status === 503 && err.code === 'sync_scope_unavailable',
    );
    assert.ok(calls.at(-1).includes('require_existing=1'));

    // Defense-in-depth: even if a manager ignores require_existing and returns `{ files: [] }` for a persisted scope, fail closed 503!
    mode = 'empty';
    await assert.rejects(
      () => engine.manifest('project-notes', '55'),
      err => err.status === 503 && err.code === 'sync_scope_unavailable',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
