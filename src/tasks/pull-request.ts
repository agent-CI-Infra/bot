import {integratedPublication} from './integration.js';
import type { Store, Row } from '../storage/database.js';
import { stop, sha, type Redactor } from '../agent/common.js';
import { GitHub } from '../github/client.js';
import { Publisher } from '../github/publisher.js';
import { roleConfiguration } from '../roles/definition.js';
import { permitsTool } from '../roles/permissions.js';
import { assertPublicationStages } from '../roles/schedule.js';
import { assertManagedExecution, assertTaskExternalEffect, sourcePolicies, taskToolAllowed } from './management.js';
import { grantedWrites, projectRefusal, sourceRefusal } from './grants.js';
import { taskPermissions } from './configuration.js';
import { TaskRecords } from './service.js';
import { requestedTask,workOf } from '../work/catalog.js';
import { workEnabled } from '../work/settings.js';
import { stopAboveCeiling } from '../work/ceiling.js';

/** Whether a person confirmed that this development may change .github/workflows/ (set only when the task is created). */
export const workflowChanges = (task: Row) => !!JSON.parse(task.input||'{}').workflow_changes?.confirmed_by;
/**
 * The token a task's pull request is published with. Only a development a project administrator confirmed as a CI change
 * (#931) asks for Workflows, and gets it only where the installation grants it; every other push lacks it, so GitHub
 * refuses a branch that changes .github/workflows/. undefined is the usual development token.
 */
