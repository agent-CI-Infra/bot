import { Store } from '../dist/storage/database.js';
import { ResultSession, resultScope, commandResult } from '../dist/agent/tool-results.js';
// Opt-in acceptance using real Docker execs, process groups and pipes. No deployed containers are modified.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Docker } from '../manager/docker.mjs';
import { Projects } from '../manager/projects.mjs';

const id=()=>randomBytes(24).toString('hex'),tag=randomBytes(4).toString('hex');
const deployment='commands'+tag,image=`bot-command-lifecycle-${tag}:test`,repo='632';
const work=resolve('.tmp/command-lifecycle-docker',tag),base=process.env.BOT_TEST_BASE_IMAGE||'department-bot-project-computer:local';
mkdirSync(work,{recursive:true});
const sh=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',maxBuffer:16*1024*1024});
const evidence={deployment,image,base,checks:[]},passed=name=>{evidence.checks.push(name);console.log('PASS '+name);};
class TestDocker extends Docker {
  async volumeSource(directory){return directory;}
  async runner(container,input,wait){
    if(input.type==='git_export'){
      // The real runner starts a process group, then the real Docker socket request times out before its result.
      return super.runner(container,{...input,type:'command',command:'echo $$ > /workspace/timed-pid; sleep 30 & wait',timeout_ms:null},200);
    }
    if(input.type==='health'&&this.unhealthy)return {ok:false,error:'injected_unhealthy'};
    return super.runner(container,input,wait);
  }
}
const docker=new TestDocker();let projects,built=false;
try{
  const context=join(work,'context');mkdirSync(join(context,'runner'),{recursive:true});
  for(const name of readdirSync('runner'))if(name.endsWith('.mjs'))cpSync(join('runner',name),join(context,'runner',name));
  writeFileSync(join(context,'Dockerfile'),`FROM ${base}\nUSER root\nCOPY runner/ /opt/runner/\nRUN chmod -R a-w /opt/runner\nUSER 10001:10001\n`);
  sh('docker',['build','-q','-t',image,'--label','department.bot.deployment='+deployment,context]);
  built=true;
  projects=new Projects({database:join(work,'manager.sqlite'),docker,deployment,image,egress:false});
  await projects.register(repo);projects.parallelism(repo,2);
  const container=projects.names(repo,1).container,ws=id();
  const call=request=>projects.operate(repo,'execute',{operation_id:id(),generation:1,request});
  const raw=request=>Docker.prototype.runner.call(docker,container,{operation_id:id(),...request},10000);
  const command=value=>call({type:'workspace_command',workspace_id:ws,command:value,timeout_ms:10000});
  await call({type:'workspace_init',workspace_id:ws});
  const started=projects.get(repo).started_at;
  const other=command('echo started > long-started; sleep 2; echo survived');
  // Wait for the command to enter the container before timing out its neighbour.
  for(let n=0;n<100;n++){
    const read=await raw({type:'read',path:`tasks/${ws}/repo/long-started`});if(read.ok)break;
    if(n===99)throw new Error('concurrent command did not start');
    await new Promise(r=>setTimeout(r,20));
  }
  await assert.rejects(call({type:'git_export'}),/docker_timeout/);
  assert.equal((await other).result.output,'survived\n');
  assert.equal(projects.get(repo).state,'ready');assert.equal(projects.get(repo).started_at,started);
  const dead=await raw({type:'command',command:'pid=$(cat /workspace/timed-pid); test ! -e /proc/$pid/stat || grep -q ") Z " /proc/$pid/stat',timeout_ms:5000});
  assert.equal(dead.result.exit_code,0);passed('unscoped RPC timeout ends its operation while another task finishes on the same container');

  const service=`const fs=require('fs'),http=require('http');const s=http.createServer((q,r)=>r.end('alive'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync('port',String(s.address().port)));setTimeout(()=>{process.stdout.write('x'.repeat(2*1024*1024));process.stderr.write('logged-after-runner-exit\\n');fs.writeFileSync('printed','yes');},1200)`;
  const kept=await call({type:'workspace_command',workspace_id:ws,command:`node -e ${JSON.stringify(service)}`,keep_background:true,timeout_ms:5000});
  assert.equal(kept.result.running,true);assert.ok(kept.result.log_path.startsWith(`/workspace/tasks/${ws}/logs/`));
  const probe=await command(`node -e "const fs=require('fs');(async()=>{while(!fs.existsSync('printed'))await new Promise(r=>setTimeout(r,50));console.log(await(await fetch('http://127.0.0.1:'+fs.readFileSync('port','utf8'))).text());const log=fs.readFileSync('${kept.result.log_path}','utf8');if(log.length<2097152||!log.includes('logged-after-runner-exit'))process.exit(2)})()"`);
  assert.equal(probe.result.exit_code,0,probe.result.output);assert.equal(probe.result.output,'alive\n');
  passed('background service remains reachable after runner exit and writes more than 2 MiB to the returned log');
  await call({type:'reap',workspace_id:ws});

  await command('sleep 30 & echo $! > ordinary-pid');
  const ordinary=await command('pid=$(cat ordinary-pid); test ! -e /proc/$pid/stat || grep -q ") Z " /proc/$pid/stat');
  assert.equal(ordinary.result.exit_code,0);passed('ordinary shell exit still reaps its process group');
  const resultStore=new Store(':memory:',randomBytes(32));
  try{
    const session=new ResultSession(resultStore,resultScope(resultStore,{id:'command-output',conversation_id:'docker'}),()=> 'docker-owner',()=>{});
    for(const code of [0,1]){
      const text='HEAD\n'+'中😀'.repeat(800000)+'\nFINAL_'+code+'\n';
      const producer="process.stdout.write('HEAD\\n'+'中😀'.repeat(800000)+'\\nFINAL_"+code+"\\n',()=>{process.exitCode="+code+"})";
      const large=await call({type:'workspace_command',workspace_id:ws,command:'node -e '+JSON.stringify(producer),timeout_ms:30000});
      assert.equal(large.result.exit_code,code);assert.equal(large.result.truncated,true);assert.match(large.result.tail,new RegExp('FINAL_'+code));
      // call() chooses the operation id; the runner-owned output_file names the exact journal that produced the result.
      const source=/\/([a-f0-9]{48})\.out$/.exec(large.result.output_file)?.[1];assert.ok(source);
      const saved=await session.execute('run_command',{},()=>commandResult(large.result,source,offset=>projects.output(repo,source,offset)));
      assert.equal(saved.error,undefined);assert.ok(saved.file);assert.equal(saved.output_file,undefined);
      let position=0,complete='';for(;;){const page=await session.read({file:saved.file,position,length:65536});assert.equal(page.error,undefined);complete+=page.content;if(page.eof)break;position=page.next_position;}
      assert.equal(complete,text);
    }
    passed('5 MiB success/failure commands finish in Docker and complete UTF-8 output pages without re-execution');
  }finally{resultStore.close();}
  docker.unhealthy=true;
  await assert.rejects(call({type:'git_export'}),/docker_timeout/);
  assert.equal(projects.get(repo).state,'failed');
  assert.equal((await docker.request('GET',`/containers/${container}/json`)).State.Running,false);
  passed('failed runner health check still stops the project computer');
}finally{
  evidence.finished_at=new Date().toISOString();writeFileSync(join(work,'evidence.json'),JSON.stringify(evidence,null,2));
  if(projects){
    try{await projects.operate(repo,'delete',{operation_id:id(),generation:1});
      for(const name of [projects.names(repo,1).volume,projects.notesName(repo)])await docker.request('DELETE','/volumes/'+name);
    }finally{projects.trajectories.closeAll();projects.db.close();}
  }
  if(built)sh('docker',['image','rm',image]);
}
