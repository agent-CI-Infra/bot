import { fail, type Json } from '../core/security.js';
import { str, obj } from './catalog-base.js';
import { planSchema, schedulingCommands } from '../schedules/schema.js';

export { str, obj } from './catalog-base.js';
const bool = { type: 'boolean' }, integer = { type: 'integer', minimum: 0 };
const strings = { type: 'array', items: str, maxItems: 100 };
export const contractSchema = obj({ goal: str, scope: strings, criteria: { ...strings, minItems: 1 }, endpoint: str }, ['goal', 'scope', 'criteria', 'endpoint']);
export const targetSchema = obj({ project_id: str, task_id: str, workflow_id: str }, ['project_id']);
export const commands: Record<string, { capability: string; arguments: Json; description: string }> = {
  'rules.update': {capability:'config.write',arguments:obj({path:str,content:{anyOf:[{type:'string'},{type:'null'}]}},['path','content']),description:'修改控制台共享行为规则；仓库规则仍具有优先级。'},
  'project.update': { capability:'config.write',arguments:obj({model_id:{anyOf:[str,{type:'null'}]},review_enabled:bool,development_enabled:bool,actions_failures_enabled:bool,enabled:bool,test_command:{type:'string',maxLength:2048},max_revisions:{type:'integer',minimum:0,maximum:10},base_branch:{type:'string',maxLength:256},automation:{type:'object'},review_issues:bool,review_pull_requests:bool,review_pr_updates:bool,review_issue_updates:bool,review_pr_discussion:bool,review_language:{type:'string',enum:['auto','zh','en']},task_concurrency:{anyOf:[integer,{type:'null'}]},task_models:{type:'object'}}),description:'更新项目模型、触发开关与配置；运行中任务保留行为快照。' },
  'manager.update': { capability: 'config.write', arguments: obj({ expected_revision: integer, content: { type: 'string' }, work: { type: 'object' }, events: { type: 'object' } }, []), description: '修改项目 Manager：提示词（项目唯一的流程定义）、各工作类型的开关和写入、哪些事件交给 Manager；只影响之后的分派和新任务。提示词不能授予写入。' },
  'workflow.update': { capability: 'config.write', arguments: obj({ prompt: { anyOf: [{type:'string'}, { type: 'null' }] }, enabled: bool, writes: strings }, []), description: '（兼容旧名称）修改一个工作类型的 Manager 章节、开关或写入；target.workflow_id 是工作类型 id。' },
  'roles.update': { capability:'roles.edit',arguments:obj({expected_revision:integer,enabled:bool,controller:obj({role:str,entries:obj({development:bool,request:bool,review:bool,actions:bool})}),roles:{type:'array',maxItems:32,items:{type:'object'}},skills:{type:'array',maxItems:32,items:{type:'object'}}},['expected_revision','enabled']),description:'通过 RoleDefinitionV2 修改组织允许的角色默认设置；保留角色 revision、模型、Skill 和 Pi 配置。' },
  'task.create': { capability: 'tasks.write', arguments: obj({ request: str, contract: contractSchema }, ['request','contract']), description: '创建有目标与验收条件的普通业务任务，沿用交付和独立 QA。' },
  ...Object.fromEntries(['pause','cancel','retry','adopt-config'].map(action => ['task.'+action, { capability: 'tasks.write', arguments: obj({}), description: action==='adopt-config'?'明确采用新配置：先暂停并等待旧 run 结束，创建新配置 revision 并使旧候选和验收失效。':'通过现有 Task 服务执行 '+action+' 并回读。' }])),
  'task.instructions': { capability: 'tasks.write', arguments: obj({ instruction: str }, ['instruction']), description: '追加当前任务补充指令，供后续步骤读取，不改目标或旧 run 快照。' },
  'task.contract': { capability: 'tasks.write', arguments: obj({ contract: contractSchema }, ['contract']), description: '显式修改目标、范围或验收条件并增加 contract revision，使旧候选与验收失效。' },
  'configuration.pr': { capability: 'config.write', arguments: obj({ path: str, content: str }, ['path','content']), description: '通过受信任的 App 发布适配器创建默认分支配置 PR；待合入才生效。' },
  'knowledge.revise': { capability: 'knowledge.write', arguments: obj({ id: str, revision: integer, body: str, reason:str, catalog:{type:'object'}, action:{type:'string',enum:['accept','reject','archive','conflict','revoke','restore','merge']}, evidence:strings, supersedes:strings, run_id:str }, ['id','revision']), description: '按精确 revision 修订知识目录或正文，或附证据复核候选；文档晋升通过项目知识页核验合入。' },
  ...schedulingCommands,
};
export const schedulingQueries = ['list_schedules','list_subscriptions','list_occurrences','list_notification_deliveries','list_schedule_audit','list_schedule_destinations','preview_schedule'];
export const queries = ['list_projects','list_tasks','get_task','get_effective_config','get_usage','list_audit','get_capabilities','search_knowledge','read_knowledge','knowledge_versions', ...schedulingQueries] as const;
export const querySchema = obj({ operation: { type:'string', enum: queries }, target: obj({ project_id: str, task_id: str, workflow_id: str }), arguments: obj({ offset: integer, limit: { type:'integer',minimum:1,maximum:100 }, section: { type:'string',enum:['detail','logs','runs','events','roles','source'] }, source: str, query: str, id:str, revision:{type:'integer',minimum:1}, baseline:str, plan: planSchema, schedule_id: str }) }, ['operation','target','arguments']);
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
      for(const [key,v] of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))fail(400,'unexpected_management_field');if(Object.hasOwn(properties,key))validate(properties[key] as Json,v);else if(schema.additionalProperties===false)fail(400,'unexpected_management_field');}
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
  { type:'function',function:{name:'management_command',description:'Execute an authorized business command. Read its current revision first. Ordinary operations execute directly; deterministic organization policy alone can require approval.',parameters:toolCommandSchema} },
];
