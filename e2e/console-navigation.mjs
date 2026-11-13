// Exercise the visible navigation at each breakpoint, rather than clicking a hidden desktop menu.
export async function consoleNavigate(page, name) {
  if (!await page.evaluate(() => matchMedia('(max-width:767px)').matches)) {
    if (['身份与权限', '飞书绑定', '外部执行端', '飞书会话'].includes(name)) {
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
  const address = { '全局设置': '#/settings/work-computers', 'Webhook 投递': '#/events', '外部执行端': '#/external', '身份与权限': '#/identity', '飞书绑定': '#/identity/feishu', '设置': '#/preferences', '个人设置': '#/preferences', '飞书会话': '#/conversations',
    '看板': '#/board', '统计': '#/costs', '管理对话': '#/management', '项目': '#/projects' }[name];
  if (!address) throw new Error('Unknown console navigation: ' + name);
  await page.locator('#console-page').locator(`a[href="${address}"]`).click();
}

// Project settings have one directory; exercise it instead of a removed row of sibling tabs.
export async function projectNavigate(page, name) {
  await page.locator('#project-page .project-content').waitFor();
  const directory = page.locator('.project-settings-directory');
  const back = page.getByRole('link', { name: '返回项目设置', exact: true });
  if (await back.isVisible()) { await back.click(); await directory.waitFor(); }
  const settings = ['基本设置', '机器配置', '角色', '模型', '计划与通知', '外部执行', '成员'];
  const choose = async caption => {
    if (await page.evaluate(() => matchMedia('(max-width:767px)').matches))
      await page.getByLabel('当前页面', { exact: true }).selectOption({ label: caption });
    else await page.locator('.project-nav').getByRole('link', { name: caption, exact: true }).click();
  };
  if (settings.includes(name)) {
    if (!await directory.isVisible()) await choose('项目设置');
    await directory.getByRole('link', { name, exact: true }).click();
  } else if (name !== '项目设置' || !await directory.isVisible()) await choose(name);
}
