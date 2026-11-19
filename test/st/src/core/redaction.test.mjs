import test from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../../../../dist/agent/common.js';
import { publicText, registeredRedactor } from '../../../../dist/core/redaction.js';
import { managementFixture, command, settled } from '../../../fixtures/management-fixture.mjs';

const ordinary = ['密码: test_value', 'api_key = env.OPENAI_API_KEY', 'session_token = user_session_token_id',
  'token = "my_custom_identifier_12345"', '-----BEGIN CERTIFICATE-----', '{\n  "token": "ordinary public value",\n  "analysis": [1, 2]\n}'];
test('a short configured model key preserves ordinary text and binary content', async t => {
  const { admin, h } = await managementFixture(t);
  const model = await admin('/api/models','POST',{model_name:'local',api_url:'http://localhost:8484/v1',api_key:'x'});
  assert.equal(model.status,201);
  const redactor = registeredRedactor(h.store), text = 'example x text';
  assert.equal(redactor.text(text), text);
  assert.equal(publicText(text, redactor), text);
  assert.equal(redactor.contains(Buffer.from(text)), false);
  redactor.add('12345678');
  assert.equal(redactor.text('x 12345678'), 'x [REDACTED]');
  assert.equal(redactor.contains(Buffer.from('x 12345678')), true);
});

test('management input and commands accept and retain normal text without trace-only transformations',async t=>{
  const f=await managementFixture(t);
  f.modelState.respond=(_body,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'已读取'}}]}));};
  const conversation=(await f.admin('/api/management/conversations','POST',{scope:'platform'})).value.conversation.id;
  const exact = 'fixture-provider-key';
  for(const [index,content] of [...ordinary, 'before '+exact+' after'].entries()) {
    const expected = content.replace(exact, '[REDACTED]');
    const submitted=await f.admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'ordinary-'+index,content});
    assert.equal(submitted.status,201,JSON.stringify(submitted.value));
    if (content.includes(exact)) {
      const replay = await f.admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'ordinary-'+index,content});
      assert.equal(replay.value.id,submitted.value.id);
      const conflict = await f.admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'ordinary-'+index,content:expected});
      assert.equal(conflict.status,409);
    }
    const history=await settled(f.admin,conversation,submitted.value.id);assert.equal(history.messages.find(row=>row.id===submitted.value.id).state,'completed');
    assert.equal(JSON.parse(f.h.store.get('SELECT input FROM management_messages WHERE id=?',submitted.value.id).input).content,expected);
    const result=await command(f.admin,'workflow.update',{project_id:'101',workflow_id:'review.issue'},{prompt:content},'ordinary-command-'+index);
    assert.equal(result.status,201,JSON.stringify(result.value));
    const stored=f.h.store.get('SELECT arguments FROM management_commands WHERE idempotency_key=?','ordinary-command-'+index);
    assert.equal(JSON.parse(stored.arguments).prompt,expected);
  }
});

test('GitHub comments retain ordinary prose, code and JSON through the write boundary',async t=>{
  const {createServer}=await import('node:http'),{once}=await import('node:events');
  const {Store}=await import('../../../../dist/storage/database.js'),{githubWrite,githubWriteStorage}=await import('../../../../dist/github/write.js');
  const store=new Store(':memory:',Buffer.alloc(32,7));t.after(()=>store.close());githubWriteStorage(store);
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account','1',?,'now')",store.secrets.seal({token:'fixture-github-credential'},'account:a'));
  store.run("INSERT INTO repositories VALUES('r','fixture/redaction','10','a')");store.run("INSERT INTO policies(repository_id,enabled,capability_ceiling) VALUES('r',1,'comment')");
  const posted=[],server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){posted.push(JSON.parse(raw));res.statusCode=201;return res.end(JSON.stringify({id:posted.length,html_url:'https://github.invalid/comment/'+posted.length}));}
    if(req.url==='/repositories/r')return res.end(JSON.stringify({id:'r',full_name:'fixture/redaction',owner:{id:10},default_branch:'main'}));
    return res.end(JSON.stringify({id:1,number:1}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const context={store,repository:store.get("SELECT * FROM repositories WHERE id='r'"),redactor:new Redactor(),guard:async()=>{},apiUrl:'http://127.0.0.1:'+server.address().port,scope:'redaction-fixture',actor:{kind:'task',role:'dev'},allowed:()=>true};
  const encoded = Buffer.from('fixture-github-credential').toString('base64');
  for(const [index,body] of [...ordinary,'before '+encoded+' after'].entries()) {
    const result=await githubWrite(context,{method:'POST',path:'/issues/1/comments',body:{body},key:'ordinary-'+index});
    assert.equal(result.status,201,JSON.stringify(result));assert.ok(posted[index].body.startsWith(body.replace(encoded,'[REDACTED]')+'\n\n<!-- dept-bot-write:'));
  }
});
