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
import { ProjectMemory } from '../dist/memory/project.js';
import { authorizeKnowledgeTask } from './knowledge-fixture.mjs';
import { developmentTeam } from '../dist/roles/development.js';
import { roleApi } from '../dist/roles/api.js';
import { controllerWorkspace } from '../dist/roles/workspace.js';
import { Redactor } from '../dist/agent/common.js';
import { Workspace } from '../dist/agent/workspace.js';
import { LocalManager } from '../dist/projects/local-manager.js';
import { agentLoop } from '../dist/agent/loop.js';
import { eventWork } from '../dist/work/events.js';
import { releaseStorage } from '../dist/releases/storage.js';
import '../dist/releases/notes.js';

// The real Pi SDK (runner/node_modules) in a real runner workspace, driven by the control plane through the task mailbox.
// CI installs the runner dependencies and sets BOT_REQUIRE_PI=1, so a missing SDK fails there instead of skipping.
const sdk = existsSync('runner/node_modules/@earendil-works/pi-coding-agent/package.json');
const skip = !sdk && process.env.BOT_REQUIRE_PI !== '1' ? 'Pi SDK not installed: npm ci --prefix runner --omit=dev --ignore-scripts' : false;
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const results = messages => messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(text(m.content)); } catch { return { raw: text(m.content) }; } });
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function entryFixture(t, kind, respond, controlled = false) {
  const root = mkdtempSync(join(tmpdir(), 'bot-pi-entry-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root), bodies = [], logs = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); bodies.push(body);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: respond(body) }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(async () => { await manager.recover(); await new Promise(resolve => { model.close(resolve); model.closeAllConnections(); }); store.close(); rmSync(root, { recursive: true, force: true }); });
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')"); store.run("INSERT INTO repositories VALUES('101','fixture/pi','o','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)', 'm', '101', `http://127.0.0.1:${model.address().port}/v1`, 'fixture', store.secrets.seal({ value: 'entry-fixture-key' }, 'model:m'), 'now');
  store.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('101','m',1)");
  const environment = await manager.call('PUT', '/v1/projects/101');
  store.run('INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)', 't', '101', kind, 'Validate entry submission', '{}', 1, environment.generation, randomBytes(24).toString('hex'));
  new TaskRecords(store).contract('t', { goal: 'Inspect supplied facts', scope: ['report'], criteria: ['Valid factual report'], endpoint: 'report' });
  if (controlled) {
    authorizeKnowledgeTask(store);
    roleApi(store, { id: 'admin', role: 'project_admin', repositories: ['101'] }, 'PUT', new URL('http://local/api/repositories/101/roles'),
      { expected_revision: 0, enabled: true, controller: { entries: { review: true } }, roles: [{ role_id: 'manager', harness_ref: { id: 'native' } }] });
  }
  // Recording a new contract invalidates the old workspace; the engine allocates its replacement afterwards.
  store.run("UPDATE tasks SET workspace_id=?,generation=? WHERE id='t'", randomBytes(24).toString('hex'), environment.generation);
  const task = store.get("SELECT * FROM tasks WHERE id='t'"), redactor = new Redactor(), guard = async () => {}, workspace = new Workspace(store, manager, task, redactor, guard, value => logs.push(value));
  const initialized = await workspace.call('init', { type: 'workspace_init' });
  assert.equal(initialized.initialized, true);
  return { store, task, workspace, redactor, guard, bodies, logs };
}

for (const controlled of [false, true]) test(`Pi review entry repairs its own finish tool in one session (controlled=${controlled})`, { skip, timeout: 90000 }, async t => {
  let attempts = 0;
  const valid = { summary: 'Verified report', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' };
  const f = await entryFixture(t, 'review.issue', body => {
    if (body.tools.some(tool => tool.function.name === 'nominate_delivery')) {
      const ref = results(body.messages).find(result => result.result_ref)?.result_ref;
      return ref ? call('nominate_delivery', { result_ref: ref }) : call('delegate_role', { role: 'dev', purpose: 'Inspect the report', refs: ['task:t'] });
    }
    attempts++;
    if (attempts === 1) return call('finish_review', { ...valid, findings: [{ body: 'Inspect this line', format: 'inline', selection_reason: 'Changed line', actionable: false, within_goal: false, requires_human_decision: false, path: 'a.js', side: 'RIGHT', line: 'invalid-line' }] });
    return call('finish_review', attempts === 2 ? { ...valid, summary: 'x'.repeat(16001) } : valid);
  }, controlled);
  const result = await agentLoop(f.store, f.task, f.workspace, f.redactor, f.guard, {});
  assert.equal(result.summary, valid.summary); assert.equal(attempts, 3);
  assert.ok(f.bodies.some(body => results(body.messages).some(result => result.error === 'invalid_submission' && result.message.includes('model_review_invalid'))));
  assert.equal(f.logs.filter(log => log.type === 'pi_session').length, 1, 'correction uses the original Pi process and workspace');
  assert.equal(f.logs.filter(log => log.type === 'tool' && log.result?.submitted === true).length, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM tasks').n, 1);
});

test('Pi entry stops with the original validation fault after two unsuccessful repairs', { skip, timeout: 90000 }, async t => {
  let attempts = 0;
  const f = await entryFixture(t, 'review.issue', () => { attempts++; return call('finish_review', { summary: 'x'.repeat(16001), findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' }); });
  await assert.rejects(agentLoop(f.store, f.task, f.workspace, f.redactor, f.guard, {}), { code: 'model_review_invalid' });
  assert.equal(attempts, 3); assert.equal(f.logs.filter(log => log.type === 'pi_session').length, 1);
});

test('Pi event finish validates release-note source coverage before ending the session', { skip, timeout: 90000 }, async t => {
  let attempts = 0;
  const f = await entryFixture(t, 'release.notes', () => call('finish_release_notes', { groups: [{ heading: 'Fixes', source_ids: ++attempts === 1 ? [] : ['source-1'] }] }));
  releaseStorage(f.store);
  const result = await agentLoop(f.store, f.task, f.workspace, f.redactor, f.guard, { headings: ['Fixes'] }, undefined, undefined, undefined, {},
    { validateSubmission: value => eventWork('release.notes').checkResult(f.store, f.task, { sources: [{ id: 'source-1' }] }, value) });
  assert.deepEqual(result.groups, [{ heading: 'Fixes', source_ids: ['source-1'] }]); assert.equal(attempts, 2);
  assert.ok(f.bodies.some(body => results(body.messages).some(result => result.message?.includes('release_notes_invalid'))));
  assert.equal(f.logs.filter(log => log.type === 'pi_session').length, 1);
  assert.equal(f.store.get('SELECT count(*) n FROM project_releases').n, 0, 'validation does not publish or mutate release state');
});

test('a real Pi controller session delegates a role, reads its result by reference and nominates it; forbidden calls are refused', { skip, timeout: 180000 }, async t => {
  assert.ok(sdk, 'runner/node_modules must contain the Pi SDK');
  const root = mkdtempSync(join(tmpdir(), 'bot-pi-controller-')), store = new Store(':memory:', randomBytes(32)), manager = new LocalManager('101', root), bodies = [], logs = [], steps = {};
  t.after(async () => { await manager.recover(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); bodies.push(body);
    const tools = body.tools.map(t => t.function.name), done = results(body.messages), ref = done.find(r => r.result_ref)?.result_ref;
    let message;
    // Custom prompts replace the template, so recognize the controller by its offered tools.
    if (!tools.includes('nominate_delivery')) message = call('finish', { summary: 'implemented by dev' });
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
    { prepare: async () => {}, controller: controllerWorkspace(workspace), worker: controllerWorkspace(workspace) });
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
  assert.deepEqual(session.tools.sort(), ['acknowledge_coordination', 'create_task', 'delegate_role', 'finish_coordination', 'list_managed_tasks', 'list_project_tasks', 'manage_task', 'nominate_delivery', 'plan_task', 'read_child_tasks', 'read_coordination', 'read_managed_task', 'read_stage_schedule', 'read_task_history', 'read_task_record', 'record_progress', 'record_scope_difference', 'relate_task', 'request_task_coordination', 'set_task_priority', 'wait_for_children', 'wait_for_tasks']);
  const controllerDir = join(root, 'tasks', JSON.parse(store.get("SELECT runtime FROM role_instances WHERE role='manager'").runtime).workspace_id, 'agent');
  const state = JSON.parse(readFileSync(join(controllerDir, 'state.json'), 'utf8'));
  assert.deepEqual([state.state, state.agent, state.version], ['completed', 'pi', installed]);
  // Pi only ever offered the controller's tools to the model; the forbidden calls were refused by the control plane.
  const controllerBodies = bodies.filter(b => b.tools.some(t => t.function.name === 'nominate_delivery'));
  assert.ok(controllerBodies.length >= 4);
  for (const body of controllerBodies) {
    const system = text(body.messages[0].content);
    assert.ok(system.includes('You may edit files and merge pull requests yourself.'));
    assert.ok(!system.includes('Coordinate only.'));
    assert.ok(body.tools.every(t => session.tools.includes(t.function.name)));
  }
  const denied = store.all("SELECT data FROM task_history WHERE type='capability_denied'").map(row => JSON.parse(row.data));
  assert.ok(denied.some(d => d.tool === 'write_file' && d.reason === 'not_offered'));
  assert.ok(denied.some(d => d.reason === 'delegation_not_allowed' && d.requested_role === 'qa'));
  assert.equal(store.get("SELECT status FROM tasks WHERE id='t'").status, 'running');
  assert.ok(!JSON.stringify(store.all('SELECT * FROM task_history')).includes('pi-fixture-key'));
});

test('real Pi schedules configured parallel observers from durable task facts, without a task-specific workflow', { skip, timeout:180000 }, async t => {
  const root=mkdtempSync(join(tmpdir(),'bot-pi-stages-')),store=new Store(':memory:',randomBytes(32)),manager=new LocalManager('101',root);
  let step=0,devRef,readers=0,release;const barrier=new Promise(r=>release=r),bodies=[];
  t.after(async()=>{await manager.recover();store.close();rmSync(root,{recursive:true,force:true});});
  const model=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);bodies.push(body);const tools=body.tools.map(t=>t.function.name);let message;
    if(tools.includes('nominate_delivery')){
      const done=results(body.messages);devRef??=done.find(r=>r.result_ref)?.result_ref;
      message=[()=>call('delegate_role',{role:'dev',purpose:'Deliver a bounded artifact',refs:['task:t']}),()=>call('read_stage_schedule',{}),()=>call('delegate_roles',{assignments:[{role:'reviewer',stage_id:'reviewer',purpose:'Inspect artifact',refs:[devRef]},{role:'test',stage_id:'test',purpose:'Test artifact',refs:[devRef]}]}),()=>call('nominate_delivery',{result_ref:devRef})][step++]();
    }else if(tools.includes('submit_role_result')){
      if(body.messages.at(-1).role==='tool')message=call('submit_role_result',{summary:'Inspected retained artifact',findings:[],inspected_scope:['report'],unknowns:[]});
      else{if(++readers===2)release();await barrier;message=call('read_task_record',{ref:devRef});}
    }else message=call('finish',{summary:'retained bounded artifact'});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:10,completion_tokens:5}}));
  });model.listen(0,'127.0.0.1');await once(model,'listening');t.after(()=>new Promise(r=>{model.close(r);model.closeAllConnections();}));
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");store.run("INSERT INTO repositories VALUES('101','fixture/pi','o','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','101',`http://127.0.0.1:${model.address().port}/v1`,'fixture',store.secrets.seal({value:'pi-stage-fixture'},'model:m'),'now');store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  const environment=await manager.call('PUT','/v1/projects/101');store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t','101','task.request','running','artifact','{}',1,?,?)",environment.generation,randomBytes(24).toString('hex'));
  const records=new TaskRecords(store);records.contract('t',{goal:'Deliver artifact',scope:['report'],criteria:['Inspected and tested'],endpoint:'artifact'});
  const required_stages=['reviewer','test'].map(role=>({stage_id:role,depends_on:[],delivery_types:['artifact'],role_constraints:{kinds:['observer'],role_ids:[role],capabilities:['raw_evidence','fixed_candidate_read','fresh_context','output_validation'],independent:true},required:true,completion:{evidence_types:['tool_observation'],min_evidence:1,no_findings:true},retry:{max_attempts:3},budget:{max_tool_calls:8}}));
  roleApi(store,{id:'owner',role:'project_admin',repositories:['101']},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:0,enabled:true,roles:[{role_id:'manager',persona_prompt:'Delegate the artifact, then inspect and test the same version in parallel. Nominate after both stages pass.'}],required_stages});
  const task=store.get("SELECT * FROM tasks WHERE id='t'"),redactor=new Redactor(),guard=async()=>{},workspace=new Workspace(store,manager,task,redactor,guard,()=>{});
  const result=await runTeam({store,task,redactor,guard,system:'Artifact delivery',prompt:'{}',tools:[{type:'function',function:{name:'finish',description:'Submit artifact',parameters:{type:'object',properties:{summary:{type:'string'}},required:['summary']}}}],finish:{name:'finish',validate:v=>v}},
    {prepare:async()=>{},withRole:async(_role,work)=>work(),controller:controllerWorkspace(workspace),worker:controllerWorkspace(workspace)});
  assert.equal(result.summary,'retained bounded artifact');assert.equal(readers,2);
  assert.equal(store.get("SELECT count(*) n FROM task_stage_results WHERE json_extract(result,'$.passed')=1").n,2);
  assert.equal(store.get('SELECT count(*) n FROM task_stage_plans').n,1);assert.equal(store.get('SELECT count(*) n FROM tasks').n,1);assert.equal(store.get("SELECT status FROM tasks WHERE id='t'").status,'running');
  assert.equal(store.get("SELECT count(*) n FROM task_runs WHERE role='qa'").n,0,'nomination still awaits independent framework QA');
  assert.ok(bodies.filter(b=>b.tools.some(t=>t.function.name==='nominate_delivery')).every(b=>!b.tools.some(t=>['run_command','write_file','submit_acceptance'].includes(t.function.name))));
});

