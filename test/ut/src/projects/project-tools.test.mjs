import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { Store } from '../../../../dist/storage/database.js';
import { ProjectToolsService, PROJECT_TOOLS_QUOTA_KEY, activeProjectToolsForProjects } from '../../../../dist/projects/tools.js';
import { isSensitiveToolPath, normalizeToolRelativePath } from '../../../../dist/projects/tools-archive.js';
import { projectToolsPriorityGuidance } from '../../../../dist/projects/tools-assistant.js';
import { systemInstructions } from '../../../../dist/roles/pool.js';
import { workspaceProfile } from '../../../../dist/agent/profiles.js';
import { environment as runnerEnv } from '../../../../runner/command.mjs';

function makeStore(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 7));
  t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('acc-1','acct','bot_account',NULL,'{}',?)", new Date().toISOString());
  store.run("INSERT INTO repositories VALUES('101','acme/alpha','owner-1','acc-1')");
  store.run("INSERT INTO repositories VALUES('202','acme/beta','owner-1','acc-1')");
  return store;
}

async function tempDir(t, prefix = 'project-tools-ut-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Builds a POSIX ustar tar.gz buffer with custom entry types/modes/paths for deterministic security tests. */
function buildTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    nameBuf.copy(header, 0, 0, Math.min(100, nameBuf.length));
    const mode = (entry.mode ?? 0o644).toString(8).padStart(7, '0') + '\0';
    Buffer.from(mode, 'ascii').copy(header, 100);
    Buffer.from('0000000\0', 'ascii').copy(header, 108);
    Buffer.from('0000000\0', 'ascii').copy(header, 116);
    const body = entry.content ? Buffer.from(entry.content) : Buffer.alloc(0);
    Buffer.from(body.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124);
    Buffer.from('00000000000\0', 'ascii').copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkname) Buffer.from(entry.linkname, 'utf8').copy(header, 157, 0, 100);
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
    blocks.push(header);
    if (body.length) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a valid ZIP buffer supporting STORE (0), DEFLATE (8), Unix mode bits, and symlinks. */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.content ? Buffer.from(entry.content) : Buffer.alloc(0);
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const sum = crc32(raw);
    const flags = entry.flags ?? 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(sum, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    localParts.push(lfh, nameBuf, compressed);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4); // Unix host OS = 3
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(sum, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    const unixMode = entry.unixMode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    cdh.writeUInt32LE((unixMode << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + compressed.length;
  }
  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

test('single-file publish, merge immutability via hardlinks, replace, delete-files, rollback and clear', async t => {
  const store = makeStore(t);
  const root = await tempDir(t);
  const notified = [];
  const svc = new ProjectToolsService(store, {
    root,
    manager: { async call(method, path, body) { if (method === 'PUT' && path.endsWith('/tools')) { notified.push({ path, body }); return {}; } if (path === '/v1/project-tools/mounts') return { mounts: [] }; return null; } },
  });
  t.after(() => svc.stop());

  // rev-1: single executable file
  const r1 = await svc.publish({
    repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'file',
    targetPath: 'bin/mytool', executable: true, buffer: Buffer.from('#!/bin/sh\necho v1\n'), note: 'initial v1',
  });
  assert.equal(r1.revision, 1);
  assert.equal(r1.files_count, 1);
  const st1 = await lstat(join(root, '101', 'rev-1', 'bin', 'mytool'));
  assert.equal(st1.mode & 0o777, 0o755);

  // rev-2: merge adds second file, hardlinks unchanged file without mutating rev-1
  const r2 = await svc.publish({
    repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'merge', kind: 'file',
    targetPath: 'share/readme.txt', executable: false, buffer: Buffer.from('hello docs\n'),
  });
  assert.equal(r2.revision, 2);
  assert.equal(r2.files_count, 2);
  const st2Same = await lstat(join(root, '101', 'rev-2', 'bin', 'mytool'));
  assert.equal(st2Same.ino, st1.ino, 'unchanged file in merge shares inode via hardlink');
  const st2Doc = await lstat(join(root, '101', 'rev-2', 'share', 'readme.txt'));
  assert.equal(st2Doc.mode & 0o777, 0o644);

  // rev-3: merge overwrites bin/mytool — MUST unlink before write so rev-1/rev-2 stay immutable!
  const r3 = await svc.publish({
    repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'merge', kind: 'file',
    targetPath: 'bin/mytool', executable: true, buffer: Buffer.from('#!/bin/sh\necho v3\n'),
  });
  assert.equal(r3.revision, 3);
  assert.equal(await readFile(join(root, '101', 'rev-1', 'bin', 'mytool'), 'utf8'), '#!/bin/sh\necho v1\n');
  assert.equal(await readFile(join(root, '101', 'rev-3', 'bin', 'mytool'), 'utf8'), '#!/bin/sh\necho v3\n');

  // rev-4: merge delete removes share/readme.txt and prunes empty share/ dir
  const r4 = await svc.publish({
    repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'merge', kind: 'delete',
    deletePaths: ['share/readme.txt'],
  });
  assert.equal(r4.revision, 4);
  assert.equal(r4.files_count, 1);
  assert.equal(await lstat(join(root, '101', 'rev-4', 'share')).catch(() => null), null);

  // rollback to rev-1
  const rb = await svc.rollback('101', 1, 'admin-1', 'console');
  assert.equal(rb.revision, 1);
  assert.equal(rb.state.active_revision, 1);
  assert.equal(rb.state.files.length, 1);

  // clear sets active_revision = null
  const cleared = await svc.clear('101', 'admin-1', 'console');
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.state.active_revision, null);
  assert.equal(notified.at(-1).body.revision, null);
});

test('.tar.gz and .zip streaming extraction with executable bits, relative symlinks and security rejections', async t => {
  const store = makeStore(t);
  const root = await tempDir(t);
  const svc = new ProjectToolsService(store, { root });

  // Valid .tar.gz with executable + safe internal relative symlink
  const goodTar = buildTarGz([
    { name: 'lib/real-cli', mode: 0o755, content: '#!/bin/sh\necho tar-ok\n' },
    { name: 'bin/cli', type: '2', linkname: '../lib/real-cli' },
  ]);
  const resTar = await svc.publish({
    repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'archive',
    filename: 'bundle.tar.gz', buffer: goodTar,
  });
  assert.equal(resTar.revision, 1);
  assert.equal(resTar.files_count, 2);
  assert.equal((await lstat(join(root, '101', 'rev-1', 'lib', 'real-cli'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(root, '101', 'rev-1', 'bin', 'cli'))).isSymbolicLink(), true);

  // Valid .zip with DEFLATE + STORE + executable + safe relative symlink
  const goodZip = buildZip([
    { name: 'bin/zip-cli', content: '#!/bin/sh\necho zip-ok\n', unixMode: 0o100755, method: 8 },
    { name: 'bin/alias-cli', content: 'zip-cli', unixMode: 0o120777, method: 0 },
    { name: 'share/info.txt', content: 'info', unixMode: 0o100644, method: 0 },
  ]);
  const resZip = await svc.publish({
    repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'archive',
    filename: 'bundle.zip', buffer: goodZip,
  });
  assert.equal(resZip.revision, 2);
  assert.equal(resZip.files_count, 3);
  assert.equal((await lstat(join(root, '101', 'rev-2', 'bin', 'zip-cli'))).mode & 0o777, 0o755);

  // Reject path traversal, absolute path, hardlink, device, escaping symlink, and chained symlink escape in tar.gz
  for (const [label, entries, expectedCode] of [
    ['tar traversal', [{ name: '../evil.sh', content: 'x' }], 'unsafe_tool_path'],
    ['tar absolute', [{ name: '/etc/evil', content: 'x' }], 'unsafe_tool_path'],
    ['tar hardlink', [{ name: 'a', type: '1', linkname: '/etc/passwd' }], 'unsafe_archive_entry_type'],
    ['tar device', [{ name: 'devnull', type: '3' }], 'unsafe_archive_entry_type'],
    ['tar fifo', [{ name: 'pipe', type: '6' }], 'unsafe_archive_entry_type'],
    ['tar abs symlink', [{ name: 'bin/x', type: '2', linkname: '/etc/passwd' }], 'unsafe_archive_symlink'],
    ['tar rel escape symlink', [{ name: 'bin/x', type: '2', linkname: '../../etc/passwd' }], 'unsafe_archive_symlink'],
    ['tar chained escape symlink', [
      { name: 'sub/b', type: '2', linkname: '..' },
      { name: 'sub/a', type: '2', linkname: 'b/../outside' },
    ], 'unsafe_archive_symlink'],
  ]) {
    await assert.rejects(
      () => svc.publish({ repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'archive', filename: 'bad.tar.gz', buffer: buildTarGz(entries) }),
      err => err?.code === expectedCode,
      `${label} must fail with ${expectedCode}`,
    );
  }

  // Reject Zip-Slip, absolute path, encrypted entry, and escaping symlink in .zip
  for (const [label, entries, expectedCode] of [
    ['zip traversal', [{ name: '../../escape.sh', content: 'x' }], 'unsafe_tool_path'],
    ['zip absolute', [{ name: '/tmp/escape.sh', content: 'x' }], 'unsafe_tool_path'],
    ['zip encrypted', [{ name: 'bin/a', content: 'x', flags: 1 }], 'encrypted_archive_unsupported'],
    ['zip escape symlink', [{ name: 'bin/link', content: '../../../etc/passwd', unixMode: 0o120777, method: 0 }], 'unsafe_archive_symlink'],
  ]) {
    await assert.rejects(
      () => svc.publish({ repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'archive', filename: 'bad.zip', buffer: buildZip(entries) }),
      err => err?.code === expectedCode,
      `${label} must fail with ${expectedCode}`,
    );
  }
});

test('sensitive filenames, PEM keys, provider tokens and registered secrets are blocked while benign templates pass', async t => {
  const store = makeStore(t);
  const root = await tempDir(t);
  // Register a secret model API key in the control plane store.
  const secretValue = 'super-secret-deployment-token-9876543210';
  store.run(
    "INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES('m-1',NULL,'https://example.test','gpt',?,1,?)",
    store.secrets.seal({ value: secretValue }, 'model:m-1'),
    new Date().toISOString(),
  );
  const svc = new ProjectToolsService(store, { root });

  // Filename rules
  for (const badPath of ['.env', '.env.local', '.env.example.bak', 'keys/server.pem', 'tls/private.key', 'ssh/id_rsa', '.aws/credentials', 'credentials.json', '.netrc']) {
    assert.ok(isSensitiveToolPath(badPath), `${badPath} must be blocked`);
  }
  assert.equal(isSensitiveToolPath('.env.example'), null, 'exact single suffix .env.example is allowed');
  assert.equal(isSensitiveToolPath('ssh/id_ed25519.pub'), null, 'public key suffix is allowed');
  assert.throws(() => normalizeToolRelativePath('a/../b'), err => err?.code === 'unsafe_tool_path');

  // Publish blocks sensitive filename
  await assert.rejects(
    () => svc.publish({ repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'file', targetPath: 'config/.env.production', buffer: Buffer.from('FOO=bar\n') }),
    err => err?.code === 'sensitive_tool_file_blocked',
  );
  // Publish blocks PEM private key inside harmless filename
  await assert.rejects(
    () => svc.publish({ repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'file', targetPath: 'bin/helper.txt', buffer: Buffer.from('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n') }),
    err => err?.code === 'sensitive_tool_content_blocked',
  );
  // Publish blocks GitHub PAT token
  await assert.rejects(
    () => svc.publish({ repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'file', targetPath: 'bin/script.sh', buffer: Buffer.from('TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz\n') }),
    err => err?.code === 'sensitive_tool_content_blocked',
  );
  // Publish blocks registered secret literal straddling 64 KiB chunk boundary!
  const boundaryPayload = Buffer.concat([Buffer.alloc(65520, 0x41), Buffer.from(secretValue, 'utf8'), Buffer.alloc(128, 0x42)]);
  await assert.rejects(
    () => svc.publish({ repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'file', targetPath: 'bin/blob.bin', buffer: boundaryPayload }),
    err => err?.code === 'sensitive_tool_content_blocked',
  );
});

test('GC keeps active + 3 previous revisions, protects mounted revisions, fails closed on unknown mounts, and sweeps orphans', async t => {
  const store = makeStore(t);
  const root = await tempDir(t);
  let liveMounts = new Set(['101:1']); // pretend a running container still holds rev-1
  const svc = new ProjectToolsService(store, {
    root,
    mountedRevisions: async () => liveMounts,
  });

  // Publish 6 revisions (1..6)
  for (let i = 1; i <= 6; i++) {
    await svc.publish({
      repositoryId: '101', actorId: 'admin-1', source: 'console', mode: 'replace', kind: 'file',
      targetPath: `bin/v${i}`, executable: true, buffer: Buffer.from(`v${i}`),
    });
  }
  // Create an orphan staging dir and a deleted-project orphan dir ('999').
  // Leave staging-orphan's mtime at "now" so any background post-publish GC ignores it,
  // then pass a future `now` (+2h) to explicit svc.gc() for deterministic assertion.
  const oldStaging = join(root, '101', 'staging-orphan');
  await mkdir(oldStaging, { recursive: true });
  await mkdir(join(root, '999', 'rev-1'), { recursive: true });

  // Run GC: keep = {6, 5, 4, 3}; rev-2 pruned; rev-1 protected because mounted!
  const g1 = await svc.gc(undefined, Date.now() + 2 * 3600_000);
  assert.equal(g1.skipped_mounted, 1);
  assert.equal(g1.staging_cleaned, 1);
  assert.equal(g1.orphans_removed, 1);
  assert.equal(await lstat(oldStaging).catch(() => null), null, 'stale staging directory must be cleaned');
  assert.ok(await lstat(join(root, '101', 'rev-1')).catch(() => null), 'mounted rev-1 must survive GC');
  assert.equal(await lstat(join(root, '101', 'rev-2')).catch(() => null), null, 'unmounted rev-2 must be pruned');
  for (const rev of [3, 4, 5, 6]) {
    assert.ok(await lstat(join(root, '101', `rev-${rev}`)).catch(() => null), `retained rev-${rev} must remain`);
  }
  assert.equal(await lstat(join(root, '999')).catch(() => null), null, 'deleted project orphan removed');

  // Fail closed when manager mount state is unavailable (null)
  liveMounts = null;
  const gFail = await svc.gc('101');
  assert.equal(gFail.pruned, 0);
  assert.ok(await lstat(join(root, '101', 'rev-1')).catch(() => null), 'rev-1 kept when mount state unknown');

  // Once container unmounts rev-1, GC removes it cleanly
  liveMounts = new Set();
  const g2 = await svc.gc('101');
  assert.equal(g2.pruned, 1);
  assert.equal(await lstat(join(root, '101', 'rev-1')).catch(() => null), null);
});

test('PATH places /opt/project-tools/bin at the very end, activeProjectToolsForProjects isolates projects, and prompts declare 3-tier priority', async t => {
  const parts = runnerEnv.PATH.split(':');
  assert.equal(parts.at(-1), '/opt/project-tools/bin', '/opt/project-tools/bin must be appended at the very end of PATH');
  assert.ok(parts.indexOf('/usr/bin') < parts.indexOf('/opt/project-tools/bin'), '/usr/bin must precede /opt/project-tools/bin');
  assert.ok(parts.indexOf('/opt/preinstalled/bin') < parts.indexOf('/opt/project-tools/bin'), '/opt/preinstalled/bin must precede /opt/project-tools/bin');

  // Verify prompts declare the 3-tier priority guidance
  for (const text of [projectToolsPriorityGuidance, systemInstructions, workspaceProfile('development.issue', {}).system]) {
    assert.match(text, /base image/i);
    assert.match(text, /packages.*setup_script/i);
    assert.match(text, /\/opt\/project-tools/);
  }

  // Verify per-project isolation in activeProjectToolsForProjects
  const store = makeStore(t);
  const root = await tempDir(t);
  const svc = new ProjectToolsService(store, { root });
  await svc.publish({ repositoryId: '101', actorId: 'a', source: 'console', mode: 'replace', kind: 'file', targetPath: 'bin/a', buffer: Buffer.from('a') });
  await svc.publish({ repositoryId: '202', actorId: 'a', source: 'console', mode: 'replace', kind: 'file', targetPath: 'bin/b', buffer: Buffer.from('b') });
  const onlyAlpha = activeProjectToolsForProjects(store, [{ id: '101', full_name: 'acme/alpha' }]);
  assert.deepEqual(onlyAlpha, [{ repository_id: '101', mount_name: 'acme__alpha', revision: 1 }]);
});

test('merge fails closed on missing active revision, crash-orphan rev dir is retryable, disk reserve blocks upload, and unreachable manager yields unknown rotation state', async t => {
  const store = makeStore(t);
  const root = await tempDir(t);
  let diskLow = false;
  let managerDown = false;
  const svc = new ProjectToolsService(store, {
    root,
    diskState: () => ({ free_bytes: diskLow ? 1024 : 100 * 1024 ** 3, total_bytes: 200 * 1024 ** 3, used_bytes: 100 * 1024 ** 3, reserve_bytes: 10 * 1024 ** 3, floor_bytes: 10 * 1024 ** 3, low: diskLow }),
    manager: {
      async call() {
        if (managerDown) throw new Error('manager_unavailable');
        return { computer: { tools_revision: 1, applied_tools_revision: 1, tools_pending: false } };
      },
    },
  });
  t.after(() => svc.stop());

  // 1. Publish rev-1
  await svc.publish({ repositoryId: '101', actorId: 'a', source: 'console', mode: 'replace', kind: 'file', targetPath: 'bin/a', buffer: Buffer.from('v1') });

  // 2. Simulate crash orphan at rev-2 (uncommitted directory on disk) -> next publish sweeps orphan and succeeds cleanly
  await mkdir(join(root, '101', 'rev-2'), { recursive: true });
  await writeFile(join(root, '101', 'rev-2', 'stale'), 'orphan');
  const rev2 = await svc.publish({ repositoryId: '101', actorId: 'a', source: 'console', mode: 'merge', kind: 'file', targetPath: 'bin/b', buffer: Buffer.from('v2') });
  assert.equal(rev2.revision, 2);
  assert.equal(await lstat(join(root, '101', 'rev-2', 'stale')).catch(() => null), null, 'crash orphan files must be swept');
  assert.equal(await readFile(join(root, '101', 'rev-2', 'bin', 'a'), 'utf8'), 'v1');
  assert.equal(await readFile(join(root, '101', 'rev-2', 'bin', 'b'), 'utf8'), 'v2');

  // 3. Delete active rev-2 directory on disk -> merge fails closed instead of silently publishing an empty base
  await rm(join(root, '101', 'rev-2'), { recursive: true, force: true });
  await assert.rejects(
    () => svc.publish({ repositoryId: '101', actorId: 'a', source: 'console', mode: 'merge', kind: 'file', targetPath: 'bin/c', buffer: Buffer.from('v3') }),
    err => err?.status === 409 && err?.code === 'project_tools_revision_missing_on_disk',
  );

  // 4. Low data-disk free space blocks publish before staging (507 project_tools_disk_full)
  diskLow = true;
  await assert.rejects(
    () => svc.publish({ repositoryId: '101', actorId: 'a', source: 'console', mode: 'replace', kind: 'file', targetPath: 'bin/c', buffer: Buffer.from('v3') }),
    err => err?.status === 507 && err?.code === 'project_tools_disk_full',
  );
  diskLow = false;

  // 5. Unreachable manager reports tools_pending=null and rotation_status='unknown' instead of false
  managerDown = true;
  const view = await svc.view('101');
  assert.equal(view.tools_pending, null);
  assert.equal(view.rotation_status, 'unknown');
});
