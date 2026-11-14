import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import { HttpError, randomId } from '../core/security.js';
import { assertOwnedPR } from '../github/publisher.js';
import type { DevelopmentWait } from '../github/text.js';
import { assigneesOf, developmentReady, reviewRequestsCode, sameLabel } from './queue.js';
import { actionsDevelopmentAllowed, actionsReport } from '../actions/safety.js';
import { stop } from '../agent/common.js';
import { developmentLabel, ruleErrors } from '../rules/service.js';
import { workActive, eventFilters } from '../work/settings.js';
import { recordEvent } from '../dispatch/store.js';

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
export function developmentLabelForTask(store:Store,task:Row){try{return developmentLabel(store,task.repository_id);}catch(error){const detail=(error as {detail?:string}).detail;
  return stop(error instanceof HttpError&&ruleErrors.has(error.code)?error.code:'invalid_bot_label','waiting_configuration',`仓库 ${task.repository_id} 的开发标签配置无效${detail?'：'+detail:''}，请检查行为规则。`);}}
// The go-ahead for development: the label is on the Issue and the latest time it was added was by a user account, not
// an app. Null without it. Who is assigned is a fact for the Manager, not a condition.
export async function developmentApproved(context:DevelopmentContext,github:GitHub,task:Row):Promise<GoAhead|null>{
  const label=context.label(task),issue=await github.object(task.kind,task.object_number);
  if(!developmentReady(issue,label))return null;
  const events=await github.pages(github.path(`/issues/${task.object_number}/events`));
  const added=events.filter((e:any)=>e.event==='labeled'&&sameLabel(e.label?.name,label)).at(-1);
  return added?.actor?.type==='User'?{label,labeled_by:String(added.actor.login||''),assignees:assigneesOf(issue)}:null;
}
// The requests of people and other review bots that this review of the bot's own pull request took on. A request has to be
// one of the comments the review answered (discussion_requests): the signed webhook brought those, already limited to the
// repository's owners, members and collaborators, or to other bots. GitHub's API answers author_association from the
// installation's view, which may not see private organization membership, so it is not asked again; it only gives the text.
// Whether a comment asks for a change at all, or whether another bot's review is right, is the review agent's judgement.
export async function revisionRequests(github:GitHub,task:Row,result:any,input:any={}):Promise<RevisionRequest[]>{
  if(task.kind!=='review.pr')return [];
  const offered=new Map<string,any>((input.context?.discussion_requests||[]).map((r:any)=>[`${r.type}:${r.id}`,r]));
  // A review a person's comment started that found changes to make but named no request: those changes answer that comment.
  // Another bot's comment always needs the review's own judgement, so it never stands in this way.
  const named=result.findings.some((f:any)=>f.requested_in),trigger=input.trigger;
  const answered=named||!trigger?.source||trigger.actor_type==='Bot'||input.merged_updates?.length?[]
    :result.findings.filter(actionableFinding).map((f:any)=>[f,trigger.source]);
  const requests=new Map<string,RevisionRequest>();
  for(const [finding,asked] of [...result.findings.filter((f:any)=>actionableFinding(f)&&f.requested_in).map((f:any)=>[f,f.requested_in]),...answered]){
    const key=`${asked.type}:${asked.id}`,offer=offered.get(key);
    if(requests.has(key)){requests.get(key)!.findings.push(finding);continue;}
    if(!offer||!offer.author_id||String(offer.author_id)===github.actorId)continue;
    const path=offer.type==='comment'?`/issues/comments/${offer.id}`:offer.type==='review_comment'?`/pulls/comments/${offer.id}`:`/pulls/${task.object_number}/reviews/${offer.id}`;
    const text=await github.request('GET',github.path(path)).then((c:any)=>String(c?.body||''),()=>'');
    requests.set(key,{type:offer.type,id:String(offer.id),author:String(offer.author||''),author_id:String(offer.author_id),author_type:offer.author_type==='Bot'?'Bot':'User',
      url:String(offer.url||''),body:text.slice(0,4000),findings:[finding]});
  }
  return [...requests.values()];
}
// Why development of an Issue this review found ready will not start yet: no development label, or the label added by
// an app. Null when the go-ahead is there, or when it is not this review's to start (development or its events off, no
// explicit code request, an Actions report not cleared for development).
export async function developmentWait(context:DevelopmentContext,github:GitHub,task:Row,input:any,result:any):Promise<DevelopmentWait|null>{
  if(task.kind!=='review.issue'||!workActive(context.store,task.repository_id,'development.issue'))return null;
  const filters=eventFilters(context.store,task.repository_id);
  if(!filters['review.published.issue']&&!filters['issue.development_label'])return null;
  if(!reviewRequestsCode(input.object,result)||!actionsDevelopmentAllowed(context.store,task.repository_id,task.object_number,input.object,result))return null;
  const label=context.label(task),issue=await github.object(task.kind,task.object_number);
  if(!developmentReady(issue,label))return {reason:'label',label};
  const events=await github.pages(github.path(`/issues/${task.object_number}/events`));
  return events.filter((e:any)=>e.event==='labeled'&&sameLabel(e.label?.name,label)).at(-1)?.actor?.type==='User'?null:{reason:'app',label};
}
/**
 * A published review is an event for the Manager when it may lead to development: an Issue review published while a
 * person's development label is on the Issue, or a review of the bot's own pull request that took on change requests or
 * found actionable problems. The control plane's conditions (development switch, a person's label, Actions clearance,
 * budgets, one revision at a time) decide whether development is offered at all; the Manager decides whether to start it,
 * reading what the review found and who is assigned.
 */
