import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { harness, setup, account, repository, testPassword } from '../test/helpers.mjs';
import { TaskEngine } from '../dist/agent/engine.js';
import { openRoleAdvanced, goRolePage, openRoleFormAdvanced } from './open-role-advanced.mjs';
import { consoleSave, compareWithServer, confirmDiscard } from './console-save.mjs';

test('角色概览和详情通过表单保存模型、提示词、预算、技能和阶段，保留草稿并拒绝过期保存', async ({ page }) => {
  test.setTimeout(90000);
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) })), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    const model = (await admin('/api/models', 'POST', { repository_id: '101', model_name: 'Coding model', api_url: 'http://127.0.0.1:9/v1', api_key: testPassword() })).value.model;
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('link', { name: '角色', exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('recommended-roles-intro')).toBeVisible();
    await openRoleAdvanced(page);
    await expect(page.getByRole('heading', { name: '角色概览', exact: true })).toBeVisible();
    await expect(page.locator('textarea[name=role_configuration]')).toHaveCount(0);
    await expect(page.getByText('工作类型：开关、写入与设置', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '角色列表' }).getByRole('link', { name: '技能包目录', exact: true })).toBeVisible();
    await goRolePage(page, { role: 'dev' });
    await expect(page).toHaveURL(/\/roles\/dev$/);
    await page.getByLabel('dev Agent 后端', { exact: true }).selectOption('native');
    await page.getByLabel('dev 模型', { exact: true }).selectOption(model.id);
    await page.getByLabel('角色提示词', { exact: true }).fill('先读复现，再修改代码并验证。');
    await expect(page.getByLabel('系统提示词', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByText('查看固定职责与任务记录规则', { exact: true })).toHaveCount(0);
    await expect(page.getByText('能力策略', { exact: true })).toHaveCount(0);
    await openRoleFormAdvanced(page);
    await page.getByLabel('dev 使用虚拟电脑权限', { exact: true }).selectOption('deny');
    await page.getByLabel('dev 项目任务与协作权限', { exact: true }).selectOption('write');
    await page.getByLabel('dev 指派其他角色权限', { exact: true }).selectOption('deny');
    await page.getByLabel('预算方式', { exact: true }).selectOption('bounded');
    await expect(page.getByText('未配置的轮次沿用运行入口缺省值：', { exact: false })).toBeVisible();
    await page.getByLabel('单次运行最多模型轮数', { exact: true }).fill('200');
    await page.getByLabel('单次输出最多 token', { exact: true }).fill('32768');
    await goRolePage(page, { role: 'test' });
    await goRolePage(page, { role: 'dev' });
    await expect(page.getByLabel('角色提示词', { exact: true })).toHaveValue('先读复现，再修改代码并验证。');
    await expect(page.getByLabel('dev 模型', { exact: true })).toHaveValue(model.id);
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
    let saved = (await admin('/api/repositories/101/roles')).value.configuration, dev = saved.roles.find(role => role.role_id === 'dev');
    expect(dev.persona_prompt).toBe('先读复现，再修改代码并验证。'); expect(dev.model_profile_ref.model_id).toBe(model.id);
    expect(dev.permissions).toMatchObject({ computer: 'deny', project_tasks: 'write', delegation: 'deny' });
    expect(dev.capability_policy_ref).toBeUndefined();
    expect(dev.budget_policy_ref).toMatchObject({ id: 'bounded', max_turns: 200, max_output_tokens: 32768 });
    await openRoleFormAdvanced(page);
    mkdirSync('.tmp/role-settings', { recursive: true });
    await page.getByLabel('预算方式',{exact:true}).selectOption('metered');
    await expect(page.locator('input[name=max_cost]')).toHaveCount(0);
    await expect(page.getByText('任务累计金额上限（留空不设置）',{exact:true})).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByLabel('预算方式', { exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByLabel('单次运行最多模型轮数', { exact: true })).toHaveValue('200');
      await expect(page.getByLabel('单次输出最多 token', { exact: true })).toHaveValue('32768');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.tmp/role-settings/budget-${width}.png` });
      await page.getByLabel('任务累计秒数',{exact:true}).scrollIntoViewIfNeeded();
      await expect(page.getByLabel('任务累计秒数',{exact:true})).toBeVisible();
      await page.screenshot({path:`.tmp/role-settings/cost-free-${width}.png`});
    }
    await page.getByLabel('预算方式',{exact:true}).selectOption('bounded');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await goRolePage(page);
    await page.getByRole('button', { name: '添加技能包', exact: true }).click();
    await page.locator('.role-skill').getByLabel('文件内容', { exact: true }).fill('记录测试证据。');
    await goRolePage(page, { role: 'dev' });
    await openRoleFormAdvanced(page);
    await page.getByLabel('dev 技能包', { exact: true }).selectOption('skills_1');
    await goRolePage(page);
    await page.getByRole('button', { name: '添加阶段', exact: true }).click();
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101/roles')).value.configuration.revision).toBe(2);
    saved = (await admin('/api/repositories/101/roles')).value.configuration;
    expect(saved.roles.find(role => role.role_id === 'dev').skill_bundle_ref.id).toBe('skills_1'); expect(saved.required_stages[0].stage_id).toBe('review_1');
    await page.reload(); await expect(page.locator('.role-stage')).toHaveCount(1);
    await goRolePage(page, { role: 'dev' });
    await page.getByLabel('职责', { exact: true }).fill('保留这份未保存的职责。');
    await admin('/api/repositories/101/roles', 'PUT', { expected_revision: 2, enabled: false, roles: [] });
    await consoleSave(page).click();
    await expect(page.getByRole('alert').filter({ hasText: '角色配置已被别人修改' })).toBeVisible();
    await expect(page.getByLabel('职责', { exact: true })).toHaveValue('保留这份未保存的职责。');
    mkdirSync('.tmp/role-settings', { recursive: true });
    await page.screenshot({ path: '.tmp/role-settings/role-detail.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('dev 项目任务与协作权限', { exact: true })).toHaveValue('write');
    await expect(page.getByLabel('dev 指派其他角色权限', { exact: true })).toHaveValue('deny');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await goRolePage(page);
    await expect(page.getByRole('table', { name: '角色解析结果' })).toBeVisible();
    await expect(page.locator('[data-role-version]')).toHaveText(`有未保存的更改`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/role-settings/overview-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('新增角色、删除内置角色并重载，只有三个必需角色不可删除', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await page.goto(h.admin + '/#/projects/101/roles');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await openRoleAdvanced(page);
    await page.getByLabel('新角色标识', { exact: true }).fill('security');
    await page.getByRole('button', { name: '添加角色', exact: true }).click();
    await goRolePage(page, { role: 'security' });
    await page.getByLabel('角色提示词', { exact: true }).fill('检查输入边界并记录证据。');
    await openRoleFormAdvanced(page);
    await page.getByLabel('security 使用虚拟电脑权限', { exact: true }).selectOption('deny');
    await consoleSave(page).click();
    await expect(page.locator('.flash')).toHaveText('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
    for (const name of ['Manager', '跨任务协调', '独立 QA']) {
      await goRolePage(page, { role: name });
      await openRoleFormAdvanced(page);
      await expect(page.getByRole('button', { name: '删除这个角色', exact: true })).toHaveCount(0);
    }
    await goRolePage(page, { role: 'Reviewer' });
    await openRoleFormAdvanced(page);
    await page.getByRole('button', { name: '删除这个角色', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除角色', exact: true }).click();
    await expect(page.getByTestId('role-list-reviewer')).toHaveCount(0);
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101/roles')).value.configuration.revision).toBe(2);
    await page.reload();
    await goRolePage(page);
    await expect(page.getByTestId('role-list-reviewer')).toHaveCount(0);
    await page.getByTestId('role-list-security').click();
    await expect(page.getByLabel('角色提示词', { exact: true })).toHaveValue('检查输入边界并记录证据。');
    await openRoleFormAdvanced(page);
    await expect(page.getByLabel('security 使用虚拟电脑权限', { exact: true })).toHaveValue('deny');
    await page.getByRole('button', { name: '删除这个角色', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除角色', exact: true }).click();
    await consoleSave(page).click();
    await expect.poll(async () => (await admin('/api/repositories/101/roles')).value.configuration.revision).toBe(3);
    const roles = (await admin('/api/repositories/101/roles')).value.configuration.roles.map(role => role.role_id);
    expect(roles).not.toContain('reviewer'); expect(roles).not.toContain('security');
  } finally { await h.stop(); }
});


test('旧权限明确显示原动作，保存其他字段保留授权，选择新等级才迁移',async({page})=>{
  test.setTimeout(90000);
  const h=await harness(undefined,undefined,store=>({engine:new TaskEngine(store,{call:async()=>null})}));
  try{
    const {admin,password}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
    await admin('/api/repositories/101/roles','PUT',{expected_revision:0,enabled:true,roles:[]});
    const config=JSON.parse(h.store.get("SELECT value FROM settings WHERE key='roles:101'").value);
    config.roles.find(r=>r.role_id==='dev').permissions={repository:'read',commands:'deny',github:'none',issues:'allow',pull_request:'deny',submission:'deny'};
    const raw=JSON.stringify(config);h.store.run("UPDATE settings SET value=? WHERE key='roles:101'",raw);
    await page.goto(h.admin+'/#/projects/101/roles/dev');
    await page.getByLabel('用户名',{exact:true}).fill('administrator');await page.getByLabel('密码',{exact:true}).fill(password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.getByTestId('role-form')).toBeVisible();
    await openRoleFormAdvanced(page);
    const computer=page.getByLabel('dev 使用虚拟电脑权限',{exact:true}),issues=page.getByLabel('dev Issue权限',{exact:true});
    await expect(computer).toHaveValue('custom');await expect(issues).toHaveValue('custom');
    await expect(page.locator('.role-permissions')).toContainText('文件：只读；命令：不允许');
    await expect(page.locator('.role-permissions')).toContainText('旧配置保留的能力：创建');
    expect(h.store.get("SELECT value FROM settings WHERE key='roles:101'").value).toBe(raw);
    await page.getByLabel('职责',{exact:true}).fill('保留旧授权');
    await consoleSave(page).click();
    await expect.poll(async()=>(await admin('/api/repositories/101/roles')).value.configuration.revision).toBe(2);
    let saved=(await admin('/api/repositories/101/roles')).value.configuration.roles.find(r=>r.role_id==='dev').permissions;
    expect(saved.computer).toBe('custom');expect(saved.legacy_issues_create).toBe('allow');expect(saved.legacy_issues_read).toBe('deny');expect(saved.legacy_issues_reply).toBe('deny');
    await openRoleFormAdvanced(page);
    await computer.selectOption('allow');await issues.selectOption('read');
    await consoleSave(page).click();
    await expect.poll(async()=>(await admin('/api/repositories/101/roles')).value.configuration.revision).toBe(3);
    saved=(await admin('/api/repositories/101/roles')).value.configuration.roles.find(r=>r.role_id==='dev').permissions;
    expect(saved.computer).toBe('allow');expect(saved.github_issues).toBe('read');expect(saved.legacy_repository).toBeUndefined();expect(saved.legacy_issues_create).toBeUndefined();
  }finally{await h.stop();}
});

test('GitHub 权限文案说明读写开放 github_write；默认只有 Manager 可写', async ({ page }) => {
  const h = await harness(undefined, undefined, store => ({ engine: new TaskEngine(store, { call: async () => null }) }));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    await page.goto(h.admin + '/#/projects/101/roles/manager');
    await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await openRoleFormAdvanced(page);
    const box = page.locator('.role-permissions');
    for (const [label, value] of [['Issue', 'write'], ['Pull Request', 'write'], ['Contents', 'write'], ['Actions', 'read']])
      await expect(page.getByLabel('manager ' + label + '权限', { exact: true })).toHaveValue(value);
    await expect(box).toContainText('读写：还可以用 github_write 新建、修改和关闭 Issue，评论，加删标签、指派人和里程碑。');
    await expect(box).toContainText('读写：还可以用 github_write 开 PR、修改 PR，评论，发检视（包括批准和要求修改）、请求检视人。合并 PR 属于 Contents 读写。');
    await expect(box).toContainText('读写：还可以用 github_write 提交文件、创建 Git 对象、分支和引用、合并 PR，可以直接推送到分支。');
    await expect(box).toContainText('默认只有 Manager 可写，且只写它正在处理的事件所在仓库。');
    await expect(box).toContainText('不需要这里的写权限');
    await expect(page.getByText('Actions：重跑原始运行', { exact: true })).toHaveCount(0);
    await goRolePage(page, { role: 'Dev' });
    await openRoleFormAdvanced(page);
    for (const label of ['Issue', 'Pull Request', 'Contents', 'Actions', 'Checks', 'Commit Status'])
      await expect(page.getByLabel('dev ' + label + '权限', { exact: true })).toHaveValue('read');
  } finally { await h.stop(); }
});

