import type { Store, Row } from '../storage/database.js';
import type { Workspace } from '../agent/workspace.js';
import { randomId } from '../core/security.js';
import { TaskRecords } from './service.js';
import { stop } from '../agent/common.js';

/** A progress checkpoint retains unpublished code/artifacts without pretending they passed acceptance. */
export async function checkpoint(store:Store,task:Row,workspace:Workspace){
  const input=JSON.parse(store.get('SELECT input FROM tasks WHERE id=?',task.id)!.input),records=new TaskRecords(store);
  const revision=records.get(task.id).revision;
  const snapshot=await workspace.artifact('checkpoint:'+randomId());
  const recovery={source_workspace_id:task.workspace_id,base_sha:input.snapshot_sha||task.head_sha,revision,
    sha:snapshot.local_sha,tree_sha:snapshot.tree_sha,created_at:new Date().toISOString()};
  records.atomic(()=>{
    records.assertClaim(task.id,task.claim_token);
    const current=store.get('SELECT input,workspace_id FROM tasks WHERE id=?',task.id)!;
    if(records.get(task.id).revision!==revision||current.workspace_id!==task.workspace_id)return stop('checkpoint_context_changed','retry_wait','保存进度时需求版本或工作区已变化。');
    store.run('UPDATE tasks SET input=?,updated_at=? WHERE id=?',JSON.stringify({...JSON.parse(current.input),recovery}),new Date().toISOString(),task.id);
    records.history(task.id,'artifact_checkpoint',recovery);
  });return recovery;
}
export async function restoreCheckpoint(store:Store,task:Row,workspace:Workspace,baseSha:string){
  const input=JSON.parse(store.get('SELECT input FROM tasks WHERE id=?',task.id)!.input),saved=input.recovery;
  if(!saved||saved.source_workspace_id===task.workspace_id)return;
  const records=new TaskRecords(store);
  const owned=store.get("SELECT 1 FROM task_history WHERE task_id=? AND type='artifact_checkpoint' AND json_extract(data,'$.source_workspace_id')=? AND json_extract(data,'$.sha')=? AND json_extract(data,'$.tree_sha')=?",task.id,saved.source_workspace_id,saved.sha,saved.tree_sha);
  if(!owned){records.history(task.id,'checkpoint_not_restored',{reason:'checkpoint_ownership_unverified'});return;}
  if(saved.revision!==records.get(task.id).revision||saved.base_sha!==baseSha){records.history(task.id,'checkpoint_not_restored',{reason:'contract_or_base_changed',checkpoint:saved});return;}
  const restored=await workspace.call('restore:'+saved.sha,{type:'workspace_restore',source_workspace_id:saved.source_workspace_id,sha:saved.sha,tree_sha:saved.tree_sha});
  if(restored.error)return stop('checkpoint_unavailable','waiting_environment','已保存的进度成果暂时不可恢复，未覆盖新工作区。');
  records.history(task.id,'checkpoint_restored',{...saved,workspace_id:task.workspace_id});
}
