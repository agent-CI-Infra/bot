import { readToolResult } from './tool-results.js';
import { modelCapabilities, modelProtocol, type ModelInterfaceType } from '../models/catalog.js';
import { commandTool } from './command.js';
import { type Store } from '../storage/database.js';
import { stop } from './common.js';
import { loopbackHostname } from '../core/security.js';
import { pricingFor } from '../metrics/accounting.js';
import { githubWriteTool } from '../github/write.js';
import { pullRequestLabelsSchema } from '../github/pull-request-labels.js';
import { reviewConclusions } from '../review/findings.js';
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
    (m.repository_id=? OR (m.repository_id IS NULL AND (m.restricted=0 OR EXISTS(SELECT 1 FROM model_projects mp WHERE mp.model_id=m.id AND mp.repository_id=?))))`, modelId, repositoryId, repositoryId);
/** The run-time model of a visible row; the key is opened here and never stored with a role snapshot. */
export interface RuntimeModel {
  id: string; version: number; url: string; key: string; model: string;
  pricing: ReturnType<typeof pricingFor>;
  capabilities?: ReturnType<typeof modelCapabilities>;
  protocol?: ReturnType<typeof modelProtocol>;
}
export function openModel(store: Store, row: Record<string, any>): RuntimeModel {
  // A row saved before the write-side rule can still hold a public http URL; sending the key there in the clear is the
  // leak this refuses. wait for a person to change the address rather than retrying with the same one.
  const savedUrl = String(row.api_url ?? '');
  let parsed: URL | null = null; try { parsed = new URL(savedUrl); } catch {}
  if (parsed?.protocol === 'http:' && !loopbackHostname(parsed.hostname))
    return stop('model_url_insecure','waiting_configuration',`模型 ${row.id} 的地址是明文 HTTP 且不是本机，请改成 https 或本机地址后重试。`);
  const key=String(store.secrets.open(row.api_key,`model:${row.id}`).value||'');if(!key)return stop('model_key_missing','waiting_configuration',`模型 ${row.id} 的凭据为空，请重新配置。`);
  return {id:String(row.id),version:Number(row.version),url:String(row.api_url),key,model:String(row.model_name),pricing:pricingFor(store,String(row.id)),capabilities:modelCapabilities(store,row as any),protocol:modelProtocol(store,row as any)};
}
// The one place a saved model URL becomes request addresses (tasks, model listing and model tests all use it).
// Only a trailing slash and a trailing /chat/completions are removed; /v1 is never added or removed, so the base the
// administrator wrote decides whether requests carry it. has_v1 reports whether that base path ends in /v1.
export function modelEndpoints(url:string){
  const base=url.replace(/\/$/,'').replace(/\/chat\/completions$/,'');
  let path='';try{path=new URL(base).pathname;}catch{/* A saved URL was validated on write; an unparsable one simply has no /v1. */}
  return {chat_url:base+'/chat/completions',models_url:base+'/models',has_v1:/\/v1$/.test(path)};
}
export function resolveModelWireUrl(url: string, interfaceType: ModelInterfaceType = 'openai-chat-completions'): string {
  const trimmed = url.replace(/\/$/, '');
  if (interfaceType === 'openai-chat-completions') return modelEndpoints(url).chat_url;
  if (interfaceType === 'anthropic-messages') {
    if (trimmed.endsWith('/messages')) return trimmed;
    const stripped = trimmed.replace(/\/(?:chat\/completions|responses)$/, '');
    let path = ''; try { path = new URL(stripped).pathname; } catch {}
    return /\/v1$/.test(path) ? stripped + '/messages' : stripped + '/v1/messages';
  }
  if (trimmed.endsWith('/responses')) return trimmed;
  const stripped = trimmed.replace(/\/(?:chat\/completions|messages)$/, '');
  let path = ''; try { path = new URL(stripped).pathname; } catch {}
  return !path || path === '/' ? stripped + '/v1/responses' : stripped + '/responses';
}
export function resolveModelsListUrl(url: string, interfaceType: ModelInterfaceType = 'openai-chat-completions'): string {
  if (interfaceType === 'openai-chat-completions') return modelEndpoints(url).models_url;
  const stripped = url.replace(/\/$/, '').replace(/\/(?:chat\/completions|responses|messages|models)$/, '');
  let path = ''; try { path = new URL(stripped).pathname; } catch {}
  if (interfaceType === 'anthropic-messages' && !/\/v1$/.test(path)) return stripped + '/v1/models';
  if (interfaceType === 'openai-responses' && (!path || path === '/')) return stripped + '/v1/models';
  return stripped + '/models';
}
const fn=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const string={type:'string'};
// The tools a workspace agent gets follow its trusted capabilities: a tool its work type does not allow is not offered.
// Each configured write is a platform tool; the control plane performs it (see writeCatalog). github_write is offered to
// every work type and kept only where the executing role may write to GitHub (#381).
export function tools(profile: { workspaceWrite: boolean; completion: 'review' | 'publication' | 'reply' | 'event'; read?: boolean; shell?: boolean; notes?: boolean; github?: boolean; writes?: string[] }){
  const development = profile.completion === 'publication', allow = (flag?: boolean) => flag !== false;
  const writes = profile.writes ?? (development ? ['code', 'pull_request'] : profile.completion === 'review' ? ['reply', 'labels'] : ['reply']);
  const labels = writes.includes('labels') ? { labels: { type: 'array', items: string, description: 'Classification labels for this Issue or PR, chosen only from repository_labels; an empty list when none fits. Only this list is applied, never a Labels line in the summary. The control plane adds the valid ones after publishing; never apply labels yourself' } } : {};
  const result:any[]=[readToolResult];
  if(allow(profile.read))result.push(fn('read_file','Read a file in this task workspace',{path:string},['path']));
  if(allow(profile.shell))result.push(commandTool(null));
  if(allow(profile.github))result.push(fn('github_read_token','Exchange a short-lived read-only GitHub token for this repository. Later run_command calls get it as GH_TOKEN and GITHUB_TOKEN for https://api.github.com; it can read code, Issues, pull requests, comments, reviews, Actions runs and checks, and cannot write anything. The token value is never shown to you',{},[]));
  if(profile.workspaceWrite||allow(profile.notes))result.push(fn('write_file',profile.workspaceWrite?'Replace a repository text file or a persistent project note at ../notes/<name>':'Replace a persistent project note at ../notes/<name> only. Repository writes are forbidden',{path:string,content:string},['path','content']));
  if(writes.includes('pull_request'))result.push(
    fn('create_pull_request',(development?'Create or update the bot pull request from the working tree now.':'Publish the working-tree changes as a bot pull request now: a new one when the task is an Issue, or an update of this bot\'s own pull request. It does not end the task; finish as usual afterwards.')+' test_command records a command you already ran; only the project policy command is run by the control plane. On validation_failed, fix the problem and call again. Remove generated files before calling',
      {summary:string,test_command:string,change_title:{type:'string',description:'Concise code-change subject only. No review passphrase or review template.'},
        labels:pullRequestLabelsSchema},['summary','test_command','change_title']));
  result.push(githubWriteTool);
  // Development ends with its PR; an event workflow ends with its own finishing tool (eventTools).
  if(development||profile.completion==='event')return result;
  // A custom workflow replies: a summary comment and findings, without the Issue authorization fields of a review.
  if(profile.completion==='reply')result.push(fn('finish_review',writes.includes('reply')?'Finish this workflow with the reply the control plane publishes; only real diff locations of a pull request can be inline':'Finish this workflow with your result. This workflow does not reply on GitHub: the result is kept for the console only',{
    summary:string,...labels,findings:{type:'array',items:{type:'object',properties:{body:string,format:{type:'string',enum:['discussion','inline']},selection_reason:string,path:string,line:{type:'integer'},side:{type:'string',enum:['LEFT','RIGHT']},start_line:{type:'integer'},start_side:{type:'string',enum:['LEFT','RIGHT']}},required:['body','format','selection_reason'],additionalProperties:false}}
  },['summary','findings']));
  // A review reports findings, a recommendation (#815) and, for an Issue, its conclusion (#1026); whether to develop is the
  // Manager's decision, not a field here.
  else result.push(fn('finish_review','Finish review with evidence, findings and a recommendation; only real diff locations can be inline',{
    summary:string,...labels,recommendation:{type:'string',description:'What you recommend the project do next, in one or two sentences: for an Issue, whether it can be developed as asked and what is still open; for a pull request, whether it is ready. The Manager reads it; it is never a permission.'},
    conclusion:{type:'string',enum:[...reviewConclusions],description:'For an Issue review: ready_for_development, needs_information, human_decision_required or no_code_change, as the review rules define them. Omit it for a pull request. The Manager reads it; it is never a permission.'},
    resolved_comments:{type:'array',items:{type:'integer'},description:'Ids (from review_comments.json) of this bot\'s earlier top-level inline comments that the reviewed head has fixed; the control plane resolves their threads'},
    product_defect:{type:'boolean',description:'For automatically filed Actions code failures, true only after repository evidence confirms a product defect, a concrete current/expected behavior and a code fix. External failures, ambiguous evidence and engineering-only failures are false. This is not development approval.'},
    findings:{type:'array',items:{type:'object',properties:{body:string,format:{type:'string',enum:['discussion','inline']},selection_reason:string,actionable:{type:'boolean'},within_goal:{type:'boolean'},requires_human_decision:{type:'boolean'},human_action:{type:'string',description:'When requires_human_decision is true: one sentence on what a person must decide or do'},comment_id:{type:'integer',description:'When this finding is one of this bot\'s earlier top-level inline comments that still applies: its id from review_comments.json. It is not posted again; the summary links to it'},requested_in:{type:'object',description:'On a pull request this bot opened: the comment, review or inline comment of a person or another review bot that asked for this change, when you will make it (with actionable and within_goal true). The control plane checks who wrote it and then revises the pull request',properties:{type:{type:'string',enum:['comment','review','review_comment'],description:'comment: comments.json; review: reviews.json; review_comment: review_comments.json'},id:{type:'integer'}},required:['type','id'],additionalProperties:false},path:string,line:{type:'integer'},side:{type:'string',enum:['LEFT','RIGHT']},start_line:{type:'integer'},start_side:{type:'string',enum:['LEFT','RIGHT']}},required:['body','format','selection_reason','actionable','within_goal','requires_human_decision'],additionalProperties:false}}
  },['summary','findings',...(writes.includes('labels')?['labels']:[])]));
  return result;
}
// The finishing tool of a workflow that runs on an event, and the writes only it has. Rerun and report are recorded when
// called; the control plane checks the cited lines and acts after the agent finishes.
export function eventTools(kind:string,writes:string[]){
  if(kind==='release.observe')return [fn('finish_observation','Finish with your analysis of the release run. The control plane shows it beside the authoritative status, which it reads itself',
    {job_ids:{type:'array',items:{type:'integer'},description:'Ids of the failed jobs of this run that your analysis is about'},advice:{type:'string',description:'Your analysis and suggested next steps'}},['job_ids','advice'])];
  if(kind==='release.notes')return [fn('finish_release_notes','Finish with the release notes: every source id of ../context/sources.json exactly once, grouped under allowed headings. The control plane checks the groups and writes every title and link itself',
    {groups:{type:'array',items:{type:'object',properties:{heading:string,source_ids:{type:'array',items:string}},required:['heading','source_ids'],additionalProperties:false}}},['groups'])];
  const evidence={type:'array',items:string,description:'Log lines copied exactly from what the failed steps printed (their file in ../context/failed-steps/ or the same part of the job log), without timestamps; never command echoes or invented lines'};
  return [
    ...(writes.includes('actions_rerun')?[fn('rerun_failed_run','Ask for the original run to be rerun once because these failed jobs fail for a reason outside the repository on this commit (a service outage or rate limit, the network, the runner, the disk). Recorded now; after you finish the control plane checks the cited lines and its single rerun budget, and reruns only when every failed job is external',
      {job_ids:{type:'array',items:{type:'integer'}},reason:{type:'string',description:'Supported explanation of why rerunning this commit is likely to pass; reporting is a separate explicit decision'},evidence},['job_ids','reason','evidence'])]:[]),
    ...(writes.includes('issue')?[fn('report_failure','Explicitly request one useful public report after investigating a cause. Associate the upstream and downstream failed jobs with this cause; independent causes get separate reports. Repeating a cause replaces its report. An unknown investigation is allowed when worth reporting: explain what was checked, the remaining gaps and why it is actionable. No report is required just because a job failed. The control plane checks references and publishes after finish_analysis; it does not confirm your causal conclusions or approve development',
      {cause:{type:'string',description:'Stable, specific cause identity shared across attempts/recurrences. Describe the underlying problem, not a job id, timestamp, run id or generic exit/assertion symptom. Different independent causes must have different identities'},
        job_ids:{type:'array',items:{type:'integer'},description:'Affected failed jobs from run.json. Put the upstream job first, then its downstream checks; explain the causal associations in diagnosis'},
        kind:{type:'string',enum:['external','code','unknown']},title:{type:'string',description:'Specific English Issue title'},
        diagnosis:{type:'string',description:'Complete readable English Markdown investigation: expected vs observed, causal chain and job associations, source/artifact references, what was checked, confidence and uncertainty, and concrete correction or next verification. Distinguish observations, hypotheses, actual reproduction and suggested tests. Preserve paragraphs and relevant detail. For a supported code change include ## Current behavior, ## Expected behavior and ## Requested code change with concrete content; never use boilerplate or invent a defect'},
        report_reason:{type:'string',description:'Why filing this report is useful after the investigation; unknown is an investigation request, not a confirmed code defect'},
        evidence:{type:'array',description:'References to the failed attempt. Log/source lines are matched exactly. Artifact metadata is checked against this run and commit, but its contents and attempt association are not independently verified; describe what you actually inspected and its limits in diagnosis',items:{type:'object',properties:{type:{type:'string',enum:['log','source','artifact']},job_id:{type:'integer'},lines:{type:'array',items:string,description:'Exact lines from the failed steps for log, or the failed commit for source'},path:{type:'string',description:'Repository-relative source path'},artifact_id:{type:'integer'}},required:['type'],additionalProperties:false}}},
      ['cause','job_ids','kind','title','diagnosis','report_reason','evidence'])]:[]),
    fn('finish_analysis','Finish with the full investigation, covering every failed job and its causal association or unresolved gap, decisions to report or leave unreported, what was checked, uncertainty and next steps. Unreported jobs and unavailable logs never create an automatic Issue. Reports explicitly recorded through report_failure retain their own full diagnosis',{summary:string},['summary'])];
}
