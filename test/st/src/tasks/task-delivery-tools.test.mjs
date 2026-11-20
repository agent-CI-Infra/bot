// #814: one generic task whose deliveries are tools, the writes the Manager grants, and the project's QA gate before a PR.
// The engine tests run the real scheduler, Task Manager team, runner workspace, policy tests and Publisher against the
// GitHub protocol fixture; the model is a scripted local server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../dist/storage/database.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { TaskCommands } from '../../../../dist/tasks/commands.js';
import { TaskEngine } from '../../../../dist/agent/engine.js';
import { LocalManager } from '../../../../dist/projects/local-manager.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { roleTaskCaller } from '../../../../dist/tasks/management.js';
import { roleConfiguration } from '../../../../dist/roles/definition.js';
import { policyView } from '../../../../dist/roles/board.js';
import { grantTaskWrites, grantView, grantedWrites, pullRequestQaGate, pullRequestQaRequired, setDeliveryGates, taskWritesDetail } from '../../../../dist/tasks/grants.js';
import { grantedTaskWrite } from '../../../../dist/tasks/github-write.js';
import { assertRequestPullRequest } from '../../../../dist/tasks/pull-request.js';
import { taskPermissions } from '../../../../dist/tasks/configuration.js';
import { server as github } from '../../../fixtures/agent-server.mjs';
import { authorizeKnowledgeTask } from '../../../fixtures/knowledge-fixture.mjs';
import { nativeRoles } from '../../../fixtures/native-roles.mjs';

const pass = { outcome: 'pass', reason: 'Read the fixed candidate: add now sums both numbers and the project test passes', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true };
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const operator = { id: 'operator', role: 'project_admin', repositories: ['101'] };
const fixed = 'export const add = (a, b) => a + b; // REPO_101_ONLY\n';

/**
 * A project at develop with the project test `node --test`, the default role team, and a model that answers by role:
 * `manager(context)` and `dev(context)` return the next message; QA reads the candidate and passes.
 */
