import type { Store, Row } from '../storage/database.js';
import { selectedModel } from '../agent/model.js';
import { taskWorkflow, workflowPermissions } from '../workflows/resolve.js';
import { stop, TaskError } from '../agent/common.js';
import { builtinWorkflow } from '../workflows/catalog.js';
import { resolveRules } from '../rules/service.js';
import { roleConfiguration } from '../roles/definition.js';

export function taskConfiguration(store:Store,task:Row):any|null{
  const row=store.get('SELECT snapshot FROM task_execution_configs WHERE task_id=?',task.id??'');return row?JSON.parse(row.snapshot):null;
}
export function captureTaskConfiguration(store:Store,id:string):void{
  const task=store.get('SELECT * FROM tasks WHERE id=?',id);if(!task)return;
  try{executionModel(store,task);}catch(error){
    // A task created before any usable model exists remains repairable through the normal configuration wait.
    if(!(error instanceof TaskError&&error.state==='waiting_configuration'))throw error;
  }
}
/** Capture once per explicitly adopted execution revision. Credentials are sealed, and omitted from public snapshots. */
export function executionModel(store:Store,task:Row,kind=taskWorkflow(task as any)){
  if(!task.id||!store.get('SELECT 1 FROM tasks WHERE id=?',task.id))return selectedModel(store,task.repository_id,kind);
  let config=taskConfiguration(store,task);
  if(!config){
    const model=selectedModel(store,task.repository_id,kind),{key,...metadata}=model;
    config={policy:store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id),
      workflow:store.get('SELECT * FROM workflows WHERE repository_id=? AND id=?',task.repository_id,kind)??null,
      permissions:builtinWorkflow(kind)||store.get('SELECT 1 FROM workflows WHERE repository_id=? AND id=?',task.repository_id,kind)?workflowPermissions(store,task.repository_id,kind):null,roles:roleConfiguration(store,task.repository_id),
      model:metadata,credentials:store.secrets.seal({value:key},'task-model:'+task.id)};
    store.run('INSERT OR IGNORE INTO task_execution_configs VALUES(?,?,?,?)',task.id,JSON.parse(task.input||'{}').configuration_revision??1,JSON.stringify(config),new Date().toISOString());
    config=taskConfiguration(store,task);
  }
  // Selection is fixed. The shared provider boundary still checks live model credentials/version and project grants.
  const current=store.get(`SELECT * FROM models WHERE id=? AND (repository_id=? OR (repository_id IS NULL AND EXISTS
    (SELECT 1 FROM model_projects WHERE model_id=models.id AND repository_id=?)))`,config.model.id,task.repository_id,task.repository_id);
  if(!current?.api_key)stop('model_not_configured','waiting_configuration',`仓库 ${task.repository_id} 的固定模型已被删除、撤销凭据或撤销共享授权；不会自动切换模型。`);
  const key=String(store.secrets.open(config.credentials,'task-model:'+task.id).value||'');
  const liveKey=String(store.secrets.open(current!.api_key,'model:'+current!.id).value||'');
  if(current!.version!==config.model.version||current!.api_url!==config.model.url||current!.model_name!==config.model.model||liveKey!==key)stop('model_configuration_changed','waiting_configuration','固定的执行模型版本或凭据已变化，请显式采用新配置。');
  return {...config.model,key} as ReturnType<typeof selectedModel>;
}
export function supplementalInstructions(store:Store,task:Row):string[]{
  return store.all("SELECT data FROM task_history WHERE task_id=? AND type='supplemental_instruction' ORDER BY id DESC LIMIT 30",task.id).reverse().map(r=>String(JSON.parse(r.data).instruction));
}
export function executionRuleFiles(store:Store,task:Row,files:Record<string,string>,sha:string):Record<string,string>{
  const config=taskConfiguration(store,task);if(!config)return files;
  if(config.rule_files)return config.rule_files;
  // Invalid input has not become an execution snapshot. A repaired default-branch file must remain retryable.
  resolveRules(config.policy,files);
  config.rule_files=files;config.rule_sha=sha;
  store.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?',JSON.stringify(config),task.id);
  return files;
}
