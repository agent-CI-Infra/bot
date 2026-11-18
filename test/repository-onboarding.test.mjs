// Repository onboarding, analysis before the start (#930): an administrator of an installed repository talks with the
// management assistant, which only reads that repository, asks questions and saves plan drafts. GitHub and the model
// provider are local fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from './identity-fixture.mjs';
import { settled } from './management-fixture.mjs';
import { installed, readToken, repositoryRoutes, provider as scripted, call, person, say } from './onboarding-fixture.mjs';
import { withDevelopingLabel } from '../dist/management/onboarding.js';

// The assistant reads the README and the labels and asks; a reply about the level gets a plan, first with a reserved label.
const provider = t => scripted(t, context => {
  const repository = context.onboarding?.repository.full_name;
  const plan = labels => ({ profile: { summary: '命令行工具，Node.js。', sources: ['README.md', '/labels'] }, capability_ceiling: { value: 'comment', reason: '先只检视和打标签' },
    events: { value: { 'actions.run_failed': true }, reason: '分析 Actions 失败' }, test_command: { value: 'npm test', reason: 'README 写明' },
    labels: { items: labels, reason: '补齐分类标签' }, conventions: { label_usage: 'kind/ 前缀表示问题类型。' } });
  return String(context.request).includes('先只检视') ? [
    call(0, ['propose_onboarding_plan', plan([{ name: 'agent/triage', color: 'ededed', action: 'create' }])]),
    call(1, ['propose_onboarding_plan', plan([{ name: 'kind/bug', color: 'd73a4a', description: '缺陷', action: 'create' }, { name: 'bug', color: 'd73a4a', action: 'keep' }])]),
    { role: 'assistant', content: '方案草稿已保存。' },
  ] : [
    call(0, ['github_read', { repository, path: '/readme' }], ['github_read', { repository, path: '/labels' }]),
    call(1, ['ask_onboarding_questions', { questions: [{ id: 'level', question: '要不要让 bot 自动开发简单问题？', options: [{ label: '先只检视和打标签' }, { label: '也开发简单问题' }],
      recommended: '先只检视和打标签', reason: '仓库还没有检视习惯' }] }]),
    { role: 'assistant', content: '这是一个命令行工具（来源：README.md、/labels）。请回答上面的问题。' },
  ];
});

