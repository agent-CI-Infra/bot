import { commandTool } from './command.js';
import { type Store } from '../storage/database.js';
import { stop } from './common.js';
import { pricingFor } from '../metrics/accounting.js';
import { githubWriteTool } from '../github/write.js';
// Exact task-profile overrides are trusted administrator configuration, never model/tool input.
// Keep invalid/deleted overrides visible: falling back would silently change the user's chosen model.
export function selectedModel(store: Store, repositoryId: string, taskKind?: string) {
  const policy = store.get('SELECT model_id,task_models FROM policies WHERE repository_id=?', repositoryId);
  let overrides: Record<string, string>;
  try {
    overrides = JSON.parse(policy?.task_models || '{}');
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error();
  } catch { return stop('task_models_invalid', 'waiting_configuration', '任务模型配置无效，请重新保存项目模型设置。'); }
  // Work types (and 'manager', the dispatch call) name their model in task_models; anything else uses the project default.
  const overridden = !!taskKind && Object.hasOwn(overrides, taskKind);
  const modelId = overridden ? overrides[taskKind!] : policy?.model_id;
  if (overridden && (typeof modelId !== 'string' || !modelId)) return stop('task_models_invalid', 'waiting_configuration', '任务模型配置无效，请重新保存项目模型设置。');
  const row = modelId ? visibleModel(store, repositoryId, modelId) : undefined;
  if (!row?.api_key) return stop('model_not_configured','waiting_configuration',`仓库 ${repositoryId}${overridden ? ' 的任务 ' + taskKind : ''} 未配置可用模型或模型凭据；不会自动切换到其他模型。`);
  return openModel(store, row);
}
/** A model this project may use: its own, or a shared one granted to it. Returns the row without opening its key. */
export const visibleModel = (store: Store, repositoryId: string, modelId: string) => store.get(`SELECT m.* FROM models m WHERE m.id=? AND
    (m.repository_id=? OR (m.repository_id IS NULL AND EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?)))`, modelId, repositoryId, repositoryId);
