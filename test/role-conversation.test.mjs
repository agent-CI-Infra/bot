import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/storage/database.js';
import { TaskCommands } from '../dist/tasks/commands.js';
import { RoleConversations } from '../dist/roles/conversation.js';
import { roleTaskCaller } from '../dist/tasks/management.js';
import { roleApi } from '../dist/roles/api.js';
import { knowledgeActor } from './knowledge-fixture.mjs';
import { LocalManager } from '../dist/projects/local-manager.js';

async function fixture(t,harness,budget){
  const store=new Store(':memory:',Buffer.alloc(32,8)),root=mkdtempSync(join(tmpdir(),'role-conversation-')),manager=new LocalManager('101',root),requests=[];
  const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const body=JSON.parse(text);requests.push(body);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'reply-'+requests.length,type:'function',function:{name:'finish',arguments:JSON.stringify({message:'A source-bound response'})}}]}}],usage:{prompt_tokens:9,completion_tokens:3}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await manager.recover();await new Promise(r=>{server.close(r);server.closeAllConnections();});store.close();rmSync(root,{recursive:true,force:true});});
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account',NULL,'{}','now')");store.run("INSERT INTO repositories VALUES('101','fixture/project-101','10','a')");
  store.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101',?,'fixture',?,'now')",'http://127.0.0.1:'+server.address().port+'/v1',store.secrets.seal({value:'fixture-model-secret'},'model:m'));
  store.run("INSERT INTO policies(repository_id,enabled,model_id) VALUES('101',1,'m')");
  roleApi(store,{id:'operator',role:'project_admin',repositories:['101']},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:0,enabled:false,
    roles:[{role_id:'reviewer',harness_ref:{id:harness},permissions:{task_management:'none',conversation_history:'read'},...(budget?{budget_policy_ref:budget}:{})}]});
  const actor=knowledgeActor(store,'reader','101',['tasks.read','knowledge.read']),caller=roleTaskCaller(store,'101','reviewer',{actor,conversation_id:'one-logical-conversation',source_message:'source-1',guard(){}});
  const conversations=new RoleConversations(store,new TaskCommands(store),manager);let current='original';
  const source={id:'one-logical-conversation',source_message:'source-1',caller,request:'Read the local context',guard(){},fence:()=>current,context:()=>({messages:[{content:'Local context'}]}),query:()=>({messages:[]}),summary:()=>({state:'none'})};
  return {store,requests,conversations,source,next:()=>({...source,source_message:'source-2',caller:roleTaskCaller(store,'101','reviewer',{actor,conversation_id:source.id,source_message:'source-2',guard(){}})}),change:()=>{current='changed';}};
}
for(const harness of ['native','process','pi'])test(`generic conversation uses the configured ${harness} harness without a business task or fake writer`,async t=>{
  const f=await fixture(t,harness),result=await f.conversations.run(f.source);
  assert.equal(result.message,'A source-bound response');assert.equal(f.store.get('SELECT count(*) n FROM tasks').n,0);
  const turn=f.store.get('SELECT * FROM role_conversation_turns');assert.equal(turn.role_id,'reviewer');assert.equal(turn.state,'completed');
  const request=f.store.get('SELECT * FROM model_requests WHERE conversation_id=?',f.source.id);
  assert.ok(!request.request_snapshot.includes('Local context'));assert.ok(!request.response_snapshot.includes('A source-bound response'));
  assert.ok(f.store.secrets.open(request.request_snapshot,'conversation-model-request:'+request.id).snapshot.includes('Local context'));
  assert.ok(f.store.get('SELECT count(*) n FROM role_conversation_events').n>0);
  assert.ok(f.requests.every(r=>!r.tools.some(t=>['create_task','run_command','delegate_role','create_pull_request'].includes(t.function.name))));
  const ledger=f.store.get('SELECT * FROM model_requests');assert.equal(ledger.task_id,null);assert.equal(ledger.conversation_id,f.source.id);assert.equal(ledger.role_id,'reviewer');assert.equal(ledger.source_message,'source-1');
  if(harness==='pi'){
    assert.ok(f.store.get('SELECT count(*) n FROM role_conversation_operations').n>0);
    assert.equal(f.store.get('SELECT count(*) n FROM task_tools').n,0);
    assert.ok(!JSON.stringify(f.store.all('SELECT request,result FROM role_conversation_operations')).includes('A source-bound response'));
  }
  const before=f.requests.length;assert.equal((await f.conversations.run(f.source)).replayed,true);assert.equal(f.requests.length,before);
  f.change();await assert.rejects(f.conversations.run(f.source),{code:'conversation_turn_not_replayable'});
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
