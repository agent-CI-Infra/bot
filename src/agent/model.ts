import { type Store } from '../storage/database.js';
import { Redactor, stop } from './common.js';
export function selectedModel(store: Store, repositoryId: string) {
  const row=store.get(`SELECT m.* FROM policies p JOIN models m ON m.id=p.model_id WHERE p.repository_id=? AND
    (m.repository_id=p.repository_id OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=p.repository_id)))`,repositoryId);
  if(!row?.api_key)return stop('model_not_configured','waiting_configuration');
  const key=String(store.secrets.open(row.api_key,`model:${row.id}`).value||'');if(!key)return stop('model_key_missing','waiting_configuration');
  return {url:String(row.api_url),key,model:String(row.model_name)};
}
const fn=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const string={type:'string'};
export function tools(development:boolean){
  const result=[fn('read_file','Read a file in this task workspace',{path:string},['path']),fn('run_command','Run a bounded command in this task workspace',{command:string},['command'])];
  if(development)result.push(fn('write_file','Replace a text file in this task workspace',{path:string,content:string},['path','content']),
    fn('finish_development','Finish implementation; the server will independently run the required tests and publish only the registered bot branch',
      {summary:string,test_command:string},['summary','test_command']));
  else result.push(fn('finish_review','Finish review with evidence and explicit issue intent; only real diff locations can be inline',{
    summary:string,requires_code_change:{type:'boolean'},issue_requests_code:{type:'boolean'},clarification_required:{type:'boolean'},implementation_goal:string,request_quote:string,
    findings:{type:'array',items:{type:'object',properties:{body:string,format:{type:'string',enum:['discussion','inline']},selection_reason:string,path:string,line:{type:'integer'},side:{type:'string',enum:['LEFT','RIGHT']},start_line:{type:'integer'},start_side:{type:'string',enum:['LEFT','RIGHT']}},required:['body','format','selection_reason'],additionalProperties:false}}
  },['summary','requires_code_change','issue_requests_code','clarification_required','implementation_goal','request_quote','findings']));
  return result;
}
export async function completion(store:Store,repo:string,messages:any[],development:boolean,redactor:Redactor){
  const config=selectedModel(store,repo);redactor.add(config.key);
  const url=config.url.replace(/\/$/,'');const endpoint=url.endsWith('/chat/completions')?url:url+'/chat/completions';
  let response:Response;
  try{response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:'Bearer '+config.key,'Content-Type':'application/json'},
    body:JSON.stringify({model:config.model,messages,tools:tools(development),tool_choice:'auto',temperature:0,max_tokens:8192})});}
  catch{return stop('model_unavailable','retry_wait');}
  if([401,403].includes(response.status))stop('model_authentication_failed','waiting_configuration');
  if(!response.ok)stop('model_http_'+response.status,response.status===429||response.status>=500?'retry_wait':'failed');
  const raw=await response.text();if(raw.length>2*1024*1024)stop('model_response_too_large');
  let value:any;try{value=JSON.parse(raw);}catch{return stop('model_response_invalid');}
  const message=redactor.clean(value.choices?.[0]?.message);
  if(!message||message.role!=='assistant')stop('model_response_invalid');
  return message;
}
