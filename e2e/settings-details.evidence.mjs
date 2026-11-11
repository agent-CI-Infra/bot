// Screenshot evidence for #237 detail pages. Not a test: Playwright only collects *.spec.mjs.
//
//   node e2e/settings-details.evidence.mjs docs/verification/237/detail-pages/after
//
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

const out = resolve(process.argv[2] || '.tmp/settings-details-evidence');
mkdirSync(out, { recursive: true });
const f = await identityFixture();
const browser = await chromium.launch();
try {
  const admin = f.h.store.get("SELECT id FROM users WHERE role='super_admin'").id;
  // Same evidence as the spec: a zero-repository installation and one delivery whose signature did not verify.
  f.h.store.run(`INSERT INTO github_installations(ref,github_host,app_id,installation_id,account_id,target_id,target_type,
    target_login,repository_selection,status,completeness,revision,updated_at)
    VALUES('github.com/123/88','github.com','123','88',?,77,'Organization','empty-org','selected','active','complete',1,?)`,
    f.a.id, new Date().toISOString());
  f.h.store.run(`INSERT INTO installation_events(id,installation_ref,account_id,endpoint_id,delivery_id,event,action,
    signature_verified,received_at,payload_hash,payload,sender,requester,evidence_type,result,revision)
    VALUES('ev-bad','github.com/123/77',?,?,'d-bad','installation_repositories','added',0,?,'hash-bad','{}',NULL,NULL,'unsigned','rejected',2)`,
    f.a.id, f.a.endpoints[0].id, new Date().toISOString());
  const context = await browser.newContext({ reducedMotion: 'reduce' }), page = await context.newPage();
  await page.goto(f.h.admin + '/#/settings/installations/github.com/123/77');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const pages = [['installation-77', '/#/settings/installations/github.com/123/77'],
    ['installation-88-zero-repo', '/#/settings/installations/github.com/123/88'],
    ['user-admin', '/#/settings/users/' + admin]];
  for (const [name, hash] of pages) {
    await page.goto(f.h.admin + hash);
    await page.locator('#settings-panel').getByRole('heading').first().waitFor({ timeout: 10000 }).catch(() => {});
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
    }
  }
} finally { await browser.close(); await f.close(); }
