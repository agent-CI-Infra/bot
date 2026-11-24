// #934, #1133, #1269: unified repository onboarding in the Management Assistant, at 1440 and at 390.
// An administrator with zero started projects opens 开始接入 (and legacy #/onboarding/103), analyzes the unstarted
// repository read-only in #/management, files a start request, has a super administrator approve in 待处理 (#/inbox),
// applies confirmed settings and creates a CI workflow PR development task directly without a confirmation card, verifies
// project basic settings has no duplicate onboarding entry, and picks onboarding / gate / Actions / Issue prompts from
// the assistant's recommendation list on #/projects/103/management. GitHub and the model are local fixtures.
import { test, expect } from '@playwright/test';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';
import { installed, repositoryRoutes, provider, call, assistantModel } from '../../fixtures/onboarding-fixture.mjs';

const toolResults = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));

const script = (context, body) => {
  const text = String(context.request ?? '');
  const steps = body.messages.filter(m => m.role === 'assistant').length;
  const obs = toolResults(body);
  if (text.includes('确认按推荐方案启动')) {
    return [
      call(0, ['start_repository', { action: 'start', repository: 'fixture/project-103', capability_ceiling: 'develop',
        summary: 'Node.js 命令行工具（`npm test`）；计划开启 `develop` 能力上限、新建 `kind/bug` 标签并补齐 `.github/workflows/ci.yml`。' }]),
      { role: 'assistant', content: '所属组织尚未加入受信组织，已为你提交启动申请，等待超级管理员在控制台「待处理」或飞书私聊同意后再继续配置。' },
    ];
  }
  if (text.includes('超级管理员已同意启动')) {
    if (steps === 0) return [call(0, ['management_query', { operation: 'get_effective_config', target: { project_id: '103' }, arguments: {} }])];
    if (steps === 1) {
      const cfg = obs.at(-1);
      return [call(1,
        ['management_command', { operation: 'project.update', target: { project_id: '103' }, expected_revision: cfg.revision,
          arguments: { test_command: 'npm test' } }],
        ['github_write', { repository: 'fixture/project-103', method: 'POST', path: '/labels', key: 'e2e-kind-bug',
          body: { name: 'kind/bug', color: 'd73a4a', description: '缺陷' } }],
        ['github_write', { repository: 'fixture/project-103', method: 'POST', path: '/labels', key: 'e2e-developing',
          body: { name: 'bot-developing', color: 'fbca04', description: 'Developing' } }],
        ['github_write', { repository: 'fixture/project-103', method: 'POST', path: '/labels', key: 'e2e-developed',
          body: { name: 'bot-developed', color: '0e8a16', description: 'Developed' } }])];
    }
    if (steps === 2) {
      const policyReceipt = obs.find(o => o.operation === 'project.update');
      return [call(2,
        ['management_command', { operation: 'task.create', target: { project_id: '103' }, expected_revision: policyReceipt.after_revision,
          arguments: { intent: 'development', request: '为 PR 增加 npm test 自动检查工作流',
            contract: { goal: '在 .github/workflows/ci.yml 中增加 PR 自动运行 npm test 的检查', scope: ['.github/workflows/ci.yml'],
              criteria: ['改动经 bot PR 交付，由人检视并合并', 'PR 触发 npm test'], endpoint: 'reviewable_pull_request' } } }])];
    }
    return [{ role: 'assistant', content: '已保存测试命令 `npm test`（待首次运行验证）、创建标签并直接创建修改 `.github/workflows/ci.yml` 的开发 PR 任务。' }];
  }
  if (steps === 0) {
    return [call(0,
      ['management_query', { operation: 'list_projects', target: {}, arguments: {} }],
      ['github_read', { repository: 'fixture/project-103', path: '/readme' }],
      ['github_read', { repository: 'fixture/project-103', path: '/labels' }])];
  }
  if (steps === 1) {
    return [call(1, ['send_message', { text: '已读完 README 与现有标签，正在整理仓库画像。' }])];
  }
  return [{ role: 'assistant', content: [
    '### 仓库画像',
    '- **定位与技术栈**：Node.js 命令行工具（来源：`README.md`、`/labels`），测试命令为 `npm test`，目前只有 `bug` 标签，尚无 PR CI 工作流。',
    '- **能力上限说明**：`read` 只读问答；`comment` 检视评论与分类打标；`develop` 可在机器人分支开发并提 PR。',
    '',
    '### 关键选择与推荐',
    '1. **能力上限**：推荐 `develop`（可开发简单问题并提交 CI 工作流 PR）。',
    '2. **分类标签**：推荐新建 `kind/bug`（保留现有 `bug`）。',
    '3. **CI 工作流**：推荐在项目启动后由 bot 提交 `.github/workflows/ci.yml` PR。',
    '',
    '请确认是否按上述推荐项启动并配置？',
  ].join('\n') }];
};

