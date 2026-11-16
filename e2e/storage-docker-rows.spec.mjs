import { test, expect } from '@playwright/test';
import { identityFixture } from '../test/identity-fixture.mjs';

// #671/#680: the super-administrator disk table lists Docker's image layers, container writable layers and build cache
// beside everything else that is already known. Volumes are not a row of their own: the volumes /system/df lists are the
// project computers, the manager's data and the assistant HOME, which the table already counts. The control-plane
// harness has no manager, so the read is injected; the numbers are chosen small enough to leave "other" positive.
const docker = { images: 644_245_094, containers: 73_400_320, build_cache: 231_928_258 };
const added = Object.values(docker).reduce((total, bytes) => total + bytes, 0);
const withDocker = async route => {
  const response = await route.fetch(), json = await response.json();
  if (json.host) {
    json.host.known = { ...json.host.known, docker_images: docker.images, docker_containers: docker.containers,
      docker_build_cache: docker.build_cache };
    json.host.unmeasured = (json.host.unmeasured ?? []).filter(key => !String(key).startsWith('docker_'));
    json.host.other_bytes = Math.max(0, Number(json.host.other_bytes ?? 0) - added);
  }
  if (json.totals?.manager) json.totals.manager.docker = { images: { count: 12, bytes: docker.images },
    containers: { count: 3, bytes: docker.containers }, build_cache: { count: 9, bytes: docker.build_cache } };
  await route.fulfill({ response, json });
};

test('the data disk lists Docker containers and leaves volumes out at 1440, 768 and 390', async ({ page }) => {
  const f = await identityFixture(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route(/\/api\/storage(\?|$)/, withDocker);
    await page.goto(f.h.admin + '/#/settings/storage');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const table = page.locator('.cost-table-scroll', { hasText: 'Docker 容器可写层' }).first();
    await expect(table).toContainText('Docker 容器可写层');
    await expect(table).toContainText('Docker 构建缓存');
    await expect(table).not.toContainText('Docker 卷');
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      // The whole page, not the table element: the review asks for screenshots of the screen (#680 F8).
      await page.screenshot({ path: `.tmp/680-captures/storage-full-${width}.png`, fullPage: true, animations: 'disabled' });
    }
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});
