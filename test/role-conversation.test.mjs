import test from 'node:test';
import { modelSnapshot } from '../dist/storage/payloads.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/storage/database.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { RoleConversations } from '../dist/roles/conversation.js';
import { roleTaskCaller } from '../dist/tasks/management.js';
import { roleApi } from '../dist/roles/api.js';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { LocalManager } from '../dist/projects/local-manager.js';
import { DatabaseSync } from 'node:sqlite';
import { beginModelRequest,finishModelRequest,externalModelRecorder } from '../dist/metrics/accounting.js';
import { instanceUsage } from '../dist/roles/role-run.js';

async function fixture(t,harness,budget,stall=false){
  const store=new Store(':memory:',Buffer.alloc(32,8)),root=mkdtempSync(join(tmpdir(),'role-conversation-')),manager=new LocalManager('101',root),requests=[];
  const external=['acp','codex','claude_code'].includes(harness),claudeModel='claude-sonnet-4-5-20250929';let began;const started=new Promise(resolve=>{began=resolve;});
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:claudeModel}]}));return;}
    let text='';for await(const c of req)text+=c;const body=JSON.parse(text);requests.push(body);began();if(stall)await new Promise(()=>{});
    if(harness==='claude_code'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture-provider-response',type:'message',model:claudeModel,role:'assistant',content:[{type:'text',text:'Fixture response'}],usage:{input_tokens:9,output_tokens:3}}));return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'reply-'+requests.length,type:'function',function:{name:'finish',arguments:JSON.stringify({message:'A source-bound response'})}}]}}],usage:{prompt_tokens:9,completion_tokens:3}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  if(external){
    const name=harness==='acp'?'BOT_ACP_CONFIG':harness==='codex'?'BOT_CODEX_CONFIG':'BOT_CLAUDE_CODE_CONFIG',file=join(root,'config.json'),prior=process.env[name];
    const stateDirectory=join(root,'sessions');mkdirSync(stateDirectory,{mode:0o700});
    const config={command:process.execPath,args:[resolve('test/fixtures/'+(harness==='acp'?'acp-agent.mjs':'codex-app-server.mjs'))],env:{FIXTURE_CONVERSATION:'true',CODEX_HOME:join(root,'codex-home')},stateDirectory,version:harness==='codex'?'0.166.0':'1',timeoutMs:8000,cancelGraceMs:400,toolStartupMs:3000};
    if(harness==='codex')config.args.push('app-server');
    if(harness==='claude_code'){const credentialFile=join(root,'provider.key');writeFileSync(credentialFile,'fixture-provider-secret',{mode:0o600});Object.assign(config,{command:resolve('test/fixtures/claude-code.mjs'),version:'2.1.319',model:claudeModel,provider:{baseUrl:'http://127.0.0.1:'+server.address().port,credentialFile}});delete config.args;delete config.env;delete config.cancelGraceMs;delete config.toolStartupMs;}
    writeFileSync(file,JSON.stringify(config));process.env[name]=file;t.after(()=>{if(prior===undefined)delete process.env[name];else process.env[name]=prior;});
  }
  t.after(async()=>{await manager.recover();await new Promise(r=>{server.close(r);server.closeAllConnections();});store.close();rmSync(root,{recursive:true,force:true});});
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101',?,'fixture',?,'now')",'http://127.0.0.1:'+server.address().port+'/v1',store.secrets.seal({value:'fixture-model-secret'},'model:m'));
  store.run("INSERT INTO policies(repository_id,enabled,model_id) VALUES('101',1,'m')");
  roleApi(store,{id:'operator',role:'project_admin',repositories:['101']},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:0,enabled:false,
    roles:[{role_id:'reviewer',harness_ref:{id:harness},permissions:{task_management:'none',conversation_history:'read'},...(budget?{budget_policy_ref:budget}:{})}]});
  const actor=knowledgeActor(store,'reader','101',['tasks.read','knowledge.read']),caller=roleTaskCaller(store,'101','reviewer',{actor,conversation_id:'one-logical-conversation',source_message:'source-1',guard(){}});
  const conversations=new RoleConversations(store,new TaskCommands(store),manager);let current='original';
  const source={id:'one-logical-conversation',source_message:'source-1',caller,request:'Read the local context',guard(){},fence:()=>current,context:()=>({fixture_mode:'conversation',messages:[{content:'Local context'}]}),query:()=>({messages:[]}),summary:()=>({state:'none'})};
  return {store,requests,started,conversations,source,next:()=>({...source,source_message:'source-2',caller:roleTaskCaller(store,'101','reviewer',{actor,conversation_id:source.id,source_message:'source-2',guard(){}})}),change:()=>{current='changed';}};
}
for(const harness of ['native','process','pi'])test(`generic conversation uses the configured ${harness} harness without a business task or fake writer`,async t=>{
  const f=await fixture(t,harness),result=await f.conversations.run(f.source);
  assert.equal(result.message,'A source-bound response');assert.equal(f.store.get('SELECT count(*) n FROM tasks').n,0);
  const turn=f.store.get('SELECT * FROM role_conversation_turns');assert.equal(turn.role_id,'reviewer');assert.equal(turn.state,'completed');
  const instance=f.store.get('SELECT * FROM role_instances WHERE conversation_id=?',f.source.id);assert.equal(instance.task_id,null);assert.equal(instance.role,'reviewer');
  const request=f.store.get('SELECT * FROM model_requests WHERE conversation_id=?',f.source.id);
  // The exchange is in the conversation turn's trajectory file (plain text since #436); the ledger row keeps only refs.
  assert.equal(request.request_snapshot,null);assert.equal(request.response_snapshot,null);assert.ok(request.request_ref&&request.response_ref);
  assert.ok(modelSnapshot(f.store,request,'request').includes('Local context'));assert.ok(modelSnapshot(f.store,request,'response').includes('A source-bound response'));
  assert.equal(f.store.get('SELECT conversation_id FROM trajectory_files WHERE id=?',request.request_ref.split(':')[0]).conversation_id,f.source.id);
  assert.ok(f.store.get('SELECT count(*) n FROM role_conversation_events').n>0);
  assert.ok(f.requests.every(r=>!r.tools.some(t=>['run_command','delegate_role','create_pull_request'].includes(t.function.name))));
  const ledger=f.store.get('SELECT * FROM model_requests');assert.equal(ledger.task_id,null);assert.equal(ledger.conversation_id,f.source.id);assert.equal(ledger.role_id,'reviewer');assert.equal(ledger.source_message,'source-1');
  if(harness==='pi'){
    assert.ok(f.store.get('SELECT count(*) n FROM role_conversation_operations').n>0);
    assert.equal(f.store.get('SELECT count(*) n FROM task_tools').n,0);
    assert.ok(!JSON.stringify(f.store.all('SELECT request,result FROM role_conversation_operations')).includes('A source-bound response'));
  }
  const before=f.requests.length;assert.equal((await f.conversations.run(f.source)).replayed,true);assert.equal(f.requests.length,before);
  await f.conversations.run(f.next());assert.equal(f.store.get('SELECT id FROM role_instances WHERE conversation_id=?',f.source.id).id,instance.id);
  assert.equal(f.store.get('SELECT sequence FROM role_instances WHERE id=?',instance.id).sequence,2);
  f.change();await assert.rejects(f.conversations.run(f.source),{code:'conversation_turn_not_replayable'});
});
for(const harness of ['acp','codex','claude_code'])test(`non-task ${harness} uses its real protocol adapter, persistent role instance and one external request ledger (fixtures)`,async t=>{
  const f=await fixture(t,harness),result=await f.conversations.run(f.source);assert.equal(result.message,'A source-bound response');
  assert.equal(f.store.get('SELECT count(*) n FROM tasks').n,0);
  const instance=f.store.get('SELECT * FROM role_instances WHERE conversation_id=?',f.source.id);assert.equal(instance.task_id,null);
  const event=f.store.get("SELECT payload FROM role_conversation_events WHERE type='conversation_run'");
  const context=f.store.secrets.open(event.payload,'conversation-event:'+result.id+':conversation_run').data.run_context;
  assert.equal(context.task_id,null);assert.equal(context.conversation_id,f.source.id);assert.equal(context.execution_context.role_instance_id,instance.id);
  const rows=f.store.all('SELECT * FROM model_requests');assert.equal(rows.length,1);assert.equal(rows[0].task_id,null);assert.equal(rows[0].role_id,'reviewer');assert.equal(rows[0].source_message,'source-1');assert.equal(rows[0].cost,null);
  if(harness==='acp'){assert.equal(rows[0].input_tokens,null);assert.equal(rows[0].state,'external_usage_unknown');}
  if(harness==='codex'){assert.equal(rows[0].input_tokens,100);assert.equal(rows[0].output_tokens,10);}
  if(harness==='claude_code'){assert.equal(rows[0].input_tokens,9);assert.equal(rows[0].output_tokens,3);assert.equal(f.requests.length,1);}
  const text=JSON.stringify(f.store.all('SELECT * FROM role_conversation_events'));assert.ok(!text.includes('PRIVATE_FIXTURE_REASONING'));
  await f.conversations.run(f.next());assert.equal(f.store.get('SELECT count(*) n FROM role_instances WHERE conversation_id=?',f.source.id).n,1);
  assert.equal(f.store.get('SELECT count(*) n FROM model_requests').n,2);
});

