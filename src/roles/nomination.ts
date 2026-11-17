import type {Store,Row} from '../storage/database.js';
import {SubmissionError} from './submission-error.js';

/** Read only this task and its same-project descendants; an arbitrary reference never grants access. */
export function nominationSource(s:Store,task:Row,ref:unknown) {
 const latest=s.get("SELECT id FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev' ORDER BY id DESC LIMIT 1",task.id);
 const reject=(reason:string,observed:Record<string,unknown>={},code='role_nomination_invalid'):never=>{throw new SubmissionError(code,{reason,submitted_ref:typeof ref==='string'?ref.slice(0,200):null,current_task:'task:'+task.id,expected:'Latest Dev role_result of this task, or an accepted descendant task result. Child results are evidence for the CURRENT parent workspace, not an automatic checkout or parent acceptance.',observed,available_result_refs:latest?['task_history:'+latest.id]:[],available_child_result_refs:s.all("SELECT c.child_id FROM task_children c JOIN tasks t ON t.id=c.child_id JOIN task_records r ON r.task_id=t.id WHERE c.parent_id=? AND t.repository_id=? AND t.status IN ('pr_opened','completed','succeeded') AND json_extract(r.acceptance,'$.outcome') IN ('pass','pass_with_issues') LIMIT 20",task.id,task.repository_id).map(r=>'task:'+r.child_id),discovery:{tool:'read_child_tasks',arguments:{}},hint:'Read the source and actual workspace/version context, decide whether to integrate or verify further, then nominate. With no stage plan, omit stage_id when delegating.'});};
 if(typeof ref!=='string'||ref.length>200)return reject('invalid_reference_format');
 const history=/^task_history:(\d+)$/.exec(ref),child=/^task:([^:]+)(?::result)?$/.exec(ref);
 if(!history&&!child)return reject('invalid_reference_format');
 const row=history?s.get('SELECT task_id,type,data FROM task_history WHERE id=?',Number(history[1])):null;
 const sourceId=history?row?.task_id:child![1];
 if(!sourceId)return reject('reference_not_found_or_inaccessible');
 const accessible=sourceId===task.id||!!s.get(`WITH RECURSIVE descendants(id) AS (SELECT child_id FROM task_children WHERE parent_id=? UNION SELECT c.child_id FROM task_children c JOIN descendants d ON c.parent_id=d.id) SELECT 1 FROM descendants d JOIN tasks t ON t.id=d.id WHERE d.id=? AND t.repository_id=?`,task.id,sourceId,task.repository_id);
 if(!accessible)return reject('reference_not_found_or_inaccessible');
 const data=row?JSON.parse(row.data):null;
 if(row&&row.type!=='role_result')return reject('record_type_mismatch',{task_ref:'task:'+sourceId,record_type:row.type});
 if(row&&data.role!=='dev')return reject('role_mismatch',{task_ref:'task:'+sourceId,record_type:row.type,role:data.role});
 if(sourceId===task.id){
  if(!row)return reject('own_task_reference_requires_dev_result');
  const revision=s.get('SELECT revision FROM task_records WHERE task_id=?',task.id)!.revision;
  if(data.contract_revision!==revision)return reject('contract_revision_mismatch',{record_revision:data.contract_revision,current_revision:revision},'role_nomination_stale');
  if(ref!=='task_history:'+latest?.id)return reject('newer_dev_result_available',{},'role_nomination_stale');
  return {source_task_id:sourceId,source_ref:ref,result:data.result,own:true,provenance:{contract_revision:data.contract_revision,record_ref:ref}};
 }
 if(row){const newest=s.get("SELECT id FROM task_history WHERE task_id=? AND type='role_result' AND json_extract(data,'$.role')='dev' ORDER BY id DESC LIMIT 1",sourceId);if(ref!=='task_history:'+newest?.id)return reject('newer_child_dev_result_available',{task_ref:'task:'+sourceId,latest_result_ref:newest?'task_history:'+newest.id:null},'role_nomination_stale');}
 const source=s.get('SELECT t.status,t.result,r.revision,r.candidate,r.acceptance FROM tasks t JOIN task_records r ON r.task_id=t.id WHERE t.id=?',sourceId)!;
 const acceptance=JSON.parse(source.acceptance||'null'),candidate=JSON.parse(source.candidate||'null');
 if(!['pr_opened','completed','succeeded'].includes(source.status)||!['pass','pass_with_issues'].includes(acceptance?.outcome))return reject('child_result_not_accepted',{task_ref:'task:'+sourceId,status:source.status,acceptance:acceptance?.outcome??null});
 if(candidate?.revision!==source.revision||acceptance.revision!==source.revision||acceptance.candidate_id!==candidate?.id||row&&data.contract_revision!==source.revision)return reject('child_contract_revision_mismatch',{task_ref:'task:'+sourceId,current_revision:source.revision,candidate_revision:candidate?.revision??null},'role_nomination_stale');
 const result=JSON.parse(source.result||'null');
 if(!result||typeof result.summary!=='string')return reject('child_result_unavailable',{task_ref:'task:'+sourceId});
 return {source_task_id:sourceId,source_ref:ref,result:{...result,artifacts:result.artifacts??[]},own:false,provenance:{contract_revision:source.revision,candidate_id:candidate.id,acceptance:{outcome:acceptance.outcome,candidate_id:acceptance.candidate_id,revision:acceptance.revision},artifacts:candidate.artifacts.map(({kind,reference,version}:any)=>({kind,reference,version}))}};
}

/** A reused child is evidence; it must still satisfy the receiving entry's result schema. */
export async function validateNominationResult(spec:import('../agent/runtime.js').AgentSpec<any>,result:any){
 try{return spec.finish?await spec.finish.validate(result,spec.finish.name):spec.validate?await spec.validate(JSON.stringify(result)):result;}
 catch(error){throw new SubmissionError('role_nomination_invalid',{reason:'parent_result_contract_mismatch',expected:'A result matching the CURRENT parent entry contract',observed_fields:result&&typeof result==='object'?Object.keys(result).slice(0,30):[],validation_code:String((error as any)?.code??(error as any)?.message??'invalid_result').slice(0,500),hint:'Reuse compatible child evidence, supply the missing parent-specific result through an appropriate role, or choose another coordination action. Child acceptance does not change the parent result schema.'});}
}
