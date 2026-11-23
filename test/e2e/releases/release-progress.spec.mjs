import {test,expect} from '@playwright/test';
import {releaseFixture,run,target,writes} from '../../fixtures/release-fixtures.mjs';
async function login(page,f){await page.goto(f.h.admin+'/#/projects/101/release');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(f.password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('heading',{name:'发版本',level:1,exact:true})).toBeVisible();}

async function holdReleaseRead(page, url, json) {
  const requested = Promise.withResolvers(), gate = Promise.withResolvers();
  await page.evaluate(matchedUrl => {
    const readJson = Response.prototype.json;
    window.delayedReleaseRead = new Promise(resolve => {
      Response.prototype.json = function () {
        const reading = readJson.call(this);
        if (this.url === matchedUrl) {
          Response.prototype.json = readJson;
          // Run after the console's promise handlers have processed the JSON, before checking the DOM.
          void reading.then(body => setTimeout(() => resolve({ status: this.status, body }), 0), () => resolve(null));
        }
        return reading;
      };
    });
  }, url);
  await page.route(url, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    requested.resolve();
    await gate.promise;
    await route.fulfill({ json });
  });
  return {
    requested: requested.promise,
    release: gate.resolve,
    async deliver() {
      gate.resolve();
      expect(await page.evaluate(() => window.delayedReleaseRead)).toEqual({ status: 200, body: json });
    },
  };
}

test('release preparation exposes exact facts, waits for explicit writes and clears failed preflight data',async({page})=>{
 const cleanup=[],f=await releaseFixture({after:fn=>cleanup.push(fn)}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await login(page,f);await page.getByLabel('版本号',{exact:true}).fill('v1.2.3');await page.getByRole('button',{name:'检查候选提交',exact:true}).click();await expect(page.getByRole('button',{name:'确认打标签',exact:true})).toBeEnabled();await expect(page.locator('.release-preview')).toContainText(target);await expect(page.locator('.release-preview')).toContainText('新增提交');expect(writes(f.state)).toEqual([]);
  for(const width of [320,390,768,1024,1440,1920]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.route('**/releases/preflight?*',route=>route.fulfill({status:503,json:{error:'fixture_down'}}));await page.getByRole('button',{name:'检查候选提交',exact:true}).click();await expect(page.getByRole('button',{name:'确认打标签',exact:true})).toBeDisabled();await expect(page.locator('.release-preview')).not.toContainText(target);await expect(page.locator('.release-preview')).toContainText('读取失败');expect(writes(f.state)).toEqual([]);expect(errors).toEqual([]);
 }finally{for(const close of cleanup.reverse())await close();}
});

test('a later workflow attempt cannot inherit a previous attempt success and stale replies cannot redraw another section', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  let delayed;
  try {
    f.state.runs = [run()];
    f.state.jobs = [{ id: 1, run_id: 800, run_attempt: 1, name: 'release', status: 'completed', conclusion: 'success' }];
    const created = await f.create();
    for (let i = 0; i < 2; i++) await f.service.worker.process(created.value.release.id);
    const record = f.h.store.get('SELECT * FROM project_releases WHERE id=?', created.value.release.id), data = JSON.parse(record.data);
    data.ci_success = { run_id: 800, attempt: 1 };
    data.run_attempt = 2;
    data.run = { status: 'in_progress', conclusion: null };
    f.h.store.run("UPDATE project_releases SET stage='running',data=? WHERE id=?", JSON.stringify(data), record.id);

    await login(page, f);
    await expect(page.locator('.release-process')).toContainText('in_progress');
    await expect(page.locator('.release-process')).not.toContainText('attempt 1 已通过');
    delayed = await holdReleaseRead(page, f.h.admin + f.endpoint, {
      releases: [{ ...data, id: record.id, version: 'stale secret', stage: 'running', target_sha: target }],
    });
    await page.getByRole('button', { name: '刷新发布记录', exact: true }).click();
    await delayed.requested;
    await page.locator('#tabs').getByRole('link', { name: '项目总览', exact: true }).click();
    await expect(page).toHaveURL(/\/overview$/);
    await delayed.deliver();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByText('stale secret', { exact: true })).toHaveCount(0);
  } finally {
    delayed?.release();
    try { await page.unrouteAll({ behavior: 'wait' }); }
    finally { for (const close of cleanup.reverse()) await close(); }
  }
});

