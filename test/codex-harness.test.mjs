// Contract tests of the Codex app-server dialect against test/fixtures/codex-app-server.mjs (a protocol double, not Codex).
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdtempSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {Store} from '../dist/storage/database.js';import {TaskRecords} from '../dist/tasks/service.js';import {runRole} from '../dist/roles/run.js';import {Redactor,TaskError} from '../dist/agent/common.js';
import {LineRpc,codexAppServer,deniedFeatures} from '../dist/harness/app-server.js';import {acpConfiguration} from '../dist/harness/acp.js';import {instanceUsage} from '../dist/roles/role-run.js';import {roleHarness} from '../dist/roles/harness.js';
const tool=name=>({type:'function',function:{name,description:name,parameters:{type:'object',properties:{},additionalProperties:true}}});
function fixture(t,env={},config={}){
 const root=mkdtempSync(join(tmpdir(),'bot-codex-')),key=randomBytes(32),file=join(root,'db'),home=join(root,'codex-home');let s=new Store(file,key);
 s.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/OpenToday','o','a')");s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('t','r','task.request','running','codex fixture','{}')");
 new TaskRecords(s).contract('t',{goal:'codex fixture',scope:['fixture'],criteria:['Read the task fact'],endpoint:'artifact'});
 const path=join(root,'codex.json');
 const configure=(e=env,c=config)=>writeFileSync(path,JSON.stringify({command:process.execPath,args:[resolve('test/fixtures/codex-app-server.mjs'),'app-server'],env:{CODEX_HOME:home,...e},stateDirectory:join(root,'sessions'),version:'0.166.0',timeoutMs:8000,cancelGraceMs:400,toolStartupMs:3000,...c}));
 configure();const old=process.env.BOT_CODEX_CONFIG;process.env.BOT_CODEX_CONFIG=path;
 t.after(()=>{s.close();if(old===undefined)delete process.env.BOT_CODEX_CONFIG;else process.env.BOT_CODEX_CONFIG=old;rmSync(root,{recursive:true,force:true});});
 const spec={store:s,task:s.get("SELECT * FROM tasks WHERE id='t'"),redactor:new Redactor(),guard:async()=>{},system:'Fixture role',prompt:'Read task:t and submit finish',tools:[tool('read_task_record'),tool('finish')],execute:async()=>({fact:'task fact'}),finish:{name:'finish',validate:v=>{assert.equal(typeof v.summary,'string');return v;}}};
 const lines=name=>existsSync(join(home,name))?readFileSync(join(home,name),'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
 return {get s(){return s;},spec,home,configure,lines,
  state:role=>JSON.parse(s.get('SELECT harness_state FROM role_instances WHERE role=?',role??'dev').harness_state),
  events:()=>s.all("SELECT data FROM task_history WHERE type='harness_event' ORDER BY id").map(r=>JSON.parse(r.data)),
  runEvents:()=>s.all("SELECT data FROM task_history WHERE type='role_run_event' ORDER BY id").map(r=>JSON.parse(r.data)),
  get reads(){return s.get("SELECT count(*) n FROM task_history WHERE type='role_record_read' AND json_extract(data,'$.via')='gateway'").n;},
  reopen(){s.close();s=new Store(file,key);return {...spec,store:s,task:s.get("SELECT * FROM tasks WHERE id='t'")};}};
}
const results=s=>s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n;

test('Codex app-server: handshake, verified task tools, thread/turn binding, structured events, no private reasoning',async t=>{
 // Fragmented output splits JSON lines and multi-byte characters at arbitrary byte boundaries.
 const f=fixture(t,{FIXTURE_TOKEN:'fixture-secret-171',FIXTURE_FRAGMENT:'true'});
 const out=await runRole(f.spec,'dev',undefined,'codex');
 assert.equal(out.result.summary,'actual fixture result');
 const state=f.state();
 assert.deepEqual([state.protocol,state.model,state.modelProvider,state.cliVersion,state.lastTurnStatus,state.recoveryMode],['codex-app-server','gpt-fixture','openai','0.166.0','completed','new_session']);
 const methods=f.lines('requests.jsonl').map(r=>r.method);
 assert.deepEqual(methods.slice(0,3),['initialize','initialized','thread/start']);
 assert.ok(methods.indexOf('mcpServerStatus/list')<methods.indexOf('turn/start'),'tools are verified before the first turn');
 assert.ok(methods.lastIndexOf('experimentalFeature/list')<methods.indexOf('turn/start'),'built-in tools are verified before the first turn');
 const started=f.lines('requests.jsonl').find(r=>r.method==='thread/start');assert.ok(started.keys.includes('developerInstructions')&&started.keys.includes('config'));
 const events=f.events(),bound=events.find(e=>e.type==='session_bound');
 assert.deepEqual([bound.threadId,bound.protocol,bound.tools,bound.sandbox,bound.model,bound.disabledBuiltins],[state.sessionId,'codex-app-server',['create_task','finish','list_managed_tasks','manage_task','read_managed_task','read_task_record'],{type:'readOnly'},'gpt-fixture',[...deniedFeatures]]);
 const turns=events.filter(e=>e.type==='turn');
 assert.deepEqual(turns.map(e=>[e.phase,e.status??null,e.usage??null]),[['started',null,null],['ended','completed','observed']]);
 assert.equal(state.lastTurnId,turns[0].turnId);
 const message=events.find(e=>e.type==='message');assert.match(message.text,/^公开输出 fixture public output/);assert.equal(message.turnId,turns[0].turnId);
 // The duplicate item/completed is dropped; a patch attempt under the read-only sandbox ends declined.
 const patches=events.filter(e=>e.type==='tool'&&e.itemType==='fileChange');
 assert.deepEqual(patches.map(e=>[e.phase,e.status]),[['started','inProgress'],['completed','declined']]);
 assert.ok(events.some(e=>e.type==='tool'&&e.itemType==='mcpToolCall'&&e.title==='bot.read_task_record'));
 const anomalies=events.filter(e=>e.stage==='protocol_anomaly').map(e=>e.anomaly).sort();
 assert.deepEqual(anomalies,['duplicate_item','unexpected_response','unknown_notification']);
 const all=JSON.stringify(f.s.all('SELECT data FROM task_history'));
 assert.ok(!all.includes('PRIVATE_FIXTURE_REASONING'),'private reasoning never enters the trace');
 assert.ok(!all.includes('fixture-secret-171'),'configured secrets are redacted');
 // The normalized RoleRun stream carries the thread binding, turn lifecycle and usage of this run.
 const types=f.runEvents().map(e=>e.type);
 for(const type of ['run_started','session_bound','turn','usage','tool_call','tool_result'])assert.ok(types.includes(type),type);
 const usage=instanceUsage(f.s,out.instance_id);
 assert.deepEqual([usage.model_requests,usage.input_tokens,usage.output_tokens,usage.unknown_requests,usage.semantics],[1,100,10,0,'exact']);
 assert.equal(f.reads,1);assert.equal(f.s.get("SELECT count(*) n FROM model_requests WHERE accounting_source='native'").n,0);assert.equal(f.s.get("SELECT count(*) n FROM model_requests WHERE accounting_source='codex_events'").n,1);
 assert.equal(f.s.get("SELECT recovery_mode FROM task_runs ORDER BY rowid DESC LIMIT 1").recovery_mode,'new_session');
});

test('Codex permission requests follow role authority and never wait for an administrator',async t=>{
 const f=fixture(t,{FIXTURE_PERMISSIONS:'true'});await runRole(f.spec,'dev',undefined,'codex');
 const answers=method=>f.lines('responses.jsonl').filter(r=>r.method===method).map(r=>r.response);
 assert.deepEqual(answers('item/commandExecution/requestApproval'),[{decision:'decline'},{decision:'decline'}]);
 assert.deepEqual(answers('item/fileChange/requestApproval'),[{decision:'decline'}]);
 assert.deepEqual(answers('item/permissions/requestApproval'),[{permissions:{}}]);
 // The Bot task tool server's own confirmation form is the authorized path; another server or a URL elicitation is declined.
 assert.deepEqual(answers('mcpServer/elicitation/request'),[{action:'accept',content:{}},{action:'decline'},{action:'decline'}]);
 assert.deepEqual(answers('item/tool/requestUserInput'),[{answers:{}}]);
 assert.equal(answers('item/tool/call')[0].success,false);
 assert.equal(answers('account/chatgptAuthTokens/refresh')[0].error.code,-32601);
 assert.equal(answers('attestation/generate')[0].error.code,-32601);
 assert.deepEqual([...answers('applyPatchApproval'),...answers('execCommandApproval')],[{decision:'abort'},{decision:'abort'}]);
 const permissions=f.events().filter(e=>e.type==='permission');
 // All ten server request methods of the locked version, plus one for another thread.
 assert.deepEqual([permissions.length,new Set(permissions.map(p=>p.method)).size],[13,codexAppServer.serverRequests.length]);
 assert.deepEqual(permissions.filter(p=>p.allowed).map(p=>p.serverName),['bot']);
 assert.equal(permissions.find(p=>p.threadId==='foreign-thread').reason,'foreign_thread');
 assert.equal(permissions.find(p=>p.method==='item/commandExecution/requestApproval').command,'curl https://example.invalid');
 const denied=f.s.all("SELECT data FROM task_history WHERE type='capability_denied'").map(r=>JSON.parse(r.data));
 assert.ok(denied.some(d=>d.tool==='codex:item/commandExecution/requestApproval'&&d.reason==='host_command_outside_role_authority'));
 assert.ok(denied.some(d=>d.tool==='codex:item/permissions/requestApproval'&&d.reason==='sandbox_escalation_outside_role_authority'));
 const categories=f.runEvents().filter(e=>e.type==='permission').map(e=>e.category);
 assert.deepEqual([categories.filter(c=>c==='progress').length,categories.filter(c=>c==='denied').length],[1,12]);
});

test('Codex resume continues the own thread, counts usage once and rebuilds explicitly when local state is lost',async t=>{
 const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const thread=f.state().sessionId;
 const spec=f.reopen();const second=await runRole(spec,'dev');
 assert.deepEqual([f.state().sessionId,f.state().recoveryMode],[thread,'native_resume']);
 assert.ok(f.lines('requests.jsonl').some(r=>r.method==='thread/resume'));
 assert.equal(f.s.get("SELECT recovery_mode FROM task_runs ORDER BY rowid DESC LIMIT 1").recovery_mode,'native_resume');
 // The restated thread total after resume is not new usage: two turns of 110 tokens each.
 const usage=instanceUsage(f.s,second.instance_id);assert.deepEqual([usage.model_requests,usage.total_tokens],[2,220]);
 assert.equal(f.reads,2);
 rmSync(join(f.home,'threads'),{recursive:true});
 await runRole(spec,'dev');
 const rebuilt=f.state();
 assert.notEqual(rebuilt.sessionId,thread);assert.deepEqual([rebuilt.recoveryMode,rebuilt.previousSessionId],['rebuilt_from_task_records',thread]);
 assert.ok(f.events().some(e=>e.recovery==='native_resume_failed'&&e.previousSessionId===thread));
});

test('Codex stream that ends before turn/completed fails; the next run reconciles the unconfirmed turn first',async t=>{
 const f=fixture(t,{FIXTURE_DISCONNECT:'true'});
 await assert.rejects(runRole(f.spec,'dev',undefined,'codex'),{code:'codex_connection_lost'});
 assert.equal(f.s.get("SELECT status FROM task_runs ORDER BY rowid DESC LIMIT 1").status,'fault');
 assert.equal(results(f.s),0);assert.equal(f.state().lastTurnStatus,'inProgress');
 const unconfirmed=f.state().lastTurnId;
 f.configure({});await runRole(f.spec,'dev');
 const bound=f.events().filter(e=>e.type==='session_bound').at(-1);
 assert.deepEqual(bound.reconciled,{turnId:unconfirmed,recorded:'inProgress',observed:'interrupted'});
 assert.match(f.lines('prompts.jsonl').at(-1).prompt,new RegExp(`previous turn ${unconfirmed} did not end with a confirmed completion \\(observed: interrupted\\)`));
});

test('Codex failures and version, model, tool or ownership mismatches are explicit and never complete the role',async t=>{
 const cases=[[{FIXTURE_FAIL:'true'},'codex_authentication_failed'],[{FIXTURE_NO_SUBMIT:'true'},'acp_submission_required'],[{FIXTURE_VERSION:'0.165.0'},'codex_version_unsupported'],
  [{FIXTURE_MODEL:'other-model'},'codex_model_mismatch',{model:'gpt-fixture'}],[{FIXTURE_EXTRA_SERVER:'true'},'codex_unauthorized_tool_servers'],[{FIXTURE_REROUTE:'true'},'codex_model_rerouted'],
  [{FIXTURE_MCP_FAIL:'true'},'codex_task_tools_unavailable'],[{FIXTURE_HOME:'/elsewhere'},'codex_home_unexpected'],[{FIXTURE_EXIT:'true'},'codex_connection_lost'],[{},'codex_version_unsupported',{version:'0.165.0'}]];
 for(const [env,code,config] of cases)await t.test(code+' '+JSON.stringify(env),async t=>{
  const f=fixture(t,env,config);await assert.rejects(runRole(f.spec,'dev',undefined,'codex'),{code});
  assert.equal(results(f.s),0);assert.equal(f.s.get("SELECT status FROM tasks WHERE id='t'").status,'running');
  if(code==='acp_submission_required')assert.equal(f.lines('prompts.jsonl').length,3,'two repair turns, then refusal');
  if(code==='codex_authentication_failed')assert.equal(f.events().filter(e=>e.type==='turn').at(-1).status,'failed');
 });
 await t.test('resume under another configured model is refused',async t=>{
  const f=fixture(t,{},{model:'gpt-fixture'});await runRole(f.spec,'dev',undefined,'codex');
  f.configure({},{model:'gpt-other'});await assert.rejects(runRole(f.spec,'dev'),{code:'codex_resume_incompatible'});
 });
 await t.test('a resumed thread from another session directory is refused',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');
  f.configure({FIXTURE_FOREIGN_CWD:'true'});await assert.rejects(runRole(f.spec,'dev'),{code:'codex_thread_ownership_mismatch'});
 });
});

