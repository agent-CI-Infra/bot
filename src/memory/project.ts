import { configuredRedactor } from '../core/redaction.js';
import { memoryCatalog, validateCatalog, knowledgePath } from './catalog.js';
import { authorize } from '../identity/authorization.js';
import { memoryAuthorize, memoryVisible, visibleMemorySnapshot, taskMemoryAccess, type MemoryAccess } from './access.js';
import {executionBaseline} from '../agent/common.js';
import type { Store,Row } from '../storage/database.js';
import { randomId,fail } from '../core/security.js';
import { traceEvent } from '../tasks/trace.js';
import { createHash } from 'node:crypto';
const time=()=>new Date().toISOString();
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export function memoryStorage(s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS project_memories(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(repository_id,fact_key));
  CREATE TABLE IF NOT EXISTS project_memory_versions(memory_id TEXT NOT NULL REFERENCES project_memories(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
  data TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(memory_id,revision));
  CREATE INDEX IF NOT EXISTS project_memory_scope ON project_memories(repository_id,updated_at);`);}
export interface RepositoryDocument {path:string;commit:string;blob_sha:string;pr_number:number;merged:boolean;default_base?:boolean;base_ref?:string;url?:string;}
export type DocumentReader=(document:RepositoryDocument,ref?:string)=>Promise<{content:string;sha:string}>;
const kinds=['goal','decision','implementation','experience','hypothesis'];
const states=['active','needs_review','conflict','archived','revoked'];
export class ProjectMemory {
 constructor(readonly store:Store, readonly access?:MemoryAccess){}
 private allowed(repo:string,data:any){const access=memoryAuthorize(this.access,repo);if(!memoryVisible(access,repo,data))fail(404,'memory_not_found');}

 get(repo:string,id:string,revision?:number){memoryAuthorize(this.access,repo);if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))fail(400,'invalid_memory_revision');const row=this.store.get('SELECT * FROM project_memories WHERE repository_id=? AND id=?',repo,id)??this.store.get('SELECT * FROM project_memories WHERE repository_id=? AND fact_key=?',repo,id);if(!row)fail(404,'memory_not_found');
  this.allowed(repo,JSON.parse(row!.data));const version=revision===undefined?row:this.store.get('SELECT * FROM project_memory_versions WHERE memory_id=? AND revision=?',row!.id,revision);if(!version)fail(404,'memory_version_not_found');
  const data=JSON.parse(version!.data);this.allowed(repo,data);
  const visibleId=(id:string)=>{const r=this.store.get('SELECT data FROM project_memories WHERE repository_id=? AND id=?',repo,id);return r&&memoryVisible(this.access!,repo,JSON.parse(r.data));};
  return {id:row!.id,repository_id:repo,key:row!.fact_key,revision:revision??row!.revision,current_revision:row!.revision,historical:revision!==undefined&&revision!==row!.revision,current_status:JSON.parse(row!.data).status,...data,review:visibleMemorySnapshot(this.store,repo,data.review??null,this.access),sources:visibleMemorySnapshot(this.store,repo,data.sources,this.access),catalog:memoryCatalog(data,row!.fact_key),supersedes:(data.supersedes??[]).filter(visibleId),review_overdue:!!data.catalog?.review_due_at&&Date.parse(data.catalog.review_due_at)<=Date.now(),superseded_by:this.store.all("SELECT id FROM project_memories WHERE repository_id=? AND json_extract(data,'$.status') IN ('active','needs_review','conflict') AND EXISTS(SELECT 1 FROM json_each(data,'$.supersedes') WHERE value=?) ORDER BY id",repo,row!.id).map(r=>r.id).filter(visibleId)};
 }
 save(repo:string,key:string,input:any,expected:number,actor:string,reason:string){
  const access=memoryAuthorize(this.access,repo,true);memoryAuthorize(access,repo);if(access.role&&actor!=='agent:'+access.task_id)fail(403,'memory_actor_mismatch');
  if(!/^[\w./:-]{1,120}$/.test(key)||!Number.isSafeInteger(expected)||expected<0)fail(400,'invalid_memory_key_or_revision');
  const old=this.store.get('SELECT * FROM project_memories WHERE repository_id=? AND fact_key=?',repo,key),previous=old?{...this.get(repo,old.id),...JSON.parse(old.data)}:null;
  if((old?.revision??0)!==expected)fail(409,'memory_revision_changed');
  if(actor.startsWith('user:')&&actor!=='user:'+access.actor.principal_id)fail(403,'memory_actor_mismatch');
  if(!actor.startsWith('user:')&&!actor.startsWith('agent:'))fail(400,'memory_actor_required');
  if(actor.startsWith('agent:')&&(previous?.owner==='human'||previous?.authority==='repository'||!['experience','hypothesis'].includes(input.kind??previous?.kind)))fail(403,'memory_agent_cannot_assert_or_overwrite_fact');
  if(previous?.authority==='repository'&&input.body!==undefined&&input.body!==previous.body)fail(409,'memory_repository_authority');
  if(input.scope!==undefined&&(!input.scope||typeof input.scope!=='object'||Array.isArray(input.scope)||input.scope.commit!==undefined&&!/^[a-f0-9]{40}$/.test(input.scope.commit)))fail(400,'invalid_memory_scope');
  const changed=input.body!==undefined&&input.body!==previous?.body||input.sources!==undefined&&JSON.stringify(input.sources)!==JSON.stringify(previous?.sources)||input.scope!==undefined&&JSON.stringify(input.scope)!==JSON.stringify(previous?.scope);
  const supersedes=input.supersedes??previous?.supersedes??[];if(!Array.isArray(supersedes)||supersedes.length>20||supersedes.some((id:any)=>typeof id!=='string')||new Set(supersedes).size!==supersedes.length)fail(400,'invalid_memory_replacement');
  const seen=new Set<string>();const visit=(id:string)=>{if(id===old?.id)fail(409,'memory_replacement_cycle');if(seen.has(id))return;seen.add(id);const target=this.store.get('SELECT data FROM project_memories WHERE repository_id=? AND id=?',repo,id);if(!target)fail(400,'memory_replacement_outside_project');const value=JSON.parse(target!.data);this.allowed(repo,value);if(actor.startsWith('agent:')&&(value.owner==='human'||value.authority==='repository'))fail(403,'memory_agent_cannot_replace_fact');for(const next of value.supersedes??[])visit(next);};for(const id of supersedes)visit(id);
  const humanActor=actor.startsWith('user:')&&this.store.get('SELECT kind FROM principals WHERE id=?',access.actor.principal_id)?.kind==='human';
  const owner=humanActor?'human':previous?.owner??'agent';
  const data={supersedes,kind:input.kind??previous?.kind,body:input.body??previous?.body??null,status:input.status??previous?.status??'active',verification:input.verification??(changed?(actor.startsWith('user:')?'human_asserted':'unverified'):previous?.verification??(actor.startsWith('user:')?'human_asserted':'unverified')),scope:input.scope??previous?.scope??{},sources:input.sources??previous?.sources??[],authority:previous?.authority??'sqlite',document:previous?.document??null,candidate:previous?.candidate??null,owner,catalog:{...memoryCatalog(previous??{owner,scope:input.scope,kind:input.kind},key),...input.catalog},review:input.review??previous?.review??null};
  if(input.review)data.catalog.reviewed_at=input.review.at;
  validateCatalog(data.catalog,input.catalog);
  if(actor.startsWith('agent:')&&(input.review!==undefined||input.status!==undefined&&input.status!=='active'))fail(403,'memory_agent_cannot_review');
  if(!kinds.includes(data.kind)||!states.includes(data.status)||!['human_asserted','observed','unverified'].includes(data.verification)||data.authority==='sqlite'&&(typeof data.body!=='string'||!data.body.trim()||data.body.length>32000)||!Array.isArray(data.sources)||!data.sources.length||JSON.stringify(data.sources).length>8000||JSON.stringify(data.scope).length>4000)fail(400,'invalid_memory');
  if(!previous||input.sources!==undefined)for(const source of data.sources){if(!source||typeof source!=='object'||Array.isArray(source)||!Object.values(source).some(v=>typeof v==='string'&&v.trim()||typeof v==='number'))fail(400,'invalid_memory_source');if(source.path)knowledgePath(source.path);if(source?.task_id&&!this.store.get('SELECT 1 FROM tasks WHERE id=? AND repository_id=?',source.task_id,repo))fail(403,'memory_source_outside_project');}
  if(actor.startsWith('agent:')){data.verification='unverified';if(data.body.length>32000)fail(400,'memory_note_too_large');}

  return this.commit(repo,key,old,data,actor,reason);
 }
 private commit(repo:string,key:string,old:Row|undefined,data:any,actor:string,reason:string){
  if(typeof reason!=='string'||!reason.trim()||reason.length>1000)fail(400,'memory_reason_required');
  const redactor = configuredRedactor(this.store);
  data = redactor.clean(data);
  reason = redactor.text(reason);
  if(old&&JSON.stringify({...JSON.parse(old.data),supersedes:JSON.parse(old.data).supersedes??[],catalog:memoryCatalog(JSON.parse(old.data),key),review:JSON.parse(old.data).review??null})===JSON.stringify(data))return this.get(repo,old.id);
  const id=old?.id??randomId(),revision=(old?.revision??0)+1,at=time();
  this.store.transaction(()=>{const current=this.store.get('SELECT revision FROM project_memories WHERE repository_id=? AND fact_key=?',repo,key);if((current?.revision??0)!==(old?.revision??0))fail(409,'memory_revision_changed');
   this.store.run('INSERT INTO project_memories VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at',id,repo,key,revision,JSON.stringify(data),at);
   this.store.run('INSERT INTO project_memory_versions VALUES(?,?,?,?,?,?)',id,revision,JSON.stringify(data),actor,reason,at);
  });return this.get(repo,id);
 }
 linkDocument(repo:string,id:string,expected:number,document:RepositoryDocument,actor:string){
  const access=memoryAuthorize(this.access,repo,true);if(access.role)fail(403,'memory_agent_cannot_promote');knowledgePath(document.path);
  const canonical=document.merged&&document.default_base===true;const old=this.get(repo,id);if(old.revision!==expected)fail(409,'memory_revision_changed');
  if(!actor.startsWith('user:')||!document.path||document.path.startsWith('/')||document.path.split('/').some(p=>p==='..')||!/^([a-f0-9]{40})$/.test(document.commit)||!/^[a-f0-9]{40}$/.test(document.blob_sha)||!Number.isSafeInteger(document.pr_number)||document.pr_number<1)fail(400,'invalid_memory_document');
  const row=this.store.get('SELECT * FROM project_memories WHERE id=?',old.id)!;const data=JSON.parse(row.data);
  if(canonical){data.verification='human_asserted';data.authority='repository';data.document=document;data.body=null;data.candidate=null;data.catalog={...memoryCatalog(data,row.fact_key),path:document.path};}else data.candidate=document;
  return this.commit(repo,row.fact_key,row,data,actor,canonical?'verified repository merge; canonical body moved to document':'repository document candidate; no verified default-base merge');
 }
 search(repo:string,query='',options:{limit?:number;after?:string;status?:string;kind?:string;baseline?:string;module?:string;source?:string;include_superseded?:boolean;role?:string;path?:string;category?:string;tag?:string}={}){
  const access=memoryAuthorize(this.access,repo);
  const limit=options.limit??10;if(!Number.isSafeInteger(limit)||limit<1||limit>50||query.length>1000)fail(400,'invalid_memory_query');
  let sql='repository_id=? AND fact_key>?';const args:any[]=[repo,options.after??''];if(options.status){sql+=" AND json_extract(data,'$.status')=?";args.push(options.status);}else sql+=" AND json_extract(data,'$.status') IN ('active','needs_review','conflict')";
  if(options.kind){sql+=" AND json_extract(data,'$.kind')=?";args.push(options.kind);}
  if(options.role){sql+=" AND (json_extract(data,'$.scope.role')=? OR json_extract(data,'$.catalog.audience')=?)";args.push(options.role,'role:'+options.role);}
  if(options.module){sql+=" AND coalesce(json_extract(data,'$.catalog.module'),json_extract(data,'$.scope.module'))=?";args.push(options.module);}
  if(options.path){sql+=" AND instr(coalesce(json_extract(data,'$.catalog.path'),json_extract(data,'$.document.path'),''),?)=1";args.push(options.path);}
  if(options.category){sql+=" AND coalesce(json_extract(data,'$.catalog.category'),json_extract(data,'$.kind'))=?";args.push(options.category);}
  if(options.tag){sql+=" AND EXISTS(SELECT 1 FROM json_each(data,'$.catalog.tags') WHERE value=?)";args.push(options.tag);}
  if(options.source){sql+=" AND instr(lower(coalesce(json_extract(data,'$.sources'),'')),lower(?))>0";args.push(options.source);}

  // Search only meaningful content/key; source JSON and version hashes cannot create spurious semantic matches.
  const words=query.toLowerCase().split(/\s+/).filter(Boolean).slice(0,8);if(words.length){sql+=' AND ('+words.map(()=>"(instr(lower(fact_key),?)>0 OR instr(lower(coalesce(json_extract(data,'$.body'),'')),?)>0 OR instr(lower(coalesce(json_extract(data,'$.document.path'),'')),?)>0 OR instr(lower(coalesce(json_extract(data,'$.scope'),'')),?)>0 OR instr(lower(coalesce(json_extract(data,'$.catalog'),'')),?)>0)").join(' OR ')+')';for(const word of words)args.push(word,word,word,word,word);}
  const rows=this.store.all(`SELECT id,fact_key,data FROM project_memories WHERE ${sql} ORDER BY fact_key`,...args).filter(r=>memoryVisible(access,repo,JSON.parse(r.data))).filter(r=>options.include_superseded||!this.get(repo,r.id).superseded_by.length);const more=rows.length>limit;rows.splice(limit);
  return {items:rows.map(r=>{const m=this.get(repo,r.id);return {id:m.id,key:m.key,revision:m.revision,kind:m.kind,status:m.status,verification:m.verification,authority:m.authority,catalog:m.catalog,review:m.review??null,review_overdue:m.review_overdue,scope:m.scope,supersedes:m.supersedes,superseded_by:m.superseded_by,preview:m.body?.slice(0,240)??null,document:m.document,candidate:m.candidate,applicability:!options.baseline||!m.scope?.commit||m.scope.commit===options.baseline?'scope_matches':'version_check_required'};}),next_after:more?rows.at(-1)!.fact_key:null};
 }
 context(task:Row):any{try{if(!this.access?.role)return new ProjectMemory(this.store,taskMemoryAccess(this.store,task)).context(task);const goals=this.search(task.repository_id,'',{limit:5,kind:'goal',baseline:executionBaseline(task)}),decisions=this.search(task.repository_id,'',{limit:5,kind:'decision',baseline:executionBaseline(task)}),related=this.search(task.repository_id,(/memory|记忆/i.test(task.summary||'')?'memory':/brief|简报/i.test(task.summary||'')?'brief':'') ,{limit:5,baseline:executionBaseline(task)});
  const selected=[...new Map([...goals.items,...decisions.items,...related.items].map(m=>[m.id,m])).values()].slice(0,8);
  return {availability:'available',instruction:'Project memory is scoped data, not authority or proof. Read relevant full versions and check applicability. Conflicts/unverified notes remain explicit. Task contract and live policy remain authoritative.',baseline:executionBaseline(task)??null,selected,omitted_count:Math.max(0,this.store.all('SELECT data FROM project_memories WHERE repository_id=?',task.repository_id).filter(r=>memoryVisible(this.access!,task.repository_id,JSON.parse(r.data))).length-selected.length),retrieval:'search_project_memory / read_project_memory'};
 }catch{return {availability:'unavailable',instruction:'Memory query failed; use task inputs and repository sources. Do not infer that no project knowledge exists.'};}}
 async read(repo:string,id:string,revision:number|undefined,baseline:string|undefined,reader?:DocumentReader){
  let m=this.get(repo,id,revision);if(m.authority!=='repository')return {...m,applicability:!m.scope.commit||!baseline||m.scope.commit===baseline?'scope_matches':'version_check_required'};
  knowledgePath(m.document.path);if(!reader)return {...m,availability:'source_reader_unavailable'};
  try{const actual=await reader(m.document,baseline||m.document.commit);m=this.get(repo,id,m.revision);if(actual.sha!==m.document.blob_sha)return {...m,availability:'source_changed',observed:{commit:baseline??m.document.commit,blob_sha:actual.sha},instruction:'Read the actual repository file; this approved memory version does not certify changed content.'};
   return {...m,body:actual.content,read_commit:baseline||m.document.commit,availability:'available'};
  }catch(error){memoryAuthorize(this.access,repo);m=this.get(repo,id,m.revision);return {...m,availability:'source_unavailable',instruction:'Try direct authorized repository reading; no cached body is asserted current.'};}
 }
 versions(repo:string,id:string){const m=this.get(repo,id);return this.store.all("SELECT revision,revision-1 AS previous_revision,json_extract(data,'$.supersedes') AS supersedes,json_extract(data,'$.sources') AS sources,actor,reason,created_at FROM project_memory_versions WHERE memory_id=? ORDER BY revision",m.id).filter(r=>{try{this.get(repo,id,r.revision);return true;}catch(error){if((error as any).code==='memory_not_found')return false;throw error;}}).map(r=>({...r,supersedes:JSON.stringify(this.get(repo,id,r.revision).supersedes),sources:JSON.stringify(this.get(repo,id,r.revision).sources)}));}
 /** Free-file edits retain provenance and revision history across roles and console users. */
 writeFile(repo:string,id:string,expected:number,input:{content?:string;deleted?:boolean;restore?:boolean}){
  const access=memoryAuthorize(this.access,repo,true);
  const old=this.get(repo,id);if(old.revision!==expected)fail(409,'note_revision_changed');
  const row=this.store.get('SELECT * FROM project_memories WHERE repository_id=? AND id=?',repo,old.id)!,data=JSON.parse(row.data);
  data.supersedes??=[];data.catalog=memoryCatalog(data,row.fact_key);data.review??=null;
  if(input.content===old.body&&!input.deleted&&!input.restore&&!['archived','revoked'].includes(old.status))return old;
  if(input.content!==undefined){if(typeof input.content!=='string')fail(400,'invalid_note_content');if(data.authority==='repository')fail(409,'memory_repository_authority');data.body=input.content;data.verification='unverified';
   if(!access.role&&this.store.get('SELECT kind FROM principals WHERE id=?',access.actor.principal_id)?.kind==='human'){data.owner='human';data.verification='human_asserted';}}
  if(input.deleted)data.status='archived';else if(input.restore||input.content!==undefined&&['archived','revoked'].includes(data.status))data.status='needs_review';
  const actor=access.role?'agent:'+access.task_id:'user:'+access.actor.principal_id;
  return this.commit(repo,row.fact_key,row,data,actor,input.deleted?'file deleted':input.restore?'file version restored':'file content saved');
 }
 /** Revision-checked status/catalog update for console and management operations (without SQL run-evidence gating). */
 review(repo:string,id:string,expected:number,input:any){
  if(!this.access?.actor)return fail(403,'memory_actor_required');
  const access=this.access;
  if(access.actor.project_id&&access.actor.project_id!==repo)return fail(403,'project_scope_mismatch');
  if(access.role)return fail(403,'memory_agent_cannot_review');
  const principal=this.store.get('SELECT kind FROM principals WHERE id=?',access.actor.principal_id);
  if(principal?.kind==='human')authorize(access.actor,'knowledge.write',{project_id:repo});
  else authorize(access.actor,'knowledge.review',{project_id:repo});
  const old=this.get(repo,id);if(old.revision!==expected)fail(409,'memory_revision_changed');
  const actions:Record<string,string>={accept:'active',reject:'archived',archive:'archived',conflict:'conflict',revoke:'revoked',restore:'needs_review',merge:'active'};
  if(input.evidence!==undefined&&(!Array.isArray(input.evidence)||!input.evidence.length||input.evidence.length>20||input.evidence.some((e:any)=>typeof e!=='string'||!e.trim()||e.length>500)))fail(400,'memory_review_evidence_required');
  const evidence=Array.isArray(input.evidence)?input.evidence:[];
  if(!actions[input.action]||typeof input.reason!=='string'||!input.reason.trim())fail(400,'memory_review_evidence_required');
  if(input.action==='merge'&&(!Array.isArray(input.supersedes)||!input.supersedes.length))fail(400,'invalid_memory_replacement');
  const row=this.store.get('SELECT * FROM project_memories WHERE id=?',old.id)!;
  const prev=JSON.parse(row.data);
  if(input.action==='merge'){
   const seen=new Set<string>();const visit=(targetId:string)=>{if(targetId===old.id)fail(409,'memory_replacement_cycle');if(seen.has(targetId))return;seen.add(targetId);const t=this.store.get('SELECT data FROM project_memories WHERE repository_id=? AND id=?',repo,targetId);if(!t)return fail(400,'memory_replacement_outside_project');for(const next of JSON.parse(t.data).supersedes??[])visit(next);};
   for(const targetId of input.supersedes)visit(targetId);
  }
  const owner=principal?.kind==='human'?'human':prev.owner??'agent';
  const data={...prev,supersedes:input.action==='merge'?input.supersedes:prev.supersedes??[],status:actions[input.action],...(input.action==='accept'?{verification:'observed'}:{}),owner,catalog:{...memoryCatalog(prev,old.key),...(input.catalog??{}),reviewed_at:time()},review:{action:input.action,actor:access.actor.principal_id,at:time(),evidence,run_id:input.run_id??null}};
  validateCatalog(data.catalog,input.catalog);
  return this.commit(repo,old.key,row,data,'user:'+access.actor.principal_id,input.reason);
 }
}
const tool=(name:string,description:string,properties:any,required:string[]=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const memoryTools=[tool('search_project_memory','Search shared project knowledge and ../notes files; returned previews are not proof of reading or current applicability.',{query:{type:'string'},module:{type:'string'},source:{type:'string'},path:{type:'string'},tag:{type:'string'},category:{type:'string'},after:{type:'string'},kind:{type:'string'}}),tool('read_project_memory','Read one exact memory or ../notes file revision and its sources; repository bodies are checked at the task baseline.',{id:{type:'string'},revision:{type:'integer'},offset:{type:'integer'}},['id']),tool('remember_project_memory','Save or update a shared project experience/hypothesis note visible to all project roles; cannot assert human facts, replace human decisions, publish, or finish this task.',{key:{type:'string'},body:{type:'string'},kind:{type:'string',enum:['experience','hypothesis']},expected_revision:{type:'integer'},catalog:{type:'object',properties:{title:{type:'string'},tags:{type:'array',items:{type:'string'}},aliases:{type:'array',items:{type:'string'}},path:{type:'string'},module:{type:'string'},category:{type:'string'}},additionalProperties:false}},['key','body','kind'])];
export interface NotesBridge { call:(key:string,request:any)=>Promise<any>; manager?:{call:(method:string,path:string,body?:any)=>Promise<any>} }
export async function memoryTool(store:Store,task:Row,name:string,args:any,reader?:DocumentReader,notes?:NotesBridge){
 try{const access=taskMemoryAccess(store,task),memory=new ProjectMemory(store,access);
  if(name==='search_project_memory'){
   const result=memory.search(task.repository_id,args.query||'',{after:args.after,kind:args.kind,module:args.module,source:args.source,path:args.path,tag:args.tag,category:args.category,baseline:executionBaseline(task)});
   let noteItems:any[]=[];
   if(notes?.manager&&!args.after&&!args.kind&&!args.module&&!args.tag&&!args.category){
    try{const tree=await notes.manager.call('GET',`/v1/projects/${task.repository_id}/file-tree?`+new URLSearchParams({directory:'',query:String(args.query||'').slice(0,200),include_deleted:'0',deleted_only:'0'}));
     if(Array.isArray(tree?.files))noteItems=tree.files.filter((f:any)=>!args.path||String(f.path||'').startsWith(args.path)).slice(0,10).map((f:any)=>({id:f.id,key:f.path,revision:f.revision,kind:'experience',status:'active',verification:'unverified',authority:'notes_file',catalog:{title:f.name||f.path,path:'../notes/'+f.path,audience:'project'},preview:null,applicability:'scope_matches'}));
    }catch{}
   }
   const merged={...result,items:[...result.items,...noteItems]};
   traceEvent(store,task.id,'memory_search',{query:args.query||'',module:args.module??null,source:args.source??null,returned:merged.items.map(m=>({id:m.id,revision:m.revision}))},task.trace_run_id);
   return merged;
  }
  if(name==='read_project_memory'){
   const offset=args.offset??0;if(!Number.isSafeInteger(offset)||offset<0)return {error:'invalid_memory_offset'};
   const rawId=String(args.id??'');
   if(notes&&(/^f:[a-f0-9]{32}$/.test(rawId)||/^n:[a-zA-Z0-9_-]+$/.test(rawId)||rawId.startsWith('../notes/'))){
    const fileData=rawId.startsWith('../notes/')?await notes.call('memory-note:'+randomId(),{type:'workspace_read',path:rawId}):notes.manager?await notes.manager.call('GET',`/v1/projects/${task.repository_id}/file-tree/${encodeURIComponent(rawId)}`+(args.revision?`?revision=${args.revision}`:'')):{error:'notes_unavailable'};
    if(fileData?.error)return {error:fileData.error};
    const body=String(fileData?.content??''),rev=Number(fileData?.revision??args.revision??1);
    traceEvent(store,task.id,'memory_read',{id:rawId,revision:rev,memory_source:'notes:'+rawId+':'+rev,authority:'notes_file',availability:'available',sources:[],read_commit:null,content_sha256:hash(body.slice(offset,offset+8000)),offset,characters:body.slice(offset,offset+8000).length,role:access.role},task.trace_run_id);
    return {id:rawId,key:fileData?.path??rawId,revision:rev,authority:'notes_file',availability:'available',body:body.slice(offset,offset+8000),offset,next_offset:offset+8000<body.length?offset+8000:null};
   }
   if(args.revision===undefined){const current=memory.get(task.repository_id,args.id);args={...args,revision:current.revision};}
   const result=await memory.read(task.repository_id,args.id,args.revision,executionBaseline(task),reader);
   traceEvent(store,task.id,'memory_read',{id:result.id,revision:result.revision,memory_source:'project_memories:'+result.id+':'+result.revision,authority:result.authority,availability:result.availability??'available',sources:result.sources,read_commit:result.read_commit??null,content_sha256:hash(typeof result.body==='string'?result.body.slice(offset,offset+8000):''),offset,characters:typeof result.body==='string'?result.body.slice(offset,offset+8000).length:0,role:access.role},task.trace_run_id);
   return {...result,...(typeof result.body==='string'?{body:result.body.slice(offset,offset+8000),offset,next_offset:offset+8000<result.body.length?offset+8000:null}: {})};
  }
  if(name!=='remember_project_memory')return {error:'memory_tool_not_found'};
  return store.transaction(()=>{
   memoryAuthorize(access,task.repository_id,true);
   const key=String(args.key??'');
   const existing=store.get('SELECT revision FROM project_memories WHERE repository_id=? AND fact_key=?',task.repository_id,key);
   const expected=args.expected_revision!==undefined?args.expected_revision:Number(existing?.revision??0);
   const result=memory.save(task.repository_id,key,{body:args.body,kind:args.kind,sources:[{task_id:task.id,run_id:task.trace_run_id??null,source_sha:executionBaseline(task)}],scope:{commit:executionBaseline(task),role:access.role},catalog:{audience:'project',...(args.catalog??{})}},expected,'agent:'+task.id,'shared project note');
   traceEvent(store,task.id,'memory_recorded',{id:result.id,revision:result.revision},task.trace_run_id);
   return {id:result.id,revision:result.revision,verification:result.verification};
  });
 }catch(error){traceEvent(store,task.id,'memory_fault',{operation:name,code:(error as any).code||'memory_operation_failed'},task.trace_run_id);return {error:(error as any).code||'memory_operation_failed'};}
}
