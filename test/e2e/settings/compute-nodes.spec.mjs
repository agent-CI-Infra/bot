import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';

test('compute nodes settings manages pairing, labels, drain/undrain, revoke, and project machine node binding across desktop & mobile', async ({ page }) => {
  test.setTimeout(90_000);
  const cleanup = [];
  const manager = await managerFixture({ after: action => cleanup.push(action) });
  const h = await harness(undefined, manager.manager);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  try {
    const { admin, password } = await setup(h);
    const acc = await account(admin);
    await repository(admin, acc.id, '101');
    await h.projects.reconcile();

    // Create a project-admin user to verify role-gated read-only binding card later
    const memberRes = await admin('/api/users', 'POST', {
      username: 'proj-admin',
      password: 'ProjectAdminPassword123!',
      role: 'project_admin',
    });
    expect(memberRes.status).toBe(201);
    const assignRes = await admin('/api/project-admin-assignments', 'PUT', {
      user_id: memberRes.value.user.id,
      repository_ids: ['101'],
    });
    expect(assignRes.status).toBe(200);

    // 1. Login as super_admin and open 全局设置 -> 计算节点
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(h.admin + '/#/settings/compute-nodes');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    await expect(page.getByTestId('compute-nodes-overview')).toBeVisible();
    await expect(page.getByTestId('compute-nodes-list')).toContainText('本机节点 (local)');

    // Create a remote node and inspect one-time pairing token & join command
    const createCard = page.getByTestId('compute-nodes-create');
    await createCard.getByLabel('节点名称', { exact: true }).fill('上海 GPU 节点');
    await createCard.getByLabel('节点 ID（可选）', { exact: true }).fill('shanghai-01');
    await createCard.getByLabel('调度标签（可选，键=值 逗号分隔）', { exact: true }).fill('region=cn-east,gpu=true');
    await createCard.getByRole('button', { name: '签发节点接入令牌', exact: true }).click();

    const pairingBox = page.getByTestId('compute-node-pairing-result');
    await expect(pairingBox).toBeVisible();
    await expect(pairingBox).toContainText('bnode_');
    await expect(pairingBox).toContainText('docker compose -f docker/compose.node.yaml');

    const nodeCard = page.locator('[data-node-id="shanghai-01"]');
    await expect(nodeCard).toBeVisible();
    await expect(nodeCard).toContainText('region=cn-east');

    // Edit labels inline
    await nodeCard.locator('summary', { hasText: '编辑节点名称与调度标签' }).click();
    await nodeCard.getByLabel('调度标签', { exact: true }).fill('region=cn-east,gpu=true,tier=fast');
    await nodeCard.getByRole('button', { name: '保存节点属性', exact: true }).click();
    await expect(nodeCard).toContainText('tier=fast');

    // Drain & undrain node via confirmation dialog
    await nodeCard.getByRole('button', { name: '开始排水', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '开始排水', exact: true }).click();
    await expect(nodeCard).toContainText('排水中');

    await nodeCard.getByRole('button', { name: '恢复上线', exact: true }).click();
    await expect(nodeCard).not.toContainText('排水中');

    // Check mobile 390px viewport on #/settings/compute-nodes has zero horizontal overflow
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(nodeCard).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // Revoke remote node cleanly
    await page.setViewportSize({ width: 1440, height: 960 });
    await nodeCard.getByRole('button', { name: '下线撤销', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '撤销节点', exact: true }).click();
    await expect(nodeCard).toHaveCount(0);

    // 2. Register a second online node and verify project「机器配置」node binding UI for super_admin
    const second = await admin('/api/nodes', 'POST', { id: 'worker-online', name: '在线远端节点' });
    expect(second.status).toBe(201);
    h.store.run("UPDATE compute_nodes SET status='online', last_heartbeat_at=? WHERE id='worker-online'", new Date().toISOString());

    await page.goto(h.admin + '/#/projects/101/machine');
    const bindingCard = page.getByTestId('machine-node-binding');
    await expect(bindingCard).toBeVisible();
    await expect(bindingCard.getByTestId('machine-compute-nodes-link')).toHaveAttribute('href', '#/settings/compute-nodes');
    await expect(bindingCard).toContainText('本机节点 (local)');
    await bindingCard.getByLabel('目标计算节点', { exact: true }).selectOption('worker-online');
    await bindingCard.getByRole('button', { name: '切换绑定节点', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认切换节点', exact: true }).click();
    await expect(bindingCard).toContainText('在线远端节点');

    // Direct jump link from project machine page reaches #/settings/compute-nodes
    await bindingCard.getByTestId('machine-compute-nodes-link').click();
    await expect(page).toHaveURL(/#\/settings\/compute-nodes$/);
    await expect(page.getByTestId('compute-nodes-overview')).toBeVisible();
    await page.goto(h.admin + '/#/projects/101/machine');
    await expect(bindingCard).toBeVisible();

    // Mobile 390px overflow check on project machine page
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(bindingCard).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // 3. Verify project-admin sees read-only binding card without rebind control
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('proj-admin');
    await page.getByLabel('密码', { exact: true }).fill('ProjectAdminPassword123!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await page.goto(h.admin + '/#/projects/101/machine');

    await expect(bindingCard).toBeVisible();
    await expect(bindingCard).toContainText('在线远端节点');
    await expect(bindingCard).toContainText('由超级管理员统一维护');
    await expect(bindingCard.getByTestId('machine-compute-nodes-link')).toHaveCount(0);
    await expect(bindingCard.getByRole('button', { name: '切换绑定节点' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    for (const action of cleanup) await action();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