test('Codex cancel interrupts the turn, waits for the terminal receipt, then reclaims the process; late results never complete',async t=>{
 for(const [env,receipt] of [[{FIXTURE_WAIT:'true'},'terminal'],[{FIXTURE_WAIT:'true',FIXTURE_IGNORE_INTERRUPT:'true'},'timeout'],[{FIXTURE_LATE:'true'},'terminal']])await t.test(JSON.stringify(env),async t=>{
  const f=fixture(t,env);let cancel=false;
  const run=runRole({...f.spec,guard:async()=>{if(cancel)throw new TaskError('task_cancelled','cancelled');}},'dev',undefined,'codex');
  const poll=setInterval(()=>{if(existsSync(join(f.home,'prompts.jsonl')))cancel=true;},20);
  await assert.rejects(run,{code:'task_cancelled'});clearInterval(poll);
  const turnId=f.state().lastTurnId;
  assert.deepEqual(f.lines('interrupts.jsonl').map(i=>i.turnId),[turnId]);
  const turns=f.events().filter(e=>e.type==='turn');
  assert.deepEqual(turns.filter(e=>e.phase==='interrupt_receipt').map(e=>e.receipt),[receipt]);
  assert.equal(results(f.s),0);assert.equal(f.s.get("SELECT status FROM task_runs ORDER BY rowid DESC LIMIT 1").status,'fault');
 });
});

