import type { Store, Row } from '../storage/database.js';
import { fail, fields, object, randomId, digest, type Json } from '../core/security.js';

export interface Pricing { currency: 'USD' | 'CNY'; input_per_million: number; output_per_million: number; cache_per_million: number; }
export function validatePricing(value: unknown): Pricing | null {
  if (value === null) return null;
  const row=object(value);fields(row,['currency','input_per_million','output_per_million','cache_per_million']);
  if (typeof row.currency!=='string'||!['USD','CNY'].includes(row.currency)) fail(400,'invalid_pricing_currency');
  for (const name of ['input_per_million','output_per_million','cache_per_million'])
    if (typeof row[name]!=='number'||!Number.isFinite(row[name])||row[name]<0||row[name]>1000000) fail(400,'invalid_token_price');
  return row as unknown as Pricing;
}
export function pricingFor(store: Store, modelId: string): Pricing | null {
  const row=store.get('SELECT currency,input_per_million,output_per_million,cache_per_million FROM model_pricing WHERE model_id=?',modelId);
  return row ? row as Pricing : null;
}
export function savePricing(store: Store, modelId: string, pricing: Pricing | null): void {
  if (!pricing) { store.run('DELETE FROM model_pricing WHERE model_id=?',modelId);return; }
  store.run(`INSERT INTO model_pricing VALUES(?,?,?,?,?) ON CONFLICT(model_id) DO UPDATE SET currency=excluded.currency,
    input_per_million=excluded.input_per_million,output_per_million=excluded.output_per_million,cache_per_million=excluded.cache_per_million`,
    modelId,pricing.currency,pricing.input_per_million,pricing.output_per_million,pricing.cache_per_million);
}
const count=(value: unknown): number | null => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
export function normalizeUsage(value: any) {
  const input=count(value?.prompt_tokens??value?.input_tokens),output=count(value?.completion_tokens??value?.output_tokens);
  const cached=count(value?.prompt_tokens_details?.cached_tokens??value?.input_tokens_details?.cached_tokens??value?.prompt_cache_hit_tokens);
  return {input_tokens:input,output_tokens:output,cached_input_tokens:cached!==null&&input!==null&&cached<=input?cached:null};
}
/** One ledger row per provider request. A project run bills its repository; a service role run (task.service_role_id,
 * no repository) bills the role, so its usage never lands on a project. */
