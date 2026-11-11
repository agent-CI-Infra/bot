import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup } from '../test/helpers.mjs';

// #225 residual: the GitHub login callback hands the console a stable error code (?auth_error=<code>). The page mapped
// nine of them and printed "GitHub 身份暂时无法验证" for everything else, which tells the person nothing about a network
// failure, an expired grant or a pending installation approval. Unknown codes must still fall back, without echoing the
// raw code the server sent.
test('登录回调错误码显示具体中文；未知 code 落到兜底且不回显原始 code', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { password } = await setup(h), message = page.locator('#message');
    // A real callback code that used to fall into the generic sentence: an expired or revoked GitHub grant.
    await page.goto(h.admin + '/?auth_error=github_reauthorization_required');
    await expect(message).toContainText('需要重新授权');
    await expect(message).not.toContainText('GitHub 身份暂时无法验证');
    // An unknown code keeps the fallback and never shows the raw code to the person.
    await page.goto(h.admin + '/?auth_error=some_raw_code');
    await expect(message).toContainText('GitHub 身份暂时无法验证');
    await expect(message).not.toContainText('some_raw_code');
    // The same mapping holds on the identity page after login, where the callback normally lands.
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.goto(h.admin + '/?auth_error=github_verification_unavailable#/identity');
    await expect(message).toContainText('连接 GitHub 失败');
    await expect(message).not.toContainText('github_verification_unavailable');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
