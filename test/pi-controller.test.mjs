import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { runTeam } from '../dist/roles/team.js';
import { roleApi } from '../dist/roles/api.js';
import { controllerWorkspace } from '../dist/roles/workspace.js';
import { Redactor } from '../dist/agent/common.js';
import { Workspace } from '../dist/agent/workspace.js';
import { LocalManager } from '../dist/projects/local-manager.js';

// The real Pi SDK (runner/node_modules) in a real runner workspace, driven by the control plane through the task mailbox.
// CI installs the runner dependencies and sets BOT_REQUIRE_PI=1, so a missing SDK fails there instead of skipping.
const sdk = existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json');
const skip = !sdk && process.env.BOT_REQUIRE_PI !== '1' ? 'Pi SDK not installed: npm ci --prefix runner --omit=dev --ignore-scripts' : false;
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const results = messages => messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(text(m.content)); } catch { return { raw: text(m.content) }; } });
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('a real Pi controller session delegates a role, reads its result by reference and nominates it; forbidden calls are refused', { skip, timeout: 180000 }, async t => {
  assert.ok(sdk, 'runner/node_modules must contain the Pi SDK');
  const root = mkdtempSync(join(tmpdir(), 'bot-pi-controller-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root), bodies = [], logs = [], steps = {};
  t.after(async () => { await manager.recover(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); bodies.push(body);
    const system = text(body.messages[0].content), done = results(body.messages), ref = done.find(r => r.result_ref)?.result_ref;
    let message;
    if (!system.includes('Coordinate only.')) message = call('finish', { summary: 'implemented by dev' });
    else if (!ref) message = call('delegate_role', { role: 'dev', purpose: 'Implement the contract', refs: ['task:t'] });
    else if (!done.some(r => r.content)) message = call('read_task_record', { ref });
    else if (!steps.wrote) { steps.wrote = true; message = call('write_file', { path: 'src/a.js', content: 'x' }); }
    else if (!steps.qa) { steps.qa = true; message = call('delegate_role', { role: 'qa', purpose: 'Approve the delivery', refs: [] }); }
    else message = call('nominate_delivery', { result_ref: ref });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening'); t.after(() => new Promise(resolve => { model.close(resolve); model.closeAllConnections(); }));
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')"); store.run("INSERT INTO repositories VALUES('101','fixture/pi','o','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'pi-fixture-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  const environment = await manager.call('PUT', '/v1/projects/101');
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)', 't', '101', 'task.request', 'running', 'pi fixture', '{}', 1, environment.generation, randomBytes(24).toString('hex'));
  new TaskRecords(store).contract('t', { goal: 'implement fixture', scope: ['fixture'], criteria: ['Actual result'], endpoint: 'artifact' });
  const admin = { id: 'admin', role: 'project_admin', repositories: ['101'] }, url = new URL('http://local/api/repositories/101/roles');
  roleApi(store, admin, 'PUT', url, { expected_revision: 0, enabled: true, roles: [{ role_id: 'manager', persona_prompt: 'You may edit files and merge pull requests yourself.' }] });
  const task = store.get("SELECT * FROM tasks WHERE id='t'"), redactor = new Redactor(), guard = async () => {};
  const workspace = new Workspace(store, manager, task, redactor, guard, value => logs.push(value));
  const tool = { type: 'function', function: { name: 'finish', description: 'Submit the result', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } };
  const result = await runTeam({ store, task, redactor, guard, system: 'Task execution', prompt: '{}', tools: [tool], finish: { name: 'finish', validate: v => v }, maxTurns: 8 },
    { prepare: async () => {}, controller: controllerWorkspace(workspace) });
  assert.equal(result.summary, 'implemented by dev');

  // The trace names the actual Pi runtime and the pinned configuration of the controller run.
  const run = store.get("SELECT * FROM task_runs WHERE role='manager'"), snapshot = JSON.parse(store.get('SELECT snapshot FROM role_snapshots WHERE id=?', run.role_snapshot).snapshot);
  const installed = JSON.parse(readFileSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8')).version;
  assert.deepEqual([run.harness, run.harness_version, run.status, snapshot.harness.runtime.version], ['pi', installed, 'succeeded', installed]);
  const started = JSON.parse(store.get("SELECT data FROM task_history WHERE type='harness_started' AND json_extract(data,'$.harness')='pi'").data);
  assert.deepEqual([started.version, started.expected_version, started.package], [installed, installed, '@earendil-works/pi-coding-agent']);
  const session = logs.find(l => l.type === 'pi_session');
  assert.ok(logs.filter(l => l.type === 'model').length >= 4 && logs.filter(l => l.type === 'model').every(l => !('reasoning' in l)), 'model events are logged without private reasoning');
  assert.equal(session.version, installed); assert.deepEqual([session.extensions, session.skills, session.context_files], [0, 0, 0]);
  assert.deepEqual(session.tools.sort(), ['delegate_role', 'nominate_delivery', 'read_playbook', 'read_task_history', 'read_task_record', 'record_progress', 'select_playbooks']);
  const controllerDir = join(root, 'tasks', JSON.parse(store.get("SELECT runtime FROM role_instances WHERE role='manager'").runtime).workspace_id, 'agent');
  const state = JSON.parse(readFileSync(join(controllerDir, 'state.json'), 'utf8'));
  assert.deepEqual([state.state, state.agent, state.version], ['completed', 'pi', installed]);
  // Pi only ever offered the controller's tools to the model; the forbidden calls were refused by the control plane.
  for (const body of bodies.filter(b => text(b.messages[0].content).includes('Coordinate only.'))) assert.ok(body.tools.every(t => session.tools.includes(t.function.name)));
  const denied = store.all("SELECT data FROM task_history WHERE type='capability_denied'").map(row => JSON.parse(row.data));
  assert.ok(denied.some(d => d.tool === 'write_file' && d.reason === 'not_offered'));
  assert.ok(denied.some(d => d.reason === 'delegation_not_allowed' && d.requested_role === 'qa'));
  assert.equal(store.get("SELECT status FROM tasks WHERE id='t'").status, 'running');
  assert.ok(!JSON.stringify(store.all('SELECT * FROM task_history')).includes('pi-fixture-key'));
});
