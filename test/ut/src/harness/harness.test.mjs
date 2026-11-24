import { ResultSession, resultScope, projectResultOwner, readToolResult } from '../../../../dist/agent/tool-results.js';
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {roleHarness} from '../../../../dist/roles/harness.js';
import {request as httpRequest} from 'node:http';
import {roleApi} from '../../../../dist/roles/api.js';
import {Store} from '../../../../dist/storage/database.js';import {TaskRecords} from '../../../../dist/tasks/service.js';import {runRole} from '../../../../dist/roles/run.js';import {Redactor,TaskError} from '../../../../dist/agent/common.js';import {managedSession} from '../../../../dist/harness/session.js';import {taskToolServer,createTaskToolDispatcher,handleMailboxToolRequest} from '../../../../dist/roles/task-tools.js';
import { scriptedRoles } from '../../../fixtures/scripted-roles.mjs';
const tool=name=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{},additionalProperties:true}}});
function fixture(t,env={}){
 const root=mkdtempSync(join(tmpdir(),'bot-harness-')),key=randomBytes(32),file=join(root,'db'),codexHome=join(root,'codex-home'),sessions=join(root,'sessions');
 mkdirSync(codexHome,{recursive:true,mode:0o700});mkdirSync(sessions,{recursive:true,mode:0o700});
 let s=new Store(file,key);s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/OpenToday','o','a')");scriptedRoles(s,'r');s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','harness fixture','{}')");new TaskRecords(s).contract('t',{goal:'harness fixture',scope:['fixture'],criteria:['Read the task fact'],endpoint:'artifact'});
 const config=join(root,'codex.json');
 const writeConfig=(extraEnv=env)=>writeFileSync(config,JSON.stringify({command:process.execPath,args:[resolve('test/fixtures/codex-app-server.mjs'),'app-server'],version:'0.166.0',env:{CODEX_HOME:codexHome,...extraEnv},stateDirectory:sessions,cancelGraceMs:400,toolStartupMs:3000}));
 writeConfig();
 const old=process.env.BOT_CODEX_CONFIG;process.env.BOT_CODEX_CONFIG=config;
 t.after(()=>{s.close();if(old===undefined)delete process.env.BOT_CODEX_CONFIG;else process.env.BOT_CODEX_CONFIG=old;rmSync(root,{recursive:true,force:true});});
 let reads=0;const spec={store:s,task:s.get("SELECT * FROM tasks WHERE id='t'"),redactor:new Redactor(),guard:async()=>{},runAccess:{token:'rrt_'+'a'.repeat(12)+'.'+'b'.repeat(43),check:()=>{}},system:'Fixture role',prompt:'Read task:t and submit finish',tools:[tool('read_task_record'),tool('finish')],execute:async()=>{reads++;return {fact:'task fact'};},finish:{name:'finish',validate:v=>{assert.equal(typeof v.summary,'string');return v;}}};
 return {get s(){return s;},spec,codexHome,writeConfig,get reads(){return reads+s.get("SELECT count(*) n FROM task_history WHERE type='role_record_read' AND json_extract(data,'$.via')='gateway'").n;},reopen(){s.close();s=new Store(file,key);return {...spec,store:s};}};
}
test('Codex contract uses real protocol and stdio MCP, persists role binding across reopen, suppresses private reasoning',async t=>{const f=fixture(t,{FIXTURE_TOKEN:'fixture-secret-176'});const first=await runRole(f.spec,'dev',undefined,'codex');const binding=JSON.parse(f.s.get('SELECT harness_state FROM role_instances WHERE id=?',first.instance_id).harness_state);const spec=f.reopen(),second=await runRole(spec,'dev');assert.equal(first.instance_id,second.instance_id);assert.equal(JSON.parse(f.s.get('SELECT harness_state FROM role_instances WHERE id=?',first.instance_id).harness_state).sessionId,binding.sessionId);assert.equal(f.s.get("SELECT recovery_mode FROM task_runs ORDER BY rowid DESC LIMIT 1").recovery_mode,'native_resume');assert.equal(f.reads,2);const data=JSON.stringify(f.s.all('SELECT data FROM task_history'));assert.ok(!data.includes('PRIVATE_FIXTURE_REASONING'));assert.ok(!data.includes('fixture-secret-176'));const view=roleApi(f.s,{id:'u',role:'project_admin',repositories:['r']},'GET',new URL('http://local/api/tasks/t/roles'),{});assert.equal(view.instances[0].harness_state.sessionId,binding.sessionId);assert.ok(!Object.hasOwn(view.instances[0],'session'));assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,'running');assert.ok(f.s.get("SELECT id FROM task_history WHERE type='tool_observation'"));});
test('Codex role contexts stay separate; QA always starts a new external session',async t=>{const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');await runRole(f.spec,'reviewer',undefined,'codex');await runRole(f.spec,'qa',undefined,'codex');const before=JSON.parse(f.s.get("SELECT harness_state FROM role_instances WHERE role='qa'").harness_state).sessionId;await runRole(f.spec,'qa');const sessions=f.s.all('SELECT harness_state FROM role_instances').map(r=>JSON.parse(r.harness_state).sessionId);assert.equal(new Set(sessions).size,3);assert.ok(!sessions.includes(before));});
test('Codex missing thread rebuilds explicitly rather than claiming original session',async t=>{const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');rmSync(join(f.codexHome,'threads'),{recursive:true,force:true});await runRole(f.spec,'dev');const state=JSON.parse(f.s.get('SELECT harness_state FROM role_instances').harness_state);assert.equal(state.recoveryMode,'rebuilt_from_task_records');assert.notEqual(state.sessionId,state.previousSessionId);});
test('Codex process exit and missing role submission cannot complete the task',async t=>{for(const env of [{FIXTURE_EXIT:'true'},{FIXTURE_NO_SUBMIT:'true'}])await t.test(JSON.stringify(env),async t=>{const f=fixture(t,env);await assert.rejects(runRole(f.spec,'dev',undefined,'codex'));assert.equal(f.s.get("SELECT status FROM task_runs ORDER BY rowid DESC LIMIT 1").status,'fault');assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,'running');assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n,0);});});
test('Codex cancellation observes task guard while waiting for an agent turn',async t=>{const f=fixture(t,{FIXTURE_WAIT:'true'});let cancel=false;const execution=runRole({...f.spec,guard:async()=>{if(cancel)throw new TaskError('task_cancelled','cancelled');}},'dev',undefined,'codex');setTimeout(()=>{cancel=true;},400);await assert.rejects(execution,{code:'task_cancelled'});assert.equal(f.s.get("SELECT status FROM task_runs ORDER BY rowid DESC LIMIT 1").status,'fault');});
test('public session lifecycle cancels without reporting successful completion and closes resources once',async()=>{const events=[];let disposed=0;const session=managedSession(signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),e=>events.push(e),async()=>{disposed++;});const pending=session.run();await session.cancel();await assert.rejects(pending,{code:'harness_cancelled'});await session.close();await session.close();assert.equal(disposed,1);assert.equal(events.at(-1).status,'cancelled');await assert.rejects(session.run(),/unavailable/);});
test('MCP exposes only offered tools, serializes submission and rejects post-submission work',async t=>{const f=fixture(t),bridge=await taskToolServer(f.spec);t.after(()=>bridge.close());const call=async(name,args={})=>(await (await fetch(bridge.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;assert.equal((await call('unknown')).isError,true);await call('finish',{summary:'result'});assert.equal(bridge.submitted,true);assert.equal((await call('read_task_record')).isError,true);assert.equal(f.reads,0);});

test('Process and Codex expose the same cancellable session factory',async t=>{for(const harness of ['process','codex'])await t.test(harness,async t=>{const f=fixture(t,{FIXTURE_WAIT:'true'});const services={guard:async()=>{},model:{},request:async()=>{await new Promise(resolve=>setTimeout(resolve,150));return {value:{choices:[{message:{role:'assistant',content:'late response'}}]}};}};const session=roleHarness(harness).createSession(f.spec,services);const pending=session.run();setTimeout(()=>void session.cancel(),40);await assert.rejects(pending,{code:'harness_cancelled'});await session.close();const events=f.s.all("SELECT data FROM task_history WHERE type='harness_event'").map(r=>JSON.parse(r.data));assert.equal(events.at(-1).status,'cancelled');});});

test('MCP preserves UTF-8 tool arguments split inside a multibyte character', async t => {
 const f=fixture(t);let observed;
 const spec={...f.spec,tools:[...f.spec.tools,tool('write_file')],execute:async(name,args)=>{assert.equal(name,'write_file');observed=args.content;return {written:true};}};
 const bridge=await taskToolServer(spec);t.after(()=>bridge.close());
 const raw=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'write_file',arguments:{path:'example.txt',content:'测试😀'}}}));
 const split=raw.indexOf(Buffer.from('测'))+1;
 const response=await new Promise((resolve,reject)=>{const req=httpRequest(bridge.url,{method:'POST'},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve(JSON.parse(raw)));});req.on('error',reject);req.write(raw.subarray(0,split));setTimeout(()=>req.end(raw.subarray(split)),20);});
 assert.equal(response.result.isError,false);assert.equal(observed,'测试😀');
});


