import { beginModelRequest, finishModelRequest } from '../dist/metrics/accounting.js';
export function usageRequest(store,taskId,modelId,{date='2026-10-22',cost=2,currency='USD',usage={prompt_tokens:1000000,completion_tokens:0,prompt_tokens_details:{cached_tokens:0}},priced=true,id}={}){
  const task=store.get('SELECT * FROM tasks WHERE id=?',taskId);
  const request=beginModelRequest(store,task,id||taskId+'-'+date,{id:modelId,model:'fixture',pricing:priced?{currency,input_per_million:cost,output_per_million:10,cache_per_million:0.2}:null},date+'T12:00:00.000Z');
  finishModelRequest(store,request,usage,200);return request;
}
export function metricTask(store,id,repo='101',kind='review.issue'){
  store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at)
    VALUES(?,?,?,'queued',?,1,'2026-10-22T12:00:00.000Z','2026-10-22T12:00:00.000Z')`,id,repo,kind,id);
}
