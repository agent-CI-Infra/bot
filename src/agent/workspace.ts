import { type Store, type Row } from '../storage/database.js';
import { type Manager } from '../projects/service.js';
import { GitHub, repositoryTree } from '../github/client.js';
import { blobSha, clip, describeEntries, operationId, Redactor, safePath, stop, treeSha } from './common.js';
import { randomId } from '../core/security.js';
import { type Mirror } from './git-cache.js';

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
    if(request.type==='workspace_command'&&!key.startsWith('model:'))this.log({type:'phase',phase:'validate',operation_id:id,command:request.command,detail:`正在运行测试：${request.command}`});
    let response;
    // The manager answers a command only when it ends; one without timeout_ms waits as long as it runs (0 = no client timeout).
    const wait=['workspace_snapshot','workspace_finalize','workspace_blob'].includes(request.type)?0:request.type!=='workspace_command'?90000:request.timeout_ms==null?0:Number(request.timeout_ms)+120000;
    try{response=await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,input,wait);}
    catch{return stop('execution_interrupted','waiting_environment',`Runner request interrupted: ${request.type}${request.path?' '+request.path:''}`);}
    await this.guard();
    const result=this.redactor.clean(response.ok?response.result:{error:response.error||'runner_operation_failed',...(response.detail?{detail:response.detail}:{})});
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
  // Ends the processes this task left, kept background work included. Other tasks on the computer keep theirs; the last
  // task to finish (idle) clears every leftover process, so the next task starts on a clean project computer.
  async release(idle=true){
    if(!this.task.generation||!this.task.workspace_id)return;
    await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,{operation_id:randomId(),generation:this.task.generation,
      request:{type:'reap',workspace_id:this.task.workspace_id,...(idle?{idle:true}:{})}}).catch(()=>{});
  }
  async write(key:string,path:string,data:Buffer,mode='100644',snapshot=false,hash?:string){
    safePath(path);if(this.redactor.contains(data))stop('credential_in_repository',undefined,`Credential found in repository file: ${path}`);
    for(let offset=0;offset<data.length||offset===0;offset+=30000){
      const result=await this.call(key+':'+offset,{type:'workspace_write',path,base64:data.subarray(offset,offset+30000).toString('base64'),offset,
        final:offset+30000>=data.length,mode,snapshot,...(hash?{sha:hash}:{})});
      if(result.error)stop('workspace_write_failed','waiting_environment',`Could not write ${path} at offset ${offset}: ${result.detail||result.error}`);
    }
  }
  // Copies the files of one fixed commit into this task's own workspace. With a mirror that holds the commit, the listing
  // and file contents come from it; otherwise (or for a blob the mirror lacks) from the GitHub API, as before.
  async prepare(github:GitHub,commitSha:string,mirror?:Mirror){
    let bytes=0,contextBytes=0,fallback=false;const accepted:any[]=[],skipped:any[]=[],notes:string[]=[],materials:any[]=[];
    this.log({type:'phase',phase:'prepare',sha:commitSha,detail:`正在准备工作区：拉取固定提交 ${commitSha} 并写入虚拟电脑…`});
    const skip=(file:any,reason:string)=>{
      skipped.push(file);notes.push(`Skipped ${file.path}: ${reason}`);
      this.log({type:'snapshot_skipped',sha:commitSha,path:file.path,reason,detail:`已跳过路径 ${file.path}：${reason}`});
    };
    let cached=false;
    try{
      let commit:{tree:{sha:string}},tree:{tree:any[],directory_fallback:boolean};
      const listing=mirror?.has(commitSha)?await mirror.listing(commitSha):null;cached=!!listing;
      if(mirror&&!cached)notes.push(mirror.has(commitSha)?`Git 缓存读不出（${mirror.unreadable}），文件改经 GitHub API 读取。`
        :`Git 缓存不可用（${mirror.error||'镜像里没有这个提交'}），文件改经 GitHub API 读取。`);
      if(listing){commit={tree:{sha:listing.tree_sha}};tree={tree:listing.tree,directory_fallback:false};}
      else{commit=await github.request('GET',github.path('/git/commits/'+commitSha));tree=await repositoryTree(github,commit.tree.sha);}
      const files=tree.tree.filter((f:any)=>f.type!=='tree');fallback=tree.directory_fallback;
      // Preserve rule symlink preflight before any workspace writes, including after a truncated-tree fallback.
      const unsafe=files.find((f:any)=>f.mode==='120000'&&(f.path.startsWith('.bot/')||/^\.agents\/skills\/(?:[^/]+\/)+SKILL\.md$/.test(f.path)));
      if(unsafe)stop('unsafe_bot_rule','waiting_configuration',`Repository rule is a symbolic link: ${unsafe.path}`);
      const init=await this.call('prepare:init',{type:'workspace_init',author_email:github.authorEmail()});
      if(init.error)stop('workspace_init_failed','waiting_environment',`Could not initialize workspace: ${init.detail||init.error}`);
      for(const file of files){
        safePath(file.path);
        if(file.type!=='blob'||!['100644','100755','120000'].includes(file.mode)){
          skip(file,`类型 ${file.type}，mode ${file.mode}；不下载此条目（子模块不克隆）。`);continue;
        }
        let data=cached?await mirror!.blob(file.sha):null;
        if(!data){
          const blob=await github.snapshotBlob(file.sha);
          if(blob.skipped){
            skip(file,`GitHub blob API HTTP ${blob.status}，大小 ${blob.size??file.size??'unknown'} bytes；${clip(blob.message,2000)}`);continue;
          }
          if(blob.encoding!=='base64')stop('unsupported_blob_encoding',undefined,`Unsupported blob encoding for ${file.path}: ${blob.encoding}`);
          data=Buffer.from(blob.content,'base64');
        }
        const actual=blobSha(data);
        if(actual!==file.sha)stop('repository_blob_limit_or_hash',undefined,`Blob hash mismatch for ${file.path}: expected ${file.sha}, actual ${actual}`);
        await this.write('prepare:'+file.path,file.path,data,file.mode,true,file.sha);
        accepted.push({path:file.path,sha:file.sha,mode:file.mode});bytes+=data.length;
        if(accepted.length%100===0)this.log({type:'snapshot_progress',sha:commitSha,files:accepted.length,bytes,path:file.path,
          detail:`正在写入仓库快照：已写入 ${accepted.length} 个文件，${bytes} 字节；刚写完 ${file.path}`});
        if(contextBytes<100000&&!data.includes(0)){
          const text=data.toString('utf8').slice(0,12000);contextBytes+=text.length;materials.push({path:file.path,content:text,truncated:text.length<data.length});
        }
      }
      // Skipped entries remain upstream. Validate the local tree against precisely the accepted manifest.
      const expected=skipped.length?treeSha(accepted):commit.tree.sha;
      this.log({type:'snapshot_git',sha:commitSha,tree_sha:expected,detail:`正在构建本地 Git 树：${expected}`});
      const ready=await this.call('prepare:git',{type:'workspace_snapshot',tree_sha:expected});
      if(ready.error||ready.tree_sha!==expected)stop('workspace_snapshot_mismatch','waiting_environment',`Snapshot tree mismatch: expected ${expected}, actual ${ready.tree_sha||'unavailable'}; ${ready.detail||ready.error||'runner returned a different tree'}`);
      return {files:accepted,skipped_files:skipped.map(({path,sha,mode}:any)=>({path,sha,mode})),materials,tree_sha:expected,source_tree_sha:commit.tree.sha,
        coverage:[`Snapshot: ${accepted.length} files, ${bytes} bytes; skipped ${skipped.length} entries`,`Initial model context: ${materials.length} files; other accepted files available through tools`,'Git workspace contains a fixed snapshot, not full upstream history']};
    }finally{
      // source: where the listing came from; cache: whether the mirror already held the commit (hit) or fetched it.
      this.log({type:'snapshot',sha:commitSha,files:accepted.length,bytes,skipped:skipped.length,directory_fallback:fallback,source:cached?'git_cache':'github_api',
        ...(mirror?{cache:cached?mirror.state:'unavailable'}:{}),detail:describeEntries(notes)});
    }
  }
  async artifact(key:string){
    const result=await this.call(key,{type:'workspace_finalize'});
    if(result.error||!result.tree_sha||!Array.isArray(result.files))stop('candidate_unavailable','waiting_environment',`Could not finalize workspace: ${result.detail||result.error||'missing manifest'}`);
    return result;
  }
  async contents(manifest:any[],upstream:any[]=[]){
    const files:any[]=[],original=new Map(upstream.map(file=>[file.path,file]));
    for(const file of manifest){
      safePath(file.path);
      // Existing upstream objects need no round trip through a base64 candidate buffer.
      if(original.get(file.path)?.sha===file.sha){files.push({path:file.path,mode:file.mode,sha:file.sha});continue;}
      const chunks:Buffer[]=[];
      for(let offset=0;offset<file.size||offset===0;offset+=30000){
        const part=await this.call(`candidate:blob:${file.sha}:${offset}`,{type:'workspace_blob',sha:file.sha,offset});
        if(part.error)stop('candidate_blob_unavailable','waiting_environment',`Could not read candidate ${file.path} at offset ${offset}: ${part.detail||part.error}`);chunks.push(Buffer.from(part.base64,'base64'));
      }
      const bytes=Buffer.concat(chunks);
      if(blobSha(bytes)!==file.sha||this.redactor.contains(bytes))stop('candidate_blob_invalid',undefined,`Candidate blob hash or credential check failed: ${file.path}`);
      files.push({path:file.path,mode:file.mode,sha:file.sha,base64:bytes.toString('base64')});
    }
    return files;
  }
}
