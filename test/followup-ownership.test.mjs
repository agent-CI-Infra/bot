import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {validateFollowupPlan,followupExecutor} from '../dist/tasks/followups.js';
import {systemInstructions} from '../dist/roles/pool.js';

// #710: a review residual must not become work that changes someone else's issue or pull request. The PR #416 case: a
// contributor's fork branch (maintainers may not edit it) fell behind main; QA left that as a nonblocking residual.
const residual={key:'pr416-branch-head-stale',description:'The PR branch is 221 commits behind main and its body describes results on main',evidence:'git rev-list --count HEAD..origin/main: 221',impact:'The reported results do not describe the branch itself',nonblocking_reason:'The rebase merge queue runs the checks on the latest main',goal:'Land the two guarding assertions on the PR branch and report it accurately',criteria:['The PR branch carries the assertions and its body reports branch results']};
const verdict={outcome:'pass_with_issues',reason:'The review is complete and evidenced',gaps:[],residuals:[residual],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
const author={id:4160,login:'HugoXK'},maintainer={id:1,login:'maintainer'};
const pullRequest=(extra={})=>({number:416,title:'Explain why a role was chosen',body:'Adds role reasons to the console.',state:'open',merged:false,user:author,
 head:{sha:'a'.repeat(40),ref:'lp/lead/229-role-reasons',repo:{full_name:'HugoXK/bot',fork:true}},maintainer_can_modify:false,...extra});
const item=(extra={})=>({key:residual.key,priority:'P2',reason:'The branch should carry the guarding assertions',evidence_refs:[residual.evidence],action:'new',needs:[],...extra});

function fixture(t,{kind='review.pr',number=416,input={action:'opened',pull_request:pullRequest()}}={}){
 const s=new Store(':memory:',Buffer.alloc(32,9));t.after(()=>s.close());
 s.run("INSERT INTO accounts VALUES('a','test','bot_account',NULL,'{}','now')");s.run("INSERT INTO repositories VALUES('r','fixture/repo','o','a')");
 s.run("INSERT INTO policies(repository_id,enabled) VALUES('r',1)");
 s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at) VALUES('parent','r',?,'running','parent',?,?,?,'2026-11-11T19:51:00Z','2026-11-11T19:51:00Z')",
  kind,JSON.stringify(input),kind==='task.request'?null:number,kind.endsWith('.pr')?'a'.repeat(40):null);
 const records=new TaskRecords(s);
 records.contract('parent',{goal:'Review the pull request',scope:[kind],criteria:['Findings carry evidence'],endpoint:'report',source:{}});
 const candidate=records.submit('parent',[{kind:'report',reference:'task:parent:candidate',version:'v1',content:{summary:'Reviewed with evidence',findings:[]}}],[],{});
 const task=()=>s.get("SELECT * FROM tasks WHERE id='parent'");
 // A Manager plan goes through the same validation as submit_followup_plan; framework-default plans are stored as they are.
 const plan=(items,ref='manager:run')=>s.run('INSERT INTO task_followup_plans VALUES(?,?,?,?,?,?)','parent',candidate.id,candidate.revision,
  JSON.stringify(ref.startsWith('framework:')?items:validateFollowupPlan(s,task(),candidate,verdict.residuals,{items})),ref,'now');
 const decide=()=>records.decide('parent',candidate.id,candidate.revision,verdict);
 const refusals=()=>s.all("SELECT data FROM task_history WHERE task_id='parent' AND type='followup_refused'").map(row=>JSON.parse(row.data));
 const tasks=()=>s.get('SELECT count(*) n FROM tasks').n;
 return {s,plan,decide,refusals,tasks};
}

