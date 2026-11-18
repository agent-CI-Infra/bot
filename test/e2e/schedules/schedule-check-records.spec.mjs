import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomId } from '../../../dist/core/security.js';
import { githubWriteStorage } from '../../../dist/github/write.js';
import { configureDispatch, ruleDecider } from '../../../dist/dispatch/worker.js';
import { scheduledCheckDecision } from '../../../dist/dispatch/schedule.js';
import { defaultLimits } from '../../../dist/schedules/types.js';
import { channelFixture, privateChat, registerDestination } from '../../fixtures/channel-fixture.mjs';

const issueUrl = 'https://github.com/agent-test-zone/admin-fixture-101/issues/12';
const out = '.tmp/schedule-check-records-906';

async function environment() {
  let now = Date.now(), worker;
  const f = await channelFixture(undefined, { schedules: { automatic: false, clock: () => now }, onSchedules: s => { worker = s; } });
  now = Date.now(); f.worker = worker; f.advance = ms => { now += ms; };
  f.destination = await registerDestination(f.admin, await privateChat(f));
  await f.service.tick();
  return f;
}

async function command(f, operation, args, key = randomId()) {
  const listed = await f.admin('/api/management/query', 'POST', { operation: 'list_schedules', target: { project_id: '101' }, arguments: {} });
  return f.admin('/api/management/commands', 'POST', {
    operation, target: { project_id: '101' }, arguments: args, expected_revision: listed.value.revision,
    idempotency_key: key, source_conversation: 'schedule-fixture', source_message: key
  });
}

function planOf(f, override) {
  return {
    name: '自定义检查', kind: 'personal', actor_id: f.principal, owner_id: f.principal, maintainer_id: f.principal,
    workflow: 'manager.check', parameters: { instruction: 'Look for stale Issues.', file_issues: true },
    timezone: 'Asia/Shanghai', interval_ms: 60000, start_at: Date.now() + 60000, enabled: true,
    misfire: 'skip', grace_ms: 60000,
    limits: { ...defaultLimits },
    ...override
  };
}

function recordWrite(store, { scope, key, repository_id, state, html_url = null, response = null, error = null, status = null }) {
  const now = new Date().toISOString();
  store.run('INSERT INTO github_writes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    randomId(), scope, key, String(repository_id), '{}', 'POST', '/issues', '', state, status, html_url,
    response ? JSON.stringify(response) : null, error, now, now, '');
}

test('#906 运行记录用白话说明跳过、拒绝写入，并给出 Issue 链接', async ({ page }) => {
  test.setTimeout(90000);
  const f = await environment();
  mkdirSync(out, { recursive: true });
  configureDispatch(context => scheduledCheckDecision(context) ?? ruleDecider(context));
  try {
    await f.admin('/api/repositories/101/policy', 'PATCH', { enabled: true });
    githubWriteStorage(f.h.store);

    const allowed = (await command(f, 'schedule.register', { plan: planOf(f, { name: '允许建单的检查' }) })).value.result.schedule;
    await command(f, 'schedule.run-now', { id: allowed.id, revision: allowed.revision });
    f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());
    const allowedTask = f.h.store.get("SELECT * FROM tasks WHERE unique_key LIKE '101:task.request:%' ORDER BY rowid DESC LIMIT 1");
    recordWrite(f.h.store, {
      scope: 'task:' + allowedTask.id, key: 'follow-up', repository_id: allowedTask.repository_id, state: 'sent', status: 201,
      html_url: issueUrl, response: { number: 12, title: 'Stale labels', html_url: issueUrl }
    });
    f.advance(70000);
    f.worker.produce();

    const denied = (await command(f, 'schedule.register', { plan: planOf(f, { name: '只报告的检查', parameters: { instruction: 'Report only.', file_issues: false } }) })).value.result.schedule;
    await command(f, 'schedule.run-now', { id: denied.id, revision: denied.revision });
    f.worker.produce(); f.worker.dispatch(f.worker.claimOccurrence());

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(f.h.admin + '/#/projects/101/schedules');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText('允许建单的检查', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('最近结果', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('上次检查还在进行，本次已跳过').first()).toBeVisible();
    await expect(page.getByText('此计划未允许创建 Issue，只报告发现').first()).toBeVisible();

    await page.getByRole('button', { name: '查看运行与跳过原因', exact: true }).click();
    const opened = page.locator('.schedule-record', { hasText: '允许建单的检查' }).filter({ hasText: '已交给检查任务' });
    const skipped = page.locator('.schedule-record', { hasText: '上次检查还在进行，本次已跳过' });
    const reported = page.locator('.schedule-record', { hasText: '只报告的检查' }).filter({ hasText: '已交给检查任务' });
    await expect(opened).toBeVisible();
    await opened.locator(':scope > summary').click();
    const issue = opened.getByRole('link', { name: /Issue #12/ });
    await expect(issue).toBeVisible();
    await expect(issue).toHaveAttribute('href', issueUrl);
    await skipped.locator(':scope > summary').click();
    await expect(skipped).toContainText('已跳过');
    await reported.locator(':scope > summary').click();
    await expect(reported).toContainText('此计划未允许创建 Issue，只报告发现');
    await page.screenshot({ path: `${out}/check-records-1440.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(issue).toBeVisible();
    await expect(skipped).toContainText('上次检查还在进行，本次已跳过');
    await expect(reported).toContainText('此计划未允许创建 Issue，只报告发现');
    await page.screenshot({ path: `${out}/check-records-390.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    configureDispatch(ruleDecider);
    await f.close();
  }
});