// A stopped run's process group is gone and the tool call the agent tried after the stop was refused.
async function stopped(f){
 const pid=Number(readFileSync(join(f.home,'pid'),'utf8'));
 for(let i=0;i<50;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'process reclaimed');
 assert.deepEqual(f.lines('late-tools.jsonl').map(l=>l.accepted),[false],'tool call after the stop refused');
 assert.equal(results(f.s),0);assert.equal(f.s.get("SELECT status FROM task_runs ORDER BY rowid DESC LIMIT 1").status,'fault');
}

test('Codex built-in host tools are removed and verified before the first turn; one that acts anyway stops the run',async t=>{
 await t.test('thread policy and its verification',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');
  assert.deepEqual(f.lines('thread-params.jsonl'),[{method:'thread/start',approvalPolicy:'on-request',sandbox:'read-only',features:Object.fromEntries(deniedFeatures.map(n=>[n,false])),web_search:'disabled'}]);
  assert.equal(f.lines('requests.jsonl').filter(r=>r.method==='experimentalFeature/list').length,2,'every page of the feature state is read');
 });
 for(const env of [{FIXTURE_FEATURE_IGNORED:'true'},{FIXTURE_SANDBOX_IGNORED:'true'}])await t.test('server did not apply '+JSON.stringify(env),async t=>{
  const f=fixture(t,env);await assert.rejects(runRole(f.spec,'dev',undefined,'codex'),{code:'codex_builtin_tools_enabled'});
  assert.equal(f.lines('requests.jsonl').filter(r=>r.method==='turn/start').length,0,'no turn starts');
 });
 // The server runs a sandboxed command (or applies a patch, or spawns a sub-agent) without sending any approval request.
 for(const [env,code,tool] of [[{FIXTURE_BUILTIN_EXEC:'true'},'codex_builtin_tool_refused','codex:commandExecution'],[{FIXTURE_UNAPPROVED_PATCH:'true'},'codex_builtin_tool_refused','codex:fileChange'],[{FIXTURE_SUBAGENT:'true'},'codex_subagent_refused','codex:subAgentActivity'],[{FIXTURE_SAME_CHUNK:'true'},'codex_subagent_refused','codex:subAgentActivity']])
  await t.test(code+' '+tool+' '+Object.keys(env)[0],async t=>{
   const f=fixture(t,{...env,FIXTURE_IGNORE_INTERRUPT:'true'}),begun=Date.now();
   await assert.rejects(runRole(f.spec,'dev',undefined,'codex'),{code});
   assert.ok(Date.now()-begun<4000,'stopped within the grace period, not at the run timeout');
   const denied=f.s.all("SELECT data FROM task_history WHERE type='capability_denied'").map(r=>JSON.parse(r.data));
   assert.ok(denied.some(d=>d.tool===tool),tool);
   assert.equal(f.lines('responses.jsonl').length,0,'no approval request was involved');
   assert.equal(f.lines('interrupts.jsonl').length,1);
   await stopped(f);
  });
});

