import { interruptRuns, traceEvent, beginRun, endRun } from '../tasks/trace.js';
import { observation } from '../tasks/evidence.js';
import { playbooks } from '../tasks/playbooks.js';
import { restoreCheckpoint } from '../tasks/checkpoint.js';
import { runRequest } from '../tasks/request.js';
import { TaskRecords } from '../tasks/service.js';
import { evaluateDelivery } from '../tasks/acceptance.js';
import { type Store, type Row } from '../storage/database.js';
import { type Manager } from '../projects/service.js';
import { randomId, fields, fail, HttpError, type Json } from '../core/security.js';
import { type Actor, scope, repository } from '../app/auth.js';
import { GitHub } from '../github/client.js';
import { Publisher, assertOwnedPR } from '../github/publisher.js';
import { releaseCategory } from '../github/release-label.js';
import { testEvidence, reviewLanguage, promptedBy, type DevelopmentWait } from '../github/text.js';
import { enqueue, developmentReady, reviewRequestsCode, sameLabel } from '../review/queue.js';
import { actionsDevelopmentAllowed, actionsSourceIssue, publicText } from '../actions/safety.js';
import { classificationLabels, repositoryLabels } from '../review/labels.js';
import { agentLoop, type PlatformTools } from './loop.js';
import { ReadTokens } from './read-token.js';
import { Workspace } from './workspace.js';
import { selectedModel } from './model.js';
import { isAttemptFailure } from './failures.js';
import { clip, Redactor, sha, operationId, stop, TaskError } from './common.js';
import { RuleService, resolveRules, behaviorPath, developmentLabel, ruleErrors, skillIndex, computerRequest } from '../rules/service.js';
import { repositoryConcurrency } from '../app/settings.js';
import { ReviewUpdated, latestReviewSession, saveReviewSession, pendingReviewUpdates, pruneReviewSessions, reviewObjectState } from '../review/sessions.js';
import { type GitCache } from './git-cache.js';
import { taskWorkflow, workflowPermissions, workflowEnabled, activeTrigger } from '../workflows/resolve.js';
import { eventWorkflow } from '../workflows/events.js';
// The modules that own event workflows register them when loaded.
import '../releases/observe.js';
import '../releases/notes.js';
import '../actions/analysis.js';

const terminal=['succeeded','pr_opened','completed','cancelled','superseded'];
const automaticRetry=new Set(['retry_wait','waiting_configuration','waiting_environment','waiting_pr_head']);
const retryCycleMs=8*60*60*1000;
// Reviews and custom workflows reply on the object; development publishes a branch and PR.
const replies=(kind:string)=>kind.startsWith('review.')||kind.startsWith('workflow.');
const engineKinds="(kind LIKE 'review.%' OR kind LIKE 'development.%' OR kind LIKE 'workflow.%' OR kind IN ('release.observe','release.notes','actions.failures','gate.onboarding','task.request'))";
const computerSummary=(c:any)=>c?{cpus:c.cpus,memory_mb:c.memory_mb,network:c.network_policy,toolchain:c.build?.toolchain||null,
  extra_packages:c.packages||[],environment_variables:Object.keys(c.env||{}),setup:c.setup?{state:c.setup.state,exit_code:c.setup.exit_code}:null}:null;