test('an administrator analyzes an installed repository before it is started, reading only; drafts are saved and nothing is written (#930)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f, model = await provider(t);
  installed(f, '103'); state.accessible = ['101', '103']; repositoryRoutes(f);
  const repoAdmin = await person(f, 42, 'admin'), writer = await person(f, 43, 'write'), otherAdmin = await person(f, 44, 'admin');

  // A Write collaborator is no administrator: a clear code, and the session is not created.
  for (const [path, method] of [['/api/management/onboarding/103', 'GET'], ['/api/management/onboarding/103', 'POST']])
    assert.deepEqual([(await writer(path, method, method === 'POST' ? {} : undefined)).value.error], ['repository_admin_required']);
  assert.equal((await repoAdmin('/api/management/onboarding/999', 'POST', {})).value.error, 'repository_not_installed');

  // Without a shared model the page says so before anything is sent.
  const empty = await repoAdmin('/api/management/onboarding/103');
  assert.deepEqual([empty.status, empty.value.session, empty.value.repository.started, empty.value.model.available, empty.value.model.error], [200, null, false, false, 'service_role_model_not_configured']);
  assert.match(empty.value.model.notice, /共享模型/);

  const opened = (await repoAdmin('/api/management/onboarding/103', 'POST', {})).value, conversation = opened.session.conversation_id;
  // Another administrator opens the same session, and the generic conversation list and creation leave it alone.
  assert.equal((await otherAdmin('/api/management/onboarding/103', 'POST', {})).value.session.id, opened.session.id);
  assert.ok(!(await repoAdmin('/api/management/conversations')).value.conversations.some(row => row.id === conversation));
  assert.equal((await repoAdmin('/api/management/conversations', 'POST', { scope: 'onboarding:103' })).value.error, 'onboarding_scope_reserved');
  assert.equal((await writer(`/api/management/conversations/${conversation}/events`)).value.error, 'repository_admin_required');

  // The assistant's shared model; the first turn without one failed with the configuration notice.
  const failed = await say(repoAdmin, conversation, '请分析这个仓库');
  assert.ok(failed.history.events.some(e => e.type === 'error' && e.data.error === 'service_role_model_not_configured' && /共享模型/.test(e.data.notice)));
  const shared = (await admin('/api/models', 'POST', { model_name: 'Assistant fixture', api_url: model.url, api_key: 'fixture-provider-key' })).value.model;
  const role = (await admin('/api/service-roles')).value.service_roles.find(r => r.id === 'management-assistant');
  await admin('/api/service-roles/management-assistant', 'PATCH', { expected_revision: role.revision, model_id: shared.id });
  assert.deepEqual((await repoAdmin('/api/management/onboarding/103')).value.model, { available: true, source: 'assistant', name: 'Assistant fixture' });

  const before = state.requests.length, first = await say(repoAdmin, conversation, '请分析这个仓库');
  const request = model.requests.at(-1);
  assert.deepEqual(request.tools.map(tool => tool.function.name), ['read_tool_result', 'github_read', 'github_search', 'read_job_log', 'ask_onboarding_questions', 'propose_onboarding_plan', 'send_message']);
  assert.match(request.messages[0].content, /onboarding of the GitHub repository fixture\/project-103/);
  assert.match(request.messages[0].content, /# Repository onboarding/, 'the prompt of docs/prompts/onboarding.md');
  assert.deepEqual(JSON.parse(request.messages[1].content).onboarding.repository, { id: '103', full_name: 'fixture/project-103', started: false, organization_trusted: false });
  const results = first.history.events.filter(e => e.type === 'tool_result' && e.data.name === 'github_read').map(e => e.data.result);
  assert.match(results[0].result.content, /command line tool/);
  assert.deepEqual(results[1].result.map(label => label.name), ['bug']);
  assert.equal(first.history.events.at(-1).data.state, 'completed');

  // Only reads: one read-only token for repository 103 alone, revoked when the turn ended.
  const github = state.requests.slice(before);
  const minted = github.filter(r => r.path === '/app/installations/77/access_tokens');
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0].body, { repository_ids: [103], permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' } });
  assert.deepEqual(github.filter(r => r.method !== 'GET').map(r => [r.method, r.path]), [['POST', '/app/installations/77/access_tokens'], ['DELETE', '/installation/token']]);
  assert.equal(github.find(r => r.method === 'DELETE').authorization, 'Bearer ' + readToken);
  // The token reaches neither the model provider nor the conversation's events and logs.
  assert.ok(!JSON.stringify(model.requests).includes(readToken));
  assert.ok(!JSON.stringify(h.store.all('SELECT data FROM management_events')).includes(readToken));

  // The questions, with the recommended answer, are part of the session state.
  let view = (await otherAdmin('/api/management/onboarding/103')).value;
  assert.deepEqual(view.questions.questions.map(q => [q.id, q.recommended]), [['level', '先只检视和打标签']]);
  assert.equal(view.plan, null);

  // The answer: a plan with a reserved label goes back to the model with its field, the corrected one is saved.
  const second = await say(otherAdmin, conversation, '先只检视，标签用 kind/ 前缀');
  const plans = second.history.events.filter(e => e.type === 'tool_result' && e.data.name === 'propose_onboarding_plan').map(e => e.data.result);
  assert.deepEqual(plans[0], { error: 'invalid_onboarding_plan', field: 'labels.items.0.name', reason: 'reserved_label' });
  assert.equal(plans[1].saved, true); assert.equal(plans[1].version, 1);
  view = (await repoAdmin('/api/management/onboarding/103')).value;
  assert.deepEqual([view.plan.version, view.plan.plan.capability_ceiling.value, view.plan.plan.labels.items.map(l => l.name)], [1, 'comment', ['kind/bug', 'bug']]);
  // Both people read the whole conversation.
  const history = (await repoAdmin(`/api/management/conversations/${conversation}/events`)).value;
  assert.equal(history.messages.length, 3);

  // Words only, one turn at a time.
  assert.equal((await repoAdmin(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: 'q', query: { operation: 'list_projects', target: {}, arguments: {} } })).value.error, 'onboarding_content_required');
  const gate = Promise.withResolvers(); model.state.gate = gate.promise;
  const running = (await repoAdmin(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: 'busy', content: '请分析这个仓库' })).value;
  assert.equal((await otherAdmin(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: 'busy-2', content: '再看看' })).value.error, 'onboarding_turn_running');
  model.state.gate = null; gate.resolve(); await settled(repoAdmin, conversation, running.id);

  // Still not started, nothing written to GitHub, and the usage is the assistant's, kept with the session.
  assert.equal(h.store.get("SELECT 1 FROM repositories WHERE id='103'"), undefined);
  assert.ok(!state.requests.some(r => r.method !== 'GET' && !['/app/installations/77/access_tokens', '/installation/token', '/login/oauth/access_token'].includes(r.path)));
  const usage = h.store.all('SELECT repository_id,service_role_id FROM model_requests WHERE conversation_id=?', conversation);
  assert.ok(usage.length >= 6 && usage.every(row => row.repository_id === null && row.service_role_id === 'management-assistant'));
  assert.equal((await repoAdmin('/api/management/onboarding/103')).value.usage.requests, usage.length);
  // Starting the project bills that usage to it.
  assert.equal((await admin('/api/installations/103/activate', 'POST', {})).status, 201);
  assert.deepEqual([...new Set(h.store.all('SELECT repository_id FROM model_requests WHERE conversation_id=?', conversation).map(row => row.repository_id))], ['103']);

  // Closing ends the session: no more messages there, and the next open starts another one.
  assert.equal((await repoAdmin('/api/management/onboarding/103/close', 'POST', {})).value.session, null);
  assert.equal((await repoAdmin(`/api/management/conversations/${conversation}/messages`, 'POST', { source_message: 'late', content: '还在吗' })).value.error, 'onboarding_session_closed');
  assert.notEqual((await repoAdmin('/api/management/onboarding/103', 'POST', {})).value.session.id, opened.session.id);
});

