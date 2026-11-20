import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';

// #527 slice: the project list itself. Its columns already come from the dictionary (project-columns-i18n.spec.mjs),
// but the page around them — the title, the count, the filter fold, the row's state badge, the 检视/开发 switches, the
// running/queued preview, the row buttons and the pager — is still hardcoded Chinese (static/views/project-list.js).
// An English console must show none of it. The check runs at all three layouts the list has, because the row collapses
// two different ways below 1280 and a reading taken at the default 1280x720 width says nothing about 390.
const viewports = [[1440, 900], [768, 1024], [390, 844]];
const han = /[\u4e00-\u9fff]/;
// The list is one card: title and count, the filter fold, the rows and the pager all live under #workspace .list-panel.
// The console shell around it (sidebar, header) is a different slice, so the CJK reading is scoped to the card.
const panel = page => page.locator('#workspace .list-panel');

async function openProjects(page, h) {
  const { admin, password } = await setup(h), a = await account(admin);
  // The third repository has no owner login and a name without an owner prefix, so its group heading is the
  // owner-id fallback rather than a login: the one owner title an English read must also translate.
  for (const [id, owner, name, login] of [['101', '20', 'alpha/one', 'org-20'], ['202', '10', 'beta/two', 'org-10'], ['303', '30', 'gamma', '']]) {
    await repository(admin, a.id, id);
    h.store.run('UPDATE repositories SET full_name=?,owner_id=? WHERE id=?', name, owner, id);
    h.store.run('UPDATE installed_repositories SET full_name=?,owner_id=?,owner_login=?,permissions_at=? WHERE repository_id=?', name, owner, login, new Date().toISOString(), id);
    h.store.run('INSERT INTO public_board_settings(repository_id,enabled) VALUES(?,0) ON CONFLICT(repository_id) DO UPDATE SET enabled=0', id);
  }
  // A bot account with Read but not Write is a real access_gaps reading: one role gap plus the App-only account gap.
  // Keeping it on 101 means the English page renders the actionable chip instead of only the Unchecked placeholder.
  h.store.run("UPDATE installed_repositories SET permissions=? WHERE repository_id='101'", JSON.stringify({ admin: false, maintain: false, push: false, triage: false, pull: true }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(h.admin + '/#/projects');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}

test('English 界面：项目列表整页不再出现中文，三个视口都不溢出', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openProjects(page, h);
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#rows .row')).toHaveCount(3);
    // The locale change starts the console again; the pager is the last text that redraw replaces, so wait for it
    // before reading the page rather than racing the previous language's paint.
    await expect(page.locator('#page-number')).toHaveText('Page 1');
    await expect(page.locator('#count')).toHaveText('Repositories: 3 · Not synced yet');

    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px`).toBe(true);
      const left = (await panel(page).innerText()).match(/[^\s]*[\u4e00-\u9fff][^\s]*/g) || [];
      expect(left, `Chinese text left in the project list at ${width}px`).toEqual([]);
      expect(await panel(page).innerText(), `raw dictionary key at ${width}px`).not.toContain('projects.list.');
    }

    // The words a reader lands on: the page names itself, the header names the Review and Develop columns, and the
    // row says its state, its permission reading and its board in English rather than leaving the migrated columns
    // surrounded by Chinese.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    const head = page.locator('#rows .project-table-head');
    await expect(head).toContainText('Review');
    await expect(head).toContainText('Develop');
    const row = page.locator('#rows .row[data-key="101"]');
    await expect(row).toContainText('Enabled');
    await expect(page.locator('#rows .row[data-key="202"]')).toContainText('Unchecked');
    await expect(row).toContainText('Board off');
    await expect(row.locator('[data-label="review"]')).toContainText('Off');
    // The gap branch is a real row reading, not only a dictionary entry: the visible chip, its title and its aria-label
    // all read English, while the pre-fix source printed 权限不足 / 需要 GitHub App and a Chinese explanation.
    const gapChip = row.locator('.project-cell[data-label="access"] [data-permission]');
    await expect(gapChip).toHaveText('Insufficient permission · GitHub App required');
    const gapTitle = await gapChip.getAttribute('title');
    expect(gapTitle).toContain('The bot account needs the "Write" repository role (currently "Read")');
    expect(gapTitle).toContain('The project runs on a bot account, not a GitHub App installation');
    expect(gapTitle).toContain('Click to see how to fix it.');
    expect(gapTitle).not.toMatch(han);
    expect(await gapChip.getAttribute('aria-label')).toBe('Insufficient permission, GitHub App required: ' + gapTitle);
    // The owner bar around the rows is translated too: its heading falls back to the owner id and its count names the
    // page, so neither can stay Chinese while the rows read English.
    await expect(panel(page)).toContainText('Owner 30');
    await expect(panel(page)).toContainText('Projects on this page: 1');
    // Switching back restores the Chinese words rather than showing a raw key on either language.
    await page.getByRole('button', { name: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page.locator('#rows .row[data-key="101"]')).toContainText('已启用');
    await expect(row.locator('[data-permission]')).toHaveText('权限不足 · 需要 GitHub App');
    expect(await row.locator('[data-permission]').getAttribute('title')).toContain('机器人账号的仓库角色需要「Write」，现在「Read」');
    await expect(panel(page)).toContainText('所有者 30');
    await expect(panel(page)).not.toContainText('projects.list.');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

// The same slice re-renders states the ordinary super-administrator list does not show: the project administrator's
// pending-activation group and permission placeholder, and the filter row without the account/hidden controls. English
// must reach all of them, not only the rows the first test draws.
const pendingRepositories = Array.from({ length: 12 }, (_, index) => ({
  id: String(700 + index), full_name: `pending/repo-${index + 1}`, self_start: index === 0
}));
async function fixtureProjects(h, role = null) {
  const { admin, password } = await setup(h), a = await account(admin);
  for (const [id, owner, name, login] of [['101', '20', 'alpha/one', 'org-20'], ['202', '10', 'beta/two', 'org-10']]) {
    await repository(admin, a.id, id);
    h.store.run('UPDATE repositories SET full_name=?,owner_id=? WHERE id=?', name, owner, id);
    h.store.run('UPDATE installed_repositories SET full_name=?,owner_id=?,owner_login=?,permissions_at=? WHERE repository_id=?', name, owner, login, new Date().toISOString(), id);
    h.store.run('INSERT INTO public_board_settings(repository_id,enabled) VALUES(?,0) ON CONFLICT(repository_id) DO UPDATE SET enabled=0', id);
  }
  if (!role) return { admin, password, account: a };
  const memberPassword = testPassword();
  const created = await admin('/api/users', 'POST', { username: 'project-admin', password: memberPassword, role, repository_ids: ['101', '202'] });
  expect(created.status).toBe(201);
  return { admin, password: memberPassword, account: a };
}
async function signIn(page, h, username, password) {
  await page.goto(h.admin + '/#/projects');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
}
const capture = async (page, name, width, height) => {
  await page.setViewportSize({ width, height });
  await page.screenshot({ path: `.tmp/527-project-list-states/${name}-${width}.png`, fullPage: true });
};

test('English 界面：项目管理员看到待接入分组、权限占位和没有账号/隐藏控件的筛选行', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { password } = await fixtureProjects(h, 'project_admin');
    await signIn(page, h, 'project-admin', password);
    // The real identity read has no pending rows for this fixture; append the installed-but-unstarted set after login so
    // the route still answers with the account's own identity and pending state.
    await page.route('**/api/identity', async route => {
      const response = await route.fetch(), body = await response.json();
      body.github_connection = { ...(body.github_connection || {}), pending_repositories: pendingRepositories };
      await route.fulfill({ response, json: body });
    });
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#rows .project-list-row')).toHaveCount(2);

    // /api/repositories omits access_gaps for a project administrator, so the column explains itself in English.
    const placeholders = page.locator('#rows .project-list-row .project-cell[data-label="access"] [data-permission]');
    await expect(placeholders).toHaveCount(2);
    await expect(placeholders.first()).toHaveText('—');
    await expect(placeholders.first()).toHaveAttribute('title', 'An administrator checks repository permissions in the installation list');
    await expect(placeholders.first()).toHaveAttribute('aria-label', 'An administrator checks repository permissions in the installation list');

    // A project administrator has no account selector and no hidden filter; the owner filter stays. The filter row
    // lives in a folded details element, so open it before reading which controls it does and does not contain.
    const filtersFold = page.getByTestId('project-filters-fold');
    await filtersFold.locator('summary').click();
    await expect(filtersFold).toHaveAttribute('open', '');
    await expect(page.locator('#account-filter-label')).toBeHidden();
    await expect(page.locator('#hidden-filter-label')).toBeHidden();
    await expect(page.locator('#owner-filter')).toBeVisible();

    const group = page.locator('.project-pending-group');
    await expect(group.getByRole('heading', { name: 'Repositories waiting to be set up' })).toBeVisible();
    const intro = group.locator('.project-pending-intro');
    await expect(intro).toContainText('These repositories already have the GitHub App installed');
    await expect(intro).toContainText('a repository whose organization is not trusted sends a start request');
    const fold = group.locator('details[data-testid="pending-repo-fold"]');
    await expect(fold.locator('summary')).toHaveText('Show 12 repositories waiting to be set up');
    await fold.locator('summary').click();
    await expect(fold).toHaveAttribute('open', '');
    const pendingRows = fold.locator('.project-pending-row');
    await expect(pendingRows).toHaveCount(12);
    await expect(pendingRows.nth(0)).toContainText('Can start itself');
    await expect(pendingRows.nth(1)).toContainText('A super administrator must approve the start');
    const setUps = group.getByRole('link', { name: /^Set up / });
    await expect(setUps).toHaveCount(12);
    await expect(setUps.first()).toHaveAttribute('aria-label', 'Set up pending/repo-1');
    await expect(setUps.first()).toHaveAttribute('href', '#/management');
    await expect(group.getByRole('link', { name: 'View identity and access' })).toBeVisible();
    const search = fold.getByLabel('Find by name');
    await expect(search).toHaveAttribute('placeholder', 'Repository name');
    await search.fill('repo-12');
    await expect(pendingRows.nth(11)).toBeVisible();
    await expect(pendingRows.nth(0)).toBeHidden();
    await search.fill('missing');
    const empty = fold.locator('.pending-repo-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('No repository waiting to be set up has "missing" in its name');

    mkdirSync('.tmp/527-project-list-states', { recursive: true });
    await capture(page, 'project-admin-pending', 1440, 900);
    await capture(page, 'project-admin-pending', 390, 844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pending group overflow at 390px').toBe(true);

    // Choosing a filter sets the fold summary and hides the unfiltered pending group.
    await page.setViewportSize({ width: 1440, height: 900 });
    await search.fill('');
    await expect(filtersFold.locator('summary')).toHaveText('Filters');
    await page.getByLabel('Organization ID', { exact: true }).fill('10');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(filtersFold.locator('summary')).toHaveText('Filters (set)');
    await expect(filtersFold).toHaveAttribute('open', '');
    await expect(page.locator('#rows .project-list-row')).toHaveCount(1);
    await expect(page.locator('.project-pending-group')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('English 界面：已隐藏仓库视图的计数、徽章和恢复按钮', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await fixtureProjects(h);
    const a = (await admin('/api/accounts')).value.accounts[0];
    h.store.run("INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,owner_login,installed,hidden,synced_at) VALUES(?,'401','fixture/hidden','10','fixture',1,1,?)", a.id, new Date().toISOString());
    await signIn(page, h, 'administrator', password);
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // The hidden view is reached through the same checkbox the old project list used. Setting it here exercises the
    // render branch without adding a second visible control that the current shell deliberately hides.
    await page.evaluate(() => {
      const box = document.querySelector('#hidden-filter');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#count')).toHaveText('1 hidden');
    const row = page.locator('#rows .row[data-key="401"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Not started');
    await expect(row).toContainText('Hidden');
    await expect(row).not.toContainText('undefined');
    await expect(row.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    mkdirSync('.tmp/527-project-list-states', { recursive: true });
    await capture(page, 'hidden-repositories', 1440, 900);
    await capture(page, 'hidden-repositories', 390, 844);
    await page.setViewportSize({ width: 1440, height: 900 });
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.locator('#rows .row')).toHaveCount(0);
    await expect(page.locator('#count')).toHaveText('0 hidden');
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});

test('English 界面：全局项目表的开关、预览、功能区与权限占位名称都是英文', async ({ page }) => {
  const h = await harness(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { password } = await fixtureProjects(h);
    // An installation row normally always carries access_gaps, so it would draw Unchecked rather than the placeholder.
    // Removing that one field is exactly the shaped row the placeholder exists for; every other name is real.
    await page.route('**/api/installations?*', async route => {
      const response = await route.fetch(), body = await response.json();
      for (const row of body.repositories || []) if (String(row.id) === '101') {
        delete row.access_gaps;
        delete row.permissions_stale;
      }
      await route.fulfill({ response, json: body });
    });
    await page.goto(h.admin + '/#/settings/projects/list.0');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const table = page.locator('.global-project-table').first();
    const row = table.locator('.global-project-row[data-key="101"]');
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('group')).toHaveAttribute('aria-label', 'alpha/one features and tasks');
    await expect(row.getByRole('switch')).toHaveAttribute('aria-label', 'alpha/one Board');
    await expect(row.locator('.project-cell[data-label="review"] .status')).toHaveAttribute('aria-label', 'alpha/one Review: Off');
    const preview = row.locator('.project-task-preview');
    await expect(preview).toHaveAttribute('title', '0 tasks running, 0 queued');
    await expect(preview).toHaveAttribute('aria-label', 'alpha/one: 0 tasks running, 0 queued. View the run state.');
    const placeholder = row.locator('.project-cell[data-label="access"] [data-permission]');
    await expect(placeholder).toHaveText('—');
    await expect(placeholder).toHaveAttribute('title', 'An administrator checks repository permissions in the installation list');
    await expect(placeholder).toHaveAttribute('aria-label', 'An administrator checks repository permissions in the installation list');
    mkdirSync('.tmp/527-project-list-states', { recursive: true });
    await capture(page, 'settings-global-projects', 1440, 900);
    await capture(page, 'settings-global-projects', 390, 844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'global project table overflow at 390px').toBe(true);
    expect(errors).toEqual([]);
  } finally { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); }
});
