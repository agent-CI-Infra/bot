import { type Store } from '../storage/database.js';
import { stop } from './common.js';
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
  const result=[fn('read_file','Read a file in this task workspace',{path:string},['path']),fn('run_command','Run a shell command in this task workspace inside the long-lived project container (internet access available for dependencies). Output is streamed to the console.',
    {command:string,timeout_seconds:{type:'integer',minimum:1,description:'Optional. Without it the command runs until it ends; set it only for a command that might hang'},
      keep_background:{type:'boolean',description:'Keep processes started in the background (redirect their output to a file) for later commands of this task; they stop when the task ends'}},['command']),
    fn('github_read_token','Exchange a short-lived read-only GitHub token for this repository. Later run_command calls get it as GH_TOKEN and GITHUB_TOKEN for https://api.github.com; it can read code, Issues, pull requests, comments, reviews, Actions runs and checks, and cannot write anything. The token value is never shown to you',{},[])];
  if(development)result.push(fn('write_file','Replace a text file in this task workspace',{path:string,content:string},['path','content']),
    fn('finish_development','Finish implementation; the server will independently run the required tests and publish only the registered bot branch',
      {summary:string,test_command:string,change_title:{type:'string',description:'Concise code-change subject only. No review passphrase or review template.'}},['summary','test_command','change_title']));
  else result.push(fn('finish_review','Finish review with evidence and explicit issue intent; only real diff locations can be inline',{
    summary:string,labels:{type:'array',items:string,description:'Classification labels for this Issue or PR, chosen only from repository_labels. The control plane adds the valid ones after publishing; never apply labels yourself'},requires_code_change:{type:'boolean'},issue_requests_code:{type:'boolean'},clarification_required:{type:'boolean'},implementation_goal:string,request_quote:string,
    findings:{type:'array',items:{type:'object',properties:{body:string,format:{type:'string',enum:['discussion','inline']},selection_reason:string,actionable:{type:'boolean'},within_goal:{type:'boolean'},requires_human_decision:{type:'boolean'},path:string,line:{type:'integer'},side:{type:'string',enum:['LEFT','RIGHT']},start_line:{type:'integer'},start_side:{type:'string',enum:['LEFT','RIGHT']}},required:['body','format','selection_reason','actionable','within_goal','requires_human_decision'],additionalProperties:false}}
  },['summary','requires_code_change','issue_requests_code','clarification_required','implementation_goal','request_quote','findings']));
  return result;
}
