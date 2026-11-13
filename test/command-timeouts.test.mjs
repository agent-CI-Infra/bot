import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandTimeoutLimit, commandTool, runCommand } from '../dist/agent/command.js';
import { Store } from '../dist/storage/database.js';
import { Redactor } from '../dist/agent/common.js';
import { Workspace } from '../dist/agent/workspace.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { evaluateDelivery } from '../dist/tasks/acceptance.js';
import { developmentTeam } from '../dist/roles/development.js';
import { agentLoop } from '../dist/agent/loop.js';
import { roleApi } from '../dist/roles/api.js';
import { runRequest } from '../dist/tasks/request.js';
import { server as github } from './fixtures/agent-server.mjs';
import { planTask } from '../dist/roles/schedule.js';

const sdk = existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json');
const skipPi = !sdk && process.env.BOT_REQUIRE_PI !== '1' ? 'Pi SDK not installed' : false;
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const pass = { outcome: 'pass', reason: 'Verified command observations', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };
const review = { summary: 'Observed commands', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' };
const findings = { summary: 'Observed commands', findings: [], unknowns: [], inspected_scope: ['fixture'] };
const commandArgs = [{ command: 'printf default' }, { command: 'printf explicit', timeout_seconds: 400, keep_background: true }, { command: 'printf capped', timeout_seconds: 900 }];
const receipts = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('')));

