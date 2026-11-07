import {harnesses} from './harness.js';
import type {Store} from '../storage/database.js';
import {repository,scope,type Actor} from '../app/auth.js';
import {fields,fail,type Json} from '../core/security.js';
import {rolePool,configuredRoles} from './pool.js';
export function roleApi(s:Store,user:Actor,method:string,url:URL,input:Json):Json|undefined{
 const config=/^\/api\/repositories\/([^/]+)\/roles$/.exec(url.pathname);
 if(config){const repo=config[1]!;repository(s,user,repo);const key='roles:'+repo;
  if(method==='GET'){const configuration=JSON.parse(s.get('SELECT value FROM settings WHERE key=?',key)?.value??'{"enabled":false,"harnesses":{}}');return {roles:configuredRoles(configuration),harnesses,configuration};}
  if(method==='PUT'){fields(input,['enabled','harnesses','roles']);const custom=(input.roles??[]) as any[];if(!Array.isArray(custom)||custom.length>16||custom.some(r=>!r||typeof r.id!=='string'||!/^([a-z][a-z0-9_-]{0,31})$/.test(r.id)||typeof r.prompt!=='string'||!r.prompt.trim()||r.prompt.length>16000)||new Set(custom.map(r=>r.id)).size!==custom.length)fail(400,'invalid_role_definitions');if(typeof input.enabled!=='boolean'||!input.harnesses||typeof input.harnesses!=='object'||Array.isArray(input.harnesses)||Object.entries(input.harnesses).some(([role,id])=>!configuredRoles({roles:custom}).some(r=>r.id===role)||!harnesses.some(h=>h.id===id)))fail(400,'invalid_role_configuration');s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(input));s.audit(user.id,'roles.configure',repo,repo);return {ok:true};}
  return fail(405,'method_not_allowed');
 }
 const task=/^\/api\/tasks\/([^/]+)\/roles$/.exec(url.pathname);if(task&&method==='GET'){const filter=scope(user,'repository_id');if(!s.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,task[1]!,...filter.args))fail(404,'task_not_found');const after=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??50);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'invalid_pagination');const assignments=s.all('SELECT rowid AS sequence,* FROM role_assignments WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT ?',task[1]!,after,limit+1),more=assignments.length>limit;assignments.splice(limit);return {instances:s.all('SELECT id,role,definition,harness,harness_state,sequence,updated_at FROM role_instances WHERE task_id=? ORDER BY role',task[1]!).map(r=>({...r,definition:JSON.parse(r.definition),harness_state:JSON.parse(r.harness_state)})),assignments,next_after:more?assignments.at(-1)!.sequence:null};}
}
