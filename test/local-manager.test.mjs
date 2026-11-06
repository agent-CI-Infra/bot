import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { LocalManager } from '../dist/projects/local-manager.js';
import { Store } from '../dist/storage/database.js';
import { runAgent } from '../dist/agent/runtime.js';
import { Redactor } from '../dist/agent/common.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('local runner uses its project directory and scoped cleanup leaves unrelated host processes alive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bot-local-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new LocalManager('123', root), id = 'a'.repeat(48);
  await manager.call('PUT','/v1/projects/123');
  const execute = request => manager.call('POST','/v1/projects/123/execute',{generation:1,operation_id:randomBytes(24).toString('hex'),request});
  assert.equal((await execute({type:'health'})).result.ready,true);
  assert.equal((await execute({type:'workspace_init',workspace_id:id,author_email:'123+test-bot[bot]@users.noreply.github.com'})).ok,true);
  const result = await execute({type:'workspace_command',workspace_id:id,command:'node --version && pwd && sleep 120 &',keep_background:true,timeout_ms:1000});
  assert.equal(result.ok,true);
  const unrelated = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(() => unrelated.kill('SIGKILL'));
  const denied = await execute({type:'workspace_command',workspace_id:id,command:'pkill -f node'});
  assert.equal(denied.result.exit_code,126);
  assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  await assert.rejects(execute({type:'reap'}),/local_reap_requires_workspace/);
  const cleaned = await execute({type:'reap',workspace_id:id});
  assert.equal(cleaned.ok,true);
  assert.equal(cleaned.result.remaining,0);
  assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  await assert.rejects(manager.call('PUT','/v1/projects/999'),/local_project_not_found/);
});

test('local model transport retries preserve the same running agent adapter', async t => {
  const previous = process.env.BOT_LOCAL_EXECUTION;
  process.env.BOT_LOCAL_EXECUTION = 'true';
  t.after(() => { if (previous === undefined) delete process.env.BOT_LOCAL_EXECUTION; else process.env.BOT_LOCAL_EXECUTION = previous; });
  let calls = 0, starts = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(++calls === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calls === 1 ? {error:{message:'temporary outage'}} : { choices: [{message:{role:'assistant',content:'OK'}}] }));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const store = new Store(':memory:',randomBytes(32)); t.after(() => store.close());
  store.run("INSERT INTO accounts VALUES('a','test','bot_account',NULL,'{}','')");
  store.run("INSERT INTO repositories VALUES('123','fixture/repo','10','a')");
  store.run('INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES(?,?,?,?,?,?)','m','123',`http://127.0.0.1:${server.address().port}/v1`,'test',store.secrets.seal({value:'fixture-model-token'},'model:m'),'');
  store.run("INSERT INTO policies(repository_id,model_id) VALUES('123','m')");
  store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('retry-test','123','review.issue','running','test')");
  const result = await runAgent({store,task:store.get("SELECT * FROM tasks WHERE id='retry-test'"),redactor:new Redactor(),guard:async()=>{},system:'test',prompt:'test',
    adapter:async services=>{starts++;return services.request({messages:[{role:'user',content:'OK'}]},'request-1');}});
  assert.equal(result.value.choices[0].message.content,'OK');
  assert.equal(calls,2);assert.equal(starts,1);
  assert.equal(store.get("SELECT count(*) AS n FROM task_logs WHERE json_extract(content,'$.type')='model_retry'").n,1);
});