async function fixture(t, backend, kind, respond) {
  const root = mkdtempSync(join(tmpdir(), 'bot-command-policy-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root), commands = [], bodies = [], logs = [];
  const original = manager.call.bind(manager);
  manager.call = async (method, path, input, timeout) => { if (input?.request?.type === 'workspace_command') commands.push(input.request); return original(method, path, input, timeout); };
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const message = respond(body);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(async () => { await manager.recover(); await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); }); store.close(); rmSync(root, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  store.run("INSERT INTO repositories VALUES('101','fixture/commands','o','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'fixture-model-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  const environment = await manager.call('PUT', '/v1/projects/101');
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)', 't', '101', kind, 'running', 'command fixture', '{}', 1, environment.generation, randomBytes(24).toString('hex'));
  const records = new TaskRecords(store);
  records.contract('t', { goal: 'Observe commands', scope: ['fixture'], criteria: ['Use actual observations'], endpoint: 'report' });
  roleApi(store, { id: 'owner', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'), { expected_revision: 0, enabled: true, controller: { entries: { review: true, development: true, request: true } }, roles: ['manager', 'dev', 'qa', 'reviewer'].map(role_id => ({ role_id, harness_ref: { id: role_id === 'manager' ? 'native' : backend } })) });
  const task = store.get("SELECT * FROM tasks WHERE id='t'"), redactor = new Redactor(), guard = async () => {}, workspace = new Workspace(store, manager, task, redactor, guard, log => logs.push(log));
  await workspace.call('init', { type: 'workspace_init' });
  await workspace.write('seed-write', 'fixture.txt', Buffer.from('baseline'));
  const seed = await workspace.call('seed-commit', { type: 'workspace_command', command: 'git init -q && git add fixture.txt && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm baseline', timeout_ms: 10000 });
  assert.equal(seed.exit_code, 0);
  return { store, task, records, manager, workspace, redactor, guard, commands, bodies, logs };
}
function nextCommand(body) {
  const count = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).filter(c => c.function.name === 'run_command').length;
  return count < commandArgs.length ? call('run_command', commandArgs[count]) : null;
}
function assertCommands(f, seconds) {
  const commands = f.commands.filter(c => /printf (default|explicit|capped)/.test(c.command));
  assert.deepEqual(commands.map(c => c.timeout_ms), [seconds * 1000, 400000, 600000]);
  assert.deepEqual(commands.map(c => c.keep_background), [false, true, false]);
  const results = f.bodies.flatMap(receipts);
  assert.ok(results.some(r => r.timeout_notice?.requested_seconds === 900 && r.timeout_notice.effective_seconds === 600));
  for (const body of f.bodies) for (const tool of body.tools.filter(t => t.function.name === 'run_command')) {
    assert.equal(tool.function.parameters.properties.timeout_seconds.type, 'integer');
    assert.equal(tool.function.parameters.properties.keep_background.type, 'boolean');
    if (f.task.kind !== 'review.issue' || body.tools.some(t => t.function.name === 'submit_role_result')) assert.match(tool.function.description, new RegExp(`default timeout is ${body.tools.some(t => t.function.name === 'submit_acceptance') ? 120 : seconds} seconds`));
  }
}

test('command timeouts validate configuration and explicit values, clamp with a notice, and preserve no-timeout defaults', async t => {
  const previous = process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS;
  t.after(() => { if (previous === undefined) delete process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS; else process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = previous; });
  for (const value of ['0', '-1', 'x', '1.1', '2147364']) { process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = value; assert.throws(commandTimeoutLimit, /BOT_COMMAND_TIMEOUT_MAX_SECONDS/); }
  process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = '2147363'; assert.equal(commandTimeoutLimit(), 2147363);
  process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = '450'; assert.equal(commandTimeoutLimit(), 450);
  const calls = [], workspace = { call: async (_key, request) => { calls.push(request); return { exit_code: 0 }; } };
  for (const value of [0, -1, null, 1.5, '400', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await runCommand(workspace, 'bad', { command: 'unused', timeout_seconds: value }, 120)).error, 'invalid_timeout_seconds');
  assert.equal(calls.length, 0);
  const result = await runCommand(workspace, 'cap', { command: 'build', timeout_seconds: 600 }, 180);
  assert.equal(calls[0].timeout_ms, 450000); assert.equal(result.timeout_notice.effective_seconds, 450); assert.match(result.timeout_notice.message, /reduced/);
  await runCommand(workspace, 'unlimited', { command: 'build' }, null); assert.equal(calls[1].timeout_ms, null);
  process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = '60';
  assert.equal((await runCommand(workspace, 'default', { command: 'build' }, 120)).timeout_notice.effective_seconds, 60);
  assert.match(commandTool(120).function.description, /default timeout is 60 seconds/);
  assert.match(commandTool(120).function.description, /automatically saved to the returned log_path/);
  assert.match(commandTool(120).function.description, /Ordinary commands clean up their process group/);
  assert.match(commandTool(120).function.parameters.properties.keep_background.description, /log_path/);
});

for (const backend of ['native', 'process', 'pi']) {
  test(`independent QA forwards timeout and background options (${backend})`, { skip: backend === 'pi' && skipPi, timeout: 90000 }, async t => {
    const f = await fixture(t, backend, 'task.request', body => nextCommand(body) ?? call('submit_acceptance', pass));
    f.records.submit('t', [{ kind: 'report', reference: 'report.md', version: 'v1', content: 'observed' }], [], {});
    assert.equal((await evaluateDelivery(f.store, f.task, f.workspace, f.redactor, f.guard)).outcome, 'pass');
    assertCommands(f, 120);
  });
  test(`role development forwards timeout and background options (${backend})`, { skip: backend === 'pi' && skipPi, timeout: 90000 }, async t => {
    const f = await fixture(t, backend, 'development.issue', body => {
      if (body.tools.some(t => t.function.name === 'nominate_delivery')) {
        const ref = receipts(body).find(r => r.result_ref)?.result_ref;
        return ref ? call('nominate_delivery', { result_ref: ref }) : call('delegate_role', { role: 'dev', purpose: 'Observe commands', refs: [] });
      }
      return nextCommand(body) ?? call('submit_delivery', { summary: 'Observed commands', test_command: 'printf verified' });
    });
    assert.equal((await developmentTeam(f.workspace, 'Implement', '{}', async () => ({ pr: { number: 1 } }), { read: true, write: true, shell: true })).pr.number, 1);
    assertCommands(f, 180);
  });
  test(`request execution forwards timeout and background options (${backend})`, { skip: backend === 'pi' && skipPi, timeout: 90000 }, async t => {
    const f = await fixture(t, backend, 'task.request', body => {
      if (body.tools.some(t => t.function.name === 'nominate_delivery')) {
        const ref = receipts(body).find(r => r.result_ref)?.result_ref;
        return ref ? call('nominate_delivery', { result_ref: ref }) : call('delegate_role', { role: 'dev', purpose: 'Observe commands', refs: [] });
      }
      if (body.tools.some(t => t.function.name === 'submit_acceptance')) return call('submit_acceptance', pass);
      const command = nextCommand(body); if (command) return command;
      if (!body.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.function.name === 'write_file'))) return call('write_file', { path: 'report.md', content: 'Observed commands' });
      return call('submit_delivery', { summary: 'Observed commands', artifacts: [{ path: 'report.md', description: 'Observed' }], evidence: [], unknowns: [] });
    });
    github.listen(0, '127.0.0.1'); await once(github, 'listening');
    t.after(() => new Promise(resolve => { github.close(resolve); github.closeAllConnections(); }));
    const url = 'http://127.0.0.1:' + github.address().port;
    await fetch(url + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'fixture-github-token' }) });
    f.store.run("UPDATE accounts SET type='bot_account',credentials=? WHERE id='a'", f.store.secrets.seal({ token: 'fixture-github-token' }, 'account:a'));
    f.store.run("UPDATE repositories SET full_name='fixture/project-101',owner_id='10' WHERE id='101'");
    const input = JSON.stringify({ request: 'Observe commands', contract: { goal: 'Observe commands', scope: ['report'], criteria: ['Observed'], endpoint: 'report' } });
    f.store.run("UPDATE tasks SET input=?,claim_token='claim',head_sha=? WHERE id='t'", input, 'a'.repeat(40));
    f.store.run("INSERT INTO task_claims VALUES('t','101','claim','now')");
    f.task = f.store.get("SELECT * FROM tasks WHERE id='t'");
    await runRequest(f.store, f.manager, f.task, f.redactor, f.guard, () => {}, url + '/github');
    assert.equal(f.store.get("SELECT status FROM tasks WHERE id='t'").status, 'completed');
    assertCommands(f, 180);
  });
  test(`stage observation forwards timeout and background options (${backend})`, { skip: backend === 'pi' && skipPi, timeout: 90000 }, async t => {
    const f = await fixture(t, backend, 'review.issue', body => {
      if (body.tools.some(t => t.function.name === 'nominate_delivery')) {
        const refs = receipts(body).filter(r => r.result_ref).map(r => r.result_ref);
        return refs.length === 0 ? call('delegate_role', { role: 'dev', stage_id: 'dev', purpose: 'Inspect', refs: [] }) : refs.length === 1 ? call('delegate_role', { role: 'reviewer', stage_id: 'reviewer', purpose: 'Observe', refs }) : call('nominate_delivery', { result_ref: refs[0] });
      }
      if (body.tools.some(t => t.function.name === 'submit_role_result')) return nextCommand(body) ?? call('submit_role_result', findings);
      return call('finish_review', review);
    });
    const stages = ['dev', 'reviewer'].map(role => ({ stage_id: role, depends_on: role === 'dev' ? [] : ['dev'], delivery_types: ['artifact'], role_constraints: { kinds: [role === 'dev' ? 'writer' : 'observer'], role_ids: [role], capabilities: ['raw_evidence', 'output_validation', ...(role === 'dev' ? [] : ['fresh_context', 'fixed_candidate_read'])], independent: role !== 'dev' }, required: false, completion: { evidence_types: [role === 'dev' ? 'role_result' : 'execution_evidence'], min_evidence: 1, no_findings: role !== 'dev' }, retry: { max_attempts: 3 }, budget: { max_tool_calls: 8 } }));
    planTask(f.store, 't', f.records.get('t').revision, stages, 0);
    assert.equal((await agentLoop(f.store, f.task, f.workspace, f.redactor, f.guard, {})).summary, review.summary);
    assertCommands(f, 120);
  });
}

test('kept background service remains accessible to later task commands', async t => {
  const f = await fixture(t, 'native', 'task.request', () => call('submit_acceptance', pass));
  const start = await runCommand(f.workspace, 'start', { command: `node -e 'const fs=require("node:fs"),s=require("node:http").createServer((q,r)=>r.end("ready"));s.listen(0,"127.0.0.1",()=>fs.writeFileSync("port",String(s.address().port)))' > service.log 2>&1`, keep_background: true, timeout_seconds: 400 }, 120);
  assert.equal(start.running, true);
  const read = await runCommand(f.workspace, 'read', { command: `node -e 'fetch("http://127.0.0.1:"+require("node:fs").readFileSync("port","utf8")).then(r=>r.text()).then(console.log)'` }, 120);
  assert.equal(read.exit_code, 0); assert.equal(read.output.trim(), 'ready');
});
