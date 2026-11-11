import test from 'node:test';
import { fullPermissions, permissionItems } from '../dist/roles/permissions.js';
import { repositoryAssistantPermissions } from '../dist/service-roles/roles.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { managementFixture, settled } from './management-fixture.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { Store } from '../dist/storage/database.js';

const reply=(res,content)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content}}],usage:{prompt_tokens:12,completion_tokens:6}}));};
const roles=async client=>(await client('/api/service-roles')).value.service_roles;
const role=async(client,id)=>(await roles(client)).find(r=>r.id===id);
async function web(f,content,client=f.admin){
  const conversation=(await client('/api/management/conversations','POST',{scope:'platform'})).value.conversation.id;
  const message=(await client('/api/management/conversations/'+conversation+'/messages','POST',{source_message:'service-role-'+Math.random(),content})).value;
  const history=await settled(client,conversation,message.id);
  return {conversation,message:history.messages.find(m=>m.id===message.id),events:history.events.filter(e=>e.message_id===message.id)};
}

test('built-in service roles are seeded once, edited with revisions and audit, and only super administrators maintain them',async t=>{
  const f=await managementFixture(t),{admin,h}=f,member=await f.member('service-role-member',{repository_ids:['101']});
  const seeded=await roles(admin);
  assert.deepEqual(seeded.map(r=>[r.id,r.builtin,r.enabled]),[['management-assistant',true,true],['repository-assistant',true,true]]);
  const assistant=seeded[0],repository=seeded[1];
  assert.deepEqual(assistant.permissions,fullPermissions());assert.equal(assistant.permissions_inherited,false);assert.equal(assistant.permissions_fixed,true);assert.equal(assistant.model.model_name,'Management fixture');
  assert.deepEqual(repository.permissions,repositoryAssistantPermissions);
  assert.deepEqual((await admin('/api/service-roles')).value.permission_items.map(i=>[i.id,i.modes]),
    permissionItems.map(i=>[i.id,i.modes]));
  // Project administrators neither read nor change platform service roles.
  assert.equal((await member.client('/api/service-roles')).status,403);
  assert.equal((await member.client('/api/service-roles/repository-assistant','PATCH',{expected_revision:repository.revision,name:'x'})).status,403);

  const saved=await admin('/api/service-roles/repository-assistant','PATCH',{expected_revision:repository.revision,name:'Committer 助手',permissions:{project_tasks:'write'},budget:{currency:'USD',limit_amount:5}});
  assert.equal(saved.status,200,JSON.stringify(saved.value));
  assert.equal(saved.value.service_role.revision,repository.revision+1);assert.equal(saved.value.service_role.permissions.project_tasks,'write');
  assert.equal(saved.value.service_role.permissions.github_contents,'read');assert.deepEqual(saved.value.service_role.budget,{currency:'USD',limit_amount:5});
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='service_role.updated' AND resource_id='repository-assistant'"));
  const stale=await admin('/api/service-roles/repository-assistant','PATCH',{expected_revision:repository.revision,name:'Stale'});
  assert.deepEqual([stale.status,stale.value.error],[409,'service_role_revision_conflict']);
  assert.equal((await role(admin,'repository-assistant')).name,'Committer 助手');

  for(const [body,code] of [[{permissions:{computer:'execute'}},'invalid_service_role_permission'],[{permissions:{github:'write'}},'invalid_service_role_permission'],
    [{model_id:f.model.id},'shared_model_required'],[{budget:{currency:'EUR',limit_amount:1}},'invalid_pricing_currency'],[{budget:{currency:'USD',limit_amount:0}},'invalid_service_role_budget'],[{unknown:true},'unknown_field']]){
    const current=await role(admin,'repository-assistant'),result=await admin('/api/service-roles/repository-assistant','PATCH',{expected_revision:current.revision,...body});
    assert.deepEqual([result.status,result.value.error],[400,code],JSON.stringify(body));
  }
  // The management assistant always uses the current user's own permissions; built-in roles stay enabled and undeletable.
  assert.equal((await admin('/api/service-roles/management-assistant','PATCH',{expected_revision:assistant.revision,permissions:{github:'read'}})).value.error,'service_role_permissions_fixed');
  assert.equal((await admin('/api/service-roles/management-assistant','PATCH',{expected_revision:assistant.revision,enabled:false})).value.error,'builtin_service_role_required');
  assert.equal((await admin('/api/service-roles/management-assistant','DELETE',{expected_revision:assistant.revision})).value.error,'builtin_service_role_required');

  const created=(await admin('/api/service-roles','POST',{name:'可信 committer 群',responsibility:'可以暂停和取消任务'})).value.service_role;
  assert.match(created.id,/^custom-/);assert.equal(created.builtin,false);assert.deepEqual(created.permissions,repositoryAssistantPermissions);
  const disabled=(await admin('/api/service-roles/'+created.id,'PATCH',{expected_revision:created.revision,enabled:false,permissions:{delegation:'allow'}})).value.service_role;
  assert.deepEqual([disabled.enabled,disabled.permissions.delegation],[false,'allow']);
  assert.equal((await admin('/api/service-roles/'+created.id,'DELETE',{expected_revision:created.revision})).value.error,'service_role_revision_conflict');
  assert.equal((await admin('/api/service-roles/'+created.id,'DELETE',{expected_revision:disabled.revision})).value.ok,true);
  assert.deepEqual((await roles(admin)).map(r=>r.id),['management-assistant','repository-assistant']);
  assert.deepEqual(h.store.all("SELECT action FROM audit WHERE resource_id=? ORDER BY created_at,rowid",created.id).map(r=>r.action),['service_role.created','service_role.updated','service_role.deleted']);

  // A restart keeps administrator edits instead of reseeding the built-in roles.
  await h.stop();await h.start();
  assert.equal((await role(admin,'repository-assistant')).name,'Committer 助手');
});

