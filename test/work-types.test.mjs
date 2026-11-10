import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, saveManager, managerSection } from './helpers.mjs';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { runAgent, startAgentTool, subagentSystem } from '../dist/agent/runtime.js';
import { workspaceProfile } from '../dist/agent/profiles.js';
import { selectedModel } from '../dist/agent/model.js';
import { narrowPermissions, workAccess as workflowAccess, githubScopes, defaultWrites, workTypes, writeOptions } from '../dist/work/catalog.js';
import { workPermissions, managerPrompt, parseSections, withSection, ruleOverrides } from '../dist/work/settings.js';
import { runSubagent, subagentConfig } from '../runner/subagent.mjs';
import { narrowCapabilities, toolCapabilityError } from '../runner/capabilities.mjs';

// Work types replace workflows (#207): a fixed catalog whose switches and writes are project configuration, described by
// the sections of one Manager prompt.
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

test('the work types are the former built-in workflows plus reply and scheduled checks, each with a model of its own', async t => {
  assert.deepEqual(workTypes.map(work => work.id), ['review.issue', 'review.pr', 'development.issue', 'development.pr', 'reply', 'release.observe', 'release.notes', 'actions.failures', 'gate.onboarding', 'task.request']);
  const { h, admin } = await project(t);
  const create = async name => (await admin('/api/models', 'POST', { repository_id: '101', model_name: name, api_url: 'https://model.invalid/v1', api_key: 'k'.repeat(20) })).value.model;
  const base = await create('default'), review = await create('review'), manager = await create('manager');
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: base.id, task_models: { 'review.pr': review.id, manager: manager.id, 'custom.scientific-evaluation': review.id } });
  assert.equal(selectedModel(h.store, '101', 'review.pr').id, review.id);
  assert.equal(selectedModel(h.store, '101', 'manager').id, manager.id, 'the dispatch call has a model of its own');
  assert.equal(selectedModel(h.store, '101', 'reply').id, base.id);
  const view = (await admin('/api/repositories/101/manager')).value.manager;
  assert.deepEqual(view.work.find(work => work.id === 'review.pr').model, { id: review.id, inherited: false, default_id: base.id });
  assert.deepEqual(view.dispatch_model, { id: manager.id, inherited: false, default_id: base.id });
});

test('a Manager section is the console layer of its rule file; the repository file still wins and the development label stays required', async t => {
  const { h, admin, a } = await project(t);
  assert.equal((await saveManager(admin, '101', { content: '## 检视 Issue `review.issue`\n\nReview only the public API.\n' })).status, 200);
  assert.equal(JSON.parse(h.store.get("SELECT rule_overrides FROM policies WHERE repository_id='101'").rule_overrides)['.bot/rules/issue-review.md'], 'Review only the public API.');
  assert.equal(await managerSection(admin, '101', 'review.issue'), 'Review only the public API.');
  // The rules API writes the same section.
  assert.equal((await admin('/api/repositories/101/rules', 'PUT', { path: '.bot/guide.md', content: 'Be brief.' })).status, 200);
  assert.match((await admin('/api/repositories/101/manager')).value.manager.prompt.content, /## 行为指南\nBe brief\./);
  // A repository file on the default branch replaces the section.
  h.store.run("INSERT INTO repository_rule_sources VALUES('101',?,?,?)", 'a'.repeat(40), JSON.stringify({ '.bot/rules/issue-review.md': 'Repository review rules.' }), new Date().toISOString());
  const section = (await admin('/api/repositories/101/manager')).value.manager.sections.find(entry => entry.id === 'review.issue');
  assert.deepEqual([section.effective_source, section.effective, section.content], ['repository', 'Repository review rules.', 'Review only the public API.']);
  // A development section without the label line keeps bot-develop; an invalid label is refused.
  const current = managerPrompt(h.store, '101').content;
  assert.equal((await saveManager(admin, '101', { content: withSection(current, 'development', 'Implement it.') })).status, 200);
  assert.equal((await admin('/api/repositories/101/rules')).value.rules.development_label, 'bot-develop');
  const refused = await saveManager(admin, '101', { content: withSection(current, 'development', 'development_label: " bad"') });
  assert.equal(refused.value.error, 'invalid_bot_label');
  // Unknown and repeated sections are refused; headings inside fenced blocks are text.
  assert.equal((await saveManager(admin, '101', { content: '## X `nope`\n' })).value.error, 'unknown_manager_section');
  assert.equal((await saveManager(admin, '101', { content: '## A `guide`\n\na\n## B `guide`\n\nb\n' })).value.error, 'duplicate_manager_section');
  assert.deepEqual([...parseSections('## 回复 `reply`\n\n```md\n## Quoted `guide`\n```\n').sections.keys()], ['reply']);
  assert.deepEqual(ruleOverrides('## 标签 `labels`\n\nreview_label: "bot-reviewed"\n', { '.bot/rules/pr-review.md': 'old' }), { '.bot/rules/labels.md': 'review_label: "bot-reviewed"' });
  // The control plane still requires a person's development label; who is assigned is the Manager's judgement (the
  // rule decider of these tests keeps the old answer for an assigned Issue).
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true, development_enabled: true });
  const review = { summary: 's', requires_code_change: true, issue_requests_code: true, clarification_required: false, implementation_goal: 'Fix add', request_quote: 'Fix add.', findings: [], object_hash: 'h' }, now = new Date().toISOString();
  h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,result,object_number,created_at,updated_at) VALUES('rv','101','review.issue','succeeded','r','101:review.issue:5:opened','{}',?,5,?,?)", JSON.stringify(review), now, now);
  const labeled = async (delivery, name, type, assignees = []) => (await h.hook(a.path, a.secret, delivery, { repository: { id: 101 }, action: 'labeled', label: { name }, sender: { id: 5, type },
    issue: { number: 5, title: 'Fix add.', body: 'Please fix.', state: 'open', labels: [{ name }], assignees } })).value.tasks_created;
  assert.equal(await labeled('l1', 'bot-develop', 'Bot'), 0);
  assert.equal(await labeled('l2', 'bot-develop', 'User', [{ login: 'someone' }]), 0);
  assert.equal(await labeled('l3', 'bot-develop', 'User'), 1);
});

