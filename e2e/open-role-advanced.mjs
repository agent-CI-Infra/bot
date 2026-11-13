// Unconfigured role pages (#564) fold the full form behind「高级」. Configured projects do not.
import { expect } from '@playwright/test';

export async function openRoleAdvanced(page) {
  const overview = page.getByRole('heading', { name: '角色概览', exact: true });
  const intro = page.getByTestId('recommended-roles-intro');
  const fold = page.getByTestId('role-advanced');
  // After a navigation the overview may still be loading; do not assume a missing heading means the page is unconfigured.
  // intro and the (closed) advanced fold are both visible on an unconfigured first screen, so do not use a strict .or().
  await expect.poll(async () => (await overview.isVisible()) || (await intro.isVisible()) || (await fold.isVisible()), { timeout: 20000 }).toBe(true);
  if (await overview.isVisible()) return;
  await fold.waitFor({ state: 'visible' });
  const summary = fold.locator(':scope > summary').or(fold.locator('summary').first());
  for (let i = 0; i < 4 && !(await overview.isVisible()); i++) {
    if (!(await fold.evaluate(el => el.open))) await summary.click();
    await fold.evaluate(el => { el.open = true; });
    await overview.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  }
  await expect(overview).toBeVisible();
}

const roleIds = { Manager: 'manager', Dev: 'dev', Test: 'test', Reviewer: 'reviewer', Coordinator: 'coordinator', UX: 'ux', '独立 QA': 'qa', QA: 'qa', '跨任务协调': 'coordinator' };

export async function openRoleFromList(page, name) {
  await openRoleAdvanced(page);
  const id = roleIds[name] || name;
  const link = page.getByTestId('role-list-' + id);
  if (await link.count()) {
    await link.click();
  } else {
    const project = await page.evaluate(() => (location.hash.match(/#\/projects\/([^/]+)/) || [])[1] || '101');
    await page.evaluate(({ project, id }) => { location.hash = `#/projects/${project}/roles/${id}`; }, { project, id });
  }
  await expect(page.getByTestId('role-form')).toBeVisible();
}

export async function openRoleFormAdvanced(page) {
  const fold = page.getByTestId('role-form-advanced');
  await fold.waitFor({ state: 'attached', timeout: 15000 });
  if (!(await fold.evaluate(el => el.open))) {
    await fold.locator('summary').first().click();
  }
  await fold.evaluate(el => { el.open = true; el.setAttribute('open', ''); });
  await expect.poll(async () => fold.evaluate(el => el.open)).toBe(true);
}

export function roleHash(name, view) {
  const id = roleIds[name] || name;
  if (view) return `#/projects/101/roles?view=${view}`;
  return `#/projects/101/roles/${id}`;
}

/** Navigate within the current project to the role list, a role form, or skills/stages. */
export async function goRolePage(page, { role, view } = {}) {
  const project = await page.evaluate(() => {
    const m = location.hash.match(/#\/projects\/([^/]+)/);
    return m ? m[1] : '101';
  });
  const id = roleIds[role] || role;
  const next = view ? `#/projects/${project}/roles?view=${view}`
    : role ? `#/projects/${project}/roles/${id}`
    : `#/projects/${project}/roles`;
  await page.evaluate(h => { location.hash = h; }, next);
  if (role) await expect(page.getByTestId('role-form')).toBeVisible({ timeout: 15000 });
  else if (!view) {
    await expect(page.getByRole('heading', { name: '角色概览', exact: true }).or(page.getByTestId('recommended-roles-intro'))).toBeVisible({ timeout: 15000 });
  }
}
