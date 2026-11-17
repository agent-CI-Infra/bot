import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';

// Repeated dispatch failures remain recoverable; stopped development remains a separate event.
const shots = process.env.BOT_E2E_SCREENSHOTS;

test('dispatch records show retained retry evidence without a terminal attempt cap and a stopped development', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { password } = await setup(h).then(async value => { const a = await account(value.admin); await repository(value.admin, a.id, '101'); return value; });
    const add = (id, values) => h.store.run(`INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,state,decision,reason,result,error,model,attempts,answer_round,next_run_at,created_at,decided_at)
      VALUES(?,'101',?,?,?,'issue',5,?,'{}','[]',?,?,?,?,?,?,?,?,?,?,?)`, id, id, values.type, values.source, values.summary, values.state, values.decision ?? null, values.reason ?? null, values.result ?? null,
      values.error ?? null, values.model ?? null, values.attempts, values.answer_round ?? 0, values.next_run_at ?? 0, values.at, values.decided_at ?? null);
    add('stopped', { type: 'development.stopped', source: 'control_plane', summary: '开发停下：Issue #5 不再满足开发条件', state: 'decided', decision: 'ignore',
      reason: '已在 Issue 上说明开发因标签被去掉而停下', model: 'Recorded fixture model', result: JSON.stringify({ created: [], continued: [], declined: [] }), attempts: 1,
      at: '2026-11-16T10:00:00.000Z', decided_at: '2026-11-16T10:00:20.000Z' });
    add('answer', { type: 'issue.mention', source: 'github', summary: '提到 bot：Parser drops the last line #5', state: 'pending', attempts: 8, answer_round: 1,
      error: JSON.stringify({ code: 'dispatch_option_not_offered', detail: 'continue:nothing' }), next_run_at: Date.parse('2026-11-16T10:20:00.000Z'), at: '2026-11-16T10:05:00.000Z' });
    for (const attempt of [3,6,8]) h.store.run('INSERT INTO dispatch_failures VALUES(?,?,?,?,?,?)','answer',attempt,'2026-11-16T10:10:00.000Z',JSON.stringify({code:'dispatch_option_not_offered',detail:'continue:nothing'}),Date.parse('2026-11-16T10:20:00.000Z'),attempt%3===0?1:0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/roles/manager');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    const reader = page.getByRole('region', { name: 'Manager 分派记录', exact: true });
    await expect(reader.locator('[data-dispatch-event]')).toHaveCount(2);
    await expect(reader.locator('[data-dispatch-event="stopped"]')).toContainText('开发停下');
    const detail = page.getByRole('dialog', { name: '分派详情', exact: true });
    await reader.locator('[data-dispatch-event="answer"]').getByRole('button', { name: '查看分派详情', exact: true }).click();
    await expect(detail).toContainText('重复失败只触发提醒与退避；尚未决定分派结果。');
    await expect(detail).toContainText('第 8 次 · dispatch_option_not_offered');
    await expect(detail).toContainText('第 6 次 · dispatch_option_not_offered · continue:nothing · 已记录重复失败提醒');
    await expect(detail).not.toContainText('自动尝试已用完');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/dispatch-answer-round-${width}.png` }); }
    }
    await page.keyboard.press('Escape');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await reader.locator('[data-dispatch-event="stopped"]').evaluate(node => node.scrollIntoView({ block: 'center' }));
      if (shots) await page.screenshot({ path: `${shots}/dispatch-stopped-list-${width}.png` });
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
