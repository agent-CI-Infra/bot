import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes,createHmac,createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

mkdirSync('.tmp/review-dev',{recursive:true});
const project='dept-bot-agent-e2e-'+randomBytes(4).toString('hex'),override=resolve('.tmp/review-dev/compose.test.yaml');
writeFileSync(override,`services:
  fixtures:
    image: node:22-bookworm-slim
    command: [node, /fixtures/agent-server.mjs]
    volumes: [${JSON.stringify(resolve('test/fixtures')+':/fixtures:ro')}]
    networks: [control]
    ports: ["127.0.0.1:18894:9100"]
    read_only: true
    cap_drop: [ALL]
  bot:
    environment:
      BOT_GITHUB_API_URL: http://fixtures:9100/github
    depends_on:
      fixtures:
        condition: service_started
  manager:
    ports: ["127.0.0.1:18893:8793"]
`);
const env={...process.env,DOCKER_CONFIG:resolve('.cache/docker'),BUILDX_CONFIG:resolve('.cache/buildx'),BOT_WEBHOOK_PORT:'18891',BOT_ADMIN_PORT:'18892'};
const docker=args=>execFileSync('docker',args,{env,encoding:'utf8',maxBuffer:8*1024*1024});
const compose=args=>docker(['compose','-f','compose.yaml','-f',override,'-p',project,...args]);
const base='http://127.0.0.1:18892',fixture='http://127.0.0.1:18894',id=()=>randomBytes(24).toString('hex');
const password=id(),memberPassword=id(),githubToken=id(),modelKey=id(),webhookSecret=id();let cookie='',csrf='',deployment;
const evidence={checks:[],ports:[18891,18892,18893,18894],project};
const passed=name=>{evidence.checks.push(name);console.log('PASS '+name);};
async function wait(fn,description){const end=Date.now()+120000;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){if(error.message.startsWith('Task failed:'))throw error;}await new Promise(r=>setTimeout(r,250));}throw new Error('Timed out: '+description);}
async function api(path,method='GET',body){
  const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();
  if(!r.ok)throw new Error(path+': '+value.error);if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(value.csrf_token)csrf=value.csrf_token;return value;
}
async function fake(path,body){const r=await fetch(fixture+'/fixture/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.equal(r.status,200);return r.json();}
let account;
async function hook(repo,number,event='issues',action='opened',delivery=id(),pull){
  const bodyText=[1,3,6,12].includes(number)?'Fix add to sum both numbers.':'Explain the addition implementation.';
  const issue={number,title:bodyText,body:bodyText,state:'open'};
  const body=JSON.stringify({action,repository:{id:Number(repo)},number,...(event==='issues'?{issue}:{pull_request:pull})});
  const response=await fetch('http://127.0.0.1:18891'+account.endpoints[0].webhook_path,{method:'POST',headers:{'X-GitHub-Event':event,'X-GitHub-Delivery':delivery,'X-Hub-Signature-256':'sha256='+createHmac('sha256',webhookSecret).update(body).digest('hex')},body});
  assert.equal(response.status,200);return response.json();
}
async function tasks(repo,number,kind){return (await api('/api/tasks?repository_id='+repo+'&limit=100')).tasks.filter(t=>t.object_number===number&&(!kind||t.kind===kind));}
async function done(repo,number,kind,status){return wait(async()=>{const list=await tasks(repo,number,kind);if(list.some(t=>t.status==='failed'))throw new Error('Task failed: '+JSON.stringify(list));const envs=(await api('/api/environments?repository_id='+repo)).environments;if(envs.some(e=>e.state==='failed'||e.state==='reset_failed'))throw new Error('Task failed: environment '+JSON.stringify(envs));return list.find(t=>t.status===status);},`${kind} #${number} ${status}`);}
const pull=(repo,number,state,draft=false)=>({id:4000+number,number,state:'open',draft,user:{id:800},head:{sha:state.repositories.find(r=>r.id===Number(repo)).refs.contributor,ref:'contributor',repo:{id:Number(repo)}},base:{ref:'trunk',repo:{id:Number(repo)}}});
try{
  compose(['up','-d','--build']);await wait(async()=>(await fetch(base+'/healthz')).ok,'control health');
  const botId=compose(['ps','-q','bot']).trim(),control=JSON.parse(docker(['inspect',botId]))[0],address=Object.values(control.NetworkSettings.Networks)[0].IPAddress;
  const denied=compose(['exec','-T','tunnel','node','--input-type=module','-e',`for(const url of ['http://bot:8792/healthz','http://${address}:8792/healthz']){try{await fetch(url,{signal:AbortSignal.timeout(1500)});process.exit(1);}catch{}}process.stdout.write('isolated');`]);assert.equal(denied.trim(),'isolated');
  assert.equal(compose(['exec','-T','tunnel','node','--input-type=module','-e',"process.stdout.write(String((await fetch('http://webhook:8791/api/setup')).status))"]).trim(),'404');passed('Tunnel edge network cannot reach the management listener, even by its control-network IP');
  await fake('config',{github_token:githubToken,model_key:modelKey});
  const managerToken=compose(['exec','-T','bot','node','--input-type=module','-e',"import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('/internal/manager.token').toString('base64'))"]).trim();
  deployment=createHash('sha256').update(Buffer.from(managerToken,'base64')).digest('hex').slice(0,16);
  await api('/api/setup','POST',{username:'administrator',password});
  account=(await api('/api/accounts','POST',{name:'Integration fixture',type:'bot_account',token:githubToken,webhook_secret:webhookSecret})).account;
  for(const repo of ['101','202'])await api('/api/repositories','POST',{id:repo,owner_id:'10',full_name:'fixture/project-'+repo,account_id:account.id});
  await api('/api/users','POST',{username:'member',password:memberPassword,repository_ids:['101']});
  const model=(await api('/api/models','POST',{repository_id:'101',api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'fixture-model'})).model;
  await api('/api/repositories/101/policy','PATCH',{model_id:model.id,review_enabled:true,development_enabled:true,test_command:'node --test',max_revisions:2,review_label:'bot-reviewed'});
  const disabled=await hook('202',2);assert.equal(disabled.tasks_created,0);passed('review-disabled repository only archives');
  // The account sees three repositories; 303 is installed but not started, so its events only archive until an administrator starts it.
  const listed=(await api('/api/installations/sync','POST',{})).repositories;
  assert.deepEqual(listed.map(r=>[r.id,r.registered,r.installed]).sort(),[['101',true,true],['202',true,true],['303',false,true]]);
  assert.equal((await hook('303',2)).tasks_created,0);
  const shared=(await api('/api/models','POST',{repository_id:null,api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'fixture-model'})).model;
  const started=(await api('/api/installations/303/activate','POST',{model_id:shared.id})).repository;assert.deepEqual([started.registered,started.enabled,started.review_enabled,started.development_enabled],[true,true,true,false]);
  assert.equal((await hook('303',2)).tasks_created,1);await done('303',2,'review.issue','succeeded');
  await api('/api/installations/303/disable','POST',{});assert.equal((await hook('303',4)).tasks_created,0);
  passed('installed repositories are listed, start only from the console, and can be disabled');
  const delivery=id(),opened=await hook('101',1,'issues','opened',delivery);assert.equal(opened.tasks_created,1);
  const duplicate=await hook('101',1,'issues','opened',delivery);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.tasks_created,0);
  await done('101',1,'review.issue','succeeded');const development=await done('101',1,'development.issue','pr_opened');
  let state=await fake('state');assert.equal(state.prs.length,1);assert.equal(development.result.pr_number,state.prs[0].number);
  assert.ok(development.result.branch.startsWith('bot/issue-1-'));assert.equal(development.result.validation.exit_code,0);
  assert.equal(state.comments.filter(c=>c.repository_id===101&&c.number===1).length,2);
  assert.ok(state.models.some(m=>m.repository==='101'&&JSON.stringify(m.messages).includes('a - b')&&JSON.stringify(m.messages).includes('REPO_101_ONLY')));
  assert.ok(state.refWrites.every(r=>r.branch.startsWith('bot/issue-')&&r.branch!=='trunk'&&r.force!==true));
  assert.deepEqual(state.labels.filter(l=>l.repository_id===101&&l.number===1).map(l=>l.labels),[['bot-reviewed']]);
  passed('Issue reviews once, executes code and tests in project container, and opens an owned bot PR');
  assert.equal((await hook('101',1)).tasks_created,0);state=await fake('state');assert.equal(state.comments.filter(c=>c.repository_id===101&&c.number===1).length,2);
  assert.equal((await tasks('101',1)).length,2);passed('duplicate and repeated opened deliveries do not duplicate tasks, comments, or PRs');
  await hook('101',12);await done('101',12,'review.issue','waiting_permission');
  assert.equal((await tasks('101',12,'development.issue')).length,0);passed('failed review publication cannot enqueue development');
  let p=pull('101',99,state,true);assert.equal((await hook('101',99,'pull_request','opened',id(),p)).tasks_created,0);
  await fake('pr',{repository_id:'101',number:99,values:{draft:false}});p={...p,draft:false};assert.equal((await hook('101',99,'pull_request','ready_for_review',id(),p)).tasks_created,1);
  await done('101',99,'review.pr','succeeded');passed('draft PR ignored; ready-for-review creates a review');
  const beforeForeign=(await fake('state')).refWrites.length;
  await hook('101',42,'pull_request','opened',id(),pull('101',42,state));const foreignReview=await done('101',42,'review.pr','succeeded');
  assert.ok(foreignReview.result.outputs.some(output=>output.inline_comments?.some(comment=>comment.id&&comment.finding_id)));
  state=await fake('state');assert.equal(state.refWrites.length,beforeForeign);assert.equal((await tasks('101',42)).length,1);
  assert.ok(state.reviews.filter(r=>r.number===42).every(r=>r.event==='COMMENT'&&r.commit_id===pull('101',42,state).head.sha));
  assert.equal(state.comments.filter(c=>c.repository_id===101&&c.number===42).length,1);assert.deepEqual(state.labels.filter(l=>l.repository_id===101&&l.number===42).map(l=>l.labels),[['bot-reviewed']]);
  passed('foreign PR produces COMMENT review, one summary comment and the policy label, and never receives a commit');
  await hook('101',44,'pull_request','opened',id(),pull('101',44,state));await done('101',44,'review.pr','succeeded');state=await fake('state');
  assert.equal(state.reviews.filter(r=>r.number===44).length,0);assert.equal(state.comments.filter(r=>r.number===44).length,1);passed('unverifiable inline position falls back to discussion without fabricated lines');
  const staleHead=pull('101',43,state).head.sha;await hook('101',43,'pull_request','synchronize',id(),pull('101',43,state));await done('101',43,'review.pr','succeeded');
  state=await fake('state');assert.equal(state.reviews.filter(r=>r.number===43&&r.commit_id===staleHead).length,0);assert.ok((await tasks('101',43)).some(t=>t.status==='superseded'));passed('head change suppresses stale inline output and reviews the current head');
  const owned=state.prs.find(r=>r.repository_id===101);const ownedHead=state.repositories.find(r=>r.id===101).refs[owned.head.ref];
  const ownPayload={...owned,head:{...owned.head,sha:ownedHead}};
  await hook('101',owned.number,'pull_request','synchronize',id(),ownPayload);await done('101',owned.number,'development.pr','completed');
  state=await fake('state');assert.equal(state.prs.length,1);assert.ok(state.refWrites.some(r=>r.method==='PATCH'&&r.branch===owned.head.ref&&r.force===false));passed('owned bot PR is followed on its registered branch without opening a second PR');
  await hook('101',4);await done('101',4,'review.issue','succeeded');state=await fake('state');assert.equal(state.comments.filter(r=>r.number===4).length,1);passed('unknown comment response reconciles by marker instead of posting twice');
  await hook('101',6);const failed=await wait(async()=>(await tasks('101',6,'development.issue')).find(t=>t.status==='failed'),'test failure');assert.equal(failed.error_code,'validation_failed');
  state=await fake('state');assert.equal(state.prs.length,1);passed('failed tests block branch publication and PR creation');
  await api('/api/repositories/202/policy','PATCH',{review_enabled:true});await hook('202',2);
  const missing=await done('202',2,'review.issue','waiting_configuration');assert.equal(missing.error_code,'model_not_configured');
  const model2=(await api('/api/models','POST',{repository_id:'202',api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'fixture-model'})).model;
  await api('/api/repositories/202/policy','PATCH',{model_id:model2.id,development_enabled:true,test_command:'node --test'});await api('/api/tasks/'+missing.id+'/retry','POST',{});await done('202',2,'review.issue','succeeded');
  assert.ok((await fake('state')).labels.some(l=>l.repository_id===202&&l.labels.includes('bot-reviewed')));passed('missing model is a configuration fault and resumes with the built-in label after configuration');
  await fake('faults',{tree_mismatch:true});const writesBefore=(await fake('state')).refWrites.length;await hook('202',3);
  const treeFailed=await wait(async()=>(await tasks('202',3,'development.issue')).find(t=>t.status==='failed'),'tree mismatch');assert.equal(treeFailed.error_code,'github_tree_mismatch');
  assert.equal((await fake('state')).refWrites.length,writesBefore);await fake('faults',{tree_mismatch:false});passed('remote tree mismatch prevents ref update');
  await hook('101',8);await done('101',8,'review.issue','succeeded');state=await fake('state');
  assert.ok(!JSON.stringify(state.comments).includes(modelKey));
  for(const t of (await api('/api/tasks?limit=100')).tasks){const details=await api('/api/tasks/'+t.id),logs=await api('/api/tasks/'+t.id+'/logs');assert.ok(!JSON.stringify({details,logs}).includes(modelKey));assert.ok(!JSON.stringify({details,logs}).includes(githubToken));}
  assert.ok(state.models.filter(m=>m.repository==='202').every(m=>!JSON.stringify(m.messages).includes('REPO_101_ONLY')));passed('model materials remain project-scoped and response/log secrets are redacted');
  await hook('101',10);
  await wait(()=>{
    const container=docker(['ps','-q','--filter',`label=department.bot.deployment=${deployment}`,'--filter','label=department.bot.repository=101']).trim();
    if(!container)return false;
    return docker(['exec',container,'node','--input-type=module','-e',"import{readdirSync,existsSync}from'node:fs';process.stdout.write(String(Number(readdirSync('/workspace/tasks').some(id=>existsSync('/workspace/tasks/'+id+'/repo/recovery-marker.txt')))))"]).trim()==='1';
  },'Pi command has started in the project container');
  const recoveryTask=(await tasks('101',10,'review.issue'))[0],live=await api('/api/tasks/'+recoveryTask.id+'/live?offset=0');assert.equal(live.running,true);assert.ok(live.command.includes('recovery-marker'));passed('Pi commands retain live command output in the existing task API');
  compose(['kill','-s','SIGKILL','manager']);compose(['start','manager']);
  const recovered=await done('101',10,'review.issue','succeeded');assert.ok(recovered.attempt>=2);assert.equal((await fake('state')).comments.filter(c=>c.repository_id===101&&c.number===10).length,1);
  passed('interrupted container work is rechecked and resumed in a fresh attempt without a duplicate comment');
  const execute=async command=>{const r=await fetch('http://127.0.0.1:18893/v1/projects/101/execute',{method:'POST',headers:{Authorization:'Bearer '+managerToken,'Content-Type':'application/json'},body:JSON.stringify({operation_id:id(),generation:1,request:{type:'command',command}})});assert.equal(r.status,200);return (await r.json()).result;};
  const orphanScript=Buffer.from("setTimeout(()=>require('node:fs').writeFileSync('/workspace/orphan-marker','unexpected'),2000)").toString('base64');
  const detached=await execute(`node -e "require('node:child_process').spawn(process.execPath,['-e',Buffer.from('${orphanScript}','base64').toString()],{detached:true,stdio:'ignore'}).unref()"`);
  assert.equal(detached.ok,true);assert.equal(detached.result.exit_code,0);
  const isolated=await execute(`node -e "setTimeout(()=>process.exit(require('node:fs').existsSync('/workspace/orphan-marker')?1:0),2500)"`);assert.equal(isolated.result.exit_code,0);
  passed('detached processes cannot outlive a command and overlap the next project execution');
  const envOutput=docker(['exec',`dbot-${deployment}-101-g1`,'env']);for(const secret of [githubToken,modelKey,managerToken])assert.ok(!envOutput.includes(secret));
  const bot=JSON.parse(docker(['inspect',compose(['ps','-q','bot']).trim()]))[0];assert.ok(!bot.Mounts.some(m=>m.Destination.includes('docker.sock')));passed('container environment has no GitHub or model credentials; control plane has no Docker socket');
  assert.deepEqual((await api('/api/status')),{review_available:true,development_available:true,project_environments_available:true,model_calls_available:true});
  const browser=await chromium.launch();try{
    const page=await browser.newPage({viewport:{width:1365,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'检视',exact:true}).click();await page.locator('#rows').getByText(/fixture\/project-101/).first().waitFor();
    assert.ok((await page.locator('#rows').innerText()).includes('fixture/project-101'));assert.ok((await page.locator('#rows').innerText()).includes('fixture/project-202'));await page.screenshot({path:'.tmp/review-dev/admin-desktop.png'});
    // The process view shows the model's steps and the commands it ran in the project computer.
    await page.locator('#rows .row',{hasText:'Issue #1 · fixture/project-101'}).getByRole('button',{name:'查看过程',exact:true}).click();await page.locator('#timeline .step-model').first().waitFor();
    assert.ok(await page.locator('#timeline .step-tool').count()>=1);assert.match(await page.locator('#task-side').innerText(),/dbot-[0-9a-f]+-101-g\d/);await page.screenshot({path:'.tmp/review-dev/task-process.png'});
    await page.getByRole('button',{name:'打开项目机器配置',exact:true}).click();await page.locator('#machine-status').waitFor();
    await page.locator('.project-nav').getByRole('link',{name:'运行记录',exact:true}).click();await page.locator('#activity-status .commands li').first().waitFor();
    await page.getByRole('button',{name:'开发',exact:true}).click();await page.locator('#rows .row',{hasText:'Issue #1 · fixture/project-101'}).waitFor();
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByLabel('用户名',{exact:true}).fill('member');await page.getByLabel('密码',{exact:true}).fill(memberPassword);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'检视',exact:true}).click();await page.locator('#rows').getByText(/fixture\/project-101/).first().waitFor();
    assert.ok(!(await page.locator('#rows').innerText()).includes('fixture/project-202'));await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'.tmp/review-dev/project-mobile.png'});assert.deepEqual(errors,[]);
    const foreignTask=(await tasks('202',3,'development.issue'))[0].id;
    const denied=await page.evaluate(async id=>{const me=await(await fetch('/api/auth/me')).json();return Promise.all([
      fetch('/api/tasks/'+id).then(r=>r.status),fetch('/api/tasks/'+id+'/logs').then(r=>r.status),
      fetch('/api/tasks/'+id+'/retry',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token},body:'{}'}).then(r=>r.status)]);},foreignTask);
    assert.deepEqual(denied,[404,404,404]);
  }finally{await browser.close();}passed('desktop and mobile task pages obey administrator repository scope');
  evidence.issueFlow={review:(await tasks('101',1,'review.issue'))[0].id,development:development.id,branch:development.result.branch,pr:development.result.pr_number};
}catch(error){
  try{writeFileSync('.tmp/review-dev/failure.json',JSON.stringify((await api('/api/tasks?limit=100')).tasks,null,2));}catch{}
  throw error;
}finally{
  compose(['down','--volumes']);if(deployment)for(const [find,remove]of [[['ps','-aq'],['rm','-f']],[['network','ls','-q'],['network','rm']],[['volume','ls','-q'],['volume','rm']]]){const names=docker([...find,'--filter',`label=department.bot.deployment=${deployment}`]).trim().split('\n').filter(Boolean);if(names.length)docker([...remove,...names]);}
  writeFileSync('.tmp/review-dev/evidence.json',JSON.stringify(evidence,null,2));
}
