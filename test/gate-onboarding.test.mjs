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
import { workspaceProfile } from '../dist/agent/profiles.js';
import { workflowAccess, builtinWorkflow, writeOptions } from '../dist/workflows/catalog.js';
import { loadConsole } from './console-page.mjs';
import { gateFixture as fixture, writes, branchOf } from './gate-onboarding-fixtures.mjs';

const lanes = (values = {}) => ({ 'pr-ready': [], 'pr-merge': [], daily: [], release: [], ...values });

test('the board location helper still names the verified webhook origin and a lowercase path', () => {
  assert.deepEqual(boardLocation('https://bot.example/', 'My-Org/Hello'), { key: 'my-org/hello', url: 'https://bot.example/boards/my-org/hello/' });
});

test('gate onboarding needs a started project with a ready computer, the workflow on and a model, like every workflow', async t => {
  const { h, admin, startProject, open } = await fixture(t, { ready: false });
  const ready = async () => (await admin('/api/projects/101/gate-onboarding')).value.ready;
  assert.deepEqual([(await ready()).ok, (await ready()).code], [false, 'gate_project_not_started']);
  assert.deepEqual([(await open()).status, (await open()).value.error], [409, 'gate_project_not_started']);
  await startProject();
  h.store.run("UPDATE project_environments SET state='provisioning' WHERE repository_id='101'");
  assert.equal((await ready()).code, 'gate_environment_not_ready');
  assert.match((await ready()).reason, /虚拟电脑还没有就绪（当前：provisioning）/);
  h.store.run("UPDATE project_environments SET state='ready' WHERE repository_id='101'");
  assert.equal((await admin('/api/repositories/101/workflows/gate.onboarding', 'PUT', { enabled: false })).status, 200);
  assert.equal((await ready()).code, 'workflow_disabled');
  assert.equal((await admin('/api/repositories/101/workflows/gate.onboarding', 'PUT', { enabled: true })).status, 200);
  h.store.run("UPDATE policies SET model_id=NULL WHERE repository_id='101'");
  assert.equal((await ready()).code, 'model_not_configured');
  h.store.run("UPDATE policies SET model_id=(SELECT id FROM models LIMIT 1) WHERE repository_id='101'");
  assert.deepEqual([(await ready()).ok, (await ready()).model], [true, 'gate-model']);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n, 0);
});

test('gate onboarding is a built-in workflow whose agent works in the project computer and only submits a plan', () => {
  const workflow = builtinWorkflow('gate.onboarding');
  assert.deepEqual([workflow.name, workflow.base, workflow.triggers], ['接入门禁', 'gate', ['gate.manual']]);
  assert.match(workflow.prompt.builtin, /flowchart LR/);
  assert.deepEqual(writeOptions('gate.onboarding').map(write => [write.id, write.tool, write.locked]), [['gate_plan', 'submit_gate_plan', true]]);
  const profile = workspaceProfile('gate.onboarding', { workflow_prompt: workflow.prompt.builtin }, workflowAccess('gate.onboarding'));
  const names = profile.tools.map(tool => tool.function.name);
  for (const name of ['read_file', 'run_command', 'github_read_token', 'github_read', 'start_agent', 'submit_gate_plan']) assert.ok(names.includes(name), name);
  for (const name of ['create_pull_request', 'create_issue', 'finish_review']) assert.ok(!names.includes(name), name);
  assert.deepEqual([profile.finishTools, profile.capabilities.workspace.write, profile.capabilities.github.publication, profile.capabilities.writes], [['submit_gate_plan'], false, 'none', ['gate_plan']]);
  // The plan's four lanes are all required, so a submission never leaves one out by accident.
  const submit = profile.tools.find(tool => tool.function.name === 'submit_gate_plan').function.parameters;
  assert.deepEqual(submit.properties.plan.properties.lanes.required, ['pr-ready', 'pr-merge', 'daily', 'release']);
  assert.match(profile.system, /gate onboarding mode/);
  assert.match(profile.system, /standard_changes/);
});

