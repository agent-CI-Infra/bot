import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #671 S1: the storage page already loads one /api/storage answer; the two rows this slice adds are drawn from that
// answer alone, so opening the page adds no request and never scans the file system again. The disk alarm is the
// maintainers' own card (#671), not this slice.
test('#671 S1: 存储页用同一个 /api/storage 答案画出可回收与其它，不新增请求、不重新扫盘', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const facts = async () => page.locator('dl.facts').first().evaluate(list => {
    const nodes = [...list.children], out = {};
    nodes.forEach((node, index) => { if (node.tagName === 'DT') out[node.textContent.trim()] = nodes[index + 1]?.textContent.trim() ?? ''; });
    return out;
  });
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const requests = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/storage') requests.push(request.method()); });
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();

    await page.goto(h.admin + '/#/settings/storage');
    const panel = page.locator('#settings-panel');
    await expect(panel).toContainText('可回收（两个库的空闲页，做 VACUUM 能释放）');
    await expect(panel).toContainText('其它（未列明细的其它）');
    // One request for the whole page: the split is drawn beside the database and disk numbers it comes from.
    expect(requests).toEqual(['GET']);
    const pairs = await facts();
    expect(Object.keys(pairs)).toEqual(expect.arrayContaining(['控制面数据库 control.sqlite', 'manager 账本 manager.sqlite',
      '控制面所在磁盘剩余', 'manager 所在磁盘剩余', 'manager 重复正文清理', '可回收（两个库的空闲页，做 VACUUM 能释放）', '其它（未列明细的其它）']));
    // Both values are byte figures from the same answer, never a placeholder.
    expect(pairs['可回收（两个库的空闲页，做 VACUUM 能释放）']).toMatch(/^(—|[\d.]+ (KB|MB|GB))$/);
    expect(pairs['其它（未列明细的其它）']).toMatch(/^(读不到|—|[\d.]+ (KB|MB|GB))$/);
    const refreshed = () => panel.locator('p.muted').first().innerText();
    const first = await refreshed();
    // Coming back reads the same snapshot: the page does not scan the disk or the files to open itself.
    await page.goto(h.admin + '/#/settings/users');
    await expect(panel).not.toContainText('可回收');
    await page.goto(h.admin + '/#/settings/storage');
    await expect(panel).toContainText('可回收');
    expect(await refreshed()).toBe(first);
    expect(requests).toEqual(['GET', 'GET']);

    // The acceptance fixture: 1 GiB free in the control database and 2 GiB in the manager's, both on one file system.
    // 可回收 reads their sum, 3.00 GB, and 其它 stays one row rather than two identical ones.
    await page.route('**/api/storage', async route => {
      const response = await route.fetch(), body = await response.json(), disk = body.totals.control.disk;
      body.totals.control.database = { ...body.totals.control.database, free_bytes: 1024 ** 3 };
      body.totals.manager = { database: { ...body.totals.control.database, free_bytes: 2 * 1024 ** 3 }, disk, migration: null, expiry: null };
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(panel).toContainText('可回收（两个库的空闲页，做 VACUUM 能释放）');
    const stubbed = await facts();
    expect(stubbed['可回收（两个库的空闲页，做 VACUUM 能释放）']).toBe('3.00 GB');
    expect(Object.keys(stubbed).filter(key => key.startsWith('其它'))).toEqual(['其它（未列明细的其它）']);
    expect(stubbed['其它（未列明细的其它）']).toMatch(/^[\d.]+ (KB|MB|GB)$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
