import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';
import { channelFixture, privateChat, registerDestination } from '../../fixtures/channel-fixture.mjs';
import { defaultLimits } from '../../../dist/schedules/types.js';

// #691: a browser set to English used to render every clock through the browser's own locale
// ("11/18/2026, 9:03:00 AM"), while other pages used the shared "2026-11-18 09:03:00" clock. The fix is one shared
// reading per page, so this suite runs the console with locale en-US — the wording that used to drift — and requires
// the shared pattern on the three pages the issue names.
test.use({ locale: 'en-US' });

const CLOCK = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}';
const twelveHour = /\b(?:AM|PM)\b/;

async function knowledge(page) {
  const cleanup = [], f = await managerFixture({ after: fn => cleanup.push(fn) });
  const h = await harness(undefined, f.manager), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  return { h, admin, errors, async login() {
    await page.goto(h.admin + '/#/projects/101/notes');
    await page.getByLabel(/用户名|Username/).fill('administrator');
    await page.getByLabel(/密码|Password/).fill(password);
    await page.getByRole('button', { name: /^(登录|Sign in)$/ }).click();
    await expect(page.locator('.knowledge-workspace')).toBeVisible();
  }, async close() { await h.stop(); await rm(h.directory, { recursive: true, force: true }); for (const fn of cleanup.reverse()) await fn(); } };
}

async function channel() {
  const f = await channelFixture(undefined, { schedules: { automatic: false } });
  const chat = await privateChat(f);
  f.destination = await registerDestination(f.admin, chat);
  await f.service.tick();
  f.query = async (op, args = {}) => (await f.admin('/api/management/query', 'POST', { operation: op, target: { project_id: '101' }, arguments: args })).value;
  f.command = async (op, args) => {
    const { revision } = await f.query('list_subscriptions'), key = crypto.randomUUID();
    const r = await f.admin('/api/management/commands', 'POST', { operation: op, target: { project_id: '101' }, arguments: args, expected_revision: revision, idempotency_key: key, source_conversation: 'time-format-fixture', source_message: key });
    expect(r.value.state).toBe('succeeded'); return r.value.result;
  };
  return f;
}

async function login(page, f, hash) {
  await page.goto(f.h.admin + '/#' + hash);
  await page.getByLabel(/用户名|Username/).fill('administrator');
  await page.getByLabel(/密码|Password/).fill(f.password);
  await page.getByRole('button', { name: /^(登录|Sign in)$/ }).click();
}

test('a file preview in the knowledge page reads its time with the shared clock, not the browser language', async ({ page }) => {
  const f = await knowledge(page);
  try {
    await f.admin('/api/repositories/101/notes/clock.txt', 'PUT', { content: 'clock\n' });
    await f.login();
    await page.getByRole('button', { name: '文件 clock.txt', exact: true }).click();
    const row = page.locator('.knowledge-main').getByText(/^v1 · /);
    await expect(row).toBeVisible();
    await expect(row).toContainText(new RegExp('^v1 · ' + CLOCK + ' · '));
    await expect(row).not.toHaveText(twelveHour);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('the project schedule list shows its next run in the shared clock with its zone suffix', async ({ page }) => {
  const f = await channel();
  try {
    const plan = { name: '夜间检查', kind: 'personal', actor_id: f.principal, owner_id: f.principal, maintainer_id: f.principal,
      workflow: 'manager.check', parameters: { instruction: '' }, timezone: 'Asia/Shanghai', cron: '0 9 * * *',
      start_at: Date.now(), enabled: true, misfire: 'skip', grace_ms: 60000, limits: { ...defaultLimits } };
    await f.command('schedule.register', { plan });
    await login(page, f, '/projects/101/schedules');
    const list = page.getByRole('region', { name: '项目定时任务列表', exact: true });
    await expect(list).toBeVisible();
    await expect(list).toContainText(new RegExp(CLOCK + ' · Asia/Shanghai'));
    await expect(list).not.toContainText(twelveHour);
  } finally { await f.close(); }
});

test('the subscription list and its time preview read with the shared clock', async ({ page }) => {
  const f = await channel();
  try {
    await f.command('notification.register', { subscription: { name: '时间格式订阅', destination_id: f.destination, events: ['task.failed'], projects: ['101'], aggregate_ms: 300000, timezone: 'Asia/Shanghai', enabled: true } });
    await login(page, f, '/projects/101/schedules');
    const editor = page.getByRole('region', { name: '事件订阅管理', exact: true });
    await expect(editor).toContainText(new RegExp('已读取 1 条事件订阅 · ' + CLOCK));
    await page.getByRole('button', { name: '预览事件订阅时间', exact: true }).click();
    const preview = page.getByLabel('事件订阅时间预览', { exact: true });
    await expect(preview).toContainText(new RegExp(CLOCK + ' · Asia/Shanghai'));
    await expect(editor).not.toContainText(twelveHour);
  } finally { await f.close(); }
});
