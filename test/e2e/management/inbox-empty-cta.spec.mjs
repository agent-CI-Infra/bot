import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

async function login(page, url, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('待处理为空时给出项目列表/项目总览和新建任务的下一步（#690、#1222）', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await login(page, h.admin + '/#/inbox', password);
    const empty = page.locator('.console-inbox [data-testid=console-state-empty]');
    await expect(empty.getByRole('heading', { name: '当前范围没有待处理任务', exact: true })).toBeVisible();
    const next = page.locator('.console-inbox-next');
    await expect(next.getByRole('link', { name: '查看项目列表', exact: true })).toHaveAttribute('href', '#/projects');
    await expect(next.getByRole('link', { name: '新建任务', exact: true })).toHaveAttribute('href', '#/new-task');
    for (const [width, height, name] of [[390, 844, 'empty-390'], [1440, 900, 'empty-1440']]) {
      await page.setViewportSize({ width, height });
      // Hit-test each link centre on the first screen: toBeInViewport() alone misses a link covered by the fixed mobile bottom bar.
      const layout = await page.evaluate(() => {
        const card = document.querySelector('.console-inbox [data-testid=console-state-empty]').getBoundingClientRect();
        const links = [...document.querySelectorAll('.console-inbox-next a')].map(a => {
          const box = a.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { text: hit?.closest('a')?.textContent.trim(), top: box.top, left: box.left, right: box.right };
        });
        return { links, cardCentre: card.left + card.width / 2 };
      });
      expect(layout.links.map(link => link.text)).toEqual(['查看项目列表', '新建任务']);
      // One centred row, lined up under the centred empty-state heading.
      expect(Math.abs(layout.links[0].top - layout.links[1].top)).toBeLessThan(1);
      const rowCentre = (layout.links[0].left + layout.links[1].right) / 2;
      expect(Math.abs(rowCentre - layout.cardCentre)).toBeLessThan(2);
    }
    // Shorter 390 screens (390x667) put the row behind the bottom bar on the first screen; the page still scrolls far enough
    // that each link clears the bar and takes the click, so it is never a dead end.
    await page.setViewportSize({ width: 390, height: 667 });
    for (const name of ['查看项目列表', '新建任务']) {
      const hit = await next.getByRole('link', { name, exact: true }).evaluate(a => {
        a.scrollIntoView({ block: 'center' });
        const box = a.getBoundingClientRect(), bar = document.querySelector('#console-mobile-nav').getBoundingClientRect().top;
        return { text: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('a')?.textContent.trim(), aboveBar: box.bottom <= bar + 1 };
      });
      expect(hit).toEqual({ text: name, aboveBar: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await switchConsoleProject(page, '101');
    await expect(page).toHaveURL(/#\/projects\/101\/inbox$/);
    await expect(empty.getByRole('heading', { name: '当前范围没有待处理任务', exact: true })).toBeVisible();
    await expect(page.locator('.console-inbox-next').getByRole('link', { name: '查看项目总览', exact: true })).toHaveAttribute('href', '#/projects/101/overview/tasks');
    const newTask = page.locator('.console-inbox-next').getByRole('link', { name: '新建任务', exact: true });
    await expect(newTask).toHaveAttribute('href', '#/projects/101/new-task');
    await newTask.click();
    await expect(page).toHaveURL(/#\/projects\/101\/new-task$/);
    await expect(page.locator('#console-page h1')).toHaveText('新建任务');
    await expect(page.getByRole('button', { name: '提交任务', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('待处理有事项时不出现空状态下一步（#690）', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const time = new Date().toISOString();
    h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,priority,created_at,updated_at)
      VALUES('fail-0','101','review.issue','failed','任务失败',1,'P0',?,?)`, time, time);
    await login(page, h.admin + '/#/inbox', password);
    await expect(page.locator('.console-inbox [data-task-id="fail-0"]')).toBeVisible();
    await expect(page.locator('.console-inbox-next')).toHaveCount(0);
    await expect(page.locator('.console-inbox [data-testid=console-state-empty]')).toHaveCount(0);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