test('configured code flow checks out the collected commit for both observers and retains it for QA submission', { skip, timeout:180000 }, async t => {
  const root=mkdtempSync(join(tmpdir(),'bot-code-stages-')),store=new Store(':memory:',randomBytes(32)),manager=new LocalManager('101',root);let step=0,devRef,readers=0,release,privateMemoryId;const workerBodies=[];
  const barrier=new Promise(r=>release=r);t.after(async()=>{await manager.recover();store.close();rmSync(root,{recursive:true,force:true});});
  const model=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),tools=body.tools.map(t=>t.function.name);let message;
    if(tools.includes('nominate_delivery')){devRef??=results(body.messages).find(r=>r.result_ref)?.result_ref;message=[()=>call('delegate_role',{role:'dev',stage_id:'dev',purpose:'Implement',refs:[]}),()=>call('delegate_roles',{assignments:[{role:'reviewer',stage_id:'reviewer',purpose:'Inspect',refs:[devRef]},{role:'test',stage_id:'test',purpose:'Test',refs:[devRef]}]}),()=>call('nominate_delivery',{result_ref:devRef})][step++]();}
    else if(tools.includes('submit_role_result')){workerBodies.push(body);const receipts=results(body.messages);if(!receipts.length){if(++readers===2)release();await barrier;message=call('read_project_memory',{id:privateMemoryId,revision:1});}else if(!receipts.some(r=>r.content==='delivered\n'))message=call('read_file',{path:'result.txt'});else message=call('submit_role_result',{summary:'Read exact delivered files',findings:[],unknowns:[],inspected_scope:['result.txt']});}
    else message=body.messages.at(-1).role==='tool'?call('submit_delivery',{summary:'implemented',test_command:'fixture check'}):call('write_file',{path:'result.txt',content:'delivered\n'});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:10,completion_tokens:5}}));
  });model.listen(0,'127.0.0.1');await once(model,'listening');t.after(()=>new Promise(r=>{model.close(r);model.closeAllConnections();}));
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");store.run("INSERT INTO repositories VALUES('101','fixture/pi','o','a')");store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','101',`http://127.0.0.1:${model.address().port}/v1`,'fixture',store.secrets.seal({value:'pi-code-fixture'},'model:m'),'now');store.run("INSERT INTO policies(repository_id,model_id,enabled,development_enabled) VALUES('101','m',1,1)");
  const environment=await manager.call('PUT','/v1/projects/101');store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation,workspace_id) VALUES('t','101','development.issue','running','code','{}',1,?,?)",environment.generation,randomBytes(24).toString('hex'));
  const records=new TaskRecords(store);records.contract('t',{goal:'Deliver code',scope:['result.txt'],criteria:['Inspected and tested'],endpoint:'code'});
  const actor=authorizeKnowledgeTask(store);privateMemoryId=new ProjectMemory(store,{actor}).save('101','manager-only',{body:'MANAGER_ONLY_PRIVATE',kind:'experience',sources:[{reference:'fixture'}],catalog:{audience:'role:manager'}},0,'user:owner','private controller context').id;
  const required_stages=['dev','reviewer','test'].map(role=>({stage_id:role,depends_on:role==='dev'?[]:['dev'],delivery_types:['code'],role_constraints:{kinds:[role==='dev'?'writer':'observer'],role_ids:[role],capabilities:role==='dev'?['raw_evidence','output_validation']:['raw_evidence','fixed_candidate_read','fresh_context','output_validation'],independent:role!=='dev'},required:true,completion:{evidence_types:[role==='dev'?'role_result':'execution_evidence'],min_evidence:1,no_findings:role!=='dev'},retry:{max_attempts:3},budget:{max_tool_calls:8}}));
  roleApi(store,{id:'owner',role:'project_admin',repositories:['101']},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:0,enabled:true,roles:[],required_stages});
  const task=store.get("SELECT * FROM tasks WHERE id='t'"),redactor=new Redactor(),guard=async()=>{},workspace=new Workspace(store,manager,task,redactor,guard,()=>{});
  await workspace.call('seed-init',{type:'workspace_init'});await workspace.write('seed-write','result.txt',Buffer.from('baseline\n'));
  const seed=await workspace.call('seed-commit',{type:'workspace_command',command:'git init -q && git add result.txt && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm baseline',timeout_ms:10000});assert.equal(seed.exit_code,0);
  const result=await developmentTeam(workspace,'Implement code','{}',async()=>({pr:{number:1}}),{read:true,write:true,shell:true});
  assert.equal(result.summary,'implemented');assert.equal(readers,2);
  assert.ok(workerBodies.flatMap(b=>results(b.messages)).filter(r=>r.error==='memory_not_found').length>=2);assert.ok(!JSON.stringify(workerBodies).includes('MANAGER_ONLY_PRIVATE'));
  const stageResults=store.all('SELECT result FROM task_stage_results').map(r=>JSON.parse(r.result));assert.equal(stageResults.length,3);assert.ok(stageResults.every(r=>r.passed));
  const snapshots=stageResults.map(r=>r.candidate_ref);assert.equal(new Set(snapshots.map(s=>s.commit_sha)).size,1);assert.equal(new Set(snapshots.map(s=>s.tree_hash)).size,1);
  const submitted=await workspace.artifact('later-qa-submission');assert.equal(submitted.local_sha,snapshots[0].commit_sha);assert.equal(submitted.tree_sha,snapshots[0].tree_hash);
  assert.equal(store.get("SELECT status FROM tasks WHERE id='t'").status,'running');
});

