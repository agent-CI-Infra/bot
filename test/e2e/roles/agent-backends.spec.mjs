import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository, testPassword } from '../../fixtures/helpers.mjs';
import { openRoleAdvanced, goRolePage, openRoleFormAdvanced } from '../helpers/open-role-advanced.mjs';
import { TaskEngine } from '../../../dist/agent/engine.js';
import { consoleSave, compareWithServer, confirmDiscard } from '../helpers/console-save.mjs';

test('角色按能力选择 Agent 后端，展示外部后端的就绪状态与模型来源', async ({ page }) => {
  const prevToolsDir = process.env.BOT_AGENT_TOOLS_DIR;
  const toolsDir = mkdtempSync(join(tmpdir(), 'e2e-agent-tools-'));
  process.env.BOT_AGENT_TOOLS_DIR = toolsDir;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  mkdirSync(join(toolsDir, 'codex', '0.166.0', 'bin'), { recursive: true });
  writeFileSync(join(toolsDir, 'codex', '0.166.0', 'bin', 'codex'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(toolsDir, 'codex', '0.166.0', 'bin', 'codex'), 0o755);
  writeFileSync(join(toolsDir, 'codex', '0.166.0', 'manifest.json'), JSON.stringify({
    schema: 'bot.agent-tools/1',
    cli: 'codex',
    version: '0.166.0',
    arch,
    installed_at: '2026-11-15T00:00:00Z',
    container_executable: '/opt/agent-tools/codex/0.166.0/bin/codex',
    container_node_executable: null,
    node_version: null,
    artifacts: [{ role: 'static_binary', source_url: 'https://example.invalid/codex.tar.gz', sha256: 'a'.repeat(64), bytes: 32 }],
  }));
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'cmpl-1', choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');

  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }), maxBodyBytes: 1024 * 1024 })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin);
    await repository(admin, a.id, '101');
    const model = await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Fixture', api_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key: testPassword() });
    await admin('/api/repositories/101/policy', 'PATCH', { model_id: model.value.model.id });
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const roles = ['coordinator', 'manager', 'dev', 'test', 'reviewer', 'ux', 'qa'];
    await openRoleAdvanced(page);
    await expect(page.getByTestId('backend-availability-card')).toBeVisible();
    await expect(page.getByTestId('backend-availability-card')).toContainText('Claude Code');
    await expect(page.getByTestId('backend-availability-card')).toContainText('Codex');
    for (const role of roles) {
      await goRolePage(page, { role });
      const picker = page.getByTestId('role-form').getByRole('combobox', { name: `${role} Agent 后端`, exact: true });
      await expect(picker).toHaveValue('pi');
      const optionValues = await picker.locator('option').evaluateAll(els => els.map(el => el.value));
      const acp = ['dev', 'test', 'reviewer', 'ux'].includes(role) ? ['container_acp'] : [];
      expect(optionValues).toEqual(['pi', 'claude_code', 'codex', ...acp, 'native', 'process']);
      const optionDisabled = (value) => picker.locator(`option[value="${value}"]`).evaluate(el => el.disabled);
      for (const backend of ['pi', 'native', 'process']) expect(await optionDisabled(backend)).toBe(false);
      // Harness selection is independent of controller/worker role.
      for (const backend of ['claude_code', 'codex']) {
        expect(await optionDisabled(backend)).toBe(false);
      }
    }
    await goRolePage(page, { role: 'dev' });
    const acpPicker = page.getByLabel('dev Agent 后端', { exact: true });
    await acpPicker.selectOption('container_acp');
    await expect(page.getByTestId('backend-runtime-status')).toContainText('平台网关（按角色配置解析）');
    await expect(page.getByLabel('dev 模型来源', { exact: true })).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await acpPicker.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: `.tmp/agent-backends/acp-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await goRolePage(page, { role: 'manager' });
    await page.getByRole('combobox', { name: 'manager Agent 后端', exact: true }).selectOption('native');
    await goRolePage(page, { role: 'reviewer' });
    await page.getByRole('combobox', { name: 'reviewer Agent 后端', exact: true }).selectOption('codex');
    await expect(page.getByTestId('backend-runtime-status')).toBeVisible();
    const reviewerModelSource = page.getByRole('combobox', { name: 'reviewer 模型来源', exact: true });
    await expect(reviewerModelSource).toHaveValue('gateway');
    await reviewerModelSource.selectOption('subscription');
    await expect(page.getByTestId('subscription-not-implemented')).toBeVisible();
    await expect(page.getByTestId('subscription-not-implemented')).toContainText('未实现');
    await goRolePage(page, { role: 'dev' });
    await page.getByRole('combobox', { name: 'dev Agent 后端', exact: true }).selectOption('claude_code');
    await expect(page.getByTestId('backend-runtime-status')).toBeVisible();
    // #740: a role page whose CLI is unavailable is where a super administrator gets the way into the tool volume.
    await expect(page.getByTestId('backend-runtime-status')).toContainText('未就绪');
    const roleToolsLink = page.getByTestId('backend-runtime-status').getByRole('link', { name: '打开工具卷设置' });
    await expect(roleToolsLink).toBeVisible();
    await expect(roleToolsLink).toHaveAttribute('href', '#/settings/agent-tools');
    await expect(page.getByTestId('backend-runtime-status')).toContainText('安装或清理 Claude Code 与 Codex 的版本');
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toContainText('角色配置已保存');
    const savedSub = (await admin('/api/repositories/101/roles')).value;
    expect(savedSub.configuration.roles.find(r => r.role_id === 'reviewer').harness_ref).toMatchObject({ id: 'codex', model_source: 'subscription' });
    await page.reload();
    await goRolePage(page, { role: 'reviewer' });
    await expect(page.getByRole('combobox', { name: 'reviewer 模型来源', exact: true })).toHaveValue('subscription');
    await expect(page.getByTestId('subscription-not-implemented')).toBeVisible();
    // Switch model_source from subscription back to gateway and verify explicit persistence (#705 M6).
    await page.getByRole('combobox', { name: 'reviewer 模型来源', exact: true }).selectOption('gateway');
    await expect(page.getByTestId('subscription-not-implemented')).toHaveCount(0);
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toContainText('角色配置已保存');
    const saved = (await admin('/api/repositories/101/roles')).value;
    expect(saved.configuration.roles.find(r => r.role_id === 'manager').harness_ref.id).toBe('native');
    expect(saved.configuration.roles.find(r => r.role_id === 'reviewer').harness_ref.id).toBe('codex');
    expect(saved.configuration.roles.find(r => r.role_id === 'reviewer').harness_ref.model_source).toBeUndefined();
    expect(saved.configuration.roles.find(r => r.role_id === 'dev').harness_ref.id).toBe('claude_code');
    expect(saved.configuration.roles.find(r => r.role_id === 'qa').harness_ref.id).toBe('pi');
    await page.reload();
    await goRolePage(page, { role: 'manager' });
    await expect(page.getByRole('combobox', { name: 'manager Agent 后端', exact: true })).toHaveValue('native');
    await goRolePage(page, { role: 'reviewer' });
    await expect(page.getByRole('combobox', { name: 'reviewer Agent 后端', exact: true })).toHaveValue('codex');
    await expect(page.getByRole('combobox', { name: 'reviewer 模型来源', exact: true })).toHaveValue('gateway');
    await expect(page.getByTestId('subscription-not-implemented')).toHaveCount(0);
    await expect(page.getByTestId('backend-runtime-status')).toContainText('连通性未探测');
    await expect(page.getByTestId('probe-role-model')).toBeVisible();
    const scrollUnderSticky = async (targetPage, locator) => {
      await locator.evaluate(el => window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 120)));
      await targetPage.waitForTimeout(50);
    };
    mkdirSync('.tmp/agent-backends', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await scrollUnderSticky(page, page.getByTestId('backend-runtime-status'));
    await page.screenshot({ path: '.tmp/agent-backends/detail-untested-1440.png' });

    const probeResp = page.waitForResponse(r => r.url().endsWith('/api/repositories/101/roles/probe-model') && r.request().method() === 'POST');
    await page.getByTestId('probe-role-model').click();
    expect((await probeResp).status()).toBe(201);
    await expect(page.getByTestId('backend-runtime-status')).toContainText('连通正常（HTTP 200）');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await scrollUnderSticky(page, page.getByTestId('backend-runtime-status'));
    await page.screenshot({ path: '.tmp/agent-backends/detail-editor-1440.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await scrollUnderSticky(page, page.getByTestId('backend-runtime-status'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/agent-backends/detail-editor-390.png' });

    await goRolePage(page, { role: 'dev' });
    await expect(page.getByRole('combobox', { name: 'dev Agent 后端', exact: true })).toHaveValue('claude_code');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.tmp/agent-backends/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('backend-runtime-status')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // #740 review: that entry actually opens the tool volume category, and coming back lands on the same role page.
    await page.getByTestId('backend-runtime-status').getByRole('link', { name: '打开工具卷设置' }).click();
    await expect(page).toHaveURL(/#\/settings\/agent-tools$/);
    await expect(page.getByRole('heading', { name: '工具卷', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('backend-runtime-status')).toBeVisible();
    await goRolePage(page, { role: 'qa' });
    await expect(page.getByRole('combobox', { name: 'qa Agent 后端', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await goRolePage(page);
    await expect(page.getByTestId('backend-availability-card')).toBeVisible();
    await expect(page.getByTestId('backend-availability-card')).toContainText('连通正常（HTTP 200）');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await scrollUnderSticky(page, page.getByTestId('backend-availability-card'));
    await page.screenshot({ path: '.tmp/agent-backends/overview-390.png' });
    await page.screenshot({ path: '.tmp/agent-backends/mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await scrollUnderSticky(page, page.getByTestId('backend-availability-card'));
    await page.screenshot({ path: '.tmp/agent-backends/overview-1440.png' });

    // Read-only viewer (tasks.read without roles.edit) sees connectivity status without the probe mutation button.
    const readerPassword = testPassword();
    const createdReader = await admin('/api/users', 'POST', { username: 'role-reader', password: readerPassword, role: 'project_admin', repository_ids: ['101'] });
    expect(createdReader.status).toBe(201);
    h.store.run("UPDATE scoped_grants SET capabilities='[\"tasks.read\"]' WHERE principal_id=(SELECT id FROM principals WHERE user_id=?)", createdReader.value.user.id);
    const readerContext = await page.context().browser().newContext({ viewport: { width: 1440, height: 1000 } });
    const readerPage = await readerContext.newPage();
    try {
      await readerPage.goto(h.admin + '/#/projects/101/roles/reviewer');
      await readerPage.getByLabel('用户名', { exact: true }).fill('role-reader');
      await readerPage.getByLabel('密码', { exact: true }).fill(readerPassword);
      await readerPage.getByRole('button', { name: '登录', exact: true }).click();
      await expect(readerPage.getByTestId('backend-runtime-status')).toContainText('连通正常（HTTP 200）');
      await expect(readerPage.getByTestId('probe-role-model')).toHaveCount(0);
      await scrollUnderSticky(readerPage, readerPage.getByTestId('backend-runtime-status'));
      await readerPage.screenshot({ path: '.tmp/agent-backends/detail-readonly-1440.png' });
      await readerPage.setViewportSize({ width: 390, height: 844 });
      await scrollUnderSticky(readerPage, readerPage.getByTestId('backend-runtime-status'));
      expect(await readerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await readerPage.screenshot({ path: '.tmp/agent-backends/detail-readonly-390.png' });
      // #740: a project administrator cannot open the tool volume category, so the same role page names who can install.
      await readerPage.goto(h.admin + '/#/projects/101/roles/dev');
      await expect(readerPage.getByTestId('backend-runtime-status')).toContainText('请平台管理员在「全局设置 → Agent CLI 工具卷」中安装兼容版本。');
      await expect(readerPage.getByTestId('backend-runtime-status').getByRole('link', { name: '打开工具卷设置' })).toHaveCount(0);
    } finally {
      await readerContext.close();
    }
    // Load an unmarked old V2 definition: the UI always resubmits its saved harness id.
    const old = JSON.parse(h.store.get("SELECT value FROM settings WHERE key='roles:101'").value);
    const dev = old.roles.find(r => r.role_id === 'dev');
    delete dev.entry_harness_source; dev.harness_ref = { id: 'native', version: '1' };
    h.store.run("UPDATE settings SET value=? WHERE key='roles:101'", JSON.stringify(old));
    await page.reload();
    await goRolePage(page, { role: 'dev' });
    const warning = page.getByText('检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更', { exact: true });
    await expect(warning).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'dev Agent 后端', exact: true })).toHaveValue('native');
    // No-op save is not offered: the bar only shows「保存」when the draft differs from the server (#567).
    await expect(consoleSave(page)).toBeHidden();
    await expect(warning).toBeVisible();
    expect((await admin('/api/repositories/101/roles')).value.configuration.roles.find(r => r.role_id === 'dev').entry_harness_source).toBeUndefined();
    await page.getByRole('combobox', { name: 'dev Agent 后端', exact: true }).selectOption('process');
    await consoleSave(page).click();
    await expect(page.locator('#project-page .flash')).toContainText('角色配置已保存');
    await expect(warning).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'dev Agent 后端', exact: true })).toHaveValue('process');
    await expect(warning).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (prevToolsDir === undefined) delete process.env.BOT_AGENT_TOOLS_DIR;
    else process.env.BOT_AGENT_TOOLS_DIR = prevToolsDir;
    await h.stop();
    await new Promise(r => { upstream.close(r); upstream.closeAllConnections(); });
    rmSync(toolsDir, { recursive: true, force: true });
  }
});
