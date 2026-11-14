import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createRepositoryTool} from '../runner/repository-tool.mjs';
import {createTokenExchange} from '../runner/token-exchange.mjs';
import {agentOperation} from '../runner/agent.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'repository-mailbox-')),dir=join(root,'agent');
  await mkdir(dir);t.after(()=>rm(root,{recursive:true,force:true}));
  const requests=async()=>(await agentOperation({type:'workspace_agent_poll'},root)).tool_requests??[];
  const tokenRequests=async()=>(await agentOperation({type:'workspace_agent_poll'},root)).token_requests??[];
  const deliver=async(id,value,final=true,offset=0)=>agentOperation({type:'workspace_agent_tool',request_id:id,base64:Buffer.from(JSON.stringify(value)).toString('base64'),offset,final},root);
  const emptyMailbox=async()=>{
    for(const sub of ['tool-requests','tool-replies','token-requests','token-replies']){
      assert.deepEqual(await readdir(join(dir,sub)).catch(()=>[]),[],sub);
    }
  };
  return {root,dir,requests,tokenRequests,deliver,emptyMailbox,tool:createRepositoryTool(dir)};
}
async function until(read){
  for(let tries=0;tries<200;tries++){
    const value=await read();if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Timed out waiting for repository mailbox');
}

test('concurrent repository calls write distinct request files and complete out of order in parallel',async t=>{
  const f=await fixture(t),calls=[['github_read',{path:'/issues/42'}],['github_search',{query:'dependency'}],['read_job_log',{job_id:1}]];
  const pending=calls.map(([name,args])=>f.tool(name,args));
  const visible=await until(async()=>{const list=await f.requests();return list.length===calls.length&&list;});
  const byName=new Map(visible.map(item=>[item.name,item]));
  for(const [name,args] of calls){
    assert.ok(byName.has(name),name);
    assert.equal(byName.get(name).kind,'repository');
    assert.deepEqual(byName.get(name).arguments,args);
  }
  // Deliver out of order: #2 first, #0 second, #1 third.
  for(const index of [2,0,1]){
    const req=byName.get(calls[index][0]);
    await f.deliver(req.id,{result:index});
    assert.deepEqual(await pending[index],{result:index});
  }
  assert.deepEqual(await Promise.all(pending),[{result:0},{result:1},{result:2}]);
  await f.emptyMailbox();
});

test('a 120-second timeout removes only the expired request, cleans partial data and rejects late replies',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['Date'],now:1000});
  const first=f.tool('github_read',{path:'/issues'});
  const [expired]=await until(async()=>{const list=await f.requests();return list.length===1&&list;});
  await f.deliver(expired.id,{partial:true},false);
  t.mock.timers.tick(60000);
  const second=f.tool('github_search',{query:'dependency'});
  const both=await until(async()=>{const list=await f.requests();return list.length===2&&list;});
  const current=both.find(item=>item.id!==expired.id);
  // The first call's deadline is fixed when it became visible; advancing to 120s expires only the first call.
  t.mock.timers.tick(60000);
  assert.deepEqual(await first,{error:'repository_tool_timeout'});
  await assert.rejects(f.deliver(expired.id,{late:true}),/agent_request_changed/);
  assert.deepEqual((await f.requests()).map(item=>item.id),[current.id]);
  await f.deliver(current.id,{items:[]});assert.deepEqual(await second,{items:[]});
  await assert.rejects(f.deliver(current.id,{late:true}),/agent_request_changed/);
  await f.emptyMailbox();
});

test('cancellation removes only the cancelled request and leaves concurrent and subsequent calls intact',async t=>{
  const f=await fixture(t),firstAbort=new AbortController(),secondAbort=new AbortController();
  const first=f.tool('github_read',{path:'/issues'},firstAbort.signal),second=f.tool('github_search',{query:'dependency'},secondAbort.signal);
  const visible=await until(async()=>{const list=await f.requests();return list.length===2&&list;});
  const firstReq=visible.find(item=>item.name==='github_read'),secondReq=visible.find(item=>item.name==='github_search');
  firstAbort.abort();
  assert.deepEqual(await first,{error:'repository_tool_cancelled'});
  await assert.rejects(f.deliver(firstReq.id,{late:true}),/agent_request_changed/);
  // Sibling request remains visible and answerable; cancelling it also cleans up cleanly.
  assert.deepEqual((await f.requests()).map(item=>item.id),[secondReq.id]);
  secondAbort.abort();
  assert.deepEqual(await second,{error:'repository_tool_cancelled'});
  await assert.rejects(f.deliver(secondReq.id,{late:true}),/agent_request_changed/);
  await f.emptyMailbox();
  // An abandoned caller does not poison subsequent requests.
  const third=f.tool('github_read',{path:'/readme'}),[next]=await until(async()=>{const list=await f.requests();return list.length===1&&list;});
  await f.deliver(next.id,{content:'readme'});assert.deepEqual(await third,{content:'readme'});
  await f.emptyMailbox();
});