test('the #416 follow-up that would change a contributor fork PR is refused with its reasons, and the residual stays a suggestion',t=>{
 const f=fixture(t);
 // The plan the Manager made: new work for dev, which needs file edits and commands; no target means the reviewed PR.
 f.plan([item({needs:['edit_files','run_commands']})]);
 const accepted=f.decide();
 assert.deepEqual(accepted.followups,[]);assert.equal(accepted.outcome,'pass_with_issues');assert.deepEqual(accepted.residuals,[residual]);
 assert.equal(f.tasks(),1);assert.equal(f.s.get('SELECT count(*) n FROM task_relations').n,0);
 const [refusal]=f.refusals();
 assert.equal(refusal.residual_key,residual.key);
 assert.deepEqual(refusal.reasons.map(r=>r.code),['followup_others_work','followup_executor_unauthorized']);
 assert.match(refusal.reasons[0].detail,/pull request #416 was opened by @HugoXK, not the bot/);
 // task.request does not write code by default, so dev could never finish it.
 assert.match(refusal.reasons[1].detail,/cannot edit_files/);
});

test('the framework default plan (Manager unavailable) cannot create work on someone else\'s PR either',t=>{
 const f=fixture(t);
 f.plan([{key:residual.key,priority:'P2',action:'new',reason:'Default P2 pending Task Manager assessment',evidence_refs:[residual.evidence]}],'framework:default-P2');
 assert.deepEqual(f.decide().followups,[]);
 assert.deepEqual(f.refusals()[0].reasons.map(r=>r.code),['followup_others_work']);
});

test('an explicit request the PR author wrote in the PR allows the follow-up; quotes from anyone else do not',t=>{
 const request='@bot please rebase this branch onto main and push it for me';
 const input={action:'created',pull_request:pullRequest(),issue:{...pullRequest(),pull_request:{}},comment:{id:9,user:author,body:request}};
 const allowed=fixture(t,{input});
 allowed.plan([item({target:{type:'pull_request',number:416},author_request:'please rebase this branch onto main'})]);
 const [child]=allowed.decide().followups;
 assert.ok(child);assert.equal(allowed.refusals().length,0);
 // The child carries the target and the quoted request for its executor.
 const plan=JSON.parse(allowed.s.get('SELECT input FROM tasks WHERE id=?',child).input).followup_plan;
 assert.deepEqual(plan.target,{type:'pull_request',number:416});assert.equal(plan.author_request,'please rebase this branch onto main');

 // The same words from a maintainer are not the author's request.
 const other=fixture(t,{input:{...input,comment:{id:10,user:maintainer,body:request}}});
 other.plan([item({author_request:'please rebase this branch onto main'})]);
 assert.deepEqual(other.decide().followups,[]);assert.deepEqual(other.refusals()[0].reasons.map(r=>r.code),['followup_others_work']);
 // Neither is a quote the author never wrote, nor a fragment too short to be a request.
 for(const quote of ['please force-push the fixed branch','rebase']){
  const invented=fixture(t,{input});invented.plan([item({author_request:quote})]);
  assert.deepEqual(invented.decide().followups,[],quote);
 }
});

test('a revision of the bot\'s own pull request is planned as usual',t=>{
 const bot={id:99,login:'fixture-app[bot]'};
 const f=fixture(t,{number:417,input:{action:'synchronize',pull_request:pullRequest({number:417,user:bot,maintainer_can_modify:true})}});
 f.s.run('INSERT INTO bot_pull_requests VALUES(?,?,?,?,?,?,?,?,0)','r',417,'pr-417',String(bot.id),'repo-id','bot/issue-12','a'.repeat(40),'development');
 f.plan([item()]);
 const accepted=f.decide();
 assert.equal(accepted.followups.length,1);assert.equal(f.refusals().length,0);
 assert.equal(f.s.get('SELECT target_task_id FROM task_relations').target_task_id,accepted.followups[0]);
});

test('a merged or closed target, and a finding a maintainer accepted, stay suggestions even when the author asked',t=>{
 const request='Could you please add the guarding assertions to my branch?';
 const merged=fixture(t,{input:{action:'closed',pull_request:pullRequest({state:'closed',merged:true,body:request})}});
 merged.plan([item({author_request:'please add the guarding assertions to my branch'})]);
 assert.deepEqual(merged.decide().followups,[]);
 assert.deepEqual(merged.refusals()[0].reasons,[{code:'followup_object_closed',detail:'pull request #416 is already merged.'}]);

 // A close the webhook recorded counts although the stored copy of the PR still says open.
 const closed=fixture(t,{input:{action:'opened',pull_request:pullRequest({body:request})}});
 closed.s.run('INSERT INTO review_objects VALUES(?,?,?,?)','r','review.pr',416,Date.now());
 closed.plan([item({author_request:'please add the guarding assertions to my branch'})]);
 assert.deepEqual(closed.decide().followups,[]);assert.deepEqual(closed.refusals()[0].reasons.map(r=>r.code),['followup_object_closed']);

 const accepted=fixture(t,{input:{action:'opened',pull_request:pullRequest({body:request})}});
 accepted.plan([item({author_request:'please add the guarding assertions to my branch',maintainer_acceptance:'Maintainer on #416: the merge queue runs the checks on the latest main, this is fine.'})]);
 assert.deepEqual(accepted.decide().followups,[]);assert.deepEqual(accepted.refusals()[0].reasons.map(r=>r.code),['followup_maintainer_accepted']);
});

test('a follow-up whose executor lacks a permission it needs is refused until the project grants it',t=>{
 const f=fixture(t,{kind:'task.request',input:{request:'Check the docs'}});
 assert.deepEqual(followupExecutor(f.s,'r',null),{edit_files:false,run_commands:true,github_write:false});
 f.plan([item({needs:['edit_files','github_write']})]);
 assert.deepEqual(f.decide().followups,[]);
 assert.deepEqual(f.refusals()[0].reasons,[{code:'followup_executor_unauthorized',detail:"The follow-up executor (dev) cannot edit_files, github_write under the project's permissions."}]);

 const granted=fixture(t,{kind:'task.request',input:{request:'Check the docs'}});
 // Code changes need the project's capability ceiling at develop (#850), and the work type's writes to include them.
 granted.s.run("UPDATE policies SET capability_ceiling='develop',work_settings=? WHERE repository_id=?",JSON.stringify({'task.request':{writes:['code']}}),'r');
 granted.plan([item({needs:['edit_files','run_commands']})]);
 assert.equal(granted.decide().followups.length,1);assert.equal(granted.refusals().length,0);

 // Supplementing an unfinished development task does the work there, and development tasks change code.
 const supplement=fixture(t,{kind:'task.request',input:{request:'Check the docs'}});
 supplement.s.run("UPDATE policies SET capability_ceiling='develop' WHERE repository_id='r'");
 supplement.s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,created_at,updated_at) VALUES('develop','r','task.development','queued','develop','{}','now','now')");
 supplement.plan([item({action:'supplement',task_id:'develop',needs:['edit_files']})]);
 assert.deepEqual(supplement.decide().followups,['develop']);assert.equal(supplement.refusals().length,0);
});

