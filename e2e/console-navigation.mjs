// Exercise visible navigation at each breakpoint, including destinations moved into More.
export async function consoleNavigate(page, name) {
  const mobile = await page.evaluate(() => matchMedia('(max-width:767px)').matches);
  if (!mobile && ['项目', '管理对话', '看板'].includes(name)) {
    await page.locator('#tabs').getByRole('button', { name, exact: true }).click();
    return;
  }
  if (mobile && ['项目', '看板'].includes(name)) {
    await page.locator(`#console-mobile-nav [data-page=${name === '项目' ? 'projects' : 'board'}]`).click();
    return;
  }
  if (mobile) await page.locator('#console-mobile-nav [data-page=more]').click();
  else await page.locator('#tabs [data-tab=more]').click();
  const address = { '全局设置': '#/settings', '存储': '#/settings/storage', 'Webhook 投递': '#/events',
    '外部执行端': '#/external', '身份与权限': '#/identity', '飞书绑定': '#/identity',
    '设置': '#/identity', '个人设置': '#/identity', '飞书会话': '#/conversations',
    '统计': '#/costs', '管理对话': '#/management' }[name];
  if (!address) throw new Error('Unknown console navigation: ' + name);
  await page.locator('#console-page').locator(`a[href="${address}"]`).click();
  if (name === '飞书绑定') {
    if (mobile) await page.getByLabel('当前页面', { exact: true }).selectOption('#/identity/feishu');
    else await page.locator('#console-secondary-nav').getByRole('link', { name, exact: true }).click();
  }
}
