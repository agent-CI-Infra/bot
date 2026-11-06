import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository,testPassword} from './helpers.mjs';
import {metricTask,usageRequest} from './metrics-fixtures.mjs';

const kinds=['review.issue','review.pr','development.issue','development.pr'];
async function fixture(t){
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  return {h,admin,account:a};
}
function requestAt(store,task,time){const id=usageRequest(store,task,'fixture-model');store.run('UPDATE model_requests SET requested_at=? WHERE id=?',time,id);return id;}

test('requests use their actual local day while whole task runtimes belong to the creation day',async t=>{
  const {h,admin}=await fixture(t);
  for(const [index,kind] of kinds.entries()){
    metricTask(h.store,kind,'101',kind);
    h.store.run('UPDATE tasks SET created_at=? WHERE id=?','2026-11-03T16:30:00.000Z',kind);
    h.store.run('UPDATE task_metrics SET runtime_ms=? WHERE task_id=?',(index+1)*86400000,kind);
  }
  requestAt(h.store,kinds[0],'2026-11-03T16:30:00.000Z');
  requestAt(h.store,kinds[0],'2026-11-04T16:00:00.000Z');
  requestAt(h.store,kinds[0],'2026-11-03T15:59:59.999Z');
  const query='/api/costs?from=2026-11-04&to=2026-11-04';
  let result=(await admin(query+'&timezone=Asia%2FShanghai')).value;
  assert.equal(result.timezone,'Asia/Shanghai');assert.equal(result.summary.requests,1);assert.equal(result.summary.cost,2);
  assert.equal(result.summary.input_tokens,1000000);assert.equal(result.days[0].date,'2026-11-04');
  assert.equal(result.tasks.days.length,4);assert.ok(result.tasks.days.every(row=>row.date==='2026-11-04'));
  for(const [index,kind] of kinds.entries())assert.equal(result.tasks.summary.find(row=>row.kind===kind).runtime_ms,(index+1)*86400000);
  result=(await admin(query+'&timezone=UTC')).value;
  assert.equal(result.summary.requests,1);assert.equal(result.tasks.days.length,0);
  result=(await admin('/api/costs?from=2026-11-03&to=2026-11-03&timezone=America%2FLos_Angeles')).value;
  assert.equal(result.summary.requests,2);assert.equal(result.tasks.summary.length,4);
  assert.equal((await admin(query+'&timezone=unknown%2Fzone')).status,400);
});

test('local day bounds handle both 23-hour and 25-hour daylight-saving days',async t=>{
  const {h,admin}=await fixture(t);metricTask(h.store,'dst');
  for(const [day,times] of [
    ['2026-03-08',['2026-03-08T04:59:59.999Z','2026-03-08T05:00:00.000Z','2026-03-09T03:59:59.999Z','2026-03-09T04:00:00.000Z']],
    ['2026-11-01',['2026-11-01T03:59:59.999Z','2026-11-01T04:00:00.000Z','2026-11-02T04:59:59.999Z','2026-11-02T05:00:00.000Z']],
  ]){
    for(const time of times)requestAt(h.store,'dst',time);
    const result=(await admin(`/api/costs?from=${day}&to=${day}&timezone=America%2FNew_York`)).value;
    assert.equal(result.summary.requests,2);assert.equal(result.days.length,1);assert.equal(result.days[0].date,day);
  }
});

