import {test,expect} from '@playwright/test';
import {rmSync} from 'node:fs';
import {harness,setup,account,repository} from '../test/helpers.mjs';

// An installed repository that nobody has started has no project page. The console must not link to one, and an address
// that still points there must explain it and offer 启动, not show the server's error code.
test('未启动的仓库不提供项目设置入口，直接打开其项目地址时说明尚未启动并可就地启动', async ({page}) => {
  const h = await harness(), {admin, password} = await setup(h), a = await account(admin), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await repository(admin, a.id, '101');
    for (const id of ['501', '502']) h.store.run(`INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,private,installed,synced_at)
      VALUES(?,?,?,?,?,0,1,?)`, a.id, id, `fixture/unstarted-${id}`, '10', 'fixture', new Date().toISOString());
    await page.goto(h.admin + '/#/projects');
    await page.getByLabel('用户名', {exact: true}).fill('administrator'); await page.getByLabel('密码', {exact: true}).fill(password);
    await page.getByRole('button', {name: '登录', exact: true}).click();
    const row = id => page.locator(`#rows .row[data-key="${id}"]`);
    await expect(row('101').getByRole('button', {name: '设置', exact: true})).toBeVisible();
    await expect(row('501').getByRole('button', {name: '设置', exact: true})).toHaveCount(0);
    await expect(row('501').getByRole('button', {name: '启动', exact: true})).toBeVisible();

    // A bookmarked or shared address of the repository explains that it is not started yet and starts it in place.
    await page.goto(h.admin + '/#/projects/501/basic');
    const state = page.locator('#project-page .console-state');
    await expect(state.getByRole('heading', {name: 'fixture/unstarted-501 还没有启动', exact: true})).toBeVisible();
    await expect(page.locator('#project-page')).not.toContainText('tenant_forbidden');
    await expect(page.locator('#project-page')).not.toContainText('repository_not_found');
    await expect(page.locator('#console-context')).toHaveText('fixture · unstarted-501 · 未启动');
    await expect(state.getByRole('link', {name: /全局设置 · 项目/})).toHaveAttribute('href', '#/settings/projects');
    await state.getByRole('button', {name: '启动', exact: true}).click();
    await page.locator('#activation-view').getByRole('button', {name: '启动', exact: true}).click();
    await expect(page.locator('#project-page .project-head h1')).toHaveText('fixture/unstarted-501');
    await expect(page).toHaveURL(/#\/projects\/501\/basic$/);
    await expect(page.locator('#console-context')).toHaveText('fixture · unstarted-501');

    // The global project list links only started repositories to their project page.
    await page.goto(h.admin + '/#/settings/projects');
    const global = id => page.locator(`.global-project-row[data-repository-id="${id}"]`);
    await expect(global('501').getByRole('link', {name: /全局管理此项目/})).toBeVisible();
    await expect(global('502').getByRole('button', {name: '启动', exact: true})).toBeVisible();
    await expect(global('502').getByRole('link', {name: /全局管理此项目/})).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, {recursive: true, force: true}); }
});
