import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { channelFixture, privateChat, registerDestination } from '../test/channel-fixture.mjs';

// #886: both preview boxes are named with aria-label but carried no role, so they map to `generic`, where an author name
// is prohibited — axe reports `aria-prohibited-attr` (serious) and a reader may never hear "计划预览" or
// "事件订阅时间预览". The name stays; the box gets the house idiom for a named substructure (role="group", as the
// event-type box and the board controls already do).
const out = '.tmp/ui-886';
// The rule axe applies: an element that maps to `generic` (a div/span/pre/p with no role) may not take its name from
// aria-label. These are the elements on the page that would still break it.
const unnamedGenerics = page => page.evaluate(() => [...document.querySelectorAll('div[aria-label]:not([role]), span[aria-label]:not([role]), pre[aria-label]:not([role]), p[aria-label]:not([role])')]
  .map(node => (node.getAttribute('class') || node.tagName.toLowerCase()) + ' · ' + node.getAttribute('aria-label')));
async function environment() {
  const f = await channelFixture(undefined, { schedules: { automatic: false, clock: () => Date.now() } });
  f.destination = await registerDestination(f.admin, await privateChat(f));
  await f.service.tick();
  return f;
}

test('#886 计划预览与事件订阅预览都有角色，名字不再挂在 generic 上', async ({ page }) => {
  test.setTimeout(90000);
  const f = await environment(), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(f.h.admin + '/#/projects/101/schedules');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('订阅名称', { exact: true })).toBeEnabled();
    // Each preview answers to its name as a group, so the name is announced and the axe rule is satisfied.
    await expect(page.getByRole('group', { name: '计划预览', exact: true })).toHaveCount(1);
    await expect(page.getByRole('group', { name: '事件订阅时间预览', exact: true })).toHaveCount(1);
    expect(await unnamedGenerics(page)).toEqual([]);
    // The subscription preview keeps naming the times it computes, through the same box.
    await page.getByRole('button', { name: '预览事件订阅时间', exact: true }).click();
    await expect(page.getByRole('group', { name: '事件订阅时间预览', exact: true })).toContainText('假设此刻收到一条事件');
    // No visual change: the same boxes, at each width, without horizontal overflow.
    mkdirSync(out, { recursive: true });
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await page.getByRole('group', { name: '事件订阅时间预览', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/previews-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
});
