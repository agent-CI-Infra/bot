import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { testPassword } from './helpers.mjs';
import { gatePermissions } from '../dist/projects/gate-onboarding.js';
import { normalizePlan, gateFiles, gateEvents, emptyPlan, PlanError } from '../dist/projects/gate-plan.js';
import { boardLocation } from '../dist/public-board/state.js';
import { GitHub, agentReadPermissions } from '../dist/github/client.js';
import { ReadTokens } from '../dist/agent/read-token.js';
import { Redactor } from '../dist/agent/common.js';
import { releaseWorkflow } from '../dist/releases/workflow.js';
import { loadConsole } from './console-page.mjs';
import { gateFixture as fixture, makefile, answer, writes, branchOf } from './gate-onboarding-fixtures.mjs';

test('the board location helper still names the verified webhook origin and a lowercase path', () => {
  assert.deepEqual(boardLocation('https://bot.example/', 'My-Org/Hello'), { key: 'my-org/hello', url: 'https://bot.example/boards/my-org/hello/' });
});

test('a Python repository without package.json gets a plan from its own files, and nothing is written before confirmation', async t => {
  const { state, open } = await fixture(t);
  const session = await open();
  assert.equal(session.state, 'ready', JSON.stringify(session));
  assert.notEqual(session.error, 'unsupported_stack');
  assert.equal(session.agent.available, false); // Never started: no model, so the plan comes from certain facts only.
  assert.deepEqual(session.facts.languages.map(item => item.name), ['Python', 'Makefile']);
  assert.deepEqual(session.plan.toolchains, { node: '22', python: '3.12', go: '', java: '' });
  // Makefile targets are repository commands; pytest and pip install -e . are uncertain and only asked about.
  assert.deepEqual(session.plan.lanes, { build: ['make build'], 'pr-ready': ['make lint', 'make test'], 'pr-merge': [], daily: [], release: [] });
  assert.deepEqual(session.plan.install, []);
  assert.ok(session.facts.candidates.some(item => item.command === 'python -m pytest' && !item.certain));
  assert.match(session.messages.at(-1).content, /Python 依赖在 CI 里怎么安装/);
  assert.equal(session.merge_queue.state, 'disabled');
  assert.deepEqual(writes(state), []);
  // The facts token only reads.
  assert.deepEqual([...state.tokens.values()], [{ installation: 1, repository_ids: [101], permissions: gatePermissions.read }]);
  assert.ok(!JSON.stringify(session).includes('ghs_'));
});