test('reading is open to every work type; writes are chosen per work type within what it can do', async t => {
  const { h, admin } = await project(t);
  const defaults = { 'review.issue': ['reply', 'labels'], 'review.pr': ['reply', 'labels'], 'development.issue': ['code', 'pull_request'], 'release.observe': [], 'release.notes': ['release_notes'], 'actions.failures': ['issue', 'actions_rerun'], reply: ['reply'], 'gate.onboarding': ['gate_plan'], 'task.request': [] };
  for (const [id, writes] of Object.entries(defaults)) {
    assert.deepEqual(defaultWrites(id), writes, id);
    assert.deepEqual(workflowAccess(id), { workspace: { read: true, write: writes.includes('code'), notes: true, shell: true }, github: githubScopes, agents: true, writes }, id);
  }
  const put = (id, writes) => saveManager(admin, '101', { work: { [id]: { writes } } });
  // Refused: dropping a locked write, a PR without code, a write the work type cannot have, an unknown work type.
  for (const [id, writes] of [['review.pr', ['labels']], ['review.pr', ['reply', 'pull_request']], ['review.pr', ['reply', 'actions_rerun']], ['development.issue', ['code']], ['release.notes', ['reply']]])
    assert.equal((await put(id, writes)).value.error, 'invalid_work_writes', id + ' ' + writes);
  assert.equal((await saveManager(admin, '101', { work: { 'custom.abc': { enabled: true } } })).value.error, 'unknown_work_type');
  assert.equal((await put('review.pr', ['reply', 'code', 'pull_request', 'issue'])).status, 200);
  const permissions = workPermissions(h.store, '101', 'review.pr');
  assert.deepEqual(permissions.writes, ['reply', 'code', 'pull_request', 'issue']); assert.equal(permissions.workspace.write, true);
  assert.deepEqual(writeOptions('review.pr').map(option => [option.id, option.locked]), [['reply', true], ['labels', false], ['code', false], ['pull_request', false], ['issue', false]]);
  let profile = workspaceProfile('review.pr', {}, permissions), names = profile.tools.map(tool => tool.function.name);
  for (const name of ['read_file', 'run_command', 'write_file', 'start_agent', 'github_read_token', 'create_pull_request', 'create_issue', 'finish_review']) assert.ok(names.includes(name), name);
  // Without the labels write the review cannot hand over labels.
  assert.equal(profile.tools.find(tool => tool.function.name === 'finish_review').function.parameters.properties.labels, undefined);
  assert.deepEqual([profile.capabilities.workspace.write, profile.capabilities.github.publication, profile.capabilities.writes], [true, 'pull_request', ['reply', 'code', 'pull_request', 'issue']]);
  // Saved writes that no longer fit fall back leniently: locked kept, a PR without code dropped.
  h.store.run("UPDATE policies SET work_settings=? WHERE repository_id='101'", JSON.stringify({ 'review.pr': { writes: ['pull_request', 'actions_rerun'] } }));
  assert.deepEqual(workPermissions(h.store, '101', 'review.pr').writes, ['reply']);
  profile = workspaceProfile('review.pr', {}, workPermissions(h.store, '101', 'review.pr')); names = profile.tools.map(tool => tool.function.name);
  for (const name of ['create_pull_request', 'create_issue']) assert.ok(!names.includes(name), name);
  // write_file writes project notes only: the checkout stays read-only.
  assert.match(profile.tools.find(tool => tool.function.name === 'write_file').function.description, /project note at \.\.\/notes\/<name> only/);
  assert.equal(profile.capabilities.workspace.write, false);
  assert.deepEqual(profile.capabilities.github, { permissions: Object.fromEntries(githubScopes.map(scope => [scope, 'read'])), publication: 'none' });
  assert.equal(profile.subagentSystem, subagentSystem);
  // The runner still refuses what the capabilities refuse, whatever tool the model names.
  assert.equal(toolCapabilityError({ capabilities: { ...profile.capabilities, workspace: { ...profile.capabilities.workspace, shell: false } } }, 'run_command'), 'shell_not_allowed');
  assert.equal(toolCapabilityError({ capabilities: { ...profile.capabilities, agents: false } }, 'start_agent'), 'agents_not_allowed');
  assert.equal(toolCapabilityError({ capabilities: profile.capabilities }, 'create_issue'), 'write_not_allowed');
  assert.equal(toolCapabilityError({ capabilities: profile.capabilities }, 'create_pull_request'), 'publication_not_allowed');
});

