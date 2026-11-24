import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { traceStorage } from '../../../../dist/tasks/trace.js';
import { roleStorage } from '../../../../dist/roles/storage.js';
import {
  loadDevelopmentCandidate,
  saveDevelopmentCandidate,
  stripPublishedCandidateBodies,
} from '../../../../dist/storage/payloads.js';
import { PayloadMigration } from '../../../../dist/storage/migration.js';
import { deterministicCandidateIssues } from '../../../../dist/tasks/acceptance.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { workspace as runnerWorkspace } from '../../../../runner/workspace.mjs';
import { validateCall } from '../../../../manager/project-runner-calls.mjs';
import { Docker } from '../../../../manager/docker.mjs';

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prod-hardening-'));
  const store = new Store(join(dir, 'control.sqlite'), Buffer.alloc(32, 7));
  traceStorage(store);
  roleStorage(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','Fixture','bot_account',NULL,'{}','2026-01-01')");
  store.run('INSERT INTO repositories VALUES(?,?,?,?)', '101', 'fixture/repo', '1', 'a');
  store.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,phase,summary,input,created_at,updated_at) VALUES('t1','101','task.request',1,'running','model','s','{}','2026-01-01','2026-01-01')");
  return { dir, store };
}

test('task_runs indexes eliminate full table scans on operation_id, lease_scope, and role_instance_id', t => {
  const { store } = makeStore(t);
  const plan = sql => store.all(`EXPLAIN QUERY PLAN ${sql}`).map(r => String(r.detail)).join(' | ');
  for (const [label, sql] of [
    ['operation_id', "SELECT 1 FROM task_runs WHERE operation_id='op1'"],
    ['lease_scope+status', "SELECT id FROM task_runs WHERE lease_scope='scope1' AND status='running'"],
    ['role_instance_id', "SELECT id FROM task_runs WHERE role_instance_id='inst1'"],
  ]) {
    const detail = plan(sql);
    assert.match(detail, /USING (?:COVERING )?INDEX/, `${label} must use an index, got: ${detail}`);
    assert.doesNotMatch(detail, /^SCAN task_runs$/, `${label} must not full-scan task_runs`);
  }
});

