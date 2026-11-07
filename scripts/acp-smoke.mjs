// Opt-in live ACP probe. Never run by npm test; requires an authenticated operator-configured Agent.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {runRole} from '../dist/roles/run.js';
import {Redactor} from '../dist/agent/common.js';
assert.ok(process.env.BOT_ACP_CONFIG,'Set BOT_ACP_CONFIG to a trusted ACP launch configuration before running this live probe.');
process.umask(0o077);
const root=resolve(process.argv[2]??'.tmp/acp-smoke');mkdirSync(root,{recursive:true,mode:0o700});
const key=join(root,'master.key');if(!existsSync(key))writeFileSync(key,randomBytes(32),{mode:0o600});
const store=new Store(join(root,'control.sqlite'),readFileSync(key));
try{
 store.run("INSERT OR IGNORE INTO accounts VALUES('probe','ACP probe','github_app','1','{}','now')");
 store.run("INSERT OR IGNORE INTO repositories VALUES('probe','fixture/acp-probe','fixture','probe')");
 store.run("INSERT OR IGNORE INTO tasks(id,repository_id,kind,status,summary,input) VALUES('probe','probe','task.request','running','Live ACP probe','{}')");
 if(!store.get("SELECT value FROM settings WHERE key='probe:fact'"))store.run("INSERT INTO settings VALUES('probe:fact',?)",randomBytes(12).toString('hex'));
 const fact=store.get("SELECT value FROM settings WHERE key='probe:fact'").value;
 const records=new TaskRecords(store);if(!store.get("SELECT 1 FROM role_instances WHERE task_id='probe'"))records.contract('probe',{goal:'Read the task fact through the offered tool and submit it.',scope:['ACP live probe'],criteria:['Actual tool call, correct fact, queryable role/session/run binding'],endpoint:'report'});
 const prior=store.get("SELECT id,harness_state,sequence FROM role_instances WHERE task_id='probe' AND role='dev'");
 const fn=(name,description,properties)=>({type:'function',function:{name,description,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}});
 const output=await runRole({store,task:store.get("SELECT * FROM tasks WHERE id='probe'"),redactor:new Redactor(),guard:async()=>{},system:'Execute only this live protocol probe. Do not run shell commands, change files, publish, or start other agents.',prompt:JSON.stringify({task_ref:'task:probe',instruction:'Read task:probe through read_task_record, then call submit_role_result with the returned fact. This is a role result, not task acceptance.',continuing:!!prior}),tools:[fn('read_task_record','Read task facts by reference',{ref:{type:'string'}}),fn('submit_role_result','Submit the observed fact',{fact:{type:'string'}})],execute:async(name,args)=>{assert.equal(name,'read_task_record');assert.equal(args.ref,'task:probe');return {task:records.get('probe').contract,fact};},finish:{name:'submit_role_result',validate:value=>{assert.equal(value.fact,fact);return value;}}},'dev',undefined,'acp');
 const instance=store.get('SELECT id,harness_state,sequence FROM role_instances WHERE id=?',output.instance_id),state=JSON.parse(instance.harness_state);
 const reads=store.get("SELECT count(*) n FROM task_history WHERE task_id='probe' AND type='tool_started' AND json_extract(data,'$.name')='read_task_record'").n;assert.ok(reads>=(prior?.sequence??0)+1);
 if(prior)assert.equal(instance.id,prior.id);
 const proof={pid:process.pid,instance_id:instance.id,sequence:instance.sequence,session_id:state.sessionId,previous_session_id:state.previousSessionId,recovery_mode:state.recoveryMode,agent:state.agentInfo,configuration_hash:state.configurationHash,result_ref:output.reference,actual_fact_reads:reads,runs:store.all("SELECT id,harness,recovery_mode,status FROM task_runs WHERE task_id='probe' ORDER BY rowid")};
 writeFileSync(join(root,'proof-'+instance.sequence+'.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(proof));
}finally{store.close();}
