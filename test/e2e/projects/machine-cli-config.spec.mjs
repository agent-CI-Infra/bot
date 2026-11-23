import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';

async function createFixture() {
  const cleanup = [];
  const manager = await managerFixture({ after: action => cleanup.push(action) });
  const h = await harness(undefined, manager.manager);
  const close = async () => {
    await h.stop();
    for (const action of cleanup) await action();
    rmSync(h.directory, { recursive: true, force: true });
  };
  try {
    const { admin, password } = await setup(h);
    const a = await account(admin);
    await repository(admin, a.id, '101');
    await h.projects.reconcile();
    const readerPassword = testPassword();
    const created = await admin('/api/users', 'POST', {
      username: 'cli-reader',
      password: readerPassword,
      role: 'project_admin',
      repository_ids: ['101'],
    });
    expect(created.status).toBe(201);
    const readerId = created.value?.user?.id ?? created.value?.id ?? h.store.get("SELECT id FROM users WHERE username='cli-reader'")?.id;
    expect(readerId).toBeTruthy();
    h.store.run("UPDATE scoped_grants SET capabilities='[\"tasks.read\"]' WHERE principal_id=?", readerId);
    return { h, admin, password, readerPassword, manager, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function openMachineViaNavigation(page, h, username, password) {
  await page.goto(h.admin + '/#/projects');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('fixture/project-101', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).first().click();
  const machineLink = page.getByRole('link', { name: '机器配置', exact: true });
  await expect(machineLink).toBeVisible();
  await machineLink.click();
  await expect(page.locator('[data-testid="machine-cli-config"]')).toBeVisible();
}

test('CLI local model config card renders status, validates JSON, writes write-only configs, confirms delete, handles stopped computer, and stays read-only without config.write (#1260)', async ({ page, browser }) => {
  const f = await createFixture();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openMachineViaNavigation(page, f.h, 'administrator', f.password);

    const card = page.locator('[data-testid="machine-cli-config"]');
    await expect(card).toContainText('CLI 本地模型配置（项目电脑内自行配置）');
    await expect(card).toContainText('控制面不读取、不保存、不回显文件内容');
    await expect(card.locator('tr[data-cli="claude_code"][data-file="settings.json"]')).toContainText('未配置');
    await expect(card.locator('tr[data-cli="claude_code"][data-file=".credentials.json"]')).toContainText('未配置');
    await expect(card.locator('tr[data-cli="codex"][data-file="config.toml"]')).toContainText('未配置');
    await expect(card.locator('tr[data-cli="codex"][data-file="auth.json"]')).toContainText('未配置');
    await expect(card.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);

    const cliSelect = card.locator('select[name="cli_config_cli"]');
    const fileSelect = card.locator('select[name="cli_config_file"]');
    const contentBox = card.locator('textarea[name="cli_config_content"]');
    const writeBtn = card.getByRole('button', { name: '写入配置文件', exact: true });

    // Invalid JSON returns invalid_cli_config_json, keeps draft in textarea, and leaves status unchanged.
    await cliSelect.selectOption('claude_code');
    await fileSelect.selectOption('settings.json');
    await contentBox.fill('{ not valid json');
    await writeBtn.click();
    await expect(card.locator('[role="status"]')).toContainText('invalid_cli_config_json');
    await expect(contentBox).toHaveValue('{ not valid json');
    await expect(card.locator('tr[data-cli="claude_code"][data-file="settings.json"]')).toContainText('未配置');

    // Valid write clears textarea, shows success feedback, refreshes status, and never echoes secret content in DOM.
    const claudeSecret = 'sk-ant-e2e-never-echo-1260';
    const claudeSettings = JSON.stringify({ model: 'claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: claudeSecret } });
    await contentBox.fill(claudeSettings);
    await writeBtn.click();
    await expect(card.locator('[role="status"]')).toContainText('已写入 /workspace/home/.claude/settings.json');
    await expect(card.locator('[role="status"]')).toContainText('输入框已清空');
    await expect(contentBox).toHaveValue('');
    const claudeRow = card.locator('tr[data-cli="claude_code"][data-file="settings.json"]');
    await expect(claudeRow).toContainText('已存在');
    await expect(claudeRow).toContainText(`${Buffer.byteLength(claudeSettings, 'utf8')} 字节`);
    await expect(claudeRow.getByRole('button', { name: '删除', exact: true })).toBeVisible();
    await expect(card).not.toContainText(claudeSecret);

    // Also write Codex config.toml so both CLIs have present/absent rows.
    await cliSelect.selectOption('codex');
    await fileSelect.selectOption('config.toml');
    const codexToml = 'model = "gpt-5.4"\n';
    await contentBox.fill(codexToml);
    await writeBtn.click();
    await expect(card.locator('[role="status"]')).toContainText('已写入 /workspace/home/.codex/config.toml');
    await expect(contentBox).toHaveValue('');
    const codexRow = card.locator('tr[data-cli="codex"][data-file="config.toml"]');
    await expect(codexRow).toContainText('已存在');

    // Verify no horizontal overflow at 1440px and 390px.
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Read-only actor (without config.write) sees present/absent status table but NO editor and NO delete buttons.
    const readerCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const readerPage = await readerCtx.newPage();
    const readerErrors = [];
    readerPage.on('pageerror', err => readerErrors.push(err.message));
    try {
      await openMachineViaNavigation(readerPage, f.h, 'cli-reader', f.readerPassword);
      const readerCard = readerPage.locator('[data-testid="machine-cli-config"]');
      await expect(readerCard.locator('tr[data-cli="claude_code"][data-file="settings.json"]')).toContainText('已存在');
      await expect(readerCard.locator('tr[data-cli="claude_code"][data-file=".credentials.json"]')).toContainText('未配置');
      await expect(readerCard.locator('tr[data-cli="codex"][data-file="config.toml"]')).toContainText('已存在');
      await expect(readerCard.locator('tr[data-cli="codex"][data-file="auth.json"]')).toContainText('未配置');
      await expect(readerCard.locator('.cli-config-editor')).toHaveCount(0);
      await expect(readerCard.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
      await expect(readerCard).not.toContainText(claudeSecret);
      expect(readerErrors).toEqual([]);
    } finally {
      await readerCtx.close();
    }

    // Delete behind confirmation dialog: cancel keeps file, confirm deletes it.
    await claudeRow.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('删除 /workspace/home/.claude/settings.json');
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(claudeRow).toContainText('已存在');

    await claudeRow.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(card.locator('[role="status"]')).toContainText('已删除 /workspace/home/.claude/settings.json');
    await expect(claudeRow).toContainText('未配置');
    await expect(claudeRow.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);

    // Stopped project computer shows unavailable reason cleanly.
    const stopped = await f.admin('/api/environments/101/stop', 'POST', {
      operation_id: randomBytes(24).toString('hex'),
      generation: 1,
    });
    expect([200, 201]).toContain(stopped.status);
    await page.reload();
    await expect(page.locator('[data-testid="machine-cli-config"]')).toContainText('computer_not_ready');
    await expect(page.locator('[data-testid="machine-cli-config"]')).toContainText('项目电脑当前未运行或暂不可访问');
    await expect(page.locator('[data-testid="machine-cli-config"]').getByRole('button', { name: '写入配置文件', exact: true })).toBeDisabled();

    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});