/** The run-time model of a visible row; the key is opened here and never stored with a role snapshot. */
export function openModel(store: Store, row: Record<string, any>) {
  const key=String(store.secrets.open(row.api_key,`model:${row.id}`).value||'');if(!key)return stop('model_key_missing','waiting_configuration',`模型 ${row.id} 的凭据为空，请重新配置。`);
  return {id:String(row.id),version:Number(row.version),url:String(row.api_url),key,model:String(row.model_name),pricing:pricingFor(store,String(row.id))};
}
// The one place a saved model URL becomes request addresses (tasks, model listing and model tests all use it).
// Only a trailing slash and a trailing /chat/completions are removed; /v1 is never added or removed, so the base the
// administrator wrote decides whether requests carry it. has_v1 reports whether that base path ends in /v1.
export function modelEndpoints(url:string){
  const base=url.replace(/\/$/,'').replace(/\/chat\/completions$/,'');
  let path='';try{path=new URL(base).pathname;}catch{/* A saved URL was validated on write; an unparsable one simply has no /v1. */}
  return {chat_url:base+'/chat/completions',models_url:base+'/models',has_v1:/\/v1$/.test(path)};
}
const fn=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const string={type:'string'};
// The tools a workspace agent gets follow its trusted capabilities: a tool its work type does not allow is not offered.
// Each configured write is a platform tool; the control plane performs it (see writeCatalog). github_write is offered to
// every work type and kept only where the executing role may write to GitHub (#381).
export function tools(profile: { workspaceWrite: boolean; completion: 'review' | 'publication' | 'reply' | 'event'; read?: boolean; shell?: boolean; notes?: boolean; github?: boolean; writes?: string[] }){
  const development = profile.completion === 'publication', allow = (flag?: boolean) => flag !== false;
  const writes = profile.writes ?? (development ? ['code', 'pull_request'] : profile.completion === 'review' ? ['reply', 'labels'] : ['reply']);
  const labels = writes.includes('labels') ? { labels: { type: 'array', items: string, description: 'Classification labels for this Issue or PR, chosen only from repository_labels. The control plane adds the valid ones after publishing; never apply labels yourself' } } : {};
  const result:any[]=[];
  if(allow(profile.read))result.push(fn('read_file','Read a file in this task workspace',{path:string},['path']));
  if(allow(profile.shell))result.push(commandTool(null));
  if(allow(profile.github))result.push(fn('github_read_token','Exchange a short-lived read-only GitHub token for this repository. Later run_command calls get it as GH_TOKEN and GITHUB_TOKEN for https://api.github.com; it can read code, Issues, pull requests, comments, reviews, Actions runs and checks, and cannot write anything. The token value is never shown to you',{},[]));
  if(profile.workspaceWrite||allow(profile.notes))result.push(fn('write_file',profile.workspaceWrite?'Replace a repository text file or a persistent project note at ../notes/<name>':'Replace a persistent project note at ../notes/<name> only. Repository writes are forbidden',{path:string,content:string},['path','content']));
  if(writes.includes('pull_request'))result.push(
    fn('create_pull_request',(development?'Create or update the bot pull request from the working tree now.':'Publish the working-tree changes as a bot pull request now: a new one when the task is an Issue, or an update of this bot\'s own pull request. It does not end the task; finish as usual afterwards.')+' test_command records a command you already ran; only the project policy command is run by the control plane. On validation_failed, fix the problem and call again. Remove generated files before calling',
      {summary:string,test_command:string,change_title:{type:'string',description:'Concise code-change subject only. No review passphrase or review template.'},
        release_label:{type:'string',description:'For openJiuwen-ai/sciencediscovery: choose exactly one release:* category using current CONTRIBUTING.md, .github/release.yml and .agents/skills/create-github-pr/SKILL.md. Category follows the change, not its author. Other repositories may omit this.'}},['summary','test_command','change_title']));
  result.push(githubWriteTool);
  // Development ends with its PR; an event workflow ends with its own finishing tool (eventTools).
  if(development||profile.completion==='event')return result;
  // A custom workflow replies: a summary comment and findings, without the Issue authorization fields of a review.
  if(profile.completion==='reply')result.push(fn('finish_review',writes.includes('reply')?'Finish this workflow with the reply the control plane publishes; only real diff locations of a pull request can be inline':'Finish this workflow with your result. This workflow does not reply on GitHub: the result is kept for the console only',{
    summary:string,...labels,findings:{type:'array',items:{type:'object',properties:{body:string,format:{type:'string',enum:['discussion','inline']},selection_reason:string,path:string,line:{type:'integer'},side:{type:'string',enum:['LEFT','RIGHT']},start_line:{type:'integer'},start_side:{type:'string',enum:['LEFT','RIGHT']}},required:['body','format','selection_reason'],additionalProperties:false}}
  },['summary','findings']));
  else result.push(fn('finish_review','Finish review with evidence and explicit issue intent; only real diff locations can be inline',{
    summary:string,...labels,requires_code_change:{type:'boolean'},issue_requests_code:{type:'boolean'},clarification_required:{type:'boolean'},implementation_goal:string,request_quote:string,
    resolved_comments:{type:'array',items:{type:'integer'},description:'Ids (from review_comments.json) of this bot\'s earlier top-level inline comments that the reviewed head has fixed; the control plane resolves their threads'},
    product_defect:{type:'boolean',description:'For automatically filed Actions code failures, true only after repository evidence confirms a product defect, a concrete current/expected behavior and a code fix. External failures, ambiguous evidence and engineering-only failures are false. This is not development approval.'},
    findings:{type:'array',items:{type:'object',properties:{body:string,format:{type:'string',enum:['discussion','inline']},selection_reason:string,actionable:{type:'boolean'},within_goal:{type:'boolean'},requires_human_decision:{type:'boolean'},human_action:{type:'string',description:'When requires_human_decision is true: one sentence on what a person must decide or do'},comment_id:{type:'integer',description:'When this finding is one of this bot\'s earlier top-level inline comments that still applies: its id from review_comments.json. It is not posted again; the summary links to it'},requested_in:{type:'object',description:'On a pull request this bot opened: the comment, review or inline comment of a person or another review bot that asked for this change, when you will make it (with actionable and within_goal true). The control plane checks who wrote it and then revises the pull request',properties:{type:{type:'string',enum:['comment','review','review_comment'],description:'comment: comments.json; review: reviews.json; review_comment: review_comments.json'},id:{type:'integer'}},required:['type','id'],additionalProperties:false},path:string,line:{type:'integer'},side:{type:'string',enum:['LEFT','RIGHT']},start_line:{type:'integer'},start_side:{type:'string',enum:['LEFT','RIGHT']}},required:['body','format','selection_reason','actionable','within_goal','requires_human_decision'],additionalProperties:false}}
  },['summary','requires_code_change','issue_requests_code','clarification_required','implementation_goal','request_quote','findings']));
  return result;
}
// The finishing tool of a workflow that runs on an event, and the writes only it has. Rerun and report are recorded when
// called; the control plane checks the cited lines and acts after the agent finishes.
export function eventTools(kind:string,writes:string[]){
  if(kind==='gate.onboarding'){
    const commands={type:'array',items:string};
    return [fn('submit_gate_plan','Finish this turn with your reply to the person and the complete gate plan. The control plane checks the plan, shows it in the conversation and renders the gate files from it; the gate PR is opened only after the person confirms',{
      reply:{type:'string',description:'Your message to the person in Simplified Chinese: findings, review of existing CI, each lane with its commands, sources, reasons and what you ran with its timing, the standard changes, questions'},
      plan:{type:'object',additionalProperties:false,required:['toolchains','install','lanes','observe','workflow'],properties:{
        toolchains:{type:'object',additionalProperties:false,properties:{node:string,python:string,go:string,java:string},description:'Version strings; empty means not set up. node runs gate.mjs (20 or later). go may name a go.mod'},
        install:{...commands,description:'Shell commands that install dependencies before the lanes run'},
        lanes:{type:'object',additionalProperties:false,properties:{'pr-ready':commands,'pr-merge':commands,daily:commands,release:commands},description:'Only the lanes you change, each with its complete command list. A lane left out keeps its commands from ../context/plan.json exactly; do not copy an unchanged lane, since retyping a command can change its quoting'},
        observe:{type:'array',items:{type:'string',enum:['pr-ready','pr-merge','daily','release']},description:'Lanes whose failures are recorded without failing the gate'},
        workflow:{type:'string',description:'Where the gate job goes: one path from targets in ../context/gate.json, or empty for the default'}}}},['reply','plan'])];
  }
  if(kind==='release.observe')return [fn('finish_observation','Finish with your analysis of the release run. The control plane shows it beside the authoritative status, which it reads itself',
    {job_ids:{type:'array',items:{type:'integer'},description:'Ids of the failed jobs of this run that your analysis is about'},advice:{type:'string',description:'Your analysis and suggested next steps'}},['job_ids','advice'])];
  if(kind==='release.notes')return [fn('finish_release_notes','Finish with the release notes: every source id of ../context/sources.json exactly once, grouped under allowed headings. The control plane checks the groups and writes every title and link itself',
    {groups:{type:'array',items:{type:'object',properties:{heading:string,source_ids:{type:'array',items:string}},required:['heading','source_ids'],additionalProperties:false}}},['groups'])];
  const evidence={type:'array',items:string,description:'Log lines copied exactly from what the failed steps printed (their file in ../context/failed-steps/ or the same part of the job log), without timestamps; never command echoes or invented lines'};
  return [
    ...(writes.includes('actions_rerun')?[fn('rerun_failed_run','Ask for the original run to be rerun once because these failed jobs fail for a reason outside the repository on this commit (a service outage or rate limit, the network, the runner, the disk). Recorded now; after you finish the control plane checks the cited lines and its single rerun budget, and reruns only when every failed job is external',
      {job_ids:{type:'array',items:{type:'integer'}},reason:{type:'string',description:'One or two sentences in English for a public Issue'},evidence},['job_ids','reason','evidence'])]:[]),
    ...(writes.includes('issue')?[fn('report_failure','Report one failed job. kind: code when the repository at this commit causes it, unknown when the evidence is missing, mixed or does not tell, external when it comes from outside the repository. Recorded now; after you finish the control plane checks the cited lines, then files a public Issue or comments on the open Issue of the same failure, never twice',
      {job_id:{type:'integer'},kind:{type:'string',enum:['external','code','unknown']},reason:{type:'string',description:'One or two sentences in English for a public Issue'},evidence},['job_id','kind','reason','evidence'])]:[]),
    fn('finish_analysis','Finish once every failed job is covered by rerun_failed_run or report_failure. A failed job you leave out is reported as unknown',{summary:string},['summary'])];
}
