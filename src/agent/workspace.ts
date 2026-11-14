import { commandResult, ResultSession, resultOwner } from './tool-results.js';
import { type Store, type Row } from '../storage/database.js';
import { type Manager } from '../projects/service.js';
import { GitHub, repositoryTree } from '../github/client.js';
import { blobSha, executionBaseline, clip, describeEntries, operationId, Redactor, safePath, stop, treeSha, TaskError } from './common.js';
import { HttpError, randomId } from '../core/security.js';
import { eventHistory, historyOrder } from '../roles/role-run.js';
import { type Mirror } from './git-cache.js';
import { open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { payloadHeader, TrajectoryError } from '../storage/trajectories.js';
import { operationRequestText, operationResult } from '../storage/payloads.js';
import { useWorkspace } from '../projects/workspace-cleanup.js';

// Operations each task is waiting on in this process, oldest first. The console shows the newest as the command the task
// is running. task_tools cannot answer that: it has no task index (2.8M rows in production, so finding a task's pending
// row scanned the table for minutes with a cold cache), and a row an interrupted attempt left 'pending' is not running.
const collecting=new WeakMap<Manager,Map<string,Promise<any>>>();
const inFlight=new Map<string,Map<string,any>>();
/** The newest operation the task is executing right now in this process, or null. */
export function currentOperation(taskId:string):{id:string;request:any}|null{
  const last=[...inFlight.get(taskId)?.entries()??[]].at(-1);
  return last?{id:last[0],request:last[1]}:null;
}

/**
 * The project computer's work volume ran full (#671): the runner refused a call that would write, or a call or command
 * failed for want of space (runner/runner.mjs, runner/disk.mjs). The task waits for space as disk_full instead of handing
 * the failure to the model or reading it as failing tests. The answer is recorded like any result, so a repeated call
 * would get it again: the task starts a new attempt with new operation ids (engine.ts).
 */
export class VolumeFull extends TaskError {}
const MiB=2**20;
function volumeFull(request:any,result:any):void{
  const what=request.type==='workspace_command'||request.type==='command'?String(request.command).slice(0,200):`${request.type}${request.path?' '+request.path:''}`;
  if(result?.error==='disk_full')throw new VolumeFull('disk_full','waiting_environment',`项目电脑的工作卷空间不足，调用未完成：${result.detail||what}`);
  const mark=result?.disk_full;
  if(mark)throw new VolumeFull('disk_full','waiting_environment',`命令失败时项目电脑的工作卷空间不足（运行中最少剩 ${Math.floor(Number(mark.lowest_free_bytes)/MiB)} MiB，结束时剩 ${Math.floor(Number(mark.free_bytes)/MiB)} MiB，共 ${Math.floor(Number(mark.total_bytes)/MiB)} MiB）：${what}`);
}

export class Workspace {
  constructor(readonly store:Store,readonly manager:Manager,readonly task:Row,readonly redactor:Redactor,readonly guard:()=>Promise<void>,readonly log:(value:unknown)=>void,
    readonly operations?:'service_role_operations'){}
  async call(key:string,request:any){
    await this.guard();
    useWorkspace(this.store,this.task,request.type);
    request=this.redactor.clean(request);
    const id=operationId(`${this.task.id}:${this.task.attempt}:${key}`),input={operation_id:id,generation:this.task.generation,request:{...request,workspace_id:this.task.workspace_id}};
    const conversation = !!this.task.conversation_id;
    const table=conversation?(this.operations??'role_conversation_operations'):'task_tools',owner=conversation?'turn_id':'task_id';
    const encoded=JSON.stringify(input),digest=createHash('sha256').update(encoded).digest('hex');
    const row=this.store.get(`SELECT * FROM ${table} WHERE id=?`,id);
    // A row recorded since #436 keeps the request's hash (its body is in the trajectory file); an older row keeps the
    // whole request.
    if(row&&(row.request_sha256?row.request_sha256!==digest:this.readable(()=>operationRequestText(this.store,table,row))!==encoded)){
      // The recorded request names the fields that differ; its header if its file cannot be read.
      let previous:any;try{previous=JSON.parse(operationRequestText(this.store,table,row));}catch{previous=JSON.parse(row.request);}
      const changed=['generation','workspace_id','path','command','offset'].filter(field=>
        JSON.stringify(field==='generation'?previous.generation:previous.request?.[field])!==JSON.stringify(field==='generation'?input.generation:input.request[field]));
      // Report field names only: request payloads can contain file contents, tokens and model credentials.
      stop('tool_operation_conflict',undefined,this.redactor.text(`操作 key=${key}（type=${input.request.type}）与已存请求冲突：${changed.length?changed.join('、')+' 不同':'请求内容不同'}。`));
    }
    if(row?.state==='completed'){const result=this.readable(()=>operationResult(this.store,table,row));volumeFull(input.request,result);return result;}
    // The request and result go to the run's trajectory file; the row keeps their refs. Without a run (or conversation
    // turn) to file them under, the row keeps them as before.
    const trajectories=this.store.trajectories,scope=trajectories.scopeOf(this.task);
    if(!row){
      // Conversation rows were sealed before: they keep no fields of the request at all, only its ref and hash.
      if(scope)this.store.run(`INSERT INTO ${table}(id,${owner},request,result,state,request_ref,request_sha256) VALUES(?,?,?,NULL,'pending',?,?)`,id,this.task.id,
        conversation?'{}':JSON.stringify(payloadHeader(input)),trajectories.append(scope,'tool_call',id,input),digest);
      else this.store.run(`INSERT INTO ${table}(id,${owner},request,result,state) VALUES(?,?,?,NULL,'pending')`,id,this.task.id,conversation?this.store.secrets.seal(input,'conversation-operation:'+id+':request'):encoded);
    }
    if(request.type==='workspace_command'&&!key.startsWith('model:'))this.log({type:'phase',phase:'validate',operation_id:id,command:request.command,detail:`正在运行测试：${request.command}`});
    let response;
    // The manager answers a command only when it ends; one without timeout_ms waits as long as it runs (0 = no client timeout).
    const wait=['workspace_acceptance','workspace_restore','workspace_snapshot','workspace_finalize','workspace_blob','workspace_checkout','git_import'].includes(request.type)?0:request.type!=='workspace_command'?90000:request.timeout_ms==null?0:Number(request.timeout_ms)+120000;
    const operations=inFlight.get(this.task.id)??new Map<string,any>();inFlight.set(this.task.id,operations);
    operations.delete(id);operations.set(id,input.request);
    try{response=await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,input,wait);}
    catch(error){
      const code=error instanceof HttpError?error.code:null,what=`${request.type}${request.path?' '+request.path:''}`;
      // The manager's data disk is full: wait for space (#671). A repeated call whose stored result the manager removed
      // after its retention window cannot be answered: a new attempt runs with new operation ids.
      if(code==='disk_full')return stop('disk_full','waiting_environment',`manager 的数据盘空间不足，调用未完成：${what}`);
      if(code==='operation_result_expired')return stop('operation_result_expired','waiting_environment',`manager 中这次调用的结果已过保留期被删除：${what}`);
      return stop('execution_interrupted','waiting_environment',`Runner request interrupted: ${what}`);
    }
    finally{operations.delete(id);if(!operations.size&&inFlight.get(this.task.id)===operations)inFlight.delete(this.task.id);}
    let result=this.redactor.clean(response.ok?response.result:{error:response.error||'runner_operation_failed',...(response.detail?{detail:response.detail}:{})});
    if(request.type==='workspace_command'&&scope)result=await commandResult(result,id,async offset=>this.manager.call('GET',`/v1/projects/${this.task.repository_id}/output/${id}?offset=${offset}`),
      new ResultSession(this.store,scope,()=>resultOwner('task',this.task.id,this.task.authority_fence),this.guard));
    // A repeated call replays this result: it is on disk before the row points to it.
    let resultRef:string|null=null;
    if(scope){resultRef=trajectories.append(scope,'tool_result',id,result);await trajectories.sync(resultRef);}
    await this.guard();
    if(resultRef)this.store.run(`UPDATE ${table} SET state='completed',result=?,result_ref=? WHERE id=?`,conversation?null:JSON.stringify(payloadHeader(result)),resultRef,id);
    else this.store.run(`UPDATE ${table} SET state='completed',result=? WHERE id=?`,conversation?this.store.secrets.seal(result,'conversation-operation:'+id+':result'):JSON.stringify(result),id);
    // Model commands are logged by the agent loop together with the tool call; others (tests) are logged here.
    if(request.type==='workspace_command'&&!key.startsWith('model:'))this.log({type:'command',command:request.command,...result,output:clip(result.output)});
    volumeFull(input.request,result);
    return result;
  }
  // A recorded call whose file fails verification stops the task: running it again could repeat its effect. One whose
  // file was removed after its retention window (#671) cannot be answered either: a new attempt runs with new keys.
  private readable<T>(read:()=>T):T{
    try{return read();}
    catch(error){
      if(error instanceof TrajectoryError&&error.code==='trajectory_expired')stop('operation_result_expired','waiting_environment',`控制面中这次调用的记录已过保留期被删除：${error.detail}`);
      if(error instanceof TrajectoryError)stop('trajectory_unreadable',undefined,`${error.code}: ${error.detail}`);throw error;
    }
  }
  // Hands a credential to the task agent. Unlike call(), the request is not recorded in task_tools, so the token is
  // never stored; a lost answer only means the agent asks again.
  async deliver(request:any){
    await this.guard();
    useWorkspace(this.store,this.task,request.type);
    const response=await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,{operation_id:randomId(),generation:this.task.generation,
      request:{...request,workspace_id:this.task.workspace_id}},90000).catch(()=>null);
    // Nothing records this answer, so the same call can simply be made again once there is space.
    if(response?.error==='disk_full')stop('disk_full','waiting_environment',`项目电脑的工作卷空间不足，调用未完成：${response.detail||request.type}`);
    return response?.ok?response.result:{error:response?.error||'runner_operation_failed',...(response?.detail?{detail:response.detail}:{})};
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
  // The repository at one fixed commit as a git worktree on the project computer, with the repository's history. The
  // computer's git store receives what it lacks of the mirror as a pack: the whole history the first time, then only new
  // commits. `also` are further commits the task needs there, such as a pull request's base. Returns null when this way
  // is not available (the caller then copies files as before); a reason to stop the task still stops it.
  async checkout(github:GitHub,commitSha:string,mirror:Mirror,also:string[]=[]){
    const listing=mirror.has(commitSha)?await mirror.listing(commitSha):null;if(!listing)return null;
    this.log({type:'phase',phase:'prepare',sha:commitSha,detail:`正在准备工作区：在虚拟电脑上检出固定提交 ${commitSha}…`});
    const unsafe=listing.tree.find(f=>f.mode==='120000'&&(f.path.startsWith('.bot/')||/^\.agents\/skills\/(?:[^/]+\/)+SKILL\.md$/.test(f.path)));
    if(unsafe)stop('unsafe_bot_rule','waiting_configuration',`Repository rule is a symbolic link: ${unsafe.path}`);
    // The task's own credentials must not be in files the agent reads; the mirror is searched instead of copying the files.
    const leaked=await mirror.secrets(commitSha,this.redactor.values);
    if(leaked.length)stop('credential_in_repository',undefined,`Credential found in repository file: ${leaked[0]}`);
    const have=await this.deliver({type:'git_have'});if(have.error||!Array.isArray(have.commits))return null;
    const missing=[...new Set([commitSha,...also])].filter(sha=>mirror.has(sha)&&!have.commits.includes(sha));
    let packed=0;
    if(missing.length){
      const pack=await mirror.pack(missing,have.commits),id=randomId(),file=await open(pack.file,'r');
      try{
        // Chunks go straight to the computer: a first pack holds the whole repository and is not kept with the task.
        const chunk=Buffer.alloc(45000);
        for(let offset=0;offset<pack.size;offset+=45000){
          const {bytesRead}=await file.read(chunk,0,chunk.length,offset);
          const sent=await this.deliver({type:'git_pack',pack_id:id,base64:chunk.subarray(0,bytesRead).toString('base64'),offset});
          if(sent.error)return null;
          if(offset%(45000*200)===0)this.log({type:'snapshot_progress',sha:commitSha,bytes:offset+bytesRead,detail:`正在把仓库历史传到虚拟电脑：${offset+bytesRead}／${pack.size} 字节`});
        }
      }finally{await file.close();await rm(pack.file,{force:true});}
      const imported=await this.call('checkout:import:'+id,{type:'git_import',pack_id:id,commits:missing});if(imported.error)return null;
      packed=pack.size;
    }
    const ready=await this.call('checkout:worktree:'+this.task.workspace_id,{type:'workspace_checkout',sha:commitSha,tree_sha:listing.tree_sha,author_email:github.authorEmail()});
    if(ready.error||ready.tree_sha!==listing.tree_sha)return null;
    const files=listing.tree.filter(f=>f.type==='blob'),skipped=listing.tree.filter(f=>f.type!=='blob');
    this.log({type:'snapshot',sha:commitSha,files:files.length,bytes:files.reduce((sum,f)=>sum+(f.size||0),0),skipped:skipped.length,source:'git_worktree',cache:mirror.state,pack_bytes:packed,
      detail:`已检出 ${files.length} 个文件（git worktree，含仓库历史）${packed?`，本次向虚拟电脑传送 ${packed} 字节的 git 对象`:'，虚拟电脑已有所需提交'}${skipped.length?`；${skipped.length} 个子模块条目未检出`:''}`});
    return {files:files.map(({path,sha,mode})=>({path,sha,mode})),skipped_files:skipped.map(({path,sha,mode})=>({path,sha,mode})),materials:[],tree_sha:listing.tree_sha,
      source_tree_sha:listing.tree_sha,history:true,coverage:[`Checkout: ${files.length} files at ${commitSha} in a git worktree with the repository's history${skipped.length?`; ${skipped.length} submodule entries not checked out`:''}`]};
  }
  // Files the agent reads on demand, next to the checkout under ../context/ (the Issue or PR, its discussion, the
  // project's skills). Written straight to the computer, after redaction, without keeping them with the task.
  async context(files:Record<string,string>){
    this.task.trace_context={...this.task.trace_context,...this.redactor.clean(files)};
    for(const [path,text] of Object.entries(files)){
      safePath(path);const data=Buffer.from(this.redactor.text(text));
      for(let offset=0;offset<data.length||offset===0;offset+=45000){
        const result=await this.deliver({type:'workspace_context',path,base64:data.subarray(offset,offset+45000).toString('base64'),offset});
        if(result.error)stop('workspace_write_failed','waiting_environment',`Could not write task context ${path} at offset ${offset}: ${result.detail||result.error}`);
      }
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
    let entries=collecting.get(this.manager);if(!entries)collecting.set(this.manager,entries=new Map());
    const id=String(this.task.repository_id)+':'+this.task.workspace_id;
    const pending=entries.get(id);if(pending)return pending;
    const work=this.collectArtifact(key);entries.set(id,work);
    try{return await work;}finally{if(entries.get(id)===work)entries.delete(id);}
  }
  private async collectArtifact(key:string){
    const result=await this.call(key,{type:'workspace_finalize'});
    if(result.error||!result.tree_sha||!Array.isArray(result.files))stop('candidate_unavailable','waiting_environment',`Could not finalize workspace: ${result.detail||result.error||'missing manifest'}`);
    // Finalizing unchanged files can mint a different commit timestamp. Observers and Publisher must keep the exact
    // collected writer commit while its tree and execution baseline are unchanged.
    const pinned=this.store.get(`SELECT h.data,r.run_context FROM role_run_events e JOIN task_runs r ON r.id=e.run_id
      JOIN task_history h ON ${eventHistory}
      WHERE e.task_id=? AND e.type='ended' AND e.category='completed' AND r.role='dev'
        AND r.revision=(SELECT revision FROM task_records WHERE task_id=e.task_id)
        AND EXISTS(SELECT 1 FROM task_stage_plans p WHERE p.task_id=e.task_id AND p.contract_revision=r.revision)
      ORDER BY ${historyOrder} DESC LIMIT 1`,this.task.id);
    if(pinned){const output=JSON.parse(pinned.data).data,candidate=output.candidate_ref?.kind==='code'?output.candidate_ref:output.source_snapshot,ctx=JSON.parse(pinned.run_context??'{}'),base=executionBaseline(this.task);
      const source=base&&/^[a-f0-9]{40}$/.test(base)?'commit:'+base:'contract:revision:'+ctx.contract_revision;
      if(candidate?.commit_sha&&candidate.tree_hash===result.tree_sha&&ctx.source_ref===source)return {...result,local_sha:candidate.commit_sha};}
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
