import type {Store,Row} from '../storage/database.js';
import type {GitHub} from '../github/client.js';
import {traceEvent} from './trace.js';
import {reviewUpdateFacts} from '../review/sessions.js';

/** Observations describe publication facts, never a decision to replace, merge or block a task. */
export function publicationFact(s:Store,task:Row,event:string,data:any){
 return traceEvent(s,task.id,'publication_state',{event,...data,observed_at:new Date().toISOString()},task.trace_run_id,'framework');
}
/** A publish/defer/next-round choice on the task timeline: coverage, carried updates, round and Manager action. */
export function publicationDecision(s:Store,task:Row,decision:'publish'|'defer'|'next_round',data:any={}){
 let facts:any={covered_through:0,uncovered:[]};
 if(String(task.kind||'').startsWith('review.'))try{facts=reviewUpdateFacts(s,task,1000);}catch{}
 const clean=(list:any[])=>list.map(Number).filter((id:number,index:number,all:number[])=>Number.isSafeInteger(id)&&id>0&&all.indexOf(id)===index);
 const pending=clean(Array.isArray(data.pending_update_ids)?data.pending_update_ids:Array.isArray(data.carried)?data.carried:facts.uncovered.map((update:any)=>update.id));
 const carried=clean(Array.isArray(data.carried)?data.carried:Array.isArray(data.carried_update_ids)?data.carried_update_ids:decision==='publish'?[]:pending);
 const covered=Number.isSafeInteger(data.covered_through)?data.covered_through:Number.isSafeInteger(facts.covered_through)?facts.covered_through:0;
 let round=data.round===undefined?undefined:Number(data.round);
 if(round===undefined)try{round=Number(JSON.parse(task.input||'{}').round)||1;}catch{round=1;}
 return traceEvent(s,task.id,'publication_decision',{decision,reason:data.reason??null,covered_through:covered,
  pending_updates:Number.isSafeInteger(data.pending_updates)?data.pending_updates:pending.length,pending_update_ids:pending.slice(0,100),
  carried_updates:Number.isSafeInteger(data.carried_updates)?data.carried_updates:carried.length,carried:carried.slice(0,100),carried_update_ids:carried.slice(0,100),
  ...(Array.isArray(data.reasons)?{reasons:data.reasons}:{}),...(Number.isSafeInteger(round)?{round}:{}),
  manager_action:data.manager_action?String(data.manager_action):null,at:new Date().toISOString()},
  task.trace_run_id,'framework',Array.isArray(data.caused_by)?data.caused_by:[]);
}
export async function publicationContext(s:Store,task:Row,args:any={},remote?:()=>Promise<GitHub>){
 const saved=s.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),candidate=saved?JSON.parse(saved.data):null;
 const before=args?.before;
 if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))return {error:'invalid_publication_cursor'};
 const rows=s.all("SELECT id,data,created_at FROM task_history WHERE task_id=? AND type='publication_state' AND id<? ORDER BY id DESC LIMIT 21",task.id,before??Number.MAX_SAFE_INTEGER);
 const attempts=rows.slice(0,20).map(r=>({ref:'task_history:'+r.id,...JSON.parse(r.data)}));
 const decisionRows=s.all("SELECT id,data,created_at FROM task_history WHERE task_id=? AND type='publication_decision' AND id<? ORDER BY id DESC LIMIT 21",task.id,before??Number.MAX_SAFE_INTEGER);
 const decisions=decisionRows.slice(0,20).reverse().map(r=>({ref:'task_history:'+r.id,created_at:r.created_at,...JSON.parse(r.data)}));
 const version=(purpose:string,commit:any,tree:any=null)=>commit?traceEvent(s,task.id,'version_reference',{purpose,commit_sha:commit,tree_sha:tree,local_availability:'unknown',repository_id:task.repository_id,attempt:task.attempt},task.trace_run_id):null;
 const refs={candidate_ref:version('candidate',candidate?.local_sha,candidate?.tree_sha),created_commit_ref:version('created_commit',candidate?.created_commit_sha,candidate?.created_tree_sha),expected_head_ref:version('publication_expected_head',candidate?.expected_sha)};
 let observation:any={availability:'not_requested'};
 if(remote&&candidate?.branch)try{
  const github=await remote(),head=(await github.ref(candidate.branch))?.object?.sha??null;
  const data={branch:candidate.branch,expected_sha:candidate.expected_sha??null,target_sha:candidate.created_commit_sha??candidate.remote_sha??null,observed_sha:head};
  observation={availability:'available',...data,head_ref:version('publication_remote_head',head),observed_at:new Date().toISOString(),ref:publicationFact(s,task,'branch_observed',data)};
  const number=candidate.pr_number??candidate.published?.number;
  if(number&&github.permissions?.pull_requests)try{const pr=await github.object('review.pr',number);observation.pull_request={availability:'available',number,head_sha:pr.head?.sha??null,head_ref:version('publication_pr_head',pr.head?.sha),state:pr.state,observed_at:new Date().toISOString()};}catch(error){observation.pull_request={availability:'unavailable',number,error:String((error as any).code??'publication_pr_observation_failed')};}
 }catch(error){observation={...observation,availability:'unavailable',error:String((error as any).code??'publication_observation_failed'),observed_at:new Date().toISOString()};}
 const effects=s.all("SELECT id,state,request,response FROM github_effects WHERE task_id=? AND kind='branch' ORDER BY rowid DESC LIMIT 20",task.id).map(r=>{
  const request=JSON.parse(r.request),response=r.response?JSON.parse(r.response):null;
  return {ref:'github_effects:'+r.id,state:r.state,requested_sha:request.sha??null,receipt_sha:response?.object?.sha??null};
 });
 return {...refs,candidate:candidate?{local_sha:candidate.local_sha,tree_sha:candidate.tree_sha,branch:candidate.branch,expected_head:candidate.expected_sha??null,created_commit:candidate.created_commit_sha??null,legacy_remote_sha:candidate.created_commit_sha?null:candidate.remote_sha??null,branch_confirmation:candidate.branch_confirmed??null,pr_number:candidate.pr_number??candidate.published?.number??null}:null,
  remote:observation,attempts,decisions,latest_decision:decisions.at(-1)??null,next_before:rows.length>20?rows[19]!.id:null,branch_effects:effects,
  instruction:'Commit creation, branch confirmation and PR confirmation are separate facts. Legacy remote_sha alone is not proof of publication. Receipts belong to their exact request, not newer candidates. Remote observations are timestamped; unavailable means unknown. Decisions record publish, defer and next-round choices with the updates they carried; they do not replace the task contract. Read record refs for originals; choose retry, investigation, coordination, integration or help yourself.'};
}
