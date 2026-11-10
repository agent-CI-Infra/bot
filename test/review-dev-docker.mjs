import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes,createHmac,createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

mkdirSync('.tmp/review-dev',{recursive:true});
const project='dept-bot-agent-e2e-'+randomBytes(4).toString('hex'),override=resolve('.tmp/review-dev/compose.test.yaml');
// Never replace another checkout's :local images while running an isolated test deployment.
const image=name=>`department-bot-${name}:${project}`;
writeFileSync(override,`services:
  key-init:
    image: ${image('control-plane')}
  webhook:
    image: ${image('control-plane')}
  tunnel:
    image: ${image('cloudflare-tunnel')}
  project-image:
    image: ${image('project-computer')}
  fixtures:
    image: node:22-bookworm-slim
    command: [node, /fixtures/agent-server.mjs]
    volumes: [${JSON.stringify(resolve('test/fixtures')+':/fixtures:ro')}]
    networks: [control]
    ports: ["127.0.0.1:18894:9100"]
    read_only: true
    cap_drop: [ALL]
  bot:
    image: ${image('control-plane')}
    environment:
      BOT_GITHUB_API_URL: http://fixtures:9100/github
    depends_on:
      fixtures:
        condition: service_started
  manager:
    image: ${image('computer-manager')}
    environment:
      BOT_PROJECT_IMAGE: ${image('project-computer')}
    ports: ["127.0.0.1:18893:8793"]
`);
const env={...process.env,DOCKER_CONFIG:resolve('.tmp/review-dev/docker'),BUILDX_CONFIG:resolve('.tmp/review-dev/buildx'),BOT_PORT:'18891'};
const docker=args=>execFileSync('docker',args,{env,encoding:'utf8',maxBuffer:8*1024*1024});
const compose=args=>docker(['compose','-f','compose.yaml','-f','compose.build.yaml','-f',override,'-p',project,...args]);
const base='http://127.0.0.1:18891',fixture='http://127.0.0.1:18894',id=()=>randomBytes(24).toString('hex');
const password=id(),memberPassword=id(),githubToken=id(),modelKey=id(),webhookSecret=id();let cookie='',csrf='',deployment,managerToken='';
const evidence={checks:[],ports:[18891,18893,18894],project};
const passed=name=>{evidence.checks.push(name);console.log('PASS '+name);};
async function wait(fn,description){const end=Date.now()+120000;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){if(error.message.startsWith('Task failed:'))throw error;}await new Promise(r=>setTimeout(r,250));}throw new Error('Timed out: '+description);}
async function api(path,method='GET',body){
  const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();
  if(!r.ok)throw new Error(path+': '+value.error);if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(value.csrf_token)csrf=value.csrf_token;return value;
}
async function fake(path,body){const r=await fetch(fixture+'/fixture/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});assert.equal(r.status,200);return r.json();}
let account;
async function hook(repo,number,event='issues',action='opened',delivery=id(),pull,extra={}){
  const bodyText=[1,3,6,12].includes(number)?'Fix add to sum both numbers.':'Explain the addition implementation.';
  const issue={number,title:bodyText,body:bodyText,state:'open'};
  const body=JSON.stringify({action,repository:{id:Number(repo)},number,...(event==='issues'||event==='issue_comment'?{issue}:{pull_request:pull}),...extra});
  const response=await fetch('http://127.0.0.1:18891'+account.endpoints[0].webhook_path,{method:'POST',headers:{'X-GitHub-Event':event,'X-GitHub-Delivery':delivery,'X-Hub-Signature-256':'sha256='+createHmac('sha256',webhookSecret).update(body).digest('hex')},body});
  assert.equal(response.status,200);return response.json();
}
async function tasks(repo,number,kind){return (await api('/api/tasks?repository_id='+repo+'&limit=100')).tasks.filter(t=>t.object_number===number&&(!kind||t.kind===kind));}
async function dispatches(repo,number){return (await api(`/api/repositories/${repo}/dispatch?limit=100`)).events.filter(e=>number===undefined||e.object_number===number);}
async function decided(repo,number,type,decision){return wait(async()=>{const list=(await dispatches(repo,number)).filter(e=>e.type===type);if(list.some(e=>e.error))throw new Error('Task failed: dispatch '+JSON.stringify(list));return list.find(e=>e.state==='decided'&&e.decision===decision);},`${repo} ${type} #${number} ${decision}`);}
async function done(repo,number,kind,status){return wait(async()=>{const events=await dispatches(repo,number);if(events.some(e=>e.error))throw new Error('Task failed: dispatch '+JSON.stringify(events));const list=await tasks(repo,number,kind);if(list.some(t=>t.status==='failed'))throw new Error('Task failed: '+JSON.stringify(list));const envs=(await api('/api/environments?repository_id='+repo)).environments;if(envs.some(e=>e.state==='failed'||e.state==='reset_failed'))throw new Error('Task failed: environment '+JSON.stringify(envs));return list.find(t=>t.status===status);},`${repo} ${kind} #${number} ${status}`);}
const comment=(repo,number,body)=>hook(repo,number,'issue_comment','created',id(),undefined,{sender:{id:700,login:'maintainer',type:'User'},comment:{id:Date.now(),body,author_association:'MEMBER'}});
const pull=(repo,number,state,draft=false)=>({id:4000+number,number,state:'open',draft,user:{id:800},head:{sha:state.repositories.find(r=>r.id===Number(repo)).refs.contributor,ref:'contributor',repo:{id:Number(repo)}},base:{ref:'trunk',repo:{id:Number(repo)}}});
try{
  compose(['up','-d','--build']);await wait(async()=>(await fetch(base+'/healthz')).ok,'control health');
  const botId=compose(['ps','-q','bot']).trim(),control=JSON.parse(docker(['inspect',botId]))[0],address=Object.values(control.NetworkSettings.Networks)[0].IPAddress;
  // The tunnel reaches the whole business entry only through the gateway; the bot and manager themselves stay out of reach.
  const denied=compose(['exec','-T','tunnel','node','--input-type=module','-e',`for(const url of ['http://bot:8791/healthz','http://${address}:8791/healthz','http://manager:8793/ready']){try{await fetch(url,{signal:AbortSignal.timeout(1500)});process.exit(1);}catch{}}process.stdout.write('isolated');`]);assert.equal(denied.trim(),'isolated');
  assert.equal(compose(['exec','-T','tunnel','node','--input-type=module','-e',"process.stdout.write(String((await fetch('http://webhook:8791/api/setup')).status))"]).trim(),'200');passed('Tunnel edge network reaches the single entry only via the gateway, never the bot or manager directly');
  await fake('config',{github_token:githubToken,model_key:modelKey});
  managerToken=compose(['exec','-T','bot','node','--input-type=module','-e',"import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('/internal/manager.token').toString('base64'))"]).trim();
  deployment=createHash('sha256').update(Buffer.from(managerToken,'base64')).digest('hex').slice(0,16);
  await api('/api/setup','POST',{username:'administrator',password});
  account=(await api('/api/accounts','POST',{name:'Integration fixture',type:'bot_account',token:githubToken,webhook_secret:webhookSecret})).account;
  // Repositories come from the account's sync and are started from the console; 202 then has review turned off.
  await api('/api/installations/sync','POST',{});for(const repo of ['101','202'])await api(`/api/installations/${repo}/activate`,'POST',{account_id:account.id});
  await api('/api/repositories/202/policy','PATCH',{review_enabled:false});
  await api('/api/users','POST',{username:'member',password:memberPassword,repository_ids:['101']});
  const model=(await api('/api/models','POST',{repository_id:'101',api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'fixture-model'})).model;
  const coding=(await api('/api/models','POST',{repository_id:'101',api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'coding-model'})).model;
  const manager=(await api('/api/models','POST',{repository_id:'101',api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'manager-model'})).model;
  await api('/api/repositories/101/policy','PATCH',{model_id:null,task_models:{manager:manager.id,'review.issue':model.id,'review.pr':model.id,'development.issue':coding.id,'development.pr':coding.id},review_enabled:true,development_enabled:true,test_command:'node --test',max_revisions:2});
  const disabled=await hook('202',2);assert.equal(disabled.tasks_created,0);passed('review-disabled repository only archives');
  // The account sees three repositories; 303 is installed but not started, so its events only archive until an administrator starts it.
  const listed=(await api('/api/installations/sync','POST',{})).repositories;
  assert.deepEqual(listed.map(r=>[r.id,r.registered,r.installed]).sort(),[['101',true,true],['202',true,true],['303',false,true]]);
  assert.equal((await hook('303',2)).tasks_created,0);
  const shared=(await api('/api/models','POST',{repository_id:null,api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'fixture-model'})).model;
  const started=(await api('/api/installations/303/activate','POST',{model_id:shared.id})).repository;assert.deepEqual([started.registered,started.enabled,started.review_enabled,started.development_enabled],[true,true,true,false]);
  await hook('303',2);await done('303',2,'review.issue','succeeded');assert.equal((await decided('303',2,'issue.opened','create')).result.created.length,1);
  await api('/api/installations/303/disable','POST',{});assert.equal((await hook('303',4)).tasks_created,0);
  passed('installed repositories are listed, start only from the console, and can be disabled');
  const delivery=id();await hook('101',1,'issues','opened',delivery);
  const duplicate=await hook('101',1,'issues','opened',delivery);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.tasks_created,0);
  await done('101',1,'review.issue','succeeded');const development=await done('101',1,'development.issue','pr_opened');
  const opened=await decided('101',1,'issue.opened','create'),published=await decided('101',1,'review.published','create');
  assert.equal(opened.model,'manager-model');assert.equal(published.model,'manager-model');assert.deepEqual(published.result.created,[development.id]);
  let state=await fake('state');assert.equal(state.prs.length,1);assert.equal(development.result.pr_number,state.prs[0].number);
  assert.ok(development.result.branch.startsWith('bot/issue-1-'));assert.equal(development.result.validation.exit_code,0);
  assert.equal(state.comments.filter(c=>c.repository_id===101&&c.number===1).length,2);
  assert.ok(state.models.some(m=>m.repository==='101'&&JSON.stringify(m.messages).includes('a - b')&&JSON.stringify(m.messages).includes('REPO_101_ONLY')));
  assert.ok(state.refWrites.every(r=>r.branch.startsWith('bot/issue-')&&r.branch!=='trunk'&&r.force!==true));
  assert.deepEqual(state.labels.filter(l=>l.repository_id===101&&l.number===1).map(l=>l.labels),[['bot-reviewed']]);
  assert.ok(state.models.some(m=>m.repository==='101'&&m.number===1&&m.model==='fixture-model'));
  assert.ok(state.models.some(m=>m.repository==='101'&&m.number===1&&m.model==='coding-model'));
  passed('Manager dispatch, review and development use separate task models without a project default');
  passed('Issue reviews once, executes code and tests in project container, and opens an owned bot PR');
  assert.equal((await hook('101',1)).tasks_created,0);state=await fake('state');assert.equal(state.comments.filter(c=>c.repository_id===101&&c.number===1).length,2);
  assert.equal((await tasks('101',1)).length,2);passed('duplicate and repeated opened deliveries do not duplicate tasks, comments, or PRs');
  await hook('101',12);await done('101',12,'review.issue','waiting_permission');
  assert.equal((await tasks('101',12,'development.issue')).length,0);passed('failed review publication cannot enqueue development');
  let p=pull('101',99,state,true);assert.equal((await hook('101',99,'pull_request','opened',id(),p)).tasks_created,0);
  await fake('pr',{repository_id:'101',number:99,values:{draft:false}});p={...p,draft:false};await hook('101',99,'pull_request','ready_for_review',id(),p);
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
  await comment('101',4,'Thanks!');await decided('101',4,'issue.updated','ignore');
  assert.equal((await tasks('101',4)).length,1);assert.equal((await fake('state')).comments.filter(c=>c.repository_id===101&&c.number===4).length,1);passed('Manager ignores a trusted thank-you without creating work or publishing again');
  await hook('101',6);const repaired=await done('101',6,'development.issue','pr_opened');
  const repairLogs=await api('/api/tasks/'+repaired.id+'/logs');assert.ok(JSON.stringify(repairLogs).includes('validation_failed'));
  state=await fake('state');assert.equal(state.prs.length,2);passed('failed policy tests return to Pi, which repairs and creates the PR on a later call');
  await api('/api/repositories/202/policy','PATCH',{review_enabled:true});await hook('202',2);
  const unconfigured=await wait(async()=>(await dispatches('202',2)).find(e=>e.error?.code==='model_not_configured'),'Manager configuration fault');
  assert.equal(unconfigured.state,'pending');assert.equal((await tasks('202',2)).length,0);
  const model2=(await api('/api/models','POST',{repository_id:'202',api_url:'http://fixtures:9100/model',api_key:modelKey,model_name:'fixture-model'})).model;
  await api('/api/repositories/202/policy','PATCH',{task_models:{manager:model2.id}});
  await wait(async()=>(await dispatches('202',2)).find(e=>e.state==='decided'),'Manager resumes after configuration');
  const missing=await done('202',2,'review.issue','waiting_configuration');assert.equal(missing.error_code,'model_not_configured');
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
  await comment('101',10,'Also explain how the interrupted command recovers.');
  const continued=await decided('101',10,'issue.updated','continue');assert.deepEqual(continued.result.continued,[recoveryTask.id]);assert.equal((await tasks('101',10)).length,1);
  passed('Manager continues the active review with a trusted update instead of duplicating it');
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
    await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'看板',exact:true}).click();await page.locator('#board-columns').getByText(/fixture\/project-101/).first().waitFor();
    assert.ok((await page.locator('#board-columns').innerText()).includes('fixture/project-101'));assert.ok((await page.locator('#board-columns').innerText()).includes('fixture/project-202'));await page.screenshot({path:'.tmp/review-dev/admin-desktop.png'});
    // The process view shows the model's steps and the commands it ran in the project computer.
    await page.locator('[data-card-key="101/issue/1"][data-card-category="review.issue"] .board-card-title').click();await page.locator('#timeline .step-model').first().waitFor();
    assert.ok(await page.locator('#timeline .step-tool').count()>=1);assert.match(await page.locator('#task-side').innerText(),/dbot-[0-9a-f]+-101-g\d/);await page.screenshot({path:'.tmp/review-dev/task-process.png'});
    await page.getByRole('button',{name:'打开项目机器配置',exact:true}).click();await page.locator('#machine-status').waitFor();
    await page.locator('.project-nav').getByRole('link',{name:'运行状态',exact:true}).click();await page.locator('#activity-status').getByRole('heading',{name:'最近任务',exact:true}).waitFor();
    await page.getByRole('button',{name:'看板',exact:true}).click();await page.locator('[data-card-key="101/issue/1"][data-card-category="development.issue"]').waitFor();
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByLabel('用户名',{exact:true}).fill('member');await page.getByLabel('密码',{exact:true}).fill(memberPassword);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'看板',exact:true}).click();await page.locator('#board-columns').getByText(/fixture\/project-101/).first().waitFor();
    assert.ok(!(await page.locator('#board-columns').innerText()).includes('fixture/project-202'));await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'.tmp/review-dev/project-mobile.png'});assert.deepEqual(errors,[]);
    const foreignTask=(await tasks('202',3,'development.issue'))[0].id;
    const beforeRetry=(await api('/api/tasks/'+foreignTask)).task;
    const denied=await page.evaluate(async id=>{const me=await(await fetch('/api/auth/me')).json(),result=async response=>({status:response.status,error:(await response.json()).error});return Promise.all([
      fetch('/api/tasks/'+id).then(result),fetch('/api/tasks/'+id+'/logs').then(result),
      fetch('/api/tasks/'+id+'/retry',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token},body:'{}'}).then(result)]);},foreignTask);
    // Reads hide out-of-scope tasks; the write guard rejects the repository before the retry handler runs.
    assert.deepEqual(denied,[{status:404,error:'task_not_found'},{status:404,error:'task_not_found'},{status:403,error:'repository_forbidden'}]);
    const afterRetry=(await api('/api/tasks/'+foreignTask)).task;
    for(const key of ['status','attempt','error_code','updated_at'])assert.deepEqual(afterRetry[key],beforeRetry[key]);
  }finally{await browser.close();}passed('desktop and mobile task pages obey administrator repository scope');
  evidence.issueFlow={review:(await tasks('101',1,'review.issue'))[0].id,development:development.id,branch:development.result.branch,pr:development.result.pr_number};
  const events=(await Promise.all(['101','202','303'].map(repo=>dispatches(repo)))).flat(),fixtureState=await fake('state');
  for(const event of events){assert.equal(event.state,'decided',JSON.stringify(event));assert.ok(event.model);assert.ok(fixtureState.dispatches.some(call=>call.event.id===event.id&&call.model===event.model&&call.decision.decision===event.decision));}
  for(const task of (await api('/api/tasks?limit=100')).tasks){const origin=await api(`/api/tasks/${task.id}/dispatch`);assert.ok(origin.dispatch.some(event=>event.relation==='created'&&event.decision==='create'));}
  assert.deepEqual([...new Set(events.map(event=>event.decision))].sort(),['continue','create','ignore']);
  assert.ok(fixtureState.acceptances.some(call=>call.calls.includes('read_file')&&call.calls.includes('read_evidence')));
  assert.ok(fixtureState.acceptances.some(call=>call.calls.includes('read_file')&&call.calls.includes('run_command')));
  evidence.dispatch=events;passed('all tasks originate from successful model-backed Manager decisions, including review-to-development follow-up');
}catch(error){
  const redact=value=>{let text=typeof value==='string'?value:JSON.stringify(value,null,2);for(const secret of [password,memberPassword,githubToken,modelKey,webhookSecret,managerToken].filter(Boolean))text=text.replaceAll(secret,'[REDACTED]');return text;};
  for(const [name,read]of [['failure.json',()=>api('/api/tasks?limit=100')],['dispatch-failure.json',()=>Promise.all(['101','202','303'].map(repo=>dispatches(repo)))],['fixture-failure.json',()=>fake('state')],['compose-failure.log',()=>compose(['logs','--no-color','--tail','200','bot','manager','fixtures'])]])try{writeFileSync('.tmp/review-dev/'+name,redact(await read()));}catch{}
  throw error;
}finally{
  compose(['down','--volumes']);if(deployment)for(const [find,remove]of [[['ps','-aq'],['rm','-f']],[['network','ls','-q'],['network','rm']],[['volume','ls','-q'],['volume','rm']]]){const names=docker([...find,'--filter',`label=department.bot.deployment=${deployment}`]).trim().split('\n').filter(Boolean);if(names.length)docker([...remove,...names]);}
  writeFileSync('.tmp/review-dev/evidence.json',JSON.stringify(evidence,null,2));
}
