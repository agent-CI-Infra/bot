import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { identityFixture } from '../test/identity-fixture.mjs';
import { consoleNavigate } from './console-navigation.mjs';

// #708: signing in does not wait for the GitHub permission check. The console opens at once, shows the check's progress,
// and lists the projects the person can manage once it ends.
const output = '.tmp/ui-708';
const noOverflow = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

test('GitHub 登录不等权限核验：先进控制台并显示核验进度，核验完成后出现可管理的项目', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  mkdirSync(output, { recursive: true });
  // The check waits at its first installation read until released.
  let release; const held = new Promise(resolve => { release = resolve; });
  f.state.apiGate = async path => { if (path === '/app/installations/77') await held; };
  const shots = async name => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    // Signed in although the check is still held: the progress line shows, and the identity page waits for the check.
    const line = page.locator('#github-verification');
    await expect(line).toBeVisible();
    await expect(line).toHaveText('正在核验 GitHub 权限（已核对 0/1 个安装），完成后显示你可以管理的项目。');
    await expect(page.locator('#identity-panel')).toContainText('核验完成后显示你的 GitHub 连接与授权来源。');
    await shots('identity-verifying');
    // The project list does not claim there is nothing to manage while the answer is still coming.
    await consoleNavigate(page, '项目');
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(page.locator('#rows').getByRole('heading', { name: '正在核验 GitHub 权限' })).toBeVisible();
    await expect(page.getByText('已登录，尚无可管理的项目')).toHaveCount(0);
    await shots('projects-verifying');
    // The check ends: the line goes, and the project and the project picker entry appear without reloading the page.
    release();
    await expect(line).toBeHidden();
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await expect(page.locator('#console-project option', { hasText: 'fixture/project-101' })).toHaveCount(1);
    await shots('projects-verified');
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; release(); await f.close(); }
});

// #757: the check ends in the background, so it must not take away what the reader is typing. The identity sub-pages
// hold forms of their own (the app wizard's credentials, the binding page's confirmation string) and nothing the check
// proves changes them; the pages that do list the new grants are still drawn again.
const setupStub = route => route.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ platform: true, organizations: [], connectors: [], feishu_scopes: [] }) });
// A child of the identity panel: it survives the check only if the panel is not drawn again.
const markPanel = page => page.evaluate(() => {
  const marker = document.createElement('span'); marker.id = 'repaint-probe'; marker.textContent = 'probe';
  document.getElementById('identity-panel').append(marker); return marker.id;
});

test('核验结束时，身份子页上正在填写的凭据不被重绘清掉', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  await page.route('**/api/channels/setup', setupStub);
  let release; const held = new Promise(resolve => { release = resolve; });
  f.state.apiGate = async path => { if (path === '/app/installations/77') await held; };
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.locator('#github-verification')).toBeVisible();
    // The reader is on the wizard's credentials step while the check runs, and has typed into it.
    await page.goto(f.h.admin + '/#/identity/feishu-apps/new/1');
    await expect(page.locator('input[name="app_id"]')).toBeVisible();
    await page.locator('input[name="app_id"]').fill('cli_typed_by_person');
    await page.locator('input[name="app_secret"]').fill('secret_typed_by_person');
    await markPanel(page);
    // The check ends: the line goes and the newly proved projects arrive, but the page being filled stays as it is.
    release();
    await expect(page.locator('#github-verification')).toBeHidden();
    await expect(page.locator('#console-project option', { hasText: 'fixture/project-101' })).toHaveCount(1);
    await expect(page.locator('input[name="app_id"]')).toHaveValue('cli_typed_by_person');
    await expect(page.locator('input[name="app_secret"]')).toHaveValue('secret_typed_by_person');
    await expect(page.locator('#repaint-probe')).toHaveCount(1);
    await expect(page).toHaveURL(/#\/identity\/feishu-apps\/new\/1$/);
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; release(); await f.close(); }
});

test('核验结束时，没有人填写的身份子页仍然重绘，授权页面照旧跟随', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  await page.route('**/api/channels/setup', setupStub);
  let release; const held = new Promise(resolve => { release = resolve; });
  f.state.apiGate = async path => { if (path === '/app/installations/77') await held; };
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.locator('#github-verification')).toBeVisible();
    await page.goto(f.h.admin + '/#/identity/feishu-apps/new/1');
    await expect(page.locator('input[name="app_id"]')).toBeVisible();
    await markPanel(page);
    release();
    await expect(page.locator('#github-verification')).toBeHidden();
    // Nothing was typed: the sub-page follows the check as before, and the project picker still gains the new project.
    await expect(page.locator('#repaint-probe')).toHaveCount(0);
    await expect(page.locator('#identity-panel')).toContainText('飞书应用连接向导');
    await expect(page.locator('#console-project option', { hasText: 'fixture/project-101' })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; release(); await f.close(); }
});

test('核验进行中会话过期时，不再跟进核验进度，交给「登录已过期」提示', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  let release; const held = new Promise(resolve => { release = resolve; });
  f.state.apiGate = async path => { if (path === '/app/installations/77') await held; };
  let reads = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/me') reads++; });
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    const line = page.locator('#github-verification');
    await expect(line).toBeVisible();
    // The session ends while the check is still held: the next progress read is refused.
    f.h.store.run('DELETE FROM sessions');
    await expect(page.locator('#session-expired-banner')).toBeVisible();
    await expect(line).toBeHidden();
    // No more progress reads after that (the console polls every 1.5 s while it follows a check).
    const after = reads; await page.waitForTimeout(4000); expect(reads).toBe(after);
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; release(); await f.close(); }
});
