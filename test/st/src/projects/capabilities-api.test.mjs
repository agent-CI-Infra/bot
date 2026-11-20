// #1123: GET /api/repositories/:id/capabilities projects the overview's 「我们能干什么」 card from the live settings: anyone who
// may read the project sees it, a change of the ceiling or an event switch shows on the next read, and bound Feishu groups
// and scheduled checks appear as counts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup } from '../../../fixtures/channel-fixture.mjs';

const byId = card => Object.fromEntries(card.scenarios.map(c => [c.id, c.state]));

test('the capability card follows the ceiling, the event switches, bound groups and scheduled checks, and members can read it', async t => {
  const f = await channelFixture(t), read = async (client = f.admin, id = '101') => (await client(`/api/repositories/${id}/capabilities`)).value;
  const start = await read();
  assert.equal(start.scenarios.length, 6);
  assert.deepEqual(start.groups, {}); assert.equal(start.schedules, 0);

  // Raising the ceiling to develop opens development; lowering it to read holds back everything that writes on GitHub.
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' })).status, 200);
  let card = await read();
  assert.equal(card.ceiling, 'develop'); assert.equal(byId(card).development, 'ready');
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'read' })).status, 200);
  card = await read();
  assert.equal(card.ceiling_title, '只读问答');
  assert.deepEqual([byId(card).review, byId(card).development], ['ceiling_limited', 'ceiling_limited']);
  assert.match(card.scenarios.find(c => c.id === 'review').detail, /「只读问答」.*「可评论和打标签」/);

  // A Feishu group bound to the project answers questions at any ceiling; it is counted by its level, without its name.
  await boundGroup(f, ['101']);
  card = await read();
  assert.equal(Object.values(card.groups).reduce((sum, n) => sum + n, 0), 1);
  assert.equal(byId(card).qa, 'ready');
  assert.doesNotMatch(JSON.stringify(card), /oc_group/);
  // The group is not bound to project 102, which therefore counts none.
  assert.deepEqual((await read(f.admin, '102')).groups, {});

  // Switching the Actions failure event off leaves CI failures off until a scheduled check is active.
  assert.equal((await f.admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'comment' })).status, 200);
  const manager = (await f.admin('/api/repositories/101/manager')).value.manager;
  assert.equal((await f.admin('/api/repositories/101/manager', 'PUT', { expected_revision: manager.prompt.revision, events: { 'actions.run_failed': false } })).status, 200);
  assert.equal(byId(await read()).ci, 'off');
  const now = Date.now();
  f.h.store.run(`INSERT INTO schedules(id,tenant_id,project_id,creator_id,owner_id,maintainer_id,actor_id,kind,approver_id,authorization_revision,grant_snapshot,spec,revision,state,reason,next_at,last_success,created_at,updated_at)
    VALUES('check-1','github.com:10','101','x','x','x','x','project',NULL,1,'{}',?,1,'active',NULL,?,NULL,?,?)`, JSON.stringify({ workflow: 'manager.check', instruction: 'Check the CI' }), now + 60000, now, now);
  f.h.store.run(`INSERT INTO schedules(id,tenant_id,project_id,creator_id,owner_id,maintainer_id,actor_id,kind,approver_id,authorization_revision,grant_snapshot,spec,revision,state,reason,next_at,last_success,created_at,updated_at)
    VALUES('check-2','github.com:10','101','x','x','x','x','project',NULL,1,'{}',?,1,'paused','owner_left',NULL,NULL,?,?)`, JSON.stringify({ workflow: 'manager.check' }), now, now);
  card = await read();
  assert.equal(card.schedules, 1); assert.equal(byId(card).ci, 'ready');

  // A project member reads the same card; a person without access to the project does not.
  const member = await f.member('capability-member', { repository_ids: ['101'] });
  assert.deepEqual(byId(await read(member.client)), byId(card));
  const outsider = await f.member('capability-outsider', { repository_ids: ['102'] });
  assert.ok([403, 404].includes((await outsider.client('/api/repositories/101/capabilities')).status));
  assert.equal((await f.admin('/api/repositories/101/capabilities', 'POST', {})).status, 405);
});
