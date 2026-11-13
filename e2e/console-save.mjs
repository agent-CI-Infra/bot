/** Locators and folds for the unified save bar (#567). */
export const consoleSave = page => page.getByTestId('console-save');
export const consoleDiscard = page => page.getByTestId('console-save-discard');
export const consoleSaveStatus = page => page.getByTestId('console-save-status');

export async function openSaveAdvanced(page) {
  const fold = page.getByTestId('console-save-advanced');
  if (await fold.count() === 0) return;
  await fold.evaluate(el => { el.open = true; });
}

export async function compareWithServer(page) {
  await openSaveAdvanced(page);
  await page.getByRole('button', { name: '读取最新版本并比较', exact: true }).click();
}

export async function rereadMachine(page) {
  const btn = page.getByRole('button', { name: '重新读取电脑配置', exact: true });
  if (!await btn.isVisible()) await openSaveAdvanced(page);
  await btn.click();
}

export async function confirmDiscard(page) {
  await consoleDiscard(page).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃更改', exact: true }).click();
}
