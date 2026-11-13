import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCredentials, redactCredentials } from '../dist/core/redaction.js';
import { traceClean } from '../dist/tasks/trace.js';
import { publicText } from '../dist/actions/safety.js';
import { Redactor } from '../dist/agent/common.js';
import { managementFixture, command, settled } from './management-fixture.mjs';

const ordinary = ['How do I pass a bearer token to the API?', 'This adds basic validation for the input.', 'const token = readToken();', 'max_tokens: 8192', '{\n  "token": "ordinary public value",\n  "analysis": [1, 2]\n}', '@bot 绑定', '绑定 是什么意思', '重新认证 失败了怎么办'];
test('ordinary authentication prose, code and formatted JSON retain their exact bytes', () => {
  for (const text of ordinary) {
    assert.equal(hasCredentials(text), false, text);
    assert.equal(redactCredentials(text), text);
    assert.equal(traceClean(text), text);
    assert.equal(publicText(text, new Redactor(), false), text);
  }
  const value = { analysis: 'ordinary explanation', token: 'public word', max_tokens: 8192 };
  assert.equal(hasCredentials(value), false);assert.deepEqual(traceClean(value), value);
  assert.deepEqual(traceClean({role:'assistant',content:'public answer',analysis:'private provider reasoning'}),{role:'assistant',content:'public answer'});
  assert.equal(hasCredentials('[REDACTED] is the documented marker'), false);
});
test('real credential shapes and registered values remain redacted', () => {
  for (const secret of ['Authorization: Bearer '+'a'.repeat(40), 'Bearer AbCd0123456789AbCd0123456789', 'Basic dXNlcjpwYXNzd29yZA==', 'ghp_'+'a'.repeat(30), 'sk-'+'a'.repeat(30), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fixtureSignature', 'https://user:pass@host/path', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----', 'password=hunter2', 'token="AbCd0123456789AbCd0123456789"']) {
    assert.equal(hasCredentials(secret), true, secret);assert.ok(redactCredentials(secret).includes('[REDACTED]'));
    assert.notEqual(publicText(secret, new Redactor(), false), secret);
  }
  assert.equal(hasCredentials({ analysis: { password: 'fixture-password' } }), true);
  for(const value of [{password:'123456'},{password:'some(password)'},'password="some(password)"'])assert.equal(hasCredentials(value),true);
  assert.equal(hasCredentials('const api_key = readKey();'),false);
  assert.equal(hasCredentials('Bearer '+'1'.repeat(40)),true);
  const escaped=JSON.stringify({token:'ghp_'+'a'.repeat(30)}).replace('ghp_',String.fromCharCode(92)+'u0067hp_');
  assert.equal(hasCredentials(escaped),true);assert.equal(JSON.parse(redactCredentials(escaped)).token,'[REDACTED]');
  assert.deepEqual(traceClean({token:'AbCd0123456789AbCd0123456789'}),{token:'[REDACTED]'});
  const redactor = new Redactor();redactor.add('registered-private-value');
  assert.equal(publicText('value: registered-private-value',redactor,false),'value: [REDACTED]');
});
test('management input and commands accept and retain normal text without trace-only transformations',async t=>{
  const f=await managementFixture(t);
  f.modelState.respond=(_body,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'已读取'}}]}));};
  const conversation=(await f.admin('/api/management/conversations','POST',{scope:'platform'})).value.conversation.id;
  for(const [index,content] of ordinary.entries()) {
    const submitted=await f.admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'ordinary-'+index,content});
    assert.equal(submitted.status,201,JSON.stringify(submitted.value));
    const history=await settled(f.admin,conversation,submitted.value.id);assert.equal(history.messages.find(row=>row.id===submitted.value.id).state,'completed');
    assert.equal(JSON.parse(f.h.store.get('SELECT input FROM management_messages WHERE id=?',submitted.value.id).input).content,content);
    const result=await command(f.admin,'workflow.update',{project_id:'101',workflow_id:'review.issue'},{prompt:content},'ordinary-command-'+index);
    assert.equal(result.status,201,JSON.stringify(result.value));
    const stored=f.h.store.get('SELECT arguments FROM management_commands WHERE idempotency_key=?','ordinary-command-'+index);
    assert.equal(JSON.parse(stored.arguments).prompt,content);
  }
  const rejected=await f.admin('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'real-secret',content:'Bearer '+'a'.repeat(40)});
  assert.equal(rejected.status,400);assert.equal(rejected.value.error,'sensitive_management_input');
});

test('GitHub comments retain ordinary prose, code and JSON through the write boundary',async t=>{
  const {createServer}=await import('node:http'),{once}=await import('node:events');
  const {Store}=await import('../dist/storage/database.js'),{githubWrite,githubWriteStorage}=await import('../dist/github/write.js');
  const store=new Store(':memory:',Buffer.alloc(32,7));t.after(()=>store.close());githubWriteStorage(store);
  store.run("INSERT INTO accounts VALUES('a','fixture','bot_account','1',?,'now')",store.secrets.seal({token:'fixture-github-credential'},'account:a'));
  store.run("INSERT INTO repositories VALUES('r','fixture/redaction','10','a')");
  const posted=[],server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){posted.push(JSON.parse(raw));res.statusCode=201;return res.end(JSON.stringify({id:posted.length,html_url:'https://github.invalid/comment/'+posted.length}));}
    if(req.url==='/repositories/r')return res.end(JSON.stringify({id:'r',full_name:'fixture/redaction',owner:{id:10},default_branch:'main'}));
    return res.end(JSON.stringify({id:1,number:1}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const context={store,repository:store.get("SELECT * FROM repositories WHERE id='r'"),redactor:new Redactor(),guard:async()=>{},apiUrl:'http://127.0.0.1:'+server.address().port,scope:'redaction-fixture',actor:{kind:'task',role:'dev'},allowed:()=>true};
  for(const [index,body] of ordinary.slice(0,5).entries()) {
    const result=await githubWrite(context,{method:'POST',path:'/issues/1/comments',body:{body},key:'ordinary-'+index});
    assert.equal(result.status,201,JSON.stringify(result));assert.ok(posted[index].body.startsWith(body+'\n\n<!-- dept-bot-write:'));
  }
});
