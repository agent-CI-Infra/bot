import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #527 slice: the project-list column labels come from the dictionary, so an English console names its columns in
// English. The list prints those labels two different ways: at 1440 it draws the real header; below 1280 the header is
// display:none and each cell prints its own label through ::before. Both paths are asserted at their own viewport,
// because a reading taken at the default 1280x720 width says nothing about 390. 项目 and 任务 own the whole card row
// below 1280 and print no caption.
const keys = ['project', 'enabled', 'review', 'development', 'access', 'gates', 'board', 'tasks', 'actions'];
const chinese = ['项目', '启用', '检视', '开发', '权限', '门禁', '看板', '任务', '操作'];
const english = ['Project', 'Enabled', 'Review', 'Develop', 'Access', 'Gates', 'Board', 'Tasks', 'Actions'];
const captionedChinese = ['启用', '检视', '开发', '权限', '门禁', '看板', '操作'];
const captionedEnglish = ['Enabled', 'Review', 'Develop', 'Access', 'Gates', 'Board', 'Actions'];
const viewports = [[1440, 900], [768, 1024], [390, 844]];
const han = /[\u4e00-\u9fff]/;

const cellCaptions = row => row.locator(':scope > .project-cell').evaluateAll(nodes => nodes.map(cell => {
  const content = getComputedStyle(cell, '::before').content;
  return content === 'none' ? '' : content.replace(/^"|"$/g, '');
}));

async function openProjects(page, h) {
  const { admin, password } = await setup(h), a = await account(admin);
  for (const [id, owner, name] of [['101', '20', 'alpha/one'], ['202', '10', 'beta/two']]) {
    await repository(admin, a.id, id);
    h.store.run('UPDATE repositories SET full_name=?,owner_id=? WHERE id=?', name, owner, id);
    h.store.run('UPDATE installed_repositories SET full_name=?,owner_id=?,owner_login=?,permissions_at=? WHERE repository_id=?', name, owner, 'org-' + owner, new Date().toISOString(), id);
    h.store.run('INSERT INTO public_board_settings(repository_id,enabled) VALUES(?,0) ON CONFLICT(repository_id) DO UPDATE SET enabled=0', id);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(h.admin + '/#/projects');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}

test('English 界面：三个视口都显示英文列头，不横向溢出，aria 指向英文表头', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openProjects(page, h);
    const head = page.locator('#rows .project-table-head'), row = page.locator('#rows .project-list-row[data-key="101"]');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#rows .project-list-row')).toHaveCount(2);

    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      // Longer words must not push the page sideways in any of the three layouts the list has.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`).toBe(true);
      expect(await row.evaluate(line => [...line.querySelectorAll(':scope > .project-cell')].every(cell => cell.getBoundingClientRect().right <= window.innerWidth + 1)), `a cell leaves the viewport at ${width}px`).toBe(true);
      if (width >= 1280) {
        await expect(head).toBeVisible();
        await expect(head.locator('.project-cell')).toHaveText(english);
        // Every cell still names its column through the one header, and that header is the English one.
        const ids = await row.locator(':scope > .project-cell').evaluateAll(cells => cells.map(cell => cell.getAttribute('aria-labelledby')));
        expect(ids).toEqual(keys.map(key => 'project-col-' + key));
        const named = await row.locator(':scope > .project-cell').evaluateAll(cells => cells.map(cell => document.getElementById(cell.getAttribute('aria-labelledby'))?.textContent ?? ''));
        expect(named).toEqual(english);
      } else {
        await expect(head).toBeHidden();
        const printed = (await cellCaptions(row)).filter(Boolean);
        expect(printed, `captions at ${width}px`).toEqual(captionedEnglish);
        expect(printed.join(' ')).not.toMatch(han);
        // The caption sits in a fixed 58px label column: the longer English words must stay inside it.
        expect(await row.evaluate(line => [...line.querySelectorAll(':scope > .project-cell')].every(cell => cell.scrollWidth <= cell.clientWidth + 1)), `a caption overflows its cell at ${width}px`).toBe(true);
      }
    }

    // The same words where the list speaks through title/aria only: the review switch names its column in English.
    await page.setViewportSize({ width: 1440, height: 900 });
    const review = row.locator(':scope > .project-cell').nth(2).locator('.status').first();
    expect(await review.getAttribute('title')).toBe('Review: off');
    expect(await review.getAttribute('aria-label')).toBe('alpha/one Review: off');
    expect((await page.locator('#rows').innerText()) + (await review.getAttribute('aria-label'))).not.toContain('projects.columns.');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('zh-CN 界面：九个列头与稳定单元格 token 不变，切换回来不露原始 key', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openProjects(page, h);
    const head = page.locator('#rows .project-table-head'), row = page.locator('#rows .project-list-row[data-key="101"]');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(head.locator('.project-cell')).toHaveText(chinese);
    // The cell token is the stable key the layout and the other pages address the column by; it stays a slug.
    expect(await row.locator(':scope > .project-cell').evaluateAll(cells => cells.map(cell => cell.dataset.label))).toEqual(keys);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await cellCaptions(row)).toEqual(['', ...captionedChinese, '']);
    expect(await page.locator('#rows').innerText()).not.toContain('projects.columns.');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(head.locator('.project-cell')).toHaveText(english);
    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(head.locator('.project-cell')).toHaveText(chinese);
    expect(await page.locator('#rows').innerText()).not.toContain('projects.columns.');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
