import { commandTool, resolveCommandTimeout, runCommand } from '../agent/command.js';
import { workspaceRepositoryTools, type RepositoryExplorer } from '../agent/exploration.js';
import { eventSubscriptionToolNames, eventSubscriptionTools, executeTaskSubscriptionTool } from '../tasks/event-subscriptions.js';
import type {GitHub} from '../github/client.js';
import {versionTools,versionTool} from '../tasks/versions.js';
import { taskTraceAccess } from '../memory/access.js';
import { checkpoint } from '../tasks/checkpoint.js';
import {runTeam} from './team.js';
import {roleWorkspaces} from './workspace.js';
import {taskTools} from '../tasks/record-tools.js';
import {TaskRecords} from '../tasks/service.js';
import {memoryTools,memoryTool} from '../memory/project.js';
import type {Workspace} from '../agent/workspace.js';
import {randomId} from '../core/security.js';
import {traceEvent} from '../tasks/trace.js';
import {stop,blobSha,validWorkspaceToolPath} from '../agent/common.js';
import type {AgentSpec} from '../agent/runtime.js';
import {githubWriteTool,withMergePolicy} from '../github/write.js';
import {autoMergePolicy} from '../github/merge-policy.js';
import {pullRequestLabelsSchema} from '../github/pull-request-labels.js';
import {pullRequestSummaryRules} from '../github/text.js';
import {milestoneTool,milestoneToolName} from '../review/progress.js';
const tool=(name:string,description:string,properties:any,required:string[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
// The team path's developer never gets the entry's system prompt (runRole replaces it), so the guidance of the single-agent
// create_pull_request path on the PR description travels with the tool (#1106).
const summaryDescription='The public pull request description on GitHub, read by the repository\'s maintainers as written; on a revision of the bot\'s pull request it replaces the existing description. '
 +'Say what development started on (development_basis: the label and who added it, the maintainer\'s comment with its link, or the project rule, then mention the Issue\'s author as @login) and the goal you implemented; on a revision keep what the description already says about this. '
 +pullRequestSummaryRules;
/** Existing engine remains the publisher and QA authority; team only prepares its input. */
export async function developmentTeam(workspace:Workspace,system:string,prompt:string,publish:(id:string,args:any)=>Promise<any>,access:{read:boolean;write:boolean;shell:boolean},githubWrite?:(args:unknown)=>Promise<any>,milestone?:(args:unknown)=>Promise<any>,remote?:()=>Promise<GitHub>,explorer?:RepositoryExplorer){
 const {store,task,redactor,guard}=workspace,records=new TaskRecords(store),spaces=roleWorkspaces(workspace);
 const submit=tool('submit_delivery','Submit code candidate metadata for mandatory QA and framework publication. Never publish yourself.',{summary:{type:'string',description:summaryDescription},
  test_command:{type:'string',description:'The command you ran to test the change. The pull request description shows it as your report; the platform reruns only a project test command it has configured.'},
  change_title:{type:'string',description:'The commit subject and pull request title: a concise description of the code change.'},labels:pullRequestLabelsSchema},['summary','test_command']);
 const validate=(v:any)=>{if(!v||typeof v.summary!=='string'||!v.summary.trim()||typeof v.test_command!=='string'||!v.test_command.trim())return stop('role_delivery_invalid','retry_wait');return redactor.clean(v);};
 const readTools=explorer?workspaceRepositoryTools.map(t=>({...t,function:{...t.function,description:t.function.description.replace(/\s*Call github_read_token first\./g,'')}})):[];
 for(let round=0;round<3;round++){
  const cmdBudget=resolveCommandTimeout(store,task,'dev',180);
  const spec:AgentSpec<any>={store,task,redactor,guard,system:system.replace(/When ready, call create_pull_request:[\s\S]*?ends development\./,'When ready, call submit_delivery with PR metadata; framework QA and publication follow. Never call create_pull_request yourself.'),prompt:JSON.stringify({original:prompt,version_context:await versionTool(store,task,spaces.current,'read_version_context',{},remote)}),maxTurns:64,maxOutputTokens:16384,tools:[...(access.read?[tool('read_file','Read text from this shared workspace, ../notes, ../context, or /tmp',{path:{type:'string'}},['path'])]:[]),...(access.write?[tool('write_file','Write text to the repository, ../notes, or /tmp',{path:{type:'string'},content:{type:'string'}},['path','content'])]:[]),...(access.shell?[commandTool(cmdBudget.defaultSeconds,'Run verification/implementation commands without publication or credentials.',cmdBudget.maxSeconds)]:[]),submit,...versionTools,...readTools,...taskTools,...eventSubscriptionTools,...memoryTools,
  // Kept by runRole only for roles whose GitHub permissions write (#381).
  ...(githubWrite?withMergePolicy([githubWriteTool],autoMergePolicy(store,String(task.repository_id))):[]),
  // An Issue's development reports its milestones on the Issue's status comment (#1047).
  ...(milestone?[milestoneTool]:[])],finish:{name:'submit_delivery',validate},finalizationTools:['submit_delivery'],validate:content=>validate(JSON.parse(content)),execute:async(name,args)=>{
   if(versionTools.some(t=>t.function.name===name))return versionTool(store,task,spaces.current,name,args,remote);
   if(explorer&&workspaceRepositoryTools.some(t=>t.function.name===name)){const connected=await explorer.execute('github_read_token',{});return connected?.error?connected:explorer.execute(name,args);}
   if(name==='github_write'&&githubWrite)return githubWrite(args);
   if(name===milestoneToolName&&milestone)return milestone(args);
   const actorTask={...task,active_role:spaces.role,trace_run_id:spaces.runId};
   if(eventSubscriptionToolNames.includes(name))return executeTaskSubscriptionTool(store,actorTask,name,redactor.clean(args));
   if(taskTools.some(t=>t.function.name===name)){const result=records.tool(task.id,name,redactor.clean(args),taskTraceAccess(store,actorTask));if(name==='record_progress'&&spaces.role==='dev')await checkpoint(store,task,workspace);return result;}
   if(memoryTools.some(t=>t.function.name===name))return memoryTool(store,actorTask,name,redactor.clean(args),async doc=>{const raw=await spaces.current.call('role-memory:'+randomId(),{type:'workspace_read',path:doc.path});if(raw.error)throw new Error('memory_source_unavailable');return {content:raw.content,sha:blobSha(Buffer.from(raw.content))};},spaces.current);
   if(name==='write_file'&&!validWorkspaceToolPath(args?.path))return {error:'invalid_artifact_path',instruction:'Write within the repository, /workspace, ../notes or /tmp.'};
   const active=spaces.current,key='role-tool:'+randomId();const snapshot=await active.artifact(key+':version');
   const result=name==='read_file'?await active.call(key,{type:'workspace_read',path:args?.path}):name==='write_file'?(await active.write(key,args?.path,Buffer.from(args?.content??'')),{ok:true}):name==='run_command'?await runCommand(active,key,args,180,spaces.role):{error:'tool_not_allowed'};
   if(spaces.role==='dev'&&['write_file','run_command'].includes(name))await checkpoint(store,task,workspace);
   traceEvent(store,task.id,'execution_evidence',{name,role:spaces.role,version:snapshot.tree_sha,arguments:redactor.clean(args),result:redactor.clean(result)},spaces.runId,'role:'+spaces.role);return result;
  }};
  const candidate=await runTeam(spec,{workspace,prepare:spaces.prepare,controller:spaces.controller,worker:spaces.worker,withRole:spaces.withRole,withObservers:spaces.withObservers,bindRun:spaces.bindRun,snapshot:spaces.snapshot,entry:'development',writerSnapshot:async()=>{const snapshot=await spaces.current.artifact('role-collect:'+randomId());return {tree_sha:snapshot.tree_sha,local_sha:snapshot.local_sha};}}),published=await publish(randomId(),candidate);
  if(published.pr||published.status==='no_changes')return {...candidate,...published};
  traceEvent(store,task.id,'team_feedback',{result:redactor.clean(published)},task.trace_run_id);
  prompt=JSON.stringify({original:prompt,publication_feedback:published,instruction:'Read persistent feedback, fix through the same dev instance, and nominate again.'});
 }
 return stop('team_no_progress','needs_replan');
}
