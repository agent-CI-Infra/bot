import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #737: the document title names the page a tab and a history entry belong to, instead of the generic chrome title that
// every route reset it to. The 404 prefix is translated with the rest of the chrome, and a real address change announces
// the new page once by moving focus to its heading - never on the page a reader opened with, never twice for one address.
const zh = ' · launchpad 管理';
const en = ' · launchpad Admin';

async function signIn(page, password, labels) {
  await page.getByLabel(labels.user, { exact: true }).fill('administrator');
  await page.getByLabel(labels.password, { exact: true }).fill(password);
  await page.getByRole('button', { name: labels.submit, exact: true }).click();
}
const zhLogin = { user: '用户名', password: '密码', submit: '登录' }, enLogin = { user: 'Username', password: 'Password', submit: 'Sign in' };

async function fixture(t) {
  const h = await harness(), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  return { h, password };
}

test('#737 标题随路由更新：列表、控制台页、全局设置、项目页与 404', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const { h, password } = await fixture();
  try {
    await page.goto(h.admin + '/#/projects');
    await signIn(page, password, zhLogin);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await expect(page).toHaveTitle('项目' + zh);
    // A console page and a list page name themselves, not the page the reader came from.
    for (const [hash, title] of [['#/inbox', '待处理'], ['#/costs', '用量与成本'], ['#/settings/models', '全局设置']]) {
      await page.evaluate(address => { location.hash = address; }, hash);
      await expect(page).toHaveTitle(title + zh);
    }
    // The owner of the page is the project and the section it shows; the record inside the section does not rename it.
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(page.locator('#console-project-header .project-head h1')).toHaveText('fixture/project-101');
    await expect(page).toHaveTitle('fixture/project-101 · 项目总览' + zh);
    await page.evaluate(() => { location.hash = '#/projects/101/activity'; });
    await expect(page).toHaveTitle('fixture/project-101 · 运行状态' + zh);
    // The retired directory address is replaced by the overview, including its browser title.
    await page.evaluate(() => { location.hash = '#/projects/101/menu'; });
    await expect(page).toHaveTitle('fixture/project-101 · 项目总览' + zh);
    // A shared link to a project this reader cannot reach must not keep the name of the project before it.
    await page.evaluate(() => { location.hash = '#/projects/999/overview'; });
    await expect(page).toHaveTitle('项目总览' + zh);
    // An address the console does not know says so in the title, and a real page afterwards recomputes it.
    await page.evaluate(() => { location.hash = '#/nonexistent'; });
    await expect(page.locator('#console-page [data-page-not-found="console"]')).toBeVisible();
    await expect(page).toHaveTitle('找不到页面' + zh);
    await page.evaluate(() => { location.hash = '#/costs'; });
    await expect(page).toHaveTitle('用量与成本' + zh);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('#737 英文界面下页面名与 404 前缀都是英文', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const { h, password } = await fixture();
  try {
    await page.addInitScript(() => localStorage.setItem('launchpad.locale', 'en'));
    await page.goto(h.admin + '/#/projects');
    await signIn(page, password, enLogin);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await expect(page).toHaveTitle('Projects' + en);
    await page.evaluate(() => { location.hash = '#/costs'; });
    await expect(page).toHaveTitle('Usage & costs' + en);
    await page.evaluate(() => { location.hash = '#/nonexistent'; });
    await expect(page).toHaveTitle('Page not found' + en);
    // Switching the interface language recomputes the title the route already set instead of leaving the old one.
    await page.locator('#locale-switch').getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page).toHaveTitle('找不到页面' + zh);
    // The language already in effect is a no-op for the interface, and it must stay a no-op for the page name too.
    await page.locator('#locale-switch').getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page).toHaveTitle('找不到页面' + zh);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('#737 登录页的标题是界面名，切换语言也不冒充任何控制台页', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const { h, password } = await fixture();
  try {
    await page.addInitScript(() => localStorage.setItem('launchpad.locale', 'en'));
    await page.goto(h.admin + '/#/projects');
    // Before a console page exists the title is the translated chrome name - never the default tab's name.
    await expect(page.locator('#access')).toBeVisible();
    await expect(page).toHaveTitle('launchpad Admin');
    await page.locator('#locale-switch').getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page).toHaveTitle('launchpad 管理');
    // Signing out ends the page the reader was on; the sign-in screen is back to the chrome name.
    await signIn(page, password, zhLogin);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await page.evaluate(() => { location.hash = '#/costs'; });
    await expect(page).toHaveTitle('用量与成本' + zh);
    await page.locator('#logout').click();
    await expect(page.locator('#access')).toBeVisible();
    await expect(page).toHaveTitle('launchpad 管理');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('#737 真实的地址变化把焦点移到新页面标题，同地址重绘不再搬焦点', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const { h, password } = await fixture();
  const active = () => page.evaluate(() => {
    const el = document.activeElement;
    return { id: el?.id || null, tag: el?.tagName || null, text: el?.textContent?.trim() || null };
  });
  try {
    await page.goto(h.admin + '/#/projects');
    await signIn(page, password, zhLogin);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    // The page a reader opens with is not announced: signing in leaves focus where the browser put it.
    expect((await active()).id).not.toBe('page-title');
    await page.locator('#tabs').getByRole('link', { name: '用量与成本', exact: true }).click();
    await expect(page.locator('#costs-panel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || null)).toBe('page-title');
    expect(await active()).toEqual({ id: 'page-title', tag: 'H1', text: '用量与成本' });
    // Navigating to inbox moves focus to its heading.
    await page.locator('#tabs').getByRole('link', { name: '待处理', exact: true }).click();
    await expect(page.locator('.console-inbox')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName || null)).toBe('H1');
    // A redraw of the same address (a poll, a locale refresh) must not move the focus a reader already set.
    await page.locator('#tabs').getByRole('link', { name: '项目', exact: true }).focus();
    await page.evaluate(() => route());
    expect(await page.evaluate(() => document.activeElement?.dataset?.consoleNav)).toBe('projects');
    // A project page announces its own heading, which is the project name rather than a tab caption.
    await page.evaluate(() => { location.hash = '#/projects/101/overview'; });
    await expect(page.locator('#console-project-header .project-head h1')).toHaveText('fixture/project-101');
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim() || null)).toBe('fixture/project-101');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('#737 390 宽度跟随手机底部导航切换页面也会把焦点交给新页面', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects');
    await signIn(page, password, zhLogin);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    // The phone navigates through its own list of destinations; those links carry data-page, not data-tab.
    await page.locator('#console-mobile-nav a[data-page="inbox"]').click();
    await expect(page.locator('.console-inbox')).toBeVisible();
    await expect(page).toHaveTitle('待处理' + zh);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName || null)).toBe('H1');
    // A list page in the same bar lands on its own heading rather than the skip-link target.
    await page.locator('#console-mobile-nav a[data-page="costs"]').click();
    await expect(page.locator('#costs-panel')).toBeVisible();
    await expect(page).toHaveTitle('用量与成本' + zh);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName || null)).toBe('H1');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
