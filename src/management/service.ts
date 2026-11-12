import type { Manager } from '../projects/service.js';
import { historyData, logContent, unreadable } from '../storage/payloads.js';
import { visibleMemorySnapshot } from '../memory/access.js';
import { checkManagementBudget } from './budget.js';
import type { Store, Row } from '../storage/database.js';
import { assertCurrent, authorize, confinedTenant, effectiveRepositories, listEffectiveScopes, resolvePrincipalActor, restrictActor, type ActorContext } from '../identity/authorization.js';
import { digest, fail, HttpError, randomId, type Json } from '../core/security.js';
import type { Actor } from '../app/auth.js';
import type { RuleService } from '../rules/service.js';
import { managerPrompt } from '../work/settings.js';
import { applyManagerChange, managerView, workCompatibility, workflowUpdate } from '../work/api.js';
import { parseSections } from '../work/settings.js';
const parseSectionBody=(content:string,id:string)=>parseSections(content).sections.get(id)?.body??null;
import { TaskCommands } from '../tasks/commands.js';
import { TaskRecords } from '../tasks/service.js';
import { taskTrace, traceClean } from '../tasks/trace.js';
import { queries as taskQueries, redactEgress } from '../app/queries.js';
import { updatePolicy } from '../app/management.js';
import { TaskError } from '../agent/common.js';
import { roleApi } from '../roles/api.js';
import { installationExecutionDenied } from '../installations/archive.js';
import { commands, commandSchema, querySchema, queries as queryNames, schedulingQueries, validate } from './catalog.js';
import { schedulingCommands } from '../schedules/schema.js';

