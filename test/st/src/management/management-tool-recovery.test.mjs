import test from 'node:test';
import assert from 'node:assert/strict';
import { managementFixture, settled, toolResults } from '../../../fixtures/management-fixture.mjs';
import { HttpError } from '../../../../dist/core/security.js';
import * as agentModule from '../../../../dist/management/agent.js';

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

// #533: a tool that answers 404/409 is the assistant's to correct, not the end of the user's turn. Only an unrecoverable
// status (401/403 and anything else, including an internal failure) ends the turn with its code.
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

test('an authorization refusal still ends the turn with its code', async t => {
  const f = await managementFixture(t), member = await f.member('recovery-refused', { repository_ids: ['102'] });
  f.modelState.respond = async (body, res) => {
    if (!toolResults(body).length) return call(res, 'get_task', { project_id: '101', task_id: 'blocked' });
    reply(res, 'upstream must not see this reply');
  };
  const w = await web(f, '看看 101 的那个任务', member.client);
  assert.equal(w.history.messages[0].state, 'failed');
  assert.ok(w.history.events.some(e => e.type === 'tool_error' && e.data.error === 'capability_forbidden'));
  assert.equal(f.requests.length, 1, 'a 403 is never handed back to the model as an observation');
});

test('a business-state 409 still ends the turn with its code', async t => {
  const f = await managementFixture(t);
  f.h.store.run("UPDATE policies SET enabled=0 WHERE repository_id='101'");
  f.modelState.respond = async (body, res) => {
    if (!toolResults(body).length) return respond(res, { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-disabled', type: 'function', function: { name: 'management_command', arguments: JSON.stringify({ operation: 'manager.update', target: { project_id: '101' }, arguments: { prompt: '新的默认提示词' }, expected_revision: 'stale-anchor' }) } }] });
    reply(res, 'upstream must not see this reply');
  };
  const w = await web(f, '把提示词改掉');
  assert.equal(w.history.messages[0].state, 'failed');
  assert.ok(w.history.events.some(e => e.type === 'tool_error' && e.data.error === 'project_disabled'));
  assert.equal(f.requests.length, 1, 'a business-state 409 is not handed back to the model');
});

test('the recoverable set is 400/404/413/415 plus a stale revision conflict, never another 409', () => {
  assert.equal(typeof agentModule.recoverableToolStatus, 'function');
  for (const status of [400, 404, 413, 415]) assert.equal(agentModule.recoverableToolStatus(new HttpError(status, 'x')), true, String(status));
  assert.equal(agentModule.recoverableToolStatus(new HttpError(409, 'management_revision_conflict')), true);
  for (const code of ['onboarding_request_closed', 'project_disabled', 'installation_unavailable', 'installation_scope_changed', 'account_credentials_revoked'])
    assert.equal(agentModule.recoverableToolStatus(new HttpError(409, code)), false, code);
  for (const status of [401, 403, 402, 405, 500, 502]) assert.equal(agentModule.recoverableToolStatus(new HttpError(status, 'x')), false, String(status));
  assert.equal(agentModule.recoverableToolStatus(new Error('management_tool_failed')), false);
});
