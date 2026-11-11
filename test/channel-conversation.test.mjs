import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, inGroup, envelope, post, until } from './channel-fixture.mjs';
import { roleApi } from '../dist/roles/api.js';
import { resolvePrincipalActor } from '../dist/identity/authorization.js';
import { TaskCommands } from '../dist/tasks/commands.js';

// A group is served by the service role bound to it (#312); a private chat is the personal management assistant.
const answer=(res,message)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:12,completion_tokens:4}}));};
const respond=(res,name,args)=>answer(res,{role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const say=(res,content)=>answer(res,{role:'assistant',content});
async function fixture(t,participation='mentions'){
  const f=await channelFixture(t),{h}=f;
  const role=(await f.admin('/api/service-roles')).value.service_roles.find(r=>r.id==='repository-assistant');
  await f.admin('/api/service-roles/repository-assistant','PATCH',{expected_revision:role.revision,model_id:f.assistantModel.id});
  roleApi(h.store,{id:f.principal,role:'super_admin',repositories:[]},'PUT',new URL('http://local/api/repositories/101/roles'),{expected_revision:0,enabled:false,
    roles:[{role_id:'reviewer',harness_ref:{id:'native'},permissions:{task_management:'write',delegation:'deny',commands:'deny',conversation_history:'read'}}]});
  const discovery=inGroup('Discover this group','ou_alice');discovery.event.message.mentions=[];await post(h,f.id,discovery);
  const chat=h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'");
  const bound=await f.admin('/api/channels/chats/'+chat.id+'/service-binding','PUT',{service_role_id:'repository-assistant',scope:{kind:'repositories',repositories:['101']},participation,enabled:true,expected_revision:0});
  assert.equal(bound.status,200,JSON.stringify(bound.value));
  f.modelState.respond=async(body,res)=>say(res,'Recorded local answer');
  return {...f,chat};
}
const complete=(f,receipt)=>until(()=>f.h.store.get('SELECT * FROM channel_inbox WHERE id=?',receipt.value.operation_id),r=>r&&['completed','failed'].includes(r.state));
/** A task created by a legacy group employee before the upgrade; such tasks keep notifying their group. */
async function legacyTask(f,request){
  const source=inGroup(request,'ou_bob');source.event.message.mentions=[];const receipt=await post(f.h,f.id,source);
  await f.service.employees.configure(resolvePrincipalActor(f.h.store,f.principal,null,'101'),f.chat.id,{project_id:'101',role_id:'reviewer',capabilities:['tasks.read','tasks.manage_own','knowledge.read'],enabled:true,expected_revision:0});
  const caller=f.service.employees.caller(f.chat.id,'101',receipt.value.operation_id);
  return {receipt,source,task:new TaskCommands(f.h.store).tool(caller,'create_task',{request,criteria:['Return the verified report'],execute:false})};
}

test('ambient participation is set on the binding and can remain quiet without replaying bot or stale messages',async t=>{
  const f=await fixture(t,'questions');
  const quiet=inGroup('Ordinary ambient discussion','ou_bob');quiet.event.message.mentions=[];
  assert.equal((await complete(f,await post(f.h,f.id,quiet))).state,'completed');assert.equal(f.requests.length,0);
  f.modelState.respond=async(body,res)=>say(res,'');
  const question=inGroup('Does anyone need a response?','ou_bob');question.event.message.mentions=[];
  const receipt=await post(f.h,f.id,question);assert.equal((await complete(f,receipt)).state,'completed');assert.equal(f.requests.length,1);
  assert.match(f.requests[0].messages[0].content,/did not mention you/);
  assert.equal(f.h.store.get('SELECT state FROM channel_service_turns').state,'completed');
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_outbox WHERE source_event=?',receipt.value.operation_id).n,0);
  const bot=inGroup('Would this app create a reply loop?','ou_bob');bot.event.sender.sender_type='app';bot.event.message.mentions=[];
  await complete(f,await post(f.h,f.id,bot));
  const stale=inGroup('An old request?', 'ou_alice');stale.event.message.mentions=[];stale.event.message.create_time=String(Date.now()-3600000);
  await complete(f,await post(f.h,f.id,stale));await post(f.h,f.id,question);assert.equal(f.requests.length,1);
});

test('large local originals remain readable in chunks while prompts, search and compaction retain bounded excerpts',async t=>{
  const f=await fixture(t),now=Date.now(),original='A'.repeat(10000)+'precise-tail-evidence';let fetched=false;
  f.service.ledger.merge(f.chat,{message_id:'long-evidence',sender_id:'ou_alice',sender_tenant:'actor-tenant',sender_type:'user',message_type:'text',content:original,raw_content:JSON.stringify({text:original}),created_at:now-10000,updated_at:now-10000,parent_id:'',root_id:'',thread_id:'',deleted:false},'history');
  f.modelState.respond=async(body,res)=>{
    if(!body.messages.some(m=>m.role==='tool')){
      const input=JSON.parse(body.messages[1].content),local=input.context.recent_messages.find(m=>m.message_id==='long-evidence');
      assert.equal(local.content.length,3000);assert.equal(local.truncated,true);assert.equal(local.resources,undefined);
      return respond(res,'read_conversation_message',{message_id:'long-evidence',offset:8000,limit:8000});
    }
    const chunk=JSON.parse(body.messages.find(m=>m.role==='tool').content);assert.equal(chunk.text,original.slice(8000));assert.equal(chunk.next_offset,null);fetched=true;
    return say(res,'The original tail is available locally.');
  };
  assert.equal((await complete(f,await post(f.h,f.id,inGroup('Read the original tail','ou_bob')))).state,'completed');assert.ok(fetched);
});

test('a recall arriving before the first private message cannot establish a group audience',async t=>{
  const f=await fixture(t),message=envelope('A private fact after the early recall');
  const recall={header:{...message.header,event_id:'first-private-recall',event_type:'im.message.recalled_v1'},event:{chat_id:message.event.message.chat_id,message_id:'recalled-private-first',recall_time:String(Date.now())}};
  await post(f.h,f.id,recall);const receipt=await post(f.h,f.id,message);assert.equal((await complete(f,receipt)).state,'completed');
  const chat=f.h.store.get('SELECT * FROM channel_chats WHERE chat_id=?',message.event.message.chat_id);assert.equal(chat.chat_type,'p2p');assert.equal(chat.type_verified,1);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_personal_owners WHERE chat_id=?',chat.id).n,1);
});

test('unbound participants and threads share one logical conversation; quiet messages are available locally and Q&A creates no business task',async t=>{
  const f=await fixture(t),baseline=f.h.store.get('SELECT count(*) n FROM tasks').n;
  for(const [person,thread,text] of [['ou_alice','thread-a','Decision: use local green'],['ou_bob','thread-b','Agreed with the first decision']]){
    const msg=inGroup(text,person);msg.event.message.mentions=[];msg.event.message.thread_id=thread;await post(f.h,f.id,msg);
  }
  assert.equal(f.requests.length,0);
  const first=await post(f.h,f.id,inGroup('What did the group decide?','ou_bob'));const state=await complete(f,first);assert.equal(state.state,'completed',state.error);
  await until(()=>f.wire.sent.find(s=>s.content.elements?.[0]?.text?.content==='Recorded local answer'));
  const request=JSON.parse(f.requests.at(-1).messages[1].content);
  assert.equal(request.conversation_id,f.chat.id);assert.ok(JSON.stringify(request.context).includes('use local green'));assert.ok(JSON.stringify(request.context).includes('Agreed with the first decision'));
  const next=inGroup('Continue with that conclusion','ou_alice');next.event.message.thread_id='another-thread';
  assert.equal((await complete(f,await post(f.h,f.id,next))).conversation_id,f.chat.id);
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_service_turns WHERE chat_id=?',f.chat.id).n,2);
  assert.equal(f.h.store.get('SELECT count(*) n FROM tasks').n,baseline);
  assert.equal(f.h.store.get("SELECT count(*) n FROM external_identities WHERE external_actor='ou_bob'").n,0);
  assert.ok(f.h.store.all('SELECT * FROM model_requests WHERE conversation_id=?',f.chat.id).every(r=>r.task_id===null&&r.repository_id===null&&r.service_role_id==='repository-assistant'&&r.source_message));
});

test('more than 100 local messages retain old source retrieval and a rolling source summary; misses never fetch Feishu',async t=>{
  const f=await fixture(t),now=Date.now();
  for(let i=0;i<145;i++)f.service.ledger.merge(f.chat,{message_id:'old-'+String(i).padStart(3,'0'),sender_id:i%2?'ou_alice':'ou_bob',sender_tenant:'actor-tenant',sender_type:'user',message_type:'text',content:i===0?'Old source: amber deployment':'Local discussion '+i,raw_content:'{}',created_at:now-86400000+i,updated_at:now-86400000+i,parent_id:'',root_id:'',thread_id:'thread-'+i%3,deleted:false},'history');
  let searched=false;
  f.modelState.respond=async(body,res)=>{
    if(body.messages[0].content.startsWith('Summarize only'))return say(res,'A participant stated an amber deployment; confirm the original source. No inferred decision.');
    const tools=body.messages.filter(m=>m.role==='tool');
    if(!tools.length)return respond(res,'search_conversation_history',{keyword:'amber deployment',limit:50});
    const source=JSON.parse(tools.at(-1).content);assert.equal(source.messages[0].message_id,'old-000');searched=true;
    return say(res,'Old source old-000 says amber; this is a local record.');
  };
  const receipt=await post(f.h,f.id,inGroup('Find the old deployment discussion','ou_bob'));
  assert.equal((await complete(f,receipt)).state,'completed');assert.ok(searched);
  const summary=f.h.store.get('SELECT * FROM channel_chat_summaries WHERE chat_id=?',f.chat.id);assert.ok(summary);
  assert.ok(JSON.parse(summary.sources).range_hash);assert.equal(summary.through_id,'old-099');
  assert.match(JSON.parse(f.requests.at(-1).messages[1].content).summary.summary,/amber deployment/);
  const before=f.wire.state.historyRequests.length;assert.equal(f.service.ledger.query(f.chat.id,{keyword:'definitely-missing'}).messages.length,0);assert.equal(f.wire.state.historyRequests.length,before);
  f.service.ledger.merge(f.chat,{message_id:'old-000',sender_id:'ou_bob',sender_tenant:'actor-tenant',sender_type:'user',message_type:'text',content:'',raw_content:'',created_at:now-86400000,updated_at:Date.now()+1,parent_id:'',root_id:'',thread_id:'thread-0',deleted:true},'live');
  assert.equal(f.h.store.get('SELECT count(*) n FROM channel_chat_summaries').n,0);
});

test('disabling the binding while a model is blocked rejects its late reply and no protected output is sent',async t=>{
  const f=await fixture(t);let release,started;const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{started=r;});
  f.modelState.respond=async(body,res)=>{started();await gate;say(res,'This late reply must be withheld');};
  const receipt=await post(f.h,f.id,inGroup('Start a slow answer','ou_bob'));await seen;
  assert.equal((await f.admin('/api/channels/chats/'+f.chat.id+'/service-binding','PUT',{enabled:false,expected_revision:1})).status,200);
  release();const result=await complete(f,receipt);assert.equal(result.state,'failed');
  assert.ok(!JSON.stringify(f.wire.sent).includes('This late reply must be withheld'));
  assert.equal(f.h.store.get('SELECT state FROM channel_service_turns').state,'failed');
});

test('one bound private chat stays continuous across projects, threads and dates and does not inherit a group conversation',async t=>{
  const f=await fixture(t);
  const model=(await f.admin('/api/models','POST',{repository_id:'102',model_name:'Private second project',api_url:f.h.store.get('SELECT api_url FROM models WHERE id=?',f.model.id).api_url,api_key:'fixture-second-model-key'})).value.model;
  await f.admin('/api/repositories/102/policy','PATCH',{model_id:model.id});
  roleApi(f.h.store,{id:f.principal,role:'super_admin',repositories:[]},'PUT',new URL('http://local/api/repositories/102/roles'),{expected_revision:0,enabled:false,roles:[{role_id:'reviewer',harness_ref:{id:'native'}}]});
  const first=await post(f.h,f.id,envelope('/chat /project 101 private-first-fact'));const a=await complete(f,first);assert.equal(a.state,'completed',a.error);
  const second=envelope('/chat /project 102 compare with the previous private fact');second.event.message.thread_id='private-another-thread';
  const b=await complete(f,await post(f.h,f.id,second));assert.equal(b.state,'completed',b.error);assert.equal(a.conversation_id,b.conversation_id);assert.notEqual(a.conversation_id,f.chat.id);
  const prompt=JSON.parse(f.requests.at(-1).messages[1].content);assert.ok(JSON.stringify(prompt.history).includes('private-first-fact'));
  assert.ok(!JSON.stringify(prompt.history).includes('Discover this group'));
  const owner=f.h.store.get('SELECT * FROM channel_personal_owners');assert.equal(owner.principal_id,f.principal);
  f.h.store.run("UPDATE external_identities SET status='revoked' WHERE principal_id=? AND provider='feishu'",f.principal);
  const before=f.requests.length,c=await complete(f,await post(f.h,f.id,envelope('Continue privately')));assert.equal(c.state,'failed');assert.equal(f.requests.length,before);
});

test('a legacy group task result is an atomic durable notification, not another execution queue',async t=>{
  const f=await fixture(t),{source,task}=await legacyTask(f,'A report to return here');
  // Notification fixture supplies a terminal result; real engine/QA is covered separately.
  f.h.store.db.exec("CREATE TRIGGER notification_disk_full BEFORE INSERT ON channel_outbox WHEN NEW.idempotency_key LIKE 'task-result:%' BEGIN SELECT RAISE(ABORT,'fixture full'); END");
  f.h.store.run("UPDATE tasks SET status='completed',result=? WHERE id=?",JSON.stringify({summary:'A confirmed report result'}),task.id);
  await f.service.tick();assert.equal(f.h.store.get('SELECT sequence FROM channel_result_cursor').sequence,0);
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'task-result:%'").n,0);
  f.h.store.db.exec('DROP TRIGGER notification_disk_full');
  await until(()=>f.wire.sent.find(s=>JSON.stringify(s.content).includes('A confirmed report result')));
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'task-result:%'").n,1);
  await f.h.stop();await f.h.start();await post(f.h,f.id,source);
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'task-result:%'").n,1);
});

test('clearing the originating message prevents a later legacy task result from repopulating cleaned chat history',async t=>{
  const f=await fixture(t),{task}=await legacyTask(f,'A later report');
  const current=f.h.store.get('SELECT * FROM channel_chats WHERE id=?',f.chat.id);
  f.service.ledger.cleanup(f.chat.id,Date.now(),current.revision);
  f.h.store.run("UPDATE tasks SET status='completed',result=? WHERE id=?",JSON.stringify({summary:'Erased historical source should not reappear'}),task.id);
  await f.service.tick();await f.service.tick();assert.equal(f.h.store.get("SELECT count(*) n FROM channel_outbox WHERE idempotency_key LIKE 'task-result:%'").n,0);
  assert.ok(!JSON.stringify(f.wire.sent).includes('Erased historical source should not reappear'));
  f.modelState.respond=async(body,res)=>{assert.ok(!JSON.stringify(body.messages).includes('A later report'));say(res,'Only current sources are available.');};
  assert.equal((await complete(f,await post(f.h,f.id,inGroup('Read the old discussion after cleanup','ou_alice')))).state,'completed');
});

test('derived replies and other scopes are absent from future model inputs after their source fence changes',async t=>{
  const f=await fixture(t);f.modelState.respond=async(body,res)=>say(res,'Derived obsolete detail');
  const input=inGroup('A mutable source','ou_bob');assert.equal((await complete(f,await post(f.h,f.id,input))).state,'completed');
  await until(()=>f.h.store.get("SELECT count(*) n FROM channel_messages WHERE sender_type='app'").n>0);
  assert.match(f.h.store.get('SELECT project_id FROM channel_message_scopes').project_id,/^binding:/);
  const original=f.h.store.get('SELECT * FROM channel_messages WHERE message_id=?',input.event.message.message_id),payload=f.h.store.secrets.open(original.payload,'channel-message:'+f.chat.id+':'+original.message_id);
  f.service.ledger.merge(f.chat,{...payload,updated_at:Date.now()+10,content:'Corrected source'},'live');
  f.service.ledger.merge(f.chat,{...payload,message_id:'protected-other-project',sender_type:'app',content:'Unauthorized project secret',updated_at:Date.now()+20},'live');
  f.h.store.run('INSERT INTO channel_message_scopes VALUES(?,?,?,NULL)',f.chat.id,'protected-other-project','201');
  f.modelState.respond=async(body,res)=>{assert.ok(!JSON.stringify(body.messages).includes('Derived obsolete detail'));assert.ok(!JSON.stringify(body.messages).includes('Unauthorized project secret'));say(res,'A fresh local answer');};
  assert.equal((await complete(f,await post(f.h,f.id,inGroup('Answer from current sources','ou_alice')))).state,'completed');
});

test('cleanup during an in-flight model erases derived content and cannot restore its response snapshots',async t=>{
  const f=await fixture(t);let release,started;const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{started=r;});
  f.modelState.respond=async(body,res)=>{started();await gate;say(res,'Old erased response');};
  const receipt=await post(f.h,f.id,inGroup('Content that will be erased','ou_bob'));await seen;
  const row=f.h.store.get('SELECT revision FROM channel_chats WHERE id=?',f.chat.id);f.service.ledger.cleanup(f.chat.id,Date.now(),row.revision);
  release();assert.equal((await complete(f,receipt)).state,'failed');
  const request=f.h.store.get('SELECT * FROM model_requests WHERE conversation_id=?',f.chat.id);
  assert.equal(request.request_snapshot,null);assert.ok(!String(request.response_snapshot).includes('Old erased response'));assert.equal(request.input_tokens,12);
  assert.equal(f.h.store.get('SELECT reply FROM channel_service_turns').reply,null);
  assert.ok(!JSON.stringify(f.wire.sent).includes('Old erased response'));
});
