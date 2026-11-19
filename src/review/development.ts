import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import { randomId } from '../core/security.js';
import { assertOwnedPR } from '../github/publisher.js';
import { assigneesOf, developmentReady, revisionFacts, sameLabel } from './queue.js';
import { actionsDevelopmentAllowed } from '../actions/safety.js';
import { stop } from '../agent/common.js';
import { developmentLabel } from '../rules/service.js';
import { eventFilters } from '../dispatch/settings.js';
import { recordEvent } from '../dispatch/store.js';
import { covers, projectCeiling } from '../projects/ceiling.js';
import type { ClaimFacts } from './claims.js';

// Use the caller's lookups so development follows the same ownership and label checks as task execution.
export interface DevelopmentContext {
  readonly store:Store;
  owned(github:GitHub,task:Row,pr:any):Row;
  label(task:Row):string;
}

export function ownedPullRequest(store:Store,github:GitHub,task:Row,pr:any):Row{
  const row=store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,task.object_number);
  assertOwnedPR(row,pr,github.actorId,task.repository_id);
  return row!;
}
// The development label is a project setting (#935), always a valid name.
export function developmentLabelForTask(store:Store,task:Row){return developmentLabel(store,task.repository_id);}
// The go-ahead for development: the label is on the Issue and the latest time it was added was by a user account, not
// an app. Null without it. Who is assigned is a fact for the Manager, not a condition.
export async function developmentApproved(context:DevelopmentContext,github:GitHub,task:Row):Promise<GoAhead|null>{
  const label=context.label(task),issue=await github.object('review.issue',task.object_number);
  if(!developmentReady(issue,label))return null;
  const events=await github.pages(github.path(`/issues/${task.object_number}/events`));
  const added=events.filter((e:any)=>e.event==='labeled'&&sameLabel(e.label?.name,label)).at(-1);
  return added?.actor?.type==='User'?{label,labeled_by:String(added.actor.login||''),assignees:assigneesOf(issue)}:null;
}
/**
 * A published review is an event for the Manager when it may lead to development: every Issue review at the develop ceiling
 * (#1104; before, only one with a person's label on the Issue or the ready_for_development conclusion), or a review of the
 * bot's own pull request (one a person or the Manager asked for) that found actionable problems. The control plane keeps only
 * the project's switches (the capability ceiling at develop, Actions failure handling for its reports) and one development
 * at a time; the Manager decides whether to start it, reading what the review found and who is assigned, and states its basis
 * (without a label, a rule of its prompt). Requests people make on the bot's pull request reach the Manager directly as
 * revisions (#1104), not through a review.
 */
