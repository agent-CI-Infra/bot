import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { harness, setup, account, repository } from './helpers.mjs';
import { emptyRepositoryFixture } from './empty-repository-helpers.mjs';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { githubWrite } from '../dist/github/write.js';
import { projectCeiling } from '../dist/work/ceiling.js';
import { workActive, workPermissions } from '../dist/work/settings.js';

// One capability ceiling per project (#850): read, comment or develop bounds everything the bot may write there.

test('upgrading gives each project the narrowest level its switches and writes allow, and keeps what it could write', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ceiling-')), database = join(directory, 'control.sqlite'), key = randomBytes(32);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(database, key);
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");
  const projects = { develop: [1, 1, 0, '{}'], review: [1, 0, 0, '{}'], actions: [0, 0, 1, '{}'], reply: [0, 0, 0, '{"reply":{"enabled":true}}'], quiet: [0, 0, 0, '{}'],
    'develop-only': [0, 1, 0, '{"review.pr":{"writes":["reply"]}}'] };
  for (const [id, [review, development, actions, work]] of Object.entries(projects)) {
    store.run('INSERT INTO repositories VALUES(?,?,?,?)', id, 'fixture/' + id, '1', 'a');
    // A policy from before #850: its switches and writes, and no ceiling yet.
    store.run('INSERT INTO policies(repository_id,enabled,review_enabled,development_enabled,actions_failures_enabled,work_settings,capability_ceiling) VALUES(?,1,?,?,?,?,NULL)', id, review, development, actions, work);
  }
  store.close(); store = new Store(database, key);
  const ceilings = Object.fromEntries(Object.keys(projects).map(id => [id, store.get('SELECT capability_ceiling FROM policies WHERE repository_id=?', id).capability_ceiling]));
  assert.deepEqual(ceilings, { develop: 'develop', review: 'comment', actions: 'comment', reply: 'comment', quiet: 'read', 'develop-only': 'develop' });
  // The former switches now say what the ceiling says.
  assert.deepEqual(store.all("SELECT review_enabled r,development_enabled d FROM policies WHERE repository_id IN ('develop','quiet') ORDER BY repository_id").map(row => [row.r, row.d]), [[1, 1], [0, 0]]);
  // A project that developed without reviewing keeps its reviews off: the ceiling alone would have turned them on.
  const work = JSON.parse(store.get("SELECT work_settings FROM policies WHERE repository_id='develop-only'").work_settings);
  assert.equal(work['review.issue'].enabled, false); assert.equal(work['review.pr'].enabled, false); assert.deepEqual(work['review.pr'].writes, ['reply']);
  assert.equal(workActive(store, 'develop-only', 'review.issue'), false); assert.equal(workActive(store, 'develop-only', 'development.issue'), true);
  assert.equal(workActive(store, 'review', 'review.issue'), true); assert.equal(workActive(store, 'review', 'development.issue'), false);
  assert.equal(workActive(store, 'actions', 'actions.failures'), true); assert.equal(workActive(store, 'quiet', 'reply'), false);
  // Ordinary tasks wrote nothing unless an administrator chose their writes; at develop they would now inherit code delivery.
  assert.deepEqual(workPermissions(store, 'develop', 'task.request').writes, []); assert.deepEqual(workPermissions(store, 'develop', 'task.development').writes, ['code', 'pull_request']);
  assert.equal(store.get("SELECT count(*) n FROM audit WHERE action='policy.capability_ceiling_migrated'").n, 6);
  // It happens once.
  store.close(); store = new Store(database, key); t.after(() => store.close());
  assert.equal(store.get("SELECT count(*) n FROM audit WHERE action='policy.capability_ceiling_migrated'").n, 6);
});

