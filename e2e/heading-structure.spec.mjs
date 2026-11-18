import { test, expect } from '@playwright/test';
import { harness, setup, account, repository } from '../test/helpers.mjs';

// #1039: axe is not a dependency of this repository, so these assertions are the two axe rules that
// found the defect, written as structure: page-has-heading-one (a visible h1 starts the page) and
// heading-order (no level is skipped). Headings inside a hidden panel and the board's display:none
// page title do not count, exactly as the audit measured them in a real browser.
async function visibleHeadings(page) {
  return page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter(node => {
      if (node.closest('[hidden]') || node.closest('[aria-hidden="true"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    })
    .map(node => ({ level: Number(node.tagName.slice(1)), text: node.textContent.trim() })));
}
// Every page is judged at once so one red run names every route that fails, not just the first.
async function outlineProblems(page, route) {
  const headings = await visibleHeadings(page), problems = [];
  if (!headings.length) problems.push(`${route}: no visible heading`);
  else {
    if (headings[0].level !== 1) problems.push(`${route}: first heading is h${headings[0].level} "${headings[0].text}"`);
    for (let index = 1; index < headings.length; index++) {
      if (headings[index].level - headings[index - 1].level > 1) {
        problems.push(`${route}: h${headings[index - 1].level} "${headings[index - 1].text}" jumps to h${headings[index].level} "${headings[index].text}"`);
      }
    }
  }
  return { headings, problems };
}

const viewports = [[390, 844], [768, 1024], [1440, 900]];

for (const [width, height] of viewports) {
  test(`#1039 board, settings and identity keep one h1 and an unbroken heading order at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    const h = await harness(), { admin, password } = await setup(h);
    try {
      const a = await account(admin);
      await repository(admin, a.id, '101');
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height });
      await page.goto(h.admin);
      await page.getByLabel('用户名', { exact: true }).fill('administrator');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('#workspace')).toBeVisible();
      await expect(page.locator('#page-title')).toHaveText('项目');
      const problems = [];

      // The board hides the shared toolbar (and its h1) in CSS, so its own visible heading has to start the page.
      await page.goto(h.admin + '/#/board');
      await expect(page.locator('#board-columns')).toBeVisible();
      await expect(page.locator('#board-columns')).not.toHaveAttribute('aria-busy', 'true');
      const board = await outlineProblems(page, '#/board');
      problems.push(...board.problems);
      if (!board.headings.length || board.headings[0].level !== 1 || board.headings[0].text !== '任务看板') {
        problems.push('#/board: the first visible heading is not an h1 named 任务看板');
      }

      // The four settings categories the audit named: the page title is the h1 and cards must not jump to h3.
      for (const [route, marker] of [['#/settings/users', '用户'], ['#/settings/installations', 'GitHub App 安装档案'],
        ['#/settings/accounts', '已登记的账号'], ['#/settings/storage', '按项目']]) {
        await page.goto(h.admin + '/' + route);
        const content = page.locator('#settings-panel .project-content');
        await expect(content.locator('.side-card').first()).toBeVisible();
        await expect(content).toContainText(marker);
        problems.push(...(await outlineProblems(page, route)).problems);
      }

      // The identity overview is the first card; the cards after it may be h3, the overview itself may not be.
      await page.goto(h.admin + '/#/identity');
      await expect(page.locator('.identity-overview')).toBeVisible();
      const identity = await outlineProblems(page, '#/identity');
      problems.push(...identity.problems);
      if (identity.headings[1] && identity.headings[1].level !== 2) {
        problems.push(`#/identity: the overview card is h${identity.headings[1].level}, not h2`);
      }

      expect(problems).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await h.stop(); }
  });
}