export interface ManagementCommand {
  operation: string; target: {project_id:string;task_id?:string;workflow_id?:string}; arguments: Json; expected_revision: string;
  idempotency_key: string; source_conversation: string; source_message: string;
}
export interface ManagementExtension {
  execute(actor: ActorContext, command: ManagementCommand, effectKey: string): Promise<Json>;
  reconcile(actor: ActorContext, command: ManagementCommand, effectKey: string): Promise<Json | null>;
}
const normalized = (v:any):any => v===undefined?null:Array.isArray(v)?v.map(normalized):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalized(v[k])])):v;
const canonical = (v:any):string => JSON.stringify(normalized(v));
export const parameterHash = (v: unknown): string => digest(canonical(v));
const now=()=>new Date().toISOString();
export class ManagementService {
  readonly extensions = new Map<string,ManagementExtension>();
  // A trusted transport rechecks its persisted source whenever a command executes, including a reconciliation resumed in Web.
  sourceGuard?: (command: Row) => void;
  /** Called inside the creating transaction when a task.create command creates a task. */
  taskCreated?: (command: Row, task: string) => void;
  knowledgeSearch?: (actor:ActorContext,project:string,query:string,offset:number,limit:number)=>Promise<Json>;
  knowledgeRead?: (actor:ActorContext,project:string,id:string,revision?:number,versions?:boolean,baseline?:string)=>Promise<Json>;
  schedulingQuery?: (actor:ActorContext,operation:string,project:string,args:Json)=>Promise<Json>;
  constructor(readonly store: Store, readonly rules: RuleService, readonly tasks: TaskCommands, readonly computer?:Manager, readonly githubUrl?:string) {}
  register(operation: string, extension: ManagementExtension): void {
    if(!['configuration.pr','knowledge.revise',...Object.keys(schedulingCommands)].includes(operation)||this.extensions.has(operation))throw new Error('invalid_management_registration');
    this.extensions.set(operation,extension);
  }
  user(actor: ActorContext): Actor {
    assertCurrent(actor);
    const row=this.store.get('SELECT u.* FROM users u JOIN principals p ON p.user_id=u.id WHERE p.id=? AND u.active=1',actor.principal_id);
    // Adapters can use a service principal, but cannot synthesize the legacy super-admin role; a confined actor never holds it.
    return { id:actor.principal_id,username:row?.username??'service',role:row?.role==='super_admin'&&!confinedTenant(actor)?'super_admin':'project_admin',csrf:'',context:actor,repositories:this.projects(actor) };
  }
  projects(actor: ActorContext): string[] {
    assertCurrent(actor);
    return effectiveRepositories(this.store,actor).filter(id=>!actor.project_id||id===actor.project_id);
  }
  scope(actor:ActorContext,project:string,capability='tasks.read'): Row {
    if(actor.project_id&&actor.project_id!==project)fail(403,'project_scope_mismatch');
    authorize(actor,capability,{project_id:project});
    const row=this.store.get('SELECT r.*,p.enabled FROM repositories r JOIN policies p ON p.repository_id=r.id WHERE r.id=?',project);
    if(!row)return fail(404,'repository_not_found');return row;
  }
  revision(target:ManagementCommand['target']): string {
    if(target.task_id!){
      const t=this.store.get('SELECT * FROM tasks WHERE id=? AND repository_id=?',target.task_id!,target.project_id);
      if(!t)fail(404,'task_not_found');
      return parameterHash({task:t,record:this.store.get('SELECT * FROM task_records WHERE task_id=?',target.task_id!),instructions:this.store.get("SELECT max(id) AS id FROM task_history WHERE task_id=? AND type='supplemental_instruction'",target.task_id!)});
    }
    return parameterHash({policy:this.store.get('SELECT * FROM policies WHERE repository_id=?',target.project_id),
      schedules:this.store.all('SELECT id,revision FROM schedules WHERE project_id=? ORDER BY id',target.project_id),
      subscriptions:this.store.all('SELECT id,revision FROM notification_subscriptions WHERE project_id=? ORDER BY id',target.project_id),
      manager:managerPrompt(this.store,target.project_id).revision,
      roles:this.store.get('SELECT value FROM settings WHERE key=?','roles:'+target.project_id),
      sources:this.store.get('SELECT sha,files FROM repository_rule_sources WHERE repository_id=?',target.project_id),
      models:this.store.all(`SELECT id,version,model_name,api_url,api_key FROM models WHERE repository_id=? OR (repository_id IS NULL AND EXISTS
        (SELECT 1 FROM model_projects WHERE model_id=models.id AND repository_id=?)) ORDER BY id`,target.project_id,target.project_id)});
  }
  private policy(actor:ActorContext,project:string): Row|undefined {
    const tenant=this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?',project)?.tenant_id;
    return this.store.get('SELECT * FROM management_policies WHERE tenant_id=?',tenant??actor.tenant_id);
  }
  private fence(actor:ActorContext,project:string):string{
    const p=this.store.get('SELECT account_id,owner_id FROM repositories WHERE id=?',project)!;
    return parameterHash({project:p,account:this.store.get('SELECT type,app_id,credentials FROM accounts WHERE id=?',p.account_id),
      installations:this.store.all('SELECT g.ref,g.revision,g.status,g.scope_pending,r.present FROM github_installations g JOIN installation_repositories r ON r.installation_ref=g.ref WHERE g.account_id=? AND r.repository_id=? ORDER BY g.ref',p.account_id,project),policy:this.policy(actor,project)});
  }
  check(actor:ActorContext,command:Pick<ManagementCommand,'operation'|'target'|'arguments'>): void {
    const {operation,target}=command,entry=commands[operation]!;
    const project=this.scope(actor,target.project_id,entry.capability);
    if(target.task_id&&!this.store.get('SELECT 1 FROM tasks WHERE id=? AND repository_id=?',target.task_id!,target.project_id))fail(404,'task_not_found');
    if(operation.startsWith('task.')&&operation!=='task.create'&&!target.task_id!)fail(400,'task_target_required');
    // workflow.update is the pre-#207 name for editing one work type's defaults (its Manager section, switch and writes).
    if(operation==='workflow.update'&&!target.workflow_id)fail(400,'workflow_target_required');
    if(!operation.startsWith('task.')&&operation!=='workflow.update'&&(target.task_id||target.workflow_id))fail(400,'invalid_management_target');
    if((operation==='workflow.update'&&target.task_id!)||(operation.startsWith('task.')&&target.workflow_id)||operation==='task.create'&&target.task_id!)fail(400,'invalid_management_target');
    // Stop/cancel remains available while disabled. Project defaults only persist configuration;
    // their switches take effect after an explicit enable. Execution commands still require an active project.
    if(!['task.pause','task.cancel','schedule.pause','schedule.delete','subscription.pause','subscription.delete'].includes(operation)){
      if(!project.enabled&&operation!=='project.update')fail(409,'project_disabled');
      const denied=installationExecutionDenied(this.store,project.account_id,target.project_id);if(denied)fail(409,'installation_unavailable');
      if(!this.store.get('SELECT 1 FROM installed_repositories WHERE repository_id=? AND account_id=? AND installed=1',target.project_id,project.account_id))fail(409,'installation_scope_changed');
      const account=this.store.get('SELECT * FROM accounts WHERE id=?',project.account_id);
      if(!account)fail(409,'account_unavailable');
      const credentials=this.store.secrets.open(account!.credentials,'account:'+account!.id);
      if(!credentials.token&&!credentials.private_key)fail(409,'account_credentials_revoked');
      if(!(operation==='project.update'&&command.arguments.enabled===false))this.checkBudget(target.project_id);
    }
  }
  checkBudget(project:string): void {
    checkManagementBudget(this.store,project);
  }

