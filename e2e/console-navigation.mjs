// Exercise the visible navigation at each breakpoint, rather than clicking a hidden desktop menu.
// #549: a project administrator no longer has 统计 / Webhook / 个人设置 / 存储 on the sidebar;
// if the visible nav does not carry the destination, the helper follows the address (permissions are unchanged).
const addresses = {
  '全局设置': '#/settings/work-computers', 'Webhook 投递': '#/events', '外部执行端': '#/external',
  '身份与权限': '#/identity', '飞书绑定': '#/identity/feishu', '设置': '#/preferences', '个人设置': '#/preferences',
  '飞书会话': '#/conversations', '看板': '#/board', '统计': '#/costs', '管理对话': '#/management', '项目': '#/projects'
};

export async function consoleNavigate(page, name) {
  const address = addresses[name];
  const goHash = async () => {
    if (!address) throw new Error('Unknown console navigation: ' + name);
    await page.evaluate(hash => { location.hash = hash; }, address);
  };
  if (!await page.evaluate(() => matchMedia('(max-width:767px)').matches)) {
    if (['身份与权限', '飞书绑定', '外部执行端', '飞书会话'].includes(name)) {
      const prefs = page.locator('#tabs [data-tab=preferences]');
      if (await prefs.isVisible()) {
        await prefs.click();
        await page.locator('#console-secondary-nav .project-nav').getByRole('link', { name, exact: true }).click();
        return;
      }
      return goHash();
    }
    if (name === '设置' || name === '个人设置') {
      const prefs = page.locator('#tabs [data-tab=preferences]');
      if (await prefs.isVisible()) { await prefs.click(); return; }
      return goHash();
    }
    const desktop = page.locator('#tabs').getByRole('button', { name, exact: true });
    if (await desktop.isVisible()) { await desktop.click(); return; }
    return goHash();
  }
  await page.locator('#console-mobile-nav').getByRole('link', { name: '更多', exact: true }).click();
  if (!address) throw new Error('Unknown console navigation: ' + name);
  const link = page.locator('#console-page').locator(`a[href="${address}"]`);
  if (await link.count() && await link.first().isVisible()) { await link.click(); return; }
  return goHash();
}
