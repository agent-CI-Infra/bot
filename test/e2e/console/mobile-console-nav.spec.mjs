import { switchConsoleProject } from '../helpers/console-scope-picker.mjs';
import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { managementFixture } from '../../fixtures/management-fixture.mjs';

// #481 Console UX 2/3 — the mobile shell owns its own destinations, the assistant moves into the bar at ≤767px, the
// section selector keeps its groups, and the header collapses identity, role and sign-out into one account menu. Desktop
// uses its sidebar without a floating launcher. #1369: 更多 is gone; the bar carries the sidebar's all-projects pages
// (项目 / 待处理 / 助手 / 用量与成本) and the account menu the settings, with 全局设置 as the one role difference.

async function login(page, h, password, hash = '#/projects', username = 'administrator') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  // start() exposes the workspace before its first route finishes and closes any open account menu.
  await expect.poll(() => page.evaluate(() => announcedPage)).not.toBeNull();
}

async function fixture() {
  const h = await harness();
  const { admin, password } = await setup(h);
  const a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');
  return { h, admin, password };
}

const destinations = page => page.locator('#console-mobile-nav a');

test('390px 底栏是四个稳定目的地，各自至少 44px 并标明当前路由', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, h, password);
    const bar = page.locator('#console-mobile-nav');
    await expect(bar).toBeVisible();
    await expect(destinations(page)).toHaveCount(4);
    expect(await destinations(page).evaluateAll(links => links.map(link => [link.dataset.page, link.innerText.trim()])))
      .toEqual([['projects', '项目'], ['inbox', '待处理'], ['assistant', '助手'], ['costs', '用量与成本']]);
    // 44px is the touch target, not the label: the anchor itself has to be big enough to hit.
    for (const link of await destinations(page).all()) {
      const box = await link.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    // Each destination reports the route it stands on, and only that one.
    for (const [page_, hash] of [['projects', '#/projects'], ['inbox', '#/inbox'], ['costs', '#/costs']]) {
      await page.goto(h.admin + '/' + hash);
      await expect(page.locator(`#console-mobile-nav a[data-page="${page_}"]`)).toHaveAttribute('aria-current', 'page');
      expect(await destinations(page).evaluateAll(links => links.filter(link => link.getAttribute('aria-current') === 'page').length)).toBe(1);
    }
  } finally { await h.stop(); }
});

test('767px 是真实断点：767 仍是移动底栏，768 回到桌面侧栏', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 767, height: 900 });
    await login(page, h, password);
    await expect(page.locator('#console-mobile-nav')).toBeVisible();
    await expect(destinations(page)).toHaveCount(4);
    await expect(page.locator('#console-sidebar')).toBeHidden();
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(h.admin + '/#/inbox');
    await expect(page.locator('#console-mobile-nav')).toBeHidden();
    await expect(page.locator('#console-sidebar')).toBeVisible();
  } finally { await h.stop(); }
});

test('移动端从底栏「助手」进入普通页面，桌面只从侧栏进入且没有悬浮按钮', async ({ page }) => {
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.h.admin + '/#/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#management-launcher')).toHaveCount(0);
    const assistant = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await expect(assistant).toBeVisible(); await assistant.click();
    const window_ = page.locator('.management-window');
    await expect(window_).toBeVisible(); await expect(page).toHaveURL(/#\/management$/);
    await expect(page.getByRole('button', { name: '会话记录', exact: true })).toBeVisible();
    await expect(assistant).toHaveAttribute('aria-current', 'page');
    await page.locator('#console-mobile-nav a[data-page="inbox"]').click();
    await expect(window_).toBeHidden(); await expect(page).toHaveURL(/#\/inbox$/);
    await assistant.click(); await expect(window_).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(f.h.admin + '/#/inbox');
    await expect(page.locator('#console-mobile-nav')).toBeHidden();
    await expect(page.locator('#console-sidebar')).toBeVisible(); await expect(page.locator('#management-launcher')).toHaveCount(0);
  } finally { await f.close(); }
});

test('助手的作用域与会话在底栏入口处保留，不因页面切换而重置', async ({ page }) => {
  const f = await managementFixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.h.admin + '/#/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const assistant = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await assistant.click();
    const scope = page.locator('.management-scope-name'), current = page.locator('.management-conversation[aria-current=true]');
    await expect(current).toHaveAttribute('data-conversation-id', /./);
    const previous = await current.getAttribute('data-conversation-id');
    await switchConsoleProject(page, '101');
    await expect(scope).toHaveAttribute('data-scope', 'project:101');
    // The scope label changes before the project's conversation list arrives. Each scope has its own conversations, so
    // wait for the list the project rendered (a current conversation other than the previous scope's) before taking it.
    await expect(current).toHaveAttribute('data-conversation-id', new RegExp(`^(?!${previous}$)[0-9a-f]+$`));
    const id = await current.getAttribute('data-conversation-id');
    const listed = (await (await page.request.get(f.h.admin + '/api/management/conversations')).json()).conversations;
    expect(listed.find(item => item.id === id)?.scope).toBe('project:101');
    await page.locator('#console-mobile-nav a[data-page="inbox"]').click();
    await expect(page.locator('.management-window')).toBeHidden();
    await assistant.click();
    await expect(scope).toHaveAttribute('data-scope', 'project:101'); await expect(current).toHaveAttribute('data-conversation-id', id);
  } finally { await f.close(); }
});