test('each turn is a task on a checkout of the default branch; the control plane reads only gate facts and writes nothing', async t => {
  const seen = [];
  const { h, state, open, play } = await fixture(t);
  play.agent = context => { seen.push(context); return { reply: '分析完成。', plan: { ...context.plan, lanes: lanes({ 'pr-ready': ['make build', 'make test'] }) } }; };
  const session = await open();
  assert.equal(session.state, 'ready', JSON.stringify(session));
  const task = h.store.get("SELECT * FROM tasks WHERE kind='gate.onboarding'");
  assert.deepEqual([task.status, JSON.parse(task.input).session_id, session.task], ['succeeded', session.id, null]);
  const { target, gate, conversation, plan } = seen[0];
  assert.equal(target.sha, 'a'.repeat(40));
  assert.deepEqual(target.contextFiles.map(file => file.path), ['../context/conversation.json', '../context/plan.json', '../context/gate.json']);
  assert.match(target.context.workflow_prompt, /# Gate onboarding/);
  assert.deepEqual(plan, emptyPlan());
  assert.equal(conversation.length, 1); // The facts summary.
  assert.deepEqual(gate.targets, [{ path: '.github/workflows/ci.yml', mode: 'create' }, { path: '.github/workflows/ci-gates.yml', mode: 'create' }]);
  assert.deepEqual(gate.events.merge_group, ['pr-ready', 'pr-merge']);
  assert.ok(gate.standard_changes.some(change => change.includes('PR head')) && gate.standard_changes.some(change => change.includes('release.yml is created')));
  assert.deepEqual([session.messages.map(message => message.role), session.plan.lanes['pr-ready'], session.revision], [['system', 'agent'], ['make build', 'make test'], 2]);
  assert.match(session.messages[0].content, /agent 在项目电脑里检出这个提交继续分析/);
  // The task's token only reads; nothing is written to the repository before a confirmation.
  assert.deepEqual(writes(state), []);
  for (const grant of state.tokens.values()) assert.ok(!('workflows' in grant.permissions) && grant.permissions.contents === 'read');
});

test('the person replies; lanes the agent leaves out keep their commands, and the confirmed plan becomes the gate PR', async t => {
  const contexts = [];
  const { state, open, say, confirm, play } = await fixture(t);
  play.agent = context => { contexts.push(context); return contexts.length === 1
    ? { reply: 'pr-ready 跑 make build、make lint 和 make test，依赖怎么装？', plan: { toolchains: { python: '3.12' }, lanes: lanes({ 'pr-ready': ['make build', 'make lint', 'make test'], release: ['make dist'] }), install: [], observe: ['daily'], workflow: '' } }
    // Only the lanes it changes: the others keep what they had.
    : { reply: '已加入安装命令和 daily。', plan: { install: ['pip install -e ".[test]"'], lanes: { daily: ['make test'] } } }; };
  let session = await open();
  session = await say(session, '依赖用 pip install -e ".[test]"，daily 跑 make test');
  assert.equal(contexts[1].conversation.at(-1).content, '依赖用 pip install -e ".[test]"，daily 跑 make test');
  assert.deepEqual(contexts[1].plan.lanes['pr-ready'], ['make build', 'make lint', 'make test']);
  assert.deepEqual(session.plan.lanes, lanes({ 'pr-ready': ['make build', 'make lint', 'make test'], daily: ['make test'], release: ['make dist'] }));
  assert.deepEqual([session.plan.install, session.plan.toolchains.python], [['pip install -e ".[test]"'], '3.12']);
  assert.deepEqual(writes(state), []);
  session = await confirm(session);
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state);
  assert.equal(session.pr_url, 'https://github.com/octo/hello/pull/1');
  assert.deepEqual(Object.keys(files).sort(), ['.github/ci-gates.json', '.github/workflows/ci.yml', '.github/workflows/release.yml', 'scripts/gate/gate.mjs']);
  const config = JSON.parse(files['.github/ci-gates.json']);
  assert.deepEqual(config.lanes, { 'pr-ready': { commands: ['make build', 'make lint', 'make test'] }, 'pr-merge': { commands: [] },
    daily: { commands: ['make test'], enforcement: 'observe', continueOnError: true }, release: { commands: ['make dist'] } });
  assert.deepEqual(config.events, { pull_request: ['pr-ready'], workflow_dispatch: ['pr-ready'], merge_group: ['pr-ready', 'pr-merge'], push: ['pr-ready', 'pr-merge'], schedule: ['daily'], release: ['release'] });
  const workflow = parse(files['.github/workflows/ci.yml']), steps = workflow.jobs.gate.steps;
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']);
  assert.equal(steps[0].with.ref, workflow.jobs.gate.env.CI_GATES_SHA);
  const runs = steps.filter(step => step.run).map(step => step.run);
  assert.deepEqual([runs.length, runs[0], runs[1].trim().split('\n').at(-1)], [2, 'pip install -e ".[test]"', 'node scripts/gate/gate.mjs run --event "$GITHUB_EVENT_NAME"']);
  // A branch that predates the gate fails with a message, not with node's missing-module error.
  assert.match(runs[1], /if \[ ! -f scripts\/gate\/gate\.mjs \]; then\n\s+echo "::error::This commit has no scripts\/gate\/gate\.mjs: the branch predates the CI gate\./);
  assert.ok(releaseWorkflow(files['.github/workflows/release.yml'], 'v1.2.3').matched);
  assert.match(pull.body, /空 lane 只表示还没有配置检查/);
  assert.match(pull.body, /在项目的受控环境里分析仓库/);
  const source = [...state.tokens.entries()].find(([, grant]) => grant.permissions.workflows === 'write')[0];
  assert.ok(writes(state).filter(r => r.path.startsWith('/repos/octo/hello')).every(r => r.auth === source));
  assert.deepEqual(state.tokens.get(source).permissions, gatePermissions.source);
  assert.ok(state.revoked.includes(source));
});

test('a plan that fails the checks keeps the reply and the current plan; tokens in a reply are hidden', async t => {
  const { open, play } = await fixture(t);
  play.agent = ({ plan }) => ({ reply: '放进 other.yml。ghp_' + 'a'.repeat(36), plan: { ...plan, lanes: lanes({ 'pr-ready': ['make test'] }), workflow: '.github/workflows/other.yml' } });
  const session = await open();
  assert.deepEqual([session.state, session.revision, session.plan.lanes['pr-ready']], ['ready', 1, []]);
  assert.equal(session.messages.at(-2).content, '放进 other.yml。[REDACTED]');
  assert.match(session.messages.at(-1).content, /没有通过检查（workflow \.github\/workflows\/other\.yml 不在可选的位置里），右侧方案没有变化/);
});

test('a turn that ends without a result says so; the conversation goes on, and a newer conversation stops an older turn', async t => {
  const { h, admin, open, say, turn, play } = await fixture(t);
  play.agent = () => { throw Object.assign(new Error('model_unavailable'), { code: 'model_unavailable', state: 'failed', detail: '模型 30 秒内没有响应' }); };
  let session = await open();
  assert.deepEqual([session.state, session.error, session.task], ['ready', 'model_unavailable', null]);
  assert.match(session.messages.at(-1).content, /agent 这一轮没有完成：模型 30 秒内没有响应/);
  play.agent = ({ plan }) => ({ reply: '好了。', plan });
  session = await say(session, '再试一次');
  assert.equal(session.messages.at(-1).content, '好了。');
  // A conversation started while a turn waits supersedes it: the old turn's task stops when it is picked up.
  const first = (await admin('/api/projects/101/gate-onboarding', 'POST', {})).value.session;
  assert.equal(first.state, 'thinking');
  const second = (await admin('/api/projects/101/gate-onboarding', 'POST', {})).value.session;
  await turn();
  const tasks = h.store.all("SELECT input,status,error_code FROM tasks WHERE kind='gate.onboarding' ORDER BY created_at,rowid").slice(-2);
  assert.deepEqual(tasks.map(task => [JSON.parse(task.input).session_id, task.status, task.error_code]), [[first.id, 'cancelled', 'gate_session_superseded'], [second.id, 'succeeded', null]]);
  const stale = await admin(`/api/gate-onboarding/${first.id}/messages`, 'POST', { content: 'hi' });
  assert.deepEqual([stale.status, stale.value.error], [409, 'gate_onboarding_superseded']);
});

test('a bot account repository cannot start, and an empty repository ends its first turn', async t => {
  const bot = await fixture(t, { type: 'bot_account' });
  const blocked = await bot.open();
  assert.deepEqual([blocked.status, blocked.value.error], [409, 'github_app_required']);
  assert.deepEqual(bot.state.requests.filter(r => r.path !== '/repositories/101'), []);
  const app = await fixture(t);
  app.state.repos['octo/hello'].files = {};
  const empty = await app.open();
  assert.deepEqual([empty.state, empty.error], ['failed', 'repository_has_no_commit']);
  assert.match(empty.messages.at(-1).content, /仓库还没有任何提交/);
});

test('a restart ends a PR creation in progress, and deleting the project removes its conversations', async t => {
  const { h, admin, open } = await fixture(t);
  const first = await open();
  h.store.run("UPDATE gate_onboarding_sessions SET state='creating' WHERE id=?", first.id);
  await h.stop(); await h.start();
  const restarted = (await admin(`/api/gate-onboarding/${first.id}`)).value.session;
  assert.deepEqual([restarted.state, restarted.error], ['ready', 'interrupted']);
  assert.match(restarted.messages.at(-1).content, /控制面重启，创建 PR 没有完成/);
  h.store.run("UPDATE environment_operations SET state='completed'");
  assert.equal((await admin('/api/projects/101', 'DELETE', {})).status, 200);
  assert.equal(h.store.get('SELECT count(*) n FROM gate_onboarding_sessions').n, 0);
  // Only super administrators use onboarding.
  const password = testPassword(), member = h.client();
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: [] });
  await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member('/api/projects/101/gate-onboarding', 'POST', {})).status, 403);
});

