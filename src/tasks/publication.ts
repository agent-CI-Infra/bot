import type {Store,Row} from '../storage/database.js';
import type {GitHub} from '../github/client.js';
import {traceEvent} from './trace.js';

/** Observations describe publication facts, never a decision to replace, merge or block a task. */
export function publicationFact(s:Store,task:Row,event:string,data:any){
 return traceEvent(s,task.id,'publication_state',{event,...data,observed_at:new Date().toISOString()},task.trace_run_id,'framework');
}
export async function publicationContext(s:Store,task:Row,args:any={},remote?:()=>Promise<GitHub>){
 const saved=s.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),candidate=saved?JSON.parse(saved.data):null;
 const before=args?.before;
 if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))return {error:'invalid_publication_cursor'};
 const rows=s.all("SELECT id,data,created_at FROM task_history WHERE task_id=? AND type='publication_state' AND id<? ORDER BY id DESC LIMIT 21",task.id,before??Number.MAX_SAFE_INTEGER);
 const attempts=rows.slice(0,20).map(r=>({ref:'task_history:'+r.id,...JSON.parse(r.data)}));
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
  remote:observation,attempts,next_before:rows.length>20?rows[19]!.id:null,branch_effects:effects,
  instruction:'Commit creation, branch confirmation and PR confirmation are separate facts. Legacy remote_sha alone is not proof of publication. Receipts belong to their exact request, not newer candidates. Remote observations are timestamped; unavailable means unknown. Read record refs for originals; choose retry, investigation, coordination, integration or help yourself.'};
}
