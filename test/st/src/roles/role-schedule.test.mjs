import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../../../../dist/storage/database.js';
import { TaskRecords } from '../../../../dist/tasks/service.js';
import { runTeam } from '../../../../dist/roles/team.js';
import { captureTaskConfiguration } from '../../../../dist/tasks/configuration.js';
import { runRole, roleInstance } from '../../../../dist/roles/run.js';
import { saveConfiguration } from '../../../../dist/roles/definition.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { traceEvent, beginRun } from '../../../../dist/tasks/trace.js';
import { latestRoleCandidate } from '../../../../dist/roles/schedule.js';
import '../../../fixtures/scripted-driver.mjs';

const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: true } } });
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: randomBytes(4).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const tree = c => c.repeat(40);

async function fixture(t, { roles = [], file = ':memory:', handler } = {}) {
  const key = randomBytes(32);
  const s = new Store(file, key), calls = [];
  s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");
  s.run("INSERT INTO repositories VALUES('r','fixture/stages','o','a')");
  s.run("INSERT INTO repositories VALUES('other','fixture/other','o','a')");
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push(body);
    const message = handler
      ? await handler(body)
      : JSON.parse(body.messages[1].content).role_context?.role === 'qa'
        ? call('finish', { outcome: 'pass', reason: 'verified', gaps: [], residuals: [], core_complete: true, required_evidence_complete: true, acceptable_risk: true })
        : body.tools.some(tool => tool.function.name === 'submit_role_result')
          ? (body.messages.at(-1).role === 'tool' ? call('submit_role_result', { summary: 'checked', findings: [], inspected_scope: ['fixture'], unknowns: [] }) : call('read_file', { path: 'fixture' }))
          : call('finish', { summary: 'implemented' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  s.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', 'r', `http://127.0.0.1:${server.address().port}/v1`, 'fixture', s.secrets.seal({ value: 'fixture-stages-key' }, 'model:m'), 'now');
  s.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('r','m',1,1)");
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt) VALUES('t','r','development.issue','running','stages','{}',1)");
  const records = new TaskRecords(s);
  records.contract('t', { goal: 'stages', scope: ['fixture'], criteria: ['verified'], endpoint: 'code' });
  const native = ['manager', 'dev', 'test', 'reviewer', 'ux', 'qa'].map(role_id => ({ role_id, harness_ref: { id: 'scripted' }, ...roles.find(r => r.role_id === role_id) }));
  saveConfiguration(s, 'r', { expected_revision: 0, enabled: true, roles: native }, 'owner');
  captureTaskConfiguration(s, 't');
  const spec = () => ({ store: s, task: s.get("SELECT * FROM tasks WHERE id='t'"), redactor: new Redactor(), guard: async () => {}, system: 'Execution', prompt: '{}', tools: [tool('finish')], finish: { name: 'finish', validate: v => v }, maxTurns: 4 });
  t.after(() => new Promise(r => { s.close(); server.close(r); server.closeAllConnections(); }));
  return {
    get s() { return s; },
    records,
    calls,
    spec,
    assign(role, id) {
      const instance = roleInstance(s, spec().task, role);
      s.run('INSERT INTO role_assignments VALUES(?,?,?,?,?,?,?,?)', id, 't', instance.id, records.get('t').revision, null, 'running', id, null);
      return id;
    },
    async writer(id = 'dev-1', sha = 'a', hash = 'b') {
      this.assign('dev', id);
      return runRole(spec(), 'dev', id, undefined, { snapshot: async () => ({ local_sha: tree(sha), tree_sha: tree(hash) }) });
    },
  };
}

test('later snapshot operations keep the collected commit for unchanged files, but changed trees create new inputs', async t => {
  const { Workspace } = await import('../../../../dist/agent/workspace.js');
  const f = await fixture(t);
  await f.writer();
  assert.equal(latestRoleCandidate(f.s, 't').commit_sha, tree('a'));
  let version = tree('b');
  const manager = { call: async () => ({ ok: true, result: { local_sha: tree('c'), tree_sha: version, files: [] } }) };
  const workspace = new Workspace(f.s, manager, f.spec().task, new Redactor(), async () => {}, () => {});
  assert.equal((await workspace.artifact('later-observer')).local_sha, tree('a'));
  version = tree('d');
  assert.equal((await workspace.artifact('changed-source')).local_sha, tree('c'));
});

test('a running manager stops when its GitHub read authority is revoked after preflight', async t => {
  let written;
  const f = await fixture(t, {
    handler: body => {
      if (body.tools.some(tool => tool.function.name === 'nominate_delivery')) {
        saveConfiguration(f.s, 'r', { expected_revision: 1, roles: [{ role_id: 'manager', permissions: { github_issues: 'none' } }] }, 'owner');
        return call('nominate_delivery', { result_ref: written.reference });
      }
      return call('finish', { summary: 'implemented' });
    },
  });
  written = await f.writer();
  await assert.rejects(runTeam(f.spec(), { prepare: async () => {} }), { code: 'role_authority_revoked', state: 'waiting_configuration' });
  assert.equal(f.s.get("SELECT stop_reason FROM task_runs WHERE role='manager'").stop_reason, 'role_authority_revoked');
  assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='delivery_nominated'").n, 0);
});

test('an overlong handoff returns existing limits without starting a role or aborting Manager', async t => {
  let observed = false;
  const f = await fixture(t, {
    handler: body => {
      const failure = body.messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } }).find(x => x.error === 'invalid_role_assignment');
      if (!failure) return call('delegate_role', { role: 'dev', purpose: 'large'.repeat(501), refs: ['task:t'] });
      observed = true;
      assert.equal(failure.limits.purpose_max_chars, 2000);
      assert.equal(failure.received.purpose_chars, 2505);
      assert.equal(failure.contract_ref, 'contract:revision:2');
      return call('finish_coordination', { action: 'continue', reason: 'Use a short purpose and retained contract refs for the next assignment.' });
    },
  });
  await assert.rejects(runTeam(f.spec(), { prepare: async () => {} }), { code: 'manager_deferred' });
  assert.equal(observed, true);
  assert.equal(f.s.get('SELECT count(*) n FROM role_assignments').n, 0);
});

