import { latestRoleCandidate } from './schedule.js';
import { eventHistory, historyOrder } from './role-run.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Workspace} from '../agent/workspace.js';
import {randomId} from '../core/security.js';
import {traceEvent} from '../tasks/trace.js';
import {stop} from '../agent/common.js';
import type {Row} from '../storage/database.js';
import type {RoleRunOptions} from './run.js';
import {environmentProfiles} from './catalog.js';
import {RunEnvironmentClient,provisionRunEnvironment,copyCommit} from '../projects/run-environment.js';
/**
 * A container of its own for one run of a role whose environment profile requires run isolation. It is seeded with the
 * fixed snapshot of the task workspace by copying that commit's objects, never by mounting the workspace, and its tree is
 * verified. The adapter receives {client, run_id}; the manager's inspection decides run_isolation in admission.
 */
export function isolatedRunEnvironment(workspace:Workspace,given?:RunEnvironmentClient):NonNullable<RoleRunOptions['prepare']>{
 return async(instance,resolved)=>{
  const profile=environmentProfiles.find(e=>e.id===resolved.snapshot.environment.id) as {isolation?:string}|undefined;
  if(profile?.isolation!=='run_container')return;
  // Built only when a profile needs it: most runs never touch the run-environment API.
  const client=given??new RunEnvironmentClient(workspace.manager,String(workspace.task.repository_id));
  const id=randomId(),kind=resolved.snapshot.kind;
  const env=await provisionRunEnvironment(client,{run_id:id,task_id:String(workspace.task.id),lease_epoch:0,profile:kind==='writer'?'writer':'observer',network:'none'});
  traceEvent(workspace.store,workspace.task.id,'role_run_environment',{role:instance.role,instance_id:instance.id,environment_id:id,verified:env.facts.verified,violations:(env.facts.detail as any)?.violations??[],container:(env.facts.detail as any)?.container??null,limits:(env.facts.detail as any)?.limits??null},workspace.task.trace_run_id);
  if(!env.facts.verified)return {environment:{facts:env.facts,handle:null}};
  try{
   const snapshot=kind==='writer'?await workspace.artifact('role-source:'+randomId()):await observerSnapshot(workspace);
   const seeded=await copyCommit({call:request=>workspace.deliver(request)},client,id,snapshot.local_sha,snapshot.tree_sha);
   traceEvent(workspace.store,workspace.task.id,'role_candidate',{role:instance.role,version:seeded.tree_hash,sha:seeded.commit_sha,workspace_id:id,environment:'run:'+id},workspace.task.trace_run_id);
  }catch(error){await env.release();throw error;}
  // Only a writer's environment produces a candidate snapshot; an observer's build output never becomes one.
  const snapshot=kind==='writer'?async()=>{const s=await client.call(id,{type:'workspace_finalize'});return s?.tree_sha&&s?.local_sha?{tree_sha:s.tree_sha,local_sha:s.local_sha}:null;}:undefined;
  return {environment:{facts:env.facts,handle:{client,run_id:id},...(snapshot?{snapshot}:{})},release:env.release};
 };
}
async function observerSnapshot(workspace:Workspace) {
 const pinned=latestRoleCandidate(workspace.store,workspace.task.id);
 if(workspace.store.get('SELECT 1 FROM task_stage_plans WHERE task_id=?',workspace.task.id)){
  if(pinned?.kind==='code')return {local_sha:pinned.commit_sha,tree_sha:pinned.tree_hash};
  const row=workspace.store.get(`SELECT h.data FROM role_run_events e JOIN task_runs r ON r.id=e.run_id JOIN task_history h ON ${eventHistory} WHERE e.task_id=? AND e.type='ended' AND e.category='completed' AND r.role='dev' AND r.revision=(SELECT revision FROM task_records WHERE task_id=e.task_id) ORDER BY ${historyOrder} DESC LIMIT 1`,workspace.task.id);
  const snapshot=row?JSON.parse(row.data).data.source_snapshot:null;if(snapshot)return {local_sha:snapshot.commit_sha,tree_sha:snapshot.tree_hash};
 }
 return workspace.artifact('role-source:'+randomId());
}
/** One writer; observers get disposable checkouts bound to the writer's snapshot. */
export function roleWorkspaces(workspace:Workspace){const context=new AsyncLocalStorage<{space:Workspace;role:string;run_id?:string}>();let fallback=workspace;const setActive=(space:Workspace)=>{const current=context.getStore();if(current)current.space=space;else fallback=space;};return {get runId(){return context.getStore()?.run_id??workspace.task.trace_run_id;},bindRun:(id:string)=>{const current=context.getStore();if(current)current.run_id=id;},get current(){return context.getStore()?.space??fallback;},get role(){return context.getStore()?.role??workspace.task.active_role;},withRole:<R>(role:string,work:()=>Promise<R>)=>context.run({space:workspace,role},work),snapshot:async()=>workspace.artifact('role-output:'+randomId()),async prepare(role:string){setActive(workspace);const snapshot=role==='dev'?await workspace.artifact('role-source:'+randomId()):await observerSnapshot(workspace);if(role==='dev'){traceEvent(workspace.store,workspace.task.id,'role_candidate',{role,version:snapshot.tree_sha,sha:snapshot.local_sha,workspace_id:workspace.task.workspace_id},workspace.task.trace_run_id);return;}const isolated=new Workspace(workspace.store,workspace.manager,{...workspace.task,workspace_id:randomId()},workspace.redactor,workspace.guard,workspace.log);const ready=await isolated.call('role-checkout:'+randomId(),{type:'workspace_acceptance',source_workspace_id:workspace.task.workspace_id,sha:snapshot.local_sha,tree_sha:snapshot.tree_sha});if(ready.error)stop('role_snapshot_unavailable','waiting_environment');traceEvent(workspace.store,workspace.task.id,'role_candidate',{role,version:snapshot.tree_sha,sha:snapshot.local_sha,workspace_id:isolated.task.workspace_id},workspace.task.trace_run_id);setActive(isolated);return async()=>{setActive(workspace);await isolated.release(false);};},
 controller:roleBackendWorkspace(workspace),worker:roleBackendWorkspace(workspace),isolated:isolatedRunEnvironment(workspace)};}

