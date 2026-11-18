import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCredentials, redactCredentials } from '../../../../dist/core/redaction.js';
import { traceClean } from '../../../../dist/tasks/trace.js';
import { publicText } from '../../../../dist/actions/safety.js';
import { Redactor } from '../../../../dist/agent/common.js';
import { managementFixture, command, settled } from '../../../fixtures/management-fixture.mjs';

const ordinary = ['How do I pass a bearer token to the API?', 'This adds basic validation for the input.', 'const token = readToken();', 'max_tokens: 8192', '{\n  "token": "ordinary public value",\n  "analysis": [1, 2]\n}', '@bot 绑定', '绑定 是什么意思', '重新认证 失败了怎么办'];
test('ordinary authentication prose, code and formatted JSON retain their exact bytes', () => {
  for (const text of ordinary) {
    assert.equal(hasCredentials(text), false, text);
    assert.equal(redactCredentials(text), text);
    assert.equal(traceClean(text), text);
    assert.equal(publicText(text, new Redactor()), text);
  }
  const value = { analysis: 'ordinary explanation', token: 'public word', max_tokens: 8192 };
  assert.equal(hasCredentials(value), false);assert.deepEqual(traceClean(value), value);
  assert.deepEqual(traceClean({role:'assistant',content:'public answer',analysis:'private provider reasoning'}),{role:'assistant',content:'public answer'});
  assert.equal(hasCredentials('[REDACTED] is the documented marker'), false);
});
test('real credential shapes and registered values remain redacted', () => {
  for (const secret of ['Authorization: Bearer '+'a'.repeat(40), 'Bearer AbCd0123456789AbCd0123456789', 'Basic dXNlcjpwYXNzd29yZA==', 'ghp_'+'a'.repeat(30), 'sk-'+'a'.repeat(30), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fixtureSignature', 'https://user:pass@host/path', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----', 'password=hunter2', 'token="AbCd0123456789AbCd0123456789"']) {
    assert.equal(hasCredentials(secret), true, secret);assert.ok(redactCredentials(secret).includes('[REDACTED]'));
    assert.notEqual(publicText(secret, new Redactor()), secret);
  }
  assert.equal(hasCredentials({ analysis: { password: 'fixture-password' } }), true);
  for(const value of [{password:'123456'},{password:'some(password)'},'password="some(password)"'])assert.equal(hasCredentials(value),true);
  assert.equal(hasCredentials('const api_key = readKey();'),false);
  assert.equal(hasCredentials('Bearer '+'1'.repeat(40)),true);
  const escaped=JSON.stringify({token:'ghp_'+'a'.repeat(30)}).replace('ghp_',String.fromCharCode(92)+'u0067hp_');
  assert.equal(hasCredentials(escaped),true);assert.equal(JSON.parse(redactCredentials(escaped)).token,'[REDACTED]');
  assert.deepEqual(traceClean({token:'AbCd0123456789AbCd0123456789'}),{token:'[REDACTED]'});
  const redactor = new Redactor();redactor.add('registered-private-value');
  assert.equal(publicText('value: registered-private-value',redactor),'value: [REDACTED]');
});
test('public diagnostics redact encoded credentials and preserve unrelated Base64 and hashes', () => {
  const redactor = new Redactor(), secret = 'synthetic\u{1F512}\u{1FFFF}fixture';
  redactor.add(secret);
  for (const encoding of ['base64', 'base64url']) {
    for (const value of [secret, JSON.stringify({ debug: { message: 'upstream returned ' + secret } })]) {
      const encoded = Buffer.from(value).toString(encoding);
      const line = JSON.stringify({ observation: JSON.stringify({ value: encoded }) });
      assert.equal(publicText(line, redactor), line.replace(encoded, '[REDACTED]'));
    }
    const benign = Buffer.from('public diagnostic information from the build').toString(encoding);
    assert.equal(publicText(benign, redactor), benign);
  }
  const hash = '0123456789abcdef'.repeat(4);
  assert.equal(publicText('commit ' + hash, redactor), 'commit ' + hash);
});

test('line-wrapped Base64 is inspected as a single diagnostic payload', () => {
  const redactor = new Redactor(), secret = 'fixture-actions-installation-token';
  redactor.add(secret);
  for (const width of [64, 65, 76, 80]) {
    for (const encoding of ['base64', 'base64url']) {
      const wrap = value => Buffer.from(JSON.stringify(value)).toString(encoding).match(new RegExp('.{1,' + width + '}', 'g')).join('\r\n');
      const payload = { pad: 'x'.repeat(25), log: 'HTTP 401: ' + secret };
      const encoded = wrap(payload), benign = wrap({ ...payload, log: 'HTTP 401: ordinary public information' });
      assert.equal(publicText('Diagnostic payload:\nAttachment\n' + encoded + '\nNext verification step.', redactor),
        'Diagnostic payload:\nAttachment\n[REDACTED]\nNext verification step.', encoding + ' at ' + width);
      assert.equal(publicText(benign, redactor), benign.replaceAll('\r\n', '\n'));
    }
  }
});

test('Markdown keeps its prose when a folded credential is quoted, listed or written inline', () => {
  const redactor = new Redactor(), secret = 'fixture-actions-installation-token';
  redactor.add(secret);
  const encode = log => Buffer.from(JSON.stringify({ pad: 'x'.repeat(25), log })).toString('base64url');
  const sensitive = encode('HTTP 401: ' + secret), benign = encode('HTTP 401: public diagnostic data');
  const sha = '0123456789abcdef'.repeat(4);
  const nextToCommit = sha + ' ' + sensitive.match(/.{1,64}/g).join(' ');
  assert.equal(publicText('commit ' + nextToCommit + ' was returned.', redactor), 'commit ' + sha + ' [REDACTED] was returned.');
  // Also cover an unpadded payload that ends on a full-width fragment immediately before prose.
  for (const width of [76, Math.ceil(sensitive.length / 2)]) {
    for (const [prefix, join] of [['', '\n'], ['> ', '\n> '], ['> > ', '\r\n> > '],
      ['- ', '\n- '], ['1. ', '\n2. '], ['', ' '], ['', '\t']]) {
      const format = value => prefix + value.match(new RegExp('.{1,' + width + '}', 'g')).join(join) + ' was returned by the gateway.';
      assert.equal(publicText(format(sensitive), redactor), prefix + '[REDACTED] was returned by the gateway.');
      assert.equal(publicText(format(benign), redactor), format(benign).replaceAll('\r\n', '\n'));
    }
  }
});

test('folded diagnostics keep a longer preceding URL', () => {
  const redactor = new Redactor(), secret = 'fixture-actions-installation-token';
  redactor.add(secret);
  const url = 'https://logs.invalid/' + 'a'.repeat(80);
  const wrapped = Buffer.from(JSON.stringify({ pad: 'x'.repeat(25), log: 'HTTP 401: ' + secret })).toString('base64').match(/.{1,76}/g).join('\n');
  assert.equal(publicText(url + '\n' + wrapped, redactor), url + '\n[REDACTED]');
});

test('a SHA following an unpadded full-width final fragment stays visible', () => {
  const redactor = new Redactor(), secret = 'fixture-actions-installation-token';
  redactor.add(secret);
  const encode = size => Buffer.from(JSON.stringify({ pad: 'x'.repeat(size - 4) + '}[]"', log: 'HTTP 401: ' + secret })).toString('base64');
  for (const [size, width, nextSha] of [[50, 76, 'b'.repeat(40)], [32, 64, 'a'.repeat(64)]]) {
    const fullLines = encode(size).match(new RegExp('.{1,' + width + '}', 'g'));
    assert.deepEqual(fullLines.map(line => line.length), [width, width]);
    assert.ok(!fullLines.at(-1).endsWith('='));
    assert.equal(publicText(['Encoded payload:', ...fullLines, nextSha, 'Next verification step.'].join('\n'), redactor),
      ['Encoded payload:', '[REDACTED]', nextSha, 'Next verification step.'].join('\n'));
  }
});

test('timestamps on folded Actions log lines stay visible around the redacted fragments', () => {
  const redactor = new Redactor(), secret = 'fixture-actions-installation-token';
  redactor.add(secret);
  const encode = message => Buffer.from(JSON.stringify({ pad: 'x'.repeat(25), log: message })).toString('base64url').match(/.{1,76}/g);
  for (const [first, second] of [
    ['2026-11-18T11:22:23.1234567Z', '2026-11-18T11:22:24.0000000Z'],
    ['[11:22:23.123]', '[11:22:24.000]']
  ]) {
    const format = parts => '> ' + first + ' ' + parts[0] + '\n> ' + second + ' ' + parts[1] + ' was returned.';
    const benign = format(encode('HTTP 401: ordinary public data'));
    assert.equal(publicText(benign, redactor), benign);
    assert.equal(publicText(format(encode('HTTP 401: ' + secret)), redactor), format(['[REDACTED]', '[REDACTED]']));
  }
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
  const numeric=await command(f.admin,'roles.update',{project_id:'101'},{expected_revision:0,enabled:false,roles:[{password:123456}]},'numeric-secret');
  assert.equal(numeric.status,400);assert.equal(numeric.value.error,'sensitive_management_arguments');
});

test('camelCase credential fields, header schemes and numeric passwords retain protection', () => {
  const value='AbCd0123456789AbCd0123456789';
  for(const name of ['accessToken','clientSecret','refreshToken','dbPassword','apiKey']) {
    for(const input of [{[name]:value},JSON.stringify({[name]:value}),`https://host/cb?${name}=${value}`]) {
      assert.equal(hasCredentials(input),true,JSON.stringify(input));
      assert.ok(!JSON.stringify(redactCredentials(input)).includes(value));
      assert.ok(!publicText(typeof input==='string'?input:JSON.stringify(input),new Redactor()).includes(value));
    }
  }
  for(const header of ['Basic YTpi','Bearer abcdef','Token '+value,'Digest username="u", response="fixture"']) {
    for(const input of ['Authorization: '+header,{Authorization:header}]) {
      assert.equal(hasCredentials(input),true);
      assert.ok(!JSON.stringify(redactCredentials(input)).includes(header));
    }
  }
  assert.deepEqual(redactCredentials({password:123456,dbPassword:987654,max_tokens:8192,maxTokens:8192}),
    {password:'[REDACTED]',dbPassword:'[REDACTED]',max_tokens:8192,maxTokens:8192});
});

test('secretKey and credentialValue names protect credentials without rejecting ordinary values or code', () => {
  const value='AbCd0123456789AbCd0123456789';
  for(const name of ['secretKey','credentialValue','clientSecretKey']) {
    for(const input of [{[name]:value},JSON.stringify({[name]:value}),`https://host/cb?${name}=${value}`]) {
      assert.equal(hasCredentials(input),true,JSON.stringify(input));
      assert.ok(!JSON.stringify(redactCredentials(input)).includes(value));
    }
    const code=`const ${name} = readKey();`;
    assert.equal(hasCredentials(code),false);assert.equal(publicText(code,new Redactor()),code);
  }
  for(const input of [{credentialValue:'ordinary public value'},{credentialValue:8192},{max_tokens:8192},'This describes a secret key and a credential value.']) {
    assert.equal(hasCredentials(input),false);assert.deepEqual(redactCredentials(input),input);
  }
  assert.deepEqual(redactCredentials({secretKey:123456}),{secretKey:'[REDACTED]'});
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
  for(const [index,body] of ordinary.slice(0,5).entries()) {
    const result=await githubWrite(context,{method:'POST',path:'/issues/1/comments',body:{body},key:'ordinary-'+index});
    assert.equal(result.status,201,JSON.stringify(result));assert.ok(posted[index].body.startsWith(body+'\n\n<!-- dept-bot-write:'));
  }
});

test('inline headers, signed download parameters and multiline key blocks leave adjacent diagnostics intact', () => {
  const safeURL = 'https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/44199315530';
  for (const [input, expected] of [
    ['Authorization: Bearer AbC1 returned HTTP 401', 'Authorization: [REDACTED] returned HTTP 401'],
    ['Cookie: session=fixture; csrf=second caused HTTP 403', 'Cookie: [REDACTED] caused HTTP 403'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nfixture\n\nmore\n-----END PGP PRIVATE KEY BLOCK-----\nHTTP 403', '[REDACTED]\nHTTP 403'],
    ['[log](https://logs.invalid/a?sv=1&%73ig=short%2Bvalue&page=2)', '[log](https://logs.invalid/a?sv=1&%73ig=[REDACTED]&page=2)'],
    ['[log](https://logs.invalid/a?X-Goog-Signature=google-signed)', '[log](https://logs.invalid/a?X-Goog-Signature=[REDACTED])']
  ]) {
    const value = input + '\n\n' + safeURL, cleaned = expected + '\n\n' + safeURL;
    assert.equal(redactCredentials(value), cleaned);
    assert.equal(redactCredentials(cleaned), cleaned);
  }
});