test('the agent proposes from repository facts, the person corrects it in the conversation, and only confirmation opens the PR', async t => {
  const seen = [];
  const { state, open, say, confirm, llm } = await fixture(t, { model: async (input, n, body) => {
    seen.push(input);
    if (n === 1) return { content: null, tool_calls: [{ id: 'token', type: 'function', function: { name: 'github_read_token', arguments: '{}' } }] };
    if (n === 2) return { content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'github_read', arguments: JSON.stringify({ path: '/contents/Makefile' }) } }] };
    if (n === 3) {
      assert.match(body.messages.at(-1).content, /python -m pytest/); // The Makefile it read.
      return answer('build 用 make build，pr-ready 用 make lint 和 make test。Python 依赖怎么装？', { toolchains: { python: '3.12' }, lanes: { build: ['make build'], 'pr-ready': ['make lint', 'make test'] } });
    }
    assert.equal(input.conversation.at(-1).content, '依赖用 pip install -e ".[test]"，daily 跑 make test');
    return answer('已加入安装命令和 daily。', { toolchains: { python: '3.12' }, install: ['pip install -e ".[test]"'], lanes: { build: ['make build'], 'pr-ready': ['make lint', 'make test'], daily: ['make test'] } });
  } });
  let session = await open();
  assert.equal(session.agent.available, true);
  assert.equal(session.messages.at(-1).role, 'agent');
  assert.equal(session.revision, 1); // The agent's first plan equals the one built from certain facts, so no new revision.
  assert.deepEqual(seen[0].facts.files.Makefile, makefile);
  assert.deepEqual(seen[0].current_plan.lanes.build, ['make build']);
  assert.equal(seen[0].merge_queue, 'disabled');
  session = await say(session, '依赖用 pip install -e ".[test]"，daily 跑 make test');
  assert.deepEqual(session.plan.install, ['pip install -e ".[test]"']);
  assert.deepEqual(session.plan.lanes.daily, ['make test']);
  assert.equal(llm.requests.length, 4);
  // The agent's own read token is read-only and revoked; still nothing written to the repository.
  const agentToken = [...state.tokens.values()].find(grant => grant.permissions.contents === 'read' && !grant.permissions.pull_requests);
  assert.deepEqual(Object.values(agentToken.permissions).filter(level => level !== 'read'), []);
  assert.deepEqual(writes(state), []);
  assert.equal(state.repos['octo/hello'].pulls.length, 0);

  session = await confirm(session);
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state);
  assert.equal(session.pr_url, 'https://github.com/octo/hello/pull/1');
  assert.deepEqual(Object.keys(files).sort(), ['.github/ci-gates.json', '.github/workflows/ci.yml', '.github/workflows/release.yml', 'scripts/gate/gate.mjs']);
  const config = JSON.parse(files['.github/ci-gates.json']);
  assert.deepEqual(config.lanes, { build: { commands: ['make build'] }, 'pr-ready': { commands: ['make lint', 'make test'] }, 'pr-merge': { commands: [] }, daily: { commands: ['make test'] }, release: { commands: [] } });
  const workflow = parse(files['.github/workflows/ci.yml']), steps = workflow.jobs.gate.steps;
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  assert.equal(workflow.jobs.gate.env.CI_GATES_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.deepEqual(steps.filter(step => step.uses).map(step => step.uses), ['actions/checkout@v4', 'actions/setup-node@v4', 'actions/setup-python@v5', 'actions/upload-artifact@v4']);
  assert.deepEqual(steps.filter(step => step.run).map(step => step.run), ['pip install -e ".[test]"', 'node scripts/gate/gate.mjs run --event "$GITHUB_EVENT_NAME"']);
  assert.ok(!files['.github/workflows/ci.yml'].includes('npm ci'));
  assert.equal(steps.find(step => step.uses === 'actions/setup-node@v4').with.cache, undefined);
  assert.ok(releaseWorkflow(files['.github/workflows/release.yml'], 'v1.2.3').matched);
  assert.match(pull.body, /空 lane 只表示还没有配置检查/);
  assert.match(pull.body, /没有运行其中任何命令/);
  assert.match(pull.body, /`make lint`；`make test`/);
  assert.equal(pull.base, 'main');
  // Every write used the source token, which is the only token that may write workflows.
  const source = [...state.tokens.entries()].find(([, grant]) => grant.permissions.workflows === 'write')[0];
  assert.ok(writes(state).filter(r => r.path.startsWith('/repos/octo/hello')).every(r => r.auth === source));
  assert.deepEqual(state.tokens.get(source).permissions, gatePermissions.source);
  assert.equal(state.revoked.length, state.tokens.size);
});

test('with a merge queue the PR keeps only the gates that run before the queue, and reports the PR head', async t => {
  const { state, open, confirm } = await fixture(t);
  state.repos['octo/hello'].queue = 'ruleset';
  let session = await open();
  assert.deepEqual(session.merge_queue, { state: 'enabled', evidence: '默认分支 main 的规则集 77 要求 merge queue', asked: false });
  assert.deepEqual(session.target.events, ['pull_request', 'workflow_dispatch']);
  // Even a pr-merge command typed by the person is left out: it would only run on merge_group.
  const plan = { ...session.plan, lanes: { ...session.plan.lanes, 'pr-merge': ['make test'], daily: ['make test'] } };
  session = await confirm(session, { plan });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state), workflow = parse(files['.github/workflows/ci.yml']);
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'schedule', 'workflow_dispatch']);
  assert.ok(!('merge_group' in workflow.on) && !('push' in workflow.on));
  assert.equal(workflow.jobs.gate.env.CI_GATES_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  const config = JSON.parse(files['.github/ci-gates.json']);
  assert.deepEqual(config.lanes['pr-merge'], { commands: [] });
  assert.deepEqual(config.lanes.daily, { commands: ['make test'] });
  assert.match(pull.body, /不包含 merge_group，也不包含 push 到默认分支后才运行的门禁/);
  assert.match(pull.body, /\*\*build\*\*（PR 每次更新时跑，确认代码能构建）/);
  assert.match(pull.body, /先给门禁 workflow 加上 merge_group 触发/);
  // release.yml runs on version tags, not after merging.
  assert.deepEqual(Object.keys(parse(files['.github/workflows/release.yml']).on.push), ['tags']);
});

