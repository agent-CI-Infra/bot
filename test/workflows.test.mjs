import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { harness, setup, account, repository } from './helpers.mjs';
import { emptyRepositoryFixture } from './empty-repository-helpers.mjs';
import { loadConsole } from './console-page.mjs';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { runAgent, startAgentTool, subagentSystem } from '../dist/agent/runtime.js';
import { workspaceProfile } from '../dist/agent/profiles.js';
import { selectedModel } from '../dist/agent/model.js';
import { narrowPermissions, workflowAccess, githubScopes } from '../dist/workflows/catalog.js';
import { workflowPermissions } from '../dist/workflows/resolve.js';
import { runSubagent, subagentConfig } from '../runner/subagent.mjs';
import { narrowCapabilities, toolCapabilityError } from '../runner/capabilities.mjs';

const builtins = ['review.issue', 'review.pr', 'development.issue', 'development.pr', 'release.observe', 'release.notes', 'actions.failures'];
const flowPage = () => loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/workflows.js'], () => [200, {}]);
const flowOf = (page, text) => page.run(`JSON.stringify(flowText(parseFlow(${JSON.stringify(text)})))`);
// A fake Chat Completions server: respond(body, index) returns a message.
async function modelServer(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: await respond(body, requests.length) }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
async function project(t) {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  return { h, admin, a };
}

test('the built-in tasks and Actions failure handling are workflows; prompts carry the review and development flowcharts', async t => {
  const { admin } = await project(t);
  const list = (await admin('/api/repositories/101/workflows')).value;
  assert.deepEqual(list.workflows.map(workflow => workflow.id), builtins);
  // Built-in and custom workflows have the same fields, Actions failure handling included.
  for (const workflow of list.workflows) {
    assert.equal(workflow.builtin, true);
    for (const part of ['name', 'description', 'triggers', 'trigger_options', 'prompt', 'permissions', 'model']) assert.ok(workflow[part] !== undefined && workflow[part] !== null, workflow.id + ' ' + part);
    assert.equal(typeof workflow.enabled, 'boolean');
  }
  const actions = list.workflows.find(workflow => workflow.id === 'actions.failures');
  assert.deepEqual([actions.enabled, actions.triggers, actions.permissions.publication, actions.computer, actions.prompt.source], [false, [{ id: 'actions.run_failed' }], 'actions', false, 'builtin']);
  const page = flowPage(), byId = Object.fromEntries(list.workflows.map(workflow => [workflow.id, workflow]));
  for (const id of ['review.issue', 'review.pr']) assert.deepEqual(JSON.parse(flowOf(page, byId[id].prompt.effective)), ['检视 → 回复']);
  for (const id of ['development.issue', 'development.pr'])
    assert.deepEqual(JSON.parse(flowOf(page, byId[id].prompt.effective)), ['Issue 分析 → 开发 → 检视 → 测试', '检视 → 开发：发现问题', '测试 → 开发：测试失败']);
  // The drawn figure names the same steps; a prompt without a flowchart says so instead of inventing one.
  const figure = page.run(`flowFigure(parseFlow(${JSON.stringify(byId['development.issue'].prompt.effective)}))`);
  assert.equal(figure.querySelector('figcaption .flow-path').textContent, 'Issue 分析 → 开发 → 检视 → 测试');
  assert.equal(figure.querySelectorAll('rect').length, 4);
  assert.match(page.run('flowFigure(parseFlow("no chart")).querySelector("p").textContent'), /没有流程图/);
  // Triggers are drawn from the trigger list on the left, feeding the first step; they are not part of the prompt.
  const triggered = page.run(`flowFigure(parseFlow(${JSON.stringify(byId['development.issue'].prompt.effective)}), '流程图', ['检视发布结论', 'Issue 加标签：bot-develop'])`);
  const svg = (figure, tag, kind) => [...figure.querySelectorAll(tag)].filter(node => String(node.getAttribute('class')).split(' ').includes(kind));
  assert.deepEqual(svg(triggered, 'text', 'flow-trigger-label').map(node => node.textContent), ['检视发布结论', 'Issue 加标签：bot-develop']);
  assert.equal(svg(triggered, 'path', 'flow-trigger-edge').length, 2); assert.equal(svg(triggered, 'rect', 'flow-node').length, 4);
  assert.equal(triggered.querySelector('figcaption .flow-triggers').textContent, '触发源 检视发布结论、Issue 加标签：bot-develop →');
  assert.doesNotMatch(byId['development.issue'].prompt.effective, /检视发布结论/);
  const idle = page.run('flowFigure(parseFlow("no chart"), "流程图", [])');
  assert.deepEqual([svg(idle, 'text', 'flow-trigger-label')[0].textContent, svg(idle, 'path', 'flow-trigger-edge').length, svg(idle, 'text', 'flow-node-label')[0].textContent], ['没有触发源', 0, '按提示词执行']);
  // The prompt file is the source: the flowchart is in docs/prompts, which the model receives as the rule text.
  assert.ok(readFileSync('docs/prompts/issue-development.md', 'utf8').includes('test -->|测试失败| develop'));
  // Every workflow reads everything and may start agents; only development changes its checkout.
  for (const workflow of list.workflows) assert.deepEqual([workflow.permissions.agents, workflow.permissions.github, workflow.permissions.workspace.write], [true, githubScopes, workflow.id.startsWith('development.')], workflow.id);
  assert.equal(byId['development.issue'].prompt.path, '.bot/rules/issue-development.md');
  assert.deepEqual(byId['development.issue'].prompt.shared_with, ['development.pr']);
});

