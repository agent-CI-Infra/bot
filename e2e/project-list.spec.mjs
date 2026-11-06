import {test,expect} from '@playwright/test';
import {mkdirSync,rmSync} from 'node:fs';
import {harness,setup,account,repository,testPassword} from '../test/helpers.mjs';

test('项目按所有者分组，筛选和每页 50 条分页保持项目完整，隐藏与恢复仍可用', async ({page, browser}) => {
  const h = await harness(), {admin, password} = await setup(h), a = await account(admin), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const longOwner = 'organization-with-a-very-long-owner-name';
  const login = async (target, username, secret) => {
    await target.goto(h.admin + '/#/projects');
    await target.getByLabel('用户名', {exact: true}).fill(username); await target.getByLabel('密码', {exact: true}).fill(secret);
    await target.getByRole('button', {name: '登录', exact: true}).click();
    await expect(target.getByRole('heading', {name: '项目', exact: true})).toBeVisible();
  };
  const groups = target => target.locator('#rows .project-owner-group');
  const row = id => page.locator(`#rows .row[data-key="${id}"]`);
  const groupedIds = async target => groups(target).evaluateAll(nodes => nodes.map(group => ({
    owner: group.dataset.ownerId, ids: [...group.querySelectorAll('.row')].map(line => line.dataset.key)
  })));
  const checkWidth = async target => expect(await target.evaluate(() => {
    const width = innerWidth;
    return document.documentElement.scrollWidth <= width && [...document.querySelectorAll('.project-owner-title, #rows .row')].every(node => {
      const box = node.getBoundingClientRect(); return box.x >= 0 && box.right <= width && node.scrollWidth <= node.clientWidth;
    });
  })).toBe(true);
  try {
    for (const [id, owner, name, ownerLogin] of [
      ['101', '20', 'a-old/project-with-a-long-unbroken-name-for-narrow-screen-checks', ''],
      ['202', '10', 'b-owner/second', 'b-owner'], ['303', '20', 'z-renamed/third', longOwner]
    ]) {
      await repository(admin, a.id, id);
      h.store.run('UPDATE repositories SET full_name=?,owner_id=? WHERE id=?', name, owner, id);
      h.store.run('UPDATE installed_repositories SET full_name=?,owner_id=?,owner_login=?,permissions_at=? WHERE repository_id=?', name, owner, ownerLogin, new Date().toISOString(), id);
    }
    for (const [id, name, owner] of [['401', 'a-old/hidden-first', '20'], ['402', 'b-owner/hidden-second', '10'], ['403', 'z-renamed/hidden-third', '20']]) {
      h.store.run('INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,installed,hidden,synced_at) VALUES(?,?,?,?,?,1,1,?)', a.id, id, name, owner, owner === '20' ? longOwner : 'b-owner', new Date().toISOString());
    }
    await login(page, 'administrator', password);
    await expect(groups(page).locator('h2')).toHaveText([longOwner, 'b-owner']);
    expect(await groupedIds(page)).toEqual([{owner: '20', ids: ['101', '303']}, {owner: '10', ids: ['202']}]);
    await expect(row('101').getByRole('button', {name: '设置', exact: true})).toBeVisible();
    mkdirSync('.tmp/project-org-groups', {recursive: true});
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({width, height}); await checkWidth(page);
      if (width === 390) {
        const content = await row('101').locator('.row-content').boundingBox(), actions = await row('101').locator(':scope > .actions').boundingBox();
        expect(content.width).toBeGreaterThan(300); expect(actions.y).toBeGreaterThan(content.y + content.height);
      }
      await page.screenshot({path: `.tmp/project-org-groups/installed-${label}.png`, fullPage: true});
    }
    await row('101').getByRole('switch', {name: / 看板$/, exact: false}).click();
    await expect(row('101').getByRole('status')).toHaveText('看板已关闭；不再公开展示');
    await row('101').getByRole('button', {name: '设置', exact: true}).click(); await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
    await page.getByRole('link', {name: '← 全部项目', exact: true}).click();
    await page.getByLabel('组织 ID', {exact: true}).fill('10'); await page.getByRole('button', {name: '筛选', exact: true}).click();
    await expect(groups(page).locator('h2')).toHaveText(['b-owner']); await expect(page.locator('#rows .row')).toHaveCount(1); await expect(row('202')).toBeVisible();
    await page.getByLabel('组织 ID', {exact: true}).fill('missing'); await page.getByRole('button', {name: '筛选', exact: true}).click();
    await expect(groups(page)).toHaveCount(0); await expect(page.locator('#rows .row')).toHaveCount(0);
    await page.getByLabel('组织 ID', {exact: true}).fill(''); await page.getByRole('button', {name: '筛选', exact: true}).click();
    await page.getByLabel('已隐藏', {exact: true}).check();
    await expect(groups(page).locator('h2')).toHaveText([longOwner, 'b-owner']);
    expect(await groupedIds(page)).toEqual([{owner: '20', ids: ['401', '403']}, {owner: '10', ids: ['402']}]);
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({width, height}); await checkWidth(page);
      await page.screenshot({path: `.tmp/project-org-groups/hidden-${label}.png`, fullPage: true});
    }
    await row('401').getByRole('button', {name: '恢复', exact: true}).click(); await expect(row('401')).toHaveCount(0);
    await page.getByLabel('已隐藏', {exact: true}).uncheck();
    await expect(row('401')).toBeVisible(); await row('401').getByRole('button', {name: '删除', exact: true}).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('只从列表里隐藏这一行');
    await dialog.getByRole('button', {name: '隐藏', exact: true}).click(); await expect(row('401')).toHaveCount(0);
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', {username: 'group-member', password: memberPassword, repository_ids: ['101', '202', '303']});
    const context = await browser.newContext(), member = await context.newPage();
    try {
      await login(member, 'group-member', memberPassword);
      await expect(groups(member).locator('h2')).toHaveText(['a-old', 'b-owner']);
      expect(await groupedIds(member)).toEqual([{owner: '20', ids: ['101', '303']}, {owner: '10', ids: ['202']}]);
      await expect(member.locator('#rows .row')).toHaveCount(3); await expect(member.locator('#rows')).not.toContainText('hidden-first');
      for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
        await member.setViewportSize({width, height}); await checkWidth(member);
        await member.screenshot({path: `.tmp/project-org-groups/member-${label}.png`, fullPage: true});
      }
    } finally { await context.close(); }
    // More than one page: the owner groups contain exactly the rows returned for that page.
    for (let i = 0; i < 51; i++) {
      const id = String(1000 + i), owner = i % 2 ? '20' : '10', name = `extra/project-${id}`;
      h.store.run('INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES(?,?,?,?)', id, name, owner, a.id);
      h.store.run('INSERT INTO policies(repository_id) VALUES(?)', id);
      h.store.run('INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,installed,synced_at) VALUES(?,?,?,?,?,1,?)', a.id, id, name, owner, owner === '20' ? longOwner : 'b-owner', new Date().toISOString());
    }
    const all = (await admin('/api/installations')).value.repositories.map(item => item.id);
    await page.getByRole('button', {name: '刷新', exact: true}).click(); await expect(page.locator('#rows .row')).toHaveCount(50);
    const first = (await groupedIds(page)).flatMap(group => group.ids);
    expect([...first].sort()).toEqual(all.slice(0, 50).sort());
    const nextResponse = page.waitForResponse(response => response.url().endsWith('/api/installations?offset=50&limit=50'));
    await page.getByRole('button', {name: '下一页', exact: true}).click(); await nextResponse;
    await expect(page.locator('#rows .row')).toHaveCount(4);
    const second = (await groupedIds(page)).flatMap(group => group.ids);
    expect([...second].sort()).toEqual(all.slice(50).sort()); expect(new Set([...first, ...second]).size).toBe(54);
    await expect(page.getByRole('button', {name: '下一页', exact: true})).toBeDisabled();
    await page.getByLabel('组织 ID', {exact: true}).fill('20'); await page.getByRole('button', {name: '筛选', exact: true}).click();
    await expect(page.locator('#page-number')).toHaveText('第 1 页');
    await expect(page.locator('#rows .row')).toHaveCount(27); await expect(groups(page)).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, {recursive: true, force: true}); }
});

