import { test, expect } from '@playwright/test';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';

async function fixture() {
  const manager = { call: async (_method, path) => ({ repository_id: path.split('/')[3], generation: 1, state: 'ready', desired: 'ready', revision: 1, computer: {} }) };
  const h = await harness(undefined, manager), { admin, password } = await setup(h), a = await account(admin);
  await repository(admin, a.id, '101');
  await repository(admin, a.id, '202');

  const store = h.store;
  const seedPr = (repo, number, title, state = 'open', draft = 0, at = '2026-11-22T08:00:00.000Z') => {
    store.run(
      `INSERT INTO board_objects(repository_id,object_type,object_number,title,github_state,draft,title_at,state_at,draft_at,last_seen)
       VALUES(?,'pr',?,?,?,?,?,?,?,?)`,
      repo, number, title, state, draft, at, at, at, at,
    );
  };

  // #201: needs_attention — Bot PR linked to Issue #101, 1 CI pass + 1 CI fail, task failed
  seedPr('101', 201, 'Fix retry queue lock timeout under burst traffic', 'open', 0, '2026-11-22T08:30:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at)
     VALUES('t-src-101','101','development.issue','pr_opened','开发 Issue #101',101,'2026-11-22T07:00:00.000Z','2026-11-22T07:20:00.000Z')`,
  );
  store.run(
    `INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions)
     VALUES('101',201,'pr-201','999','101','bot/issue-101','1111111111111111111111111111111111111111','t-src-101',1)`,
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at) VALUES
      ('101','1111111111111111111111111111111111111111','ci:unit','unit','completed','success','https://github.com/org/repo/runs/1','2026-11-22T08:25:00.000Z'),
      ('101','1111111111111111111111111111111111111111','ci:e2e','e2e','completed','failure','https://github.com/org/repo/runs/2','2026-11-22T08:26:00.000Z')`,
  );
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,error_code,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-201-rev','101','development.pr','waiting_permission','修订 PR #201','workflow_changes_not_confirmed',201,'1111111111111111111111111111111111111111','2026-11-22T08:20:00.000Z','2026-11-22T08:30:00.000Z')`,
  );

  // #202: revising — Bot PR linked to Issue #102, active revision task, CI running
  seedPr('101', 202, 'Add bounded pagination to audit export endpoint', 'open', 0, '2026-11-22T08:20:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,object_number,created_at,updated_at)
     VALUES('t-src-102','101','development.issue','pr_opened','开发 Issue #102',102,'2026-11-22T07:10:00.000Z','2026-11-22T07:30:00.000Z')`,
  );
  store.run(
    `INSERT INTO bot_pull_requests(repository_id,number,pr_id,author_id,head_repository_id,branch,sha,source_task_id,revisions)
     VALUES('101',202,'pr-202','999','101','bot/issue-102','2222222222222222222222222222222222222222','t-src-102',0)`,
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at)
     VALUES('101','2222222222222222222222222222222222222222','ci:build','build','in_progress',NULL,'https://github.com/org/repo/runs/3','2026-11-22T08:21:00.000Z')`,
  );
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-202-dev','101','task.request','implementing','修订 PR #202',?,202,'2222222222222222222222222222222222222222','2026-11-22T08:15:00.000Z','2026-11-22T08:20:00.000Z')`,
    JSON.stringify({ target: { type: 'pr', number: 202 }, executor_role: 'dev' }),
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-pr-202-dev', JSON.stringify(['pull_request']), '2026-11-22T08:15:00.000Z');

  // #203: reviewing — External PR currently under review
  seedPr('101', 203, 'Refactor webhook signature verifier to timingSafeEqual', 'open', 0, '2026-11-22T08:15:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,input,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-203-rev','101','task.request','running','检视 PR #203',?,203,'3333333333333333333333333333333333333333','2026-11-22T08:10:00.000Z','2026-11-22T08:15:00.000Z')`,
    JSON.stringify({ target: { type: 'pr', number: 203 }, executor_role: 'reviewer' }),
  );
  store.run('INSERT INTO task_write_grants VALUES(?,?,1,?)', 't-pr-203-rev', JSON.stringify(['review']), '2026-11-22T08:10:00.000Z');

  // #204: reviewed — External PR reviewed cleanly + 22 dispatch events to verify truncation & expand toggle
  seedPr('101', 204, 'Add PR progress view and retire legacy Kanban board', 'open', 0, '2026-11-22T08:10:00.000Z');
  store.run(
    `INSERT INTO tasks(id,repository_id,kind,status,summary,result,object_number,head_sha,created_at,updated_at)
     VALUES('t-pr-204-rev','101','review.pr','succeeded','检视 PR #204',?,204,'4444444444444444444444444444444444444444','2026-11-22T08:00:00.000Z','2026-11-22T08:10:00.000Z')`,
    JSON.stringify({ conclusion: 'ready_for_development', recommendation: '逻辑清晰、索引命中良好，可以合入。' }),
  );
  store.run(
    `INSERT INTO commit_checks(repository_id,head_sha,check_key,name,status,conclusion,details_url,updated_at)
     VALUES('101','4444444444444444444444444444444444444444','ci:all','checks','completed','success','https://github.com/org/repo/runs/4','2026-11-22T08:11:00.000Z')`,
  );
  for (let i = 1; i <= 22; i++) {
    const sec = String(i).padStart(2, '0');
    const type = i === 22 ? 'review.published' : 'pull_request.synchronize';
    const decision = i === 22 ? 'ignore' : 'continue';
    store.run(
      `INSERT INTO dispatch_events(id,repository_id,event_key,type,source,object_type,object_number,summary,facts,options,thread_key,state,decision,reason,created_at,decided_at)
       VALUES(?,?,?,?,?,'pr',204,?,'{}','[]','101:pr:204','decided',?,?,?,?)`,
      `ev-pr-204-${i}`, '101', `k-pr-204-${i}`, type, i === 22 ? 'review' : 'github',
      `PR #204 分派记录 #${i}`, decision, i === 22 ? '检视已通过，无需额外修订' : `同步提交 #${i} 续接检视`,
      `2026-11-22T08:05:${sec}.000Z`, `2026-11-22T08:05:${sec}.500Z`,
    );
  }

  // #205: draft PR
  seedPr('101', 205, 'WIP: prototype multi-region runner failover', 'open', 1, '2026-11-22T07:50:00.000Z');

  // #206: pending PR (open, no tasks)
  seedPr('101', 206, 'Update contributor documentation links', 'open', 0, '2026-11-22T07:40:00.000Z');

  // #207: closed PR
  seedPr('101', 207, 'Historical closed PR', 'closed', 0, '2026-11-22T06:00:00.000Z');

  // Foreign repo #301
  seedPr('202', 301, 'Secret repo PR', 'open', 0, '2026-11-22T08:00:00.000Z');

  return { h, admin, password };
}

