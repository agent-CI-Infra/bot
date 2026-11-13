import { expect } from '@playwright/test';

/** Open the #570 folds on the basic-settings page. Force `open` so Chromium actually reveals the contents. */
export async function openBasicAdvanced(page) {
  const fold = page.getByTestId('basic-advanced');
  await expect(fold).toHaveCount(1);
  await fold.evaluate(el => { el.open = true; });
  await expect(page.getByText('仓库 ID', { exact: true })).toBeVisible();
}

export async function openProjectDanger(page) {
  const fold = page.getByTestId('project-danger-fold');
  await expect(fold).toHaveCount(1);
  await fold.evaluate(el => { el.open = true; });
  await expect(page.locator('.project-danger')).toBeVisible();
}

export async function closeBasicFolds(page) {
  for (const id of ['basic-advanced', 'project-danger-fold']) {
    const fold = page.getByTestId(id);
    if (await fold.count()) await fold.evaluate(el => { el.open = false; });
  }
}
