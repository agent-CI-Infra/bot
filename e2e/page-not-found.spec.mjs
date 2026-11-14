import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';

// #642: an unknown address says 找不到这个页面 at once with a way back; an unknown project page shows the same state inside
// the project instead of silently drawing another section. Known addresses keep working.
test('#642 未知地址与项目内未知子页显示「找不到这个页面」，1440 与 390', async ({ browser }) => {
  test.setTimeout(90000);
  const h = await harness();
  try {
    const { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const password = testPassword(); await admin('/api/users', 'POST', { username: 'member', password, role: 'project_admin', repository_ids: ['101'] });
    mkdirSync('.tmp/page-not-found', { recursive: true });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(h.admin + '/#/nonexistent'); await page.getByLabel('用户名', { exact: true }).fill('member');
      await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
      const state = page.locator('#console-page [data-page-not-found="console"]'), fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      // A fresh load of an unknown address, and a hash change to one from a working page.
      for (const from of [null, '#/board']) {
        if (from) { await page.evaluate(hash => { location.hash = hash; }, from); await expect(page.locator('#console-context')).toHaveText('看板'); }
        const lists = []; page.on('request', r => { if (/\/api\/repositories\?/.test(r.url())) lists.push(r.url()); });
        if (from) await page.evaluate(() => { location.hash = '#/nonexistent'; });
        await expect(state.getByRole('heading', { name: '找不到这个页面', exact: true })).toBeVisible({ timeout: 1000 });
        await expect(state).toContainText('链接可能已过期或输入有误。');
        await expect(page.getByText('正在加载…')).toBeHidden();
        await expect(page.locator('.list-panel')).toBeHidden();
        await expect(page.locator('#console-context')).toHaveText('找不到页面');
        await expect(page).toHaveTitle('找不到页面 · launchpad 管理');
        await expect(page.locator('#tabs [aria-current=page]')).toHaveCount(0);
        await expect(page.locator('#console-mobile-nav [aria-current=page]')).toHaveCount(0);
        await expect(state.getByRole('link', { name: '查看身份与权限', exact: true })).toHaveAttribute('href', '#/identity');
        const back = state.getByRole('link', { name: '回到项目列表', exact: true }); await expect(back).toBeVisible(); await expect(back).toHaveAttribute('href', '#/projects');
        const box = await back.boundingBox(); expect(box.x + box.width).toBeLessThanOrEqual(width); expect(await fits()).toBe(true);
        expect(lists, 'an unknown address issues no list read').toEqual([]); page.removeAllListeners('request');
      }
      await page.screenshot({ path: `.tmp/page-not-found/console-${width}.png`, fullPage: true });
      await state.getByRole('link', { name: '回到项目列表', exact: true }).click();
      await expect(page).toHaveURL(/#\/projects$/); await expect(page.locator('#rows')).toContainText('fixture/project-101'); await expect(page).toHaveTitle('launchpad 管理');
      // The skip link's in-page anchor is not an address and keeps the current page.
      await page.evaluate(() => { location.hash = '#main-content'; }); await expect(page.locator('#rows')).toContainText('fixture/project-101');
      await expect(page.locator('[data-page-not-found]')).toHaveCount(0);

      // An unknown page inside a project: same state, inside the project, with its overview as the way back.
      for (const address of ['#/projects/101/bogus', '#/projects/101/settings']) {
        await page.goto(h.admin + '/' + address);
        const inner = page.locator('#project-page [data-page-not-found="project"]');
        await expect(inner.getByRole('heading', { name: '找不到这个页面', exact: true })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(address.replace(/[/]/g, '\\/') + '$'));
        await expect(page.locator('#project-page .project-head h1')).toHaveText('fixture/project-101');
        await expect(page.locator('#project-page h3', { hasText: '项目概况' })).toHaveCount(0);
        await expect(page).toHaveTitle('找不到页面 · launchpad 管理');
        await expect(page.locator('#console-secondary-nav .project-nav [aria-current=page]')).toHaveCount(0);
        if (width === 390) await expect(page.locator('#console-section option:checked')).toHaveText('找不到页面');
        await expect(inner.getByRole('link', { name: '回到项目列表', exact: true })).toHaveAttribute('href', '#/projects');
        await expect(inner.getByRole('link', { name: '回到项目总览', exact: true })).toBeVisible(); expect(await fits()).toBe(true);
      }
      await page.screenshot({ path: `.tmp/page-not-found/project-${width}.png`, fullPage: true });
      await page.locator('#project-page').getByRole('link', { name: '回到项目总览', exact: true }).click();
      await expect(page).toHaveURL(/#\/projects\/101\/overview$/); await expect(page.locator('#project-page [data-page-not-found]')).toHaveCount(0);
      await expect(page.locator('#console-secondary-nav .project-nav [aria-current=page]')).toHaveText('项目总览'); await expect(page).toHaveTitle('launchpad 管理');
      // A project address with no section still opens 基本设置, as before.
      await page.goto(h.admin + '/#/projects/101'); await expect(page.locator('#console-secondary-nav .project-nav [aria-current=page]')).toHaveText('基本设置');
      // A broken project link that is not a project address at all is a top-level not-found.
      for (const address of ['#/projects/abc', '#/projects/101/release-notes']) { await page.goto(h.admin + '/' + address); await expect(state.getByRole('heading', { name: '找不到这个页面', exact: true })).toBeVisible(); }
      expect(errors).toEqual([]); await context.close();
    }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