for (const width of [1440, 390]) test(`在 ${width} 宽度下通过管理助手完成仓库接入、启动审批与 CI 任务创建 (#1133, #1269)`, async ({ page, browser }) => {
  test.setTimeout(120_000);
  const cleanups = [], t = { after: fn => cleanups.push(fn) }, errors = [];
  const f = await identityFixture(undefined, { github: true });
  const viewport = { width, height: width === 390 ? 844 : 900 };
  const shot = async (target, name) => {
    expect(await target.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await target.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  };
  page.on('pageerror', error => errors.push(error.message));
  try {
    // Zero started projects for this GitHub user: only unstarted installed repository 103 in an untrusted organization.
    installed(f, '103'); f.state.accessible = ['103'];
    const routes = repositoryRoutes(f);
    await assistantModel(f, await provider(t, script));
    Object.assign(f.state, { owner: false, permission: 'admin' });

    await page.setViewportSize(viewport);
    await page.goto(f.h.admin);
    await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await expect(page.locator('.identity-pending-repos').getByRole('link', { name: '开始接入 fixture/project-103' })).toHaveAttribute('href', '#/management');

    // Legacy #/onboarding/103 redirects smoothly to #/management and prefills the repository onboarding prompt.
    await page.goto(f.h.admin + '/#/onboarding/103');
    await expect(page).toHaveURL(/#\/management$/);
    const chat = page.locator('#management-chat');
    const composer = chat.getByLabel('管理消息', { exact: true });
    await expect(composer).toHaveValue(/^请帮我接入已安装仓库 fixture\/project-103：/);

    // Project list entry also navigates to #/management with the onboarding prompt prefilled and focused.
    await page.goto(f.h.admin + '/#/projects');
    const pending = page.locator('[data-key="pending:103"]');
    await expect(pending.getByRole('link', { name: '开始接入 fixture/project-103' })).toBeVisible();
    await expect(pending.getByRole('button', { name: '复制提醒' })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('接入门禁');
    await shot(page, '01-projects');
    await pending.getByRole('link', { name: '开始接入 fixture/project-103' }).click();
    await expect(page).toHaveURL(/#\/management$/);
    await expect(composer).toHaveValue(/^请帮我接入已安装仓库 fixture\/project-103：/);
    await expect(composer).toBeFocused();
    await shot(page, '02-prefilled');

    // Turn 1: read-only analysis, progress message, and structured profile + recommended choices.
    await chat.getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat).toContainText('已读完 README 与现有标签，正在整理仓库画像。');
    await expect(chat).toContainText('请确认是否按上述推荐项启动并配置？');
    await shot(page, '03-analysis');

    // Turn 2: confirm choices -> files start request for super administrator approval.
    await composer.fill('确认按推荐方案启动（能力上限 develop），新建 kind/bug 标签并补齐 CI 工作流');
    await chat.getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat).toContainText('已为你提交启动申请，等待超级管理员');
    await shot(page, '04-requested');

    // Reload preserves the conversation and step state.
    await page.reload();
    await expect(chat).toContainText('已为你提交启动申请，等待超级管理员');

    // Super administrator approves in 待处理 (#/inbox) of their own session.
    const adminContext = await browser.newContext({ viewport }), adminPage = await adminContext.newPage();
    await adminPage.goto(f.h.admin + '/#/inbox');
    await adminPage.getByLabel('用户名', { exact: true }).fill('administrator');
    await adminPage.getByLabel('密码', { exact: true }).fill(f.password);
    await adminPage.getByRole('button', { name: '登录', exact: true }).click();
    const requestCard = adminPage.getByTestId('start-requests').locator('.start-request');
    await expect(requestCard).toContainText('fixture/project-103');
    await expect(requestCard).toContainText('可开发并开 PR');
    await expect(requestCard).toContainText('@administrator 于');
    await requestCard.locator('.start-request-profile summary').click();
    await expect(requestCard.locator('.start-request-profile')).toContainText('Node.js 命令行工具');
    await requestCard.getByRole('button', { name: '同意…' }).click();
    await expect(requestCard.locator('select[name=level]')).toHaveValue('develop');
    await shot(adminPage, '05-inbox-request');
    await requestCard.getByRole('button', { name: '确认同意并启动' }).click();
    await expect(adminPage.getByTestId('start-requests')).toHaveCount(0);
    await adminContext.close();

    // Turn 3: apply policy + labels and create the CI workflow PR development task directly without a confirmation card.
    await composer.fill('超级管理员已同意启动，请继续应用确认的配置并提交 CI 工作流变更开发任务');
    await chat.getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat).toContainText('直接创建修改 .github/workflows/ci.yml 的开发 PR 任务');
    expect(routes.created.map(write => write.body.name)).toEqual(['kind/bug', 'bot-developing', 'bot-developed']);
    await expect(chat.locator('.management-workflow-confirm')).toHaveCount(0);

    const createdReceipt = chat.locator('.management-receipt').filter({ hasText: '操作 创建任务' });
    await expect(createdReceipt).toContainText('已执行');
    const createdCommand = f.h.store.get("SELECT * FROM management_commands WHERE operation='task.create' AND project_id='103'");
    await expect(createdReceipt.locator('.management-receipt-meta')).toContainText('你');
    await expect(createdReceipt.locator('.management-receipt-meta')).toContainText('fixture/project-103');
    await expect(createdReceipt.locator('.management-receipt-meta')).not.toContainText(createdCommand.principal_id);
    await expect(createdReceipt.locator('.management-receipt-change')).toContainText('创建任务');
    await expect(createdReceipt.locator('.management-receipt-change')).toContainText('为 PR 增加 npm test 自动检查工作流');
    await expect(createdReceipt.locator('.management-receipt-change')).not.toContainText('目标 103');
    await expect(createdReceipt).toContainText('这次操作没有改变配置版本');
    await expect(createdReceipt).not.toContainText(`版本 ${createdCommand.before_revision.slice(0, 12)} → ${createdCommand.after_revision.slice(0, 12)}`);
    expect(f.h.store.get("SELECT count(*) AS n FROM tasks WHERE repository_id='103'").n).toBe(1);
    const createdTask = f.h.store.get("SELECT input FROM tasks WHERE repository_id='103'");
    expect(JSON.parse(createdTask.input).workflow_changes).toBeUndefined();
    await shot(page, '07-created-receipt');

    // Reloading preserves the created receipt cleanly.
    await page.reload();
    await expect(chat.locator('.management-receipt').filter({ hasText: '操作 创建任务' })).toContainText('已执行');

    // Started project's basic settings no longer duplicates 仓库接入; onboarding and common actions live in the assistant's recommendation list.
    await page.goto(f.h.admin + '/#/projects/103/basic');
    await expect(page.locator('#project-page')).toContainText('fixture/project-103');
    await expect(page.getByRole('link', { name: /仓库接入/ })).toHaveCount(0);
    await expect(page.locator('#project-page')).not.toContainText('仓库接入');
    const overviewHeading = page.locator('#project-page').getByRole('heading', { name: '项目概况', exact: true });
    await expect(overviewHeading).toBeVisible();
    expect(await overviewHeading.evaluate(el => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    })).toBe(true);
    await shot(page, '08-project-basic');

    await page.goto(f.h.admin + '/#/projects/103/management');
    await expect(page).toHaveURL(/#\/projects\/103\/management$/);
    const welcomeList = chat.getByTestId('management-recommendations');
    await expect(welcomeList).toBeVisible();
    await expect(chat.getByTestId('management-recommendation-bar')).toBeHidden();
    for (const title of ['运行仓库接入助手', '优化门禁', '分析 Actions 运行', '分析 Issue']) {
      await expect(welcomeList.getByRole('button', { name: new RegExp(title) })).toBeVisible();
    }
    await shot(page, '09-project-recommendations');
    await welcomeList.getByRole('button', { name: /运行仓库接入助手/ }).click();
    await expect(composer).toHaveValue(/^请帮我核对并优化仓库 fixture\/project-103 的接入配置：/);
    await expect(composer).toBeFocused();
    await welcomeList.getByRole('button', { name: /优化门禁/ }).click();
    await expect(composer).toHaveValue(/评估并优化仓库 fixture\/project-103 的 CI 门禁.*layered-ci-gates/);
    await welcomeList.getByRole('button', { name: /分析 Actions 运行/ }).click();
    await expect(composer).toHaveValue(/分析仓库 fixture\/project-103 的 GitHub Actions 运行/);
    await welcomeList.getByRole('button', { name: /分析 Issue/ }).click();
    await expect(composer).toHaveValue(/分析仓库 fixture\/project-103 的 Issue #/);

    expect(errors).toEqual([]);
  } finally { await f.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
});
