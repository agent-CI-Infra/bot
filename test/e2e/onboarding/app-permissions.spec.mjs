import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { InstallationSync } from '../../../dist/app/installations.js';

// #527: an English console must leave no Chinese word in the permission report, so the case counts the CJK words that
// survive the language switch instead of trusting one or two labels.
const cjkWords = text => text.match(/[^\s]*[\u4e00-\u9fff][^\s]*/g) || [];

test('App 定义只在机器人账号检查，各功能的安装权限和事件缺口在项目行、缺口对话框与同步结论中显示', async ({ page }) => {
  const full = { contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', actions: 'write', checks: 'write', metadata: 'read' };
  const events = ['issues', 'pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'];
  // Gate onboarding also needs workflows, CI status display check_run/status, and Actions failure analysis workflow_run.
  const everything = { ...full, workflows: 'write' }, allEvents = [...events, 'check_run', 'status', 'workflow_run'];
  const app = { slug: 'fixture-app', html_url: 'https://github.com/apps/fixture-app', owner: { login: 'fixture', type: 'Organization' },
    permissions: { ...full, statuses: 'read', actions: undefined }, events: ['issues', 'pull_request'] };
  const installations = [{ id: 7, account: { id: 10, login: 'fixture', type: 'Organization' }, repository_selection: 'all',
    permissions: { ...full, actions: 'read' }, events: ['issues', 'pull_request', 'issue_comment'] },
    { id: 8, account: { id: 20, login: 'paused', type: 'Organization' }, repository_selection: 'selected', suspended_at: '2026-01-01', permissions: {}, events: [] }];
  let failInstallations = false;
  const github = createServer((req, res) => {
    const url = new URL(req.url, 'http://fake'); res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/app') return res.end(JSON.stringify(app));
    if (url.pathname === '/app/installations') {
      if (failInstallations) { res.statusCode = 503; return res.end('{}'); }
      return res.end(JSON.stringify(url.searchParams.get('page') === '1' ? installations : []));
    }
    if (url.pathname === '/app/installations/7/access_tokens') return res.end(JSON.stringify({ token: 'installation-fixture' }));
    if (url.pathname === '/installation/repositories') return res.end(JSON.stringify({ repositories: [101, 202].map(id => ({ id, full_name: `fixture/project-${id}`, private: true, owner: { id: 10, login: 'fixture' } })) }));
    res.statusCode = 404; res.end('{}');
  });
  github.listen(0, '127.0.0.1'); await once(github, 'listening');
  const h = await harness(undefined, undefined, store => ({ installations: new InstallationSync(store, `http://127.0.0.1:${github.address().port}`) }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const a = await account(admin, { name: 'Department App', type: 'github_app', app_id: '123', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token: undefined });
    await admin('/api/installations/sync', 'POST', {}); await repository(admin, a.id, '101');
    // A new App project starts with Actions failure handling on (#851); this test reads its gaps while it is off.
    expect((await admin('/api/repositories/101/policy', 'PATCH', { actions_failures_enabled: false })).status).toBe(200);
    await page.goto(h.admin); await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('link', { name: '全局设置', exact: true }).click(); await page.locator('.project-nav').getByRole('link', { name: '机器人账号', exact: true }).click();
    const accountRow = page.locator('.row', { hasText: 'Department App' }); await accountRow.getByRole('button', { name: '检查权限和事件订阅', exact: true }).click();
    const result = accountRow.locator('.permission-result');
    await expect(result).toContainText('Actions：改为「Read and write」（当前「No access」）');
    await expect(result).toContainText('Commit statuses：改为「Read and write」（当前「Read-only」）');
    await expect(result).toContainText('Subscribe to events：勾选 Issue comment、Pull request review、Pull request review comment');
    await expect(result).not.toContainText('第 2 步'); await expect(result).not.toContainText('fixture：');
    await expect(result.getByRole('link', { name: '前往接受' })).toHaveCount(0);
    const settingsLink = result.getByRole('link', { name: '打开 App 的 Permissions & events' });
    await expect(settingsLink).toHaveAttribute('href', 'https://github.com/organizations/fixture/settings/apps/fixture-app/permissions');
    for (const [width, height] of [[1365, 900], [390, 844]]) {
      await page.setViewportSize({ width, height }); await result.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // CI workflow changes and Actions failure analysis need more than the baseline; that is listed without failing it.
    await expect(result).toContainText('Workflows：改为「Read and write」（当前「No access」），CI 工作流改动需要');
    await expect(result).toContainText('Subscribe to events：勾选 Workflow run，Actions 失败分析需要');
    // Workflow run sits next to the Workflows line but needs only Actions read.
    await expect(result).toContainText('这是事件订阅，不是 Workflows 权限：GitHub 只要求 App 至少有 Actions「Read-only」');
    // App completeness is independent of installations that have not yet accepted its permissions or events.
    app.permissions = full; app.events = events; await accountRow.getByRole('button', { name: '重新检查', exact: true }).click();
    await expect(result).toContainText('检视和开发所需的 App 权限和事件订阅齐全。'); await expect(result).toContainText('勾选 Workflow run');
    app.permissions = everything; app.events = allEvents; await accountRow.getByRole('button', { name: '重新检查', exact: true }).click();
    await expect(result).toContainText('App 权限和事件订阅齐全，覆盖全部功能。'); await expect(result).not.toContainText('安装'); await expect(settingsLink).toBeVisible();
    await page.setViewportSize({ width: 1365, height: 900 }); await page.goto(h.admin + '/#/settings/projects');
    await expect(page.getByRole('button', { name: '检查接入', exact: true })).toHaveCount(0);
    const row = id => page.locator(`.global-project-row[data-repository-id="${id}"]`), message = page.locator('#message'), chip = id => row(id).locator('[data-permission]');
    const sync = page.getByRole('button', { name: '同步安装列表', exact: true });
    await sync.click(); await expect(message).toContainText('权限和事件订阅并非全部正常。');
    await expect(message).toContainText('fixture（安装 7）：Actions 需要「Read and write」，现在「Read-only」（影响发版本、触发 Actions 工作流）');
    await expect(message).toContainText('未订阅事件 Pull request review（影响检视、开发）'); await expect(message).toContainText('未订阅事件 Check run（影响控制台检查状态展示）'); await expect(message).toContainText('未订阅事件 Workflow run（影响 Actions 失败分析）');
    await expect(message).not.toContainText('paused');
    for (const id of ['101', '202']) {
      await expect(chip(id)).toHaveText('权限不足 · 事件未订阅'); await expect(chip(id).locator('svg.status-icon')).toBeVisible();
      await expect(chip(id)).toHaveAttribute('title', /Actions 需要.*Workflows 需要.*Pull request review comment.*Workflow run/);
    }
    // Every gap opens with what is missing, how to fix it and what it stops, including features that are off.
    await chip('101').click();
    const gapsView = page.locator('dialog.access-dialog'), items = gapsView.locator('.access-gaps > li');
    await expect(gapsView.getByRole('heading', { name: '权限与事件缺口 · fixture/project-101' })).toBeVisible(); await expect(items).toHaveCount(7);
    await expect(items.nth(1)).toContainText('Workflows 需要「Read and write」，现在「No access」');
    await expect(items.nth(1)).toContainText('把 Workflows 设为「Read and write」并保存；新增权限要由安装所有者（fixture）在 GitHub 的安装设置里接受');
    await expect(items.nth(1)).toContainText('CI 工作流改动（手动使用时）：推不了改动 .github/workflows 的 bot 分支，这类 PR 开不出来');
    // #1072: a project that cannot write Actions cannot start workflows either; it has no switch, so it reads as manual use.
    await expect(items.nth(0)).toContainText('触发 Actions 工作流（手动使用时）：定时任务、管理助手和飞书群触发不了工作流');
    await expect(items.nth(4)).toContainText('未订阅事件 Check run');
    await expect(items.nth(6)).toContainText('默认分支和版本标签上的失败运行不会生成排查事件。涉及：Actions 失败分析（未开启）');
    await expect(items.nth(6)).toContainText('勾选 Workflow run 并保存。这是事件订阅，不是 Workflows 权限');
    for (const [width, height] of [[1365, 900], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await items.nth(0).evaluate(node => node.scrollIntoView({ block: 'start' }));
      expect(await gapsView.evaluate(view => view.scrollWidth <= view.clientWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1365, height: 900 }); await gapsView.getByRole('button', { name: '关闭', exact: true }).click(); await expect(gapsView).toBeHidden();
    app.events = ['issues', 'pull_request']; await sync.click();
    await expect(message).toContainText('App 定义仍有缺口，请到「全局设置 → 机器人账号」查看。');
    app.events = allEvents; installations[0].permissions = everything; await sync.click();
    await expect(chip('101')).toHaveText('事件未订阅');
    await row('101').getByRole('link', { name: /项目设置/ }).click();
    await expect(page.locator('#console-permission [data-permission]')).toHaveText('事件未订阅');
    await expect(page.locator('#console-permission [data-permission]')).toHaveAttribute('title', /Pull request review comment.*Workflow run/);
    await expect(page.locator('.project-head h1')).toHaveText('基本设置');
    await expect(page.locator('.project-head [data-permission]')).toHaveCount(0);
    await expect(page.locator('#console-project-header .workbench-tabs')).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.goto(h.admin + '/#/projects/101/overview');
    await expect(page.getByTestId('project-role-board')).toBeVisible();
    await expect(page.locator('#console-permission [data-permission]')).toHaveText('事件未订阅');
    await expect(page.locator('.project-head [data-permission]')).toHaveCount(0);
    await expect(page.locator('.workbench-top .workbench-tabs')).toBeVisible();
    await expect(page.locator('.workbench-tab-count').first()).toHaveText(/\d+/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.goto(h.admin + '/#/settings/projects');
    installations[0].events = allEvents; await sync.click();
    await expect(message.locator('span')).toHaveText('安装列表已同步，1 个安装的权限和事件订阅都正常。');
    await expect(message.locator('span')).toHaveClass('view-success');
    // #977: a fresh empty reading names its state on the settings table too, instead of leaving an empty cell.
    await expect(chip('101')).toHaveText('正常'); await expect(chip('202')).toHaveText('正常');
    // Without workflow_run both rows are flagged; switching the feature on only raises that row from blue to amber.
    installations[0].events = [...events, 'check_run', 'status'];
    expect((await admin('/api/repositories/101/policy', 'PATCH', { actions_failures_enabled: true })).status).toBe(200);
    await sync.click(); await expect(message).toContainText('未订阅事件 Workflow run（影响 Actions 失败分析）');
    await expect(chip('101')).toHaveText('事件未订阅'); await expect(chip('101')).toHaveClass(/status-warning/);
    await expect(chip('202')).toHaveText('事件未订阅'); await expect(chip('202')).toHaveClass(/status-info/);
    await chip('101').click(); await expect(items).toHaveCount(1); await expect(items.first()).toContainText('涉及：Actions 失败分析（已开启）');
    await gapsView.getByRole('button', { name: '关闭', exact: true }).click();
    for (const [width, height] of [[1365, 900], [390, 844]]) {
      await page.setViewportSize({ width, height }); await row('101').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1365, height: 900 });
    installations[0].events = allEvents; await sync.click();
    await expect(message.locator('span')).toHaveText('安装列表已同步，1 个安装的权限和事件订阅都正常。'); await expect(chip('101')).toHaveText('正常');
    // A failed account sync cannot turn cached grants into an all-normal conclusion.
    failInstallations = true; await sync.click();
    await expect(message).toContainText('部分账号同步失败：Department App（github_http_503）');
    await expect(message).toContainText('因此还不能判断全部安装的权限和事件订阅是否正常。');
    // #527: the same widget is drawn on the account row and in the wizard. Its words come from static/i18n.js now, so an
    // English console reads the button, the report I/O and the feature names in English — the App definition is put back
    // to the gap state so the report keeps exercising its branches.
    app.permissions = { ...full, statuses: 'read', actions: undefined }; app.events = ['issues', 'pull_request'];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/settings/accounts');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const englishRow = page.locator('.row', { hasText: 'Department App' });
    await englishRow.getByRole('button', { name: 'Check permissions and events', exact: true }).click();
    const englishResult = englishRow.locator('.permission-result');
    await expect(englishResult).toContainText('Actions: set to "Read and write" (currently "No access")');
    await expect(englishResult).toContainText('Subscribe to events: tick Issue comment, Pull request review, Pull request review comment');
    // A feature gap usually names one feature, so the sentence has to read as well for one as for many.
    await expect(englishResult).toContainText('Workflows: set to "Read and write" (currently "No access"); needed for CI workflow changes');
    await expect(englishResult).toContainText('This is an event subscription, not the Workflows permission');
    await expect(englishResult).toContainText("Open the App's Permissions & events");
    expect(cjkWords(await englishResult.innerText()), 'Chinese text left in the English permission report').toEqual([]);
    // The wizard's "使用已登记的 App" card draws the same component with its own phrase for the button's subject. The
    // wizard chrome around it is another slice of #527 and stays Chinese; the widget's own words do not.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/settings/onboarding/1');
    const wizardRow = page.locator('#onboarding-panel .row').filter({ has: page.locator('.permission-check') }).first();
    await expect(wizardRow).toBeVisible();
    await expect(wizardRow.getByRole('button', { name: 'Check permissions and events', exact: true })).toBeVisible();
    await wizardRow.locator('.permission-check button').first().click();
    const wizardResult = wizardRow.locator('.permission-result');
    await expect(wizardResult).toContainText('Actions: set to "Read and write" (currently "No access")');
    await expect(wizardResult).toContainText('needed for CI workflow changes');
    await expect(wizardResult).toContainText("needed for Actions failure analysis. This is an event subscription, not the Workflows permission");
    expect(cjkWords(await wizardResult.innerText()), 'Chinese text left in the English wizard report').toEqual([]);
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(wizardResult).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow in the wizard with the report open at ${width}px`).toBe(true);
      expect(cjkWords(await wizardResult.innerText()), `Chinese text left in the wizard report at ${width}px`).toEqual([]);
    }
    // #527: the check's failure branch was the last place the widget interpolated readErrorText(), so an English
    // console read one English sentence with a Chinese clause inside it. Each kind the widget can name is a dictionary
    // sentence now; the captures are taken before the assertions so a red run still writes the before images.
    const englishFailures = [
      { name: 'network', fulfil: route => route.abort('connectionrefused'),
        sentence: 'Check failed: the network request failed, try again shortly' },
      { name: 'gateway-500', fulfil: route => route.fulfill({ status: 500, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }),
        sentence: 'Check failed: the gateway answered 500 · an error page with no reason; try again shortly, and ask an administrator to check the service log if it keeps happening' },
      { name: 'authorization-changed', fulfil: route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"authorization_changed"}' }),
        sentence: 'Check failed: your permissions changed; refresh the page and retry with your current permissions' },
    ];
    await page.goto(h.admin + '/#/settings/accounts');
    await page.locator('.row .permission-check').first().waitFor();
    const checkRow = page.locator('.row', { hasText: 'Department App' });
    const failures = [];
    for (const failure of englishFailures) {
      await page.route('**/api/accounts/*/permissions', failure.fulfil);
      await checkRow.locator('.permission-check button').first().click();
      const box = checkRow.locator('.permission-result');
      await expect(box.locator('p.view-error')).toBeVisible();
      failures.push({ failure, text: await box.innerText() });
      for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
        await page.setViewportSize({ width, height }); await box.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow in the ${failure.name} strip at ${width}px`).toBe(true);
      }
      await page.unroute('**/api/accounts/*/permissions', failure.fulfil);
    }
    for (const { failure, text } of failures) {
      expect(text, `the English failure sentence for ${failure.name}`).toBe(failure.sentence);
      expect(cjkWords(text), `Chinese text left in the English failure sentence for ${failure.name}`).toEqual([]);
      expect(text, `a raw i18n key left in the ${failure.name} sentence`).not.toContain('permissions.check_failed');
    }
    expect(errors).toEqual([]);
  } finally { await h.stop(); await new Promise(resolve => github.close(resolve)); }
});

// #527: moving the failure line into the dictionary must not reword the Chinese console. Each sentence below is the
// string the old code produced by concatenating 检查失败： with what readErrorText() or api() answered.
test('中文界面的权限检查失败句逐字不变', async ({ page }) => {
  const h = await harness();
  try {
    const { admin, password } = await setup(h), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await account(admin, { name: 'Department App', type: 'github_app', app_id: '123', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token: undefined });
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('link', { name: '全局设置', exact: true }).click();
    await page.locator('.project-nav').getByRole('link', { name: '机器人账号', exact: true }).click();
    const row = page.locator('.row', { hasText: 'Department App' });
    const zhFailures = [
      { name: 'network', fulfil: route => route.abort('connectionrefused'),
        sentence: '检查失败：网络连接失败，请稍后重试' },
      { name: 'gateway-500', fulfil: route => route.fulfill({ status: 500, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }),
        sentence: '检查失败：500 · 入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。' },
      { name: 'authorization-changed', fulfil: route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"authorization_changed"}' }),
        sentence: '检查失败：权限已变化，请刷新页面后按当前权限重试。' },
    ];
    for (const failure of zhFailures) {
      await page.route('**/api/accounts/*/permissions', failure.fulfil);
      await row.locator('.permission-check button').first().click();
      await expect(row.locator('.permission-result'), `the Chinese failure sentence for ${failure.name}`).toHaveText(failure.sentence);
      await page.unroute('**/api/accounts/*/permissions', failure.fulfil);
    }
  } finally { await h.stop(); }
});
