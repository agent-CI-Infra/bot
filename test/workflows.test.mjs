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
import { narrowPermissions, validatePermissions, builtinWorkflow, defaultPermissions } from '../dist/workflows/catalog.js';
import { workflowPermissions } from '../dist/workflows/resolve.js';
import { runSubagent, subagentConfig } from '../runner/subagent.mjs';
import { narrowCapabilities, toolCapabilityError } from '../runner/capabilities.mjs';

const builtins = ['review.issue', 'review.pr', 'development.issue', 'development.pr', 'release.observe', 'release.notes'];
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

test('the six built-in tasks are workflows whose prompts carry the review and development flowcharts', async t => {
  const { admin } = await project(t);
  const list = (await admin('/api/repositories/101/workflows')).value;
  assert.deepEqual(list.workflows.map(workflow => workflow.id), builtins);
  for (const workflow of list.workflows) {
    assert.equal(workflow.builtin, true);
    for (const part of ['triggers', 'prompt', 'permissions', 'model']) assert.ok(workflow[part], workflow.id + ' ' + part);
  }
  const page = flowPage(), byId = Object.fromEntries(list.workflows.map(workflow => [workflow.id, workflow]));
  for (const id of ['review.issue', 'review.pr']) assert.deepEqual(JSON.parse(flowOf(page, byId[id].prompt.effective)), ['检视 → 回复']);
  for (const id of ['development.issue', 'development.pr'])
    assert.deepEqual(JSON.parse(flowOf(page, byId[id].prompt.effective)), ['Issue 分析 → 开发 → 检视 → 测试', '检视 → 开发：发现问题', '测试 → 开发：测试失败']);
  // The drawn figure names the same steps; a prompt without a flowchart says so instead of inventing one.
  const figure = page.run(`flowFigure(parseFlow(${JSON.stringify(byId['development.issue'].prompt.effective)}))`);
  assert.equal(figure.querySelector('figcaption .flow-path').textContent, 'Issue 分析 → 开发 → 检视 → 测试');
  assert.equal(figure.querySelectorAll('rect').length, 4);
  assert.match(page.run('flowFigure(parseFlow("no chart")).querySelector("p").textContent'), /没有流程图/);
  // The prompt file is the source: the flowchart is in docs/prompts, which the model receives as the rule text.
  assert.ok(readFileSync('docs/prompts/issue-development.md', 'utf8').includes('test -->|测试失败| develop'));
  // Built-in defaults: development may start a sub-agent for its review step; reviews do not unless allowed.
  assert.equal(byId['development.issue'].permissions.agents, true); assert.equal(byId['review.pr'].permissions.agents, false);
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

test('built-in triggers keep today\'s switches: a turned-off trigger and a draft PR start no review', async t => {
  const { h, admin, a } = await project(t);
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const pr = (action, sha, draft = false) => ({ repository: { id: 101 }, action, sender: { type: 'User', login: 'alice' }, pull_request: { number: 7, draft, state: 'open', head: { sha } } });
  const hook = (id, body) => h.hook(a.path, a.secret, id, body, { 'X-GitHub-Event': 'pull_request' }).then(r => r.value.tasks_created);
  assert.equal(await hook('draft', pr('opened', 'a'.repeat(40), true)), 0);
  assert.equal(await hook('ready', pr('ready_for_review', 'a'.repeat(40))), 1);
  const saved = await admin('/api/repositories/101/workflows/review.pr', 'PUT', { triggers: { 'pull_request.synchronize': false } });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.workflow.triggers.find(trigger => trigger.id === 'pull_request.synchronize').enabled, false);
  assert.equal(h.store.get("SELECT review_pr_updates FROM policies WHERE repository_id='101'").review_pr_updates, 0);
  assert.equal(await hook('push', pr('synchronize', 'b'.repeat(40))), 0);
  // Fixed conditions cannot be switched through the workflow.
  for (const triggers of [{ 'comment.mention': false }, { 'issue.labeled': true }])
    assert.equal((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { triggers })).value.error, 'invalid_workflow_triggers');
  assert.equal((await admin('/api/repositories/101/workflows/development.issue', 'PUT', { triggers: { 'issue.labeled': false } })).value.error, 'invalid_workflow_triggers');
  // The shared switch is still the project's review switch.
  await admin('/api/repositories/101/workflows/review.issue', 'PUT', { enabled: false });
  assert.equal(await hook('reopen', pr('opened', 'c'.repeat(40))), 0);
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

test('saved permissions never exceed the workflow ceiling and choose the tools the agent gets', async t => {
  const { h, admin } = await project(t);
  for (const permissions of [{ workspace: { read: true, write: true } }, { github: ['administration'] }, { workspace: { read: false, shell: true } }, { publication: 'pull_request' }])
    assert.equal((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { permissions })).value.error, 'invalid_workflow_permissions', JSON.stringify(permissions));
  assert.equal((await admin('/api/repositories/101/workflows/release.notes', 'PUT', { permissions: { agents: true } })).value.error, 'invalid_workflow_permissions');
  const narrowed = { workspace: { read: true, write: false, notes: false, shell: false }, github: ['pull_requests', 'contents'], agents: true };
  assert.equal((await admin('/api/repositories/101/workflows/review.pr', 'PUT', { permissions: narrowed })).status, 200);
  const saved = workflowPermissions(h.store, '101', 'review.pr');
  assert.deepEqual(saved, { ...narrowed, github: ['contents', 'pull_requests'], publication: 'reply' });
  const profile = workspaceProfile('review.pr', {}, saved), names = profile.tools.map(tool => tool.function.name);
  assert.deepEqual(names.filter(name => ['run_command', 'write_file', 'read_file', 'start_agent', 'github_read_token'].includes(name)).sort(), ['github_read_token', 'read_file', 'start_agent']);
  assert.deepEqual(profile.capabilities.github.permissions, { contents: 'read', pull_requests: 'read' });
  assert.equal(profile.capabilities.workspace.shell, false); assert.equal(profile.subagentSystem, subagentSystem);
  // The runner refuses what the capabilities refuse, whatever tool the model names.
  assert.equal(toolCapabilityError({ capabilities: profile.capabilities }, 'run_command'), 'shell_not_allowed');
  assert.equal(toolCapabilityError({ capabilities: { ...profile.capabilities, agents: false } }, 'start_agent'), 'agents_not_allowed');
  // A stored row that no longer fits fails closed instead of granting more.
  h.store.run("UPDATE workflows SET permissions=? WHERE repository_id='101' AND id='review.pr'", JSON.stringify({ workspace: { read: true, write: true, shell: true }, github: ['contents', 'administration'], agents: true }));
  assert.deepEqual(workflowPermissions(h.store, '101', 'review.pr'), { workspace: { read: true, write: false, notes: false, shell: true }, github: ['contents'], agents: true, publication: 'reply' });
});

test('a sub-agent permission request can only narrow the saved permissions', () => {
  const parent = validatePermissions({ workspace: { read: true, notes: true }, github: ['contents'], agents: true }, builtinWorkflow('review.pr').ceiling);
  const child = narrowPermissions(parent, { run_commands: true, write_workspace: true, github_read: true, write_notes: false });
  assert.deepEqual(child, { workspace: { read: true, write: false, notes: false, shell: false }, github: ['contents'], agents: false, publication: 'none' });
  assert.deepEqual(narrowPermissions(defaultPermissions('development.issue'), { write_workspace: false, github_read: false }).workspace, { read: true, write: false, notes: true, shell: true });
  // The runner applies the same rule to the capabilities it received from the control plane.
  const capabilities = { workspace: { read: true, write: false, notes: true, shell: false }, github: { permissions: { contents: 'read' }, publication: 'pull_request' }, agents: true };
  assert.deepEqual(narrowCapabilities(capabilities, { run_commands: true, write_workspace: true }),
    { workspace: { read: true, write: false, notes: true, shell: false }, github: { permissions: { contents: 'read' }, publication: 'none' }, agents: false });
});

test('a runner sub-agent is a new session built only from its own instructions, with the main agent\'s tools narrowed', async () => {
  const profile = workspaceProfile('development.issue', {}, defaultPermissions('development.issue'));
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
  const review = workspaceProfile('review.pr', {}, { ...defaultPermissions('review.pr'), workspace: { read: true, write: false, notes: false, shell: false }, agents: true });
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
    triggers: [{ id: 'pull_request.opened' }, { id: 'issue.labeled', label: 'Audit' }, { id: 'comment.mention' }],
    permissions: { workspace: { read: true, notes: false, shell: false }, github: ['contents'], agents: false } });
  assert.equal(created.status, 201); const workflow = created.value.workflow;
  assert.match(workflow.id, /^custom\.[a-f0-9]{12}$/); assert.equal(workflow.builtin, false); assert.equal(workflow.prompt.effective, prompt);
  assert.deepEqual(workflow.permissions, { workspace: { read: true, write: false, notes: false, shell: false }, github: ['contents'], agents: false, publication: 'reply' });
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
  assert.equal((await admin('/api/repositories/101/workflows')).value.workflows.length, 6);
});

