import { type Store, type Row } from '../storage/database.js';
import { type Manager } from '../projects/service.js';
import { randomId, fields, fail, HttpError, type Json } from '../core/security.js';
import { type Actor, scope } from '../app/auth.js';
import { GitHub } from '../github/client.js';
import { Publisher, assertOwnedPR } from '../github/publisher.js';
import { testEvidence } from '../github/text.js';
import { enqueue, developmentReady, reviewRequestsCode, sameLabel } from '../review/queue.js';
import { classificationLabels, repositoryLabels } from '../review/labels.js';
import { agentLoop } from './loop.js';
import { ReadTokens } from './read-token.js';
import { Workspace } from './workspace.js';
import { selectedModel } from './model.js';
import { clip, Redactor, sha, operationId, stop, TaskError } from './common.js';
import { RuleService, resolveRules, behaviorPath, developmentLabel, ruleErrors } from '../rules/service.js';
import { repositoryConcurrency } from '../app/settings.js';
import { type GitCache } from './git-cache.js';

const terminal=['succeeded','pr_opened','completed','cancelled','superseded'];
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
  constructor(readonly store:Store,readonly manager:Manager,readonly githubUrl?:string,readonly gitCache?:GitCache){this.rules=new RuleService(store,manager,githubUrl);}
  // The running tasks of one repository, for callers that must wait until they have stopped.
  working(repositoryId:string):Promise<void>[]{return [...this.running.get(repositoryId)||[]].map(id=>this.active.get(id)).filter((work):work is Promise<void>=>!!work);}
  start(){
    // A previous process may have stopped between checkpoints; never charge server downtime as task runtime.
    this.store.run('UPDATE task_metrics SET active_since=NULL,complete=0 WHERE active_since IS NOT NULL');
    this.store.run('DELETE FROM task_claims');
    this.store.run("UPDATE tasks SET status='queued',claim_token=NULL WHERE (kind LIKE 'review.%' OR kind LIKE 'development.%') AND status IN ('running','preparing','implementing','validating','publishing','result_ready')");
    this.store.run("UPDATE tasks SET status='waiting_pr_head',error_code='pr_head_pending',next_run_at=0 WHERE status='waiting_permission' AND error_code='bot_pr_ownership_changed' AND phase='publish' AND kind='development.pr'");
    this.timer=setInterval(()=>this.tick(),1000);this.tick();
  }
  tick(){
    if(this.closing)return;
    const checkpoint=Date.now();
    this.store.run('UPDATE task_metrics SET runtime_ms=runtime_ms+max(0,?-active_since),active_since=? WHERE active_since IS NOT NULL',checkpoint,checkpoint);
    const tasks=this.store.all(`SELECT * FROM tasks WHERE (kind LIKE 'review.%' OR kind LIKE 'development.%') AND
      status IN ('queued','retry_wait','waiting_configuration','waiting_environment','waiting_pr_head') AND next_run_at<=? ORDER BY created_at,id`,Date.now());
    const limits=new Map<string,number>();
    for(const task of tasks){
      const repo=String(task.repository_id);
      if(this.active.has(task.id)||this.clearing.has(repo))continue;
      if(!limits.has(repo))limits.set(repo,repositoryConcurrency(this.store,repo));
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
    const task=this.store.get('SELECT * FROM tasks WHERE id=?',id)!;const redactor=new Redactor();
    const log=(value:any)=>{
      const clean=redactor.clean(value);
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
      if(!policy?.enabled||task.kind.startsWith('review.')&&!policy.review_enabled||task.kind.startsWith('development.')&&!policy.development_enabled)stop('repository_policy_disabled','cancelled',`仓库 ${task.repository_id} 已停用，或已关闭 ${task.kind} 类型任务。`);
      if(task.generation){const environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);if(!environment||environment.generation!==task.generation)stop('environment_generation_changed','waiting_environment',`项目电脑 generation 已变化：任务为 ${task.generation}，当前为 ${environment?.generation??'不存在'}。`);if(!['ready','busy'].includes(environment.state))stop('environment_not_ready','waiting_environment',`项目电脑尚未就绪，当前状态=${environment.state}。`);}
    };
    const update=(values:Record<string,unknown>)=>{
      Object.assign(task,values);const keys=Object.keys(values);
      this.store.run(`UPDATE tasks SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE id=? AND claim_token=?`,...keys.map(k=>values[k] as any),new Date().toISOString(),id,token);
    };
    let workspace:Workspace|undefined;
    try{
      await guard();const config=selectedModel(this.store,task.repository_id);redactor.add(config.key);await this.share(task.repository_id);
      const repo=this.store.get('SELECT * FROM repositories WHERE id=?',task.repository_id)!;
      const github=new GitHub(this.store,repo,redactor,guard,this.githubUrl);await github.connect(task.kind.startsWith('development.'));
      let input=JSON.parse(task.input),result=task.result?JSON.parse(task.result):null;
      const development=task.kind.startsWith('development.');
      if(development&&input.review?.clarification_required)stop('review_requires_human_decision','needs_replan','检视结果要求先由人确认需求，开发任务等待重新规划。');
      const validate=async()=>{
        await guard();const current=await github.object(task.kind,task.object_number);
        if(current.state!=='open'||current.draft===true)stop('object_closed_or_draft','cancelled',`任务目标 #${task.object_number} 已关闭或变为草稿，state=${current.state}，draft=${current.draft===true}。`);
        if(task.kind.endsWith('.pr')){
          if(development)this.owned(github,task,current);
          const candidateRow=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),candidate=candidateRow?JSON.parse(candidateRow.data):null;
          if(current.head?.sha!==task.head_sha&&!(development&&candidate?.remote_sha===current.head?.sha)){
            this.store.transaction(()=>enqueue(this.store,task.repository_id,'review.pr',task.object_number,current.head.sha,{pull_request:current,number:task.object_number}));
            stop('pull_request_head_changed','superseded',`PR #${task.object_number} 的 head 已变化：预期 ${task.head_sha}，当前 ${current.head?.sha}。`);
          }
        }else if(development&&input.object_hash&&sha(JSON.stringify([current.title,current.body]))!==input.object_hash)stop('issue_needs_replan','needs_replan',`Issue #${task.object_number} 的标题或正文已变化，需要重新规划。`);
        // The go-ahead must still hold until publication: the label stays on and nobody else has taken the Issue.
        if(task.kind==='development.issue'&&!developmentReady(current,this.label(task)))stop('development_not_approved','needs_replan',`Issue #${task.object_number} 不再满足开发条件：开发标签缺失或已有人接手。`);
        if(development){
          const saved=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),candidate=saved?JSON.parse(saved.data):null;
          if(candidate&&!candidate.pr_number&&(await github.ref(candidate.base_branch))?.object?.sha!==candidate.base_sha)stop('base_branch_changed','needs_replan',`基础分支 ${candidate.base_branch} 已偏离提交 ${candidate.base_sha}，需要重新规划。`);
          if(input.bot_pr){
            const pr=await github.object('review.pr',input.bot_pr.number),owned=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,pr.number);
            assertOwnedPR(owned,pr,github.actorId,task.repository_id);
            if(pr.state!=='open'||pr.draft===true)stop('object_closed_or_draft','cancelled',`PR #${pr.number} 已关闭或变为草稿，state=${pr.state}，draft=${pr.draft===true}。`);
            if(pr.head.sha!==task.head_sha&&pr.head.sha!==candidate?.remote_sha)stop('pull_request_head_changed','superseded',`PR #${pr.number} 的 head 已变化：任务提交 ${task.head_sha}，当前 ${pr.head.sha}。`);
          }
        }
      };
      workspace=new Workspace(this.store,this.manager,task,redactor,guard,log);
      const publishDevelopment=async()=>{
        update({status:'publishing'});log({type:'phase',phase:'publish',target:'pull_request',detail:'正在发布到 GitHub：创建或更新 PR…'});
        const publisher=new Publisher(this.store,github,task,validate,undefined,log);
        const candidate=JSON.parse(this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id)!.data);
        const commit=await publisher.branch(candidate),pr=await publisher.pullRequest(candidate,commit);
        log({type:'published',outputs:[{html_url:pr.html_url,branch:candidate.branch,sha:commit}]});
        await publisher.discussion('development-result',`Implemented in ${pr.html_url}\n\n${candidate.summary}\n\n${testEvidence(candidate)}\nCommit: ${commit}`);
        update({result:JSON.stringify({summary:candidate.summary,test_command:candidate.test_command,pr_number:pr.number,pr_url:pr.html_url,branch:candidate.branch,sha:commit,tree_sha:candidate.published_tree_sha||candidate.tree_sha,local_sha:candidate.local_sha,validation:candidate.validation}),phase:'done',status:pr.number===candidate.pr_number?'completed':'pr_opened',error_code:null});
        return {pr:{number:pr.number,html_url:pr.html_url,sha:commit}};
      };
      if(task.phase==='prepare'){
        let environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);
        if(!environment){environment=await this.manager.call('PUT','/v1/projects/'+task.repository_id);this.granted.delete(task.repository_id);await this.share(task.repository_id);}
        if(!['ready','busy'].includes(environment.state))stop('environment_not_ready','waiting_environment',`准备工作区时项目电脑尚未就绪，当前状态=${environment.state}。`);
        update({generation:environment.generation,workspace_id:task.workspace_id||randomId()});
        const object=await github.object(task.kind,task.object_number);await validate();
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
        const mirror=this.gitCache&&github.cloneUrl?await this.gitCache.open(task.repository_id,{url:github.cloneUrl,token:github.token,commits:[ref.object.sha,ruleSha],
          refs:[task.kind.endsWith('.pr')?`refs/pull/${task.object_number}/head`:`refs/heads/${input.bot_pr?.head?.ref||baseBranch}`,...(ruleBranch?[`refs/heads/${ruleBranch}`]:[])]}):undefined;
        // Rules are checked before the workspace is written. A bad rule file waits for a person with its own code and
        // nothing is published; the retry after the fix then prepares the new commit without earlier writes in the way.
        let effectiveRules:ReturnType<typeof resolveRules>;
        try{
          const ruleFiles=await this.rules.fetch(github,ruleSha,mirror);
          this.rules.cache(task.repository_id,ruleSha,ruleFiles);
          effectiveRules=resolveRules(policy,ruleFiles,this.rules.consoleComputer(task.repository_id,environment.computer));
        }catch(error){
          if(error instanceof HttpError&&ruleErrors.has(error.code))stop(error.code,'waiting_configuration',`加载仓库行为规则失败（${error.code}），请检查 .bot/ 和 .agents/skills/ 配置。`);
          throw error;
        }
        const snapshot=await workspace.prepare(github,ref.object.sha,mirror);
        const files=task.kind.endsWith('.pr')?await github.pages(github.path(`/pulls/${task.object_number}/files`)):[];
        if(files.length>=3000)stop('pull_request_file_limit','waiting_environment',`PR #${task.object_number} 返回 ${files.length} 个文件，已达到 GitHub 的 3000 文件列表上限，无法确认完整差异。`);
        if(Object.entries(effectiveRules.computer).some(([key,value])=>JSON.stringify(environment.computer?.[key])!==JSON.stringify(value))){
          this.rules.rememberComputer(task.repository_id,environment.computer);
          environment=await this.manager.call('POST',`/v1/projects/${task.repository_id}/configure`,{operation_id:randomId(),generation:environment.generation,request:redactor.clean(effectiveRules.computer)},35*60000);
          environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);
        }
        const comments=await github.pages(github.path(`/issues/${task.object_number}/comments`));
        // Classification is optional: a repository whose labels cannot be read is reviewed without them.
        const labels=development?[]:await github.pages(github.path('/labels')).then(repositoryLabels,error=>{if(error instanceof TaskError&&error.code.startsWith('github_permission_'))return [];throw error;});
        input={...input,object,object_hash:sha(JSON.stringify([object.title,object.body])),base_branch:baseBranch,snapshot_sha:ref.object.sha,snapshot_tree:snapshot.tree_sha,
          source_tree:snapshot.source_tree_sha,snapshot_files:snapshot.files,skipped_files:snapshot.skipped_files,
          files,coverage:snapshot.coverage,review_label:effectiveRules.review_label,development_label:effectiveRules.development_label,repository_labels:labels,behavior_changes:files.filter((f:any)=>behaviorPath(f.filename)||f.previous_filename&&behaviorPath(f.previous_filename)).map((f:any)=>f.filename),context:{mode:development?'development':'review',repository:github.fullName,reviewed_sha:ref.object.sha,object,implementation_goal:implementationGoal,actionable_findings:actionableFindings,review:development&&task.kind.endsWith('.pr')?null:input.review||null,effective_rules:effectiveRules,
            comments:development&&task.kind.endsWith('.pr')?[]:comments.slice(-50),files,materials:snapshot.materials,coverage:[...snapshot.coverage,...(comments.length>50?['Discussion context limited to latest 50 comments']:[])],required_test_command:policy.test_command||null,
            review_rules:{language:policy.review_language},...(development?{}:{repository_labels:labels}),
            // What the project computer offers: limits, installed toolchain and packages, variable names (not values).
            computer:computerSummary(environment.computer)}};
        update({input:JSON.stringify(redactor.clean(input)),head_sha:task.head_sha||ref.object.sha,phase:'model'});await validate();log({type:'prepared',sha:ref.object.sha,coverage:input.coverage});
      }
      if(task.phase==='validate')stop('create_pull_request_required','needs_replan','任务停在 validate 阶段，需要重新规划并通过 create_pull_request 提交候选修改。');
      if(task.phase==='model'){
        log({type:'phase',phase:'model',mode:development?'development':'review',detail:`Agent 开始执行：${development?'开发':'检视'}…`});
        result=await agentLoop(this.store,task,workspace,redactor,guard,input.context,new ReadTokens(this.store,repo,redactor,guard,this.githubUrl),development?async(requestId,args)=>{
          // Fix the only candidate snapshot before any policy command can create or modify files.
          const snapshot=await workspace!.artifact('create-pr:'+requestId+':snapshot');
          if(snapshot.tree_sha===input.snapshot_tree){
            update({result:JSON.stringify({...args,status:'no_changes'}),phase:'done',status:'completed',error_code:null});
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
          if(task.kind==='development.pr'||input.bot_pr){
            const pr=input.bot_pr||input.object,owned=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,pr.number);
            assertOwnedPR(owned,pr,github.actorId,task.repository_id);branch=owned!.branch;prNumber=owned!.number;ownerTask=owned!.source_task_id;
          }else{branch=`bot/issue-${task.object_number}-${id}`;this.store.run('INSERT INTO bot_branches VALUES(?,?,?) ON CONFLICT DO NOTHING',task.repository_id,branch,id);}
          const candidate={...snapshot,files:await workspace!.contents(snapshot.files,input.snapshot_files),source_tree:input.source_tree,snapshot_files:input.snapshot_files,skipped_files:input.skipped_files,summary:args.summary,change_title:args.change_title,test_command:args.test_command,
            implementation_goal:input.context.implementation_goal,base_sha:input.snapshot_sha,base_branch:input.base_branch,
            branch,owner_task_id:ownerTask,expected_sha:prNumber?task.head_sha:null,pr_number:prNumber,date:new Date(task.created_at).toISOString(),validation};
          this.store.run('INSERT INTO development_candidates VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data',id,JSON.stringify(candidate));
          update({result:JSON.stringify(args),phase:'publish'});
          return publishDevelopment();
        }:undefined);await validate();
        if(!development){
          if(input.behavior_changes?.length){result.summary+='\n\n这些文件改变了 bot 的行为，需要人来决定：'+input.behavior_changes.join('、');result.clarification_required=true;}
          result={...result,findings:result.findings.map((finding:any,index:number)=>({...finding,id:operationId(id+':finding:'+index)})),reviewed_sha:task.head_sha,coverage:input.coverage,object_hash:input.object_hash};
          update({result:JSON.stringify(result),phase:'publish'});
        }else if(task.phase!=='done')stop('create_pull_request_required',undefined,`开发执行结束时仍处于 ${task.phase} 阶段，未完成 create_pull_request。`);
      }
      if(task.phase==='publish'){
        update({status:'publishing'});const publisher=new Publisher(this.store,github,task,validate,undefined,log);
        if(!development){
          log({type:'phase',phase:'publish',target:'review',detail:'正在发布到 GitHub：发送检视评论…'});
          const outputs=await publisher.review(result,input.files);
          // Labels go on only after the summary comment was published: the policy's review label, plus the classification
          // labels the model named that pass classificationLabels against the repository and the object's current labels.
          const label=input.review_label,current=(await github.object(task.kind,task.object_number)).labels;
          const names=[...(label?[label]:[]),...classificationLabels(result.labels,input.repository_labels,current,[label,input.development_label])];
          if(names.length)outputs.push({labels:(await publisher.labels(names)).map((l:any)=>l.name)});
          log({type:'published',outputs:outputs.map((o:any)=>o.labels?{labels:o.labels}:{html_url:o.html_url,inline_comments:o.inline_comments?.length||0})});
          result={...result,outputs};
          // A review that finds a code request starts development only with a person's go-ahead already on the Issue;
          // otherwise the labeled webhook starts it later. A failed check counts as no go-ahead.
          const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
          let approved=false;
          if(task.kind==='review.issue'&&policy?.development_enabled&&reviewRequestsCode(input.object,result)){
            approved=await this.developmentApproved(github,task).catch(()=>false);
            if(!approved)log({type:'development_waiting_for_label'});
          }
          this.store.transaction(()=>{
            update({result:JSON.stringify(result),phase:'done',status:'succeeded',error_code:null});
            this.queueDevelopment(github,task,input,result,approved);
          });
        }
        else await publishDevelopment();
      }
      await this.release(workspace,task);log({type:'completed',status:task.status});
    }catch(error){
      if(!(error instanceof TaskError))log({type:'runtime_fault',message:redactor.text(String((error as Error)?.message||'runtime failure')).slice(0,2000)});
      await this.release(workspace,task);
      const failure=error instanceof TaskError?error:new TaskError('task_runtime_failure',String((error as Error)?.message).includes('manager')?'waiting_environment':'failed',`任务在 ${task.phase} 阶段发生运行异常，请查看此前的运行错误日志。`);
      const current=this.store.get('SELECT * FROM tasks WHERE id=?',id);
      const retries=Number(current?.retry_count||0)+(failure.state==='retry_wait'?1:0),state=failure.state==='retry_wait'&&retries>=5?'failed':failure.state;
      const delay=failure.code==='github_rate_limited'?(failure.retryAfterMs??60000):state==='waiting_configuration'?30000:5000;
      if(current?.claim_token===token&&!['cancelled','superseded'].includes(current.status))update({status:state,error_code:failure.code,retry_count:retries,next_run_at:Date.now()+delay});
      if(failure.code==='execution_interrupted'&&task.phase!=='publish'&&task.attempt<3){
        log({type:'restart_attempt',preserved_workspace:task.workspace_id});
        update({phase:'prepare',workspace_id:null,generation:null,messages:null,result:null,attempt:task.attempt+1});
      }
      // Waiting conditions can be polled every five seconds; retain one copy of an unchanged reason.
      const previous=this.store.get("SELECT content FROM task_logs WHERE task_id=? AND json_valid(content) AND json_extract(content,'$.type')='fault' ORDER BY rowid DESC LIMIT 1",id);
      const last=previous?JSON.parse(previous.content):null,detail=redactor.clean(failure.detail);
      if(current?.error_code!==failure.code||last?.code!==failure.code||(last?.detail_sha||sha(last?.detail||''))!==sha(detail||''))
        log({type:'fault',state:failure.state,code:failure.code,...(detail?{detail,detail_sha:sha(detail)}:{})});
    }
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
  label(task:Row){try{return developmentLabel(this.store,task.repository_id);}catch(error){return stop(error instanceof HttpError&&ruleErrors.has(error.code)?error.code:'invalid_bot_label','waiting_configuration',`仓库 ${task.repository_id} 的开发标签配置无效，请检查行为规则。`);}}
  // The latest time the development label was added must be by a user account, not an app, and nobody may be assigned.
  async developmentApproved(github:GitHub,task:Row){
    const label=this.label(task);
    if(!developmentReady(await github.object(task.kind,task.object_number),label))return false;
    const events=await github.pages(github.path(`/issues/${task.object_number}/events`));
    return events.filter((e:any)=>e.event==='labeled'&&sameLabel(e.label?.name,label)).at(-1)?.actor?.type==='User';
  }
  queueDevelopment(github:GitHub,task:Row,input:any,result:any,approved=false){
    const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
    if(!policy?.enabled||!policy.development_enabled||!result.requires_code_change||result.clarification_required)return;
    if(task.kind==='review.issue'){
      if(!approved||!reviewRequestsCode(input.object,result))return;
      enqueue(this.store,task.repository_id,'development.issue',task.object_number,null,{review:result,object_hash:input.object_hash},task.source_delivery_id,task.id);
    }else{
      let owned:Row;try{owned=this.owned(github,task,input.object);}catch{return;}
      const findings=result.findings.filter(actionableFinding);
      const source=this.store.get('SELECT input FROM tasks WHERE id=?',owned.source_task_id),goal=source?JSON.parse(source.input).review?.implementation_goal:'';
      if(owned.revisions>=policy.max_revisions||!findings.length||!goal)return;
      enqueue(this.store,task.repository_id,'development.pr',task.object_number,task.head_sha,{review:{...result,implementation_goal:goal,findings}},task.source_delivery_id,task.id);
    }
  }
  async api(user:Actor,method:string,url:URL,input:Json):Promise<Json|undefined>{
    const live=/^\/api\/tasks\/([^/]+)\/live$/.exec(url.pathname);
    if(live&&method==='GET')return this.live(user,live[1]!,url);
    const match=/^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);if(!match||method!=='POST')return undefined;
    fields(input,[]);const filter=scope(user,'repository_id'),task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);
    if(!task)return fail(404,'task_not_found');
    if(this.active.has(task.id)||['queued','running','preparing','implementing','validating','publishing','result_ready'].includes(task.status))fail(409,'task_already_running');
    if(!['failed','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','waiting_pr_head','retry_wait','needs_replan'].includes(task.status))fail(409,'task_not_retryable');
    this.store.transaction(()=>{
      if(task.phase!=='publish'&&['failed','waiting_environment','needs_replan'].includes(task.status)){
        this.store.run("UPDATE tasks SET phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,attempt=attempt+1 WHERE id=?",task.id);
        this.store.run('DELETE FROM development_candidates WHERE task_id=?',task.id);
      }
      this.store.run("UPDATE tasks SET status='queued',error_code=NULL,next_run_at=0,retry_count=0 WHERE id=?",task.id);this.store.audit(user.id,'task.retry',task.id,task.repository_id);
    });this.tick();return {ok:true};
  }
}

export const actionableFinding=(finding:any)=>finding.actionable===true&&finding.within_goal===true&&finding.requires_human_decision===false;
