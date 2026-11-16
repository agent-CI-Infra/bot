import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// #890: #/settings/accounts lists one row per account, and the #561 contract (docs/console-ui.md:145) ellipsizes the
// row heading so a long name never collides with the actions — but `settingsRow` only ever put the full text on the
// subtitle. A long account name therefore showed its first characters with no way to read the rest short of opening the
// detail page, which is exactly the row's job (choose or delete the right account). The fix keeps the single line and
// the list density untouched and carries the full name on the heading's title, where the desktop hover shows it. The
// text itself is never shortened, so assistive technology already reads the whole name and needs no second copy.
const longName = '测试账号名称很长很长用来验证列表和表格的换行与截断行为是否正确';

async function login(page, f) {
  await page.goto(f.h.admin + '/#/settings/accounts');
  await page.getByLabel('用户名', { exact: true }).fill('administrator');
  await page.getByLabel('密码', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('#890 长账号名被省略号截断时，标题仍然带着完整名称', async ({ page }) => {
  test.setTimeout(120000);
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const renamed = await f.admin('/api/accounts/' + f.a.id, 'PATCH', { name: longName });
    expect(renamed.status).toBe(200);
    await login(page, f);
    const panel = page.locator('#settings-panel'), row = panel.locator('[role=listitem]', { hasText: longName });
    await expect(row).toBeVisible();
    const heading = row.locator('.row-content strong').first();
    await expect(heading).toHaveText(longName);

    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(row).toBeVisible();
      const line = await heading.evaluate(el => ({
        title: el.title, text: el.textContent, truncated: el.scrollWidth > el.clientWidth + 1,
        whiteSpace: getComputedStyle(el).whiteSpace, visibleWidth: el.clientWidth, fullWidth: el.scrollWidth,
      }));
      // The visible text stays the whole name; only the paint narrows it.
      expect(line.text).toBe(longName);
      // The full name rides on the heading, whatever the viewport does to it.
      expect(line.title).toBe(longName);
      // #561's density contract is untouched: still one line, no reflow, no taller list.
      expect(line.whiteSpace).toBe('nowrap');
      // Below the desktop width the row content column cannot hold the name, so the ellipsis is what the reader sees.
      if (width < 1440) expect(line.truncated, `${width}: ${line.visibleWidth}/${line.fullWidth}`).toBe(true);
      // Truncating is a paint decision; it must not push the page sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
