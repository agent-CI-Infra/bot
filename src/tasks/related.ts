import type { Store, Row } from '../storage/database.js';
import { TaskRecords } from './service.js';
import { Workspace } from '../agent/workspace.js';
import { safePath } from '../agent/common.js';

/** Read-only discovery within one versioned delivery family; no source checkout is replaced. */
export function relatedDeliveries(store: Store, task: Row) {
  const teamParent=store.get('SELECT parent_id FROM task_children WHERE child_id=?',task.id)?.parent_id;
  const teamRoot=teamParent??(store.get('SELECT child_id FROM task_children WHERE parent_id=?',task.id)?task.id:null);
  if(!task.source_task_id&&!teamRoot)return [];
  const link=store.get('SELECT * FROM task_followups WHERE task_id=? AND parent_id=?',task.id,task.source_task_id);
  if(!link&&!teamRoot)return [];
  const parent=teamRoot??link!.parent_id;
  const family=teamRoot?[parent,...store.all('SELECT child_id FROM task_children WHERE parent_id=?',parent).map(r=>r.child_id)]:[parent,...store.all('SELECT task_id FROM task_followups WHERE parent_id=? AND candidate_id=?',parent,link!.candidate_id).map(r=>r.task_id)];
  const records=new TaskRecords(store);
  return store.all(`SELECT t.* FROM tasks t WHERE t.repository_id=? AND t.id<>? AND
    t.id IN (SELECT value FROM json_each(?))
    AND t.status NOT IN ('cancelled','superseded') ORDER BY t.created_at,t.id`,
    task.repository_id,task.id,JSON.stringify(family)).flatMap(row=>{
      const record=records.get(row.id),candidate=record.candidate;
      if(!candidate)return [];
      const accepted=record.acceptance?.revision===record.revision&&candidate.revision===record.revision&&record.acceptance?.candidate_id===candidate.id&&['pass','pass_with_issues'].includes(record.acceptance.outcome)&&['completed','succeeded','pr_opened'].includes(row.status);
      const artifact=candidate.artifacts.find(a=>a.kind==='files'||a.kind==='code'),snapshot=artifact?.content as any;
      return [{row,candidate,artifact,snapshot,description:{task_id:row.id,relationship:row.id===parent?'parent':teamRoot===task.id?'child':accepted?'accepted_sibling':'submitted_sibling',goal:String(record.contract.goal).slice(0,600),goal_characters:String(record.contract.goal).length,goal_truncated:String(record.contract.goal).length>600,
        candidate_id:candidate.id,revision:candidate.revision,status:row.status,accepted,acceptance_outcome:record.acceptance?.candidate_id===candidate.id?record.acceptance.outcome:null,tree_version:artifact?.version||null,
        artifacts:candidate.artifacts.slice(0,5).map(a=>({kind:a.kind,reference:String(a.reference).slice(0,200),reference_truncated:String(a.reference).length>200,version:String(a.version).slice(0,100),version_truncated:String(a.version).length>100})),artifact_count:candidate.artifacts.length,
        file_count:Array.isArray(snapshot?.files)?snapshot.files.length:0,discovery:{tool:'read_related_artifact',arguments:{task_id:row.id,candidate_id:candidate.id},instruction:'Index only. Omit path for a filtered, paginated file list; supply path for immutable content; section contract reads complete requirements. Pin candidate_id; do not infer omitted content is absent.'}}}];
    });
}
export const relatedIndexBudget=24*1024;
/** Shared, bounded first disclosure for QA, task context files and discovery tools. */
export function relatedDeliveryIndex(related:ReturnType<typeof relatedDeliveries>,offset=0,limit=5){
 const deliveries:typeof related[number]['description'][]=[];let size=0;
 for(const item of related.slice(offset,offset+limit)){
  const cost=JSON.stringify(item.description).length;if(size+cost>relatedIndexBudget)break;
  deliveries.push(item.description);size+=cost;
 }
 const next=offset+deliveries.length;
 if(!deliveries.length&&offset<related.length)return {deliveries,total:related.length,offset,next_offset:offset+1,complete:false,error:'related_index_entry_too_large',omitted_task_id:related[offset]!.row.id,discovery:{tool:'read_related_artifact',arguments:{task_id:related[offset]!.row.id,section:'delivery'},instruction:'This entry exceeds the index budget; read its paginated metadata explicitly. It was not absent.'}};
 return {deliveries,total:related.length,offset,next_offset:next<related.length?next:null,complete:next>=related.length,discovery:next<related.length?{tool:'read_related_artifact',arguments:{offset:next,limit},instruction:'More deliveries exist. Continue this page, then use each delivery read entrance for original requirements and evidence.'}:undefined};
}
export const relatedArtifactTool={type:'function',function:{name:'read_related_artifact',description:'Discover related delivery summaries (omit task_id); list immutable file paths (task_id, no path; directory/query filters, offset/limit); read a file in bounded chunks (path, offset/length); or page full requirements/metadata (section contract/delivery). Pin the offered candidate_id to detect changed candidates. Return next_offset continues the same query. Only this task family is accessible; acceptance is explicit and does not approve your current task.',parameters:{type:'object',properties:{task_id:{type:'string'},candidate_id:{type:'string'},path:{type:'string'},section:{type:'string',enum:['contract','delivery']},directory:{type:'string'},query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100},length:{type:'integer',minimum:1,maximum:16000}},required:[] as string[],additionalProperties:false}}};
export async function readRelatedArtifact(store: Store, task: Row, workspace: Workspace, args: any) {
 const offset=args?.offset??0,limit=args?.limit??(args?.task_id?50:5),length=args?.length??8000;
 if(!Number.isSafeInteger(length)||length<1||length>16000||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||args?.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))return {error:'invalid_related_page',expected:'offset >= 0; limit 1..100; length 1..16000; query at most 200 characters'};
 const related=relatedDeliveries(store,task);
 if(!args?.task_id)return relatedDeliveryIndex(related,offset,limit);
 const source=related.find(r=>r.row.id===args.task_id);
 if(!source)return {error:'related_delivery_not_available'};
 const binding={source_task_id:source.row.id,candidate_id:source.candidate.id,tree_version:source.artifact?.version??null,accepted:source.description.accepted};
 if(args.candidate_id!==undefined&&args.candidate_id!==source.candidate.id)return {error:'related_candidate_changed',...binding,discovery:source.description.discovery};
 if(args.section!==undefined){
  if(!['contract','delivery'].includes(args.section)||args.path!==undefined)return {error:'invalid_related_section'};
  const text=JSON.stringify(args.section==='contract'?new TaskRecords(store).get(source.row.id).contract:{...source.description,goal:new TaskRecords(store).get(source.row.id).contract.goal,goal_truncated:false,artifacts:source.candidate.artifacts.map(({kind,reference,version})=>({kind,reference,version}))}),chunk=text.slice(offset,offset+length);
  return {...binding,section:args.section,content:chunk,offset,total_characters:text.length,next_offset:offset+chunk.length<text.length?offset+chunk.length:null,complete:offset+chunk.length>=text.length};
 }
 if(args.path===undefined){
  let directory='';if(args.directory!==undefined){if(typeof args.directory!=='string')return {error:'invalid_artifact_directory'};directory=args.directory.replace(/\/+$/,'');if(directory)try{safePath(directory);}catch{return {error:'invalid_artifact_directory'};}}
  const files=(source.snapshot?.files??[]).filter((f:any)=>(!directory||f.path.startsWith(directory+'/'))&&(!args.query||f.path.includes(args.query)));
  const paths:string[]=[];let size=0;
  for(const file of files.slice(offset,offset+limit)){const cost=JSON.stringify(file.path).length;if(size+cost>relatedIndexBudget)break;paths.push(file.path);size+=cost;}
  const next=offset+paths.length;
  if(!paths.length&&offset<files.length)return {...binding,error:'related_file_entry_too_large',files:[],omitted_path_preview:String(files[offset].path).slice(0,200),omitted_path_characters:String(files[offset].path).length,offset,next_offset:offset+1<files.length?offset+1:null,complete:offset+1>=files.length,instruction:'This invalid or oversized manifest entry was omitted explicitly; continue at next_offset if present. It was not an empty file list.'};
  return {...binding,files:paths,total_files:source.snapshot?.files?.length??0,matching_files:files.length,offset,next_offset:next<files.length?next:null,complete:next>=files.length,filters:{directory,query:args.query??''},instruction:'Paths only. Read a selected path with this candidate_id for its immutable content and blob SHA; keep filters when paging.'};
 }
 try{safePath(args.path);}catch{return {error:'invalid_artifact_path'};}
 const file=source.snapshot?.files?.find((f:any)=>f.path===args.path);
 if(!file||!source.snapshot?.local_sha||!source.row.workspace_id)return {error:'related_artifact_unavailable'};
 const reader=new Workspace(store,workspace.manager,{...task,workspace_id:source.row.workspace_id},workspace.redactor,workspace.guard,workspace.log);
 const result=await reader.call('related:'+source.row.id+':'+source.candidate.id+':'+args.path,{type:'workspace_read',path:args.path,sha:source.snapshot.local_sha});
 if(typeof result.content!=='string')return {...result,...binding,blob_sha:file.sha};
 const content=result.content.slice(offset,offset+length),next=offset+content.length;
 if(result.truncated)return {...result,content,...binding,blob_sha:file.sha,offset,total_characters:result.content.length,total_bytes:result.size??null,truncated:true,next_offset:next<result.content.length?next:null,complete:false};
 return {...result,content,...binding,blob_sha:file.sha,offset,total_characters:result.content.length,next_offset:next<result.content.length?next:null,complete:next>=result.content.length};
}