test('进行中与未读状态在离开助手页后镜像到底栏「助手」', async ({ page }) => {
  const f = await managementFixture();
  let release; const gate = new Promise(done => { release = done; });
  f.modelState.respond = async (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    await gate; res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '好的。' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.h.admin + '/#/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const assistant = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await assistant.click();
    await page.getByLabel('管理消息', { exact: true }).fill('看一下进展');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.management-turn-state')).toHaveAttribute('data-state', 'running');
    await page.locator('#console-mobile-nav a[data-page="inbox"]').click();
    await expect(page.locator('.management-window')).toBeHidden();
    await expect(assistant).toHaveAttribute('data-active', '1');
    await expect(assistant.locator('.console-nav-badge')).toBeVisible();
    expect(await assistant.getAttribute('aria-label')).toContain('正在处理');
    expect(await assistant.getAttribute('aria-label')).toContain('助手');
    release();
    await expect(assistant).toHaveAttribute('data-unread', '1');
    expect(await assistant.getAttribute('aria-label')).toContain('未读');
    await assistant.click();
    await expect(assistant).not.toHaveAttribute('data-unread', '1');
    await expect(assistant).not.toHaveAttribute('data-active', '1');
  } finally { release(); await f.close(); }
});

test('#1369 手机底栏两种角色相同，账号菜单只有超管多一个全局设置', async ({ page }) => {
  const { h, admin, password } = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const member = await admin('/api/users', 'POST', { username: 'mobile-member', password: 'pw-mobile-member-1', repository_ids: ['101'] });
    expect(member.status).toBe(201);
    const seen = {};
    for (const [username, secret] of [['administrator', password], ['mobile-member', 'pw-mobile-member-1']]) {
      await login(page, h, secret, '#/projects/101/overview', username);
      await expect(page.locator('#console-project')).toHaveAttribute('data-project-id', '101');
      await expect(destinations(page).last()).toHaveAttribute('href', '#/projects/101/costs');
      const bar = await destinations(page).evaluateAll(links => links.map(link => [link.dataset.page, link.innerText.trim(), link.getAttribute('href')]));
      await page.locator('#console-account').click();
      await expect(page.locator('#console-account-menu')).toBeVisible();
      seen[username] = { bar, menu: (await page.locator('#console-account-menu .console-link:visible').allInnerTexts()).map(text => text.trim()) };
      await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
      await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    }
    expect(seen.administrator.bar).toEqual([['projects', '项目', '#/projects/101/overview'], ['inbox', '待处理', '#/projects/101/inbox'],
      ['assistant', '助手', '#/management'], ['costs', '用量与成本', '#/projects/101/costs']]);
    expect(seen['mobile-member'].bar).toEqual(seen.administrator.bar);
    expect(seen.administrator.menu).toEqual(['个人设置', '全局设置']);
    expect(seen['mobile-member'].menu).toEqual(['个人设置']);
  } finally { await h.stop(); }
});

test('移动「当前页面」选择器保留分组，深链仍然打开对应页面', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, h, password, '#/projects/101/overview');
    await expect(page.locator('#project-page')).toBeVisible();
    const labels = await page.locator('#console-section optgroup').evaluateAll(groups => groups.map(group => group.label));
    expect(labels).toEqual(['项目工作', '设置']);
    // Every option keeps its address, so a deep link opens the page it names.
    const options = await page.locator('#console-section option').evaluateAll(rows => rows.map(row => [row.textContent.trim(), row.value]));
    expect(options).toContainEqual(['项目总览', '#/projects/101/overview']);
    // Project work and settings come from the same scope navigation source.
    expect(options[0]).toEqual(['项目总览', '#/projects/101/overview']);
    await expect(page.locator('#console-section')).toHaveValue('#/projects/101/overview');
    expect(options.map(([, href]) => href)).toEqual(expect.arrayContaining(['#/projects/101/machine', '#/projects/101/roles', '#/projects/101/model', '#/projects/101/members']));
    await page.locator('#console-section').selectOption('#/projects/101/basic');
    await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
    await expect(page.getByLabel('基准分支', { exact: true })).toBeEnabled();
    await expect(page.locator('#console-section')).toHaveValue('#/projects/101/basic');
    await page.locator('#console-section').selectOption('#/projects/101/overview');
    await expect(page).toHaveURL(/#\/projects\/101\/overview$/);
    await expect(page.locator('.workspace-overview')).toBeVisible();
    await expect(page.locator('#console-section optgroup')).toHaveCount(2);
    // The picker opens settings while the desktop category row is hidden on a phone.
    await expect(page.locator('#console-secondary-nav')).toBeHidden();
    await page.locator('#console-section').selectOption('#/projects/101/basic');
    await expect(page).toHaveURL(/#\/projects\/101\/basic$/);
    await expect(page.locator('#console-section')).toHaveValue('#/projects/101/basic');
    expect(await page.locator('#console-section option').evaluateAll(rows => rows.map(row => [row.textContent.trim(), row.value]))).toEqual(options);
  } finally { await h.stop(); }
});

