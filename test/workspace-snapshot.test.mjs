import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Workspace} from '../dist/agent/workspace.js';
import {blobSha,Redactor,TaskError,treeSha,describeEntries} from '../dist/agent/common.js';
import {GitHub} from '../dist/github/client.js';
import {Publisher} from '../dist/github/publisher.js';
import {treeHash} from './fixtures/agent-server.mjs';
import {emptyRepositoryFixture} from './empty-repository-helpers.mjs';
import {loadConsole} from './console-page.mjs';
import {workspace as runnerWorkspace} from '../runner/workspace.mjs';
import {environment} from '../runner/command.mjs';

const commit='a'.repeat(40);
const entry=(path,data,mode='100644')=>({path,mode,type:'blob',sha:blobSha(data),size:data.length});

// Count and hash chunks as they arrive instead of accumulating another repository-sized buffer in the test.
function fixture(files,blobs,options={}){
  const logs=[],reads=[],writes=[],tree=treeHash(files),received=[];
  const github={path:path=>path,authorEmail:()=> '999+fixture-bot@users.noreply.github.com',
    async request(_method,path){
      reads.push(path);
      if(path.startsWith('/git/commits/'))return {tree:{sha:tree}};
      if(options.list)return options.list(path,tree);
      return {tree:files,truncated:false};
    },
    async snapshotBlob(sha){reads.push('/git/blobs/'+sha);const data=blobs.get(sha);return data?.skipped?data:{encoding:'base64',content:data.toString('base64')};}};
  const workspace=new Workspace(null,null,{},new Redactor(),async()=>{},value=>logs.push(value));
  let hash;
  workspace.call=async(_key,request)=>{
    await options.execute?.(request);
    if(request.type==='workspace_write'){
      const file=files.find(file=>file.path===request.path),chunk=Buffer.from(request.base64,'base64');
      if(request.offset===0)hash=createHash('sha1').update(`blob ${file.size}\0`);
      hash.update(chunk);writes.push({path:request.path,offset:request.offset,bytes:chunk.length});
      if(request.final){assert.equal(hash.digest('hex'),file.sha);received.push(file);}
    }
    return request.type==='workspace_snapshot'?{tree_sha:treeHash(received)}:{};
  };
  return {workspace,github,logs,reads,writes,prepare:()=>workspace.prepare(github,commit)};
}

test('prepare accepts 2001 files and logs the commit, file count and bytes',async()=>{
  const data=Buffer.from('small\n'),files=Array.from({length:2001},(_,i)=>entry(`files/${i}.txt`,data));
  const f=fixture(files,new Map([[blobSha(data),data]])),snapshot=await f.prepare();
  assert.equal(snapshot.files.length,2001);assert.equal(snapshot.tree_sha,treeHash(files));
  assert.deepEqual(f.logs.filter(log=>log.type==='snapshot'),[{type:'snapshot',sha:commit,files:2001,bytes:2001*data.length,skipped:0,directory_fallback:false,detail:''}]);
  assert.equal(f.logs.filter(log=>log.type==='snapshot_progress').length,20);
});

test('prepare writes blobs over 1 MiB and totals over 32 MiB with the original context budget',async()=>{
  const binary=Buffer.alloc(5*1024*1024),text=Buffer.alloc(1024*1024+1,120);
  const files=[entry('large.txt',text),...Array.from({length:7},(_,i)=>entry(`binary/${i}`,binary))];
  const f=fixture(files,new Map([[blobSha(binary),binary],[blobSha(text),text]])),snapshot=await f.prepare();
  const summary=f.logs.find(log=>log.type==='snapshot');
  assert.equal(snapshot.files.length,8);assert.equal(summary.bytes,7*binary.length+text.length);
  assert.ok(summary.bytes>32*1024*1024);assert.ok(f.writes.some(write=>write.offset>1024*1024));
  assert.ok(f.writes.every(write=>write.bytes<=30000));assert.equal(snapshot.materials[0].content.length,12000);
  assert.equal(snapshot.materials.length,1);assert.equal(snapshot.materials[0].truncated,true);
});

