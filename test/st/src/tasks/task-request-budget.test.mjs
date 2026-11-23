// #532 (maintainer, 2026-11-15): ordinary tasks created from chats (task.request / task.development) must take their turn
// limit and command timeout from the same budget configuration as every other entry. This test drives an ordinary request
// task in process (a task frozen with the Manager switch off, which the Manager team runs since #1256), configures the
// project's dev role with `bounded` budget `max_turns: 8` and `command_timeout_seconds: 30`, and asserts the delegated dev
// run follows the configuration instead of the entry literals (64 turns / 180 seconds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { Workspace } from '../../../../dist/agent/workspace.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { runRequest } from '../../../../dist/tasks/request.js';
import { pinLegacyTaskConfiguration } from '../../../fixtures/helpers.mjs';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
import { server as github } from '../../../fixtures/agent-server.mjs';

const contract = { goal: 'Report the current branch', scope: ['Read the working tree'], criteria: ['Report the observed branch'], endpoint: 'report', source: 'request', completeness: 'explicit' };

test('an ordinary task created from a chat takes its turn limit and command timeout from the budget configuration', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-request-budget-'));
  const store = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root);
  // Capture the requests the entry actually sends to the workspace, so the executed command's timeout is observed rather
  // than inferred from the tool description.
  const commands = [];
  const localCall = manager.call.bind(manager);
  manager.call = async (method, path, input, timeout) => { if (input?.request?.type === 'workspace_command') commands.push(input.request); return localCall(method, path, input, timeout); };
  const calls = [], managerCalls = [];
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    // The Manager hands the task to dev (#1256); only dev's requests count against dev's budget.
    if ((body.tools ?? []).some(tool => tool.function.name === 'delegate_role')) {
      managerCalls.push(body);
      const message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name: 'delegate_role', arguments: JSON.stringify({ role: 'dev', purpose: 'Report the current branch', refs: [] }) } }] };
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      return;
    }
    calls.push(body);
    // First turn runs one command without an explicit timeout, so the executed default is the configured budget. Every later
    // turn only asks for one more harmless observation: never submits, so only the turn limit can end the loop.
    const ran = body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'run_command'));
    const message = ran
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name: 'record_progress', arguments: JSON.stringify({ completed: ['Inspected the working tree'], next_action: 'Keep inspecting' }) } }] }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'printf chat-budget' }) } }] };
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  github.listen(0, '127.0.0.1');
  await once(github, 'listening');
  t.after(async () => {
    await manager.recover();
    for (const server of [model, github]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + github.address().port;
  await fetch(url + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'fixture-github-token' }) });
  store.run("INSERT INTO accounts VALUES('a','a','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-github-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  // The historical in-process configuration: controller off, every role in process. The project's only configured budget
  // is the dev role's: 8 turns and a 30-second default command timeout.
  scriptedRoles(store, '101');
  const environment = await manager.call('PUT', '/v1/projects/101');
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id,claim_token,head_sha) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 't', '101', 'task.request', 'running', 'Report the current branch',
    JSON.stringify({ request: 'Report the current branch of this checkout.', contract }), 1, environment.generation, randomBytes(24).toString('hex'), 'claim', 'a'.repeat(40));
  store.run("INSERT INTO task_claims VALUES('t','101','claim','now')");
  new TaskRecords(store).contract('t', contract);
  pinLegacyTaskConfiguration(store, 't');
  const pinned = JSON.parse(store.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', 't').snapshot);
  pinned.roles = { ...pinned.roles, roles: pinned.roles.roles.map(role => role.role_id === 'dev'
    ? { ...role, budget_policy_ref: { id: 'bounded', max_turns: 8, command_timeout_seconds: 30 } }
    : role) };
  store.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify(pinned), 't');

  const task = store.get("SELECT * FROM tasks WHERE id='t'");
  const redactor = new Redactor(), guard = async () => {};
  const workspace = new Workspace(store, manager, task, redactor, guard, () => {});
  await workspace.call('init', { type: 'workspace_init' });
  await workspace.write('seed-write', 'README.md', Buffer.from('fixture'));
  assert.equal((await workspace.call('seed-commit', { type: 'workspace_command', command: 'git init -q && git add README.md && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm baseline', timeout_ms: 10000 })).exit_code, 0);

  const error = await runRequest(store, manager, task, redactor, guard, () => {}, url + '/github').then(() => null, reason => reason);
  const turnCalls = calls;
  const executed = commands.find(request => request.command === 'printf chat-budget');
  assert.ok(executed, 'the agent executed the command the model asked for');
  // Both assertions run before failing, so one base run shows both entry literals at once: the executed default is the
  // entry literal 180 seconds (180000 ms) and the loop stops at the entry literal 64 turns.
  const entryLiterals = [];
  if (executed.timeout_ms !== 30000) entryLiterals.push(`the executed command timed out after ${executed.timeout_ms} ms; the configured dev budget is 30000 ms`);
  if (turnCalls.length !== 8) entryLiterals.push(`the model was asked ${turnCalls.length} times; the configured dev budget is 8 turns`);
  assert.deepEqual(entryLiterals, [], entryLiterals.join('\n'));
  assert.ok(error, 'the run stops at the configured turn limit');
  assert.equal(error.code, 'agent_turn_limit');
  assert.match(error.detail, /8 轮/);
  assert.equal(managerCalls.length, 1, 'the Manager delegated the task to dev once');
  // The command tool's default is the configured 30 seconds, not the entry literal 180.
  const command = calls[0].tools.find(tool => tool.function.name === 'run_command');
  assert.ok(command, 'the running agent offers run_command');
  assert.match(command.function.description, /default timeout is 30 seconds/);
});

