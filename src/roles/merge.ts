import { assertRequiredStages, deliveryCandidate } from './schedule.js';
import {assertCoordinationCurrent} from '../tasks/coordination.js';
import type { Store, Row } from '../storage/database.js';
import { scope,type Actor } from '../app/auth.js';
import { fields,fail,type Json } from '../core/security.js';
import { GitHub } from '../github/client.js';
import { Publisher } from '../github/publisher.js';
import { Redactor,sha } from '../agent/common.js';
import { TaskRecords } from '../tasks/service.js';
import { traceEvent } from '../tasks/trace.js';
import {authorizeMerge,requestIntegration,integrationStorage} from '../tasks/integration.js';
import {mergeQueue} from '../projects/gate-facts.js';
import {recordRetryFailure,resolveRetry} from '../tasks/retries.js';

async function checks(s:Store,github:GitHub,taskId:string,head:string){
 const runs:any[]=[];
 for(let page=1;page<=100;page++){
  const result=await github.request('GET',github.path('/commits/'+head+'/check-runs?filter=latest&per_page=100&page='+page));
  if(!Array.isArray(result.check_runs))fail(409,'merge_checks_unavailable');runs.push(...result.check_runs);
  if(result.check_runs.length<100)break;if(page===100)fail(409,'merge_checks_pagination_limit');
 }
 const statuses=await github.request('GET',github.path('/commits/'+head+'/status'));
 const failed=runs.some(c=>c.status==='completed'&&!['success','neutral','skipped'].includes(c.conclusion))||statuses.state==='failure';
 const pending=runs.some(c=>c.status!=='completed')||(statuses.statuses?.length&&statuses.state!=='success'&&!failed);
 const result={sha:head,failed,pending,check_runs:runs.map(c=>({id:c.id,name:c.name,status:c.status,conclusion:c.conclusion})),status_contexts:statuses.statuses?.map((v:any)=>({context:v.context,state:v.state}))??[],no_remote_checks:!runs.length&&!statuses.statuses?.length};
 // Polling an unchanged queue must not manufacture apparent task progress.
 const last=s.get("SELECT data FROM task_history WHERE task_id=? AND type='merge_checks' ORDER BY id DESC LIMIT 1",taskId);
 if(last?.data!==JSON.stringify(result))traceEvent(s,taskId,'merge_checks',result,null,'framework');
 if(!failed&&!pending)resolveRetry(s,taskId,'merge_checks');
 return result;
}
function retryFailedChecks(s:Store,task:Row,base:string,head:string,pr:any){
 requestIntegration(s,task,base,'pull_request_checks_failed:'+head,pr);
 const source=s.get("SELECT id,data FROM task_history WHERE task_id=? AND type='merge_checks' ORDER BY id DESC LIMIT 1",task.id);
 recordRetryFailure(s,task,{group:'merge_checks',occurrence:head,code:'pull_request_checks_failed',source_ref:source?'task_history:'+source.id:undefined,
  detail:source?JSON.stringify(JSON.parse(source.data)):undefined});
}
const evolved=(s:Store,task:any,head:string,merged:any,actor:Actor)=>{
 s.transaction(()=>{
  if(!s.get("SELECT id FROM task_history WHERE task_id=? AND type='repository_evolved' AND json_extract(data,'$.head_sha')=? AND json_extract(data,'$.merge_sha')=?",task.id,head,merged.sha))traceEvent(s,task.id,'repository_evolved',{pr:merged.pr_number,head_sha:head,merge_sha:merged.sha,authorized_by:actor.id},null,'framework');
  s.run("UPDATE task_merge_requests SET state='merged',error=NULL,updated_at=? WHERE task_id=?",new Date().toISOString(),task.id);
 });return merged;
};
/** Explicit operator intent, not an agent tool. Intent persists through same-contract integration and fresh QA. */
async function mergeRequest(s:Store,user:Actor,method:string,url:URL,input:Json,githubUrl?:string):Promise<Json|undefined>{
 const match=/^\/api\/tasks\/([^/]+)\/merge$/.exec(url.pathname);if(!match||!['POST','GET','DELETE'].includes(method))return;
 if(method==='GET'){integrationStorage(s);const filter=scope(user,'repository_id');if(!s.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args))fail(404,'task_not_found');const row=s.get('SELECT task_id,expected_sha,method,revision,state,next_run_at,error,updated_at FROM task_merge_requests WHERE task_id=?',match[1]!);return {merge_request:row??null};}
 if(method==='DELETE'){
  fields(input,[]);integrationStorage(s);const filter=scope(user,'repository_id');
  const task=s.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);if(!task)fail(404,'task_not_found');
  const request=s.get('SELECT * FROM task_merge_requests WHERE task_id=?',task!.id);if(!request)return {cancelled:true};
  if(request.state==='merged')return {cancelled:false,merged:true};
  s.run("UPDATE task_merge_requests SET state='cancelling',next_run_at=0 WHERE task_id=?",task!.id);
  if(s.get("SELECT 1 FROM github_effects WHERE task_id=? AND kind='merge_queue' AND state<>'pending'",task!.id)){
   const github=new GitHub(s,s.get('SELECT * FROM repositories WHERE id=?',task!.repository_id)!,new Redactor(),async()=>{},githubUrl);await github.connect(true,undefined,{pull_requests:'write'},false);
   const result=JSON.parse(task!.result||'null');if(!result?.pr_number)fail(409,'merge_context_changed');
   const pr=await github.object('review.pr',result.pr_number);if(pr.merged)return evolved(s,task!,pr.head.sha,{merged:true,sha:pr.merge_commit_sha,pr_number:pr.number},user);
   const [owner,name]=github.fullName.split('/');
   const remote=await github.graphql('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id mergeQueueEntry{id}}}}',{owner,name,number:pr.number});
   if(remote?.repository?.pullRequest?.mergeQueueEntry){
    const generation=s.get("SELECT id FROM task_history WHERE task_id=? AND type='merge_requested' ORDER BY id DESC LIMIT 1",task!.id)?.id;
    await new Publisher(s,github,task!,async()=>{}).effect('dequeue:'+generation,'dequeue',{pr:pr.number},()=>github.graphql('mutation($id:ID!){dequeuePullRequest(input:{pullRequestId:$id}){clientMutationId}}',{id:remote.repository.pullRequest.id}),async()=>null,true);
   }
  }
  s.run("UPDATE task_merge_requests SET state='cancelled',error=NULL,updated_at=? WHERE task_id=?",new Date().toISOString(),task!.id);
  traceEvent(s,task!.id,'merge_cancelled',{actor:user.id},null,'user:'+user.id);return {cancelled:true};
 }
 fields(input,['expected_sha','merge_method']);if(typeof input.expected_sha!=='string'||!/^([a-f0-9]{40})$/.test(input.expected_sha)||!['merge','squash','rebase'].includes(String(input.merge_method)))fail(400,'invalid_merge_request');
 const head=String(input.expected_sha);
 integrationStorage(s);
 const filter=scope(user,'repository_id'),task=s.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);if(!task)fail(404,'task_not_found');
 const record=new TaskRecords(s).get(task!.id),result=JSON.parse(task!.result||'null'),accepted=record.acceptance;
 if(!['pr_opened','completed'].includes(task!.status)||!accepted||!['pass','pass_with_issues'].includes(accepted.outcome)||accepted.candidate_id!==record.candidate?.id||accepted.revision!==record.revision||!result?.pr_number||result.sha!==head)fail(409,'merge_requires_accepted_delivery');
 assertCoordinationCurrent(s,task!.id,record.candidate);
 const policy=s.get('SELECT * FROM policies WHERE repository_id=?',task!.repository_id);
 assertRequiredStages(s,task!.id,deliveryCandidate(new TaskRecords(s).get(task!.id).candidate,task!.kind));
 if(!policy?.enabled||!policy.development_enabled||accepted.policy_hash!==sha(String(policy.test_command||'')))fail(409,'merge_policy_changed');
 const owned=s.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task!.repository_id,result.pr_number);if(!owned||owned.sha!==head)fail(409,'merge_requires_owned_head');
 const github=new GitHub(s,s.get('SELECT * FROM repositories WHERE id=?',task!.repository_id)!,new Redactor(),async()=>{},githubUrl);await github.connect(true,undefined,{contents:'write',pull_requests:'write',checks:'read',statuses:'read'},false);
 let pr:any;
 const validate=async()=>{
  const current=new TaskRecords(s).get(task!.id);if(!['pr_opened','completed'].includes(current.progress.status)||current.revision!==record.revision||current.candidate?.id!==record.candidate?.id||current.acceptance?.candidate_id!==accepted.candidate_id)fail(409,'merge_context_changed');
  assertCoordinationCurrent(s,task!.id,current.candidate);
  const currentPolicy=s.get('SELECT * FROM policies WHERE repository_id=?',task!.repository_id);if(!currentPolicy?.enabled||!currentPolicy.development_enabled||sha(String(currentPolicy.test_command||''))!==accepted.policy_hash)fail(409,'merge_policy_changed');
  pr=await github.object('review.pr',result.pr_number);if(pr.head?.sha!==head||pr.base?.ref!==github.defaultBranch||pr.draft||pr.state!=='open'&&!pr.merged)fail(409,'merge_head_or_target_changed');
 };
 await validate();authorizeMerge(s,task!,user,head,String(input.merge_method));
 if(pr.merged)return evolved(s,task!,head,{merged:true,sha:pr.merge_commit_sha,pr_number:pr.number},user);
 const queue=await mergeQueue({get:path=>github.request('GET',path),graphql:async(query,variables)=>({data:await github.graphql(query,variables)})},github.fullName,github.defaultBranch);
 const saved=s.get('SELECT data FROM development_candidates WHERE task_id=?',task!.id),candidate=saved?JSON.parse(saved.data):null;
 // PullRequest.base.sha can lag behind the actual branch after another PR merges.
 const base=candidate?.base_sha?(await github.ref(github.defaultBranch))?.object?.sha:pr.base?.sha;
 if(candidate?.base_sha&&!base)fail(409,'merge_base_unavailable');
 if(queue.state!=='enabled'&&candidate?.base_sha&&base&&candidate.base_sha!==base){
  requestIntegration(s,task!,base,'default_branch_advanced',pr);
  return {merged:false,status:'integrating',task_id:task!.id,pr_number:pr.number};
 }
 if(queue.state==='enabled'){
  const [owner,name]=github.fullName.split('/');
  const state=await github.graphql('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id mergeQueueEntry{id position state baseCommit{oid} headCommit{oid}}}}}',{owner,name,number:pr.number});
  const remote=state?.repository?.pullRequest,entry=remote?.mergeQueueEntry;
  if(entry){
   const event={pr_number:pr.number,head_sha:head,entry_id:entry.id,position:entry.position,state:entry.state,base_sha:entry.baseCommit?.oid??null,combined_sha:entry.headCommit?.oid??null};
   const last=s.get("SELECT data FROM task_history WHERE task_id=? AND type='merge_queue' ORDER BY id DESC LIMIT 1",task!.id);
   if(last?.data!==JSON.stringify(event))traceEvent(s,task!.id,'merge_queue',event,null,'framework');
   s.run("UPDATE task_merge_requests SET state='queued' WHERE task_id=?",task!.id);
   return {merged:false,status:'queued',...event};
  }
  const generation=s.get("SELECT id FROM task_history WHERE task_id=? AND type='merge_requested' ORDER BY id DESC LIMIT 1",task!.id)?.id??0;
  const previous=s.get("SELECT data,created_at FROM task_history WHERE task_id=? AND type='merge_queue' AND id>? ORDER BY id DESC LIMIT 1",task!.id,generation);
  const group=previous?JSON.parse(previous.data).combined_sha:null;
  if(group){
   const checked=await checks(s,github,task!.id,group);
   if(checked.failed){requestIntegration(s,task!,base,'merge_queue_combination_failed:'+group,pr);return {merged:false,status:'integrating',task_id:task!.id};}
   // A person may have removed this item. Do not silently put it back without failed-check evidence.
   fail(409,'merge_queue_removed');
  }
  if(previous&&!group){if(Date.now()-Date.parse(previous.created_at)>60000)fail(409,'merge_queue_removed');return {merged:false,status:'awaiting_queue_visibility',pr_number:pr.number};}
  const checked=await checks(s,github,task!.id,head);if(checked.failed&&candidate?.local_sha&&task!.workspace_id){retryFailedChecks(s,task!,base,head,pr);return {merged:false,status:'integrating',task_id:task!.id};}if(checked.failed||checked.pending)fail(409,'merge_checks_not_green');
  const publisher=new Publisher(s,github,task!,validate);
  const enqueued=await publisher.effect('enqueue:'+head+':'+generation,'merge_queue',{head:head},()=>github.graphql('mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id position}}}',{id:remote?.id??pr.node_id,head:head}),async()=>null,true);
  traceEvent(s,task!.id,'merge_queue',{pr_number:pr.number,head_sha:head,entry_id:enqueued?.enqueuePullRequest?.mergeQueueEntry?.id??null,position:enqueued?.enqueuePullRequest?.mergeQueueEntry?.position??null,state:'ENQUEUED',base_sha:null,combined_sha:null},null,'framework');
  s.run("UPDATE task_merge_requests SET state='queued' WHERE task_id=?",task!.id);
  return {merged:false,status:'queued',pr_number:pr.number};
 }
 const checked=await checks(s,github,task!.id,head);if(checked.failed&&candidate?.local_sha&&task!.workspace_id){retryFailedChecks(s,task!,base,head,pr);return {merged:false,status:'integrating',task_id:task!.id};}if(checked.failed||checked.pending)fail(409,'merge_checks_not_green');
 s.audit(user.id,'task.merge.authorized',task!.id,task!.repository_id);
 const publisher=new Publisher(s,github,task!,async()=>{await validate();if(!pr.merged&&candidate?.base_sha&&(await github.ref(github.defaultBranch))?.object?.sha!==candidate.base_sha)fail(409,'merge_base_advanced');});
 const merged=await publisher.effect('merge:'+head,'merge',{pr:result.pr_number,sha:head,method:input.merge_method,actor:user.id},()=>github.request('PUT',github.path('/pulls/'+result.pr_number+'/merge'),{sha:head,merge_method:input.merge_method}),async()=>{const current=await github.object('review.pr',result.pr_number);return current.merged&&current.head.sha===head?{merged:true,sha:current.merge_commit_sha,reconciled:true}:null;});
 if(merged.merged!==true)fail(409,'merge_not_confirmed');
 return evolved(s,task!,head,{merged:true,sha:merged.sha,pr_number:result.pr_number},user);
}

// Serialize only the short final publication/check decision for one repository. Development,
// integration and policy/QA executions retain their independent task slots.
const mergeLocks=new WeakMap<Store,Map<string,Promise<void>>>();
export async function mergeApi(s:Store,user:Actor,method:string,url:URL,input:Json,githubUrl?:string):Promise<Json|undefined>{
 const match=/^\/api\/tasks\/([^/]+)\/merge$/.exec(url.pathname);
 if(!match||!['POST','DELETE'].includes(method))return mergeRequest(s,user,method,url,input,githubUrl);
 const filter=scope(user,'repository_id'),task=s.get(`SELECT repository_id FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);
 if(!task)fail(404,'task_not_found');
 let locks=mergeLocks.get(s);if(!locks){locks=new Map();mergeLocks.set(s,locks);}
 const key=String(task!.repository_id),previous=locks.get(key);let release!:()=>void;
 const current=new Promise<void>(resolve=>{release=resolve;});locks.set(key,current);
 await previous;
 try{return await mergeRequest(s,user,method,url,input,githubUrl);}finally{release();if(locks.get(key)===current)locks.delete(key);}
}
