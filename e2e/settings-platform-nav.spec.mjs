import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';
import { testPassword } from '../test/helpers.mjs';

// Platform defaults (running version, task concurrency, default computer resources) now belong to 平台 inside the
// 系统与算力 group, and 常规 is retired: its old address lands on 平台 instead of drawing a category of its own.
async function login(page, f, hash) {
  await page.goto(f.h.admin + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('平台 owns the platform defaults inside the 系统与算力 group and the old 常规 address lands there', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const panel = page.locator('#settings-panel'), nav = page.locator('.project-nav');
    const headings = async () => (await panel.locator('h3').allInnerTexts()).filter(text => text.trim());
    const platformCards = ['当前运行版本', '同时运行的任务', '虚拟电脑默认资源'];

    await login(page, f, '/#/settings/platform');
    // The category sits inside 系统与算力: the group label is drawn first and 平台 is the entry right under it.
    const group = nav.locator('p.console-nav-label', { hasText: '系统与算力' });
    await expect(group).toHaveText('系统与算力');
    const firstInGroup = group.locator('xpath=following-sibling::a[1]');
    await expect(firstInGroup).toHaveText('平台');
    await expect(firstInGroup).toHaveAttribute('href', '#/settings/platform');
    // 常规 is no longer a category at all, so no tab still offers the retired name.
    await expect(nav.getByRole('link', { name: '常规', exact: true })).toHaveCount(0);
    // The address owns the three platform cards, and the bar marks it as the current category.
    await expect(nav.locator('[aria-current=page]')).toHaveText('平台');
    await expect.poll(headings).toEqual(platformCards);

    // The retired address is not a dead end: it lands on the category that now owns these cards.
    await page.goto(f.h.admin + '/#/settings/general');
    await expect(page).toHaveURL(/#\/settings\/platform$/);
    await expect(nav.locator('[aria-current=page]')).toHaveText('平台');
    await expect.poll(headings).toEqual(platformCards);

    // A different declared category still draws its own cards, so the assertions above are not one always-on page.
    await page.goto(f.h.admin + '/#/settings/models');
    await expect.poll(headings).toEqual(['默认共享模型', '部署共享模型']);

    // 存储 (#436) stays in 系统与算力, still the last entry before the next group label: the rename must not displace it.
    await page.goto(f.h.admin + '/#/settings/platform');
    const storage = nav.getByRole('link', { name: '存储', exact: true });
    await expect(storage).toHaveAttribute('href', '#/settings/storage');
    await expect(storage.locator('xpath=following-sibling::p[1]')).toHaveText('接入与网络');

    // A project administrator reaches only 存储, as #436 made it: renaming 常规 must not widen who reads global settings.
    const memberPassword = testPassword();
    await f.admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: ['101'] });
    const member = await page.context().browser().newContext(), memberPage = await member.newPage();
    await memberPage.goto(f.h.admin + '/#/settings');
    await memberPage.getByLabel('用户名', { exact: true }).fill('member');
    await memberPage.getByLabel('密码', { exact: true }).fill(memberPassword);
    await memberPage.getByRole('button', { name: '登录', exact: true }).click();
    const memberNav = memberPage.locator('.project-nav');
    await expect(memberNav.getByRole('link')).toHaveText(['存储']);
    await expect(memberNav.getByRole('link', { name: '平台', exact: true })).toHaveCount(0);
    await member.close();
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
