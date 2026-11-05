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
  // Makefile targets are repository commands and go into pr-ready, build first; pytest and pip install -e . are only asked about.
  assert.deepEqual(session.plan.lanes, { 'pr-ready': ['make build', 'make lint', 'make test'], 'pr-merge': [], daily: [], release: [] });
  assert.deepEqual(session.plan.install, []);
  assert.deepEqual([session.plan.observe, session.plan.workflow, session.default_workflow], [['daily'], '', '.github/workflows/ci.yml']);
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
      // A model that still thinks in a build lane: it is folded into pr-ready.
      return answer('pr-ready 跑 make build、make lint 和 make test。Python 依赖怎么装？', { toolchains: { python: '3.12' }, lanes: { build: ['make build'], 'pr-ready': ['make lint', 'make test'] } });
    }
    assert.equal(input.conversation.at(-1).content, '依赖用 pip install -e ".[test]"，daily 跑 make test');
    return answer('已加入安装命令和 daily。', { toolchains: { python: '3.12' }, install: ['pip install -e ".[test]"'], lanes: { 'pr-ready': ['make build', 'make lint', 'make test'], daily: ['make test'] } });
  } });
  let session = await open();
  assert.equal(session.agent.available, true);
  assert.equal(session.messages.at(-1).role, 'agent');
  assert.equal(session.revision, 1); // The agent's first plan equals the one built from certain facts, so no new revision.
  assert.deepEqual(seen[0].facts.files.Makefile, makefile);
  assert.deepEqual(seen[0].current_plan.lanes['pr-ready'], ['make build', 'make lint', 'make test']);
  assert.ok(seen[0].facts.tree.includes('src/hello/__init__.py'));
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
  assert.deepEqual(config.lanes, { 'pr-ready': { commands: ['make build', 'make lint', 'make test'] }, 'pr-merge': { commands: [] },
    daily: { commands: ['make test'], enforcement: 'observe', continueOnError: true }, release: { commands: [] } });
  // Every PR commit runs pr-ready; the merge gate runs pr-ready again and then pr-merge on the merged result.
  assert.deepEqual(config.events, { pull_request: ['pr-ready'], workflow_dispatch: ['pr-ready'], merge_group: ['pr-ready', 'pr-merge'], push: ['pr-ready', 'pr-merge'], schedule: ['daily'], release: ['release'] });
  const workflow = parse(files['.github/workflows/ci.yml']), steps = workflow.jobs.gate.steps;
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  assert.equal(workflow.jobs.gate.env.CI_GATES_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.deepEqual(steps.filter(step => step.uses).map(step => step.uses), ['actions/checkout@v4', 'actions/setup-node@v4', 'actions/setup-python@v5', 'actions/upload-artifact@v4']);
  // The code checked out is the commit the reports name.
  assert.equal(steps[0].with.ref, workflow.jobs.gate.env.CI_GATES_SHA);
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

test('a repository whose projects live in subdirectories is analyzed from its tree, README, scripts and existing CI', async t => {
  const { state, open } = await fixture(t);
  // The layout of agent-test-zone/bot-demo: no root manifest, a test script the README and CI use, a Node sub-project.
  state.repos['octo/hello'].languages = { Python: 4000, JavaScript: 2000, Shell: 300 };
  state.repos['octo/hello'].files = {
    'README.md': '# demo\n\n## Tests\n\n```sh\nsh scripts/test.sh\n```\n',
    'scripts/test.sh': '#!/bin/sh\npython3 -m unittest discover -s inventory -t . -v\n(cd textkit && node --test)\n',
    'inventory/__init__.py': '', 'inventory/stock.py': 'x = 1\n', 'inventory/test_stock.py': 'import unittest\n',
    'textkit/package.json': JSON.stringify({ name: 'textkit', scripts: { test: 'node --test' } }), 'textkit/src/index.js': '', 'textkit/test/index.test.js': '',
    '.github/workflows/ci.yml': "name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.11'\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '22'\n      - run: sh scripts/test.sh\n" };
  state.repos['octo/hello'].actionRuns = [{ path: '.github/workflows/ci.yml', event: 'pull_request', conclusion: 'success', run_started_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:01:30Z' }];
  const session = await open();
  assert.ok(session.facts.tree.includes('textkit/test/index.test.js') && session.facts.tree.includes('inventory/'));
  assert.deepEqual(session.facts.manifests.sort(), ['README.md', 'scripts/test.sh', 'textkit/package.json']);
  assert.deepEqual(session.facts.actions_runs.map(run => [run.workflow, run.minutes]), [['.github/workflows/ci.yml', 1.5]]);
  const script = session.facts.candidates.find(item => item.command === 'sh scripts/test.sh');
  assert.deepEqual([script.kind, script.certain, script.source.split('；').sort()], ['test', true, ['.github/workflows/ci.yml', 'README.md', 'scripts/test.sh']]);
  assert.ok(session.facts.candidates.some(item => item.command === '(cd textkit && npm test)' && item.certain));
  // The command the repository already runs in CI wins; the versions come from its setup steps.
  assert.deepEqual(session.plan.lanes['pr-ready'], ['sh scripts/test.sh']);
  assert.deepEqual(session.plan.toolchains, { node: '22', python: '3.11', go: '', java: '' });
  assert.match(session.messages[0].content, /最近成功的 PR 检查耗时：1\.5–1\.5 分钟/);
});

test('the agent submits its plan through a tool and fixes what validation rejects within the same turn', async t => {
  const calls = [];
  const submit = (id, args) => ({ content: null, tool_calls: [{ id, type: 'function', function: { name: 'submit_gate_plan', arguments: JSON.stringify(args) } }] });
  const plan = { toolchains: { node: '22', python: '3.12', go: '', java: '' }, install: [], lanes: { 'pr-ready': ['make build', 'make test'], 'pr-merge': ['make e2e'], daily: [], release: [] }, observe: ['daily'], workflow: '' };
  const { open } = await fixture(t, { model: async (input, n, body) => {
    calls.push(body.messages.at(-1));
    if (n === 1) { assert.ok(body.tools.some(tool => tool.function.name === 'submit_gate_plan')); return submit('a', { reply: '方案', plan: { ...plan, workflow: '.github/workflows/other.yml' } }); }
    if (n === 2) { assert.match(body.messages.at(-1).content, /gate_plan_invalid/); return submit('b', { reply: 'pr-ready 跑构建和测试，pr-merge 跑端到端。', plan }); }
    assert.match(body.messages.at(-1).content, /"accepted":true/);
    return { content: '已提交。' };
  } });
  const session = await open();
  assert.equal(calls.length, 3);
  assert.equal(session.messages.at(-1).content, 'pr-ready 跑构建和测试，pr-merge 跑端到端。');
  assert.deepEqual(session.plan.lanes['pr-merge'], ['make e2e']);
  assert.equal(session.revision, 2);
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
  assert.match(pull.body, /\*\*daily\*\*（.*，失败只记录（observe））：`make e2e`/);
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

test('an existing ci.yml and release.yml are never overwritten; by default the gate job goes beside them', async t => {
  const { state, open, confirm } = await fixture(t);
  Object.assign(state.repos['octo/hello'].files, { '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n',
    '.github/workflows/release.yml': 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs: {}\n' });
  let session = await open();
  assert.deepEqual(session.facts.workflows.map(item => [item.path, item.events, item.jobs]), [['.github/workflows/ci.yml', ['push'], ['test']], ['.github/workflows/release.yml', ['push'], []]]);
  assert.ok(session.facts.candidates.some(item => item.command === 'make test' && item.source.includes('Makefile') && item.source.includes('.github/workflows/ci.yml')));
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
  assert.ok(session.facts.questions.some(question => question.includes('release.yml')));
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
  assert.match(session.messages.at(-1).content, /右侧是仓库当前的门禁配置/);
  // The old build lane is folded into pr-ready.
  assert.deepEqual(session.plan.lanes, { 'pr-ready': ['make build', 'make lint'], 'pr-merge': [], daily: [], release: [] });
  assert.ok(session.messages.some(message => message.content.includes('原来的 build lane 已并入 pr-ready')));
  assert.deepEqual([session.plan.workflow, session.plan.install, session.plan.toolchains.python, session.plan.observe], ['.github/workflows/ci.yml', ['pip install -e .'], '3.11', []]);
  assert.equal(session.workflow_options[0].path, '.github/workflows/ci.yml');
  // The review shows what the standard gate changes: the gate job and its triggers, the event mapping replacing the build lane,
  // and the release.yml the release flow needs.
  assert.deepEqual(session.target.files.map(file => [file.path, file.mode]), [['.github/workflows/ci.yml', 'update'], ['.github/ci-gates.json', 'update'], ['.github/workflows/release.yml', 'create']]);
  const diff = session.target.files[0].diff;
  for (const line of [/^\+  merge_group:$/m, /^\+ {6}CI_GATES_SHA: /m, /^\+ {10}ref: /m, /^\+ {8}uses: actions\/upload-artifact@v4$/m, /^ {5}name: CI gate$/m, /^ {5}branches: \[main\]$/m]) assert.match(diff, line);
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
  // With a merge queue the old push trigger stays in the file, but the gate job no longer runs after merging.
  assert.ok(!workflow.jobs.checks.if.includes("'push'"));
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

test('a Node repository with dependencies but no lock file is onboarded; npm install is only asked about', async t => {
  const { state, open, confirm } = await fixture(t);
  state.repos['octo/hello'].files = { 'package.json': JSON.stringify({ name: 'hello', scripts: { build: 'tsc', test: 'node --test' }, dependencies: { leftpad: '1' } }) };
  let session = await open();
  assert.equal(session.state, 'ready');
  assert.deepEqual(session.plan.install, []);
  assert.deepEqual(session.plan.lanes['pr-ready'], ['npm run build', 'npm test']);
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
  // Plain text instead of a submitted plan is shown as the reply; the plan stays as it was.
  assert.match(session.messages.at(-1).content, /^not json\n\n（这一轮 agent 没有提交方案，右侧方案没有变化。）$/);
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
  assert.deepEqual(emptyPlan().toolchains, { node: '22', python: '', go: '', java: '' });
  assert.deepEqual([emptyPlan().observe, normalizePlan({}).observe, normalizePlan({ observe: [] }).observe], [['daily'], ['daily'], []]);
  assert.throws(() => normalizePlan({ workflow: '../ci.yml' }), PlanError);
  assert.throws(() => normalizePlan({ observe: ['nightly'] }), PlanError);
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

test('opening 接入门禁 shows the lanes first and creates nothing until the person starts', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/gate-onboarding.js'], (method, path) =>
    method === 'GET' && path === '/api/projects/101/gate-onboarding' ? [200, { session: null }] : [500, { error: 'unexpected' }]);
  await page.run("openGateOnboarding({ id: '101', full_name: 'octo/hello' }, null)");
  assert.equal(page.run('gateOnboardingView.open && gateOnboardingView.id'), 'quickstart-view');
  assert.equal(page.$('gate-onboarding-title').textContent, '接入门禁 · octo/hello');
  assert.equal(page.$('gate-onboarding-intro').hidden, false);
  assert.equal(page.$('gate-onboarding-chat').hidden, true);
  const lanes = page.$('gate-onboarding-lanes').children.filter(item => item.tagName === 'DT').map(item => item.textContent);
  assert.deepEqual(lanes, ['pr-ready', 'pr-merge', 'daily', 'release']);
  assert.ok(page.$('gate-onboarding-lanes').children.filter(item => item.tagName === 'DD').every(item => item.textContent.length > 10));
  assert.deepEqual(page.requests, ['GET /api/projects/101/gate-onboarding']);
});