test('flow parsing reads chains, labels written either way, and node labels declared later', () => {
  const page = flowPage();
  const text = '```mermaid\nflowchart LR\n  a[甲] --> b --> c[丙]\n  b[乙] -- 返回 --> a\n  c -.->|跳过| a\n```';
  assert.deepEqual(JSON.parse(flowOf(page, text)), ['甲 → 乙 → 丙', '乙 → 甲：返回', '丙 → 甲：跳过']);
  assert.equal(page.run('parseFlow("```js\\nflowchart LR\\na-->b\\n```")'), null);
});

test('existing task model overrides keep applying to the workflows of the same id, and saving a workflow writes them', async t => {
  const { h, admin } = await project(t);
  const create = async name => (await admin('/api/models', 'POST', { repository_id: '101', model_name: name, api_url: 'https://model.invalid/v1', api_key: 'k'.repeat(20) })).value.model;
  const base = await create('default'), review = await create('review'), coder = await create('coder');
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: base.id, task_models: { 'review.pr': review.id, 'custom.scientific-evaluation': review.id } });
  let list = (await admin('/api/repositories/101/workflows')).value.workflows, pr = list.find(workflow => workflow.id === 'review.pr');
  assert.deepEqual([pr.model.id, pr.model.inherited], [review.id, false]);
  assert.deepEqual(list.find(workflow => workflow.id === 'review.issue').model, { id: null, inherited: true, default_id: base.id });
  const saved = await admin('/api/repositories/101/workflows/development.issue', 'PUT', { model_id: coder.id });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(h.store.get("SELECT task_models FROM policies WHERE repository_id='101'").task_models),
    { 'review.pr': review.id, 'custom.scientific-evaluation': review.id, 'development.issue': coder.id });
  assert.equal(selectedModel(h.store, '101', 'development.issue').id, coder.id);
  assert.equal(selectedModel(h.store, '101', 'custom.scientific-evaluation').id, review.id);
  await admin('/api/repositories/101/workflows/review.pr', 'PUT', { model_id: null });
  assert.equal(selectedModel(h.store, '101', 'review.pr').id, base.id);
  // A custom workflow keeps its own model; without one it follows the project default.
  const custom = (await admin('/api/repositories/101/workflows', 'POST', { name: 'Docs check', prompt: 'Check the docs.', triggers: [{ id: 'pull_request.opened' }], model_id: coder.id })).value.workflow;
  assert.equal(selectedModel(h.store, '101', custom.id).id, coder.id);
  await admin('/api/repositories/101/workflows/' + custom.id, 'PUT', { model_id: null, version: custom.version });
  assert.equal(selectedModel(h.store, '101', custom.id).id, base.id);
});

test('built-in triggers start from today\'s switches and are edited like custom ones; drafts are never reviewed', async t => {
  const { h, admin, a } = await project(t);
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const pr = (action, sha, draft = false) => ({ repository: { id: 101 }, action, sender: { type: 'User', login: 'alice' }, pull_request: { number: 7, draft, state: 'open', head: { sha } } });
  const hook = (id, body) => h.hook(a.path, a.secret, id, body, { 'X-GitHub-Event': 'pull_request' }).then(r => r.value.tasks_created);
  assert.equal(await hook('draft', pr('opened', 'a'.repeat(40), true)), 0);
  assert.equal(await hook('ready', pr('ready_for_review', 'a'.repeat(40))), 1);
  let workflow = (await admin('/api/repositories/101/workflows/review.pr')).value.workflow;
  assert.deepEqual(workflow.triggers.map(trigger => trigger.id).sort(), ['comment.mention', 'pull_request.opened', 'pull_request.synchronize', 'pull_request.updated']);
  assert.deepEqual(workflow.trigger_options.map(option => option.id), ['pull_request.opened', 'pull_request.synchronize', 'pull_request.updated', 'pull_request.labeled', 'comment.mention']);
  // The trigger list replaces the switches: head updates off, mentions off, a label trigger on.
  const saved = await admin('/api/repositories/101/workflows/review.pr', 'PUT', { triggers: [{ id: 'pull_request.opened' }, { id: 'pull_request.updated' }, { id: 'pull_request.labeled', label: 'needs-review' }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(h.store.get("SELECT review_pr_updates FROM policies WHERE repository_id='101'").review_pr_updates, 0);
  assert.equal(await hook('push', pr('synchronize', 'b'.repeat(40))), 0);
  const comment = id => ({ repository: { id: 101 }, action: 'created', sender: { type: 'User', login: 'bob' }, issue: { number: 7, state: 'open', pull_request: {} }, comment: { id, body: '@bot look', author_association: 'NONE', user: { id: 9 } } });
  assert.equal((await h.hook(a.path, a.secret, 'mention', comment(51), { 'X-GitHub-Event': 'issue_comment' })).value.tasks_created, 0);
  const label = (id, name, type = 'User', draft = false) => hook(id, { ...pr('labeled', 'a'.repeat(40), draft), label: { name }, sender: { type, login: 'carol' } });
  for (const [id, name, type, draft] of [['l1', 'other'], ['l2', 'NEEDS-REVIEW', 'Bot'], ['l3', 'needs-review', 'User', true]]) assert.equal(await label(id, name, type, draft), 0, id);
  // The review of this head is still queued, so the label joins it as an update instead of a second review.
  assert.equal(await label('l4', 'NEEDS-REVIEW'), 0);
  assert.equal(JSON.parse(h.store.get("SELECT input FROM tasks WHERE kind='review.pr'").input).merged_updates.at(-1).reason, 'labeled');
  assert.equal(h.store.get('SELECT count(*) n FROM review_updates').n, 1);
  // A policy PATCH still switches the matching trigger of a workflow with its own list.
  await admin('/api/repositories/101/policy', 'PATCH', { review_pr_updates: true });
  workflow = (await admin('/api/repositories/101/workflows/review.pr')).value.workflow;
  assert.ok(workflow.triggers.some(trigger => trigger.id === 'pull_request.synchronize'));
  // Triggers a workflow cannot have, and label triggers without a label, are refused.
  for (const triggers of [[{ id: 'issue.labeled', label: 'x' }], [{ id: 'pull_request.labeled' }], [{ id: 'release.manual' }]])
    assert.match((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { triggers })).value.error, /invalid_workflow_trigger/);
  // Each review workflow has its own switch now; the project review switch still covers both.
  assert.equal((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { enabled: false })).status, 200);
  assert.equal(await hook('reopen', pr('opened', 'c'.repeat(40))), 0);
  assert.equal((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { enabled: true })).status, 200);
  assert.equal(await hook('again', pr('opened', 'd'.repeat(40))), 1);
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: false });
  assert.equal(await hook('off', pr('opened', 'e'.repeat(40))), 0);
});

