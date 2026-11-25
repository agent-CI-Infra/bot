import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { createControlPlane } from '../../../../dist/server.js';
import { ProjectToolsService } from '../../../../dist/projects/tools.js';
import { materializeSkillSet, projectSkillScope } from '../../../../dist/roles/skill-store.js';
import { AssistantHomes } from '../../../../dist/service-roles/assistant-computers.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { CasCache, SyncClient } from '../../../../runner/sync-client.mjs';

async function startServer(setup) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-http-st-'));
  const store = new Store(join(dir, 'control.sqlite'), randomBytes(32));
  const projectNotesRoot = join(dir, 'project-notes');
  const projectToolsRoot = join(dir, 'project-tools');
  const agentToolsRoot = join(dir, 'agent-tools');
  const skillStoreRoot = join(dir, 'skill-store');
  const assistantHomesRoot = join(dir, 'assistant-homes');
  const toolResultsRoot = join(dir, 'tool-results');
  for (const d of [projectNotesRoot, projectToolsRoot, agentToolsRoot, skillStoreRoot, assistantHomesRoot, toolResultsRoot]) {
    mkdirSync(d, { recursive: true });
  }

  // Seed a minimal repository row so ProjectToolsService.publish works cleanly.
  store.run(
    "INSERT INTO accounts(id,name,type,app_id,credentials,created_at) VALUES('acc1','Test','github_app','1','{}',?)",
    new Date().toISOString(),
  );
  store.run(
    "INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES('42','org/repo','100','acc1')",
  );

  const projectTools = new ProjectToolsService(store, { root: projectToolsRoot });
  const { server, sync } = createControlPlane({
    store,
    staticDirectory: resolve('static'),
    projectTools,
    assistantHomes: assistantHomesRoot,
    syncOptions: {
      projectNotesRoot,
      projectToolsRoot,
      agentToolsRoot,
      skillStoreRoot,
      toolResultsRoot,
      assistantHomesRoot,
    },
    channels: { longConnections: false },
    schedules: { automatic: false },
    consolidation: { automatic: false },
  });

  if (setup) await setup({ dir, store, projectTools, projectNotesRoot, projectToolsRoot, agentToolsRoot, skillStoreRoot, assistantHomesRoot, toolResultsRoot, sync });

  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = async () => {
    await new Promise(r => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, baseUrl, sync, projectTools, projectNotesRoot, agentToolsRoot, skillStoreRoot, assistantHomesRoot, toolResultsRoot, close };
}

