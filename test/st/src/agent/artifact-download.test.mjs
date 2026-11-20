import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from '../../../fixtures/release-fixtures.mjs';
import { randomWorkspaceId } from '../../../fixtures/helpers.mjs';
import { RepositoryExplorer, workspaceRepositoryTools } from '../../../../dist/agent/exploration.js';
import { ReadTokens } from '../../../../dist/agent/read-token.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { workspace as runnerWorkspace } from '../../../../runner/workspace.mjs';
import { ArtifactArchiveError, extractArtifactZip } from '../../../../runner/artifact-zip.mjs';

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.store ? 0 : 8;
    const compressed = method === 0 ? raw : deflateRawSync(raw);
    const crc = entry.crcOverride ?? (crc32(raw) >>> 0);
    const uncompressedSize = entry.uncompressedOverride ?? raw.length;
    const unixMode = entry.unixMode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    const externalAttr = (unixMode & 0xffff) << 16;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // Unix
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttr >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, nameBuf);
    localOffset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

test('extractArtifactZip enforces path traversal, symlink, CRC and decompression limits (#1168)', async t => {
  const f = await releaseFixture(t);
  const root = join(f.h.directory, 'zip-unit');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const validZip = buildZip([
    { name: 'reports/', data: '' },
    { name: 'reports/junit.xml', data: '<testsuite tests="3" failures="0"/>\n' },
    { name: 'summary.json', data: '{"passed":3}', store: true },
  ]);
  const extracted = extractArtifactZip(validZip, join(root, 'valid'));
  assert.equal(extracted.total_files, 2);
  assert.match(readFileSync(join(root, 'valid/reports/junit.xml'), 'utf8'), /testsuite/);
  assert.equal(readFileSync(join(root, 'valid/summary.json'), 'utf8'), '{"passed":3}');

  // Rejects path traversal, absolute paths, .git and .runner-journal
  for (const unsafeName of ['../escape.txt', 'nested/../../escape.txt', '/etc/passwd', '.git/config', 'sub/.git/hooks/pre-commit', '.runner-journal/state']) {
    assert.throws(
      () => extractArtifactZip(buildZip([{ name: unsafeName, data: 'bad' }]), join(root, 'unsafe')),
      err => err instanceof ArtifactArchiveError && err.code === 'artifact_path_traversal',
      unsafeName,
    );
  }

  // Rejects symbolic link entries in archive
  assert.throws(
    () => extractArtifactZip(buildZip([{ name: 'link', data: '/etc/passwd', unixMode: 0o120777 }]), join(root, 'symlink-entry')),
    err => err instanceof ArtifactArchiveError && err.code === 'artifact_symlink_forbidden',
  );

  // Rejects pre-existing multi-hop symlink inside destination directory
  const preLinkRoot = join(root, 'pre-symlink');
  const outsideDir = join(root, 'outside');
  mkdirSync(preLinkRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  symlinkSync(outsideDir, join(preLinkRoot, 'sub'));
  assert.throws(
    () => extractArtifactZip(buildZip([{ name: 'sub/escaped.txt', data: 'nope' }]), preLinkRoot),
    err => err instanceof ArtifactArchiveError && err.code === 'artifact_symlink_escape',
  );

  // Enforces cumulative uncompressed size cap (zip-bomb defense)
  const bombZip = buildZip([{ name: 'huge.txt', data: 'A'.repeat(200_000) }]);
  assert.throws(
    () => extractArtifactZip(bombZip, join(root, 'bomb'), { maxUncompressedBytes: 64 * 1024 }),
    err => err instanceof ArtifactArchiveError && err.code === 'artifact_uncompressed_too_large',
  );

  // Rejects corrupted CRC32
  const badCrcZip = buildZip([{ name: 'corrupt.txt', data: 'hello', crcOverride: 0x12345678 }]);
  assert.throws(
    () => extractArtifactZip(badCrcZip, join(root, 'crc')),
    err => err instanceof ArtifactArchiveError && err.code === 'artifact_zip_invalid',
  );
});

test('download_artifact verifies actions read scope, strips auth on 302 redirect and extracts into workspace context (#1168)', async t => {
  const f = await releaseFixture(t);
  assert.ok(workspaceRepositoryTools.some(tool => tool.function.name === 'download_artifact'));

  const zipPayload = buildZip([
    { name: 'coverage/summary.json', data: '{"lines":98.5}' },
    { name: 'logs/failure-snippet.txt', data: 'AssertionError: expected 2 to equal 3\n' },
  ]);

  const storageHits = [];

  f.state.custom = async ({ path, res, send }) => {
    if (path === '/repos/fixture/project-101/actions/artifacts/501') {
      send({
        id: 501,
        name: 'test-results',
        size_in_bytes: zipPayload.length,
        expired: false,
        workflow_run: { id: 9001 },
      });
      return true;
    }
    if (path === '/repos/fixture/project-101/actions/artifacts/501/zip') {
      // Redirect to same-origin HTTP fixture endpoint to test 302 redirect handling without forwarding Authorization
      res.writeHead(302, { Location: `${f.apiUrl}/storage-redirect/501` });
      res.end();
      return true;
    }
    if (path === '/storage-redirect/501') {
      storageHits.push({ url: path, auth: res.req.headers.authorization ?? null });
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(zipPayload);
      return true;
    }
    if (path === '/repos/fixture/project-101/actions/artifacts/502') {
      send({ id: 502, name: 'expired-bundle', size_in_bytes: 128, expired: true });
      return true;
    }
    if (path === '/repos/fixture/project-101/actions/artifacts/503') {
      send({ id: 503, name: 'giant-bundle', size_in_bytes: 64 * 1024 * 1024, expired: false });
      return true;
    }
    return false;
  };

  const wsRoot = join(f.h.directory, 'runner-tasks');
  const gitRoot = join(f.h.directory, 'runner-git');
  const notesRoot = join(f.h.directory, 'runner-notes');
  const worktreesRoot = join(f.h.directory, 'runner-worktrees');
  mkdirSync(wsRoot, { recursive: true });
  mkdirSync(notesRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });

  const workspaceId = randomWorkspaceId();
  f.h.store.run(
    "INSERT INTO tasks(id,repository_id,kind,status,summary,generation,workspace_id) VALUES('task-art','101','task.request','running','Inspect artifact',1,?)",
    workspaceId,
  );
  const task = f.h.store.get("SELECT * FROM tasks WHERE id='task-art'");
  const manager = {
    async call(_method, _path, { request }) {
      try {
        return { ok: true, result: await runnerWorkspace(request, wsRoot, gitRoot, notesRoot, worktreesRoot) };
      } catch (error) {
        return { ok: false, error: 'runner_operation_failed', detail: String(error?.message || error) };
      }
    },
  };
  const redactor = new Redactor();
  const workspace = new Workspace(f.h.store, manager, task, redactor, async () => {}, () => {});

  const repo = f.h.store.get("SELECT * FROM repositories WHERE id='101'");
  let allowedScopes = ['contents', 'issues']; // Initially missing 'actions'
  const tokens = new ReadTokens(f.h.store, repo, redactor, async () => {}, f.apiUrl, ['contents', 'issues', 'actions'], () => allowedScopes);
  t.after(() => tokens.revoke());

  let writable = false;
  const explorer = new RepositoryExplorer(tokens, redactor, async () => {}, {
    extract: (artifactId, data, targetPath) => workspace.extractArtifact(artifactId, data, targetPath),
    canWriteCheckout: () => writable,
  });

  await explorer.execute('github_read_token', {});

  // 1. Denied without 'actions' read permission
  assert.deepEqual(await explorer.execute('download_artifact', { artifact_id: 501 }), { error: 'github_resource_forbidden' });

  // 2. Grant 'actions' read permission: default extraction into ../context/artifacts/501 works even on read-only tasks!
  allowedScopes = ['contents', 'issues', 'actions'];
  await explorer.execute('github_read_token', {});
  const downloaded = await explorer.execute('download_artifact', { artifact_id: 501 });
  assert.equal(downloaded.artifact_id, 501);
  assert.equal(downloaded.name, 'test-results');
  assert.equal(downloaded.workflow_run_id, 9001);
  assert.equal(downloaded.directory, '../context/artifacts/501');
  assert.equal(downloaded.total_files, 2);
  assert.equal(storageHits.length, 1);
  assert.equal(storageHits[0].auth, null, '302 redirect to artifact storage must not forward Authorization header');

  // Verify extracted files are readable via workspace_read
  const readSummary = await workspace.call('read-art-1', { type: 'workspace_read', path: '../context/artifacts/501/coverage/summary.json' });
  assert.equal(readSummary.content, '{"lines":98.5}');

  // 3. Read-only task cannot extract into repository checkout, and ../notes is always forbidden
  assert.equal((await explorer.execute('download_artifact', { artifact_id: 501, path: 'artifacts/in-repo' })).error, 'workspace_write_not_allowed');
  assert.equal((await explorer.execute('download_artifact', { artifact_id: 501, path: '../notes/art' })).error, 'invalid_artifact_path');

  // 4. Expired and oversized artifacts are rejected cleanly before archive extraction
  assert.equal((await explorer.execute('download_artifact', { artifact_id: 502 })).error, 'github_artifact_expired');
  assert.equal((await explorer.execute('download_artifact', { artifact_id: 503 })).error, 'github_artifact_too_large');
});
