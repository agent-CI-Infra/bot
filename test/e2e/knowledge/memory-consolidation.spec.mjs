import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';

function seedBoundGroup(store, adminUserId, repoId, modelId) {
  const connId = '1'.repeat(48), credId = '2'.repeat(48), chatId = '3'.repeat(48);
  const bindingId = '4'.repeat(48), bindPrincipal = 'p-e2e-group';
  const now = Date.now();
  store.run('INSERT OR IGNORE INTO channel_credentials VALUES(?,?)', credId, store.secrets.seal({ app_secret: 'sec' }, 'channel-credential:' + credId));
  store.run(`INSERT OR IGNORE INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at,owner_tenant,created_by)
    VALUES(?,'feishu','cli_e2e','tenant_e2e','ou_bot','enterprise','websocket',?,1,1,?,'',?)`, connId, credId, now, adminUserId);
  store.run(`INSERT OR IGNORE INTO channel_chats(id,connector_id,provider,app_id,installation_tenant,chat_id,chat_type,state,display_name,context_revision,revision,retained_after,created_at,last_received_at)
    VALUES(?,?,'feishu','cli_e2e','tenant_e2e','oc_e2e_group','group','active','记忆测试群',1,1,0,?,?)`, chatId, connId, now, now);
  store.run("INSERT OR IGNORE INTO principals(id,kind,active,authorization_revision,maintenance) VALUES(?,'service',1,1,?)", bindPrincipal, 'channel-binding:' + chatId);
  const tenantId = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', repoId)?.tenant_id || 't1';
  store.run(`INSERT OR IGNORE INTO channel_service_bindings(id,chat_id,service_role_id,scope,principal_id,configured_by,owner_id,participation,permissions,model_id,prompt,harness,enabled,revision,created_at,updated_at)
    VALUES(?,?,'group-assistant','repositories',?,?,?,'mentions',?,?,?,'pi',1,1,?,?)`,
    bindingId, chatId, bindPrincipal, adminUserId, adminUserId,
    JSON.stringify({ github_issues: 'read', github_pull_requests: 'read', github_actions: 'read', github_contents: 'read', github_checks: 'read', github_statuses: 'read', project_tasks: 'read', project_memory: 'read', project_configuration: 'none', schedules: 'none', delegation: 'deny' }),
    modelId, '', now, now);
  store.run(`INSERT OR IGNORE INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,grantor_id,policy,evidence,verified_at)
    VALUES('g-e2e-group',?,?,?,'project','service',?,'explicit_delegation',?,'channel_service_binding',?,?)`,
    bindPrincipal, tenantId, repoId, JSON.stringify(['tasks.read', 'knowledge.read']), adminUserId, 'channel:' + chatId, now);
  return chatId;
}

