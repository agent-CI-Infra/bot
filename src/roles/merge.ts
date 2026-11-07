import type { Store } from '../storage/database.js';
import { scope,type Actor } from '../app/auth.js';
import { fields,fail,type Json } from '../core/security.js';
import { GitHub } from '../github/client.js';
import { Publisher } from '../github/publisher.js';
import { Redactor,sha } from '../agent/common.js';
import { TaskRecords } from '../tasks/service.js';
import { traceEvent } from '../tasks/trace.js';
/** Explicit operator authorization; never a manager/role tool. GitHub still enforces branch rules. */
export async function mergeApi(s:Store,user:Actor,method:string,url:URL,input:Json,githubUrl?:string):Promise<Json|undefined>{
 const match=/^\/api\/tasks\/([^/]+)\/merge$/.exec(url.pathname);if(!match||method!=='POST')return;
 fields(input,['expected_sha','merge_method']);if(typeof input.expected_sha!=='string'||!/^([a-f0-9]{40})$/.test(input.expected_sha)||!['merge','squash','rebase'].includes(String(input.merge_method)))fail(400,'invalid_merge_request');
 const filter=scope(user,'repository_id'),task=s.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);if(!task)fail(404,'task_not_found');
 const record=new TaskRecords(s).get(task!.id),result=JSON.parse(task!.result||'null'),accepted=record.acceptance;
 if(!['pr_opened','completed'].includes(task!.status)||!accepted||!['pass','pass_with_issues'].includes(accepted.outcome)||accepted.candidate_id!==record.candidate?.id||accepted.revision!==record.revision||!result?.pr_number||result.sha!==input.expected_sha)fail(409,'merge_requires_accepted_delivery');
 const policy=s.get('SELECT * FROM policies WHERE repository_id=?',task!.repository_id);
 if(!policy?.enabled||!policy.development_enabled||accepted.policy_hash!==sha(String(policy.test_command||'')))fail(409,'merge_policy_changed');
 const owned=s.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task!.repository_id,result.pr_number);if(!owned||owned.sha!==input.expected_sha)fail(409,'merge_requires_owned_head');
 const github=new GitHub(s,s.get('SELECT * FROM repositories WHERE id=?',task!.repository_id)!,new Redactor(),async()=>{},githubUrl);await github.connect(true,undefined,{contents:'write',pull_requests:'write',checks:'read',statuses:'read'},false);
 const validate=async()=>{
  const current=new TaskRecords(s).get(task!.id);if(current.revision!==record.revision||current.candidate?.id!==record.candidate?.id||current.acceptance?.candidate_id!==accepted.candidate_id)fail(409,'merge_context_changed');
  const currentPolicy=s.get('SELECT * FROM policies WHERE repository_id=?',task!.repository_id);if(!currentPolicy?.enabled||!currentPolicy.development_enabled||sha(String(currentPolicy.test_command||''))!==accepted.policy_hash)fail(409,'merge_policy_changed');
  const pr=await github.object('review.pr',result.pr_number);if(pr.head?.sha!==input.expected_sha||pr.base?.ref!==github.defaultBranch||pr.draft||pr.state!=='open'&&!pr.merged)fail(409,'merge_head_or_target_changed');
  if(pr.merged)return;
  const checks:any[]=[];for(let page=1;page<=100;page++){const result=await github.request('GET',github.path('/commits/'+input.expected_sha+'/check-runs?filter=latest&per_page=100&page='+page));if(!Array.isArray(result.check_runs))fail(409,'merge_checks_unavailable');checks.push(...result.check_runs);if(result.check_runs.length<100)break;if(page===100)fail(409,'merge_checks_pagination_limit');}
  const statuses=await github.request('GET',github.path('/commits/'+input.expected_sha+'/status'));
  if(checks.some(c=>c.status!=='completed'||!['success','neutral','skipped'].includes(c.conclusion))||(statuses.statuses?.length&&statuses.state!=='success'))fail(409,'merge_checks_not_green');
  traceEvent(s,task!.id,'merge_checks',{sha:input.expected_sha,check_runs:checks.map(c=>({id:c.id,name:c.name,status:c.status,conclusion:c.conclusion})),status_contexts:statuses.statuses?.map((v:any)=>({context:v.context,state:v.state}))??[],no_remote_checks:!checks.length&&!statuses.statuses?.length},null,'framework');
 };
 await validate();s.audit(user.id,'task.merge.authorized',task!.id,task!.repository_id);
 const publisher=new Publisher(s,github,task!,validate);
 const merged=await publisher.effect('merge:'+input.expected_sha,'merge',{pr:result.pr_number,sha:input.expected_sha,method:input.merge_method,actor:user.id},()=>github.request('PUT',github.path('/pulls/'+result.pr_number+'/merge'),{sha:input.expected_sha,merge_method:input.merge_method}),async()=>{const pr=await github.object('review.pr',result.pr_number);return pr.merged&&pr.head.sha===input.expected_sha?{merged:true,sha:pr.merge_commit_sha,reconciled:true}:null;});
 if(merged.merged!==true)fail(409,'merge_not_confirmed');
 traceEvent(s,task!.id,'repository_evolved',{pr:result.pr_number,head_sha:input.expected_sha,merge_sha:merged.sha,base:github.defaultBranch,authorized_by:user.id},null,'framework');return {merged:true,sha:merged.sha,pr_number:result.pr_number};
}