test('a started project opens the same onboarding with its settings; the default model of a trusted organization runs it (#930)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f, model = await provider(t);
  installed(f, '103'); state.accessible = ['101', '103']; repositoryRoutes(f);
  const shared = (await admin('/api/models', 'POST', { model_name: 'Assistant fixture', api_url: model.url, api_key: 'fixture-provider-key' })).value.model;
  const organization = (await admin('/api/models', 'POST', { model_name: 'Organization default', api_url: model.url, api_key: 'fixture-provider-key' })).value.model;
  const role = (await admin('/api/service-roles')).value.service_roles.find(r => r.id === 'management-assistant');
  await admin('/api/service-roles/management-assistant', 'PATCH', { expected_revision: role.revision, model_id: shared.id });
  const repoAdmin = await person(f, 42, 'admin');

  // 101 is started: its administrator (config.write) runs it, and the model sees its current settings. The project only
  // carries the usage: the assistant's shared model runs it even while that model is restricted to other projects.
  h.store.run('UPDATE models SET restricted=1 WHERE id=?', shared.id); h.store.run('DELETE FROM model_projects WHERE model_id=?', shared.id);
  const started = (await repoAdmin('/api/management/onboarding/101', 'POST', {})).value;
  assert.equal(started.repository.started, true);
  const checked = await say(repoAdmin, started.session.conversation_id, '请分析这个仓库');
  assert.equal(checked.history.events.at(-1).data.state, 'completed', JSON.stringify(checked.history.events.at(-1)));
  const settings = JSON.parse(model.requests.at(-1).messages[1].content).onboarding.current_settings;
  assert.deepEqual(Object.keys(settings), ['enabled', 'capability_ceiling', 'events', 'test_command', 'review_language']);
  assert.deepEqual([...new Set(h.store.all('SELECT repository_id FROM model_requests WHERE conversation_id=?', started.session.conversation_id).map(row => row.repository_id))], ['101']);

  // A trusted organization with a default model: its repositories' onboarding uses that model.
  assert.equal((await admin('/api/trusted-organizations/10', 'PUT', { model_id: organization.id })).status, 200);
  const pending = (await repoAdmin('/api/management/onboarding/103', 'POST', {})).value;
  assert.deepEqual(pending.model, { available: true, source: 'organization', name: 'Organization default' });
  const turn = await say(repoAdmin, pending.session.conversation_id, '请分析这个仓库');
  assert.equal(turn.history.events.at(-1).data.state, 'completed', JSON.stringify(turn.history.events.at(-1)));
  assert.equal(model.requests.at(-1).model, 'Organization default');
  assert.deepEqual([...new Set(h.store.all('SELECT model_id FROM model_requests WHERE conversation_id=?', pending.session.conversation_id).map(row => row.model_id))], [organization.id]);
  // Without a default model the assistant's own shared model runs it again.
  assert.equal((await admin('/api/trusted-organizations/10', 'PUT', {})).status, 200);
  assert.deepEqual((await repoAdmin('/api/management/onboarding/103')).value.model.source, 'assistant');
});

test('a plan that lets the bot develop also creates the developing label, once, and never for a lower level (#1047)', () => {
  const developing = { name: 'bot-developing', color: 'fbca04', description: 'The bot is developing this Issue; removed when its pull request is opened or it stops', action: 'create' };
  const develop = { profile: { summary: 's', sources: ['README.md'] }, capability_ceiling: { value: 'develop', reason: 'r' } };
  assert.deepEqual(withDevelopingLabel(develop, 'bot-developing').labels, { items: [developing], reason: 'bot 开发 Issue 期间给它加这个标签，开出 PR 或停下时去掉。' });
  const listed = { ...develop, labels: { items: [{ name: 'kind/bug', color: 'd73a4a', action: 'create' }], reason: 'r' } };
  assert.deepEqual(withDevelopingLabel(listed, 'wip').labels.items.map(item => item.name), ['kind/bug', 'wip']);
  const kept = { ...develop, labels: { items: [{ name: 'Bot-Developing', color: '000000', action: 'keep' }], reason: 'r' } };
  assert.equal(withDevelopingLabel(kept, 'bot-developing'), kept);
  const comment = { ...develop, capability_ceiling: { value: 'comment', reason: 'r' } };
  assert.equal(withDevelopingLabel(comment, 'bot-developing'), comment);
  assert.equal(withDevelopingLabel(develop, ''), develop, 'a project that keeps no developing label');
});
