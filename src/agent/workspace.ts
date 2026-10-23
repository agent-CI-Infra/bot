import { type Store, type Row } from '../storage/database.js';
import { type Manager } from '../projects/service.js';
import { GitHub } from '../github/client.js';
import { blobSha, clip, operationId, Redactor, safePath, stop } from './common.js';
import { randomId } from '../core/security.js';

export class Workspace {
  constructor(readonly store:Store,readonly manager:Manager,readonly task:Row,readonly redactor:Redactor,readonly guard:()=>Promise<void>,readonly log:(value:unknown)=>void){}
  async call(key:string,request:any){
    await this.guard();
    request=this.redactor.clean(request);
    const id=operationId(`${this.task.id}:${this.task.attempt}:${key}`),input={operation_id:id,generation:this.task.generation,request:{...request,workspace_id:this.task.workspace_id}};
    let row=this.store.get('SELECT * FROM task_tools WHERE id=?',id);
    if(row&&row.request!==JSON.stringify(input))stop('tool_operation_conflict');
    if(row?.state==='completed')return JSON.parse(row.result);
    if(!row)this.store.run("INSERT INTO task_tools VALUES(?,?,?,NULL,'pending')",id,this.task.id,JSON.stringify(input));
    let response;
    // The manager answers a command only when it ends; one without timeout_ms waits as long as it runs (0 = no client timeout).
    const wait=request.type!=='workspace_command'?90000:request.timeout_ms==null?0:Number(request.timeout_ms)+120000;
    try{response=await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,input,wait);}
    catch{return stop('execution_interrupted','waiting_environment');}
    await this.guard();
    const result=this.redactor.clean(response.ok?response.result:{error:response.error||'runner_operation_failed'});
    this.store.run("UPDATE task_tools SET state='completed',result=? WHERE id=?",JSON.stringify(result),id);
    // Model commands are logged by the agent loop together with the tool call; others (tests) are logged here.
    if(request.type==='workspace_command'&&!key.startsWith('model:'))this.log({type:'command',command:request.command,...result,output:clip(result.output)});
    return result;
  }
  // Hands a credential to the task agent. Unlike call(), the request is not recorded in task_tools, so the token is
  // never stored; a lost answer only means the agent asks again.
  async deliver(request:any){
    await this.guard();
    const response=await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,{operation_id:randomId(),generation:this.task.generation,
      request:{...request,workspace_id:this.task.workspace_id}},90000).catch(()=>null);
    return response?.ok?response.result:{error:response?.error||'runner_operation_failed'};
  }
  // Ends background processes this task kept so the next task starts on a clean project computer.
  async release(){
    if(!this.task.generation||!this.task.workspace_id)return;
    await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,{operation_id:randomId(),generation:this.task.generation,
      request:{type:'reap',workspace_id:this.task.workspace_id}}).catch(()=>{});
  }
  async write(key:string,path:string,data:Buffer,mode='100644',snapshot=false,hash?:string){
    safePath(path);if(this.redactor.contains(data))stop('credential_in_repository');
    for(let offset=0;offset<data.length||offset===0;offset+=30000){
      const result=await this.call(key+':'+offset,{type:'workspace_write',path,base64:data.subarray(offset,offset+30000).toString('base64'),offset,
        final:offset+30000>=data.length,mode,snapshot,...(hash?{sha:hash}:{})});
      if(result.error)stop('workspace_write_failed','waiting_environment');
    }
  }
  async prepare(github:GitHub,commitSha:string){
    const commit=await github.request('GET',github.path('/git/commits/'+commitSha));
    const tree=await github.request('GET',github.path('/git/trees/'+commit.tree.sha+'?recursive=1'));
    if(tree.truncated||!Array.isArray(tree.tree))stop('repository_tree_truncated','waiting_environment');
    const files=tree.tree.filter((f:any)=>f.type!=='tree');
    if(files.length>2000||files.some((f:any)=>f.type!=='blob'||!['100644','100755','120000'].includes(f.mode)||Number(f.size)>1024*1024))stop('repository_snapshot_limit','waiting_environment');
    const init=await this.call('prepare:init',{type:'workspace_init',author_email:github.authorEmail()});if(init.error)stop('workspace_init_failed','waiting_environment');
    let bytes=0,contextBytes=0;const materials:any[]=[],ruleFiles:Record<string,string>={};
    for(const file of files){
      safePath(file.path);
      const blob=await github.request('GET',github.path('/git/blobs/'+file.sha));
      if(blob.encoding!=='base64')stop('unsupported_blob_encoding');
      const data=Buffer.from(blob.content,'base64');bytes+=data.length;
      if ((file.path.startsWith('.bot/') || /^\.agents\/skills\/(?:[^/]+\/)+SKILL\.md$/.test(file.path)) && !data.includes(0)){if(file.mode==='120000')stop('unsafe_bot_rule','waiting_configuration');ruleFiles[file.path]=data.toString('utf8');}
      if(bytes>32*1024*1024||data.length>1024*1024||blobSha(data)!==file.sha)stop('repository_blob_limit_or_hash');
      await this.write('prepare:'+file.path,file.path,data,file.mode,true,file.sha);
      if(contextBytes<100000&&!data.includes(0)){
        const text=data.toString('utf8').slice(0,12000);contextBytes+=text.length;materials.push({path:file.path,content:text,truncated:text.length<data.length});
      }
    }
    const ready=await this.call('prepare:git',{type:'workspace_snapshot',tree_sha:commit.tree.sha});
    if(ready.error||ready.tree_sha!==commit.tree.sha)stop('workspace_snapshot_mismatch','waiting_environment');
    return {files:files.map((f:any)=>({path:f.path,sha:f.sha,mode:f.mode})),materials,rule_files:ruleFiles,tree_sha:commit.tree.sha,
      coverage:[`Snapshot: ${files.length} files, ${bytes} bytes`,`Initial model context: ${materials.length} files; other files available through tools`,'Git workspace contains a fixed snapshot, not full upstream history' ]};
  }
  async artifact(key:string){
    const result=await this.call(key,{type:'workspace_finalize'});
    if(result.error||!result.tree_sha||!Array.isArray(result.files))stop('candidate_unavailable','waiting_environment');
    return result;
  }
  async contents(manifest:any[]){
    const files:any[]=[];let total=0;
    for(const file of manifest){
      safePath(file.path);const chunks:Buffer[]=[];
      for(let offset=0;offset<file.size||offset===0;offset+=30000){
        const part=await this.call(`candidate:blob:${file.sha}:${offset}`,{type:'workspace_blob',sha:file.sha,offset});
        if(part.error)stop('candidate_blob_unavailable','waiting_environment');chunks.push(Buffer.from(part.base64,'base64'));
      }
      const bytes=Buffer.concat(chunks);total+=bytes.length;
      if(total>32*1024*1024||blobSha(bytes)!==file.sha||this.redactor.contains(bytes))stop('candidate_blob_invalid');
      files.push({path:file.path,mode:file.mode,sha:file.sha,base64:bytes.toString('base64')});
    }
    return files;
  }
}
