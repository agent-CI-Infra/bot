// #743: two polled pages of the project console — the release records and the Actions configuration check — read
// something the signed-in actor may lose access to. An answer of 401/403/404 cannot become readable by asking again, so
// each poll stops and says so once; only a failure that may clear on its own keeps polling. The conversations page is
// not part of this: its terminal branch already replaces the layout, which detaches the thread the poll checks.
import { test, expect } from '@playwright/test';
import { releaseFixture } from '../../fixtures/release-fixtures.mjs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';

// A timer that was already scheduled when the terminal answer arrived still fires once; let it pass before counting.
const settle = page => page.clock.runFor(6000);

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
  await page.clock.install();
  try {
    await loginAs(page, f.h.admin, f.password);
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', level: 1, exact: true })).toBeVisible();
    await page.route('**/api/repositories/101/releases', route => route.fulfill({ status: 404, json: { error: 'not_found' } }));
    await page.getByRole('button', { name: '刷新发布记录', exact: true }).click();
    await expect(page.getByText(/发布记录已不可读取/)).toBeVisible();
    // Wait for the already-scheduled poll to fire and receive its terminal 404 before counting subsequent ticks.
    const trailing = page.waitForResponse(r => new URL(r.url()).pathname === '/api/repositories/101/releases');
    await settle(page);
    await trailing;
    const reads = countReads(page, /^\/api\/repositories\/101\/releases$/);
    await page.clock.runFor(6500);
    await page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
    expect(reads.n, 'a 404 on the release records must not be retried by the poll').toBe(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});

test('#743 发布页：5xx 仍会继续轮询', async ({ page }) => {
  const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
  await page.clock.install();
  try {
    await loginAs(page, f.h.admin, f.password);
    await page.goto(f.h.admin + '/#/projects/101/release');
    await expect(page.getByRole('heading', { name: '发版本', level: 1, exact: true })).toBeVisible();
    await page.route('**/api/repositories/101/releases', route => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await page.getByRole('button', { name: '刷新发布记录', exact: true }).click();
    await expect(page.getByText(/发布记录读取失败/)).toBeVisible();
    const reads = countReads(page, /^\/api\/repositories\/101\/releases$/);
    const retried = page.waitForResponse(r => new URL(r.url()).pathname === '/api/repositories/101/releases');
    await page.clock.runFor(6500);
    await retried;
    expect(reads.n, 'a 503 may clear on its own, so the poll keeps going').toBeGreaterThan(0);
  } finally { for (const close of cleanup.reverse()) await close(); }
});

test('#743 监听与触发页：403 之后停止 Actions 配置检查并写终态文案', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  await page.clock.install();
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
    await page.clock.runFor(5500);
    await expect(status).toContainText('配置检查已停止', { timeout: 12000 });
    await settle(page);
    const reads = countReads(page, /^\/api\/repositories\/101$/);
    await page.clock.runFor(6500);
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
  await page.clock.install();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const status = await triggersPageWithActionsCheck(page, h, password);
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await page.clock.runFor(5500);
    await expect(status).toContainText('读取失败，显示上次结果', { timeout: 12000 });
    // The last readable answer stays readable on the line under the result: only its freshness is in doubt.
    await expect(page.locator('[data-actions-policy]')).toContainText('配置检查通过后');
    await expect(status).toContainText(/上次成功读取：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  } finally { await h.stop(); }
});

test('#878 监听与触发页：下一次成功读取后清除过期标注', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  await page.clock.install();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const status = await triggersPageWithActionsCheck(page, h, password);
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await page.clock.runFor(5500);
    await expect(status).toContainText('读取失败，显示上次结果', { timeout: 12000 });
    await page.unroute('**/api/repositories/101');
    await page.clock.runFor(10500);
    await expect(status).not.toContainText('读取失败', { timeout: 20000 });
    await expect(status).toContainText('配置检查通过后');
  } finally { await h.stop(); }
});

