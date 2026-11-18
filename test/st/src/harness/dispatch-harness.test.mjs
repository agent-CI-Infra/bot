// These legacy protocol fixtures exercise the explicitly enabled gateway transport.
process.env.BOT_HARNESS_MODEL_TRANSPORT='gateway';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../../../dist/storage/database.js';
import {LocalManager} from '../../../../dist/projects/local-manager.js';
import {roleApi} from '../../../../dist/roles/api.js';
import {recordEvent} from '../../../../dist/dispatch/store.js';
import {Dispatcher} from '../../../../dist/dispatch/worker.js';
import {managerDecision} from '../../../../dist/dispatch/manager.js';

test('event dispatch uses a real Pi session and retains native binding without a business Task',{timeout:60000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'dispatch-pi-')),s=new Store(':memory:',randomBytes(32)),manager=new LocalManager('101',root);let calls=0;const bodies=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls++;bodies.push(body);
  assert.ok(body.tools.some(t=>t.function.name==='bash'));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'d'+calls,type:'function',function:{name:'ignore_event',arguments:JSON.stringify({reason:'This event is informational.'})}}]}}],usage:{prompt_tokens:10,completion_tokens:10}}));
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{await manager.recover();provider.closeAllConnections();await new Promise(r=>provider.close(r));s.close();rmSync(root,{recursive:true,force:true});});
 s.run("INSERT INTO accounts VALUES('a','fixture','github_app','1','{}','now')");s.run("INSERT INTO repositories VALUES('101','fixture/repo','10','a')");
 s.run("INSERT INTO models(id,repository_id,api_url,model_name,api_key,updated_at) VALUES('m','101',?,'fixture',?,'now')",'http://127.0.0.1:'+provider.address().port+'/v1',s.secrets.seal({value:'fixture-key'},'model:m'));
 s.run("INSERT INTO policies(repository_id,model_id,enabled) VALUES('101','m',1)");
 // No role configuration: the defaults run the Manager on Pi (#1068).
 assert.equal(roleApi(s,{id:'admin',role:'project_admin',repositories:['101']},'GET',new URL('http://local/api/repositories/101/roles'),{}).configuration.roles.find(r=>r.role_id==='manager').harness_ref.id,'pi');
 recordEvent(s,{repositoryId:'101',key:'dispatch-probe',type:'schedule.due',source:'schedule',summary:'Inspect event',facts:{},options:[{id:'check',work:'task.request',title:'Check',spec:{type:'request',key:'probe',request:'Inspect',principal:null}}]});
 const dispatcher=new Dispatcher(s,(store,context)=>managerDecision(store,context,undefined,manager));dispatcher.tick();await dispatcher.idle();
 const event=s.get('SELECT * FROM dispatch_events');assert.equal(event.state,'decided',JSON.stringify({error:event.error,result:event.result}));
 assert.equal(event.decision,'ignore');
 const binding=s.get('SELECT * FROM dispatch_harness_sessions');assert.equal(binding.harness,'pi');assert.ok(JSON.parse(binding.state).sessionId);
 assert.equal(s.get('SELECT count(*) n FROM tasks').n,0);assert.equal(calls,1);
 assert.ok(s.get('SELECT count(*) n FROM model_requests').n>0);
 // The Pi Manager reads what the native one reads (#1058): the project's dispatch prompt, with the rule a project_rule basis
 // quotes, the work this event can create, and the write and merge rules; not the role prompt alone.
 const system=JSON.stringify(bodies[0].messages.filter(m=>m.role==='system'||m.role==='developer'));
 for(const text of ['# Project Manager prompt','## Starting development','The bot may develop an Issue on its own when','# Work this event can create','task.request','Never merge a pull request'])
  assert.ok(system.includes(text),text);
});
