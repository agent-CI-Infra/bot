import type {AgentSpec,AgentServices} from '../agent/runtime.js';
import {runAgent} from '../agent/runtime.js';
import type {Row} from '../storage/database.js';
import type {Manager} from '../projects/service.js';
import {randomId} from '../core/security.js';
import {stop} from '../agent/common.js';
import {Workspace} from '../agent/workspace.js';
import {roleHarness} from '../roles/harness.js';
import {harnessAccess} from '../harness/access.js';
import {traceEvent} from '../tasks/trace.js';

/** Event routing is a Manager turn too. Its native session belongs to the dispatch event, never a fabricated Task.
 * A driver that runs in the project computer (Pi, Codex, Claude Code, ACP) waits for it; one that runs in the control
 * plane (the process driver) needs no project runtime (#1256). */
export async function runDispatchHarness<T>(spec:AgentSpec<T>,role:Row,event:Row,manager?:Manager):Promise<T>{
 const store=spec.store,backend=role.harness_ref.id,driver=roleHarness(backend),inProject=driver.environment!=='control_plane';
 let environment:any=null;
 if(inProject){
  if(!manager)return stop('harness_environment_required','waiting_environment','The configured event Manager Harness requires a project runtime; no Native fallback was used.');
  environment=await manager.call('GET','/v1/projects/'+event.repository_id);
  if(!environment)environment=await manager.call('PUT','/v1/projects/'+event.repository_id);
  if(!['ready','busy'].includes(environment?.state))return stop('environment_not_ready','waiting_environment');
 }
 store.db.exec(`CREATE TABLE IF NOT EXISTS dispatch_harness_sessions(event_id TEXT NOT NULL REFERENCES dispatch_events(id) ON DELETE CASCADE,attempt INTEGER NOT NULL,harness TEXT NOT NULL,workspace_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(event_id,attempt));`);
 const attempt=Number(event.attempts),previous=store.get('SELECT * FROM dispatch_harness_sessions WHERE event_id=? AND attempt=?',event.id,attempt);
 const workspaceId=previous?.workspace_id??randomId(),binding='dispatch:'+event.id+':'+attempt;
 store.run('INSERT OR IGNORE INTO dispatch_harness_sessions(event_id,attempt,harness,workspace_id) VALUES(?,?,?,?)',event.id,attempt,backend,workspaceId);
 const task={...spec.task,id:binding,conversation_id:binding,workspace_id:workspaceId,generation:environment?.generation};
 const workspace=inProject?new Workspace(store,manager!,task,spec.redactor,spec.guard,event=>traceEvent(store,task.id,'harness_event',event), 'service_role_operations'):undefined;
 if(workspace&&(await workspace.call('dispatch-init',{type:'workspace_init'})).error)return stop('controller_workspace_unavailable','waiting_environment');
 const token=randomId();spec.redactor.add(token);
 const access=harnessAccess(role.permissions,environment?.computer?.egress===true||environment?.computer?.network_policy==='internet egress',store.get('SELECT full_name FROM repositories WHERE id=?',event.repository_id)?.full_name??null);
 const current:AgentSpec<T>={...spec,task,...(workspace?{roleWorkspace:workspace}:{}),harnessAccess:access,harnessSessionKey:binding,
  harnessTurnLimit:['bounded','metered'].includes(role.budget_policy_ref?.id)?role.budget_policy_ref.max_turns:undefined,
  ...(manager?{containerOptions:{manager,egress:access.network}}:{}),
  harnessState:{value:previous?JSON.parse(previous.state):{},save:state=>store.run('UPDATE dispatch_harness_sessions SET state=? WHERE event_id=? AND attempt=?',JSON.stringify(spec.redactor.clean(state)),event.id,attempt)},
  runAccess:{token,check:presented=>{if(presented!==token)stop('run_token_invalid','failed');}},
  runContext:()=>({protocol:'bot.role-run/1',task_id:null,conversation_id:binding,assignment_id:binding,run_id:binding,tenant_id:String(store.get('SELECT owner_id FROM repositories WHERE id=?',event.repository_id)?.owner_id??'project'),project_id:String(event.repository_id),principal_ref:'role:manager',source_ref:'dispatch_event:'+event.id,candidate_ref:null,configuration_snapshot_ref:'dispatch:'+event.id,lease_epoch:Math.max(1,attempt),contract_revision:0,policy_revision:'dispatch',role_revision:String(role.revision),harness_revision:driver.version,skill_revisions:[],model_revision:String(spec.model?.version??1),budget:{policy_ref:'dispatch',accounting:'per_run',max_turns:null,max_output_tokens:null,max_total_tokens:null,max_model_requests:null,max_tool_calls:null,max_wall_ms:null,max_concurrency:1},execution_context:{role_instance_id:binding,role:'manager',kind:'controller',environment_profile:'workspace'}}),
  ...(workspace?{pi:{workspace,key:binding+':'+randomId(),resume:false,runtime:{version:driver.version,report:event=>traceEvent(store,task.id,'harness_event',{type:'runtime',...event})}}}:{}),
 };
 if(driver.prepare)await driver.prepare(current);
 const adapter=driver.adapter(current);
 try{return await runAgent({...current,adapter:(services:AgentServices)=>adapter({...services,request:(body,id,onToken,onFinish,options)=>services.request(body,id,onToken,onFinish,{...options,harnessTools:true})})});}
 finally{await workspace?.release(false);}
}
