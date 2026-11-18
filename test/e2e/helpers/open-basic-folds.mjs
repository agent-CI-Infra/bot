import { expect } from '@playwright/test';

/** Open the #570 folds on the basic-settings page by clicking the visible summary. */
export async function openBasicAdvanced(page) {
  const fold = page.getByTestId('basic-advanced');
  await expect(fold).toHaveCount(1);
  await expect(fold).not.toHaveAttribute('open', /.+/);
  await fold.locator('summary').click();
  await expect(fold).toHaveJSProperty('open', true);
  await expect(page.getByText('仓库 ID', { exact: true })).toBeVisible();
}

export async function openProjectDanger(page) {
  const fold = page.getByTestId('project-danger-fold');
  await expect(fold).toHaveCount(1);
  await expect(fold).not.toHaveAttribute('open', /.+/);
  await fold.locator('summary').click();
  await expect(fold).toHaveJSProperty('open', true);
  await expect(page.locator('.project-danger')).toBeVisible();
}

export async function closeBasicFolds(page) {
  for (const id of ['basic-advanced', 'project-danger-fold']) {
    const fold = page.getByTestId(id);
    if (await fold.count() && await fold.evaluate(el => el.open)) await fold.locator('summary').click();
  }
}
