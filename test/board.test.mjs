import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { boardTask, boardFixtures, boardRelease } from './board-fixtures.mjs';
const query=filters=>'/api/board/cards?filters='+encodeURIComponent(JSON.stringify(filters));
async function fixture(t){const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');await repository(admin,a.id,'202');return {h,admin,a};}
test('board projects one card per workflow, keeps published PR separate and omits raw task JSON',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  const result=await admin('/api/board/cards');assert.equal(result.status,200);
  const own=result.value.cards.filter(c=>c.repository_id==='101');assert.equal(own.length,8);
  assert.deepEqual(Object.fromEntries(own.map(c=>[c.object_number+'/'+c.card_category,c.bot_stage])),{'1/review.issue':'reviewed','2/review.pr':'reviewing','3/review.issue':'reviewed','3/development.issue':'developing','4/review.issue':'reviewed','4/development.issue':'developed','5/review.issue':'attention','40/review.pr':'unreviewed'});
  // Each card names its workflow as the repository names it.
  assert.deepEqual([...new Set(own.map(c=>c.card_category+'='+c.card_category_name))].sort(),['development.issue=开发 Issue','review.issue=检视 Issue','review.pr=检视 PR']);
  assert.equal(result.value.work_count,9);assert.equal(Object.values(result.value.column_counts).reduce((a,b)=>a+b,0),9);
  const combined=own.find(c=>c.object_number===3&&c.card_category==='development.issue');assert.equal(combined.review_task_id,'source-review');assert.equal(combined.development_task_id,'developing');
  assert.equal(own.find(c=>c.object_number===4).development_pr_number,40);assert.equal(combined.development_pr_number,null);
  assert.deepEqual(result.value.counts,{issue:5,pr:2});
  const stages=(await admin('/api/board')).value.stages;assert.deepEqual(stages.map(s=>s.id),['unreviewed','reviewing','reviewed','developing','developed','attention']);
  assert.equal(stages.find(s=>s.id==='developing').pr.name,'正在跟进');assert.ok(stages.every(s=>s.hint));
  assert.equal(own.find(c=>c.object_number===40).object_type,'pr');
  assert.equal(JSON.stringify(result.value).includes('input'),false);assert.equal(JSON.stringify(result.value).includes('result'),false);
  const tasks=(await admin('/api/board/cards/101/issue/3/tasks')).value.tasks;assert.equal(tasks.length,2);
  assert.equal((await admin('/api/tasks?kind=review')).value.tasks.length,6);assert.equal((await admin('/api/tasks?kind=development')).value.tasks.length,2);
});
test('each workflow retains its stage when another workflow has a newer success or failure',async t=>{
  const {h,admin}=await fixture(t);
  const active=['queued','running','preparing','implementing','validating','publishing','waiting_pr_head','waiting_publication','waiting_environment','result_ready'];
  for(const [i,status]of active.entries()){
    boardTask(h.store,'r'+i,10+i,'review.issue','running');boardTask(h.store,'d'+i,10+i,'development.issue',status);
  }
  for(const [i,status]of ['failed','cancelled','waiting_configuration','waiting_permission','needs_replan','retry_wait'].entries())boardTask(h.store,'f'+i,30+i,'review.pr',status);
  boardTask(h.store,'old-fail',50,'development.issue','failed');
  boardTask(h.store,'new-success',50,'review.issue','succeeded',{time:'2026-10-02T12:00:00.000Z'});
  boardTask(h.store,'old-success',51,'development.issue','completed');
  boardTask(h.store,'new-fail',51,'review.issue','failed',{time:'2026-10-02T12:00:00.000Z'});
  boardTask(h.store,'dev-success',52,'development.issue','succeeded');boardTask(h.store,'review-later',52,'review.issue','running',{time:'2026-10-02T12:00:00.000Z'});
  boardTask(h.store,'retry-fail',53,'review.issue','failed');boardTask(h.store,'retry-success',53,'review.issue','succeeded',{time:'2026-10-02T12:00:00.000Z'});
  const cards=(await admin('/api/board/cards')).value.cards;
  assert.ok(cards.filter(c=>c.object_number>=10&&c.object_number<20&&c.card_category==='development.issue').every(c=>c.bot_stage==='developing'));
  assert.ok(cards.filter(c=>c.object_number>=30&&c.object_number<36).every(c=>c.bot_stage==='attention'));
  const card=(number,category)=>cards.find(c=>c.object_number===number&&c.card_category===category);
  assert.equal(card(50,'review.issue').bot_stage,'reviewed');assert.equal(card(50,'development.issue').bot_stage,'attention');
  assert.equal(card(51,'review.issue').bot_stage,'attention');assert.equal(card(51,'development.issue').bot_stage,'developed');
  assert.equal(card(52,'review.issue').execution_status,'running');assert.equal(card(52,'development.issue').execution_status,'completed');
  assert.equal(card(53,'review.issue').bot_stage,'reviewed');assert.equal(card(53,'review.issue').task_id,'retry-success');
  // A newer development result must not hide the still-running review.
  h.store.run("UPDATE tasks SET status='succeeded',updated_at='2026-10-03' WHERE id='d0'");
  const before=(await admin(query([{field:'text',value:'10'}]))).value.cards;
  assert.equal(before.find(c=>c.card_category==='review.issue').execution_status,'running');
  assert.equal(before.find(c=>c.card_category==='development.issue').execution_status,'completed');
  for(const group of ['repository','execution_status','category']){
    const after=(await admin(query([{field:'text',value:'10'}])+'&group_by='+group)).value.cards;
    assert.deepEqual(after,before);
  }

});
test('verified webhooks project draft, closed and comment objects without starting tasks; preserve known metadata',async t=>{
  const {h,admin,a}=await fixture(t);
  const send=(id,payload,event='issues',secret=a.secret)=>h.hook(a.path,secret,id,{repository:{id:101},...payload},{'X-GitHub-Event':event});
  await send('draft',{action:'opened',pull_request:{number:7,title:'Draft research PR',draft:true,state:'open'}},'pull_request');
  await send('closed',{action:'closed',issue:{number:8,title:'Closed Issue',state:'closed'}});
  await send('comment',{action:'created',issue:{number:9,title:'PR via comment',pull_request:{url:'https://api.github.com/repos/a/b/pulls/9'}}},'issue_comment');
  await send('partial',{issue:{number:7,pull_request:{}}},'issue_comment');
  await send('bad-signature',{issue:{number:10,title:'Untrusted'}},'issues',testPassword());
  await send('weird',{pull_request:'invalid',issue:42});
  const open=(await admin('/api/board/cards')).value.cards;
  assert.equal(open.length,2);assert.equal(open.find(c=>c.object_number===7).draft,1);assert.equal(open.find(c=>c.object_number===7).title,'Draft research PR');
  assert.equal(open.find(c=>c.object_number===9).object_type,'pr');assert.ok(open.every(c=>c.bot_stage==='unreviewed'));
  assert.equal((await admin(query([{field:'include_closed',value:true}]))).value.cards.length,3);
  assert.equal(h.store.get('SELECT count(*) n FROM tasks').n,0);
  await send('reopen',{action:'reopened',issue:{number:8,state:'open'}});
  assert.equal((await admin('/api/board/cards')).value.cards.find(c=>c.object_number===8).title,'Closed Issue');
  await send('checks',{check_suite:{pull_requests:[{number:11},{number:12,title:'PR from check'},null,23,'bad']}},'check_suite');
  await send('invalid-number',{issue:{number:9007199254740992,title:'Unsafe number'}});
  const fromChecks=(await admin(query([{field:'object_type',value:'pr'}]))).value.cards;
  assert.equal(fromChecks.length,4);assert.ok(fromChecks.some(c=>c.object_number===11&&c.object_type==='pr'&&c.title===null));
  // A newer task without metadata must not prevent an older known value from filling a blank.
  boardTask(h.store,'metadata-missing',61,'review.pr','succeeded',{time:'2026-12-01T12:00:00.000Z',title:null});
  await send('metadata-known',{pull_request:{number:61,title:'Known title',state:'closed',draft:false}},'pull_request');
  const metadata=h.store.get('SELECT * FROM board_objects WHERE repository_id=? AND object_type=? AND object_number=?','101','pr',61);
  assert.equal(metadata.title,'Known title');assert.equal(metadata.github_state,'closed');assert.equal(metadata.draft,0);
});
test('scope is enforced with no filters, explicit filters, saved views, card mutations and revoked assignments',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  const password=testPassword(),user=(await admin('/api/users','POST',{username:'member',password,repository_ids:['101']})).value.user;
  const member=h.client();await member('/api/auth/login','POST',{username:'member',password});
  const visible=(await member('/api/board/cards')).value;assert.ok(visible.cards.every(c=>c.repository_id==='101'));assert.deepEqual(visible.counts,{issue:4,pr:2});
  assert.equal((await member(query([{field:'repository_id',value:'202'}]))).status,403);
  assert.equal((await member('/api/board/cards/202/issue/1/tasks')).status,403);
  assert.equal((await member('/api/board/cards/202/issue/1','PATCH',{field_id:'bot_stage',option_id:'developed'})).status,403);
  const view=(await member('/api/board/views','POST',{name:'Own repo',filters:[{field:'repository_id',value:'101'}]})).value.view;
  await admin('/api/project-admin-assignments','PUT',{user_id:user.id,repository_ids:[]});
  assert.deepEqual((await member('/api/board/cards')).value.cards,[]);assert.deepEqual((await member('/api/board/cards')).value.counts,{issue:0,pr:0});
  assert.deepEqual((await member('/api/board/cards?view_id='+view.id)).value.cards,[]);
});
test('filters, bounded pagination and personal views persist without affecting another account',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  const prs=(await admin(query([{field:'object_type',value:'pr'}]))).value;assert.equal(prs.cards.length,2);
  // Totals for the Issue/PR switch ignore the type condition and keep every other one, including a stage filter.
  assert.deepEqual(prs.counts,{issue:5,pr:2});
  assert.deepEqual((await admin(query([{field:'object_type',value:'issue'},{field:'bot_stage',value:'attention'}]))).value.counts,{issue:1,pr:0});
  assert.deepEqual((await admin(query([{field:'repository_id',value:'202'}]))).value.counts,{issue:1,pr:0});
  assert.equal((await admin(query([{field:'text',value:'successful review'}]))).value.cards.length,1);
  assert.equal((await admin(query([{field:'text',value:'%'}]))).value.cards.length,0);
  assert.equal((await admin(query([{field:'text',value:'#3'}]))).value.cards.length,2);
  assert.equal((await admin(query([{field:'bot_stage',value:'attention'}]))).value.cards.length,1);
  const page=await admin('/api/board/cards?limit=2');assert.equal(page.value.cards.length,2);assert.equal(page.value.has_more,true);
  for(const suffix of ['limit=101','offset=-1','limit=1.1','offset=100001'])assert.equal((await admin('/api/board/cards?'+suffix)).status,400);
  for(const condition of [[{field:'status',value:'bogus'}],[{field:'include_closed',value:'true'}]])assert.equal((await admin(query(condition))).status,400);
  assert.equal((await admin(query([{field:'object_type',value:'all'}]))).value.work_count,9);
  const password=testPassword();await admin('/api/users','POST',{username:'other',password,repository_ids:['101']});
  const other=h.client();await other('/api/auth/login','POST',{username:'other',password});
  const saved=(await admin('/api/board/views','POST',{name:'PRs',filters:[{field:'object_type',value:'pr'}],hidden_columns:['unreviewed']})).value.view;
  await admin('/api/board/views/default','PATCH',{filters:[{field:'object_type',value:'pr'}]});
  assert.deepEqual((await other('/api/board')).value.views[0].filters,[]);
  assert.equal((await other('/api/board/cards?view_id='+saved.id)).status,404);
  assert.equal((await other('/api/board/views/'+saved.id,'PATCH',{name:'Overwritten'})).status,404);
  assert.equal((await admin('/api/board/views/default','DELETE',{})).status,400);
  assert.equal((await admin('/api/board/views/default','PATCH',{name:'Renamed'})).status,400);
  assert.equal((await admin('/api/board/views/default','PATCH',{group_by:'custom'})).status,400);
  await h.stop();await h.start();assert.equal((await admin('/api/board')).value.views.find(v=>v.id===saved.id).hidden_columns[0],'unreviewed');
});
test('custom single-select columns include empty options; changing values never writes tasks or execution stages',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  const field=(await admin('/api/board/fields','POST',{name:'Priority'})).value.field;
  const high=(await admin('/api/board/fields/'+field.id+'/options','POST',{name:'High'})).value.option;
  await admin('/api/board/fields/'+field.id+'/options','POST',{name:'Low'});
  assert.equal((await admin('/api/board/fields/'+field.id+'/options','POST',{name:'High'})).status,409);
  const before=h.store.all('SELECT * FROM tasks');
  assert.equal((await admin('/api/board/cards/101/issue/3','PATCH',{field_id:field.id,option_id:high.id})).status,200);
  const grouped=(await admin('/api/board/cards?group_by='+field.id)).value.cards.find(c=>c.object_number===3&&c.card_category==='development.issue');
  assert.equal(grouped.field_value,high.id);assert.equal(grouped.bot_stage,'developing');assert.deepEqual(h.store.all('SELECT * FROM tasks'),before);
  assert.equal((await admin('/api/board')).value.fields[0].options.length,2);
  assert.equal((await admin('/api/board/cards/101/issue/3','PATCH',{field_id:'bot_stage',option_id:'developed'})).status,404);
  assert.equal((await admin('/api/board/cards/101/issue/3','PATCH',{field_id:field.id,option_id:'invalid'})).status,400);
  assert.equal((await admin('/api/board/cards/101/issue/3','PATCH',{field_id:field.id,option_id:high.id,status:'completed'})).status,400);
  const otherField=(await admin('/api/board/fields','POST',{name:'Other'})).value.field;
  assert.equal((await admin('/api/board/cards/101/issue/3','PATCH',{field_id:otherField.id,option_id:high.id})).status,400);
  await admin('/api/board/cards/101/issue/3','PATCH',{field_id:field.id,option_id:null});
  assert.equal(h.store.get('SELECT count(*) n FROM board_values').n,0);
  const password=testPassword();await admin('/api/users','POST',{username:'field-other',password,repository_ids:['101']});
  const other=h.client();await other('/api/auth/login','POST',{username:'field-other',password});
  assert.equal((await other('/api/board/cards?group_by='+field.id)).status,404);
  assert.equal((await other('/api/board/cards/101/issue/3','PATCH',{field_id:field.id,option_id:high.id})).status,404);
});
test('repository, execution and workflow dimensions include releases without leaking payload or grants',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  boardTask(h.store,'queued',6,'review.issue','queued');boardTask(h.store,'waiting',7,'development.issue','waiting_permission');
  boardTask(h.store,'cancelled',8,'review.issue','cancelled');
  boardRelease(h.store,'release-running','101','v1.2.3','running');boardRelease(h.store,'release-done','101','v1.2.2','published');
  boardRelease(h.store,'release-foreign','202','v9.9.9','failed');
  const all=await admin('/api/board/cards');assert.equal(all.status,200);assert.equal(all.value.release_count,3);
  const running=all.value.cards.find(c=>c.release_id==='release-running');assert.equal(running.full_name,'fixture/project-101');
  assert.equal(running.version,'v1.2.3');assert.equal(running.release_stage,'running');assert.equal(running.execution_status,'running');assert.equal(running.bot_stage,'developing');
  assert.equal(all.value.cards.find(c=>c.release_id==='release-done').execution_status,'completed');
  assert.equal(all.value.cards.find(c=>c.release_id==='release-foreign').execution_status,'failed');
  assert.ok(!JSON.stringify(all.value).includes('private release payload'));
  for(const [id,status]of [['reviewing','running'],['reviewed','completed'],['failed-review','failed'],['queued','queued'],['waiting','waiting'],['cancelled','other']]){
    const objectNumber=h.store.get('SELECT object_number FROM tasks WHERE id=?',id).object_number;
    assert.equal(all.value.cards.find(c=>c.object_number===objectNumber&&c.card_type==='object').execution_status,status,id);
  }
  // A workflow filter keeps that workflow's cards; a family saved by an older view keeps every workflow of the family.
  for(const category of ['review.issue','review.pr','development.issue']){
    const result=await admin(query([{field:'category',value:category}]));assert.ok(result.value.cards.length>0,category);
    assert.ok(result.value.cards.every(c=>c.card_type==='object'&&c.card_category===category));assert.equal(result.value.release_count,0);
  }
  for(const family of ['review','development']){
    const result=await admin(query([{field:'category',value:family}]));assert.ok(result.value.cards.length>0);
    assert.ok(result.value.cards.every(c=>c.card_type==='object'&&c.card_category.startsWith(family+'.')));assert.equal(result.value.release_count,0);
  }
  // A built-in object workflow names its object type, so an object type filter left in the view does not empty it.
  assert.ok((await admin(query([{field:'category',value:'review.pr'},{field:'object_type',value:'issue'}]))).value.cards.length>0);
  assert.equal((await admin(query([{field:'category',value:'custom.zz'}]))).status,400);
  const releases=await admin(query([{field:'category',value:'release'}]));assert.equal(releases.value.cards.length,3);assert.ok(releases.value.cards.every(c=>c.card_type==='release'));
  assert.deepEqual(releases.value.counts,{issue:0,pr:0});
  assert.equal((await admin(query([{field:'text',value:'v1.2.3'}]))).value.cards[0].release_id,'release-running');
  for(const status of ['running','queued','failed','completed','waiting','other']){
    const result=await admin(query([{field:'execution_status',value:status}]));assert.ok(result.value.cards.every(c=>c.execution_status===status),status);
  }
  for(const group of ['repository','execution_status','category'])assert.equal((await admin('/api/board/cards?group_by='+group)).status,200);
  const saved=await admin('/api/board/views/default','PATCH',{group_by:'repository',filters:[{field:'category',value:'review'}]});
  assert.equal(saved.status,200);assert.equal(saved.value.view.group_by,'repository');assert.deepEqual(saved.value.view.filters,[{field:'category',value:'review'}]);
  const taskQuery=(filters)=> '/api/board/cards/101/issue/3/tasks?filters='+encodeURIComponent(JSON.stringify(filters));
  assert.deepEqual((await admin(taskQuery([{field:'category',value:'review'}]))).value.tasks.map(t=>t.id),['source-review']);
  assert.deepEqual((await admin(taskQuery([{field:'category',value:'review.issue'}]))).value.tasks.map(t=>t.id),['source-review']);
  assert.deepEqual((await admin(taskQuery([{field:'category',value:'development.issue'}]))).value.tasks.map(t=>t.id),['developing']);
  assert.deepEqual((await admin(taskQuery([{field:'category',value:'development'}]))).value.tasks.map(t=>t.id),['developing']);
  assert.deepEqual((await admin(taskQuery([{field:'category',value:'development'},{field:'execution_status',value:'running'}]))).value.tasks.map(t=>t.id),['developing']);
  assert.equal((await admin(taskQuery([{field:'category',value:'development'},{field:'execution_status',value:'completed'}]))).value.tasks.length,0);
  const password=testPassword();await admin('/api/users','POST',{username:'release-member',password,repository_ids:['101']});
  const member=h.client();await member('/api/auth/login','POST',{username:'release-member',password});
  const visible=await member('/api/board/cards');assert.equal(visible.value.release_count,2);
  assert.ok(visible.value.cards.filter(c=>c.card_type==='release').every(c=>c.repository_id==='101'));
  assert.ok(!JSON.stringify(visible.value).includes('v9.9.9'));
});
test('one-time backfill recovers historical tasks and deliveries',async t=>{
  const {h,admin,a}=await fixture(t);boardFixtures(h.store);
  await h.hook(a.path,a.secret,'backfill',{repository:{id:101},issue:{number:60,title:'Historical delivery'}});
  h.store.db.exec("DELETE FROM settings WHERE key='board_projection_v1'; DELETE FROM board_objects");
  await h.stop();await h.start();
  assert.equal((await admin('/api/board/cards')).value.cards.length,10);
});

