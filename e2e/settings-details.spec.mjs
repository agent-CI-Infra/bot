import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// The settings pages address one installation and one user by id. A detail page has to keep the evidence honest: a
// zero-repository installation says 无仓库, missing installation history never guesses a requester, an unverified
// signature stands out, and disabling the last super administrator is refused in words, not as a bare error code.
async function login(page, f, hash) {
  await page.goto(f.h.admin + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('installation and user detail pages address one record and keep missing evidence explicit', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const admin = f.h.store.get("SELECT id FROM users WHERE role='super_admin'").id;
    // A second installation on the same App with no repository at all: a real zero-repository installation.
    f.h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,
      target_login,repository_selection,status,completeness,revision,updated_at)
      VALUES('github.com/123/88','github.com','123','88',?,77,'Organization','empty-org','selected','active','complete',1,?)`,
      f.a.id, new Date().toISOString());
    // A delivery whose signature did not verify must not read as a normal event.
    f.h.store.run(`INSERT INTO installation_events(id,installation_ref,account_id,endpoint_id,delivery_id,event,action,
      signature_verified,received_at,payload_hash,payload,sender,requester,evidence_type,result,revision)
      VALUES('ev-bad','github.com/123/77',?,?,'d-bad','installation_repositories','added',0,?,'hash-bad','{}',NULL,NULL,'unsigned','rejected',2)`,
      f.a.id, f.a.endpoints[0].id, new Date().toISOString());

    await login(page, f, '/#/settings/installations/github.com/123/77');
    const panel = page.locator('#settings-panel');
    // The address reaches the installation itself, with a way back to the archive.
    await expect(panel).toContainText('fixture · 安装 77');
    await expect(page.getByRole('link', { name: '返回安装档案' })).toBeVisible();
    // Missing history does not become "no requester".
    await expect(panel).toContainText('历史证据缺失');
    await expect(panel).toContainText('不能判断申请者');
    // The unverified delivery is marked in the events table.
    await expect(panel).toContainText('签名未验证');

    // A zero-repository installation reads 无仓库 instead of an empty table.
    await page.goto(f.h.admin + '/#/settings/installations/github.com/123/88');
    await expect(panel).toContainText('empty-org · 安装 88');
    await expect(panel).toContainText('无仓库');

    // The user detail page carries the same access projection and can disable the account.
    await page.goto(f.h.admin + '/#/settings/users/' + admin);
    await expect(panel).toContainText('本地账号');
    const disable = panel.getByRole('button', { name: '停用', exact: true });
    await expect(disable).toBeVisible();
    await disable.click();
    // The server refuses the only active super administrator; the page says why in words.
    await expect(panel.locator('[role=alert]').last()).toContainText('最后一名活跃的超级管理员');
    await expect(panel).toContainText('已启用');

    // Both detail pages stay readable on a phone: nothing overflows the 390px viewport.
    for (const hash of ['/#/settings/installations/github.com/123/77', '/#/settings/users/' + admin]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(f.h.admin + hash);
      await expect(panel.getByRole('link', { name: /返回/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // Prototype names in the address must not reach settingsCards' prototype chain: they fall back to 常规, no crash.
    for (const hash of ['/#/settings/__proto__', '/#/settings/constructor']) {
      await page.goto(f.h.admin + hash);
      await expect(panel).toContainText('当前运行版本');
      expect(errors).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