test('development triggers can be switched while the control plane keeps the development conditions', async t => {
  const { h, admin, a } = await project(t);
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  const review = { summary: 's', requires_code_change: true, issue_requests_code: true, clarification_required: false, implementation_goal: 'Fix add', request_quote: 'Fix add.', findings: [], object_hash: 'h' }, now = new Date().toISOString();
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)", JSON.stringify(review), now, now);
  const labeled = async (delivery, assignees = []) => (await h.hook(a.path, a.secret, delivery, { repository: { id: 101 }, action: 'labeled', label: { name: 'bot-develop' }, sender: { id: 5, type: 'User' },
    issue: { number: 5, title: 'Fix add.', body: 'Please fix.', state: 'open', labels: [{ name: 'bot-develop' }], assignees } })).value.tasks_created;
  const options = (await admin('/api/repositories/101/workflows/development.issue')).value.workflow.trigger_options;
  assert.deepEqual(options.map(option => [option.id, option.label, option.fixed_label ?? null]), [['review.published', false, null], ['issue.labeled', false, 'bot-develop']]);
  // Without the label trigger a person's label starts nothing; with it, the conditions still apply.
  assert.equal((await admin('/api/repositories/101/workflows/development.issue', 'PUT', { triggers: [{ id: 'review.published' }] })).status, 200);
  assert.equal(await labeled('d1'), 0);
  assert.equal((await admin('/api/repositories/101/workflows/development.issue', 'PUT', { triggers: [{ id: 'issue.labeled' }] })).status, 200);
  assert.equal(await labeled('d2', [{ login: 'someone' }]), 0);
  assert.equal(await labeled('d3'), 1);
  // Switching the workflow off stops its queued task at the next check.
  assert.equal((await admin('/api/repositories/101/workflows/development.issue', 'PUT', { enabled: false })).status, 200);
  const { workflowActive } = await import('../dist/workflows/resolve.js');
  assert.equal(workflowActive(h.store, '101', 'development.issue'), false);
  assert.equal(await labeled('d4'), 0);
});

test('Actions failure handling is a workflow: its switch is the policy switch and its trigger gates the module', async t => {
  const { h, admin } = await project(t);
  const { actionsWorkflowOn } = await import('../dist/actions/storage.js');
  assert.equal(actionsWorkflowOn(h.store, '101'), false);
  assert.equal((await admin('/api/repositories/101/workflows/actions.failures', 'PUT', { enabled: true })).status, 200);
  assert.equal(h.store.get("SELECT actions_failures_enabled FROM policies WHERE repository_id='101'").actions_failures_enabled, 1);
  assert.ok(h.store.get("SELECT enabled_at FROM actions_failure_scans WHERE repository_id='101'").enabled_at);
  assert.equal(actionsWorkflowOn(h.store, '101'), true);
  assert.equal((await admin('/api/repositories/101/workflows/actions.failures', 'PUT', { triggers: [] })).status, 200);
  assert.equal(actionsWorkflowOn(h.store, '101'), false);
  // Its analysis prompt is edited like any workflow's; it runs in the control plane and reads all of GitHub.
  assert.equal((await admin('/api/repositories/101/workflows/actions.failures', 'PUT', { prompt: 'Treat npm registry errors as external.' })).status, 200);
  const workflow = (await admin('/api/repositories/101/workflows/actions.failures')).value.workflow;
  assert.deepEqual([workflow.enabled, workflow.active, workflow.triggers, workflow.prompt.source, workflow.permissions.github, workflow.computer], [true, true, [], 'console', githubScopes, false]);
  const builtin = workflow.prompt.layers[0].content;
  assert.equal(flowOf(flowPage(), builtin), JSON.stringify(['读取日志 → 分析原因 → 重跑一次 → 提报 Issue → 检视 Issue', '分析原因 → 提报 Issue：代码或不明原因']));
});