// #1078: the Actions check row changes on its own — a failed refresh, a stopped check, a recovery — and every change
// replaces its text in place, so the node has to stay a polite live region. A row turned into an alert after one error
// would make every later ordinary update interrupt the reader (#874), so the role is pinned after the failure too. The
// 401 below keeps the console's own session state out of the way (`invalid_login` is the code api.js does not read as an
// expired session); the row's terminal branch is what this test is about.
// The success branch of the poll is the other half: it repeats the same sentence every five seconds, and a live region
// announces any child-node change, so rewriting that sentence unchanged would interrupt the reader on every poll.
test('#1078 监听与触发页：状态行常驻 polite live region，失败与终止之后仍是 status', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  await page.clock.install();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await loginAs(page, h.admin + '/#/projects/101/triggers', password);
    const status = page.locator('[data-actions-status]');
    // Each attribute is asserted on its own and named in the message, so a failure says which one is missing instead of
    // handing back one joined string for all three.
    const expectSemantics = async where => {
      for (const [name, value] of [['role', 'status'], ['aria-live', 'polite'], ['aria-atomic', 'true']])
        await expect(status, `${where} (${name})`).toHaveAttribute(name, value);
    };
    // The row is rendered before the switch is turned on, so its semantics are there from the first paint.
    await expect(status).toContainText('未开启。');
    await expectSemantics('the status row is a polite live region from its first render');
    await page.getByLabel('接收默认分支和版本标签的 Actions 失败事件', { exact: true }).check();
    await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    await expect(status).toContainText('配置检查通过后', { timeout: 10000 });
    await expectSemantics('a successful read keeps the role');
    // The successful poll answers the same sentence every five seconds. Watch the row across one full interval: the
    // request count proves a poll happened in that window, and the mutation count has to stay at zero because an
    // unchanged sentence is not news for the reader.
    await page.evaluate(() => {
      const row = document.querySelector('[data-actions-status]');
      window.__rowChanges = 0;
      new MutationObserver(records => { window.__rowChanges += records.length; })
        .observe(row, { childList: true, characterData: true, subtree: true });
    });
    const poll = url => url.pathname === '/api/repositories/101';
    let polls = 0;
    await page.route(poll, route => { polls++; return route.continue(); });
    const polled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/repositories/101');
    await page.clock.runFor(7000);
    await polled;
    await page.unroute(poll);
    expect(polls, 'the row was polled while it was watched').toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__rowChanges), 'an unchanged answer must not rewrite a live region: a reader announces every child-node change again').toBe(0);
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await page.clock.runFor(5500);
    await expect(status).toContainText('读取失败，显示上次结果', { timeout: 12000 });
    await expectSemantics('a failed refresh keeps the role instead of turning the row into an alert');
    await page.unroute('**/api/repositories/101');
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 401, json: { error: 'invalid_login' } }));
    await page.clock.runFor(10500);
    await expect(status).toContainText('配置检查已停止', { timeout: 20000 });
    await expectSemantics('a stopped check keeps the role too');
  } finally { await h.stop(); }
});

// #1079: the row used to carry two different kinds of sentence as one — what the check does ("配置检查通过后随 Webhook 处理…")
// and what this read found ("读取失败，…"). A reader takes the description of the check for the answer it just gave, the
// ASCII space after the Chinese full stop strands at a line edge, and "可能已过期" is sewn into a parenthesis. The policy
// sentence moves to its own muted note beside the row, the row keeps only this read's result, and the space is gone.
test('#1079 监听与触发页：策略句搬到同级的 note，状态行只讲本次结果', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  await page.clock.install();
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    await loginAs(page, h.admin + '/#/projects/101/triggers', password);
    const status = page.locator('[data-actions-status]'), policy = page.locator('[data-actions-policy]');
    await page.getByLabel('接收默认分支和版本标签的 Actions 失败事件', { exact: true }).check();
    await page.getByRole('button', { name: '保存事件开关', exact: true }).click();
    // Nothing has failed yet, so the policy sentence is the only thing to say and it stays in the row, word for word.
    await expect(status).toContainText('配置检查通过后随 Webhook 处理', { timeout: 10000 });
    await expect(policy).toBeHidden();
    await page.route('**/api/repositories/101', route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
    await page.clock.runFor(5500);
    await expect(status).toContainText('读取失败，显示上次结果', { timeout: 12000 });
    // Two sentences on two lines, each readable on its own: the row is this read's result only, and the policy sentence
    // is still on the page in the note under it. Both are asserted as visible, so a note that is merely in the DOM —
    // folded into a closed details, or removed from the layout — cannot pass this.
    await expect(status).toBeVisible();
    await expect(status).not.toContainText('配置检查通过后');
    await expect(status).not.toContainText('每 10 分钟补扫');
    await expect(status).toContainText(/上次成功读取：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    await expect(policy).toBeVisible();
    await expect(policy).toHaveText('配置检查通过后随 Webhook 处理，并每 10 分钟补扫一次，发现符合条件的失败运行后交给 Manager。');
    // The note is a sibling of the row, never inside it: the row is a live region and would announce the policy as news.
    expect(await page.evaluate(() => !document.querySelector('[data-actions-status]').contains(document.querySelector('[data-actions-policy]'))), 'the policy note must not sit inside the live region').toBe(true);
    const [row, note] = [await status.boundingBox(), await policy.boundingBox()];
    expect(note.y, 'the note is its own line below the result, not the same line').toBeGreaterThanOrEqual(row.y + row.height - 1);
    // A Chinese full stop no longer runs into "读取失败" through an ASCII space, in the row or across the two lines.
    expect(await status.textContent()).not.toMatch(/。\s+读取失败/);
    expect(await page.evaluate(() => document.querySelector('[data-overview-anchor="project-events"]').innerText)).not.toMatch(/。\s+读取失败/);
    // The narrowest layout must not gain a horizontal scrollbar from the split.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(policy).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the result row and the policy note must not overflow at 390').toBe(true);
  } finally { await h.stop(); }
});
