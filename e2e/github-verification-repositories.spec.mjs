import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { identityFixture } from '../test/identity-fixture.mjs';
import { consoleNavigate } from './console-navigation.mjs';

// #866: the permission check ended, but reading the projects it just changed failed. The reader must not be left with the
// old list and no word: the line says the list could not be read and offers to read it again; a read that comes back
// draws the new projects and takes the notice away.
const output = '.tmp/ui-866';
const noOverflow = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

test('权限核验完成后的项目列表读取失败有提示，重新读取成功后列表更新', async ({ page }) => {
  const f = await identityFixture(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://avatars.githubusercontent.com/**', route => route.abort());
  mkdirSync(output, { recursive: true });
  // The check waits at its first installation read until released.
  let release; const held = new Promise(resolve => { release = resolve; });
  f.state.apiGate = async path => { if (path === '/app/installations/77') await held; };
  // The first project-list read after the check is armed to fail the way a control plane that is down answers; the read
  // the button asks for goes through to the service.
  let failNext = false;
  await page.route('**/api/repositories', route => {
    if (!failNext) return route.continue();
    failNext = false;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) });
  });
  const picker = page.locator('#console-project option', { hasText: 'fixture/project-101' });
  const retry = page.locator('#github-verification').getByRole('button', { name: '重新读取项目列表' });
  const shots = async name => {
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
      // The notice and its button stay inside the width the reader has, at every one of them.
      if (await retry.isVisible()) {
        const box = await retry.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.height).toBeGreaterThan(0);
      }
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  try {
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    const line = page.locator('#github-verification');
    await expect(line).toBeVisible();
    await expect(picker).toHaveCount(0);
    // The check ends and the list read fails: the line says so instead of vanishing with the progress it was showing.
    failNext = true; release();
    await expect(line).toBeVisible();
    await expect(line).toHaveText('权限核验已完成，但项目列表读取失败。重新读取项目列表');
    await expect(line).toHaveAttribute('data-state', 'failed');
    await expect(retry).toBeVisible();
    await expect(picker).toHaveCount(0);
    await shots('repositories-failed');
    // The pages the check feeds were redrawn with the finished state: neither still claims the check is running, and
    // the identity root does not keep its "after the check" placeholder.
    await expect(page.locator('#rows')).not.toContainText('正在核验 GitHub 权限');
    await consoleNavigate(page, '身份与权限');
    await expect(page.locator('#identity-panel')).not.toContainText('核验完成后显示你的 GitHub 连接与授权来源');
    await consoleNavigate(page, '项目');
    // The button reads the list again; the projects the check just proved arrive and the notice goes.
    await retry.click();
    await expect(line).toBeHidden();
    await expect(picker).toHaveCount(1);
    await shots('repositories-read');
    // The project list the check was for now names the project, without reloading the page.
    await consoleNavigate(page, '项目');
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    expect(errors).toEqual([]);
  } finally { f.state.apiGate = undefined; release(); await f.close(); }
});
