import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, envelope, post, finished, until, bindFixture } from './channel-fixture.mjs';
import { query, settled } from './management-fixture.mjs';

// Local model protocol fixtures verify transport/service behavior; they do not measure model language quality.
const respond=(res,message)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:12,completion_tokens:4}}));};
const reply=(res,content)=>respond(res,{role:'assistant',content});
const call=(res,operation,target={},args={})=>respond(res,{role:'assistant',content:null,tool_calls:[{id:'fixture-query',type:'function',function:{name:'management_query',arguments:JSON.stringify({operation,target,arguments:args})}}]});
const observation=body=>body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
const input=body=>JSON.parse(body.messages[1].content);
async function im(f,content,overrides){const event=envelope(content,overrides),receipt=await post(f.h,f.id,event);return {event,receipt,row:await finished(f.h,receipt.value.operation_id)};}
async function web(f,content,client=f.admin){const conversation=(await client('/api/management/conversations','POST',{scope:'platform'})).value.conversation.id;
  const message=(await client('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'fixture-web',content})).value;
  return {conversation,message,history:await settled(client,conversation,message.id)};}
const sent=(f,id)=>until(()=>f.wire.sent.find(s=>JSON.stringify(s.content).includes(id)));

test('multi-project greetings use the shared management agent and private history shows the actual answer',async t=>{
  const f=await channelFixture(t);let channel=true;
  f.modelState.respond=async(body,res)=>{
    assert.deepEqual(body.tools.map(t=>t.function.name),['management_query','management_command','start_own_task','continue_own_task','list_own_tasks','read_own_task','manage_own_task','search_role_memory','read_role_memory','remember_role_memory','github_read','github_search','read_job_log',
      ...(channel?['list_message_resources','read_message_text','read_message_resource','view_message_image','import_message_resource','attach_message_resource','attach_workspace_file','create_reply_file']:[])]);
    assert.equal(input(body).scope,'platform');assert.equal(input(body).request,'你好');
    assert.match(body.messages[0].content,/No project is preselected/);
    reply(res,'你好！可以按项目名称查询任务和管理配置。');
  };
  const result=await im(f,'你好');assert.equal(result.row.state,'completed',result.row.error);
  await sent(f,'你好！');assert.equal(f.h.store.get('SELECT scope FROM management_conversations WHERE id=?',result.row.conversation_id).scope,'platform');
  assert.equal(f.h.store.get('SELECT count(*) n FROM role_conversation_turns').n,0);
  const chat=f.h.store.get("SELECT id FROM channel_chats WHERE chat_id='oc_private'");
  const view=await f.admin('/api/channels/chats/'+chat.id+'/conversation');
  assert.equal(view.value.mode,'management');assert.equal(view.value.turns[0].request,'你好');assert.match(view.value.turns[0].reply,/你好！/);
  channel=false;const w=await web(f,'你好');assert.equal(w.history.messages[0].state,'completed');
  assert.ok(!JSON.stringify(f.wire.sent).includes('/chat /project'));assert.equal(f.h.store.get('SELECT count(*) n FROM management_commands WHERE source_message LIKE \'feishu:%\' OR source_message=\'fixture-web\'').n,0);
});

test('authorized names, ambiguous project clarification, continuation and switching share real Web query results',async t=>{
  const f=await channelFixture(t),member=await f.member('personal-names',{organization_ids:['10']});
  bindFixture(f.h,f.id,member.id,'ou_member');
  f.h.store.run("UPDATE repositories SET full_name=CASE id WHEN '101' THEN 'alpha/bot' WHEN '102' THEN 'beta/bot' ELSE 'private/hidden' END");
  const asMember={sender:{sender_id:{open_id:'ou_member'}}};let expected;
  f.modelState.respond=async(body,res)=>{
    const context=input(body),observed=observation(body);
    if(context.request==='我能管理哪些项目'||context.request==='看看 bot 项目的任务'){
      if(!observed.length)return call(res,'list_projects');
      assert.deepEqual(observed[0].projects.map(p=>p.full_name),['alpha/bot','beta/bot']);
      return reply(res,context.request==='我能管理哪些项目'?'可以管理 alpha/bot、beta/bot。':'有 alpha/bot 和 beta/bot，请问要查看哪一个？');
    }
    assert.ok(context.history.some(h=>h.request.content==='看看 bot 项目的任务'));
    assert.ok(context.history.some(h=>h.reply?.includes('请问要查看哪一个')));
    if(!observed.length)return call(res,'list_tasks',{project_id:expected});
    assert.deepEqual(observed[0],(await query(member.client,'list_tasks',{project_id:expected})).value);
    reply(res,expected==='102'?'beta/bot 的任务已查询。':'alpha/bot 的任务已查询。');
  };
  for(const content of ['我能管理哪些项目','看看 bot 项目的任务'])assert.equal((await im(f,content,asMember)).row.state,'completed');
  assert.equal(f.h.store.get('SELECT count(*) n FROM management_commands WHERE source_message LIKE \'feishu:%\' OR source_message=\'fixture-web\'').n,0);
  expected='102';const selected=await im(f,'beta/bot',asMember);assert.equal(selected.row.state,'completed',selected.row.error);
  expected='101';const switched=await im(f,'换成 alpha/bot',{...asMember,message:{thread_id:'another-thread'}});assert.equal(switched.row.state,'completed',switched.row.error);
  assert.equal(selected.row.conversation_id,switched.row.conversation_id);
  assert.ok(!JSON.stringify(f.wire.sent).includes('private/hidden'));
  assert.ok(f.requests.every(r=>r.model==='Management fixture')); // Target 102 has no model: the assistant uses its own.
  assert.deepEqual(f.h.store.all('SELECT DISTINCT repository_id,service_role_id FROM model_requests').map(r=>({...r})),[{repository_id:null,service_role_id:'management-assistant'}]);
  const other=await f.member('other-private-reader',{repository_ids:['101']});
  assert.equal((await other.client('/api/management/conversations/'+selected.row.conversation_id)).status,404);
  const projects=(await query(member.client,'list_projects')).value.projects;assert.deepEqual(projects.map(p=>p.full_name),['alpha/bot','beta/bot']);
});

test('Web and personal natural-language writes share audit, receipts and replay protection and execute without approval',async t=>{
  const f=await channelFixture(t),tenant=f.h.store.get("SELECT tenant_id FROM identity_projects WHERE project_id='101'").tenant_id;
  // A policy left by an older version is no longer read.
  f.h.store.run('INSERT INTO management_policies(tenant_id,approval_operations) VALUES(?,?)',tenant,JSON.stringify(['task.pause']));
  const w=await web(f,'暂停任务'),i=await im(f,'暂停任务');assert.equal(i.row.state,'completed',i.row.error);
  const receipts=f.h.store.all("SELECT * FROM management_commands WHERE source_message LIKE 'feishu:%' OR source_message='fixture-web' ORDER BY created_at");assert.equal(receipts.length,2);
  assert.deepEqual(receipts.map(r=>r.operation),['task.pause','task.pause']);assert.equal(receipts[0].state,'succeeded');
  assert.ok(!receipts.some(r=>r.state==='awaiting_approval'));
  assert.deepEqual(receipts.map(r=>r.channel),['web','im']);assert.equal(receipts[0].principal_id,receipts[1].principal_id);
  assert.equal(f.h.store.get("SELECT status FROM tasks WHERE id='blocked'").status,'paused');
  assert.ok(f.h.store.get("SELECT 1 FROM audit WHERE action='management.succeeded' AND resource_id=?",receipts[0].id));
  await post(f.h,f.id,i.event);assert.equal(f.h.store.get('SELECT count(*) n FROM management_commands WHERE source_message LIKE \'feishu:%\' OR source_message=\'fixture-web\'').n,2);
  assert.ok(w.history.events.some(e=>e.type==='tool_result'&&e.data.result.state==='succeeded'));
  assert.ok(!JSON.stringify(f.wire.sent).includes('等待审批'));
});

test('read-only and out-of-scope tool calls fail identically in Web and personal messages without writes',async t=>{
  const f=await channelFixture(t),member=await f.member('read-only-personal',{repository_ids:['101']});bindFixture(f.h,f.id,member.id,'ou_reader');
  f.h.store.run('UPDATE scoped_grants SET capabilities=? WHERE principal_id=?',JSON.stringify(['tasks.read']),member.id);
  const overrides={sender:{sender_id:{open_id:'ou_reader'}}};
  const w=await web(f,'暂停任务',member.client),i=await im(f,'暂停任务',overrides);assert.equal(i.row.state,'failed');
  assert.ok(w.history.events.some(e=>e.type==='tool_error'&&e.data.error==='capability_forbidden'));
  assert.ok(f.h.store.get("SELECT 1 FROM management_events WHERE message_id=? AND type='tool_error' AND data LIKE '%capability_forbidden%'",i.row.message_id));
  f.modelState.respond=async(body,res)=>call(res,'get_task',{project_id:'201',task_id:'foreign'});
  const outside=await im(f,'读取未授权项目',overrides);assert.equal(outside.row.state,'failed');
  const webOutside=await web(f,'读取未授权项目',member.client);assert.ok(webOutside.history.events.some(e=>e.type==='tool_error'));
  assert.equal(f.h.store.get('SELECT count(*) n FROM management_commands WHERE source_message LIKE \'feishu:%\' OR source_message=\'fixture-web\'').n,0);
  assert.equal(f.h.store.get("SELECT status FROM tasks WHERE id='blocked'").status,'waiting_environment');
});

test('no projects, a first project without a model and a missing assistant model are explained without listing private IDs',async t=>{
  const f=await channelFixture(t),member=await f.member('no-project-personal',{});bindFixture(f.h,f.id,member.id,'ou_no_projects');
  const i=await im(f,'你好',{sender:{sender_id:{open_id:'ou_no_projects'}},message:{chat_id:'oc_no_projects'}});assert.equal(i.row.state,'completed');
  await sent(f,'当前账户没有可访问的项目');assert.equal(f.requests.length,0);
  // The first visible project has no model: the greeting still works on the assistant's own model and bills the assistant.
  f.h.store.run("UPDATE policies SET model_id=NULL WHERE repository_id='101'");
  f.modelState.respond=async(_body,res)=>reply(res,'你好，可以按项目名称提问。');
  const greeting=await im(f,'你好');assert.equal(greeting.row.state,'completed',greeting.row.error);await sent(f,'你好，可以按项目名称提问。');
  assert.deepEqual(f.h.store.all('SELECT repository_id,service_role_id FROM model_requests WHERE conversation_id=?',greeting.row.conversation_id).map(r=>({...r})),[{repository_id:null,service_role_id:'management-assistant'}]);
  const chat=f.h.store.get("SELECT id FROM channel_chats WHERE chat_id='oc_private'"),view=(await f.admin('/api/channels/chats/'+chat.id+'/conversation')).value;
  assert.deepEqual([view.usage.requests,view.usage.input_tokens],[1,12]);
  // Without its own model the assistant says where to configure it; it never borrows a project's model.
  f.h.store.run("UPDATE service_roles SET model_id=NULL WHERE id='management-assistant'");
  const before=f.requests.length,missing=await im(f,'你好');assert.equal(missing.row.state,'failed');assert.equal(f.requests.length,before);
  await sent(f,'管理助手尚未配置模型');
  assert.ok(!JSON.stringify(f.wire.sent).includes('/chat /project'));
});

test('revocation while the model waits blocks late writes, old history and protected delivery',async t=>{
  const f=await channelFixture(t),member=await f.member('revoked-personal',{repository_ids:['101']});bindFixture(f.h,f.id,member.id,'ou_revoked');
  const asMember={sender:{sender_id:{open_id:'ou_revoked'}},message:{chat_id:'oc_revoked'}};
  let release;f.modelState.gate=new Promise(r=>release=r);t.after(()=>release());
  const receipt=await post(f.h,f.id,envelope('暂停任务',asMember));await until(()=>f.requests.length);
  const conversation=f.h.store.get('SELECT conversation_id FROM channel_inbox WHERE id=?',receipt.value.operation_id).conversation_id;
  await f.admin('/api/project-admin-assignments','PUT',{user_id:member.id,repository_ids:[]});f.modelState.gate=null;release();
  const row=await finished(f.h,receipt.value.operation_id);assert.equal(row.state,'failed');
  assert.equal(f.h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n,0);
  const history=(await member.client('/api/management/conversations/'+conversation+'/events')).value;
  assert.deepEqual(history.messages,[]);assert.deepEqual(history.events,[]);
  assert.ok(!JSON.stringify(f.wire.sent).includes('Inspect task facts'));
});

test('recalled private sources invalidate Web context, then continue with fresh history',async t=>{
  const f=await channelFixture(t);
  const initial=await im(f,'暂停任务');
  const recall={header:{...initial.event.header,event_id:'recall-personal-request',event_type:'im.message.recalled_v1'},event:{chat_id:'oc_private',message_id:initial.event.event.message.message_id,recall_time:String(Date.now())}};
  await finished(f.h,(await post(f.h,f.id,recall)).value.operation_id);
  assert.equal((await f.admin('/api/management/conversations/'+initial.row.conversation_id+'/events')).status,409);
  f.modelState.respond=async(body,res)=>{assert.deepEqual(input(body).history,[]);reply(res,'请重新说明要处理的项目和任务。');};
  const fresh=await im(f,'继续');assert.equal(fresh.row.state,'completed',fresh.row.error);assert.notEqual(fresh.row.conversation_id,initial.row.conversation_id);
});

test('ambiguous tasks only ask for a choice and a stale write revision cannot pause another task',async t=>{
  const f=await channelFixture(t);let reads=0;
  f.modelState.respond=async(body,res)=>{
    const observed=observation(body);
    if(input(body).request==='暂停某个任务'){
      if(!observed.length)return call(res,'list_tasks');
      return reply(res,'请提供要暂停的任务标题和项目名称。');
    }
    if(!observed.length)return call(res,'get_task',{project_id:'101',task_id:'blocked'});
    if(observed.length===1){
      reads++;f.h.store.run("UPDATE tasks SET summary='Changed while choosing' WHERE id='blocked'");
      return respond(res,{role:'assistant',content:null,tool_calls:[{id:'stale-pause',type:'function',function:{name:'management_command',arguments:JSON.stringify({operation:'task.pause',target:{project_id:'101',task_id:'blocked'},arguments:{},expected_revision:observed[0].revision})}}]});
    }
    reply(res,'不应到达这里');
  };
  const ambiguous=await im(f,'暂停某个任务');assert.equal(ambiguous.row.state,'completed');assert.equal(f.h.store.get("SELECT count(*) n FROM management_commands WHERE channel='im'").n,0);
  const stale=await im(f,'暂停刚才那个');assert.equal(stale.row.state,'failed');assert.equal(reads,1);
  assert.ok(f.h.store.get("SELECT 1 FROM management_events WHERE message_id=? AND type='tool_error' AND data LIKE '%management_revision_conflict%'",stale.row.message_id));
  assert.equal(f.h.store.get("SELECT status FROM tasks WHERE id='blocked'").status,'waiting_environment');
});

test('unknown execution receipts survive a misleading model answer and are never automatically repeated',async t=>{
  const f=await channelFixture(t);let effects=0;
  f.service.management.service.extensions.set('knowledge.revise',{execute:async()=>{effects++;throw new Error('fixture unknown effect');},reconcile:async()=>null});
  f.modelState.respond=async(body,res)=>{
    const observed=observation(body);
    if(!observed.length)return call(res,'get_effective_config',{project_id:'101'});
    if(observed.length===1)return respond(res,{role:'assistant',content:null,tool_calls:[{id:'unknown-effect',type:'function',function:{name:'management_command',arguments:JSON.stringify({operation:'knowledge.revise',target:{project_id:'101'},arguments:{id:'entry',revision:1},expected_revision:observed[0].revision})}}]});
    assert.equal(observed[1].state,'unknown');reply(res,'操作已完成。');
  };
  const result=await im(f,'更新知识');assert.equal(result.row.state,'completed');await sent(f,'执行结果待确认，请先对账，勿重复提交');
  assert.ok(!JSON.stringify(f.wire.sent).includes('操作已完成。'));
  await post(f.h,f.id,result.event);assert.equal(effects,1);assert.equal(f.h.store.get("SELECT state FROM management_commands WHERE channel='im'").state,'unknown');
});

test('connector changes start fresh personal context without changing the logical chat',async t=>{
  const f=await channelFixture(t);
  f.modelState.respond=async(body,res)=>{assert.deepEqual(input(body).history,[]);reply(res,'你好，可以按项目名称提问。');};
  const first=await im(f,'你好');assert.equal(first.row.state,'completed');
  f.h.store.run('UPDATE channel_connectors SET revision=revision+1 WHERE id=?',f.id);
  const second=await im(f,'你好');assert.equal(second.row.state,'completed',second.row.error);assert.notEqual(second.row.conversation_id,first.row.conversation_id);
  assert.equal(f.h.store.get("SELECT count(*) n FROM channel_chats WHERE chat_id='oc_private'").n,1);
  assert.equal((await f.admin('/api/management/conversations/'+first.row.conversation_id+'/events')).status,403);
});

test('personal delivery rechecks permission after asynchronous Feishu authentication',async t=>{
  const f=await channelFixture(t),member=await f.member('delivery-revoked',{repository_ids:['101']});bindFixture(f.h,f.id,member.id,'ou_delivery');
  let release,sending;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  // Pause authentication for this reply, not a preceding profile or connection check.
  f.wire.state.authGate=async()=>{
    const row=f.h.store.all("SELECT id,payload,source_event FROM channel_outbox WHERE state='sending'").find(row=>JSON.stringify(f.h.store.secrets.open(row.payload,'channel-outbox:'+row.id).delivery).includes('Protected private project fact'));
    if(row){sending=row;await gate;}
  };
  f.modelState.respond=async(body,res)=>reply(res,'Protected private project fact');
  const receipt=await post(f.h,f.id,envelope('查询任务',{sender:{sender_id:{open_id:'ou_delivery'}},message:{chat_id:'oc_delivery'}}));
  // Receipt reactions also exchange tokens; wait for this protected reply's actual authentication barrier.
  await until(()=>sending);assert.equal(sending.source_event,receipt.value.operation_id);
  await f.admin('/api/project-admin-assignments','PUT',{user_id:member.id,repository_ids:[]});f.wire.state.authGate=null;release();
  const outbox=await until(()=>f.h.store.get('SELECT * FROM channel_outbox WHERE id=?',sending.id),r=>r?.state==='failed');
  assert.equal(outbox.last_error,'authorization_changed');assert.ok(!JSON.stringify(f.wire.sent).includes('Protected private project fact'));
});

test('private history cleanup erases management text and snapshots, including a late model answer',async t=>{
  const f=await channelFixture(t);
  f.modelState.respond=async(body,res)=>reply(res,'private-cleanup-derived');
  const first=await im(f,'private-cleanup-original');assert.equal(first.row.state,'completed');
  let chat=f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_private'");f.service.ledger.cleanup(chat.id,Date.now(),chat.revision);
  assert.ok(!f.h.store.get('SELECT input FROM management_messages WHERE id=?',first.row.message_id).input.includes('private-cleanup-original'));
  assert.equal(f.h.store.get('SELECT count(*) n FROM management_events WHERE message_id=?',first.row.message_id).n,0);
  assert.equal(f.h.store.get('SELECT request_snapshot FROM model_requests WHERE conversation_id=?',first.row.conversation_id).request_snapshot,null);
  assert.equal((await f.admin('/api/management/conversations/'+first.row.conversation_id+'/events')).status,409);
  let release;f.modelState.gate=new Promise(r=>release=r);t.after(()=>release());const before=f.requests.length;
  const receipt=await post(f.h,f.id,envelope('private-late-original'));await until(()=>f.requests.length>before);
  const row=f.h.store.get('SELECT * FROM channel_inbox WHERE id=?',receipt.value.operation_id);
  chat=f.h.store.get('SELECT * FROM channel_chats WHERE id=?',chat.id);f.service.ledger.cleanup(chat.id,Date.now(),chat.revision);
  f.modelState.gate=null;release();assert.equal((await finished(f.h,receipt.value.operation_id)).state,'failed');
  assert.equal(f.h.store.get('SELECT request_snapshot FROM model_requests WHERE conversation_id=?',row.conversation_id).request_snapshot,null);
  assert.ok(!JSON.stringify(f.h.store.all('SELECT data FROM management_events WHERE message_id=?',row.message_id)).includes('private-cleanup-derived'));
});

test('the management assistant works a side question in its own task with the user\'s own tools and keeps only the conclusion',async t=>{
  const f=await channelFixture(t),ownBodies=[];
  const tool=(res,name,args)=>respond(res,{role:'assistant',content:null,tool_calls:[{id:'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  let main;
  f.modelState.respond=async(body,res)=>{
    const seen=observation(body);
    if(body.messages[0].content.includes('one of your own independent tasks')){
      ownBodies.push(body);
      return seen.length?reply(res,'可访问的项目有 '+seen[0].projects.length+' 个。'):call(res,'list_projects');
    }
    return main(body,res,seen);
  };
  main=(body,res,seen)=>!seen.length?tool(res,'start_own_task',{title:'盘点项目',instruction:'数一数我能访问几个项目'}):reply(res,'结论：'+seen[0].conclusion);
  const first=await web(f,'我能管理几个项目？');
  assert.equal(first.history.messages[0].state,'completed');
  const events=first.history.events.filter(e=>e.type==='tool_call').map(e=>e.data.name);
  assert.deepEqual(events,['start_own_task','management_query']);
  const result=first.history.events.find(e=>e.type==='tool_result'&&e.data.name==='start_own_task').data.result;
  assert.equal(result.state,'completed');assert.match(result.conclusion,/可访问的项目有 \d+ 个/);
  assert.match(first.history.events.find(e=>e.type==='reply').data.text,/结论：可访问的项目有/);
  // Inside the own task: the same management tools, no own-task tools, a context of its own.
  assert.deepEqual(ownBodies[0].tools.map(t=>t.function.name),['management_query','management_command','search_role_memory','read_role_memory','remember_role_memory','github_read','github_search','read_job_log']);
  assert.equal(JSON.parse(ownBodies[0].messages[1].content).instruction,'数一数我能访问几个项目');
  const row=f.h.store.get('SELECT * FROM service_role_own_tasks');
  assert.equal(row.owner_kind,'management');assert.equal(row.owner_id,first.conversation);assert.equal(row.service_role_id,'management-assistant');
  assert.equal(f.h.store.get("SELECT count(*) n FROM model_requests WHERE service_role_id='management-assistant' AND repository_id IS NOT NULL").n,0);
  // Another conversation of the same user does not see it; the same conversation can continue it.
  main=(body,res,seen)=>!seen.length?tool(res,'list_own_tasks',{}):reply(res,'没有。');
  const other=await web(f,'列出独立任务');assert.deepEqual(observation(f.requests.at(-1))[0].own_tasks,[]);
  assert.notEqual(other.conversation,first.conversation);
  main=(body,res,seen)=>!seen.length?tool(res,'continue_own_task',{task_id:row.id,instruction:'再确认一次'}):reply(res,'已确认。');
  const message=(await f.admin('/api/management/conversations/'+first.conversation+'/messages','POST',{source_message:'fixture-web-2',content:'再确认一次'})).value;
  const history=await settled(f.admin,first.conversation,message.id);
  assert.equal(history.events.filter(e=>e.type==='tool_result'&&e.data.name==='continue_own_task').at(-1).data.result.round,2);
  assert.match(JSON.parse(ownBodies.at(-1).messages[1].content).own_task.previous_rounds[0].conclusion,/可访问的项目有/);
});