test('managed session preserves a Manager stop reason instead of converting it to user cancellation',async()=>{
 const reason=new TaskError('manager_execution_stopped','retry_wait','retain and replan');let started;
 const bound=new Promise(resolve=>started=resolve),events=[];
 const session=managedSession(async signal=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {summary:'late result'};},event=>events.push(event));
 const run=session.run();await bound;await session.cancel(reason);await assert.rejects(run,error=>error===reason);assert.equal(events.at(-1).code,'manager_execution_stopped');await session.close();
});


test('Codex loads an ordinary pinned Skill over stdio MCP and rebuilds an obsolete external session without old tools', async t => {
 const f=fixture(t,{FIXTURE_SKILL:'true'}),url=new URL('http://local/api/repositories/r/roles'),actor={id:'admin',role:'project_admin',repositories:['r']};
 const saved=roleApi(f.s,actor,'PUT',url,{expected_revision:0,enabled:true,skills:[{id:'inspection',source:{type:'inline',files:[{path:'SKILL.md',content:'Inspect the actual source before reporting a defect.'}]}}],roles:[{role_id:'dev',harness_ref:{id:'codex'},skill_bundle_ref:{id:'inspection'}}]}).configuration;
 const first=await runRole(f.spec,'dev'),binding=JSON.parse(f.s.get('SELECT harness_state FROM role_instances WHERE id=?',first.instance_id).harness_state);
 assert.equal(first.result.summary,'Inspect the actual source before reporting a defect.');
 assert.deepEqual([first.result.bundle.revision,first.result.bundle.content_hash,first.result.sha256],[saved.skills[0].revision,saved.skills[0].content_hash,saved.skills[0].files[0].sha256]);
 assert.ok(!first.result.provided_tools.some(name=>['read_playbook','select_playbooks'].includes(name)));
 const row=f.s.get('SELECT snapshot_id FROM role_instances WHERE id=?',first.instance_id),snapshot=JSON.parse(f.s.get('SELECT snapshot FROM role_snapshots WHERE id=?',row.snapshot_id).snapshot);
 snapshot.capability.tools.push('read_playbook','select_playbooks');
 f.s.run('INSERT INTO role_snapshots VALUES(?,?,?,?,?,?,?)','old-codex-snapshot','r','dev',1,1,JSON.stringify(snapshot),'now');
 f.s.run("UPDATE role_instances SET snapshot_id='old-codex-snapshot' WHERE id=?",first.instance_id);
 const second=await runRole(f.spec,'dev'),next=JSON.parse(f.s.get('SELECT harness_state FROM role_instances WHERE id=?',first.instance_id).harness_state);
 assert.equal(second.instance_id,first.instance_id);assert.notEqual(next.sessionId,binding.sessionId);assert.notEqual(next.recoveryMode,'native_resume');
 assert.equal(second.result.summary,first.result.summary);assert.ok(f.s.get("SELECT 1 FROM task_history WHERE type='role_guidance_migrated'"));
 assert.equal(f.s.get("SELECT count(*) n FROM task_history WHERE type='skill_read'").n,2);
});