test('undated and missing clocks stay incomplete, live clocks accumulate, and every task result respects repository scope',async t=>{
  const {h,admin}=await fixture(t);
  for(const id of ['legacy','missing','partial','live','undated','other'])metricTask(h.store,id,id==='other'?'202':'101');
  metricTask(h.store,'outside','101','release');
  h.store.run("UPDATE tasks SET created_at='' WHERE id IN ('undated','other')");
  h.store.run("UPDATE task_metrics SET complete=0 WHERE task_id IN ('legacy','partial','undated')");
  h.store.run("UPDATE task_metrics SET runtime_ms=7000 WHERE task_id='partial'");
  h.store.run("DELETE FROM task_metrics WHERE task_id='missing'");
  h.store.run("UPDATE task_metrics SET runtime_ms=2000,active_since=? WHERE task_id='live'",Date.now()-5000);
  const query='/api/costs?from=2026-10-22&to=2026-10-22&repository_id=101';
  let result=(await admin(query)).value;
  assert.equal(result.tasks.summary[0].count,4);assert.equal(result.tasks.summary[0].incomplete_tasks,3);
  assert.equal(result.tasks.summary[0].running_tasks,1);assert.ok(result.tasks.summary[0].runtime_ms>=14000);
  assert.equal(result.tasks.undated.length,1);assert.equal(result.tasks.undated[0].count,1);
  assert.equal(result.tasks.undated[0].runtime_ms,null);assert.equal(result.tasks.undated[0].incomplete_tasks,1);
  h.store.run("DELETE FROM tasks WHERE id IN ('partial','live')");
  result=(await admin(query)).value;assert.equal(result.tasks.summary[0].runtime_ms,null);
  assert.equal(result.tasks.summary[0].incomplete_tasks,2);
  const password=testPassword();await admin('/api/users','POST',{username:'stats-member',password,repository_ids:['101']});
  const member=h.client();await member('/api/auth/login','POST',{username:'stats-member',password});
  result=(await member(query.replace('&repository_id=101',''))).value;
  assert.ok(result.tasks.days.every(row=>row.repository_id==='101'));assert.ok(result.tasks.undated.every(row=>row.repository_id==='101'));
  assert.ok(!JSON.stringify(result).includes('project-202'));assert.equal((await member(query.replace('=101','=202'))).status,403);
  const empty=(await member('/api/costs?from=2020-01-01&to=2020-01-01')).value;
  assert.deepEqual(empty.tasks.days,[]);assert.deepEqual(empty.tasks.summary,[]);assert.equal(empty.tasks.undated.length,1);
  assert.deepEqual((await admin(query+'&currency=CNY')).value.tasks,result.tasks);
});

test('every workflow that runs tasks is counted: built-ins by their names, custom workflows by their saved names',async t=>{
  const {h,admin}=await fixture(t),now=new Date().toISOString();
  h.store.run(`INSERT INTO workflows(repository_id,id,name,created_at,updated_at) VALUES('101','custom.0123456789ab','Docs check',?,?)`,now,now);
  const tasks=[['review.issue',null],['actions.failures',null],['actions.failures',null],['release.observe',null],['workflow.pr','custom.0123456789ab'],['workflow.issue','custom.ba9876543210']];
  for(const [index,[kind,workflow]] of tasks.entries()){
    metricTask(h.store,'task-'+index,'101',kind);
    h.store.run('UPDATE tasks SET created_at=?,workflow_id=? WHERE id=?','2026-11-04T08:00:00.000Z',workflow,'task-'+index);
  }
  const result=(await admin('/api/costs?from=2026-11-04&to=2026-11-04&timezone=UTC')).value;
  assert.deepEqual(result.tasks.summary.map(row=>[row.workflow,row.name,row.count]),[['review.issue','检视 Issue',1],['release.observe','CI 观察',1],
    ['actions.failures','Actions 失败处理',2],['custom.0123456789ab','Docs check',1],['custom.ba9876543210','已删除的工作流',1]]);
  assert.ok(result.tasks.days.every(row=>typeof row.name==='string'&&row.workflow));
});

test('366 days of four task kinds do not consume the existing date-by-repository cost group budget',async t=>{
  const {h,admin,account:a}=await fixture(t);
  h.store.transaction(()=>{
    for(let repo=0;repo<4;repo++){
      const id='range-'+repo;
      h.store.run('INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES(?,?,?,?)',id,'fixture/'+id,'10',a.id);
      for(let day=0;day<366;day++){
        const at=new Date(Date.UTC(2024,0,1+day)).toISOString(),request=id+'-'+day;
        h.store.run(`INSERT INTO model_requests(id,repository_id,request_id,model_id,model_name,requested_at,cost,currency)
          VALUES(?,?,?,'fixture','fixture',?,1,'USD')`,request,id,request,at);
        for(const kind of kinds){
          metricTask(h.store,request+'-'+kind,id,kind);
          h.store.run('UPDATE tasks SET created_at=? WHERE id=?',at,request+'-'+kind);
        }
      }
    }
  });
  // fetch drops a Connection: close request header, so the idle socket stays pooled while the synchronous seeding blocks the
  // event loop. Let the server's expired keep-alive timer close it first; otherwise the next request reuses it and is reset.
  await new Promise(resolve=>setTimeout(resolve,50));
  const result=await admin('/api/costs?from=2024-01-01&to=2024-12-31');
  assert.equal(result.status,200);assert.equal(result.value.days.length,1464);assert.equal(result.value.tasks.days.length,5856);
  for(const row of result.value.tasks.summary)assert.equal(row.count,1464);
});
