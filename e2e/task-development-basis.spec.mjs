import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { recordBasis } from '../dist/dispatch/basis.js';

// #815: a development's task page says why it was allowed to start.
const shots = process.env.BOT_E2E_SCREENSHOTS;

test('a development shows its basis: the maintainer\'s comment, who wrote it and their permission', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const now = new Date().toISOString();
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,unique_key,input,object_number,created_at,updated_at) VALUES('dev-basis','101','development.issue','paused','development.issue #5','101:development.issue:5:update:d','{}',5,?,?)", now, now);
    recordBasis(h.store, 'dev-basis', { kind: 'maintainer_request', comment_id: '77', author: 'maria', permission: 'triage', url: 'https://github.example/fixture/project-101/issues/5#issuecomment-77', excerpt: 'Please implement the CRLF fix now; the last line of a CRLF file is lost.' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('[data-task-id="dev-basis"]').getByRole('button', { name: '查看任务', exact: true }).click();
    await page.locator('details.task-archive-fold > summary').click();
    const card = page.locator('#task-side section').filter({ hasText: '开发依据' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('维护者在评论里要求'); await expect(card).toContainText('maria（triage）'); await expect(card).toContainText('Please implement the CRLF fix now');
    await expect(card.getByRole('link', { name: '打开这条评论', exact: true })).toHaveAttribute('href', /issuecomment-77/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await card.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/task-basis-${width}.png` }); }
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
