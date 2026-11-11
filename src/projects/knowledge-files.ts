import type { Store } from '../storage/database.js';
import type { Manager } from './service.js';
import { repository, type Actor } from '../app/auth.js';
import { fail, fields, type Json } from '../core/security.js';
import { memoryAuthorize } from '../memory/access.js';
import { ProjectMemory } from '../memory/project.js';
import { memoryApi } from '../memory/api.js';

// A control character (NUL, the rest of C0, DEL, the C1 range and the two line separators) cannot be shown or typed in
// the console, so a name or a path carrying one is refused before any filesystem request, as the manager does.
const controlCharacter = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Match the manager's relative-path contract before sending any filesystem request.
const filePath = (value: unknown, root = false): string => {
  if (root && value === '') return '';
  if (typeof value !== 'string' || !value || Buffer.byteLength(value)>4096 || /^[A-Za-z]:\//.test(value) || value.includes('\\') || controlCharacter.test(value)) fail(400,'invalid_note_path');
  const parts=(value as string).split('/');
  if(parts.length>32 || parts.some(part=>!part || ['.','..','.git'].includes(part.toLowerCase()) || /^\.(?:write|expired)-/.test(part) || Buffer.byteLength(part)>255)) fail(400,'invalid_note_path');
  return value as string;
};
// A legacy id is a physical file id by form: an old name that carries a control character still round-trips, and the
// manager reports that file as quarantined instead of this route misrouting the request as an unknown id.
const physicalId = (id:string) => {
  if (/^f:[a-f0-9]{32}$/.test(id)) return true;
  if (!/^n:[a-zA-Z0-9_-]+$/.test(id)) return false;
  try { const name=Buffer.from(id.slice(2),'base64url').toString('utf8');return !name.includes('/') && 'n:'+Buffer.from(name).toString('base64url')===id; } catch { return false; }
};
// A legacy title becomes a file name, so the same characters that a name may not carry are folded here instead of
// failing the migration: a title is data, not a name its author chose on this filesystem.
const legacyName = (m: any) => String(m.catalog.title || m.key).replace(/[/\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,'-').slice(0,160) + '--' + m.id.slice(0,8) + '.md';
const deleted = (m: any) => ['archived','revoked'].includes(m.status);
const summary = (m: any) => ({ id:'m:'+m.id,name:legacyName(m),path:legacyName(m),directory:'',revision:m.revision,deleted:deleted(m),readonly:m.authority==='repository',source:m.authority==='repository'?'repository':'legacy',can_move:false,bytes:typeof m.body==='string'?Buffer.byteLength(m.body):0 });

/** Physical files share a stable catalog; legacy records retain their existing audience and repository authority. */
export async function knowledgeFilesApi(store:Store,manager:Manager|undefined,user:Actor,method:string,url:URL,input:Json,githubUrl?:string):Promise<Json|undefined>{
  const match=/^\/api\/repositories\/([^/]+)\/(knowledge-files|knowledge-directories)(?:\/([^/]+))?(?:\/(versions|restore|move))?$/.exec(url.pathname);
  if(!match)return;
  const repo=match[1]!,directories=match[2]==='knowledge-directories',operation=match[4];repository(store,user,repo);
  const access={actor:user.context!},authorize=()=>{repository(store,user,repo);memoryAuthorize(access,repo,method!=='GET');};authorize();
  const writable=()=>{try{memoryAuthorize(access,repo,true);return true;}catch(error){if((error as any).code==='capability_forbidden')return false;throw error;}};
  const present=(file:any)=>{const readonly=!!file.readonly||!writable();return {...file,readonly,can_edit:!readonly&&file.can_edit!==false,can_move:!readonly&&!String(file.id).startsWith('m:')};};
  const memory=new ProjectMemory(store,access);
  const call=async(verb:string,path:string,body?:Json)=>{if(!manager)fail(503,'manager_unavailable');authorize();const result=await manager!.call(verb,'/v1/projects/'+repo+'/file-tree'+path,body);authorize();return result;};
  const memoryFile=async(id:string,revision?:number)=>{
    const result=await memoryApi(store,user,'GET',new URL('http://local/api/repositories/'+repo+'/memories/'+encodeURIComponent(id)+(revision===undefined?'':'?revision='+revision)),{},githubUrl);
    const m=(result as any).memory;authorize();
    return present({...summary(m),current_revision:m.current_revision,current_deleted:['archived','revoked'].includes(m.current_status),historical:m.historical,content:deleted(m)?null:m.body??null,readonly:memory.get(repo,id).authority==='repository',source:memory.get(repo,id).authority==='repository'?'repository':'legacy',availability:m.availability??'available'});
  };
  const oldFiles=()=>store.all('SELECT id FROM project_memories WHERE repository_id=? ORDER BY fact_key',repo).flatMap(row=>{try{return [summary(memory.get(repo,row.id))];}catch(error){if((error as any).code==='memory_not_found')return [];throw error;}});
  if(directories){
    if(match[3]||operation)return fail(404,'not_found');
    if(!['POST','DELETE'].includes(method))return fail(405,'method_not_allowed');
    fields(input,['path']);const path=filePath(input.path),result=await call(method,'/directories',{path});
    store.audit(user.id,'knowledge.directory.'+(method==='POST'?'created':'deleted'),path,repo);return result;
  }
  if(!match[3]){
    if(method==='GET'){
      const directory=filePath(url.searchParams.get('directory')??'',true),query=url.searchParams.get('query')??'',trash=url.searchParams.get('deleted_only')==='1',include=url.searchParams.get('include_deleted')==='1';
      if(query.length>200)fail(400,'invalid_note_query');
      const disk=await call('GET','?'+new URLSearchParams({directory,query,include_deleted:include?'1':'0',deleted_only:trash?'1':'0'}));
      const legacy=(directory===''||query||trash?oldFiles():[]).filter(f=>(trash?f.deleted:include||!f.deleted)&&f.path.toLowerCase().includes(query.toLowerCase()));
      return {...disk,can_write:writable(),files:[...disk.files,...legacy].map(present).sort((a,b)=>a.path.localeCompare(b.path))};
    }
    if(method==='POST'){
      fields(input,['name','path','content']);if(input.name!==undefined&&input.path!==undefined)fail(400,'invalid_note_path');
      if(input.name!==undefined&&(typeof input.name!=='string'||controlCharacter.test(input.name)))fail(400,'invalid_note_name');
      const path=filePath(input.path??input.name);if(input.name!==undefined&&path.includes('/'))fail(400,'invalid_note_name');
      if(typeof input.content!=='string')fail(400,'invalid_note_content');
      if(!path.includes('/')&&oldFiles().some(f=>f.name===path))fail(409,'note_path_conflict');
      const file=await call('POST','',{path,content:input.content,actor:'user:'+access.actor.principal_id});
      store.audit(user.id,'knowledge.file.saved',path,repo);return {file:present(file)};
    }
    return fail(405,'method_not_allowed');
  }
  let id:string;try{id=decodeURIComponent(match[3]);}catch{return fail(400,'invalid_note_id');}
  const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):undefined;
  if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))fail(400,'invalid_note_revision');
  if(method!=='GET'){
    fields(input,operation==='move'?['path','expected_revision']:operation==='restore'?['revision','expected_revision']:method==='DELETE'?['expected_revision']:['content','expected_revision']);
    if(!Number.isSafeInteger(input.expected_revision)||Number(input.expected_revision)<1)fail(400,'invalid_note_revision');
    if(operation==='move')filePath(input.path);
  }
  if(physicalId(id)){
    const path='/'+encodeURIComponent(id);
    if(method==='GET'&&operation==='versions')return await call('GET',path+'/versions');
    if(method==='GET'&&!operation)return {file:present(await call('GET',path+(revision===undefined?'':'?revision='+revision)))};
    if(method==='PUT'&&!operation||method==='DELETE'&&!operation||method==='POST'&&['restore','move'].includes(operation!)){
      const file=await call(method,path+(operation?'/'+operation:''),{...input,actor:'user:'+access.actor.principal_id});
      store.audit(user.id,'knowledge.file.'+(method==='DELETE'?'deleted':operation==='restore'?'restored':operation==='move'?'moved':'saved'),file.path,repo);return {file:present(file)};
    }
  }else if(id.startsWith('m:')){
    const key=id.slice(2),current=memory.get(repo,key);
    if(method!=='GET'&&current.authority==='repository')fail(409,'memory_repository_authority');
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
