// Screenshot evidence for #237 (installation profiles). Not a test: Playwright only collects *.spec.mjs.
// Run on the base SHA and the tip, then compare the folders:
//
//   node e2e/installation-profiles.evidence.mjs docs/verification/237/after
//
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

const out = resolve(process.argv[2] || '.tmp/installation-profiles-evidence');
mkdirSync(out, { recursive: true });
const f = await identityFixture();
const browser = await chromium.launch();
try {
  // The same evidence the spec uses: one signed installation event and one installation whose App is gone.
  f.h.store.run(`INSERT INTO installation_events(id,installation_ref,account_id,endpoint_id,delivery_id,event,action,
    signature_verified,received_at,payload_hash,payload,sender,requester,evidence_type,result,revision)
    VALUES('ev-created','github.com/123/77',?,?,'d-1','installation','created',1,?,'hash-1','{}',?,?,'signed','accepted',1)`,
    f.a.id, f.a.endpoints[0].id, new Date().toISOString(), JSON.stringify({ login: 'fixture', id: 10 }), JSON.stringify({ login: 'fixture', id: 10 }));
  f.h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,
    target_login,repository_selection,status,completeness,revision,updated_at)
    VALUES('github.com/999/88','github.com','999','88','gone','1','Organization','orphan','selected','active','complete',1,?)`,
    new Date().toISOString());
  const context = await browser.newContext({ reducedMotion: 'reduce' }), page = await context.newPage();
  await page.goto(f.h.admin + '/#/settings/installations');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  for (const [section, name] of [['installations', 'installations'], ['accounts', 'accounts']]) {
    await page.goto(f.h.admin + '/#/settings/' + section);
    await page.locator('#settings-panel').getByRole('heading').first().waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 });
      await page.locator('#settings-panel').getByText('所属账号').first().waitFor({ timeout: 3000 }).catch(() => {});
      await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
    }
  }
} finally { await browser.close(); await f.close(); }
