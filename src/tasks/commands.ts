import {requestedTask} from '../work/catalog.js';
import {taskPermissions} from './configuration.js';
import {attachChild} from './children.js';
import {roleConfiguration} from '../roles/definition.js';
import {relateTasks} from './followups.js';
import {setTaskPriority} from './priority.js';
import type { Store, Row } from '../storage/database.js';
import { randomId, fields, fail, digest, object, HttpError, type Json } from '../core/security.js';
import { type Actor, scope, repository } from '../app/auth.js';
import { TaskRecords } from './service.js';
import { traceEvent } from './trace.js';
import { captureTaskConfiguration } from './configuration.js';
import { stageReplanContext } from '../roles/schedule.js';
import { assertManagedTask, assertManagedExecution, assertTaskCaller, createManagedTask, operatorTaskCaller, taskCallerActor, type TaskCaller } from './management.js';
import { TaskError } from '../agent/common.js';
import { readEvidence } from './evidence.js';
import { taskTraceAccess } from '../memory/access.js';
import { assertRequestPullRequest, softwareRequest } from './pull-request.js';
const terminal=['succeeded','pr_opened','completed','cancelled','superseded'];
const replies=(kind:string)=>kind.startsWith('review.')||kind.startsWith('workflow.');
/** Shared task mutation boundary for the console, management tools and future message adapters. */
export class TaskCommands {
  constructor(readonly store:Store, readonly hooks:{active?:(id:string)=>boolean;tick?:()=>void}={}){}
  private sourceVisible(task:Row):boolean{
    try{assertManagedExecution(this.store,task);return true;}
    catch(error){if(error instanceof HttpError||error instanceof TaskError)return false;throw error;}
  }
  /** The role caller is an issued object supplied only by trusted runtime/transport code, never an HTTP field. */
  api(user:Actor,method:string,url:URL,input:Json,caller?:TaskCaller):Json|undefined {
    const target = /^\/api\/tasks\/([^/]+)\//.exec(url.pathname);
    if (caller) {
      assertTaskCaller(this.store,caller,true);
      if (url.pathname === '/api/tasks' && method === 'POST') {
        if (input.repository_id !== caller.project_id) fail(403,'task_project_mismatch');
      } else if (target) assertManagedTask(this.store,caller,target[1]!,true);
      else return fail(403,'task_operation_forbidden');
    } else if (target && method !== 'GET') {
      const project=this.store.get('SELECT repository_id FROM tasks WHERE id=?',target[1]!)?.repository_id;
      if(project) operatorTaskCaller(this.store,user,project);
    }
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
        this.store.run("UPDATE tasks SET input=?,status='queued',phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,publication_started=0,error_code=NULL,next_run_at=0,attempt=attempt+1 WHERE id=?",JSON.stringify({...saved,contract,request:requestedTask(task!)?contract.goal:saved.request}),task!.id);
        this.store.run("DELETE FROM github_effects WHERE task_id=? AND state='pending'",task!.id);
        this.store.run('DELETE FROM development_candidates WHERE task_id=?',task!.id);
        traceEvent(this.store,task!.id,'intervention',{action:'contract_revision',before:new TaskRecords(this.store).get(task!.id).revision-1,after:contract,reason:'explicit user contract revision',stage_plan:stageReplanContext(this.store,task!.id)},null,'user:'+user.id);
        const revised=this.store.get('SELECT * FROM tasks WHERE id=?',task!.id)!;
        if(softwareRequest(revised))try{assertRequestPullRequest(this.store,revised);}catch(error){if(error instanceof TaskError)fail(403,error.code);throw error;}
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
      fields(input,['repository_id','request','contract','intent',...(caller?['executor_role','execute','as_child']:[])]);
      if(typeof input.repository_id!=='string'||typeof input.request!=='string'||!input.request.trim()||input.request.length>60000)fail(400,'invalid_task_request');
      repository(this.store,user,input.repository_id as string);
      const id=randomId(),now=new Date().toISOString();
      const contract=input.contract as any;
      if(!contract||!Array.isArray(contract.criteria)||!contract.criteria.length||typeof contract.endpoint!=='string'||!contract.endpoint.trim())fail(400,'invalid_task_contract');
      if(input.intent!==undefined&&!['report','development'].includes(String(input.intent)))fail(400,'invalid_task_intent');
      const development=input.intent==='development'||input.intent===undefined&&contract.endpoint==='reviewable_pull_request',kind=development?'task.development':'task.request';
      if(development&&contract.endpoint!=='reviewable_pull_request'||input.intent==='report'&&contract.endpoint!=='report')fail(400,'invalid_task_endpoint');
      const controller=roleConfiguration(this.store,String(input.repository_id)).controller.role;
      const team=!!caller&&caller.role===controller&&input.executor_role===undefined;
      if(team){const definition=roleConfiguration(this.store,caller!.project_id).roles.find(r=>r.role_id===caller!.role);
        if(caller!.permissions?.delegation!=='allow'||definition?.permissions.delegation!=='allow')fail(403,'task_delegation_forbidden');}
      if(development){
        // Development uses the project's ordinary development work type. Parent linkage adds no authority.
        try{assertRequestPullRequest(this.store,{id:'',kind,repository_id:input.repository_id,input:JSON.stringify({contract})});}catch(error){if(error instanceof TaskError)fail(403,error.code);throw error;}
        if(caller?.source_task_id){const source=this.store.get('SELECT * FROM tasks WHERE id=? AND repository_id=?',caller.source_task_id,caller.project_id);
          if(!source||!['code','pull_request'].every(write=>taskPermissions(this.store,source).writes.includes(write)))fail(403,'task_external_write_forbidden');}
      }
      // Validate before insertion; rollback also removes trigger-created records on failure.
      if (caller && (input.executor_role !== undefined && typeof input.executor_role !== 'string' || input.execute !== undefined && typeof input.execute !== 'boolean')) fail(400,'invalid_task_executor');
      if(input.as_child!==undefined&&typeof input.as_child!=='boolean')fail(400,'invalid_child_task');
      if(input.as_child&&(!caller?.source_task_id||caller.role!==roleConfiguration(this.store,caller.project_id).controller.role))fail(403,'child_task_manager_required');
      if(input.as_child){
        const controller=roleConfiguration(this.store,caller!.project_id).roles.find(r=>r.role_id===caller!.role);
        if(caller!.permissions?.delegation!=='allow'||controller?.permissions.delegation!=='allow')fail(403,'task_delegation_forbidden');
        const parent=this.store.get('SELECT * FROM tasks WHERE id=? AND repository_id=?',caller!.source_task_id!,caller!.project_id);
        if(!parent)fail(403,'task_project_mismatch');
        if(contract.endpoint==='reviewable_pull_request'&&!['code','pull_request'].every(write=>taskPermissions(this.store,parent!).writes.includes(write)))fail(403,'task_external_write_forbidden');
      }
      const key=caller?'managed:'+digest(JSON.stringify([caller.owner_key,caller.source_message,caller.source_task_id,
        caller.source_task_id?this.store.get('SELECT revision FROM task_records WHERE task_id=?',caller.source_task_id)?.revision:null,input.request,contract,input.executor_role??caller.role,...(input.as_child?['child']:[]),...(development?['development']:[])])):null;
      const legacyKey=development&&caller?'managed:'+digest(JSON.stringify([caller.owner_key,caller.source_message,caller.source_task_id,
        caller.source_task_id?this.store.get('SELECT revision FROM task_records WHERE task_id=?',caller.source_task_id)?.revision:null,input.request,contract,input.executor_role??caller.role,...(input.as_child?['child']:[])])):null;
      const previous=key?this.store.get('SELECT id FROM tasks WHERE unique_key=?',key)??(legacyKey?this.store.get("SELECT id FROM tasks WHERE unique_key=? AND kind='task.request'",legacyKey):undefined):undefined;
      if(previous){assertManagedTask(this.store,caller!,previous.id,true);return {id:previous.id,replayed:true};}
      this.store.transaction(()=>{createManagedTask(this.store,caller??operatorTaskCaller(this.store,user,String(input.repository_id)),input.executor_role as string|undefined,()=>{
        this.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,unique_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",id,input.repository_id as string,kind,input.execute===false?'paused':'queued',(input.request as string).slice(0,160),JSON.stringify({request:input.request,contract}),key,now,now);
        try {new TaskRecords(this.store).contract(id,{...contract,source:{type:'request',actor:user.id},completeness:'explicit'});}catch{fail(400,'invalid_task_contract');}
        // Persist the authoritative validated contract for executor recovery.
        this.store.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify({request:input.request,contract:new TaskRecords(this.store).get(id).contract}),id);
        captureTaskConfiguration(this.store,id);
        if(input.as_child)attachChild(this.store,caller!.source_task_id!,id);
        if (user.context) this.store.run('INSERT INTO task_authorizations VALUES(?,?,?,?,?)', id, user.context.principal_id,
          this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', input.repository_id as string)!.tenant_id, input.repository_id as string, caller?'tasks.manage_own':'tasks.write');
        this.store.audit(user.id,'task.create',id,input.repository_id as string);
        return id;
      });
      // The Task Manager coordinates the same project team, independently of parent linkage.
      if(team)this.store.run('UPDATE task_origins SET executor_role=NULL WHERE task_id=?',id);
      const created=this.store.get('SELECT * FROM tasks WHERE id=?',id)!;
      if(softwareRequest(created))try{assertRequestPullRequest(this.store,created);}catch(error){if(error instanceof TaskError)fail(403,error.code);throw error;}
      });this.hooks.tick?.();return {id};
    }
    const match=/^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);if(!match||method!=='POST')return undefined;
    fields(input,[]);const filter=scope(user,'repository_id'),task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);
    if(!task)return fail(404,'task_not_found');
    if(this.hooks.active?.(task.id)||['queued','running','preparing','implementing','validating','publishing','result_ready'].includes(task.status))fail(409,'task_already_running');
    if(!['paused','waiting_coordination','failed','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','waiting_pr_head','retry_wait','needs_replan','needs_help'].includes(task.status))fail(409,'task_not_retryable');
    this.store.transaction(()=>{
      // A publish-phase task restarts only when re-planning it cannot strand a branch or PR it already wrote.
      const wrote=!!this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",task.id);
      if(!requestedTask(task)&&(replies(task.kind)&&!wrote || (task.phase!=='publish'||task.status==='needs_replan'&&!wrote)&&['failed','waiting_environment','needs_replan'].includes(task.status))){
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
  /** Model tools, conversations and role runs all call the same API mutations and ownership checks. */
  tool(caller:TaskCaller,name:string,args:any):Json {
    args=object(args);
    assertTaskCaller(this.store,caller,!['list_managed_tasks','read_managed_task'].includes(name));
    const actor=taskCallerActor(this.store,caller),user:Actor={id:caller.principal_id??'role:'+caller.role,username:caller.role??'operator',role:'project_admin',csrf:'',repositories:[caller.project_id],context:actor};
    if(name==='list_managed_tasks'){
      fields(args,['offset','limit']);const offset=args.offset??0,limit=args.limit??20;
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'invalid_pagination');
      const rows=this.store.all('SELECT t.id,t.repository_id,t.kind,t.status,t.summary,t.updated_at,o.executor_role,o.conversation_id FROM tasks t JOIN task_origins o ON o.task_id=t.id WHERE o.project_id=? AND o.owner_key=? ORDER BY t.created_at DESC,t.id LIMIT ? OFFSET ?',caller.project_id,caller.owner_key,limit+1,offset);
      return {tasks:rows.slice(0,limit).map(row=>this.sourceVisible(this.store.get('SELECT * FROM tasks WHERE id=?',row.id)!)?row:
        {...row,summary:'[原来源已变化，旧任务内容不提供给模型]',source_unavailable:true}),has_more:rows.length>limit,next_offset:rows.length>limit?offset+limit:null};
    }
    if(name==='read_managed_task'){
      fields(args,['task_id','source','offset','length']);const id=String(args.task_id);assertManagedTask(this.store,caller,id);const task=this.store.get('SELECT * FROM tasks WHERE id=?',id)!;
      if(!this.sourceVisible(task))return {task:{id,repository_id:task.repository_id,status:task.status,source_unavailable:true}};
      const records=new TaskRecords(this.store);
      if(args.source!==undefined){
        if(typeof args.source!=='string')fail(400,'invalid_evidence_source');
        const candidate=records.get(id).candidate;
        return {evidence:candidate?readEvidence(this.store,id,candidate,args,taskTraceAccess(this.store,{...task,active_role:caller.role})): {error:'evidence_not_offered'}};
      }
      if(args.offset!==undefined||args.length!==undefined)fail(400,'evidence_source_required');
      return {task:records.context(id),origin:this.store.get('SELECT source_kind,source_role,executor_role,conversation_id FROM task_origins WHERE task_id=?',id)??null};
    }
    if(name==='create_task'){
      try{
        fields(args,['request','criteria','executor_role','execute','endpoint','as_child','intent']);
        if(args.intent!==undefined&&!['report','development'].includes(String(args.intent)))fail(400,'invalid_task_intent');
        if(args.endpoint!==undefined&&!['report','reviewable_pull_request'].includes(String(args.endpoint)))fail(400,'invalid_task_endpoint');
        const intent=args.intent??(args.endpoint==='reviewable_pull_request'?'development':undefined);
        return this.api(user,'POST',new URL('http://local/api/tasks'),{repository_id:caller.project_id,request:args.request,
          contract:{goal:args.request,criteria:args.criteria,scope:[String(args.request).slice(0,2000)],endpoint:args.endpoint??(intent==='development'?'reviewable_pull_request':'report')},
          ...(intent!==undefined?{intent}:{}),...(args.executor_role!==undefined?{executor_role:args.executor_role}:{}),...(args.execute!==undefined?{execute:args.execute}:{}),...(args.as_child!==undefined?{as_child:args.as_child}:{})},caller)!;
      }catch(error){
        const expected=['invalid_task_intent','invalid_task_endpoint','invalid_task_request','invalid_task_contract','invalid_task_executor','invalid_child_task','child_task_manager_required','child_task_uses_project_team','task_executor_unavailable','task_delegation_forbidden','task_external_write_forbidden','task_pull_request_forbidden','task_software_disabled'];
        if(!(error instanceof HttpError||error instanceof TaskError)||!expected.includes(error.code))throw error;
        return {error:error.code,stage:'task_creation',created:false,instruction:error.code==='task_external_write_forbidden'?'The source task has no code/PR authority to delegate. Keep the original goal and coordinate or request the missing authority.':error.code==='task_software_disabled'?'Project development or this work type is disabled. Ask the project administrator to enable it; no task was created.':error.code==='task_pull_request_forbidden'?'The selected executor or work type cannot edit code and deliver a PR. A Task Manager can delegate to the normal project team within existing development authority.':error.message};
      }
    }
    if(name==='manage_task'){
      fields(args,['task_id','action','instruction']);if(!['instructions','retry','pause','cancel'].includes(String(args.action)))fail(400,'task_operation_forbidden');
      if(args.action!=='instructions'&&args.instruction!==undefined)fail(400,'unknown_field');
      return this.api(user,'POST',new URL('http://local/api/tasks/'+String(args.task_id)+'/'+args.action),args.action==='instructions'?{instruction:args.instruction}:{},caller)!;
    }
    return fail(403,'task_tool_not_allowed');
  }
}