test('the management assistant uses its own model and ledger even when the first project has no model',async t=>{
  const f=await managementFixture(t),{admin,h}=f;
  f.modelState.respond=async(body,res)=>{assert.match(body.messages[0].content,/No project is preselected/);assert.match(body.messages[0].content,/Only answer about authorized projects/);reply(res,'你好！');};
  const current=await role(admin,'management-assistant');
  await admin('/api/service-roles/management-assistant','PATCH',{expected_revision:current.revision,prompt:'Only answer about authorized projects.'});
  h.store.run("UPDATE policies SET model_id=NULL");
  const greeting=await web(f,'你好');assert.equal(greeting.message.state,'completed',JSON.stringify(greeting.events));
  assert.deepEqual(h.store.all('SELECT repository_id,service_role_id,model_id FROM model_requests').map(r=>({...r})),[{repository_id:null,service_role_id:'management-assistant',model_id:f.assistantModel.id}]);
  // Project statistics never include the assistant; the service role page does.
  const costs=(await admin('/api/costs')).value;assert.equal(costs.summary.requests,0);
  const usage=(await role(admin,'management-assistant')).usage;
  assert.deepEqual([usage.requests,usage.input_tokens,usage.output_tokens,usage.unpriced_requests],[1,12,6,1]);

  // A project's own model is never borrowed: without the assistant's model the turn stops and says where to configure it.
  h.store.run("UPDATE service_roles SET model_id=NULL WHERE id='management-assistant'");
  const before=f.requests.length,missing=await web(f,'你好');
  assert.equal(missing.message.state,'failed');assert.equal(f.requests.length,before);
  const failure=missing.events.find(e=>e.type==='error').data;
  assert.equal(failure.error,'service_role_model_not_configured');assert.match(failure.notice,/全局设置 → 服务角色/);
});

test('service role budgets stop at the limit and on usage that cannot be priced',async t=>{
  const f=await managementFixture(t),{admin,h}=f;
  f.modelState.respond=async(_body,res)=>reply(res,'预算内的回答');
  const setBudget=async budget=>{const current=await role(admin,'management-assistant');return admin('/api/service-roles/management-assistant','PATCH',{expected_revision:current.revision,budget});};
  // The model has no price: a finite budget cannot be checked, so nothing is sent.
  await setBudget({currency:'USD',limit_amount:0.01});
  let before=f.requests.length,result=await web(f,'你好');
  assert.equal(result.events.find(e=>e.type==='error').data.error,'service_role_budget_usage_unknown');assert.equal(f.requests.length,before);
  const model=h.store.get('SELECT version FROM models WHERE id=?',f.assistantModel.id);
  assert.equal((await admin('/api/models/'+f.assistantModel.id,'PATCH',{version:model.version,pricing:{currency:'USD',input_per_million:1000,output_per_million:1000,cache_per_million:1000}})).status,200);
  // A model change bumps the model version; the role still points at it. One request costs 0.018 USD, above the 0.01 limit.
  result=await web(f,'你好');assert.equal(result.message.state,'completed',JSON.stringify(result.events));
  assert.equal(h.store.get("SELECT round(sum(cost),6) cost FROM model_requests WHERE service_role_id='management-assistant'").cost,0.018);
  before=f.requests.length;result=await web(f,'再来一次');
  assert.equal(result.events.find(e=>e.type==='error').data.error,'service_role_budget_exhausted');assert.equal(f.requests.length,before);
  await setBudget({currency:'USD',limit_amount:1});
  assert.equal((await web(f,'继续')).message.state,'completed');
  // A model priced in another currency cannot be measured against the budget.
  await setBudget({currency:'CNY',limit_amount:100});
  assert.equal((await web(f,'换币种')).events.find(e=>e.type==='error').data.error,'service_role_budget_usage_unknown');
});

