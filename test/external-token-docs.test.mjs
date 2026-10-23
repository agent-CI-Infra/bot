import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {externalFixture} from './external-helpers.mjs';

test('documented OpenSSL and curl client signs, exchanges, comments and revokes without the Node helper',async t=>{
  const h=await externalFixture(t),client=await h.client(),key=join(h.directory,'bot-client.pem');
  writeFileSync(key,client.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const document=readFileSync(resolve('docs/external-token-api.md'),'utf8');
  const blocks=new Map([...document.matchAll(/```sh\n# (token-[\w-]+)\n([\s\S]*?)```/g)].map(match=>[match[1],match[2]]));
  assert.equal(blocks.size,6);
  const setup=blocks.get('token-setup').replace(/^TOKEN_URL=.*$/m,'TOKEN_URL="$FIXTURE_AUDIENCE"')
    .replace(/^CLIENT_ID=.*$/m,'CLIENT_ID="$FIXTURE_CLIENT"').replace(/^KEY_FILE=.*$/m,'KEY_FILE="$FIXTURE_KEY"');
  // The fixture transports HTTP locally; the signed audience remains the exact registered HTTPS URL.
  const exchange=blocks.get('token-exchange').replace('POST "$TOKEN_URL"','POST "$FIXTURE_TOKEN_ENDPOINT"');
  const use=blocks.get('token-use').replace(/^COMMENT_URL=.*$/m,'COMMENT_URL="$FIXTURE_COMMENT_ENDPOINT"');
  const revoke=blocks.get('token-revoke').replace(/^REVOKE_URL=.*$/m,'REVOKE_URL="$FIXTURE_REVOKE_ENDPOINT"');
  const script=[setup,blocks.get('token-sign'),exchange,use,revoke,blocks.get('token-cleanup')].join('\n');
  const child=spawn('sh',['-s'],{cwd:h.directory,env:{...process.env,FIXTURE_AUDIENCE:h.audience,FIXTURE_CLIENT:client.client.id,FIXTURE_KEY:key,
    FIXTURE_TOKEN_ENDPOINT:h.webhook+'/external/token',FIXTURE_REVOKE_ENDPOINT:h.webhook+'/external/revoke',
    FIXTURE_COMMENT_ENDPOINT:h.github.url+'/repos/fixture/project-101/issues/1/comments'},stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.stdin.end(script);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,error);assert.equal(h.github.grants.length,1);assert.equal(h.github.comments.length,1);
  assert.equal(h.github.comments[0].body,'检视完成：请在这里填写结论。');
  assert.equal(h.store.get('SELECT state FROM external_grants').state,'revoked');
  for(const [token,state]of h.github.tokens){assert.equal(state.revoked,true);assert.ok(!output.includes(token));}
});