export function queueDevelopment(context:DevelopmentContext,github:GitHub,task:Row,input:any,result:any,approved:DevelopmentOffer|null=null){
  const policy=context.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
  if(!policy?.enabled||!covers(projectCeiling(context.store,task.repository_id,policy),'develop'))return;
  const filters=eventFilters(context.store,task.repository_id,policy),number=task.object_number;
  const facts={review_task:task.id,object:{number,title:String(input.object?.title||'').slice(0,300),url:input.object?.html_url??null},
    review:{summary:String(result.summary||'').slice(0,1500),...(result.recommendation?{recommendation:String(result.recommendation).slice(0,1500)}:{}),...(result.conclusion?{conclusion:result.conclusion}:{}),
      actionable_findings:(result.findings||[]).filter(actionableFinding).length}};
  // A review publishes once, in the transaction that ends it, so each call is one publication of its own.
  const published=randomId().slice(0,16);
  const event=(type:'issue'|'pr',title:string,option:any)=>recordEvent(context.store,{repositoryId:task.repository_id,key:`${task.repository_id}:review.published:${task.id}:${published}`,type:'review.published',source:'review',
    summary:title,facts,object:{type,number},delivery:task.source_delivery_id,options:[option]});
  const isIssueReview = task.kind === 'review.issue' || (task.kind === 'task.request' && input?.target?.type === 'issue');
  if(isIssueReview){
    if(!approved||!filters['review.published.issue'])return;
    if(!actionsDevelopmentAllowed(context.store,task.repository_id,number))return;
    const owned=context.store.get(`SELECT 1 FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
      WHERE p.repository_id=? AND (t.kind='development.issue' OR (t.kind='task.request' AND json_extract(t.input,'$.target.type')='issue')) AND t.object_number=? LIMIT 1`,task.repository_id,number);
    const earlier=context.store.get("SELECT 1 FROM tasks t WHERE t.repository_id=? AND (t.kind='development.issue' OR (t.kind='task.request' AND EXISTS (SELECT 1 FROM task_write_grants g WHERE g.task_id=t.id AND json_valid(g.writes) AND EXISTS (SELECT 1 FROM json_each(g.writes) WHERE value='pull_request')))) AND t.object_number=? AND t.unique_key IS NOT NULL LIMIT 1",task.repository_id,number);
    Object.assign(facts,{development:{...approved,bot_pull_request:owned?true:false}});
    const concluded:Record<string,string>={ready_for_development:'可开发',needs_information:'缺信息',human_decision_required:'需要人决定',no_code_change:'不需要改代码'};
    event('issue',approved.label?`Issue 检视已发布，开发标签已加：#${number}`:`Issue 检视已发布${concluded[result.conclusion]?`，结论为${concluded[result.conclusion]}`:''}：#${number}`,{id:'development',work:'development.issue',title:`开发 Issue #${number}`,
      default:!!approved.label&&!approved.assignees.length&&!earlier,
      spec:{type:'object',kind:'development.issue',number,head:null,input:{review:result,object_hash:input.object_hash},delivery:task.source_delivery_id,source_task:task.id,update_id:task.id}});
  }else{
    if(!filters['review.published.pr'])return;
    let owned:Row;try{owned=context.owned(github,task,input.object);}catch{return;}
    const source=context.store.get('SELECT * FROM tasks WHERE id=?',owned.source_task_id);
    if(source&&(source.kind==='development.issue'||(source.kind==='task.request'&&JSON.parse(source.input||'{}')?.target?.type==='issue'))&&!actionsDevelopmentAllowed(context.store,task.repository_id,source.object_number))return;
    const findings=(result.findings||[]).filter(actionableFinding);
    if(!findings.length)return;
    const goal=source?developmentGoal(JSON.parse(source.input)):'';
    // The comments that started this review (or joined it) asked for what it found: a revision of them is counted for their
    // authors like a direct one, and the Manager sees how often the pull request was already revised (#1104).
    const asked=[input.trigger,...(input.merged_updates||[])].filter((t:any)=>t?.source&&t.reason!=='pushed'&&/^[1-9]\d*$/.test(String(t.source.id)))
      .map((t:any)=>({type:String(t.source.type),id:String(t.source.id),author:String(t.actor||''),author_id:String(t.actor_id||''),author_type:t.actor_type==='Bot'?'Bot':'User',url:String(t.url||''),body:''}));
    Object.assign(facts,{bot_pull_request:true,revisions:revisionFacts(context.store,task.repository_id,number,asked[0]?.author_id)});
    event('pr',`bot PR 检视已发布，发现可执行问题：#${number}`,{id:'development',work:'development.pr',title:`跟进 bot PR #${number}`,default:true,
      spec:{type:'object',kind:'development.pr',number,head:task.head_sha,input:{review:{...result,implementation_goal:goal,findings},revision:{source:'review',...(asked.length?{asked_by:asked}:{})}},
        delivery:task.source_delivery_id,source_task:task.id,...(asked.length?{requests:asked}:{})}});
  }
}

/** A person's go-ahead for developing an Issue, as the Manager reads it. */
export interface GoAhead { label:string; labeled_by:string; assignees:string[] }
/**
 * What an Issue review offers development on: a person's go-ahead, or without one an Issue review that concluded
 * ready_for_development (#1026), where label and labeled_by are null and the Manager needs another basis. A published review
 * adds the claim facts read at publication (#1047).
 */