test('a sub-agent permission request can only narrow the main agent\'s permissions', () => {
  const parent = { ...workflowAccess('review.pr'), workspace: { read: true, write: false, notes: true, shell: false }, github: ['contents'] };
  const child = narrowPermissions(parent, { run_commands: true, write_workspace: true, github_read: true, write_notes: false });
  assert.deepEqual(child, { workspace: { read: true, write: false, notes: false, shell: false }, github: ['contents'], agents: false, writes: [] });
  assert.deepEqual(narrowPermissions(workflowAccess('development.issue'), { write_workspace: false, github_read: false }).workspace, { read: true, write: false, notes: true, shell: true });
  // The runner applies the same rule to the capabilities it received from the control plane.
  const capabilities = { workspace: { read: true, write: false, notes: true, shell: false }, github: { permissions: { contents: 'read' }, publication: 'pull_request' }, agents: true };
  assert.deepEqual(narrowCapabilities(capabilities, { run_commands: true, write_workspace: true }),
    { workspace: { read: true, write: false, notes: true, shell: false }, github: { permissions: { contents: 'read' }, publication: 'none' }, agents: false, writes: [] });
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

test('a project administrator manages only their own project\'s Manager, and the workflow API is gone', async t => {
  const { h, admin, a } = await project(t);
  await repository(admin, a.id, '202');
  const password = 'p'.repeat(16);
  await admin('/api/users', 'POST', { username: 'member', password, repository_ids: ['101'] });
  const member = h.client(); await member('/api/auth/login', 'POST', { username: 'member', password });
  assert.equal((await member('/api/repositories/101/manager')).status, 200);
  assert.equal((await member('/api/repositories/202/manager')).status, 403);
  assert.equal((await member('/api/repositories/202/manager', 'PUT', { expected_revision: 0, content: 'x' })).status, 403);
  assert.equal((await member('/api/repositories/202/dispatch')).status, 403);
  assert.equal((await member('/api/repositories/101/manager', 'PUT', { expected_revision: 0, content: '## 通用回复 `reply`\n\n' + 'y'.repeat(300 * 1024) })).status, 200, 'no request size limit of its own');
  assert.equal((await member('/api/repositories/101/manager', 'PUT', { expected_revision: 0, content: 'stale' })).value.error, 'manager_revision_conflict');
  for (const [method, path] of [['GET', '/workflows'], ['POST', '/workflows'], ['PUT', '/workflows/review.issue'], ['POST', '/workflows/assistant']]) {
    const removed = await member('/api/repositories/101' + path, method, method === 'GET' ? undefined : {});
    assert.deepEqual([removed.status, removed.value.error], [410, 'workflows_removed'], method + ' ' + path);
  }
});


test('the complete Manager prompt is plain text, revisioned, restart-safe and independent of task rule sections', async t => {
  const {h,admin}=await project(t);
  const before=(await admin('/api/repositories/101/manager')).value.manager;
  assert.match(before.prompt.content,/Every event/);
  const text='按项目目标分派。\n## 任意标题 `not.a.section`\n优先续接已有任务。';
  const writes=workPermissions(h.store,'101','review.issue');
  const saved=await admin('/api/repositories/101/manager','PUT',{expected_revision:before.prompt.revision,prompt:text});
  assert.equal(saved.status,200);assert.equal((await admin('/api/repositories/101/manager')).value.manager.prompt.content,text);
  const revision=(await admin('/api/repositories/101/manager')).value.manager.prompt.revision;
  assert.equal((await admin('/api/repositories/101/manager','PUT',{expected_revision:revision,events:{'issue.opened':false}})).status,200);
  await admin('/api/repositories/101/rules','PUT',{path:'.bot/guide.md',content:'Keep task rules independent.'});
  assert.equal((await admin('/api/repositories/101/manager')).value.manager.prompt.content,text);
  assert.deepEqual(workPermissions(h.store,'101','review.issue'),writes);
  await h.stop();await h.start();assert.equal((await admin('/api/repositories/101/manager')).value.manager.prompt.content,text);
  assert.equal((await admin('/api/repositories/101/manager','PUT',{expected_revision:before.prompt.revision,prompt:'stale'})).value.error,'manager_revision_conflict');
});
