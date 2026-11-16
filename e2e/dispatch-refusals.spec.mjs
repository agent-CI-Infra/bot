import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// #815: the Manager's dispatch records show what the control plane refused and why, and the events its filters stopped.
const shots = process.env.BOT_E2E_SCREENSHOTS;

test('dispatch records show refusals with their reasons and filtered events with why nothing happened', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const add = (id, values) => h.store.run(`INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,decision,reason,result,refusals,model,attempts,created_at,decided_at)
      VALUES(?,'101',?,?,'github','issue',5,?,'{}','[]',?,?,?,?,?,?,1,?,?)`, id, id, values.type, values.summary, values.state, values.decision, values.reason, values.result, values.refusals ?? null,
      values.model ?? null, values.at, values.at);
    add('refused', { type: 'issue.labeled', summary: '开发标签：Parser drops the last line #5', state: 'decided', decision: 'ignore', reason: '这个 Issue 已在开发中，已在 Issue 上回复', model: 'Recorded fixture model',
      result: JSON.stringify({ created: [], continued: [], declined: [] }), at: '2026-11-16T10:00:00.000Z',
      refusals: JSON.stringify([{ work: 'development.issue', code: 'development_active', reason: '这个 Issue 已有未结束的开发任务（running）。', task_id: 'dev-running', tool: 'create_task', at: '2026-11-16T10:00:01.000Z' }]) });
    add('filtered', { type: 'issue.updated', summary: 'Parser drops the last line #5（mallory）', state: 'filtered', decision: 'ignore', reason: '评论人在仓库里没有角色，也不是作者；外人的评论只有提到 bot 时才交给 Manager。',
      result: JSON.stringify({ filtered: 'outsider_comment' }), at: '2026-11-16T10:05:00.000Z' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/roles/manager');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    const reader = page.getByRole('region', { name: 'Manager 分派记录', exact: true });
    await expect(reader.locator('[data-dispatch-event]')).toHaveCount(2);
    const refused = reader.locator('[data-dispatch-event="refused"]'), filtered = reader.locator('[data-dispatch-event="filtered"]');
    await expect(refused).toContainText('控制面拒绝 1 次：这个 Issue 已有未结束的开发任务（running）。');
    await expect(filtered).toContainText('被过滤'); await expect(filtered).toContainText('外人的评论');
    // The state filter finds what the filters stopped.
    await reader.getByRole('combobox', { name: '分派状态', exact: true }).selectOption('filtered');
    await reader.getByRole('button', { name: '应用分派筛选', exact: true }).click();
    await expect(reader.locator('[data-dispatch-event]')).toHaveCount(1); await expect(reader.locator('[data-dispatch-event="filtered"]')).toBeVisible();
    const detail = page.getByRole('dialog', { name: '分派详情', exact: true });
    await reader.locator('[data-dispatch-event="filtered"]').getByRole('button', { name: '查看分派详情', exact: true }).click();
    await expect(detail).toContainText('控制面过滤（没有交给 Manager）'); await expect(detail).toContainText('外人的评论');
    // Nothing was decided for it: the detail shows the reason code and when it was recorded, not a decision time or attempts.
    await expect(detail).toContainText('outsider_comment'); await expect(detail).toContainText('记录时间');
    await expect(detail).not.toContainText('决定时间'); await expect(detail).not.toContainText('当前轮尝试次数');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (shots) await page.screenshot({ path: `${shots}/dispatch-filtered-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press('Escape');
    await reader.getByRole('combobox', { name: '分派状态', exact: true }).selectOption('');
    await reader.getByRole('button', { name: '应用分派筛选', exact: true }).click();
    await expect(reader.locator('[data-dispatch-event]')).toHaveCount(2);
    await refused.getByRole('button', { name: '查看分派详情', exact: true }).click();
    await expect(detail).toContainText('控制面拒绝'); await expect(detail).toContainText('development.issue · development_active：这个 Issue 已有未结束的开发任务（running）。');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/dispatch-refusal-${width}.png` }); }
    }
    await page.keyboard.press('Escape');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await reader.scrollIntoViewIfNeeded();
      if (shots) await page.screenshot({ path: `${shots}/dispatch-list-${width}.png` });
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