test('a custom workflow task runs its own prompt with its saved permissions and replies once', async t => {
  const configs = [];
  const f = await emptyRepositoryFixture(t, { execute: async request => {
    if (request.type === 'workspace_agent_config') { configs.push(Buffer.from(request.base64, 'base64')); if (request.final) configs.done = JSON.parse(Buffer.concat(configs)); }
    if (request.type === 'workspace_agent_poll') return { ok: true, result: { state: 'completed', result: { summary: 'Docs look consistent.', findings: [{ body: 'Link in README is stale.', format: 'discussion', selection_reason: 'Not on a diff line' }] } } };
  } });
  f.setBranch('ready');
  f.store.run("UPDATE tasks SET status='cancelled' WHERE id=?", f.taskId);
  const prompt = 'Check every link in the docs.\n\n```mermaid\nflowchart LR\n  read[读文档] --> reply[回复]\n```';
  const workflow = (await f.admin('/api/repositories/101/workflows', 'POST', { name: '文档检查', prompt, triggers: [{ id: 'issue.opened' }],
    permissions: { workspace: { read: true, notes: false, shell: false }, github: [], agents: false } })).value.workflow;
  const id = (await import('../dist/workflows/triggers.js')).queueWorkflows(f.store, '101', 'issues', { action: 'opened', issue: { number: 1, state: 'open', title: 'First issue', body: 'Please review this project.' }, sender: { type: 'User', login: 'alice' } }, 'delivery-1');
  assert.equal(id, 1);
  f.engine.tick(); await Promise.all(f.engine.active.values());
  const task = f.store.get("SELECT * FROM tasks WHERE kind='workflow.issue'");
  assert.equal(task.status, 'succeeded', task.error_code); assert.equal(task.workflow_id, workflow.id);
  assert.equal(f.comments.length, 1); assert.match(f.comments[0].body, /Docs look consistent\.[\s\S]*Link in README is stale\./);
  const config = configs.done;
  assert.ok(config.system.includes('## Workflow: 文档检查 (console)\n' + prompt));
  assert.doesNotMatch(config.system, /## \.bot\/rules\/issue-review\.md/);
  assert.deepEqual(config.tools.map(tool => tool.function.name), ['read_file', 'finish_review']);
  assert.deepEqual(config.capabilities, { workspace: { read: true, write: false, notes: false, shell: false }, github: { permissions: {}, publication: 'none' }, agents: false });
  // No label, no development and no review conversation come out of a custom workflow.
  assert.equal(f.store.get("SELECT count(*) n FROM tasks WHERE kind LIKE 'development.%'").n, 0);
  assert.equal(f.store.get("SELECT count(*) n FROM review_sessions").n, 0);
});

test('chat drafts a prompt with a flowchart and permissions within the ceiling; only saving makes it effective', async t => {
  const { h, admin } = await project(t);
  const draftPrompt = '检查文档。\n\n```mermaid\nflowchart LR\n  read[读文档] --> check[核对] --> reply[回复]\n  check -->|需要复核| read\n```';
  const model = await modelServer(t, () => ({ content: JSON.stringify({ reply: '已起草：读文档后核对并回复。', draft: { name: '文档检查', description: '检查文档链接',
    triggers: [{ id: 'pull_request.opened' }, { id: 'push' }], prompt: draftPrompt, permissions: { workspace: { read: true, write: true, shell: true }, github: ['contents'], agents: true } } }) }));
  const created = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'writer', api_url: model.url, api_key: 'assistant-model-key' })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: created.id });
  const reply = await admin('/api/repositories/101/workflows/assistant', 'POST', { messages: [{ role: 'user', content: 'PR 打开时检查文档链接' }] });
  assert.equal(reply.status, 201, JSON.stringify(reply.value));
  assert.equal(reply.value.reply, '已起草：读文档后核对并回复。');
  assert.equal(reply.value.draft.prompt, draftPrompt);
  assert.deepEqual(reply.value.draft.triggers, [{ id: 'pull_request.opened' }]);
  assert.deepEqual(reply.value.draft.permissions, { workspace: { read: true, write: false, notes: false, shell: true }, github: ['contents'], agents: true, publication: 'reply' });
  assert.equal(reply.value.warnings.length, 1);
  const page = flowPage();
  assert.deepEqual(JSON.parse(flowOf(page, reply.value.draft.prompt)), ['读文档 → 核对 → 回复', '核对 → 读文档：需要复核']);
  // The model saw the catalog and the ceiling; nothing was saved by the chat itself.
  assert.match(model.requests[0].messages[0].content, /start_agent/);
  assert.equal((await admin('/api/repositories/101/workflows')).value.workflows.length, 6);
  assert.equal(h.store.get('SELECT count(*) n FROM workflows').n, 0);
  const saved = await admin('/api/repositories/101/workflows', 'POST', { name: reply.value.draft.name, description: reply.value.draft.description, triggers: reply.value.draft.triggers,
    prompt: reply.value.draft.prompt, permissions: reply.value.draft.permissions });
  assert.equal(saved.status, 201);
  assert.equal(saved.value.workflow.prompt.effective, draftPrompt);
  assert.equal(h.store.get("SELECT action FROM audit WHERE action='workflow.created'").action, 'workflow.created');
  // For a built-in workflow the chat drafts its configurable triggers only.
  const builtin = await admin('/api/repositories/101/workflows/assistant', 'POST', { workflow_id: 'review.pr', messages: [{ role: 'user', content: '只在打开时检视' }] });
  assert.equal(builtin.status, 201); assert.deepEqual(builtin.value.draft.triggers, {});
  assert.equal((await admin('/api/repositories/101/workflows/assistant', 'POST', { messages: [] })).value.error, 'invalid_assistant_messages');
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