test('deleting the shared model clears it from service roles and the wizard default fills built-in roles without one',async t=>{
  const f=await managementFixture(t),{admin,h}=f,before=await role(admin,'management-assistant');
  assert.equal((await admin('/api/models/'+f.assistantModel.id,'DELETE',{})).status,200);
  const after=await role(admin,'management-assistant');
  assert.deepEqual([after.model_id,after.revision],[null,before.revision+1]);
  assert.ok(h.store.get("SELECT 1 FROM audit WHERE action='service_role.model_cleared' AND resource_id='management-assistant'"));
  const replacement=(await admin('/api/models','POST',{model_name:'Wizard default',api_url:'http://127.0.0.1:9/v1',api_key:'fixture-provider-key'})).value.model;
  const kept=(await admin('/api/models','POST',{model_name:'Kept choice',api_url:'http://127.0.0.1:9/v1',api_key:'fixture-provider-key'})).value.model;
  const repository=await role(admin,'repository-assistant');await admin('/api/service-roles/repository-assistant','PATCH',{expected_revision:repository.revision,model_id:kept.id});
  assert.equal((await admin('/api/onboarding/model','POST',{model_id:replacement.id})).status,201);
  assert.equal((await role(admin,'management-assistant')).model_id,replacement.id);
  assert.equal((await role(admin,'repository-assistant')).model_id,kept.id);
});