export function beginModelRequest(store: Store, task: Row, requestId: string, model: {id:string;model:string;pricing:Pricing|null}, time=new Date().toISOString()): string {
  const id=randomId(),price=model.pricing;
  if(!task.repository_id&&!task.service_role_id)return fail(500,'model_request_owner_missing');
  store.run(`INSERT INTO model_requests(id,task_id,repository_id,service_role_id,request_id,model_id,model_name,requested_at,
    currency,input_per_million,output_per_million,cache_per_million) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,task.id,task.repository_id??null,task.service_role_id??null,requestId,model.id,model.model,time,price?.currency??null,price?.input_per_million??null,price?.output_per_million??null,price?.cache_per_million??null);
  const origin = task.id ? store.get('SELECT conversation_id,source_message FROM task_origins WHERE task_id=?', task.id) : undefined;
  store.run('UPDATE model_requests SET conversation_id=?,role_id=?,source_message=? WHERE id=?',task.conversation_id??origin?.conversation_id??null,
    task.active_role??task.role_id??null,task.source_message??origin?.source_message??null,id);
  return id;
}
export function finishModelRequest(store: Store, id: string, usage: unknown, httpStatus: number | null, state='received'): void {
  const row=store.get('SELECT * FROM model_requests WHERE id=?',id);if(!row||row.finished_at)return;
  const tokens=normalizeUsage(usage),input=tokens.input_tokens,output=tokens.output_tokens,cached=tokens.cached_input_tokens;
  // Cached input is a subset of input tokens. Missing cache data cannot be assumed to be a cache miss.
  const canPrice=row.currency&&input!==null&&output!==null&&(cached!==null||row.input_per_million===row.cache_per_million);
  const cost=canPrice?((input!-(cached??0))*row.input_per_million+(cached??0)*row.cache_per_million+output!*row.output_per_million)/1000000:null;
  store.run(`UPDATE model_requests SET finished_at=?,http_status=?,state=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,cost=?
    WHERE id=? AND finished_at IS NULL`,new Date().toISOString(),httpStatus,state,input,output,cached,cost,id);
}
export interface ExternalModelRequest {
  key:string; source:'provider_requests'|'codex_events'|'acp_prompt';model:string;started_at?:string;
  input_tokens:number|null;output_tokens:number|null;cached_input_tokens?:number|null;finished?:boolean;http_status?:number|null;
  reconciles_key?:string;
}
/** One external receipt updates one original ledger row. Cumulative usage callbacks are never separate requests. */
export function recordExternalModelRequest(store:Store,task:Row,runId:string,value:ExternalModelRequest):string{
  return store.transaction(()=>{
    let row=store.get('SELECT * FROM model_requests WHERE external_key=?',value.key);
    if(row&&row.repository_id!==task.repository_id)return fail(409,'model_request_scope_mismatch');
    if(!row&&value.reconciles_key){
      const unresolved=store.get('SELECT * FROM model_requests WHERE external_key=? AND accounting_source=? AND input_tokens IS NULL AND output_tokens IS NULL',value.reconciles_key,value.source);
      if(unresolved){if(unresolved.repository_id!==task.repository_id)return fail(409,'model_request_scope_mismatch');
        store.run('UPDATE model_requests SET external_key=? WHERE id=?',value.key,unresolved.id);row=unresolved;}
    }
    if(!row){const id=beginModelRequest(store,{...task,id:store.get('SELECT 1 FROM tasks WHERE id=?',task.id)?task.id:null},value.key,
      {id:'external:'+value.source,model:value.model,pricing:null},value.started_at);
      store.run('UPDATE model_requests SET external_key=?,accounting_source=?,run_id=? WHERE id=?',value.key,value.source,runId,id);row=store.get('SELECT * FROM model_requests WHERE id=?',id)!;}
    const tokens=normalizeUsage({input_tokens:value.input_tokens,output_tokens:value.output_tokens,input_tokens_details:{cached_tokens:value.cached_input_tokens}}),
      input=tokens.input_tokens,output=tokens.output_tokens,cached=tokens.cached_input_tokens;
    store.run(`UPDATE model_requests SET input_tokens=CASE WHEN ? IS NULL THEN input_tokens ELSE max(coalesce(input_tokens,0),?) END,
      output_tokens=CASE WHEN ? IS NULL THEN output_tokens ELSE max(coalesce(output_tokens,0),?) END,
      cached_input_tokens=CASE WHEN ? IS NULL THEN cached_input_tokens ELSE max(coalesce(cached_input_tokens,0),?) END,
      finished_at=CASE WHEN ?=1 THEN coalesce(finished_at,?) ELSE finished_at END,http_status=coalesce(?,http_status),
      state=CASE WHEN ? IS NOT NULL AND ? IS NOT NULL THEN 'external_received' ELSE 'external_usage_unknown' END WHERE id=?`,
      input,input,output,output,cached,cached,value.finished?1:0,new Date().toISOString(),value.http_status??null,input??row.input_tokens,output??row.output_tokens,row.id);
    return row.id;
  });
}
/** Task and conversation entries consume the same stable receipts; public cumulative snapshots are not invoices. */
export function externalModelRecorder(store:Store,task:Row,runId:string,initialModel:string,instanceId=runId){
  let model=initialModel;const turns=new Map<string,{known:number;keys:Set<string>}>();
  const request=(value:ExternalModelRequest)=>recordExternalModelRequest(store,task,runId,{...value,key:runId+':'+value.key,model:value.model==='external'?model:value.model});
  const event=(value:{type:string;[key:string]:unknown})=>{
    if(value.type==='session_bound'&&typeof value.configuredModel==='string')model=value.configuredModel;
    if(!['turn','usage'].includes(value.type)||value.type==='usage'&&value.source!=='codex_app_server')return;
    // ACP publishes prompt attempts separately. Only the app-server has per-turn provider usage deltas.
    if(initialModel!=='codex')return;
    const key='codex:'+instanceId+':'+String(value.threadId??'unbound')+':'+String(value.turnId??'unconfirmed:'+runId),pending=key+':pending',
      turn=turns.get(key)??{known:0,keys:new Set<string>()};turns.set(key,turn);
    if(value.type==='usage'){
      const hash=JSON.stringify(value.thread_total);if(turn.keys.has(hash))return;turn.keys.add(hash);
      turn.known++;const delta=value.delta as any;
      recordExternalModelRequest(store,task,runId,{key:key+':usage:'+digest(hash),reconciles_key:pending,source:'codex_events',model,input_tokens:delta?.input_tokens??null,output_tokens:delta?.output_tokens??null,cached_input_tokens:delta?.cached_input_tokens??null,finished:true});
    }else if(!turn.known&&['started','start_unconfirmed','ended'].includes(String(value.phase))&&!store.get('SELECT 1 FROM model_requests WHERE accounting_source=? AND external_key>=? AND external_key<?', 'codex_events',key+':usage:',key+':usage:\uffff'))
      recordExternalModelRequest(store,task,runId,{key:pending,source:'codex_events',model,input_tokens:null,output_tokens:null,finished:value.phase!=='started'});
  };
  return {request,event};
}
export function withTaskMetrics<T extends Row>(store: Store, tasks: T[], now=Date.now()): (T & {metrics: Json})[] {
  if (!tasks.length) return [];
  const ids=tasks.map(t=>String(t.id)),marks=ids.map(()=>'?').join(',');
  const clocks=new Map(store.all(`SELECT * FROM task_metrics WHERE task_id IN (${marks})`,...ids).map(r=>[r.task_id,r]));
  const totals=new Map(store.all(`SELECT task_id,count(*) requests,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,
    sum(cached_input_tokens) cached_input_tokens,
    sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) usage_missing_requests,
    sum(CASE WHEN cached_input_tokens IS NULL THEN 1 ELSE 0 END) cache_missing_requests,
    sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced_requests
    FROM model_requests WHERE task_id IN (${marks}) GROUP BY task_id`,...ids).map(r=>[r.task_id,r]));
  const costs=new Map<string,Row[]>();
  for(const row of store.all(`SELECT task_id,currency,sum(cost) amount FROM model_requests
    WHERE task_id IN (${marks}) AND cost IS NOT NULL GROUP BY task_id,currency`,...ids)){
    const rows=costs.get(row.task_id)||[];rows.push({currency:row.currency,amount:row.amount});costs.set(row.task_id,rows);
  }
  return tasks.map(task=>{
    const clock=clocks.get(task.id),total=totals.get(task.id),empty=clock?.complete?0:null;
    const runtime=clock?Number(clock.runtime_ms)+(clock.active_since!==null?Math.max(0,now-clock.active_since):0):null;
    return {...task,metrics:{runtime_ms:runtime,complete:!!clock?.complete,running:clock?.active_since!=null,
      input_tokens:total?total.input_tokens:empty,output_tokens:total?total.output_tokens:empty,cached_input_tokens:total?total.cached_input_tokens:empty,
      cache_hit_rate:total&&!total.usage_missing_requests&&!total.cache_missing_requests&&total.input_tokens>0?total.cached_input_tokens/total.input_tokens:null,
      requests:total?.requests||0,usage_missing_requests:total?.usage_missing_requests||0,cache_missing_requests:total?.cache_missing_requests||0,
      unpriced_requests:total?.unpriced_requests||0,costs:costs.get(task.id)||[]}};
  });
}