test('development_candidates externalizes large file arrays to blobs, preserves refs on metadata saves, strips bodies after publish, and migrates legacy rows', async t => {
  const { store } = makeStore(t);
  const largeFiles = Array.from({ length: 60 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    mode: '100644',
    sha: String(i).padStart(40, 'a'),
    size: 512,
    base64: Buffer.from(`export const x${i} = ${'v'.repeat(200)};`).toString('base64'),
  }));
  const snapshotFiles = largeFiles.map(({ path, mode, sha }) => ({ path, mode, sha }));
  const candidate = {
    tree_sha: '1'.repeat(40),
    local_sha: '2'.repeat(40),
    base_sha: '3'.repeat(40),
    branch: 'bot/task-t1',
    files: largeFiles,
    snapshot_files: snapshotFiles,
    skipped_files: [],
  };

  saveDevelopmentCandidate(store, 't1', candidate, '101');
  const storedRow = JSON.parse(String(store.get('SELECT data FROM development_candidates WHERE task_id=?', 't1').data));
  assert.equal(typeof storedRow.files?.$blob, 'string', 'files array is stored as a blob ref in SQLite');
  assert.equal(typeof storedRow.snapshot_files?.$blob, 'string', 'snapshot_files array is stored as a blob ref in SQLite');
  assert.equal(storedRow.base_sha, '3'.repeat(40), 'metadata remains directly readable in SQLite');
  assert.ok(JSON.stringify(storedRow).length < 2048, 'SQLite row stays compact');

  const loaded = loadDevelopmentCandidate(store, 't1');
  assert.equal(loaded.files.length, 60);
  assert.equal(loaded.files[0].base64, largeFiles[0].base64);

  // Updating metadata on the loaded object reuses the cached blob ref without rewriting the files blob.
  loaded.remote_sha = '4'.repeat(40);
  saveDevelopmentCandidate(store, 't1', loaded, '101');
  const afterMetaSave = JSON.parse(String(store.get('SELECT data FROM development_candidates WHERE task_id=?', 't1').data));
  assert.equal(afterMetaSave.files.$blob, storedRow.files.$blob);
  assert.equal(afterMetaSave.remote_sha, '4'.repeat(40));

  // Stripping bodies after publication removes base64 while keeping manifest paths/shas.
  stripPublishedCandidateBodies(store, 't1', loaded, '101');
  const stripped = loadDevelopmentCandidate(store, 't1');
  assert.equal(stripped.files.length, 60);
  assert.ok(stripped.files.every(f => f.base64 === undefined && typeof f.path === 'string' && typeof f.sha === 'string'));

  // Background PayloadMigration also externalizes legacy inline development_candidates rows.
  store.run("INSERT INTO tasks(id,repository_id,kind,object_number,status,phase,summary,input,created_at,updated_at) VALUES('t2','101','task.request',2,'completed','done','s','{}','2026-01-01','2026-01-01')");
  store.run('INSERT INTO development_candidates VALUES(?,?)', 't2', JSON.stringify(candidate));
  const beforeLen = String(store.get('SELECT data FROM development_candidates WHERE task_id=?', 't2').data).length;
  assert.ok(beforeLen > 10_000, 'legacy inline row starts large');

  const migration = new PayloadMigration(store, { guard: null, pauseMs: 1, idleMs: 60_000 });
  migration.start();
  const deadline = Date.now() + 5_000;
  while (String(store.get('SELECT data FROM development_candidates WHERE task_id=?', 't2').data).length >= 2048) {
    assert.ok(Date.now() < deadline, 'PayloadMigration should externalize legacy development_candidates row');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  await migration.stop();

  const migratedRaw = String(store.get('SELECT data FROM development_candidates WHERE task_id=?', 't2').data);
  assert.ok(migratedRaw.length < 2048, 'legacy row shrunk to metadata + blob refs');
  assert.equal(loadDevelopmentCandidate(store, 't2').files.length, 60);
});

test('workspace_read honors max_bytes and skip_binary on disk and git commits, and spills/truncates >1MiB reads', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wsId = 'a'.repeat(48), tasksRoot = join(dir, 'tasks'), storeRoot = join(dir, 'store'), repo = join(tasksRoot, wsId, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'small.txt'), 'hello world\n');
  writeFileSync(join(repo, 'binary.dat'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
  const bigText = 'line-of-text\n'.repeat(120_000); // ~1.56 MiB
  writeFileSync(join(repo, 'large.log'), bigText);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'bot'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  // Disk reads with max_bytes and skip_binary
  const skipBigDisk = await runnerWorkspace({ type: 'workspace_read', workspace_id: wsId, path: 'large.log', max_bytes: 262144, skip_binary: true }, tasksRoot, storeRoot);
  assert.deepEqual(skipBigDisk, { skipped: true, reason: 'file_too_large', size: Buffer.byteLength(bigText) });

  const skipBinDisk = await runnerWorkspace({ type: 'workspace_read', workspace_id: wsId, path: 'binary.dat', max_bytes: 262144, skip_binary: true }, tasksRoot, storeRoot);
  assert.deepEqual(skipBinDisk, { skipped: true, reason: 'binary_file', size: 7 });

  // Git sha reads with max_bytes and skip_binary
  const skipBigGit = await runnerWorkspace({ type: 'workspace_read', workspace_id: wsId, path: 'large.log', sha, max_bytes: 262144, skip_binary: true }, tasksRoot, storeRoot);
  assert.deepEqual(skipBigGit, { skipped: true, reason: 'file_too_large', size: Buffer.byteLength(bigText), version: sha });

  const skipBinGit = await runnerWorkspace({ type: 'workspace_read', workspace_id: wsId, path: 'binary.dat', sha, max_bytes: 262144, skip_binary: true }, tasksRoot, storeRoot);
  assert.deepEqual(skipBinGit, { skipped: true, reason: 'binary_file', size: 7, version: sha });

  // Unbounded >1 MiB read returns bounded preview + readable path instead of multi-MB inline string
  const truncatedDisk = await runnerWorkspace({ type: 'workspace_read', workspace_id: wsId, path: 'large.log' }, tasksRoot, storeRoot);
  assert.equal(truncatedDisk.truncated, true);
  assert.equal(truncatedDisk.size, Buffer.byteLength(bigText));
  assert.ok(truncatedDisk.content.length < 200_000 && truncatedDisk.path.endsWith('/large.log'));

  const truncatedGit = await runnerWorkspace({ type: 'workspace_read', workspace_id: wsId, path: 'large.log', sha }, tasksRoot, storeRoot);
  assert.equal(truncatedGit.truncated, true);
  assert.ok(truncatedGit.log_path && readFileSync(truncatedGit.log_path, 'utf8') === bigText, 'full git content spilled to log_path');

  // validateCall accepts max_bytes/skip_binary only on workspace_read
  assert.doesNotThrow(() => validateCall({ type: 'workspace_read', workspace_id: wsId, path: 'a.txt', max_bytes: 262144, skip_binary: true }));
  assert.throws(() => validateCall({ type: 'workspace_read', workspace_id: wsId, path: 'a.txt', max_bytes: 0 }), /invalid_runner_request/);
  assert.throws(() => validateCall({ type: 'workspace_command', workspace_id: wsId, command: 'ls', max_bytes: 100 }), /invalid_runner_request/);
});