test('classic protection is settled by GraphQL, and an unreadable merge queue is asked about instead of guessed', async t => {
  const { state, open, confirm, admin } = await fixture(t);
  state.repos['octo/hello'].queue = 'graphql';
  let session = await open();
  assert.equal(session.merge_queue.state, 'enabled');
  state.repos['octo/hello'].queue = 'hidden';
  session = await open();
  assert.deepEqual([session.merge_queue.state, session.merge_queue.asked], ['unknown', true]);
  assert.equal(session.target, null);
  assert.match(session.messages.at(-1).content, /是否启用了 merge queue/);
  const refused = await confirm(session);
  assert.deepEqual([refused.status, refused.value.error], [400, 'merge_queue_required']);
  assert.deepEqual(writes(state), []);
  const answered = await admin(`/api/gate-onboarding/${session.id}/merge-queue`, 'POST', { answer: 'disabled' });
  assert.equal(answered.status, 201);
  assert.deepEqual([answered.value.session.merge_queue.state, answered.value.session.target.events], ['disabled', ['pull_request', 'merge_group', 'push', 'workflow_dispatch']]);
  assert.deepEqual(writes(state), []);
  session = await confirm(answered.value.session, { merge_queue: 'disabled' });
  assert.equal(session.state, 'done');
  assert.ok('merge_group' in parse(branchOf(state).files['.github/workflows/ci.yml']).on);
  assert.match(branchOf(state).pull.body, /由仓库管理员在接入对话中确认/);
});

