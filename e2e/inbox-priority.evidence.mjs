import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// Captures the real 待我处理 page for docs/verification/226. Run it twice: EVIDENCE_DIR=before on the base tree and
// EVIDENCE_DIR=after on the branch tip; the same fixture and viewport list keeps the pair comparable.
const out = process.env.EVIDENCE_DIR === 'before' ? 'docs/verification/226/before' : 'docs/verification/226/after';

test('evidence: 待我处理 with priority and waiting time', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const ago = ms => new Date(Date.now() - ms).toISOString();
    const seed = (id, status, priority, time, summary) => h.store.run(`INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,priority,created_at,updated_at)
      VALUES(?,?,'review.issue',?,'fixture',?,?,?,?)`, id, '101', status, Number(id.replace(/\D/g, '')) || 1, priority, time, time);
    seed('fail-0', 'failed', 'P0', ago(3 * 24 * 3600e3), '检查失败的原因并补上证据');
    seed('perm-1', 'waiting_permission', 'P1', ago(5 * 3600e3), '等待项目权限后继续');
    seed('conf-2', 'waiting_configuration', 'P2', ago(30 * 60e3), '补齐任务所需的模型配置');
    seed('queue-3', 'queued', 'P0', ago(4 * 24 * 3600e3), '排队的任务不计入待处理');
    await page.goto(h.admin + '/#/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.console-inbox [data-task-id]')).toHaveCount(3);
    mkdirSync(out, { recursive: true });
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/inbox-${width}.png`, fullPage: true });
    }
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
