import { latestRoleCandidate } from './schedule.js';
import { eventHistory, historyOrder } from './role-run.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Workspace} from '../agent/workspace.js';
import {randomId} from '../core/security.js';
import {traceEvent} from '../tasks/trace.js';
import {stop} from '../agent/common.js';
import type {Row} from '../storage/database.js';
import type {RoleRunOptions} from './run.js';

async function observerSnapshot(workspace:Workspace) {
 const pinned=latestRoleCandidate(workspace.store,workspace.task.id);
 if(workspace.store.get('SELECT 1 FROM task_stage_plans WHERE task_id=?',workspace.task.id)){
  if(pinned?.kind==='code')return {local_sha:pinned.commit_sha,tree_sha:pinned.tree_hash};
  const row=workspace.store.get(`SELECT h.data FROM role_run_events e JOIN task_runs r ON r.id=e.run_id JOIN task_history h ON ${eventHistory} WHERE e.task_id=? AND e.type='ended' AND e.category='completed' AND r.role='dev' AND r.revision=(SELECT revision FROM task_records WHERE task_id=e.task_id) ORDER BY ${historyOrder} DESC LIMIT 1`,workspace.task.id);
  const snapshot=row?JSON.parse(row.data).data.source_snapshot:null;if(snapshot)return {local_sha:snapshot.commit_sha,tree_sha:snapshot.tree_hash};
 }
 return workspace.artifact('role-source:'+randomId());
}
/**
 * On-demand read-only git worktree checkout of a commit when multiple readers need independent working trees from the
 * project computer's shared git store (`repo.git`). Never copies or clones a task directory.
 */
export async function candidateCheckout(source:Pick<Workspace,'store'|'manager'|'task'|'redactor'|'guard'|'log'>,sha:string,tree:string,_key?:string){
 const space=new Workspace(source.store,source.manager,{...source.task,workspace_id:randomId()},source.redactor,source.guard,source.log);
 const worktree=await space.observe(source.task,sha,tree);
 if(!worktree){await space.release(false);return null;}
 return {space,worktree_id:worktree.id,release:async()=>{await space.release(false);space.releaseWorktree('reader_finished');}};
}
/**
 * Roles within the same task share `workspace` directly in place so dependencies (`node_modules`), build caches and test
 * artifacts produced by `dev` remain available to `test`, `reviewer`, `ux` and `qa` without re-cloning.
 */
export function roleWorkspaces(workspace:Workspace){
 const context=new AsyncLocalStorage<{space:Workspace;role:string;run_id?:string;observer?:{local_sha:string;tree_sha:string}}>();
 let fallback=workspace;
 const setActive=(space:Workspace)=>{const current=context.getStore();if(current)current.space=space;else fallback=space;};
 const activeWorktree=()=>workspace.store.hasTable('worktree_bindings')?workspace.store.get('SELECT worktree_id FROM worktree_bindings WHERE task_id=? AND workspace_id=? AND released_at IS NULL',workspace.task.id,workspace.task.workspace_id)?.worktree_id??null:null;
 return {
  get runId(){return context.getStore()?.run_id??workspace.task.trace_run_id;},
  bindRun:(id:string)=>{const current=context.getStore();if(current)current.run_id=id;},
  get current(){return context.getStore()?.space??fallback;},
  get role(){return context.getStore()?.role??workspace.task.active_role;},
  withObservers:async<R>(work:()=>Promise<R>)=>{const observer=await observerSnapshot(workspace);return context.run({space:workspace,role:'manager',observer},work);},
  withRole:<R>(role:string,work:()=>Promise<R>)=>context.run({space:workspace,role,observer:context.getStore()?.observer},work),
  snapshot:async()=>workspace.artifact('role-output:'+randomId()),
  async prepare(role:string){
   setActive(workspace);
   const snapshot=role==='dev'?await workspace.artifact('role-source:'+randomId()):(context.getStore()?.observer??await observerSnapshot(workspace));
   const worktreeId=activeWorktree();
   traceEvent(workspace.store,workspace.task.id,'role_candidate',{role,version:snapshot.tree_sha,sha:snapshot.local_sha,workspace_id:workspace.task.workspace_id,...(worktreeId?{worktree_id:worktreeId}:{})},workspace.task.trace_run_id);
   return undefined;
  },
  controller:roleBackendWorkspace(workspace),
  worker:roleBackendWorkspace(()=>context.getStore()?.space??fallback),
 };
}

