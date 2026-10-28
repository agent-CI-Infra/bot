import { type Store } from '../storage/database.js';
import { type Actor, repository, scope } from './auth.js';
import { deliveryResult } from '../review/delivery.js';
import { fail, type Json } from '../core/security.js';
import { withTaskMetrics } from '../metrics/accounting.js';
import { explainFailure } from '../agent/failures.js';
// Faults are classified when read, so logs written before a cause existed are explained the same way.
function faultCause(log:Record<string,any>){
  if(!String(log.content).startsWith('{"type":"fault"'))return log;
  try{const value=JSON.parse(log.content);return {...log,cause:explainFailure(value.code,value.state)};}catch{return log;}
}
const publicTask=(row:Record<string,any>)=>({id:row.id,repository_id:row.repository_id,full_name:row.full_name,kind:row.kind,status:row.status,summary:row.summary,
  object_number:row.object_number,head_sha:row.head_sha,source_task_id:row.source_task_id,generation:row.generation,phase:row.phase,
  error_code:row.error_code,error_cause:explainFailure(row.error_code,row.status),retry_count:row.retry_count,pushed_sha:row.pushed_sha||null,attempt:row.attempt,result:row.result?JSON.parse(row.result):null,created_at:row.created_at,updated_at:row.updated_at});

const pushedSha="(SELECT json_extract(data,'$.remote_sha') FROM development_candidates WHERE task_id=tasks.id) AS pushed_sha";
const repositoryName='(SELECT full_name FROM repositories WHERE id=tasks.repository_id) AS full_name';
export function queries(store: Store, user: Actor, url: URL): Json | undefined {
  const path = url.pathname, repo = url.searchParams.get('repository_id');
  if (repo) repository(store, user, repo);
  const filter = scope(user, 'repository_id');
  if (path === '/api/events') {
    const clauses = [filter.sql], args = [...filter.args];
    for (const key of ['repository_id', 'account_id', 'event', 'status', 'delivery_id']) {
      const value = url.searchParams.get(key);
      if (value) { clauses.push(`${key}=?`); args.push(value); }
    }
    const owner = url.searchParams.get('owner_id');
    if (owner) { clauses.push('repository_id IN (SELECT id FROM repositories WHERE owner_id=?)'); args.push(owner); }
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) fail(400, 'invalid_pagination');
    return { events: store.all(`SELECT *, (SELECT full_name FROM repositories WHERE id=deliveries.repository_id) AS full_name
      FROM deliveries WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC,id DESC LIMIT ? OFFSET ?`, ...args, limit, offset).map(row=>{const {payload,response,request_headers,...safe}=row;return {...safe,...deliveryResult(store,row)};}) };
  }
  const event = /^\/api\/events\/([^/]+)$/.exec(path);
  if (event) {
    const row = store.get(`SELECT * FROM deliveries WHERE id=? AND ${filter.sql}`, event[1]!, ...filter.args);
    if (!row) return fail(404, 'event_not_found');
    return { event: { ...row, request_headers: JSON.parse(row.request_headers),
      payload: Buffer.from(row.payload).toString('utf8'), response: JSON.parse(row.response) } };
  }
  if (path === '/api/tasks') {
    const clauses=[filter.sql],args=[...filter.args];
    for(const [key,column] of [['repository_id','repository_id'],['account_id','account_id'],['owner_id','owner_id']]){
      const value=url.searchParams.get(key!);if(value){clauses.push(key==='repository_id'?'repository_id=?':`repository_id IN (SELECT id FROM repositories WHERE ${column}=?)`);args.push(value);}
    }
    // Review and development tasks are listed on separate pages.
    const kind=url.searchParams.get('kind');if(kind){if(!['review','development'].includes(kind))fail(400,'invalid_task_kind');clauses.push('kind LIKE ?');args.push(kind+'.%');}
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset))fail(400,'invalid_pagination');
    return {tasks:withTaskMetrics(store,store.all(`SELECT *,${repositoryName},${pushedSha} FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,...args,limit,offset).map(publicTask)),execution_available:true};
  }
  const task = /^\/api\/tasks\/([^/]+)(\/logs)?$/.exec(path);
  if (task) {
    const row = store.get(`SELECT *,${repositoryName},${pushedSha} FROM tasks WHERE id=? AND ${filter.sql}`, task[1]!, ...filter.args);
    if (!row) return fail(404, 'task_not_found');
    const fault=row.error_code&&!task[2]?store.get("SELECT content FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.type')='fault' AND json_extract(content,'$.code')=? ORDER BY rowid DESC LIMIT 1",row.id,row.error_code):null;
    const errorDetail=fault?JSON.parse(fault.content).detail:null;
    return task[2] ? { logs: store.all('SELECT id,content,created_at FROM task_logs WHERE task_id=? ORDER BY rowid', row.id).map(faultCause) } : { task: {...withTaskMetrics(store,[publicTask(row)])[0],error_detail:errorDetail||null},publications:store.all('SELECT kind,state,response FROM github_effects WHERE task_id=?',row.id).map(p=>({...p,response:p.response?JSON.parse(p.response):null})) };
  }
  if (path === '/api/audit') return { audit: store.all(`SELECT * FROM audit WHERE ${filter.sql}${repo ? ' AND repository_id=?' : ''}
    ORDER BY created_at DESC LIMIT 100`, ...filter.args, ...(repo ? [repo] : [])) };
  return undefined;
}