test('access loss clears previews and records before an older successful preflight can return', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  const endpoint = f.h.admin + f.endpoint, version = 'v1.2.4', preflight = endpoint + '/preflight?version=' + version;
  const check = page.getByRole('button', { name: '检查候选提交', exact: true });
  const confirm = page.getByRole('button', { name: '确认打标签', exact: true });
  const input = page.getByLabel('版本号', { exact: true }), records = page.locator('.release-record');
  const releaseWrites = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().startsWith(endpoint)) releaseWrites.push(request.url());
  });
  const expectAccessLost = async () => {
    await expect(page.locator('.release-panel')).toContainText('发布权限已失效');
    await expect(page.locator('.release-preview')).toBeEmpty();
    await expect(page.locator('.release-overview')).toBeEmpty();
    await expect(records).toHaveCount(0);
    await expect(confirm).toBeDisabled();
  };
  let delayed;
  try {
    await f.create();
    await login(page, f);
    await input.fill(version);
    const [initial] = await Promise.all([page.waitForResponse(preflight), input.press('Tab')]);
    await expect(confirm).toBeEnabled();
    await expect(records).toHaveCount(1);
    const candidate = await initial.json();
    expect(candidate.available).toBe(true);
    // Reuse a successful fixture response so no upstream read can overlap the delayed browser reply.
    delayed = await holdReleaseRead(page, preflight, { ...candidate, target_title: 'stale candidate' });
    await check.click();
    await delayed.requested;

    await page.route(endpoint, route => route.request().method() === 'GET'
      ? route.fulfill({ status: 403, json: { error: 'repository_forbidden' } }) : route.fallback());
    await page.getByRole('button', { name: '刷新发布记录', exact: true }).click();
    await expectAccessLost();
    // A later denied poll can clear a briefly restored preview before a locator assertion sees it.
    const previewAdditions = await page.locator('.release-preview').evaluateHandle(preview => {
      const added = [];
      new MutationObserver(entries => {
        for (const entry of entries) {
          for (const node of entry.addedNodes) added.push(node.textContent);
        }
      }).observe(preview, { childList: true });
      return added;
    });
    await delayed.deliver();
    expect(await previewAdditions.jsonValue()).toEqual([]);
    await expectAccessLost();
    await expect(page.getByText('stale candidate', { exact: true })).toHaveCount(0);
    expect(releaseWrites).toEqual([]);
    expect(writes(f.state)).toEqual([]);
  } finally {
    delayed?.release();
    try { await page.unrouteAll({ behavior: 'wait' }); }
    finally { for (const close of cleanup.reverse()) await close(); }
  }
});

test('a published Release with an intentionally empty body is still shown as an existing Release',async({page})=>{
 const cleanup=[],f=await releaseFixture({after:fn=>cleanup.push(fn)});
 try{
  f.state.runs=[run()];f.state.jobs=[{id:1,run_id:800,run_attempt:1,name:'release',status:'completed',conclusion:'success'}];const created=await f.create();for(let i=0;i<4;i++)await f.service.worker.process(created.value.release.id);
  let record=(await f.admin(f.endpoint)).value.releases[0];const saved=await f.admin(f.endpoint+'/'+record.id+'/draft','PATCH',{body:'',revision:record.revision,body_revision:record.body_revision});expect(saved.status).toBe(200);record=saved.value.release;
  const published=await f.admin(f.endpoint+'/'+record.id+'/publish','POST',{revision:record.revision,body_revision:record.body_revision});expect(published.status).toBe(201);expect(published.value.release.stage).toBe('published');
  await login(page,f);await expect(page.locator('.release-process')).toContainText('已记录 Release');await expect(page.locator('.release-process')).not.toContainText('尚未生成');
 }finally{for(const close of cleanup.reverse())await close();}
});