test('FileSyncEngine HTTP + SyncClient: all 4 read-only namespaces support CAS incremental pull with 0-byte unchanged transfer', async () => {
  const env = await startServer(async ({ store, projectTools, agentToolsRoot, skillStoreRoot, toolResultsRoot }) => {
    // 1. tool-results: two immutable UTF-8 result files under owner `project_42`.
    const ownerDir = join(toolResultsRoot, 'project_42');
    mkdirSync(ownerDir, { recursive: true });
    writeFileSync(join(ownerDir, `${'a'.repeat(48)}.utf8`), 'large command output A\n');
    writeFileSync(join(ownerDir, `${'b'.repeat(48)}.utf8`), 'large command output B\n');

    // 2. project-tools: publish rev-1 with executable binary + normal file.
    await projectTools.publish({
      repositoryId: '42',
      actorId: 'u1',
      source: 'api',
      mode: 'replace',
      kind: 'file',
      targetPath: 'bin/mytool',
      executable: true,
      buffer: Buffer.from('#!/bin/sh\necho v1\n'),
    });

    // 3. agent-tools: create x64 and arm64 CLI manifests + an internal relative symlink.
    const x64Dir = join(agentToolsRoot, 'codex', '0.1.0');
    mkdirSync(join(x64Dir, 'bin'), { recursive: true });
    mkdirSync(join(x64Dir, 'lib'), { recursive: true });
    writeFileSync(join(x64Dir, 'manifest.json'), JSON.stringify({ schema: 'bot.agent-tools/1', cli: 'codex', version: '0.1.0', arch: 'x64' }));
    writeFileSync(join(x64Dir, 'lib', 'codex-real'), '#!/bin/sh\necho x64\n');
    chmodSync(join(x64Dir, 'lib', 'codex-real'), 0o755);
    symlinkSync('../lib/codex-real', join(x64Dir, 'bin', 'codex'));

    const armDir = join(agentToolsRoot, 'codex', '0.2.0');
    mkdirSync(join(armDir, 'bin'), { recursive: true });
    writeFileSync(join(armDir, 'manifest.json'), JSON.stringify({ schema: 'bot.agent-tools/1', cli: 'codex', version: '0.2.0', arch: 'arm64' }));
    writeFileSync(join(armDir, 'bin', 'codex'), '#!/bin/sh\necho arm64\n');
    chmodSync(join(armDir, 'bin', 'codex'), 0o755);

    // 4. skill-store (#1359): materialize a skill set for project 42.
    materializeSkillSet({
      root: skillStoreRoot,
      scope: projectSkillScope('42'),
      files: [
        { path: 'project/deploy/SKILL.md', content: '---\nname: deploy\ndescription: Deploy skill\n---\n# Deploy\n' },
        { path: 'project/deploy/scripts/run.sh', content: '#!/bin/sh\necho ok\n' },
      ],
    });
  });

  try {
    const sharedCas = new CasCache(join(env.dir, 'node-cas'));
    const nodeToken = env.sync.tokens.issue({
      actor: 'node:remote-1',
      grants: [{ namespace: '*', scope: '*', mode: 'ro' }],
    }).token;

    // 1. tool-results lazy single-file pull -> fetches ONLY file A, never file B.
    const resultsTarget = join(env.dir, 'mount-results');
    const resultsClient = new SyncClient({
      baseUrl: env.baseUrl,
      token: nodeToken,
      namespace: 'tool-results',
      scope: 'project_42',
      targetDir: resultsTarget,
      cas: sharedCas,
    });
    const fileA = `${'a'.repeat(48)}.utf8`;
    const fileB = `${'b'.repeat(48)}.utf8`;
    const lazyPull = await resultsClient.pull({ paths: [fileA] });
    assert.equal(lazyPull.fetched_blobs, 1);
    assert.equal(readFileSync(join(resultsTarget, fileA), 'utf8'), 'large command output A\n');
    assert.equal(existsSync(join(resultsTarget, fileB)), false);

    // Second pull of the same file hits CAS cache -> 0 bytes transferred!
    const lazyAgain = await resultsClient.pull({ paths: [fileA] });
    assert.equal(lazyAgain.fetched_blobs, 0);
    assert.equal(lazyAgain.fetched_bytes, 0);
    assert.equal(lazyAgain.cached_hits, 1);

    // 2. project-tools incremental rev-1 -> rev-2: unchanged file transfers 0 bytes, new file fetched!
    const projToolsTarget = join(env.dir, 'mount-project-tools');
    const projToolsClient = new SyncClient({
      baseUrl: env.baseUrl,
      token: nodeToken,
      namespace: 'project-tools',
      scope: '42',
      targetDir: projToolsTarget,
      cas: sharedCas,
    });
    const pt1 = await projToolsClient.pull();
    assert.equal(pt1.revision, 1);
    assert.equal(pt1.fetched_blobs, 1);
    assert.equal((lstatSync(join(projToolsTarget, 'bin/mytool')).mode & 0o111) !== 0, true);

    // Unchanged pull -> 0 bytes transferred.
    const ptNoop = await projToolsClient.pull();
    assert.equal(ptNoop.fetched_blobs, 0);
    assert.equal(ptNoop.fetched_bytes, 0);
    assert.equal(ptNoop.entries_count, 0);

    // Merge-publish a second file in rev-2: bin/mytool is unchanged so only README.txt transfers!
    await env.projectTools.publish({
      repositoryId: '42',
      actorId: 'u1',
      source: 'api',
      mode: 'merge',
      kind: 'file',
      targetPath: 'README.txt',
      buffer: Buffer.from('project tools readme\n'),
    });
    const pt2 = await projToolsClient.pull();
    assert.equal(pt2.revision, 2);
    assert.equal(pt2.fetched_blobs, 1);
    assert.equal(pt2.fetched_bytes, Buffer.byteLength('project tools readme\n'));
    assert.equal(readFileSync(join(projToolsTarget, 'README.txt'), 'utf8'), 'project tools readme\n');

    // 3. agent-tools scoped by os/arch: linux/x64 syncs only x64 (plus safe relative symlink), never arm64.
    const agentToolsTarget = join(env.dir, 'mount-agent-tools');
    const agentClient = new SyncClient({
      baseUrl: env.baseUrl,
      token: nodeToken,
      namespace: 'agent-tools',
      scope: 'linux/x64',
      targetDir: agentToolsTarget,
      cas: sharedCas,
    });
    const at1 = await agentClient.pull();
    assert.ok(at1.fetched_blobs >= 2);
    assert.equal(at1.symlinks_written, 1);
    assert.equal(lstatSync(join(agentToolsTarget, 'codex/0.1.0/bin/codex')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(agentToolsTarget, 'codex/0.1.0/bin/codex')), '../lib/codex-real');
    assert.equal(existsSync(join(agentToolsTarget, 'codex/0.2.0')), false);

    // 4. skill-store (#1359): syncs content-addressed sets/<hash>/bot/skills/... with executable script bit intact,
    //    and a second independent target dir sharing the same CasCache transfers 0 bytes!
    const skillTarget1 = join(env.dir, 'mount-skills-1');
    const skillClient1 = new SyncClient({
      baseUrl: env.baseUrl,
      token: nodeToken,
      namespace: 'skill-store',
      scope: 'projects/42',
      targetDir: skillTarget1,
      cas: sharedCas,
    });
    const sk1 = await skillClient1.pull();
    assert.ok(sk1.fetched_blobs >= 3);
    assert.ok(sk1.hardlinked_files >= 2); // non-executable files hardlinked from CAS!

    const skillTarget2 = join(env.dir, 'mount-skills-2');
    const skillClient2 = new SyncClient({
      baseUrl: env.baseUrl,
      token: nodeToken,
      namespace: 'skill-store',
      scope: 'projects/42',
      targetDir: skillTarget2,
      cas: sharedCas,
    });
    const sk2 = await skillClient2.pull();
    assert.equal(sk2.fetched_blobs, 0);
    assert.equal(sk2.fetched_bytes, 0);
    assert.equal(sk2.cached_hits, sk1.fetched_blobs);

    // Read-only namespace rejects write attempts even with an rw token!
    const rwToken = env.sync.tokens.issue({
      actor: 'node:remote-1',
      grants: [{ namespace: '*', scope: '*', mode: 'rw' }],
    }).token;
    const roWriteRes = await fetch(`${env.baseUrl}/sync/skill-store/projects%2F42/blobs/put`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rwToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ blobs: [] }),
    });
    assert.equal(roWriteRes.status, 403);
    assert.equal((await roWriteRes.json()).error, 'sync_namespace_readonly');
  } finally {
    await env.close();
  }
});

