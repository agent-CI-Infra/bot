import {Workspace} from '../agent/workspace.js';
import {randomId} from '../core/security.js';
import {traceEvent} from '../tasks/trace.js';
import {stop} from '../agent/common.js';
import type {Row} from '../storage/database.js';
import type {RoleRunOptions} from './run.js';
/** One writer; observers get disposable checkouts bound to the writer's snapshot. */
export function roleWorkspaces(workspace:Workspace){let active=workspace;return {get current(){return active;},async prepare(role:string){active=workspace;const snapshot=await workspace.artifact('role-source:'+randomId());if(role==='dev'){traceEvent(workspace.store,workspace.task.id,'role_candidate',{role,version:snapshot.tree_sha,sha:snapshot.local_sha,workspace_id:workspace.task.workspace_id},workspace.task.trace_run_id);return;}const isolated=new Workspace(workspace.store,workspace.manager,{...workspace.task,workspace_id:randomId()},workspace.redactor,workspace.guard,workspace.log);const ready=await isolated.call('role-checkout:'+randomId(),{type:'workspace_acceptance',source_workspace_id:workspace.task.workspace_id,sha:snapshot.local_sha,tree_sha:snapshot.tree_sha});if(ready.error)stop('role_snapshot_unavailable','waiting_environment');traceEvent(workspace.store,workspace.task.id,'role_candidate',{role,version:snapshot.tree_sha,sha:snapshot.local_sha,workspace_id:isolated.task.workspace_id},workspace.task.trace_run_id);active=isolated;return async()=>{active=workspace;await isolated.release(false);};},
 controller:controllerWorkspace(workspace)};}

/** The runner's view of a Pi session in one workspace; null when that workspace or session no longer exists. */
async function piState(space:Workspace){try{const state=await space.call('pi:probe:'+randomId(),{type:'workspace_agent_poll',offset:0});return state.error?null:state;}catch{return null;}}
const report=(space:Workspace,instance:Row,expected:string,recovery:string)=>(runtime:any)=>traceEvent(space.store,space.task.id,'harness_started',{harness:'pi',package:runtime.package,version:runtime.version,expected_version:expected,node:runtime.node,instance_id:instance.id,role:instance.role,workspace_id:space.task.workspace_id,recovery},space.task.trace_run_id);
/**
 * The project controller's Pi session lives in its own empty workspace on the project computer: no repository checkout,
 * no shell or file tools, and nothing shared with the task workspace. Each run gets a fresh one. After an interruption
 * (a control-plane restart) the run reattaches to the session still living in its previous workspace: native resume.
 */
export function controllerWorkspace(workspace:Workspace):NonNullable<RoleRunOptions['prepare']>{
 return async(instance,resolved)=>{
  if(resolved.snapshot.harness.id!=='pi')return;
  const {store,task}=workspace,runtime=instance.runtime?JSON.parse(instance.runtime):null;
  const last=store.get('SELECT status FROM task_runs WHERE role_instance_id=? ORDER BY rowid DESC LIMIT 1',instance.id);
  let space:Workspace|undefined,resume=false;
  // Only a run interrupted by a control-plane crash can leave a session to reattach. A cancelled or failed run released its
  // workspace; its next run is rebuilt from task records, never reported as native resume.
  if(runtime?.workspace_id&&runtime.generation===task.generation&&last?.status==='interrupted'){
   const previous=new Workspace(store,workspace.manager,{...task,workspace_id:runtime.workspace_id},workspace.redactor,workspace.guard,workspace.log);
   // Only a session still running is reattached. One that already ended is rebuilt from task records: its submission
   // may be stale by now, and the delegations it made are reused from their durable results.
   const state=await piState(previous);if(state?.state==='running'){space=previous;resume=true;}
  }
  if(!space){
   space=new Workspace(store,workspace.manager,{...task,workspace_id:randomId()},workspace.redactor,workspace.guard,workspace.log);
   const ready=await space.call('controller:init:'+space.task.workspace_id,{type:'workspace_init'});if(ready.error)stop('controller_workspace_unavailable','waiting_environment','无法在项目电脑上准备主控会话工作区。');
   store.run('UPDATE role_instances SET runtime=? WHERE id=?',JSON.stringify({workspace_id:space.task.workspace_id,generation:task.generation,created_at:new Date().toISOString()}),instance.id);
  }
  const live=space;
  return {pi:{workspace:live,resume,key:'pi:'+live.task.workspace_id,runtime:{version:resolved.snapshot.harness.version,report:report(live,instance,resolved.snapshot.harness.version,resume?'native_resume':'new_session')}},release:()=>live.release(false)};
 };
}
/**
 * The entry executor: the workflow's own Pi session in the task workspace, now run as the dev role assignment. Its tools,
 * permissions and finish come from the workflow profile exactly as before. A session that survived an interruption in
 * this workspace is reattached (the runner never starts a second process for one workspace).
 */
export function executorWorkspace(workspace:Workspace,session:NonNullable<import('../agent/pi.js').PiRoleEnvironment['session']>,round:string):NonNullable<RoleRunOptions['prepare']>{
 return async(instance,resolved)=>{
  const state=await piState(workspace),resume=!!state&&['running','completed','review_ready','review_resuming'].includes(state.state);
  // Operation keys of this call only: a later call in the same attempt sends its own configuration.
  return {pi:{workspace,session,resume,key:'pi:'+round,runtime:{version:resolved.snapshot.harness.version,report:report(workspace,instance,resolved.snapshot.harness.version,resume?'native_resume':'new_session')}}};
 };
}
