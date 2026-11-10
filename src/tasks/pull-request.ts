import type { Store, Row } from '../storage/database.js';
import { stop, sha, type Redactor } from '../agent/common.js';
import { GitHub, revokeInstallationToken } from '../github/client.js';
import { Publisher } from '../github/publisher.js';
import { releaseCategory } from '../github/release-label.js';
import { roleConfiguration } from '../roles/definition.js';
import { permitsTool } from '../roles/permissions.js';
import { assertPublicationStages } from '../roles/schedule.js';
import { assertManagedExecution, assertTaskExternalEffect, taskToolAllowed } from './management.js';
import { taskPermissions } from './configuration.js';
import { TaskRecords } from './service.js';
import { workEnabled } from '../work/settings.js';

export const softwareRequest = (task: Row) => task.kind==='task.request' && JSON.parse(task.input||'{}').contract?.endpoint==='reviewable_pull_request';
/** A delivery endpoint does not lend file/PR authority to an ordinary report or a delegated executor. */
export function assertRequestPullRequest(store: Store, task: Row): void {
  const origin=assertManagedExecution(store,task),policy=store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id),writes=taskPermissions(store,task).writes;
  if(!softwareRequest(task)||!policy?.enabled||!policy.development_enabled||!workEnabled(store,task.repository_id,'task.request'))stop('task_software_disabled','waiting_configuration');
  if(!writes.includes('code')||!writes.includes('pull_request'))stop('task_pull_request_forbidden','waiting_permission','项目未显式允许普通事项修改代码并交付 PR。');
  if(origin?.executor_role){
    const executor=roleConfiguration(store,task.repository_id).roles.find(r=>r.role_id===origin.executor_role&&r.enabled);
    if(!executor||!['write_file','create_pull_request'].every(name=>permitsTool(executor.permissions,name)&&taskToolAllowed(store,task,executor.role_id,name)))
      stop('task_pull_request_forbidden','waiting_permission','来源和执行角色必须均具备代码与 PR 能力；任务管理或委派不能增加写权限。');
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
  const repo=store.get('SELECT * FROM repositories WHERE id=?',task.repository_id)!,github=new GitHub(store,repo,redactor,validate,apiUrl);
  github.beforeWrite=check;
  try{
    await github.connect(true);
    const candidate=JSON.parse(store.get('SELECT data FROM development_candidates WHERE task_id=?',task.id)!.data);
    await releaseCategory(github,candidate.release_label);
    const publisher=new Publisher(store,github,task,validate,undefined,log),commit=await publisher.branch(candidate),pr=await publisher.pullRequest(candidate,commit);
    await validate();
    return {summary:candidate.summary,test_command:candidate.test_command,pr_number:pr.number,pr_url:pr.html_url,branch:candidate.branch,sha:commit,
      tree_sha:candidate.published_tree_sha||candidate.tree_sha,local_sha:candidate.local_sha,validation:candidate.validation};
  }finally{
    if(github.expiresAt&&github.token)await revokeInstallationToken(apiUrl??'https://api.github.com',github.token).catch(()=>false);
  }
}