test('an existing ci.yml and release.yml are never overwritten; the gate job goes beside them', async t => {
  const { state, open, confirm } = await fixture(t);
  Object.assign(state.repos['octo/hello'].files, { '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n',
    '.github/workflows/release.yml': 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs: {}\n' });
  let session = await open();
  assert.deepEqual(session.facts.workflows.map(item => [item.path, item.events]), [['.github/workflows/ci.yml', ['push']], ['.github/workflows/release.yml', ['push']]]);
  assert.ok(session.facts.candidates.some(item => item.command === 'make test' && item.source.includes('Makefile') && item.source.includes('.github/workflows/ci.yml')));
  assert.equal(session.target.workflow_path, '.github/workflows/ci-gates.yml');
  assert.match(session.messages[0].content, /不会覆盖/);
  const plan = { ...session.plan, lanes: { ...session.plan.lanes, release: ['make build'] } };
  session = await confirm(session, { plan });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state);
  assert.deepEqual(Object.keys(files).sort(), ['.github/ci-gates.json', '.github/workflows/ci-gates.yml', 'scripts/gate/gate.mjs']);
  assert.ok(!writes(state).some(r => /workflows\/(?:ci|release)\.yml$/.test(r.path)));
  const workflow = parse(files['.github/workflows/ci-gates.yml']);
  assert.equal(workflow.name, 'CI gates');
  assert.ok('release' in workflow.on); // The repository's own release.yml does not run the release lane.
  assert.match(pull.body, /这个 PR 没有修改它/);
});

test('a repository that already has ci-gates.json is reported as connected and gets no PR', async t => {
  const { state, open, confirm, admin } = await fixture(t);
  state.repos['octo/hello'].files['.github/ci-gates.json'] = '{"version":1,"lanes":{}}';
  const session = await open();
  assert.equal(session.state, 'connected');
  assert.match(session.messages.at(-1).content, /不需要再开一份覆盖它的 PR/);
  const refused = await confirm(session);
  assert.deepEqual([refused.status, refused.value.error], [409, 'gate_onboarding_closed']);
  assert.equal((await admin(`/api/gate-onboarding/${session.id}/messages`, 'POST', { content: 'hi' })).status, 409);
  assert.deepEqual(writes(state), []);
});

test('a Node repository with dependencies but no lock file is onboarded; npm install is only asked about', async t => {
  const { state, open, confirm } = await fixture(t);
  state.repos['octo/hello'].files = { 'package.json': JSON.stringify({ name: 'hello', scripts: { build: 'tsc', test: 'node --test' }, dependencies: { leftpad: '1' } }) };
  let session = await open();
  assert.equal(session.state, 'ready');
  assert.deepEqual(session.plan.install, []);
  assert.deepEqual(session.plan.lanes.build, ['npm run build']);
  assert.deepEqual(session.plan.lanes['pr-ready'], ['npm test']);
  assert.match(session.messages.at(-1).content, /没有锁文件/);
  session = await confirm(session, { plan: { ...session.plan, install: ['npm install'] } });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { files } = branchOf(state), steps = parse(files['.github/workflows/ci.yml']).jobs.gate.steps;
  assert.ok(!Object.keys(files).includes('package-lock.json'));
  assert.equal(steps.find(step => step.uses === 'actions/setup-node@v4').with.cache, undefined);
  assert.deepEqual(steps.filter(step => step.run).map(step => step.run)[0], 'npm install');
});

test('a stale revision, an open gate PR, a secret or an Actions expression stops confirmation without writing', async t => {
  const { state, open, confirm, admin } = await fixture(t);
  let session = await open();
  let refused = await confirm({ ...session, revision: session.revision + 1 });
  assert.deepEqual([refused.status, refused.value.error], [409, 'gate_plan_changed']);
  refused = await confirm(session, { plan: { ...session.plan, install: ['echo ${{ secrets.TOKEN }}'] } });
  assert.deepEqual([refused.status, refused.value.error], [400, 'gate_plan_invalid']);
  refused = await confirm(session, { plan: { ...session.plan, lanes: { ...session.plan.lanes, build: ['curl -H "Authorization: ghp_' + 'a'.repeat(36) + '"'] } } });
  assert.deepEqual([refused.status, refused.value.error], [400, 'gate_plan_secret']);
  assert.equal((await admin(`/api/gate-onboarding/${session.id}/messages`, 'POST', { content: 'hello' })).value.error, 'gate_agent_unavailable');
  state.repos['octo/hello'].pulls.push({ number: 7, head: { ref: 'bot/gate-onboarding-12345678' } });
  session = await open();
  assert.deepEqual(session.facts.open_gate_prs.map(item => item.number), [7]);
  refused = await confirm(session);
  assert.deepEqual([refused.status, refused.value.error], [409, 'gate_pr_open']);
  assert.deepEqual(writes(state), []);
});

test('an App without the workflows permission returns to the conversation and can confirm again once granted', async t => {
  const { state, open, confirm } = await fixture(t);
  delete state.installations.octo.permissions.workflows;
  let session = await open();
  session = await confirm(session);
  assert.deepEqual([session.state, session.error], ['ready', 'app_permissions_missing']);
  assert.match(session.messages.at(-1).content, /Workflows（Read and write）/);
  assert.deepEqual(writes(state), []);
  state.installations.octo.permissions.workflows = 'write';
  session = await confirm(session);
  assert.equal(session.state, 'done');
});

test('a bot account repository and an empty repository stop before anything is proposed', async t => {
  const bot = await fixture(t, { type: 'bot_account' });
  const blocked = await bot.open();
  assert.deepEqual([blocked.state, blocked.error], ['blocked', 'github_app_required']);
  assert.deepEqual(bot.state.requests, []);
  const app = await fixture(t);
  app.state.repos['octo/hello'].files = {};
  const empty = await app.open();
  assert.deepEqual([empty.state, empty.error], ['blocked', 'repository_empty']);
});

test('model output that breaks the contract leaves the plan alone and says so', async t => {
  const { open, say } = await fixture(t, { model: async (_input, n) => n === 1 ? answer('先看看', { lanes: { build: ['make build'] } })
    : n === 2 ? { content: 'not json' } : answer('带令牌的方案', { lanes: { build: ['echo gate-model-key-123456'] } }) });
  let session = await open();
  const revision = session.revision;
  session = await say(session, '再想想');
  assert.equal(session.revision, revision);
  assert.match(session.messages.at(-1).content, /没有按约定返回 JSON/);
  session = await say(session, '再来');
  assert.equal(session.revision, revision);
  assert.match(session.messages.at(-1).content, /包含了令牌/);
});

test('a restart ends an unfinished turn, a newer conversation supersedes the old one, and deleting the project removes both', async t => {
  const { h, admin, open } = await fixture(t, { start: true });
  const first = await open();
  h.store.run("UPDATE gate_onboarding_sessions SET state='thinking' WHERE id=?", first.id);
  await h.stop(); await h.start();
  const restarted = (await admin(`/api/gate-onboarding/${first.id}`)).value.session;
  assert.deepEqual([restarted.state, restarted.error], ['ready', 'interrupted']);
  assert.match(restarted.messages.at(-1).content, /控制面重启/);
  const second = await open();
  assert.equal((await admin('/api/projects/101/gate-onboarding')).value.session.id, second.id);
  const stale = await admin(`/api/gate-onboarding/${first.id}/confirm`, 'POST', { revision: restarted.revision });
  assert.deepEqual([stale.status, stale.value.error], [409, 'gate_onboarding_superseded']);
  assert.equal((await admin('/api/projects/101', 'DELETE', {})).status, 200);
  assert.equal(h.store.get('SELECT count(*) n FROM gate_onboarding_sessions').n, 0);
  // Only super administrators use onboarding.
  const password = testPassword(), member = h.client();
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] });
  await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member('/api/projects/101/gate-onboarding', 'POST', {})).status, 403);
});