test('manager Docker.request allows responses larger than 4 MiB without artificial docker_response_too_large cap', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'docker-sock-'));
  const sock = join(dir, 'docker.sock');
  const payload = Buffer.alloc(5 * 1024 * 1024, 0x61); // 5 MiB > old 4 MiB cap
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end(payload); });
  await new Promise(resolve => server.listen(sock, resolve));
  t.after(() => new Promise(resolve => server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); })));

  const docker = new Docker(sock);
  const raw = await docker.request('GET', '/large', undefined, true, 15000);
  assert.equal(raw.length, payload.length, '5 MiB raw Docker response succeeds without 4 MiB cap');
});

test('acceptance preflight skips binary and oversized files without calling workspace_read, and bounds text reads', async t => {
  const { store } = makeStore(t);
  const calls = [];
  const workspace = {
    async call(_key, req) {
      calls.push(req);
      if (req.path === 'src/conflict.ts') return { content: '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n' };
      return { skipped: true, reason: 'file_too_large', size: 500_000 };
    },
  };
  const candidate = {
    claims: {},
    artifacts: [{
      kind: 'code',
      content: {
        local_sha: 'a'.repeat(40),
        snapshot_files: [],
        files: [
          { path: 'assets/playwright-mcp-0.0.78.zip', sha: '1'.repeat(40) },
          { path: 'assets/bee-flying.webp', sha: '2'.repeat(40) },
          { path: 'assets/big.txt', sha: '3'.repeat(40), size: 300_000 },
          { path: 'assets/unknown-big.txt', sha: '4'.repeat(40) },
          { path: 'src/conflict.ts', sha: '5'.repeat(40) },
        ],
      },
    }],
  };
  const issues = await deterministicCandidateIssues(store, { id: 't1' }, workspace, candidate, new Redactor([]));
  assert.deepEqual(calls.map(c => c.path), ['assets/unknown-big.txt', 'src/conflict.ts'], 'binary and >256KiB files never call workspace_read');
  assert.ok(calls.every(c => c.max_bytes === 262144 && c.skip_binary === true), 'preflight bounds workspace_read calls');
  assert.ok(issues.some(i => i.includes('src/conflict.ts')), 'still detects conflict markers in text files');
});
