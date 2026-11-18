// #743: two polled pages of the project console — the release records and the Actions configuration check — read
// something the signed-in actor may lose access to. An answer of 401/403/404 cannot become readable by asking again, so
// each poll stops and says so once; only a failure that may clear on its own keeps polling. The conversations page is
// not part of this: its terminal branch already replaces the layout, which detaches the thread the poll checks.
import { test, expect } from '@playwright/test';
import { releaseFixture } from '../../fixtures/release-fixtures.mjs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';

// A timer that was already scheduled when the terminal answer arrived still fires once; let it pass before counting.
const settle = page => page.waitForTimeout(6000);

async function loginAs(page, address, password, username = 'administrator') {
  await page.goto(address);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

function countReads(page, pattern) {
  const seen = { n: 0 };
  page.on('request', request => { if (pattern.test(new URL(request.url()).pathname)) seen.n++; });
  return seen;
}

test('#743 发布页：404 之后停止读取发布记录并写终态文案', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  try {
    await loginAs(page, f.h.admin, f.password);
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', level: 1, exact: true })).toBeVisible();
    await page.route('**/api/repositories/101/releases', route => route.fulfill({ status: 404, json: { error: 'not_found' } }));
    await page.getByRole('button', { name: '刷新发布记录', exact: true }).click();
    await expect(page.getByText(/发布记录已不可读取/)).toBeVisible();
    await settle(page);
    const reads = countReads(page, /^\/api\/repositories\/101\/releases$/);
    await page.waitForTimeout(6500);
    expect(reads.n, 'a 404 on the release records must not be retried by the poll').toBe(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});

test('#743 发布页：5xx 仍会继续轮询', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  try {
    await loginAs(page, f.h.admin, f.password);
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', level: 1, exact: true })).toBeVisible();
    await page.route('**/api/repositories/101/releases', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await page.getByRole('button', { name: '刷新发布记录', exact: true }).click();
    await expect(page.getByText(/发布记录读取失败/)).toBeVisible();
    const reads = countReads(page, /^\/api\/repositories\/101\/releases$/);
    await page.waitForTimeout(6500);
    expect(reads.n, 'a 503 may clear on its own, so the poll keeps going').toBeGreaterThan(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});

test('#743 监听与触发页：403 之后停止 Actions 配置检查并写终态文案', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await loginAs(page, h.admin + '/#/projects/101/triggers', password);
    // Enable the event source through its own switch, the way the page turns the check on.
    await page.getByLabel('接收默认分支和版本标签的 Actions 失败事件', { exact: true }).check();
    await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    const status = page.locator('[data-actions-status]');
    await expect(status).toContainText('配置检查通过后', { timeout: 10000 });
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 403, json: { error: 'repository_forbidden' } }));
    await expect(status).toContainText('配置检查已停止', { timeout: 12000 });
    await settle(page);
    const reads = countReads(page, /^\/api\/repositories\/101$/);
    await page.waitForTimeout(6500);
    expect(reads.n, 'a 403 on the repository read must stop the configuration check').toBe(0);
  } finally { await h.stop(); }
});

// #878: a 500 or a network error may clear on its own, so the scan keeps polling — but the status it could not refresh
// must not keep reading as current. It says it is stale and names the last successful read; a later success drops that.
async function triggersPageWithActionsCheck(page, h, password) {
  await loginAs(page, h.admin + '/#/projects/101/triggers', password);
  // Enable the event source through its own switch, the way the page turns the check on.
  await page.getByLabel('接收默认分支和版本标签的 Actions 失败事件', { exact: true }).check();
  await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
  const status = page.locator('[data-actions-status]');
  await expect(status).toContainText('配置检查通过后', { timeout: 10000 });
  return status;
}

test('#878 监听与触发页：可恢复的读取失败标注「读取失败，显示上次结果」和上次成功时间', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const status = await triggersPageWithActionsCheck(page, h, password);
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await expect(status).toContainText('读取失败，显示上次结果', { timeout: 12000 });
    // The last readable answer stays readable: only its freshness is in doubt.
    await expect(status).toContainText('配置检查通过后');
    await expect(status).toContainText(/上次成功读取：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  } finally { await h.stop(); }
});

test('#878 监听与触发页：下一次成功读取后清除过期标注', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const status = await triggersPageWithActionsCheck(page, h, password);
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await expect(status).toContainText('读取失败，显示上次结果', { timeout: 12000 });
    await page.unroute('**/api/repositories/101');
    await expect(status).not.toContainText('读取失败', { timeout: 20000 });
    await expect(status).toContainText('配置检查通过后');
  } finally { await h.stop(); }
});

// #1078: the Actions check row changes on its own — a failed refresh, a stopped check, a recovery — and every change
// replaces its text in place, so the node has to stay a polite live region. A row turned into an alert after one error
// would make every later ordinary update interrupt the reader (#874), so the role is pinned after the failure too. The
// 401 below keeps the console's own session state out of the way (`invalid_login` is the code api.js does not read as an
// expired session); the row's terminal branch is what this test is about.
test('#1078 监听与触发页：状态行常驻 polite live region，失败与终止之后仍是 status', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await loginAs(page, h.admin + '/#/projects/101/triggers', password);
    const status = page.locator('[data-actions-status]');
    const semantics = () => status.evaluate(node => [node.getAttribute('role'), node.getAttribute('aria-live'), node.getAttribute('aria-atomic')].join('/'));
    // The row is rendered before the switch is turned on, so its semantics are there from the first paint.
    await expect(status).toContainText('未开启。');
    expect(await semantics(), 'the status row is a polite live region from its first render').toBe('status/polite/true');
    await page.getByLabel('接收默认分支和版本标签的 Actions 失败事件', { exact: true }).check();
    await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    await expect(status).toContainText('配置检查通过后', { timeout: 10000 });
    expect(await semantics(), 'a successful read keeps the role').toBe('status/polite/true');
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await expect(status).toContainText('读取失败，显示上次结果', { timeout: 12000 });
    expect(await semantics(), 'a failed refresh keeps the role instead of turning the row into an alert').toBe('status/polite/true');
    await page.unroute('**/api/repositories/101');
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 401, json: { error: 'invalid_login' } }));
    await expect(status).toContainText('配置检查已停止', { timeout: 20000 });
    expect(await semantics(), 'a stopped check keeps the role too').toBe('status/polite/true');
  } finally { await h.stop(); }
});