// A repository's tasks share its one project computer: up to its concurrency (project value, else the global default) run
// at once, each in its own workspace and under its own claim; the rest stay queued.
export class TaskEngine {
  // Running work by task id, and the task ids running on each repository's computer.
  readonly active=new Map<string,Promise<void>>();private readonly running=new Map<string,Set<string>>();
  // Repositories whose last running task is clearing the computer; nothing starts there until it is done.
  private readonly clearing=new Set<string>();
  // Running tasks that have reached their release: they need the computer no longer, so they never keep another task's
  // release from being the last one. They leave this set when they leave `running`.
  private readonly finishing=new Set<string>();
  // The parallel runner calls last granted by the manager, per repository.
  private readonly granted=new Map<string,number>();
  private timer:ReturnType<typeof setInterval>|undefined;private closing=false;
  readonly rules:RuleService;
  constructor(readonly store:Store,readonly manager:Manager,readonly githubUrl?:string,readonly gitCache?:GitCache,readonly evaluate=evaluateDelivery){this.rules=new RuleService(store,manager,githubUrl);}
  // The running tasks of one repository, for callers that must wait until they have stopped.
  working(repositoryId:string):Promise<void>[]{return [...this.running.get(repositoryId)||[]].map(id=>this.active.get(id)).filter((work):work is Promise<void>=>!!work);}
  start(){
    // A previous process may have stopped between checkpoints; never charge server downtime as task runtime.
    this.store.run('UPDATE task_metrics SET active_since=NULL,complete=0 WHERE active_since IS NOT NULL');
    this.store.run('DELETE FROM task_claims');interruptRuns(this.store);
    this.store.run(`UPDATE tasks SET status='queued',claim_token=NULL WHERE ${engineKinds} AND status IN ('running','preparing','implementing','validating','publishing','result_ready')`);
    this.store.run("UPDATE tasks SET status='waiting_pr_head',error_code='pr_head_pending',next_run_at=0 WHERE status='waiting_permission' AND error_code='bot_pr_ownership_changed' AND phase='publish' AND kind='development.pr'");
    this.timer=setInterval(()=>this.tick(),1000);this.tick();
  }
  tick(){
    if(this.closing)return;
    const checkpoint=Date.now();pruneReviewSessions(this.store,checkpoint);
    this.store.run('UPDATE task_metrics SET runtime_ms=runtime_ms+max(0,?-active_since),active_since=? WHERE active_since IS NOT NULL',checkpoint,checkpoint);
    const tasks=this.store.all(`SELECT * FROM tasks WHERE ${engineKinds} AND
      status IN ('queued','retry_wait','waiting_configuration','waiting_environment','waiting_pr_head') AND next_run_at<=? ORDER BY created_at,id`,Date.now());
    const limits=new Map<string,number>();
    for(const task of tasks){
      const dependency=JSON.parse(task.input||'{}').wait_for_review;
      if(dependency&&![...terminal,'failed','needs_replan'].includes(this.store.get('SELECT status FROM tasks WHERE id=?',dependency)?.status))continue;
      const repo=String(task.repository_id);
      if(this.active.has(task.id)||this.clearing.has(repo))continue;
      // A computer being rebuilt with new default resources takes new tasks once that is done (see ProjectService.reconcileProject).
      if(!limits.has(repo))limits.set(repo,this.store.get("SELECT 1 FROM environment_operations WHERE repository_id=? AND action='refresh' AND state='pending'",repo)?0:repositoryConcurrency(this.store,repo));
      const running=this.running.get(repo)||new Set<string>();
      if(running.size>=limits.get(repo)!)continue;
      const token=randomId(),now=new Date().toISOString();
      this.store.transaction(()=>{
        this.store.run('INSERT INTO task_claims VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET token=excluded.token,claimed_at=excluded.claimed_at',task.id,repo,token,now);
        this.store.run("UPDATE tasks SET claim_token=?,status='running',updated_at=? WHERE id=?",token,now,task.id);
      });
      running.add(task.id);this.running.set(repo,running);
      const work=this.run(task.id,token).finally(()=>{
        this.store.run('DELETE FROM task_claims WHERE task_id=? AND token=?',task.id,token);
        this.active.delete(task.id);this.finishing.delete(task.id);running.delete(task.id);if(!running.size&&this.running.get(repo)===running)this.running.delete(repo);
      });this.active.set(task.id,work);
    }
  }
  // The manager lets as many runner calls share a computer as tasks may run on it, and never fewer than run there now,
  // so lowering the setting lets running tasks finish instead of starving them.
  private async share(repositoryId:string){
    const tasks=Math.max(repositoryConcurrency(this.store,repositoryId),this.running.get(repositoryId)?.size||1);
    if(this.granted.get(repositoryId)===tasks)return;
    await this.manager.call('PUT',`/v1/projects/${repositoryId}/parallel`,{tasks}).then(()=>this.granted.set(repositoryId,tasks),()=>{});
  }
  // A task that is not the last one on its computer ends only its own processes; the last one clears the computer and
  // holds back new work on it until that is done. Tasks finishing together each count the others as finishing, so the
  // last of them to get here still clears the computer.
  private async release(workspace:Workspace|undefined,task:Row){
    if(!workspace)return;
    const repo=String(task.repository_id),running=this.running.get(repo);
    const idle=![...running||[]].some(other=>other!==task.id&&!this.finishing.has(other));
    if(running?.has(task.id))this.finishing.add(task.id);
    if(idle)this.clearing.add(repo);
    try{await workspace.release(idle);}finally{if(idle)this.clearing.delete(repo);}
  }
  async close(){this.closing=true;if(this.timer)clearInterval(this.timer);await Promise.allSettled(this.active.values());}
  async run(id:string,token:string){
    const task=this.store.get('SELECT * FROM tasks WHERE id=?',id)!;const records=new TaskRecords(this.store);const redactor=new Redactor(),event=eventWorkflow(task.kind);
    const policyHashFor=(artifacts:any[])=>sha(artifacts.some(a=>a.kind==='code')?String(this.store.get('SELECT test_command FROM policies WHERE repository_id=?',task.repository_id)?.test_command||''):'');
    const log=(value:any)=>{
      const clean=redactor.clean(value);
      if(value.type==='tool')clean.attempt=task.attempt;
      // A waiting retry can re-enter a phase. Keep one start per attempt (or policy operation).
      if(value.type==='phase'){
        clean.phase_key=operationId(`${task.attempt}:${value.phase}:${value.operation_id||''}`);
        if(this.store.get("SELECT id FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.phase_key')=?",id,clean.phase_key))return;
      }
      let content=JSON.stringify(clean);
      // Never slice serialized JSON: that used to hide the entire reason in the console.
      if(content.length>70000)content=JSON.stringify({type:clean.type,state:clean.state,code:clean.code,step:clean.step,detail_sha:clean.detail_sha,
        phase:clean.phase,phase_key:clean.phase_key,sha:clean.sha,files:clean.files,bytes:clean.bytes,skipped:clean.skipped,directory_fallback:clean.directory_fallback,source:clean.source,cache:clean.cache,
        detail:clip(clean.detail,6000),output:clip(content,6000),truncated:true});
      if(value.type==='snapshot'&&this.store.get("SELECT content FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.type')='snapshot' ORDER BY rowid DESC LIMIT 1",id)?.content===content)return;
      this.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',randomId(),id,content,new Date().toISOString());
    };
    const guard=async()=>{
      // Only this task's own claim counts; other tasks on the same computer hold their own.
      const current=this.store.get('SELECT * FROM tasks WHERE id=?',id),claim=this.store.get('SELECT token FROM task_claims WHERE task_id=?',id);
      if(current?.claim_token!==token||claim?.token!==token||['cancelled','superseded'].includes(current.status))stop('task_claim_revoked','cancelled',`任务 ${id} 的执行权已撤销或状态已变为 ${current?.status||'不存在'}。`);
      const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
      const actionsIssue=actionsSourceIssue(this.store,task as {repository_id:string;kind:string;object_number:number});
      if(actionsIssue!==null&&(!policy?.actions_failures_enabled||task.kind.startsWith('development.')&&!actionsDevelopmentAllowed(this.store,task.repository_id,actionsIssue)))stop('actions_development_disabled','cancelled');
      if(!policy?.enabled||task.kind.startsWith('review.')&&!policy.review_enabled||task.kind.startsWith('development.')&&!policy.development_enabled)stop('repository_policy_disabled','cancelled',`仓库 ${task.repository_id} 已停用，或已关闭 ${task.kind} 类型任务。`);
      // A workflow that was switched off (or a custom one deleted) stops its tasks the same way.
      if(task.kind!=='task.request'&&!workflowEnabled(this.store,task.repository_id,taskWorkflow(task as any)))stop('workflow_disabled','cancelled',`工作流 ${taskWorkflow(task as any)} 已关闭或删除。`);
      // An event that moved on (another run attempt, a release no longer waiting) ends its task at once.
      if(event)event.validate(this.store,current!,JSON.parse(current!.input||'{}'));
      if(task.generation){const environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);if(!environment||environment.generation!==task.generation)stop('environment_generation_changed','waiting_environment',`项目电脑 generation 已变化：任务为 ${task.generation}，当前为 ${environment?.generation??'不存在'}。`);if(!['ready','busy'].includes(environment.state))stop('environment_not_ready','waiting_environment',`项目电脑尚未就绪，当前状态=${environment.state}。`);}
    };
    const update=(values:Record<string,unknown>)=>records.atomic(()=>{
      // A revoked claim may record only its own cancellation; the SQL claim_token fence still protects a new owner.
      if(!(values.status==='cancelled'&&values.error_code==='task_claim_revoked'))records.assertClaim(id,token);
      if(['succeeded','pr_opened','completed'].includes(String(values.status))) {
        const record=records.get(id);
        const accepted=record.pending||record.acceptance;
        if(record.pending?.policy_hash!==policyHashFor(record.candidate?.artifacts||[]))stop('acceptance_context_changed','retry_wait','交付前必需验证策略已变化，将重新验收。');
        if(!record.candidate||accepted?.candidate_id!==record.candidate.id||accepted?.revision!==record.revision||!['pass','pass_with_issues'].includes(accepted?.outcome))
          stop('acceptance_required','retry_wait','交付必须先通过独立验收。');
        if(record.pending)records.decide(id,record.candidate!.id,record.revision,record.pending,String(values.status),true,token);
        records.history(id,'delivery',{status:values.status,result:values.result?JSON.parse(String(values.result)):null,candidate_id:record.candidate!.id});
      }
      if(values.status&&(terminal.includes(String(values.status))||values.status==='needs_replan'))Object.assign(values,{retry_cycle_started_at:null,retry_error_code:null,retry_count:0});
      Object.assign(task,values);const keys=Object.keys(values);
      this.store.run(`UPDATE tasks SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE id=? AND claim_token=?`,...keys.map(k=>values[k] as any),new Date().toISOString(),id,token);
    });
    let workspace:Workspace|undefined;let attemptRun:Row|null=null;
    try{
      await guard();const config=selectedModel(this.store,task.repository_id,taskWorkflow(task as any));redactor.add(config.key);await this.share(task.repository_id);
      attemptRun=beginRun(this.store,task,'attempt',{phase:task.phase,kind:task.kind,model:{id:config.id,name:config.model,version:config.version},policy:this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id)});task.trace_run_id=attemptRun?.id;
      const repo=this.store.get('SELECT * FROM repositories WHERE id=?',task.repository_id)!;
      // A task waiting for its computer retries every few seconds, so it checks the computer before it asks GitHub for
      // anything: four such tasks once used up their installation's hourly GitHub quota while their computer was down.
      let environment:any=null;
      if(task.phase==='prepare'){
        environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);
        if(!environment){environment=await this.manager.call('PUT','/v1/projects/'+task.repository_id);this.granted.delete(task.repository_id);await this.share(task.repository_id);}
        if(!['ready','busy'].includes(environment.state))stop('environment_not_ready','waiting_environment',`准备工作区时项目电脑尚未就绪，当前状态=${environment.state}。`);
      }
      if(task.kind==='task.request'){await runRequest(this.store,this.manager,task,redactor,guard,log,this.githubUrl,this.gitCache);return;}
      // The writes this workflow may ask for decide the platform tools; a workflow that may open a PR needs contents write.
      const writes=workflowPermissions(this.store,task.repository_id,taskWorkflow(task as any)).writes,eventState:Record<string,any>={};
      // An event workflow reads Actions runs and logs; it writes only through its own tools.
      const github=new GitHub(this.store,repo,redactor,guard,this.githubUrl);await github.connect(task.kind.startsWith('development.')||writes.includes('pull_request'),undefined,
        event?{contents:'read',actions:'read',checks:'read',statuses:'read',issues:'write',pull_requests:'read'}:undefined);
      let input=JSON.parse(task.input),result=task.result?JSON.parse(task.result):null;
      const development=task.kind.startsWith('development.'),review=task.kind.startsWith('review.');
      // Only the built-in reviews continue an earlier conversation; a custom workflow starts fresh every time.
      const prior=review&&task.attempt===1?latestReviewSession(this.store,task):undefined;
      if(development&&input.review?.clarification_required)stop('review_requires_human_decision','needs_replan','检视结果要求先由人确认需求，开发任务等待重新规划。');
      // validate(object) checks an object just read instead of reading it again; seen is the last object it checked.
      let seen:any=null;
      const validate=async(fetched?:any)=>{
        await guard();
        if(event){event.validate(this.store,task,input);return;}
        const current=seen=fetched||await github.object(task.kind,task.object_number);
        if(review)reviewObjectState(this.store,task.repository_id,task.kind,task.object_number,current.state!=='open');
        if(current.state!=='open'||current.draft===true)stop('object_closed_or_draft','cancelled',`任务目标 #${task.object_number} 已关闭或变为草稿，state=${current.state}，draft=${current.draft===true}。`);
        if(task.kind.endsWith('.pr')){
          if(development)this.owned(github,task,current);
          const candidateRow=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),candidate=candidateRow?JSON.parse(candidateRow.data):null;
          // This task's own push (development, or any workflow that updated the bot's PR) moved the head on purpose.
          if(current.head?.sha!==task.head_sha&&!(candidate?.remote_sha===current.head?.sha)){
            // A stale comment or update review must not turn into a head-triggered review that could start a bot PR revision.
            if(task.kind==='review.pr'&&!input.comment&&!input.trigger)this.store.transaction(()=>enqueue(this.store,task.repository_id,'review.pr',task.object_number,current.head.sha,{pull_request:current,number:task.object_number}));
            stop('pull_request_head_changed','superseded',`PR #${task.object_number} 的 head 已变化：预期 ${task.head_sha}，当前 ${current.head?.sha}。`);
          }
        }else if(development&&input.object_hash&&sha(JSON.stringify([current.title,current.body]))!==input.object_hash)stop('issue_needs_replan','needs_replan',`Issue #${task.object_number} 的标题或正文已变化，需要重新规划。`);
        // The go-ahead must still hold until publication: the label stays on and nobody else has taken the Issue.
        if(task.kind==='development.issue'&&!developmentReady(current,this.label(task)))stop('development_not_approved','needs_replan',`Issue #${task.object_number} 不再满足开发条件：开发标签缺失或已有人接手。`);
        if(task.kind==='development.issue'&&!actionsDevelopmentAllowed(this.store,task.repository_id,task.object_number,current,input.review))stop('actions_development_not_approved','needs_replan');
        const actionsIssue=actionsSourceIssue(this.store,task as {repository_id:string;kind:string;object_number:number});
        if(actionsIssue!==null){
          if(!github.installationEvents?.includes('workflow_run')){
            this.store.run("UPDATE actions_failure_scans SET error='actions_workflow_run_subscription_missing',configured_at=NULL WHERE repository_id=?",task.repository_id);
            stop('actions_workflow_run_subscription_missing','waiting_configuration');
          }
          if(development&&task.kind.endsWith('.pr')){
            const issue=await github.object('development.issue',actionsIssue);
            if(issue.state!=='open'||!developmentReady(issue,this.label(task))||!actionsDevelopmentAllowed(this.store,task.repository_id,actionsIssue,issue))stop('actions_development_not_approved','needs_replan');
          }
        }
        if(development){
          const saved=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),candidate=saved?JSON.parse(saved.data):null;
          // Once the branch is on GitHub, only its PR is left to open, and a base that moved on since is normal for a PR.
          const pushed=!!this.store.get("SELECT 1 FROM github_effects WHERE id=? AND state='sent'",operationId(id+':branch'));
          if(candidate&&!candidate.pr_number&&!pushed&&(await github.ref(candidate.base_branch))?.object?.sha!==candidate.base_sha)stop('base_branch_changed','needs_replan',`基础分支 ${candidate.base_branch} 已偏离提交 ${candidate.base_sha}，需要重新规划。`);
          if(input.bot_pr){
            const pr=await github.object('review.pr',input.bot_pr.number),owned=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,pr.number);
            assertOwnedPR(owned,pr,github.actorId,task.repository_id);
            if(pr.state!=='open'||pr.draft===true)stop('object_closed_or_draft','cancelled',`PR #${pr.number} 已关闭或变为草稿，state=${pr.state}，draft=${pr.draft===true}。`);
            if(pr.head.sha!==task.head_sha&&pr.head.sha!==candidate?.remote_sha)stop('pull_request_head_changed','superseded',`PR #${pr.number} 的 head 已变化：任务提交 ${task.head_sha}，当前 ${pr.head.sha}。`);
          }
        }
      };
      workspace=new Workspace(this.store,this.manager,task,redactor,guard,log);
      // Reuse a check only at the immediately following phase boundary in this run. A resumed run or a
      // ReviewUpdated loop starts without this credit and must read the current object before continuing.
      let validatedPhase:'model'|'publish'|undefined;
      const accept=async(artifact:any, evidence:any[]=[])=>{
        const inputNow=JSON.parse(task.input||'{}');
        const before=records.get(id);
        const goal=development?inputNow.context?.implementation_goal||inputNow.object?.body||task.summary
          :event?`${task.kind}: ${task.summary}`:`${task.kind}: ${inputNow.object?.title||task.summary}. Deliver a factual report with actual repository evidence, address the requested discussion, distinguish defects and suggestions. Source request: ${inputNow.object?.body||''}`;
        const contract=inputNow.contract||{goal,scope:[development?String(goal):task.kind],criteria:[development?'Implement the recorded goal and approved findings; mandatory project verification must pass.':'Deliver the requested result, supported by verifiable evidence; do not invent observations.'],endpoint:development?'reviewable_pull_request':'report',source:{kind:task.kind,object_number:task.object_number,delivery_id:task.source_delivery_id},completeness:'derived_from_source'};
        if(before.contract.completeness==='unspecified'||before.contract.completeness==='legacy_unknown')records.contract(id,contract);
        const version=artifact.tree_sha||sha(JSON.stringify(artifact));
        const compact=(value:any)=>({...value,...(value.files?{files:value.files.map(({base64,...file}:any)=>file)}:{})});
        const artifacts=[{kind:artifact.tree_sha?'code':'report',reference:`task:${id}:candidate`,version,content:redactor.clean(compact(artifact))}];
        // A workflow's final report delivers its intermediate PR too. Do not drop the code or its residual findings.
        if(!artifact.tree_sha){
          const saved=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),code=saved?JSON.parse(saved.data):null;
          if(code?.published){artifacts.push({kind:'code',reference:code.published.html_url,version:code.published_tree_sha||code.tree_sha,content:redactor.clean(compact(code))});
            evidence=[...evidence,{source:'policy_validation',version:code.tree_sha,verified:code.validation?.source==='policy',result:code.validation}];}
        }
        const candidate=records.submit(id,artifacts,evidence,redactor.clean({summary:artifact.summary,test_command:artifact.test_command}),token);
        const policyHash=policyHashFor(artifacts);
        const savedDecision=records.get(id);const existing=savedDecision.pending||savedDecision.acceptance;
        if(existing?.policy_hash===policyHash&&existing?.candidate_id===candidate.id&&['pass','pass_with_issues'].includes(existing.outcome))return {ok:true};
        const access=workflowPermissions(this.store,task.repository_id,taskWorkflow(task as any));
        const verdict=await this.evaluate(this.store,task,workspace!,redactor,guard,access.workspace.shell);
        await validate();
        if(policyHash!==policyHashFor(artifacts))stop('acceptance_context_changed','retry_wait','验收期间必需验证策略变化，将重新验收。');
        if(['pass','pass_with_issues'].includes(verdict.outcome)){records.stage(id,candidate.id,candidate.revision,verdict,token,{policy_hash:policyHash});return {ok:true};}
        const result=records.decide(id,candidate.id,candidate.revision,verdict,'running',false,token);
        if(verdict.outcome==='needs_human'||result.exhausted)stop(result.exhausted?'acceptance_no_progress':'acceptance_needs_human','needs_replan',verdict.reason+' '+verdict.gaps.join('; '));
        // Continue this same execution when called as a tool; a finished report retries with explicit feedback.
        this.store.run("UPDATE tasks SET status='running',phase=? WHERE id=?",task.phase,id);
        return {error:`acceptance_${verdict.outcome}`,reason:verdict.reason,gaps:verdict.gaps};
      };
      const acceptReport=async(value:any)=>{
        const checked=await accept(value,this.store.all("SELECT id,content FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.type')='tool' AND json_extract(content,'$.name') IN ('run_command','read_file') AND json_extract(content,'$.attempt')=? ORDER BY rowid",id,task.attempt).map(row=>observation('task_log:'+row.id,sha(row.content),row.content)));
        if(checked.error){
          await this.release(workspace,task);
          update({phase:'prepare',workspace_id:null,generation:null,messages:null,result:null,model_started:0,publication_started:0,attempt:task.attempt+1});
          stop(checked.error,'queued',checked.reason+' '+checked.gaps?.join('; '));
        }
      };

      // Another workflow's pull request: published like development's, recorded on its candidate, and the task carries on.
      const publishPullRequest=async()=>{
        log({type:'phase',phase:'pull_request',target:'pull_request',detail:'正在发布到 GitHub：创建或更新 PR…'});
        const publisher=new Publisher(this.store,github,task,validate,undefined,log);
        const candidate=JSON.parse(this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id)!.data);
        const checked=await accept(candidate,[{source:'policy_validation',version:candidate.tree_sha,verified:candidate.validation?.source==='policy',result:candidate.validation}]);
        if(checked.error)return checked;
        const commit=await publisher.branch(candidate),pr=await publisher.pullRequest(candidate,commit);
        log({type:'published',outputs:[{html_url:pr.html_url,branch:candidate.branch,sha:commit}]});
        const published={number:pr.number,html_url:pr.html_url,sha:commit};
        this.store.run('UPDATE development_candidates SET data=? WHERE task_id=?',JSON.stringify({...JSON.parse(this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id)!.data),published}),id);
        return {pr:published};
      };
      const publishDevelopment=async()=>{
        update({status:'publishing'});log({type:'phase',phase:'publish',target:'pull_request',detail:'正在发布到 GitHub：创建或更新 PR…'});
        const publisher=new Publisher(this.store,github,task,validate,undefined,log);
        const candidate=JSON.parse(this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id)!.data);
        const checked=await accept(candidate,[{source:'policy_validation',version:candidate.tree_sha,verified:candidate.validation?.source==='policy',result:candidate.validation}]);
        if(checked.error)return checked;
        const commit=await publisher.branch(candidate),pr=await publisher.pullRequest(candidate,commit);
        log({type:'published',outputs:[{html_url:pr.html_url,branch:candidate.branch,sha:commit}]});
        await publisher.discussion('development-result',`Implemented in ${pr.html_url}\n\n${candidate.summary}\n\n${testEvidence(candidate)}\nCommit: ${commit}`);
        update({result:JSON.stringify({summary:candidate.summary,test_command:candidate.test_command,pr_number:pr.number,pr_url:pr.html_url,branch:candidate.branch,sha:commit,tree_sha:candidate.published_tree_sha||candidate.tree_sha,local_sha:candidate.local_sha,validation:candidate.validation}),phase:'done',status:pr.number===candidate.pr_number?'completed':'pr_opened',error_code:null});
        return {pr:{number:pr.number,html_url:pr.html_url,sha:commit}};
      };
      // An event workflow works on a checkout of the commit its event concerns, with the event as context files.
      if(task.phase==='prepare'&&event){
        update({generation:environment.generation,workspace_id:task.workspace_id||randomId()});
        await validate();
        const target=await event.prepare(this.store,github,task,input,redactor),policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id)!;
        const ruleSha=(await github.ref(github.defaultBranch))?.object?.sha||target.sha;
        const mirror=this.gitCache&&github.cloneUrl?await this.gitCache.open(task.repository_id,{url:github.cloneUrl,token:github.token,commits:[target.sha,ruleSha],refs:[`refs/heads/${github.defaultBranch}`]}):undefined;
        let effectiveRules:ReturnType<typeof resolveRules>;
        try{
          const ruleFiles=await this.rules.fetch(github,ruleSha,mirror);this.rules.cache(task.repository_id,ruleSha,ruleFiles);
          effectiveRules=resolveRules(policy,ruleFiles,this.rules.consoleComputer(task.repository_id,environment.computer));
        }catch(error){
          if(error instanceof HttpError&&ruleErrors.has(error.code)){const detail=(error as HttpError&{detail?:string}).detail;stop(error.code,'waiting_configuration',`加载仓库行为规则失败（${error.code}）${detail?'：'+detail:''}，请检查 .bot/ 和 .agents/skills/ 配置。`);}
          throw error;
        }
        let snapshot:any=mirror?await workspace.checkout(github,target.sha,mirror,[]):null;
        if(!snapshot){if(mirror?.has(target.sha))update({workspace_id:randomId()});snapshot=await workspace.prepare(github,target.sha,mirror);}
        await workspace.deliver({type:'workspace_cache',sha:target.sha,tree_sha:snapshot.tree_sha});
        const computer=computerRequest(effectiveRules.computer,environment.computer);
        if(computer){
          this.rules.rememberComputer(task.repository_id,environment.computer);
          environment=await this.manager.call('POST',`/v1/projects/${task.repository_id}/configure`,{operation_id:randomId(),generation:environment.generation,request:redactor.clean(computer)},35*60000);
          environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);
        }
        const skills=skillIndex(effectiveRules.files);
        await workspace.context({...target.files,...Object.fromEntries(skills.map(skill=>[skill.file,skill.content]))});
        input={...input,snapshot_sha:target.sha,snapshot_tree:snapshot.tree_sha,source_tree:snapshot.source_tree_sha,snapshot_files:snapshot.files,skipped_files:snapshot.skipped_files,coverage:snapshot.coverage,
          context:{mode:'event',repository:github.fullName,reviewed_sha:target.sha,context_files:target.contextFiles,skills:skills.map(({name,description,path})=>({name,description,path})),
            effective_rules:effectiveRules,computer:computerSummary(environment.computer),...target.context}};
        update({input:JSON.stringify(redactor.clean(input)),head_sha:target.sha,phase:'model'});await validate();validatedPhase='model';log({type:'prepared',sha:target.sha});
      }
      if(task.phase==='prepare'){
        update({generation:environment.generation,workspace_id:task.workspace_id||randomId()});
        const object=await github.object(task.kind,task.object_number);await validate(object);
        let implementationGoal=input.review?.implementation_goal||'',actionableFindings:any[]=[];
        if(development&&input.review?.clarification_required)stop('review_requires_human_decision','needs_replan','检视结果要求先由人确认需求，开发任务等待重新规划。');
        if(task.kind.endsWith('.pr')){
          const owned=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,task.object_number);
          if(owned){
            const source=this.store.get('SELECT input FROM tasks WHERE id=?',owned.source_task_id);
            implementationGoal=source?JSON.parse(source.input).review?.implementation_goal||'':'';
            if(development){
              actionableFindings=(input.review?.findings||[]).filter(actionableFinding);
              if(!implementationGoal||!actionableFindings.length)stop('revision_scope_unconfirmed','needs_replan',`PR #${task.object_number} 缺少已确认的实现目标或可执行检视意见。`);
            }
          }
        }
        if(input.contract?.completeness==='explicit')implementationGoal=input.contract.goal;
        const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id)!;
        if(task.kind==='development.issue'){
          const owned=this.store.get(`SELECT p.* FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
            WHERE p.repository_id=? AND t.kind='development.issue' AND t.object_number=? ORDER BY t.created_at LIMIT 1`,task.repository_id,task.object_number);
          if(owned){
            const pr=await github.object('review.pr',owned.number);assertOwnedPR(owned,pr,github.actorId,task.repository_id);
            input.bot_pr=pr;update({head_sha:pr.head.sha});await validate();
          }
        }
        const baseBranch=input.bot_pr?.base?.ref||policy.base_branch||github.defaultBranch;
        const ref=task.kind.endsWith('.pr')||input.bot_pr?{object:{sha:task.head_sha}}:await github.ref(baseBranch);
        if(!ref?.object?.sha)stop('repository_has_no_commit','waiting_configuration',`基础分支 ${baseBranch} 没有可读取的提交，请先初始化仓库或检查分支配置。`);
        if(development&&task.kind.endsWith('.pr')){
          const owned=this.owned(github,task,object);
          if(owned.sha!==task.head_sha){const compare=await github.request('GET',github.path('/compare/'+owned.sha+'...'+task.head_sha));if(!['ahead','identical'].includes(compare.status))stop('bot_branch_history_changed','needs_replan',`分支 ${owned.branch} 的提交历史已变化，比较状态=${compare.status}，需要重新规划。`);}
        }
        // Rules never come from a pull request's own commits: PR tasks read the default branch, an Issue development that
        // continues the bot's PR reads that PR's base branch, and other Issue tasks read the commit they check out.
        const ruleBranch=task.kind.endsWith('.pr')?github.defaultBranch:input.bot_pr?baseBranch:null;
        const ruleSha=ruleBranch?(await github.ref(ruleBranch))?.object.sha:ref.object.sha;
        // The repository's mirror is brought up to both commits first; rules and files are then read at those commits.
        // A pull request's base comes into the mirror too, so the agent can compare base and head with git.
        const pr=task.kind.endsWith('.pr'),prBase=pr&&/^[a-f0-9]{40}$/.test(String(object.base?.sha||''))?String(object.base.sha):null;
        const mirror=this.gitCache&&github.cloneUrl?await this.gitCache.open(task.repository_id,{url:github.cloneUrl,token:github.token,commits:[ref.object.sha,ruleSha,...(prBase?[prBase]:[])],
          refs:[pr?`refs/pull/${task.object_number}/head`:`refs/heads/${input.bot_pr?.head?.ref||baseBranch}`,...(ruleBranch?[`refs/heads/${ruleBranch}`]:[]),...(prBase&&object.base?.ref?[`refs/heads/${object.base.ref}`]:[])]}):undefined;
        // Rules are checked before the workspace is written. A bad rule file waits for a person with its own code and
        // nothing is published; the retry after the fix then prepares the new commit without earlier writes in the way.
        let effectiveRules:ReturnType<typeof resolveRules>;
        try{
          const ruleFiles=await this.rules.fetch(github,ruleSha,mirror);
          this.rules.cache(task.repository_id,ruleSha,ruleFiles);
          effectiveRules=resolveRules(policy,ruleFiles,this.rules.consoleComputer(task.repository_id,environment.computer));
        }catch(error){
          if(error instanceof HttpError&&ruleErrors.has(error.code)){const detail=(error as HttpError&{detail?:string}).detail;stop(error.code,'waiting_configuration',`加载仓库行为规则失败（${error.code}）${detail?'：'+detail:''}，请检查 .bot/ 和 .agents/skills/ 配置。`);}
          throw error;
        }
        // A git worktree from the computer's store when the mirror has the commit. Otherwise files are copied as before, in a
        // fresh workspace, so nothing a checkout left halfway is in the way.
        let snapshot:any=null;
        if(prior&&prior.generation===environment.generation&&prior.head_sha===ref.object.sha&&prior.workspace_id
          &&!this.store.get("SELECT 1 FROM tasks WHERE workspace_id=? AND id<>? AND status IN ('running','publishing','preparing')",prior.workspace_id,id)){
          const ownWorkspace=task.workspace_id;update({workspace_id:prior.workspace_id});
          const reused=await workspace.deliver({type:'workspace_reuse',sha:ref.object.sha,tree_sha:JSON.parse(prior.snapshot).snapshot_tree});
          if(reused.reused){const cached=JSON.parse(prior.snapshot);snapshot={files:cached.snapshot_files,skipped_files:cached.skipped_files,tree_sha:cached.snapshot_tree,source_tree_sha:cached.source_tree,coverage:cached.coverage,history:cached.history};}
          else update({workspace_id:ownWorkspace});
        }
        if(!snapshot)snapshot=mirror?await workspace.checkout(github,ref.object.sha,mirror,prBase?[prBase]:[]):null;
        if(!snapshot){if(mirror?.has(ref.object.sha))update({workspace_id:randomId()});snapshot=await workspace.prepare(github,ref.object.sha,mirror);}
        if(!development)await workspace.deliver({type:'workspace_cache',sha:ref.object.sha,tree_sha:snapshot.tree_sha});
        const files=task.kind.endsWith('.pr')?await github.pages(github.path(`/pulls/${task.object_number}/files`)):[];
        if(files.length>=3000)stop('pull_request_file_limit','failed',`PR #${task.object_number} 返回 ${files.length} 个文件，已达到 GitHub 的 3000 文件列表上限，无法确认完整差异。`);
        const computer=computerRequest(effectiveRules.computer,environment.computer);
        if(computer){
          this.rules.rememberComputer(task.repository_id,environment.computer);
          environment=await this.manager.call('POST',`/v1/projects/${task.repository_id}/configure`,{operation_id:randomId(),generation:environment.generation,request:redactor.clean(computer)},35*60000);
          environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);
        }
        const comments=await github.pages(github.path(`/issues/${task.object_number}/comments`));
        // The whole discussion and the project's skills are files the agent reads when it needs them, next to the checkout.
        const reviews=pr?await github.pages(github.path(`/pulls/${task.object_number}/reviews`)):[],reviewComments=pr?await github.pages(github.path(`/pulls/${task.object_number}/comments`)):[];
        const skills=skillIndex(effectiveRules.files),json=(value:unknown)=>JSON.stringify(value,null,2);
        await workspace.context({'object.json':json(object),'comments.json':json(comments),
          ...(pr?{'files.json':json(files),'reviews.json':json(reviews),'review_comments.json':json(reviewComments)}:{}),
          ...Object.fromEntries(skills.map(skill=>[skill.file,skill.content]))});
        const kind=pr?'pull request':'Issue',contextFiles=[
          {path:'../context/object.json',content:`The ${kind} as GitHub returns it: title, full body, author, labels${pr?', base and head':''}`},
          {path:'../context/comments.json',content:`All ${comments.length} conversation comments, oldest first`},
          ...(pr?[{path:'../context/files.json',content:`The ${files.length} changed files with GitHub's patch of each`},
            {path:'../context/reviews.json',content:`All ${reviews.length} reviews of the pull request`},
            {path:'../context/review_comments.json',content:`All ${reviewComments.length} inline review comments, with path, line and in_reply_to_id`}]:[])];
        // Classification is optional: a repository whose labels cannot be read is reviewed without them.
        const labeling=review||writes.includes('labels');
        const labels=!labeling?[]:await github.pages(github.path('/labels')).then(repositoryLabels,error=>{if(error instanceof TaskError&&error.code.startsWith('github_permission_'))return [];throw error;});
        input={...input,...JSON.parse(this.store.get('SELECT input FROM tasks WHERE id=?',id)!.input),object,object_hash:sha(JSON.stringify([object.title,object.body])),base_branch:baseBranch,snapshot_sha:ref.object.sha,snapshot_tree:snapshot.tree_sha,
          source_tree:snapshot.source_tree_sha,snapshot_files:snapshot.files,skipped_files:snapshot.skipped_files,
          files,coverage:snapshot.coverage,review_label:effectiveRules.review_label,development_label:effectiveRules.development_label,repository_labels:labels,behavior_changes:files.filter((f:any)=>behaviorPath(f.filename)||f.previous_filename&&behaviorPath(f.previous_filename)).map((f:any)=>f.filename),context:{mode:development?'development':review?'review':'workflow',repository:github.fullName,reviewed_sha:ref.object.sha,...(development?{}:{bot_login:github.actorLogin||null}),
            ...(!pr ? {actions_failure:this.store.get('SELECT classification FROM actions_failure_issues WHERE repository_id=? AND number=?',task.repository_id,task.object_number)||null} : {}),
            object:{number:object.number,title:object.title,state:object.state,author:object.user?.login||null,html_url:object.html_url||null,labels:(object.labels||[]).map((l:any)=>typeof l==='string'?l:l.name),
              ...(pr?{draft:object.draft===true}:{}),body_excerpt:String(object.body||'').slice(0,1000)},
            ...(pr?{pull_request:{base:{ref:object.base?.ref||null,sha:prBase},head:{ref:object.head?.ref||null,sha:object.head?.sha||null},
              diff:snapshot.history&&prBase?`git diff ${prBase}...${object.head?.sha}`:null}}:{}),
            context_files:contextFiles,skills:skills.map(({name,description,path})=>({name,description,path})),
            implementation_goal:implementationGoal,actionable_findings:actionableFindings,
            // On a revision people or other review bots asked for: their comments, which the findings above carry out.
            ...(development&&input.revision?.requests?.length?{revision_requests:input.revision.requests}:{}),review:development&&task.kind.endsWith('.pr')?null:input.review||null,effective_rules:effectiveRules,
            ...(input.comment?{trigger_comment:input.comment}:{}),...(input.trigger?{trigger:input.trigger}:{}),
            // On a pull request this bot opened: the comments, reviews and inline comments this review answers. Each change the
            // review takes on from one of them names it in requested_in.
            ...(review&&pr&&this.store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,task.object_number)
              ?{discussion_requests:discussionRequests(this.store,task,input)}:{}),...(input.merged_updates?.length?{merged_updates:input.merged_updates}:{}),coverage:snapshot.coverage,required_test_command:policy.test_command||null,
            review_rules:{language:policy.review_language},...(labeling?{repository_labels:labels}:{}),
            // What the project computer offers: limits, installed toolchain and packages, variable names (not values).
            computer:computerSummary(environment.computer)}};
        update({input:JSON.stringify(redactor.clean(input)),head_sha:task.head_sha||ref.object.sha,phase:'model'});await validate();validatedPhase='model';log({type:'prepared',sha:ref.object.sha,coverage:input.coverage});
      }
      if(task.phase==='validate')stop('create_pull_request_required','needs_replan','任务停在 validate 阶段，需要重新规划并通过 create_pull_request 提交候选修改。');
      // Every attempt refreshes GitHub before its first request. Turn boundaries do the same for pending updates.
      const conversation=!review?undefined:{history:prior?JSON.parse(prior.messages):[],resume:false,boundary:async(stage:string)=>{
        const updates=pendingReviewUpdates(this.store,task);
        if(stage!=='start'&&!updates.length)return {messages:[]};
        const object=await github.object(task.kind,task.object_number);await validate(object);
        const pr=task.kind==='review.pr',comments=await github.pages(github.path(`/issues/${task.object_number}/comments`));
        const reviews=pr?await github.pages(github.path(`/pulls/${task.object_number}/reviews`)):[],reviewComments=pr?await github.pages(github.path(`/pulls/${task.object_number}/comments`)):[];
        await workspace!.context({'object.json':JSON.stringify(object,null,2),'comments.json':JSON.stringify(comments,null,2),
          ...(pr?{'reviews.json':JSON.stringify(reviews,null,2),'review_comments.json':JSON.stringify(reviewComments,null,2)}:{})});
        const latest=JSON.parse(this.store.get('SELECT input FROM tasks WHERE id=?',id)!.input);
        input={...input,...latest,object,object_hash:sha(JSON.stringify([object.title,object.body]))};
        const descriptions:Record<string,string>={'../context/comments.json':`All ${comments.length} conversation comments, oldest first`,
          '../context/reviews.json':`All ${reviews.length} reviews of the pull request`,
          '../context/review_comments.json':`All ${reviewComments.length} inline review comments, with path, line and in_reply_to_id`};
        input.context={...input.context,context_files:input.context.context_files.map((file:any)=>({...file,content:descriptions[file.path]||file.content})),
          object:{...input.context.object,title:object.title,body_excerpt:String(object.body||'').slice(0,1000)},
          trigger:input.trigger,merged_updates:input.merged_updates,
          conversation_notice:`Current checkout/head: ${task.head_sha}. Read the current checkout, .bot rules, skills and ../notes/ for this task. Historical code conclusions may refer to an earlier head.`};
        update({input:JSON.stringify(redactor.clean(input))});
        if(updates.length)this.store.run('UPDATE tasks SET review_update_cursor=? WHERE id=?',updates.at(-1)!.id,id);
        if(stage!=='start')for(const row of updates){const data=JSON.parse(row.data);log({type:'review_update',actor:data.actor,reason:data.reason,detail:JSON.stringify(data)});}
        return stage==='start'?{prompt:JSON.stringify({...input.context,structured_task:records.get(id),playbook_catalog:playbooks.map(({content,...p})=>p),effective_rules:undefined,review_rules:undefined})}
          :{messages:updates.map(row=>JSON.stringify({instruction:'A person updated this review. Respond to this update and revise the final result before publication. Discussion files have been refreshed.',
            update:JSON.parse(row.data),current_object:object,reviewed_sha:task.head_sha}))};
      }};
      if(development&&task.phase==='model')await restoreCheckpoint(this.store,task,workspace,input.snapshot_sha);
      const initial=records.get(id);
      if(['unspecified','legacy_unknown'].includes(initial.contract.completeness||'')) {
        const goal=development?input.context?.implementation_goal||input.object?.body||task.summary
          :event?input.context?.workflow_prompt||`${task.kind}: ${task.summary}`:`${task.kind}: ${input.object?.title||task.summary}. Requested result: ${input.object?.body||task.summary}`;
        records.contract(id,input.contract||{goal,scope:[development?goal:task.kind],criteria:[development?'Implement the recorded goal and approved actionable findings; mandatory project verification must pass.':'Deliver a factual requested report, inspect relevant artifacts, distinguish findings from suggestions, and support conclusions with evidence.'],endpoint:development?'reviewable_pull_request':'report',source:{kind:task.kind,object_number:task.object_number,delivery_id:task.source_delivery_id},completeness:'derived_from_source'});
      }
      for(;;){
      try{
      if(task.phase==='model'){
        if(validatedPhase!=='model')await validate();
        validatedPhase=undefined;
        log({type:'phase',phase:'model',mode:development?'development':'review',detail:`Agent 开始执行：${development?'开发':'检视'}…`});
        // create_issue: a new Issue the workflow files, once per tool call, with mentions escaped and secrets removed.
        // An event workflow's own write tools (Actions rerun and report) come from its module; it reports through them.
        input.context={...input.context,acceptance_feedback:records.get(id).acceptance};
        const platform:PlatformTools={...(event?.tools?.(this.store,task,input,writes,eventState)??{})};
        if(writes.includes('issue')&&task.kind!=='actions.failures')platform.create_issue=async(callId,args)=>{
          if(typeof args?.title!=='string'||!args.title.trim()||args.title.length>256||typeof args.body!=='string'||args.body.length>60000)return {error:'create_issue_invalid',message:'title (up to 256 characters) and body are required.'};
          const safe=(text:string)=>publicText(text,redactor).replace(/@/g,'&#64;');
          const issue=await new Publisher(this.store,github,task,validate,undefined,log).issue('issue:'+callId,safe(args.title).replace(/[\r\n]+/g,' ').trim(),safe(args.body));
          log({type:'published',outputs:[{html_url:issue.html_url,issue:issue.number}]});
          return {number:issue.number,html_url:issue.html_url};
        };
        result=await agentLoop(this.store,task,workspace,redactor,guard,input.context,new ReadTokens(this.store,repo,redactor,guard,this.githubUrl,workflowPermissions(this.store,task.repository_id,taskWorkflow(task as any)).github),writes.includes('pull_request')?async(requestId,args)=>{
          // Any workflow other than development may publish one PR per task, while the project's development switch is on,
          // from an Issue or onto the bot's own PR.
          if(!development){
            if(!this.store.get('SELECT development_enabled FROM policies WHERE repository_id=?',task.repository_id)?.development_enabled)
              return {error:'development_disabled',message:'The project\'s development switch is off, so no pull request can be published. Finish without one.'};
            const earlier=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),published=earlier?JSON.parse(earlier.data).published:null;
            if(published)return {error:'pull_request_already_published',pr:published,message:'This task already published its pull request.'};
            if(task.kind.endsWith('.pr')&&!this.store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,task.object_number))
              return {error:'pull_request_not_owned',message:'This pull request is not the bot\'s own, so its branch cannot be updated. Report your changes in your reply instead.'};
          }
          // A missing category can be corrected in the same tool conversation, before any branch is published.
          try{await releaseCategory(github,args.release_label);}catch(error){
            if(error instanceof TaskError&&error.code==='pr_release_category_required')return {error:error.code,message:'Read the current contribution guide and create-github-pr skill, choose exactly one release:* category, and call create_pull_request again with release_label.'};
            throw error;
          }
          // Fix the only candidate snapshot before any policy command can create or modify files.
          const snapshot=await workspace!.artifact('create-pr:'+requestId+':snapshot');
          if(snapshot.tree_sha===input.snapshot_tree){
            const checked=await accept({...args,status:'no_changes',tree_sha:snapshot.tree_sha});if(checked.error)return checked;
            if(development)update({result:JSON.stringify({...args,status:'no_changes'}),phase:'done',status:'completed',error_code:null});
            return {status:'no_changes',message:'The working tree has no changes; no pull request was created.'};
          }
          await validate();
          const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id)!;
          const command=String(policy.test_command||'').trim();
          let validation:any={command:args.test_command,source:'agent',skipped:true};
          if(command){
            validation={...await workspace!.call('create-pr:'+requestId+':tests',{type:'workspace_command',command,timeout_ms:null}),command,source:'policy'};
            if(validation.error||validation.exit_code!==0||validation.timed_out||validation.truncated)return {...validation,error:'validation_failed'};
          }
          let branch:string,ownerTask=id,prNumber:number|null=null;
          if(task.kind.endsWith('.pr')||input.bot_pr){
            const pr=input.bot_pr||input.object,owned=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,pr.number);
            assertOwnedPR(owned,pr,github.actorId,task.repository_id);branch=owned!.branch;prNumber=owned!.number;ownerTask=owned!.source_task_id;
          }else{branch=`bot/issue-${task.object_number}-${id}`;this.store.run('INSERT INTO bot_branches VALUES(?,?,?) ON CONFLICT DO NOTHING',task.repository_id,branch,id);}
          const candidate={...snapshot,files:await workspace!.contents(snapshot.files,input.snapshot_files),source_tree:input.source_tree,snapshot_files:input.snapshot_files,skipped_files:input.skipped_files,summary:args.summary,change_title:args.change_title,test_command:args.test_command,release_label:args.release_label,
            implementation_goal:input.context.implementation_goal,base_sha:input.snapshot_sha,base_branch:input.base_branch,
            branch,owner_task_id:ownerTask,expected_sha:prNumber?task.head_sha:null,pr_number:prNumber,date:new Date(task.created_at).toISOString(),validation};
          this.store.run('INSERT INTO development_candidates VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data',id,JSON.stringify(candidate));
          if(!development)return publishPullRequest();
          update({result:JSON.stringify(args),phase:'publish'});
          return publishDevelopment();
        }:undefined,conversation,platform);
        if(event){
          // The module checks the finished result and takes it; the task keeps what it returns.
          await acceptReport(result);
          const kept=await event.finish(this.store,task,input,result,eventState);
          update({result:JSON.stringify(redactor.clean(kept)),phase:'done',status:'succeeded',error_code:null});
        }else if(!development){
          // Files that change the bot's own behavior are a person's decision; the summary comment lists them with the others.
          if(review&&input.behavior_changes?.length){result.behavior_changes=input.behavior_changes;result.clarification_required=true;}
          // A pull request this workflow published on the way is part of its result.
          const candidate=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),published=candidate?JSON.parse(candidate.data).published:null;
          result={...result,findings:result.findings.map((finding:any,index:number)=>({...finding,id:operationId(id+':finding:'+index)})),reviewed_sha:task.head_sha,coverage:input.coverage,object_hash:input.object_hash,...(published?{pull_request:published}:{})};
          await acceptReport(result);
          update({result:JSON.stringify(result),phase:'publish'});validatedPhase='publish';
        }else if(task.phase!=='done')stop('create_pull_request_required',undefined,`开发执行结束时仍处于 ${task.phase} 阶段，未完成 create_pull_request。`);
      }
      if(task.phase==='publish'){
        if(validatedPhase!=='publish')await validate();
        validatedPhase=undefined;
        if(!development)await acceptReport(result);
        update({status:'publishing'});const publisher=new Publisher(this.store,github,task,validate,undefined,log,development?undefined:()=>{
          // No await between checking the inbox and fencing the first GitHub write.
          if(this.store.get('SELECT publication_started FROM tasks WHERE id=?',id)?.publication_started)return;
          if(review&&pendingReviewUpdates(this.store,task).length)throw new ReviewUpdated();
          update({publication_started:1});
        });
        if(!development&&!review){
          // A custom workflow publishes what its writes allow and stops: no development, no conversation to keep.
          const outputs:any[]=[];
          if(writes.includes('reply')){
            log({type:'phase',phase:'publish',target:'workflow',detail:'正在发布到 GitHub：发送工作流回复…'});
            outputs.push(...await publisher.reply(result,input.files));
          }
          if(writes.includes('labels')&&result.labels?.length){
            const current=(seen||await github.object(task.kind,task.object_number)).labels;
            const names=classificationLabels(result.labels,input.repository_labels,current,[input.review_label,input.development_label]);
            if(names.length)outputs.push({labels:(await publisher.labels(names)).map((l:any)=>l.name)});
          }
          if(outputs.length)log({type:'published',outputs:outputs.map((o:any)=>o.labels?{labels:o.labels}:{html_url:o.html_url,inline_comments:o.inline_comments?.length||0})});
          update({result:JSON.stringify({...result,outputs}),phase:'done',status:'succeeded',error_code:null});
        }
        else if(!development){
          log({type:'phase',phase:'publish',target:'review',detail:'正在发布到 GitHub：发送检视评论…'});
          const setting=this.store.get('SELECT review_language FROM policies WHERE repository_id=?',task.repository_id)?.review_language;
          // A review a person's comment asked for names that person in the summary comment, which also notifies them of the edit.
          const asked=input.trigger?.actor?{actor:input.trigger.actor,url:input.trigger.url||null,what:promptedBy(input.trigger.reason)}:input.comment?{actor:input.comment.user?.login||input.sender?.login||null,url:input.comment.html_url||null,what:'comment' as const}:undefined;
          // An Issue the review finds ready for development that will not be developed yet says what it waits for.
          const development=await this.developmentWait(github,task,input,result).catch(()=>null);
          const outputs=await publisher.review(result,input.files,{language:reviewLanguage(setting,result.summary),trigger:asked,development});
          // Labels go on only after the summary comment was published: the policy's review label, plus the classification
          // labels the model named that pass classificationLabels against the repository and the object's current labels.
          // publisher.review ends by validating the object, so its labels are current.
          if(writes.includes('labels')){
            const label=input.review_label,current=(seen||await github.object(task.kind,task.object_number)).labels;
            const names=[...(label?[label]:[]),...classificationLabels(result.labels,input.repository_labels,current,[label,input.development_label])];
            if(names.length)outputs.push({labels:(await publisher.labels(names)).map((l:any)=>l.name)});
          }
          log({type:'published',outputs:outputs.map((o:any)=>o.labels?{labels:o.labels}:{html_url:o.html_url,inline_comments:o.inline_comments?.length||0,...(o.resolved_threads?{resolved_threads:o.resolved_threads.length}:{})})});
          result={...result,outputs};
          // A review that finds a code request starts development only with a person's go-ahead already on the Issue;
          // otherwise the labeled webhook starts it later. A failed check counts as no go-ahead.
          const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
          let approved=false;
          if(task.kind==='review.issue'&&policy?.development_enabled&&reviewRequestsCode(input.object,result)){
            approved=await this.developmentApproved(github,task).catch(()=>false);
            // The log names the reason the summary comment gave: no label yet, someone assigned, or a label added by an app.
            if(!approved)log({type:'development_waiting',reason:development?.reason||'label',...(development?.assignees.length?{assignees:development.assignees}:{})});
          }
          // Who wrote the comments a review of the bot's own pull request took on is read from GitHub before the transaction.
          const requests=await this.revisionRequests(github,task,result,input).catch(()=>[]);
          if(requests.length)log({type:'revision_requests',requests:requests.map(r=>({type:r.type,id:r.id,author:r.author,author_type:r.author_type,url:r.url}))});
          this.store.transaction(()=>{
            update({result:JSON.stringify(result),phase:'done',status:'succeeded',error_code:null});
            saveReviewSession(this.store,task);
            this.queueDevelopment(github,task,input,result,approved,requests);
          });
        }
        else {
          const published=await publishDevelopment();
          if('error' in published&&published.error){
            if(this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",id))stop('acceptance_publication_changed','needs_replan','已部分发布的候选需要修订；保留现有 GitHub 成果，请根据验收缺口安排已有 PR 的修订。');
            const saved=JSON.parse(this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id)!.data);
            const recovery={source_workspace_id:task.workspace_id,base_sha:saved.base_sha,revision:records.get(id).revision,sha:saved.local_sha,tree_sha:saved.tree_sha,created_at:new Date().toISOString()};
            records.atomic(()=>{
              const current=JSON.parse(this.store.get('SELECT input FROM tasks WHERE id=?',id)!.input);
              this.store.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify({...current,recovery}),id);records.history(id,'artifact_checkpoint',recovery);
              update({phase:'prepare',status:'queued',workspace_id:null,generation:null,messages:null,result:null,model_started:0,publication_started:0,attempt:task.attempt+1});
            });
            stop(String(published.error),'queued',String((published as any).reason||'独立验收要求修订或补证。'));
          }
        }
      }
      break;
      }catch(error){
        if(error instanceof ReviewUpdated&&conversation){validatedPhase=undefined;conversation.resume=true;this.store.run("DELETE FROM github_effects WHERE task_id=? AND state='pending'",id);update({phase:'model',result:null,status:'running'});continue;}
        throw error;
      }
      }
      await this.release(workspace,task);log({type:'completed',status:task.status});
    }catch(error){
      // An unexpected error keeps its message and where it was thrown (the top stack frames), in the task log and in the
      // control plane's log; both pass through the task's redactor.
      if(!(error instanceof TaskError)){
        const message=redactor.text(String((error as Error)?.message||'runtime failure')).slice(0,2000),where=redactor.text(String((error as Error)?.stack||'')).split('\n').slice(1,6).map(line=>line.trim()).join('\n').slice(0,2000);
        log({type:'runtime_fault',message,...(where?{where}:{})});console.error(`[engine] task ${id} runtime fault in ${task.phase}: ${message}${where?'\n  '+where.replace(/\n/g,'\n  '):''}`);
      }
      await this.release(workspace,task);
      const failure=error instanceof TaskError?error:new TaskError('task_runtime_failure',String((error as Error)?.message).includes('manager')?'waiting_environment':'failed',`任务在 ${task.phase} 阶段发生运行异常：${redactor.text(String((error as Error)?.message||'未知错误')).replace(/\s+/g,' ').slice(0,300)}`);
      const current=this.store.get('SELECT * FROM tasks WHERE id=?',id);
      // A GitHub rate limit is waited out until its window resets (the task resumes then, a few seconds apart from others
      // waiting for the same window); it does not use up the five automatic retries.
      const limited=failure.code==='github_rate_limited';
      const state=failure.state,retrying=automaticRetry.has(state),counted=isAttemptFailure(failure.code,state),now=Date.now();
      const previousCode=current?.retry_error_code||current?.error_code;
      const retries=counted?(previousCode===failure.code?Number(current?.retry_count||0):0)+1:retrying?Number(current?.retry_count||0):0;
      // Once in the slow cycle, a task never starts another burst. Its slots stay relative to its own entry time,
      // including after a restart or a different transient failure. Conditions and rate limits preserve the burst
      // and cycle but use their own wait, so a computer becoming ready need not wait for an eight-hour slot.
      const cycle=retrying?(current?.retry_cycle_started_at??(counted&&retries>=5?now:null)):null;
      // The same stop again waits twice as long as the last time, up to a cap; a different stop starts over. Automatic
      // retries back off too (5 s, 15 s, 45 s, 135 s), so a GitHub or model outage of a few minutes is outlasted.
      const waits=current?.error_code===failure.code?Number(current?.wait_count||0)+1:0,grow=(base:number,cap:number)=>Math.min(base*2**waits,cap);
      const delay=limited?(failure.retryAfterMs??grow(60000,15*60000))+Math.floor(Math.random()*5000)
        :counted&&cycle!=null?cycle+(Math.floor(Math.max(0,now-cycle)/retryCycleMs)+1)*retryCycleMs-now
        :state==='waiting_configuration'?grow(30000,30*60000):state==='retry_wait'?Math.min(5000*3**(retries-1),300000):grow(5000,5*60000);
      // An event workflow's module hears that its task ended without a result (a waiting or retried task has not ended).
      if(event&&current?.claim_token===token&&['failed','cancelled','superseded','needs_replan'].includes(state))event.ended?.(this.store,task,failure.code,redactor.text(String(failure.detail||'')));
      if(current?.claim_token===token&&!['cancelled','superseded'].includes(current.status))update({status:state,error_code:failure.code,retry_count:retries,wait_count:waits,
        retry_error_code:counted?failure.code:retrying?current?.retry_error_code??null:null,retry_cycle_started_at:cycle,
        rate_limit_bucket:limited?failure.bucket??null:null,next_run_at:now+delay});
      // release() reaps the agent. Its cached pi:start receipt describes that dead process, so every model-phase
      // failure must use a new workspace and operation namespace, for development as well as review at any attempt.
      if(current?.claim_token===token&&!['cancelled','superseded'].includes(current.status)&&!['cancelled','superseded'].includes(state)&&
        task.kind!=='task.request'&&(task.phase==='model'||replies(task.kind)&&task.phase==='publish'&&!task.publication_started||failure.code==='execution_interrupted'&&task.phase!=='publish')){
        if(replies(task.kind)&&!task.publication_started)this.store.run("DELETE FROM github_effects WHERE task_id=? AND state='pending'",id);
        log({type:'restart_attempt',preserved_workspace:task.workspace_id});
        update({phase:'prepare',workspace_id:null,generation:null,messages:null,result:null,model_started:0,review_update_cursor:0,publication_started:0,attempt:task.attempt+1});
      }
      // Waiting conditions can be polled every five seconds; retain one copy of an unchanged reason. The state is the one
      // the task is left in; entering the slow cycle is a distinct event even when the reason stays the same.
      const previous=this.store.get("SELECT content FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.type')='fault' ORDER BY rowid DESC LIMIT 1",id);
      const last=previous?JSON.parse(previous.content):null,detail=redactor.clean(failure.detail);
      if(current?.error_code!==failure.code||last?.code!==failure.code||last?.state!==state||last?.retry_cycle_started_at!==(cycle??undefined)||(last?.detail_sha||sha(last?.detail||''))!==sha(detail||''))
        log({type:'fault',state,code:failure.code,...(cycle!=null?{retry_cycle_started_at:cycle}:{}),...(detail?{detail,detail_sha:sha(detail)}:{})});
    }finally{const current=this.store.get('SELECT status,error_code FROM tasks WHERE id=?',id);endRun(this.store,attemptRun,terminal.includes(current?.status)?'succeeded':'stopped',current?.error_code);}
  }
  // The command a running task is executing right now, with its output so far, read from the project computer.
  async live(user:Actor,id:string,url:URL):Promise<Json>{
    const filter=scope(user,'repository_id'),task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,id,...filter.args);
    if(!task)return fail(404,'task_not_found');
    const tool=task.status==='running'?this.store.get("SELECT id,request FROM task_tools WHERE task_id=? AND state='pending' ORDER BY rowid DESC LIMIT 1",task.id):undefined;
    const request=tool?JSON.parse(tool.request).request:null;
    const offset=Number(url.searchParams.get('offset'))||0;if(!Number.isSafeInteger(offset)||offset<0)fail(400,'invalid_offset');
    if(!tool||!['workspace_command','command'].includes(request?.type)){
      if(task.status!=='running'||task.phase!=='model'||!task.workspace_id||!task.generation)return {running:false};
      const live=await this.manager.call('POST',`/v1/projects/${task.repository_id}/execute`,{operation_id:randomId(),generation:task.generation,request:{type:'workspace_agent_live',workspace_id:task.workspace_id,offset}}).catch(()=>null);
      return live?.ok?live.result:{running:false};
    }
    const output=await this.manager.call('GET',`/v1/projects/${task.repository_id}/output/${tool.id}?offset=${offset}`).catch(()=>null);
    return {running:true,operation_id:tool.id,command:request.command,timeout_ms:request.timeout_ms,keep_background:!!request.keep_background,
      output:output?.data??'',offset:output?.offset??offset,state:output?.state??'unavailable'};
  }
  owned(github:GitHub,task:Row,pr:any):Row{
    const row=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,task.object_number);
    assertOwnedPR(row,pr,github.actorId,task.repository_id);
    return row!;
  }
  label(task:Row){try{return developmentLabel(this.store,task.repository_id);}catch(error){const detail=(error as {detail?:string}).detail;
    return stop(error instanceof HttpError&&ruleErrors.has(error.code)?error.code:'invalid_bot_label','waiting_configuration',`仓库 ${task.repository_id} 的开发标签配置无效${detail?'：'+detail:''}，请检查行为规则。`);}}
  // The latest time the development label was added must be by a user account, not an app, and nobody may be assigned.
  async developmentApproved(github:GitHub,task:Row){
    const label=this.label(task);
    if(!developmentReady(await github.object(task.kind,task.object_number),label))return false;
    const events=await github.pages(github.path(`/issues/${task.object_number}/events`));
    return events.filter((e:any)=>e.event==='labeled'&&sameLabel(e.label?.name,label)).at(-1)?.actor?.type==='User';
  }
  // The requests of people and other review bots that this review of the bot's own pull request took on. A request has to be
  // one of the comments the review answered (discussion_requests): the signed webhook brought those, already limited to the
  // repository's owners, members and collaborators, or to other bots. GitHub's API answers author_association from the
  // installation's view, which may not see private organization membership, so it is not asked again; it only gives the text.
  // Whether a comment asks for a change at all, or whether another bot's review is right, is the review agent's judgement.
  async revisionRequests(github:GitHub,task:Row,result:any,input:any={}):Promise<RevisionRequest[]>{
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
  // Why development of an Issue this review found ready will not start yet: no development label, someone assigned, or the
  // label added by an app. Null when development may start, or when it is not this review's to start (development or its
  // triggers off, no explicit code request, an Actions report not cleared for development).
  async developmentWait(github:GitHub,task:Row,input:any,result:any):Promise<DevelopmentWait|null>{
    if(task.kind!=='review.issue'||!this.store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1 AND development_enabled=1',task.repository_id))return null;
    if(!activeTrigger(this.store,task.repository_id,'development.issue','review.published')&&!activeTrigger(this.store,task.repository_id,'development.issue','issue.labeled'))return null;
    if(!reviewRequestsCode(input.object,result)||!actionsDevelopmentAllowed(this.store,task.repository_id,task.object_number,input.object,result))return null;
    const label=this.label(task),issue=await github.object(task.kind,task.object_number);
    const assignees=[...(Array.isArray(issue.assignees)?issue.assignees:[]),...(issue.assignee&&!issue.assignees?.length?[issue.assignee]:[])].map((a:any)=>String(a?.login||'')).filter(Boolean);
    if(assignees.length)return {reason:'assigned',label,assignees};
    if(!(issue.labels||[]).some((l:any)=>sameLabel(typeof l==='string'?l:l?.name,label)))return {reason:'label',label,assignees:[]};
    const events=await github.pages(github.path(`/issues/${task.object_number}/events`));
    return events.filter((e:any)=>e.event==='labeled'&&sameLabel(e.label?.name,label)).at(-1)?.actor?.type==='User'?null:{reason:'app',label,assignees:[]};
  }
  queueDevelopment(github:GitHub,task:Row,input:any,result:any,approved=false,requests:RevisionRequest[]=[]){
    const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
    if(!policy?.enabled||!policy.development_enabled||result.clarification_required)return;
    if(task.kind==='review.issue'){
      if(!result.requires_code_change)return;
      // The development workflow starts from a published review only while that trigger is on; its conditions stay.
      if(!activeTrigger(this.store,task.repository_id,'development.issue','review.published'))return;
      if(!actionsDevelopmentAllowed(this.store,task.repository_id,task.object_number,input.object,result))return;
      if(!approved||!reviewRequestsCode(input.object,result))return;
      // Development that continues the bot's PR for this Issue revises that PR, so it counts against the same budget.
      const owned=this.store.get(`SELECT p.revisions FROM bot_pull_requests p JOIN tasks t ON t.id=p.source_task_id
        WHERE p.repository_id=? AND t.kind='development.issue' AND t.object_number=? ORDER BY t.created_at LIMIT 1`,task.repository_id,task.object_number);
      if(owned&&owned.revisions>=policy.max_revisions)return;
      enqueue(this.store,task.repository_id,'development.issue',task.object_number,null,{review:result,object_hash:input.object_hash},task.source_delivery_id,task.id);
    }else{
      if(!activeTrigger(this.store,task.repository_id,'development.pr','review.published'))return;
      let owned:Row;try{owned=this.owned(github,task,input.object);}catch{return;}
      const source=this.store.get('SELECT * FROM tasks WHERE id=?',owned.source_task_id);
      if(source&&source.kind==='development.issue'&&!actionsDevelopmentAllowed(this.store,task.repository_id,source.object_number))return;
      const goal=source?JSON.parse(source.input).review?.implementation_goal:'';
      if(!goal)return;
      // A person's request is acted on whenever it comes, with no budget; each comment only once. Another bot's review is
      // acted on once per bot and pull request, so two bots cannot keep each other busy.
      const done=(r:RevisionRequest)=>!!this.store.get("SELECT 1 FROM bot_pr_requests WHERE repository_id=? AND number=? AND source_type=? AND source_id=? AND state='done'",task.repository_id,task.object_number,r.type,r.id);
      const botDone=(r:RevisionRequest)=>!!this.store.get("SELECT 1 FROM bot_pr_requests WHERE repository_id=? AND number=? AND author_id=? AND author_type='Bot' AND state='done'",task.repository_id,task.object_number,r.author_id);
      const accepted=requests.filter(r=>!done(r)&&(r.author_type!=='Bot'||!botDone(r)));
      // The bot's own findings revise the pull request after a review of a new head, within the revision budget; a review that
      // revises for a request anyway takes them along. A mention or a discussion alone never starts a revision of them.
      const taken=new Set(requests.flatMap(r=>r.findings));
      const own=result.findings.filter((f:any)=>actionableFinding(f)&&!f.requested_in&&!taken.has(f));
      const ownAllowed=accepted.length>0||!input.comment&&!input.trigger&&!!result.requires_code_change&&owned.revisions<policy.max_revisions;
      const findings=[...new Set(accepted.flatMap(r=>r.findings)),...(ownAllowed?own:[])];
      if(!findings.length)return;
      const revision=accepted.length?{source:'request',requests:accepted.map(({findings,...request})=>request)}:{source:'review'};
      const created=enqueue(this.store,task.repository_id,'development.pr',task.object_number,task.head_sha,{review:{...result,implementation_goal:goal,findings},revision},task.source_delivery_id,task.id);
      // Requests the queued revision carries are done; with another revision already queued or running they wait, and later
      // reviews of this pull request list them again (discussion_requests).
      const now=new Date().toISOString();
      for(const r of accepted)this.store.run(`INSERT INTO bot_pr_requests VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,number,source_type,source_id)
        DO UPDATE SET state=excluded.state,task_id=excluded.task_id`,task.repository_id,task.object_number,r.type,r.id,r.author,r.author_id,r.author_type,r.url,created?'done':'pending',created||null,now);
      if(!created&&accepted.length)this.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',randomId(),task.id,
        JSON.stringify({type:'revision_deferred',detail:`PR #${task.object_number} 已有排队或执行中的修订；这次的修改请求先记下，之后对这个 PR 的检视会再列出它们。`}),now);
    }
  }
  async api(user:Actor,method:string,url:URL,input:Json):Promise<Json|undefined>{
    const contractMatch=/^\/api\/tasks\/([^/]+)\/contract$/.exec(url.pathname);
    if(contractMatch&&method==='PATCH'){
      fields(input,['contract','expected_revision']);const filter=scope(user,'repository_id');
      const task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,contractMatch[1]!,...filter.args);
      if(!task)fail(404,'task_not_found');
      if(this.active.has(task!.id)||task!.status==='running')fail(409,'task_already_running');
      if(terminal.includes(task!.status)||this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",task!.id))fail(409,'task_contract_after_publication');
      if(!Number.isSafeInteger(input.expected_revision))fail(400,'invalid_task_revision');
      const records=new TaskRecords(this.store),contract={...(input.contract as any),source:{type:'human_revision',actor:user.id},completeness:'explicit'};
      records.atomic(()=>{
        try{records.contract(task!.id,contract,Number(input.expected_revision));}catch(error){fail((error as Error).message==='task_revision_changed'?409:400,(error as Error).message);}
        const saved=JSON.parse(task!.input);
        this.store.run("UPDATE tasks SET input=?,status='queued',phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,publication_started=0,error_code=NULL,next_run_at=0,attempt=attempt+1 WHERE id=?",JSON.stringify({...saved,contract,request:task!.kind==='task.request'?contract.goal:saved.request}),task!.id);
        this.store.run("DELETE FROM github_effects WHERE task_id=? AND state='pending'",task!.id);
        this.store.run('DELETE FROM development_candidates WHERE task_id=?',task!.id);
        traceEvent(this.store,task!.id,'intervention',{action:'contract_revision',before:new TaskRecords(this.store).get(task!.id).revision-1,after:contract,reason:'explicit user contract revision'},null,'user:'+user.id);
        this.store.audit(user.id,'task.contract',task!.id,task!.repository_id);
      });this.tick();return {task:new TaskRecords(this.store).get(task!.id)};
    }
    const contextMatch=/^\/api\/repositories\/([^/]+)\/context$/.exec(url.pathname);
    if(contextMatch&&(method==='GET'||method==='PATCH')){
      repository(this.store,user,contextMatch[1]!);const records=new TaskRecords(this.store);
      if(method==='GET')return {context:records.project(contextMatch[1]!)};
      fields(input,['facts','expected_revision']);
      if(!Number.isSafeInteger(input.expected_revision)||Number(input.expected_revision)<0)fail(400,'invalid_project_revision');
      try{records.setProject(contextMatch[1]!,input.facts as any,Number(input.expected_revision));}
      catch(error){fail((error as Error).message==='project_revision_changed'?409:400,(error as Error).message);}
      this.store.audit(user.id,'project.context',contextMatch[1]!,contextMatch[1]!);return {context:records.project(contextMatch[1]!)};
    }
    if(url.pathname==='/api/tasks'&&method==='POST') {
      fields(input,['repository_id','request','contract']);
      if(typeof input.repository_id!=='string'||typeof input.request!=='string'||!input.request.trim()||input.request.length>60000)fail(400,'invalid_task_request');
      repository(this.store,user,input.repository_id as string);
      const id=randomId(),now=new Date().toISOString();
      const contract=input.contract as any;
      if(!contract||!Array.isArray(contract.criteria)||!contract.criteria.length||typeof contract.endpoint!=='string'||!contract.endpoint.trim())fail(400,'invalid_task_contract');
      // Validate before insertion; rollback also removes trigger-created records on failure.
      this.store.transaction(()=>{
        this.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,created_at,updated_at) VALUES(?,?,'task.request','queued',?,?,?,?)",id,input.repository_id as string,(input.request as string).slice(0,160),JSON.stringify({request:input.request,contract}),now,now);
        try {new TaskRecords(this.store).contract(id,{...contract,source:{type:'request',actor:user.id},completeness:'explicit'});}catch{fail(400,'invalid_task_contract');}
        // Persist the authoritative validated contract for executor recovery.
        this.store.run('UPDATE tasks SET input=? WHERE id=?',JSON.stringify({request:input.request,contract:new TaskRecords(this.store).get(id).contract}),id);
        this.store.audit(user.id,'task.create',id,input.repository_id as string);
      });this.tick();return {id};
    }
    const live=/^\/api\/tasks\/([^/]+)\/live$/.exec(url.pathname);
    if(live&&method==='GET')return this.live(user,live[1]!,url);
    const match=/^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);if(!match||method!=='POST')return undefined;
    fields(input,[]);const filter=scope(user,'repository_id'),task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);
    if(!task)return fail(404,'task_not_found');
    if(this.active.has(task.id)||['queued','running','preparing','implementing','validating','publishing','result_ready'].includes(task.status))fail(409,'task_already_running');
    if(!['failed','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','waiting_pr_head','retry_wait','needs_replan'].includes(task.status))fail(409,'task_not_retryable');
    this.store.transaction(()=>{
      // A publish-phase task restarts only when re-planning it cannot strand a branch or PR it already wrote.
      const wrote=!!this.store.get("SELECT 1 FROM github_effects WHERE task_id=? AND state<>'pending'",task.id);
      if(task.kind!=='task.request'&&(replies(task.kind)&&!wrote || (task.phase!=='publish'||task.status==='needs_replan'&&!wrote)&&['failed','waiting_environment','needs_replan'].includes(task.status))){
        this.store.run("UPDATE tasks SET phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,model_started=0,review_update_cursor=0,publication_started=0,attempt=attempt+1 WHERE id=?",task.id);
        if(replies(task.kind))this.store.run("DELETE FROM github_effects WHERE task_id=? AND state='pending'",task.id);
        this.store.run('DELETE FROM development_candidates WHERE task_id=?',task.id);
      }
      // Pressing 重试 on 发布待确认 is the confirmation the pause waits for: the write is looked up once more and,
      // only if GitHub still has no trace of it, sent again.
      if(task.status==='waiting_publication')this.store.run("UPDATE github_effects SET state='recheck' WHERE task_id=? AND state IN ('unknown','inflight')",task.id);
      this.store.run("UPDATE tasks SET status='queued',error_code=NULL,next_run_at=0,retry_count=0,wait_count=0,retry_error_code=NULL,retry_cycle_started_at=NULL WHERE id=?",task.id);this.store.audit(user.id,'task.retry',task.id,task.repository_id);
    });this.tick();return {ok:true};
  }
}

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
