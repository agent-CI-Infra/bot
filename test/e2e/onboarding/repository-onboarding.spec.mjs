// #934: scenario A of #929 in the browser, at 1440 and at 390. An administrator of a repository whose organization is not
// trusted opens 开始接入, the assistant reads the repository and asks; its questions are a selectable card in the conversation
// and the answers bring a plan; confirming it asks a super administrator, who approves in 待处理; the plan is applied with
// receipts and a failed item is retried on the completion page. A reload, and at 1440 a second device, come back to the same
// state. GitHub and the model are local fixtures.
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { identityFixture } from '../../fixtures/identity-fixture.mjs';
import { installed, repositoryRoutes, provider, call, assistantModel } from '../../fixtures/onboarding-fixture.mjs';

const output = '.tmp/repository-onboarding-934';
// A 40-character unbroken ASCII run in the second question makes a card that cannot be wider than a phone.
const longAscii = 'kindbugkindfeaturekinddocskindchore'.padEnd(40, 'x');
const questions = [
  { id: 'level', question: '要不要让 bot 自动开发简单问题？', options: [{ label: '先只检视和打标签', description: '能力上限「可评论和打标签」' }, { label: '也开发简单问题', description: '能力上限「可开发并开 PR」' }],
    recommended: '先只检视和打标签', reason: '仓库还没有 CI，先看检视的质量。' },
  { id: 'labels', question: '分类标签怎么定？' + longAscii, options: [{ label: '用 kind/ 前缀', description: '新建 kind/bug、kind/feature' }, { label: '沿用现有标签', description: '现在只有 bug' }],
    recommended: '用 kind/ 前缀', reason: '现有标签不够用来分类。' },
];
const plan = {
  profile: { summary: '一个 Node.js 命令行工具。README 写明用 `npm test` 跑测试；只有一个定时的 Nightly 工作流，PR 很少有人检视。', stack: ['Node.js', 'npm'],
    collaboration: '维护者直接开 PR，少有检视。', ci: '只有 nightly.yml，每天 UTC 16:00 定时运行。', labels: '只有 bug 一个标签。', sources: ['README.md', '/labels', '.github/workflows/nightly.yml', '/actions/runs'] },
  capability_ceiling: { value: 'comment', reason: '先只检视和打标签。' },
  test_command: { value: 'npm test', reason: 'README 写明。' },
  labels: { items: [{ name: 'kind/bug', color: 'd73a4a', description: '缺陷', action: 'create' }, { name: 'kind/feature', color: '0e8a16', description: '新功能', action: 'create' }], reason: '用 kind/ 前缀分类。' },
  conventions: { label_usage: 'kind/bug 表示缺陷，kind/feature 表示新功能。', review_focus: '关注命令行参数的兼容性。' },
  // #1072: a recommendation only; it is never one of the changes and never in the way of the start.
  scheduled_dispatch: { workflows: [{ path: '.github/workflows/nightly.yml', cron: '0 16 * * *', delay: '最近 5 次平均晚 7 小时' }], reason: 'Nightly 的定时运行经常晚好几个小时，建议改由 bot 按时触发。' },
};
// The first message reads the repository, reports progress and asks; the answers bring the plan.
const script = context => String(context.request).startsWith('我的回答') ? [
  call(0, ['propose_onboarding_plan', plan]),
  { role: 'assistant', content: '方案草稿已保存为第 1 版：先只检视和打标签，新建 `kind/bug` 和 `kind/feature`。请在「方案」里核对后确认。' },
] : [
  call(0, ['github_read', { repository: 'fixture/project-103', path: '/readme' }]),
  call(1, ['send_message', { text: '已读完 README，正在整理仓库画像。' }]),
  call(2, ['ask_onboarding_questions', { questions }]),
  { role: 'assistant', content: '**仓库画像**：一个 Node.js 命令行工具，用 `npm test` 跑测试。请先回答两个问题，我再给出方案。' },
];

