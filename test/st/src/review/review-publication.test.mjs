// #1100: a QA-approved review publishes; what its result does not cover goes to its next round, and the Manager is told.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFixture } from '../../../fixtures/acceptance-fixture.mjs';
import { emptyRepositoryFixture } from '../../../fixtures/empty-repository-helpers.mjs';
import { TaskError } from '../../../../dist/agent/common.js';
import { queueWebhook } from '../../../../dist/review/queue.js';
import { roleApi } from '../../../../dist/roles/api.js';
import { harnesses } from '../../../../dist/roles/harness.js';
import { captureTaskConfiguration } from '../../../../dist/tasks/configuration.js';
import { publicationContext } from '../../../../dist/tasks/publication.js';
import '../../../fixtures/scripted-driver.mjs';

const review = { summary: 'Reviewed the initial commit.', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' };
const issue = { number: 1, state: 'open', title: 'First issue', body: 'Please review this project.', user: { id: 5, login: 'author' } };
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + Math.random().toString(16).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const results = messages => messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
const hex = n => String(n).repeat(48);

/** A maintainer's comment on the Issue, as GitHub delivers it; it joins the running review as an update. */
function comment(h, id, body) {
  assert.equal(queueWebhook(h.store, '101', 'issue_comment', { action: 'created', issue, sender: { login: 'maintainer', id: 7, type: 'User' },
    comment: { id, body, author_association: 'MEMBER', html_url: `https://github.invalid/issues/1#issuecomment-${id}`, user: { login: 'maintainer' } } }, 'comment-' + id), 0);
  return Number(h.store.get("SELECT id FROM review_updates WHERE task_id=? AND json_extract(data,'$.source.id')=?", h.taskId, id).id);
}
const logs = (h, type) => h.store.all('SELECT content FROM task_logs WHERE task_id=? ORDER BY rowid', h.taskId).map(row => JSON.parse(row.content)).filter(value => value.type === type);
const task = h => h.store.get('SELECT * FROM tasks WHERE id=?', h.taskId);

/**
 * The engine, ticked by the test only: a finished review's next round is queued, and the test reads it before it runs.
 */
function driven(h) {
  const tick = h.engine.tick.bind(h.engine); h.engine.tick = () => {};
  return async () => { h.store.run('UPDATE tasks SET next_run_at=0 WHERE id=?', h.taskId); tick(); await Promise.all(h.engine.active.values()); return task(h); };
}

test('PR #1094: a Manager-controlled review publishes after an attempt bump reuses its result; later comments start the next round', async t => {
  let h, qa = 0;
  const managerPrompts = [], delegations = [], polls = new Map(), updates = {};
  h = await emptyRepositoryFixture(t, {
    // The first QA run ends without a verdict, as in production; a comment arrives during each QA run.
    async evaluate(store, row) {
      qa++;
      if (qa === 1) { updates.w = comment(h, 302, 'Please also check the README while QA runs.'); throw new TaskError('role_submission_required', 'retry_wait', 'QA ended without submitting a verdict.'); }
      updates.v = comment(h, 303, 'One more thing, during the second QA run.');
      return acceptanceFixture(store, row);
    },
    // The Manager (Native): it delegates Dev once, then nominates the latest Dev result it is told about.
    github(path, send, _res, body) {
      if (path !== '/v1/chat/completions' || !body.tools?.some(tool => tool.function.name === 'nominate_delivery')) return false;
      // A later run continues the Manager's conversation: its prompt is the latest user message.
      const latest = body.messages.filter(message => message.role === 'user').at(-1).content, prompt = JSON.parse(latest);
      if (!managerPrompts.some(seen => seen.raw === latest)) managerPrompts.push({ raw: latest, ...prompt });
      const delegated = results(body.messages).find(result => result.result_ref);
      if (delegated) delegations.push(delegated);
      const ref = delegated?.result_ref ?? prompt.review_updates?.result_ref;
      send({ choices: [{ message: ref ? call('nominate_delivery', { result_ref: ref }) : call('delegate_role', { role: 'dev', purpose: 'Review the Issue', refs: ['task:' + h.taskId] }) }] });
      return true;
    },
    // Dev's Pi session on the project computer: it starts, takes the maintainer's comment at its next turn, and finishes.
    execute(request) {
      const id = request.workspace_id;
      if (request.type === 'workspace_agent_runtime') return { ok: true, result: { agent: 'pi', package: '@earendil-works/pi-coding-agent', version: harnesses.find(h => h.id === 'pi').version, node: process.version } };
      if (request.type === 'workspace_agent_start') { polls.set(id, 0); return { ok: true, result: { started: true } }; }
      if (request.type === 'workspace_agent_boundary') return { ok: true, result: {} };
      if (request.type !== 'workspace_agent_poll') return undefined;
      if (!polls.has(id)) return { ok: true, result: { state: 'missing' } };
      const n = polls.get(id) + 1; polls.set(id, n);
      if (n === 1) return { ok: true, result: { state: 'running', boundary: { id: hex(1), stage: 'start' } } };
      if (n === 2) { updates.u = comment(h, 301, 'Is the error path covered?'); return { ok: true, result: { state: 'running', boundary: { id: hex(2), stage: 'turn' } } }; }
      return { ok: true, result: { state: 'completed', result: review } };
    },
  });
  h.setBranch('ready');
  // The project runs reviews under its Manager (Native), with the review entry's Dev on Pi.
  const admin = { id: 'admin', role: 'project_admin', repositories: ['101'] }, url = new URL('http://local/api/repositories/101/roles');
  const roles = ['test', 'reviewer', 'ux', 'qa', 'manager'].map(role_id => ({ role_id, harness_ref: { id: 'scripted' } }));
  roleApi(h.store, admin, 'PUT', url, { expected_revision: roleApi(h.store, admin, 'GET', url, {}).revision, enabled: true, controller: { entries: { review: true } },
    roles: [...roles, { role_id: 'dev', harness_ref: { id: 'pi' } }] });
  h.store.run('DELETE FROM task_execution_configs WHERE task_id=?', h.taskId); captureTaskConfiguration(h.store, h.taskId);
  const run = driven(h);

  // Attempt 1: Dev's session took comment U at a turn; QA ended without a verdict, so the next attempt starts.
  let current = await run();
  assert.equal(qa, 1); assert.deepEqual([current.phase, current.attempt, current.error_code], ['prepare', 2, 'role_submission_required']);
  const devResult = h.store.get("SELECT id,data FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev'", h.taskId);
  assert.equal(JSON.parse(devResult.data).result.updates_through, updates.u, 'the Dev result covers the comment its session was given');
  // The attempt bump keeps the cursor: U is not pending again (it was reset to the round's start before #1100).
  assert.equal(current.review_update_cursor, updates.u);
  // The Dev run the Manager delegated came back with the facts of its result: nothing after it yet.
  assert.deepEqual([delegations[0].review_updates.covered_through, delegations[0].review_updates.uncovered], [updates.u, []]);

  // Attempt 2: the Manager reuses the Dev result and is told of W, which came after it, and that the platform publishes anyway.
  current = await run();
  assert.equal(managerPrompts.length, 2, 'the Manager ran once in each attempt');
  const told = managerPrompts.at(-1).review_updates;
  assert.equal(told.result_ref, 'task_history:' + devResult.id); assert.equal(told.covered_through, updates.u);
  assert.deepEqual(told.uncovered.map(({ id, reason, push, actor, url, excerpt }) => ({ id, reason, push, actor, url, excerpt })),
    [{ id: updates.w, reason: 'comment', push: false, actor: 'maintainer', url: 'https://github.invalid/issues/1#issuecomment-302', excerpt: 'Please also check the README while QA runs.' }]);
  assert.ok(told.uncovered[0].at); assert.match(told.instruction, /Unless you act, the platform publishes/);
  // Dev was not run again, QA passed and the review was published: no loop back to the model.
  assert.equal(h.operations.filter(type => type === 'workspace_agent_start').length, 1);
  assert.equal(qa, 2); assert.equal(h.comments.length, 1); assert.match(h.comments[0].body, /Reviewed the initial commit\./);
  assert.ok(!h.store.get("SELECT 1 FROM task_logs WHERE task_id=? AND json_extract(content,'$.code')='manager_deferred'", h.taskId));
  // The decision is on the timeline and in the publication facts: published, W and V (which came during QA) carried.
  const [decision] = logs(h, 'publication_decision');
  assert.deepEqual([decision.decision, decision.covered_through, decision.carried], ['publish', updates.u, [updates.w, updates.v]]);
  assert.match(decision.detail, new RegExp(`更新 ${updates.w}、${updates.v} .*下一轮`));
  const fact = JSON.parse(h.store.get("SELECT data FROM task_history WHERE task_id=? AND type='publication_state' AND json_extract(data,'$.event')='review_publication'", h.taskId).data);
  assert.deepEqual([fact.covered_through, fact.carried], [updates.u, [updates.w, updates.v]]);
  // The unified decision history and publication context expose publish and next_round; attempts still only publication_state.
  const decisions = h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='publication_decision' ORDER BY id", h.taskId).map(row => JSON.parse(row.data));
  assert.deepEqual(decisions.map(value => [value.decision, value.covered_through, value.carried, value.carried_updates]), [
    ['publish', updates.u, [updates.w, updates.v], 2], ['next_round', updates.u, [updates.w, updates.v], 2]]);
  const context = await publicationContext(h.store, task(h));
  assert.deepEqual(context.decisions.map(value => value.decision), ['publish', 'next_round']);
  assert.equal(context.latest_decision.decision, 'next_round');
  assert.ok(context.attempts.every(value => value.event !== 'publish'));
  // W and V start the next round: V, the latest, is its trigger, W is merged; U, which the published result answered, is not.
  const input = JSON.parse(current.input);
  assert.deepEqual([current.status, current.phase, current.attempt, input.round], ['queued', 'prepare', 3, 2]);
  assert.equal(input.trigger.source.id, 303); assert.deepEqual(input.merged_updates.map(update => update.source?.id), [302]);
  assert.equal(current.review_update_cursor, updates.v);
  assert.deepEqual(logs(h, 'continued').map(log => log.updates), [2]);
});

test('a single-session review publishes even when a comment comes while it publishes; the comment starts its next round', async t => {
  let h, started = false, polls = 0;
  const updates = {};
  h = await emptyRepositoryFixture(t, {
    github(path, send) {
      if (!path.endsWith('/issues/1')) return false;
      // The comment comes after QA, while the review is about to make its first GitHub write.
      const current = task(h);
      if (current.phase === 'publish' && !current.publication_started && !updates.w) updates.w = comment(h, 402, 'A question while it publishes.');
      send({ ...issue, html_url: 'https://github.invalid/issues/1' }); return true;
    },
    // The task's own Pi session (no Manager): it takes U at a turn and finishes.
    execute(request) {
      if (request.type === 'workspace_agent_start') { started = true; return { ok: true, result: { started: true } }; }
      if (request.type === 'workspace_agent_boundary') return { ok: true, result: {} };
      if (request.type !== 'workspace_agent_poll' || !started) return undefined;
      polls++;
      if (polls === 1) return { ok: true, result: { state: 'running', boundary: { id: hex(1), stage: 'start' } } };
      if (polls === 2) { updates.u = comment(h, 401, 'Is the error path covered?'); return { ok: true, result: { state: 'running', boundary: { id: hex(2), stage: 'turn' } } }; }
      return { ok: true, result: { state: 'completed', result: review } };
    },
  });
  h.setBranch('ready');
  const current = await driven(h)();
  assert.equal(h.comments.length, 1, 'the review was published');
  assert.equal(h.operations.filter(type => type === 'workspace_agent_start').length, 1);
  assert.ok(!h.operations.includes('workspace_agent_continue'), 'the session is not resumed to answer the comment first');
  // The session took U, so the result covers it; W came after and is carried.
  const [decision] = logs(h, 'publication_decision');
  assert.deepEqual([decision.covered_through, decision.carried], [updates.u, [updates.w]]);
  const decisions = h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='publication_decision' ORDER BY id", h.taskId).map(row => JSON.parse(row.data));
  assert.deepEqual(decisions.map(value => [value.decision, value.covered_through, value.carried]), [
    ['publish', updates.u, [updates.w]], ['next_round', updates.u, [updates.w]]]);
  const input = JSON.parse(current.input);
  assert.deepEqual([current.status, input.round, input.trigger.source.id, current.review_update_cursor], ['queued', 2, 402, updates.w]);
  // The timeline: the session took U, the publication carried W, and the next round took W.
  const timeline = h.store.all('SELECT content FROM task_logs WHERE task_id=? ORDER BY rowid', h.taskId).map(row => JSON.parse(row.content))
    .filter(value => ['review_update', 'publication_decision', 'published', 'continued'].includes(value.type)).map(value => value.type === 'review_update' ? JSON.parse(value.detail).source.id : value.type);
  assert.deepEqual(timeline, [401, 'publication_decision', 'published', 'continued', 402]);
});

test('a review Manager can defer publication; the defer decision is on the task timeline and in read_publication_context', async t => {
  let h;
  const prompts = [];
  h = await emptyRepositoryFixture(t, {
    // The Manager (Native) explicitly defers instead of nominating a delivery.
    github(path, send, _res, body) {
      if (path !== '/v1/chat/completions' || !body.tools?.some(tool => tool.function.name === 'finish_coordination')) return false;
      const latest = body.messages.filter(message => message.role === 'user').at(-1).content;
      prompts.push(JSON.parse(latest));
      send({ choices: [{ message: call('finish_coordination', { action: 'wait', reason: 'Wait for a design answer before publishing', resume_condition: 'The design question is answered', delay_seconds: 30 }) }] });
      return true;
    },
  });
  h.setBranch('ready');
  const admin = { id: 'admin', role: 'project_admin', repositories: ['101'] }, url = new URL('http://local/api/repositories/101/roles');
  const roles = ['test', 'reviewer', 'ux', 'qa', 'manager'].map(role_id => ({ role_id, harness_ref: { id: 'scripted' } }));
  roleApi(h.store, admin, 'PUT', url, { expected_revision: roleApi(h.store, admin, 'GET', url, {}).revision, enabled: true, controller: { entries: { review: true } },
    roles: [...roles, { role_id: 'dev', harness_ref: { id: 'pi' } }] });
  h.store.run('DELETE FROM task_execution_configs WHERE task_id=?', h.taskId); captureTaskConfiguration(h.store, h.taskId);
  const current = await driven(h)();
  assert.equal(prompts.length, 1);
  assert.deepEqual([current.status, current.error_code], ['retry_wait', 'manager_deferred']);
  const decisions = h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='publication_decision' ORDER BY id", h.taskId).map(row => JSON.parse(row.data));
  assert.deepEqual(decisions.map(value => [value.decision, value.manager_action, value.reason, value.covered_through]), [
    ['defer', 'wait', 'Wait for a design answer before publishing', 0]]);
  const context = await publicationContext(h.store, task(h));
  assert.deepEqual(context.attempts, []);
  assert.equal(context.latest_decision.decision, 'defer');
  assert.equal(context.latest_decision.manager_action, 'wait');
});

test('a review Manager on a Harness backend that ends a turn without nominating records one defer', async t => {
  let h;
  h = await emptyRepositoryFixture(t, {
    // The Manager runs on Pi in the project computer; its session ends the turn with prose, not a delivery nomination.
    execute(request) {
      if (request.type === 'workspace_agent_runtime') return { ok: true, result: { agent: 'pi', package: '@earendil-works/pi-coding-agent', version: harnesses.find(h => h.id === 'pi').version, node: process.version } };
      if (request.type === 'workspace_agent_start') return { ok: true, result: { started: true } };
      if (request.type === 'workspace_agent_boundary') return { ok: true, result: {} };
      if (request.type !== 'workspace_agent_poll') return undefined;
      return { ok: true, result: { state: 'completed', result: { harness_turn: true, text: 'Waiting for the design answer before publishing.', session_id: 'manager-session' } } };
    },
  });
  h.setBranch('ready');
  const admin = { id: 'admin', role: 'project_admin', repositories: ['101'] }, url = new URL('http://local/api/repositories/101/roles');
  const roles = ['test', 'reviewer', 'ux', 'qa'].map(role_id => ({ role_id, harness_ref: { id: 'scripted' } }));
  roleApi(h.store, admin, 'PUT', url, { expected_revision: roleApi(h.store, admin, 'GET', url, {}).revision, enabled: true, controller: { entries: { review: true } },
    roles: [...roles, { role_id: 'manager', harness_ref: { id: 'pi' } }, { role_id: 'dev', harness_ref: { id: 'pi' } }] });
  h.store.run('DELETE FROM task_execution_configs WHERE task_id=?', h.taskId); captureTaskConfiguration(h.store, h.taskId);
  const current = await driven(h)();
  assert.deepEqual([current.status, current.error_code], ['retry_wait', 'manager_deferred']);
  // Both the finish_coordination and the turn-end path reach the same disposition handling: exactly one defer, no attempt.
  const decisions = h.store.all("SELECT data FROM task_history WHERE task_id=? AND type='publication_decision' ORDER BY id", h.taskId).map(row => JSON.parse(row.data));
  assert.deepEqual(decisions.map(value => [value.decision, value.manager_action, value.reason]),
    [['defer', 'continue', 'Waiting for the design answer before publishing.']]);
  assert.ok(h.store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='manager_observation'", h.taskId), 'the turn is still recorded as an observation');
  const context = await publicationContext(h.store, task(h));
  assert.deepEqual(context.attempts, []);
  assert.equal(context.latest_decision.manager_action, 'continue');
});
