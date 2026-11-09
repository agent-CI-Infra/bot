import { taskTraceAccess } from '../memory/access.js';
import { checkpoint } from '../tasks/checkpoint.js';
import {runTeam} from './team.js';
import {roleWorkspaces} from './workspace.js';
import {taskTools} from '../tasks/playbooks.js';
import {TaskRecords} from '../tasks/service.js';
import {memoryTools,memoryTool} from '../memory/project.js';
import type {Workspace} from '../agent/workspace.js';
import {randomId} from '../core/security.js';
import {traceEvent} from '../tasks/trace.js';
import {stop,blobSha} from '../agent/common.js';
import type {AgentSpec} from '../agent/runtime.js';
const tool=(name:string,description:string,properties:any,required:string[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
/** Existing engine remains the publisher and QA authority; team only prepares its input. */
export async function developmentTeam(workspace:Workspace,system:string,prompt:string,publish:(id:string,args:any)=>Promise<any>,access:{read:boolean;write:boolean;shell:boolean}){
 const {store,task,redactor,guard}=workspace,records=new TaskRecords(store),spaces=roleWorkspaces(workspace);
 const submit=tool('submit_delivery','Submit code candidate metadata for mandatory QA and framework publication. Never publish yourself.',{summary:{type:'string'},test_command:{type:'string'},change_title:{type:'string'},release_label:{type:'string'}},['summary','test_command']);
 const validate=(v:any)=>{if(!v||typeof v.summary!=='string'||!v.summary.trim()||typeof v.test_command!=='string'||!v.test_command.trim())return stop('role_delivery_invalid','retry_wait');return redactor.clean(v);};
 for(let round=0;round<3;round++){
  const spec:AgentSpec<any>={store,task,redactor,guard,candidateSnapshot:async()=>{const snapshot=await spaces.current.artifact('role-collect:'+randomId());return {tree_sha:snapshot.tree_sha,local_sha:snapshot.local_sha};},system:system.replace(/ At task start, read the existing notes[\s\S]*?Notes are never committed or put in a publication tree\./,' Use project/role memory tools for durable knowledge. Do not write ../notes files.').replace(/When ready, call create_pull_request:[\s\S]*?ends development\./,'When ready, call submit_delivery with PR metadata; framework QA and publication follow. Never call create_pull_request yourself.'),prompt,maxTurns:64,maxOutputTokens:16384,tools:[...(access.read?[tool('read_file','Read text from this role workspace',{path:{type:'string'}},['path'])]:[]),...(access.write?[tool('write_file','Write repository relative text',{path:{type:'string'},content:{type:'string'}},['path','content'])]:[]),...(access.shell?[tool('run_command','Run verification/implementation commands without publication or credentials',{command:{type:'string'}},['command'])]:[]),submit,...taskTools,...memoryTools],finish:{name:'submit_delivery',validate},finalizationTools:['submit_delivery'],validate:content=>validate(JSON.parse(content)),execute:async(name,args)=>{
   if(taskTools.some(t=>t.function.name===name)){const result=records.tool(task.id,name,redactor.clean(args),taskTraceAccess(store,task));if(name==='record_progress'&&task.active_role==='dev')await checkpoint(store,task,workspace);return result;}
   if(memoryTools.some(t=>t.function.name===name))return memoryTool(store,task,name,redactor.clean(args),async doc=>{const raw=await spaces.current.call('role-memory:'+randomId(),{type:'workspace_read',path:doc.path});if(raw.error)throw new Error('memory_source_unavailable');return {content:raw.content,sha:blobSha(Buffer.from(raw.content))};});
   if(name==='run_command'&&typeof args?.command==='string'&&[...args.command.matchAll(/\/tasks\/([a-f0-9]{48})\//g)].some(m=>m[1]!==spaces.current.task.workspace_id))return {error:'stale_workspace_reference',instruction:'Use repository-relative commands in the CURRENT role workspace. Read old observations through task records; do not run commands in a previous dev or observer checkout.'};
   if(name==='write_file'&&(typeof args?.path!=='string'||args.path.startsWith('/')||args.path.split('/').includes('..')))return {error:'invalid_artifact_path',instruction:'Write repository-relative files only. Use remember_role_memory for durable role experience; legacy ../notes writes are not available in this harness.'};
   const active=spaces.current,key='role-tool:'+randomId();const snapshot=await active.artifact(key+':version');
   const result=name==='read_file'?await active.call(key,{type:'workspace_read',path:args?.path}):name==='write_file'?(await active.write(key,args?.path,Buffer.from(args?.content??'')),{ok:true}):name==='run_command'?await active.call(key,{type:'workspace_command',command:args?.command,timeout_ms:180000}):{error:'tool_not_allowed'};
   if(task.active_role==='dev'&&['write_file','run_command'].includes(name))await checkpoint(store,task,workspace);
   traceEvent(store,task.id,'execution_evidence',{name,role:task.active_role,version:snapshot.tree_sha,arguments:redactor.clean(args),result:redactor.clean(result)},task.trace_run_id,'role:'+task.active_role);return result;
  }};
  const candidate=await runTeam(spec,{prepare:spaces.prepare,controller:spaces.controller,worker:spaces.worker,isolated:spaces.isolated,entry:'development'}),published=await publish(randomId(),candidate);
  if(published.pr||published.status==='no_changes')return {...candidate,...published};
  traceEvent(store,task.id,'team_feedback',{result:redactor.clean(published)},task.trace_run_id);
  prompt=JSON.stringify({original:prompt,publication_feedback:published,instruction:'Read persistent feedback, fix through the same dev instance, and nominate again.'});
 }
 return stop('team_no_progress','needs_replan');
}
