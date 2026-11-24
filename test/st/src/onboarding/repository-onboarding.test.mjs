// Repository onboarding unified into the management assistant (#930, #1133): retired standalone onboarding routes answer
// 410, and an administrator with zero started projects analyzes unstarted installed repositories directly in a standard
// management assistant conversation (read-only GitHub inspection, personal assistant computer, and no writes before start).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityFixture } from '../../../fixtures/identity-fixture.mjs';
import { assistantManager } from '../../../fixtures/assistant-computer-fixture.mjs';
import { settled } from '../../../fixtures/management-fixture.mjs';
import { until } from '../../../fixtures/channel-fixture.mjs';
import { installed, readToken, repositoryRoutes, provider as scripted, call, person, say, assistantModel } from '../../../fixtures/onboarding-fixture.mjs';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { invalidate } from '../../../../dist/identity/authorization.js';
import { ownerId } from '../../../../dist/service-roles/assistant-computers.js';
import { onboardingInstructions } from '../../../../dist/management/onboarding.js';
import { onboardingItems } from '../../../../dist/management/onboarding-apply.js';
import { developedLabel, developingIssueLabel } from '../../../../dist/review/labels.js';
import { readResource } from '../../../../dist/agent/exploration.js';

test('standalone onboarding endpoints and legacy onboarding conversations return 410 repository_onboarding_merged (#1133)', async t => {
  const f = await identityFixture(t, { github: true }), { h, state } = f;
  installed(f, '103'); state.accessible = ['103'];
  const repoAdmin = await person(f, 42, 'admin');

  for (const [path, method] of [
    ['/api/management/onboarding/103', 'GET'],
    ['/api/management/onboarding/103', 'POST'],
    ['/api/management/onboarding/103/confirm', 'POST'],
    ['/api/management/onboarding/103/close', 'POST'],
    ['/api/management/onboarding/103/request/withdraw', 'POST'],
    ['/api/management/onboarding/103/items/labels/retry', 'POST'],
  ]) {
    const res = await repoAdmin(path, method, method === 'POST' ? {} : undefined);
    assert.deepEqual([res.status, res.value.error], [410, 'repository_onboarding_merged'], `${method} ${path}`);
  }

  assert.deepEqual(
    [(await repoAdmin('/api/management/conversations', 'POST', { scope: 'onboarding:103' })).status,
     (await repoAdmin('/api/management/conversations', 'POST', { scope: 'onboarding:103' })).value.error],
    [400, 'onboarding_scope_reserved'],
  );

  // Legacy onboarding conversations remain invisible in the list and answer 410 when read or addressed.
  const legacyId = 'deadbeef00001133';
  h.store.run("INSERT INTO management_conversations(id,principal_id,tenant_id,scope,created_at) VALUES(?,?,'github.com:10','onboarding:103',?)",
    legacyId, repoAdmin.principal, new Date().toISOString());
  assert.ok(!(await repoAdmin('/api/management/conversations')).value.conversations.some(row => row.id === legacyId));
  assert.deepEqual([(await repoAdmin(`/api/management/conversations/${legacyId}/events`)).status, (await repoAdmin(`/api/management/conversations/${legacyId}/events`)).value.error],
    [410, 'repository_onboarding_merged']);
  assert.deepEqual([(await repoAdmin(`/api/management/conversations/${legacyId}/messages`, 'POST', { source_message: 'm1', content: 'hello' })).status,
    (await repoAdmin(`/api/management/conversations/${legacyId}/messages`, 'POST', { source_message: 'm1', content: 'hello' })).value.error],
    [410, 'repository_onboarding_merged']);
});