export type DevelopmentOffer = (GoAhead | { label:null; labeled_by:null; assignees:string[] }) & { claims?:ClaimFacts };
// The goal of a development: the Manager's brief for an Issue (#815); a revision of a bot pull request carries the goal of the
// development that opened it (input.review.implementation_goal is set by the control plane, never by a review since #815).
/**
 * A development that stopped because its go-ahead no longer holds (the development label was removed, or an Issue filed from
 * an Actions failure got an assignee) goes back to the Manager (#815), instead of waiting for someone to press retry: it can
 * answer the person on the Issue (a review that replies, or a comment with github_write) or ignore it. When a person adds
 * the label again, the labeling offers the waiting development under work.continue, and continuing it resumes the task.
 */
export function developmentStopped(store:Store,task:Row,detail:string){
  const policy=store.get('SELECT enabled FROM policies WHERE repository_id=?',task.repository_id);if(!policy?.enabled)return;
  const number=Number(task.object_number),input=JSON.parse(task.input||'{}'),stopped=randomId().slice(0,16);
  const trigger={reason:'development_stopped',task_id:String(task.id),code:'development_not_approved',detail:detail.slice(0,600)};
  recordEvent(store,{repositoryId:task.repository_id,key:`${task.repository_id}:development.stopped:${task.id}:${stopped}`,type:'development.stopped',source:'control_plane',
    summary:`开发停下：Issue #${number} 不再满足开发条件`,object:{type:'issue',number},delivery:task.source_delivery_id??null,
    facts:{development:{task_id:String(task.id),status:'waiting_permission',detail:detail.slice(0,600),label:developmentLabel(store,task.repository_id)},
      object:{number,title:String(input.object?.title||'').slice(0,300),url:input.object?.html_url??null}},
    options:[{id:'review',work:'review.issue',title:`检视 Issue #${number}（回应开发停下）`,
      spec:{type:'object',kind:'review.issue',number,head:null,input:{trigger},delivery:task.source_delivery_id??null,update_id:`stopped-${stopped}`}}],
    merge:{key:`${task.repository_id}:development.stopped:${task.id}:${stopped}`,data:trigger,trigger,head:null,kinds:['review.issue']}});
}
/**
 * Requests that reached a revision after it prepared (a comment continued into it, #1104) are not in what it carried out. When it
 * ends, they go back to the Manager as an update of the pull request offering another revision, so none is silently dropped.
 */
export function carryRevisionRequests(store:Store,task:Row,covered:any[],head:string|null){
  if((task.kind!=='development.pr'&&task.kind!=='task.request')||!/^[a-f0-9]{40}$/.test(String(head||'')))return;
  const key=(r:any)=>`${r.type}:${r.id}`,done=new Set(covered.map(key));
  const stored=JSON.parse(store.get('SELECT input FROM tasks WHERE id=?',task.id)?.input||'{}');
  const open=((stored.revision?.requests||[]) as any[]).filter(r=>!done.has(key(r)));
  if(!open.length)return;
  const number=Number(task.object_number);
  recordEvent(store,{repositoryId:task.repository_id,key:`${task.repository_id}:revision.carried:${task.id}`,type:'pull_request.updated',source:'control_plane',
    summary:`bot PR #${number} 修订进行中收到的意见`,object:{type:'pr',number},delivery:task.source_delivery_id??null,
    facts:{bot_pull_request:true,carried_from:String(task.id),requests:open,revisions:revisionFacts(store,task.repository_id,number,open[0]?.author_id),
      reason:'These comments arrived while the previous revision was already working; it did not carry them out.'},
    options:[{id:'development',work:'development.pr',title:`修订 bot PR #${number}`,default:false,
      spec:{type:'object',kind:'development.pr',number,head,input:{revision:{source:'request',requests:open}},delivery:null,requests:open}}]});
}
export const developmentGoal=(input:any)=>String(input?.review?.implementation_goal||input?.manager?.brief?.goal||'');
export const actionableFinding=(finding:any)=>finding.actionable===true&&finding.within_goal===true&&finding.requires_human_decision===false;