test('Codex model reroute stops the run within the grace period even when the interrupt is ignored',async t=>{
 const f=fixture(t,{FIXTURE_REROUTE:'true',FIXTURE_IGNORE_INTERRUPT:'true'}),begun=Date.now();
 await assert.rejects(runRole(f.spec,'dev',undefined,'codex'),{code:'codex_model_rerouted'});
 assert.ok(Date.now()-begun<4000,'not the run timeout');
 assert.deepEqual(f.events().filter(e=>e.phase==='interrupt_receipt').map(e=>e.receipt),['timeout']);
 await stopped(f);
});

test('Codex rebuilds only an explicitly missing thread, and never onto another model or provider',async t=>{
 await t.test('another resume error keeps the binding and fails for retry',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const before=f.state();
  f.configure({FIXTURE_RESUME_ERROR:'-32603:temporary database read failed; retry later',FIXTURE_MODEL:'different-default-model',FIXTURE_PROVIDER:'different-provider'});
  await assert.rejects(runRole(f.spec,'dev'),{code:'codex_resume_failed'});
  assert.deepEqual(f.state(),before);assert.equal(f.lines('requests.jsonl').filter(r=>r.method==='thread/start').length,1,'no new thread');
 });
 await t.test('a lost thread is not rebuilt on a different default model or provider',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const before=f.state();
  rmSync(join(f.home,'threads'),{recursive:true});f.configure({FIXTURE_MODEL:'different-default-model',FIXTURE_PROVIDER:'different-provider'});
  await assert.rejects(runRole(f.spec,'dev'),{code:'codex_resume_incompatible'});
  assert.deepEqual(f.state(),before);
 });
});

test('Codex turns without any usage report count as unknown requests, never as exact zero',async t=>{
 for(const [env,code] of [[{FIXTURE_DISCONNECT:'true'},'codex_connection_lost'],[{FIXTURE_WAIT:'true',FIXTURE_IGNORE_INTERRUPT:'true'},'task_cancelled'],[{FIXTURE_EXIT:'true'},'codex_connection_lost']])await t.test(JSON.stringify(env),async t=>{
  const f=fixture(t,env);let cancel=false,running=null;
  // A turn still in progress without usage is not counted yet; it counts once its run ended without a report.
  const poll=setInterval(()=>{if(env.FIXTURE_WAIT&&!cancel&&f.s.get("SELECT 1 FROM task_history WHERE type='harness_event' AND json_extract(data,'$.type')='turn' AND json_extract(data,'$.phase')='started'")){
   const u=instanceUsage(f.s,f.s.get("SELECT id FROM role_instances WHERE role='dev'").id);running=[u.model_requests,u.unknown_requests];cancel=true;}},20);
  await assert.rejects(runRole({...f.spec,guard:async()=>{if(cancel)throw new TaskError('task_cancelled','cancelled');}},'dev',undefined,'codex'),{code});clearInterval(poll);
  if(env.FIXTURE_WAIT)assert.deepEqual(running,[0,0]);
  const instance=f.s.get("SELECT id FROM role_instances WHERE role='dev'").id,usage=instanceUsage(f.s,instance);
  assert.deepEqual([usage.model_requests,usage.unknown_requests,usage.total_tokens,usage.semantics],[1,1,0,'lower_bound']);
 });
});

