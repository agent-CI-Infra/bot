import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConsole} from './console-page.mjs';

const text=node=>[node.textContent,...node.children.map(text)].filter(Boolean).join('\n');
const prepare={type:'phase',phase:'prepare',detail:'正在准备工作区：拉取固定提交 abc 并写入虚拟电脑…'};
const progress=files=>({type:'snapshot_progress',sha:'abc',files,bytes:files*10,path:`src/${files-1}.txt`,detail:`已写入 ${files} 个文件；刚写完 src/${files-1}.txt`});
function fixture(t){
  const task={id:'task',repository_id:'101',kind:'review.issue',object_number:1,status:'running',phase:'prepare'},logs=[];
  const second={task:{...task,id:'second'},logs:[]};
  const page=loadConsole(['static/app.js','static/views.js'],(_method,path)=>{
    const current=path.startsWith('/api/tasks/second')?second:{task,logs};
    if(path.endsWith('/logs'))return [200,{logs:current.logs}];
    if(path==='/api/tasks/'+current.task.id)return [200,{task:current.task,publications:[]}];
    return [404,{}];
  });
  page.run("scroller = node => node; taskMetricsCard = () => element('section','');");
  t.after(()=>page.run('taskView.close(); clearTimeout(taskTimer);'));
  const add=value=>logs.push({id:String(logs.length),created_at:'2026-10-27T16:30:00Z',content:JSON.stringify(value)});
  return {task,logs,second,page,add,
    open:async(id='task')=>{await page.run(`openTask(${JSON.stringify(id)})`);page.run('clearTimeout(taskTimer)');},
    refresh:()=>page.run('(async () => { await refreshTask(); clearTimeout(taskTimer); })()'),
    groups:()=>page.$('timeline').querySelectorAll('details.snapshot-progress')};
}

test('snapshot preparation is one folded entry and appends live lines without resetting the reader',async t=>{
  const f=fixture(t);f.add(prepare);await f.open();
  const [fold]=f.groups(),output=fold.querySelector('pre');
  assert.equal(f.page.$('timeline').children.length,1);assert.equal(fold.open,false);
  assert.match(text(fold.querySelector('summary')),/仓库快照进度/);assert.match(text(output),/\[16:30:00\] 正在准备工作区/);
  fold.open=true;Object.assign(output,{scrollHeight:1000,clientHeight:200,scrollTop:800});
  f.add(progress(100));await f.refresh();
  assert.equal(f.groups()[0],fold);assert.equal(fold.open,true);assert.equal(output.scrollTop,1000);
  assert.match(text(fold.querySelector('summary')),/已写入 100 个文件 · 1000 字节/);
  assert.match(text(output),/src\/99.txt/);
  output.scrollTop=100;f.add(progress(200));await f.refresh();
  assert.equal(output.scrollTop,100,'new progress does not pull a reader away from earlier lines');
  const before=text(output);await f.refresh();assert.equal(text(output),before,'polling does not duplicate existing lines');
  assert.ok(before.indexOf('src/99.txt')<before.indexOf('src/199.txt'));
  fold.open=false;f.add(progress(300));await f.refresh();assert.equal(fold.open,false);
  fold.open=true;fold.listeners.toggle[0]();assert.equal(output.scrollTop,1000,'reopening follows the latest lines');
  assert.equal(f.page.$('timeline').children.length,1);
});