for (const width of [1440, 390]) test(`场景 A 在 ${width} 宽度下走完接入向导：分析、回答、确认申请、超管同意、完成页重试`, async ({ page, browser }) => {
  test.setTimeout(120_000);
  const cleanups = [], t = { after: fn => cleanups.push(fn) }, errors = [];
  const f = await identityFixture(undefined, { github: true });
  const viewport = { width, height: width === 390 ? 844 : 900 };
  mkdirSync(output, { recursive: true });
  const shot = async (target, name) => {
    if (width === 390) expect(await target.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // From the top with nothing focused, so the sticky sidebar and the skip link sit where a reader first sees them.
    await target.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
    await target.screenshot({ path: `${output}/${width}-${name}.png`, fullPage: true });
  };
  page.on('pageerror', error => errors.push(error.message));
  try {
    installed(f, '103'); f.state.accessible = ['101', '103'];
    const routes = repositoryRoutes(f), answer = f.state.route; let labelsReadable = false;
    // The first read of the labels fails, so the completion page has a failed item to retry.
    f.state.route = (path, method, body, send) => !labelsReadable && method === 'GET' && /\/labels(\?|$)/.test(path) ? (send({ message: 'Resource not accessible by integration' }, 403), true) : answer(path, method, body, send);
    await assistantModel(f.admin, await provider(t, script));
    // The GitHub user administers the repository; the organization is not trusted.
    Object.assign(f.state, { owner: false, permission: 'admin' });
    await page.setViewportSize(viewport);
    await page.goto(f.h.admin); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
    await expect(page.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
    await expect(page.locator('.identity-pending-repos').getByRole('link', { name: '开始接入 fixture/project-103' })).toHaveAttribute('href', '#/onboarding/103');

    // The project list carries one entry for the repository; there is no gate entry anywhere.
    await page.goto(f.h.admin + '/#/projects');
    const pending = page.locator('[data-key="pending:103"]');
    await expect(pending.getByRole('link', { name: '开始接入 fixture/project-103' })).toBeVisible();
    await expect(pending.getByRole('button', { name: '复制提醒' })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('接入门禁');
    await shot(page, '01-projects');
    await pending.getByRole('link', { name: '开始接入 fixture/project-103' }).click();

    const phase = page.getByTestId('onboarding-phase'), next = page.getByTestId('onboarding-next');
    await expect(page.getByRole('heading', { name: 'fixture/project-103', level: 1 })).toBeVisible();
    await expect(phase).toHaveText('未开始');
    await expect(next).toContainText('点「开始分析」，助手只读分析仓库');
    await expect(page.locator('#console-page')).not.toContainText('接入门禁');
    await shot(page, '02-start');
    await next.getByRole('button', { name: '开始分析' }).click();

    // The analysis: a progress message and the answer stream into the conversation, then the questions wait for answers.
    await expect(phase).toHaveText('待回答');
    await expect(next).toContainText('回答助手的问题');
    const chat = page.locator('.ro-chat');
    await expect(chat).toContainText('已读完 README，正在整理仓库画像。');
    await expect(chat).toContainText('请先回答两个问题');
    await expect(chat.locator('.ro-reads summary')).toHaveText('读取与操作 2 步');
    await shot(page, '03-analysis');
    // The questions are a card under the asking turn's assistant replies; the side panel and the phone tab are gone.
    const questionCard = chat.locator('.ro-question-card');
    const questionTurn = chat.locator('.ro-turn').filter({ has: page.locator('.ro-question-card') });
    await expect(questionTurn).toHaveCount(1);
    await expect(questionTurn.locator('.ro-replies')).toContainText('请先回答两个问题');
    await expect(questionTurn).toContainText('要不要让 bot 自动开发简单问题？');
    await expect(questionTurn).toContainText(longAscii);
    expect(await questionTurn.evaluate(turn => {
      const replies = turn.querySelector('.ro-replies'), card = turn.querySelector('.ro-question-card');
      return !!replies && !!card && !!(replies.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await expect(page.locator('.ro-panel[data-panel=questions]')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /问题/ })).toHaveCount(0);
    if (width === 390) {
      expect(await page.locator('.ro-tabs .ro-tab').allTextContents()).toEqual(['对话', '画像', '方案']);
      await page.getByRole('tab', { name: /画像/ }).click();
      await expect(chat).toBeHidden();
      // If the conversation events have not rebuilt the card yet, the action says what to do instead of doing nothing.
      const events = '**/api/management/conversations/*/events*';
      await page.route(events, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], events: [], has_more: false }) }));
      await page.reload();
      await expect(phase).toHaveText('待回答');
      await expect(questionCard).toHaveCount(0);
      await next.getByRole('button', { name: '去回答问题' }).click();
      await expect(page.locator('.ro-problem')).toContainText('问题卡片还没有读取到');
      await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
      await page.unroute(events);
      await page.reload();
      await expect(questionCard).toBeVisible();
    }
    // 去回答问题 brings the conversation back, scrolls the card into view and focuses the first option of the first question.
    await next.getByRole('button', { name: '去回答问题' }).click();
    if (width === 390) {
      await expect(page.locator('.ro-page')).toHaveAttribute('data-tab', 'chat'); await expect(chat).toBeVisible();
      // The long, unbroken question text wraps instead of widening the conversation or the card.
      const feed = chat.locator('.ro-feed');
      expect(await feed.evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(await feed.evaluate(node => node.clientWidth) + 1);
      expect(await questionCard.evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(await questionCard.evaluate(node => node.clientWidth) + 1);
    }
    await expect(questionCard).toBeInViewport();
    await expect(questionCard.getByRole('radio', { name: /先只检视和打标签/ })).toBeFocused();
    await expect(questionCard.getByRole('radio', { name: /先只检视和打标签/ })).toBeChecked();
    await expect(questionCard).toContainText('推荐理由：仓库还没有 CI，先看检视的质量。');
    await expect(questionCard).toContainText('也开发简单问题');
    await questionCard.getByLabel('第 2 题的补充').fill('标签颜色沿用 GitHub 默认');
    // Repainting the page through its own history toggle keeps the unsent choice and note.
    await page.evaluate(() => document.querySelector('.ro-history-toggle').click());
    await expect(questionCard.getByRole('radio', { name: /先只检视和打标签/ })).toBeChecked();
    await expect(questionCard.getByLabel('第 2 题的补充')).toHaveValue('标签颜色沿用 GitHub 默认');
    await shot(page, '04-questions');
    await questionCard.getByRole('button', { name: '提交回答' }).click();

    // The plan: every item says what changes and where; one is left out before confirming.
    await expect(phase).toHaveText('待确认');
    // The answered card stays in the conversation as a read-only card.
    await expect(questionCard.getByRole('radio').first()).toBeDisabled();
    await expect(questionCard).toContainText('这一组问题已结束');
    await expect(questionCard.getByRole('button', { name: '提交回答' })).toBeHidden();
    if (width === 390) await page.getByRole('tab', { name: /方案/ }).click();
    const planPanel = page.locator('.ro-plan');
    await expect(planPanel.locator('.ro-change')).toHaveCount(5);
    await expect(planPanel.locator('[data-item=start]')).toContainText('确认后向超级管理员申请启动');
    await expect(planPanel.locator('[data-item=start] input')).toBeDisabled();
    await expect(planPanel.locator('[data-item=labels]')).toContainText('在哪里生效：GitHub 标签');
    await planPanel.locator('[data-item=conventions]').getByRole('checkbox').uncheck();
    await expect(planPanel).toContainText('将应用 4 项，共 5 项');
    // The bot-scheduling recommendation sits below the plan, outside its items; before the start it only says what comes next.
    const recommended = planPanel.locator('[data-item=scheduled_dispatch]');
    await expect(recommended).toContainText('用 Bot 定时触发 workflow');
    await expect(recommended).toContainText('.github/workflows/nightly.yml：0 16 * * *，最近 5 次平均晚 7 小时');
    await expect(recommended).toContainText('不随方案应用，也不影响启动项目');
    await expect(recommended).toContainText('项目启动后可以交给管理助手处理');
    await expect(recommended.getByRole('checkbox')).toHaveCount(0);
    // The profile: its own tab on a phone, beside the plan on a desktop.
    if (width === 390) {
      await page.getByRole('tab', { name: /画像/ }).click();
      await expect(page.locator('.ro-profile')).toContainText('一个 Node.js 命令行工具'); await shot(page, '05-profile');
      await page.getByRole('tab', { name: /方案/ }).click();
    } else await expect(page.locator('.ro-profile')).toContainText('维护者直接开 PR');
    await shot(page, '06-plan');
    await planPanel.getByRole('button', { name: '确认并申请启动' }).click();

    // Requested: the start waits for a super administrator; a reload (and another device) shows the same state.
    await expect(phase).toHaveText('已申请（等待超管）');
    await expect(next).toContainText('已向超级管理员申请启动');
    await expect(planPanel.locator('[data-item=start]')).toContainText('等待审批');
    await expect(planPanel.locator('[data-item=conventions]')).toContainText('确认时去掉了这一项。');
    await shot(page, '07-requested');
    // A stored tab from before the change (questions) falls back to the conversation instead of a blank page; the card survives.
    await page.evaluate(() => sessionStorage.setItem('repository-onboarding-tab:103', 'questions'));
    await page.reload();
    await expect(phase).toHaveText('已申请（等待超管）');
    const reloadedCard = page.locator('.ro-chat .ro-question-card');
    await expect(reloadedCard).toBeVisible();
    await expect(reloadedCard).toContainText('这一组问题已结束');
    await expect(reloadedCard.getByRole('radio').first()).toBeDisabled();
    if (width === 390) {
      await expect(page.locator('.ro-page')).toHaveAttribute('data-tab', 'chat');
      await expect(page.locator('.ro-chat')).toBeVisible();
      expect(await page.locator('.ro-tabs .ro-tab').allTextContents()).toEqual(['对话', '画像', '进度']);
    }
    if (width === 1440) {
      const other = await browser.newContext({ viewport }), device = await other.newPage();
      await device.goto(f.h.admin); await device.getByRole('link', { name: '使用 GitHub 登录' }).click();
      await expect(device.getByRole('heading', { name: '我的 GitHub 连接' })).toBeVisible();
      await device.goto(f.h.admin + '/#/onboarding/103');
      await expect(device.getByTestId('onboarding-phase')).toHaveText('已申请（等待超管）');
      await expect(device.locator('.ro-chat')).toContainText('请先回答两个问题');
      await other.close();
    }

    // The super administrator decides in 待处理 of their own session.
    const adminContext = await browser.newContext({ viewport }), adminPage = await adminContext.newPage();
    await adminPage.goto(f.h.admin + '/#/inbox');
    await adminPage.getByLabel('用户名', { exact: true }).fill('administrator'); await adminPage.getByLabel('密码', { exact: true }).fill(f.password);
    await adminPage.getByRole('button', { name: '登录', exact: true }).click();
    const requestCard = adminPage.getByTestId('start-requests').locator('.start-request');
    await expect(requestCard).toContainText('fixture/project-103');
    await expect(requestCard).toContainText('kind/bug、kind/feature');
    await expect(requestCard).toContainText('@administrator 于');
    await requestCard.getByRole('button', { name: '同意…' }).click();
    await expect(requestCard.locator('select[name=level]')).toHaveValue('comment');
    await shot(adminPage, '08-inbox-request');
    await requestCard.getByRole('button', { name: '确认同意并启动' }).click();
    await expect(adminPage.getByTestId('start-requests')).toHaveCount(0);
    await adminContext.close();

    // Back on the requester's page: the project started and the plan was applied; the labels could not be read yet.
    await expect(phase).toHaveText('部分未生效', { timeout: 30_000 });
    const done = page.getByTestId('onboarding-done');
    await expect(done.getByRole('heading', { name: '接入完成，有 1 项没有生效' })).toBeVisible();
    await expect(done.locator('[data-item=start]')).toContainText('超级管理员同意后启动');
    await expect(done.locator('[data-item=test_command]')).toContainText('尚未验证');
    await expect(done.locator('[data-item=labels]')).toContainText('读不到仓库现有的标签');
    await shot(page, '09-done-failed');
    labelsReadable = true;
    await done.locator('[data-item=labels]').getByRole('button', { name: '重试「GitHub 标签」' }).click();
    await expect(phase).toHaveText('完成');
    await expect(done.getByRole('heading', { name: '接入完成', exact: true })).toBeVisible();
    await expect(done.locator('[data-item=labels]')).toContainText('kind/bug 已新建、kind/feature 已新建');
    expect(routes.created.map(write => write.body.name)).toEqual(['kind/bug', 'kind/feature']);
    // The completion page says what the bot does now, how to use it on GitHub and Feishu, and where to change it later.
    await expect(done).toContainText('能力上限「可评论和打标签」');
    await expect(done).toContainText('在 Issue 或 PR 的评论里 @ 这个 GitHub App 的机器人账号');
    await expect(done).toContainText('私聊 bot 等同你在控制台的权限');
    await expect(done.getByRole('link', { name: /监听与触发/ })).toHaveAttribute('href', '#/projects/103/triggers');
    const dispatch = done.locator('[data-item=scheduled_dispatch]');
    await expect(dispatch.getByRole('link', { name: /去定时任务页/ })).toHaveAttribute('href', '#/projects/103/schedules');
    await shot(page, '10-done');
    // 交给管理助手 puts the request in the assistant's composer; the person reads it and sends it themselves.
    await dispatch.getByRole('button', { name: '交给管理助手' }).click();
    const composer = page.getByLabel('管理消息', { exact: true });
    await expect(composer).toHaveValue(/^请为 fixture\/project-103 开启 Bot 定时触发：\.github\/workflows\/nightly\.yml（0 16 \* \* \*）。/);
    await expect(composer).toBeFocused();
    await shot(page, '11-dispatch-to-assistant');

    // The started project offers to run the wizard again from its settings.
    await page.goto(f.h.admin + '/#/projects/103/basic');
    await expect(page.getByRole('link', { name: /重新运行接入向导/ })).toHaveAttribute('href', '#/onboarding/103');
    expect(errors).toEqual([]);
  } finally { await f.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
});
