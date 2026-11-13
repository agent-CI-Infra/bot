import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFixture, boundGroup, repositoryAssistant, credentials, envelope, inGroup, post, until } from './channel-fixture.mjs';

const say = (res, content) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({choices:[{message:{role:'assistant',content}}],usage:{prompt_tokens:12,completion_tokens:4}})); };
const inbox = (f,receipt) => f.h.store.get('SELECT * FROM channel_inbox WHERE id=?',receipt.value.operation_id);
const done = (f,receipt) => until(()=>inbox(f,receipt),row=>['completed','failed'].includes(row?.state));
function gate(t) { let release; const wait=new Promise(resolve=>{release=resolve;});t.after(()=>release());return {wait,release}; }
async function fixture(t,personal) {
  const f=await channelFixture(t);
  if(!personal){await repositoryAssistant(f);f.chat=await boundGroup(f);}
  f.send=text=>post(f.h,f.id,personal?envelope(text):inGroup(text));
  return f;
}
async function recall(f,receipt) {
  const event=f.service.turnMessages.event(inbox(f,receipt));
  const result=await post(f.h,f.id,{header:{create_time:String(Date.now()*1000),event_id:'recall-'+event.event_id,event_type:'im.message.recalled_v1',token:credentials.verification_token,app_id:event.app_id,tenant_key:event.installation_tenant},
    event:{chat_id:event.chat_id,message_id:event.message_id,recall_time:String(Date.now())}});
  assert.equal(result.status,200,JSON.stringify(result.value));
}

for(const personal of [false,true]) {
  for(const change of ['recall','edit'])test(`${personal?'private':'group'} ${change} of history refreshes an active answer without replacing the session`,async t=>{
    const f=await fixture(t,personal),waiting=gate(t),release=gate(t);let calls=0;
    f.modelState.respond=async(body,res)=>{
      calls++;
      if(calls===1)return say(res,'引用 old-source-unique 的早期回答');
      if(calls===2){waiting.release();await release.wait;return say(res,'依赖旧正文的迟到回答');}
      const text=JSON.stringify(body);
      assert.ok(!text.includes('old-source-unique'),text);
      assert.ok(!text.includes('依赖旧正文的迟到回答'));
      assert.match(text,change==='recall'?/recalled/:/edited/);
      if(change==='edit')assert.match(text,/new-source-unique/);
      return say(res,'基于当前原文完成');
    };
    const first=await f.send('old-source-unique');assert.equal((await done(f,first)).state,'completed');
    const original=inbox(f,first),event=f.service.turnMessages.event(original),chat=f.service.ledger.chat(event),fence=personal?null:f.service.serviceBindings.fence(chat.id);
    f.h.store.run('INSERT INTO channel_chat_summaries VALUES(?,?,?,?,?,?,?)',chat.id,chat.context_revision,1,event.created_at,event.message_id,JSON.stringify({authorization_fence:fence}),f.h.store.secrets.seal({summary:'old-source-unique derived summary'},'channel-summary:'+chat.id));
    const next=await f.send('现在继续');await waiting.wait;
    if(change==='recall')await recall(f,first);
    else f.service.ledger.accept({...event,content:'new-source-unique',raw_content:JSON.stringify({text:'new-source-unique'}),updated_at:Date.now()+1});
    release.release();assert.equal((await done(f,next)).state,'completed');
    assert.equal(calls,3);
    if(personal)assert.equal(inbox(f,next).conversation_id,original.conversation_id);
    else assert.equal(f.service.serviceBindings.fence(chat.id),fence);
    assert.equal(f.service.ledger.query(chat.id,{keyword:'old-source-unique'}).messages.length,0);
    assert.equal(f.h.store.get('SELECT count(*) n FROM channel_chat_summaries WHERE chat_id=?',chat.id).n,0);
    assert.ok(!JSON.stringify(f.wire.sent).includes('依赖旧正文的迟到回答'));
  });
  test(`${personal?'private':'group'} recalling the current question stops only that round`,async t=>{
    const f=await fixture(t,personal),waiting=gate(t),release=gate(t);let calls=0;
    f.modelState.respond=async(_body,res)=>{calls++;if(calls===1){waiting.release();await release.wait;}say(res,calls===1?'不可发送的回答':'后续问题正常回答');};
    const first=await f.send('撤回这一轮的问题');await waiting.wait;
    const original=inbox(f,first);await recall(f,first);release.release();
    assert.equal((await done(f,first)).state,'failed');
    const next=await f.send('后续新问题');assert.equal((await done(f,next)).state,'completed');
    if(personal)assert.equal(inbox(f,next).conversation_id,original.conversation_id);
    assert.ok(!JSON.stringify(f.wire.sent).includes('不可发送的回答'));
  });
}

for(const change of ['roster','backfill'])test(`an active group turn survives ${change} without changing its authorization fence`,async t=>{
  const f=await fixture(t,false),waiting=gate(t),release=gate(t);let calls=0;
  f.modelState.respond=async(_body,res)=>{calls++;waiting.release();await release.wait;say(res,'本轮正常完成');};
  const receipt=await f.send('正常问题');await waiting.wait;
  const chat=f.h.store.get("SELECT * FROM channel_chats WHERE chat_id='oc_group'"),fence=f.service.serviceBindings.fence(chat.id);
  if(change==='roster'){
    const header={...envelope().header,event_type:'im.chat.member.user.added_v1'};
    const result=await post(f.h,f.id,{header,event:{chat_id:'oc_group'}});assert.equal(result.status,200);
  }else{
    f.service.ledger.merge(chat,{message_id:'backfilled',sender_id:'ou_alice',sender_tenant:'actor-tenant',sender_type:'user',message_type:'text',created_at:1,updated_at:1,
      content:'旧历史补读',raw_content:'{}',parent_id:'',root_id:'',thread_id:'',deleted:false},'history');
  }
  release.release();assert.equal((await done(f,receipt)).state,'completed');
  assert.equal(calls,1);assert.equal(f.service.serviceBindings.fence(chat.id),fence);
});
