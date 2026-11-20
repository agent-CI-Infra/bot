import { readToolResult } from './tool-results.js';
import { modelCapabilities, modelProtocol, type ModelInterfaceType } from '../models/catalog.js';
import { commandTool } from './command.js';
import { type Store } from '../storage/database.js';
import { stop } from './common.js';
import { loopbackHostname } from '../core/security.js';
import { pricingFor } from '../metrics/accounting.js';
import { githubWriteTool } from '../github/write.js';
import { pullRequestLabelsSchema } from '../github/pull-request-labels.js';
import { pullRequestMediaSchema } from '../github/pull-request-media.js';
import { reviewConclusions } from '../review/findings.js';
// Model resolution uses the project default model; role-specific overrides live on RoleDefinitionV2.model_profile_ref (#1122).
export function selectedModel(store: Store, repositoryId: string, roleId?: string) {
  let roleModelId: string | undefined;
  if (roleId) {
    try {
      const saved = store.get('SELECT value FROM settings WHERE key=?', 'roles:' + repositoryId);
      const roles = saved ? JSON.parse(String(saved.value))?.roles : null;
      const found = Array.isArray(roles) ? roles.find((r: any) => r?.role_id === roleId) : null;
      if (typeof found?.model_profile_ref?.model_id === 'string') roleModelId = found.model_profile_ref.model_id;
    } catch { /* ignore */ }
  }
  const policy = store.get('SELECT model_id FROM policies WHERE repository_id=?', repositoryId);
  const modelId = roleModelId ?? policy?.model_id;
  const row = modelId ? visibleModel(store, repositoryId, modelId) : undefined;
  if (!row?.api_key) return stop('model_not_configured','waiting_configuration',`仓库 ${repositoryId} 未配置可用默认模型或模型凭据；不会自动切换到其他模型。`);
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
        labels:pullRequestLabelsSchema,media:pullRequestMediaSchema},['summary','test_command','change_title']));
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
    findings:{type:'array',items:{type:'object',properties:{body:string,format:{type:'string',enum:['discussion','inline']},selection_reason:string,actionable:{type:'boolean'},within_goal:{type:'boolean'},requires_human_decision:{type:'boolean'},human_action:{type:'string',description:'When requires_human_decision is true: one sentence on what a person must decide or do'},comment_id:{type:'integer',description:'When this finding is one of this bot\'s earlier top-level inline comments that still applies: its id from review_comments.json. It is not posted again; the summary links to it'},path:string,line:{type:'integer'},side:{type:'string',enum:['LEFT','RIGHT']},start_line:{type:'integer'},start_side:{type:'string',enum:['LEFT','RIGHT']}},required:['body','format','selection_reason','actionable','within_goal','requires_human_decision'],additionalProperties:false}}
  },['summary','findings',...(writes.includes('labels')?['labels']:[])]));
  return result;
}
// The finishing tool for each event adapter.
export function eventTools(kind:string){
  if(kind==='release.observe')return [fn('finish_observation','Finish with your analysis of the release run. The control plane shows it beside the authoritative status, which it reads itself',
    {job_ids:{type:'array',items:{type:'integer'},description:'Ids of the failed jobs of this run that your analysis is about'},advice:{type:'string',description:'Your analysis and suggested next steps'}},['job_ids','advice'])];
  if(kind==='release.notes')return [fn('finish_release_notes','Finish with the release notes: every source id of ../context/sources.json exactly once, grouped under allowed headings. The control plane checks the groups and writes every title and link itself',
    {groups:{type:'array',items:{type:'object',properties:{heading:string,source_ids:{type:'array',items:string}},required:['heading','source_ids'],additionalProperties:false}}},['groups'])];
  return [fn('finish_analysis','Finish the internal investigation with what was checked, the likely cause, any uncertainty and next steps',{summary:string},['summary'])];
}
