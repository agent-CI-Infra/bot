import {publicationContext} from './publication.js';
import type {GitHub} from '../github/client.js';
import type {Store,Row} from '../storage/database.js';
import type {Workspace} from '../agent/workspace.js';
import {traceEvent} from './trace.js';
import {safePath} from '../agent/common.js';
import {randomId} from '../core/security.js';

const instruction='Use the offered task_history version refs instead of copying SHAs. A restored candidate lives in the index/worktree; HEAD may remain at the base. Local candidate and published commits can differ even with identical trees. Comparing content uses trees; checking ancestry uses commits. A publication receipt does not imply its commit is available locally. Choose any further authorized inspection yourself.';
export const versionTools=[
 {type:'function',function:{name:'read_publication_context',description:'Inspect this task publication facts on demand: created commit, confirmed branch/PR, current remote observations, receipts and paged attempts. Does not publish or decide recovery.',parameters:{type:'object',properties:{before:{type:'integer'}}}}},
 {type:'function',function:{name:'read_version_context',description:'Get fixed durable refs for baseline, candidate and publication plus actual workspace HEAD and current remote main/PR facts when available. No SHA transcription needed; no checkout is changed. Optionally request a bounded baseline-to-current-main change summary.',parameters:{type:'object',properties:{compare_main:{type:'boolean',description:'Optionally read remote changed paths/stats between this task baseline and current main; this does not decide verification or integration.'}}}}},
 {type:'function',function:{name:'read_version_file',description:'Read a repository file at a version ref. Also accepts commit_sha for existing direct-SHA callers. Does not checkout or fetch.',parameters:{type:'object',properties:{ref:{type:'string'},commit_sha:{type:'string'},path:{type:'string'}},required:['path']}}},
 {type:'function',function:{name:'compare_versions',description:'Compare content at two offered version refs. Does not change HEAD or fetch remote objects.',parameters:{type:'object',properties:{left_ref:{type:'string'},right_ref:{type:'string'},left_sha:{type:'string'},right_sha:{type:'string'}},additionalProperties:false}}}
];
export function resolveVersion(s:Store,task:Row,ref:string){
 const match=/^task_history:(\d+)$/.exec(String(ref));if(!match)return null;
 const row=s.get("SELECT data FROM task_history WHERE task_id=? AND id=? AND type='version_reference'",task.id,Number(match[1]));
 return row?JSON.parse(row.data):null;
}
export async function versionTool(s:Store,task:Row,workspace:Workspace,name:string,args:any,remote?:()=>Promise<GitHub>){
 if(name==='read_publication_context')return publicationContext(s,task,args,remote);
 if(name==='read_version_context'){
  const input=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',task.id)?.input||'{}');
  const row=s.get("SELECT data FROM task_history WHERE task_id=? AND type='artifact_checkpoint' ORDER BY id DESC LIMIT 1",task.id),checkpoint=row?JSON.parse(row.data):null;
  const saved=s.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),candidate=checkpoint??(saved?JSON.parse(saved.data):null),publication=saved?JSON.parse(saved.data):null;
  const head=await workspace.call('version-head:'+randomId(),{type:'workspace_source'});
  const record=(purpose:string,commit:any,tree:any,availability:string)=>commit||tree?traceEvent(s,task.id,'version_reference',{purpose,commit_sha:commit??null,tree_sha:tree??null,local_availability:availability,workspace_id:workspace.task.workspace_id,attempt:task.attempt,repository_id:task.repository_id},task.trace_run_id):null;
  const baselineCommit=input.snapshot_sha??candidate?.base_sha??task.head_sha,baselineRef=record('baseline',baselineCommit,input.snapshot_tree??candidate?.base_tree,'unknown');
  let remoteFacts:any={availability:'not_offered'};
  if(remote)try{
    const github=await remote(),main=(await github.ref(github.defaultBranch))?.object?.sha;
    const mainRef=main?record('current_main',main,null,'unknown'):null;
    let pr:any=null;const number=JSON.parse(s.get('SELECT result FROM tasks WHERE id=?',task.id)?.result||'null')?.pr_number??input.bot_pr?.number;
    if(number&&github.permissions.pull_requests) {const value=await github.object('review.pr',number);pr={number:value.number,head_sha:value.head?.sha,base_sha:value.base?.sha,base_branch:value.base?.ref,mergeable:value.mergeable??null,mergeable_state:value.mergeable_state??null,state:value.state,merged:value.merged??false};}
    remoteFacts={availability:main?'available':'unknown',branch:github.defaultBranch,current_main_ref:mainRef,observed_at:new Date().toISOString(),pull_request:pr};
    if(args?.compare_main&&baselineCommit&&main&&baselineCommit!==main)try{
      const diff=await github.request('GET',github.path('/compare/'+baselineCommit+'...'+main));
      const comparison={left_ref:baselineRef,right_ref:mainRef,source:'github_compare',status:diff.status,ahead_by:diff.ahead_by,behind_by:diff.behind_by,total_commits:diff.total_commits,files:(diff.files??[]).slice(0,100).map((f:any)=>({path:f.filename,status:f.status,additions:f.additions,deletions:f.deletions})),files_truncated:(diff.files??[]).length>=100};
      remoteFacts.main_changes={...comparison,ref:traceEvent(s,task.id,'version_comparison',comparison,task.trace_run_id)};
    }catch(error){if(!String((error as any).code||'').startsWith('github_'))throw error;remoteFacts.main_changes={availability:'unavailable',error:(error as any).code,left_ref:baselineRef,right_ref:mainRef};}

  }catch(error){if(!String((error as any).code||'').startsWith('github_'))throw error;remoteFacts={availability:'unavailable',error:(error as any).code};}
  return {baseline_ref:baselineRef,candidate_ref:record('candidate',candidate?.sha??candidate?.local_sha,candidate?.tree_sha,'unknown'),publication_ref:record('publication',publication?.branch_confirmed?.sha??publication?.published?.sha,publication?.published_tree_sha,'unknown'),publication_discovery:{tool:'read_publication_context',arguments:{}},workspace_head_ref:record('workspace_head',head?.local_sha,head?.tree_sha,head?.error?'unavailable':'confirmed'),remote:remoteFacts,instruction};
 }
 const version=(ref:any,sha:any)=>ref?resolveVersion(s,task,ref):/^[a-f0-9]{40}$/.test(String(sha))?{commit_sha:sha,tree_sha:null}:null;
 if(name==='read_version_file'){
  try{safePath(args.path);}catch{return {error:'invalid_artifact_path'};}
  const v=version(args.ref,args.commit_sha);if(!v)return {error:'version_reference_not_found',discovery:{tool:'read_version_context',arguments:{}}};
  if(!v.commit_sha)return {error:'version_commit_unavailable',ref:args.ref};
  const result=await workspace.call('version-file:'+randomId(),{type:'workspace_read',sha:v.commit_sha,path:args.path});
  return result.error?{error:'version_object_unavailable',ref:args.ref,detail:result.detail,instruction:'The ref is retained; remote publication objects may require an authorized fetch. No checkout was changed.'}:result;
 }
 if(name==='compare_versions'){
  const left=version(args.left_ref,args.left_sha),right=version(args.right_ref,args.right_sha);if(!left||!right)return {error:'version_reference_not_found',discovery:{tool:'read_version_context',arguments:{}}};
  if(left.tree_sha&&left.tree_sha===right.tree_sha)return {content_equal:true,left_ref:args.left_ref,right_ref:args.right_ref,proof:'recorded tree identities; not a claim of commit ancestry or local availability'};
  const a=left.tree_sha??left.commit_sha,b=right.tree_sha??right.commit_sha;if(!/^[a-f0-9]{40}$/.test(a??'')||!/^[a-f0-9]{40}$/.test(b??''))return {error:'version_object_unavailable'};
  const result=await workspace.call('version-diff:'+randomId(),{type:'workspace_command',command:`git diff --stat ${a} ${b} --`,timeout_ms:30000});
  if((result.error||result.exit_code!==0)&&remote&&left.commit_sha&&right.commit_sha)try{
    const github=await remote(),comparison=await github.request('GET',github.path('/compare/'+left.commit_sha+'...'+right.commit_sha));
    return {left_ref:args.left_ref,right_ref:args.right_ref,source:'github_compare',status:comparison.status,ahead_by:comparison.ahead_by,behind_by:comparison.behind_by,total_commits:comparison.total_commits,files:(comparison.files??[]).slice(0,100).map((f:any)=>({path:f.filename,status:f.status,additions:f.additions,deletions:f.deletions})),files_truncated:(comparison.files??[]).length>=100,instruction:'Remote comparison is a bounded observation, not proof of local availability or a verification decision.'};
  }catch(error){if(!String((error as any).code||'').startsWith('github_'))throw error;return {error:'version_comparison_unavailable',remote_error:(error as any).code,left_ref:args.left_ref,right_ref:args.right_ref,result};}
  return result.error||result.exit_code!==0?{error:'version_object_unavailable',left_ref:args.left_ref,right_ref:args.right_ref,result,discovery:{tool:'read_version_context',arguments:{}}}:result;
 }
 return {error:'tool_not_allowed'};
}
