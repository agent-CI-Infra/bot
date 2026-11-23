import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import {
  knowledgePath,
  memoryTool,
  notePathFromKey,
  projectNoteVersions,
  readProjectNote,
  saveProjectNote,
  searchProjectNotes,
} from '../../../../dist/memory/project.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { toolCapabilityError } from '../../../../runner/capabilities.mjs';

const sha = 'a'.repeat(40);
const owner = 'user:owner';

function seed(s) {
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('101','fixture/OpenToday','o','a')");
  s.run("INSERT INTO repositories VALUES('202','private/other','o','a')");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,head_sha) VALUES('t','101','task.request','running','memory filter followup',?)", sha);
  authorizeKnowledgeTask(s);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-unified-'));
  const s = new Store(':memory:', Buffer.alloc(32));
  const manager = new LocalManager('101', dir);
  seed(s);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { s, dir, manager, task: { ...s.get("SELECT * FROM tasks WHERE id='t'"), trace_run_id: 'run' } };
}

test('physical project notes persist revisions across reopen, support exact historical reads and paginate long bodies', async t => {
  const { s, dir, manager, task } = fixture(t);
  const v1 = 'Filter preference uses localStorage; unknown values fall back to all.';
  const v2 = 'Updated behavior:\n' + 'x'.repeat(9000) + 'TAIL_MARKER';

  const saved1 = await saveProjectNote(s, manager, '101', { path: 'guides/memory-filter.md', content: v1 }, owner);
  assert.equal(saved1.revision, 1);
  const saved2 = await saveProjectNote(s, manager, '101', { id: saved1.id, content: v2, expected_revision: 1 }, owner);
  assert.equal(saved2.revision, 2);

  // Stale optimistic revision is rejected.
  await assert.rejects(
    saveProjectNote(s, manager, '101', { id: saved1.id, content: 'stale writer', expected_revision: 1 }, owner),
    /note_revision_changed/,
  );

  // Reopen LocalManager on the same root directory and verify exact revisions & history survive.
  const reopened = new LocalManager('101', dir);
  assert.equal((await readProjectNote(reopened, '101', saved1.id, 1)).content, v1);
  assert.equal((await readProjectNote(reopened, '101', 'guides/memory-filter.md')).revision, 2);
  assert.equal((await projectNoteVersions(reopened, '101', saved1.id)).versions.length, 2);

  // Paginated reads via memoryTool record memory_read trace with notes:<id>:<rev>.
  const page1 = await memoryTool(s, task, 'read_project_memory', { id: saved1.id, revision: 2, offset: 0 }, { manager: reopened });
  assert.equal(page1.revision, 2);
  assert.equal(page1.body.length, 8000);
  assert.equal(page1.next_offset, 8000);
  const page2 = await memoryTool(s, task, 'read_project_memory', { id: saved1.id, revision: 2, offset: page1.next_offset }, { manager: reopened });
  assert.ok(page2.body.endsWith('TAIL_MARKER'));
  assert.equal(page2.next_offset, null);
  assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='memory_read'").n, 2);
});

test('memoryTool searches filenames, paths and bodies with previews, respects prefix filter and rejects sensitive paths', async t => {
  const { s, manager, task } = fixture(t);
  await saveProjectNote(s, manager, '101', { path: 'ops/deploy.md', content: 'Always verify compose config before rollout.' }, owner);
  await saveProjectNote(s, manager, '101', { path: 'guides/testing.md', content: 'Use page.clock instead of fixed sleeps.' }, owner);

  const search = await memoryTool(s, task, 'search_project_memory', { query: 'compose config' }, { manager });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].path, 'ops/deploy.md');
  assert.equal(search.items[0].match_in, 'content');
  assert.ok(search.items[0].preview.includes('compose config'));
  assert.equal(s.get("SELECT count(*) n FROM task_history WHERE type='memory_read'").n, 0, 'search does not claim a read');

  const scoped = await searchProjectNotes(manager, '101', '', { path: 'guides/' });
  assert.deepEqual(scoped.items.map(i => i.path), ['guides/testing.md']);

  for (const bad of ['.env', '.env.production', 'keys/private.pem', '.ssh/id_rsa', '../private/chat.md', '.git/config', '.write-history/file-tree.json']) {
    assert.throws(() => knowledgePath(bad), /memory_sensitive_path|invalid_memory_path/, bad);
    const res = await memoryTool(s, task, 'remember_project_memory', { path: bad, body: 'nope' }, { manager });
    assert.match(res.error, /memory_sensitive_path|invalid_memory_path/);
  }
  assert.equal(notePathFromKey('runtime:retry'), 'runtime-retry.md');
  assert.equal(notePathFromKey('pi.candidate'), 'pi.candidate.md');
  assert.equal(notePathFromKey('../notes/ops/runbook.md'), 'ops/runbook.md');
});

test('memoryTool preserves ordinary auth examples, masks registered credentials, checks capabilities and handles missing bridge', async t => {
  const { s, manager, task } = fixture(t);
  s.run('UPDATE accounts SET credentials=? WHERE id=?', s.secrets.seal({ token: 'registered-project-token-88' }, 'account:a'), 'a');

  const example = 'sk-' + '1'.repeat(28);
  const savedExample = await memoryTool(s, task, 'remember_project_memory', { key: 'auth-example', body: example }, { manager });
  assert.equal((await readProjectNote(manager, '101', savedExample.id)).content, example);

  const savedSecret = await memoryTool(s, task, 'remember_project_memory', { key: 'secret-check', body: 'leak registered-project-token-88 here' }, { manager });
  assert.equal((await readProjectNote(manager, '101', savedSecret.id)).content, 'leak [REDACTED] here');

  // Missing notes bridge fails explicitly without touching SQLite.
  const unavailable = await memoryTool(s, task, 'search_project_memory', { query: 'anything' });
  assert.equal(unavailable.error, 'notes_unavailable');
  assert.equal(s.hasTable('project_memories'), false);

  // Runner capability gate still blocks remember_project_memory without write permission.
  assert.equal(toolCapabilityError({ capabilities: { workspace: { read: true } } }, 'remember_project_memory', {}), 'memory_write_not_allowed');
});
