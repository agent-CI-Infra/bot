// Opt-in live probe of an external agent harness. Never run by npm test.
// Usage: node scripts/acp-smoke.mjs <dir> [acp|codex] [--cancel-after-turn]
// acp reads BOT_ACP_CONFIG, codex reads BOT_CODEX_CONFIG; both need an operator-configured, authenticated agent for a
// successful role result. A failed run still writes its proof (error code, binding, turn statuses) and exits 1.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../dist/storage/database.js';
import {TaskRecords} from '../dist/tasks/service.js';
import {runRole} from '../dist/roles/run.js';
import {Redactor,TaskError} from '../dist/agent/common.js';
const args=process.argv.slice(2),cancelAfterTurn=args.includes('--cancel-after-turn'),[dir,harness='acp']=args.filter(a=>!a.startsWith('--'));
assert.ok(['acp','codex'].includes(harness),'harness must be acp or codex');
const variable=harness==='codex'?'BOT_CODEX_CONFIG':'BOT_ACP_CONFIG';
assert.ok(process.env[variable],`Set ${variable} to a trusted launch configuration before running this live probe.`);
process.umask(0o077);
const root=resolve(dir??'.tmp/acp-smoke');mkdirSync(root,{recursive:true,mode:0o700});
const key=join(root,'master.key');if(!existsSync(key))writeFileSync(key,randomBytes(32),{mode:0o600});
const store=new Store(join(root,'control.sqlite'),readFileSync(key));
let failed=false;
try{
 store.run("INSERT OR IGNORE INTO accounts VALUES('probe','ACP probe','github_app','1','{}','now')");
 store.run("INSERT OR IGNORE INTO repositories VALUES('probe','fixture/acp-probe','fixture','probe')");
 store.run("INSERT OR IGNORE INTO tasks(id,repository_id,kind,status,summary,input) VALUES('probe','probe','task.request','running','Live ACP probe','{}')");
 if(!store.get("SELECT value FROM settings WHERE key='probe:fact'"))store.run("INSERT INTO settings VALUES('probe:fact',?)",randomBytes(12).toString('hex'));
 const fact=store.get("SELECT value FROM settings WHERE key='probe:fact'").value;
 const records=new TaskRecords(store);if(!store.get("SELECT 1 FROM role_instances WHERE task_id='probe'"))records.contract('probe',{goal:'Read the task fact through the offered tool and submit it.',scope:['ACP live probe'],criteria:['Actual tool call, correct fact, queryable role/session/run binding'],endpoint:'report'});
 const prior=store.get("SELECT id,harness_state,sequence FROM role_instances WHERE task_id='probe' AND role='dev'");
 const fn=(name,description,properties)=>({type:'function',function:{name,description,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}});
 const lastRun=store.get('SELECT coalesce(max(rowid),0) n FROM task_runs').n;
 // --cancel-after-turn cancels the task as soon as this probe's turn has started, to observe interrupt and its receipt.
 const turnStarted=()=>store.get("SELECT 1 FROM task_history h JOIN task_runs r ON r.id=h.run_id WHERE h.task_id='probe' AND h.type='harness_event' AND json_extract(h.data,'$.type')='turn' AND r.rowid>?",lastRun);
 const guard=async()=>{if(cancelAfterTurn&&turnStarted())throw new TaskError('task_cancelled','cancelled');};
 let output=null,error=null;
 try{output=await runRole({store,task:store.get("SELECT * FROM tasks WHERE id='probe'"),redactor:new Redactor(),guard,system:'Execute only this live protocol probe. Do not run shell commands, change files, publish, or start other agents.',prompt:JSON.stringify({task_ref:'task:probe',instruction:'Read task:probe through read_task_record, then call submit_role_result with the returned fact. This is a role result, not task acceptance.',continuing:!!prior}),tools:[fn('read_task_record','Read task facts by reference',{ref:{type:'string'}}),fn('submit_role_result','Submit the observed fact',{fact:{type:'string'}})],execute:async(name,args)=>{assert.equal(name,'read_task_record');assert.equal(args.ref,'task:probe');return {task:records.get('probe').contract,fact};},finish:{name:'submit_role_result',validate:value=>{assert.equal(value.fact,fact);return value;}}},'dev',undefined,harness);}
 catch(e){error={code:e.code??'error',state:e.state??null,detail:typeof e.detail==='string'?e.detail.slice(0,500):null};failed=true;}
 const instance=store.get("SELECT id,harness_state,sequence FROM role_instances WHERE task_id='probe' AND role='dev'"),state=JSON.parse(instance.harness_state);
 const reads=store.get("SELECT count(*) n FROM task_history WHERE task_id='probe' AND type='tool_started' AND json_extract(data,'$.name')='read_task_record'").n;
 if(output){assert.ok(reads>=(prior?.sequence??0)+1);if(prior)assert.equal(instance.id,prior.id);}
 const run=store.get("SELECT id FROM task_runs WHERE task_id='probe' ORDER BY rowid DESC LIMIT 1")?.id;
 const events=run?store.all("SELECT data FROM task_history WHERE run_id=? AND type='harness_event' ORDER BY id",run).map(r=>JSON.parse(r.data)):[];
 const bound=events.find(e=>e.type==='session_bound');
 const proof={pid:process.pid,harness,instance_id:instance.id,sequence:instance.sequence,session_id:state.sessionId,previous_session_id:state.previousSessionId,recovery_mode:state.recoveryMode,agent:state.agentInfo,configuration_hash:state.configurationHash,
  binding:bound?{protocol:bound.protocol??'acp',model:bound.model??null,modelProvider:bound.modelProvider??null,cliVersion:bound.cliVersion??null,tools:bound.tools??null,sandbox:bound.sandbox??null,instructionSources:bound.instructionSources??null,reconciled:bound.reconciled??null}:null,
  turns:events.filter(e=>e.type==='turn').map(e=>({phase:e.phase,turn_id:e.turnId??null,status:e.status??null,receipt:e.receipt??null,error:e.error?.code??null})),permissions:events.filter(e=>e.type==='permission').map(e=>({method:e.method??null,decision:e.decision,reason:e.reason??null})),
  result_ref:output?.reference??null,error,actual_fact_reads:reads,runs:store.all("SELECT id,harness,recovery_mode,protocol_recovery,status FROM task_runs WHERE task_id='probe' ORDER BY rowid")};
 writeFileSync(join(root,'proof-'+instance.sequence+'.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(proof));
}finally{store.close();}
process.exitCode=failed?1:0;