test('skip, Git tree and final snapshot records share the stream, while later task failures stay separate',async t=>{
  const f=fixture(t);f.add(prepare);f.add(progress(100));
  f.add({type:'snapshot_skipped',detail:'已跳过路径 vendor/<script>alert(1)</script>：子模块不克隆。'});
  f.add({type:'snapshot_git',tree_sha:'tree-abc',detail:'正在构建本地 Git 树：tree-abc'});
  await f.open();const [fold]=f.groups(),output=fold.querySelector('pre');
  assert.match(text(fold.querySelector('summary')),/正在构建本地 Git 树/);
  assert.match(text(output),/vendor\/<script>alert\(1\)<\/script>/);assert.equal(output.querySelector('script'),null);
  assert.match(text(output),/本地 Git 树：tree-abc/);
  f.add({type:'snapshot',sha:'abc',files:150,bytes:1500,skipped:1,source:'git_cache',cache:'hit',directory_fallback:true,detail:'快照附加说明'});
  f.add({type:'prepared',sha:'abc',coverage:[]});f.add({type:'phase',phase:'model',detail:'开始检视'});
  f.task.phase='model';await f.refresh();
  assert.equal(f.groups().length,1);assert.equal(f.groups()[0],fold);
  assert.match(text(fold.querySelector('summary')),/已接收 150 个文件 · 1500 字节 · 跳过 1 项/);
  assert.match(text(fold.querySelector('summary')),/已完成/);
  for(const detail of ['Git 缓存','逐目录列举','快照附加说明'])assert.ok(text(output).includes(detail),detail);
  f.task.status='failed';f.add({type:'fault',state:'failed',code:'model_http_400',detail:'模型请求失败，HTTP 400。'});await f.refresh();
  assert.match(text(fold.querySelector('summary')),/已完成/,'a later failure does not mark the finished snapshot as failed');
  assert.match(text(f.page.$('timeline').querySelector('.step-fault')),/HTTP 400/);
  assert.equal(fold.open,false);
});

test('retry preparations get separate groups and switching tasks clears the active snapshot',async t=>{
  const f=fixture(t);f.add(prepare);f.add(progress(100));
  f.add({type:'snapshot',sha:'abc',files:100,bytes:1000,skipped:0});
  f.add({type:'fault',state:'waiting_environment',code:'execution_interrupted',detail:'项目电脑连接中断。'});
  f.task.status='waiting_environment';await f.open();
  const [first]=f.groups();assert.match(text(first.querySelector('summary')),/已暂停/);
  first.open=true;f.add({type:'restart_attempt'});f.add({...prepare,detail:'正在准备新一次尝试'});f.add({...progress(200),sha:'def'});
  f.task.status='running';await f.refresh();const groups=f.groups();
  assert.equal(groups.length,2);assert.equal(groups[0],first);assert.equal(first.open,true);
  assert.match(text(first.querySelector('summary')),/已暂停/);assert.match(text(groups[1].querySelector('summary')),/执行中/);
  assert.ok(!text(first).includes('src/199.txt'));assert.ok(!text(groups[1]).includes('src/99.txt'));
  f.second.logs.push({id:'0',content:JSON.stringify({type:'snapshot',sha:'another',files:2,bytes:20,skipped:0})});
  f.second.task.status='succeeded';await f.open('second');
  assert.equal(f.groups().length,1);assert.notEqual(f.groups()[0],groups[1]);
  assert.match(text(f.groups()[0]),/已接收 2 个文件/);assert.ok(!text(f.groups()[0]).includes('src/199.txt'));
});

test('completed history groups every hundred-file progress update and refreshes without adding entries',async t=>{
  const f=fixture(t);f.task.status='succeeded';f.task.phase='done';f.add(prepare);
  for(let files=100;files<=2000;files+=100)f.add(progress(files));
  f.add({type:'snapshot',sha:'abc',files:2001,bytes:20010,skipped:0,source:'github_api'});
  await f.open();const [fold]=f.groups(),output=fold.querySelector('pre');
  assert.equal(f.page.$('timeline').children.length,1);assert.equal(fold.open,false);
  assert.match(text(fold.querySelector('summary')),/已完成/);assert.match(text(fold.querySelector('summary')),/已接收 2001 个文件/);
  assert.equal((text(output).match(/刚写完 src\//g)||[]).length,20);
  const original=text(output);await f.refresh();assert.equal(text(output),original);assert.equal(f.groups()[0],fold);
});
