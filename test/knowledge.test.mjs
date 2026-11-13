import { command } from './management-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../dist/storage/database.js';
import { ProjectMemory, memoryTool } from '../dist/memory/project.js';
import { taskMemoryAccess, visibleMemorySnapshot } from '../dist/memory/access.js';
import { memoryApi } from '../dist/memory/api.js';
import { resolveActor, resolvePrincipalActor, resolveServiceActor, authorize, invalidate } from '../dist/identity/authorization.js';
import { traceEvent, traceSource, taskTrace } from '../dist/tasks/trace.js';
import { TaskRecords } from '../dist/tasks/service.js';
import { readEvidence } from '../dist/tasks/evidence.js';
import { sha } from '../dist/agent/common.js';
import { knowledgeActor, authorizeKnowledgeTask } from './knowledge-fixture.mjs';
import { identityFixture } from './identity-fixture.mjs';
import { projectCapabilities } from '../dist/identity/storage.js';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
const commit = 'a'.repeat(40);
const entry = (body = 'A reproducible observation') => ({ body, kind:'experience', sources:[{reference:'test run output', commit}], scope:{commit,module:'runtime'} });
function fixture(t) {
  const s = new Store(':memory:', Buffer.alloc(32)); t.after(() => s.close());
  s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");
  for (const [id,owner] of [['r','10'],['sibling','10'],['foreign','20']]) s.run('INSERT INTO repositories VALUES(?,?,?,?)',id,'fixture/'+id,owner,'a');
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,head_sha) VALUES('t','r','task.request','running','runtime notes',?)", commit);
  const actor = authorizeKnowledgeTask(s), access = {actor}, m = new ProjectMemory(s,access);
  const task = (role='dev') => ({...s.get("SELECT * FROM tasks WHERE id='t'"),active_role:role,trace_run_id:'run-'+role});
  const view = role => new ProjectMemory(s,taskMemoryAccess(s,task(role)));
  const user = actor => ({id:actor.principal_id,role:'project_admin',repositories:['r'],context:actor});
  return {s,actor,access,m,task,view,user};
}
test('existing rows/history get an index without a body migration; metadata searches keep exact sources and versions', t => {
  const {s,m} = fixture(t), original = {...entry('ECONNRESET is transient'),owner:'human',authority:'sqlite',status:'active',verification:'human_asserted'};
  s.run('INSERT INTO project_memories VALUES(?,?,?,?,?,?)','legacy','r','net.reset',1,JSON.stringify(original),'now');
  s.run('INSERT INTO project_memory_versions VALUES(?,?,?,?,?,?)','legacy',1,JSON.stringify(original),'user:owner','legacy source','now');
  const indexed = m.save('r','net.reset',{catalog:{title:'Network retry',aliases:['socket hang up'],tags:['network'],path:'src/network/client.ts',module:'transport',owner:'oncall',category:'operations',review_due_at:'2020-01-01T00:00:00Z'}},1,'user:owner','add directory index');
  assert.equal(indexed.body,original.body); assert.equal(indexed.review_overdue,true); assert.equal(m.get('r','legacy',1).body,original.body);
  assert.equal(s.get('SELECT data FROM project_memory_versions WHERE memory_id=? AND revision=1','legacy').data,JSON.stringify(original));
  for(const query of ['socket hang up','Network retry','ECONNRESET']) assert.equal(m.search('r',query).items[0].id,'legacy');
  assert.equal(m.search('r','',{path:'src/network/',module:'transport',category:'operations',tag:'network'}).items[0].revision,2);
  assert.equal(m.search('r','',{path:'docs/'}).items.length,0); assert.equal(m.versions('r','legacy')[0].actor,'user:owner');
  assert.equal(s.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'project_memor%'").length,2);
});
test('tenant/project grants and server role views fence list, IDs, keys, historical revisions, versions, source and export', async t => {
  const {s,m,actor,view,task,user} = fixture(t);
  const shared=m.save('r','shared',entry('Shared reviewed reference'),0,'user:owner','human source');
  const candidate=await memoryTool(s,task(),'remember_project_memory',{key:'private',body:'DEV_PRIVATE_OBSERVATION',kind:'experience'});assert.ok(candidate.id);
  for(const role of ['reviewer','test','qa','manager']) {
    const v=view(role);assert.deepEqual(v.search('r','').items.map(x=>x.id),[shared.id]);
    assert.equal(v.search('r','',{role:'dev'}).items.length,0);
    for(const id of [candidate.id,'role.dev.private'])for(const rev of [undefined,1])assert.throws(()=>v.get('r',id,rev),/memory_not_found/);
    assert.throws(()=>v.versions('r',candidate.id),/memory_not_found/);
    assert.throws(()=>traceSource(s,'t',`project_memories:${candidate.id}:1`,taskMemoryAccess(s,task(role))),/not_found/);
    assert.equal((await memoryTool(s,task(role),'read_project_memory',{id:candidate.id,revision:1,role:'dev'})).error,'memory_not_found');
    assert.equal((await memoryTool(s,task(role),'remember_project_memory',{key:'try',body:'no',kind:'experience'})).error,'memory_role_read_only');
  }
  assert.equal(view('dev').get('r',candidate.id,1).body,'DEV_PRIVATE_OBSERVATION');
  const readOnly=knowledgeActor(s,'reader','r',['tasks.read','knowledge.read']);
  const base='http://local/api/repositories/r/memories';
  for(const suffix of ['', '?role=dev','/'+candidate.id,'/'+candidate.id+'?revision=1','/'+candidate.id+'/versions','?export=1']) {
    try{const data=await memoryApi(s,user(readOnly),'GET',new URL(base+suffix),{});assert.ok(!JSON.stringify(data).includes('DEV_PRIVATE'));}catch(error){assert.equal(error.code,'memory_not_found');}
  }
  for(const repo of ['sibling','foreign']) {
    const otherActor=knowledgeActor(s,'other-'+repo,repo),other=new ProjectMemory(s,{actor:otherActor});const item=other.save(repo,'other',entry('foreign secret'),0,'user:'+otherActor.principal_id,'other project');
    assert.throws(()=>m.get('r',item.id),/memory_not_found/);assert.throws(()=>m.search(repo),/forbidden/);assert.throws(()=>m.get(repo,item.id,1),/forbidden/);
  }
  assert.throws(()=>new ProjectMemory(s,{actor:JSON.parse(JSON.stringify(actor))}).search('r'),/untrusted_actor/);
  assert.throws(()=>new ProjectMemory(s).get('r',shared.id),/memory_actor_required/);
  const writeOnly=knowledgeActor(s,'write-only','r',['tasks.read','knowledge.write']);
  assert.throws(()=>new ProjectMemory(s,{actor:writeOnly}).save('r','must-not-persist',entry(),0,'user:write-only','write without response read authority'),/capability_forbidden/);
  assert.equal(s.get("SELECT count(*) n FROM project_memories WHERE fact_key='must-not-persist'").n,0);
});
test('visibility withdrawal fences old revisions, captured tool sources and existing service objects without permission caches', async t => {
  const {s,m,task,view,actor,access}=fixture(t),a=m.save('r','withdraw',entry('ONCE_SHARED'),0,'user:owner','source');
  const captured={name:'read_project_memory',observation:await view('reviewer').read('r',a.id,1,commit)};
  const event=traceEvent(s,'t','tool_observation',captured);
  m.save('r',a.key,{catalog:{audience:'role:dev'}},1,'user:owner','withdraw shared audience');
  assert.throws(()=>view('reviewer').get('r',a.id,1),/memory_not_found/);
  const scoped=taskMemoryAccess(s,task('reviewer'));
  assert.ok(!JSON.stringify(traceSource(s,'t',event,scoped)).includes('ONCE_SHARED'));
  const events=taskTrace(s,'t',new URL('http://local?include_data=1'),'events',scoped);assert.ok(!JSON.stringify(events).includes('ONCE_SHARED'));
  assert.equal(traceSource(s,'t',`project_memories:${a.id}:1`,access).data.body,'ONCE_SHARED');
  invalidate(s,actor.principal_id,'fixture revoked');
  assert.throws(()=>m.get('r',a.id,1),/authorization_changed/);assert.throws(()=>m.search('r'),/authorization_changed/);assert.throws(()=>traceSource(s,'t',`project_memories:${a.id}:1`,access),/authorization_changed/);
  s.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id='owner'",Date.now());
  const refreshed=resolvePrincipalActor(s,'owner',actor.tenant_id);assert.throws(()=>new ProjectMemory(s,{actor:refreshed}).get('r',a.id),/capability_forbidden/);
});
test('private historical versions stay private after sharing and private replacements never hide shared knowledge', async t => {
  const {s,m,task,view}=fixture(t),a=m.save('r','shared',entry(),0,'user:owner','shared');
  const b=m.save('r','private',{...entry('private'),catalog:{audience:'role:dev'},supersedes:[a.id]},0,'user:owner','private replacement');
  assert.deepEqual(view('reviewer').search('r').items.map(x=>x.id),[a.id]);assert.deepEqual(view('reviewer').get('r',a.id).superseded_by,[]);
  m.save('r',b.key,{catalog:{audience:'project'}},1,'user:owner','explicitly share new version');
  assert.throws(()=>view('reviewer').get('r',b.id,1),/memory_not_found/);
  assert.deepEqual(view('reviewer').versions('r',b.id).map(x=>x.revision),[2]);
  assert.equal((await memoryTool(s,task('reviewer'),'read_project_memory',{id:b.id,revision:2})).body,'private');
});
test('review transitions require evidence, retain original source and review history, and reject concurrent revisions', t => {
  const {m,view}=fixture(t),a=m.save('r','candidate',{...entry(),verification:'unverified'},0,'user:owner','candidate');
  assert.throws(()=>m.review('r',a.id,1,{action:'accept',reason:'looks right',evidence:[]}),/review_evidence_required/);
  const accepted=m.review('r',a.id,1,{action:'accept',evidence:['check:test-run#42'],reason:'independently reproduced'});
  assert.equal(accepted.verification,'observed');assert.equal(accepted.review.actor,'owner');assert.ok(accepted.catalog.reviewed_at);assert.deepEqual(accepted.sources,a.sources);
  assert.throws(()=>m.review('r',a.id,1,{action:'revoke',evidence:['check:42'],reason:'stale writer'}),/memory_revision_changed/);
  let rev=2;for(const [action,status] of [['conflict','conflict'],['reject','archived'],['restore','needs_review'],['revoke','revoked'],['restore','needs_review']]){
    const next=m.review('r',a.id,rev,{action,evidence:['check:'+rev],reason:action});assert.equal(next.revision,++rev);assert.equal(next.status,status);
  }
  assert.equal(m.get('r',a.id,1).verification,'unverified');assert.equal(m.get('r',a.id,2).review.action,'accept');assert.equal(m.versions('r',a.id).length,rev);
  assert.throws(()=>view('dev').review('r',a.id,rev,{action:'accept',evidence:['self'],reason:'self'}),/memory_agent_cannot_review/);
  const b=m.save('r','duplicate',entry('duplicate'),0,'user:owner','duplicate');
  const merged=m.review('r',a.id,rev,{action:'merge',supersedes:[b.id],evidence:['comparison'],reason:'duplicate'});assert.deepEqual(merged.supersedes,[b.id]);
  assert.throws(()=>m.review('r',b.id,1,{action:'merge',supersedes:[a.id],evidence:['comparison'],reason:'cycle'}),/memory_replacement_cycle/);
});
test('run note budget is atomic and credentials cannot enter body, directory metadata, sources or review evidence', async t => {
  const {s,m,task}=fixture(t);
  for(let i=0;i<3;i++)assert.ok((await memoryTool(s,task(),'remember_project_memory',{key:'n'+i,body:'actual note '+i,kind:'experience',catalog:{title:'Observation '+i,aliases:['failure-'+i]}})).id);
  assert.equal((await memoryTool(s,task(),'remember_project_memory',{key:'four',body:'extra',kind:'experience'})).error,'memory_note_budget_exhausted');
  const secret='ghp_'+'a'.repeat(30);
  for(const data of [{...entry(secret)}, {...entry(),catalog:{aliases:[secret]}},{...entry(),sources:[{reference:secret}]}])assert.throws(()=>m.save('r','sensitive',data,0,'user:owner','check'),/memory_sensitive_content/);
  const a=m.save('r','review',entry(),0,'user:owner','source');assert.throws(()=>m.review('r',a.id,1,{action:'accept',reason:'check',evidence:[secret]}),/memory_sensitive_content/);
  // A failed trace write must roll back the knowledge row as well as the per-run receipt.
  s.db.exec("CREATE TRIGGER reject_memory_receipt BEFORE INSERT ON task_history WHEN NEW.type='memory_recorded' BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
  const result=await memoryTool(s,{...task(),trace_run_id:'new-run'},'remember_project_memory',{key:'rollback',body:'must not persist',kind:'experience'});assert.ok(result.error);assert.throws(()=>m.get('r','role.dev.rollback'),/memory_not_found/);
});
test('captured execution evidence cannot carry Dev private memory into independent evaluation', async t => {
  const {s,m,view,task}=fixture(t);const a=m.save('r','private',{...entry('PRIVATE_EVIDENCE'),catalog:{audience:'role:dev'}},0,'user:owner','private');
  const result=await view('dev').read('r',a.id,1,commit),raw=JSON.stringify({name:'read_project_memory',result});
  const ref=traceEvent(s,'t','execution_evidence',JSON.parse(raw));
  const candidate={id:'candidate',revision:1,artifacts:[],evidence:[{source:ref,version:'v1',result:{digest:sha(raw)}}]};
  assert.equal(readEvidence(s,'t',candidate,{source:ref},taskMemoryAccess(s,task('qa'))).error,'evidence_knowledge_forbidden');
  assert.ok(!JSON.stringify(new TaskRecords(s).tool('t','read_task_history',{},taskMemoryAccess(s,task('reviewer')))).includes('PRIVATE_EVIDENCE'));
  assert.ok(!JSON.stringify(visibleMemorySnapshot(s,'r',{input:JSON.stringify({project_memory:{selected:[result]}})},taskMemoryAccess(s,task('qa')))).includes('PRIVATE_EVIDENCE'));
  const legacyReceipt={ref:`project_memories:${a.id}:1`,content:JSON.stringify({data:{body:'PRIVATE_EVIDENCE'}})};
  assert.ok(!JSON.stringify(visibleMemorySnapshot(s,'r',legacyReceipt,taskMemoryAccess(s,task('qa')))).includes('PRIVATE_EVIDENCE'));
  s.run('DELETE FROM project_memories WHERE id=?',a.id);
  assert.ok(!JSON.stringify(visibleMemorySnapshot(s,'r',result,taskMemoryAccess(s,task('dev')))).includes('PRIVATE_EVIDENCE'));
});
test('document reads recheck current visibility after asynchronous source I/O', async t => {
  const {m,view}=fixture(t),a=m.save('r','document',entry(),0,'user:owner','source');
  const doc={path:'docs/runbook.md',commit,blob_sha:'b'.repeat(40),pr_number:1,merged:true,default_base:true};m.linkDocument('r',a.id,1,doc,'user:owner');
  await assert.rejects(view('reviewer').read('r',a.id,2,commit,async()=>{m.save('r',a.key,{catalog:{audience:'role:dev'}},2,'user:owner','withdraw while reading');return {content:'MUST_NOT_ESCAPE',sha:doc.blob_sha};}),/memory_not_found/);
});
test('knowledge HTTP and management facade share persisted revisions, review evidence and current authorization', async t => {
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const root='/api/repositories/101/memories';
  const created=await admin(root,'POST',{key:'runtime.retry',expected_revision:0,...entry(),reason:'user source',catalog:{title:'Retry failures',aliases:['socket reset'],path:'src/net/client.ts',category:'operations'}});assert.equal(created.status,201,JSON.stringify(created.value));const id=created.value.memory.id;
  const search=await admin('/api/management/query','POST',{operation:'search_knowledge',target:{project_id:'101'},arguments:{query:'socket reset'}});assert.equal(search.status,201,JSON.stringify(search.value));assert.ok(JSON.stringify(search.value).includes(id));
  const review=await admin(root+'/'+id+'/review','POST',{expected_revision:1,action:'accept',evidence:['run:local-check'],reason:'reproduced'});assert.equal(review.status,201);assert.equal(review.value.memory.revision,2);
  assert.equal((await admin(root+'/'+id,'PATCH',{expected_revision:1,body:'stale',reason:'racing edit'})).value.error,'memory_revision_changed');
  assert.equal((await admin(root+'?export=1')).value.items[0].revision,2);
  assert.equal((await admin(root+'/'+id+'?revision=1')).value.memory.body,created.value.memory.body);
  assert.equal((await admin(root+'/'+id+'/versions')).value.versions.length,2);
  assert.ok(h.store.get("SELECT resource_id FROM audit WHERE action='memory.read'").resource_id.includes(':1'));
  const exact=await admin('/api/management/query','POST',{operation:'read_knowledge',target:{project_id:'101'},arguments:{id,revision:1}});assert.equal(exact.value.memory.revision,1);
  const versions=await admin('/api/management/query','POST',{operation:'knowledge_versions',target:{project_id:'101'},arguments:{id}});assert.equal(versions.value.versions.length,2);
  const args={id,revision:2,catalog:{title:'Managed retry failures'},reason:'correct directory title'};
  const revised=await command(admin,'knowledge.revise',{project_id:'101'},args,'knowledge-change');assert.equal(revised.value.state,'succeeded',JSON.stringify(revised.value));
  const replay=await command(admin,'knowledge.revise',{project_id:'101'},args,'knowledge-change');assert.equal(replay.value.id,revised.value.id);
  assert.equal((await admin(root+'/'+id)).value.memory.revision,3);assert.equal((await admin(root+'/'+id+'/versions')).value.versions.length,3);
});

test('a project grant manager explicitly enables independent service review through the grants API without acquiring review authority', async t=>{
  const {h,admin,login}=await identityFixture(t),s=h.store;
  const {result:github}=await login();
  const derived=s.all("SELECT capabilities FROM scoped_grants WHERE principal_id=? AND source='github_derived'",github.principal_id);
  assert.ok(derived.length);assert.ok(derived.every(g=>!JSON.parse(g.capabilities).includes('knowledge.review')));
  assert.ok(!projectCapabilities.includes('knowledge.review'));
  const password=testPassword(),created=await admin('/api/users','POST',{username:'review-manager',password,repository_ids:['101']});
  assert.equal(created.status,201);const managerId=created.value.user.id;
  // Establish only the pre-existing grant-management precondition; review authority is granted below via HTTP.
  knowledgeActor(s,managerId,'101',['grants.manage']);
  const manager=h.client();assert.equal((await manager('/api/auth/login','POST',{username:'review-manager',password})).status,200);
  const managerActor=resolveActor(s,manager.cookie().slice('bot_session='.length));
  authorize(managerActor,'grants.manage',{project_id:'101'});assert.throws(()=>authorize(managerActor,'knowledge.review',{project_id:'101'}),/capability_forbidden/);
  assert.ok(!managerActor.capabilities.includes('knowledge.review'));
  assert.ok(s.all("SELECT capabilities FROM scoped_grants WHERE principal_id=? AND policy='legacy'",managerId).every(g=>!JSON.parse(g.capabilities).includes('knowledge.review')));
  const made=await manager('/api/identity/service-principals','POST',{project_id:'101',maintenance:'independent review pipeline'});
  assert.equal(made.status,201);const principal=made.value.principal_id;
  const before=resolveServiceActor(s,principal);assert.deepEqual(new Set(before.capabilities),new Set(projectCapabilities));
  assert.throws(()=>authorize(before,'knowledge.review'),/capability_forbidden/);
  const defaults=s.all('SELECT capabilities FROM scoped_grants WHERE principal_id=?',principal);
  assert.ok(defaults.every(g=>!JSON.parse(g.capabilities).includes('knowledge.review')));
  s.run("INSERT INTO tasks(id,repository_id,kind,status,summary,head_sha) VALUES('review-task','101','task.request','running','independent review',?)",commit);
  authorizeKnowledgeTask(s,'review-task',managerId);
  const task={...s.get("SELECT * FROM tasks WHERE id='review-task'"),active_role:'dev',trace_run_id:'producer-run'};
  const note=await memoryTool(s,task,'remember_project_memory',{key:'review-candidate',body:'Observed fixture behavior',kind:'experience'});
  assert.ok(note.id);
  const m=new ProjectMemory(s,{actor:managerActor});assert.equal(m.get('101',note.id).owner,'agent');
  const service=()=>new ProjectMemory(s,{actor:resolveServiceActor(s,principal)});
  const input={action:'accept',run_id:'review-run',evidence:['task_history:1'],reason:'independent raw check'};
  assert.throws(()=>service().review('101',note.id,1,input),/capability_forbidden/);
  assert.equal((await manager('/api/identity/grants','POST',{principal_id:principal,tenant_id:'github.com:10',project_id:'101',capabilities:['knowledge.typo']})).value.error,'invalid_capabilities');
  assert.equal((await manager('/api/identity/grants','POST',{principal_id:principal,tenant_id:'github.com:20',project_id:'201',capabilities:['knowledge.review']})).status,403);
  const grant=await manager('/api/identity/grants','POST',{principal_id:principal,tenant_id:'github.com:10',project_id:'101',capabilities:['knowledge.review']});
  assert.equal(grant.status,201,JSON.stringify(grant.value));
  const enabled=resolveServiceActor(s,principal);assert.ok(enabled.capabilities.includes('knowledge.review'));authorize(enabled,'knowledge.review');
  // An added grant raises no authorization revision (#521): the earlier actor keeps working under the current grants.
  authorize(before,'knowledge.read');authorize(before,'knowledge.review');
  assert.throws(()=>authorize(managerActor,'knowledge.review',{project_id:'101'}),/capability_forbidden/);
  assert.throws(()=>service().review('101',note.id,1,input),/memory_independent_review_required/);
  s.run("INSERT INTO role_instances(id,task_id,role,definition,harness,updated_at) VALUES('observer','review-task','reviewer','{}','fixture','now')");
  s.run("INSERT INTO task_runs(id,task_id,kind,attempt,revision,started_at,status,context_snapshot,config_snapshot,role_instance_id,role) VALUES('review-run','review-task','execution',1,1,'now','running','{}','{}','observer','reviewer')");
  const records=new TaskRecords(s);
  records.history('review-task','tool_observation',{name:'run_command',result:{exit_code:0,output:'reproduced'}},'review-run');
  const observation=s.get("SELECT id FROM task_history WHERE task_id='review-task' AND type='tool_observation' ORDER BY id DESC LIMIT 1");input.evidence=['task_history:'+observation.id];
  assert.throws(()=>service().review('101',note.id,1,input),/memory_independent_review_required/);
  s.run("UPDATE task_runs SET status='succeeded' WHERE id='review-run'");
  assert.throws(()=>service().review('101',note.id,1,input),/memory_independent_review_required/);
  records.history('review-task','memory_read',{id:note.id,revision:1,memory_source:`project_memories:${note.id}:1`},'review-run');
  const reviewed=service().review('101',note.id,1,input);
  assert.equal(reviewed.verification,'observed');assert.equal(reviewed.review.actor,principal);assert.equal(reviewed.owner,'agent');
  assert.equal(m.get('101',note.id,1).owner,'agent');
  const adopted=m.review('101',note.id,2,{action:'accept',evidence:input.evidence,reason:'human adoption after service review'});
  assert.equal(adopted.owner,'human');assert.equal(adopted.review.actor,managerId);
  assert.equal((await manager('/api/identity/grants/'+grant.value.grant_id,'DELETE',{})).status,200);
  assert.ok(!resolveServiceActor(s,principal).capabilities.includes('knowledge.review'));
  assert.throws(()=>new ProjectMemory(s,{actor:enabled}).review('101',note.id,3,input),/authorization_changed/);
  assert.throws(()=>service().review('101',note.id,3,input),/capability_forbidden/);
});

test('sensitive repository paths stay outside directory metadata, sources and document promotion', t=>{
  const {m}=fixture(t);
  for(const path of ['.env','.env.production','keys/private.pem','.ssh/id_rsa','../private/chat.md']) {
    assert.throws(()=>m.save('r','bad-path',{...entry(),catalog:{path}},0,'user:owner','sensitive index'),/memory_sensitive_path|invalid_memory_path/);
    assert.throws(()=>m.save('r','bad-source',{...entry(),sources:[{path,commit}]},0,'user:owner','sensitive source'),/memory_sensitive_path|invalid_memory_path/);
  }
});

test('export rechecks earlier entries if their audience is withdrawn during a later document read',async t=>{
 const {createServer}=await import('node:http'),{once}=await import('node:events'),{blobSha}=await import('../dist/agent/common.js');
 const {s,m,user}=fixture(t),first=m.save('r','a.shared',entry('WITHDRAWN_DURING_EXPORT'),0,'user:owner','shared source');
 const bytes=Buffer.from('Repository document'),document=m.save('r','z.document',entry(),0,'user:owner','document');
 m.linkDocument('r',document.id,1,{path:'docs/reference.md',commit,blob_sha:blobSha(bytes),pr_number:1,merged:true,default_base:true},'user:owner');
 const reader=knowledgeActor(s,'reader','r',['tasks.read','knowledge.read']);
 s.run("UPDATE accounts SET type='bot_account',credentials=? WHERE id='a'",s.secrets.seal({token:'fixture-read-only-token'},'account:a'));
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/repositories/r')return res.end(JSON.stringify({id:'r',owner:{id:'10'},full_name:'fixture/r',default_branch:'main'}));
  if(req.url.startsWith('/repos/fixture/r/contents/')){m.save('r',first.key,{catalog:{audience:'role:dev'}},1,'user:owner','withdraw while exporting');return res.end(JSON.stringify({encoding:'base64',content:bytes.toString('base64'),sha:blobSha(bytes),size:bytes.length}));}
  res.writeHead(404);res.end('{}');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 await assert.rejects(memoryApi(s,user(reader),'GET',new URL('http://local/api/repositories/r/memories?export=1'),{},'http://127.0.0.1:'+server.address().port),/memory_not_found/);
});


test('TaskRecords raw JSON evidence stays byte-exact and complete when no knowledge is filtered', t=>{
  const {s,task}=fixture(t),records=new TaskRecords(s),access=taskMemoryAccess(s,task('qa'));
  const contents=['{\n  "name": "package-fixture",\n  "scripts": { "test": "node --test" }\n}\n','  [\n    { "path": "src/a.ts" },\n    42\n  ]\n'];
  for(const [i,content] of contents.entries())for(const type of ['execution_evidence','acceptance_evidence']){
    const data={name:'read_file',result:{path:i?'files.json':'package.json',content}};
    records.history('t',type,data);
    const row=s.get('SELECT id,data FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 1','t'),source='task_history:'+row.id;
    const candidate={id:'candidate',revision:1,artifacts:[],evidence:[{source,version:'tree',result:{digest:sha(row.data)}}]};
    const read=readEvidence(s,'t',candidate,{source},access);
    assert.equal(read.chunk,row.data);assert.equal(JSON.parse(read.chunk).result.content,content);assert.equal(read.digest,sha(row.data));
    assert.equal(readEvidence(s,'t',candidate,{source,offset:4,length:17},access).chunk,row.data.slice(4,21));
    const trace=traceSource(s,'t',source,access);assert.equal(trace.complete,true);assert.equal(trace.missing_reason,undefined);
    assert.strictEqual(visibleMemorySnapshot(s,'r',data,access),data);
    assert.equal(visibleMemorySnapshot(s,'r',content,access),content);
  }
});

test('TaskRecords evidence with a withdrawn knowledge reference still hides the whole captured body', t=>{
  const {s,m,task}=fixture(t),records=new TaskRecords(s),a=m.save('r','reference',entry('PRIVATE_ORIGINAL'),0,'user:owner','source');
  const content='{\n  "ref": "project_memories:'+a.id+':1",\n  "content": "PRIVATE_CAPTURE"\n}\n';
  const data={name:'read_task_record',result:{content,package_json:'{\n  "name": "plain JSON"\n}\n'}};
  records.history('t','execution_evidence',data);
  const row=s.get('SELECT id,data FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 1','t'),source='task_history:'+row.id;
  const candidate={id:'candidate',revision:1,artifacts:[],evidence:[{source,version:'tree',result:{digest:sha(row.data)}}]};
  const qa=taskMemoryAccess(s,task('qa'));
  assert.equal(readEvidence(s,'t',candidate,{source},qa).chunk,row.data,'readable references do not rewrite JSON');
  const originalTrace=traceSource(s,'t',source,qa);assert.equal(originalTrace.complete,true);
  m.save('r',a.key,{catalog:{audience:'role:dev'}},1,'user:owner','withdraw');
  assert.equal(readEvidence(s,'t',candidate,{source},qa).error,'evidence_knowledge_forbidden');
  const filtered=traceSource(s,'t',source,qa);assert.equal(filtered.complete,false);assert.equal(filtered.missing_reason,'knowledge_filtered');assert.equal(filtered.sha256,originalTrace.sha256);
  assert.ok(!JSON.stringify(filtered).includes('PRIVATE_CAPTURE'));
  assert.equal(readEvidence(s,'t',candidate,{source},taskMemoryAccess(s,task('dev'))).chunk,row.data);
});

test('TaskRecords oversized evidence is filtered before capture truncation can retain a private preview', t=>{
  const {s,m,task}=fixture(t),records=new TaskRecords(s),a=m.save('r','oversized-reference',entry(),0,'user:owner','source');
  const qa=taskMemoryAccess(s,task('qa')),captures=[];
  for(const paddingInsideReceipt of [true,false]){
    const receipt={ref:`project_memories:${a.id}:1`,content:'PRIVATE_OVERSIZED_CAPTURE'},padding='x'.repeat(2200000);
    const data={result:paddingInsideReceipt?{...receipt,padding}:receipt,...(paddingInsideReceipt?{}:{padding})};
    records.history('t','execution_evidence',data);
    const row=s.get('SELECT id,data FROM task_history WHERE task_id=? ORDER BY id DESC LIMIT 1','t'),source='task_history:'+row.id;
    const candidate={id:'candidate',revision:1,artifacts:[],evidence:[{source,version:'tree',result:{digest:sha(row.data)}}]};
    assert.equal(readEvidence(s,'t',candidate,{source},qa).chunk,row.data.slice(0,12000));
    const original=traceSource(s,'t',source,qa);assert.equal(original.missing_reason,'capture_limit_exceeded');
    assert.ok(original.preview.includes('PRIVATE_OVERSIZED_CAPTURE'));captures.push({source,candidate,original});
  }
  m.save('r',a.key,{catalog:{audience:'role:dev'}},1,'user:owner','withdraw');
  for(const {source,candidate,original} of captures){
    assert.equal(readEvidence(s,'t',candidate,{source},qa).error,'evidence_knowledge_forbidden');
    const filtered=traceSource(s,'t',source,qa);assert.equal(filtered.complete,false);assert.equal(filtered.missing_reason,'knowledge_filtered');
    assert.equal(filtered.sha256,original.sha256);assert.equal(filtered.original_bytes,original.original_bytes);
    assert.ok(!JSON.stringify(filtered).includes('PRIVATE_OVERSIZED_CAPTURE'));
  }
});