export function queueDevelopment(context:DevelopmentContext,github:GitHub,task:Row,input:any,result:any,approved:GoAhead|null=null,requests:RevisionRequest[]=[]){
  const policy=context.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
  if(!policy?.enabled||!policy.development_enabled||task.kind!=='review.issue'&&result.clarification_required)return;
  const filters=eventFilters(context.store,task.repository_id,policy),number=task.object_number;
  const facts={review_task:task.id,object:{number,title:String(input.object?.title||'').slice(0,300),url:input.object?.html_url??null},
    review:{summary:String(result.summary||'').slice(0,1500),requires_code_change:!!result.requires_code_change,implementation_goal:String(result.implementation_goal||'').slice(0,1500),
      actionable_findings:(result.findings||[]).filter(actionableFinding).length}};
  // A review publishes once, in the transaction that ends it, so each call is one publication of its own.
  const published=randomId().slice(0,16);
  const event=(type:'issue'|'pr',title:string,option:any)=>recordEvent(context.store,{repositoryId:task.repository_id,key:`${task.repository_id}:review.published:${task.id}:${published}`,type:'review.published',source:'review',
    summary:title,facts,object:{type,number},delivery:task.source_delivery_id,options:[option]});
  if(task.kind==='review.issue'){
    // With a person's go-ahead on the Issue, every published review offers development; whether this review supports
    // developing now (a request in the Issue, nothing left to decide, nobody else on it) is the Manager's judgement.
    if(!approved||!filters['review.published.issue'])return;
    const requested=reviewRequestsCode(input.object,result);
    if(!actionsDevelopmentAllowed(context.store,task.repository_id,number,input.object,result))return;
    if(actionsReport(context.store,task.repository_id,number)&&(approved.assignees.length||!requested||!result.requires_code_change))return;
    // Development that continues the bot's PR for this Issue revises that PR, so it counts against the same budget.
    const owned=context.store.get(`SELECT p.revisions FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
      WHERE p.repository_id=? AND t.kind='development.issue' AND t.object_number=? ORDER BY t.created_at LIMIT 1`,task.repository_id,number);
    if(owned&&owned.revisions>=policy.max_revisions)return;
    // What the control plane did before #207 (for the rule decider in tests): the first development of an unassigned
    // Issue whose review found the change requested.
    const earlier=context.store.get("SELECT 1 FROM tasks WHERE repository_id=? AND kind='development.issue' AND object_number=? AND unique_key IS NOT NULL LIMIT 1",task.repository_id,number);
    Object.assign(facts,{development:{...approved,bot_pull_request:owned?true:false},
      review:{...facts.review,issue_requests_code:!!result.issue_requests_code,clarification_required:!!result.clarification_required,
        request_quote:String(result.request_quote||'').slice(0,500),quote_in_issue:requested}});
    event('issue',`Issue 检视已发布，开发标签已加：#${number}`,{id:'development',work:'development.issue',title:`开发 Issue #${number}`,
      default:requested&&!!result.requires_code_change&&!result.clarification_required&&!approved.assignees.length&&!earlier,
      spec:{type:'object',kind:'development.issue',number,head:null,input:{review:result,object_hash:input.object_hash},delivery:task.source_delivery_id,source_task:task.id,update_id:task.id}});
  }else{
    if(!filters['review.published.pr'])return;
    let owned:Row;try{owned=context.owned(github,task,input.object);}catch{return;}
    const source=context.store.get('SELECT * FROM tasks WHERE id=?',owned.source_task_id);
    if(source&&source.kind==='development.issue'&&!actionsDevelopmentAllowed(context.store,task.repository_id,source.object_number))return;
    const goal=source?developmentGoal(JSON.parse(source.input)):'';
    if(!goal)return;
    // A person's request is acted on whenever it comes, with no budget; each comment only once. Another bot's review is
    // acted on once per bot and pull request, so two bots cannot keep each other busy.
    const done=(r:RevisionRequest)=>!!context.store.get("SELECT 1 FROM bot_pr_requests WHERE repository_id=? AND number=? AND source_type=? AND source_id=? AND state='done'",task.repository_id,number,r.type,r.id);
    const botDone=(r:RevisionRequest)=>!!context.store.get("SELECT 1 FROM bot_pr_requests WHERE repository_id=? AND number=? AND author_id=? AND author_type='Bot' AND state='done'",task.repository_id,number,r.author_id);
    const accepted=requests.filter(r=>!done(r)&&(r.author_type!=='Bot'||!botDone(r)));
    // The bot's own findings revise the pull request after a review of a new head, within the revision budget; a review that
    // revises for a request anyway takes them along. A mention or a discussion alone never starts a revision of them.
    const taken=new Set(requests.flatMap(r=>r.findings));
    const own=result.findings.filter((f:any)=>actionableFinding(f)&&!f.requested_in&&!taken.has(f));
    const ownAllowed=accepted.length>0||!input.comment&&!input.trigger&&!!result.requires_code_change&&owned.revisions<policy.max_revisions;
    const findings=[...new Set(accepted.flatMap(r=>r.findings)),...(ownAllowed?own:[])];
    if(!findings.length)return;
    const plain=accepted.map(({findings,...request})=>request);
    // The requests stay pending until a revision that carries them is queued; later reviews of this pull request list
    // pending requests again (discussion_requests), also when the Manager decides not to revise now.
    const now=new Date().toISOString();
    for(const r of plain)context.store.run(`INSERT INTO bot_pr_requests VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,number,source_type,source_id)
      DO UPDATE SET state=CASE WHEN bot_pr_requests.state='done' THEN 'done' ELSE excluded.state END`,task.repository_id,number,r.type,r.id,r.author,r.author_id,r.author_type,r.url,'pending',null,now);
    const revision=accepted.length?{source:'request',requests:plain}:{source:'review'};
    event('pr',`bot PR 检视已发布，${accepted.length?`采纳了 ${accepted.length} 条修改要求`:'发现可执行问题'}：#${number}`,{id:'development',work:'development.pr',title:`跟进 bot PR #${number}`,default:true,
      spec:{type:'object',kind:'development.pr',number,head:task.head_sha,input:{review:{...result,implementation_goal:goal,findings},revision},delivery:task.source_delivery_id,source_task:task.id,requests:plain}});
  }
}

