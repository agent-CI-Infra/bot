import type {Store,Row} from '../storage/database.js';
import type {Workspace} from '../agent/workspace.js';
import {traceEvent} from './trace.js';
import {safePath} from '../agent/common.js';
import {randomId} from '../core/security.js';

const instruction='Use the offered task_history version refs instead of copying SHAs. A restored candidate lives in the index/worktree; HEAD may remain at the base. Local candidate and published commits can differ even with identical trees. Comparing content uses trees; checking ancestry uses commits. A publication receipt does not imply its commit is available locally. Choose any further authorized inspection yourself.';
export const versionTools=[
 {type:'function',function:{name:'read_version_context',description:'Get fixed durable refs for baseline, candidate and publication plus actual workspace HEAD. No SHA transcription needed.',parameters:{type:'object',properties:{}}}},
 {type:'function',function:{name:'read_version_file',description:'Read a repository file at a version ref. Also accepts commit_sha for existing direct-SHA callers. Does not checkout or fetch.',parameters:{type:'object',properties:{ref:{type:'string'},commit_sha:{type:'string'},path:{type:'string'}},required:['path']}}},
 {type:'function',function:{name:'compare_versions',description:'Compare content at two offered version refs. Does not change HEAD or fetch remote objects.',parameters:{type:'object',properties:{left_ref:{type:'string'},right_ref:{type:'string'},left_sha:{type:'string'},right_sha:{type:'string'}},additionalProperties:false}}}
];
export function resolveVersion(s:Store,task:Row,ref:string){
 const match=/^task_history:(\d+)$/.exec(String(ref));if(!match)return null;
 const row=s.get("SELECT data FROM task_history WHERE task_id=? AND id=? AND type='version_reference'",task.id,Number(match[1]));
 return row?JSON.parse(row.data):null;
}
export async function versionTool(s:Store,task:Row,workspace:Workspace,name:string,args:any){
 if(name==='read_version_context'){
  const input=JSON.parse(s.get('SELECT input FROM tasks WHERE id=?',task.id)?.input||'{}');
  const row=s.get("SELECT data FROM task_history WHERE task_id=? AND type='artifact_checkpoint' ORDER BY id DESC LIMIT 1",task.id),checkpoint=row?JSON.parse(row.data):null;
  const saved=s.get('SELECT data FROM development_candidates WHERE task_id=?',task.id),candidate=checkpoint??(saved?JSON.parse(saved.data):null),publication=saved?JSON.parse(saved.data):null;
  const head=await workspace.call('version-head:'+randomId(),{type:'workspace_source'});
  const record=(purpose:string,commit:any,tree:any,availability:string)=>commit||tree?traceEvent(s,task.id,'version_reference',{purpose,commit_sha:commit??null,tree_sha:tree??null,local_availability:availability,workspace_id:workspace.task.workspace_id,attempt:task.attempt},task.trace_run_id):null;
  return {baseline_ref:record('baseline',input.snapshot_sha??candidate?.base_sha??task.head_sha,input.snapshot_tree??candidate?.base_tree,'unknown'),candidate_ref:record('candidate',candidate?.sha??candidate?.local_sha,candidate?.tree_sha,'unknown'),publication_ref:record('publication',publication?.remote_sha,publication?.published_tree_sha,'unknown'),workspace_head_ref:record('workspace_head',head?.local_sha,head?.tree_sha,head?.error?'unavailable':'confirmed'),instruction};
 }
 const version=(ref:any,sha:any)=>ref?resolveVersion(s,task,ref):/^[a-f0-9]{40}$/.test(String(sha))?{commit_sha:sha,tree_sha:null}:null;
 if(name==='read_version_file'){
  try{safePath(args.path);}catch{return {error:'invalid_artifact_path'};}
  const v=version(args.ref,args.commit_sha);if(!v)return {error:'version_reference_not_found'};
  if(!v.commit_sha)return {error:'version_commit_unavailable',ref:args.ref};
  const result=await workspace.call('version-file:'+randomId(),{type:'workspace_read',sha:v.commit_sha,path:args.path});
  return result.error?{error:'version_object_unavailable',ref:args.ref,detail:result.detail,instruction:'The ref is retained; remote publication objects may require an authorized fetch. No checkout was changed.'}:result;
 }
 if(name==='compare_versions'){
  const left=version(args.left_ref,args.left_sha),right=version(args.right_ref,args.right_sha);if(!left||!right)return {error:'version_reference_not_found'};
  if(left.tree_sha&&left.tree_sha===right.tree_sha)return {content_equal:true,left_ref:args.left_ref,right_ref:args.right_ref,proof:'recorded tree identities; not a claim of commit ancestry or local availability'};
  const a=left.tree_sha??left.commit_sha,b=right.tree_sha??right.commit_sha;if(!/^[a-f0-9]{40}$/.test(a??'')||!/^[a-f0-9]{40}$/.test(b??''))return {error:'version_object_unavailable'};
  const result=await workspace.call('version-diff:'+randomId(),{type:'workspace_command',command:`git diff --stat ${a} ${b} --`,timeout_ms:30000});
  return result.error||result.exit_code!==0?{error:'version_object_unavailable',left_ref:args.left_ref,right_ref:args.right_ref,result}:result;
 }
 return {error:'tool_not_allowed'};
}
