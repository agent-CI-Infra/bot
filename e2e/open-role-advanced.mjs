// Unconfigured role pages (#564) fold the full form behind「高级」. Configured projects do not.
import { expect } from '@playwright/test';

export async function openRoleAdvanced(page) {
  const overview = page.getByRole('heading', { name: '角色概览', exact: true });
  if (await overview.isVisible()) return;
  const fold = page.getByTestId('role-advanced');
  await fold.waitFor({ state: 'visible' });
  const summary = fold.locator(':scope > summary');
  for (let i = 0; i < 4 && !(await overview.isVisible()); i++) {
    await summary.click();
    await overview.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  }
  await expect(overview).toBeVisible();
}
