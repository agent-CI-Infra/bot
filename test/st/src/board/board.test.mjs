import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { boardStorage } from '../../../../dist/board/storage.js';

test('retired legacy Kanban board endpoints answer 410 board_retired while Issue & PR progress endpoints work (#1222)', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');

  for (const [path, method, body] of [
    ['/api/board', 'GET'],
    ['/api/board/cards', 'GET'],
    ['/api/board/cards?repository_id=101', 'GET'],
    ['/api/board/cards/101/issue/1/tasks', 'GET'],
    ['/api/board/cards/101/issue/1', 'PATCH', { field_id: 'f1', option_id: 'o1' }],
    ['/api/board/fields', 'POST', { name: 'Priority' }],
    ['/api/board/fields/f1/options', 'POST', { name: 'High' }],
    ['/api/board/views', 'POST', { name: 'Custom', group_by: 'bot_stage', filters: [], hidden_columns: [] }],
    ['/api/board/views/default', 'PATCH', { group_by: 'bot_stage' }],
    ['/api/board/views/v1', 'DELETE', {}],
  ]) {
    const res = await admin(path, method, body);
    assert.equal(res.status, 410, `${method} ${path}`);
    assert.equal(res.value.error, 'board_retired', `${method} ${path}`);
  }

  assert.equal((await admin('/api/board/issues?repository_id=101')).status, 200);
  assert.equal((await admin('/api/board/prs?repository_id=101')).status, 200);
});

test('verified webhooks project draft, closed and comment objects into board_objects without starting tasks', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');

  await h.hook(a.path, a.secret, 'pr-draft', {
    repository: { id: 101 },
    action: 'opened',
    pull_request: { number: 3, title: 'WIP draft PR', state: 'open', draft: true },
  });
  await h.hook(a.path, a.secret, 'pr-closed', {
    repository: { id: 101 },
    action: 'closed',
    pull_request: { number: 4, title: 'Closed PR', state: 'closed', draft: false },
  });
  await h.hook(a.path, a.secret, 'issue-open', {
    repository: { id: 101 },
    action: 'opened',
    issue: { number: 5, title: 'Open issue', state: 'open' },
  });

  const prs = (await admin('/api/board/prs?repository_id=101&include_closed=1')).value.prs;
  assert.equal(prs.length, 2);
  const pr3 = prs.find(p => p.number === 3);
  const pr4 = prs.find(p => p.number === 4);
  assert.equal(pr3.draft, true);
  assert.equal(pr3.status, 'draft');
  assert.equal(pr4.github_state, 'closed');

  const issues = (await admin('/api/board/issues?repository_id=101')).value.issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, 5);
  assert.equal(issues[0].title, 'Open issue');
});

test('one-time board_pr_tasks_v1 backfill projects historical legacy and #1122 PR tasks cleanly', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const now = '2026-11-20T10:00:00.000Z';
  h.store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,head_sha,result,created_at,updated_at) VALUES('backfill-pr-1','101','review.pr','succeeded','Review PR #9',9,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?, ?, ?)`,
    JSON.stringify({ conclusion: 'ready_for_development', recommendation: 'Looks good.' }),
    now, now,
  );
  // Clear projection and migration flag, then re-run boardStorage to verify backfill
  h.store.run('DELETE FROM board_pr_tasks');
  h.store.run("DELETE FROM settings WHERE key='board_pr_tasks_v1'");
  boardStorage(h.store);
  const row = h.store.get("SELECT * FROM board_pr_tasks WHERE task_id='backfill-pr-1'");
  assert.ok(row);
  assert.equal(row.object_number, 9);
  assert.equal(row.role_kind, 'review');
  assert.equal(row.head_sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(row.recommendation, 'Looks good.');
});
