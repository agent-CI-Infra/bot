import { commandResult, ResultSession, projectResultOwner } from './tool-results.js';
import { type Store, type Row } from '../storage/database.js';
import { type Manager } from '../projects/service.js';
import { GitHub, repositoryTree } from '../github/client.js';
import { blobSha, executionBaseline, clip, describeEntries, operationId, Redactor, safePath, stop, treeSha, TaskError, workspaceToolPath } from './common.js';
import { HttpError, randomId } from '../core/security.js';
import { eventHistory, historyOrder } from '../roles/role-run.js';
import { traceEvent } from '../tasks/trace.js';
import { type Mirror } from './git-cache.js';
import { open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { payloadHeader, TrajectoryError } from '../storage/trajectories.js';
import { operationRequestText, operationResult } from '../storage/payloads.js';
import { useWorkspace, workspaceRemoving } from '../projects/workspace-cleanup.js';
import { claimWorktree, decidePlan, movePlan, planWorktree, refuseWorktree, registerWorktree, releaseBinding, releaseWorktrees, reusableWorktrees, taskPlan, taskWorktree, worktreeRestored, type WorktreeMode } from '../projects/worktrees.js';
import { sanitizeBrowserTrajectory } from '../../runner/browser-policy.mjs';
import { MAX_ARTIFACT_COMPRESSED_BYTES } from '../../runner/artifact-zip.mjs';

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
// Who made a workspace choice, as the console names it.
const who=(by:string)=>by==='system'?'系统':by==='agent'?'执行 agent ':`主控 ${by} `;
const MiB=2**20;
function volumeFull(request:any,result:any):void{
  const what=request.type==='workspace_command'||request.type==='command'?String(request.command).slice(0,200):`${request.type}${request.path?' '+request.path:''}`;
  if(result?.error==='disk_full')throw new VolumeFull('disk_full','waiting_environment',`项目电脑的工作卷空间不足，调用未完成：${result.detail||what}`);
  const mark=result?.disk_full;
  if(mark)throw new VolumeFull('disk_full','waiting_environment',`命令失败时项目电脑的工作卷空间不足（运行中最少剩 ${Math.floor(Number(mark.lowest_free_bytes)/MiB)} MiB，结束时剩 ${Math.floor(Number(mark.free_bytes)/MiB)} MiB，共 ${Math.floor(Number(mark.total_bytes)/MiB)} MiB）：${what}`);
}

// What works before the task has a worktree (#769): the task context, its agent's mailbox and session, the project notes, the
// computer's git store, and making, taking or inspecting worktrees. Everything else runs in the checkout.
const aside=(request:any)=>/^(workspace_agent_|workspace_harness_|git_)/.test(request.type)
  ||['workspace_context','workspace_artifact_stage','workspace_init','workspace_checkout','workspace_worktree_create','workspace_worktree_bind','workspace_worktree_inspect'].includes(request.type)
  ||request.type==='workspace_artifact_extract'&&typeof request.path==='string'&&(request.path.startsWith('../')||request.path.startsWith('/tmp/')||request.path.startsWith('/workspace/'))
  ||['workspace_read','workspace_write'].includes(request.type)&&!request.sha&&!request.snapshot&&typeof request.path==='string'&&(request.path.startsWith('../')||request.path.startsWith('/tmp/')||request.path.startsWith('/workspace/'));
// One binding or choice at a time per task workspace in this process, whichever Workspace object asks: a read that binds
// the system's choice and the agent's own choice in the same turn must not both take a worktree.
const queues=new Map<string,Promise<unknown>>();
function serialized<T>(key:string,work:()=>Promise<T>):Promise<T>{
  const next=(queues.get(key)??Promise.resolve()).then(work),tail=next.then(()=>{},()=>{});queues.set(key,tail);
  void tail.then(()=>{if(queues.get(key)===tail)queues.delete(key);});
  return next;
}
export class Workspace {
  // The task workspace this object saw holding its worktree, so later calls do not ask again.
  private settled?:string;
  constructor(readonly store:Store,readonly manager:Manager,readonly task:Row,readonly redactor:Redactor,readonly guard:()=>Promise<void>,readonly log:(value:unknown)=>void,
    readonly operations?:'service_role_operations'){}
  async call(key:string,request:any){
    await this.guard();
    // A task gets its worktree when it first needs one (#769): the one its controller or agent chose, or the system's.
    if(!aside(request)){const ready=await this.ensure();if(ready.error)return ready;}
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
      const recordedInput=['workspace_agent_config','workspace_harness_config','workspace_agent_token'].includes(input.request?.type)?{...input,request:{...input.request,base64:'[redacted]'}}:input.request?.type==='workspace_browser'?sanitizeBrowserTrajectory(input):input;
      if(scope)this.store.run(`INSERT INTO ${table}(id,${owner},request,result,state,request_ref,request_sha256) VALUES(?,?,?,NULL,'pending',?,?)`,id,this.task.id,
        conversation?'{}':JSON.stringify(payloadHeader(recordedInput)),trajectories.append(scope,'tool_call',id,recordedInput),digest);
      else this.store.run(`INSERT INTO ${table}(id,${owner},request,result,state,request_sha256) VALUES(?,?,?,NULL,'pending',?)`,id,this.task.id,conversation?this.store.secrets.seal(recordedInput,'conversation-operation:'+id+':request'):JSON.stringify(recordedInput),digest);
    }
    if(request.type==='workspace_command'&&!key.startsWith('model:'))this.log({type:'phase',phase:'validate',operation_id:id,command:request.command,detail:`正在运行测试：${request.command}`});
    let response;
    // The manager answers a command only when it ends; one without timeout_ms waits as long as it runs (0 = no client timeout).
    const wait=['workspace_restore','workspace_snapshot','workspace_finalize','workspace_blob','workspace_checkout','workspace_advance','workspace_worktree_create','workspace_worktree_bind','workspace_import_commits','workspace_verify_merge','git_import'].includes(request.type)?0:request.type==='workspace_browser'? (Number(request.timeout_ms)>0?Number(request.timeout_ms)+120000:180000) :request.type!=='workspace_command'?90000:request.timeout_ms==null?0:Number(request.timeout_ms)+120000;
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
      new ResultSession(this.store,scope,()=>projectResultOwner(this.task.repository_id),this.guard));
    // A repeated call replays this result: it is on disk before the row points to it. Browser screenshot bytes and typed
    // text stay off the stored record; the in-memory result still carries them so evidence can be persisted.
    const storedResult=request.type==='workspace_browser'?sanitizeBrowserTrajectory(result):result;
    let resultRef:string|null=null;
    if(scope){resultRef=trajectories.append(scope,'tool_result',id,storedResult);await trajectories.sync(resultRef);}
    await this.guard();
    if(resultRef)this.store.run(`UPDATE ${table} SET state='completed',result=?,result_ref=? WHERE id=?`,conversation?null:JSON.stringify(payloadHeader(storedResult)),resultRef,id);
    else this.store.run(`UPDATE ${table} SET state='completed',result=? WHERE id=?`,conversation?this.store.secrets.seal(storedResult,'conversation-operation:'+id+':result'):JSON.stringify(storedResult),id);
    // Model commands are logged by the agent loop together with the tool call; others (tests) are logged here.
    if(request.type==='workspace_command'&&!key.startsWith('model:'))this.log({type:'command',command:request.command,...result,output:clip(result.output)});
    // Locks a git process that ended abnormally left in the worktree, which the runner removed before this operation (#712).
    if(Array.isArray(result?.stale_git_locks_removed)&&result.stale_git_locks_removed.length)this.log({type:'git_locks_removed',operation:request.type,locks:result.stale_git_locks_removed,
      detail:`${request.type} 前清理了工作区里没有 git 进程持有的遗留锁：${result.stale_git_locks_removed.map((lock:any)=>`${lock.file}（已存在 ${lock.age_seconds} 秒）`).join('、')}`});
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
  // Delivers teardown/interrupt signals when a run is cancelling or closing, even after the task guard no longer passes.
  async deliverCleanup(request:any,timeoutMs=15000){
    if(!this.task.generation||!this.task.workspace_id)return {error:'workspace_unavailable'};
    const response=await this.manager.call('POST',`/v1/projects/${this.task.repository_id}/execute`,{operation_id:randomId(),generation:this.task.generation,
      request:{...request,workspace_id:this.task.workspace_id}},timeoutMs).catch(()=>null);
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
    snapshot?safePath(path):workspaceToolPath(path);
    if(this.redactor.contains(data))stop('credential_in_repository',undefined,`Credential found in repository file: ${path}`);
    for(let offset=0;offset<data.length||offset===0;offset+=30000){
      const result=await this.call(key+':'+offset,{type:'workspace_write',path,base64:data.subarray(offset,offset+30000).toString('base64'),offset,
        final:offset+30000>=data.length,mode,snapshot,...(hash?{sha:hash}:{})});
      if(result.error)stop('workspace_write_failed','waiting_environment',`Could not write ${path} at offset ${offset}: ${result.detail||result.error}`);
    }
  }
  /**
   * The repository at one fixed commit as a git worktree on the project computer, with the repository's history (#769).
   * The computer's git store receives what it lacks of the mirror as a pack: the whole history the first time, then only
   * new commits. `also` are further commits the task needs there, such as a pull request's base. A task that only reads
   * takes a worktree made for reading at this commit that no unfinished task holds, after the runner checked it (HEAD,
   * tree, no changes); a task that writes, or a reader that finds none, gets a new worktree. Either way the task directory
   * links to it as repo. Returns null when this way is not available (the caller then copies files as before); a reason to
   * stop the task still stops it.
   */
  async bind(github:GitHub,commitSha:string,mirror:Mirror,also:string[],mode:WorktreeMode){
    const listing=await this.listing(commitSha,mirror,`正在准备工作区：在虚拟电脑上取固定提交 ${commitSha} 的 git worktree…`);if(!listing)return null;
    const packed=await this.transfer(commitSha,mirror,also);if(packed===null)return null;
    const taken=await this.take(commitSha,listing.tree_sha,mode,github.authorEmail(),'system');if(!taken)return null;
    const snapshot=this.checkedOut(commitSha,listing,mirror,packed,taken.reused?`已复用 worktree ${taken.id.slice(0,12)}（同一提交、没有改动），共`:`已新建 worktree ${taken.id.slice(0,12)} 并检出`);
    return {...snapshot,worktree:taken};
  }
  /**
   * Prepares the commit like bind() but leaves the worktree for later (#769): the computer's store gets the commits, and the
   * task records what it is to get (taskPlan). The task's controller, or its agent without a role team, may choose a
   * worktree first (choose()); the first call that needs the files without a choice binds the system's (ensure()).
   * A workspace that already holds a worktree (the same workspace preparing again) is checked again at once, as bind() does.
   * Returns null when this way is not available.
   */
  async plan(github:GitHub,commitSha:string,mirror:Mirror,also:string[],mode:WorktreeMode){
    if(taskWorktree(this.store,this.task))return this.bind(github,commitSha,mirror,also,mode);
    const listing=await this.listing(commitSha,mirror,`正在准备提交 ${commitSha}：工作区在任务第一次用到仓库文件时建立…`);if(!listing)return null;
    const packed=await this.transfer(commitSha,mirror,also);if(packed===null)return null;
    // Bindings of earlier workspaces of this task (an earlier attempt) end now: this workspace has none yet.
    releaseWorktrees(this.store,String(this.task.id),'new_workspace',this.task.workspace_id);
    planWorktree(this.store,this.task,commitSha,listing.tree_sha,mode,github.authorEmail());this.settled=undefined;
    return {...this.checkedOut(commitSha,listing,mirror,packed,'提交已就绪，worktree 在第一次用到文件时建立；共'),worktree:null};
  }
  /** The plan of the task's current workspace (#769), if it was prepared by plan(). */
  plannedWorktree(){return taskPlan(this.store,this.task);}
  /**
   * Binds the task's worktree if the task needs one and holds none yet: the system's choice (bind()'s rule) for a task
   * that prepared by plan() and did not choose. An error answer when no worktree could be made.
   */
  async ensure():Promise<{error?:string;message?:string;worktree?:{id:string;mode:string;reused:boolean}}>{
    if(this.settled&&this.settled===this.task.workspace_id)return {};
    return serialized(`${this.task.id}:${this.task.workspace_id}`,async()=>{
      if(this.settled&&this.settled===this.task.workspace_id)return {};
      const plan=taskPlan(this.store,this.task);
      if(!plan||plan.state==='bound'&&taskWorktree(this.store,this.task)){this.settled=String(this.task.workspace_id);return {};}
      const taken=await this.take(plan.head_sha,plan.tree_sha,plan.mode,plan.author_email,'system');
      if(!taken)return {error:'workspace_unavailable',message:'No worktree could be made for this task on the project computer.'};
      this.settled=String(this.task.workspace_id);
      return {worktree:taken};
    });
  }
  /**
   * The system's choice for one commit: the worktree this workspace holds when it is still at the commit, else for a
   * reader a free unchanged one made for reading, else a new one. Returns null when none could be made.
   */
  private async take(commitSha:string,tree:string,mode:WorktreeMode,author:string|null,by:string){
    // Bindings of earlier workspaces of this task (an earlier attempt) end; one this workspace already took is checked again.
    releaseWorktrees(this.store,String(this.task.id),'new_workspace',this.task.workspace_id);
    const own=taskWorktree(this.store,this.task);
    if(own&&(own.head_sha!==commitSha||own.tree_sha!==tree))releaseBinding(this.store,Number(own.id),'task_commit_changed');
    const offered=own&&own.head_sha===commitSha&&own.tree_sha===tree?[{id:own.worktree_id,binding:Number(own.id)}]:[];
    return this.handOver(commitSha,tree,mode,author,by,offered);
  }
  /**
   * A checkout of a fixed candidate for an observer role or the acceptance check (#769), in this workspace: a task
   * directory of its own next to the task's workspace `source` (the task as it is there), which made the candidate. When
   * `source` holds a worktree, its commits are in the computer's git store, so this workspace takes a worktree made for
   * reading at the candidate's commit by the system's rule (a free, unchanged one, else a new one) instead of cloning
   * `source`, and gets a copy of `source`'s ../context/. Observers may run at once and run tests, so they do not share one.
   * The binding holds until releaseWorktree(). Null when `source` holds no worktree (a file copy) or none could be made:
   * the caller clones as before.
   */
  async observe(source:Row,commitSha:string,tree:string){
    if(!taskWorktree(this.store,source))return null;
    useWorkspace(this.store,this.task,'checkout');
    return serialized(`${this.task.id}:${this.task.workspace_id}`,()=>this.handOver(commitSha,tree,'read',null,'system',[],{source_workspace_id:String(source.workspace_id)}));
  }
  /** This workspace's run is over (an observer's or the acceptance check's): the worktree it read may go to the next reader. */
  releaseWorktree(reason:string){const own=taskWorktree(this.store,this.task);if(own)releaseBinding(this.store,Number(own.id),reason);}
  /**
   * Hands a worktree to this workspace: the one offered (the workspace's own), else for a reader a free unchanged one made
   * for reading at the commit, else a new one. `extra` goes with each runner call. Null when none could be made.
   */
  private async handOver(commitSha:string,tree:string,mode:WorktreeMode,author:string|null,by:string,offered:{id:string;binding:number}[],extra:Record<string,string>={}){
    const repo=String(this.task.repository_id),email=author??undefined;
    if(!offered.length&&mode==='read')for(const row of reusableWorktrees(this.store,repo,Number(this.task.generation),commitSha))
      if(row.tree_sha===tree){const binding=claimWorktree(this.store,this.task,row,mode);if(binding){offered.push({id:row.id,binding});break;}}
    for(const {id,binding} of offered){
      const bound=await this.call(`worktree:bind:${id}:${this.task.workspace_id}`,{type:'workspace_worktree_bind',worktree_id:id,sha:commitSha,tree_sha:tree,author_email:email,...extra});
      if(!bound.error&&!bound.refused&&bound.tree_sha===tree)return this.bound(id,mode,true,commitSha,tree,by);
      // Changed by its last task, moved or gone: it is not offered again, and the task gets a new one.
      refuseWorktree(this.store,repo,id,binding,String(bound.refused||'bind_failed'));
      // Shown in the console's snapshot block with the other preparation steps.
      this.log({type:'snapshot_progress',sha:commitSha,worktree_refused:{worktree_id:id,reason:bound.refused||bound.error,head:bound.head??null,changed_count:bound.changed_count??null},
        detail:`worktree ${id.slice(0,12)} 未通过交接核对（${bound.refused||bound.detail||bound.error}${bound.changed_count?`，有 ${bound.changed_count} 个文件改动`:''}），改为新建 worktree。`});
    }
    const id=randomId(),binding=registerWorktree(this.store,this.task,id,mode,commitSha,tree);
    const created=await this.call('worktree:create:'+id,{type:'workspace_worktree_create',worktree_id:id,sha:commitSha,tree_sha:tree,author_email:email,...extra});
    if(created.error||created.refused||created.tree_sha!==tree){refuseWorktree(this.store,repo,id,binding,String(created.refused||'create_failed'));return null;}
    return this.bound(id,mode,false,commitSha,tree,by);
  }
  /**
   * The task's own choice (#769), made by its controller or by its agent (`by`): an existing worktree of the project
   * computer (`use`, read or write) or a new one (`create`). The handover checks are the runner's, as for
   * the system's choice; a worktree with changes, or at another commit, is taken only with on_changes (reset restores it
   * to the task's commit first, saving its changes as a patch into ../context/; keep_changes takes it as it is, at the
   * task's commit, for writing). A task that writes cannot read only. Once the task holds a
   * worktree, it keeps it for this attempt.
   */
  choose(action:'use'|'create',args:{worktree_id?:string;mode?:string;on_changes?:string},by:string,callId=randomId()):Promise<any>{
    return serialized(`${this.task.id}:${this.task.workspace_id}`,()=>this.chooseNow(action,args,by,callId));
  }
  private async chooseNow(action:'use'|'create',args:{worktree_id?:string;mode?:string;on_changes?:string},by:string,callId:string):Promise<any>{
    const plan=taskPlan(this.store,this.task),repo=String(this.task.repository_id);
    if(!plan)return {error:'workspace_not_selectable',message:'This task\'s workspace was prepared without the computer\'s git store; it cannot be chosen.'};
    const held=taskWorktree(this.store,this.task);
    if(held)return {error:'workspace_already_bound',message:'This task already holds a worktree for this attempt; it keeps it.',worktree_id:held.worktree_id,mode:held.mode,head:held.head_sha};
    const mode=args.mode===undefined?plan.mode:args.mode;
    if(mode!=='read'&&mode!=='write')return {error:'invalid_arguments',message:'mode is read or write.'};
    if(plan.mode==='write'&&mode==='read')return {error:'workspace_mode_not_allowed',message:'This task changes repository files, so it takes its worktree for writing.'};
    const onChanges=args.on_changes;
    if(onChanges!==undefined&&onChanges!=='reset'&&onChanges!=='keep_changes')return {error:'invalid_arguments',message:'on_changes is reset or keep_changes.'};
    if(onChanges==='keep_changes'&&mode!=='write')return {error:'workspace_mode_not_allowed',message:'Only a writer keeps a worktree\'s changes.'};
    if(action==='create'){
      const id=randomId(),binding=registerWorktree(this.store,this.task,id,mode,plan.head_sha,plan.tree_sha);
      const created=await this.call('worktree:create:'+id,{type:'workspace_worktree_create',worktree_id:id,sha:plan.head_sha,tree_sha:plan.tree_sha,author_email:plan.author_email??undefined});
      if(created.error||created.refused||created.tree_sha!==plan.tree_sha){refuseWorktree(this.store,repo,id,binding,String(created.refused||'create_failed'));return {error:'workspace_unavailable',message:String(created.detail||created.refused||created.error||'the worktree could not be made')};}
      this.bound(id,mode,false,plan.head_sha,plan.tree_sha,by);
      return {worktree_id:id,mode,created:true,head:plan.head_sha,tree_sha:plan.tree_sha,changed_count:0,changed:[]};
    }
    if(!/^[a-f0-9]{48}$/.test(String(args.worktree_id||'')))return {error:'invalid_arguments',message:'worktree_id is the id list_workspaces shows.'};
    const row=this.store.get("SELECT * FROM worktrees WHERE repository_id=? AND id=? AND generation=? AND state<>'removed'",repo,String(args.worktree_id),Number(this.task.generation));
    // One the cleanup is removing right now is not listed, nor handed over: its directory may be gone the next moment.
    if(!row||workspaceRemoving(repo,row.id))return {error:'workspace_not_found',message:'No such worktree of this project on this computer; call list_workspaces.'};
    // A reader shares a worktree with other readers; a writer takes one nobody holds.
    const binding=claimWorktree(this.store,this.task,row,mode,true,plan.head_sha,plan.tree_sha);
    if(binding===null)return {error:'workspace_busy',message:mode==='write'?'Another unfinished task holds this worktree; a writer needs one nobody holds.':'An unfinished task holds this worktree for writing.'};
    const bound=await this.call(`worktree:use:${callId}`,{type:'workspace_worktree_bind',worktree_id:row.id,sha:plan.head_sha,tree_sha:plan.tree_sha,author_email:plan.author_email??undefined,...(onChanges?{on_changes:onChanges}:{})});
    if(bound.error||bound.refused||bound.tree_sha!==plan.tree_sha){
      // A refused choice changes nothing: the worktree stays as it is for others; one that is gone is not listed again.
      if(bound.refused==='workspace_missing')refuseWorktree(this.store,repo,row.id,binding,'workspace_missing');else releaseBinding(this.store,binding,'choice_refused');
      const refused=bound.refused||'workspace_unavailable';
      return {error:refused,head:bound.head??null,tree_sha:bound.tree_sha??null,changed_count:bound.changed_count??null,changed:bound.changed??undefined,...(bound.detail?{detail:String(bound.detail)}:{}),
        message:refused==='workspace_mismatch'?`This worktree is at ${bound.head}, not at the task's commit ${plan.head_sha}${mode==='write'?'; on_changes reset restores it to the task\'s commit (saving its changes as a patch)':''}.`
          :refused==='workspace_dirty'?`This worktree has ${bound.changed_count} changed files${mode==='write'?'; choose on_changes reset (saves them as a patch, then restores the worktree) or keep_changes (work on top of them)':'; a reader only takes an unchanged one'}.`
          :refused==='workspace_missing'?'This worktree is gone from the computer.':'The runner could not hand the worktree over.'};
    }
    if(onChanges==='reset')worktreeRestored(this.store,repo,row.id,plan.head_sha,plan.tree_sha);
    this.bound(row.id,mode,true,plan.head_sha,plan.tree_sha,by,onChanges,bound.saved);
    return {worktree_id:row.id,mode,head:bound.head,tree_sha:bound.tree_sha,changed_count:bound.changed_count,changed:bound.changed,...(bound.saved?{saved_changes:bound.saved}:{})};
  }
  // The task history's evidence of which worktree this run uses at which commit, and who chose it.
  private bound(id:string,mode:WorktreeMode,reused:boolean,head:string,tree:string,by:string,onChanges?:string,saved?:any){
    traceEvent(this.store,String(this.task.id),'workspace_bound',{worktree_id:id,workspace_id:this.task.workspace_id,mode,reused,head_sha:head,tree_sha:tree,attempt:this.task.attempt,decided_by:by,...(onChanges?{on_changes:onChanges}:{}),...(saved?{saved_changes:saved}:{})},this.task.trace_run_id);
    if(taskPlan(this.store,this.task)){
      decidePlan(this.store,this.task,'bound',by);
      this.log({type:'workspace_chosen',decided_by:by,choice:reused?'use':'create',worktree_id:id,mode,head,...(onChanges?{on_changes:onChanges}:{}),...(saved?{saved_changes:saved}:{}),
        detail:`${who(by)}${reused?`选用 worktree ${id.slice(0,12)}`:`新建 worktree ${id.slice(0,12)}`}（${mode==='read'?'读':'写'}，提交 ${head.slice(0,7)}）${onChanges==='reset'?`，先还原${saved?`，原有改动（${saved.count} 个文件）已保存到 ${saved.path}`:''}`:onChanges==='keep_changes'?'，保留其中的改动':''}。`});
    }
    this.settled=String(this.task.workspace_id);
    return {id,mode,reused};
  }
  /**
   * Moves this task's worktree to another commit in place (#770), keeping the directory, its untracked files and the
   * agent's session. Tracked changes, and untracked files the commit would overwrite, are saved as a patch under
   * ../context/ first (`saved`). `key` tells moves of one attempt apart. Returns null when the workspace is not a
   * worktree of the computer's store or the move fails: the caller then prepares a fresh workspace.
   */
  async advance(commitSha:string,mirror:Mirror,also:string[],key:string){
    const listing=await this.listing(commitSha,mirror,`正在把工作区移到新提交 ${commitSha}…`);if(!listing)return null;
    const packed=await this.transfer(commitSha,mirror,also);if(packed===null)return null;
    // A workspace without its worktree yet follows the new commit by its plan alone (#769).
    const plan=taskPlan(this.store,this.task);
    if(plan&&plan.state!=='bound'){movePlan(this.store,this.task,commitSha,listing.tree_sha);return {...this.checkedOut(commitSha,listing,mirror,packed,'已改为新提交，worktree 在第一次用到文件时建立；共'),previous_sha:plan.head_sha,saved:null};}
    const moved=await this.call(`advance:${key}:${commitSha}`,{type:'workspace_advance',sha:commitSha,tree_sha:listing.tree_sha});
    if(moved.error||moved.tree_sha!==listing.tree_sha)return null;
    // The task now works on the new commit: list_workspaces compares worktrees with it, its own included.
    if(plan)movePlan(this.store,this.task,commitSha,listing.tree_sha);
    return {...this.checkedOut(commitSha,listing,mirror,packed,'已移到新提交'),previous_sha:String(moved.previous_sha),saved:moved.saved??null};
  }
  // The files of a commit the mirror holds, after the checks every checkout makes; null when the mirror lacks it.
  private async listing(commitSha:string,mirror:Mirror,detail:string){
    const listing=mirror.has(commitSha)?await mirror.listing(commitSha):null;if(!listing)return null;
    this.log({type:'phase',phase:'prepare',sha:commitSha,detail});
    const unsafe=listing.tree.find(f=>f.mode==='120000'&&(f.path==='.agents/skills'||String(f.path??'').startsWith('.agents/skills/')));
    if(unsafe)stop('unsafe_skill_file','waiting_configuration',`Repository skill is a symbolic link: ${unsafe.path}`);
    // The task's own credentials must not be in files the agent reads; the mirror is searched instead of copying the files.
    const leaked=await mirror.secrets(commitSha,this.redactor.values);
    if(leaked.length)stop('credential_in_repository',undefined,`Credential found in repository file: ${leaked[0]}`);
    return listing;
  }
  /** Packs extra commits from the mirror into the project computer's git store when a conflict base arrives mid-run. */
  async transferCommits(mirror:Mirror,commits:string[]):Promise<boolean>{
    const shas=[...new Set(commits.filter(s=>/^[a-f0-9]{40}$/.test(s)))];
    if(!shas.length)return true;
    return (await this.transfer(shas[0]!,mirror,shas.slice(1)))!==null;
  }
  // Sends the computer's git store what it lacks of these commits, as a pack. Returns the bytes sent, or null when this
  // way is not available.
  private async transfer(commitSha:string,mirror:Mirror,also:string[]):Promise<number|null>{
    const have=await this.deliver({type:'git_have'});if(have.error||!Array.isArray(have.commits))return null;
    const missing=[...new Set([commitSha,...also])].filter(sha=>mirror.has(sha)&&!have.commits.includes(sha));
    if(!missing.length)return 0;
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
    return pack.size;
  }
  private checkedOut(commitSha:string,listing:{tree:any[];tree_sha:string},mirror:Mirror,packed:number,done:string){
    const files=listing.tree.filter(f=>f.type==='blob'),skipped=listing.tree.filter(f=>f.type!=='blob');
    this.log({type:'snapshot',sha:commitSha,files:files.length,bytes:files.reduce((sum,f)=>sum+(f.size||0),0),skipped:skipped.length,source:'git_worktree',cache:mirror.state,pack_bytes:packed,
      detail:`${done} ${files.length} 个文件（git worktree，含仓库历史）${packed?`，本次向虚拟电脑传送 ${packed} 字节的 git 对象`:'，虚拟电脑已有所需提交'}${skipped.length?`；${skipped.length} 个子模块条目未检出`:''}`});
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
  async extractArtifact(artifactId:number,data:Buffer,targetPath=`../context/artifacts/${artifactId}`){
    workspaceToolPath(targetPath);
    if(data.length>MAX_ARTIFACT_COMPRESSED_BYTES)return {error:'github_artifact_too_large',detail:`Compressed artifact size ${data.length} exceeds ${MAX_ARTIFACT_COMPRESSED_BYTES} bytes.`};
    if(!aside({type:'workspace_artifact_extract',path:targetPath})){const ready=await this.ensure();if(ready.error)return ready;}
    const stageId=randomId();
    for(let offset=0;offset<data.length||offset===0;offset+=45000){
      const staged=await this.deliver({type:'workspace_artifact_stage',stage_id:stageId,base64:data.subarray(offset,offset+45000).toString('base64'),offset});
      if(staged.error)return staged;
      if(data.length===0)break;
    }
    return this.deliver({type:'workspace_artifact_extract',stage_id:stageId,path:targetPath});
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
      // Preserve the skill symlink preflight before any workspace writes, including after a truncated-tree fallback.
      const unsafe=files.find((f:any)=>f.mode==='120000'&&(f.path==='.agents/skills'||String(f.path??'').startsWith('.agents/skills/')));
      if(unsafe)stop('unsafe_skill_file','waiting_configuration',`Repository skill is a symbolic link: ${unsafe.path}`);
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
