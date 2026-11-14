import {test,expect} from '@playwright/test';
import { openProjectDanger } from './open-basic-folds.mjs';
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
      h.store.run("INSERT INTO public_board_settings(repository_id,enabled) VALUES(?,0) ON CONFLICT(repository_id) DO UPDATE SET enabled=0", id);
    }
    for (const [id, name, owner] of [['401', 'a-old/hidden-first', '20'], ['402', 'b-owner/hidden-second', '10'], ['403', 'z-renamed/hidden-third', '20']]) {
      h.store.run('INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,installed,hidden,synced_at) VALUES(?,?,?,?,?,1,1,?)', a.id, id, name, owner, owner === '20' ? longOwner : 'b-owner', new Date().toISOString());
    }
    await login(page, 'administrator', password);
    await expect(groups(page).locator('h2')).toHaveText([longOwner, 'b-owner']);
    expect(await groupedIds(page)).toEqual([{owner: '20', ids: ['101', '303']}, {owner: '10', ids: ['202']}]);
    await expect(row('101').getByRole('button', {name: '设置', exact: true})).toBeVisible();
    mkdirSync('.tmp/project-org-groups', {recursive: true});
    for (const [label, width, height] of [['wide', 1920, 1080], ['desktop', 1440, 900], ['compact', 1024, 900], ['tablet', 768, 900], ['mobile', 390, 844], ['narrow', 320, 700]]) {
      await page.setViewportSize({width, height}); await checkWidth(page);
      if (width === 390) {
        const content = await row('101').locator('.row-content').boundingBox(), actions = await row('101').locator(':scope > .actions').boundingBox();
        expect(content.width).toBeGreaterThan(300); expect(actions.y).toBeGreaterThan(content.y + content.height);
      }
      if (label === 'desktop' || label === 'mobile') await page.screenshot({path: `.tmp/project-org-groups/installed-${label}.png`, fullPage: true});
    }
    await expect(row('101').getByRole('switch')).toHaveCount(0);
    await row('101').getByRole('button', {name: '设置', exact: true}).click(); await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
    await page.getByRole('link', {name: '← 全部项目', exact: true}).click();
    const filtersFold = page.getByTestId('project-filters-fold');
    await expect(filtersFold).toBeVisible();
    if (!await filtersFold.evaluate(el => el.open)) await filtersFold.locator('summary').click();
    await page.getByLabel('组织 ID', {exact: true}).fill('10'); await page.getByRole('button', {name: '筛选', exact: true}).click();
    await expect(groups(page).locator('h2')).toHaveText(['b-owner']); await expect(page.locator('#rows .row')).toHaveCount(1); await expect(row('202')).toBeVisible();
    await page.getByLabel('组织 ID', {exact: true}).fill('missing'); await page.getByRole('button', {name: '筛选', exact: true}).click();
    await expect(groups(page)).toHaveCount(0); await expect(page.locator('#rows .row')).toHaveCount(0);
    await page.getByLabel('组织 ID', {exact: true}).fill(''); await page.getByRole('button', {name: '筛选', exact: true}).click();
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
    const next = page.getByRole('button', {name: '下一页', exact: true});
    await next.scrollIntoViewIfNeeded();
    expect(await next.evaluate(node => {const box = node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));})).toBe(true);
    const nextResponse = page.waitForResponse(response => response.url().endsWith('/api/installations?offset=50&limit=50'));
    await next.click(); await nextResponse;
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