test('the policy API sets the ceiling, older switches move it, and work types stay under it', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const policy = change => admin('/api/repositories/101/policy', 'PATCH', change);
  const work = async () => Object.fromEntries((await admin('/api/repositories/101/manager')).value.manager.work.map(entry => [entry.id, entry]));
  // The test repository starts with reviews off. Its bot account cannot handle Actions failures, so that stays off (#851).
  assert.equal((await admin('/api/repositories/101/policy')).value.policy.capability_ceiling, 'read');
  assert.equal((await admin('/api/repositories/101/policy')).value.policy.actions_failures_enabled, 0);
  let saved = await policy({ capability_ceiling: 'comment' });
  assert.equal(saved.status, 200); assert.equal(saved.value.policy.capability_ceiling, 'comment');
  assert.deepEqual([saved.value.policy.review_enabled, saved.value.policy.development_enabled], [1, 0]);
  let types = await work();
  assert.equal(types['review.issue'].active, true); assert.equal(types['development.issue'].active, false);
  assert.deepEqual(types['development.issue'].ceiling, { needed: 'develop', covered: false });
  // Ordinary tasks inherit the ceiling: no code delivery below develop. Writes a person confirms in the console stay.
  assert.deepEqual(types['task.request'].writes, []); assert.deepEqual(types['release.notes'].writes, ['release_notes']);
  assert.equal(types['task.request'].write_options.find(option => option.id === 'pull_request').needed, 'develop');
  saved = await policy({ capability_ceiling: 'develop' });
  assert.deepEqual([saved.value.policy.review_enabled, saved.value.policy.development_enabled], [1, 1]);
  types = await work();
  assert.equal(types['development.issue'].active, true); assert.deepEqual(types['task.request'].writes, ['code', 'pull_request']);
  assert.deepEqual(workPermissions(h.store, '101', 'task.development').writes, ['code', 'pull_request']);
  // The former switches still work: development off keeps reviews, reviews off is read.
  assert.equal((await policy({ development_enabled: false })).value.policy.capability_ceiling, 'comment');
  assert.equal((await policy({ development_enabled: true })).value.policy.capability_ceiling, 'develop');
  assert.equal((await policy({ review_enabled: false })).value.policy.capability_ceiling, 'read');
  assert.equal((await policy({ review_enabled: true })).value.policy.capability_ceiling, 'comment');
  // Refused: a level that does not exist (the command schema lists the three), both forms at once, development without reviews.
  assert.equal((await policy({ capability_ceiling: 'merge' })).status, 400);
  for (const change of [{ capability_ceiling: 'develop', development_enabled: true }, { review_enabled: false, development_enabled: true }])
    assert.equal((await policy(change)).value.error, 'invalid_capability_ceiling', JSON.stringify(change));
  assert.equal(projectCeiling(h.store, '101'), 'comment');
  assert.deepEqual(h.store.all("SELECT resource_id FROM audit WHERE action='policy.capability_ceiling' AND repository_id='101' ORDER BY rowid").map(row => row.resource_id),
    // Starting the project (comment) and the test repository's reviews off (read), then each change above.
    ['read -> comment', 'comment -> read', 'read -> comment', 'comment -> develop', 'develop -> comment', 'comment -> develop', 'develop -> read', 'read -> comment']);
});

test('github_write refuses what the ceiling does not allow, for every caller, before anything reaches GitHub', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 7)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')"); store.run("INSERT INTO policies(repository_id,enabled,capability_ceiling) VALUES('r',1,'comment')");
  const repository = store.get("SELECT * FROM repositories WHERE id='r'");
  // The caller's own permission allows everything; only the ceiling refuses.
  const write = args => githubWrite({ store, repository, redactor: new Redactor(), guard: async () => {}, apiUrl: 'http://127.0.0.1:9', scope: 'test', actor: { kind: 'manager', role: 'manager' }, allowed: () => true }, args);
  const merge = await write({ method: 'PUT', path: '/pulls/7/merge', key: 'merge' });
  assert.equal(merge.error, 'capability_ceiling'); assert.equal(merge.needed, 'develop'); assert.equal(merge.ceiling, 'comment'); assert.match(merge.detail, /Contents/);
  assert.equal((await write({ method: 'PUT', path: '/contents/docs/a.md', key: 'file', body: { message: 'm', content: 'YQ==' } })).error, 'capability_ceiling');
  store.run("UPDATE policies SET capability_ceiling='read'");
  const comment = await write({ method: 'POST', path: '/issues/5/comments', key: 'comment', body: { body: 'hello' } });
  assert.equal(comment.error, 'capability_ceiling'); assert.equal(comment.needed, 'comment'); assert.equal(comment.ceiling, 'read');
  assert.deepEqual(store.all('SELECT state,error FROM github_writes ORDER BY rowid').map(row => [row.state, row.error]),
    [['refused', 'capability_ceiling'], ['refused', 'capability_ceiling'], ['refused', 'capability_ceiling']]);
});

test('lowering the ceiling stops a development task before its next tool call instead of cancelling it; raising it lets it be retried', async t => {
  const h = await emptyRepositoryFixture(t, { taskKind: 'development.issue' });
  assert.equal((await h.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'comment' })).status, 200);
  const task = await h.run();
  assert.equal(task.status, 'waiting_permission'); assert.equal(task.error_code, 'capability_ceiling_lowered');
  const fault = h.store.all('SELECT content FROM task_logs WHERE task_id=?', h.taskId).map(row => JSON.parse(row.content)).find(entry => entry.type === 'fault');
  assert.match(fault.detail, /可评论和打标签.*可开发并开 PR/);
  assert.equal((await h.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' })).status, 200);
  const retried = await h.admin('/api/tasks/' + h.taskId + '/retry', 'POST', {});
  assert.equal(retried.status, 201, JSON.stringify(retried.value));
});
