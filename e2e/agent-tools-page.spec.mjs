import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { startMockToolUpstream } from '../test/agent-tools-fixture.mjs';
import { AgentToolManager } from '../dist/harness/agent-tools.js';
import { beginRun } from '../dist/tasks/trace.js';
import { allocateLease, recordRunCliVersion } from '../dist/roles/role-run.js';

// #740: the console page for the Agent CLI tool volume. Every install below goes through the real service and a mock
// download upstream, so the page, the API and the installer are exercised together instead of against a stub status.
async function fill(page, url, username, password) {
  await page.goto(url);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('the tool volume page installs a CLI, reports a refused download and keeps a running version when pruning', async ({ page, browser }) => {
  // Three real installs against the mock upstream, three widths of screenshots and a second sign-in.
  test.setTimeout(120000);
  const root = mkdtempSync(join(tmpdir(), 'agent-tools-page-')), cleanups = [];
  const t = { after: fn => cleanups.push(fn) };
  const upstream = await startMockToolUpstream(t, 'x64');
  const h = await harness(undefined, undefined, {
    agentTools: new AgentToolManager({ volumeRoot: root, containerRoot: '/opt/agent-tools', arch: 'x64', sources: upstream.sources }),
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  mkdirSync('.tmp/agent-tools-page', { recursive: true });
  try {
    const { admin, password } = await setup(h);
    const bot = await account(admin);
    await repository(admin, bot.id, '101');
    const memberPassword = testPassword();
    await admin('/api/users', 'POST', { username: 'member', password: memberPassword, role: 'project_admin', repository_ids: ['101'] });

    await fill(page, h.admin + '/#/settings/agent-tools', 'administrator', password);
    // An empty volume is an empty state plus a usable form, not a dead end.
    await expect(page.locator('nav.project-nav a', { hasText: 'Agent CLI 工具卷' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: '工具卷', exact: true })).toBeVisible();
    await expect(page.locator('.agent-tools-cli[data-cli="codex"]')).toContainText('尚未安装');
    await expect(page.locator('.agent-tools-install select[name="cli"]')).toBeVisible();

    // Installing a Codex version through the page downloads it from the mock release API and refreshes the page.
    await page.locator('.agent-tools-install select[name="cli"]').selectOption('codex');
    await page.locator('.agent-tools-install input[name="version"]').fill('0.166.0');
    await page.locator('.agent-tools-install button[type="submit"]').click();
    await expect(page.locator('.agent-tools-cli[data-cli="codex"]')).toContainText('当前选用 0.166.0');
    await expect(page.locator('.agent-tools-cli[data-cli="codex"]')).toContainText('0.166.0');

    // A tampered archive is refused with the service's own answer, and the form keeps what was typed.
    upstream.setTamperClaudeHash(true);
    await page.locator('.agent-tools-install select[name="cli"]').selectOption('claude_code');
    await page.locator('.agent-tools-install input[name="version"]').fill('2.1.319');
    await page.locator('.agent-tools-install button[type="submit"]').click();
    await expect(page.locator('.agent-tools-install .view-error')).toContainText('agent_tool_hash_mismatch');
    await expect(page.locator('.agent-tools-install input[name="version"]')).toHaveValue('2.1.319');
    upstream.setTamperClaudeHash(false);

    // A version a running task executes survives a prune that would otherwise drop it.
    await page.locator('.agent-tools-install select[name="cli"]').selectOption('codex');
    await page.locator('.agent-tools-install input[name="version"]').fill('0.167.0');
    await page.locator('.agent-tools-install button[type="submit"]').click();
    await expect(page.locator('.agent-tools-cli[data-cli="codex"]')).toContainText('当前选用 0.167.0');
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,summary,input,attempt,generation) VALUES('t740','101','task.request','running','fixture','{}',1,1)");
    const run = beginRun(h.store, h.store.get("SELECT * FROM tasks WHERE id='t740'"), 'execution', {});
    h.store.run("UPDATE task_runs SET role='developer',harness='codex',harness_version='1' WHERE id=?", run.id);
    allocateLease(h.store, 't740', 'assign-740', run.id);
    recordRunCliVersion(h.store, run.id, '0.166.0');
    await page.locator('.agent-tools-prune select[name="cli"]').selectOption('codex');
    await page.locator('.agent-tools-prune input[name="retain_count"]').fill('1');
    await page.locator('.agent-tools-prune button[type="submit"]').click();
    // Nothing was removed: the only version outside the retained count is the one a running task executes.
    await expect(page.locator('.agent-tools-prune')).toContainText('本次没有删除任何版本');
    await expect(page.locator('.agent-tools-prune')).toContainText('正在运行');
    // The protected version is still installed and still selected is the newest; nothing claims it was removed.
    await expect(page.locator('.agent-tools-cli[data-cli="codex"]')).toContainText('0.166.0');
    await expect(page.locator('.agent-tools-cli[data-cli="codex"]')).toContainText('0.167.0');

    // Three widths, full page, no horizontal overflow.
    for (const [width, height] of [[1440, 1000], [768, 1000], [390, 844]]) {
      await page.setViewportSize({ width, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.tmp/agent-tools-page/after-${width}.png`, fullPage: true });
    }

    // A project administrator has no entry, and the API itself refuses them.
    const member = h.client();
    expect((await member('/api/auth/login', 'POST', { username: 'member', password: memberPassword })).status).toBe(200);
    expect((await member('/api/agent-tools')).status).toBe(403);
    // A separate browser context, because the administrator's session is still open in this one.
    const memberPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await fill(memberPage, h.admin + '/#/settings/agent-tools', 'member', memberPassword);
      // Signing in opens the project list; the one settings category this role may open has no tool entry.
      await memberPage.goto(h.admin + '/#/settings/storage');
      const settingsNav = memberPage.getByRole('navigation', { name: '设置类别' });
      await expect(settingsNav.getByRole('link')).toHaveText(['存储']);
      await expect(settingsNav).not.toContainText('Agent CLI 工具卷');
    } finally { await memberPage.close(); }
    expect(errors).toEqual([]);
  } finally {
    for (const cleanup of cleanups) await cleanup();
    rmSync(root, { recursive: true, force: true });
    await h.stop();
  }
});