test('built-in workflows take a name and description like custom ones, and release workflows can be switched off', async t => {
  const { h, admin } = await project(t);
  assert.equal((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { name: 'PR 检视（主仓）', description: '只看核心模块' })).status, 200);
  let workflow = (await admin('/api/repositories/101/workflows/review.pr')).value.workflow;
  assert.deepEqual([workflow.name, workflow.description, workflow.default_name], ['PR 检视（主仓）', '只看核心模块', '检视 PR']);
  await admin('/api/repositories/101/workflows/review.pr', 'PUT', { name: '' });
  assert.equal((await admin('/api/repositories/101/workflows/review.pr')).value.workflow.name, '检视 PR');
  const { activeTrigger } = await import('../dist/workflows/resolve.js');
  assert.ok(activeTrigger(h.store, '101', 'release.observe', 'release.manual'));
  assert.equal((await admin('/api/repositories/101/workflows/release.observe', 'PUT', { enabled: false })).status, 200);
  assert.equal(activeTrigger(h.store, '101', 'release.observe', 'release.manual'), undefined);
  workflow = (await admin('/api/repositories/101/workflows/release.notes')).value.workflow;
  assert.equal((await admin('/api/repositories/101/workflows/release.notes', 'PUT', { triggers: [], version: workflow.version })).status, 200);
  assert.equal(activeTrigger(h.store, '101', 'release.notes', 'release.manual'), undefined);
});

test('a workflow prompt replaces the rule file console layer, the repository file still wins, and the development label stays required', async t => {
  const { h, admin, a } = await project(t);
  const prompt = 'Review only the public API.\n\n```mermaid\nflowchart LR\n  review[检视] --> reply[回复]\n```';
  assert.equal((await admin('/api/repositories/101/workflows/review.issue', 'PUT', { prompt })).status, 200);
  assert.equal(JSON.parse(h.store.get("SELECT rule_overrides FROM policies WHERE repository_id='101'").rule_overrides)['.bot/rules/issue-review.md'], prompt);
  let workflow = (await admin('/api/repositories/101/workflows/review.issue')).value.workflow;
  assert.deepEqual([workflow.prompt.source, workflow.prompt.effective], ['console', prompt]);
  // A repository file on the default branch replaces the console text.
  h.store.run("INSERT INTO repository_rule_sources VALUES('101',?,?,?)", 'a'.repeat(40), JSON.stringify({ '.bot/rules/issue-review.md': 'Repository review rules.' }), new Date().toISOString());
  workflow = (await admin('/api/repositories/101/workflows/review.issue')).value.workflow;
  assert.deepEqual([workflow.prompt.source, workflow.prompt.effective, workflow.prompt.layers.map(layer => layer.source)], ['repository', 'Repository review rules.', ['builtin', 'console', 'repository']]);
  // A development prompt without the label line keeps bot-develop; an invalid label is refused.
  assert.equal((await admin('/api/repositories/101/workflows/development.issue', 'PUT', { prompt: 'Implement it.' })).status, 200);
  assert.equal((await admin('/api/repositories/101/rules')).value.rules.development_label, 'bot-develop');
  assert.equal((await admin('/api/repositories/101/workflows/development.issue', 'PUT', { prompt: 'development_label: " bad"\n' })).value.error, 'invalid_bot_label');
  // The control plane still requires a person's development label and an unassigned Issue.
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  const review = { summary: 's', requires_code_change: true, issue_requests_code: true, clarification_required: false, implementation_goal: 'Fix add', request_quote: 'Fix add.', findings: [], object_hash: 'h' }, now = new Date().toISOString();
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)", JSON.stringify(review), now, now);
  const labeled = async (delivery, name, type, assignees = []) => (await h.hook(a.path, a.secret, delivery, { repository: { id: 101 }, action: 'labeled', label: { name }, sender: { id: 5, type },
    issue: { number: 5, title: 'Fix add.', body: 'Please fix.', state: 'open', labels: [{ name }], assignees } })).value.tasks_created;
  assert.equal(await labeled('l1', 'bot-develop', 'Bot'), 0);
  assert.equal(await labeled('l2', 'bot-develop', 'User', [{ login: 'someone' }]), 0);
  assert.equal(await labeled('l3', 'bot-develop', 'User'), 1);
  // The policy test command the control plane runs before publishing is a setting of the development workflows.
  assert.equal((await admin('/api/repositories/101/workflows/development.pr', 'PUT', { settings: { test_command: 'npm test' } })).status, 200);
  assert.equal(h.store.get("SELECT test_command FROM policies WHERE repository_id='101'").test_command, 'npm test');
});