test('项目列表直接切换检视和开发，保存失败保留状态，任务数刷新且项目管理员仅见自己的项目',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    for(const id of ['101','202','303'])await repository(admin,a.id,id);
    await admin('/api/repositories/303/policy','PATCH',{enabled:false});
    h.store.run("INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at) VALUES(?,'404','fixture/new-project','10','fixture',0,1,?)",a.id,new Date().toISOString());
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('active','101','review.issue','running','Review in progress')");
    for(let i=0;i<65;i++)h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,'101','review.issue','queued','Waiting for this computer')",'queue-'+i);
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('waiting','101','development.issue','waiting_configuration','Configure a model')");
    const login=async(p,user,secret)=>{await p.goto(h.admin);await p.getByLabel('用户名',{exact:true}).fill(user);await p.getByLabel('密码',{exact:true}).fill(secret);await p.getByRole('button',{name:'登录',exact:true}).click();await expect(p.getByRole('heading',{name:'项目',exact:true})).toBeVisible();};
    await login(page,'administrator',password);
    const row=id=>page.locator(`#rows [data-repository-id="${id}"]`),review=row('101').getByRole('switch',{name:'fixture/project-101 检视',exact:true}),development=row('101').getByRole('switch',{name:'fixture/project-101 开发',exact:true});
    await expect(review).toHaveAttribute('aria-checked','false');await expect(row('101')).toContainText('执行中 1');await expect(row('101')).toContainText('排队 65');await expect(row('202')).toContainText('执行中 0');
    await review.click();await expect(review).toHaveAttribute('aria-checked','true');await expect(row('101').getByRole('status')).toHaveText('检视已开启');
    await review.click();await expect(review).toHaveAttribute('aria-checked','false');await review.click();await expect(review).toHaveAttribute('aria-checked','true');
    await page.route('**/api/repositories/101/policy',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'}));await development.click();await expect(row('101').getByRole('status')).toContainText('开发保存失败');await expect(row('101').getByRole('status')).toContainText('temporary_unavailable');await expect(development).toHaveAttribute('aria-checked','false');
    mkdirSync('.tmp/project-list',{recursive:true});await page.screenshot({path:'.tmp/project-list/save-error.png',fullPage:true});await page.unroute('**/api/repositories/101/policy');
    let release,count=0;const held=new Promise(done=>release=done);
    await page.route('**/api/repositories/101/policy',async route=>{count++;expect(route.request().postDataJSON()).toEqual({development_enabled:true});await held;await route.continue();});
    await development.click();await expect(development).toBeDisabled();await expect(review).toBeDisabled();await development.evaluate(node=>node.click());expect(count).toBe(1);release();await expect(development).toBeEnabled();await expect(development).toHaveAttribute('aria-checked','true');await expect(row('101').getByRole('status')).toHaveText('开发已开启');await page.unroute('**/api/repositories/101/policy');
    await expect(row('404').getByRole('switch').first()).toBeDisabled();await expect(row('404').getByRole('switch',{name:'fixture/new-project 开发',exact:true})).toBeDisabled();await expect(row('404').getByRole('switch',{name:'fixture/new-project 看板',exact:true})).toBeEnabled();
    const disabledDevelopment=row('303').getByRole('switch',{name:'fixture/project-303 开发',exact:true});await disabledDevelopment.click();await expect(disabledDevelopment).toHaveAttribute('aria-checked','true');await expect(row('303').getByRole('status')).toHaveText('开发已开启；项目仍已禁用');expect((await admin('/api/repositories/303')).value.policy.enabled).toBe(0);
    h.store.run("UPDATE tasks SET status='succeeded' WHERE id='active'");h.store.run("UPDATE tasks SET status='running' WHERE id='queue-0'");
    await expect(row('101')).toContainText('排队 64',{timeout:10000});await expect(row('101')).toContainText('执行中 1');
    await page.setViewportSize({width:1440,height:900});const title=await row('101').locator('.row-content').boundingBox(),controls=await row('101').locator('.project-overview').boundingBox();expect(controls.x).toBeGreaterThan(title.x+title.width-1);await page.screenshot({path:'.tmp/project-list/desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(review).toBeVisible();await expect(development).toBeVisible();await page.screenshot({path:'.tmp/project-list/mobile.png',fullPage:true});
    await row('101').getByRole('link',{name:/正在执行 1 个任务/}).click();await expect(page).toHaveURL(/#\/projects\/101\/activity$/);await expect(page.getByRole('heading',{name:'fixture/project-101',exact:true})).toBeVisible();
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'project-admin',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext({viewport:{width:390,height:844}}),member=await context.newPage();await login(member,'project-admin',memberPassword);await expect(member.locator('#rows .project-list-row')).toHaveCount(1);await expect(member.locator('#rows')).not.toContainText('fixture/project-202');await expect(member.locator('#rows')).toContainText('执行中 1');
    const own=member.getByRole('switch',{name:'fixture/project-101 开发',exact:true});await own.click();await expect(own).toHaveAttribute('aria-checked','false');await expect(member.locator('#rows [role=status]')).toHaveText('开发已关闭');await member.screenshot({path:'.tmp/project-list/member-mobile.png',fullPage:true});await context.close();
    expect((await admin('/api/repositories/101')).value.policy.development_enabled).toBe(0);expect(errors).toEqual([]);
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});
