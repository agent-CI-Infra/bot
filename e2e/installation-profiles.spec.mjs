import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// An installation profile has to answer three questions on its own: which registered account is the credential behind it,
// where the authorization comes from, and which permissions are missing. Unmatched evidence stays "unknown", not blank.
async function login(page, f, hash) {
  await page.goto(f.h.admin + hash);
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('installation profiles name the account, the authorization source and the missing permissions', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    // The signed installation event is the authorization record behind the matched installation.
    f.h.store.run(`INSERT INTO installation_events(id,installation_ref,account_id,endpoint_id,delivery_id,event,action,
      signature_verified,received_at,payload_hash,payload,sender,requester,evidence_type,result,revision)
      VALUES('ev-created','github.com/123/77',?,?,'d-1','installation','created',1,?,'hash-1','{}',?,?,'signed','accepted',1)`,
      f.a.id, f.a.endpoints[0].id, new Date().toISOString(), JSON.stringify({ login: 'fixture', id: 10 }), JSON.stringify({ login: 'fixture', id: 10 }));
    // An installation whose App is no longer registered: its profile must say the account is unknown, not guess one.
    f.h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,
      target_login,repository_selection,status,completeness,revision,updated_at)
      VALUES('github.com/999/88','github.com','999','88','gone','1','Organization','orphan','selected','active','complete',1,?)`,
      new Date().toISOString());
    await login(page, f, '/#/settings/installations');
    const panel = page.locator('#settings-panel');
    await expect(panel).toContainText('安装档案');
    // The matched installation names the account that owns the credential, not just its App id.
    await expect(panel).toContainText('所属账号');
    await expect(panel).toContainText('Test account');
    // Authorization comes from the signed installation event.
    await expect(panel).toContainText('GitHub App 安装事件（签名验证）');
    // The orphan keeps its evidence: no account, authorization unknown, permissions unknown.
    await expect(panel).toContainText('未匹配到已登记账号');
    await expect(panel).toContainText('授权来源未知');
    await expect(panel).toContainText('未同步到权限');

    // The account row says where its credential comes from; the install target is on the installation detail page.
    await page.goto(f.h.admin + '/#/settings/accounts');
    await expect(panel).toContainText('GitHub App 安装');
    await expect(panel).toContainText('凭据来源');
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