// Production: a tasks row stores the task input (about 1 MB on average) before updated_at and result, so the card list,
// which read those columns from each object's newest review and development task, walked the input of every task it
// showed or counted (0.8 s with a warm cache, 9 s with a cold one, four times per request).
test('the card list reads tasks through the covering index; only the page reads development results',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  const seen=[],all=h.store.all.bind(h.store),get=h.store.get.bind(h.store);
  h.store.all=(sql,...args)=>{seen.push(sql);return all(sql,...args);};h.store.get=(sql,...args)=>{seen.push(sql);return get(sql,...args);};
  try{assert.equal((await admin('/api/board/cards')).status,200);}finally{h.store.all=all;h.store.get=get;}
  const lists=seen.filter(sql=>/WITH latest AS MATERIALIZED/.test(sql));
  assert.equal(lists.length,4,'cards, object totals, column counts and work counts');
  for(const sql of lists){
    const plan=h.store.all('EXPLAIN QUERY PLAN '+sql).map(r=>r.detail),tasks=plan.filter(d=>/^(SCAN|SEARCH) t\b|^(SCAN|SEARCH) tasks\b/.test(d));
    assert.ok(tasks.some(d=>/COVERING INDEX board_task_cover/.test(d)),plan.join(' | '));
    // No task row by primary key per card; general tasks (no object) read their summary from the row, not via the input.
    assert.ok(!plan.some(d=>/sqlite_autoindex_tasks_1/.test(d)),plan.join(' | '));
    assert.ok(tasks.every(d=>/board_task_cover/.test(d)),plan.join(' | '));
  }
  const results=seen.filter(sql=>/\bresult\b/.test(sql)&&/FROM tasks/.test(sql));
  assert.equal(results.length,1);assert.match(results[0],/WHERE id IN \(/);
});

