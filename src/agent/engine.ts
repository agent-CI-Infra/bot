import { type Store, type Row } from '../storage/database.js';
import { type Manager } from '../projects/service.js';
import { randomId, fields, fail, type Json } from '../core/security.js';
import { type Actor, scope } from '../app/auth.js';
import { GitHub } from '../github/client.js';
import { Publisher } from '../github/publisher.js';
import { enqueue } from '../review/queue.js';
import { agentLoop } from './loop.js';
import { Workspace } from './workspace.js';
import { selectedModel } from './model.js';
import { Redactor, sha, operationId, stop, TaskError } from './common.js';

const terminal=['succeeded','pr_opened','completed','cancelled','superseded'];
export class TaskEngine {
  readonly active=new Map<string,Promise<void>>();private timer:ReturnType<typeof setInterval>|undefined;private closing=false;
  constructor(readonly store:Store,readonly manager:Manager,readonly githubUrl?:string){}
  start(){
    this.store.run("UPDATE task_locks SET task_id=NULL,token=NULL");
    this.store.run("UPDATE tasks SET status='queued',claim_token=NULL WHERE (kind LIKE 'review.%' OR kind LIKE 'development.%') AND status IN ('running','preparing','implementing','validating','publishing','result_ready')");
    this.timer=setInterval(()=>this.tick(),1000);this.tick();
  }
  tick(){
    if(this.closing)return;
    const tasks=this.store.all(`SELECT * FROM tasks WHERE (kind LIKE 'review.%' OR kind LIKE 'development.%') AND
      status IN ('queued','retry_wait','waiting_configuration','waiting_environment') AND next_run_at<=? ORDER BY created_at,id`,Date.now());
    for(const task of tasks){
      if(this.active.has(task.repository_id))continue;
      const token=randomId();
      this.store.transaction(()=>{
        this.store.run('INSERT INTO task_locks(repository_id) VALUES(?) ON CONFLICT DO NOTHING',task.repository_id);
        this.store.run('UPDATE task_locks SET task_id=?,token=?,fence=fence+1 WHERE repository_id=?',task.id,token,task.repository_id);
        this.store.run("UPDATE tasks SET claim_token=?,status='running',updated_at=? WHERE id=?",token,new Date().toISOString(),task.id);
      });
      const work=this.run(task.id,token).finally(()=>{
        this.store.run('UPDATE task_locks SET task_id=NULL,token=NULL WHERE repository_id=? AND token=?',task.repository_id,token);this.active.delete(task.repository_id);
      });this.active.set(task.repository_id,work);
    }
  }
  async close(){this.closing=true;if(this.timer)clearInterval(this.timer);await Promise.allSettled(this.active.values());}
  async run(id:string,token:string){
    const task=this.store.get('SELECT * FROM tasks WHERE id=?',id)!;const redactor=new Redactor();
    const log=(value:unknown)=>this.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)',randomId(),id,JSON.stringify(redactor.clean(value)).slice(0,70000),new Date().toISOString());
    const guard=async()=>{
      const current=this.store.get('SELECT * FROM tasks WHERE id=?',id),lock=this.store.get('SELECT * FROM task_locks WHERE repository_id=?',task.repository_id);
      if(current?.claim_token!==token||lock?.token!==token||['cancelled','superseded'].includes(current.status))stop('task_claim_revoked','cancelled');
      const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
      if(!policy?.enabled||task.kind.startsWith('review.')&&!policy.review_enabled||task.kind.startsWith('development.')&&!policy.development_enabled)stop('repository_policy_disabled','cancelled');
      if(task.generation){const environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);if(!environment||environment.generation!==task.generation)stop('environment_generation_changed','waiting_environment');if(!['ready','busy'].includes(environment.state))stop('environment_not_ready','waiting_environment');}
    };
    const update=(values:Record<string,unknown>)=>{
      Object.assign(task,values);const keys=Object.keys(values);
      this.store.run(`UPDATE tasks SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE id=? AND claim_token=?`,...keys.map(k=>values[k] as any),new Date().toISOString(),id,token);
    };
    try{
      await guard();const config=selectedModel(this.store,task.repository_id);redactor.add(config.key);
      const repo=this.store.get('SELECT * FROM repositories WHERE id=?',task.repository_id)!;
      const github=new GitHub(this.store,repo,redactor,guard,this.githubUrl);await github.connect(task.kind.startsWith('development.'));
      let input=JSON.parse(task.input),result=task.result?JSON.parse(task.result):null;
      const development=task.kind.startsWith('development.');
      const validate=async()=>{
        await guard();const current=await github.object(task.kind,task.object_number);
        if(current.state!=='open'||current.draft===true)stop('object_closed_or_draft','cancelled');
        if(task.kind.endsWith('.pr')){
          const candidateRow=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),candidate=candidateRow?JSON.parse(candidateRow.data):null;
          if(current.head?.sha!==task.head_sha&&!(development&&candidate?.remote_sha===current.head?.sha)){
            this.store.transaction(()=>enqueue(this.store,task.repository_id,'review.pr',task.object_number,current.head.sha,{pull_request:current,number:task.object_number}));
            stop('pull_request_head_changed','superseded');
          }
          if(development)this.owned(github,task,current);
        }else if(development&&input.object_hash&&sha(JSON.stringify([current.title,current.body]))!==input.object_hash)stop('issue_needs_replan','needs_replan');
        if(development){
          const saved=this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id),candidate=saved?JSON.parse(saved.data):null;
          if(candidate&&!candidate.pr_number&&(await github.ref(candidate.base_branch))?.object?.sha!==candidate.base_sha)stop('base_branch_changed','needs_replan');
        }
      };
      const workspace=new Workspace(this.store,this.manager,task,redactor,guard,log);
      if(task.phase==='prepare'){
        let environment=await this.manager.call('GET','/v1/projects/'+task.repository_id);
        if(!environment)environment=await this.manager.call('PUT','/v1/projects/'+task.repository_id);
        if(!['ready','busy'].includes(environment.state))stop('environment_not_ready','waiting_environment');
        update({generation:environment.generation,workspace_id:task.workspace_id||randomId()});
        const object=await github.object(task.kind,task.object_number);await validate();
        const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id)!;
        const baseBranch=policy.base_branch||github.defaultBranch;
        const ref=task.kind.endsWith('.pr')?{object:{sha:task.head_sha}}:await github.ref(baseBranch);
        if(!ref?.object?.sha)stop('repository_has_no_commit','waiting_configuration');
        if(development&&task.kind.endsWith('.pr')){
          const owned=this.owned(github,task,object);
          if(owned.sha!==task.head_sha){const compare=await github.request('GET',github.path('/compare/'+owned.sha+'...'+task.head_sha));if(!['ahead','identical'].includes(compare.status))stop('bot_branch_history_changed','needs_replan');}
        }
        const snapshot=await workspace.prepare(github,ref.object.sha);
        const files=task.kind.endsWith('.pr')?await github.pages(github.path(`/pulls/${task.object_number}/files`)):[];
        if(files.length>=3000)stop('pull_request_file_limit','waiting_environment');
        const comments=await github.pages(github.path(`/issues/${task.object_number}/comments`));
        input={...input,object,object_hash:sha(JSON.stringify([object.title,object.body])),base_branch:baseBranch,snapshot_sha:ref.object.sha,snapshot_tree:snapshot.tree_sha,
          files,coverage:snapshot.coverage,context:{mode:development?'development':'review',repository:github.fullName,reviewed_sha:ref.object.sha,object,review:input.review||null,
            comments:comments.slice(-50),files,materials:snapshot.materials,coverage:[...snapshot.coverage,...(comments.length>50?['Discussion context limited to latest 50 comments']:[])],required_test_command:policy.test_command||null}};
        update({input:JSON.stringify(redactor.clean(input)),head_sha:task.head_sha||ref.object.sha,phase:'model'});await validate();log({type:'prepared',sha:ref.object.sha,coverage:input.coverage});
      }
      if(task.phase==='model'){
        result=await agentLoop(this.store,task,workspace,redactor,guard,input.context);await validate();
        if(!development){
          result={...result,findings:result.findings.map((finding:any,index:number)=>({...finding,id:operationId(id+':finding:'+index)})),reviewed_sha:task.head_sha,coverage:input.coverage,object_hash:input.object_hash};
          update({result:JSON.stringify(result),phase:'publish'});
        }else update({result:JSON.stringify(result),phase:'validate'});
      }
      if(task.phase==='validate'){
        const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id)!;
        const command=policy.test_command||result.test_command;if(typeof command!=='string'||!command.trim())stop('test_command_missing','waiting_configuration');
        const before=await workspace.artifact('validate:before');
        const validation=await workspace.call('validate:tests',{type:'workspace_command',command,timeout_ms:60000});
        if(validation.error||validation.exit_code!==0||validation.timed_out||validation.truncated)stop('validation_failed');
        const after=await workspace.artifact('validate:after');if(before.tree_sha!==after.tree_sha)stop('tests_changed_candidate');
        if(after.tree_sha===input.snapshot_tree)stop('development_has_no_changes');
        let branch:string,ownerTask=id,prNumber:number|null=null;
        if(task.kind==='development.pr'){const owned=this.owned(github,task,input.object);branch=owned.branch;prNumber=owned.number;ownerTask=owned.source_task_id;}
        else{branch=`bot/issue-${task.object_number}-${id}`;this.store.run('INSERT INTO bot_branches VALUES(?,?,?) ON CONFLICT DO NOTHING',task.repository_id,branch,id);}
        const candidate={...after,files:await workspace.contents(after.files),summary:result.summary,base_sha:input.snapshot_sha,base_branch:input.base_branch,
          branch,owner_task_id:ownerTask,expected_sha:prNumber?task.head_sha:null,pr_number:prNumber,date:new Date(task.created_at).toISOString(),validation:{...validation,command}};
        this.store.run('INSERT INTO development_candidates VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data',id,JSON.stringify(candidate));update({phase:'publish'});
      }
      if(task.phase==='publish'){
        update({status:'publishing'});const publisher=new Publisher(this.store,github,task,validate);
        if(!development){
          const outputs=await publisher.review(result,input.files);
          // The policy label, never the model, is applied only after the summary comment was published.
          const label=this.store.get('SELECT review_label FROM policies WHERE repository_id=?',task.repository_id)?.review_label;
          if(label)outputs.push({labels:(await publisher.label(label)).map((l:any)=>l.name)});
          log({type:'published',outputs:outputs.map((o:any)=>o.labels?{labels:o.labels}:{html_url:o.html_url,inline_comments:o.inline_comments?.length||0})});
          result={...result,outputs};
          this.store.transaction(()=>{
            update({result:JSON.stringify(result),phase:'done',status:'succeeded',error_code:null});
            this.queueDevelopment(github,task,input,result);
          });
        }
        else{
          const candidate=JSON.parse(this.store.get('SELECT data FROM development_candidates WHERE task_id=?',id)!.data);
          const commit=await publisher.branch(candidate),pr=await publisher.pullRequest(candidate,commit);
          log({type:'published',outputs:[{html_url:pr.html_url,branch:candidate.branch,sha:commit}]});
          await publisher.discussion('development-result',`Implemented in ${pr.html_url}\n\n${candidate.summary}\n\nTests: ${candidate.validation.command}\nExit code: ${candidate.validation.exit_code}\nCommit: ${commit}`);
          update({result:JSON.stringify({summary:candidate.summary,pr_number:pr.number,pr_url:pr.html_url,branch:candidate.branch,sha:commit,tree_sha:candidate.tree_sha,local_sha:candidate.local_sha,validation:candidate.validation}),phase:'done',status:pr.number===candidate.pr_number?'completed':'pr_opened',error_code:null});
        }
      }
      log({type:'completed',status:task.status});
    }catch(error){
      if(!(error instanceof TaskError))log({type:'runtime_fault',message:redactor.text(String((error as Error)?.message||'runtime failure')).slice(0,2000)});
      const failure=error instanceof TaskError?error:new TaskError('task_runtime_failure',String((error as Error)?.message).includes('manager')?'waiting_environment':'failed');
      const current=this.store.get('SELECT * FROM tasks WHERE id=?',id);
      const retries=Number(current?.retry_count||0)+(failure.state==='retry_wait'?1:0),state=failure.state==='retry_wait'&&retries>=5?'failed':failure.state;
      if(current?.claim_token===token&&!['cancelled','superseded'].includes(current.status))update({status:state,error_code:failure.code,retry_count:retries,next_run_at:Date.now()+(state==='waiting_configuration'?30000:5000)});
      if(failure.code==='execution_interrupted'&&task.phase!=='publish'&&task.attempt<3){
        log({type:'restart_attempt',preserved_workspace:task.workspace_id});
        update({phase:'prepare',workspace_id:null,generation:null,messages:null,result:null,attempt:task.attempt+1});
      }
      log({type:'fault',state:failure.state,code:failure.code});
    }
  }
  owned(github:GitHub,task:Row,pr:any):Row{
    const row=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',task.repository_id,task.object_number);
    if(!row||row.pr_id!==String(pr.id)||row.author_id!==String(pr.user?.id)||row.author_id!==github.actorId||row.head_repository_id!==String(pr.head?.repo?.id)||row.head_repository_id!==task.repository_id||row.branch!==pr.head?.ref) return stop('pull_request_not_owned','waiting_permission');
    return row;
  }
  queueDevelopment(github:GitHub,task:Row,input:any,result:any){
    const policy=this.store.get('SELECT * FROM policies WHERE repository_id=?',task.repository_id);
    if(!policy?.enabled||!policy.development_enabled||!result.requires_code_change||result.clarification_required||!result.implementation_goal.trim())return;
    if(task.kind==='review.issue'){
      const text=String(input.object.title)+'\n'+String(input.object.body||'');
      if(!result.issue_requests_code||!result.request_quote.trim()||!text.includes(result.request_quote))return;
      enqueue(this.store,task.repository_id,'development.issue',task.object_number,null,{review:result,object_hash:input.object_hash},task.source_delivery_id,task.id);
    }else{
      let owned:Row;try{owned=this.owned(github,task,input.object);}catch{return;}
      if(owned.revisions>=policy.max_revisions||!result.findings.length)return;
      enqueue(this.store,task.repository_id,'development.pr',task.object_number,task.head_sha,{review:result},task.source_delivery_id,task.id);
    }
  }
  api(user:Actor,method:string,url:URL,input:Json):Json|undefined{
    const match=/^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);if(!match||method!=='POST')return undefined;
    fields(input,[]);const filter=scope(user,'repository_id'),task=this.store.get(`SELECT * FROM tasks WHERE id=? AND ${filter.sql}`,match[1]!,...filter.args);
    if(!task)return fail(404,'task_not_found');
    if(!['failed','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','retry_wait','needs_replan'].includes(task.status)||this.active.has(task.repository_id))fail(409,'task_not_retryable');
    this.store.transaction(()=>{
      if(task.phase!=='publish'&&['failed','waiting_environment','needs_replan'].includes(task.status)){
        this.store.run("UPDATE tasks SET phase='prepare',workspace_id=NULL,generation=NULL,messages=NULL,result=NULL,attempt=attempt+1 WHERE id=?",task.id);
        this.store.run('DELETE FROM development_candidates WHERE task_id=?',task.id);
      }
      this.store.run("UPDATE tasks SET status='queued',error_code=NULL,next_run_at=0,retry_count=0 WHERE id=?",task.id);this.store.audit(user.id,'task.retry',task.id,task.repository_id);
    });this.tick();return {ok:true};
  }
}