test('A turn start the server never answered is kept for reconciliation and counted once',async t=>{
 const run=async(env,expected)=>{
  const f=fixture(t,env);
  await assert.rejects(runRole(f.spec,'dev',undefined,'codex'),{code:'codex_connection_lost'});
  const [{turnId}]=f.lines('unanswered.jsonl'),instance=f.s.get("SELECT id FROM role_instances WHERE role='dev'").id,count=()=>{const u=instanceUsage(f.s,instance);return [u.model_requests,u.unknown_requests,u.total_tokens,u.semantics];};
  assert.deepEqual(count(),expected.first);
  assert.deepEqual([f.state().lastTurnId,f.state().lastTurnStatus],[expected.known?turnId:null,expected.known?'inProgress':'startRequested']);
  // The next run resumes the thread and reads the turn back before its own turn, then asks to check side effects.
  f.configure({});await runRole(f.spec,'dev');
  const methods=f.lines('requests.jsonl').map(r=>r.method),resumed=methods.lastIndexOf('thread/resume'),listed=methods.indexOf('thread/turns/list');
  assert.ok(resumed>=0&&listed>resumed&&listed<methods.lastIndexOf('turn/start'),'thread/turns/list after resume, before the turn');
  const bound=f.events().filter(e=>e.type==='session_bound').at(-1);
  assert.deepEqual(bound.reconciled,{turnId,recorded:expected.known?'inProgress':'startRequested',observed:'interrupted'});
  assert.match(f.lines('prompts.jsonl').at(-1).prompt,new RegExp(`previous turn ${turnId} did not end with a confirmed completion \\(observed: interrupted\\)`));
  assert.deepEqual(count(),expected.second);
 };
 // 110 tokens were reported for the turn before its start answer was lost: one request, exact.
 await t.test('usage and turn id arrived first',()=>run({FIXTURE_START_UNANSWERED:'true'},{known:true,first:[1,0,110,'exact'],second:[2,0,220,'exact']}));
 // Nothing ever named the turn: one unknown request, and resume finds the turn as the thread's newest.
 await t.test('no turn id ever arrived',()=>run({FIXTURE_START_SILENT:'true'},{known:false,first:[1,1,0,'lower_bound'],second:[2,1,110,'lower_bound']}));
 // A late notification of the turn known before the start does not name the unanswered turn.
 await t.test('a late notification of the previous turn',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const previous=f.state().lastTurnId;
  f.configure({FIXTURE_START_SILENT:'true',FIXTURE_LATE_PREVIOUS:'true'});
  await assert.rejects(runRole(f.spec,'dev'),{code:'codex_connection_lost'});
  assert.deepEqual([f.state().lastTurnId,f.state().lastTurnStatus,f.state().knownTurnId],[null,'startRequested',previous]);
  const [{turnId}]=f.lines('unanswered.jsonl');f.configure({});await runRole(f.spec,'dev');
  assert.deepEqual(f.events().filter(e=>e.type==='session_bound').at(-1).reconciled,{turnId,recorded:'startRequested',observed:'interrupted'});
  const u=instanceUsage(f.s,f.s.get("SELECT id FROM role_instances WHERE role='dev'").id);
  assert.deepEqual([u.model_requests,u.unknown_requests,u.semantics],[3,1,'lower_bound']);
 });
});

test('The last known turn survives a reconciliation that found nothing, and a standard turn/started names an unanswered turn',async t=>{
 const turns=f=>[f.state().lastTurnId,f.state().lastTurnStatus,f.state().knownTurnId],bound=f=>f.events().filter(e=>e.type==='session_bound').at(-1);
 await t.test('a late notification after a not_started reconciliation does not pose as the new turn',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const a=f.state().lastTurnId;
  // The server goes away before it creates the next turn: the binding only knows that a start was requested after A.
  f.configure({FIXTURE_EXIT:'true'});await assert.rejects(runRole(f.spec,'dev'),{code:'codex_connection_lost'});
  assert.deepEqual(turns(f).slice(0,2),[null,'startRequested']);const afterExit=f.state().knownTurnId;
  // Resume finds nothing newer than A; the next start creates turn C, a late notification of A arrives, the stream ends.
  f.configure({FIXTURE_START_SILENT:'true',FIXTURE_LATE_PREVIOUS:'true'});await assert.rejects(runRole(f.spec,'dev'),{code:'codex_connection_lost'});
  assert.deepEqual(bound(f).reconciled,{turnId:null,recorded:'startRequested',observed:'not_started'});
  assert.deepEqual(turns(f).slice(0,2),[null,'startRequested'],'the late notification of A does not name the new start');
  assert.deepEqual([afterExit,f.state().knownTurnId],[a,a],'A stays the last known turn through both');
  const [{turnId:c}]=f.lines('unanswered.jsonl');
  f.configure({});await runRole(f.spec,'dev');
  assert.deepEqual(bound(f).reconciled,{turnId:c,recorded:'startRequested',observed:'interrupted'});
 });
 await t.test('only a standard turn/started, no usage, then a cancel',async t=>{
  const f=fixture(t,{FIXTURE_START_HANG:'true'});let cancel=false,seen=0;
  const poll=setInterval(()=>{if(existsSync(join(f.home,'unanswered.jsonl'))&&++seen>5)cancel=true;},20);
  await assert.rejects(runRole({...f.spec,guard:async()=>{if(cancel)throw new TaskError('task_cancelled','cancelled');}},'dev',undefined,'codex'),{code:'task_cancelled'});clearInterval(poll);
  const [{turnId}]=f.lines('unanswered.jsonl');
  assert.deepEqual(f.lines('interrupts.jsonl').map(i=>i.turnId),[turnId],'the cancel interrupts the turn named by turn/started');
  assert.deepEqual(f.events().filter(e=>e.phase==='interrupt_receipt').map(e=>[e.turnId,e.receipt]),[[turnId,'terminal']]);
  assert.deepEqual(turns(f),[turnId,'interrupted',turnId]);
  const u=instanceUsage(f.s,f.s.get("SELECT id FROM role_instances WHERE role='dev'").id);
  assert.deepEqual([u.model_requests,u.unknown_requests,u.total_tokens,u.semantics],[1,1,0,'lower_bound']);
 });
 await t.test('an explicitly refused start leaves the turn binding as it was',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const before=turns(f);
  f.configure({FIXTURE_START_REFUSED:'true'});await assert.rejects(runRole(f.spec,'dev'),{code:'acp_execution_failed'});
  assert.deepEqual(turns(f).slice(0,2),[before[0],'completed']);assert.ok(!Object.hasOwn(f.state(),'previousTurnId'),'no field is left behind by the refused start');
  assert.deepEqual(turns(f),[before[0],'completed',before[0]]);
 });
});