test('rendered files follow the plan: toolchains, go.mod, npm cache and empty lanes', () => {
  const plan = normalizePlan({ toolchains: { node: '20', go: 'go.mod', java: '21' }, install: ['npm ci', 'go mod download'], lanes: { build: ['go build ./...'], release: [] } });
  const target = { defaultBranch: 'trunk', mergeQueue: 'disabled', workflowPath: '.github/workflows/ci.yml', releaseWorkflow: true, npmLock: true };
  const [workflow, config, release] = gateFiles(plan, target), parsed = parse(workflow.content);
  assert.deepEqual(parsed.on.push.branches, ['trunk']);
  assert.deepEqual(gateEvents(plan, target), ['pull_request', 'merge_group', 'push', 'workflow_dispatch']);
  const steps = parsed.jobs.gate.steps;
  assert.deepEqual(steps.find(step => step.uses === 'actions/setup-node@v4').with, { 'node-version': '20', cache: 'npm' });
  assert.deepEqual(steps.find(step => step.uses === 'actions/setup-go@v5').with, { 'go-version-file': 'go.mod' });
  assert.deepEqual(steps.find(step => step.uses === 'actions/setup-java@v4').with, { distribution: 'temurin', 'java-version': '21' });
  assert.deepEqual(steps.filter(step => step.run).map(step => step.name), ['Install dependencies (1)', 'Install dependencies (2)', 'Run gate lanes']);
  assert.deepEqual(JSON.parse(config.content).lanes['pr-ready'], { commands: [] });
  assert.equal(parse(release.content).jobs.gate.steps.at(-2).run, 'node scripts/gate/gate.mjs run --lane release');
  assert.deepEqual(emptyPlan().toolchains, { node: '22', python: '', go: '', java: '' });
  assert.throws(() => normalizePlan({ lanes: { deploy: ['x'] } }), PlanError);
  // Commands are kept whole; a long or non-ASCII command is not refused.
  const long = 'echo ' + '测'.repeat(5000);
  assert.deepEqual(normalizePlan({ lanes: { daily: [long] } }).lanes.daily, [long]);
});

test('review, development and read tokens still never ask for workflows', async t => {
  const { h, owner, state, github } = await fixture(t);
  const repository = { id: '101', full_name: 'octo/hello', owner_id: '10', account_id: owner.id };
  for (const development of [false, true]) await new GitHub(h.store, repository, new Redactor(), async () => {}, github.url).connect(development);
  const tokens = new ReadTokens(h.store, repository, new Redactor(), async () => {}, github.url);
  await tokens.issue(); await tokens.revoke();
  for (const grant of state.tokens.values()) assert.ok(!('workflows' in grant.permissions));
  assert.ok(!('workflows' in agentReadPermissions));
});

test('opening 接入门禁 shows the five lanes first and creates nothing until the person starts', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/gate-onboarding.js'], (method, path) =>
    method === 'GET' && path === '/api/projects/101/gate-onboarding' ? [200, { session: null }] : [500, { error: 'unexpected' }]);
  await page.run("openGateOnboarding({ id: '101', full_name: 'octo/hello' }, null)");
  assert.equal(page.run('gateOnboardingView.open && gateOnboardingView.id'), 'quickstart-view');
  assert.equal(page.$('gate-onboarding-title').textContent, '接入门禁 · octo/hello');
  assert.equal(page.$('gate-onboarding-intro').hidden, false);
  assert.equal(page.$('gate-onboarding-chat').hidden, true);
  const lanes = page.$('gate-onboarding-lanes').children.filter(item => item.tagName === 'DT').map(item => item.textContent);
  assert.deepEqual(lanes, ['build', 'pr-ready', 'pr-merge', 'daily', 'release']);
  assert.ok(page.$('gate-onboarding-lanes').children.filter(item => item.tagName === 'DD').every(item => item.textContent.length > 10));
  assert.deepEqual(page.requests, ['GET /api/projects/101/gate-onboarding']);
});
