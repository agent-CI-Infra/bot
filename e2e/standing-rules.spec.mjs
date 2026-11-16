import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #815: 角色 → Manager lists the standing rules in force, saves an edited list, and the dispatch records name the rule.
const shots = process.env.BOT_E2E_SCREENSHOTS;

test('the standing rules card shows the built-in rules, saves an edited list, and a record says which rule decided', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    h.store.run(`INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,decision,reason,result,rule,attempts,created_at,decided_at)
      VALUES('ruled','101','ruled','issue.opened','github','issue',5,'Issue 打开：Parser drops the last line #5','{}','[]','decided','create','常设规则：新 Issue 交给 Issue 检视。','{"created":[],"continued":[],"declined":[]}','{"id":"issue-opened","revision":0}',1,'2026-11-16T10:00:00.000Z','2026-11-16T10:00:00.000Z')`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/roles/manager');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rules = page.locator('[data-overview-anchor="standing-rules"]');
    await expect(rules).toContainText('现在用内置规则');
    await expect(rules.locator('ul.history li')).toHaveCount(5);
    await expect(rules).toContainText('只续接还在进行的任务');
    const reader = page.getByRole('region', { name: 'Manager 分派记录', exact: true });
    await expect(reader.locator('[data-dispatch-event="ruled"]')).toContainText('按常设规则 issue-opened（第 0 版）分派，没有调用模型');
    for (const width of [1440, 390]) {
      // The card just below the role page's sticky save bar, so its heading is not under the bar.
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await rules.evaluate(element => { element.scrollIntoView({ block: 'start' }); const bar = document.querySelector('.console-save-bar');
        window.scrollBy(0, element.getBoundingClientRect().top - (bar ? bar.getBoundingClientRect().bottom : 0) - 8); });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/standing-rules-${width}.png` }); }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // A rule that would start development is refused with the reason, and nothing is saved.
    const editor = page.getByLabel('常设规则（JSON）', { exact: true });
    await editor.fill(JSON.stringify([{ id: 'dev', event: 'issue.opened', action: 'create', work: 'development.issue', reason: '开发' }]));
    await rules.getByRole('button', { name: '保存常设规则', exact: true }).click();
    await expect(rules).toContainText('常设规则不能启动开发');
    // Keeping only the pull request rules saves a new Manager revision.
    await editor.fill(JSON.stringify([{ id: 'pull-request-opened', event: 'pull_request.opened', action: 'create', work: 'review.pr', reason: '常设规则：新 PR 交给 PR 检视。' }]));
    await rules.getByRole('button', { name: '保存常设规则', exact: true }).click();
    await expect(page.getByText('已保存常设规则', { exact: true })).toBeVisible();
    await expect(rules).toContainText('项目规则，随 Manager 配置第');
    await expect(rules.locator('ul.history li')).toHaveCount(1);
    expect((await admin('/api/repositories/101/manager')).value.manager.standing_rules.rules.map(rule => rule.id)).toEqual(['pull-request-opened']);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
