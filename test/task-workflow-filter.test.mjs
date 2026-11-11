import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from './helpers.mjs';

// #238 API slice: the task list can be narrowed to one work type, which is what the costs down-drill needs.
// A task's work type is workOf(kind): ordinary "workflow.*" kinds are the single 通用回复 work type.
test('the task list filters by work type and combines with kind as an intersection', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const insert = (id, kind, created) => h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    id, '101', kind, 'succeeded', id, created, created);
  insert('ri', 'review.issue', '2026-11-01T00:00:00Z');
  insert('rp', 'review.pr', '2026-11-02T00:00:00Z');
  insert('di', 'development.issue', '2026-11-03T00:00:00Z');
  insert('wi', 'workflow.issue', '2026-11-04T00:00:00Z');
  insert('wp', 'workflow.pr', '2026-11-05T00:00:00Z');
  insert('rn', 'release.notes', '2026-11-06T00:00:00Z');
  const ids = async query => (await admin('/api/tasks' + query)).value.tasks.map(row => row.id).sort();

  // One work type selects exactly the tasks it runs as.
  assert.deepEqual(await ids('?workflow=review.pr'), ['rp']);
  assert.deepEqual(await ids('?workflow=review.issue'), ['ri']);
  assert.deepEqual(await ids('?workflow=development.issue'), ['di']);
  // 通用回复 owns both ordinary workflow kinds, so it must not be read from the kind prefix by hand.
  assert.deepEqual(await ids('?workflow=reply'), ['wi', 'wp']);
  // The param combines with kind instead of overriding it: the two conditions are an intersection.
  assert.deepEqual(await ids('?kind=review&workflow=review.pr'), ['rp']);
  assert.deepEqual(await ids('?kind=review&workflow=development.issue'), []);
  // The existing kind behaviour is unchanged: review is both review kinds, development both development kinds.
  assert.deepEqual(await ids('?kind=review'), ['ri', 'rp']);
  assert.deepEqual(await ids('?kind=development'), ['di']);
  // A valid work type with no task is an empty list, never a 404.
  const empty = await admin('/api/tasks?workflow=gate.onboarding');
  assert.deepEqual([empty.status, empty.value.tasks], [200, []]);
  // Unknown values are refused with a stable code so the console can tell a typo from an empty result.
  for (const query of ['?workflow=nope', '?workflow=Review.pr']) {
    const refused = await admin('/api/tasks' + query);
    assert.deepEqual([refused.status, refused.value.error], [400, 'invalid_task_workflow'], query);
  }
  // An omitted or empty value means no narrowing, like the other list params.
  assert.equal((await admin('/api/tasks?workflow=')).value.tasks.length, 6);
  // The summary block counts with the same filter as the rows.
  const summary = (await admin('/api/tasks?workflow=review.pr&summary=1')).value.summary;
  assert.equal(summary.all, 1);
});