test('reading is open to every workflow and writing follows its type; permissions are not configured', async t => {
  const { h, admin } = await project(t);
  // The editor has no permissions to save, built-in or custom.
  assert.equal((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { permissions: { agents: false } })).status, 400);
  assert.equal((await admin('/api/repositories/101/workflows', 'POST', { name: 'x', prompt: 'y', permissions: { agents: false } })).status, 400);
  for (const id of ['review.issue', 'review.pr', 'release.observe', 'release.notes', 'actions.failures', 'custom'])
    assert.deepEqual(workflowAccess(id), { workspace: { read: true, write: false, notes: true, shell: true }, github: githubScopes, agents: true,
      publication: { 'review.issue': 'reply', 'review.pr': 'reply', 'release.observe': 'none', 'release.notes': 'release_notes', 'actions.failures': 'actions', custom: 'reply' }[id] }, id);
  assert.equal(workflowAccess('development.issue').workspace.write, true); assert.equal(workflowAccess('development.pr').publication, 'pull_request');
  // Permissions saved while they were configurable no longer narrow anything, and never widen writing.
  h.store.run("INSERT INTO workflows(repository_id,id,permissions,created_at,updated_at) VALUES('101','review.pr',?,'','')", JSON.stringify({ workspace: { read: true, write: true, shell: false }, github: ['contents'], agents: false }));
  const permissions = workflowPermissions(h.store, '101', 'review.pr');
  assert.deepEqual(permissions, workflowAccess('review.pr'));
  const profile = workspaceProfile('review.pr', {}, permissions), names = profile.tools.map(tool => tool.function.name);
  for (const name of ['read_file', 'run_command', 'write_file', 'start_agent', 'github_read_token']) assert.ok(names.includes(name), name);
  // write_file writes project notes only: the checkout stays read-only.
  assert.match(profile.tools.find(tool => tool.function.name === 'write_file').function.description, /project note at \.\.\/notes\/<name> only/);
  assert.equal(profile.capabilities.workspace.write, false);
  assert.deepEqual(profile.capabilities.github, { permissions: Object.fromEntries(githubScopes.map(scope => [scope, 'read'])), publication: 'none' });
  assert.equal(profile.subagentSystem, subagentSystem);
  // The runner still refuses what the capabilities refuse, whatever tool the model names.
  assert.equal(toolCapabilityError({ capabilities: { ...profile.capabilities, workspace: { ...profile.capabilities.workspace, shell: false } } }, 'run_command'), 'shell_not_allowed');
  assert.equal(toolCapabilityError({ capabilities: { ...profile.capabilities, agents: false } }, 'start_agent'), 'agents_not_allowed');
  // A deleted custom workflow runs nothing.
  assert.throws(() => workflowPermissions(h.store, '101', 'custom.000000000000'), /workflow_not_found/);
});

test('a sub-agent permission request can only narrow the main agent\'s permissions', () => {
  const parent = { ...workflowAccess('review.pr'), workspace: { read: true, write: false, notes: true, shell: false }, github: ['contents'] };
  const child = narrowPermissions(parent, { run_commands: true, write_workspace: true, github_read: true, write_notes: false });
  assert.deepEqual(child, { workspace: { read: true, write: false, notes: false, shell: false }, github: ['contents'], agents: false, publication: 'none' });
  assert.deepEqual(narrowPermissions(workflowAccess('development.issue'), { write_workspace: false, github_read: false }).workspace, { read: true, write: false, notes: true, shell: true });
  // The runner applies the same rule to the capabilities it received from the control plane.
  const capabilities = { workspace: { read: true, write: false, notes: true, shell: false }, github: { permissions: { contents: 'read' }, publication: 'pull_request' }, agents: true };
  assert.deepEqual(narrowCapabilities(capabilities, { run_commands: true, write_workspace: true }),
    { workspace: { read: true, write: false, notes: true, shell: false }, github: { permissions: { contents: 'read' }, publication: 'none' }, agents: false });
});

test('a runner sub-agent is a new session built only from its own instructions, with the main agent\'s tools narrowed', async () => {
  const profile = workspaceProfile('development.issue', {}, workflowAccess('development.issue'));
  const config = { system: 'MAIN SYSTEM', prompt: 'MAIN PROMPT with the Issue', tools: profile.tools, capabilities: profile.capabilities, workspace_id: 'w', subagent_system: profile.subagentSystem };
  const created = [], events = [];
  const result = await runSubagent({ config, id: 'agent-1', writeEvent: async event => { events.push(event); },
    args: { name: 'reviewer', instructions: 'Review the diff.', task: 'Report defects in git diff.', permissions: { write_workspace: false, run_commands: true } },
    createSession: async (child, id) => { created.push({ child, id }); let asked; return { prompt: async text => { asked = text; }, getLastAssistantText: () => 'No defects in ' + asked, dispose() {} }; } });
  assert.equal(created.length, 1); const { child } = created[0];
  assert.equal(child.system, subagentSystem + '\n\nReview the diff.'); assert.equal(child.prompt, 'Report defects in git diff.');
  assert.doesNotMatch(JSON.stringify(child.system + child.prompt), /MAIN SYSTEM|MAIN PROMPT/);
  const names = child.tools.map(tool => tool.function.name);
  for (const reserved of ['create_pull_request', 'finish_review', 'start_agent']) assert.ok(!names.includes(reserved), reserved);
  assert.ok(names.includes('run_command') && names.includes('write_file'));
  assert.deepEqual([child.capabilities.workspace.write, child.capabilities.github.publication, child.capabilities.agents], [false, 'none', false]);
  assert.deepEqual(result, { agent_id: 'agent-1', tools: names, result: 'No defects in Report defects in git diff.' });
  assert.deepEqual(events.map(event => event.type), ['agent_start', 'agent_end']);
  // A main agent without the agents capability cannot start one, and a child of a read-only parent stays read-only.
  assert.deepEqual(await runSubagent({ config: { ...config, capabilities: { ...config.capabilities, agents: false } }, args: { instructions: 'x', task: 'y' }, id: 'a', createSession: async () => assert.fail(), writeEvent: async () => {} }), { error: 'start_agent_not_allowed' });
  const review = workspaceProfile('review.pr', {}, { ...workflowAccess('review.pr'), workspace: { read: true, write: false, notes: false, shell: false } });
  const reader = subagentConfig({ ...config, tools: review.tools, capabilities: review.capabilities }, { instructions: 'x', task: 'y', permissions: { run_commands: true, write_notes: true, write_workspace: true } });
  assert.deepEqual(reader.tools.map(tool => tool.function.name).filter(name => ['run_command', 'write_file'].includes(name)), []);
});

