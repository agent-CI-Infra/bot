import { taskControllerReads, visibleMemorySnapshot, type MemoryAccess } from '../memory/access.js';
import { historyData, logContent, unreadable } from '../storage/payloads.js';
import type { Store } from '../storage/database.js';
import { sha } from '../agent/common.js';
import type { Candidate, Evidence } from './service.js';

/** Keep prompts bounded while the original observation remains addressable and hash-bound. */
export function observation(source:string,version:string,raw:string):Evidence {
  const data=JSON.parse(raw),result=data.result??data;
  const preview=(value:any):any=>typeof value==='string'&&value.length>4000?value.slice(0,4000)+' [read_evidence for full observation]':Array.isArray(value)?value.map(preview):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,preview(v)])):value;
  return {source,version,verified:!result?.error&&!result?.timed_out&&!result?.truncated&&(result?.exit_code===undefined||result.exit_code===0),result:{...preview(data),digest:sha(raw)}};
}
/** A candidate as agent input where its bodies matter (acceptance, a follow-up's parent delivery). Both grow with an
 * attempt: a files artifact lists every file of the workspace (1.5 MB for a 9,500-file repository) and evidence has one
 * preview per command. A field of an artifact's content over 16 KB is replaced by its size; evidence previews are kept
 * newest first within 128 KB, older entries keep their source for read_evidence. */
export function boundedCandidate(candidate:Candidate|null){
  if(!candidate)return null;
  const size=(value:unknown)=>JSON.stringify(value)?.length??0;
  const content=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)&&size(value)>16384
    ?Object.fromEntries(Object.entries(value).map(([key,field])=>[key,size(field)>16384?{omitted:true,characters:size(field)}:field])):size(value)>16384?{omitted:true,characters:size(value)}:value;
  let budget=128*1024;
  const evidence=[...candidate.evidence].reverse().map(entry=>{
    const cost=size(entry.result);if(cost<=budget){budget-=cost;return entry;}
    budget=0;return {source:entry.source,version:entry.version,verified:entry.verified,result:{omitted:true,characters:cost,read:'read_evidence with this source'}};
  }).reverse();
  return {...candidate,artifacts:candidate.artifacts.map(artifact=>({...artifact,...(artifact.content===undefined?{}:{content:content(artifact.content)})})),evidence};
}
export function readEvidence(store:Store,taskId:string,candidate:Candidate,args:any,access?:MemoryAccess){
  const error=(code:string)=>({error:code,requested_source:args?.source,candidate_id:candidate.id,revision:candidate.revision,offered_sources:candidate.evidence.slice(-20).map(({source,version,verified})=>({source,version,verified})),discovery:{tool:'read_evidence',task_ref:'task:'+taskId},instruction:'Only offered, authorized observations are readable here. Choose among offered_sources; task-reading tools, when available, expose shared publication/version facts. You decide whether to query another source or obtain new evidence.'});
  const evidence=candidate.evidence.find(e=>e.source===args?.source);
  const source=String(args?.source||''),[kind,id]=source.split(':');
  if(!id||id.length>128)return error('invalid_evidence_source');
  if(!evidence&&kind!=='task_history')return error('evidence_not_offered');
  const row=kind==='task_history'?store.get('SELECT data AS raw,data,type FROM task_history WHERE task_id=? AND id=?',taskId,id!):kind==='task_log'?store.get('SELECT content AS raw,content,content_ref FROM task_logs WHERE task_id=? AND id=?',taskId,id!):null;
  if(!row)return error('raw_evidence_unavailable');
  // A body in a trajectory file reads as the text it was recorded with, so digests taken before still match.
  try{row.raw=kind==='task_log'?logContent(store,row):historyData(store,row);}catch{return error('raw_evidence_unavailable');}
  let data:any;try{data=JSON.parse(row.raw);}catch{data={};}
  const verification=!evidence&&row.type==='acceptance_evidence'&&data&&typeof data.evaluation_id==='string'?store.get("SELECT data FROM task_history WHERE task_id=? AND type='acceptance_started' AND json_extract(data,'$.evaluation_id')=? AND json_extract(data,'$.candidate_id')=? AND json_extract(data,'$.revision')=?",taskId,data.evaluation_id,candidate.id,candidate.revision):null;
  if(!evidence&&row.type!=='execution_evidence'&&!verification)return error('evidence_not_offered');
  if(evidence&&(evidence.result as any)?.digest!==sha(row.raw))return error('evidence_digest_changed');
  const scoped=taskControllerReads(store,taskId,access)?data:visibleMemorySnapshot(store,store.get('SELECT repository_id FROM tasks WHERE id=?',taskId)!.repository_id,data,access);
  if(scoped!==data)return error('evidence_knowledge_forbidden');
  const offset=args?.offset??0,length=args?.length??12000;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>32000)return error('invalid_evidence_range');
  const binding=verification?JSON.parse(verification.data):null;
  return {source,version:evidence?.version||data?.version||data?.result?.version||binding?.source_tree||'unknown',historical:!evidence,
    ...(binding?{verification_candidate:binding.candidate_id,revision:binding.revision}:{}),digest:sha(row.raw),offset,total:row.raw.length,chunk:row.raw.slice(offset,offset+length)};
}

/** Compact facts from previous attempts at this exact candidate; never model messages or prior opinions. */
export function previousVerificationEvidence(store:Store,taskId:string,candidate:Candidate){
  return store.all(`SELECT h.id,h.data,h.created_at,s.data binding FROM task_history h JOIN task_history s
    ON s.task_id=h.task_id AND s.type='acceptance_started' AND json_extract(s.data,'$.evaluation_id')=json_extract(h.data,'$.evaluation_id')
    WHERE h.task_id=? AND h.type='acceptance_evidence' AND json_extract(h.data,'$.name') IN ('read_file','run_command','policy_validation','read_related_artifact') AND json_extract(s.data,'$.candidate_id')=? AND json_extract(s.data,'$.revision')=?
    ORDER BY h.id DESC LIMIT 60`,taskId,candidate.id,candidate.revision).reverse().map(row=>{
      const data=JSON.parse(row.data),binding=JSON.parse(row.binding),result=data.result||{};
      return {source:'task_history:'+row.id,digest:sha(row.data),observed_at:row.created_at,name:data.name,
        candidate_id:binding.candidate_id,revision:binding.revision,version:result.version||binding.source_tree||'unknown',
        arguments:{path:data.arguments?.path,command:String(data.arguments?.command||data.command||'').slice(0,200)},
        exit_code:result.exit_code,error:result.error,timed_out:result.timed_out,truncated:result.truncated,
        preview:typeof result.output==='string'?result.output.slice(-1000):typeof result.content==='string'?result.content.slice(0,500):JSON.stringify(result).slice(0,500)};
    });
}
