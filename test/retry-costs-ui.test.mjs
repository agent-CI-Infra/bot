import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConsole} from './console-page.mjs';

const text=node=>[node.textContent,...node.children.flatMap(text)].join(' ');
const click=node=>node.listeners.click[0]({currentTarget:node});
const task={id:'task',repository_id:'101',kind:'review.issue',object_number:1,status:'waiting_pr_head',phase:'publish',attempt:1};

test('review and development lists share retry states and keep a failed retry visible across refreshes',async()=>{
  for(const tab of ['reviews','developments']){
    let reject=true;
    const page=loadConsole(['static/app.js','static/views.js','static/metrics.js'],(method,path)=>method==='POST'?[reject?409:200,reject?{error:'task_already_running'}:{ok:true}]:[200,{tasks:[task]}]);
    page.run(`me={id:'admin',role:'project_admin'};tab='${tab}';projectRoute=()=>null;`);
    await page.run('render()');let retry=page.$('rows').querySelectorAll('button').find(node=>node.textContent==='重试');assert.ok(retry,'waiting_pr_head offers retry');
    await click(retry);const expected='这个任务已经在执行或排队，不用再次重试。';assert.ok(text(page.$('message')).includes(expected));
    await page.run('render()');assert.ok(text(page.$('message')).includes(expected),'five-second render keeps error');
    page.run("error(new Error('refresh failed'))");assert.ok(text(page.$('message')).includes(expected),'refresh errors do not replace the retry explanation');
    await click(page.$('message').querySelector('button'));assert.equal(page.$('message').childElementCount,0);
    retry=page.$('rows').querySelectorAll('button').find(node=>node.textContent==='重试');await click(retry);reject=false;
    await click(retry);assert.equal(page.$('message').childElementCount,0,'successful retry clears error');
    reject=true;await click(page.$('rows').querySelectorAll('button').find(node=>node.textContent==='重试'));
    page.run("$('list-panel').className='list-panel';tab=tab==='reviews'?'developments':'reviews';");await page.run('route()');assert.equal(page.$('message').childElementCount,0,'page switch clears error');
  }
});

test('task dialog explains retry conflicts and keeps the error after the immediate and later refresh',async()=>{
  for(const [code,message]of [['task_already_running','这个任务已经在执行或排队，不用再次重试。'],['task_not_retryable','这个任务已经结束，不能重试。']]){
    let reject=true;
    const page=loadConsole(['static/app.js','static/views.js'],(method,path)=>method==='POST'?[reject?409:200,reject?{error:code}:{ok:true}]:path.endsWith('/logs')?[200,{logs:[]}]:[200,{task,publications:[]}]);
    page.run("renderTimeline=()=>{};refreshLive=async()=>{};renderTaskSide=()=>{};keepOpen=(node,draw)=>draw();openTaskId='task';taskView.showModal();");
    try{
      await page.run('refreshTask();');await click(page.$('task-actions').querySelectorAll('button').find(node=>node.textContent==='重试'));
      assert.ok(text(page.$('task-error')).includes(message));await page.run('refreshTask()');assert.ok(text(page.$('task-error')).includes(message));
      reject=false;await click(page.$('task-actions').querySelectorAll('button').find(node=>node.textContent==='重试'));assert.equal(page.$('task-error').childElementCount,0);
      reject=true;await click(page.$('task-actions').querySelectorAll('button').find(node=>node.textContent==='重试'));await click(page.$('task-error').querySelector('button'));assert.equal(page.$('task-error').childElementCount,0);
    }finally{page.run('taskView.close();clearTimeout(taskTimer);');}
  }
});

test('cost view shows token totals, per-project and daily tokens, and all saved price groups',async()=>{
  const data={from:'2026-10-22',to:'2026-10-23',currency:'USD',collection_started_at:'2026-10-22T00:00:00Z',summary:{cost:3,requests:3,unpriced_requests:1,usage_missing_requests:0,input_tokens:3000,output_tokens:300,cached_input_tokens:1750},
    prices:[2,3].map(input=>({model_name:'fixture-model',currency:'USD',input_per_million:input,output_per_million:10,cache_per_million:0.0002})),
    days:[{date:'2026-10-22',repository_id:'101',full_name:'fixture/project',cost:1,requests:1,unpriced_requests:0,input_tokens:1000,output_tokens:100,cached_input_tokens:750},
      {date:'2026-10-23',repository_id:'101',full_name:'fixture/project',cost:2,requests:2,unpriced_requests:1,input_tokens:2000,output_tokens:200,cached_input_tokens:1000}]};
  const page=loadConsole(['static/app.js','static/metrics.js','static/costs.js'],()=>[200,data]);
  page.run("me={id:'admin'};tab='costs';costState={from:'2026-10-22',to:'2026-10-23',currency:'USD'};document.createTextNode=text=>element('span',text);costChart=()=>{};");
  await page.run('loadCosts(0)');const body=page.$('cost-body');
  assert.match(text(body),/输入包含缓存命中 token/);const totals=body.querySelector('.cost-token-summary');
  for(const token of ['3,000','300','1,750'])assert.ok(text(totals).includes(token));
  const tables=body.querySelectorAll('tbody');assert.equal(tables.length,3);
  assert.equal(tables[0].children.length,2);assert.match(text(tables[0]),/fixture-model USD 2 10 0.0002/);assert.match(text(tables[0]),/fixture-model USD 3 10 0.0002/);
  assert.match(text(tables[1]),/3,000 300 1,750/);assert.match(text(tables[2]),/1,000 100 750/);assert.match(text(tables[2]),/2,000 200 1,000/);
  data.prices=[];await page.run('loadCosts(0)');assert.equal(body.querySelectorAll('tbody').length,2);assert.ok(!text(body).includes('范围内已保存的单价'));
});