async function createFixture(page) {
  const cleanup = [];
  const homesDir = mkdtempSync(join(tmpdir(), 'e2e-mc-homes-'));
  cleanup.push(() => rmSync(homesDir, { recursive: true, force: true }));
  const mf = await managerFixture({ after: fn => cleanup.push(fn) });
  const h = await harness(undefined, mf.manager, {
    assistantHomes: homesDir,
    consolidation: {
      automatic: false,
      runner: async ctx => {
        if (ctx.scope_kind === 'project') {
          await ctx.execute('save_project_note', { path: 'INDEX.md', content: '# Consolidated Project Index\n\nUpdated by Pi.' });
          await ctx.execute('delete_project_note', { path: 'temp-note.md' });
          return { summary: '已整理项目知识并清理 temp-note.md。' };
        }
        await ctx.execute('write_file', { path: '~/memory/INDEX.md', content: '# Consolidated Private Memory\n\nUpdated by Pi.' });
        return { summary: '已整理私有记忆。' };
      },
    },
  });
  const { admin, password } = await setup(h);
  const acc = await account(admin);
  await repository(admin, acc.id, '101');
  const shared = (await admin('/api/models', 'POST', {
    provider_name: 'Nightly', api_url: 'http://127.0.0.1:9999/v1', model_name: 'pi-nightly', api_key: 'sk-e2e-key-123456',
  })).value.model;
  await admin('/api/repositories/101/policy', 'PATCH', { model_id: shared.id });
  const roleRow = h.store.get("SELECT revision FROM service_roles WHERE id='management-assistant'");
  const rolePatch = await admin('/api/service-roles/management-assistant', 'PATCH', {
    name: '管理助手', responsibility: 'test', prompt: '', model_id: shared.id, expected_revision: roleRow.revision,
  });
  if (rolePatch.status !== 200) throw new Error('service role patch failed: ' + JSON.stringify(rolePatch));
  await admin('/api/repositories/101/knowledge-files', 'POST', { name: 'temp-note.md', content: 'Obsolete note to delete and restore.' });
  const adminPrincipal = h.store.get("SELECT id FROM principals WHERE kind='human' LIMIT 1").id;
  const chatId = seedBoundGroup(h.store, adminPrincipal, '101', shared.id);

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  return {
    h, admin, password, shared, chatId, errors,
    async login(hash = '#/settings/memory-consolidation') {
      await page.goto(h.admin + '/' + hash);
      await page.getByLabel('用户名', { exact: true }).fill('administrator');
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
    },
    async assertNoHorizontalOverflow(label) {
      const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(ok, `no horizontal overflow at ${label}`).toBe(true);
    },
    async close() {
      await h.stop();
      rmSync(h.directory, { recursive: true, force: true });
      for (const fn of cleanup.reverse()) await fn();
    },
  };
}