test('with a merge queue the gate runs on pull requests and in the queue, not again after merging, so it can be required', async t => {
  const { state, open, confirm } = await fixture(t);
  state.repos['octo/hello'].queue = 'ruleset';
  let session = await open();
  assert.deepEqual(session.merge_queue, { state: 'enabled', evidence: '默认分支 main 的规则集 77 要求 merge queue', asked: false });
  assert.deepEqual(session.facts.required_checks, ['unit']);
  assert.match(session.messages[0].content, /规则集要求的检查：unit/);
  assert.deepEqual(session.target.events, ['pull_request', 'merge_group', 'workflow_dispatch']);
  // pr-merge runs in the queue, so a command for it is kept.
  const plan = { ...session.plan, lanes: { ...session.plan.lanes, 'pr-merge': ['make test'], daily: ['make e2e'] } };
  session = await confirm(session, { plan });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state), workflow = parse(files['.github/workflows/ci.yml']);
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'merge_group', 'schedule', 'workflow_dispatch']);
  assert.ok(!('push' in workflow.on));
  assert.equal(workflow.jobs.gate.env.CI_GATES_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  // A push never cancels a queue or daily run; only pull request runs of one branch replace each other.
  assert.deepEqual(workflow.concurrency, { group: "ci-gates-${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}", 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" });
  const config = JSON.parse(files['.github/ci-gates.json']);
  assert.deepEqual(config.lanes['pr-merge'], { commands: ['make test'] });
  // daily follows CI-workflow: failures are recorded, later commands still run.
  assert.deepEqual(config.lanes.daily, { commands: ['make e2e'], enforcement: 'observe', continueOnError: true });
  assert.match(pull.body, /进入队列后，在队列的合并结果上先跑 pr-ready 再跑 pr-merge（merge_group），合入默认分支后不再重复运行/);
  assert.match(pull.body, /可以把 `gate` 设为必需检查/);
  assert.match(pull.body, /\*\*daily\*\*（每天定时.*通常只记录失败）：`make e2e`（observe：失败只记录，不让门禁失败）/);
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
  assert.match(session.messages[0].content, /merge queue：无法判断/);
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

test('an existing ci.yml and release.yml are never overwritten; by default the gate job goes beside them', async t => {
  const { state, open, confirm } = await fixture(t);
  Object.assign(state.repos['octo/hello'].files, { '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n',
    '.github/workflows/release.yml': 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs: {}\n' });
  let session = await open();
  assert.deepEqual(session.facts.workflows.map(item => [item.path, item.events, item.jobs]), [['.github/workflows/ci.yml', ['push'], ['test']], ['.github/workflows/release.yml', ['push'], []]]);
  assert.deepEqual(session.workflow_options, [{ path: '.github/workflows/ci-gates.yml', mode: 'create' }, { path: '.github/workflows/ci.yml', mode: 'update' }]);
  const elsewhere = await confirm(session, { plan: { ...session.plan, workflow: '.github/workflows/release.yml' } });
  assert.deepEqual([elsewhere.status, elsewhere.value.error], [409, 'gate_workflow_invalid']);
  assert.equal(session.target.workflow_path, '.github/workflows/ci-gates.yml');
  assert.match(session.messages[0].content, /不会覆盖/);
  const plan = { ...session.plan, lanes: { ...session.plan.lanes, release: ['make build'] } };
  session = await confirm(session, { plan });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { files } = branchOf(state);
  assert.deepEqual(Object.keys(files).sort(), ['.github/ci-gates.json', '.github/workflows/ci-gates.yml', '.github/workflows/release.yml', 'scripts/gate/gate.mjs']);
  assert.ok(!writes(state).some(r => /workflows\/ci\.yml$/.test(r.path)));
  const workflow = parse(files['.github/workflows/ci-gates.yml']);
  assert.equal(workflow.name, 'CI gates');
  assert.ok(!('release' in workflow.on));
  // The repository's own tag-triggered release.yml keeps its triggers and gets a job that runs the release lane.
  const release = parse(files['.github/workflows/release.yml']);
  assert.deepEqual([release.on, Object.keys(release.jobs)], [{ push: { tags: ['v*'] } }, ['release-gate']]);
  assert.equal(release.jobs['release-gate'].steps.find(step => step.run?.includes('gate.mjs')).run, 'node scripts/gate/gate.mjs run --lane release');
  assert.deepEqual(release.jobs['release-gate'].permissions, { contents: 'read' });
});

test('a release.yml the release flow cannot use is left alone and explained; a missing one is created', async t => {
  const { state, open, confirm } = await fixture(t);
  state.repos['octo/hello'].files['.github/workflows/release.yml'] = 'name: Release\non:\n  release:\n    types: [published]\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n';
  let session = await open();
  assert.equal(session.facts.release_workflow.usable, false);
  assert.match(session.messages[0].content, /不能用于发版本/);
  session = await confirm(session, { plan: { ...session.plan, lanes: { ...session.plan.lanes, release: ['make build'] } } });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state);
  assert.ok(!('.github/workflows/release.yml' in files));
  assert.match(pull.body, /不能用于发版本（[^）]+），这个 PR 没有修改它/);
});

test('the gate job can be merged into an existing workflow: other jobs, comments and triggers stay, and the diff is shown first', async t => {
  const { state, open, confirm, admin } = await fixture(t);
  state.repos['octo/hello'].queue = 'ruleset';
  const ci = '# Our CI\nname: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: make test # unit tests\n';
  state.repos['octo/hello'].files['.github/workflows/ci.yml'] = ci;
  let session = await open();
  const plan = { ...session.plan, workflow: '.github/workflows/ci.yml' };
  // The preview renders unsent edits without saving them.
  const preview = (await admin(`/api/gate-onboarding/${session.id}/preview`, 'POST', { plan })).value;
  assert.equal(preview.target.mode, 'update');
  const diff = preview.target.files.find(file => file.path === '.github/workflows/ci.yml').diff;
  assert.match(diff, /^\+  merge_group:$/m);
  assert.match(diff, /^\+  gate:$/m);
  assert.match(diff, /^ {3}test:$/m);
  assert.equal((await admin(`/api/gate-onboarding/${session.id}`)).value.session.revision, session.revision);
  assert.deepEqual(writes(state), []);
  session = await confirm(session, { plan });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state), merged = files['.github/workflows/ci.yml'], workflow = parse(merged);
  assert.ok(merged.startsWith('# Our CI\n') && merged.includes('make test # unit tests'));
  assert.deepEqual(Object.keys(workflow.jobs), ['test', 'gate']);
  assert.deepEqual(Object.keys(workflow.on), ['push', 'pull_request', 'merge_group', 'workflow_dispatch']);
  // The existing push trigger stays for the test job, but with a merge queue the gate job does not run after merging.
  assert.equal(workflow.jobs.gate.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch'");
  assert.ok(!Object.keys(files).includes('.github/workflows/ci-gates.yml'));
  assert.match(pull.body, /并入了已有的 `\.github\/workflows\/ci\.yml`/);
});

test('a repository that already has gates is reviewed from its own configuration; the review shows what the standard gate job changes', async t => {
  const { state, open, confirm } = await fixture(t);
  state.repos['octo/hello'].queue = 'ruleset';
  const config = { version: 1, level: 'C2', caseCatalog: 'test/cases/case-catalog.yaml', lanes: { build: { commands: 'make build', timeoutSec: 600 }, 'pr-ready': { commands: ['make lint'] }, daily: { commands: [] } } };
  // An older, hand-written gate job: its own display name, no PR head reporting, no report upload and no merge_group.
  const ci = 'name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  checks:\n    name: CI gate\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.11"\n      - run: pip install -e .\n      - run: node scripts/gate/gate.mjs run --event "$GITHUB_EVENT_NAME"\n';
  Object.assign(state.repos['octo/hello'].files, { '.github/ci-gates.json': JSON.stringify(config), '.github/workflows/ci.yml': ci, 'scripts/gate/gate.mjs': '// theirs\n' });
  let session = await open();
  assert.equal(session.state, 'ready');
  assert.ok(session.messages.some(message => /右侧方案从当前的 \.github\/ci-gates\.json/.test(message.content)));
  // The old build lane is folded into pr-ready.
  assert.deepEqual(session.plan.lanes, { 'pr-ready': ['make build', 'make lint'], 'pr-merge': [], daily: [], release: [] });
  assert.ok(session.messages.some(message => message.content.includes('原来的 build lane 已并入 pr-ready')));
  assert.deepEqual([session.plan.workflow, session.plan.install, session.plan.toolchains.python, session.plan.observe], ['.github/workflows/ci.yml', ['pip install -e .'], '3.11', []]);
  assert.equal(session.workflow_options[0].path, '.github/workflows/ci.yml');
  // The review shows what the standard gate changes: the gate job and its triggers, the event mapping replacing the build lane,
  // and the release.yml the release flow needs.
  assert.deepEqual(session.target.files.map(file => [file.path, file.mode]), [['.github/workflows/ci.yml', 'update'], ['.github/ci-gates.json', 'update'], ['.github/workflows/release.yml', 'create']]);
  const diff = session.target.files[0].diff;
  for (const line of [/^\+  merge_group:$/m, /^\+ {6}CI_GATES_SHA: /m, /^\+ {10}ref: /m, /^\+ {8}uses: actions\/upload-artifact@v4$/m, /^ {5}name: CI gate$/m, /^- {4}branches: \[main\]$/m]) assert.match(diff, line);
  assert.deepEqual(Object.keys(JSON.parse(session.target.files[1].content).lanes), ['pr-ready', 'daily']);
  const plan = { ...session.plan, lanes: { ...session.plan.lanes, 'pr-ready': ['make build', 'make lint', 'make test'] } };
  session = await confirm(session, { plan });
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const { pull, files } = branchOf(state), updated = JSON.parse(files['.github/ci-gates.json']), workflow = parse(files['.github/workflows/ci.yml']);
  assert.equal(pull.title, 'chore(ci): update CI gates');
  // Keys and forms the plan did not change are kept.
  assert.deepEqual([updated.level, updated.caseCatalog, Object.keys(updated), Object.keys(updated.lanes)], ['C2', 'test/cases/case-catalog.yaml', ['version', 'level', 'caseCatalog', 'events', 'lanes'], ['pr-ready', 'daily']]);
  assert.deepEqual(updated.lanes['pr-ready'], { commands: ['make build', 'make lint', 'make test'] });
  assert.deepEqual([Object.keys(workflow.jobs), workflow.jobs.checks.name], [['checks'], 'CI gate']);
  // The file holds only the gate job, so with a merge queue its push trigger goes: nothing runs again after merging.
  assert.deepEqual([Object.keys(workflow.on), workflow.jobs.checks.if], [['pull_request', 'merge_group', 'workflow_dispatch'], undefined]);
  assert.deepEqual(Object.keys(files).sort(), ['.github/ci-gates.json', '.github/workflows/ci.yml', '.github/workflows/release.yml']);
  assert.ok(!writes(state).some(r => r.path.endsWith('gate.mjs')));
});

test('gates this flow created and that were merged show no changes the next time, and no empty PR is opened', async t => {
  const { state, open, confirm } = await fixture(t);
  let session = await confirm(await open());
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  // Merge the gate PR, then open onboarding again.
  const repo = state.repos['octo/hello'], { files } = branchOf(state);
  Object.assign(repo.files, files); repo.pulls = [];
  session = await open();
  assert.deepEqual([session.plan.workflow, session.target.mode, session.target.files], ['.github/workflows/ci.yml', 'update', []]);
  const before = writes(state).length, empty = await confirm(session);
  assert.deepEqual([empty.status, empty.value.error], [409, 'gate_no_changes']);
  assert.equal(writes(state).length, before);
});

test('a merged gate job keeps the existing job name, and a default-branch change since the conversation stops the PR', async t => {
  const { state, open, confirm } = await fixture(t);
  state.repos['octo/hello'].queue = 'ruleset';
  const ci = 'name: CI\non: [pull_request]\njobs:\n  checks:\n    name: CI gate\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/gate/gate.mjs run --event "$GITHUB_EVENT_NAME"\n';
  Object.assign(state.repos['octo/hello'].files, { '.github/ci-gates.json': '{"version":1,"lanes":{}}', '.github/workflows/ci.yml': ci, 'scripts/gate/gate.mjs': '// theirs\n' });
  let session = await open();
  state.repos['octo/hello'].files['.github/workflows/ci.yml'] = ci + '# changed\n';
  session = await confirm(session);
  assert.deepEqual([session.state, session.error], ['ready', 'gate_file_changed']);
  assert.deepEqual(writes(state), []);
  state.repos['octo/hello'].files['.github/workflows/ci.yml'] = ci;
  session = await confirm(session);
  assert.equal(session.state, 'done', JSON.stringify(session.messages));
  const workflow = parse(branchOf(state).files['.github/workflows/ci.yml']);
  assert.deepEqual(Object.keys(workflow.jobs), ['checks']);
  assert.equal(workflow.jobs.checks.name, 'CI gate'); // The required-check context stays the same.
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'merge_group', 'workflow_dispatch']);
});

test('a stale revision, an open gate PR, a secret or an Actions expression stops confirmation without writing', async t => {
  const { state, open, confirm } = await fixture(t);
  let session = await open();
  let refused = await confirm({ ...session, revision: session.revision + 1 });
  assert.deepEqual([refused.status, refused.value.error], [409, 'gate_plan_changed']);
  refused = await confirm(session, { plan: { ...session.plan, install: ['echo ${{ secrets.TOKEN }}'] } });
  assert.deepEqual([refused.status, refused.value.error], [400, 'gate_plan_invalid']);
  refused = await confirm(session, { plan: { ...session.plan, lanes: { ...session.plan.lanes, build: ['curl -H "Authorization: ghp_' + 'a'.repeat(36) + '"'] } } });
  assert.deepEqual([refused.status, refused.value.error], [400, 'gate_plan_secret']);
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

test('rendered files follow the plan: toolchains, go.mod, npm cache and empty lanes', () => {
  const plan = normalizePlan({ toolchains: { node: '20', go: 'svc/go.mod', java: '21' }, install: ['npm ci', 'go mod download'], lanes: { build: ['go build ./...'], 'pr-ready': ['go vet ./...'], release: [] } });
  const target = { defaultBranch: 'trunk', mergeQueue: 'disabled', workflowPath: '.github/workflows/ci.yml', workflowSource: null, configSource: null, releaseSource: null, releaseUsable: false, npmLock: true };
  const [workflow, config, release] = gateFiles(plan, target), parsed = parse(workflow.content);
  assert.deepEqual(parsed.on.push.branches, ['trunk']);
  assert.deepEqual(gateEvents(plan, target), ['pull_request', 'merge_group', 'push', 'workflow_dispatch']);
  assert.deepEqual(gateEvents(plan, { ...target, mergeQueue: 'enabled' }), ['pull_request', 'merge_group', 'workflow_dispatch']);
  const steps = parsed.jobs.gate.steps;
  assert.deepEqual(steps.find(step => step.uses === 'actions/setup-node@v4').with, { 'node-version': '20', cache: 'npm' });
  assert.deepEqual(steps.find(step => step.uses === 'actions/setup-go@v5').with, { 'go-version-file': 'svc/go.mod' });
  assert.deepEqual(steps[0].with, { ref: '${{ github.event.pull_request.head.sha || github.sha }}' });
  assert.deepEqual(steps.find(step => step.uses === 'actions/setup-java@v4').with, { distribution: 'temurin', 'java-version': '21' });
  assert.deepEqual(steps.filter(step => step.run).map(step => step.name), ['Install dependencies (1)', 'Install dependencies (2)', 'Run gate lanes']);
  // A build lane is folded into pr-ready, build first.
  assert.deepEqual(JSON.parse(config.content).lanes, { 'pr-ready': { commands: ['go build ./...', 'go vet ./...'] }, 'pr-merge': { commands: [] },
    daily: { commands: [], enforcement: 'observe', continueOnError: true }, release: { commands: [] } });
  assert.equal(parse(release.content).jobs.gate.steps.at(-2).run, 'node scripts/gate/gate.mjs run --lane release');
  // A repository's own release.yml with branch triggers runs the merged release lane on version tags only.
  const own = 'name: Release\non:\n  push:\n    branches: [main]\n    tags: ["v*"]\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n';
  const merged = gateFiles({ ...plan, lanes: { ...plan.lanes, release: ['make dist'] } }, { ...target, releaseSource: own, releaseUsable: true }).find(file => file.path === '.github/workflows/release.yml');
  assert.equal(parse(merged.content).jobs['release-gate'].if, "startsWith(github.ref, 'refs/tags/')");
  assert.deepEqual(Object.keys(parse(merged.content).jobs), ['publish', 'release-gate']);
  assert.deepEqual(emptyPlan().toolchains, { node: '22', python: '', go: '', java: '' });
  assert.deepEqual([emptyPlan().observe, normalizePlan({}).observe, normalizePlan({ observe: [] }).observe], [['daily'], ['daily'], []]);
  assert.throws(() => normalizePlan({ workflow: '../ci.yml' }), PlanError);
  assert.throws(() => normalizePlan({ observe: ['nightly'] }), PlanError);
  assert.throws(() => normalizePlan({ lanes: { deploy: ['x'] } }), PlanError);
  // Commands are kept whole; a long or non-ASCII command is not refused.
  const long = 'echo ' + '测'.repeat(5000);
  assert.deepEqual(normalizePlan({ lanes: { daily: [long] } }).lanes.daily, [long]);
});

test('turning on a merge queue rewrites the gate\'s own workflow, while a shared workflow keeps its triggers', () => {
  const plan = normalizePlan({ lanes: { 'pr-ready': ['make test'] } });
  const target = { defaultBranch: 'main', mergeQueue: 'disabled', workflowPath: '.github/workflows/ci-gates.yml', workflowSource: null, configSource: null, releaseSource: null, releaseUsable: false, npmLock: false };
  const [first] = gateFiles(plan, target), before = parse(first.content);
  assert.ok('push' in before.on);
  assert.match(first.content, /^# Without a merge queue/m);
  // The lane commands run the pull request's code: no token is handed to them.
  assert.ok(!first.content.includes('GITHUB_TOKEN'));
  assert.ok(before.jobs.gate.steps.every(step => !step.env));
  // The same gate-only file after the repository enables a merge queue: no push trigger, no job-level if, a current header.
  const [updated] = gateFiles(plan, { ...target, mergeQueue: 'enabled', workflowSource: first.content }), after = parse(updated.content);
  assert.deepEqual(Object.keys(after.on), ['pull_request', 'merge_group', 'workflow_dispatch']);
  assert.equal(after.jobs.gate.if, undefined);
  assert.match(updated.content, /^# This repository uses a merge queue/m);
  assert.doesNotMatch(updated.content, /Without a merge queue/);
  assert.match(updated.content, /^# CI gates \(CI-workflow\), generated/);
  // A workflow with other jobs keeps push for them; the gate job is limited to the gate events instead.
  const shared = 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make lint\n';
  const [merged] = gateFiles(plan, { ...target, mergeQueue: 'enabled', workflowPath: '.github/workflows/ci.yml', workflowSource: shared }), mixed = parse(merged.content);
  assert.ok('push' in mixed.on);
  assert.equal(mixed.jobs.gate.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch'");
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

test('opening 接入门禁 shows the lanes first and creates nothing until the person starts', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/gate-onboarding.js'], (method, path) =>
    method === 'GET' && path === '/api/projects/101/gate-onboarding' ? [200, { session: null, ready: { ok: false, code: 'gate_project_not_started', reason: '项目还没有启动' } }] : [500, { error: 'unexpected' }]);
  await page.run("openGateOnboarding({ id: '101', full_name: 'octo/hello' }, null)");
  assert.equal(page.run('gateOnboardingView.open && gateOnboardingView.id'), 'quickstart-view');
  assert.equal(page.$('gate-onboarding-title').textContent, '接入门禁 · octo/hello');
  assert.equal(page.$('gate-onboarding-intro').hidden, false);
  assert.equal(page.$('gate-onboarding-chat').hidden, true);
  const lanes = page.$('gate-onboarding-lanes').children.filter(item => item.tagName === 'DT').map(item => item.textContent);
  assert.deepEqual(lanes, ['pr-ready', 'pr-merge', 'daily', 'release']);
  assert.ok(page.$('gate-onboarding-lanes').children.filter(item => item.tagName === 'DD').every(item => item.textContent.length > 10));
  assert.deepEqual(page.requests, ['GET /api/projects/101/gate-onboarding']);
  // A project that is not ready cannot start: the reason is shown and the button stays off.
  assert.equal(page.$('gate-onboarding-ready').textContent, '项目还没有启动');
  assert.equal(page.$('gate-onboarding-start').disabled, true);
});