test('a truncated recursive tree is discarded and every directory is listed nonrecursively',async()=>{
  const data=Buffer.from('nested'),files=[entry('root.txt',data),entry('src/nested/code.txt',data)],dir='b'.repeat(40),nested='c'.repeat(40);
  const f=fixture(files,new Map([[blobSha(data),data]]),{list(path,tree){
    if(path.endsWith('?recursive=1'))return {truncated:true,tree:[entry('incomplete.txt',data)]};
    if(path==='/git/trees/'+tree)return {tree:[files[0],{path:'src',mode:'040000',type:'tree',sha:dir}]};
    if(path==='/git/trees/'+dir)return {tree:[{path:'nested',mode:'040000',type:'tree',sha:nested}]};
    if(path==='/git/trees/'+nested)return {tree:[{...files[1],path:'code.txt'}]};
    assert.fail('Unexpected tree request '+path);
  }});
  const snapshot=await f.prepare();assert.deepEqual(snapshot.files.map(file=>file.path),files.map(file=>file.path));
  assert.equal(f.reads.filter(path=>path.includes('/git/trees/')).length,4);assert.equal(f.logs.find(log=>log.type==='snapshot').directory_fallback,true);
});

test('submodules, unsupported modes and API-rejected huge blobs are skipped with coverage and reasons',async()=>{
  const data=Buffer.from('ok'),huge=entry('weights/model.bin',data),submodule={path:'vendor/module',type:'commit',mode:'160000',sha:'c'.repeat(40)},unsupported={...entry('odd-mode',data),'mode':'100664'};
  huge.sha='d'.repeat(40);huge.size=110*1024*1024;
  const accepted=entry('README.md',data),f=fixture([accepted,submodule,unsupported,huge],new Map([[accepted.sha,data],[huge.sha,{skipped:true,status:403,message:'Blob is too large',size:huge.size}]]));
  const snapshot=await f.prepare();assert.deepEqual(snapshot.files,[{path:accepted.path,mode:accepted.mode,sha:accepted.sha}]);
  assert.equal(snapshot.skipped_files.length,3);assert.equal(snapshot.tree_sha,treeHash([accepted]));
  assert.ok(snapshot.coverage.some(line=>line.includes('skipped 3')));
  const summary=f.logs.find(log=>log.type==='snapshot');
  assert.match(summary.detail,/vendor\/module.*160000/);assert.match(summary.detail,/odd-mode.*100664/);
  assert.match(summary.detail,/weights\/model.bin.*HTTP 403.*115343360 bytes/);
  assert.equal(f.logs.filter(log=>log.type==='snapshot_skipped').length,3);
  assert.ok(!f.reads.includes('/git/blobs/'+submodule.sha));assert.equal(f.writes.length,1);
});

test('hash mismatches and unsafe paths still stop preparation with a locatable reason',async()=>{
  const data=Buffer.from('expected'),file=entry('src/mismatch.txt',data),actual=Buffer.from('different');
  const f=fixture([file],new Map([[file.sha,actual]]));
  await assert.rejects(f.prepare(),error=>error instanceof TaskError&&error.code==='repository_blob_limit_or_hash'&&error.detail.includes(file.path)&&error.detail.includes(file.sha)&&error.detail.includes(blobSha(actual)));
  assert.equal(f.logs.find(log=>log.type==='snapshot').files,0);assert.equal(f.logs[0].sha,commit);
  const unsafe=fixture([{...file,path:'../outside'}],new Map([[file.sha,data]]));
  await assert.rejects(unsafe.prepare(),error=>error.code==='unsafe_repository_path'&&error.detail.includes('../outside'));
  assert.equal(unsafe.writes.length,0);
});

test('skip descriptions report exactly how many entries were omitted',()=>{
  const lines=Array.from({length:2000},(_,i)=>`Skipped path/${i}: mode 160000`),detail=describeEntries(lines,1000);
  const kept=detail.split('\n').filter(line=>line.startsWith('Skipped')).length;
  assert.match(detail,new RegExp(`${lines.length-kept} entries omitted`));assert.ok(detail.length<1100);
});