test('Manager routes version queries and reads all Dev/QA records of its task through real role tools', async t => {
  const { versionTools, versionTool, resolveVersion } = await import('../../../../dist/tasks/versions.js');
  const { traceSnapshot } = await import('../../../../dist/tasks/trace.js');
  let step = 0;
  const seen = [];
  const f = await fixture(t, {
    handler: body => {
      const last = body.messages.at(-1);
      if (last?.role === 'tool') seen.push(JSON.parse(last.content));
      return [
        () => call('read_version_context', {}),
        () => call('read_task_record', { ref: checkpoint }),
        () => call('read_task_record', { ref: 'task_runs:' + qa.id + ':context' }),
        () => call('read_task_record', { ref: 'model_requests:qa-source:request' }),
        () => call('finish_coordination', { action: 'continue', reason: 'Read the offered version and all task records, no execution or acceptance.' }),
      ][step++]();
    },
  });
  const dev = beginRun(f.s, { id: 't' }, 'role', { role: 'dev' });
  f.s.run("UPDATE task_runs SET role='dev' WHERE id=?", dev.id);
  const checkpoint = traceEvent(f.s, 't', 'artifact_checkpoint', { tree_sha: tree('b'), marker: 'dev-checkpoint' }, dev.id);
  const qa = beginRun(f.s, { id: 't' }, 'role', { role: 'qa' });
  f.s.run("UPDATE task_runs SET role='qa',context_snapshot=? WHERE id=?", traceSnapshot({ marker: 'qa-context', captured: { ref: 'project_memories:role-private:1', body: 'captured-role-note' } }), qa.id);
  f.s.run("INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,run_id,request_snapshot) VALUES('qa-source','t','r','probe','m','fixture','now',?,?)", qa.id, traceSnapshot({ marker: 'qa-model-input', api_key: 'fixture-stages-key' }));
  const workspace = { task: { workspace_id: 'probe' }, call: async () => ({ local_sha: tree('a'), tree_sha: tree('b') }) };
  let routed = 0;
  await assert.rejects(runTeam({ ...f.spec(), tools: versionTools, execute: async (name, args) => { routed++; return versionTool(f.s, f.spec().task, workspace, name, args, async () => ({ defaultBranch: 'main', permissions: { contents: 'read' }, ref: async () => ({ object: { sha: tree('c') } }) })); } }, { prepare: async () => {} }), { code: 'manager_deferred' });
  assert.equal(routed, 1);
  assert.equal(resolveVersion(f.s, f.spec().task, seen[0].remote.current_main_ref).commit_sha, tree('c'));
  assert.ok(seen[1].content.includes('dev-checkpoint'));
  assert.ok(seen[2].content.includes('qa-context'));
  assert.ok(seen[2].content.includes('captured-role-note'));
  assert.ok(seen[3].content.includes('qa-model-input'));
  assert.ok(!JSON.stringify(seen).includes('fixture-stages-key'));
});

test('Manager can hand an authorized parent task reference to Dev without copying records', async t => {
  const { attachChild } = await import('../../../../dist/tasks/children.js');
  let delegated = false;
  const f = await fixture(t, {
    handler: body => {
      const role = JSON.parse(body.messages[1].content).role_context?.role;
      if (role === 'dev') {
        if (body.messages.at(-1).role !== 'tool') return call('read_managed_task', { task_id: 'parent' });
        assert.ok(body.messages.at(-1).content.includes('parent goal'));
        return call('finish', { summary: 'Read the handed-off parent task facts' });
      }
      if (!delegated) { delegated = true; return call('delegate_role', { role: 'dev', purpose: 'Read the parent goal from its durable task reference', refs: ['task:parent'] }); }
      const result = JSON.parse(body.messages.at(-1).content);
      assert.ok(result.result_ref);
      return call('finish_coordination', { action: 'continue', reason: 'Parent reference handoff completed' });
    },
  });
  f.s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('parent','r','development.issue','running','parent','{}')");
  f.records.contract('parent', { goal: 'parent goal', scope: ['fixture'], criteria: ['verified'], endpoint: 'code' });
  attachChild(f.s, 'parent', 't');
  await assert.rejects(runTeam(f.spec(), { prepare: async () => {} }), { code: 'manager_deferred' });
  assert.equal(f.s.get("SELECT count(*) n FROM role_assignments WHERE task_id='t' AND status='completed'").n, 1);
});

