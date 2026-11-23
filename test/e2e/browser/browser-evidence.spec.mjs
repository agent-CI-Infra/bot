import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { browserEvidenceDir } from '../../../dist/browser/runtime.js';
import { browserEvidenceRoot } from '../../../dist/browser/evidence.js';

const png = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/browser-site/evidence-card.png'));
const pngSha = createHash('sha256').update(png).digest('hex');

test('任务详情展示浏览器截图证据，窄屏不横向溢出', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const h = await harness();
  try {
    const { admin, password } = await setup(h);
    const acct = await account(admin);
    await repository(admin, acct.id, '101');
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input) VALUES('browse-ui','101','task.request','succeeded','巡检夹具',?)",
      JSON.stringify({ request: 'Inspect the fixture', browser: { origins: ['http://127.0.0.1:9'] } }));
    const dir = browserEvidenceDir(browserEvidenceRoot(h.store), 'browse-ui');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'step-1.png'), png);
    writeFileSync(join(dir, 'steps.json'), JSON.stringify({
      task_id: 'browse-ui',
      steps: [{ id: 'step-1', n: 1, at: '2026-11-16T00:00:00.000Z', action: 'screenshot', url: 'http://127.0.0.1:9/', title: '本地巡检页', result: 'ok', screenshot: { file: 'step-1.png', sha256: pngSha, bytes: png.length } }]
    }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await page.goto(h.admin + '/#/projects/101/activity');
    await expect(page.getByRole('heading', { name: '运行状态', level: 1, exact: true })).toBeVisible();
    await page.evaluate(() => openTask('browse-ui'));
    const card = page.locator('section.side-card', { has: page.getByRole('heading', { name: '浏览器证据', exact: true }) });
    await expect(card.getByText('共 1 步，其中 1 张截图可打开查看。')).toBeVisible();
    await expect(card.getByRole('img', { name: 'screenshot 第 1 步截图' })).toBeVisible();
    await expect(card.getByRole('link', { name: '打开截图', exact: true })).toHaveAttribute('href', '/api/tasks/browse-ui/browser-evidence/step-1.png');
    await card.scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole('heading', { name: '浏览器证据', exact: true })).toBeVisible();
    await expect(card.getByRole('img', { name: 'screenshot 第 1 步截图' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
