import type { Store } from '../storage/database.js';
import { sha } from '../agent/common.js';
import type { Candidate, Evidence } from './service.js';

/** Keep prompts bounded while the original observation remains addressable and hash-bound. */
export function observation(source:string,version:string,raw:string):Evidence {
  const data=JSON.parse(raw),result=data.result??data;
  const preview=(value:any):any=>typeof value==='string'&&value.length>4000?value.slice(0,4000)+' [read_evidence for full observation]':Array.isArray(value)?value.map(preview):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,preview(v)])):value;
  return {source,version,verified:!result?.error&&!result?.timed_out&&!result?.truncated&&(result?.exit_code===undefined||result.exit_code===0),result:{...preview(data),digest:sha(raw)}};
}
export function readEvidence(store:Store,taskId:string,candidate:Candidate,args:any){
  const evidence=candidate.evidence.find(e=>e.source===args?.source);
  const source=String(args?.source||''),[kind,id]=source.split(':');
  if(!id||id.length>128)return {error:'invalid_evidence_source'};
  if(!evidence&&kind!=='task_history')return {error:'evidence_not_offered'};
  const row=kind==='task_history'?store.get('SELECT data AS raw,type FROM task_history WHERE task_id=? AND id=?',taskId,id!):kind==='task_log'?store.get('SELECT content AS raw FROM task_logs WHERE task_id=? AND id=?',taskId,id!):null;
  if(!row)return {error:'raw_evidence_unavailable'};
  let data:any;try{data=JSON.parse(row.raw);}catch{data={};}
  const verification=!evidence&&row.type==='acceptance_evidence'&&data&&typeof data.evaluation_id==='string'?store.get("SELECT data FROM task_history WHERE task_id=? AND type='acceptance_started' AND json_extract(data,'$.evaluation_id')=? AND json_extract(data,'$.candidate_id')=? AND json_extract(data,'$.revision')=?",taskId,data.evaluation_id,candidate.id,candidate.revision):null;
  if(!evidence&&row.type!=='execution_evidence'&&!verification)return {error:'evidence_not_offered'};
  if(evidence&&(evidence.result as any)?.digest!==sha(row.raw))return {error:'evidence_digest_changed'};
  const offset=args?.offset??0,length=args?.length??12000;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>32000)return {error:'invalid_evidence_range'};
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