test('an existing ledger is rebuilt once with a nullable repository, keeping every row, column, index and trigger',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'service-ledger-')),path=join(directory,'control.sqlite'),key=randomBytes(32);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  // The ledger as an upgraded deployment has it: the original NOT NULL table plus the columns and indexes added since.
  const legacy=new DatabaseSync(path,{enableForeignKeyConstraints:false});
  legacy.exec(`CREATE TABLE model_requests(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id),request_id TEXT NOT NULL,model_id TEXT NOT NULL,model_name TEXT NOT NULL,
      requested_at TEXT NOT NULL,finished_at TEXT,http_status INTEGER,state TEXT NOT NULL DEFAULT 'pending',
      input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER,
      currency TEXT,input_per_million REAL,output_per_million REAL,cache_per_million REAL,cost REAL);
    ALTER TABLE model_requests ADD COLUMN run_id TEXT;ALTER TABLE model_requests ADD COLUMN request_snapshot TEXT;ALTER TABLE model_requests ADD COLUMN response_snapshot TEXT;
    ALTER TABLE model_requests ADD COLUMN conversation_id TEXT;ALTER TABLE model_requests ADD COLUMN role_id TEXT;ALTER TABLE model_requests ADD COLUMN source_message TEXT;
    ALTER TABLE model_requests ADD COLUMN external_key TEXT;ALTER TABLE model_requests ADD COLUMN accounting_source TEXT NOT NULL DEFAULT 'native';
    CREATE INDEX model_request_task ON model_requests(task_id);
    CREATE INDEX model_request_date ON model_requests(requested_at,repository_id);
    CREATE INDEX model_request_repo_date ON model_requests(repository_id,requested_at);
    CREATE INDEX model_conversation_scope ON model_requests(conversation_id,role_id,requested_at);
    CREATE UNIQUE INDEX external_model_request ON model_requests(external_key) WHERE external_key IS NOT NULL;
    CREATE INDEX model_request_run ON model_requests(run_id);
    CREATE TABLE ledger_probe(id TEXT);
    CREATE TRIGGER ledger_probe_insert AFTER INSERT ON model_requests BEGIN INSERT INTO ledger_probe VALUES(NEW.id); END;`);
  const insert=legacy.prepare(`INSERT INTO model_requests(id,task_id,repository_id,request_id,model_id,model_name,requested_at,finished_at,http_status,state,
    input_tokens,output_tokens,cached_input_tokens,currency,input_per_million,output_per_million,cache_per_million,cost,run_id,request_snapshot,response_snapshot,
    conversation_id,role_id,source_message,external_key,accounting_source) VALUES(?,NULL,?,?,?,?,?,?,200,'received',?,?,?,'USD',1,2,0.5,?,?,?,?,?,?,?,?,?)`);
  insert.run('old-1','101','review:1','m1','Old model','2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',10,5,2,0.00002,'run-1','{"a":1}','{"b":2}','conv-1','dev','msg-1',null,'native');
  insert.run('old-2','102','manager:2','m2','Old model 2','2026-01-02T00:00:00.000Z',null,null,null,null,null,null,null,null,'conv-2','qa','msg-2','ext-2','codex_events');
  const columns=legacy.prepare('PRAGMA table_info(model_requests)').all().map(r=>r.name),rows=legacy.prepare('SELECT * FROM model_requests ORDER BY id').all();
  const indexes=legacy.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='model_requests' AND sql IS NOT NULL ORDER BY name").all();
  legacy.close();

  let store=new Store(path,key);
  const info=store.all('PRAGMA table_info(model_requests)');
  assert.equal(info.find(r=>r.name==='repository_id').notnull,0);
  assert.deepEqual(info.map(r=>r.name),[...columns,'service_role_id']);
  assert.deepEqual(store.all(`SELECT ${columns.join(',')} FROM model_requests ORDER BY id`),rows);
  const rebuilt=store.all("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='model_requests' AND sql IS NOT NULL ORDER BY name");
  for(const index of indexes)assert.deepEqual(rebuilt.find(r=>r.name===index.name),index);
  assert.ok(rebuilt.some(r=>r.name==='model_request_service_role'));
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ledger_probe_insert' AND tbl_name='model_requests'"));
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trace_model_finish'"));
  assert.deepEqual(store.all('PRAGMA foreign_key_list(model_requests)').map(r=>[r.table,r.from]).sort(),[['repositories','repository_id'],['tasks','task_id']]);
  assert.equal(store.get('PRAGMA foreign_keys').foreign_keys,1);
  // The rebuilt ledger accepts service role rows, and project rows still need a valid repository.
  store.run("INSERT INTO model_requests(id,repository_id,service_role_id,request_id,model_id,model_name,requested_at) VALUES('service-1',NULL,'management-assistant','r','m','n','2026-01-03T00:00:00.000Z')");
  assert.ok(store.get("SELECT 1 FROM ledger_probe WHERE id='service-1'"));
  assert.throws(()=>store.run("INSERT INTO model_requests(id,repository_id,request_id,model_id,model_name,requested_at) VALUES('bad',?, 'r','m','n','2026-01-03T00:00:00.000Z')",'missing-repository'),/FOREIGN KEY/);
  const migrated=store.get("SELECT value FROM settings WHERE key='model_requests_nullable_repository'").value,table=store.get("SELECT sql FROM sqlite_master WHERE name='model_requests'").sql;
  store.close();
  // Opening again does not rebuild a second time.
  store=new Store(path,key);t.after(()=>store.close());
  assert.equal(store.get("SELECT value FROM settings WHERE key='model_requests_nullable_repository'").value,migrated);
  assert.equal(store.get("SELECT sql FROM sqlite_master WHERE name='model_requests'").sql,table);
  assert.equal(store.get('SELECT count(*) n FROM model_requests').n,3);
});


test('the full management role cannot lend computer execution to a read-only operator',async t=>{
  const calls=[],manager={async call(method,path,input){
    calls.push({method,path,input});
    return method==='GET'?{generation:1,state:'ready'}:{ok:true,result:input.request.type==='workspace_command'?{output:'command completed',exit_code:0}:{written:true}};
  }};
  const f=await managementFixture(t,store=>({engine:new TaskEngine(store,manager)}));
  const reader=await f.member('computer-reader',{repository_ids:['101']});
  f.h.store.run('UPDATE scoped_grants SET capabilities=? WHERE principal_id=?',JSON.stringify(['tasks.read']),reader.id);
  f.modelState.respond=async(body,res)=>{
    if(body.messages.some(m=>m.role==='tool'))return reply(res,'命令已执行');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'computer',type:'function',function:{name:'run_command',arguments:JSON.stringify({repository:'agent-test-zone/admin-fixture-101',command:'printf computer-check'})}}]}}]}));
  };
  let before=calls.length;
  const denied=await web(f,'执行检查',reader.client);
  assert.equal(denied.message.state,'failed');assert.equal(calls.length,before);
  assert.equal(denied.events.find(e=>e.type==='tool_error').data.error,'capability_forbidden');
  const allowed=await web(f,'执行检查');
  assert.equal(allowed.message.state,'completed',JSON.stringify(allowed.events));
  assert.ok(calls.some(c=>c.input?.request?.type==='workspace_command'));
  assert.equal(f.h.store.get('SELECT count(*) n FROM role_conversation_operations').n,0);
  assert.ok(f.h.store.get('SELECT count(*) n FROM service_role_operations').n>=2);
});