async function engineFixture(t, { manager, dev, qa }) {
  const root = mkdtempSync(join(tmpdir(), 'bot-delivery-tools-')), store = new Store(':memory:', randomBytes(32)), computer = new LocalManager('101', root);
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  const gh = 'http://127.0.0.1:' + github.address().port;
  await fetch(gh + '/fixture/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_token: 'delivery-fixture-token' }) });
  const seen = { manager: [], dev: [], qa: 0 };
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw), messages = body.messages;
    const tools = (body.tools ?? []).map(tool => tool.function.name), names = messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(c => c.function.name);
    const results = messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return { raw: m.content }; } });
    const context = { body, messages, tools, names, results, store };
    let message;
    try {
      if (tools.includes('delegate_role')) { seen.manager.push(tools); message = manager(context); }
      else if (messages[0].content.includes('independent delivery acceptance evaluator')) { seen.qa++; message = qa ? qa(context) : !names.includes('read_file') ? call('read_file', { path: 'calc.mjs' }) : { role: 'assistant', content: JSON.stringify(pass) }; }
      else if (tools.includes('submit_report')) { seen.dev.push(tools); message = dev(context); }
      else throw new Error('unexpected model request: ' + tools.join(','));
    } catch (error) { seen.error ??= error; res.writeHead(500); res.end(JSON.stringify({ error: { message: 'fixture assertion failed' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const engine = new TaskEngine(store, computer, gh + '/github');
  t.after(async () => { await engine.close(); await computer.recover(); await new Promise(r => { model.close(r); model.closeAllConnections(); });
    await new Promise(r => { github.close(r); github.closeAllConnections(); }); store.close(); rmSync(root, { recursive: true, force: true }); });
  store.run('INSERT INTO accounts VALUES(?,?,?,?,?,?)', 'a', 'fixture', 'bot_account', null, store.secrets.seal({ token: 'delivery-fixture-token' }, 'account:a'), 'now');
  store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', 'http://127.0.0.1:' + model.address().port + '/v1', 'fixture', store.secrets.seal({ value: 'delivery-model-token' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled,capability_ceiling,test_command) VALUES('101','m',1,1,'develop','node --test')");
  // The scripted Manager reads the in-process message format; the default Pi backend has its own coverage.
  nativeRoles(store, '101');
  const commands = new TaskCommands(store);
  const state = async () => (await fetch(gh + '/fixture/state')).json();
  const create = body => commands.api(operator, 'POST', new URL('http://local/api/tasks'), { repository_id: '101', ...body }).id;
  const run = async id => {
    store.run("UPDATE tasks SET status='running',claim_token='claim' WHERE id=?", id);
    store.run("INSERT OR REPLACE INTO task_claims VALUES(?,'101','claim','now')", id);
    authorizeKnowledgeTask(store, id);
    await engine.run(id, 'claim');
    assert.ifError(seen.error);
    return store.get('SELECT * FROM tasks WHERE id=?', id);
  };
  const logs = id => { const row = store.get('SELECT status,phase,attempt,error_code FROM tasks WHERE id=?', id);
    return JSON.stringify({ ...row, history: store.all('SELECT type FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 12', id).map(r => r.type) }); };
  return { store, commands, create, run, state, seen, logs };
}
// The Manager's latest delegated result in this conversation.
const latestResult = results => results.filter(r => r.result_ref).at(-1)?.result_ref;
const contract = goal => ({ goal, scope: ['calc.mjs'], criteria: ['add(2, 3) returns 5 and the project test passes'], endpoint: 'report' });

test('a report task that finds a needed change continues after grant_writes and opens the PR behind independent QA', { timeout: 240000 }, async t => {
  let granted = false, prsBefore, mediaSelectionAttempted = false, mediaRefusal, nominationRefusal;
  const h = await engineFixture(t, {
    manager: ({ tools, names, results, messages }) => {
      assert.ok(tools.includes('grant_writes'), 'the Task Manager of a generic task can change its writes');
      const prompt = JSON.parse(messages[1].content);
      const delegated = names.filter(name => name === 'delegate_role').length;
      if (!delegated) { assert.deepEqual(prompt.writes.granted, []); assert.ok(prompt.writes.grantable.includes('pull_request')); return call('delegate_role', { role: 'dev', purpose: 'Find why add(2, 3) is wrong and report it', refs: [prompt.task_ref] }); }
      if (!names.includes('grant_writes')) return call('grant_writes', { task_id: prompt.task_id, writes: ['pull_request'], reason: 'The report found that calc.mjs must change; deliver the fix as a PR in the same task' });
      if (delegated === 1) { const grant = results.at(-1); assert.deepEqual(grant.writes, ['pull_request'], JSON.stringify(grant)); granted = true;
        return call('delegate_role', { role: 'dev', purpose: 'Fix add in calc.mjs and open the pull request', refs: [prompt.task_ref, latestResult(results)] }); }
      const result_ref = latestResult(results);
      if (!names.includes('nominate_delivery'))
        return call('nominate_delivery', { result_ref, summary: '![Screenshot](workspace:.tmp/unselected.png)' });
      nominationRefusal = messages.filter(message => ['tool', 'user'].includes(message.role)).map(message => JSON.stringify(message.content))
        .find(text => text.includes('must name a selected media file') && text.includes('.tmp/unselected.png'));
      return call('nominate_delivery', { result_ref });
    },
    dev: ({ tools, names, messages }) => {
      if (!granted) {
        // Before the grant the executor has no PR tool: it reports the needed change instead.
        assert.ok(!tools.includes('open_pull_request') && !tools.includes('post_review') && !tools.includes('github_write'), tools.join(','));
        if (!names.includes('read_file')) return call('read_file', { path: 'calc.mjs' });
        return call('submit_report', { summary: 'add subtracts its second argument; calc.mjs needs a one-line code change', artifacts: [], evidence: [{ source: 'calc.mjs', result: 'add = (a, b) => a - b' }], unknowns: [] });
      }
      assert.ok(tools.includes('open_pull_request'), 'after the grant the executor gets open_pull_request');
      if (!names.includes('write_file')) return call('write_file', { path: 'calc.mjs', content: fixed });
      if (!mediaSelectionAttempted) {
        mediaSelectionAttempted = true;
        return call('open_pull_request', { summary: '![Screenshot](workspace:.tmp/missing.png)', media: ['.tmp/missing.png'], artifacts: [], change_title: 'fix: add sums both numbers' });
      }
      mediaRefusal = messages.filter(message => ['tool', 'user'].includes(message.role)).map(message => JSON.stringify(message.content))
        .find(text => text.includes('Cannot read') && text.includes('.tmp/missing.png'));
      return call('open_pull_request', { summary: 'add now sums both numbers', artifacts: [{ path: 'calc.mjs', description: 'Fixed add' }], evidence: [], unknowns: [], change_title: 'fix: add sums both numbers' });
    },
    qa: ({ names }) => {
      assert.equal(h.store.get("SELECT count(*) n FROM github_effects WHERE kind LIKE '%pull%'").n, 0, 'nothing is published before independent QA');
      return !names.includes('read_file') ? call('read_file', { path: 'calc.mjs' }) : { role: 'assistant', content: JSON.stringify(pass) };
    }
  });
  prsBefore = (await h.state()).prs.length;
  const id = h.create({ request: 'Find out why add(2, 3) is wrong', contract: contract('Find out why add(2, 3) is wrong') });
  assert.deepEqual(grantedWrites(h.store, id), [], 'a report task starts without writes');
  const task = await h.run(id);
  assert.equal(task.status, 'pr_opened', h.logs(id));
  assert.equal(task.kind, 'task.request');
  assert.ok(mediaRefusal, 'an invalid media file can be corrected in the active delivery turn');
  assert.ok(nominationRefusal, 'the Manager can repair a media reference before ending the nomination turn');
  const prs = (await h.state()).prs;
  assert.equal(prs.length, prsBefore + 1);
  assert.equal(prs.at(-1).head.ref, 'bot/task-' + id, 'the same task opened the PR');
  assert.ok(h.seen.qa >= 1, 'independent QA ran on the candidate');
  assert.equal(new TaskRecords(h.store).get(id).acceptance.outcome, 'pass');
  // The grant is recorded with its reason and audited; the details show which delivery tools each run had.
  const detail = taskWritesDetail(h.store, task, []);
  assert.deepEqual(detail.granted, ['pull_request']);
  assert.match(detail.changes.find(change => change.added?.includes('pull_request')).reason, /same task/);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='task.grant_writes' AND repository_id='101'"));
  const devRuns = detail.runs.filter(run => run.role === 'dev').reverse();
  assert.deepEqual(devRuns.map(run => run.tools), [['submit_report'], ['submit_report', 'open_pull_request']]);
});

test('a delivery call the task no longer holds is refused with its reason, nothing is written, and a report still ends it', { timeout: 240000 }, async t => {
  let refusal = null;
  const h = await engineFixture(t, {
    manager: ({ names, results, messages }) => {
      const prompt = JSON.parse(messages[1].content);
      return !names.includes('delegate_role') ? call('delegate_role', { role: 'dev', purpose: 'Fix add and deliver it', refs: [prompt.task_ref] }) : call('nominate_delivery', { result_ref: latestResult(results) });
    },
    dev: ({ body, tools, names, messages, store }) => {
      if (!names.includes('write_file')) {
        assert.ok(tools.includes('open_pull_request'));
        // #1106: a pull request delivery says its summary is the public PR description; a report's summary is not one.
        const summary = name => body.tools.find(t => t.function.name === name).function.parameters.properties.summary.description;
        assert.match(summary('open_pull_request'), /^The public pull request description on GitHub[\s\S]*No internal references/); assert.equal(summary('submit_report'), undefined);
        return call('write_file', { path: 'calc.mjs', content: fixed });
      }
      if (!names.includes('open_pull_request')) {
        // The Manager narrows the grant while the executor works: the next call is checked against the grant as it is now.
        const id = store.get("SELECT id FROM tasks WHERE kind='task.request'").id;
        grantTaskWrites(store, store.get('SELECT * FROM tasks WHERE id=?', id), { writes: [], reason: 'Deliver a report only' }, 'user:operator', []);
        return call('open_pull_request', { summary: 'add now sums both numbers', artifacts: [{ path: 'calc.mjs', description: 'Fixed add' }], evidence: [], unknowns: [], change_title: 'fix: add sums both numbers' });
      }
      refusal = messages.filter(m => m.role === 'tool' || m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).find(text => text.includes('delivery_not_granted'));
      return call('submit_report', { summary: 'The fix is in calc.mjs; this task may not open the PR, so it is reported instead', artifacts: [{ path: 'calc.mjs', description: 'Fixed add, not published' }], evidence: [], unknowns: [] });
    }
  });
  const before = await h.state();
  // intent=development still works: it grants pull_request.
  const id = h.create({ request: 'Fix add', intent: 'development', contract: { ...contract('Fix add'), endpoint: 'reviewable_pull_request' } });
  assert.deepEqual(grantedWrites(h.store, id), ['pull_request']);
  const task = await h.run(id);
  assert.ok(refusal, 'the refusal returns to the executor');
  assert.match(refusal, /grant:pull_request/);
  assert.equal(task.status, 'completed', h.logs(id));
  const after = await h.state();
  assert.equal(after.prs.length, before.prs.length);
  assert.equal(after.refWrites.length, before.refWrites.length, 'nothing was pushed');
  assert.equal(h.store.get('SELECT count(*) n FROM github_effects WHERE task_id=?', id).n, 0);
});

test('a project that turns off the QA gate publishes a tested candidate without independent QA; failing tests still block it', { timeout: 240000 }, async t => {
  // Role sessions continue across attempts, so the script follows the task's attempt rather than the conversation.
  const attempt = store => store.get("SELECT attempt FROM tasks WHERE kind='task.request'").attempt;
  const h = await engineFixture(t, {
    manager: ({ names, results, messages, store }) => {
      const prompt = JSON.parse(messages[1].content);
      assert.equal(prompt.writes.pull_request_qa, false);
      const delegated = names.filter(name => name === 'delegate_role').length;
      return delegated < attempt(store) ? call('delegate_role', { role: 'dev', purpose: 'Fix add and open the PR (attempt ' + attempt(store) + ')', refs: [prompt.task_ref] }) : call('nominate_delivery', { result_ref: latestResult(results) });
    },
    dev: ({ names, store }) => {
      // The first attempt submits the unchanged, failing code; the second fixes it.
      if (attempt(store) > 1 && !names.includes('write_file')) return call('write_file', { path: 'calc.mjs', content: fixed });
      return call('open_pull_request', { summary: 'Deliver add', artifacts: [{ path: 'calc.mjs', description: 'add' }], evidence: [], unknowns: [], change_title: 'fix: add sums both numbers' });
    }
  });
  setDeliveryGates(h.store, '101', { pull_request_qa: false }, 'operator');
  assert.equal(pullRequestQaGate(h.store, '101'), false);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='policy.delivery_gates'"));
  const before = (await h.state()).prs.length;
  const id = h.create({ request: 'Fix add', contract: { ...contract('Fix add'), endpoint: 'reviewable_pull_request' } });
  let task = await h.run(id);
  assert.equal(task.status, 'queued', h.logs(id));
  const first = JSON.parse(h.store.get("SELECT data FROM task_history WHERE task_id=? AND type='acceptance_evaluated' ORDER BY id DESC LIMIT 1", id).data);
  assert.equal(first.method, 'pull_request_qa_gate_off');assert.equal(first.verdict.outcome, 'return');
  assert.equal((await h.state()).prs.length, before, 'a failing project test blocks the PR');
  task = await h.run(id);
  assert.equal(task.status, 'pr_opened', h.logs(id));
  assert.equal((await h.state()).prs.length, before + 1);
  assert.equal(h.seen.qa, 0, 'no independent QA ran');
});

// The Manager's GitHub resources set to read: it then holds no GitHub write to lend.
function noGithubWrites(s) {
  const cfg = roleConfiguration(s, 'r'), manager = cfg.roles.find(role => role.role_id === cfg.controller.role);
  for (const resource of ['issues', 'pull_requests', 'contents', 'actions']) manager.permissions['github_' + resource] = 'read';
  s.run("UPDATE settings SET value=? WHERE key='roles:r'", JSON.stringify(cfg));
}
// Grants without a model: the ceilings, the source, older tasks and the post_review boundary.
function grantFixture(t) {
  const s = new Store(':memory:', Buffer.alloc(32, 9)); t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')"); s.run("INSERT INTO repositories VALUES('r','fixture/r','1','a')");
  s.run("INSERT INTO policies(repository_id,enabled,development_enabled,capability_ceiling) VALUES('r',1,1,'develop')");
  const cfg = roleConfiguration(s, 'r'); cfg.enabled = true; s.run("INSERT INTO settings VALUES('roles:r',?)", JSON.stringify(cfg));
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('parent','r','task.request','running','Parent','{}')");
  s.run("INSERT INTO task_write_grants VALUES('parent','[\"pull_request\",\"review\",\"github\",\"actions_rerun\"]',1,'now')");
  new TaskRecords(s).contract('parent', { goal: 'Parent', scope: ['Parent'], criteria: ['Done'], endpoint: 'report' });
  const caller = roleTaskCaller(s, 'r', 'manager', { source_task_id: 'parent', guard() {} }), commands = new TaskCommands(s);
  const create = (args = {}) => commands.tool(caller, 'create_task', { request: 'Look into it', criteria: ['A factual answer'], ...args });
  return { s, caller, commands, create, task: id => s.get('SELECT * FROM tasks WHERE id=?', id) };
}

test('grant_writes widens within the ceilings and the Manager\'s own authority, narrows at once, and leaves older tasks on their path', t => {
  const { s, caller, commands, create, task } = grantFixture(t);
  const { id } = create();
  assert.deepEqual(grantedWrites(s, id), []);
  assert.throws(() => assertRequestPullRequest(s, task(id)), { code: 'delivery_not_granted' });
  // Unknown writes and a missing reason change nothing.
  assert.equal(commands.tool(caller, 'grant_writes', { task_id: id, writes: ['merge'], reason: 'x' }).error, 'invalid_task_writes');
  assert.equal(commands.tool(caller, 'grant_writes', { task_id: id, writes: ['pull_request'], reason: ' ' }).error, 'invalid_grant_reason');
  // Below develop the project refuses a PR, with the level it needs.
  s.run("UPDATE policies SET capability_ceiling='comment'");
  const refused = commands.tool(caller, 'grant_writes', { task_id: id, writes: ['pull_request'], reason: 'Needs a code change' });
  assert.equal(refused.error, 'capability_ceiling'); assert.equal(refused.granted, false); assert.equal(refused.write, 'pull_request'); assert.match(refused.instruction, /Nothing was changed/);
  assert.deepEqual(grantedWrites(s, id), []);
  // A Manager without a GitHub write cannot lend one: the source's ceiling and its own authority bound the grant.
  noGithubWrites(s);
  const github = commands.tool(caller, 'grant_writes', { task_id: id, writes: ['github'], reason: 'Comment on the Issue' });
  assert.equal(github.error, 'task_external_write_forbidden', JSON.stringify(github)); assert.deepEqual(grantedWrites(s, id), []);
  s.run("UPDATE policies SET capability_ceiling='develop'");
  // What the Manager is shown as grantable leaves out what it cannot lend.
  const manager = roleConfiguration(s, 'r').roles.find(role => role.role_id === 'manager').permissions;
  assert.deepEqual(grantView(s, task(id), [], [manager]).grantable, ['pull_request']);
  const ok = commands.tool(caller, 'grant_writes', { task_id: id, writes: ['pull_request'], reason: 'Needs a code change' });
  assert.deepEqual(ok.writes, ['pull_request']); assert.deepEqual(ok.effective, ['pull_request']);
  assert.deepEqual(taskPermissions(s, task(id)).writes, ['code', 'pull_request']);
  assertRequestPullRequest(s, task(id));
  assert.equal(s.get("SELECT count(*) n FROM audit WHERE action='task.grant_writes'").n, 1);
  // Lowering the ceiling narrows what the task holds at once, without changing the grant.
  s.run("UPDATE policies SET capability_ceiling='comment'");
  assert.throws(() => assertRequestPullRequest(s, task(id)), { code: 'capability_ceiling' });
  assert.deepEqual(grantedWrites(s, id), ['pull_request']);
  s.run("UPDATE policies SET capability_ceiling='develop'");
  // Narrowing needs no ceiling and takes effect at the next call.
  assert.deepEqual(commands.tool(caller, 'grant_writes', { task_id: id, writes: [], reason: 'A report is enough' }).writes, []);
  assert.throws(() => assertRequestPullRequest(s, task(id)), { code: 'delivery_not_granted' });
  // Only the Manager grants; a finished task and a task created before #814 cannot be granted writes.
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('old','r','task.development','queued','Old','{}')");
  const origin = { ...s.get('SELECT * FROM task_origins WHERE task_id=?', id), task_id: 'old' };
  s.run(`INSERT INTO task_origins(${Object.keys(origin).join(',')}) VALUES(${Object.keys(origin).map(() => '?').join(',')})`, ...Object.values(origin));
  assert.equal(commands.tool(caller, 'grant_writes', { task_id: 'old', writes: ['pull_request'], reason: 'x' }).error, 'task_writes_not_grantable');
  s.run("UPDATE tasks SET status='completed' WHERE id=?", id);
  assert.equal(commands.tool(caller, 'grant_writes', { task_id: id, writes: ['pull_request'], reason: 'x' }).error, 'task_already_delivered');
  // Managing tasks needs the delegation permission; even with it, only the controller grants writes.
  const cfg = roleConfiguration(s, 'r'); cfg.roles.find(role => role.role_id === 'dev').permissions.delegation = 'allow';
  s.run("UPDATE settings SET value=? WHERE key='roles:r'", JSON.stringify(cfg));
  const dev = roleTaskCaller(s, 'r', 'dev', { source_task_id: 'parent', guard() {} }), own = commands.tool(dev, 'create_task', { request: 'Dev work', criteria: ['Done'] });
  assert.ok(own.id, JSON.stringify(own));
  assert.equal(commands.tool(dev, 'grant_writes', { task_id: own.id, writes: ['pull_request'], reason: 'x' }).error, 'grant_writes_manager_only');
  // A person who manages the project's tasks may grant too.
  assert.deepEqual(commands.api({ id: 'operator', role: 'project_admin', repositories: ['r'] }, 'POST', new URL('http://local/api/tasks/' + create({ request: 'Another' }).id + '/writes'), { writes: ['pull_request'], reason: 'A person may grant too' }).writes, ['pull_request']);
});

test('creation maps intent and endpoint to writes and refuses what the ceilings do not allow, creating nothing', t => {
  const { s, create } = grantFixture(t);
  const development = create({ intent: 'development' }), endpoint = create({ request: 'By endpoint', endpoint: 'reviewable_pull_request' }), explicit = create({ request: 'Explicit', writes: ['pull_request'] });
  for (const { id } of [development, endpoint, explicit]) { assert.equal(s.get('SELECT kind FROM tasks WHERE id=?', id).kind, 'task.request'); assert.deepEqual(grantedWrites(s, id), ['pull_request']); }
  assert.equal(create({ request: 'Report', intent: 'report', writes: ['pull_request'] }).error, 'invalid_task_intent');
  const before = s.get('SELECT count(*) n FROM tasks').n;
  noGithubWrites(s);
  assert.equal(create({ request: 'Review', writes: ['review'] }).error, 'task_external_write_forbidden');
  s.run("UPDATE policies SET capability_ceiling='read'");
  const refused = create({ request: 'Comment', writes: ['github'] });
  assert.equal(refused.error, 'capability_ceiling'); assert.equal(refused.created, false);
  assert.equal(s.get('SELECT count(*) n FROM tasks').n, before);
});

test('post_review and github_write refuse without the grant and write nothing', async t => {
  const { s, create, task } = grantFixture(t);
  const { id } = create();
  let requests = 0;
  const server = createServer((_, res) => { requests++; res.writeHead(500); res.end('{}'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const write = grantedTaskWrite(s, task(id), new Redactor(), async () => {}, 'http://127.0.0.1:' + server.address().port);
  for (const [name, args] of [['post_review', { pull_number: 1, body: 'Looks fine', key: 'r1' }], ['github_write', { method: 'POST', path: '/issues/1/comments', body: { body: 'hi' }, key: 'c1' }]]) {
    const result = await write(name, args);
    assert.equal(result.error, 'delivery_not_granted'); assert.equal(result.tool, name); assert.match(result.missing, /^grant:/);
  }
  // With the grant, an inline comment without the line GitHub needs is refused before anything is sent.
  grantTaskWrites(s, task(id), { writes: ['review'], reason: 'Post the review' }, 'user:operator', []);
  const invalid = await grantedTaskWrite(s, task(id), new Redactor(), async () => {}, 'http://127.0.0.1:' + server.address().port)('post_review', { pull_number: 1, body: 'See inline', key: 'r2', comments: [{ path: 'calc.mjs', body: 'No line' }] });
  assert.equal(invalid.error, 'invalid_arguments');
  assert.equal(requests, 0);
});

test('the QA gate before a PR is on by default, shown with the policy and only takes a boolean', t => {
  const { s } = grantFixture(t);
  assert.equal(pullRequestQaGate(s, 'r'), true, 'independent QA before a PR is on by default');
  assert.deepEqual(policyView(s, s.get("SELECT * FROM policies WHERE repository_id='r'"), 'r').delivery_gates, { pull_request_qa: true });
  assert.throws(() => setDeliveryGates(s, 'r', { pull_request_qa: 'no' }, 'operator'), { code: 'invalid_delivery_gates' });
  assert.throws(() => setDeliveryGates(s, 'r', { merge: true }, 'operator'), { code: 'invalid_delivery_gates' });
  setDeliveryGates(s, 'r', { pull_request_qa: false }, 'operator');
  assert.equal(pullRequestQaGate(s, 'r'), false);
  // With the gate off, QA is skipped only for a project whose test command checks the candidate instead.
  assert.equal(pullRequestQaRequired(s, 'r'), true, 'no test command: QA still runs');
  s.run("UPDATE policies SET test_command='node --test' WHERE repository_id='r'");
  assert.equal(pullRequestQaRequired(s, 'r'), false);
  assert.deepEqual(policyView(s, s.get("SELECT * FROM policies WHERE repository_id='r'"), 'r').delivery_gates, { pull_request_qa: false });
});
