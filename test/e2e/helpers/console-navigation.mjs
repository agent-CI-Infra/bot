// Exercise the visible navigation at each breakpoint, rather than clicking a hidden desktop menu.
// #1369: every role has the same entries; the personal pages (存储 among them) sit under 个人设置, and 全局设置 is the one
// entry only a super administrator has. The phone reaches both settings through the account menu.
// If the visible nav does not carry the destination, the helper follows the address (permissions are unchanged).
import { expect } from '@playwright/test';

const addresses = {
  '全局设置': '#/settings/work-computers', '外部执行端': '#/external', '存储': '#/settings/storage',
  '身份与权限': '#/identity', '飞书绑定': '#/identity/feishu', '设置': '#/preferences', '个人设置': '#/identity',
  '飞书会话': '#/conversations', '用量与成本': '#/costs', '管理助手': '#/management', '项目': '#/projects'
};
const personal = ['身份与权限', '飞书绑定', '外部执行端', '飞书会话', '存储'];
const accountMenu = page => page.locator('#console-account-menu');
const accountLinks = page => page.locator('#console-account-menu .console-link:visible');

// #1391: an asynchronous shell re-sync closes the phone's account menu after it was opened. The breakpoint change from
// setViewportSize() and the background permission refresh after the project list renders both call syncConsoleShell(),
// which hides the menu (static/shell.js). Because that can happen after the links were read, each attempt re-opens the
// menu and re-asserts its visible entries instead of waiting out the test timeout on a closed menu.
export async function openAccountMenu(page, expectedLinks, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!await accountMenu(page).isVisible()) await page.locator('#console-account').click();
    try {
      await expect(accountLinks(page).first()).toBeVisible({ timeout: 2000 });
      if (expectedLinks) await expect(accountLinks(page)).toHaveText(expectedLinks, { timeout: 2000 });
      return;
    } catch (err) {
      lastError = err;
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  throw lastError;
}

// Re-open + re-assert before every click, so an entry that disappeared between reading the menu and clicking it is
// retried rather than exhausting the whole test timeout.
export async function clickAccountMenuEntry(page, name, expectedLinks, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await openAccountMenu(page, expectedLinks);
    try {
      await accountMenu(page).getByRole('link', { name, exact: true }).click({ timeout: 2000 });
      return;
    } catch (err) {
      lastError = err;
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  throw lastError;
}

export async function consoleNavigate(page, name) {
  const address = addresses[name];
  const goHash = async () => {
    if (!address) throw new Error('Unknown console navigation: ' + name);
    await page.evaluate(hash => { location.hash = hash; }, address);
  };
  if (!await page.evaluate(() => matchMedia('(max-width:767px)').matches)) {
    if (personal.includes(name)) {
      const prefs = page.locator('#tabs [data-console-nav=preferences]');
      if (await prefs.isVisible()) {
        await prefs.click();
        await page.locator('#console-secondary-nav .project-nav').getByRole('link', { name, exact: true }).click();
        return;
      }
      return goHash();
    }
    if (name === '设置' || name === '个人设置') {
      const prefs = page.locator('#tabs [data-console-nav=preferences]');
      if (await prefs.isVisible()) { await prefs.click(); return; }
      return goHash();
    }
    const desktop = page.locator('#tabs').getByRole('link', { name, exact: true });
    if (await desktop.isVisible()) { await desktop.click(); return; }
    return goHash();
  }
  const bar = page.locator('#console-mobile-nav').getByRole('link', { name, exact: true });
  if (['项目', '用量与成本'].includes(name) && await bar.isVisible()) { await bar.click(); return; }
  const settings = name === '全局设置' ? '全局设置' : personal.includes(name) || name === '设置' || name === '个人设置' ? '个人设置' : null;
  if (!settings) return goHash();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await openAccountMenu(page);
    } catch {
      return goHash();
    }
    const entry = page.locator('#console-account-menu').getByRole('link', { name: settings, exact: true });
    if (!await entry.isVisible()) { await page.keyboard.press('Escape'); return goHash(); }
    try {
      await entry.click({ timeout: 2000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  // A personal page other than the first one is picked from the phone's 当前页面 list.
  if (settings === '个人设置' && address !== '#/identity' && address !== '#/preferences') {
    await page.getByLabel('当前页面', { exact: true }).selectOption(address);
  }
}