test('Only the turn named by the start answer ends the start; a late turn id or terminal of an older turn does not',async t=>{
 // Two finished runs: turn B, then turn A, the last known one. B is older and can still send late notifications.
 const setup=async t=>{const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const b=f.state().lastTurnId;await runRole(f.spec,'dev');return {f,b,a:f.state().lastTurnId};};
 await t.test('answer C, then a late item and the terminal of B, in one chunk',async t=>{
  const {f,b}=await setup(t);
  f.configure({FIXTURE_STALE_TERMINAL:'true'});const out=await runRole(f.spec,'dev');
  const c=f.lines('prompts.jsonl')[2].turnId,events=f.events(),ended=events.slice(events.findLastIndex(e=>e.type==='session_bound')).filter(e=>e.type==='turn'&&e.phase==='ended');
  assert.notEqual(c,b);
  assert.deepEqual(ended.map(e=>[e.turnId,e.status]),[[c,'completed']],'one turn in this run, ended by C and not by the terminal of B');
  assert.deepEqual([f.state().lastTurnId,f.state().lastTurnStatus,f.state().knownTurnId],[c,'completed',c]);
  assert.equal(f.lines('prompts.jsonl').length,3,'no further turn started while C was still running');
  assert.equal(out.result.summary,'actual fixture result');
 });
 await t.test('no answer: a late item of B, then the turn/started of C',async t=>{
  const {f}=await setup(t);
  f.configure({FIXTURE_STALE_HINT:'true'});await assert.rejects(runRole(f.spec,'dev'),{code:'codex_connection_lost'});
  const [{turnId:c}]=f.lines('unanswered.jsonl');
  assert.deepEqual([f.state().lastTurnId,f.state().lastTurnStatus,f.state().knownTurnId],[c,'inProgress',c],'turn/started replaces the guess from the late item');
  f.configure({});await runRole(f.spec,'dev');
  assert.deepEqual(f.events().filter(e=>e.type==='session_bound').at(-1).reconciled,{turnId:c,recorded:'inProgress',observed:'interrupted'});
 });
 await t.test('cancel after a stale terminal waits for the answered turn itself',async t=>{
  // C starts after the answer and the stale terminal of B; C ignores the interrupt.
  const {f}=await setup(t),results=()=>f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n,before=results();
  f.configure({FIXTURE_STALE_TERMINAL:'true',FIXTURE_WAIT:'true',FIXTURE_IGNORE_INTERRUPT:'true'});
  let cancelAt=0;const poll=setInterval(()=>{if(!cancelAt&&f.lines('prompts.jsonl').length===3)cancelAt=Date.now();},20);
  await assert.rejects(runRole({...f.spec,guard:async()=>{if(cancelAt)throw new TaskError('task_cancelled','cancelled');}},'dev'),{code:'task_cancelled'});clearInterval(poll);
  const c=f.lines('prompts.jsonl')[2].turnId,events=f.events(),run=events.slice(events.findLastIndex(e=>e.type==='session_bound'));
  assert.deepEqual(f.lines('interrupts.jsonl').map(i=>i.turnId),[c]);
  assert.deepEqual(run.filter(e=>e.phase==='interrupt_receipt').map(e=>[e.turnId,e.receipt]),[[c,'timeout']],'the terminal of B is no receipt for C');
  const at=phase=>Date.parse(f.s.all("SELECT created_at,data FROM task_history WHERE type='harness_event' ORDER BY id").filter(r=>JSON.parse(r.data).phase===phase).at(-1).created_at);
  assert.ok(at('interrupt_receipt')-at('interrupt_requested')>=380,'the grace period (400 ms) was waited for C');
  assert.deepEqual(run.filter(e=>e.type==='turn'&&e.phase==='ended'),[],'C never ended');
  assert.equal(results(),before,'no role result');
 });
 await t.test('answer C, the late item and terminal of B, and an item of C that stops the run, all in one chunk',async t=>{
  const {f,b}=await setup(t),results=()=>f.s.get("SELECT count(*) n FROM task_history WHERE type='role_result'").n,before=results();
  f.configure({FIXTURE_STALE_TERMINAL:'true',FIXTURE_STALE_STOP:'true',FIXTURE_WAIT:'true',FIXTURE_IGNORE_INTERRUPT:'true'});
  await assert.rejects(runRole(f.spec,'dev'),{code:'codex_subagent_refused'});
  const c=f.lines('prompts.jsonl')[2].turnId,rows=f.s.all("SELECT created_at,data FROM task_history WHERE type='harness_event' ORDER BY id").map(r=>({at:Date.parse(r.created_at),...JSON.parse(r.data)}));
  const run=rows.slice(rows.findLastIndex(e=>e.type==='session_bound')),requested=run.filter(e=>e.phase==='interrupt_requested'),receipts=run.filter(e=>e.phase==='interrupt_receipt');
  assert.notEqual(c,b);
  assert.deepEqual(f.lines('interrupts.jsonl').map(i=>i.turnId),[c],'the stop interrupts C, not B');
  assert.deepEqual([requested.map(e=>e.turnId),receipts.map(e=>[e.turnId,e.receipt])],[[c],[[c,'timeout']]],'the same turn id is interrupted and awaited');
  assert.ok(receipts[0].at-requested[0].at>=380,'the grace period (400 ms) was waited for C');
  assert.deepEqual(run.filter(e=>e.type==='turn'&&e.phase==='ended'),[],'C never ended');
  assert.equal(results(),before,'no role result');
 });
});

