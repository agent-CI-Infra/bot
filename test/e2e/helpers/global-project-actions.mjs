import { expect } from '@playwright/test';

export async function clickGlobalProjectAction(page, repositoryId, name) {
  const row = page.locator(`.global-project-row[data-repository-id="${repositoryId}"]`);
  const toggle = row.locator('.project-actions-toggle'), direct = row.locator('button', { hasText: name });
  await Promise.race([toggle.waitFor({ state: 'attached' }), direct.waitFor({ state: 'visible' })]);
  if (await toggle.count()) {
    await toggle.click();
    await expect(row.locator('.project-actions-menu')).toHaveClass(/open/);
    await expect(row.locator('.project-actions-panel')).toBeVisible();
  }
  await direct.click();
}
