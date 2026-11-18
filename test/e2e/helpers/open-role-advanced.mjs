// The role list is the first screen of every project, one following the defaults included (#1068; #564's intro and fold
// are gone). openRoleAdvanced keeps its name for the specs that call it and waits for that list.
import { expect } from '@playwright/test';

export async function openRoleAdvanced(page) {
  const overview = page.getByRole('heading', { name: '角色概览', exact: true }).or(page.getByRole('heading', { name: 'Roles', exact: true }));
  await expect(overview).toBeVisible({ timeout: 20000 });
}

const roleIds = { Manager: 'manager', Dev: 'dev', Test: 'test', Reviewer: 'reviewer', Coordinator: 'coordinator', UX: 'ux', '独立 QA': 'qa', QA: 'qa', '跨任务协调': 'coordinator', '项目管理者': 'manager', '开发': 'dev', '测试': 'test', '检视': 'reviewer', '体验检视': 'ux', '独立验收': 'qa', 'Developer': 'dev', 'Project controller': 'manager', 'Tester': 'test', 'UX reviewer': 'ux', 'Independent QA': 'qa', 'Task coordinator': 'coordinator' };

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
  // Permissions equal to the role's defaults are folded under 「与默认相同」 (#850); tests edit those too.
  const defaults = fold.getByTestId('role-permission-defaults');
  if (await defaults.count()) await defaults.evaluate(el => { el.open = true; });
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
    await expect(page.getByRole('heading', { name: '角色概览', exact: true }).or(page.getByRole('heading', { name: 'Roles', exact: true }))).toBeVisible({ timeout: 15000 });
  }
}
