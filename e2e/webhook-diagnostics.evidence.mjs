// Screenshot evidence for #238 (Webhook list and detail diagnostics). Not a test: Playwright only collects
// *.spec.mjs, so this file never runs in CI. It starts the real control plane through test/helpers.mjs, seeds one
// delivery of each outcome, signs in with the fixture administrator and captures the real #/events page and the
// delivery dialog at 390 and 1440. Run it on the base SHA and on the tip SHA; the PR commits both directories:
//
//   PLAYWRIGHT_BROWSERS_PATH=<browsers> node e2e/webhook-diagnostics.evidence.mjs docs/verification/238/before
//   PLAYWRIGHT_BROWSERS_PATH=<browsers> node e2e/webhook-diagnostics.evidence.mjs docs/verification/238/after
//
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';

const out = resolve(process.argv[2] || '.tmp/webhook-evidence');
mkdirSync(out, { recursive: true });

const h = await harness();
const browser = await chromium.launch();
try {
  const { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await admin('/api/repositories/101/policy', 'PATCH', { review_enabled: true });
  const opened = { repository: { id: 101, full_name: 'fixture/project-101' }, action: 'opened', issue: { number: 1, title: 'Review' } };
  await h.hook(a.path, a.secret, 'delivery-success', opened);
  await h.hook(a.path, a.secret, 'delivery-duplicate', opened);
  await h.hook(a.path, a.secret, 'delivery-draft', { repository: { id: 101 }, action: 'opened', pull_request: { number: 2, draft: true, head: { sha: 'a'.repeat(40) } } }, { 'X-GitHub-Event': 'pull_request' });
  await h.hook(a.path, a.secret, 'delivery-not-trigger', { repository: { id: 101 }, ref: 'refs/heads/main' }, { 'X-GitHub-Event': 'push' });
  await admin('/api/repositories/101/policy', 'PATCH', { enabled: false });
  await h.hook(a.path, a.secret, 'delivery-disabled', { ...opened, issue: { number: 3, title: 'Disabled' } });
  await admin('/api/repositories/101/policy', 'PATCH', { enabled: true });
  await h.hook(a.path, 'wrong-secret', 'delivery-bad-signature', opened);

  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(h.admin + '/');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForFunction(() => document.body.classList.contains('console-ready'));
  for (const [width, height] of [[390, 844], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    await page.goto(h.admin + '/#/events');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.locator('#rows .row').first().waitFor();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}/webhooks-${width}.png`, fullPage: true });
    await page.locator('#rows .row').filter({ hasText: 'delivery-success' }).getByRole('button', { name: '查看详情', exact: true }).click();
    await page.locator('#detail[open]').waitFor();
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${out}/webhook-detail-${width}.png` });
    await page.locator('#detail').getByRole('button', { name: '关闭', exact: true }).click();
  }
  await context.close();
} finally { await browser.close(); await h.stop(); }
console.log('wrote screenshots to ' + out);
