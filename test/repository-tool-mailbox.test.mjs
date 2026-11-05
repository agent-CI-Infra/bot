import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createRepositoryTool} from '../runner/repository-tool.mjs';
import {agentOperation} from '../runner/agent.mjs';

async function fixture(t){
  await mkdir('.tmp',{recursive:true});const root=await mkdtemp(resolve('.tmp/repository-mailbox-')),dir=join(root,'agent');
  await mkdir(dir);t.after(()=>rm(root,{recursive:true,force:true}));
  const request=()=>readFile(join(dir,'repository-request.json'),'utf8').then(JSON.parse).catch(()=>null);
  const deliver=async(id,value,final=true,offset=0)=>agentOperation({type:'workspace_agent_repository_tool',request_id:id,base64:Buffer.from(JSON.stringify(value)).toString('base64'),offset,final},root);
  return {root,dir,request,deliver,tool:createRepositoryTool(dir)};
}
async function until(read){
  for(let tries=0;tries<200;tries++){
    const value=await read();if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Timed out waiting for repository mailbox');
}

test('concurrent repository calls each own the mailbox until their reply is consumed',async t=>{
  const f=await fixture(t),calls=[['github_read',{path:'/issues/42'}],['github_search',{query:'dependency'}],['read_job_log',{job_id:1}]];
  const pending=calls.map(([name,args])=>f.tool(name,args)),ids=[];
  for(const [index,[name,args]] of calls.entries()){
    const current=await until(async()=>{const value=await f.request();return value&&!ids.includes(value.id)&&value;});
    ids.push(current.id);assert.equal(current.name,name);assert.deepEqual(current.arguments,args);
    // A queued caller cannot replace this request while the first one waits.
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await f.request()).id,current.id);
    await f.deliver(current.id,{result:index});
    assert.deepEqual(await pending[index],{result:index});
  }
  assert.deepEqual(await Promise.all(pending),[{result:0},{result:1},{result:2}]);
  assert.deepEqual(await readdir(f.dir),[]);
});

test('a 120-second timeout releases the queue, removes partial data and rejects late replies',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['Date'],now:1000});
  const first=f.tool('github_read',{path:'/issues'}),second=f.tool('github_search',{query:'dependency'});
  const expired=await until(f.request);
  await f.deliver(expired.id,{partial:true},false);
  // The deadline is fixed when the request becomes visible, not extended by polling.
  t.mock.timers.tick(120000);
  assert.deepEqual(await first,{error:'repository_tool_timeout'});
  const current=await until(async()=>{const value=await f.request();return value&&value.id!==expired.id&&value;});
  await assert.rejects(f.deliver(expired.id,{late:true}),/agent_request_changed/);
  assert.equal((await f.request()).id,current.id);
  await f.deliver(current.id,{items:[]});assert.deepEqual(await second,{items:[]});
  await assert.rejects(f.deliver(current.id,{late:true}),/agent_request_changed/);
  assert.deepEqual(await readdir(f.dir),[]);
});

test('cancellation removes the active request and a cancelled queued call never replaces it',async t=>{
  const f=await fixture(t),active=new AbortController(),queued=new AbortController();
  const first=f.tool('github_read',{path:'/issues'},active.signal),second=f.tool('github_search',{query:'dependency'},queued.signal);
  const current=await until(f.request);queued.abort();active.abort();
  assert.deepEqual(await first,{error:'repository_tool_cancelled'});assert.deepEqual(await second,{error:'repository_tool_cancelled'});
  await assert.rejects(f.deliver(current.id,{late:true}),/agent_request_changed/);
  assert.deepEqual(await readdir(f.dir),[]);
  // An abandoned caller does not poison subsequent requests.
  const third=f.tool('github_read',{path:'/readme'}),next=await until(f.request);
  await f.deliver(next.id,{content:'readme'});assert.deepEqual(await third,{content:'readme'});
});

test('abandoning the mailbox during chunk delivery is reported as an expired request',async t=>{
  for(const operation of ['open','rename'])await t.test(operation,async t=>{
    const f=await fixture(t),abort=new AbortController(),pending=f.tool('github_read',{path:'/issues'},abort.signal);
    const current=await until(f.request),original=fsPromises[operation];
    const hook=t.mock.method(fsPromises,operation,async(path,...args)=>{
      if(path===join(f.dir,`repository-reply-${current.id}.tmp`)){
        // Remove the request and partial reply before the delivery's original I/O resumes.
        abort.abort();await pending;
      }
      return original(path,...args);
    });
    syncBuiltinESMExports();
    try{await assert.rejects(f.deliver(current.id,{late:true}),/agent_request_changed/);}
    finally{hook.mock.restore();syncBuiltinESMExports();}
    assert.deepEqual(await pending,{error:'repository_tool_cancelled'});
    assert.deepEqual(await readdir(f.dir),[]);
  });
});
