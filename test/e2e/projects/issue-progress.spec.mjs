import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { consoleSave } from '../helpers/console-save.mjs';

async function fixture() {
  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(undefined, manager), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');
  await admin('/api/repositories/101/policy', 'PATCH', { capability_ceiling: 'develop' });

  const store = h.store;
  const seedIssue = (repo, number, title, state = 'open', at = '2026-11-20T10:00:00.000Z') => {
    store.run(
      `INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,title_at,state_at,draft_at,last_seen)
       VALUES(?,'issue',?,?,?,0,?,?,?,?)`,
      repo, number, title, state, at, at, at, at,
    );
  };

  // #101: pr_opened
  seedIssue('101', 101, 'Fix webhook retry backoff overflow', 'open', '2026-11-20T11:30:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    't-issue-101-dev', '101', 'task.request', 'pr_opened', '开发 Issue #101',
    JSON.stringify({ target: { type: 'issue', number: 101 }, executor_role: 'dev' }),
    JSON.stringify({ pr_number: 205, pr_url: 'https://github.com/org/repo/pull/205' }),
    101, '2026-11-20T11:00:00.000Z', '2026-11-20T11:30:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-issue-101-dev', JSON.stringify(['pull_request']), '2026-11-20T11:00:00.000Z');
  store.run(
    `INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions) VALUES('101',205,'pr-205','999','101','bot/issue-101','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','t-issue-101-dev',0)`,
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES('101','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','ci:unit','unit','completed','success','https://github.com/org/repo/runs/1','2026-11-20T11:31:00.000Z')`,
  );

  // #102: developing
  seedIssue('101', 102, 'Support custom timeout in runner config', 'open', '2026-11-20T11:20:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-issue-102-dev', '101', 'task.request', 'implementing', '开发 Issue #102',
    JSON.stringify({ target: { type: 'issue', number: 102 }, executor_role: 'dev' }),
    102, '2026-11-20T11:10:00.000Z', '2026-11-20T11:20:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-issue-102-dev', JSON.stringify(['pull_request']), '2026-11-20T11:10:00.000Z');

  // #103: needs_information
  seedIssue('101', 103, 'Login page intermittently shows blank card', 'open', '2026-11-20T11:15:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    't-issue-103-rev', '101', 'task.request', 'succeeded', '检视 Issue #103',
    JSON.stringify({ target: { type: 'issue', number: 103 }, executor_role: 'reviewer' }),
    JSON.stringify({
      conclusion: 'needs_information',
      recommendation: '无法根据描述复现，需要浏览器控制台报错与复现账号角色。',
      findings: [{ id: 'F1', format: 'discussion', body: '缺复现步骤', requires_human_decision: true, human_action: '请补充浏览器报错日志和具体账号角色' }],
    }),
    103, '2026-11-20T11:05:00.000Z', '2026-11-20T11:15:00.000Z',
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-issue-103-rev', JSON.stringify(['review']), '2026-11-20T11:05:00.000Z');

  // #104: human_decision_required
  seedIssue('101', 104, 'Migrate auth tokens to short-lived sessions', 'open', '2026-11-20T11:10:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-issue-104-rev', '101', 'review.issue', 'succeeded', '检视 Issue #104',
    JSON.stringify({
      conclusion: 'human_decision_required',
      recommendation: '涉及认证架构变更，建议维护者先确认兼容策略。',
      findings: [{ id: 'F1', format: 'discussion', body: '架构调整', requires_human_decision: true, human_action: '决定是否保留旧长期令牌兼容期（方案 A/B）' }],
    }),
    104, '2026-11-20T11:00:00.000Z', '2026-11-20T11:10:00.000Z',
  );
  store.run(
    `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,thread_key,state,decision,reason,created_at,decided_at)
     VALUES('ev-104','101','k-104','review.published','review','issue',104,'Issue 检视已发布，结论为需要人决定：#104','{}','[]','101:issue:104','decided','ignore','检视结论为需要人决定，等待维护者确认方案后再开发','2026-11-20T11:10:00.000Z','2026-11-20T11:10:05.000Z')`,
  );

  // #105: blocked
  seedIssue('101', 105, 'Adjust CI release workflow trigger', 'open', '2026-11-20T11:05:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,error_code,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-issue-105-dev', '101', 'development.issue', 'waiting_permission', '开发 Issue #105', 'workflow_changes_not_confirmed',
    105, '2026-11-20T10:55:00.000Z', '2026-11-20T11:05:00.000Z',
  );

  // #106: skipped
  seedIssue('101', 106, 'Question about local compose ports', 'open', '2026-11-20T11:00:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    't-issue-106-rev', '101', 'review.issue', 'succeeded', '检视 Issue #106',
    JSON.stringify({ conclusion: 'no_code_change', recommendation: '文档已说明端口配置，无需修改代码。' }),
    106, '2026-11-20T10:50:00.000Z', '2026-11-20T11:00:00.000Z',
  );

  // #107: closed
  seedIssue('101', 107, 'Closed historical issue', 'closed', '2026-11-20T08:00:00.000Z');

  // Foreign repo #201
  seedIssue('202', 201, 'Secret repo issue', 'open', '2026-11-20T11:00:00.000Z');

  return { h, admin, password };
}

async function login(page, h, password, username = 'administrator', hash = '#/projects/101/overview/issues') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.workspace-overview')).toBeVisible();
}

test('Issue Progress view displays clear auto-dev statuses, filters, expandable chain and works across desktop & mobile', async ({ page, browser }) => {
  const { h, admin, password } = await fixture();
  const memberPassword = testPassword();
  await admin('/api/users', 'POST', { username: 'proj-admin', password: memberPassword, repository_ids: ['101'] });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  mkdirSync('.tmp/issue-progress', { recursive: true });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, password);

    // Tab active and counts accurate
    await expect(page.locator('[data-workbench-view="issues"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-workbench-view="issues"] .workbench-tab-count')).toHaveText('6');
    await expect(page.locator('[data-issue-group="all"] strong')).toHaveText('6');
    await expect(page.locator('[data-issue-group="pr_opened"] strong')).toHaveText('1');
    await expect(page.locator('[data-issue-group="developing"] strong')).toHaveText('1');
    await expect(page.locator('[data-issue-group="needs_human"] strong')).toHaveText('3');
    await expect(page.locator('[data-issue-group="skipped"] strong')).toHaveText('1');
    await expect(page.locator('.workbench-issue-row')).toHaveCount(6);
    await expect(page.locator('[data-issue-number="101"]')).toContainText('→ PR #205');
    await expect(page.locator('[data-issue-number="103"]')).toContainText('请补充浏览器报错日志');
    await expect(page.locator('[data-issue-number="104"]')).toContainText('决定是否保留旧长期令牌');

    await page.screenshot({ path: '.tmp/issue-progress/issues-1440.png' });

    // Filter to "开发不了 · 需人工" and check sub-pills + expand chain
    await page.locator('[data-issue-group="needs_human"]').click();
    await expect(page).toHaveURL(/overview\/issues\.needs_human$/);
    await expect(page.locator('.workbench-issue-row')).toHaveCount(3);
    await expect(page.locator('.workbench-issue-subpills')).toBeVisible();
    await expect(page.locator('[data-issue-group="needs_information"] strong')).toHaveText('1');
    await expect(page.locator('[data-issue-group="human_decision_required"] strong')).toHaveText('1');
    await expect(page.locator('[data-issue-group="blocked"] strong')).toHaveText('1');

    // Expand chain on Issue #104
    await page.locator('[data-issue-toggle="104"]').click();
    await expect(page.locator('[data-issue-chain="104"]')).toBeVisible();
    await expect(page.locator('[data-issue-chain="104"]')).toContainText('检视结论为需要人决定');
    await expect(page.locator('[data-issue-chain="104"]')).toContainText('检视 Issue #104');
    await page.screenshot({ path: '.tmp/issue-progress/issues-needs-human-chain-1440.png' });

    // Sub-filter to needs_information
    await page.locator('[data-issue-group="needs_information"]').click();
    await expect(page).toHaveURL(/overview\/issues\.needs_information$/);
    await expect(page.locator('.workbench-issue-row')).toHaveCount(1);
    await expect(page.locator('[data-issue-number="103"]')).toBeVisible();

    // Return to all, test search & include_closed
    await page.locator('[data-issue-group="all"]').click();
    await expect(page.locator('.workbench-issue-row')).toHaveCount(6);
    const search = page.getByLabel('搜索 Issue');
    await search.fill('#101');
    await expect(page.locator('.workbench-issue-row')).toHaveCount(1);
    await search.fill('');
    await expect(page.locator('.workbench-issue-row')).toHaveCount(6);
    await page.getByLabel('含已关闭').check();
    await expect(page.locator('.workbench-issue-row')).toHaveCount(7);
    await expect(page.locator('[data-issue-number="107"]')).toContainText('已关闭');
    await page.getByLabel('含已关闭').uncheck();
    await expect(page.locator('.workbench-issue-row')).toHaveCount(6);

    // Mobile 390px and narrow 320px: no horizontal overflow
    for (const width of [390, 320, 768]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.tmp/issue-progress/issues-390.png' });

    // Basic settings needs_human_label field saves cleanly
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.admin + '/#/projects/101/basic');
    const nhInput = page.getByLabel('需人工标签');
    await expect(nhInput).toHaveValue('bot-needs-human');
    await page.screenshot({ path: '.tmp/issue-progress/basic-labels-1440.png' });
    await nhInput.fill('triage-human');
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101/policy')).value.policy.needs_human_label).toBe('triage-human');

    // Capture mobile basic settings labels card
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(h.admin + '/#/projects/101/basic');
    await page.getByLabel('需人工标签').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.tmp/issue-progress/basic-labels-390.png' });

    // Verify project_admin role view & scope isolation (cannot see repo 202) in an isolated context
    const memberCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const memberPage = await memberCtx.newPage();
    memberPage.on('pageerror', e => errors.push(e.message));
    try {
      await login(memberPage, h, memberPassword, 'proj-admin', '#/projects/101/overview/issues');
      await expect(memberPage.locator('.workbench-issue-row')).toHaveCount(6);
      await expect(memberPage.locator('.workspace-issue-rows')).not.toContainText('Secret repo issue');
      await memberPage.screenshot({ path: '.tmp/issue-progress/issues-member-1440.png' });
      await memberPage.goto(h.admin + '/#/projects/202/overview/issues');
      await expect(memberPage.locator('#project-page')).toContainText('403');
    } finally {
      await memberCtx.close();
    }

    expect(errors).toEqual([]);
  } finally {
    await h.stop();
  }
});
