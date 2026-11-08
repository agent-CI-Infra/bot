import {requestCoordination,validCoordination,coordinationContext,coordinationVersion,assertCoordinationCurrent,acknowledgeCoordination,type CoordinationRequest} from './coordination.js';
import {recordScopeDifference,scopeDifferences} from './scope.js';
import { stop } from '../agent/common.js';
import type { Store } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { createHash } from 'node:crypto';
import { playbooks } from './playbooks.js';
import { captureTaskConfiguration } from './configuration.js';

export interface Contract { goal: string; scope: string[]; constraints?: string[]; criteria: string[]; endpoint: string | null; source: unknown; completeness?: string }
export interface Artifact { kind: string; reference: string; version: string; content?: unknown }
export interface Evidence { source: string; version: string; verified: boolean; result: unknown }
export interface Candidate { id: string; revision: number; artifacts: Artifact[]; evidence: Evidence[]; claims: unknown; created_at: string; coordination_version?: string }
export type Outcome = 'pass' | 'pass_with_issues' | 'return' | 'insufficient_evidence' | 'needs_human';
export interface Residual { key: string; description: string; evidence: string; impact: string; nonblocking_reason: string; goal: string; criteria: string[] }
export interface Verdict { coordination?: CoordinationRequest; outcome: Outcome; reason: string; gaps: string[]; residuals: Residual[]; core_complete: boolean; required_evidence_complete: boolean; acceptable_risk: boolean }
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const outcomes = new Set(['pass','pass_with_issues','return','insufficient_evidence','needs_human']);
export function validateVerdict(value: any): Verdict {
  if (!value || !outcomes.has(value.outcome) || typeof value.reason !== 'string' || !value.reason.trim() || !Array.isArray(value.gaps) || value.gaps.some((x: unknown)=>typeof x!=='string') ||
    !Array.isArray(value.residuals) || ['core_complete','required_evidence_complete','acceptable_risk'].some(k=>typeof value[k]!=='boolean')) throw new Error('invalid_acceptance_result');
  if(value.coordination!==undefined&&(!validCoordination(value.coordination)||value.outcome!=='needs_human'))throw new Error('invalid_acceptance_coordination');
  const passing = ['pass','pass_with_issues'].includes(value.outcome);
  if (passing && (!value.core_complete || !value.required_evidence_complete || !value.acceptable_risk || value.gaps.length)) throw new Error('acceptance_core_incomplete');
  if (!passing && !value.gaps.length) throw new Error('acceptance_gap_required');
  if (value.outcome === 'pass_with_issues' ? !value.residuals.length : value.residuals.length) throw new Error('acceptance_residual_mismatch');
  const keys = new Set();
  for (const r of value.residuals) {
    if (!r || ['key','description','evidence','impact','nonblocking_reason','goal'].some(k=>typeof r[k]!=='string'||!r[k].trim()) || !Array.isArray(r.criteria)||!r.criteria.length||r.criteria.some((x:unknown)=>typeof x!=='string'||!x.trim())||keys.has(r.key)) throw new Error('invalid_acceptance_residual');
    keys.add(r.key);
  }
  return value;
}
export class TaskRecords {
  constructor(readonly store: Store) {}
  atomic<T>(fn:()=>T):T {
    const name='task_'+randomId();this.store.db.exec('SAVEPOINT '+name);
    try {const result=fn();this.store.db.exec('RELEASE '+name);return result;}
    catch(error){this.store.db.exec('ROLLBACK TO '+name);this.store.db.exec('RELEASE '+name);throw error;}
  }
  assertClaim(id: string, token?: string) {
    if(!token)return;
    const task=this.store.get('SELECT claim_token,status FROM tasks WHERE id=?',id),claim=this.store.get('SELECT token FROM task_claims WHERE task_id=?',id);
    if(task?.claim_token!==token||claim?.token!==token||['cancelled','superseded'].includes(task?.status))stop('task_claim_revoked','cancelled','任务执行权已变化，拒绝提交旧执行的状态。');
  }
  history(id: string, type: string, data: unknown,runId?:string|null) {
    const value=data as any;
    const evaluated=(type==='acceptance'||type==='acceptance_staged')&&typeof value?.candidate_id==='string'&&Number.isSafeInteger(value?.revision)?this.store.get("SELECT h.id,h.run_id FROM task_history h JOIN task_runs r ON r.id=h.run_id WHERE h.task_id=? AND h.type='acceptance_evaluated' AND json_extract(h.data,'$.candidate_id')=? AND r.revision=? ORDER BY h.id DESC LIMIT 1",id,value.candidate_id,value.revision):undefined;
    this.store.run('INSERT INTO task_history(task_id,type,data,created_at,run_id,caused_by) VALUES(?,?,?,?,?,?)',id,type,JSON.stringify(data),new Date().toISOString(),runId??evaluated?.run_id??null,JSON.stringify(evaluated?['task_history:'+evaluated.id]:[]));
  }
  get(id: string) {
    const r=this.store.get('SELECT * FROM task_records WHERE task_id=?',id),t=this.store.get('SELECT * FROM tasks WHERE id=?',id);
    if (!r||!t) throw new Error('task_not_found');
    return {contract:JSON.parse(r.contract) as Contract, revision:Number(r.revision), progress:{status:t.status,phase:t.phase,attempt:t.attempt,completed:JSON.parse(r.completed),next_action:r.next_action,waiting_reason:/^(waiting_|retry_wait$|needs_replan$|failed$)/.test(t.status)?t.error_code:null},
      selections:JSON.parse(r.selections),candidate:r.candidate?JSON.parse(r.candidate) as Candidate:null,acceptance:r.acceptance?JSON.parse(r.acceptance):null,pending:r.pending?JSON.parse(r.pending):null,rounds:Number(r.rounds),
      coordination:coordinationContext(this.store,id),scope_differences:scopeDifferences(this.store,id),project:{repository_id:t.repository_id,context:this.project(t.repository_id)},followups:this.store.all('SELECT candidate_id,issue_key,task_id FROM task_followups WHERE parent_id=?',id)};
  }
  project(id: string) { const row=this.store.get('SELECT * FROM project_context WHERE repository_id=?',id);return row?{revision:row.revision,facts:JSON.parse(row.facts),updated_at:row.updated_at}:null; }
  setProject(id: string, facts: {source:string;fact:string}[], expectedRevision: number) {
    if (!Array.isArray(facts)||facts.some(f=>!f||typeof f.source!=='string'||!f.source.trim()||typeof f.fact!=='string'||!f.fact.trim())) throw new Error('project_fact_source_required');
    this.atomic(()=>{
      const current=this.project(id);if((current?.revision||0)!==expectedRevision)throw new Error('project_revision_changed');
      if(current&&JSON.stringify(current.facts)===JSON.stringify(facts))return;
      this.store.run('INSERT INTO project_context VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET revision=excluded.revision,facts=excluded.facts,updated_at=excluded.updated_at',id,expectedRevision+1,JSON.stringify(facts),new Date().toISOString());
    });
  }
  contract(id: string, value: Contract, expectedRevision?: number) {
    if(value?.constraints!==undefined&&(!Array.isArray(value.constraints)||value.constraints.some(c=>typeof c!=='string'||!c.trim())))throw new Error('invalid_task_constraints');
    if (!value || typeof value.goal!=='string'||!value.goal.trim()||!Array.isArray(value.scope)||!Array.isArray(value.criteria)||[...value.scope,...value.criteria].some(x=>typeof x!=='string'||!x.trim())||!(value.endpoint===null||typeof value.endpoint==='string')) throw new Error('invalid_task_contract');
    this.atomic(()=>{
    const current=this.get(id);if(expectedRevision!==undefined&&expectedRevision!==current.revision)throw new Error('task_revision_changed');
    if (JSON.stringify(current.contract)===JSON.stringify(value))return;
    if(['completed','succeeded','pr_opened'].includes(current.progress.status))throw new Error('task_already_delivered');
    this.store.run("UPDATE task_records SET contract=?,revision=revision+1,candidate=NULL,acceptance=NULL,pending=NULL,rounds=0,completed='[]',next_action=NULL WHERE task_id=?",JSON.stringify(value),id);
    this.history(id,'contract',{previous_revision:current.revision,revision:current.revision+1,contract:value,previous_progress:current.progress});
    });
  }

