import { command } from '../../../fixtures/management-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { memoryTool, readProjectNote, saveProjectNote, searchProjectNotes } from '../../../../dist/memory/project.js';
import { migrateLegacyProjectMemories } from '../../../../dist/memory/migration.js';
import { taskMemoryAccess } from '../../../../dist/memory/access.js';
import { resolvePrincipalActor, invalidate } from '../../../../dist/identity/authorization.js';
import { traceEvent, traceSource } from '../../../../dist/tasks/trace.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { readEvidence } from '../../../../dist/tasks/evidence.js';
import { sha } from '../../../../dist/agent/common.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { deleteProjectRecords } from '../../../../dist/projects/removal.js';
import { knowledgeActor, authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { managerFixture } from '../../../fixtures/project-manager-fixture.mjs';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';

const commit = 'a'.repeat(40);

function createLegacyTables(s) {
  s.db.exec(`CREATE TABLE IF NOT EXISTS project_memories(
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_memory_versions(
    memory_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    data TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(memory_id, revision)
  );`);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-unified-'));
  const s = new Store(':memory:', Buffer.alloc(32));
  const manager = new LocalManager('101', dir);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
  for (const [id, owner] of [['101', '10'], ['102', '10'], ['201', '20']]) {
    s.run('INSERT INTO repositories VALUES(?,?,?,?)', id, 'fixture/' + id, owner, 'a');
  }
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,head_sha) VALUES('t','101','task.request','running','runtime notes',?)", commit);
  const actor = authorizeKnowledgeTask(s);
  const task = (role = 'dev') => ({ ...s.get("SELECT * FROM tasks WHERE id='t'"), active_role: role, trace_run_id: 'run-' + role });
  return { s, manager, actor, task };
}