test('transport-agnostic task tool dispatcher runs non-submission tools in parallel, drains before single submission, checks policy and enforces mailbox run tokens', async t => {
  const f = fixture(t);
  f.s.run("INSERT INTO policies(repository_id,enabled,development_enabled) VALUES('r',1,1)");
  const order = [], resolvers = new Map();
  let tokenState = 'ok', validatedCount = 0;
  const spec = {
    ...f.spec,
    tools: [tool('inspect_a'), tool('inspect_b'), tool('finish')],
    runAccess: {
      token: 'rrt_' + 'a'.repeat(12) + '.' + 'b'.repeat(43),
      check: () => { if (tokenState !== 'ok') throw new TaskError(tokenState, 'failed'); }
    },
    execute: (name, args) => new Promise(resolve => {
      resolvers.set(name, () => { order.push(name); resolve({ inspected: name, ...args }); });
    }),
    finish: {
      name: 'finish',
      validate: async v => {
        validatedCount++;
        order.push('validate:' + v.summary);
        await new Promise(resolve => setTimeout(resolve, 10));
        return v;
      }
    }
  };
  const dispatcher = createTaskToolDispatcher(spec);
  // Start two parallel non-submission calls and finish them out of order.
  const callA = dispatcher.call(dispatcher.token, { id: '1'.repeat(48), name: 'inspect_a', arguments: { n: 1 }, transport: 'mailbox' });
  const callB = dispatcher.call(dispatcher.token, { id: '2'.repeat(48), name: 'inspect_b', arguments: { n: 2 }, transport: 'mailbox' });
  while (resolvers.size < 2) await new Promise(resolve => setTimeout(resolve, 5));
  // Submit two concurrent finish calls while inspect_a is still in flight; inspect_b completes first, then inspect_a.
  const fin1 = dispatcher.call(dispatcher.token, { id: '3'.repeat(48), name: 'finish', arguments: { summary: 'first' }, transport: 'mailbox' });
  const fin2 = dispatcher.call(dispatcher.token, { id: '4'.repeat(48), name: 'finish', arguments: { summary: 'second' }, transport: 'mailbox' });
  resolvers.get('inspect_b')();
  assert.deepEqual((await callB).observation, { inspected: 'inspect_b', n: 2 });
  assert.equal(validatedCount, 0, 'finish waits for in-flight non-submission tools before validating');
  resolvers.get('inspect_a')();
  assert.deepEqual((await callA).observation, { inspected: 'inspect_a', n: 1 });
  const [out1, out2] = await Promise.all([fin1, fin2]);
  assert.equal(validatedCount, 1);
  assert.equal(out1.submitted !== out2.submitted, true);
  assert.deepEqual(out1.submitted ? out2.observation : out1.observation, { error: 'execution_already_submitted' });
  assert.deepEqual(order.slice(0, 2), ['inspect_b', 'inspect_a']);
  assert.equal(dispatcher.submitted, true);

  // Mailbox token enforcement: forged/missing/revoked tokens are refused, delivered to the caller and recorded as capability_denied.
  const fresh = createTaskToolDispatcher(spec);
  const chunks = [];
  const forged = await handleMailboxToolRequest(fresh, spec.redactor, { id: '5'.repeat(48), name: 'inspect_a', arguments: {}, token: 'forged' }, async chunk => { chunks.push(chunk); return {}; });
  assert.deepEqual(forged.observation, { error: 'run_token_invalid' });
  assert.equal(chunks.length, 1);
  tokenState = 'run_token_revoked';
  await assert.rejects(handleMailboxToolRequest(fresh, spec.redactor, { id: '6'.repeat(48), name: 'inspect_a', arguments: {}, token: fresh.token }, async () => ({})), { code: 'run_token_revoked' });

  // Disabling the repository policy refuses tool calls immediately with repository_policy_disabled.
  tokenState = 'ok';
  f.s.run("UPDATE policies SET enabled=0 WHERE repository_id='r'");
  await assert.rejects(fresh.call(fresh.token, { id: '7'.repeat(48), name: 'inspect_a', arguments: {}, transport: 'mailbox' }), { code: 'repository_policy_disabled' });
  const denied = f.s.all("SELECT data FROM task_history WHERE type='capability_denied'").map(r => JSON.parse(r.data).reason);
  assert.ok(denied.includes('run_token_invalid'));
  assert.ok(denied.includes('run_token_revoked'));
  assert.ok(denied.includes('repository_policy_disabled'));
  await dispatcher.close();
  await fresh.close();
});


