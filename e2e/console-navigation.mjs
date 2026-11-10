// Exercise the visible navigation at each breakpoint, rather than clicking a hidden desktop menu.
export async function consoleNavigate(page, name) {
  const desktop = page.locator('#tabs').getByRole('button', { name, exact: true });
  if (!await page.evaluate(() => matchMedia('(max-width:767px)').matches)) { await desktop.click(); return; }
  await page.locator('#console-mobile-nav').getByRole('link', { name: '更多', exact: true }).click();
  const address = { '全局设置': '#/settings/general', 'Webhook 投递': '#/events', '外部执行端': '#/external', '身份与权限': '#/identity' }[name];
  if (!address) throw new Error('Unknown console navigation: ' + name);
  await page.locator('#console-page').locator(`a[href="${address}"]`).click();
}
