import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { chromium } from '@playwright/test';

mkdirSync('.tmp/project-env', { recursive: true });
const project = 'dept-bot-env-e2e-' + randomBytes(4).toString('hex');
const override = resolve('.tmp/project-env/compose.test.yaml');
writeFileSync(override, 'services:\n  manager:\n    ports: ["127.0.0.1:18883:8793"]\n');
const composeArgs = ['compose','-f','compose.yaml','-f',override,'-p',project];
const env = { ...process.env, BOT_WEBHOOK_PORT: '18881', BOT_ADMIN_PORT: '18882', DOCKER_CONFIG: resolve('.cache/docker'), BUILDX_CONFIG: resolve('.cache/buildx') };
const docker = args => execFileSync('docker', args, { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const compose = args => docker([...composeArgs, ...args]);
const base = 'http://127.0.0.1:18882', managerUrl = 'http://127.0.0.1:18883';
const id = () => randomBytes(24).toString('hex');
const password = id(), memberPassword = id(), githubToken = id(), modelKey = id();
const privateKey = generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}), webhookSecret=id();
let cookie = '', csrf = '', token, deployment;
async function wait(fn, description) {
  const end = Date.now() + 90000;
  while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('Timed out: ' + description);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type':'application/json', Cookie:cookie,'X-CSRF-Token':csrf }, ...(body ? { body:JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(path + ': ' + result.error);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  if (result.csrf_token) csrf = result.csrf_token; return result;
}
async function manager(repo, action, request, generation = 1, operation = id()) {
  const response = await fetch(`${managerUrl}/v1/projects/${repo}${action ? '/' + action : ''}`, { method: action ? 'POST' : 'GET',
    headers: { Authorization:'Bearer ' + token, 'Content-Type':'application/json' },
    ...(action ? { body:JSON.stringify({ operation_id:operation, generation, ...(request ? {request} : {}) }) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value.result;
}
const run = (repo, command, generation = 1, operation) => manager(repo, 'execute', { type:'command',command }, generation, operation);
const evidence = { checks:[], ports:[18881,18882,18883], project };
function passed(name) { evidence.checks.push(name); console.log('PASS ' + name); }
function inspect(name) { return JSON.parse(docker(['inspect',name]))[0]; }
try {
  compose(['up','-d','--build']);
  await wait(async () => (await fetch(base + '/healthz')).ok, 'control health');
  token = compose(['exec','-T','bot','node','--input-type=module','-e',"import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('/internal/manager.token').toString('base64'))"]).trim();
  deployment = createHash('sha256').update(Buffer.from(token,'base64')).digest('hex').slice(0,16);
  await api('/api/setup','POST',{ username:'administrator',password });
  await api('/api/accounts','POST',{ name:'Token fixture',type:'bot_account',token:githubToken,webhook_secret:id() });
  const a = (await api('/api/accounts','POST',{ name:'Environment fixture',type:'github_app',app_id:'123',private_key:privateKey,webhook_secret:webhookSecret })).account;
  for (const repo of ['101','202']) await api('/api/repositories','POST',{ id:repo, full_name:'fixture/project-' + repo,owner_id:'10',account_id:a.id });
  await api('/api/models','POST',{ repository_id:'101',api_url:'https://model.invalid',api_key:modelKey,model_name:'fixture' });
  await api('/api/users','POST',{ username:'member',password:memberPassword,repository_ids:['101'] });
  await wait(async () => { const list=(await api('/api/environments')).environments;return list.length===2 && list.every(e=>e.state==='ready'); },'two project environments');
  const name = (repo, generation = 1) => `dbot-${deployment}-${repo}-g${generation}`;
  assert.equal(docker(['ps','-aq','--filter',`label=department.bot.deployment=${deployment}`]).trim().split('\n').length,2);
  const before = inspect(name('101')).Id; await manager('101'); assert.equal(inspect(name('101')).Id,before);
  passed('one long-lived container per repository');
  assert.equal((await manager('101','execute',{type:'write',path:'private.txt',content:'project-101-only'})).ok,true);
  assert.equal((await manager('202','execute',{type:'read',path:'private.txt'})).ok,false);
  const c1 = inspect(name('101')), c2 = inspect(name('202'));
  assert.notEqual(c1.Mounts[0].Name,c2.Mounts[0].Name);
  assert.notDeepEqual(Object.keys(c1.NetworkSettings.Networks),Object.keys(c2.NetworkSettings.Networks));
  assert.deepEqual(c1.HostConfig.PortBindings,{}); assert.equal(c1.Config.User,'10001:10001'); assert.equal(c1.HostConfig.ReadonlyRootfs,true);
  const socketTest = await run('101', "node -e \"require('node:fs').access('/var/run/docker.sock',e=>process.exit(e?0:1))\""); assert.equal(socketTest.result.exit_code,0);
  const otherVolume = c1.Mounts[0].Name;
  const leakCheck = await run('202', `test ! -e /workspace/private.txt && test ! -e /var/lib/docker/volumes/${otherVolume} && test ! -e /keys/master.key && test ! -e /internal/manager.token && test ! -e /data/control.sqlite`); assert.equal(leakCheck.result.exit_code,0);
  passed('projects cannot read each other files, volumes, or Docker socket');
  // Start the listening operation concurrently with the connection attempt; it has no published port.
  const listening = run('101', 'node -e "require(\'node:net\').createServer(s=>s.end()).listen(7788,\'0.0.0.0\');setTimeout(()=>process.exit(0),5000)"');
  await wait(() => { try { docker(['exec',name('101'),'node','-e',"const s=require('node:net').connect(7788,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"]); return true; } catch { return false; } }, 'project listener readiness');
  const ip = Object.values(c1.NetworkSettings.Networks)[0].IPAddress;
  const cannotConnect = await run('202', `node -e "const s=require('node:net').connect(7788,'${ip}');s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),1000)"`);
  assert.equal(cannotConnect.result.exit_code,0); await listening; passed('project networks cannot connect across repositories');
  const command = 'node -e "console.log(Date.now());setTimeout(()=>console.log(Date.now()),500)"';
  const same = await Promise.all([run('101',command),run('101',command)]);
  const stamps = same.map(r=>r.result.output.trim().split('\n').map(Number)); assert.ok(stamps[0][1]<=stamps[1][0]);
  const both = await Promise.all([run('101',command),run('202',command)]);
  const times = both.map(r=>r.result.output.trim().split('\n').map(Number)); assert.ok(Math.max(times[0][0],times[1][0])<Math.min(times[0][1],times[1][1]));
  passed('same repository serializes execution; different repositories overlap');
  const envResult = await run('101','env');
  for (const value of [githubToken,modelKey,privateKey.trim(),'BEGIN PRIVATE KEY',token,'BOT_MANAGER_TOKEN_FILE','BOT_MASTER_KEY_FILE']) {
    assert.ok(!envResult.result.output.includes(value)); assert.ok(!JSON.stringify(c1.Config.Env).includes(value)); assert.ok(!JSON.stringify(inspect(c1.Image).Config.Env).includes(value));
  }
  const botId=compose(['ps','-q','bot']).trim(), bot=inspect(botId), mg=inspect(compose(['ps','-q','manager']).trim());
  assert.ok(!bot.Mounts.some(m=>m.Destination.includes('docker.sock'))); assert.ok(mg.Mounts.some(m=>m.Destination==='/var/run/docker.sock'));
  assert.ok(!mg.Mounts.some(m=>m.Destination==='/keys')); assert.ok(!mg.Mounts.some(m=>m.Name===bot.Mounts.find(x=>x.Destination==='/data').Name));
  compose(['exec','-T','bot','node','--input-type=module','-e',"import {accessSync} from 'node:fs';try{accessSync('/var/run/docker.sock');process.exit(1)}catch{}"]);
  passed('project credentials absent; only manager has daemon access');
  const duplicate = id(); await run('101','printf x >> once.txt',1,duplicate); await run('101','printf x >> once.txt',1,duplicate);
  assert.equal((await manager('101','execute',{type:'read',path:'once.txt'})).result.content,'x'); passed('execution operation ids are idempotent');
  compose(['restart','manager']);
  await wait(async () => (await manager('101'))?.state==='ready','manager recovery');
  assert.equal((await manager('101','execute',{type:'read',path:'private.txt'})).result.content,'project-101-only');
  assert.equal((await manager('101')).generation,1); passed('restart rechecks runner and preserves generation and data');
  await api('/api/environments/101/stop','POST',{operation_id:id(),generation:1});
  assert.equal(inspect(name('101')).State.Running,false); assert.ok(docker(['volume','inspect',c1.Mounts[0].Name]));
  await api('/api/environments/101/start','POST',{operation_id:id(),generation:1});
  assert.equal((await manager('101','execute',{type:'read',path:'private.txt'})).result.content,'project-101-only');
  const resetId=id(); await api('/api/environments/101/reset','POST',{operation_id:resetId,generation:1});
  assert.equal((await manager('101')).generation,2); assert.equal(inspect(name('101')).State.Running,false);
  assert.equal((await manager('101','execute',{type:'read',path:'private.txt'},2)).ok,false);
  const oldMount=c1.Mounts[0].Name; assert.ok(docker(['volume','inspect',oldMount]));
  assert.notEqual(inspect(name('101',2)).Mounts[0].Name,oldMount);
  await assert.rejects(run('101','true',1),/stale_generation/); passed('stop retains data; reset increments generation and retains old volume');
  await wait(async()=> (await api('/api/environments')).environments.every(e=>e.state==='ready'),'environment page readiness');
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width:1365,height:900}}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base); await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('button',{name:'项目环境',exact:true}).click();await page.locator('#rows .row').nth(1).waitFor();
    assert.equal(await page.locator('#rows .row').count(),2);await page.screenshot({path:'.tmp/project-env/admin-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByLabel('用户名',{exact:true}).fill('member');await page.getByLabel('密码',{exact:true}).fill(memberPassword);await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('button',{name:'项目环境',exact:true}).click();await page.locator('#rows .row').first().waitFor();assert.equal(await page.locator('#rows .row').count(),1);
    assert.ok((await page.locator('#rows').innerText()).includes('project-101'));assert.ok(!(await page.locator('#rows').innerText()).includes('project-202'));
    await page.getByRole('button',{name:'停止',exact:true}).click();await page.getByText(/仓库 ID 101 · stopped/).waitFor();
    await page.getByRole('button',{name:'启动',exact:true}).click();await page.getByText(/仓库 ID 101 · ready/).waitFor();
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'重置',exact:true}).click();await page.getByText(/generation 3/).waitFor();
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'.tmp/project-env/project-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);passed('desktop and mobile environment page obey administrator scope');
  } finally {await browser.close();}
  const removed=JSON.stringify({action:'deleted',installation:{account:{id:10}}});
  const removal=await fetch('http://127.0.0.1:18881'+a.endpoints[0].webhook_path,{method:'POST',headers:{'X-GitHub-Event':'installation','X-GitHub-Delivery':id(),'X-Hub-Signature-256':'sha256='+createHmac('sha256',webhookSecret).update(removed).digest('hex')},body:removed});assert.equal(removal.status,200);
  await wait(async()=> (await manager('101')).state==='stopped'&&(await manager('202')).state==='stopped','uninstallation stop');
  assert.ok(docker(['volume','inspect',c1.Mounts[0].Name]));assert.ok(docker(['volume','inspect',c2.Mounts[0].Name]));passed('uninstallation stops environments and preserves volumes');
  await api('/api/environments/202/delete','POST',{operation_id:id(),generation:1,confirm:true});
  assert.equal(docker(['ps','-aq','--filter',`name=^/${name('202')}$`]).trim(),'');assert.ok(docker(['volume','inspect',c2.Mounts[0].Name]));passed('delete removes container and network while retaining volume');
} finally {
  // Clean only the unique deployment created by this run, including retained reset volumes.
  compose(['down','--volumes']);
  if(deployment) for(const [kind,find,remove] of [['container',['ps','-aq'],['rm','-f']],['network',['network','ls','-q'],['network','rm']],['volume',['volume','ls','-q'],['volume','rm']]]) {
    const names=docker([...find,'--filter',`label=department.bot.deployment=${deployment}`]).trim().split('\n').filter(Boolean);
    if(names.length) docker([...remove,...names]);
  }
  writeFileSync('.tmp/project-env/evidence.json',JSON.stringify(evidence,null,2));
}
