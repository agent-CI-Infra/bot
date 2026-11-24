// Repository names in management and onboarding tool arguments are GitHub full names: GitHub compares them without
// case, while a repository id stays exact. A name that is not found is a correctable argument error, so the model can
// retry in the same turn instead of the turn ending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from '../../../fixtures/identity-fixture.mjs';
import { installed, repositoryRoutes, provider as scripted, call, person, say, assistantModel } from '../../../fixtures/onboarding-fixture.mjs';

const reply = content => ({ role: 'assistant', content });

test('management turns resolve a case-different repository name, correct an unknown one, and use the same name for writes', async t => {
  const f = await identityFixture(t, { github: true }), { admin } = f;
  repositoryRoutes(f);
  const provider = await scripted(t, () => [
    call(0, ['github_read', { repository: 'FIXTURE/PROJECT-101', path: '/readme' }]),
    call(1, ['github_read', { repository: 'fixture/project-999', path: '/readme' }]),
    call(2, ['github_read', { repository: 'fixture/project-101', path: '/readme' }]),
    // The write selector has its own comparison: it must resolve the same mixed-case name and keep the scope check.
    call(3, ['github_write', { repository: 'FIXTURE/PROJECT-101', method: 'POST', path: '/not-a-supported-write', body: {}, key: 'case-write' }]),
    reply('已读取 fixture/project-101。'),
  ]);
  await assistantModel(f, provider);

  const conversation = (await admin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const turn = await say(admin, conversation, '请读取这个仓库的 README');
  assert.equal(turn.history.messages[0].state, 'completed', turn.history.messages[0].error);

  const reads = turn.history.events.filter(e => e.type === 'tool_result' && e.data.name === 'github_read').map(e => e.data.result);
  assert.deepEqual(reads.map(read => read.repository), ['fixture/project-101', 'fixture/project-101']);
  assert.match(reads[0].result.content, /command line tool/);

  // Only the unknown name is a correctable argument error: a case-different name names the same repository.
  const correctable = turn.history.events.filter(e => e.type === 'tool_error' && e.data.name === 'github_read').map(e => e.data);
  assert.deepEqual(correctable.map(e => e.error), ['repository_not_found']);
  assert.ok(!turn.history.events.some(e => e.type === 'error'), 'a missing name must not end the turn');

  const writes = turn.history.events.filter(e => e.type === 'tool_result' && e.data.name === 'github_write').map(e => e.data.result);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].repository, 'fixture/project-101');
  assert.equal(writes[0].result.error, 'github_write_route_unsupported');
  assert.ok(!turn.history.events.some(e => e.type === 'tool_error' && e.data.name === 'github_write'));
});

test('an onboarding turn resolves a case-different name of its unstarted repository', async t => {
  const f = await identityFixture(t, { github: true }), { admin, state } = f;
  installed(f, '103');
  state.accessible = ['101', '103'];
  repositoryRoutes(f);
  const provider = await scripted(t, () => [
    call(0, ['start_repository', { action: 'status', repository: 'FIXTURE/PROJECT-103' }]),
    reply('fixture/project-103 尚未启动。'),
  ]);
  await assistantModel(f, provider);

  const repositoryAdmin = await person(f, 42, 'admin');
  const conversation = (await repositoryAdmin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const turn = await say(repositoryAdmin, conversation, '请查看 fixture/project-103 的启动状态');
  assert.equal(turn.history.messages[0].state, 'completed', turn.history.messages[0].error);

  const started = turn.history.events.filter(e => e.type === 'tool_result' && e.data.name === 'start_repository').map(e => e.data.result);
  assert.equal(started.length, 1);
  assert.equal(started[0].state, 'unstarted');
  assert.deepEqual(started[0].repository, { id: '103', full_name: 'fixture/project-103', started: false, organization_trusted: false });
});