/** A person's go-ahead for developing an Issue, as the Manager reads it. */
export interface GoAhead { label:string; labeled_by:string; assignees:string[] }
// The goal of an Issue development: the reviewed implementation goal, else the goal of the Manager's brief.
export const developmentGoal=(input:any)=>String(input?.review?.implementation_goal||input?.manager?.brief?.goal||'');
export const actionableFinding=(finding:any)=>finding.actionable===true&&finding.within_goal===true&&finding.requires_human_decision===false;
/**
 * What a review of a bot pull request answers: the comments, reviews and inline comments that triggered it or joined it while it
 * waited (each with its author, already limited to members and other bots when it was queued), and requests an earlier review
 * took on while another revision was running.
 */
export function discussionRequests(store:Store,task:Row,input:any){
  const list=new Map<string,any>();
  for(const t of [input.trigger,...(input.merged_updates||[])])if(t?.source)list.set(`${t.source.type}:${t.source.id}`,
    {type:t.source.type,id:t.source.id,author:t.actor||'',author_id:t.actor_id||'',author_type:t.actor_type==='Bot'?'Bot':'User',url:t.url||null});
  for(const r of store.all("SELECT * FROM bot_pr_requests WHERE repository_id=? AND number=? AND state='pending'",task.repository_id,task.object_number))
    if(!list.has(`${r.source_type}:${r.source_id}`))list.set(`${r.source_type}:${r.source_id}`,{type:r.source_type,id:Number(r.source_id),author:r.author,author_id:r.author_id,author_type:r.author_type,url:r.url||null,pending:true});
  return [...list.values()];
}
/** A comment, review or inline comment on a bot pull request that a review took on as a change to make. */
export interface RevisionRequest { type:'comment'|'review'|'review_comment', id:string, author:string, author_id:string, author_type:'User'|'Bot', url:string, body:string, findings:any[] }
