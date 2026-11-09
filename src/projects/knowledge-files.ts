import type { Store } from '../storage/database.js';
import type { Manager } from './service.js';
import { repository, type Actor } from '../app/auth.js';
import { fail, fields, type Json } from '../core/security.js';
import { memoryAuthorize } from '../memory/access.js';
import { ProjectMemory } from '../memory/project.js';
import { memoryApi } from '../memory/api.js';

const fileName = (value: unknown): string => {
  if (typeof value !== 'string' || !value || /[/\\\0]/.test(value) || ['.','..','.git'].includes(value.toLowerCase()) || /^\.(?:write|expired)-/.test(value)) fail(400,'invalid_note_name');
  return value as string;
};
const noteId = (name: string) => 'n:' + Buffer.from(name).toString('base64url');
const legacyName = (m: any) => String(m.catalog.title || m.key).replace(/[/\\\0]/g,'-').slice(0,160) + '--' + m.id.slice(0,8) + '.md';
const deleted = (m: any) => ['archived','revoked'].includes(m.status);
const summary = (m: any) => ({ id:'m:'+m.id,name:legacyName(m),revision:m.revision,deleted:deleted(m),readonly:m.authority==='repository',bytes:typeof m.body==='string'?Buffer.byteLength(m.body):0 });

/** One free-file contract over existing content, without copying private legacy entries into a shared notes volume. */
export async function knowledgeFilesApi(store:Store,manager:Manager|undefined,user:Actor,method:string,url:URL,input:Json,githubUrl?:string):Promise<Json|undefined>{
  const match=/^\/api\/repositories\/([^/]+)\/knowledge-files(?:\/([^/]+))?(?:\/(versions|restore))?$/.exec(url.pathname);
  if(!match)return;
  const repo=match[1]!,operation=match[3];repository(store,user,repo);
  const access={actor:user.context!},authorize=()=>memoryAuthorize(access,repo,method!=='GET');authorize();
  const memory=new ProjectMemory(store,access);
  const call=async(verb:string,path:string,body?:Json)=>{if(!manager)fail(503,'manager_unavailable');authorize();const result=await manager!.call(verb,'/v1/projects/'+repo+'/files'+path,body);authorize();return result;};
  const memoryFile=async(id:string,revision?:number)=>{
    const result=await memoryApi(store,user,'GET',new URL('http://local/api/repositories/'+repo+'/memories/'+encodeURIComponent(id)+(revision===undefined?'':'?revision='+revision)),{},githubUrl);
    const m=(result as any).memory;authorize();
    return {...summary(m),current_revision:m.current_revision,current_deleted:['archived','revoked'].includes(m.current_status),historical:m.historical,content:deleted(m)?null:m.body??null,readonly:memory.get(repo,id).authority==='repository',availability:m.availability??'available'};
  };
  const oldFiles=()=>store.all('SELECT id FROM project_memories WHERE repository_id=? ORDER BY fact_key',repo).flatMap(row=>{try{return [summary(memory.get(repo,row.id))];}catch(error){if((error as any).code==='memory_not_found')return [];throw error;}});
  if(!match[2]){
    if(method==='GET'){
      const disk=await call('GET','?include_deleted='+String(url.searchParams.get('include_deleted')==='1'?1:0));
      const all=[...disk.files.map((f:any)=>({...f,id:noteId(f.name)})),...oldFiles()].filter(f=>url.searchParams.get('include_deleted')==='1'||!f.deleted);
      const query=(url.searchParams.get('query')||'').toLowerCase();return {files:all.filter(f=>f.name.toLowerCase().includes(query)).sort((a,b)=>a.name.localeCompare(b.name))};
    }
    if(method==='POST'){
      fields(input,['name','content']);const name=fileName(input.name);
      if(typeof input.content!=='string')fail(400,'invalid_note_content');
      if(oldFiles().some(f=>f.name===name))fail(409,'note_revision_changed');
      const file=await call('PUT','/'+encodeURIComponent(name),{content:input.content,expected_revision:0,actor:'user:'+access.actor.principal_id});
      store.audit(user.id,'knowledge.file.saved',name,repo);return {file:{...file,id:noteId(name)}};
    }
    return fail(405,'method_not_allowed');
  }
  let id:string;try{id=decodeURIComponent(match[2]);}catch{return fail(400,'invalid_note_name');}
  const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined;
  if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))fail(400,'invalid_note_revision');
  if(method!=='GET'){
    fields(input,operation==='restore'?['revision','expected_revision']:method==='DELETE'?['expected_revision']:['content','expected_revision']);
    if(!Number.isSafeInteger(input.expected_revision)||Number(input.expected_revision)<1)fail(400,'invalid_note_revision');
  }
  if(id.startsWith('n:')){
    const encoded=id.slice(2),name=fileName(Buffer.from(encoded,'base64url').toString('utf8'));
    if(noteId(name)!==id)fail(400,'invalid_note_name');
    const path='/'+encodeURIComponent(name);
    if(method==='GET'&&operation==='versions')return await call('GET',path+'/versions');
    if(method==='GET'&&!operation)return {file:{...await call('GET',path+(revision===undefined?'':'?revision='+revision)),id}};
    if(method==='PUT'&&!operation||method==='DELETE'&&!operation||method==='POST'&&operation==='restore'){
      const file=await call(method,path+(operation?'/'+operation:''),{...input,actor:'user:'+access.actor.principal_id});
      store.audit(user.id,'knowledge.file.'+(method==='DELETE'?'deleted':operation==='restore'?'restored':'saved'),name,repo);return {file:{...file,id}};
    }
  }else if(id.startsWith('m:')){
    const key=id.slice(2),current=memory.get(repo,key);
    if(method==='GET'&&operation==='versions')return {current_revision:current.revision,versions:memory.versions(repo,key).map((v:any)=>{const m=memory.get(repo,key,v.revision);return {revision:v.revision,actor:v.actor,created_at:v.created_at,deleted:deleted(m),bytes:typeof m.body==='string'?Buffer.byteLength(m.body):0};}).reverse()};
    if(method==='GET'&&!operation)return {file:await memoryFile(key,revision)};
    if(method==='PUT'&&!operation||method==='DELETE'&&!operation||method==='POST'&&operation==='restore'){
      let content=input.content as string|undefined;
      if(operation==='restore'){
        if(!Number.isSafeInteger(input.revision)||Number(input.revision)<1)fail(400,'invalid_note_revision');
        const old=memory.get(repo,key,Number(input.revision));if(deleted(old))fail(400,'invalid_note_revision');content=old.body;
      }
      if(method!=='DELETE'&&typeof content!=='string')fail(400,'invalid_note_content');
      memory.writeFile(repo,key,Number(input.expected_revision),{...(method!=='DELETE'?{content}:{}),deleted:method==='DELETE',restore:operation==='restore'});
      store.audit(user.id,'knowledge.file.'+(method==='DELETE'?'deleted':operation==='restore'?'restored':'saved'),key,repo);return {file:await memoryFile(key)};
    }
  }else fail(404,'note_not_found');
  return fail(405,'method_not_allowed');
}