/** The runner's view of a Pi session in one workspace; null when that workspace or session no longer exists. */
async function piState(space:Workspace){try{const state=await space.call('pi:probe:'+randomId(),{type:'workspace_agent_poll',offset:0});return state.error?null:state;}catch{return null;}}
const report=(space:Workspace,instance:Row,expected:string,recovery:string)=>(runtime:any)=>traceEvent(space.store,space.task.id,'harness_started',{harness:'pi',package:runtime.package,version:runtime.version,expected_version:expected,node:runtime.node,instance_id:instance.id,role:instance.role,workspace_id:space.task.workspace_id,recovery},space.task.trace_run_id);
/**
 * A Pi backend session lives in a separate empty workspace. Every role tool is forwarded to its existing control-plane
 * callback, so writer/observer/QA tools still address the correct task or fixed-candidate workspace. Selecting Pi never
 * gives a role a broader local tool profile. QA and coordination always rebuild from their supplied durable facts.
 */
export function roleBackendWorkspace(workspace:Workspace):NonNullable<RoleRunOptions['prepare']>{
 return async(instance,resolved)=>{
  if(resolved.snapshot.harness.id!=='pi')return;
  const {store,task}=workspace,runtime=instance.runtime?JSON.parse(instance.runtime):null;
  const last=store.get('SELECT status FROM task_runs WHERE role_instance_id=? ORDER BY rowid DESC LIMIT 1',instance.id);
  let space:Workspace|undefined,resume=false;
  // Only a run interrupted by a control-plane crash can leave a session to reattach. A cancelled or failed run released its
  // workspace; its next run is rebuilt from task records, never reported as native resume.
  if(!['qa','coordinator'].includes(String(instance.role))&&runtime?.workspace_id&&runtime.generation===task.generation&&last?.status==='interrupted'){
   const previous=new Workspace(store,workspace.manager,{...task,workspace_id:runtime.workspace_id},workspace.redactor,workspace.guard,workspace.log);
   // Only a session still running is reattached. One that already ended is rebuilt from task records: its submission
   // may be stale by now, and the delegations it made are reused from their durable results.
   const state=await piState(previous);if(state?.state==='running'){space=previous;resume=true;}
  }
  if(!space){
   space=new Workspace(store,workspace.manager,{...task,workspace_id:randomId()},workspace.redactor,workspace.guard,workspace.log);
   const ready=await space.call('backend:init:'+space.task.workspace_id,{type:'workspace_init'});if(ready.error)stop('controller_workspace_unavailable','waiting_environment','无法在项目电脑上准备 Agent 后端会话工作区。');
   store.run('UPDATE role_instances SET runtime=? WHERE id=?',JSON.stringify({workspace_id:space.task.workspace_id,generation:task.generation,created_at:new Date().toISOString()}),instance.id);
  }
  const live=space;
  return {pi:{workspace:live,resume,key:'pi:'+live.task.workspace_id,runtime:{version:resolved.snapshot.harness.version,report:report(live,instance,resolved.snapshot.harness.version,resume?'native_resume':'new_session')}},release:()=>live.release(false)};
 };
}
/** Compatibility name: controllers use the same backend preparation as every other role. */
export const controllerWorkspace = roleBackendWorkspace;
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