test('Pi local command execution honors the configured cap, reports it, and retains background servers', { skip, timeout: 90000 }, async t => {
  const previous = process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS;
  process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = '450';
  t.after(() => { if (previous === undefined) delete process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS; else process.env.BOT_COMMAND_TIMEOUT_MAX_SECONDS = previous; });
  const commands = [
    { command: 'cat ../agent/live.json' },
    { command: 'cat ../agent/live.json', timeout_seconds: 400 },
    { command: 'cat ../agent/live.json', timeout_seconds: 900 },
    { command: `node -e 'const fs=require("node:fs"),s=require("node:http").createServer((q,r)=>r.end("pi-ready"));s.listen(0,"127.0.0.1",()=>fs.writeFileSync("port",String(s.address().port)))' > service.log 2>&1`, keep_background: true, timeout_seconds: 400 },
    { command: `node -e 'fetch("http://127.0.0.1:"+require("node:fs").readFileSync("port","utf8")).then(r=>r.text()).then(console.log)'` }
  ];
  const f = await entryFixture(t, 'review.issue', body => {
    const count = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).filter(c => c.function.name === 'run_command').length;
    return count < commands.length ? call('run_command', commands[count]) : call('finish_review', { summary: 'Verified local commands', findings: [], requires_code_change: false, issue_requests_code: false, clarification_required: false, implementation_goal: '', request_quote: '' });
  });
  assert.equal((await agentLoop(f.store, f.task, f.workspace, f.redactor, f.guard, {})).summary, 'Verified local commands');
  const done = f.logs.filter(l => l.type === 'tool' && l.name === 'run_command').map(l => l.result);
  assert.equal(done.length, 5);
  assert.deepEqual(done.slice(0, 3).map(r => JSON.parse(r.output).timeout_ms), [null, 400000, 450000]);
  assert.equal(done[2].timeout_notice.requested_seconds, 900); assert.equal(done[2].timeout_notice.max_seconds, 450);
  assert.equal(done[3].running, true); assert.equal(done[4].output.trim(), 'pi-ready');
});