test('action none keeps a residual as a suggestion without a refusal, and a review residual can name no target',t=>{
 const kept=fixture(t);kept.plan([item({action:'none',reason:'A maintainer already accepted this on the PR'})]);
 assert.deepEqual(kept.decide().followups,[]);assert.equal(kept.refusals().length,0);assert.equal(kept.tasks(),1);
 // Work that changes no existing issue or PR (for example a defect the review found on main) is not someone else's PR.
 const separate=fixture(t);separate.plan([item({target:{type:'none'}})]);
 assert.equal(separate.decide().followups.length,1);
});

test('plan validation requires needs and a well-formed target',t=>{
 const f=fixture(t);
 const check=(value,code)=>assert.throws(()=>f.plan([value]),new RegExp(code));
 check({...item(),needs:undefined},'followup_needs_invalid');
 check(item({needs:['merge']}),'followup_needs_invalid');
 check(item({target:{type:'pull_request'}}),'followup_target_invalid');
 check(item({target:{type:'none',number:416}}),'followup_target_invalid');
 check(item({author_request:' '}),'followup_target_invalid');
 check(item({action:'none',issue_url:'https://github.com/fixture/repo/issues/12'}),'followup_new_has_reference');
});

test('the base system prompt every role receives carries the rule',()=>{
 assert.match(systemInstructions,/Unless its author explicitly asked for it in that issue or pull request, do not push to, rebase, edit the title, body or labels of, or otherwise change an issue or pull request someone else opened, including its branch in a fork, and do not plan or delegate work that would\./);
 assert.match(systemInstructions,/Report problems in someone else's work through comments and review findings/);
});
