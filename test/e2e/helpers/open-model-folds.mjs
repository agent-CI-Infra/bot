import { expect } from '@playwright/test';

export async function openModelOverrides(page) {
  const fold = page.getByTestId('model-overrides');
  await expect(fold).toHaveCount(1);
  await fold.evaluate(el => { el.open = true; });
  await expect(page.getByRole('table', { name: '工作类型模型', exact: true })).toBeVisible();
}

export async function openModelCatalog(page) {
  const fold = page.getByTestId('model-catalog');
  await expect(fold).toHaveCount(1);
  await fold.evaluate(el => { el.open = true; });
  await expect(page.getByRole('heading', { name: '本项目专属模型', exact: true }).or(page.getByRole('heading', { name: '部署共享模型', exact: true })).first()).toBeVisible();
}
