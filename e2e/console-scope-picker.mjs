// Use the same visible scope trigger on desktop and mobile; no synthetic select/change events.
export async function switchConsoleProject(page, id) {
  await page.locator('.console-scope-trigger:visible').click();
  await page.locator(`#console-scope-list [role=option][data-project-id="${id}"]`).first().click();
}