test('A failure after the start answer named the turn keeps that turn for reconciliation',async t=>{
 // Fault injection: recording the turn's started event fails after the answer was accepted and the binding saved.
 const failStarted=f=>f.s.db.exec(`CREATE TRIGGER fail_started BEFORE INSERT ON task_history WHEN NEW.type='harness_event' AND json_extract(NEW.data,'$.phase')='started' BEGIN SELECT RAISE(ABORT,'injected started failure'); END;`);
 const turns=f=>[f.state().lastTurnId,f.state().lastTurnStatus,f.state().knownTurnId];
 const resumed=async(f,c)=>{f.s.db.exec('DROP TRIGGER fail_started');f.configure({});await runRole(f.spec,'dev');
  assert.deepEqual(f.events().filter(e=>e.type==='session_bound').at(-1).reconciled,{turnId:c,recorded:'inProgress',observed:'interrupted'});};
 await t.test('B was the hint and has a terminal, then the answer names C',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');await runRole(f.spec,'dev');
  failStarted(f);f.configure({FIXTURE_STALE_BEFORE:'true',FIXTURE_WAIT:'true'});
  await assert.rejects(runRole(f.spec,'dev'),{code:'acp_execution_failed'});
  const c=f.lines('prompts.jsonl')[2].turnId;
  assert.ok(f.events().some(e=>e.anomaly==='hint_not_started_turn'),'B was the hint when the answer named C');
  assert.deepEqual(turns(f),[c,'inProgress',c],'C stays the unconfirmed turn, not B/completed');
  assert.equal(f.events().filter(e=>e.phase==='start_unconfirmed').length,0);
  await resumed(f,c);
 });
 await t.test('no hint at all',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');
  failStarted(f);f.configure({FIXTURE_WAIT:'true'});
  await assert.rejects(runRole(f.spec,'dev'),{code:'acp_execution_failed'});
  const c=f.lines('prompts.jsonl')[1].turnId;
  assert.deepEqual(turns(f),[c,'inProgress',c]);
  assert.equal(f.events().filter(e=>e.phase==='start_unconfirmed').length,0,'the accepted C is not reported as a start without an answer');
  await resumed(f,c);
 });
 await t.test('the first save of C fails, after B was the hint and has a terminal',async t=>{
  const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');const b=f.state().lastTurnId;await runRole(f.spec,'dev');
  // Fault injection: the first harness_state UPDATE naming a new in-progress turn (C, not the hint B) fails; later writes pass.
  const run=f.s.run.bind(f.s);let failed=0;
  f.s.run=(sql,...args)=>{if(!failed&&/^UPDATE role_instances SET harness_state=/.test(sql)){const v=JSON.parse(args[0]);
   if(v.lastTurnStatus==='inProgress'&&v.lastTurnId&&v.lastTurnId!==b){failed++;throw new Error('injected harness_state failure');}}return run(sql,...args);};
  f.configure({FIXTURE_STALE_BEFORE:'true',FIXTURE_WAIT:'true'});
  await assert.rejects(runRole(f.spec,'dev'));f.s.run=run;
  const c=f.lines('prompts.jsonl')[2].turnId;assert.equal(failed,1);
  assert.deepEqual(turns(f),[c,'inProgress',c],'the database row names C, not the hint B');
  assert.equal(f.events().filter(e=>e.phase==='start_unconfirmed').length,0);
  f.configure({});await runRole(f.spec,'dev');
  assert.deepEqual(f.events().filter(e=>e.type==='session_bound').at(-1).reconciled,{turnId:c,recorded:'inProgress',observed:'interrupted'});
 });
 await t.test('an answered turn whose started event is missing counts once as unknown, by its id',async t=>{
  const f=fixture(t);const first=await runRole(f.spec,'dev',undefined,'codex');
  const usage=()=>{const u=instanceUsage(f.s,first.instance_id);return [u.model_requests,u.unknown_requests,u.total_tokens,u.semantics];};
  assert.deepEqual(usage(),[1,0,110,'exact'],'A');
  failStarted(f);f.configure({FIXTURE_WAIT:'true'});await assert.rejects(runRole(f.spec,'dev'),{code:'acp_execution_failed'});
  const c=f.lines('prompts.jsonl')[1].turnId;
  assert.deepEqual(usage(),[2,1,110,'lower_bound'],'A and the unreported C');
  assert.deepEqual(f.events().filter(e=>e.type==='turn'&&e.phase==='answered').map(e=>[e.turnId,e.usage]),[[c,'unknown']]);
  assert.equal(f.events().filter(e=>e.phase==='start_unconfirmed').length,0);
  // Resume without new usage for C, then D reports 110 tokens: C still counts once, D adds itself.
  f.s.db.exec('DROP TRIGGER fail_started');f.configure({});await runRole(f.spec,'dev');
  assert.deepEqual(usage(),[3,1,220,'lower_bound'],'A, C unknown once, D');
  // A usage report for C arriving later replaces its unknown request instead of adding to it.
  const runId=f.s.get("SELECT run_id FROM task_history WHERE type='harness_event' AND json_extract(data,'$.phase')='answered'").run_id;
  f.s.run("INSERT INTO task_history(task_id,type,data,created_at,run_id,actor) VALUES('t','harness_event',?,?,?,'harness')",JSON.stringify({type:'usage',source:'codex_app_server',turnId:c,delta:{input_tokens:40,output_tokens:10,total_tokens:50}}),new Date().toISOString(),runId);
  assert.deepEqual(usage(),[3,0,270,'exact'],'A, C by its report, D');
 });
});

