import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';

// #873: a reload of a signed-in console reads the project list before it can draw anything. When that read fails the
// page now stops on the boot card the signed-out boot already used, instead of leaving an empty workspace behind.
const failRepositories = route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"fixture_unavailable"}' });

async function signIn(page, password) {
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

test('signed-in reload whose project list read fails stops on the boot card and recovers through its retry', async ({ page }) => {
  const h = await harness(), { password, admin } = await setup(h), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    // A real project: the recovery has to bring the list back, not only the empty shell around it.
    await repository(admin, (await account(admin)).id, '101');
    await page.goto(h.admin); await signIn(page, password);
    await page.route('**/api/repositories', failRepositories);
    await page.reload();
    const boot = page.locator('#boot'), message = page.locator('#boot-message'), retry = page.locator('#boot-retry');
    await expect(boot).toBeVisible();
    await expect(message).toHaveAttribute('role', 'alert');
    await expect(message).toContainText('控制台载入失败：500 · fixture_unavailable');
    // The workspace it could not fill is off the screen, and so is the login form: this is not a signed-out console.
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#access')).toBeHidden();
    // The session survives (#873): the header still names the reader, so a failure to read one list does not look like a
    // sign-out and 退出登录 stays reachable.
    await expect(page.locator('#identity')).toBeVisible();
    await expect(page.locator('#who')).toContainText('administrator');
    // One failure, one retry: the shared message strip holds no second copy, and no second retry button appears.
    await expect(page.getByText('控制台载入失败')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(1);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#boot-message')).toBeInViewport();
      await expect(retry).toBeInViewport();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // A retry that fails again leaves the same card and its button usable instead of a disabled retry under a stale page.
    await retry.click();
    await expect(boot).toBeVisible();
    await expect(message).toHaveAttribute('role', 'alert');
    await expect(retry).toBeVisible(); await expect(retry).toBeEnabled();
    await page.unroute('**/api/repositories');
    await retry.click();
    await expect(boot).toBeHidden();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#tabs')).toBeVisible();
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
