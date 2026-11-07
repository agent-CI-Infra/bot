import type { Store } from '../storage/database.js';
import { repository,type Actor } from '../app/auth.js';
import { fields,fail,type Json } from '../core/security.js';
import { GitHub } from '../github/client.js';
import { Redactor,blobSha } from '../agent/common.js';
import { ProjectMemory,type RepositoryDocument } from './project.js';
export async function memoryApi(store:Store,user:Actor,method:string,url:URL,input:Json,githubUrl?:string):Promise<Json|undefined>{
 const match=/^\/api\/repositories\/([^/]+)\/memories(?:\/([^/]+))?(?:\/(versions|document))?$/.exec(url.pathname);if(!match)return;
 const repo=match[1]!,id=match[2],operation=match[3];repository(store,user,repo);const memory=new ProjectMemory(store);
 let github:GitHub|undefined;const client=async()=>{if(!github){github=new GitHub(store,store.get('SELECT * FROM repositories WHERE id=?',repo)!,new Redactor(),async()=>{},githubUrl);await github.connect(false,undefined,{contents:'read',pull_requests:'read'},false);}return github;};
 const reader=async(document:RepositoryDocument,ref?:string)=>{const gh=await client(),file=await gh.request('GET',gh.path('/contents/'+document.path.split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(ref||document.commit)));if(file?.encoding!=='base64'||file.size>128*1024)fail(409,'memory_document_unavailable');const bytes=Buffer.from(file.content,'base64');if(blobSha(bytes)!==file.sha)fail(409,'memory_document_hash_mismatch');return {content:bytes.toString('utf8'),sha:file.sha};};
 if(method==='GET'){
  if(!id)return memory.search(repo,url.searchParams.get('query')||'',{role:url.searchParams.get('role')||undefined,module:url.searchParams.get('module')||undefined,source:url.searchParams.get('source')||undefined,include_superseded:url.searchParams.get('include_superseded')==='1',limit:Number(url.searchParams.get('limit')||10),after:url.searchParams.get('after')||undefined,status:url.searchParams.get('status')||undefined,kind:url.searchParams.get('kind')||undefined,baseline:url.searchParams.get('baseline')||undefined}) as any;
  if(operation==='versions')return {versions:memory.versions(repo,id)};
  const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined;if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))fail(400,'invalid_memory_revision');
  return {memory:await memory.read(repo,id,revision,url.searchParams.get('baseline')||undefined,reader)} as any;
 }
 if(method==='POST'&&operation==='document'){
  fields(input,['expected_revision','pr_number','path']);if(typeof input.path!=='string'||input.path.length>500||input.path.startsWith('/')||input.path.split('/').some(p=>p==='..')||!Number.isSafeInteger(input.pr_number)||Number(input.pr_number)<1)fail(400,'invalid_memory_document');
  const gh=await client(),pr=await gh.object('review.pr',Number(input.pr_number));if(pr.base?.repo?.id&&String(pr.base.repo.id)!==repo)fail(409,'memory_document_wrong_repository');
  const merged=pr.merged===true&&!!pr.merged_at,commit=merged?pr.merge_commit_sha:pr.head?.sha;if(!/^[a-f0-9]{40}$/.test(commit||''))fail(409,'memory_document_commit_unknown');
  const doc={path:String(input.path),commit,pr_number:Number(input.pr_number),merged,default_base:pr.base?.ref===gh.defaultBranch,base_ref:pr.base?.ref,url:pr.html_url,blob_sha:''};const observed=await reader(doc);doc.blob_sha=observed.sha;
  const result=memory.linkDocument(repo,id!,Number(input.expected_revision),doc,'user:'+user.id);store.audit(user.id,'memory.document',result.id,repo);return {memory:result} as any;
 }
 if(method==='POST'&&!id||method==='PATCH'&&id&&!operation){
  fields(input,['key','expected_revision','body','kind','verification','scope','sources','status','reason','supersedes']);const old=id?memory.get(repo,id):null;
  const result=memory.save(repo,old?.key||String(input.key||''),input,Number(input.expected_revision),'user:'+user.id,String(input.reason||''));store.audit(user.id,'memory.updated',result.id,repo);return {memory:result} as any;
 }
 return fail(405,'method_not_allowed');
}
