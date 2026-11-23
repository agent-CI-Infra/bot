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
 // Reads the same updates a publication would carry. A failure here is unknown coverage, never a real zero: the fields it
 // would fill stay null and `coverage` says unavailable, so a defer never pretends to have answered every update.
 let facts:any=null;
 if(String(task.kind||'').startsWith('review.'))try{facts=reviewUpdateFacts(s,task,1000);}catch{facts=null;}
 const coverage=facts&&Number.isSafeInteger(facts.covered_through)?'available':'unavailable';
 const clean=(list:any[])=>list.map(Number).filter((id:number,index:number,all:number[])=>Number.isSafeInteger(id)&&id>0&&all.indexOf(id)===index);
 const explicitPending=Array.isArray(data.pending_update_ids)?data.pending_update_ids:Array.isArray(data.carried)?data.carried:null;
 const pendingKnown=explicitPending!==null||coverage==='available';
 const pending=clean(explicitPending??(coverage==='available'?(facts.uncovered??[]).map((update:any)=>update.id):[]));
 const explicitCarried=Array.isArray(data.carried)?data.carried:Array.isArray(data.carried_update_ids)?data.carried_update_ids:null;
 const carriedKnown=explicitCarried!==null||decision==='publish'||pendingKnown;
 const carried=clean(explicitCarried??(decision==='publish'?[]:pending));
 const covered=Number.isSafeInteger(data.covered_through)?data.covered_through:coverage==='available'?Number(facts.covered_through):null;
 let round=data.round===undefined?undefined:Number(data.round);
 if(round===undefined)try{round=Number(JSON.parse(task.input||'{}').round)||1;}catch{round=1;}
 return traceEvent(s,task.id,'publication_decision',{decision,reason:data.reason??null,coverage,covered_through:covered,
  pending_updates:Number.isSafeInteger(data.pending_updates)?data.pending_updates:pendingKnown?pending.length:null,pending_update_ids:pending.slice(0,100),
  carried_updates:Number.isSafeInteger(data.carried_updates)?data.carried_updates:carriedKnown?carried.length:null,carried:carried.slice(0,100),carried_update_ids:carried.slice(0,100),
  ...(Array.isArray(data.reasons)?{reasons:data.reasons}:{}),...(Number.isSafeInteger(round)?{round}:{}),
  manager_action:data.manager_action?String(data.manager_action):null,at:new Date().toISOString()},
  task.trace_run_id,'framework',Array.isArray(data.caused_by)?data.caused_by:[]);
}
export async function publicationContext(s:Store,task:Row,args:any={},remote?:()=>Promise<GitHub>){
 const saved=s.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),candidate=saved?JSON.parse(saved.data):null;
 // Attempts and decisions are separate event streams with independent sizes: one cursor cannot page both without
 // skipping older rows of the other, so each keeps its own `before` argument and its own truncation marker.
 const {before,decisions_before}=args??{};
 if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))return {error:'invalid_publication_cursor'};
 if(decisions_before!==undefined&&(!Number.isSafeInteger(decisions_before)||decisions_before<1))return {error:'invalid_decisions_cursor'};
 const rows=s.all("SELECT id,data,created_at FROM task_history WHERE task_id=? AND type='publication_state' AND id<? ORDER BY id DESC LIMIT 21",task.id,before??Number.MAX_SAFE_INTEGER);
 const attempts=rows.slice(0,20).map(r=>({ref:'task_history:'+r.id,...JSON.parse(r.data)}));
 const decisionRows=s.all("SELECT id,data,created_at FROM task_history WHERE task_id=? AND type='publication_decision' AND id<? ORDER BY id DESC LIMIT 21",task.id,decisions_before??Number.MAX_SAFE_INTEGER);
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
  remote:observation,attempts,next_before:rows.length>20?rows[19]!.id:null,attempts_truncated:rows.length>20,
  decisions,latest_decision:decisions.at(-1)??null,decisions_next_before:decisionRows.length>20?decisionRows[19]!.id:null,decisions_truncated:decisionRows.length>20,branch_effects:effects,
  instruction:'Commit creation, branch confirmation and PR confirmation are separate facts. Legacy remote_sha alone is not proof of publication. Receipts belong to their exact request, not newer candidates. Remote observations are timestamped; unavailable means unknown. Decisions record publish, defer and next-round choices with the updates they carried; they do not replace the task contract. Attempts and decisions page independently: pass next_before for attempts and decisions_next_before for decisions; a null cursor with its truncated marker false means that stream has no older rows. Read record refs for originals; choose retry, investigation, coordination, integration or help yourself.'};
}