test('preparing 250 files records starts, progress and skipped paths before finalization returns',async()=>{
  const data=Buffer.from('snapshot body stays out of progress'),files=Array.from({length:250},(_,i)=>entry(`src/${i}.txt`,data));
  const submodule={path:'vendor/module',type:'commit',mode:'160000',sha:'c'.repeat(40)};
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=fixture([...files,submodule],new Map([[blobSha(data),data]]),{async execute(request){
    if(request.type==='workspace_snapshot'){entered.resolve();await release.promise;}
  }});
  const preparing=f.prepare();await entered.promise;
  try{
    assert.equal(f.logs[0].phase,'prepare');assert.equal(f.logs[0].sha,commit);assert.match(f.logs[0].detail,/正在准备工作区/);
    assert.deepEqual(f.logs.filter(log=>log.type==='snapshot_progress').map(({files,bytes,path})=>({files,bytes,path})),[
      {files:100,bytes:100*data.length,path:'src/99.txt'},{files:200,bytes:200*data.length,path:'src/199.txt'}]);
    const skipped=f.logs.find(log=>log.type==='snapshot_skipped');assert.equal(skipped.path,submodule.path);assert.match(skipped.reason,/160000.*子模块/);
    assert.equal(f.logs.at(-1).type,'snapshot_git');assert.equal(f.logs.some(log=>log.type==='snapshot'),false);
    assert.ok(!JSON.stringify(f.logs).includes(data.toString()));
  }finally{release.resolve();await preparing;}
  assert.equal(f.logs.at(-1).type,'snapshot');assert.equal(f.logs.at(-1).files,250);
});

test('candidate transfer reuses unchanged upstream blobs and has no 32 MiB total cap',async()=>{
  const data=Buffer.alloc(17*1024*1024,120),file=entry('large.bin',data),unchanged={...file,path:'original.bin'};
  const workspace=new Workspace(null,null,{},new Redactor(),async()=>{},()=>{}),calls=[];
  workspace.call=async(_key,request)=>{calls.push(request);return {base64:data.subarray(request.offset,request.offset+30000).toString('base64')};};
  const files=await workspace.contents([unchanged,file,{...file,path:'second.bin'}],[unchanged]);
  assert.equal(files[0].base64,undefined);assert.equal(files.length,3);
  assert.equal(Buffer.from(files[1].base64,'base64').length+Buffer.from(files[2].base64,'base64').length,34*1024*1024);
  assert.equal(calls.filter(request=>request.offset===0).length,2);
});

