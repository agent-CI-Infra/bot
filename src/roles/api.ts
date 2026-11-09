import {harnesses} from './harness.js';
import {agentBackends,recommendedBackend} from './backends.js';
import type {Store} from '../storage/database.js';
import {repository,scope,type Actor} from '../app/auth.js';
import {fields,fail,type Json} from '../core/security.js';
import {TaskError} from '../agent/common.js';
import {traceEvent} from '../tasks/trace.js';
import {catalog} from './catalog.js';
import {roleConfiguration,saveConfiguration,configurationRevision,resolveRole,modelProfileHash} from './definition.js';
// A resolve error names the configuration field before "：" in its detail; the API returns it as field.
const resolveError=(error:unknown):never=>{if(error instanceof TaskError)fail(409,error.code,/^(roles\.[^：]+)：/.exec(error.detail??'')?.[1]);throw error;};
const host=(url:string)=>{try{return new URL(url).host;}catch{return null;}};
/** Every entry to role configuration (console, API, management agent) is this one service with the same project grant. */
export function roleApi(s:Store,user:Actor,method:string,url:URL,input:Json):Json|undefined{
 const config=/^\/api\/repositories\/([^/]+)\/roles(?:\/(resolve))?$/.exec(url.pathname);
 if(config){const repo=config[1]!;repository(s,user,repo);
  if(config[2]==='resolve'){
   if(method!=='POST')return fail(405,'method_not_allowed');
   // A read-only preview: the exact snapshot a run would start with now. It stores nothing and creates no task.
   fields(input,['role','workflow','expected_revision']);if(typeof input.role!=='string'||typeof (input.workflow??'development.issue')!=='string')fail(400,'invalid_role_resolution');
   try{const {id,snapshot}=resolveRole(s,repo,String(input.role),String(input.workflow??'development.issue'),{expectedRevision:input.expected_revision===undefined?undefined:Number(input.expected_revision),persist:false});return {snapshot_id:id,snapshot};}catch(error){return resolveError(error);}
  }
  if(method==='GET'){
   const revision=url.searchParams.get('revision');
   if(revision!==null){if(!/^\d+$/.test(revision))fail(400,'invalid_revision');const old=configurationRevision(s,repo,Number(revision));if(!old)fail(404,'role_configuration_revision_not_found');return {configuration:old};}
   const current=roleConfiguration(s,repo),workflow=url.searchParams.get('workflow')||'development.issue';
   const models=s.all(`SELECT m.id,m.model_name,m.api_url,m.version,m.repository_id FROM models m WHERE m.api_key IS NOT NULL AND (m.repository_id=? OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?))) ORDER BY m.model_name,m.id`,repo,repo)
    .map(m=>({id:m.id,name:m.model_name,host:host(m.api_url),version:m.version,profile_hash:modelProfileHash(m),shared:m.repository_id==null}));
   const source=s.hasTable('repository_rule_sources')?s.get('SELECT sha,files FROM repository_rule_sources WHERE repository_id=?',repo):undefined;
   const preview=current.roles.filter(r=>r.enabled).map(r=>{try{const {id,snapshot}=resolveRole(s,repo,r.role_id,workflow,{persist:false});return {role:r.role_id,snapshot_id:id,model:snapshot.model,harness:snapshot.harness,skills:snapshot.skills&&{id:snapshot.skills.id,revision:snapshot.skills.revision,content_hash:snapshot.skills.content_hash}};}catch(error){if(error instanceof TaskError)return {role:r.role_id,error:error.code,detail:error.detail??null};throw error;}});
   // The editable sources of the current bundles, so a console edit can resave them unchanged.
   const skill_inputs=current.skills.map(b=>{const row=s.get('SELECT source,files FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND revision=?',repo,b.id,b.revision),source=JSON.parse(row?.source??'{}'),files=JSON.parse(row?.files??'[]');
    return {id:b.id,source:source.type==='inline'?{type:'inline',files:files.map((f:any)=>({path:f.path,content:f.content}))}:source.type==='builtin'?{type:'builtin',playbooks:source.playbooks}:{type:'repository',commit:source.commit,paths:source.paths}};});
   return {configuration:current,configured:!!s.get('SELECT value FROM settings WHERE key=?','roles:'+repo),revision:current.revision,workflow,preview,harnesses,backends:agentBackends(),recommended_backend:recommendedBackend,...catalog(),models,skill_inputs,
    skill_sources:{repository:source?{commit:source.sha,paths:Object.keys(JSON.parse(source.files)).filter(p=>p.startsWith('.agents/skills/'))}:null},
    revisions:s.all('SELECT revision,hash,actor,created_at FROM role_config_revisions WHERE repository_id=? ORDER BY revision DESC LIMIT 20',repo)};
  }
  if(method==='PUT'){const saved=saveConfiguration(s,repo,input,user.id);s.audit(user.id,'roles.configure',String(saved.revision),repo);return {ok:true,configuration:saved};}
  return fail(405,'method_not_allowed');
 }
 const apply=/^\/api\/tasks\/([^/]+)\/roles\/apply$/.exec(url.pathname);
 if(apply){if(method!=='POST')return fail(405,'method_not_allowed');
  const filter=scope(user,'repository_id'),task=s.get(`SELECT id,repository_id FROM tasks WHERE id=? AND ${filter.sql}`,apply[1]!,...filter.args);if(!task)fail(404,'task_not_found');
  fields(input,['role','expected_revision']);if(typeof input.role!=='string'||!Number.isSafeInteger(input.expected_revision))fail(400,'invalid_role_apply');
  const current=roleConfiguration(s,task!.repository_id);if(current.revision!==input.expected_revision)fail(409,'role_configuration_conflict','expected_revision');
  const instance=s.get('SELECT id,config_revision FROM role_instances WHERE task_id=? AND role=?',task!.id,String(input.role));if(!instance)fail(404,'role_instance_not_found');
  if(instance!.config_revision===current.revision)return {instance_id:instance!.id,pending:false,config_revision:current.revision};
  // The running role ends at its next safe checkpoint and continues the same assignment on this revision.
  s.run('UPDATE role_instances SET pending_revision=? WHERE id=?',current.revision,instance!.id);
  traceEvent(s,task!.id,'role_revision_requested',{instance_id:instance!.id,role:input.role,config_revision:current.revision,actor:user.id},null,'user:'+user.id);s.audit(user.id,'roles.apply',task!.id,task!.repository_id);
  return {instance_id:instance!.id,pending:true,config_revision:current.revision};
 }
 const task=/^\/api\/tasks\/([^/]+)\/roles$/.exec(url.pathname);if(task&&method==='GET'){const filter=scope(user,'repository_id');if(!s.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,task[1]!,...filter.args))fail(404,'task_not_found');const after=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??50);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'invalid_pagination');const assignments=s.all('SELECT rowid AS sequence,* FROM role_assignments WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT ?',task[1]!,after,limit+1),more=assignments.length>limit;assignments.splice(limit);
  const instances=s.all('SELECT id,role,definition,harness,harness_state,sequence,updated_at,snapshot_id,config_revision,role_revision,pending_revision FROM role_instances WHERE task_id=? ORDER BY role',task[1]!).map(r=>({...r,definition:JSON.parse(r.definition),harness_state:JSON.parse(r.harness_state)}) as Record<string,any>);
  // Every role run with the snapshot it ran with: the actual model, skills, harness and policy, never conversation bodies.
  // RoleRun facts (#169): the scheduler's lease, the run it resumed, the protocol recovery mode, its RunContext and admission.
  const runs=s.all("SELECT id,kind,status,stop_reason,role,role_instance_id,assignment_id,role_snapshot,role_version,harness,harness_version,recovery_mode,lease_scope,lease_epoch,resume_from_run_id,protocol_recovery,run_context,admission FROM task_runs WHERE task_id=? AND role IS NOT NULL ORDER BY rowid",task[1]!).map(r=>({...r,run_context:r.run_context?JSON.parse(String(r.run_context)):null,admission:r.admission?JSON.parse(String(r.admission)):null}) as Record<string,any>);
  const ids=[...new Set([...instances.map(i=>i.snapshot_id),...runs.map(r=>r.role_snapshot)].filter(Boolean))];
  const snapshots=Object.fromEntries(ids.map(id=>[id,JSON.parse(s.get('SELECT snapshot FROM role_snapshots WHERE id=?',id)?.snapshot??'null')]));
  return {instances,assignments,runs,snapshots,next_after:more?assignments.at(-1)!.sequence:null};}
}