test('refused handoff refs are correctable observations and unrelated records stay task scoped', async t => {
  let step = 0;
  const seen = [];
  const f = await fixture(t, {
    handler: body => {
      const last = body.messages.at(-1);
      if (last?.role === 'tool') seen.push(JSON.parse(last.content));
      return [
        () => call('read_task_record', { ref: 'task:unrelated' }),
        () => call('delegate_role', { role: 'dev', purpose: 'Inspect', refs: ['task:missing'] }),
        () => call('delegate_role', { role: 'dev', purpose: 'Inspect', refs: ['task:unrelated'] }),
        () => call('finish_coordination', { action: 'continue', reason: 'Refusals are facts; retain the task and correct the references.' }),
      ][step++]();
    },
  });
  f.s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('unrelated','r','development.issue','running','unrelated','{}')");
  f.records.contract('unrelated', { goal: 'UNRELATED_PRIVATE_GOAL', scope: [], criteria: ['test'], endpoint: 'code' });
  await assert.rejects(runTeam(f.spec(), { prepare: async () => {} }), { code: 'manager_deferred' });
  assert.equal(seen[0].error, 'task_record_not_found');
  assert.equal(seen[1].error, 'invalid_task_reference');
  assert.equal(seen[2].error, 'invalid_task_reference');
  assert.ok(!JSON.stringify(seen).includes('UNRELATED_PRIVATE_GOAL'));
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='manager' AND status='fault'").n, 0);
  assert.equal(f.s.get('SELECT count(*) n FROM role_assignments').n, 0);
});

test('non-array parallel assignments return validation facts without aborting Manager', async t => {
  let step = 0;
  const f = await fixture(t, {
    handler: body => {
      if (step++ === 0) return call('delegate_roles', { assignments: 'invalid' });
      assert.equal(JSON.parse(body.messages.at(-1).content).error, 'parallel_observers_required');
      return call('finish_coordination', { action: 'continue', reason: 'Correct parallel assignment format' });
    },
  });
  await assert.rejects(runTeam(f.spec(), { prepare: async () => {}, withRole: async () => assert.fail('no role should start') }), { code: 'manager_deferred' });
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='manager' AND status='fault'").n, 0);
});

test('Manager corrects repeated wrong refs then reuses an accepted child without another Dev run', async t => {
  let step = 0;
  let f;
  f = await fixture(t, {
    handler: body => {
      assert.ok(body.tools.some(t => t.function.name === 'nominate_delivery'), 'no worker execution should be needed');
      if (step > 0 && step <= 4) {
        const feedback = JSON.parse(body.messages.at(-1).content);
        assert.equal(feedback.reason, 'reference_not_found_or_inaccessible');
        if (step === 3) assert.equal(feedback.manager_notice.attempts, 3);
      }
      return step++ < 4 ? call('nominate_delivery', { result_ref: 'task_history:999999' }) : call('nominate_delivery', { result_ref: 'task:child', summary: 'Integrated parent capability', change_title: 'Parent delivery' });
    },
  });
  f.s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('child','r','task.development','pr_opened','child','{}')");
  const child = f.records.get('child'), revision = child.revision;
  f.s.run("INSERT INTO task_children VALUES('t','child','now')");
  f.s.run("UPDATE tasks SET result=? WHERE id='child'", JSON.stringify({ summary: 'child done', change_title: 'Child result' }));
  f.s.run("UPDATE task_records SET candidate=?,acceptance=? WHERE task_id='child'", JSON.stringify({ id: 'c', revision, artifacts: [] }), JSON.stringify({ outcome: 'pass', revision, candidate_id: 'c' }));
  const result = await runTeam(f.spec(), { prepare: async () => {} });
  assert.equal(result.summary, 'Integrated parent capability');
  assert.equal(step, 5);
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='dev'").n, 0);
  assert.equal(f.s.get("SELECT count(*) n FROM task_runs WHERE role='manager'").n, 1);
  assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status, 'running', 'nomination is not acceptance');
  const nominated = JSON.parse(f.s.get("SELECT data FROM task_history WHERE task_id='t' AND type='delivery_nominated'").data);
  assert.equal(nominated.qa_required, true);
  assert.equal(nominated.sources[0].task_id, 'child');
  assert.equal(nominated.candidate_scope, 'current_parent_workspace');
});