test('saved views restore object scope and filters, column totals cover all pages and permission scopes',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  const filters=[{field:'object_type',value:'pr'},{field:'category',value:'review'},{field:'execution_status',value:'running'}];
  const saved=(await admin('/api/board/views','POST',{name:'Running PR reviews',group_by:'repository',filters,hidden_columns:['202']})).value.view;
  const result=(await admin('/api/board/cards?view_id='+saved.id)).value;
  assert.deepEqual(result.cards.map(c=>c.task_id),['reviewing']);assert.deepEqual(result.column_counts,{'101':1});
  assert.deepEqual(saved.filters,filters);assert.deepEqual(saved.hidden_columns,['202']);
  const all=(await admin('/api/board/views','POST',{name:'All work',filters:[{field:'object_type',value:'all'}],group_by:'category'})).value.view;
  assert.equal((await admin('/api/board/cards?view_id='+all.id)).value.work_count,9);
  const page=(await admin('/api/board/cards?group_by=category&limit=1')).value;
  assert.equal(page.cards.length,1);assert.equal(page.work_count,9);assert.deepEqual(page.column_counts,{'review.issue':5,'review.pr':2,'development.issue':2});
  const keys=new Set();for(let offset=0;offset<9;offset+=2){
    const next=(await admin('/api/board/cards?limit=2&offset='+offset)).value;
    for(const c of next.cards)keys.add([c.repository_id,c.object_type,c.object_number,c.card_category].join('/'));
  }
  assert.equal(keys.size,9);
});

