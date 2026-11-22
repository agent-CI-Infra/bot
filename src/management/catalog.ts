import { fail, type Json } from '../core/security.js';
import { str, obj } from './catalog-base.js';
import { planSchema, subscriptionSchema, schedulingCommands } from '../schedules/schema.js';

export { str, obj } from './catalog-base.js';
const bool = { type: 'boolean' }, integer = { type: 'integer', minimum: 0 };
const strings = { type: 'array', items: str, maxItems: 100 };
export const contractSchema = obj({ goal: str, scope: strings, criteria: { ...strings, minItems: 1 }, endpoint: str }, ['goal', 'scope', 'criteria', 'endpoint']);
export const taskTargetSchema = obj({ type: { type: 'string', enum: ['issue', 'pr', 'branch', 'commit'] }, number: { type: 'integer', minimum: 1 }, ref: { ...str, maxLength: 256 } }, ['type']);
export const targetSchema = obj({ project_id: str, task_id: str }, ['project_id']);
export const commands: Record<string, { capability: string; arguments: Json; description: string }> = {
  'project.update': { capability:'config.write',arguments:obj({model_id:{anyOf:[str,{type:'null'}]},capability_ceiling:{type:'string',enum:['read','comment','develop'],description:'项目能力上限：read 只读问答，comment 可评论和打标签，develop 可开发并开 PR（含合并）'},review_enabled:bool,development_enabled:bool,actions_failures_enabled:bool,enabled:bool,test_command:{type:'string',maxLength:2048},base_branch:{type:'string',maxLength:256},review_issues:bool,review_pull_requests:bool,review_pr_updates:bool,review_issue_updates:bool,review_pr_discussion:bool,review_language:{type:'string',enum:['auto','zh','en']},task_concurrency:{anyOf:[integer,{type:'null'}]},command_timeout_seconds:{anyOf:[{type:'integer',minimum:10,maximum:7200},{type:'null'}]},role_concurrency:{type:'object'},delivery_gates:obj({pull_request_qa:{...bool,description:'普通任务开 PR 前是否需要独立 QA 通过（默认 true）'}},['pull_request_qa']),review_label:{type:'string',description:'检视发布后 bot 加的标签；空字符串表示不加'},development_label:{type:'string',description:'人加上它表示要求 bot 开发这个 Issue'},developing_label:{type:'string',description:'bot 开发 Issue 期间加在 Issue 上的标签，开出 PR 或停下时去掉；空字符串表示不加'},needs_human_label:{type:'string',description:'Issue 缺信息、需人工决定或开发受阻未开出 PR 时 bot 加的标签，进入开发或开出 PR 后去掉；空字符串表示不加'},auto_merge_policy:{type:'string',enum:['disallow','non_bot_only','allow_all'],description:'自动合并策略（#1170）：disallow 不自动合并，只有仓库写权限的维护者明确要求合并某条 PR 时才合并（默认）；non_bot_only 不自动合并 bot 开发的 PR，其他 PR 可按仓库规则自动合并；allow_all 包括 bot 自己的 PR 都可按仓库规则自动合并。合并与入队（Merge Queue）同一策略。'}}),description:'更新项目默认模型、能力上限、自动合并策略、触发开关、检视与开发标签和其他配置；运行中任务保留行为快照。' },
  'manager.update': { capability: 'config.write', arguments: obj({ expected_revision: integer, content: { type: 'string' }, prompt: { type: 'string' }, events: { type: 'object' }, standing_rules: { type: 'array', maxItems: 50, items: { type: 'object' }, description: '常设规则（#815）：例行事件按规则直接派给对应角色，不调用模型；整份替换，空数组表示所有事件都交给 Manager。' } }, []), description: '修改项目 Manager：提示词（项目统一分派与协作规则）、常设规则、哪些事件交给 Manager；只影响之后的分派和新任务。提示词不能授予写入。' },
  'roles.update': { capability:'roles.edit',arguments:obj({expected_revision:integer,enabled:bool,controller:obj({role:str,entries:obj({development:bool,request:bool,review:bool,actions:bool})}),roles:{type:'array',maxItems:32,items:{type:'object'}},skills:{type:'array',maxItems:32,items:{type:'object'}},deleted_roles:{type:'array',maxItems:32,items:str},follow_default:{type:'boolean',description:'只与 expected_revision 一起提交 true：把项目自己的角色配置恢复为跟随内置默认（#1068）。'}},['expected_revision']),description:'通过 RoleDefinitionV2 修改组织允许的角色默认设置；保留角色 revision、模型、Skill 和 Pi 配置。保存后是项目自己的配置，不再跟随内置默认。' },
  'task.create': { capability: 'tasks.write', arguments: obj({ request: str, contract: contractSchema, target: taskTargetSchema, executor_role: str, intent:{type:'string',enum:['report','development','review','test']},
    writes:{type:'array',items:{type:'string',enum:['pull_request','review','github','actions_rerun']},maxItems:4,description:'授予任务的写入：pull_request 开 PR、review 发检视、github 评论标签等、actions_rerun 单次重跑失败运行；不填只能交报告。开发意图或 PR 端点授予 pull_request，检视意图授予 review。'},
    workflow_changes:{...bool,description:'Allow this development PR task to modify .github/workflows/ (requests Workflows permission when pushing the bot branch). Requires project administrator confirmation in the console: calling task.create with workflow_changes: true stages a confirmation card in the console conversation instead of creating the task immediately.'} }, ['request','contract']),
    description: '创建有目标与验收条件的通用任务（可选绑定 PR、Issue、分支或提交检出对象）；执行者按授予的写入调用交付工具（交报告、开 PR、发检视、写 GitHub、单次重跑 Actions），都在项目能力上限和来源权限之内。' },
  ...Object.fromEntries(['pause','cancel','retry','adopt-config'].map(action => ['task.'+action, { capability: 'tasks.write', arguments: obj({}), description: action==='adopt-config'?'明确采用新配置：先暂停并等待旧 run 结束，创建新配置 revision 并使旧候选和验收失效。':'通过现有 Task 服务执行 '+action+' 并回读。' }])),
  'task.relate': {capability:'tasks.write',arguments:obj({task_id:str,key:str,relationship:{type:'string',enum:['same_problem','related','recurrence']},reason:str,evidence:str},['task_id','key','relationship','reason','evidence']),description:'登记同项目相似/关联/复现任务，保留证据；目标正在执行时请求 Coordinator，不按标题自动合并。'},
  'task.priority': {capability:'tasks.write',arguments:obj({priority:{type:'string',enum:['P0','P1','P2','P3']},reason:str},['priority','reason']),description:'按统一严重性标准调整任务优先级并记录证据与理由；改级进入新级队尾，不抢占执行。'},
  'task.instructions': { capability: 'tasks.write', arguments: obj({ instruction: str }, ['instruction']), description: '追加当前任务补充指令，供后续步骤读取，不改目标或旧 run 快照。' },
  'task.contract': { capability: 'tasks.write', arguments: obj({ contract: contractSchema }, ['contract']), description: '显式修改目标、范围或验收条件并增加 contract revision，使旧候选与验收失效。' },
  'knowledge.revise': { capability: 'knowledge.write', arguments: obj({ id: str, revision: integer, body: str, reason:str, catalog:{type:'object'}, action:{type:'string',enum:['accept','reject','archive','conflict','revoke','restore','merge']}, evidence:strings, supersedes:strings, run_id:str }, ['id','revision']), description: '按精确 revision 修订知识目录或正文，或附证据复核候选；文档晋升通过项目知识页核验合入。' },
  ...schedulingCommands,
};
export const schedulingQueries = ['list_schedules','list_subscriptions','list_occurrences','list_notification_deliveries','list_schedule_audit','list_schedule_destinations','preview_schedule','preview_subscription','list_schedule_migrations'];
export const queries = ['list_projects','list_tasks','get_task','get_effective_config','get_usage','list_audit','get_capabilities','search_knowledge','read_knowledge','knowledge_versions', ...schedulingQueries] as const;
export const querySchema = obj({ operation: { type:'string', enum: queries }, target: obj({ project_id: str, task_id: str }), arguments: obj({ offset: integer, limit: { type:'integer',minimum:1,maximum:100 }, section: { type:'string',enum:['detail','logs','runs','events','roles','source'] }, source: str, query: str, id:str, revision:{type:'integer',minimum:1}, baseline:str, plan: planSchema, subscription: subscriptionSchema, schedule_id: str }) }, ['operation','target','arguments']);
export const commandSchema = obj({ operation: { type:'string',enum:Object.keys(commands) }, target: targetSchema, arguments: { type:'object' }, expected_revision: str,
  idempotency_key: { ...str,maxLength:240 }, source_conversation: { ...str,maxLength:240 }, source_message: { ...str,maxLength:240 } }, ['operation','target','arguments','expected_revision','idempotency_key','source_conversation','source_message']);

