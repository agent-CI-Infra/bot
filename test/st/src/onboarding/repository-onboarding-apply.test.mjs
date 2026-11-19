// Applying confirmed repository onboarding in standard management assistant conversations (#932, #931, #1133):
// trusted-organization and super-administrator immediate starts, same-turn configuration through standard management
// commands and github_write, delegated schedule service principal creation via actor_id "auto", and staged console
// confirmation for task.create with workflow_changes: true.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture } from '../../../fixtures/identity-fixture.mjs';
import { settled } from '../../../fixtures/management-fixture.mjs';
import { installed, repositoryRoutes, provider, call, person, say, assistantModel } from '../../../fixtures/onboarding-fixture.mjs';
import { testPassword } from '../../../fixtures/helpers.mjs';
import { dispatchPrompt } from '../../../../dist/dispatch/manager.js';
import { managerPrompt } from '../../../../dist/dispatch/settings.js';
import { roleConfiguration } from '../../../../dist/roles/definition.js';
import { projectCeiling } from '../../../../dist/projects/ceiling.js';
import { defaultLimits } from '../../../../dist/schedules/types.js';

const roleKeys = ['role_id', 'enabled', 'name', 'responsibility', 'persona_prompt', 'model_profile_ref', 'skill_bundle_ref', 'harness_ref', 'permissions', 'environment_profile_ref', 'budget_policy_ref', 'output_schema_ref'];
const toolResults = body => body.messages.filter(m => m.role === 'tool').map(m => ({ id: m.tool_call_id, value: JSON.parse(m.content) }));