// #532 review (B1/B2): a delegated role with `entry-default` keeps the entry defaults (64 turns, 180-second command
// default) even when the dev role configured a smaller budget. The entry's own resolved budget must not travel into
// other roles' runs through the shared AgentSpec.
test('a delegated entry-default observer keeps the entry turn and command defaults while dev has a smaller budget', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-request-team-budget-'));
  const store = new Store(':memory:', randomBytes(32));
  const manager = new LocalManager('101', root);
  const commands = [];
  const originalCall = manager.call.bind(manager);
  manager.call = async (method, path, input, timeout) => { if (input?.request?.type === 'workspace_command') commands.push(input.request); return originalCall(method, path, input, timeout); };
  const calls = [];
  const receipts = body => body.messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')); } catch { return {}; } });
  const toolCalls = body => body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []);
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const tools = (body.tools ?? []).map(tool => tool.function.name);
    const ran = toolCalls(body);
    let message;
    if (tools.includes('delegate_role')) {
      const done = receipts(body).filter(r => r.result_ref || r.findings_ref || r.observation_ref);
      message = done.length === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'd' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'delegate_role', arguments: JSON.stringify({ role: 'dev', purpose: 'Write the report', refs: [] }) } }] }
        : done.length === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'd' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'delegate_role', arguments: JSON.stringify({ role: 'reviewer', purpose: 'Inspect the report', refs: [done[0].result_ref] }) } }] }
          : { role: 'assistant', content: null, tool_calls: [{ id: 'd' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'nominate_delivery', arguments: JSON.stringify({ result_ref: done[0].result_ref }) } }] };
    } else if (tools.includes('submit_role_result')) {
      const command = ran.some(c => c.function.name === 'run_command');
      const filler = ran.filter(c => c.function.name === 'read_file').length;
      message = !command
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'r' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'printf reviewer-default' }) } }] }
        : filler < 9
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'r' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'report.md' }) } }] }
          : { role: 'assistant', content: null, tool_calls: [{ id: 'r' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'submit_role_result', arguments: JSON.stringify({ summary: 'Report inspected', findings: [], unknowns: [], inspected_scope: ['report.md'] }) } }] };
    } else if (tools.includes('submit_acceptance')) {
      message = !ran.some(c => c.function.name === 'read_file')
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'q' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'report.md' }) } }] }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'q' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'submit_acceptance', arguments: JSON.stringify({ outcome: 'pass', reason: 'The report is present', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true }) } }] };
    } else {
      message = !ran.some(c => c.function.name === 'write_file')
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'w' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'report.md', content: 'Observed report' }) } }] }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'w' + randomBytes(4).toString('hex'), type: 'function', function: { name: 'submit_delivery', arguments: JSON.stringify({ summary: 'Observed report', artifacts: [{ path: 'report.md', description: 'Observed report' }], evidence: [], unknowns: [] }) } }] };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  github.listen(0, '127.0.0.1');
  await once(github, 'listening');
  t.after(async () => {
    await manager.recover();
    for (const server of [model, github]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + github.address().port;
  await fetch(url + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'fixture-github-token' }) });
  store.run("INSERT INTO accounts VALUES('a','a','bot_account',NULL,?,'now')", store.secrets.seal({ token: 'fixture-github-token' }, 'account:a'));
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  scriptedRoles(store, '101');
  const environment = await manager.call('PUT', '/v1/projects/101');
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id,claim_token,head_sha) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 't', '101', 'task.request', 'running', 'Report the current branch',
    JSON.stringify({ request: 'Report the current branch of this checkout.', contract }), 1, environment.generation, randomBytes(24).toString('hex'), 'claim', 'a'.repeat(40));
  store.run("INSERT INTO task_claims VALUES('t','101','claim','now')");
  new TaskRecords(store).contract('t', contract);
  pinLegacyTaskConfiguration(store, 't');
  const pinned = JSON.parse(store.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?', 't').snapshot);
  pinned.roles = {
    ...pinned.roles,
    enabled: true,
    controller: { ...pinned.roles.controller, entries: { ...pinned.roles.controller.entries, request: true } },
    roles: pinned.roles.roles.map(role => role.role_id === 'dev'
      ? { ...role, budget_policy_ref: { id: 'bounded', max_turns: 8, command_timeout_seconds: 30 } }
      : { ...role, budget_policy_ref: { ...role.budget_policy_ref, id: 'entry-default' } }),
  };
  store.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify(pinned), 't');

  const task = store.get("SELECT * FROM tasks WHERE id='t'");
  const redactor = new Redactor(), guard = async () => {};
  const workspace = new Workspace(store, manager, task, redactor, guard, () => {});
  await workspace.call('init', { type: 'workspace_init' });
  await workspace.write('seed-write', 'README.md', Buffer.from('fixture'));
  assert.equal((await workspace.call('seed-commit', { type: 'workspace_command', command: 'git init -q && git add README.md && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm baseline', timeout_ms: 10000 })).exit_code, 0);

  const error = await runRequest(store, manager, task, redactor, guard, () => {}, url + '/github').then(() => null, reason => reason);
  assert.equal(error, null, `${error?.code}: ${error?.detail} | runs=${JSON.stringify(store.all('SELECT role,harness FROM task_runs WHERE task_id=?', 't'))} | logs=${JSON.stringify(store.all('SELECT content FROM task_logs WHERE task_id=? ORDER BY id DESC LIMIT 6', 't').map(r => r.content).join('\n')).slice(0, 1500)}`);
  // dev is bounded at 8 turns and 30s; the reviewer is entry-default and must keep 64 turns and 180s.
  const observerCalls = calls.filter(body => (body.tools ?? []).some(tool => tool.function.name === 'submit_role_result'));
  assert.equal(observerCalls.length, 11, `the entry-default observer ran ${observerCalls.length} model requests; 1 command + 9 observations + 1 submission`);
  const executed = commands.find(request => request.command === 'printf reviewer-default');
  assert.ok(executed, 'the observer executed its command');
  assert.equal(executed.timeout_ms, 180000, 'the entry-default observer keeps the 180-second entry default');
});