/** A small closed-schema validator shared by direct API and model tools; unknown authority fields are rejected. */
export function validate(schema: Json, value: any): void {
  if(schema.anyOf){if(!(schema.anyOf as Json[]).some(s=>{try{validate(s,value);return true;}catch{return false;}}))fail(400,'invalid_management_arguments');return;}
  if(schema.enum&&!(schema.enum as unknown[]).includes(value))fail(400,'invalid_management_arguments');
  switch(schema.type){
    case 'object': {
      if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'invalid_management_arguments');
      const properties=(schema.properties??{}) as Json;
      if((schema.required as string[]??[]).some(k=>!Object.hasOwn(value,k)))fail(400,'invalid_management_arguments');
      // `__proto__` is never a legitimate key. A closed schema also refuses `constructor`/`prototype`, but an open map
      // (additionalProperties !== false, such as the role-id keyed `role_concurrency`) may legally be keyed by either:
      // they are ordinary role names, and refusing them would make such a role impossible to configure.
      const open=schema.additionalProperties!==false;
      for(const [key,v] of Object.entries(value)){if(key==='__proto__'||!open&&['constructor','prototype'].includes(key))fail(400,'unexpected_management_field');if(Object.hasOwn(properties,key))validate(properties[key] as Json,v);else if(!open)fail(400,'unexpected_management_field');}
      break;
    }
    case 'string': if(typeof value!=='string'||value.includes('\0')||value.length<Number(schema.minLength??0)||value.length>Number(schema.maxLength??Number.MAX_SAFE_INTEGER))fail(400,'invalid_management_arguments');break;
    case 'integer': if(!Number.isSafeInteger(value)||value<Number(schema.minimum??0)||value>Number(schema.maximum??Number.MAX_SAFE_INTEGER))fail(400,'invalid_management_arguments');break;
    case 'boolean': if(typeof value!=='boolean')fail(400,'invalid_management_arguments');break;
    case 'null': if(value!==null)fail(400,'invalid_management_arguments');break;
    case 'array': if(!Array.isArray(value)||value.length<Number(schema.minItems??0)||value.length>Number(schema.maxItems??100))fail(400,'invalid_management_arguments');else for(const item of value)validate(schema.items as Json,item);break;
  }
}
const toolCommandSchema={...obj({operation:(commandSchema.properties as Json).operation,target:targetSchema,arguments:{type:'object'},expected_revision:str},['operation','target','arguments','expected_revision']),anyOf:Object.entries(commands).map(([operation,entry])=>obj({operation:{type:'string',enum:[operation]},target:targetSchema,arguments:entry.arguments,expected_revision:str},['operation','target','arguments','expected_revision']))};
export const managementTools = [
  { type:'function',function:{name:'management_query',description:'Read scoped persisted management facts. Never invent status, logs, costs or configuration.',parameters:querySchema} },
  { type:'function',function:{name:'management_command',description:'Execute an authorized business command. Read its current revision first. Authorized commands execute directly without an approval step, except task.create with workflow_changes: true, which stages a console confirmation card for a project administrator.',parameters:toolCommandSchema} },
];