test('FileSyncEngine HTTP + SyncClient: rw project-notes & assistant-homes 3-way merge, 409 interactive, background conflict copy, redaction, deletion & security', async () => {
  const env = await startServer(async ({ store }) => {
    const sealed = store.secrets.seal({ value: 'super-secret-api-key-123456' }, 'model:m-sync');
    store.run(
      "INSERT INTO models(id,repository_id,api_url,model_name,api_key,version,updated_at) VALUES('m-sync',NULL,'https://example.test','gpt-sync',?,1,?)",
      sealed,
      new Date().toISOString(),
    );
  });

  try {
    const casA = new CasCache(join(env.dir, 'cas-a'));
    const casB = new CasCache(join(env.dir, 'cas-b'));

    const tokenA = env.sync.tokens.issue({
      actor: 'agent:worker-a',
      actorTag: 'worker-a',
      grants: [{ namespace: 'project-notes', scope: '42', mode: 'rw' }],
    }).token;
    const tokenB = env.sync.tokens.issue({
      actor: 'agent:worker-b',
      actorTag: 'worker-b',
      grants: [{ namespace: 'project-notes', scope: '42', mode: 'rw' }],
    }).token;

    const dirA = join(env.dir, 'client-a');
    const dirB = join(env.dir, 'client-b');
    const clientA = new SyncClient({ baseUrl: env.baseUrl, token: tokenA, namespace: 'project-notes', scope: '42', targetDir: dirA, cas: casA });
    const clientB = new SyncClient({ baseUrl: env.baseUrl, token: tokenB, namespace: 'project-notes', scope: '42', targetDir: dirB, cas: casB });

    // Initial pull on empty scope + write base file on A and push.
    await clientA.pull();
    const initial = '# Guide\n\n## Intro\ninitial intro\n\n## Steps\ninitial steps\n';
    writeFileSync(join(dirA, 'guide.md'), initial);
    const push1 = await clientA.push({ mode: 'interactive' });
    assert.equal(push1.ok, true);
    assert.equal(push1.results[0].status, 'committed');
    assert.equal(existsSync(join(dirA, '.sync-base.json')), true);

    // Client B pulls -> receives guide.md and writes .sync-base.json.
    const pullB1 = await clientB.pull();
    assert.equal(pullB1.fetched_blobs, 1);
    assert.equal(readFileSync(join(dirB, 'guide.md'), 'utf8'), initial);

    // Subsequent unchanged pull & push transfer 0 bytes!
    const pullBNoop = await clientB.pull();
    assert.equal(pullBNoop.fetched_blobs, 0);
    assert.equal(pullBNoop.fetched_bytes, 0);
    const pushBNoop = await clientB.push();
    assert.equal(pushBNoop.uploaded_blobs, 0);
    assert.equal(pushBNoop.uploaded_bytes, 0);

    // 1. Disjoint edits on A (Intro) and B (Steps) -> B auto-merges cleanly!
    writeFileSync(join(dirA, 'guide.md'), initial.replace('initial intro', 'updated intro by A'));
    assert.equal((await clientA.push({ mode: 'interactive' })).ok, true);

    writeFileSync(join(dirB, 'guide.md'), initial.replace('initial steps', 'updated steps by B'));
    const pushBAutoMerge = await clientB.push({ mode: 'interactive' });
    assert.equal(pushBAutoMerge.ok, true);
    assert.equal(pushBAutoMerge.results[0].status, 'merged');
    const mergedContent = readFileSync(join(dirB, 'guide.md'), 'utf8');
    assert.match(mergedContent, /updated intro by A/);
    assert.match(mergedContent, /updated steps by B/);

    // A pulls merged content cleanly.
    await clientA.pull();
    assert.equal(readFileSync(join(dirA, 'guide.md'), 'utf8'), mergedContent);

    // 2. True same-line conflict in interactive mode -> HTTP 409 sync_conflict with base/current/local diff.
    writeFileSync(join(dirA, 'guide.md'), mergedContent.replace('updated intro by A', 'intro-final-by-A'));
    assert.equal((await clientA.push({ mode: 'interactive' })).ok, true);

    writeFileSync(join(dirB, 'guide.md'), mergedContent.replace('updated intro by A', 'intro-final-by-B'));
    const conflictRes = await clientB.push({ mode: 'interactive' });
    assert.equal(conflictRes.ok, false);
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.error, 'sync_conflict');
    assert.equal(conflictRes.conflicts.length, 1);
    assert.match(conflictRes.conflicts[0].current_content, /intro-final-by-A/);
    assert.match(conflictRes.conflicts[0].local_content, /intro-final-by-B/);

    // Online agent resolves the 409 semantically, advances baseline to server revision, and resubmits!
    const resolved = mergedContent.replace('updated intro by A', 'intro-combined-A-and-B');
    writeFileSync(join(dirB, 'guide.md'), resolved);
    await clientB.acceptServerBase('guide.md', conflictRes.conflicts[0].current_revision, conflictRes.conflicts[0].current_sha256);
    const resolvedPush = await clientB.push({ mode: 'interactive' });
    assert.equal(resolvedPush.ok, true);
    assert.equal(resolvedPush.results[0].status, 'committed');

    // 3. True same-line conflict in background mode -> preserves main file untouched & writes conflict copy!
    await clientA.pull();
    writeFileSync(join(dirA, 'guide.md'), resolved.replace('intro-combined-A-and-B', 'main-kept-by-A'));
    assert.equal((await clientA.push({ mode: 'interactive' })).ok, true);

    writeFileSync(join(dirB, 'guide.md'), resolved.replace('intro-combined-A-and-B', 'background-attempt-by-B'));
    const bgPush = await clientB.push({ mode: 'background' });
    assert.equal(bgPush.ok, true);
    assert.equal(bgPush.status, 200);
    assert.equal(bgPush.results[0].status, 'conflict_copy');
    const copyPath = bgPush.results[0].conflict_path;
    assert.match(copyPath, /^guide\.conflict-worker-b-\d{8}T\d{6}Z\.md$/);
    // Main file preserved as A's version; conflict copy holds B's version on both server and client!
    assert.match(readFileSync(join(env.projectNotesRoot, '42', 'guide.md'), 'utf8'), /main-kept-by-A/);
    assert.match(readFileSync(join(env.projectNotesRoot, '42', copyPath), 'utf8'), /background-attempt-by-B/);
    assert.match(readFileSync(join(dirB, 'guide.md'), 'utf8'), /main-kept-by-A/);
    assert.match(readFileSync(join(dirB, copyPath), 'utf8'), /background-attempt-by-B/);

    // 4. Control-plane Redactor scrubs registered secret on push and syncs redacted bytes back to client.
    writeFileSync(join(dirA, 'secret-note.md'), 'key=super-secret-api-key-123456\n');
    const redactedPush = await clientA.push({ mode: 'interactive' });
    assert.equal(redactedPush.ok, true);
    assert.equal(redactedPush.results[0].redacted, true);
    assert.equal(readFileSync(join(env.projectNotesRoot, '42', 'secret-note.md'), 'utf8'), 'key=[REDACTED]\n');
    assert.equal(readFileSync(join(dirA, 'secret-note.md'), 'utf8'), 'key=[REDACTED]\n');

    // 5. Deletion propagates across clients.
    await clientB.pull();
    assert.equal(existsSync(join(dirB, 'secret-note.md')), true);
    unlinkSync(join(dirA, 'secret-note.md'));
    const delPush = await clientA.push({ mode: 'interactive' });
    assert.equal(delPush.ok, true);
    assert.equal(delPush.results[0].deleted, true);

    const pullAfterDel = await clientB.pull();
    assert.equal(pullAfterDel.deleted_files, 1);
    assert.equal(existsSync(join(dirB, 'secret-note.md')), false);

    // 6. Client-side symlink protection blocks exfiltration on push.
    const outsideSecret = join(env.dir, 'host-secret.txt');
    writeFileSync(outsideSecret, 'do not exfiltrate');
    symlinkSync(outsideSecret, join(dirA, 'sneaky-link.md'));
    await assert.rejects(() => clientA.push(), /sync_symlink_forbidden/);
    unlinkSync(join(dirA, 'sneaky-link.md'));

    // 7. Server-side path traversal & unauthorized scope rejection.
    const traversalRes = await fetch(`${env.baseUrl}/sync/project-notes/42/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'interactive',
        changes: [{ path: '../escape.md', base_revision: 0, content_sha256: 'a'.repeat(64) }],
      }),
    });
    assert.equal(traversalRes.status, 400);
    assert.equal((await traversalRes.json()).error, 'sync_invalid_path');

    const crossScopeRes = await fetch(`${env.baseUrl}/sync/project-notes/999/manifest`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(crossScopeRes.status, 403);
    assert.equal((await crossScopeRes.json()).error, 'sync_scope_forbidden');

    const noAuthRes = await fetch(`${env.baseUrl}/sync/project-notes/42/manifest`);
    assert.equal(noAuthRes.status, 401);

    // 8. assistant-homes namespace uses the exact same SyncClient & hides `.write-history` from AssistantHomes.list!
    const owner = 'b'.repeat(32);
    const homeToken = env.sync.tokens.issue({
      actor: 'assistant:group-chat-1',
      actorTag: 'group-1',
      grants: [{ namespace: 'assistant-homes', scope: owner, mode: 'rw' }],
    }).token;
    const homeDirClient = join(env.dir, 'assistant-memory-local');
    const homeClient = new SyncClient({
      baseUrl: env.baseUrl,
      token: homeToken,
      namespace: 'assistant-homes',
      scope: owner,
      targetDir: homeDirClient,
      cas: casA,
    });
    await homeClient.pull();
    writeFileSync(join(homeDirClient, 'INDEX.md'), '# Memory\n- user prefers short answers\n');
    const homePush = await homeClient.push({ mode: 'background' });
    assert.equal(homePush.ok, true);
    assert.equal(
      readFileSync(join(env.assistantHomesRoot, owner, 'home-1', 'memory', 'INDEX.md'), 'utf8'),
      '# Memory\n- user prefers short answers\n',
    );

    // Verify AssistantHomes.list("~/memory") does not leak `.write-history` or `.sync-base.json`.
    const homes = new AssistantHomes(env.store, env.assistantHomesRoot);
    const listed = await homes.list(join(env.assistantHomesRoot, owner, 'home-1'), 'memory', true);
    assert.equal(listed.exists, true);
    assert.deepEqual(listed.entries.map(e => e.path), ['INDEX.md']);

    // 9. Dirty local file protection on pull, delete/modify conflicts, re-creation over tombstone,
    //    single-blob binary GET, cross-scope CAS oracle prevention, and conflicts/history endpoints.
    writeFileSync(join(dirA, 'guide.md'), 'dirty uncommitted local edit on A\n');
    writeFileSync(join(dirB, 'guide.md'), readFileSync(join(dirB, 'guide.md'), 'utf8') + '\nextra B line\n');
    assert.equal((await clientB.push({ mode: 'interactive' })).ok, true);

    const dirtyPull = await clientA.pull();
    assert.deepEqual(dirtyPull.skipped_dirty, ['guide.md']);
    assert.equal(readFileSync(join(dirA, 'guide.md'), 'utf8'), 'dirty uncommitted local edit on A\n');

    const forcedPull = await clientA.pull({ force: true });
    assert.deepEqual(forcedPull.skipped_dirty, []);
    assert.match(readFileSync(join(dirA, 'guide.md'), 'utf8'), /extra B line/);

    // Modify-vs-delete in background mode preserves local work as a conflict copy!
    await clientB.pull();
    unlinkSync(join(dirA, 'guide.md'));
    assert.equal((await clientA.push({ mode: 'interactive' })).ok, true);

    writeFileSync(join(dirB, 'guide.md'), 'precious edit while deleted on server\n');
    const modDelBg = await clientB.push({ mode: 'background' });
    assert.equal(modDelBg.ok, true);
    assert.equal(modDelBg.results[0].status, 'conflict_copy');
    assert.ok(modDelBg.results[0].conflict_path);
    assert.equal(
      readFileSync(join(env.projectNotesRoot, '42', modDelBg.results[0].conflict_path), 'utf8'),
      'precious edit while deleted on server\n',
    );

    // Re-creating a previously soft-deleted file cleanly with base_revision=0 succeeds.
    await clientA.pull();
    writeFileSync(join(dirA, 'guide.md'), 'freshly recreated guide\n');
    const recreatePush = await clientA.push({ mode: 'interactive' });
    assert.equal(recreatePush.ok, true);
    assert.equal(recreatePush.results[0].status, 'committed');

    // Single-blob binary GET + cross-scope CAS oracle prevention.
    const guideSha = recreatePush.results[0].sha256;
    const blobGetRes = await fetch(`${env.baseUrl}/sync/project-notes/42/blobs/${guideSha}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(blobGetRes.status, 200);
    assert.equal(blobGetRes.headers.get('x-sync-sha256'), guideSha);
    assert.equal(await blobGetRes.text(), 'freshly recreated guide\n');

    const token99 = env.sync.tokens.issue({
      actor: 'agent:other-project',
      grants: [{ namespace: 'project-notes', scope: '99', mode: 'ro' }],
    }).token;
    const crossOracleRes = await fetch(`${env.baseUrl}/sync/project-notes/99/blobs/${guideSha}`, {
      headers: { Authorization: `Bearer ${token99}` },
    });
    assert.equal(crossOracleRes.status, 404);

    // Conflicts and history HTTP endpoints return structured records.
    const conflictsRes = await fetch(`${env.baseUrl}/sync/project-notes/42/conflicts`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(conflictsRes.status, 200);
    const conflictsBody = await conflictsRes.json();
    assert.ok(conflictsBody.conflicts.length >= 3);

    const historyRes = await fetch(`${env.baseUrl}/sync/project-notes/42/history?path=guide.md`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(historyRes.status, 200);
    const historyBody = await historyRes.json();
    assert.ok(historyBody.versions.length >= 4);
  } finally {
    await env.close();
  }
});

test('FileSyncEngine HTTP bridges project-notes seamlessly through Manager /v1/projects/:id/file-tree (LocalManager)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-mgr-bridge-'));
  const store = new Store(join(dir, 'control.sqlite'), randomBytes(32));
  const localManager = new LocalManager('77', join(dir, 'local-repo-77'));
  const { server, sync } = createControlPlane({
    store,
    staticDirectory: resolve('static'),
    projects: { manager: localManager },
    channels: { longConnections: false },
    schedules: { automatic: false },
    consolidation: { automatic: false },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const tok1 = sync.tokens.issue({ actor: 'agent:m1', actorTag: 'm1', grants: [{ namespace: 'project-notes', scope: '77', mode: 'rw' }] }).token;
    const tok2 = sync.tokens.issue({ actor: 'agent:m2', actorTag: 'm2', grants: [{ namespace: 'project-notes', scope: '77', mode: 'rw' }] }).token;
    const cas = new CasCache(join(dir, 'cas'));
    const c1Dir = join(dir, 'c1');
    const c2Dir = join(dir, 'c2');
    const c1 = new SyncClient({ baseUrl, token: tok1, namespace: 'project-notes', scope: '77', targetDir: c1Dir, cas });
    const c2 = new SyncClient({ baseUrl, token: tok2, namespace: 'project-notes', scope: '77', targetDir: c2Dir, cas });

    await c1.pull();
    writeFileSync(join(c1Dir, 'runbook.md'), 'Header\n\nSection 1\nv1\n\nSection 2\nv2\n');
    assert.equal((await c1.push({ mode: 'interactive' })).ok, true);

    await c2.pull();
    writeFileSync(join(c1Dir, 'runbook.md'), 'Header\n\nSection 1\nv1-from-c1\n\nSection 2\nv2\n');
    assert.equal((await c1.push({ mode: 'interactive' })).ok, true);

    writeFileSync(join(c2Dir, 'runbook.md'), 'Header\n\nSection 1\nv1\n\nSection 2\nv2-from-c2\n');
    const merged = await c2.push({ mode: 'interactive' });
    assert.equal(merged.ok, true);
    assert.equal(merged.results[0].status, 'merged');
    const onDisk = readFileSync(join(dir, 'local-repo-77', 'project-notes', 'runbook.md'), 'utf8');
    assert.match(onDisk, /v1-from-c1/);
    assert.match(onDisk, /v2-from-c2/);
  } finally {
    await new Promise(r => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