test('a large gateway result is saved before MCP/mailbox tracing even when the role executor bypasses resultSpec',async t=>{
  const f=fixture(t),files=new ResultSession(f.s,resultScope(f.s,f.spec.task),()=>projectResultOwner('r'),f.spec.guard);
  const payload={revision:'gateway-revision',content:'中😀'.repeat(500000)},dispatcher=createTaskToolDispatcher({...f.spec,resultSession:files,tools:[tool('read_task_record'),readToolResult],
    execute:async(name,args)=>name==='read_tool_result'?files.read(args):payload});
  t.after(()=>dispatcher.close());
  const out=await dispatcher.call(dispatcher.token,{id:'a'.repeat(48),name:'read_task_record',arguments:{},transport:'mailbox'});
  assert.ok(out.observation.file);assert.equal(out.observation.revision,'gateway-revision');assert.ok(Buffer.byteLength(JSON.stringify(out.observation))<256*1024);
  const page=await dispatcher.call(dispatcher.token,{id:'b'.repeat(48),name:'read_tool_result',arguments:{file:out.observation.file,length:65536},transport:'http'});
  assert.match(page.observation.content,/gateway-revision/);assert.equal(page.observation.eof,false);
  const record=f.s.get("SELECT data FROM task_history WHERE type='tool_observation' ORDER BY id LIMIT 1");assert.ok(record);assert.ok(record.data.length<256*1024,'trace keeps the preview and handle');
});
