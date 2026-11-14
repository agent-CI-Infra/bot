import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { identityFixture, openIdentityAdvanced } from '../test/identity-fixture.mjs';
import { transport, connector, bindFixture, envelope, post, finished } from '../test/channel-fixture.mjs';

const output = '.tmp/identity-display';
async function navigateIdentity(page, width) {
  if (width < 768) {
    await page.locator('#console-mobile-nav a[href="#/more"]').click();
    await page.locator('#console-page a[href="#/identity"]').click();
  } else if (await page.locator('#tabs [data-tab="preferences"]').isVisible()) {
    await page.locator('#tabs [data-tab="preferences"]').click();
    await page.locator('#console-secondary-nav a[href="#/identity"]').click();
  } else {
    await page.locator('#console-more-link').click();
    await page.locator('#console-page a[href="#/identity"]').click();
  }
  await expect(page.locator('.identity-overview')).toBeVisible();
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const selector of ['.feishu-metric small', '.feishu-summary-row > strong', '.feishu-row-title > strong']) {
    for (const node of await page.locator(selector).all()) {
      if (await node.isVisible()) expect(await node.evaluate(el => {
        const box = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
        return box.left >= parent.left && box.right <= parent.right && el.scrollWidth <= Math.max(el.clientWidth, box.width);
      })).toBe(true);
    }
  }
}

for (const kind of ['github', 'local']) for (const locale of ['zh-CN', 'en']) {
  test(`${kind} account names and repository scopes stay readable in ${locale} at desktop and mobile widths`, async ({ page }) => {
    test.setTimeout(90000);
    const wire = transport(), f = await identityFixture(null, { channels: { fetch: wire.fetch, longConnections: false } });
    const errors = []; page.on('pageerror', err => errors.push(err.message)); mkdirSync(output, { recursive: true });
    try {
      // A project GitHub administrator and the local platform administrator exercise both role layouts.
      f.state.owner = false; f.state.admin = true; f.state.login = 'a-github-username-with-thirty-nine-chars1';
      const id = await connector(f.admin);
      await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
      await page.addInitScript(value => localStorage.setItem('launchpad.locale', value), locale);
      await page.goto(f.h.admin);
      if (kind === 'github') await page.locator('#github-login').click();
      else {
        await page.locator('#access-form [name="username"]').fill('administrator');
        await page.locator('#access-form [name="password"]').fill(f.password);
        await page.locator('#access-submit').click();
      }
      await expect(page.locator('#workspace')).toBeVisible();
      const actor = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
      const name = kind === 'github' ? '@' + f.state.login : 'administrator';
      bindFixture(f.h, id, actor.id);
      // A historical grant without a visible repository must not disclose another repository's metadata.
      for (const [project, revoked] of [['101', null], ['999', Date.now()]]) {
        f.h.store.run(`INSERT INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at,revoked_at)
          VALUES(?,?, 'github.com:10',?,'project','delegated','["tasks.read"]','explicit_delegation','independent','display fixture',?,?)`,
        'display-' + project, actor.id, project, Date.now(), revoked);
      }
      for (const width of [1440, 390]) {
        const prefix = `${output}/${kind}-${locale}-${width}`;
        await page.setViewportSize({ width, height: 1000 });
        await navigateIdentity(page, width);
        const overview = page.locator('.identity-feishu .feishu-overview');
        await expect(overview).toContainText((locale === 'en' ? 'Current account ' : '当前账户 ') + name);
        await expect(overview).toContainText(locale === 'en' ? `${name}’s Feishu identity` : `${name} 的飞书身份`);
        await expect(overview).not.toContainText(/github:\d+:/);
        await noOverflow(page);
        await page.screenshot({ path: prefix + '-identity.png', fullPage: true });
        if (width < 768) {
          await page.locator('#console-account').click();
          await expect(page.locator('#console-account-login')).toHaveText(name);
          await page.keyboard.press('Escape');
        } else await expect(page.locator('#who')).toContainText(name);
        await openIdentityAdvanced(page);
        const permissions = page.locator('.side-card').filter({ has: page.locator('.identity-grants') });
        await expect(permissions).toContainText((locale === 'en' ? 'Project ' : '项目 ') + 'fixture/project-101');
        await page.locator('details.identity-history > summary').click();
        await expect(permissions).toContainText(locale === 'en' ? 'Project (ID 999)' : '项目（ID 999）');
        if (kind === 'github') {
          await expect(page.locator('#identity-panel')).toContainText(actor.username);
          expect(await page.locator('#identity-panel').evaluate(el => {
            const copy = el.cloneNode(true); copy.querySelector('.identity-advanced').remove(); return copy.textContent;
          })).not.toContain(actor.username);
          await expect(permissions).not.toContainText('other/project-201');
        }
        await noOverflow(page);
        await permissions.screenshot({ path: prefix + '-permissions.png' });
        await overview.locator('a[href="#/identity/feishu"]').click();
        await expect(page.locator('.feishu-metrics')).toContainText(name);
        const binding = page.getByLabel('我的飞书账号', { exact: true });
        await expect(binding).toContainText(locale === 'en' ? `${name}’s Feishu account` : `${name} 的飞书账号`);
        await expect(binding).toContainText((locale === 'en' ? 'Linked platform account: ' : '关联平台账户：') + name);
        await page.getByRole('button', { name: '创建个人绑定', exact: true }).click();
        await page.getByText('使用旧私聊认证字符串（兼容入口）', { exact: true }).click();
        await expect(page.locator('.feishu-legacy-binding form')).toContainText((locale === 'en' ? 'This will link to your current platform account: ' : '将绑定到当前平台账户：') + name);
        await expect(page.locator('#identity-panel')).not.toContainText(/github:\d+:/);
        await noOverflow(page);
        await page.screenshot({ path: prefix + '-feishu.png', fullPage: true });

        // Open the actual link issued by the local Feishu transport, then claim it as the signed-in person.
        const started = await post(f.h, id, envelope('/bind', { sender: { sender_id: { open_id: 'ou_pending_' + width } } }));
        expect((await finished(f.h, started.value.operation_id)).state).toBe('completed');
        const outbox = f.h.store.get('SELECT * FROM channel_outbox WHERE source_event=?', started.value.operation_id);
        const reply = f.h.store.secrets.open(outbox.payload, 'channel-outbox:' + outbox.id);
        const challenge = /challenge=([a-f0-9]+)/.exec(JSON.stringify(reply))[1];
        await page.goto(f.h.admin + '/auth/channels/start?challenge=' + challenge);
        await expect(page.locator('#feishu-identity')).toContainText((locale === 'en' ? 'This will link to your current platform account: ' : '将绑定到当前平台账户：') + name);
        await expect(page.locator('#identity-panel')).not.toContainText(/github:\d+:/);
        await noOverflow(page);
        await page.screenshot({ path: prefix + '-confirm.png', fullPage: true });
        await page.getByRole('button', { name: '绑定到当前平台账户', exact: true }).click();
        const pending = page.getByLabel('待确认的飞书身份').last();
        await expect(pending).toContainText(name);
        await expect(page.locator('#identity-panel')).not.toContainText(/github:\d+:/);
        await noOverflow(page);
        await pending.screenshot({ path: prefix + '-pending.png' });
      }
      expect(errors).toEqual([]);
    } finally { await f.close(); rmSync(f.h.directory, { recursive: true, force: true }); }
  });
}