test('abandoning the mailbox during chunk delivery is reported as an expired request',async t=>{
  for(const operation of ['open','rename'])await t.test(operation,async t=>{
    const f=await fixture(t),abort=new AbortController(),pending=f.tool('github_read',{path:'/issues'},abort.signal);
    const [current]=await until(async()=>{const list=await f.requests();return list.length===1&&list;});
    const original=fsPromises[operation];
    const hook=t.mock.method(fsPromises,operation,async(path,...args)=>{
      if(path===join(f.dir,'tool-replies',`${current.id}.tmp`)){
        // Remove the request and partial reply before the delivery's original I/O resumes.
        abort.abort();await pending;
      }
      return original(path,...args);
    });
    syncBuiltinESMExports();
    try{await assert.rejects(f.deliver(current.id,{late:true}),/agent_request_changed/);}
    finally{hook.mock.restore();syncBuiltinESMExports();}
    assert.deepEqual(await pending,{error:'repository_tool_cancelled'});
    await f.emptyMailbox();
  });
});

test('concurrent token exchanges write per-request files, carry run tokens and complete out of order',async t=>{
  const f=await fixture(t),exchange=createTokenExchange(f.dir,{token:'rrt_fixture_token'});
  const first=exchange(t.signal),second=exchange(t.signal);
  const visible=await until(async()=>{const list=await f.tokenRequests();return list.length===2&&list;});
  assert.equal(new Set(visible.map(item=>item.id)).size,2);
  assert.ok(visible.every(item=>item.token==='rrt_fixture_token'));
  const deliver=(id,token)=>agentOperation({type:'workspace_agent_token',request_id:id,base64:Buffer.from(JSON.stringify({token,expires_at:'2099-01-01T00:00:00Z',repository:'fixture/repo',permissions:{contents:'read'}})).toString('base64')},f.root);
  await deliver(visible[1].id,'second-read-token');
  await deliver(visible[0].id,'first-read-token');
  const resolved=await Promise.all([first,second]);
  assert.deepEqual(new Set(resolved.map(r=>r.token)),new Set(['first-read-token','second-read-token']));
  await f.emptyMailbox();
});

test('token cancellations return promptly and leave concurrent and subsequent exchanges intact',async t=>{
  const f=await fixture(t),exchange=createTokenExchange(f.dir),firstAbort=new AbortController(),secondAbort=new AbortController();
  t.after(()=>{firstAbort.abort();secondAbort.abort();});
  const first=exchange(firstAbort.signal),second=exchange(secondAbort.signal);
  const visible=await until(async()=>{const list=await f.tokenRequests();return list.length===2&&list;});
  const promptly=async pending=>{
    let timer;
    try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Token cancellation did not return promptly')),1000);})]);}
    finally{clearTimeout(timer);}
  };
  secondAbort.abort();assert.deepEqual(await promptly(second),{error:'github_read_token_cancelled'});
  assert.equal((await f.tokenRequests()).length,1,'cancelling one exchange must leave the sibling exchange intact');
  firstAbort.abort();assert.deepEqual(await promptly(first),{error:'github_read_token_cancelled'});
  const third=exchange(t.signal),[next]=await until(async()=>{const list=await f.tokenRequests();return list.length===1&&list;});
  const grant={token:'next-read-token'};
  await agentOperation({type:'workspace_agent_token',request_id:next.id,base64:Buffer.from(JSON.stringify(grant)).toString('base64')},f.root);
  assert.deepEqual(await third,grant);
  await f.emptyMailbox();
});

test('a timed-out token exchange only removes its own request file',async t=>{
  const f=await fixture(t),exchange=createTokenExchange(f.dir);t.mock.timers.enable({apis:['Date'],now:1000});
  const pending=exchange();
  const [first]=await until(async()=>{const list=await f.tokenRequests();return list.length===1&&list;});
  const otherId='b'.repeat(48),other={id:otherId};
  await fsPromises.writeFile(join(f.dir,'token-requests',`${otherId}.json`),JSON.stringify(other));
  t.mock.timers.tick(120000);assert.deepEqual(await pending,{error:'github_read_token_timeout'});
  assert.equal(first.id!==otherId,true);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir,'token-requests',`${otherId}.json`),'utf8')),other);
});
