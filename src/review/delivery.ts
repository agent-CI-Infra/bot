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
// A delivery is three facts for the console, all already in the archive: whether the request was accepted, whether its
// signature was checked, and what the Manager decided. They are projected here so a row never derives one from another;
// a bad signature is refused before processing, and an archived event keeps its own reason.
export function deliveryDiagnosis(store:Store,row:any){
  const status=String(row.status||'');
  // The signature is read only after the body is complete and the endpoint exists. A missing event name or delivery ID
  // is refused after verification, so those rows still carry a verified signature.
  const signature=status==='invalid_signature'?{state:'invalid',reason:'invalid_signature'}
    :status==='payload_too_large'||status==='unknown_endpoint'?{state:'unchecked',reason:status}
    :{state:'verified',reason:null};
  const dispatch=store.all(`SELECT id,type,source,state,decision,reason,summary,created_at,decided_at FROM dispatch_events
    WHERE delivery_id=? ORDER BY created_at,id`,row.id).map((event:any)=>({event_id:event.id,type:event.type,source:event.source,
    state:event.state,decision:event.decision,reason:event.reason,summary:event.summary,created_at:event.created_at,decided_at:event.decided_at}));
  return {reception:{accepted:status==='accepted',code:status,http_status:row.http_status,body_complete:!!row.body_complete,received_at:row.received_at},
    signature,dispatch,source:{reference:'deliveries:'+row.id,record_id:row.id,delivery_id:row.delivery_id,event:row.event,route:row.route,
      account_id:row.account_id,endpoint_id:row.endpoint_id,repository_id:row.repository_id}};
}
