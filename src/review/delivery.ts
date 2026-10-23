import type { Store } from '../storage/database.js';
// Derive presentation from the archive and durable task identity, never expose raw payloads in lists.
export function deliveryResult(store:Store,row:any){
  let tasks=store.all('SELECT id,kind,object_number,status FROM tasks WHERE source_delivery_id=? ORDER BY created_at,id',row.id),reason='not_trigger',fullName=row.full_name||null;
  let payload:any={};try{payload=JSON.parse(Buffer.from(row.payload).toString('utf8'));}catch{}
  if(!fullName&&/^[\w.-]+\/[\w.-]+$/.test(payload.repository?.full_name||''))fullName=payload.repository.full_name;
  if(!tasks.length&&row.repository_id){
    const issue=row.event==='issues'&&payload.action==='opened'&&payload.issue&&!payload.issue.pull_request;
    const pr=row.event==='pull_request'&&['opened','ready_for_review','synchronize'].includes(payload.action)&&payload.pull_request?.draft!==true;
    const object=issue?payload.issue:pr?payload.pull_request:null;
    if(object){const key=`${row.repository_id}:review.${issue?'issue':'pr'}:${object.number||payload.number}:${issue?'opened':object.head?.sha}`;
      tasks=store.all('SELECT id,kind,object_number,status FROM tasks WHERE unique_key=?',key);if(tasks.length)reason='duplicate';}
  }else if(tasks.length)reason='tasks_created';
  if(row.duplicate)reason='duplicate';
  else if(row.status!=='accepted')reason=row.status;
  else if(!tasks.length&&row.event==='pull_request'&&payload.pull_request?.draft===true)reason='draft';
  else if(!tasks.length&&row.repository_id){try{reason=JSON.parse(row.response).review_outcome||reason;}catch{}}
  else if(!row.repository_id)reason='unregistered_repository';
  return {full_name:fullName,processing_result:reason,tasks};
}