export const pullRequestPermissions = (task: Row): Record<string, string> | undefined =>
  workflowChanges(task) ? { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' } : undefined;
/** A generic task (#814): its deliveries are tools its executor calls, offered by the writes it was granted. */
export const genericTask = (task: Row) => task.kind==='task.request' && JSON.parse(task.input||'{}').generic===true;
/** Does the task deliver a PR? A generic task once its executor called open_pull_request; an older one by its endpoint. */
export const softwareRequest = (task: Row) => { const input=JSON.parse(task.input||'{}');
  return requestedTask(task) && (genericTask(task) ? input.delivery==='pull_request' : input.contract?.endpoint==='reviewable_pull_request'); };
/**
 * Why a generic task may not deliver a PR now (null when it may), checked at every open_pull_request call and again before
 * publication: the project's limit, the grant, the source's ceiling and an executor that can change the code it delivers.
 */
export function pullRequestRefusal(store: Store, task: Row): { code: string; state: 'waiting_permission' | 'waiting_configuration'; message: string; missing: string } | null {
  const origin=assertManagedExecution(store,task);
  const project=projectRefusal(store,String(task.repository_id),'pull_request');
  if(project)return {code:project.code,state:project.code==='capability_ceiling'?'waiting_permission':'waiting_configuration',message:project.message,missing:project.code==='capability_ceiling'?'capability_ceiling:develop':'development_switch'};
  if(!(grantedWrites(store,String(task.id))??[]).includes('pull_request'))
    return {code:'delivery_not_granted',state:'waiting_permission',message:'这个任务没有被授予开 PR（pull_request）；Manager 可以用 grant_writes 授予，或改为 submit_report 交报告。',missing:'grant:pull_request'};
  const source=sourceRefusal(sourcePolicies(store,task),'pull_request');
  if(source)return {...source,state:'waiting_permission',missing:'source:pull_request'};
  if(origin?.executor_role){
    const executor=roleConfiguration(store,task.repository_id).roles.find(r=>r.role_id===origin.executor_role&&r.enabled);
    if(!executor||!(permitsTool(executor.permissions,'write_file')&&taskToolAllowed(store,task,executor.role_id,'write_file')))
      return {code:'task_pull_request_forbidden',state:'waiting_permission',message:'执行角色必须能修改虚拟电脑中的代码；任务管理或委派不能增加这项能力。',missing:'executor:write_file'};
  }
  return null;
}
/** A delivery endpoint does not lend file/PR authority to an ordinary report or a delegated executor. */
export function assertRequestPullRequest(store: Store, task: Row): void {
  if(genericTask(task)){const refusal=pullRequestRefusal(store,task);if(refusal)stop(refusal.code,refusal.state,refusal.message);return;}
  const origin=assertManagedExecution(store,task),policy=store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
  if(!softwareRequest(task)||!policy?.enabled||!workEnabled(store,task.repository_id,workOf(task as any)))stop('task_software_disabled','waiting_configuration');
  // Code delivery needs the project's ceiling at develop (#850); below it the refusal names the level needed.
  stopAboveCeiling(store,task.repository_id,'develop');
  const writes=taskPermissions(store,task).writes;
  if(!writes.includes('code')||!writes.includes('pull_request'))stop('task_pull_request_forbidden','waiting_permission','这类任务的写入被收窄为不含修改代码和交付 PR。');
  if(origin?.executor_role){
    const executor=roleConfiguration(store,task.repository_id).roles.find(r=>r.role_id===origin.executor_role&&r.enabled);
    // The PR itself is a framework delivery (#381); the executor still has to be able to change the code it delivers.
    if(!executor||!(permitsTool(executor.permissions,'write_file')&&taskToolAllowed(store,task,executor.role_id,'write_file')))
      stop('task_pull_request_forbidden','waiting_permission','执行角色必须能修改虚拟电脑中的代码；任务管理或委派不能增加这项能力。');
  }
  assertTaskExternalEffect(store,task,'pull_request');
}
export function requestPolicyHash(store: Store, task: Row): string {
  return sha(String(store.get('SELECT test_command FROM policies WHERE repository_id=?',task.repository_id)?.test_command||''));
}
/** Uses the original effect journal and Publisher, with every raw blob/tree write behind the accepted-candidate fence. */
export async function publishRequestPullRequest(store: Store, task: Row, redactor: Redactor, guard:()=>Promise<void>, log:(value:any)=>void, apiUrl?:string) {
  const validate=async()=>{await guard();check();};
  const check=()=>{
    assertRequestPullRequest(store,task);
    const record=new TaskRecords(store).get(task.id),accepted=record.pending,code=record.candidate?.artifacts.find(a=>a.kind==='code'),
      saved=store.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),candidate=saved&&JSON.parse(saved.data);
    if(!accepted||!['pass','pass_with_issues'].includes(accepted.outcome)||accepted.candidate_id!==record.candidate?.id||accepted.revision!==record.revision||
      accepted.policy_hash!==requestPolicyHash(store,task)||!code||code.version!==candidate?.tree_sha||
      (code.content as any)?.branch!==candidate.branch||(code.content as any)?.base_sha!==candidate.base_sha)
      stop('acceptance_required','retry_wait','当前软件候选必须先通过独立 QA 与当前项目验证策略。');
    assertPublicationStages(store,task.id);
  };
  await validate();
  const repo=store.get('SELECT * FROM repositories WHERE id=?',task.repository_id)!,github=new GitHub(store,repo,redactor,validate,apiUrl);github.purpose='pull_request';
  github.beforeWrite=check;
  try{
    await github.connect(true,undefined,pullRequestPermissions(task));
    const candidate=JSON.parse(store.get('SELECT data FROM development_candidates WHERE task_id=?',task.id)!.data);
    const publisher=new Publisher(store,github,task,validate,undefined,log),commit=await publisher.branch(candidate),pr=await publisher.pullRequest(candidate,commit);
    await validate();
    integratedPublication(store,task,commit);
    return {summary:candidate.summary,test_command:candidate.test_command,pr_number:pr.number,pr_url:pr.html_url,branch:candidate.branch,sha:commit,
      tree_sha:candidate.published_tree_sha||candidate.tree_sha,local_sha:candidate.local_sha,validation:candidate.validation};
  }finally{
    await github.revokeTokens('pull_request');
  }
}
