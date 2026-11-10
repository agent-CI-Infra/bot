import {relateTasks} from './followups.js';
import {setTaskPriority} from './priority.js';
import type { Store } from '../storage/database.js';
import { randomId, fields, fail, type Json } from '../core/security.js';
import { type Actor, scope, repository } from '../app/auth.js';
import { TaskRecords } from './service.js';
import { traceEvent } from './trace.js';
import { captureTaskConfiguration } from './configuration.js';
import { stageReplanContext } from '../roles/schedule.js';
const terminal=['succeeded','pr_opened','completed','cancelled','superseded'];
const replies=(kind:string)=>kind.startsWith('review.')||kind.startsWith('workflow.');
/** Shared task mutation boundary for the console, management tools and future message adapters. */
export class TaskCommands {
  constructor(readonly store:Store, readonly hooks:{active?:(id:string)=>boolean;tick?:()=>void}={}){}
  api(user:Actor,method:string,url:URL,input:Json):Json|undefined {
    const relation=/^\/api\/tasks\/([^/]+)\/relate$/.exec(url.pathname);
    if(relation&&method==='POST'){
      fields(input,['task_id','key','relationship','reason','evidence']);const filter=scope(user,'repository_id');const task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,relation[1]!,...filter.args);if(!task)fail(404,'task_not_found');
      try{return relateTasks(this.store,task!,input,'user:'+user.id);}catch(e){return fail(400,(e as Error).message);}
    }
    const priority=/^\/api\/tasks\/([^/]+)\/priority$/.exec(url.pathname);
    if(priority&&method==='POST'){
      fields(input,['priority','reason']);const filter=scope(user,'repository_id');
      const task=this.store.get(`SELECT id,repository_id FROM tasks WHERE id=? AND ${filter.sql}`,priority[1]!,...filter.args);if(!task)fail(404,'task_not_found');
      const result=setTaskPriority(this.store,task!.id,input.priority,input.reason,'user:'+user.id);this.store.audit(user.id,'task.priority',task!.id,task!.repository_id);this.hooks.tick?.();return result;
    }
    const intervention=/^\/api\/tasks\/([^/]+)\/(pause|cancel|instructions|adopt-config)$/.exec(url.pathname);
    if(intervention&&method==='POST'){
      const filter=scope(user,'repository_id'),task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,intervention[1]!,...filter.args);
      if(!task)return fail(404,'task_not_found');
      const action=intervention[2]!,records=new TaskRecords(this.store);
      fields(input,action==='instructions'?['instruction']:[]);
      if(terminal.includes(task.status))fail(409,'task_already_delivered');
      if(action==='adopt-config'&&(this.hooks.active?.(task.id)||task.status==='running'))fail(409,'pause_and_wait_for_checkpoint');
      if(action==='adopt-config'&&this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",task.id))fail(409,'task_config_after_publication');
      this.store.transaction(()=>{
        if(action==='instructions'){
          if(typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>16000)fail(400,'invalid_task_instruction');
          records.history(task.id,'supplemental_instruction',{instruction:input.instruction,actor:user.id});
        }else if(action==='adopt-config'){
          const previous=this.store.get('SELECT revision FROM task_execution_configs WHERE task_id=?',task.id)?.revision??0;
          this.store.run('DELETE FROM task_execution_configs WHERE task_id=?',task.id);
          // RoleDefinitionV2 rebinds the same instances on the next run, preserving their snapshot lineage.
          this.store.run("UPDATE role_instances SET session='[]',harness_state='{}' WHERE task_id=?",task.id);
          this.store.run("UPDATE task_records SET candidate=NULL,acceptance=NULL,pending=NULL,rounds=0 WHERE task_id=?",task.id);
          const saved=JSON.parse(task.input||'{}');
          this.store.run("UPDATE tasks SET input=?,status='queued',phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,publication_started=0,error_code=NULL,next_run_at=0,attempt=attempt+1 WHERE id=?",JSON.stringify({...saved,configuration_revision:previous+1}),task.id);
          records.history(task.id,'configuration_adopted',{previous_revision:previous,revision:previous+1,actor:user.id,previous_run:this.store.get('SELECT id FROM task_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1',task.id)?.id??null});
        }else{
          // Revoke the execution claim first. A late model/tool result cannot overwrite the intervention.
          this.store.run('DELETE FROM task_claims WHERE task_id=?',task.id);
          this.store.run('UPDATE tasks SET status=?,claim_token=NULL,error_code=?,updated_at=? WHERE id=?',action==='pause'?'paused':'cancelled','user_'+action,new Date().toISOString(),task.id);
          this.store.run("UPDATE task_runs SET status='interrupted',ended_at=?,stop_reason=? WHERE task_id=? AND status='running'",new Date().toISOString(),'user_'+action,task.id);
        }
        traceEvent(this.store,task.id,'intervention',{action,...input,...(action==='adopt-config'?{stage_plan:stageReplanContext(this.store,task.id)}:{})},null,'user:'+user.id);
        this.store.audit(user.id,'task.'+action,task.id,task.repository_id);
      });
      if(action==='adopt-config')this.hooks.tick?.();
      return {task:records.get(task.id)};
    }
    const contractMatch=/^\/api\/tasks\/([^/]+)\/contract$/.exec(url.pathname);
    if(contractMatch&&method==='PATCH'){
      fields(input,['contract','expected_revision']);const filter=scope(user,'repository_id');
      const task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,contractMatch[1]!,...filter.args);
      if(!task)fail(404,'task_not_found');
      if(this.hooks.active?.(task!.id)||task!.status==='running')fail(409,'task_already_running');
      if(terminal.includes(task!.status)||this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",task!.id))fail(409,'task_contract_after_publication');
      if(!Number.isSafeInteger(input.expected_revision))fail(400,'invalid_task_revision');
      const records=new TaskRecords(this.store),contract={...(input.contract as any),source:{type:'human_revision',actor:user.id},completeness:'explicit'};
      records.atomic(()=>{
        try{records.contract(task!.id,contract,Number(input.expected_revision));}catch(error){fail((error as Error).message==='task_revision_changed'?409:400,(error as Error).message);}
        const saved=JSON.parse(task!.input);
        this.store.run("UPDATE tasks SET input=?,status='queued',phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,publication_started=0,error_code=NULL,next_run_at=0,attempt=attempt+1 WHERE id=?",JSON.stringify({...saved,contract,request:task!.kind==='task.request'?contract.goal:saved.request}),task!.id);
        this.store.run("DELETE FROM github_effects WHERE task_id=? AND state='pending'",task!.id);
        this.store.run('DELETE FROM development_candidates WHERE task_id=?',task!.id);
        traceEvent(this.store,task!.id,'intervention',{action:'contract_revision',before:new TaskRecords(this.store).get(task!.id).revision-1,after:contract,reason:'explicit user contract revision',stage_plan:stageReplanContext(this.store,task!.id)},null,'user:'+user.id);
        this.store.audit(user.id,'task.contract',task!.id,task!.repository_id);
      });this.hooks.tick?.();return {task:new TaskRecords(this.store).get(task!.id)};
    }
    const contextMatch=/^\/api\/repositories\/([^/]+)\/context$/.exec(url.pathname);
    if(contextMatch&&(method==='GET'||method==='PATCH')){
      repository(this.store,user,contextMatch[1]!);const records=new TaskRecords(this.store);
      if(method==='GET')return {context:records.project(contextMatch[1]!)};
      fields(input,['facts','expected_revision']);
      if(!Number.isSafeInteger(input.expected_revision)||Number(input.expected_revision)<0)fail(400,'invalid_project_revision');
      try{records.setProject(contextMatch[1]!,input.facts as any,Number(input.expected_revision));}
      catch(error){fail((error as Error).message==='project_revision_changed'?409:400,(error as Error).message);}
      this.store.audit(user.id,'project.context',contextMatch[1]!,contextMatch[1]!);return {context:records.project(contextMatch[1]!)};
    }
    if(url.pathname==='/api/tasks'&&method==='POST') {
      fields(input,['repository_id','request','contract']);
      if(typeof input.repository_id!=='string'||typeof input.request!=='string'||!input.request.trim()||input.request.length>60000)fail(400,'invalid_task_request');
      repository(this.store,user,input.repository_id as string);
      const id=randomId(),now=new Date().toISOString();
      const contract=input.contract as any;
      if(!contract||!Array.isArray(contract.criteria)||!contract.criteria.length||typeof contract.endpoint!=='string'||!contract.endpoint.trim())fail(400,'invalid_task_contract');
      // Validate before insertion; rollback also removes trigger-created records on failure.
      this.store.transaction(()=>{
        this.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,created_at,updated_at) VALUES(?,?,'task.request','queued',?,?,?,?)",id,input.repository_id as string,(input.request as string).slice(0,160),JSON.stringify({request:input.request,contract}),now,now);
        try {new TaskRecords(this.store).contract(id,{...contract,source:{type:'request',actor:user.id},completeness:'explicit'});}catch{fail(400,'invalid_task_contract');}
        // Persist the authoritative validated contract for executor recovery.
        this.store.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify({request:input.request,contract:new TaskRecords(this.store).get(id).contract}),id);
        captureTaskConfiguration(this.store,id);
        if (user.context) this.store.run('INSERT INTO task_authorizations VALUES(?,?,?,?,?)', id, user.context.principal_id,
          this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', input.repository_id as string)!.tenant_id, input.repository_id as string, 'tasks.write');
        this.store.audit(user.id,'task.create',id,input.repository_id as string);
      });this.hooks.tick?.();return {id};
    }
    const match=/^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);if(!match||method!=='POST')return undefined;
    fields(input,[]);const filter=scope(user,'repository_id'),task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);
    if(!task)return fail(404,'task_not_found');
    if(this.hooks.active?.(task.id)||['queued','running','preparing','implementing','validating','publishing','result_ready'].includes(task.status))fail(409,'task_already_running');
    if(!['paused','waiting_coordination','failed','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','waiting_pr_head','retry_wait','needs_replan'].includes(task.status))fail(409,'task_not_retryable');
    this.store.transaction(()=>{
      // A publish-phase task restarts only when re-planning it cannot strand a branch or PR it already wrote.
      const wrote=!!this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",task.id);
      if(task.kind!=='task.request'&&(replies(task.kind)&&!wrote || (task.phase!=='publish'||task.status==='needs_replan'&&!wrote)&&['failed','waiting_environment','needs_replan'].includes(task.status))){
        this.store.run("UPDATE tasks SET phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,review_update_cursor=0,publication_started=0,attempt=attempt+1 WHERE id=?",task.id);
        if(replies(task.kind))this.store.run("DELETE FROM github_effects WHERE task_id=? AND state='pending'",task.id);
        this.store.run('DELETE FROM development_candidates WHERE task_id=?',task.id);
      }
      // Pressing 重试 on 发布待确认 is the confirmation the pause waits for: the write is looked up once more and,
      // only if GitHub still has no trace of it, sent again.
      if(task.status==='waiting_publication')this.store.run("UPDATE github_effects SET state='recheck' WHERE task_id=? AND state IN ('unknown','inflight')",task.id);
      this.store.run("UPDATE tasks SET status='queued',error_code=NULL,next_run_at=0,retry_count=0,wait_count=0,retry_error_code=NULL,retry_cycle_started_at=NULL WHERE id=?",task.id);
      traceEvent(this.store,task.id,'intervention',{action:'retry',stage_plan:stageReplanContext(this.store,task.id)},null,'user:'+user.id);
      this.store.audit(user.id,'task.retry',task.id,task.repository_id);
    });this.hooks.tick?.();return {ok:true};
  }
}