test('an administrator with zero started projects analyzes an unstarted repository in the management assistant; reads only and blocks writes (#930, #1133)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f;
  installed(f, '103');
  // Neither person has access to started project 101: only unstarted installed repository 103 is in their GitHub list.
  state.accessible = ['103'];
  repositoryRoutes(f);
  const model = await scripted(t, context => {
    const text = String(context.request?.content ?? context.request ?? '');
    if (text.includes('尝试写入标签')) {
      return [
        call(0, ['github_write', { repository: 'fixture/project-103', method: 'POST', path: '/labels', key: 'unstarted-label', body: { name: 'kind/bug', color: 'd73a4a' } }]),
        { role: 'assistant', content: '仓库尚未启动，不能写入标签。' },
      ];
    }
    return [
      call(0, ['management_query', { operation: 'list_projects', target: {}, arguments: {} }],
        ['github_read', { repository: 'fixture/project-103', path: '/readme' }],
        ['github_read', { repository: 'fixture/project-103', path: '/labels' }]),
      { role: 'assistant', content: '这是一个 Node.js 命令行工具（来源：README.md、/labels），确认后再为你启动。' },
    ];
  });
  const repoAdmin = await person(f, 42, 'admin'), writer = await person(f, 43, 'write');

  // A Write collaborator on an unstarted repository has neither started projects nor pending repositories to administer.
  assert.equal((await writer('/api/management/conversations', 'POST', { scope: 'tenant:github.com:10' })).status, 403);
  const writerConv = (await writer('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const writerTurn = await say(writer, writerConv, '请分析 fixture/project-103');
  assert.match(writerTurn.history.events.find(e => e.type === 'reply').data.text, /没有可访问的项目|还没有你有权查看的项目/);
  assert.equal(model.requests.length, 0);

  // The repository administrator opens both platform and tenant conversations even with zero started projects.
  const tenantConv = await repoAdmin('/api/management/conversations', 'POST', { scope: 'tenant:github.com:10' });
  assert.equal(tenantConv.status, 201, JSON.stringify(tenantConv.value));
  const conversation = (await repoAdmin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;

  // Without a shared model configured on management-assistant, the turn reports the service role configuration notice.
  const unconfigured = await say(repoAdmin, conversation, '请分析 fixture/project-103');
  assert.ok(unconfigured.history.events.some(e => e.type === 'error' && e.data.error === 'service_role_model_not_configured' && /共享模型/.test(e.data.notice)));

  await assistantModel(f, model);

  // Direct management query also returns pending_repositories alongside empty started projects.
  const queryRes = await repoAdmin(`/api/management/conversations/${conversation}/messages`, 'POST',
    { source_message: 'direct-list', query: { operation: 'list_projects', target: {}, arguments: {} } });
  assert.equal(queryRes.status, 201);
  const directHistory = await settled(repoAdmin, conversation, queryRes.value.id);
  const directProjects = directHistory.events.find(e => e.message_id === queryRes.value.id && e.type === 'tool_result').data.result;
  assert.deepEqual(directProjects.pending_repositories.map(r => r.id), ['103']);

  const before = state.requests.length;
  const first = await say(repoAdmin, conversation, '请分析 fixture/project-103');
  assert.equal(first.history.events.at(-1).data.state, 'completed', JSON.stringify(first.history.events.at(-1)));

  const request = model.requests.at(-1);
  const toolNames = request.tools.map(tool => tool.function.name);
  for (const expected of ['management_query', 'management_command', 'github_read', 'github_search', 'read_job_log', 'github_write', 'start_repository', 'send_message', 'start_own_task'])
    assert.ok(toolNames.includes(expected), `missing tool ${expected}`);
  for (const retired of ['ask_onboarding_questions', 'propose_onboarding_plan'])
    assert.ok(!toolNames.includes(retired), `unexpected retired tool ${retired}`);
  assert.match(request.messages[0].content, /# Repository onboarding/);
  assert.doesNotMatch(request.messages[0].content, /\.bot\b/);

  const listResult = first.history.events.find(e => e.type === 'tool_result' && e.data.name === 'management_query').data.result;
  assert.deepEqual(listResult.projects, []);
  assert.deepEqual(listResult.pending_repositories, [{ id: '103', full_name: 'fixture/project-103', started: false, self_start: false, tenant_id: 'github.com:10' }]);

  const reads = first.history.events.filter(e => e.type === 'tool_result' && e.data.name === 'github_read').map(e => e.data.result);
  assert.match(reads[0].result.content, /command line tool/);
  assert.deepEqual(reads[1].result.map(label => label.name), ['bug']);

  // One read-only token for repository 103 alone, revoked when the turn ended, and redacted everywhere.
  const github = state.requests.slice(before);
  const minted = github.filter(r => r.path === '/app/installations/77/access_tokens');
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0].body, { repository_ids: [103], permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' } });
  assert.deepEqual(github.filter(r => r.method !== 'GET').map(r => [r.method, r.path]), [['POST', '/app/installations/77/access_tokens'], ['DELETE', '/installation/token']]);
  assert.equal(github.find(r => r.method === 'DELETE').authorization, 'Bearer ' + readToken);
  assert.ok(!JSON.stringify(model.requests).includes(readToken));
  assert.ok(!JSON.stringify(h.store.all('SELECT data FROM management_events')).includes(readToken));

  // github_write is blocked on an unstarted repository without minting any write token.
  const beforeWrite = state.requests.length;
  const writeAttempt = await say(repoAdmin, conversation, '尝试写入标签');
  const writeResult = writeAttempt.history.events.find(e => e.type === 'tool_result' && e.data.name === 'github_write').data.result;
  assert.equal(writeResult.result.error, 'project_not_started');
  assert.deepEqual(state.requests.slice(beforeWrite).filter(r => r.path.includes('/labels') && r.method === 'POST'), []);

  // Still unstarted, usage billed to management-assistant.
  assert.equal(h.store.get("SELECT 1 FROM repositories WHERE id='103'"), undefined);
  const usage = h.store.all('SELECT repository_id,service_role_id FROM model_requests WHERE conversation_id=?', conversation);
  assert.ok(usage.length >= 4 && usage.every(row => row.repository_id === null && row.service_role_id === 'management-assistant'));
});

test('an administrator with zero started projects mounts their personal computer before start and keeps HOME across start (#457, #1133)', async t => {
  const assistant = await assistantManager(t);
  const manager = { call: (method, path, input, timeout) => path.startsWith('/v1/assistant-computers') ? assistant.manager.call(method, path, input, timeout)
    : Promise.resolve(method === 'GET' ? { generation: 1, state: 'ready' } : { ok: true, result: {} }) };
  let channels;
  const f = await identityFixture(t, { github: true, onChannels: s => { channels = s; }, extra: store => ({ engine: new TaskEngine(store, manager), assistantHomes: assistant.homes }) });
  const { h, admin, state } = f;
  const service = channels.management.service.assistants;
  await until(() => service.reconciled);
  await service.close();

  installed(f, '103');
  state.accessible = ['103'];
  repositoryRoutes(f);

  const model = await scripted(t, context => {
    const text = String(context.request?.content ?? context.request ?? '');
    if (text.includes('读取笔记')) {
      return [call(0, ['read_file', { path: '~/onboarding-note.txt' }]), { role: 'assistant', content: '已读取。' }];
    }
    return [
      call(0, ['write_file', { path: '~/onboarding-note.txt', content: 'draft for 103' }]),
      call(1, ['run_command', { command: 'cat ~/onboarding-note.txt' }]),
      { role: 'assistant', content: '已写入个人电脑。' },
    ];
  });
  await assistantModel(f, model);

  const repoAdmin = await person(f, 42, 'admin');
  const owner = ownerId({ kind: 'person', subject: repoAdmin.principal, tenant: '' });
  const conversation = (await repoAdmin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;

  const first = await say(repoAdmin, conversation, '把分析草稿记到个人电脑');
  assert.equal(first.history.events.at(-1).data.state, 'completed', JSON.stringify(first.history.events.at(-1)));
  const cmdResult = first.history.events.find(e => e.type === 'tool_result' && e.data.name === 'run_command').data.result;
  assert.equal(cmdResult.output, 'draft for 103');
  assert.equal(readFileSync(join(assistant.homes, owner, 'home-1', 'onboarding-note.txt'), 'utf8'), 'draft for 103');

  // Starting repository 103 keeps the exact same repository set ['103']: HOME generation stays 1 and nothing is sealed.
  assert.equal((await admin('/api/installations/103/activate', 'POST', {})).status, 201);
  const second = await say(repoAdmin, conversation, '读取笔记');
  const readResult = second.history.events.find(e => e.message_id === second.id && e.type === 'tool_result' && e.data.name === 'read_file').data.result;
  assert.equal(readResult.content, 'draft for 103');
  assert.equal(h.store.get('SELECT generation FROM assistant_homes WHERE owner=?', owner).generation, 1);
  assert.deepEqual(h.store.all('SELECT * FROM assistant_home_sealed WHERE owner=?', owner), []);

  // Losing repository 103 revokes authority: sweep removes the idle computer immediately.
  h.store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=?", Date.now(), repoAdmin.principal);
  invalidate(h.store, repoAdmin.principal, 'test_revoked');
  await service.sweep();
  await Promise.all([...assistant.computers.removing.values()]);
  assert.ok(!assistant.computers.leases.has(owner));
});

test('onboarding prompt and label helpers preserve development status labels (#1047) and scheduled dispatch guidance (#1072, #1133)', () => {
  assert.deepEqual(developingIssueLabel('bot-developing'), {
    name: 'bot-developing',
    color: 'fbca04',
    description: 'The bot is developing this Issue; removed when its pull request is opened or it stops',
  });
  assert.equal(developingIssueLabel(''), null);
  assert.equal(developingIssueLabel('BOT-DEVELOPED'), null);
  assert.deepEqual(developedLabel, {
    name: 'bot-developed',
    color: '0e8a16',
    description: 'The bot opened a pull request for this Issue',
  });
  assert.match(onboardingInstructions, /bot-developing/);
  assert.match(onboardingInstructions, /bot-developed/);
  assert.match(onboardingInstructions, /on\.schedule/);
  assert.match(onboardingInstructions, /AGENTS\.md/);
  assert.match(onboardingInstructions, /CONTRIBUTING\.md/);
  assert.match(onboardingInstructions, /\.github\/ISSUE_TEMPLATE\//);
  assert.match(onboardingInstructions, /\.github\/CODEOWNERS/);
  assert.doesNotMatch(onboardingInstructions, /configuration\.pr/);
  assert.match(onboardingInstructions, /task\.create/);
  assert.match(onboardingInstructions, /reviewable_pull_request/);
  assert.match(onboardingInstructions, /\.agents\/skills\//);
  assert.doesNotMatch(onboardingInstructions, /\.bot\b/);
  assert.equal(readResource('/rules/branches/main'), 'contents');
  assert.ok(!onboardingItems.includes('scheduled_dispatch'));
});
