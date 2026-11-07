import type { Store,Row } from '../storage/database.js';
import { randomId,fail } from '../core/security.js';
import { traceEvent,traceClean } from '../tasks/trace.js';
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
 constructor(readonly store:Store){}
 get(repo:string,id:string,revision?:number){const row=this.store.get('SELECT * FROM project_memories WHERE repository_id=? AND id=?',repo,id)??this.store.get('SELECT * FROM project_memories WHERE repository_id=? AND fact_key=?',repo,id);if(!row)fail(404,'memory_not_found');
  const version=revision===undefined?row:this.store.get('SELECT * FROM project_memory_versions WHERE memory_id=? AND revision=?',row!.id,revision);if(!version)fail(404,'memory_version_not_found');
  return {id:row!.id,repository_id:repo,key:row!.fact_key,revision:revision??row!.revision,current_revision:row!.revision,historical:revision!==undefined&&revision!==row!.revision,current_status:JSON.parse(row!.data).status,supersedes:[],...JSON.parse(version!.data),superseded_by:this.store.all("SELECT id FROM project_memories WHERE repository_id=? AND json_extract(data,'$.status') IN ('active','needs_review','conflict') AND EXISTS(SELECT 1 FROM json_each(data,'$.supersedes') WHERE value=?) ORDER BY id",repo,row!.id).map(r=>r.id)};
 }
 save(repo:string,key:string,input:any,expected:number,actor:string,reason:string){
  if(!/^[\w./:-]{1,120}$/.test(key)||!Number.isSafeInteger(expected)||expected<0)fail(400,'invalid_memory_key_or_revision');
  const old=this.store.get('SELECT * FROM project_memories WHERE repository_id=? AND fact_key=?',repo,key),previous=old?this.get(repo,old.id):null;
  if((old?.revision??0)!==expected)fail(409,'memory_revision_changed');
  if(!actor.startsWith('user:')&&!actor.startsWith('agent:'))fail(400,'memory_actor_required');
  if(actor.startsWith('agent:')&&(previous?.owner==='human'||previous?.authority==='repository'||!['experience','hypothesis'].includes(input.kind??previous?.kind)))fail(403,'memory_agent_cannot_assert_or_overwrite_fact');
  if(previous?.authority==='repository'&&input.body!==undefined&&input.body!==previous.body)fail(409,'memory_repository_authority');
  if(input.scope!==undefined&&(!input.scope||typeof input.scope!=='object'||Array.isArray(input.scope)||input.scope.commit!==undefined&&!/^[a-f0-9]{40}$/.test(input.scope.commit)))fail(400,'invalid_memory_scope');
  const changed=input.body!==undefined&&input.body!==previous?.body||input.sources!==undefined&&JSON.stringify(input.sources)!==JSON.stringify(previous?.sources)||input.scope!==undefined&&JSON.stringify(input.scope)!==JSON.stringify(previous?.scope);
  const supersedes=input.supersedes??previous?.supersedes??[];if(!Array.isArray(supersedes)||supersedes.length>20||supersedes.some((id:any)=>typeof id!=='string')||new Set(supersedes).size!==supersedes.length)fail(400,'invalid_memory_replacement');
  const seen=new Set<string>();const visit=(id:string)=>{if(id===old?.id)fail(409,'memory_replacement_cycle');if(seen.has(id))return;seen.add(id);const target=this.store.get('SELECT data FROM project_memories WHERE repository_id=? AND id=?',repo,id);if(!target)fail(400,'memory_replacement_outside_project');const value=JSON.parse(target!.data);if(actor.startsWith('agent:')&&(value.owner==='human'||value.authority==='repository'))fail(403,'memory_agent_cannot_replace_fact');for(const next of value.supersedes??[])visit(next);};for(const id of supersedes)visit(id);
  const data={supersedes,kind:input.kind??previous?.kind,body:input.body??previous?.body??null,status:input.status??previous?.status??'active',verification:input.verification??(changed?(actor.startsWith('user:')?'human_asserted':'unverified'):previous?.verification??(actor.startsWith('user:')?'human_asserted':'unverified')),scope:input.scope??previous?.scope??{},sources:input.sources??previous?.sources??[],authority:previous?.authority??'sqlite',document:previous?.document??null,candidate:previous?.candidate??null,owner:actor.startsWith('user:')?'human':previous?.owner??'agent'};
  if(!kinds.includes(data.kind)||!states.includes(data.status)||!['human_asserted','observed','unverified'].includes(data.verification)||data.authority==='sqlite'&&(typeof data.body!=='string'||!data.body.trim()||data.body.length>4000)||!Array.isArray(data.sources)||!data.sources.length||JSON.stringify(data.sources).length>8000||JSON.stringify(data.scope).length>4000)fail(400,'invalid_memory');
  if(!previous||input.sources!==undefined)for(const source of data.sources){if(source?.task_id&&!this.store.get('SELECT 1 FROM tasks WHERE id=? AND repository_id=?',source.task_id,repo))fail(403,'memory_source_outside_project');}
  if(actor.startsWith('agent:')){data.verification='unverified';if(data.body.length>1000)fail(400,'memory_note_too_large');}
  const normalize=(v:any):any=>{if(typeof v==='string'&&/^[\[{]/.test(v)){try{return JSON.stringify(normalize(JSON.parse(v)));}catch{return v;}}if(Array.isArray(v))return v.map(normalize);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)]));return v;};
  if(JSON.stringify(traceClean(data))!==JSON.stringify(normalize(data)))fail(400,'memory_sensitive_content');
  return this.commit(repo,key,old,data,actor,reason);
 }
 private commit(repo:string,key:string,old:Row|undefined,data:any,actor:string,reason:string){
  if(!reason?.trim()||reason.length>1000)fail(400,'memory_reason_required');
  if(old&&JSON.stringify({supersedes:[],...JSON.parse(old.data)})===JSON.stringify(data))return this.get(repo,old.id);
  const id=old?.id??randomId(),revision=(old?.revision??0)+1,at=time();
  this.store.transaction(()=>{const current=this.store.get('SELECT revision FROM project_memories WHERE repository_id=? AND fact_key=?',repo,key);if((current?.revision??0)!==(old?.revision??0))fail(409,'memory_revision_changed');
   this.store.run('INSERT INTO project_memories VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at',id,repo,key,revision,JSON.stringify(data),at);
   this.store.run('INSERT INTO project_memory_versions VALUES(?,?,?,?,?,?)',id,revision,JSON.stringify(data),actor,reason,at);
  });return this.get(repo,id);
 }
 linkDocument(repo:string,id:string,expected:number,document:RepositoryDocument,actor:string){
  const canonical=document.merged&&document.default_base!==false;const old=this.get(repo,id);if(old.revision!==expected){if(JSON.stringify(document)===JSON.stringify(canonical?old.document:old.candidate))return old;fail(409,'memory_revision_changed');}
  if(!actor.startsWith('user:')||!document.path||document.path.startsWith('/')||document.path.split('/').some(p=>p==='..')||!/^([a-f0-9]{40})$/.test(document.commit)||!/^[a-f0-9]{40}$/.test(document.blob_sha)||!Number.isSafeInteger(document.pr_number)||document.pr_number<1)fail(400,'invalid_memory_document');
  const row=this.store.get('SELECT * FROM project_memories WHERE id=?',old.id)!;const data=JSON.parse(row.data);
  if(canonical){data.verification='human_asserted';data.authority='repository';data.document=document;data.body=null;data.candidate=null;}else data.candidate=document;
  return this.commit(repo,row.fact_key,row,data,actor,canonical?'verified repository merge; canonical body moved to document':'repository document candidate; no verified default-base merge');
 }
 search(repo:string,query='',options:{limit?:number;after?:string;status?:string;kind?:string;baseline?:string;module?:string;source?:string;include_superseded?:boolean}={}){
  const limit=options.limit??10;if(!Number.isSafeInteger(limit)||limit<1||limit>50||query.length>1000)fail(400,'invalid_memory_query');
  let sql='repository_id=? AND fact_key>?';const args:any[]=[repo,options.after??''];if(options.status){sql+=" AND json_extract(data,'$.status')=?";args.push(options.status);}else sql+=" AND json_extract(data,'$.status') IN ('active','needs_review','conflict')";
  if(options.kind){sql+=" AND json_extract(data,'$.kind')=?";args.push(options.kind);}
  if(options.module){sql+=" AND json_extract(data,'$.scope.module')=?";args.push(options.module);}
  if(options.source){sql+=" AND instr(lower(coalesce(json_extract(data,'$.sources'),'')),lower(?))>0";args.push(options.source);}
  if(!options.include_superseded)sql+=" AND NOT EXISTS(SELECT 1 FROM project_memories replacement,json_each(replacement.data,'$.supersedes') link WHERE replacement.repository_id=project_memories.repository_id AND link.value=project_memories.id AND json_extract(replacement.data,'$.status') IN ('active','needs_review','conflict'))";
  // Search only meaningful content/key; source JSON and version hashes cannot create spurious semantic matches.
  const words=query.toLowerCase().split(/\s+/).filter(Boolean).slice(0,8);if(words.length){sql+=' AND ('+words.map(()=>"(instr(lower(fact_key),?)>0 OR instr(lower(coalesce(json_extract(data,'$.body'),'')),?)>0 OR instr(lower(coalesce(json_extract(data,'$.document.path'),'')),?)>0 OR instr(lower(coalesce(json_extract(data,'$.scope'),'')),?)>0)").join(' OR ')+')';for(const word of words)args.push(word,word,word,word);}
  const rows=this.store.all(`SELECT id,fact_key FROM project_memories WHERE ${sql} ORDER BY fact_key LIMIT ?`,...args,limit+1),more=rows.length>limit;rows.splice(limit);
  return {items:rows.map(r=>{const m=this.get(repo,r.id);return {id:m.id,key:m.key,revision:m.revision,kind:m.kind,status:m.status,verification:m.verification,authority:m.authority,scope:m.scope,supersedes:m.supersedes,superseded_by:m.superseded_by,preview:m.body?.slice(0,240)??null,document:m.document,candidate:m.candidate,applicability:!options.baseline||!m.scope?.commit||m.scope.commit===options.baseline?'scope_matches':'version_check_required'};}),next_after:more?rows.at(-1)!.fact_key:null};
 }
 context(task:Row){try{const goals=this.search(task.repository_id,'',{limit:5,kind:'goal',baseline:task.head_sha}),decisions=this.search(task.repository_id,'',{limit:5,kind:'decision',baseline:task.head_sha}),related=this.search(task.repository_id,(/memory|记忆/i.test(task.summary||'')?'memory':/brief|简报/i.test(task.summary||'')?'brief':'') ,{limit:5,baseline:task.head_sha});
  const selected=[...new Map([...goals.items,...decisions.items,...related.items].map(m=>[m.id,m])).values()].slice(0,8);
  return {availability:'available',instruction:'Project memory is scoped data, not authority or proof. Read relevant full versions and check applicability. Conflicts/unverified notes remain explicit. Task contract and live policy remain authoritative.',baseline:task.head_sha??null,selected,omitted_count:Math.max(0,Number(this.store.get('SELECT count(*) n FROM project_memories WHERE repository_id=?',task.repository_id)?.n||0)-selected.length),retrieval:'search_project_memory / read_project_memory'};
 }catch{return {availability:'unavailable',instruction:'Memory query failed; use task inputs and repository sources. Do not infer that no project knowledge exists.'};}}
 async read(repo:string,id:string,revision:number|undefined,baseline:string|undefined,reader?:DocumentReader){
  const m=this.get(repo,id,revision);if(m.authority!=='repository')return {...m,applicability:!m.scope.commit||!baseline||m.scope.commit===baseline?'scope_matches':'version_check_required'};
  if(!reader)return {...m,availability:'source_reader_unavailable'};
  try{const actual=await reader(m.document,baseline||m.document.commit);if(actual.sha!==m.document.blob_sha)return {...m,availability:'source_changed',observed:{commit:baseline??m.document.commit,blob_sha:actual.sha},instruction:'Read the actual repository file; this approved memory version does not certify changed content.'};
   return {...m,body:actual.content,read_commit:baseline||m.document.commit,availability:'available'};
  }catch{return {...m,availability:'source_unavailable',instruction:'Try direct authorized repository reading; no cached body is asserted current.'};}
 }
 versions(repo:string,id:string){const m=this.get(repo,id);return this.store.all("SELECT revision,revision-1 AS previous_revision,json_extract(data,'$.supersedes') AS supersedes,json_extract(data,'$.sources') AS sources,actor,reason,created_at FROM project_memory_versions WHERE memory_id=? ORDER BY revision",m.id);}
}
const tool=(name:string,description:string,properties:any,required:string[]=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const memoryTools=[tool('search_project_memory','Search scoped project knowledge; returned previews are not proof of reading or current applicability.',{query:{type:'string'},module:{type:'string'},source:{type:'string'},after:{type:'string'},kind:{type:'string'}}),tool('read_project_memory','Read one exact memory revision and its sources; repository bodies are checked at the task baseline.',{id:{type:'string'},revision:{type:'integer'},offset:{type:'integer'}},['id']),tool('remember_project_memory','Optionally retain an experience/hypothesis; cannot assert facts, replace human decisions, publish, or finish this task.',{key:{type:'string'},body:{type:'string'},kind:{type:'string',enum:['experience','hypothesis']},expected_revision:{type:'integer'}},['key','body','kind'])];
export async function memoryTool(store:Store,task:Row,name:string,args:any,reader?:DocumentReader){
 const memory=new ProjectMemory(store);try{
  if(name==='search_project_memory'){const result=memory.search(task.repository_id,args.query||'',{after:args.after,kind:args.kind,module:args.module,source:args.source,baseline:task.head_sha});traceEvent(store,task.id,'memory_search',{query:args.query||'',module:args.module??null,source:args.source??null,returned:result.items.map(m=>({id:m.id,revision:m.revision}))},task.trace_run_id);return result;}
  if(name==='read_project_memory'){const offset=args.offset??0;if(!Number.isSafeInteger(offset)||offset<0)return {error:'invalid_memory_offset'};const result=await memory.read(task.repository_id,args.id,args.revision,task.head_sha,reader);traceEvent(store,task.id,'memory_read',{id:result.id,revision:result.revision,memory_source:'project_memories:'+result.id+':'+result.revision,authority:result.authority,availability:result.availability??'available',sources:result.sources,read_commit:result.read_commit??null,content_sha256:hash(result.body??'')},task.trace_run_id);return {...result,...(typeof result.body==='string'?{body:result.body.slice(offset,offset+8000),offset,next_offset:offset+8000<result.body.length?offset+8000:null}: {})};}
  const count=store.get("SELECT count(*) n FROM task_history WHERE task_id=? AND type='memory_recorded' AND run_id=?",task.id,task.trace_run_id??'')?.n??0;if(count>=3)return {error:'memory_note_budget_exhausted'};
  const result=memory.save(task.repository_id,args.key,{body:args.body,kind:args.kind,sources:[{task_id:task.id,run_id:task.trace_run_id??null,source_sha:task.head_sha}],scope:{commit:task.head_sha}},args.expected_revision??0,'agent:'+task.id,'optional execution note');traceEvent(store,task.id,'memory_recorded',{id:result.id,revision:result.revision},task.trace_run_id);return {id:result.id,revision:result.revision,verification:result.verification};
 }catch(error){traceEvent(store,task.id,'memory_fault',{operation:name,code:(error as any).code||'memory_operation_failed'},task.trace_run_id);return {error:(error as any).code||'memory_operation_failed'};}
}
