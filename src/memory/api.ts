import { knowledgePath } from './catalog.js';
import type { Store } from '../storage/database.js';
import { repository,type Actor } from '../app/auth.js';
import { fields,fail,type Json } from '../core/security.js';
import { GitHub } from '../github/client.js';
import { Redactor,blobSha } from '../agent/common.js';
import { memoryAuthorize } from './access.js';
import { ProjectMemory,type RepositoryDocument } from './project.js';
export async function memoryApi(store:Store,user:Actor,method:string,url:URL,input:Json,githubUrl?:string):Promise<Json|undefined>{
 const match=/^\/api\/(?:repositories|projects)\/([^/]+)\/(?:memories|knowledge)(?:\/([^/]+))?(?:\/(versions|document|review))?$/.exec(url.pathname);if(!match)return;
 const repo=match[1]!,id=match[2],operation=match[3];repository(store,user,repo);
 if(!user.context)fail(403,'memory_actor_required');const access={actor:user.context!},memory=new ProjectMemory(store,access);memoryAuthorize(access,repo,method!=='GET');
 let github:GitHub|undefined;const client=async()=>{memoryAuthorize(access,repo);if(!github){github=new GitHub(store,store.get('SELECT * FROM repositories WHERE id=?',repo)!,new Redactor(),async()=>{memoryAuthorize(access,repo);},githubUrl);await github.connect(false,undefined,{contents:'read',pull_requests:'read'},false);}return github;};
 const reader=async(document:RepositoryDocument,ref?:string)=>{memoryAuthorize(access,repo);const gh=await client(),file=await gh.request('GET',gh.path('/contents/'+document.path.split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(ref||document.commit)));memoryAuthorize(access,repo);if(file?.encoding!=='base64'||file.size>128*1024)fail(409,'memory_document_unavailable');const bytes=Buffer.from(file.content,'base64');if(blobSha(bytes)!==file.sha)fail(409,'memory_document_hash_mismatch');return {content:bytes.toString('utf8'),sha:file.sha};};
 if(method==='GET'){
  if(!id&&url.searchParams.get('export')==='1'){const items=[];let after:string|undefined;do{const page=memory.search(repo,url.searchParams.get('query')||'',{limit:50,after,include_superseded:true,status:url.searchParams.get('status')||undefined,module:url.searchParams.get('module')||undefined,path:url.searchParams.get('path')||undefined,tag:url.searchParams.get('tag')||undefined,category:url.searchParams.get('category')||undefined,role:url.searchParams.get('role')||undefined});for(const item of page.items)items.push(await memory.read(repo,item.id,item.revision,url.searchParams.get('baseline')||undefined,reader));after=page.next_after??undefined;}while(after);memoryAuthorize(access,repo);const current=items.map(item=>({...item,...memory.get(repo,item.id,item.revision),body:item.body}));return {items:current} as any;}
  if(!id)return memory.search(repo,url.searchParams.get('query')||'',{role:url.searchParams.get('role')||undefined,module:url.searchParams.get('module')||undefined,path:url.searchParams.get('path')||undefined,tag:url.searchParams.get('tag')||undefined,category:url.searchParams.get('category')||undefined,source:url.searchParams.get('source')||undefined,include_superseded:url.searchParams.get('include_superseded')==='1',limit:Number(url.searchParams.get('limit')||10),after:url.searchParams.get('after')||undefined,status:url.searchParams.get('status')||undefined,kind:url.searchParams.get('kind')||undefined,baseline:url.searchParams.get('baseline')||undefined}) as any;
  if(operation==='versions')return {versions:memory.versions(repo,id)};
  const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined;
  const result=await memory.read(repo,id,revision,url.searchParams.get('baseline')||undefined,reader);
  store.audit(user.id,'memory.read','project_memories:'+result.id+':'+result.revision,repo);return {memory:result} as any;
 }
 if(method==='POST'&&operation==='review'){
  fields(input,['expected_revision','action','evidence','reason','run_id','supersedes','catalog']);const result=memory.review(repo,id!,Number(input.expected_revision),input);store.audit(user.id,'memory.review',result.id,repo);return {memory:result} as any;
 }
 if(method==='POST'&&operation==='document'){
  memory.get(repo,id!);fields(input,['expected_revision','pr_number','path']);if(typeof input.path!=='string'||!input.path||input.path.length>500||input.path.startsWith('/')||input.path.includes('\\')||input.path.split('/').some(p=>p==='..')||!Number.isSafeInteger(input.pr_number)||Number(input.pr_number)<1)fail(400,'invalid_memory_document');
  knowledgePath(input.path);const gh=await client(),pr=await gh.object('review.pr',Number(input.pr_number));if(String(pr.base?.repo?.id)!==repo)fail(409,'memory_document_wrong_repository');
  const merged=pr.merged===true&&!!pr.merged_at,commit=merged?pr.merge_commit_sha:pr.head?.sha;if(!/^[a-f0-9]{40}$/.test(commit||''))fail(409,'memory_document_commit_unknown');
  const doc={path:String(input.path),commit,pr_number:Number(input.pr_number),merged,default_base:pr.base?.ref===gh.defaultBranch,base_ref:pr.base?.ref,url:pr.html_url,blob_sha:''};
  if(merged&&doc.default_base){const comparison=await gh.request('GET',gh.path('/compare/'+commit+'...'+encodeURIComponent(gh.defaultBranch)));if(comparison.base_commit?.sha!==commit||comparison.merge_base_commit?.sha!==commit||!['ahead','identical'].includes(comparison.status))fail(409,'memory_document_not_on_default_branch');}
  const observed=await reader(doc);doc.blob_sha=observed.sha;
  memoryAuthorize(access,repo,true);const result=memory.linkDocument(repo,id!,Number(input.expected_revision),doc,'user:'+access.actor.principal_id);store.audit(user.id,'memory.document',result.id,repo);return {memory:result} as any;
 }
 if(method==='POST'&&!id||method==='PATCH'&&id&&!operation){
  fields(input,['key','expected_revision','body','kind','verification','scope','sources','status','reason','supersedes','catalog']);const old=id?memory.get(repo,id):null;
  const result=memory.save(repo,old?.key||String(input.key||''),input,Number(input.expected_revision),'user:'+access.actor.principal_id,String(input.reason||''));store.audit(user.id,'memory.updated',result.id,repo);return {memory:result} as any;
 }
 return fail(405,'method_not_allowed');
}
