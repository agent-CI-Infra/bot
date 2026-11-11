import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, testPassword } from '../test/helpers.mjs';

// #224-A: the design token layer and the component/state sample page. The sample page is the reviewed evidence surface for
// both, so it has to be a real page: same control plane, same stylesheets, same components. It is super-administrator only
// and has no navigation entry, which this spec pins too — a visible "design system demo" would be a product change nobody
// asked for.
test('#224-A 设计 token 可解析、组件与四种状态可见、五档视口无横向溢出；样例页无导航入口且只对超级管理员开放', async ({ page, browser }) => {
  test.setTimeout(60000);
  const h = await harness(), errors = [], out = '.tmp/design-system';
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync(out, { recursive: true });
  try {
    const { admin, password } = await setup(h);
    await account(admin);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/design');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#design-page')).toBeVisible();

    // The module sheets no longer declare a theme: `static/shell.css` is the only `:root` that declares custom
    // properties, per docs/console-ui.md ("modules reference the variables, they do not copy another theme").
    const rootDeclarations = async file => page.evaluate(async name => {
      const text = await (await fetch('/' + name)).text();
      const block = /:root\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
      return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(match => match[1]);
    }, file);
    expect(await rootDeclarations('style.css')).toEqual([]);
    expect(await rootDeclarations('views.css')).toEqual([]);
    expect((await rootDeclarations('shell.css')).length).toBeGreaterThan(0);
    // Everything the sample page draws resolves to a shell.css value; an undefined token would render as nothing.
    const token = name => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
    for (const name of ['--color-brand', '--color-text', '--control-min', '--font-size-5', '--focus-ring'])
      expect(await token(name)).not.toBe('');
    expect(await token('--control-min')).toBe('44px');
    await expect(page.locator('#design-page')).toContainText('static/shell.css');

    // Every component the slice names has a sample, and the samples are the product's own components, not copies.
    for (const heading of ['设计 token', '按钮与操作', '表单控件', '表格、卡片与状态', '状态：空 / 加载 / 错误 / 无权限 / 成功', '对话框'])
      await expect(page.locator('#design-page').getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('#design-page button.status')).toHaveCount(0); // status badges are spans or real buttons, never fakes
    // The catalog has to paint, not print: a colour chip is a real box whose background equals the token it names.
    const chips = page.locator('#design-tokens .design-swatch i');
    expect(await chips.count()).toBeGreaterThanOrEqual(8);
    expect(await page.evaluate(() => {
      const bad = [];
      for (const chip of document.querySelectorAll('#design-tokens .design-swatch i')) {
        const name = chip.parentElement.querySelector('code').textContent.trim();
        const probe = document.createElement('div'); probe.style.background = `var(${name})`; document.body.append(probe);
        const resolved = getComputedStyle(probe).backgroundColor; probe.remove();
        const painted = getComputedStyle(chip).backgroundColor, box = chip.getBoundingClientRect();
        if (painted !== resolved || painted === 'rgba(0, 0, 0, 0)' || box.width < 8 || box.height < 8)
          bad.push([name, painted, resolved, box.width, box.height]);
      }
      return bad;
    })).toEqual([]);
    await expect(page.locator('#design-rows .row')).toHaveCount(4);
    await expect(page.locator('#design-rows .status-success')).toHaveText('已完成');
    await expect(page.locator('#design-rows .status-warning')).toContainText('需人工');
    await expect(page.locator('#design-rows .status-danger')).toHaveText('失败');
    await expect(page.locator('#design-buttons button:disabled')).toHaveText('保存中…');

    // The four states plus the two feedback strips. The empty and loading wording is the console's own, drawn by the same
    // rule the projects list uses, so the sample cannot drift from it.
    expect(await page.locator('#design-empty').evaluate(el => getComputedStyle(el, '::after').content)).toContain('暂无记录');
    expect(await page.locator('#design-loading').evaluate(el => getComputedStyle(el, '::after').content)).toContain('正在加载…');
    await expect(page.locator('#design-states .view-error')).toContainText('刷新后再保存');
    await expect(page.locator('#design-states .side-card').getByRole('heading', { name: '无权限', exact: true })).toBeVisible();
    await expect(page.locator('#design-states .view-success')).toBeVisible();
    await expect(page.locator('#design-states .flash')).toBeVisible();

    // The dialog is the native one: Escape closes it and focus returns to the button that opened it.
    const trigger = page.getByRole('button', { name: '打开确认框', exact: true });
    await trigger.click();
    await expect(page.locator('#design-confirm')).toBeVisible();
    await expect(page.locator('#design-confirm')).toContainText('确认删除这个安装？');
    await page.keyboard.press('Escape');
    await expect(page.locator('#design-confirm')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('打开确认框');

    // Five viewports, no page-level horizontal overflow; the page is the catalog and the sample rows reflow inside it.
    for (const width of [390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(h.admin + '/#/design');
      await expect(page.locator('#design-page')).toBeVisible();
      expect([width, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]).toEqual([width, true]);
      await page.screenshot({ path: `${out}/design-${width}.png`, fullPage: true });
    }

    // The shell knows this address: it has a context label of its own, and the mobile bottom nav does not pretend that
    // 更多 (or any other destination) is the current page.
    await expect(page.locator('#console-context')).toHaveText('设计系统样例');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/design');
    await expect(page.locator('#design-page')).toBeVisible();
    await expect(page.locator('#console-mobile-nav a[aria-current=page]')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(h.admin + '/#/design');
    await expect(page.locator('#design-page')).toBeVisible();

    // No navigation entry and no product link: the only way in is the address itself.
    await expect(page.locator('#tabs').getByRole('button', { name: '设计', exact: true })).toHaveCount(0);
    expect(await page.locator('a[href="#/design"]').count()).toBe(0);

    // The projects list still draws its own empty state from the rule this slice generalised to the class.
    await page.goto(h.admin + '/#/projects');
    await expect(page.locator('#rows')).toBeVisible();
    await expect(page.locator('#rows')).not.toHaveAttribute('aria-busy', 'true');
    expect(await page.locator('#rows').evaluate(el => getComputedStyle(el, '::after').content)).toContain('暂无记录');

    // A project administrator has no sample page; the address falls back to the projects list.
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: [] });
    const context = await browser.newContext(), member = await context.newPage();
    await member.goto(h.admin + '/#/design');
    await member.getByLabel('用户名', { exact: true }).fill('member');
    await member.getByLabel('密码', { exact: true }).fill(memberPassword);
    await member.getByRole('button', { name: '登录', exact: true }).click();
    await expect(member.locator('#design-page')).toBeHidden();
    await expect(member.locator('#tabs [aria-current=page]')).toHaveText('项目');
    await context.close();
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

// #224-A turned a dead rule into a live one: `#rows:empty::after` became `.rows:empty::after`, so a list that is
// loading now shows 正在加载… instead of 暂无记录. That is a behaviour change, so it gets an assertion of its own
// rather than being folded into "no visual change".
test('#224-A 列表加载中显示「正在加载…」，加载完成后忙碌态解除', async ({ page }) => {
  test.setTimeout(60000);
  const h = await harness();
  try {
    const { admin, password } = await setup(h);
    await account(admin);
    // The projects list is served by /api/installations (the shell's own /api/repositories call happens earlier);
    // hold that one request so the loading state can be observed instead of raced.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/installations*', async route => { await held; return route.continue(); });
    await page.goto(h.admin + '/');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const rows = page.locator('#rows');
    await expect(rows).toHaveAttribute('aria-busy', 'true');
    expect(await rows.evaluate(el => getComputedStyle(el, '::after').content)).toContain('正在加载…');
    release();
    await expect(rows).not.toHaveAttribute('aria-busy', 'true');
    expect(await rows.evaluate(el => getComputedStyle(el, '::after').content)).not.toContain('正在加载…');
  } finally { await h.stop(); }
});