test('a trusted organization administrator starts an unstarted repository and applies policy, conventions, labels and schedules in one conversation (#932, #1133)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f;
  installed(f, '103');
  state.accessible = ['103'];
  const github = repositoryRoutes(f, [{ name: 'bug', color: 'd73a4a' }]);

  const model = await provider(t, (_context, body) => {
    const steps = body.messages.filter(m => m.role === 'assistant').length;
    const obs = toolResults(body).map(o => o.value);
    if (steps === 0) return [call(0, ['start_repository', { action: 'start', repository: 'fixture/project-103', capability_ceiling: 'develop', summary: 'Node.js CLI tool' }])];
    if (steps === 1) return [call(1, ['management_query', { operation: 'get_effective_config', target: { project_id: '103' }, arguments: {} }])];
    if (steps === 2) {
      const cfg = obs.at(-1);
      return [call(2,
        ['management_command', { operation: 'project.update', target: { project_id: '103' }, expected_revision: cfg.revision,
          arguments: { test_command: 'npm test', review_language: 'zh' } }])];
    }
    if (steps === 3) {
      const afterPolicy = obs.at(-1).after_revision;
      const cfg = obs[1];
      const conventionBlock = '## 本仓库约定\n\n- kind/ 前缀表示问题类型。\n- 只改一个文件的拼写问题算简单问题。';
      return [call(3,
        ['management_command', { operation: 'manager.update', target: { project_id: '103' }, expected_revision: afterPolicy,
          arguments: { expected_revision: cfg.manager.prompt.revision, events: { 'actions.run_failed': true, 'issue.labels': ['kind/bug'] },
            prompt: conventionBlock } }])];
    }
    if (steps === 4) {
      const afterManager = obs.at(-1).after_revision;
      const cfg = obs[1];
      const working = roleConfiguration(h.store, '103').roles.filter(r => r.enabled && r.role_id !== 'coordinator');
      return [call(4,
        ['management_command', { operation: 'roles.update', target: { project_id: '103' }, expected_revision: afterManager,
          arguments: { expected_revision: cfg.roles.configuration.revision,
            roles: working.map(r => ({ ...Object.fromEntries(roleKeys.filter(k => k in r).map(k => [k, r[k]])),
              persona_prompt: r.persona_prompt + '\n\n## 本仓库约定\n\n只改一个文件算简单问题。' })) } }],
        ['github_write', { repository: 'fixture/project-103', method: 'POST', path: '/labels', key: 'lbl-kind-bug', body: { name: 'kind/bug', color: 'd73a4a', description: '缺陷' } }],
        ['github_write', { repository: 'fixture/project-103', method: 'POST', path: '/labels', key: 'lbl-developing', body: { name: 'bot-developing', color: 'fbca04', description: 'Developing' } }],
        ['github_write', { repository: 'fixture/project-103', method: 'POST', path: '/labels', key: 'lbl-developed', body: { name: 'bot-developed', color: '0e8a16', description: 'Developed' } }])];
    }
    if (steps === 5) {
      const rolesReceipt = obs.find(o => o.operation === 'roles.update');
      return [call(5,
        ['management_command', { operation: 'schedule.register', target: { project_id: '103' }, expected_revision: rolesReceipt.after_revision,
          arguments: { plan: { name: '每日巡检', kind: 'project', actor_id: 'auto', owner_id: 'self', maintainer_id: 'self',
            workflow: 'manager.check', parameters: { instruction: '看看昨天失败的 Actions。' }, timezone: 'Asia/Shanghai', cron: '0 9 * * 1-5',
            start_at: Date.now(), enabled: true, misfire: 'skip', grace_ms: 60000, limits: defaultLimits } } }])];
    }
    return [{ role: 'assistant', content: '仓库已启动并完成策略、约定、标签与每日巡检配置（`npm test` 待首次运行验证）。' }];
  });
  await assistantModel(admin, model);

  // Trust organization 10 at comment ceiling; start_repository upgrades ceiling to develop after activation.
  assert.equal((await admin('/api/trusted-organizations/10', 'PUT', { capability_ceiling: 'comment' })).status, 200);
  const repoAdmin = await person(f, 42, 'admin');
  const conversation = (await repoAdmin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;

  const turn = await say(repoAdmin, conversation, '确认按方案启动并配置 fixture/project-103');
  assert.equal(turn.history.events.at(-1).data.state, 'completed', JSON.stringify(turn.history.events.filter(e => e.type !== 'text')));

  const startResult = turn.history.events.find(e => e.type === 'tool_result' && e.data.name === 'start_repository').data.result;
  assert.deepEqual([startResult.state, startResult.by, startResult.capability_ceiling], ['started', 'trusted_organization', 'develop']);

  const policy = h.store.get("SELECT * FROM policies WHERE repository_id='103'");
  assert.deepEqual([projectCeiling(h.store, '103'), policy.test_command, policy.review_language, !!policy.actions_failures_enabled], ['develop', 'npm test', 'zh', true]);
  assert.match(dispatchPrompt(h.store, '103'), /## 本仓库约定[\s\S]*kind\/ 前缀表示问题类型/);
  const roles = roleConfiguration(h.store, '103').roles.filter(r => r.enabled && r.role_id !== 'coordinator');
  assert.ok(roles.length > 1 && roles.every(r => r.persona_prompt.includes('## 本仓库约定')));

  assert.deepEqual(github.created.map(c => c.body.name), ['kind/bug', 'bot-developing', 'bot-developed']);

  const check = h.store.get("SELECT * FROM schedules WHERE project_id='103'"), spec = JSON.parse(check.spec);
  assert.deepEqual([check.kind, check.owner_id, check.maintainer_id, spec.workflow, spec.cron], ['project', repoAdmin.principal, repoAdmin.principal, 'manager.check', '0 9 * * 1-5']);
  assert.equal(h.store.get('SELECT kind FROM principals WHERE id=?', check.actor_id).kind, 'service');
  assert.equal(h.store.get('SELECT source FROM scoped_grants WHERE principal_id=?', check.actor_id).source, 'explicit_delegation');
});

test('a super administrator starts an untrusted-organization repository immediately; non-super-admins cannot pass super-admin flags (#1133)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f;
  installed(f, '104'); state.accessible = ['104']; repositoryRoutes(f);
  const shared = await assistantModel(admin, await provider(t, context => {
    const text = String(context.request?.content ?? context.request ?? '');
    if (text.includes('越权参数')) {
      return [call(0, ['start_repository', { action: 'start', repository: '104', trust_organization: true }]), { role: 'assistant', content: '失败。' }];
    }
    if (text.includes('申请启动')) {
      return [call(0, ['start_repository', { action: 'start', repository: '104', capability_ceiling: 'comment', summary: 'Node.js CLI' }]), { role: 'assistant', content: '已提交申请。' }];
    }
    return [call(0, ['start_repository', { action: 'start', repository: '104', capability_ceiling: 'comment', model_id: shared.id, trust_organization: true }]),
      { role: 'assistant', content: '已由超级管理员直接启动。' }];
  }));

  const repoAdmin = await person(f, 42, 'admin');
  const userConv = (await repoAdmin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const denied = await say(repoAdmin, userConv, '用越权参数启动');
  const deniedResult = denied.history.events.find(e => e.message_id === denied.id && e.type === 'tool_result' && e.data.name === 'start_repository').data.result;
  assert.deepEqual(deniedResult, { state: 'failed', error: 'super_admin_required' });
  assert.equal(h.store.get("SELECT 1 FROM repositories WHERE id='104'"), undefined);

  const requested = await say(repoAdmin, userConv, '申请启动 104');
  assert.equal(requested.history.events.find(e => e.message_id === requested.id && e.type === 'tool_result' && e.data.name === 'start_repository').data.result.state, 'start_requested');
  assert.equal(h.store.get("SELECT state FROM onboarding_requests WHERE repository_id='104'").state, 'pending');

  const adminConv = (await admin('/api/management/conversations', 'POST', { scope: 'platform' })).value.conversation.id;
  const started = await say(admin, adminConv, '启动 104');
  const startedResult = started.history.events.find(e => e.message_id === started.id && e.type === 'tool_result' && e.data.name === 'start_repository').data.result;
  assert.deepEqual([startedResult.state, startedResult.by, startedResult.capability_ceiling, startedResult.model_id], ['started', 'super_admin', 'comment', shared.id]);
  assert.ok(h.store.get("SELECT 1 FROM trusted_organizations WHERE owner_id='10'"));
  assert.deepEqual({ ...h.store.get("SELECT state,reason FROM onboarding_requests WHERE repository_id='104'") }, { state: 'lapsed', reason: 'project_started' });
});

test('workflow_changes task.create stages a console confirmation card for the model and executes only when confirmed by a project administrator in the console (#931, #1133)', async t => {
  const f = await identityFixture(t, { github: true }), { h, admin, state } = f;
  state.accessible = ['101']; repositoryRoutes(f);
  h.store.run("UPDATE policies SET capability_ceiling='develop',development_enabled=1 WHERE repository_id='101'");

  const ciContract = { goal: 'Add npm test PR workflow', scope: ['.github/workflows/ci.yml'], criteria: ['Runs npm test on pull_request'], endpoint: 'reviewable_pull_request' };
  const model = await provider(t, (_context, body) => {
    const steps = body.messages.filter(m => m.role === 'assistant').length;
    if (steps === 0) return [call(0, ['management_query', { operation: 'get_effective_config', target: { project_id: '101' }, arguments: {} }])];
    if (steps === 1) {
      const cfg = toolResults(body).at(-1).value;
      return [call(1, ['management_command', { operation: 'task.create', target: { project_id: '101' }, expected_revision: cfg.revision,
        arguments: { intent: 'development', workflow_changes: true, request: 'Add CI workflow running npm test', contract: ciContract } }])];
    }
    return [{ role: 'assistant', content: '已生成工作流变更确认卡片，请在控制台点击确认执行。' }];
  });
  await assistantModel(admin, model);

  // Project member with tasks.write ONLY (no config.write) cannot even stage workflow_changes: true.
  const memberPassword = testPassword();
  const user = (await admin('/api/users', 'POST', { username: 'task-member', password: memberPassword, repository_ids: [] })).value.user;
  const memberPrincipal = h.store.get('SELECT id FROM principals WHERE user_id=?', user.id).id;
  const tenant = h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  assert.equal((await admin('/api/identity/grants', 'POST', { principal_id: memberPrincipal, tenant_id: tenant, project_id: '101', capabilities: ['tasks.read', 'tasks.write'] })).status, 201);
  const member = h.client();
  await member('/api/auth/login', 'POST', { username: 'task-member', password: memberPassword });
  const memberConv = (await member('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
  const memberTurn = await say(member, memberConv, '帮我提交 CI 变更任务');
  const memberStep = memberTurn.history.events.find(e => e.message_id === memberTurn.id && e.type === 'tool_result' && e.data.name === 'management_command').data.result;
  assert.deepEqual([memberStep.state, memberStep.confirmation_required, memberStep.error], ['failed', false, 'capability_forbidden']);
  assert.equal(h.store.get("SELECT count(*) AS n FROM tasks WHERE repository_id='101'").n, 0);

  // Lowering project ceiling below develop refuses staging too.
  const repoAdmin = await person(f, 42, 'admin');
  const adminConv = (await repoAdmin('/api/management/conversations', 'POST', { scope: 'project:101' })).value.conversation.id;
  h.store.run("UPDATE policies SET capability_ceiling='comment' WHERE repository_id='101'");
  const ceilingTurn = await say(repoAdmin, adminConv, '尝试在 comment 上限下提交 CI 任务');
  const ceilingStep = ceilingTurn.history.events.find(e => e.message_id === ceilingTurn.id && e.type === 'tool_result' && e.data.name === 'management_command').data.result;
  assert.deepEqual([ceilingStep.state, ceilingStep.confirmation_required, ceilingStep.error], ['failed', false, 'capability_ceiling']);

  // Restore develop ceiling: model call stages confirmation_required without creating a task.
  h.store.run("UPDATE policies SET capability_ceiling='develop' WHERE repository_id='101'");
  const stagedTurn = await say(repoAdmin, adminConv, '请创建 CI workflow 变更 PR 任务');
  const staged = stagedTurn.history.events.find(e => e.message_id === stagedTurn.id && e.type === 'tool_result' && e.data.name === 'management_command').data.result;
  assert.equal(staged.confirmation_required, true);
  assert.equal(staged.state, 'confirmation_required');
  assert.equal(staged.preview_command.operation, 'task.create');
  assert.equal(staged.preview_command.arguments.workflow_changes, true);
  assert.equal(h.store.get("SELECT count(*) AS n FROM tasks WHERE repository_id='101'").n, 0, 'task is not created before console confirmation');

  // Member without config.write cannot confirm the preview command either.
  const memberDirect = await member(`/api/management/conversations/${memberConv}/messages`, 'POST', { source_message: 'confirm:bad', command: staged.preview_command });
  assert.equal(memberDirect.status, 201);
  const memberDirectHistory = await settled(member, memberConv, memberDirect.value.id);
  const memberDirectReceipt = memberDirectHistory.events.find(e => e.message_id === memberDirect.value.id && e.type === 'tool_result').data.result;
  assert.equal(memberDirectReceipt.state, 'failed');
  assert.equal(memberDirectReceipt.result.error, 'capability_forbidden');

  // Project administrator confirms the preview command in the console conversation -> creates task with confirmed_by & audit!
  const confirmed = await repoAdmin(`/api/management/conversations/${adminConv}/messages`, 'POST', { source_message: 'confirm:call-1-0', command: staged.preview_command });
  assert.equal(confirmed.status, 201);
  const confirmedHistory = await settled(repoAdmin, adminConv, confirmed.value.id);
  const receipt = confirmedHistory.events.find(e => e.message_id === confirmed.value.id && e.type === 'tool_result').data.result;
  assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
  assert.equal(receipt.source_conversation, 'console:conversation:' + adminConv);

  const task = h.store.get('SELECT * FROM tasks WHERE id=?', receipt.result.id);
  const input = JSON.parse(task.input);
  assert.equal(input.workflow_changes.confirmed_by, repoAdmin.principal);
  assert.deepEqual(input.contract.scope, ['.github/workflows/ci.yml']);
  assert.deepEqual(JSON.parse(h.store.get('SELECT writes FROM task_write_grants WHERE task_id=?', task.id).writes), ['pull_request']);
  assert.equal(h.store.get("SELECT count(*) AS n FROM audit WHERE action='task.workflow_changes' AND resource_id=?", task.id).n, 1);

  // Replaying the same source_message returns replayed: true and creates no duplicate task.
  const replayed = await repoAdmin(`/api/management/conversations/${adminConv}/messages`, 'POST', { source_message: 'confirm:call-1-0', command: staged.preview_command });
  assert.equal(replayed.value.replayed, true);
  assert.equal(h.store.get("SELECT count(*) AS n FROM tasks WHERE repository_id='101'").n, 1);
});