  progress(id: string, completed: string[], next: string) {
    if(!Array.isArray(completed)||completed.some(x=>typeof x!=='string')||typeof next!=='string')throw new Error('invalid_task_progress');
    this.atomic(()=>{
    this.store.run('UPDATE task_records SET completed=?,next_action=? WHERE task_id=?',JSON.stringify(completed),next,id);this.history(id,'checkpoint',{completed,next_action:next});
    });
  }

  tool(id: string, name: string, args: any) {
    if(name==='read_coordination')return coordinationContext(this.store,id);
    if(name==='acknowledge_coordination')return acknowledgeCoordination(this.store,id,args);
    if(name==='record_scope_difference')return recordScopeDifference(this.store,id,args);
    if(name==='read_task_history'){
      const offset=args?.offset??0,limit=args?.limit??10;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)return {error:'invalid_history_page'};
      const clip=(value:any):any=>typeof value==='string'&&value.length>12000?value.slice(0,12000)+' [truncated; original retained in task_history]':Array.isArray(value)?value.map(clip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clip(v)])):value;
      const filter="task_id=? AND type IN ('coordination_requested','coordination_notice','coordination_acknowledged','coordination_result','coordination_fault','scope_difference','checkpoint','artifact_checkpoint','execution_evidence','acceptance','acceptance_fault','inherited_artifact','memory_search','memory_read','memory_fault','role_handoff','role_result','role_candidate','role_record_read','delivery_nominated','role_assignment_fault','role_result_normalized')";
      const total=Number(this.store.get('SELECT count(*) n FROM task_history WHERE '+filter,id)!.n);
      const rows=this.store.all('SELECT id,type,data,created_at FROM task_history WHERE '+filter+' ORDER BY id DESC LIMIT ? OFFSET ?',id,limit,offset).reverse();
      return {total,offset,next_offset:offset+rows.length<total?offset+rows.length:null,observations:rows.map(row=>({...row,data:clip(JSON.parse(row.data))}))};
    }
    if(name==='read_playbook'){
      if(!args?.id)return playbooks.map(({content,...p})=>p);
      const guide=playbooks.find(p=>p.id===args.id);if(!guide)return {error:'playbook_not_found'};
      this.history(id,'playbook_read',{id:guide.id,version:guide.version});return guide;
    }
    if(name==='record_progress'){if(!Array.isArray(args?.completed)||args.completed.some((x:unknown)=>typeof x!=='string')||typeof args?.next_action!=='string')return {error:'invalid_task_progress'};this.progress(id,args.completed,args.next_action);return {ok:true};}
    if(name==='select_playbooks'){
      const selections=args?.selections;
      const read=new Set(this.store.all("SELECT data FROM task_history WHERE task_id=? AND type='playbook_read'",id).map(row=>{const p=JSON.parse(row.data);return p.id+':'+p.version;}));
      if(!Array.isArray(selections)||new Set(selections.map(s=>s?.id)).size!==selections.length||selections.some(s=>!playbooks.some(p=>p.id===s?.id&&p.version===s?.version)||!read.has(s.id+':'+s.version)||typeof s.purpose!=='string'||!s.purpose.trim()))return {error:'invalid_playbook_selection'};
      this.store.run('UPDATE task_records SET selections=? WHERE task_id=?',JSON.stringify(selections),id);this.history(id,'playbooks',{selections});return {ok:true};
    }
    return {error:'tool_not_allowed'};
  }
  submit(id: string, artifacts: Artifact[], evidence: Evidence[], claims: unknown, token?: string): Candidate {
    return this.atomic(()=>{
    this.assertClaim(id,token);
    const current=this.get(id);
    if(!Array.isArray(artifacts)||!artifacts.length||artifacts.some(a=>!a||!a.kind||!a.reference||!a.version)||!Array.isArray(evidence)||evidence.some(e=>!e||!e.source||!e.version||typeof e.verified!=='boolean'))throw new Error('invalid_task_candidate');
    const executionRevision=this.store.get('SELECT revision FROM task_execution_configs WHERE task_id=?',id)?.revision??JSON.parse(this.store.get('SELECT input FROM tasks WHERE id=?',id)!.input||'{}').configuration_revision??1;
    const coordination_version=coordinationVersion(this.store,id);
    const key=hash({...(coordination_version?{coordination_version}:{}),revision:current.revision,execution_revision:executionRevision,artifacts,evidence,claims});
    if(current.candidate?.id===key)return current.candidate;
    if(['completed','succeeded','pr_opened'].includes(current.progress.status))throw new Error('task_already_delivered');
    const candidate={id:key,...(coordination_version?{coordination_version}:{}),revision:current.revision,artifacts,evidence,claims,created_at:new Date().toISOString()};
    this.store.run('UPDATE task_records SET candidate=?,acceptance=NULL,pending=NULL WHERE task_id=?',JSON.stringify(candidate),id);this.history(id,'candidate',candidate);return candidate;
    });
  }

  stage(id: string, candidateId: string, revision: number, verdict: Verdict, token?: string, binding?: {policy_hash:string}) {
    return this.atomic(()=>{
    this.assertClaim(id,token);validateVerdict(verdict);const current=this.get(id);
    assertCoordinationCurrent(this.store,id,current.candidate);
    if(current.candidate?.id!==candidateId||current.revision!==revision)throw new Error('stale_acceptance');
    this.store.run('UPDATE task_records SET pending=? WHERE task_id=?',JSON.stringify({...verdict,...binding,candidate_id:candidateId,revision}),id);
    this.history(id,'acceptance_staged',{...verdict,candidate_id:candidateId,revision});
    });
  }

  /** One local commit: decision, residual tasks, lineage and original completion. Replays never re-open children. */
  decide(id: string, candidateId: string, revision: number, verdict: Verdict, successStatus='completed', finalize=true, token?: string) {
    validateVerdict(verdict);
    return this.atomic(()=>{
      this.assertClaim(id,token);
      const current=this.get(id),task=this.store.get('SELECT * FROM tasks WHERE id=?',id)!;
      if(!current.candidate||current.candidate.id!==candidateId||current.revision!==revision)throw new Error('stale_acceptance');
      if(['pass','pass_with_issues'].includes(verdict.outcome))assertCoordinationCurrent(this.store,id,current.candidate);
      if(['cancelled','superseded'].includes(task.status))throw new Error('task_cancelled');
      if(current.acceptance?.candidate_id===candidateId) {
        const {candidate_id:_,revision:_revision,followups:_followups,created_at:_time,exhausted:_exhausted,...previous}=current.acceptance;
        if(['pass','pass_with_issues'].includes(previous.outcome))return current.acceptance;
        if(hash(previous)===hash(verdict)){
          this.store.run("UPDATE tasks SET status='needs_replan',phase='acceptance',error_code='acceptance_no_progress' WHERE id=?",id);
          const ended={...current.acceptance,exhausted:true};this.store.run('UPDATE task_records SET acceptance=? WHERE task_id=?',JSON.stringify(ended),id);
          this.history(id,'acceptance_no_progress',{candidate_id:candidateId,reason:'identical rejected candidate and verdict'});return ended;
        }
      }
      if(['completed','succeeded','pr_opened'].includes(task.status))throw new Error('task_already_delivered');
      const followups:string[]=[];
      for(const residual of verdict.residuals){
        const child=randomId(),now=new Date().toISOString();
        const input={request:residual.goal,contract:{goal:residual.goal,scope:current.contract.scope,criteria:residual.criteria,endpoint:'artifact',completeness:'inherited',source:{parent_task:id,parent_revision:current.revision,candidate_id:candidateId,residual:residual.key}},
          parent_task:id,residual,authorization:'inherited; no additional publication or merge rights'};
        // Follow-ups use the ordinary request executor. No GitHub write or expanded policy is inherited.
        this.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,source_task_id,created_at,updated_at) VALUES(?,?,'task.request','queued',?,?,?,?,?,?)`,child,task.repository_id,residual.goal,`residual:${id}:${candidateId}:${residual.key}`,JSON.stringify(input),id,now,now);
        this.store.run('UPDATE task_records SET contract=? WHERE task_id=?',JSON.stringify(input.contract),child);
        captureTaskConfiguration(this.store,child);
        this.store.run('INSERT INTO task_followups VALUES(?,?,?,?)',id,candidateId,residual.key,child);followups.push(child);
      }
      const rounds=current.rounds+1,passing=['pass','pass_with_issues'].includes(verdict.outcome);
      const exhausted=!passing&&verdict.outcome!=='needs_human'&&rounds>=3;
      const acceptance={...verdict,candidate_id:candidateId,revision,followups,created_at:new Date().toISOString(),exhausted};
      this.store.run('UPDATE task_records SET acceptance=?,rounds=?,pending=NULL,next_action=? WHERE task_id=?',JSON.stringify(acceptance),rounds,passing?null:verdict.gaps.join('; '),id);
      const status=passing?successStatus:verdict.outcome==='needs_human'||exhausted?'needs_replan':'queued';
      this.store.run('UPDATE tasks SET status=?,phase=?,error_code=?,next_run_at=0,updated_at=? WHERE id=?',status,passing?(finalize?'done':task.phase):verdict.outcome==='needs_human'||exhausted?'acceptance':'prepare',passing?null:exhausted?'acceptance_no_progress':`acceptance_${verdict.outcome}`,new Date().toISOString(),id);
      this.history(id,'acceptance',acceptance);
      if(verdict.outcome==='needs_human'&&verdict.coordination){const request=requestCoordination(this.store,task,verdict.coordination);this.store.run("UPDATE tasks SET status='waiting_coordination',error_code='task_coordination_requested' WHERE id=?",id);return {...acceptance,coordination_requested:request.coordination_id};}
      return acceptance;
    });
  }
}