test('snapshot blob downloads bypass the 48 MiB JSON cap while ordinary responses and permission errors remain bounded',async t=>{
  const data=Buffer.alloc(37*1024*1024,120),sha=blobSha(data),content=data.toString('base64');let mode='large';
  const server=createServer((_req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(mode==='large')return res.end(JSON.stringify({encoding:'base64',content,size:data.length}));
    res.statusCode=403;res.end(JSON.stringify(mode==='size'?{message:'Blob is too large',size:110*1024*1024}:{message:'Resource not accessible by integration'}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const github=new GitHub(null,{},new Redactor(),async()=>{},'http://127.0.0.1:'+server.address().port);github.fullName='fixture/repo';
  assert.ok(content.length>48*1024*1024);
  const blob=await github.snapshotBlob(sha);assert.equal(blobSha(Buffer.from(blob.content,'base64')),sha);
  await assert.rejects(github.request('GET',github.path('/ordinary')),error=>error.code==='github_response_too_large');
  mode='size';assert.deepEqual(await github.snapshotBlob(sha),{skipped:true,status:403,size:110*1024*1024,message:'Blob is too large'});
  mode='permission';await assert.rejects(github.snapshotBlob(sha),error=>error.code==='github_permission_403');
});

test('runner writes and reads a large file in chunks, finalizes over 2000 files and handles ls-tree output above 4 MiB',async t=>{
  mkdirSync(resolve('.tmp'),{recursive:true});const root=mkdtempSync(resolve('.tmp/runner-snapshot-')),id='a'.repeat(48),repo=join(root,id,'repo');
  const previous={HOME:environment.HOME,TMPDIR:environment.TMPDIR};Object.assign(environment,{HOME:root,TMPDIR:root});
  t.after(()=>{Object.assign(environment,previous);rmSync(root,{recursive:true,force:true});});
  const run=request=>runnerWorkspace({...request,workspace_id:id},root);
  await run({type:'workspace_init'});
  const data=Buffer.alloc(5*1024*1024+17,120),file=entry('large.txt',data);
  for(let offset=0;offset<data.length;offset+=30000)await run({type:'workspace_write',path:file.path,mode:file.mode,sha:file.sha,snapshot:true,offset,base64:data.subarray(offset,offset+30000).toString('base64'),final:offset+30000>=data.length});
  assert.equal((await run({type:'workspace_read',path:file.path})).content.length,data.length);
  assert.equal((await run({type:'workspace_snapshot',tree_sha:treeHash([file])})).tree_sha,treeHash([file]));
  const directory=Array(5).fill('d'.repeat(180)).join('/');mkdirSync(join(repo,directory),{recursive:true});
  for(let i=0;i<5001;i++)writeFileSync(join(repo,directory,`${String(i).padStart(5,'0')}-${'f'.repeat(50)}`),'');
  const result=await run({type:'workspace_finalize'});assert.equal(result.files.length,5002);
  assert.equal(result.files.find(item=>item.path===file.path).size,data.length);
  const raw=execFileSync('git',['ls-tree','-r','-l','-z',result.tree_sha],{cwd:repo,maxBuffer:16*1024*1024});assert.ok(raw.length>4*1024*1024);
  const hash=createHash('sha1').update(`blob ${data.length}\0`);
  for(let offset=0;offset<data.length;offset+=30000){const part=await run({type:'workspace_blob',sha:file.sha,offset});assert.equal(part.size,data.length);hash.update(Buffer.from(part.base64,'base64'));}
  assert.equal(hash.digest('hex'),file.sha);
  assert.equal(readFileSync(join(root,id,'blob-'+file.sha)).length,data.length);
  await assert.rejects(run({type:'workspace_write',path:'../outside',base64:'',offset:0,final:true,mode:'100644'}),/invalid_path/);
  renameSync(repo,repo+'-saved');symlinkSync(repo+'-saved',repo);
  await assert.rejects(run({type:'workspace_finalize'}),/workspace_replaced/);
});

test('failed task detail exposes redacted hash-mismatch reasons and preserves preparation logs',async t=>{
  const file=entry('src/fixture-key.txt',Buffer.from('expected')),h=await emptyRepositoryFixture(t,{files:[file]});h.setBranch('ready');
  const task=await h.run();assert.equal(task.status,'failed');assert.equal(task.error_code,'repository_blob_limit_or_hash');
  const {value:detail}=await h.admin('/api/tasks/'+h.taskId),{value:{logs}}=await h.admin('/api/tasks/'+h.taskId+'/logs');
  assert.match(detail.task.error_detail,/src\/\[REDACTED\]\.txt/);assert.match(detail.task.error_detail,/expected [a-f0-9]{40}, actual [a-f0-9]{40}/);
  assert.ok(!JSON.stringify(logs).includes('fixture-key'));assert.equal(logs.map(log=>JSON.parse(log.content)).filter(log=>log.type==='snapshot').length,1);
  const fault=logs.map(log=>JSON.parse(log.content)).find(log=>log.type==='fault');assert.equal(fault.detail,detail.task.error_detail);
});

test('rule preflight and preparation both use the complete directory fallback instead of failing on truncated trees',async t=>{
  const data=Buffer.from('ready'),file=entry('ready.txt',data),h=await emptyRepositoryFixture(t,{files:[file],blob:{encoding:'base64',content:data.toString('base64')},truncated:true});
  h.setBranch('ready');const task=await h.run();assert.equal(task.status,'succeeded');
  const logs=h.store.all('SELECT content FROM task_logs WHERE task_id=?',h.taskId).map(row=>JSON.parse(row.content));
  const snapshot=logs.find(log=>log.type==='snapshot');assert.equal(snapshot.files,1);assert.equal(snapshot.directory_fallback,true);
  assert.equal(logs[0].type,'queued');
  const phases=logs.filter(log=>log.type==='phase');assert.deepEqual(phases.map(log=>log.phase),['prepare','model','publish']);
  assert.equal(phases[1].mode,'review');assert.equal(phases[2].target,'review');
  assert.ok(!logs.some(log=>log.code==='repository_tree_truncated'));
});

test('automatic waiting retries deduplicate equal details but retain changed reasons and valid truncated JSON',async t=>{
  const data=Buffer.from('ok'),file=entry('src/ok.txt',data);let reason='workspace_replaced: fixture-key/path '+JSON.stringify({entry:'"'}).repeat(40000)+' tail/path';
  const h=await emptyRepositoryFixture(t,{files:[file],blob:{encoding:'base64',content:data.toString('base64')},execute:request=>request.type==='workspace_write'?{ok:false,error:'runner_operation_failed',detail:reason}:null});
  h.setBranch('ready');let task=await h.run();assert.equal(task.status,'waiting_environment');
  const logs=()=>h.store.all('SELECT content FROM task_logs WHERE task_id=?',h.taskId).map(row=>{assert.ok(row.content.length<70000);return JSON.parse(row.content);});
  assert.equal(logs().filter(log=>log.type==='fault').length,1);
  let fault=logs().find(log=>log.type==='fault');assert.match(fault.detail,/workspace_replaced/);assert.match(fault.detail,/tail\/path/);assert.match(fault.detail,/omitted/);assert.ok(!fault.detail.includes('fixture-key'));
  for(let i=0;i<3;i++){h.due();task=await h.run();assert.equal(task.status,'waiting_environment');}
  assert.equal(logs().filter(log=>log.type==='fault').length,1);assert.equal(logs().filter(log=>log.type==='snapshot').length,1);
  assert.equal(logs().filter(log=>log.type==='phase'&&log.phase==='prepare').length,1,'waiting retries retain one phase start');
  // The journal replays the failed operation; simulate a refreshed response for a newly diagnosed cause.
  h.store.run('DELETE FROM task_tools WHERE task_id=?',h.taskId);reason='invalid_parent: changed/path';h.due();await h.run();
  assert.equal(logs().filter(log=>log.type==='fault').length,2);
});

test('new logs render during execution, survive terminal states and do not duplicate on refresh',async()=>{
  const task={id:'task',repository_id:'101',kind:'review.issue',object_number:1,status:'running',phase:'prepare'};
  const values=[
    {type:'queued',detail:'排队中，等待仓库 101 的虚拟电脑空闲…'},
    {type:'phase',phase:'prepare',detail:`正在准备工作区：拉取固定提交 ${commit} 并写入虚拟电脑…`},
    {type:'snapshot_progress',detail:'正在写入仓库快照：已写入 100 个文件，600 字节；刚写完 src/99.txt'},
    {type:'snapshot_skipped',detail:'已跳过路径 vendor/module：mode 160000；子模块不克隆。'},
    {type:'snapshot_git',detail:'正在构建本地 Git 树：abc'},
    {type:'phase',phase:'model',detail:'Agent 开始执行：检视…'},
    {type:'tool_start',name:'run_command',command:'npm test'},
    {type:'tool_start',name:'write_file',path:'src/main.js'},
    {type:'tool_start',name:'finish_review'},
    {type:'tool_start',name:'create_pull_request'},
    {type:'phase',phase:'validate',detail:'正在运行测试：npm test'},
    {type:'phase',phase:'publish',detail:'正在发布到 GitHub：发送检视评论…'}];
  const logs=values.map((value,i)=>({id:String(i),content:JSON.stringify(value)}));
  const page=loadConsole(['static/app.js','static/views.js'],(_method,path)=>path.endsWith('/logs')?[200,{logs}]:path==='/api/tasks/task'?[200,{task,publications:[]}]:[404,{}]);
  page.run("scroller = node => node; taskMetricsCard = () => element('section',''); openTaskId = 'task'; taskView.showModal();");
  try{
    for(const status of ['running','failed','succeeded']){
      task.status=status;
      await page.run('(async () => { await refreshTask(); clearTimeout(taskTimer); })()');
      assert.equal(page.$('timeline').children.length,logs.length);
      const text=node=>[node.textContent,...node.children.flatMap(text)].join('\n'),visible=text(page.$('timeline'));
      for(const expected of ['工作区准备日志','仓库快照进度日志','仓库快照跳过日志','本地 Git 树日志','Agent 执行日志','工具开始日志','仓库测试日志','GitHub 发布日志','src/99.txt','vendor/module','npm test','src/main.js','finish_review','create_pull_request',commit])assert.ok(visible.includes(expected),expected);
    }
  }finally{page.run('taskView.close(); clearTimeout(taskTimer);');}
});

test('failed, waiting and retry-wait details show reasons in the timeline and sidebar without raw data',async()=>{
  const detail='Blob hash mismatch for src/problem.txt: expected abc, actual def';
  for(const status of ['failed','waiting_environment','waiting_configuration','waiting_permission','waiting_publication','waiting_pr_head','retry_wait']){
    const task={id:'task',repository_id:'101',kind:'review.issue',object_number:1,status,phase:'prepare',attempt:1,error_code:'repository_blob_limit_or_hash',error_detail:detail};
    const logs=[{id:'snapshot',content:JSON.stringify({type:'snapshot',sha:commit,files:1,bytes:12,skipped:1,detail:'Skipped vendor/module: mode 160000'})},{id:'fault',content:JSON.stringify({type:'fault',state:status,code:task.error_code,detail})}];
    const page=loadConsole(['static/app.js','static/views.js'],(_method,path)=>path.endsWith('/logs')?[200,{logs}]:path==='/api/tasks/task'?[200,{task,publications:[]}]:[404,{}]);
    page.run("scroller = node => node; taskMetricsCard = () => element('section',''); openTaskId = 'task'; taskView.showModal();");
    await page.run('(async () => { await refreshTask(); clearTimeout(taskTimer); })()');
    const visible=node=>node.tagName==='DETAILS'?[]:[node.textContent,...node.children.flatMap(visible)];
    assert.ok(visible(page.$('timeline')).includes(detail));assert.ok(visible(page.$('task-side')).includes(detail));
    assert.ok(visible(page.$('timeline')).includes('Skipped vendor/module: mode 160000'));assert.equal(page.$('timeline').children.length,2);
    page.run('taskView.close(); clearTimeout(taskTimer);');
  }
});

test('publishing a partial snapshot preserves excluded upstream paths and verifies the complete remote tree',async t=>{
  const h=await emptyRepositoryFixture(t),data=Buffer.from('changed'),file=entry('src/changed.txt',data),deleted=entry('delete.txt',Buffer.from('old'));
  const skipped=[{path:'vendor/module',mode:'160000',sha:'b'.repeat(40)},{path:'weights/huge.bin',mode:'100644',sha:'c'.repeat(40)}],expected=treeHash([file,...skipped]);
  const branch='bot/issue-1-snapshot',source='d'.repeat(40),writes=[];
  h.store.run('INSERT INTO bot_branches VALUES(?,?,?)','101',branch,h.taskId);
  const github={defaultBranch:'main',path:path=>path,authorEmail:()=> '999+fixture-bot@users.noreply.github.com',ref:async()=>null,
    async request(_method,path,body){writes.push({path,body});if(path==='/git/blobs')return {sha:file.sha};if(path==='/git/trees')return {sha:expected};if(path==='/git/commits')return {sha:'e'.repeat(40),tree:{sha:expected}};if(path==='/git/refs')return {object:{sha:'e'.repeat(40)}};assert.fail(path);}};
  const candidate={branch,owner_task_id:h.taskId,files:[{...file,base64:data.toString('base64')}],skipped_files:skipped,snapshot_files:[deleted],source_tree:source,tree_sha:treeHash([file]),base_sha:commit,date:new Date().toISOString(),summary:'Update source',test_command:'true',validation:{source:'agent',skipped:true,command:'true'}};
  const publisher=new Publisher(h.store,github,h.store.get('SELECT * FROM tasks WHERE id=?',h.taskId),async()=>{});
  assert.equal(await publisher.branch(candidate),'e'.repeat(40));
  const request=writes.find(write=>write.path==='/git/trees').body;assert.equal(request.base_tree,source);
  assert.ok(request.tree.some(item=>item.path===deleted.path&&item.sha===null));assert.ok(!request.tree.some(item=>item.path.startsWith('vendor/')||item.path.startsWith('weights/')));
  assert.equal(writes.find(write=>write.path==='/git/commits').body.tree,expected);
  assert.equal(treeSha([file,...skipped]),expected);
});
