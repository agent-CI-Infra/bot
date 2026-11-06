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
  if(!evidence)return {error:'evidence_not_offered'};
  const [kind,id]=evidence.source.split(':');
  const row=kind==='task_history'?store.get('SELECT data AS raw FROM task_history WHERE task_id=? AND id=?',taskId,id!):kind==='task_log'?store.get('SELECT content AS raw FROM task_logs WHERE task_id=? AND id=?',taskId,id!):null;
  if(!row)return {error:'raw_evidence_unavailable'};
  if((evidence.result as any)?.digest!==sha(row.raw))return {error:'evidence_digest_changed'};
  const offset=args?.offset??0,length=args?.length??12000;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>32000)return {error:'invalid_evidence_range'};
  return {source:evidence.source,version:evidence.version,digest:sha(row.raw),offset,total:row.raw.length,chunk:row.raw.slice(offset,offset+length)};
}
