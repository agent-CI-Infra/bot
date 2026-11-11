import type {Store,Row} from '../storage/database.js';
import type {GitHub} from './client.js';
import {Redactor} from '../agent/common.js';
import {traceEvent} from '../tasks/trace.js';

/** Each endpoint has its own receipt: missing logs must never erase annotations/job facts. */
export async function collectCheckEvidence(s:Store,task:Row,github:GitHub,redactor:Redactor,sha:string,checkId:number,page=1){
 if(!/^[a-f0-9]{40}$/.test(sha)||!Number.isSafeInteger(checkId)||checkId<1||!Number.isSafeInteger(page)||page<1)return {error:'invalid_ci_reference'};
 const refs:string[]=[],base={repository:github.fullName,sha,check_run_id:checkId};
 const read=async(kind:string,path:string,work:()=>Promise<any>)=>{
  try{const value=await work();refs.push(traceEvent(s,task.id,'retry_evidence',redactor.clean({...base,kind,endpoint:path,data:value}),null,'framework'));return value;}
  catch(error){refs.push(traceEvent(s,task.id,'retry_evidence',{...base,kind,endpoint:path,error:String((error as any).code??'github_evidence_unavailable'),availability:'unavailable'},null,'framework'));return null;}
 };
 const route='/check-runs/'+checkId;
 const check=await read('check_run',route,()=>github.request('GET',github.path(route)));
 if(!check)return {refs};
 if(check.head_sha!==sha){refs.push(traceEvent(s,task.id,'retry_evidence',{...base,kind:'binding',error:'ci_candidate_mismatch',observed_sha:check.head_sha},null,'framework'));return {refs,error:'ci_candidate_mismatch'};}
 const annotationsPath=route+'/annotations?per_page=100&page='+page;
 const annotations=await read('annotations',annotationsPath,async()=>{
  const items=await github.request('GET',github.path(annotationsPath));
  if(!Array.isArray(items))throw new Error('invalid_annotations');
  return {items,page,next_page:items.length===100?page+1:null,check_run_id:checkId,sha};
 });
 // Only an Actions job URL belonging to this repository establishes the link.
 const match=/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)(?:\?.*)?$/.exec(String(check.details_url??''));
 const jobId=match&&match[1]!.toLowerCase()===github.fullName.toLowerCase()&&Number.isSafeInteger(Number(match[3]))?Number(match[3]):null;
 if(jobId){
  const jobPath='/actions/jobs/'+jobId;
  const job=await read('job',jobPath,()=>github.request('GET',github.path(jobPath)));
  if(job?.head_sha&&job.head_sha!==sha){refs.push(traceEvent(s,task.id,'retry_evidence',{...base,kind:'job_binding',job_id:jobId,error:'ci_candidate_mismatch'},null,'framework'));}
  else if(job)await read('log',jobPath+'/logs',async()=>{const log=await github.jobLog(jobId);return {job_id:jobId,log:log.slice(-32000),original_characters:log.length,truncated:log.length>32000};});
 }else refs.push(traceEvent(s,task.id,'retry_evidence',{...base,kind:'job_link',availability:'unconfirmed',instruction:'No verified Actions job association. Check output and annotations remain usable; do not assume check-run ID is a job ID.'},null,'framework'));
 return {refs,annotations_next_page:annotations?.next_page??null,check_run_id:checkId,sha};
}