test('A session refused before its binding counts a restated usage increment once, on the attempt that binds',async t=>{
 const f=fixture(t);const first=await runRole(f.spec,'dev',undefined,'codex');const before=f.state();
 assert.equal(before.usage.total,110);
 // The thread grew by 110 tokens the client never saw; every resume restates the total 220 before the extra server refuses it.
 f.configure({FIXTURE_EXTRA_SERVER:'true',FIXTURE_EARLY_USAGE:'true'});
 for(let i=0;i<2;i++)await assert.rejects(runRole(f.spec,'dev'),{code:'codex_unauthorized_tool_servers'});
 assert.deepEqual(f.state(),before);
 assert.equal(f.events().filter(e=>e.type==='usage').length,1,'the refused attempts recorded no usage');
 let usage=instanceUsage(f.s,first.instance_id);assert.deepEqual([usage.model_requests,usage.total_tokens],[1,110]);
 f.configure({FIXTURE_EARLY_USAGE:'true'});await runRole(f.spec,'dev');
 usage=instanceUsage(f.s,first.instance_id);
 assert.deepEqual([usage.model_requests,usage.total_tokens,usage.unknown_requests],[3,330,0],'110 + the restated 110 once + the new turn');
 assert.equal(f.state().usage.total,330);
});

test('Codex roles keep separate threads; QA always starts a new one',async t=>{
 const f=fixture(t);await runRole(f.spec,'dev',undefined,'codex');await runRole(f.spec,'reviewer',undefined,'codex');await runRole(f.spec,'qa',undefined,'codex');
 const first=f.state('qa').sessionId;await runRole(f.spec,'qa');
 const threads=f.s.all('SELECT harness_state FROM role_instances').map(r=>JSON.parse(r.harness_state).sessionId);
 assert.equal(new Set(threads).size,3);assert.notEqual(f.state('qa').sessionId,first);
 assert.equal(f.lines('requests.jsonl').filter(r=>r.method==='thread/resume').length,0,'no role resumed another role\'s thread');
 assert.deepEqual(roleHarness('codex').capabilities.recovery,['native_resume','rebuilt_from_task_records']);
});

test('LineRpc reassembles split lines and characters, correlates answers and fails pending requests on a broken stream',async()=>{
 const written=[],seen=[],anomalies=[];let failed=null;
 const rpc=new LineRpc(line=>written.push(JSON.parse(line)),{notification:(method,params)=>seen.push([method,params]),request:()=>{},anomaly:kind=>anomalies.push(kind),failed:error=>{failed=error;}});
 const pending=rpc.request('thread/start',{});const id=written[0].id;
 const bytes=Buffer.from([{method:'note',params:{text:'公开'}},{id,result:{ok:true}},{id,result:{ok:false}}].map(m=>JSON.stringify(m)+'\n').join(''));
 for(let i=0;i<bytes.length;i+=5)rpc.feed(bytes.subarray(i,i+5));
 assert.deepEqual(await pending,{ok:true});assert.equal(seen[0][1].text,'公开');assert.deepEqual(anomalies,['unexpected_response']);
 const second=rpc.request('turn/start',{});rpc.feed('not json\n');
 await assert.rejects(second,{code:'codex_protocol_invalid'});assert.equal(failed.code,'codex_protocol_invalid');
 await assert.rejects(rpc.request('turn/start',{}),{code:'codex_protocol_invalid'});
 assert.equal(codexAppServer.cli,'0.166.0');
});

test('Codex launch configuration refuses shared homes, daemons, unknown sandboxes and protocol mismatches',async t=>{
 const root=mkdtempSync(join(tmpdir(),'bot-codex-config-')),path=join(root,'codex.json'),old=process.env.BOT_CODEX_CONFIG;process.env.BOT_CODEX_CONFIG=path;
 t.after(()=>{if(old===undefined)delete process.env.BOT_CODEX_CONFIG;else process.env.BOT_CODEX_CONFIG=old;rmSync(root,{recursive:true,force:true});});
 const base={command:'codex',args:['app-server'],env:{CODEX_HOME:join(root,'home')},stateDirectory:join(root,'sessions'),version:'0.166.0'};
 const load=value=>{writeFileSync(path,JSON.stringify(value));return acpConfiguration('codex-app-server');};
 assert.equal(load(base).protocol,'codex-app-server');
 for(const bad of [{env:{}},{env:{CODEX_HOME:'relative'}},{env:{CODEX_HOME:join(process.env.HOME??'/root','.codex')}},{args:['app-server','proxy']},{args:['app-server','--listen','ws://127.0.0.1:1']},{args:['exec']},{sandbox:'danger-full-access'},{sandbox:'workspace-write'},{mode:'auto'},{protocol:'acp'},{version:undefined}])
  assert.throws(()=>load({...base,...bad}),{code:'acp_configuration_invalid'},JSON.stringify(bad));
 // The ACP launch file cannot be reused for Codex and the other way round.
 writeFileSync(path,JSON.stringify({...base,protocol:'codex-app-server'}));const acp=process.env.BOT_ACP_CONFIG;process.env.BOT_ACP_CONFIG=path;
 try{assert.throws(()=>acpConfiguration('acp'),{code:'acp_configuration_invalid'});}finally{if(acp===undefined)delete process.env.BOT_ACP_CONFIG;else process.env.BOT_ACP_CONFIG=acp;}
});

test('legacy absolute Harness timeout no longer kills active execution; explicit cancellation still interrupts',async t=>{
 const f=fixture(t,{FIXTURE_WAIT:'true'},{timeoutMs:1000});let cancel=false,settled=false;
 const run=runRole({...f.spec,guard:async()=>{if(cancel)throw new TaskError('task_cancelled','cancelled');}},'dev',undefined,'codex');
 const observed=run.finally(()=>settled=true);observed.catch(()=>{});
 await new Promise(r=>setTimeout(r,1600));assert.equal(settled,false);assert.ok(f.events().some(e=>e.stage==='legacy_timeout_ignored'));
 cancel=true;await assert.rejects(observed,{code:'task_cancelled'});assert.equal(f.events().some(e=>e.code==='harness_timeout'),false);
});