test('project list shows progress while settings own mutations and project admins change only their own policies',async({page,browser})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);
  try{
    for(const id of ['101','202'])await repository(admin,a.id,id);
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES('active','101','review.issue','running','Review in progress')");
    await page.goto(h.admin+'/#/projects');
    await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    const row=page.locator('#rows [data-repository-id="101"]');
    await expect(row).toContainText('执行中 1');await expect(row.getByRole('switch')).toHaveCount(0);
    await expect(row.getByRole('button',{name:'禁用',exact:true})).toHaveCount(0);
    await row.getByRole('button',{name:'设置',exact:true}).click();
    await openProjectDanger(page);
    await expect(page.getByRole('button',{name:'禁用项目',exact:true})).toBeVisible();
    await page.goto(h.admin+'/#/settings/projects');
    const globalRow=page.locator('.global-project-row[data-key="101"]');
    await expect(globalRow.getByRole('switch',{name:'fixture/project-101 看板',exact:true})).toBeVisible();
    await expect(globalRow.getByRole('switch',{name:'fixture/project-101 检视',exact:true})).toHaveCount(0);
    const memberPassword=testPassword();await admin('/api/users','POST',{username:'project-admin',password:memberPassword,repository_ids:['101']});
    const context=await browser.newContext({viewport:{width:390,height:844}}),member=await context.newPage();
    try{
      await member.goto(h.admin+'/#/projects');await member.getByLabel('用户名',{exact:true}).fill('project-admin');await member.getByLabel('密码',{exact:true}).fill(memberPassword);await member.getByRole('button',{name:'登录',exact:true}).click();
      await expect(member.locator('#rows .row')).toHaveCount(1);
      await member.locator('#rows [data-repository-id="101"]').getByRole('button',{name:'设置',exact:true}).click();
      await member.getByLabel('开启自动开发',{exact:true}).check();
      await member.getByTestId('console-save').click();
      await expect(member.locator('#project-page .flash')).toContainText('已保存');
      expect((await admin('/api/repositories/101')).value.policy.development_enabled).toBe(1);
    }finally{await context.close();}
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('hidden repositories can be restored and hidden again from global settings',async({page})=>{
  const h=await harness(),{admin,password}=await setup(h),a=await account(admin);
  try{
    h.store.run("INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,installed,hidden,synced_at) VALUES(?,'401','fixture/hidden','10','fixture',1,1,?)",a.id,new Date().toISOString());
    await page.goto(h.admin+'/#/settings/projects/hidden.0');await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
    const row=page.locator('.global-project-row[data-key="401"]');await row.getByRole('button',{name:'恢复',exact:true}).click();await expect(row).toHaveCount(0);
    await page.getByRole('link',{name:'返回项目管理',exact:false}).click();await row.getByRole('button',{name:'删除',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'隐藏',exact:true}).click();await expect(row).toHaveCount(0);
    await page.getByRole('link',{name:'管理已隐藏仓库',exact:false}).click();await expect(row).toBeVisible();
  }finally{await h.stop();rmSync(h.directory,{recursive:true,force:true});}
});

test('项目列表：组织可折叠、状态按类别成列对齐、主列表不显示安装与仓库 ID', async ({page, browser}) => {
  const h = await harness(), {admin, password} = await setup(h), a = await account(admin), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const login = async (target, username, secret) => {
    await target.goto(h.admin + '/#/projects');
    await target.getByLabel('用户名', {exact: true}).fill(username); await target.getByLabel('密码', {exact: true}).fill(secret);
    await target.getByRole('button', {name: '登录', exact: true}).click();
    await expect(target.getByRole('heading', {name: '项目', exact: true})).toBeVisible();
  };
  const group = key => page.locator(`#rows .project-owner-group[data-key="${key}"]`);
  const row = key => page.locator(`#rows .project-list-row[data-key="${key}"]`);
  // Left edge of every status cell, in column order, for one row.
  const columnLefts = key => row(key).evaluate(line => [...line.children]
    .filter(child => child.classList.contains('project-cell'))
    .map(child => Math.round(child.getBoundingClientRect().left)));
  try {
    for (const [id, owner, name, ownerLogin] of [
      ['101', '20', 'alpha/one', 'org-alpha'], ['202', '10', 'beta/two', 'org-beta'],
      ['303', '20', 'alpha/three', 'org-alpha'], ['404', '20', 'alpha/unstarted', 'org-alpha'],
    ]) {
      await repository(admin, a.id, id);
      h.store.run('UPDATE repositories SET full_name=?,owner_id=? WHERE id=?', name, owner, id);
      h.store.run('UPDATE installed_repositories SET full_name=?,owner_id=?,owner_login=?,permissions_at=? WHERE repository_id=?', name, owner, ownerLogin, new Date().toISOString(), id);
      h.store.run("INSERT INTO public_board_settings(repository_id,enabled) VALUES(?,0) ON CONFLICT(repository_id) DO UPDATE SET enabled=0", id);
    }
    await login(page, 'administrator', password);
    await page.setViewportSize({width: 1440, height: 900});

    // One shared column definition: the header names every category and every row uses the same cells.
    const head = page.locator('#rows .project-table-head');
    await expect(head).toBeVisible();
    await expect(head.locator('.project-cell')).toHaveText(['项目', '启用', '检视', '开发', '权限', '门禁', '看板', '任务', '操作']);
    for (const key of ['101', '202', '303', '404']) await expect(row(key).locator(':scope > .project-cell')).toHaveCount(9);
    // Columns line up across rows and across organizations, not just inside one row.
    const alpha = await columnLefts('101'), beta = await columnLefts('202'), unstarted = await columnLefts('404');
    expect(beta).toEqual(alpha); expect(unstarted).toEqual(alpha);

    // Technical IDs stay out of the list; names and useful status remain.
    const listText = await page.locator('#rows').innerText();
    expect(listText).not.toMatch(/仓库 ID|安装 \d+/);
    await expect(row('101')).toContainText('alpha/one');
    await expect(row('101').locator('.project-cell[data-label="启用"]')).toContainText('已启用');

    // #544: the task cell stays the drill-down into the project's activity, as it was before the table.
    const drill = row('101').locator('.project-cell[data-label="任务"] .project-task-preview');
    await expect(drill).toHaveAttribute('href', '#/projects/101/activity');
    await drill.click();
    await expect(page).toHaveURL(/#\/projects\/101\/activity/);
    await page.goBack();
    await expect(row('101')).toBeVisible();

    // #544 review: the permission column names its state instead of staying blank, and the gate cell keeps the shared
    // chip so a background check can replace it where it stands.
    const permissionCell = key => row(key).locator('.project-cell[data-label="权限"]');
    // This fixture has no GitHub permission read, so the honest state is 未检查 — not an empty column. The 正常 state is
    // covered by the unit test that renders a row whose gaps were read and are empty.
    await expect(permissionCell('101')).toHaveText('未检查');
    for (const key of ['101', '202', '303', '404']) await expect(permissionCell(key)).toHaveText(/正常|未检查/);
    const gateChip = row('101').locator('.project-cell[data-label="门禁"] [data-integration]');
    await expect(gateChip).toHaveText(/发布检查未完成|门禁/);

    // A board change on the backend reaches the table without a manual reload: the same poll refreshes the board cell.
    const boardCell = row('101').locator('.project-cell[data-label="看板"]');
    await expect(boardCell).toHaveText('看板已关闭');
    await admin('/api/installations/101/board', 'PATCH', { enabled: true });
    await expect(boardCell).toHaveText(/看板采集中|查看看板/, { timeout: 15000 });

    // Each organization folds on its own, the title stays visible and the state is announced.
    const toggle = group('20').locator('h2 button');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(row('101')).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(row('101')).toBeHidden(); await expect(row('303')).toBeHidden();
    await expect(group('20').locator('h2')).toBeVisible();
    await expect(row('202')).toBeVisible();
    // Keyboard: Enter on the focused title folds the same way.
    await group('10').locator('h2 button').focus();
    await page.keyboard.press('Enter');
    await expect(group('10').locator('h2 button')).toHaveAttribute('aria-expanded', 'false');
    await expect(row('202')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(row('202')).toBeVisible();
    // A manual refresh keeps the folded organization folded.
    await page.getByRole('button', {name: '刷新', exact: true}).click();
    await expect(group('20').locator('h2 button')).toHaveAttribute('aria-expanded', 'false');
    await expect(row('101')).toBeHidden();
    await toggle.click(); await expect(row('101')).toBeVisible();

    mkdirSync('.tmp/ui-project-table', {recursive: true});
    // Narrow screens keep the label/value pairing and never push the page sideways.
    for (const [label, width, height] of [['mobile', 390, 844], ['narrow', 320, 700]]) {
      await page.setViewportSize({width, height});
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await expect(row('101').locator('.project-cell[data-label="门禁"]')).toBeVisible();
      expect(await row('101').evaluate(line => line.scrollWidth <= line.clientWidth)).toBe(true);
      await page.screenshot({path: `.tmp/ui-project-table/${label}.png`, fullPage: true});
    }
    await page.setViewportSize({width: 1440, height: 900});
    await page.screenshot({path: '.tmp/ui-project-table/desktop.png', fullPage: true});

    // A project administrator sees the same columns and none of the technical IDs.
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', {username: 'table-member', password: memberPassword, repository_ids: ['101', '303']});
    const context = await browser.newContext({viewport: {width: 1440, height: 900}}), member = await context.newPage();
    try {
      await login(member, 'table-member', memberPassword);
      await expect(member.locator('#rows .project-table-head .project-cell')).toHaveText(['项目', '启用', '检视', '开发', '权限', '门禁', '看板', '任务', '操作']);
      await expect(member.locator('#rows .project-list-row')).toHaveCount(2);
      expect(await member.locator('#rows').innerText()).not.toMatch(/仓库 ID|安装 \d+/);
      await expect(member.locator('#rows .project-owner-group h2 button')).toHaveAttribute('aria-expanded', 'true');
    } finally { await context.close(); }
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, {recursive: true, force: true}); }
});
