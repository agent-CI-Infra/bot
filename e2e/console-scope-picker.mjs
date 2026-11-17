import { expect } from '@playwright/test';
// Use the real scope trigger for this viewport, then wait until the shared bar names the selected address.
export async function switchConsoleProject(page, id, { waitForNavigation = true } = {}) {
  const trigger = page.locator(page.viewportSize().width <= 767 ? '#console-mobile-project' : '#console-project');
  await trigger.click();
  await page.locator(`#console-scope-list [role=option][data-project-id="${id}"]`).first().click();
  await expect(page.locator('#console-scope-picker')).not.toBeVisible();
  if (waitForNavigation) await expect(trigger).toHaveAttribute('data-project-id', id);
}