test('legacy task role instances and assignment foreign keys survive the nullable-task migration',async t=>{
  const root=mkdtempSync(join(tmpdir(),'role-instance-upgrade-')),file=join(root,'control.sqlite'),key=Buffer.alloc(32,5);let store=new Store(file,key);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");store.run("INSERT INTO repositories VALUES('101','fixture/upgrade','10','a')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('old-task','101','task.request','paused','Old task','{}')");
  store.run("INSERT INTO role_instances(id,task_id,role,definition,harness,session,updated_at) VALUES('old-role','old-task','reviewer','{}','native','[\"old session\"]','now')");
  store.run("INSERT INTO role_assignments(id,task_id,instance_id,revision,status,input_ref) VALUES('old-assignment','old-task','old-role',1,'completed','original-source')");store.close();
  const db=new DatabaseSync(file),sql=db.prepare("SELECT sql FROM sqlite_schema WHERE name='role_instances'").get().sql,
    columns=db.prepare('PRAGMA table_info(role_instances)').all().map(r=>'"'+r.name+'"').join(',');
  db.exec('PRAGMA foreign_keys=OFF;BEGIN');
  db.exec(sql.replace(/CREATE TABLE role_instances/i,'CREATE TABLE legacy_instances').replace(/task_id TEXT REFERENCES/,'task_id TEXT NOT NULL REFERENCES'));
  db.exec(`INSERT INTO legacy_instances(${columns}) SELECT ${columns} FROM role_instances;DROP TABLE role_instances;ALTER TABLE legacy_instances RENAME TO role_instances;COMMIT`);db.close();
  store=new Store(file,key);assert.equal(store.get('SELECT task_id FROM role_instances').task_id,'old-task');assert.equal(store.get('SELECT instance_id FROM role_assignments').instance_id,'old-role');
  assert.equal(store.get('SELECT session FROM role_instances').session,'["old session"]');assert.deepEqual(store.all('PRAGMA foreign_key_check'),[]);
  assert.equal(store.all('PRAGMA table_info(role_instances)').find(r=>r.name==='task_id').notnull,0);
  store.run("DELETE FROM tasks WHERE id='old-task'");assert.equal(store.get('SELECT count(*) n FROM role_instances').n,0);assert.equal(store.get('SELECT count(*) n FROM role_assignments').n,0);
});
test('a metered one-request budget admits its final response and does not admit another billable request',async t=>{
  const f=await fixture(t,'native',{id:'metered',max_model_requests:1});
  assert.equal((await f.conversations.run(f.source)).message,'A source-bound response');
  const source=f.next();
  await assert.rejects(f.conversations.run(source),{code:'role_budget_exhausted'});assert.equal(f.requests.length,1);
});
test('a monetary cap never treats missing pricing as a zero-cost conversation',async t=>{
  const f=await fixture(t,'native',{id:'metered',max_cost:{currency:'USD',amount:1}});
  await assert.rejects(f.conversations.run(f.source),{code:'budget_usage_unknown'});assert.equal(f.requests.length,0);
});
test('cumulative wall budget survives a new conversational turn',async t=>{
  const f=await fixture(t,'native',{id:'metered',max_wall_seconds:60});await f.conversations.run(f.source);
  f.store.run('UPDATE role_conversation_turns SET created_at=updated_at-61000');
  await assert.rejects(f.conversations.run(f.next()),{code:'role_budget_exhausted'});assert.equal(f.requests.length,1);
});
test('main-instance budgets exclude independent task runs while conversation invoices include both',async t=>{
  const f=await fixture(t,'native',{id:'metered',max_model_requests:2});await f.conversations.run(f.source);
  f.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('independent','101','task.request','paused','Independent task','{}')");
  const id=beginModelRequest(f.store,{id:'independent',repository_id:'101',conversation_id:f.source.id,active_role:'reviewer',source_message:'child-source'},'child-inference',{id:'m',model:'fixture',pricing:null});finishModelRequest(f.store,id,{prompt_tokens:1,completion_tokens:1},200);
  assert.equal((await f.conversations.run(f.next())).message,'A source-bound response');
  const role=f.store.get('SELECT id FROM role_instances WHERE conversation_id=?',f.source.id);assert.equal(instanceUsage(f.store,role.id).model_requests,2);
  assert.equal(f.store.get('SELECT count(*) n FROM model_requests WHERE conversation_id=?',f.source.id).n,3);
});
test('reply replay remains bound to the original principal even if an adapter reuses its content fence',async t=>{
  const f=await fixture(t,'native');await f.conversations.run(f.source);
  const actor=knowledgeActor(f.store,'another-reader','101',['tasks.read','knowledge.read']),caller=roleTaskCaller(f.store,'101','reviewer',{actor,conversation_id:f.source.id,source_message:f.source.source_message,guard(){}});
  await assert.rejects(f.conversations.run({...f.source,caller}),{code:'conversation_source_mismatch'});assert.equal(f.requests.length,1);
});
test('external receipts reconcile unknown Codex turns across recovery and never bill cumulative provider updates twice',async t=>{
  const f=await fixture(t,'native'),task={id:'receipt-fixture',kind:'role.conversation',repository_id:'101',conversation_id:f.source.id,active_role:'reviewer',source_message:'source-1'},
    first=externalModelRecorder(f.store,task,'first-run','codex','persistent-instance'),turn={threadId:'thread_with_underscore',turnId:'remote-turn'};
  first.event({type:'turn',phase:'started',...turn});const pending=f.store.get('SELECT * FROM model_requests');assert.equal(pending.input_tokens,null);
  const usage={type:'usage',source:'codex_app_server',...turn,delta:{input_tokens:100,output_tokens:10},thread_total:{input:100,output:10,total:110}};
  first.event(usage);assert.equal(f.store.get('SELECT id FROM model_requests').id,pending.id);
  const recovered=externalModelRecorder(f.store,task,'recovered-run','codex','persistent-instance');recovered.event(usage);
  assert.equal(f.store.get('SELECT count(*) n FROM model_requests').n,1);
  recovered.event({...usage,thread_total:{input:200,output:20,total:220}});assert.equal(f.store.get('SELECT count(*) n FROM model_requests').n,2);
  const request={key:'provider-receipt',source:'provider_requests',model:'fixture-external',input_tokens:null,output_tokens:null};
  recovered.request(request);recovered.request({...request,input_tokens:9,output_tokens:0});recovered.request({...request,input_tokens:9,output_tokens:3,finished:true});
  assert.equal(f.store.get('SELECT count(*) n FROM model_requests').n,3);assert.equal(f.store.get('SELECT sum(input_tokens) n FROM model_requests').n,209);
  assert.ok(f.store.all('SELECT cost FROM model_requests').every(r=>r.cost===null));
});
test('wall budget aborts a blocked model before its first byte',{timeout:40000},async t=>{
  const f=await fixture(t,'native',{id:'metered',max_wall_seconds:60},true),work=f.conversations.run(f.source);
  await f.started;f.store.run('UPDATE role_conversation_turns SET created_at=? WHERE state=?',Date.now()-61000,'running');
  await assert.rejects(work,{code:'role_budget_exhausted'});assert.equal(f.requests.length,1);
});
