import test from 'node:test';
import assert from 'node:assert/strict';
import { managementFixture, settled, toolResults } from '../../../fixtures/management-fixture.mjs';

// Local model protocol fixtures verify transport/service behavior; they do not measure model language quality.
const respond = (res, message) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 4 } })); };
const reply = (res, content) => respond(res, { role: 'assistant', content });
const call = (res, operation, target = {}, args = {}) => respond(res, { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-query', type: 'function', function: { name: 'management_query', arguments: JSON.stringify({ operation, target, arguments: args }) } }] });
async function web(f, content, client = f.admin) {
  const conversation = (await client('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const message = (await client('/api/management/conversations/' + conversation + '/messages', 'POST', { source_message: 'fixture-web', content })).value;
  return { conversation, message, history: await settled(client, conversation, message.id) };
}
const toolMessages = body => body.messages.filter(m => m.role === 'tool');

// #533: a tool that answers 404/409 is the assistant's to correct, not the end of the user's turn. Refusals come back to
// the model too (below); 401 and internal failures still end the turn.
test('a recoverable tool status returns the tool result to the model and the turn continues', async t => {
  const f = await managementFixture(t);
  f.modelState.respond = async (body, res) => {
    const observations = toolResults(body);
    if (!observations.length) return call(res, 'get_task', { project_id: '101', task_id: 'missing' });
    // The model reads the same receipt a person would: the error code, not a thrown turn.
    assert.equal(observations[0].error, 'task_not_found');
    reply(res, '这个项目里没有该任务，可能已被删除。');
  };
  const w = await web(f, '看看那个已经不在的任务');
  assert.equal(w.history.messages[0].state, 'completed', w.history.messages[0].error);
  // The observation really reached the model, not only the event stream.
  assert.equal(f.requests.length, 2, 'the model must be asked a second time with the tool result');
  const observation = JSON.parse(toolMessages(f.requests[1])[0].content);
  assert.equal(observation.error, 'task_not_found');
  // The receipt stays truthful: it was an error, and the user can still see which tool failed.
  assert.ok(w.history.events.some(e => e.type === 'tool_error' && e.data.error === 'task_not_found'));
});

test('a conflicting command revision also returns to the model instead of ending the turn', async t => {
  const f = await managementFixture(t);
  const revision = (await f.admin('/api/management/query', 'POST', { operation: 'get_effective_config', target: { project_id: '101' }, arguments: {} })).value.revision;
  await f.admin('/api/management/commands', 'POST', { operation: 'manager.update', target: { project_id: '101' }, arguments: { prompt: 'New default' }, expected_revision: revision, idempotency_key: 'stale-anchor', source_conversation: 'fixture-conversation', source_message: 'stale-anchor' });
  f.modelState.respond = async (body, res) => {
    const observations = toolResults(body);
    if (!observations.length) return respond(res, { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-command', type: 'function', function: { name: 'management_command', arguments: JSON.stringify({ operation: 'manager.update', target: { project_id: '101' }, arguments: { prompt: 'Second default' }, expected_revision: revision }) } }] });
    assert.equal(observations[0].error, 'management_revision_conflict');
    reply(res, '配置已经被改过，我按最新版本重试。');
  };
  const w = await web(f, '把提示词改成第二版');
  assert.equal(w.history.messages[0].state, 'completed', w.history.messages[0].error);
  assert.equal(JSON.parse(toolMessages(f.requests[1])[0].content).error, 'management_revision_conflict');
});

// A refusal (403) or a business-state 409 (#533, maintainers' decision on #1256) comes back to the model as an observation
// and the turn continues. The refused call does nothing.
test('an authorization refusal comes back to the model and the turn continues', async t => {
  const f = await managementFixture(t), member = await f.member('recovery-refused', { repository_ids: ['102'] });
  f.modelState.respond = async (body, res) => {
    if (!toolResults(body).length) return call(res, 'get_task', { project_id: '101', task_id: 'blocked' });
    reply(res, '你没有项目 101 的访问权限。');
  };
  const w = await web(f, '看看 101 的那个任务', member.client);
  assert.ok(w.history.events.some(e => e.type === 'tool_error' && e.data.error === 'capability_forbidden'));
  assert.equal(w.history.messages[0].state, 'completed', w.history.messages[0].error);
  assert.equal(JSON.parse(toolMessages(f.requests[1])[0].content).error, 'capability_forbidden');
  assert.match(w.history.events.find(e => e.type === 'reply').data.text, /没有项目 101 的访问权限/);
});

test('a business-state 409 comes back to the model and the turn continues', async t => {
  const f = await managementFixture(t);
  f.h.store.run("UPDATE policies SET enabled=0 WHERE repository_id='101'");
  const before = f.h.store.get("SELECT count(*) n FROM management_commands").n;
  f.modelState.respond = async (body, res) => {
    if (!toolResults(body).length) return respond(res, { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-disabled', type: 'function', function: { name: 'management_command', arguments: JSON.stringify({ operation: 'manager.update', target: { project_id: '101' }, arguments: { prompt: '新的默认提示词' }, expected_revision: 'stale-anchor' }) } }] });
    reply(res, '项目 101 已停用，需要先启用。');
  };
  const w = await web(f, '把提示词改掉');
  assert.ok(w.history.events.some(e => e.type === 'tool_error' && e.data.error === 'project_disabled'));
  assert.equal(f.h.store.get("SELECT count(*) n FROM management_commands").n, before, 'the refused command records nothing');
  assert.equal(w.history.messages[0].state, 'completed', w.history.messages[0].error);
  assert.equal(JSON.parse(toolMessages(f.requests[1])[0].content).error, 'project_disabled');
});
