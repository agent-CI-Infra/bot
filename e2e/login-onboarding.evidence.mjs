// Screenshot evidence generator for #225 slice 1 (login/onboarding). Not a test: Playwright only collects
// *.spec.mjs, so CI never runs this file. It starts the real control plane through the same fixture the
// identity spec uses, captures the real login card and the real identity page, and writes them into the
// directory given on the command line. Run it on the base SHA and on the tip SHA, then compare the folders.
//
//   node e2e/login-onboarding.evidence.mjs .local/evidence/225/after
//
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { identityFixture } from '../test/identity-fixture.mjs';

const out = resolve(process.argv[2] || '.tmp/login-onboarding-evidence');
mkdirSync(out, { recursive: true });
const viewports = [[390, 844], [768, 1024], [1440, 1000]];

const f = await identityFixture();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16636b"/></svg>' }));
  // Signed out: the login card is the only screen a new operator sees.
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(f.h.admin + '/');
    // Wait for the shell to decide between the login card and the console, so a capture can never race it.
    await page.waitForFunction(() => document.getElementById('boot')?.hidden === true).catch(() => {});
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/login-${width}.png`, fullPage: true });
    writeFileSync(`${out}/login-${width}.txt`, (await page.locator('body').innerText()));
  }
  // Signed in with a GitHub-derived grant, then the installation moves on so the grant is pending with a reason.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(f.h.admin + '/');
  await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
  await page.waitForSelector('#identity-panel:not([hidden])').catch(() => {});
  const grant = f.h.store.get("SELECT * FROM scoped_grants WHERE source='github_derived'");
  f.h.store.run('UPDATE github_installations SET revision=revision+1 WHERE ref=?', grant.installation_ref);
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    // Re-derive then re-render in place: a background installation sync can move the revision back, and a
    // cold page load re-syncs it, so both the cause and the render are refreshed per viewport.
    f.h.store.run('UPDATE github_installations SET revision=revision+1 WHERE ref=?', grant.installation_ref);
    await page.evaluate(() => start());
    await page.waitForTimeout(150);
    // Fail loudly instead of committing a screenshot that does not show the pending reason.
    const shown = await page.locator('#identity-panel').innerText();
    if (!shown.includes(process.env.REASON_TEXT || '安装待同步')) throw new Error('identity panel does not show the pending reason: ' + shown.slice(0, 200));
    await page.screenshot({ path: `${out}/identity-pending-${width}.png`, fullPage: true });
    writeFileSync(`${out}/identity-pending-${width}.txt`, shown);
  }
  await context.close();
} finally { await browser.close(); await f.close(); }
console.log('wrote screenshots to ' + out);