test('legacy SQLite project_memories migrate safely and idempotently into physical Markdown files without overwriting', async t => {
  const { s, manager } = fixture(t);
  createLegacyTables(s);
  s.run('UPDATE accounts SET credentials=? WHERE id=?', s.secrets.seal({ token: 'legacy-secret-token-42' }, 'account:a'), 'a');

  // Seed active, collision, repository-authority, inactive, empty, and corrupt rows.
  s.run("INSERT INTO project_memories VALUES('mem00001','101','net.reset',1,?,'2026-01-01T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'active', body: 'ECONNRESET is transient; token legacy-secret-token-42', catalog: { title: 'Network retry', module: 'transport', tags: ['network', 'retry'] } }));
  s.run("INSERT INTO project_memories VALUES('mem00002','101','collide.note',1,?,'2026-01-02T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'active', body: 'Migrated without clobbering existing file', catalog: { title: 'Collide' } }));
  s.run("INSERT INTO project_memories VALUES('mem00003','101','repo.doc',2,?,'2026-01-03T00:00:00Z')",
    JSON.stringify({ kind: 'implementation', authority: 'repository', status: 'active', body: null, document: { path: 'docs/guide.md' } }));
  s.run("INSERT INTO project_memories VALUES('mem00004','101','old.revoked',1,?,'2026-01-04T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'revoked', body: 'should be skipped' }));
  s.run("INSERT INTO project_memories VALUES('mem00005','101','empty.note',1,?,'2026-01-05T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'active', body: '   ' }));
  s.run("INSERT INTO project_memories VALUES('mem00006','101','corrupt.row',1,'{not-json','2026-01-06T00:00:00Z')");

  // Pre-create an unrelated physical file at the exact collision path for mem00002.
  await manager.call('POST', '/v1/projects/101/file-tree', {
    path: 'migrated-memories/Collide--mem00002.md',
    content: 'HUMAN_OWNED_FILE_MUST_NOT_BE_OVERWRITTEN',
    actor: 'user:owner',
    create_parents: true,
  });

  // Simulate a transient failure on first attempt: must not mark migrated so retry succeeds.
  const failingManager = { call: async () => { throw Object.assign(new Error('offline'), { status: 503, code: 'manager_offline' }); } };
  const transient = await migrateLegacyProjectMemories(s, failingManager, '101');
  assert.equal(transient.failed, 2);
  assert.equal(transient.skipped, 4);
  assert.equal(s.get("SELECT count(*) n FROM project_memory_migrations WHERE status='migrated'").n, 0);

  // Real migration succeeds for both active entries.
  const first = await migrateLegacyProjectMemories(s, manager, '101');
  assert.equal(first.migrated, 2);
  assert.equal(first.failed, 0);

  const retryNote = await readProjectNote(manager, '101', 'migrated-memories/Network retry--mem00001.md');
  assert.ok(retryNote.content.startsWith('<!-- legacy-project-memory: mem00001 -->'));
  assert.ok(retryNote.content.includes('ECONNRESET is transient; token [REDACTED]'));
  assert.ok(!retryNote.content.includes('legacy-secret-token-42'));
  assert.ok(retryNote.content.includes('- Module: transport'));
  assert.ok(retryNote.content.includes('- Tags: network, retry'));

  // Collision path preserved human file and wrote migrated copy to -2 suffix.
  const humanFile = await readProjectNote(manager, '101', 'migrated-memories/Collide--mem00002.md');
  assert.equal(humanFile.content, 'HUMAN_OWNED_FILE_MUST_NOT_BE_OVERWRITTEN');
  const collidedCopy = await readProjectNote(manager, '101', 'migrated-memories/Collide--mem00002-2.md');
  assert.ok(collidedCopy.content.includes('Migrated without clobbering existing file'));

  // Repeating migration is a complete no-op.
  const second = await migrateLegacyProjectMemories(s, manager, '101');
  assert.deepEqual([second.migrated, second.skipped, second.failed], [0, 0, 0]);

  // Simulate crash after writing mem00001 file but before recording project_memory_migrations row:
  // replay detects the marker comment and does not create a duplicate -2 file.
  s.run("DELETE FROM project_memory_migrations WHERE memory_id='mem00001'");
  const replayed = await migrateLegacyProjectMemories(s, manager, '101');
  assert.equal(replayed.migrated, 1);
  assert.equal(replayed.items[0].note_path, 'migrated-memories/Network retry--mem00001.md');
  const all = await searchProjectNotes(manager, '101', '', { limit: 50 });
  assert.deepEqual(all.items.map(f => f.path).sort(), [
    'migrated-memories/Collide--mem00002-2.md',
    'migrated-memories/Collide--mem00002.md',
    'migrated-memories/Network retry--mem00001.md',
  ]);
});

test('legacy migration byte-bounds long multibyte titles and records permanent 4xx errors without retrying forever', async t => {
  const { s, manager } = fixture(t);
  createLegacyTables(s);
  const cjkTitle = '中文知识标题'.repeat(20); // 120 UTF-16 chars, 360 UTF-8 bytes (> 255 byte path component limit)
  const emojiTitle = '🚀笔记'.repeat(60); // 4-byte UTF-8 surrogate pairs
  s.run("INSERT INTO project_memories VALUES('mb000001','101','cjk.long',1,?,'2026-01-01T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'active', body: 'CJK body preserved', catalog: { title: cjkTitle } }));
  s.run("INSERT INTO project_memories VALUES('mb000002','101','emoji.long',1,?,'2026-01-02T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'active', body: 'Emoji body preserved', catalog: { title: emojiTitle } }));

  const migrated = await migrateLegacyProjectMemories(s, manager, '101');
  assert.deepEqual([migrated.migrated, migrated.skipped, migrated.failed], [2, 0, 0]);
  for (const item of migrated.items) {
    assert.equal(item.status, 'migrated');
    const basename = item.note_path.split('/').at(-1);
    assert.ok(Buffer.byteLength(basename, 'utf8') <= 255, `component too long: ${Buffer.byteLength(basename, 'utf8')} bytes`);
    assert.equal(basename.isWellFormed(), true, 'must not split UTF-16 surrogate pairs');
  }
  const cjkNote = await readProjectNote(manager, '101', migrated.items.find(i => i.memory_id === 'mb000001').note_path);
  assert.ok(cjkNote.content.includes(`# ${cjkTitle}`));
  assert.ok(cjkNote.content.includes('CJK body preserved'));

  // Project-wide 4xx errors (401 unauthorized, 403 resource_ownership_mismatch, 404 not_found) must stay retryable and never write skipped_invalid.
  s.run("INSERT INTO project_memories VALUES('retry403','101','proj.infra',1,?,'2026-01-03T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'active', body: 'Should migrate once manager recovers' }));
  for (const [status, code] of [[401, 'unauthorized'], [403, 'resource_ownership_mismatch'], [404, 'not_found']]) {
    const infraFail = { call: async () => { throw Object.assign(new Error(code), { status, code }); } };
    const failedPass = await migrateLegacyProjectMemories(s, infraFail, '101');
    assert.deepEqual([failedPass.migrated, failedPass.skipped, failedPass.failed], [0, 0, 1], `${status} ${code} must be retryable`);
    assert.equal(s.get("SELECT status FROM project_memory_migrations WHERE memory_id='retry403'"), undefined);
  }
  const recovered = await migrateLegacyProjectMemories(s, manager, '101');
  assert.deepEqual([recovered.migrated, recovered.skipped, recovered.failed], [1, 0, 0]);
  assert.equal(s.get("SELECT status FROM project_memory_migrations WHERE memory_id='retry403'").status, 'migrated');

  // Permanent per-row validation error (400 invalid_note_path) records skipped_invalid in the ledger so retries stop immediately.
  s.run("INSERT INTO project_memories VALUES('bad40001','101','perm.bad',1,?,'2026-01-04T00:00:00Z')",
    JSON.stringify({ kind: 'experience', status: 'active', body: 'Will hit permanent 400' }));
  const badManager = {
    call: async (method, path) => {
      if (method === 'POST' && path.endsWith('/file-tree')) {
        throw Object.assign(new Error('invalid_note_path'), { status: 400, code: 'invalid_note_path' });
      }
      return {};
    },
  };
  const permanent = await migrateLegacyProjectMemories(s, badManager, '101');
  assert.deepEqual([permanent.migrated, permanent.skipped, permanent.failed], [0, 1, 0]);
  assert.equal(s.get("SELECT status FROM project_memory_migrations WHERE memory_id='bad40001'").status, 'skipped_invalid');
  const next = await migrateLegacyProjectMemories(s, badManager, '101');
  assert.deepEqual([next.migrated, next.skipped, next.failed], [0, 0, 0]);
});

test('fresh databases do not create legacy project_memories tables and historical traceSource replay enforces project authorization', async t => {
  const { s, actor, task } = fixture(t);
  assert.equal(s.hasTable('project_memories'), false);
  assert.equal(s.hasTable('project_memory_versions'), false);
  assert.throws(() => traceSource(s, 't', 'project_memories:missing:1', { actor }), /trace_source_not_found/);

  // Legacy tables present on upgraded installations remain read-only replayable with authorization checks.
  createLegacyTables(s);
  s.run("INSERT INTO project_memories VALUES('hist-r','101','k',1,?,'now')", JSON.stringify({ body: 'HISTORICAL_BODY', status: 'active' }));
  s.run("INSERT INTO project_memory_versions VALUES('hist-r',1,?,'user:owner','hist','now')", JSON.stringify({ body: 'HISTORICAL_BODY', status: 'active' }));
  s.run("INSERT INTO project_memories VALUES('hist-foreign','201','k',1,?,'now')", JSON.stringify({ body: 'FOREIGN_SECRET', status: 'active' }));
  s.run("INSERT INTO project_memory_versions VALUES('hist-foreign',1,?,'user:other','hist','now')", JSON.stringify({ body: 'FOREIGN_SECRET', status: 'active' }));

  const replayed = traceSource(s, 't', 'project_memories:hist-r:1', taskMemoryAccess(s, task('reviewer')));
  assert.equal(replayed.data.body, 'HISTORICAL_BODY');
  assert.throws(() => traceSource(s, 't', 'project_memories:hist-foreign:1', { actor }), /trace_source_not_found/);

  // Revoking actor authorization blocks replay immediately.
  invalidate(s, actor.principal_id, 'fixture revoked');
  assert.throws(() => traceSource(s, 't', 'project_memories:hist-r:1', { actor }), /authorization_changed/);
  s.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id='owner'", Date.now());
  const refreshed = resolvePrincipalActor(s, 'owner', actor.tenant_id);
  assert.throws(() => traceSource(s, 't', 'project_memories:hist-r:1', { actor: refreshed }), /capability_forbidden/);

  // Project deletion cleans up migration & legacy memory tables.
  s.run("INSERT INTO project_memory_migrations VALUES('hist-r','101','migrated-memories/k--hist-r.md','migrated','now')");
  deleteProjectRecords(s, '101');
  assert.equal(s.get("SELECT count(*) n FROM project_memory_migrations WHERE repository_id='101'").n, 0);
  assert.equal(s.get("SELECT count(*) n FROM project_memories WHERE repository_id='101'").n, 0);
  assert.equal(s.get("SELECT count(*) n FROM project_memory_versions WHERE memory_id='hist-r'").n, 0);
  assert.equal(s.get("SELECT count(*) n FROM project_memories WHERE repository_id='201'").n, 1);
});

test('same-project working roles share physical notes while retired /memories and /knowledge endpoints return 410', async t => {
  const f = await managerFixture(t);
  const h = await harness(t, f.manager);
  const { admin } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');

  // Retired routes always return 410 project_memory_api_removed.
  for (const [method, path] of [
    ['GET', '/api/repositories/101/memories'],
    ['POST', '/api/repositories/101/memories'],
    ['PATCH', '/api/repositories/101/memories/some-id'],
    ['GET', '/api/projects/101/knowledge'],
    ['POST', '/api/projects/101/knowledge/some-id/review'],
  ]) {
    const res = await admin(path, method, method === 'GET' ? undefined : {});
    assert.equal(res.status, 410, `${method} ${path}`);
    assert.equal(res.value.error, 'project_memory_api_removed');
  }

  // Management facade operates directly on physical project notes (create, body search + preview, read, versions, revise, delete, restore).
  const createArgs = { path: 'ops/retry-policy.md', revision: 0, content: '# Retry Policy\n\nHandle transient socket reset with exponential backoff.' };
  const created = await command(admin, 'knowledge.revise', { project_id: '101' }, createArgs, 'create-note-1');
  assert.equal(created.value.state, 'succeeded', JSON.stringify(created.value));
  const file = created.value.result.file;
  assert.equal(file.path, 'ops/retry-policy.md');
  assert.equal(file.revision, 1);

  // Replay with same idempotency key reuses command without creating a second revision.
  const replay = await command(admin, 'knowledge.revise', { project_id: '101' }, createArgs, 'create-note-1');
  assert.equal(replay.value.id, created.value.id);

  // Management query search_knowledge searches file bodies and returns preview excerpt.
  const search = await admin('/api/management/query', 'POST', {
    operation: 'search_knowledge',
    target: { project_id: '101' },
    arguments: { query: 'exponential backoff' },
  });
  assert.equal(search.status, 201, JSON.stringify(search.value));
  assert.equal(search.value.items.length, 1);
  assert.equal(search.value.items[0].id, file.id);
  assert.equal(search.value.items[0].match_in, 'content');
  assert.ok(search.value.items[0].preview.includes('exponential backoff'));

  // Update via knowledge.revise and check exact revision read + versions + audit.
  const updated = await command(admin, 'knowledge.revise', { project_id: '101' }, {
    id: file.id,
    revision: 1,
    content: '# Retry Policy v2\n\nUpdated retry guidance.',
  }, 'update-note-1');
  assert.equal(updated.value.state, 'succeeded', JSON.stringify(updated.value));
  assert.equal(updated.value.result.file.revision, 2);

  // Stale revision reports note_revision_changed cleanly.
  const stale = await command(admin, 'knowledge.revise', { project_id: '101' }, {
    id: file.id,
    revision: 1,
    content: 'stale edit',
  }, 'stale-note-1');
  assert.equal(stale.value.state, 'unknown');
  assert.equal(stale.value.result.error, 'note_revision_changed');

  const exactV1 = await admin('/api/management/query', 'POST', {
    operation: 'read_knowledge',
    target: { project_id: '101' },
    arguments: { id: file.id, revision: 1 },
  });
  assert.equal(exactV1.value.file.revision, 1);
  assert.ok(exactV1.value.file.content.includes('exponential backoff'));
  assert.ok(h.store.get("SELECT resource_id FROM audit WHERE action='memory.read'").resource_id.includes(`notes:${file.id}:1`));

  const versions = await admin('/api/management/query', 'POST', {
    operation: 'knowledge_versions',
    target: { project_id: '101' },
    arguments: { id: file.id },
  });
  assert.equal(versions.value.versions.length, 2);

  // Delete and restore via knowledge.revise.
  const deleted = await command(admin, 'knowledge.revise', { project_id: '101' }, {
    action: 'delete',
    id: file.id,
    revision: 2,
  }, 'delete-note-1');
  assert.equal(deleted.value.state, 'succeeded');
  assert.equal(deleted.value.result.file.deleted, true);

  const restored = await command(admin, 'knowledge.revise', { project_id: '101' }, {
    action: 'restore',
    id: file.id,
    revision: 3,
    target_revision: 1,
  }, 'restore-note-1');
  assert.equal(restored.value.state, 'succeeded');
  assert.equal(restored.value.result.file.revision, 4);
  assert.ok(restored.value.result.file.content.includes('exponential backoff'));

  // Same-project working roles share the same physical file transparently through memoryTool.
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,head_sha) VALUES('task-101','101','task.request','running','share notes',?)", commit);
  authorizeKnowledgeTask(h.store, 'task-101');
  const task = role => ({ ...h.store.get("SELECT * FROM tasks WHERE id='task-101'"), active_role: role, trace_run_id: 'run-' + role });
  const devWrote = await memoryTool(h.store, task('dev'), 'remember_project_memory', { key: 'shared-finding', body: 'DEV_SHARED_OBSERVATION' }, { manager: f.manager });
  assert.ok(devWrote.id);
  for (const role of ['reviewer', 'test', 'qa', 'manager']) {
    const read = await memoryTool(h.store, task(role), 'read_project_memory', { id: devWrote.id, revision: 1 }, { manager: f.manager });
    assert.equal(read.body, 'DEV_SHARED_OBSERVATION');
    const wrote = await memoryTool(h.store, task(role), 'remember_project_memory', { key: 'note-by-' + role, body: 'shared by ' + role }, { manager: f.manager });
    assert.ok(wrote.id, role + ' can write shared project note');
  }
});

test('TaskRecords raw JSON evidence stays byte-exact and complete', t => {
  const { s, task } = fixture(t);
  const records = new TaskRecords(s);
  const access = taskMemoryAccess(s, task('qa'));
  const contents = ['{\n  "name": "package-fixture",\n  "scripts": { "test": "node --test" }\n}\n', '  [\n    { "path": "src/a.ts" },\n    42\n  ]\n'];
  for (const [i, content] of contents.entries()) {
    for (const type of ['execution_evidence', 'acceptance_evidence']) {
      const data = { name: 'read_file', result: { path: i ? 'files.json' : 'package.json', content } };
      records.history('t', type, data);
      const row = s.get('SELECT id,data FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 1', 't');
      const source = 'task_history:' + row.id;
      const candidate = { id: 'candidate', revision: 1, artifacts: [], evidence: [{ source, version: 'tree', result: { digest: sha(row.data) } }] };
      const read = readEvidence(s, 't', candidate, { source }, access);
      assert.equal(read.chunk, row.data);
      assert.equal(JSON.parse(read.chunk).result.content, content);
      assert.equal(read.digest, sha(row.data));
      assert.equal(readEvidence(s, 't', candidate, { source, offset: 4, length: 17 }, access).chunk, row.data.slice(4, 21));
      const trace = traceSource(s, 't', source, access);
      assert.equal(trace.complete, true);
      assert.equal(trace.missing_reason, undefined);
    }
  }
});

test('ordinary credential discussions and formatted JSON are preserved while registered credentials are redacted on save', async t => {
  const { s, manager } = fixture(t);
  s.run('UPDATE accounts SET credentials=? WHERE id=?', s.secrets.seal({ token: 'secret-registered-cred-99' }, 'account:a'), 'a');
  const ordinary = [
    'How do I pass a bearer token to the API?',
    'const token = readToken();',
    'max_tokens: 8192',
    '{\n  "analysis": "ordinary",\n  "token": "word"\n}',
    'sk-' + '1'.repeat(28),
  ];
  for (const [index, text] of ordinary.entries()) {
    const saved = await saveProjectNote(s, manager, '101', { path: `ordinary-${index}.md`, content: text }, 'user:owner');
    assert.equal(saved.content, text);
  }
  const masked = await saveProjectNote(s, manager, '101', { path: 'masked.md', content: 'prefix secret-registered-cred-99 suffix' }, 'user:owner');
  assert.equal(masked.content, 'prefix [REDACTED] suffix');
});