  async effective(actor:ActorContext,project:string):Promise<Json>{
    this.scope(actor,project);
    const rules=await this.rules.view(project),work=await workCompatibility(this.store,this.rules,project),manager=await managerView(this.store,this.rules,project);
    const sources={sha:rules.sha,updated_at:rules.updated_at,needs_refresh:rules.needs_refresh};
    this.scope(actor,project);
    let taskCreation:{allowed:boolean;reason:string|null}={allowed:true,reason:null};
    try{this.check(actor,{operation:'task.create',target:{project_id:project},arguments:{}});}
    catch(error){if(!(error instanceof HttpError||error instanceof TaskError))throw error;taskCreation={allowed:false,reason:error.code};}
    const roles=roleApi(this.store,this.user(actor),'GET',new URL('http://local/api/repositories/'+project+'/roles'),{}) as {configuration:any;preview:{error?:string}[]};
    // manager is the project's flow definition; workflows lists the work types in the shape older clients read.
    return traceClean({project_id:project,revision:this.revision({project_id:project}),task_creation:taskCreation,manager:{prompt:manager.prompt,work:manager.work,events:manager.events,migration:manager.migration},
      workflows:work.map(w=>({...w,
      prompt:{...w.prompt,version:w.prompt.source==='repository'?sources.sha:parameterHash(w.prompt.effective),layers:w.prompt.layers.map((l:any)=>({...l,version:l.source==='repository'?sources.sha:parameterHash(l.content)}))},
      model:{...w.model,source:w.model.id||w.model.default_id?'console':'builtin',version:this.store.get('SELECT version FROM models WHERE id=?',w.model.id||w.model.default_id)?.version??null}})),
      roles:{...roles,version:parameterHash(roles.configuration),roles:roles.configuration.roles.map((r:any)=>({...r,source:!roles.configuration.legacy||r.persona_prompt?'console':'builtin'}))},
      skills:rules.files.filter((f:any)=>f.path.startsWith('.agents/skills/')).map((f:any)=>({path:f.path,source:f.source,version:sources.sha,content:f.effective})),
      sources,capability_gaps:[...new Set(roles.preview.filter(r=>r.error).map(r=>r.error))],semantics:{defaults:'只影响之后新建的任务。',instructions:'追加记录，不改写旧 run 快照；后续步骤读取。',contract:'增加合同 revision，清除旧候选和验收。',adopt_config:'先暂停并等待旧执行结束，再显式采用新配置 revision。'}});
  }
  private nextSteps(actor:ActorContext,target:ManagementCommand['target']):string[]{
    try{authorize(actor,'tasks.write',{project_id:target.project_id});}catch{return [];}
    const task=this.store.get('SELECT * FROM tasks WHERE id=?',target.task_id!)!;
    if(['completed','succeeded','pr_opened','cancelled','superseded'].includes(task.status))return [];
    const result=['task.pause','task.cancel','task.instructions'];
    const active=this.tasks.hooks.active?.(task.id)||task.status==='running';
    if(!active&&['paused','failed','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','waiting_pr_head','retry_wait','needs_replan','needs_help'].includes(task.status))result.push('task.retry');
    if(!active&&!this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",task.id))result.push('task.contract','task.adopt-config');
    result.push('task.priority','task.relate');
    return result.filter(operation=>{try{this.check(actor,{operation,target,arguments:{}});return true;}catch{return false;}});
  }
  async query(actor:ActorContext,input:Json):Promise<Json>{
    validate(querySchema,input);assertCurrent(actor);
    const operation=String(input.operation),target=input.target as ManagementCommand['target'],args=input.arguments as any;
    if(target.project_id)this.scope(actor,target.project_id,['search_knowledge','read_knowledge','knowledge_versions'].includes(operation)?'knowledge.read':'tasks.read');
    const ids=target.project_id?[target.project_id]:this.projects(actor),offset=args.offset??0,limit=args.limit??20;
    if(schedulingQueries.includes(operation)){
      if(!this.schedulingQuery)fail(409,'scheduling_not_registered');
      return this.schedulingQuery!(actor,operation,target.project_id,args);
    }
    if(operation==='get_capabilities')return {queries:queryNames,commands:Object.entries(commands).map(([operation,c])=>({operation,...c,available:!['configuration.pr','knowledge.revise',...Object.keys(schedulingCommands)].includes(operation)||this.extensions.has(operation)})),scopes:listEffectiveScopes(this.store,actor.principal_id).filter(s=>s.state==='active'&&(!confinedTenant(actor)||s.scope!=='platform')&&(!actor.tenant_id||!s.tenant_id||s.tenant_id===actor.tenant_id)&&(!actor.project_id||s.scope!=='project'||s.project_id===actor.project_id))};
    if(operation==='list_projects')return {projects:ids.slice(offset,offset+limit).map(id=>{
      const project=this.scope(actor,id),policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',id)!;
      return {id,tenant_id:this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?',id)?.tenant_id,full_name:project.full_name,enabled:!!project.enabled,configuration_gaps:[...(!policy.model_id?['model_not_configured']:[]),...(installationExecutionDenied(this.store,project.account_id,id)?['installation_unavailable']:[])],url:'#/projects/'+id+'/basic'};
    }),total:ids.length,next_offset:offset+limit<ids.length?offset+limit:null};
    if(operation==='get_effective_config'){if(!target.project_id)fail(400,'project_target_required');return this.effective(actor,target.project_id);}
    if(operation==='search_knowledge'){if(!target.project_id)fail(400,'project_target_required');if(!this.knowledgeSearch)fail(409,'knowledge_not_registered');return this.knowledgeSearch!(actor,target.project_id,args.query??'',offset,limit);}
    if(['read_knowledge','knowledge_versions'].includes(operation)){if(!target.project_id||typeof args.id!=='string')fail(400,'knowledge_target_required');if(!this.knowledgeRead)fail(409,'knowledge_not_registered');return this.knowledgeRead!(actor,target.project_id,args.id,args.revision,operation==='knowledge_versions',args.baseline);}
    const marks=ids.map(()=>'?').join(',')||'NULL';
    if(operation==='list_tasks'){
      const rows=this.store.all(`SELECT id FROM tasks WHERE repository_id IN (${marks}) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,...ids,limit+1,offset),more=rows.length>limit;rows.splice(limit);
      return {tasks:await Promise.all(rows.map(t=>this.query(actor,{operation:'get_task',target:{task_id:t.id,project_id:this.store.get('SELECT repository_id FROM tasks WHERE id=?',t.id)!.repository_id},arguments:{}}))),next_offset:more?offset+limit:null};
    }
    if(operation==='get_task'){
      if(!target.task_id||!target.project_id)fail(400,'task_target_required');
      if(!this.store.get('SELECT 1 FROM tasks WHERE id=? AND repository_id=?',target.task_id!,target.project_id))fail(404,'task_not_found');
      const section=args.section??'detail',base='/api/tasks/'+target.task_id;
      if(section==='logs'){
        const rows=this.store.all('SELECT id,content,content_ref,created_at FROM task_logs WHERE task_id=? ORDER BY rowid LIMIT ? OFFSET ?',target.task_id!,limit+1,offset),more=rows.length>limit;rows.splice(limit);
        const text=(r:Record<string,any>)=>{try{return logContent(this.store,r);}catch(error){return JSON.stringify({type:'log_unreadable',...unreadable(error)});}};
        return traceClean({logs:rows.map(({content_ref,...r})=>({...r,source_ref:'task_logs:'+r.id,content:String(visibleMemorySnapshot(this.store,target.project_id!,text({...r,content_ref}),{actor})).slice(0,24000)})),next_offset:more?offset+limit:null});
      }
      if(section==='roles')return traceClean(roleApi(this.store,this.user(actor),'GET',new URL('http://local'+base+'/roles?after='+offset+'&limit='+limit),{})!);
      if(section!=='detail'){
        // Knowledge records have their own ACL. A trace source must not turn into a knowledge reader.
        if(section==='source'&&!/^(task_runs:|task_history:|task_logs:|task_tools:|role_snapshots:|github_effects:|model_requests:|project_memories:|contract:revision:|task:)/.test(args.source??''))fail(403,'trace_source_forbidden');
        if(section==='source')authorize(actor,'knowledge.read',{project_id:target.project_id});
        return traceClean(taskTrace(this.store,target.task_id!,new URL('http://local'+base+'/'+section+'?after='+offset+'&limit='+limit+'&ref='+encodeURIComponent(args.source??'')),section,{actor}));
      }
      const result=taskQueries(this.store,this.user(actor),new URL('http://local'+base))!;
      return traceClean({...result,revision:this.revision(target),allowed_next_steps:this.nextSteps(actor,target),url:'#/projects/'+target.project_id+'/activity',logs_url:base+'/logs',runs_url:base+'/runs'});
    }
    if(operation==='get_usage'){
      const rows=this.store.all(`SELECT repository_id,currency,count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(cost) cost,sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced_requests FROM model_requests WHERE repository_id IN (${marks}) GROUP BY repository_id,currency ORDER BY repository_id,currency LIMIT ? OFFSET ?`,...ids,limit+1,offset),more=rows.length>limit;rows.splice(limit);
      return {usage:rows,next_offset:more?offset+limit:null,budgets:this.store.all(`SELECT * FROM management_budgets WHERE project_id IN (${marks})`,...ids),budget_policy:'未配置预算表示不限额；未知价格不计作零费用。'};
    }
    if(operation==='list_audit'){
      const rows=this.store.all(`SELECT * FROM management_commands WHERE project_id IN (${marks}) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,...ids,limit+1,offset),more=rows.length>limit;rows.splice(limit);
      return {audit:rows.map(r=>this.receipt(r)),next_offset:more?offset+limit:null};
    }
    return fail(400,'unknown_management_query');
  }
  receipt(row:Row):Json {
    const {arguments:args,result,target,...safe}=row;
    return redactEgress(traceClean({...safe,target:JSON.parse(target),arguments:JSON.parse(args),result:result?JSON.parse(result):null}));
  }
  read(actor:ActorContext,id:string):Json {
    const row=this.store.get('SELECT * FROM management_commands WHERE id=?',id);if(!row)fail(404,'management_command_not_found');
    this.scope(actor,row!.project_id);return this.receipt(row!);
  }
  async submit(actor:ActorContext,input:Json):Promise<Json>{
    validate(commandSchema,input);const command=input as unknown as ManagementCommand,entry=commands[command.operation]!;
    validate(entry.arguments,command.arguments);
    if(JSON.stringify(traceClean(command.arguments))!==JSON.stringify(command.arguments))fail(400,'sensitive_management_arguments');
    this.scope(actor,command.target.project_id,entry.capability);
    const hash=parameterHash(command),previous=this.store.get('SELECT * FROM management_commands WHERE principal_id=? AND idempotency_key=?',actor.principal_id,command.idempotency_key);
    if(previous){if(previous.parameter_hash!==hash)fail(409,'idempotency_conflict');return this.receipt(previous);}
    const row=this.store.transaction(()=>{
      this.check(actor,command);const current=this.revision(command.target);
      if(current!==command.expected_revision)fail(409,'management_revision_conflict');
      // Authorized commands execute directly: what an actor may do is configured in the console, with no approval step.
      const id=randomId(),time=now();
      this.store.run(`INSERT INTO management_commands(id,principal_id,tenant_id,project_id,channel,operation,target,arguments,expected_revision,idempotency_key,parameter_hash,authorization_revision,execution_fence,source_conversation,source_message,state,before_revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,actor.principal_id,this.store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?',command.target.project_id)!.tenant_id,command.target.project_id,actor.channel,command.operation,JSON.stringify(command.target),JSON.stringify(traceClean(command.arguments)),command.expected_revision,command.idempotency_key,hash,actor.authorization_revision,this.fence(actor,command.target.project_id),command.source_conversation,command.source_message,'pending',current,time,time);
      return this.store.get('SELECT * FROM management_commands WHERE id=?',id)!;
    });
    return this.execute(actor,row.id,command);
  }
  private command(row:Row):ManagementCommand{return {operation:row.operation,target:JSON.parse(row.target),arguments:JSON.parse(row.arguments),expected_revision:row.expected_revision,idempotency_key:row.idempotency_key,source_conversation:row.source_conversation,source_message:row.source_message};}
  async resume(actor:ActorContext,id:string):Promise<Json>{
    const row=this.store.get('SELECT * FROM management_commands WHERE id=?',id);if(!row)fail(404,'management_command_not_found');
    if(row!.principal_id!==actor.principal_id)fail(403,'command_operator_required');
    this.check(actor,this.command(row!));
    if(['pending','unknown','executing'].includes(row!.state))return this.execute(actor,id,this.command(row!));
    return this.receipt(row!);
  }
  private async execute(actor:ActorContext,id:string,command:ManagementCommand):Promise<Json>{
    const extension=this.extensions.get(command.operation);
    try{
      const row=this.store.get('SELECT * FROM management_commands WHERE id=?',id)!;
      if(row.channel==='im'&&this.sourceGuard)restrictActor(actor,()=>this.sourceGuard?.(row));
      this.sourceGuard?.(row);
      if(row.principal_id!==actor.principal_id||row.authorization_revision!==actor.authorization_revision)fail(409,'authorization_changed');
      this.check(actor,command);
      if(row.execution_fence!==this.fence(actor,command.target.project_id))fail(409,'execution_context_changed');
      if(extension){
        // Any uncertain external response is reconciled using the persisted effect key, never blindly retried.
        if(['executing','unknown'].includes(row.state)){
          const found=await extension.reconcile(actor,command,id);this.sourceGuard?.(row);this.check(actor,command);
          if(found)this.finish(id,'succeeded',found);else this.finish(id,'unknown',{error:'external_result_unknown',reconcile_required:true});
        }else{
          if(this.revision(command.target)!==command.expected_revision)fail(409,'management_revision_conflict');
          this.store.run("UPDATE management_commands SET state='executing',updated_at=? WHERE id=?",now(),id);
          const result=await extension.execute(actor,command,id);this.sourceGuard?.(row);this.check(actor,command);this.finish(id,'succeeded',result);
        }
      }else this.store.transaction(()=>{
        this.check(actor,command);
        if(this.revision(command.target)!==command.expected_revision)fail(409,'management_revision_conflict');
        const user=this.user(actor),{operation,target,arguments:args}=command;
        let result:Json;
        if(operation==='rules.update'){
          const policy=this.store.get('SELECT rule_overrides FROM policies WHERE repository_id=?',target.project_id)!;
          const before=JSON.parse(policy.rule_overrides||'{}')[String(args.path)]??null;
          this.rules.save(user,target.project_id,args);
          const source=this.store.get('SELECT files FROM repository_rule_sources WHERE repository_id=?',target.project_id);
          const overridden=!!(source&&Object.hasOwn(JSON.parse(source.files),String(args.path)));
          result={saved:true,effect:overridden?'console_overridden':'future_tasks',effective:!overridden,diff:{before:{content:before},after:args},notice:overridden?'控制台层已保存；仓库文件覆盖它，实际行为尚未改变。':'共享规则已保存，只影响之后的新任务。'};
        }else if(operation==='project.update'){
          result=updatePolicy(this.store,user,target.project_id,args);
        }else if(operation==='workflow.update'){
          // A work type's Manager section, switch and writes, under the command name clients used before #207.
          const id=target.workflow_id!,sectionId=(id.startsWith('development.')?'development':id),rule=({'review.issue':'.bot/rules/issue-review.md','review.pr':'.bot/rules/pr-review.md',development:'.bot/rules/issue-development.md'} as Record<string,string>)[sectionId];
          const before=managerPrompt(this.store,target.project_id),oldPrompt=parseSectionBody(before.content,sectionId);
          const saved=workflowUpdate(this.store,target.project_id,id,args,user.id);
          const source=this.store.get('SELECT files,sha FROM repository_rule_sources WHERE repository_id=?',target.project_id);
          // The exact effective prompt is returned by get_effective_config; repository ownership is never guessed.
          const overridden=!!(rule&&source&&Object.hasOwn(JSON.parse(source.files),rule)&&Object.hasOwn(args,'prompt'));
          result={saved:true,manager_revision:saved.revision,effect:overridden?'console_overridden':'future_tasks',effective:!overridden,source:overridden?'repository':'console',diff:{before:{prompt:oldPrompt},after:args},rollback:{operation:'workflow.update',target,arguments:{prompt:oldPrompt},expected_revision:this.revision(target)},configuration_url:'#/projects/'+target.project_id+'/roles',repository_sources:source?.sha??null,notice:overridden?'Manager 章节已保存，但仓库 .bot 文件优先，实际行为尚未改变。可创建配置 PR，待合入生效。':'Manager 章节已保存，只影响之后新建任务；已有 run 保留原配置。'};
        }else if(operation==='manager.update'){
          const before=managerPrompt(this.store,target.project_id),saved=applyManagerChange(this.store,target.project_id,args,user.id);
          result={saved:true,manager_revision:saved.revision,effect:'future_tasks',diff:{before:{revision:before.revision},after:{revision:saved.revision}},configuration_url:'#/projects/'+target.project_id+'/roles',
            notice:'Manager 配置已保存为第 '+saved.revision+' 版，只影响之后的分派和新建任务；已有 run 保留原配置。'};
        }else if(operation==='roles.update'){
          const allowed=JSON.parse(this.policy(actor,target.project_id)?.role_fields??'["enabled","controller","roles","skills","required_stages"]');
          if(Object.keys(args).some(k=>k!=='expected_revision'&&!allowed.includes(k==='deleted_roles'?'roles':k)))fail(403,'role_setting_forbidden');
          result=roleApi(this.store,user,'PUT',new URL('http://local/api/repositories/'+target.project_id+'/roles'),args)!;
          result={...result,effect:'future_tasks'};
        }else if(operation.startsWith('task.')){
          const action=operation.slice(5),url=action==='create'?'/api/tasks':'/api/tasks/'+target.task_id+'/'+action;
          const body=action==='create'?{repository_id:target.project_id,...args}:action==='contract'?{...args,expected_revision:new TaskRecords(this.store).get(target.task_id!).revision}:args;
          result=this.tasks.api(user,action==='contract'?'PATCH':'POST',new URL('http://local'+url),body)!;
          if(!result)fail(409,'task_operation_unavailable');
          result={...result,task_url:result.id?'/api/tasks/'+result.id:'/api/tasks/'+target.task_id};
          if(action==='create'&&result.id)this.taskCreated?.(row,String(result.id));
        }else return fail(409,operation.replaceAll('.','_')+'_not_registered');
        this.finish(id,'succeeded',result);
      });
    }catch(error){
      const row=this.store.get('SELECT state FROM management_commands WHERE id=?',id);
      this.finish(id,row?.state==='executing'?'unknown':'failed',{error:error instanceof HttpError||error instanceof TaskError?error.code:'management_tool_failed',http_status:error instanceof HttpError?error.status:503,...(error instanceof HttpError&&error.field?{field:error.field}:{}),...(row?.state==='executing'?{reconcile_required:true}:{})});
    }
    return this.receipt(this.store.get('SELECT * FROM management_commands WHERE id=?',id)!);
  }
  private finish(id:string,state:string,result:Json):void{
    const row=this.store.get('SELECT * FROM management_commands WHERE id=?',id)!;
    this.store.run('UPDATE management_commands SET state=?,result=?,after_revision=?,updated_at=? WHERE id=?',state,JSON.stringify(traceClean(result)),this.revision(JSON.parse(row.target)),now(),id);
    this.store.audit(row.principal_id,'management.'+state,id,row.project_id);
  }
}
