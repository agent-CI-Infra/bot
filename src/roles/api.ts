import type {Store} from '../storage/database.js';
import {repository,scope,type Actor} from '../app/auth.js';
import {fields,fail,type Json} from '../core/security.js';
import {rolePool,harnesses} from './pool.js';
export function roleApi(s:Store,user:Actor,method:string,url:URL,input:Json):Json|undefined{
 const config=/^\/api\/repositories\/([^/]+)\/roles$/.exec(url.pathname);
 if(config){const repo=config[1]!;repository(s,user,repo);const key='roles:'+repo;
  if(method==='GET')return {roles:rolePool,harnesses,configuration:JSON.parse(s.get('SELECT value FROM settings WHERE key=?',key)?.value??'{"enabled":false,"harnesses":{}}')};
  if(method==='PUT'){fields(input,['enabled','harnesses']);if(typeof input.enabled!=='boolean'||!input.harnesses||typeof input.harnesses!=='object'||Array.isArray(input.harnesses)||Object.entries(input.harnesses).some(([role,id])=>!rolePool.some(r=>r.id===role)||!harnesses.some(h=>h.id===id)))fail(400,'invalid_role_configuration');s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(input));s.audit(user.id,'roles.configure',repo,repo);return {ok:true};}
  return fail(405,'method_not_allowed');
 }
 const task=/^\/api\/tasks\/([^/]+)\/roles$/.exec(url.pathname);if(task&&method==='GET'){const filter=scope(user,'repository_id');if(!s.get(`SELECT id FROM tasks WHERE id=? AND ${filter.sql}`,task[1]!,...filter.args))fail(404,'task_not_found');return {instances:s.all('SELECT id,role,definition,harness,sequence,updated_at FROM role_instances WHERE task_id=? ORDER BY role',task[1]!).map(r=>({...r,definition:JSON.parse(r.definition)})),assignments:s.all('SELECT * FROM role_assignments WHERE task_id=? ORDER BY rowid',task[1]!)};}
}