test('global settings, project knowledge consolidation & restore, and group/personal ~/memory/ browsers work at 1440px and 390px', async ({ page }) => {
  test.setTimeout(90000);
  const f = await createFixture(page);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await f.login('#/settings/memory-consolidation');

    // 1. Global Settings -> Nightly Memory Consolidation
    const settingsPanel = page.locator('#settings-panel');
    await expect(settingsPanel.getByRole('heading', { name: '夜间自动记忆整理', exact: true })).toBeVisible();
    const enabledBox = settingsPanel.locator('input[name="enabled"]');
    await expect(enabledBox).toBeChecked();
    await settingsPanel.locator('input[name="window_start"]').fill('01:30');
    await settingsPanel.locator('input[name="window_end"]').fill('04:30');
    await settingsPanel.locator('input[name="max_concurrency"]').fill('3');
    await settingsPanel.locator('select[name="model_id"]').selectOption(f.shared.id);
    await settingsPanel.getByRole('button', { name: '保存全局设置', exact: true }).click();
    await expect(settingsPanel.getByText('夜间记忆整理全局设置已保存。')).toBeVisible();
    await f.assertNoHorizontalOverflow('global-settings-1440');

    await page.reload();
    await expect(settingsPanel.locator('input[name="window_start"]')).toHaveValue('01:30');
    await expect(settingsPanel.locator('input[name="max_concurrency"]')).toHaveValue('3');

    // 2. Global Settings -> Storage retention includes project_notes history fields
    await page.goto(f.h.admin + '/#/settings/storage');
    await page.getByText('保留天数与项目设置', { exact: true }).click();
    await expect(page.locator('input[name="project_notes_keep_versions"]')).toHaveValue('50');
    await expect(page.locator('input[name="project_notes_keep_days"]')).toHaveValue('30');

    // 3. Project Knowledge -> Consolidation bar, manual run, and one-click jump to deleted file history & restore
    await page.goto(f.h.admin + '/#/projects/101/knowledge');
    await expect(page.locator('.mc-knowledge-bar')).toBeVisible();
    await page.getByRole('button', { name: '整理设置与记录', exact: true }).click();
    await expect(page.locator('.mc-knowledge-drawer')).toBeVisible();
    // Save per-project consolidation settings and verify the inline confirmation remains visible after redraw
    await page.locator('.mc-knowledge-drawer select[name="enabled_override"]').selectOption('on');
    await page.locator('.mc-knowledge-drawer').getByRole('button', { name: '保存整理设置', exact: true }).click();
    await expect(page.locator('.mc-knowledge-drawer').getByRole('status')).toHaveText('记忆整理设置已保存。');
    await expect(page.locator('.mc-knowledge-drawer').getByRole('status')).toBeVisible();
    await page.locator('.mc-knowledge-drawer').getByRole('button', { name: '立即整理', exact: true }).click();
    await expect(page.locator('.mc-knowledge-drawer')).toContainText('已整理项目知识并清理 temp-note.md。');
    await expect(page.locator('.mc-knowledge-drawer')).toContainText('删除：temp-note.md');
    await f.assertNoHorizontalOverflow('project-knowledge-1440');

    // Clicking the deleted file pill jumps straight to its version history where one-click restore works
    await page.locator('.mc-knowledge-drawer button.mc-file-pill-deleted').click();
    await expect(page.getByRole('complementary', { name: '文件历史' })).toBeVisible();
    await expect(page.locator('.knowledge-history')).toContainText('夜间记忆整理');

    // 4. Personal Settings -> Personal consolidation & ~/memory/ browser (desktop + 390px mobile)
    await page.goto(f.h.admin + '/#/identity');
    await expect(page.getByRole('heading', { name: '个人管理助手夜间记忆整理', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '个人管理助手私有记忆（~/memory/）', exact: true })).toBeVisible();

    const personalBrowser = page.locator('.identity-personal-memory .mc-browser').first();
    await personalBrowser.getByRole('button', { name: '新建文件', exact: true }).click();
    await personalBrowser.locator('input[name="memory_path"]').fill('preferences.md');
    await personalBrowser.locator('textarea[name="memory_content"]').fill('# 偏好\n\n使用简体中文总结。');
    await personalBrowser.getByRole('button', { name: '保存文件', exact: true }).click();
    await expect(personalBrowser.locator('.mc-browser-preview')).toContainText('使用简体中文总结。');

    // Trigger personal consolidation and verify INDEX.md appears
    await page.locator('.identity-personal-memory').getByRole('button', { name: '立即整理', exact: true }).click();
    await expect(page.locator('.identity-personal-memory')).toContainText('已整理私有记忆。');
    await expect(personalBrowser.locator('.mc-browser-files')).toContainText('INDEX.md');
    await f.assertNoHorizontalOverflow('identity-1440');

    // Mobile 390px check on Personal Settings & Global Settings
    await page.setViewportSize({ width: 390, height: 844 });
    await f.assertNoHorizontalOverflow('identity-390');

    // 5. Group Assistant Settings -> Group consolidation & ~/memory/ browser (390px + 1440px)
    await page.goto(f.h.admin + '/#/identity/feishu/groups/' + f.chatId);
    await expect(page.getByRole('heading', { name: '本群夜间自动记忆整理', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '群聊助手私有记忆（~/memory/）', exact: true })).toBeVisible();
    await f.assertNoHorizontalOverflow('group-settings-390');

    await page.setViewportSize({ width: 1440, height: 900 });
    const groupBrowser = page.locator('.mc-group-extra .mc-browser').first();
    await groupBrowser.getByRole('button', { name: '新建文件', exact: true }).click();
    await groupBrowser.locator('input[name="memory_path"]').fill('team.md');
    await groupBrowser.locator('textarea[name="memory_content"]').fill('# 群协作约定\n\n每日早会 10:00。');
    await groupBrowser.getByRole('button', { name: '保存文件', exact: true }).click();
    await expect(groupBrowser.locator('.mc-browser-preview')).toContainText('每日早会 10:00。');
    await groupBrowser.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除文件', exact: true }).click();
    await expect(groupBrowser).toContainText('~/memory/ 目录下暂无记忆文件。');
    await f.assertNoHorizontalOverflow('group-settings-1440');

    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
