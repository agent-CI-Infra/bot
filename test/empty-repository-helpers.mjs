import {createServer} from 'node:http';
import {once} from 'node:events';
import {rmSync} from 'node:fs';
import {harness,setup,account,repository} from './helpers.mjs';
import {TaskEngine} from '../dist/agent/engine.js';
import {treeSha} from '../dist/agent/common.js';

export async function emptyRepositoryFixture(t,options={}){
  let branch='empty',engine;const comments=[],operations=[],commit='a'.repeat(40),tree=options.files?treeSha(options.files):'b'.repeat(40);
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{},path=new URL(req.url,'http://fixture').pathname;
    const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(await options.github?.(path,send,res))return;
    if(path==='/user')return send({id:999,login:'fixture-bot'});
    if(path==='/repositories/101')return send({id:101,owner:{id:10},full_name:'fixture/project-101',default_branch:'main'});
    if(path.endsWith('/issues/1'))return send({id:1,number:1,state:'open',title:'First issue',body:'Please review this project.'});
    if(path.endsWith('/git/ref/heads/main'))return branch==='ready'?send({object:{sha:commit}}):send({message:branch==='empty'?'Git Repository is empty.':'Reference conflict'},409);
    if(path.endsWith('/git/refs/heads/main'))return send({message:'Git Repository is empty.'},409);
    if(path.endsWith('/git/commits/'+commit))return send({sha:commit,tree:{sha:tree}});
    if(path.endsWith('/git/trees/'+tree))return send(options.truncated&&req.url.includes('recursive=1')?{sha:tree,tree:[],truncated:true}:{sha:tree,tree:options.files||[],truncated:false});
    if(path.includes('/git/blobs/'))return send(options.blob||{encoding:'base64',content:Buffer.from('unexpected content').toString('base64')});
    if(path.endsWith('/issues/1/comments')){
      if(req.method==='POST'){const value={id:comments.length+1,body:body.body,user:{id:999},html_url:'https://github.invalid/comment/1'};comments.push(value);return send(value,201);}
      return send(comments);
    }
    if(path.endsWith('/issues/1/labels'))return send((body.labels||[]).map(name=>({name})));
    return send({},404);
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const githubUrl='http://127.0.0.1:'+server.address().port;
  const manager={call:async(method,path,body)=>{
    if(path.endsWith('/execute')){
      operations.push(body.request.type);
      if(options.execute){const result=await options.execute(body.request);if(result)return result;}
      const result=body.request.type==='workspace_snapshot'?{tree_sha:body.request.tree_sha}:body.request.type==='workspace_agent_poll'?{state:'completed',result:{summary:'Reviewed the initial commit.',findings:[],requires_code_change:false,issue_requests_code:false,clarification_required:false,implementation_goal:'',request_quote:''}}:{};
      return {ok:true,result};
    }
    return {repository_id:'101',state:'ready',generation:1,desired:'ready',revision:1};
  }};
  const h=await harness(undefined,manager,store=>({engine:engine=new TaskEngine(store,manager,githubUrl)})),{admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const model=(await admin('/api/models','POST',{repository_id:'101',api_url:'https://model.invalid/v1',api_key:'fixture-key',model_name:'fixture-model'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{review_enabled:true,model_id:model.id});
  await h.hook(a.path,a.secret,'first-issue',{repository:{id:101},action:'opened',issue:{number:1,title:'First issue',body:'Please review this project.'}});
  const taskId=h.store.get('SELECT id FROM tasks').id;
  const result={...h,adminBase:h.admin,admin,password,engine,taskId,githubUrl,comments,operations,commit,
    setBranch(value){branch=value;},
    async run(){engine.tick();await Promise.all(engine.active.values());return h.store.get('SELECT * FROM tasks WHERE id=?',taskId);},
    due(){h.store.run('UPDATE tasks SET next_run_at=0 WHERE id=?',taskId);},
    async close(){await engine.close();await h.stop();await new Promise(resolve=>server.close(resolve));rmSync(h.directory,{recursive:true,force:true});}};
  if(t)t.after(()=>result.close());return result;
}
