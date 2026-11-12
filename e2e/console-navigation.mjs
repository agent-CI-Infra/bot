// Exercise the visible navigation at each breakpoint, rather than clicking a hidden desktop menu.
export async function consoleNavigate(page, name) {
  if (!await page.evaluate(() => matchMedia('(max-width:767px)').matches)) {
    if (['身份与权限', '外部执行端', '飞书会话'].includes(name)) {
      await page.locator('#tabs [data-tab=preferences]').click();
      await page.locator('#console-secondary-nav .project-nav').getByRole('link', { name, exact: true }).click();
      return;
    }
    if (name === '设置' || name === '个人设置') {
      await page.locator('#tabs [data-tab=preferences]').click();
      return;
    }
    const desktop = page.locator('#tabs').getByRole('button', { name, exact: true, includeHidden: true });
    await desktop.click();
    return;
  }
  await page.locator('#console-mobile-nav').getByRole('link', { name: '更多', exact: true }).click();
  const address = { '全局设置': '#/settings/platform', 'Webhook 投递': '#/events', '外部执行端': '#/external', '身份与权限': '#/identity', '设置': '#/preferences', '个人设置': '#/preferences', '飞书会话': '#/conversations',
    '看板': '#/board', '统计': '#/costs', '管理对话': '#/management', '项目': '#/projects' }[name];
  if (!address) throw new Error('Unknown console navigation: ' + name);
  await page.locator('#console-page').locator(`a[href="${address}"]`).click();
}
