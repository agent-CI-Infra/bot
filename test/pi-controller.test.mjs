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
  assert.deepEqual(session.tools.sort(), ['acknowledge_coordination', 'delegate_role', 'list_project_tasks', 'nominate_delivery', 'plan_task', 'read_coordination', 'read_playbook', 'read_stage_schedule', 'read_task_history', 'read_task_record', 'record_progress', 'request_task_coordination', 'select_playbooks', 'wait_for_tasks']);
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