test('a control-plane sub-agent has its own messages and at most the caller\'s tools', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 7)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','test','github_app','1','{}',?)", new Date().toISOString());
  store.run("INSERT INTO repositories VALUES('r','fixture/repo','o','a')");
  const call = (name, args = {}) => ({ id: 'c' + Math.random().toString(16).slice(2, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const model = await modelServer(t, (body, index) => {
    const child = body.messages[0].content.startsWith(subagentSystem);
    if (index === 1) return { content: null, tool_calls: [call('start_agent', { name: 'checker', instructions: 'Check one log.', task: 'Read job 1.', permissions: { github_read: true } })] };
    if (child && !body.messages.some(message => message.role === 'tool')) return { content: null, tool_calls: [call('publish_release'), call('inspect')] };
    if (child) return { content: 'Job 1 failed on a timeout.' };
    return { content: 'Parent conclusion.' };
  });
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','r',?,?,?,?)", model.url, 'fixture', store.secrets.seal({ value: 'secret-model-key' }, 'model:m'), new Date().toISOString());
  store.run("INSERT INTO policies(repository_id,model_id) VALUES('r','m')");
  const inspect = { type: 'function', function: { name: 'inspect', description: 'Read only.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
  const executed = [];
  const result = await runAgent({ store, task: { id: 'run', repository_id: 'r', kind: 'release.observe' }, redactor: new Redactor(), guard: async () => {},
    system: 'PARENT SYSTEM', prompt: 'PARENT PROMPT', tools: [inspect, startAgentTool], execute: async name => { executed.push(name); return { ok: true }; },
    agents: { system: subagentSystem, tools: () => [inspect, startAgentTool, { type: 'function', function: { name: 'publish_release', parameters: {} } }] } });
  assert.equal(result, 'Parent conclusion.');
  const childRequests = model.requests.filter(body => body.messages[0].content.startsWith(subagentSystem));
  assert.equal(childRequests.length, 2);
  // The child's first request holds only its own system prompt and task, never the caller's conversation.
  assert.deepEqual(childRequests[0].messages.map(message => message.role), ['system', 'user']);
  assert.equal(childRequests[0].messages[1].content, 'Read job 1.');
  assert.ok(!JSON.stringify(childRequests).includes('PARENT'));
  // Tools the caller lacks are not offered, and the child cannot start more agents or call an unoffered tool.
  assert.deepEqual(childRequests[0].tools.map(tool => tool.function.name), ['inspect']);
  assert.ok(childRequests[1].messages.some(message => message.role === 'tool' && message.content.includes('tool_not_allowed')));
  assert.deepEqual(executed, ['inspect']);
  const parentFinal = model.requests.at(-1);
  assert.ok(parentFinal.messages.some(message => message.role === 'tool' && message.content.includes('Job 1 failed on a timeout.')));
});

test('custom workflows trigger on the catalog events with today\'s filters, and stop when switched off or deleted', async t => {
  const { h, admin, a } = await project(t);
  const prompt = 'Check the docs.\n\n```mermaid\nflowchart LR\n  read[读文档] --> reply[回复]\n```';
  const created = await admin('/api/repositories/101/workflows', 'POST', { name: '文档检查', description: 'docs', prompt,
    triggers: [{ id: 'pull_request.opened' }, { id: 'issue.labeled', label: 'Audit' }, { id: 'comment.mention' }] });
  assert.equal(created.status, 201); const workflow = created.value.workflow;
  assert.match(workflow.id, /^custom\.[a-f0-9]{12}$/); assert.equal(workflow.builtin, false); assert.equal(workflow.prompt.effective, prompt);
  assert.deepEqual(workflow.permissions, workflowAccess('custom')); assert.equal(workflow.computer, true);
  for (const body of [{ name: 'x', prompt: 'y', permissions: { workspace: { read: true, write: true } } }, { name: 'x', prompt: 'y', triggers: [{ id: 'issue.labeled' }] }, { name: 'x', prompt: 'y', triggers: [{ id: 'push' }] }, { name: '', prompt: 'y' }])
    assert.equal((await admin('/api/repositories/101/workflows', 'POST', body)).status, 400, JSON.stringify(body));
  const tasks = () => h.store.all("SELECT kind,workflow_id,object_number,head_sha FROM tasks WHERE kind LIKE 'workflow.%' ORDER BY created_at,rowid");
  const pr = (action, draft = false, sha = 'a'.repeat(40)) => ({ repository: { id: 101 }, action, sender: { type: 'User', login: 'alice' }, pull_request: { number: 8, draft, state: 'open', title: 't', head: { sha } } });
  const hook = (id, body, event) => h.hook(a.path, a.secret, id, body, { 'X-GitHub-Event': event }).then(r => r.value.tasks_created);
  // Review is off for the project; custom workflows have their own switch.
  assert.equal(await hook('d1', pr('opened', true), 'pull_request'), 0);
  assert.equal(await hook('d2', pr('opened'), 'pull_request'), 1);
  assert.equal(await hook('d3', pr('opened'), 'pull_request'), 0, 'the same head runs once');
  const issue = { number: 3, state: 'open', title: 'i', body: 'b', labels: [{ name: 'audit' }] };
  assert.equal(await hook('d4', { repository: { id: 101 }, action: 'labeled', label: { name: 'audit' }, sender: { type: 'Bot' }, issue }, 'issues'), 0);
  assert.equal(await hook('d5', { repository: { id: 101 }, action: 'labeled', label: { name: 'other' }, sender: { type: 'User' }, issue }, 'issues'), 0);
  assert.equal(await hook('d6', { repository: { id: 101 }, action: 'labeled', label: { name: 'AUDIT' }, sender: { type: 'User' }, issue }, 'issues'), 1);
  const comment = (id, body, sender = { type: 'User', login: 'bob' }) => ({ repository: { id: 101 }, action: 'created', sender, issue: { number: 3, state: 'open', title: 'i', body: 'b' }, comment: { id, body, author_association: 'NONE', user: { id: 9 } } });
  assert.equal(await hook('d7', comment(41, 'no mention'), 'issue_comment'), 0);
  assert.equal(await hook('d8', comment(42, '<!-- dept-bot:x --> @bot'), 'issue_comment'), 0);
  assert.equal(await hook('d9', comment(43, 'please @bot check'), 'issue_comment'), 1);
  assert.deepEqual(tasks().map(task => [task.kind, task.workflow_id, task.object_number]), [['workflow.pr', workflow.id, 8], ['workflow.issue', workflow.id, 3], ['workflow.issue', workflow.id, 3]]);
  assert.equal(tasks()[0].head_sha, 'a'.repeat(40));
  // The built-in review did not run: the project review switch is off.
  assert.equal(h.store.get("SELECT count(*) n FROM tasks WHERE kind LIKE 'review.%'").n, 0);
  const off = await admin('/api/repositories/101/workflows/' + workflow.id, 'PUT', { enabled: false, version: workflow.version });
  assert.equal(off.status, 200);
  assert.equal(await hook('d10', pr('synchronize', false, 'b'.repeat(40)), 'pull_request'), 0);
  assert.equal((await admin('/api/repositories/101/workflows/' + workflow.id, 'PUT', { enabled: true, version: workflow.version })).value.error, 'workflow_version_conflict');
  assert.equal((await admin('/api/repositories/101/workflows/review.issue', 'DELETE', {})).value.error, 'builtin_workflow_required');
  assert.equal((await admin('/api/repositories/101/workflows/' + workflow.id, 'DELETE', {})).status, 200);
  assert.deepEqual(h.store.all("SELECT DISTINCT status,error_code FROM tasks WHERE kind LIKE 'workflow.%'").map(row => [row.status, row.error_code]), [['cancelled', 'workflow_deleted']]);
  assert.equal((await admin('/api/repositories/101/workflows')).value.workflows.length, builtins.length);
});

test('a custom workflow task runs its own prompt, reads everything, writes nothing itself and replies once', async t => {
  const configs = [];
  const f = await emptyRepositoryFixture(t, { execute: async request => {
    if (request.type === 'workspace_agent_config') { configs.push(Buffer.from(request.base64, 'base64')); if (request.final) configs.done = JSON.parse(Buffer.concat(configs)); }
    if (request.type === 'workspace_agent_poll') return { ok: true, result: { state: 'completed', result: { summary: 'Docs look consistent.', findings: [{ body: 'Link in README is stale.', format: 'discussion', selection_reason: 'Not on a diff line' }] } } };
  } });
  f.setBranch('ready');
  f.store.run("UPDATE tasks SET status='cancelled' WHERE id=?", f.taskId);
  const prompt = 'Check every link in the docs.\n\n```mermaid\nflowchart LR\n  read[读文档] --> reply[回复]\n```';
  const workflow = (await f.admin('/api/repositories/101/workflows', 'POST', { name: '文档检查', prompt, triggers: [{ id: 'issue.opened' }] })).value.workflow;
  const id = (await import('../dist/workflows/triggers.js')).queueWorkflows(f.store, '101', 'issues', { action: 'opened', issue: { number: 1, state: 'open', title: 'First issue', body: 'Please review this project.' }, sender: { type: 'User', login: 'alice' } }, 'delivery-1');
  assert.equal(id, 1);
  f.engine.tick(); await Promise.all(f.engine.active.values());
  const task = f.store.get("SELECT * FROM tasks WHERE kind='workflow.issue'");
  assert.equal(task.status, 'succeeded', task.error_code); assert.equal(task.workflow_id, workflow.id);
  assert.equal(f.comments.length, 1); assert.match(f.comments[0].body, /Docs look consistent\.[\s\S]*Link in README is stale\./);
  const config = configs.done;
  assert.ok(config.system.includes('## Workflow: 文档检查 (console)\n' + prompt));
  assert.doesNotMatch(config.system, /## \.bot\/rules\/issue-review\.md/);
  const names = config.tools.map(tool => tool.function.name);
  for (const name of ['read_file', 'run_command', 'write_file', 'github_read_token', 'start_agent', 'finish_review']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('create_pull_request'));
  assert.deepEqual(config.capabilities, { workspace: { read: true, write: false, notes: true, shell: true }, github: { permissions: Object.fromEntries(githubScopes.map(scope => [scope, 'read'])), publication: 'none' }, agents: true });
  // No label, no development and no review conversation come out of a custom workflow.
  assert.equal(f.store.get("SELECT count(*) n FROM tasks WHERE kind LIKE 'development.%'").n, 0);
  assert.equal(f.store.get("SELECT count(*) n FROM review_sessions").n, 0);
});

// The assistant's model: it reads the workflows, proposes a draft through update_draft and streams its last message.
async function assistantModel(t, draft) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    const last = body.messages.at(-1), tool = name => body.messages.some(message => message.role === 'tool' && body.messages.find(m => m.tool_calls?.some(c => c.id === message.tool_call_id && c.function.name === name)));
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    if (last.role !== 'tool' || !tool('update_draft') && !tool('list_workflows')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '先看现有工作流。', tool_calls: [call('c1', 'list_workflows', {})] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    }
    if (!tool('update_draft')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call('c2', 'update_draft', draft)] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    }
    // The last message streams in pieces, as a provider sends it.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['已起草：', '读文档后核对', '并回复。']) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test('the assistant works like an agent: it reads workflows, proposes a checked draft, streams its work, and saves nothing', async t => {
  const { h, admin } = await project(t);
  const draftPrompt = '检查文档。\n\n```mermaid\nflowchart LR\n  read[读文档] --> check[核对] --> reply[回复]\n  check -->|需要复核| read\n```';
  // A model that still proposes permissions has them dropped: there are none to configure.
  const draft = { name: '文档检查', description: '检查文档链接', triggers: [{ id: 'pull_request.opened' }, { id: 'push' }], prompt: draftPrompt,
    permissions: { workspace: { read: true, write: true, shell: true }, github: ['contents'], agents: true } };
  const model = await assistantModel(t, draft);
  const created = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'writer', api_url: model.url, api_key: 'assistant-model-key' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: created.id });
  const reply = await admin('/api/repositories/101/workflows/assistant', 'POST', { messages: [{ role: 'user', content: 'PR 打开时检查文档链接' }] });
  assert.equal(reply.status, 201, JSON.stringify(reply.value));
  assert.equal(reply.value.reply, '已起草：读文档后核对并回复。');
  assert.equal(reply.value.draft.prompt, draftPrompt);
  assert.deepEqual(reply.value.draft.triggers, [{ id: 'pull_request.opened' }]);
  assert.equal(reply.value.draft.permissions, undefined);
  assert.deepEqual(reply.value.warnings, ['有触发源不在这条工作流的目录里，或按标签触发时缺少标签名，已去掉。']);
  const page = flowPage();
  assert.deepEqual(JSON.parse(flowOf(page, reply.value.draft.prompt)), ['读文档 → 核对 → 回复', '核对 → 读文档：需要复核']);
  // The model was told reading is open, writing follows the type and GitHub writes belong to the control plane; it saw the workflows it asked for.
  const system = model.requests[0].messages[0].content;
  assert.match(system, /Reading is never restricted/); assert.match(system, /start_agent/); assert.match(system, /control plane publishes what the type allows \(reply\)/);
  assert.doesNotMatch(JSON.stringify(model.requests[0].tools), /permissions/);
  assert.deepEqual(model.requests[0].tools.map(tool => tool.function.name), ['update_draft', 'list_workflows']);
  assert.ok(JSON.parse(model.requests[1].messages.at(-1).content).some(workflow => workflow.id === 'review.pr'));
  assert.equal((await admin('/api/repositories/101/workflows')).value.workflows.length, builtins.length);
  assert.equal(h.store.get('SELECT count(*) n FROM workflows').n, 0);
  // The streamed form sends each step as one JSON line: text, tool calls with their results, the draft, then done.
  const stream = await fetch(h.admin + '/api/repositories/101/workflows/assistant?stream=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie(), 'X-CSRF-Token': admin.csrf() },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'PR 打开时检查文档链接' }] }) });
  assert.equal(stream.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const events = (await stream.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.type === 'tool_call').map(event => event.name), ['list_workflows', 'update_draft']);
  assert.equal(events.filter(event => event.type === 'tool_result').length, 2);
  assert.equal(events.find(event => event.type === 'draft').draft.prompt, draftPrompt);
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.delta), ['先看现有工作流。', '已起草：', '读文档后核对', '并回复。']);
  assert.deepEqual([events.at(-1).type, events.at(-1).reply], ['done', '已起草：读文档后核对并回复。']);
  // Saving is the administrator's own step.
  const saved = await admin('/api/repositories/101/workflows', 'POST', { name: reply.value.draft.name, description: reply.value.draft.description, triggers: reply.value.draft.triggers,
    prompt: reply.value.draft.prompt });
  assert.equal(saved.status, 201);
  assert.equal(saved.value.workflow.prompt.effective, draftPrompt);
  assert.equal(h.store.get("SELECT action FROM audit WHERE action='workflow.created'").action, 'workflow.created');
  // For a built-in workflow the assistant drafts the same fields, keeping only triggers that workflow can have.
  const builtin = await admin('/api/repositories/101/workflows/assistant', 'POST', { workflow_id: 'review.pr', messages: [{ role: 'user', content: '只在打开时检视' }] });
  assert.equal(builtin.status, 201); assert.deepEqual(builtin.value.draft.triggers, [{ id: 'pull_request.opened' }]);
  assert.equal((await admin('/api/repositories/101/workflows/assistant', 'POST', { messages: [] })).value.error, 'invalid_assistant_messages');
  assert.equal((await fetch(h.admin + '/api/repositories/101/workflows/assistant?stream=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie(), 'X-CSRF-Token': admin.csrf() },
    body: JSON.stringify({ messages: [] }) })).status, 400);
});

test('a project administrator manages only their own project\'s workflows', async t => {
  const { h, admin, a } = await project(t);
  await repository(admin, a.id, '202');
  const password = 'p'.repeat(16);
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member('/api/repositories/101/workflows')).status, 200);
  assert.equal((await member('/api/repositories/202/workflows')).status, 403);
  assert.equal((await member('/api/repositories/202/workflows', 'POST', { name: 'x', prompt: 'y' })).status, 403);
  assert.equal((await member('/api/repositories/101/workflows', 'POST', { name: 'x', prompt: 'y'.repeat(3 * 1024 * 1024) })).status, 201, 'no size limit of its own');
});
