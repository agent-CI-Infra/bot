// #1123: prompt cards (the Manager prompt, a role prompt) open in their reading view. A test that types into a prompt
// switches that card to 编辑源码 first, which shows the textarea the card saves; value assertions work in either view.
import { expect } from '@playwright/test';

export async function promptEditor(page, label) {
  await page.getByRole('button', { name: `${label}：编辑源码`, exact: true }).click();
  const editor = page.getByLabel(label, { exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

// The reading view of a prompt card: visible once the card has drawn, in whichever mode it opened.
export const promptReading = (page, label) => page.getByRole('region', { name: `${label}阅读视图`, exact: true });