test('移动头部把身份、角色与退出登录收进账号菜单，键盘可用', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, h, password);
    const identity = page.locator('#identity');
    const trigger = page.locator('#console-account');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The separate sign-out button and the bare login text no longer compete for header space.
    await expect(page.locator('header #logout')).toBeHidden();
    await expect(trigger).toHaveAccessibleName(/账号/);
    await trigger.click();
    const menu = page.locator('#console-account-menu');
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.locator('#console-account-login')).toHaveText('administrator');
    await expect(page.locator('#console-account-role')).toHaveText('管理员');
    // Escape closes the menu and returns focus to the trigger; Enter reopens it.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    // #1369: the settings entries the sidebar pins live here on the phone; 全局设置 only for a super administrator.
    await expect(menu.getByRole('link', { name: '个人设置', exact: true })).toHaveAttribute('href', '#/identity');
    await expect(menu.getByRole('link', { name: '全局设置', exact: true })).toHaveAttribute('href', '#/settings/work-computers');
    await expect(menu.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    // A real sign-out still works from the menu.
    await menu.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(identity).toBeHidden();
  } finally { await h.stop(); }
});

test('320/390/767 与矮窗无横向溢出，聚焦控件不被底栏遮挡', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, h, password, '#/costs');
    for (const [width, height] of [[320, 640], [390, 844], [767, 900], [390, 480], [767, 360]]) {
      await page.setViewportSize({ width, height });
      await page.goto(h.admin + '/#/costs');
      await expect(page.locator('#console-mobile-nav')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // The bar reserves safe-area space and never sits on top of the control the reader is typing in.
      const focusable = page.getByLabel('开始日期（本地）', { exact: true });
      await focusable.focus();
      const clear = await focusable.evaluate((el, bar) => {
        const box = el.getBoundingClientRect(), top = document.querySelector(bar).getBoundingClientRect().top;
        const hit = document.elementFromPoint(box.left + Math.min(8, box.width / 2), box.top + box.height / 2);
        return { aboveBar: box.bottom <= top + 1, hit: !!hit && (el === hit || el.contains(hit)) };
      }, '#console-mobile-nav');
      expect(clear.aboveBar || height > 480).toBe(true);
      expect(clear.hit).toBe(true);
    }
  } finally { await h.stop(); }
});

test('账号菜单跟随页面与断点关闭，不会盖在新页面或停在桌面宽度上', async ({ page }) => {
  const { h, password } = await fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, h, password);
    const trigger = page.locator('#console-account'), menu = page.locator('#console-account-menu');
    // Choosing a destination closes the disclosure instead of leaving it open over the page it just navigated to.
    await trigger.click();
    await expect(menu).toBeVisible();
    await menu.getByRole('link', { name: '个人设置', exact: true }).click();
    await expect(page).toHaveURL(/#\/identity$/);
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => announcedPage)).toBe('page:identity');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // 768px hides the trigger itself, so a menu opened at 390px must not keep floating over the desktop header.
    await trigger.click();
    await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(menu).toBeHidden();
    await expect(trigger).toBeHidden();
  } finally { await h.stop(); }
});

test('换一次会话后底栏「助手」不保留上一位用户的进行中与未读', async ({ page }) => {
  const f = await managementFixture();
  let release; const gate = new Promise(done => { release = done; });
  f.modelState.respond = async (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    await gate; res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '好的。' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.h.admin + '/#/inbox');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const assistant = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await assistant.click();
    await page.getByLabel('管理消息', { exact: true }).fill('看一下进展');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.management-turn-state')).toHaveAttribute('data-state', 'running');
    await page.locator('#console-mobile-nav a[data-page="inbox"]').click();
    await expect(assistant).toHaveAttribute('data-active', '1');
    // Leave the reply unread, then change session from the account menu: the next owner starts idle and read.
    release();
    await expect(assistant).toHaveAttribute('data-unread', '1');
    await page.locator('#console-account').click();
    await page.locator('#console-account-menu').getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible();
    const fresh = page.locator('#console-mobile-nav a[data-page="assistant"]');
    await expect(fresh).not.toHaveAttribute('data-active', '1');
    await expect(fresh).not.toHaveAttribute('data-unread', '1');
    await expect(fresh).toHaveAttribute('aria-label', '助手');
  } finally { release(); await f.close(); }
});