test('reply tasks get cards of their own, and the board lists the work types; views that named a custom workflow keep working',async t=>{
  const {h,admin}=await fixture(t);boardFixtures(h.store);
  // Reply tasks of a former custom workflow and of the Manager count as one kind of work on their object.
  const reply=(id,number,status,time,workflow=null)=>{boardTask(h.store,id,number,'workflow.issue',status,{time});h.store.run('UPDATE tasks SET workflow_id=? WHERE id=?',workflow,id);};
  reply('docs-old',3,'failed','2026-10-01T10:00:00.000Z','custom.0123456789ab');reply('docs-new',3,'running','2026-10-01T11:00:00.000Z');reply('docs-done',5,'succeeded');
  const board=(await admin('/api/board')).value;
  assert.deepEqual(board.workflows.map(w=>[w.id,w.name]),[['review.issue','检视 Issue'],['review.pr','检视 PR'],['development.issue','开发 Issue'],['development.pr','跟进 bot PR'],['reply','通用回复'],['task.request','通用任务'],['release','发版本']]);
  const cards=(await admin('/api/board/cards')).value.cards,card=(number,category)=>cards.find(c=>c.object_number===number&&c.card_category===category&&c.repository_id==='101');
  // The reply card follows its own latest task; the object's review card is unchanged.
  assert.deepEqual([card(3,'reply').task_id,card(3,'reply').bot_stage,card(3,'reply').card_category_name],['docs-new','reviewing','通用回复']);
  assert.deepEqual([card(5,'reply').bot_stage,card(5,'review.issue').bot_stage,card(5,'review.issue').card_category_name],['reviewed','attention','检视 Issue']);
  const only=(await admin(query([{field:'category',value:'reply'}]))).value;
  assert.deepEqual(only.cards.map(c=>c.task_id).sort(),['docs-done','docs-new']);
  assert.deepEqual((await admin('/api/board/cards?group_by=category&filters='+encodeURIComponent('[]'))).value.column_counts.reply,2);
  // A view saved with a custom workflow id shows the reply cards.
  assert.deepEqual((await admin(query([{field:'category',value:'custom.0123456789ab'}]))).value.cards.map(c=>c.task_id).sort(),['docs-done','docs-new']);
  // Opening a reply card lists its reply tasks only.
  const tasks=(await admin('/api/board/cards/101/issue/3/tasks?filters='+encodeURIComponent(JSON.stringify([{field:'category',value:'reply'}])))).value.tasks;
  assert.deepEqual(tasks.map(t=>t.id),['docs-new','docs-old']);
  assert.equal((await admin('/api/board/cards/101/issue/3/tasks')).value.tasks.length,4);
});