async function login(page, h, password, username = 'administrator', hash = '#/projects') {
  await page.goto(h.admin + '/' + hash);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

test('PR Progress panel, retired board redirects, and simplified navigation work across desktop & mobile (#1222)', async ({ page, browser }) => {
  test.setTimeout(120000);
  const { h, admin, password } = await fixture();
  const memberPassword = testPassword();
  await admin('/api/users', 'POST', { username: 'proj-admin', password: memberPassword, repository_ids: ['101'] });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  try {
    // 1. All-projects shell: no "任务看板" on desktop sidebar or mobile bottom nav
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, h, password, 'administrator', '#/projects');
    await expect(page.locator('#rows')).toContainText('fixture/project-101');
    await expect(page.locator('#tabs').getByRole('link', { name: '任务看板', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#console-mobile-nav a')).toHaveText(['项目', '待处理', '助手', '用量与成本']);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Legacy global routes redirect cleanly to #/projects
    for (const legacy of ['#/board', '#/reviews', '#/developments']) {
      await page.goto(h.admin + '/' + legacy);
      await expect(page).toHaveURL(/#\/projects$/);
    }
    // Legacy project board route redirects cleanly to overview/tasks with replaceState
    await page.goto(h.admin + '/#/projects/101/board');
    await expect(page).toHaveURL(/#\/projects\/101\/overview\/tasks$/);
    await expect(page.locator('.workspace-overview')).toBeVisible();

    // 2. Open PR Progress 4th tab and check counts, badges, CI and statuses
    await page.locator('[data-workbench-view="prs"]').click();
    await expect(page).toHaveURL(/#\/projects\/101\/overview\/prs$/);
    await expect(page.locator('[data-workbench-view="prs"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-workbench-view="prs"] .workbench-tab-count')).toHaveText('6');
    await expect(page.locator('[data-pr-group="all"] strong')).toHaveText('6');
    await expect(page.locator('[data-pr-group="needs_attention"] strong')).toHaveText('1');
    await expect(page.locator('[data-pr-group="revising"] strong')).toHaveText('1');
    await expect(page.locator('[data-pr-group="reviewing"] strong')).toHaveText('1');
    await expect(page.locator('[data-pr-group="reviewed"] strong')).toHaveText('1');
    await expect(page.locator('[data-pr-group="draft"] strong')).toHaveText('1');
    await expect(page.locator('[data-pr-group="pending"] strong')).toHaveText('1');
    await expect(page.locator('.workbench-pr-row')).toHaveCount(6);
    await expect(page.locator('[data-pr-number="201"]')).toContainText('Bot PR');
    await expect(page.locator('[data-pr-number="201"]')).toContainText('← Issue #101');
    await expect(page.locator('[data-pr-number="201"]')).toContainText('CI 1 失败');
    await expect(page.locator('[data-pr-number="202"]')).toContainText('← Issue #102');
    await expect(page.locator('[data-pr-number="202"]')).toContainText('CI 运行中');
    await expect(page.locator('[data-pr-number="204"]')).toContainText('逻辑清晰、索引命中良好');

    // 3. Expand PR #204 chain: shows review summary + truncated dispatch events (>20) + expand button
    await page.locator('[data-pr-toggle="204"]').click();
    const chain204 = page.locator('[data-pr-chain="204"]');
    await expect(chain204).toBeVisible();
    await expect(chain204).toContainText('检视 PR #204');
    await expect(chain204).toContainText('Manager 分派记录（显示 20 / 共 22 条）');
    await expect(chain204).toContainText('仅展示最近 20 条分派记录（共 22 条）。');
    const expandBtn = chain204.getByRole('button', { name: '展开其余 12 条分派记录', exact: true });
    await expect(expandBtn).toBeVisible();
    await chain204.scrollIntoViewIfNeeded();
    await expandBtn.click();
    await expect(chain204.locator('.issue-chain-block').last().locator('.issue-chain-item')).toHaveCount(20);
    await expect(expandBtn).toHaveCount(0);

    // 4. Filter by status, Bot-only, search, and include_closed
    await page.locator('[data-pr-group="needs_attention"]').click();
    await expect(page).toHaveURL(/overview\/prs\.needs_attention$/);
    await expect(page.locator('.workbench-pr-row')).toHaveCount(1);
    await expect(page.locator('[data-pr-number="201"]')).toBeVisible();

    await page.locator('[data-pr-group="all"]').click();
    await expect(page.locator('.workbench-pr-row')).toHaveCount(6);
    await page.getByLabel('仅 Bot PR').check();
    await expect(page.locator('.workbench-pr-row')).toHaveCount(2);
    await expect(page.locator('[data-pr-number="201"]')).toBeVisible();
    await expect(page.locator('[data-pr-number="202"]')).toBeVisible();
    await page.getByLabel('仅 Bot PR').uncheck();
    await expect(page.locator('.workbench-pr-row')).toHaveCount(6);

    const search = page.getByLabel('搜索 PR');
    await search.fill('#205');
    await expect(page.locator('.workbench-pr-row')).toHaveCount(1);
    await expect(page.locator('[data-pr-number="205"]')).toBeVisible();
    await search.fill('');
    await expect(page.locator('.workbench-pr-row')).toHaveCount(6);

    await page.getByLabel('含已关闭').check();
    await expect(page.locator('.workbench-pr-row')).toHaveCount(7);
    await expect(page.locator('[data-pr-number="207"]')).toContainText('已关闭');
    await page.getByLabel('含已关闭').uncheck();
    await expect(page.locator('.workbench-pr-row')).toHaveCount(6);

    // 5. Mobile 390px, 320px, 768px: zero horizontal overflow, 4-item bottom nav, >=44px touch targets
    for (const width of [390, 320, 768]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#console-mobile-nav a')).toHaveText(['项目', '待处理', '助手', '用量与成本']);
    for (const link of await page.locator('#console-mobile-nav a').all()) {
      const box = await link.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    const toggleBox = await page.locator('[data-pr-toggle="201"]').boundingBox();
    expect(toggleBox.height).toBeGreaterThanOrEqual(44);

    // Capture expanded chain on 390px
    await page.locator('[data-pr-toggle="204"]').click();
    await expect(page.locator('[data-pr-chain="204"]')).toBeVisible();
    await page.locator('[data-pr-chain="204"]').scrollIntoViewIfNeeded();

    // 6. Project admin role view & scope isolation (cannot see repo 202)
    const memberCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const memberPage = await memberCtx.newPage();
    memberPage.on('pageerror', e => errors.push(e.message));
    try {
      await login(memberPage, h, memberPassword, 'proj-admin', '#/projects/101/overview/prs');
      await expect(memberPage.locator('#tabs').getByRole('link', { name: '任务看板', exact: true })).toHaveCount(0);
      await expect(memberPage.locator('.workbench-pr-row')).toHaveCount(6);
      await expect(memberPage.locator('.workspace-pr-rows')).not.toContainText('Secret repo PR');
      await memberPage.goto(h.admin + '/#/projects/202/overview/prs');
      await expect(memberPage.locator('#project-page')).toContainText('403');
    } finally {
      await memberCtx.close();
    }

    expect(errors).toEqual([]);
  } finally {
    await h.stop();
  }
});