/** The runner's view of a Pi session in one workspace; null when that workspace or session no longer exists. */
async function piState(space:Workspace){try{const state=await space.call('pi:probe:'+randomId(),{type:'workspace_agent_poll',offset:0});return state.error?null:state;}catch{return null;}}
const report=(space:Workspace,instance:Row,expected:string,recovery:string)=>(runtime:any)=>traceEvent(space.store,space.task.id,'harness_started',{harness:'pi',package:runtime.package,version:runtime.version,expected_version:expected,node:runtime.node,instance_id:instance.id,role:instance.role,workspace_id:space.task.workspace_id,recovery},space.task.trace_run_id);
const computerEgress=(environment:any)=>typeof environment?.computer?.egress==='boolean'?environment.computer.egress:environment?.computer?.network_policy==='internet egress';
/**
 * A Pi backend session lives in a separate empty workspace; `claude_code` and `codex` run directly inside the active
 * task/candidate checkout (`<task_dir>/repo`) with in-container model relay and stdio MCP platform tools (#705).
 */
export function roleBackendWorkspace(workspaceOrGetter:Workspace|(()=>Workspace)):NonNullable<RoleRunOptions['prepare']>{
 return async(instance,resolved)=>{
  const workspace=typeof workspaceOrGetter==='function'?workspaceOrGetter():workspaceOrGetter;
  if(['claude_code','codex'].includes(resolved.snapshot.harness.id)){
   // The CLI works in the checkout with its own file tools, so the task's worktree is bound before it starts (#769).
   const ready=await workspace.ensure?.()??{};if(ready.error)stop('workspace_unavailable','waiting_environment',ready.message);
   let egress=false;
   try{const env=await workspace.manager.call('GET','/v1/projects/'+workspace.task.repository_id);egress=computerEgress(env);}catch{}
   return {roleWorkspace:workspace,containerOptions:{manager:workspace.manager,egress}};
  }
  if(resolved.snapshot.harness.id!=='pi')return;
  const {store,task}=workspace,runtime=instance.runtime?JSON.parse(instance.runtime):null;
  const last=store.get('SELECT status FROM task_runs WHERE role_instance_id=? ORDER BY rowid DESC LIMIT 1',instance.id);
  let space:Workspace|undefined,resume=false;
  if(runtime?.guidance_retired&&runtime.workspace_id){
   // Retiring a protocol also retires its live runner, which may otherwise wait forever on an obsolete mailbox.
   const previous=new Workspace(store,workspace.manager,{...task,workspace_id:runtime.workspace_id},workspace.redactor,workspace.guard,workspace.log);
   await previous.release(false);
  }
  // Only a run interrupted by a control-plane crash can leave a session to reattach. A cancelled or failed run released its
  // workspace; its next run is rebuilt from task records, never reported as native resume.
  if(!runtime?.guidance_retired&&!['qa','coordinator'].includes(String(instance.role))&&runtime?.workspace_id&&runtime.generation===task.generation&&last?.status==='interrupted'){
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
  let egress=false;try{egress=computerEgress(await workspace.manager.call('GET','/v1/projects/'+task.repository_id));}catch{}
  return {roleWorkspace:workspace,containerOptions:{manager:workspace.manager,egress},pi:{workspace:live,resume,key:'pi:'+live.task.workspace_id,runtime:{version:resolved.snapshot.harness.version,report:report(live,instance,resolved.snapshot.harness.version,resume?'native_resume':'new_session')}},release:()=>live.release(false)};
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
