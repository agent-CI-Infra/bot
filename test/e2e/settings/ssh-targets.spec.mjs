import { test, expect } from '@playwright/test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import ssh2 from 'ssh2';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { managerFixture } from '../../fixtures/project-manager-fixture.mjs';
import { consoleNavigate } from '../helpers/console-navigation.mjs';

async function startSshServer() {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const fingerprint = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.username === 'tester' && ctx.method === 'password' && ctx.password === 'ssh-pass-1412') return ctx.accept();
      ctx.reject();
    });
    client.on('session', (_accept, reject) => reject());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    fingerprint,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function checkContrast(page, rootSelector) {
  return page.evaluate(sel => {
    const parseRgb = str => {
      const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/.exec(str || '');
      if (!m) return null;
      return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
    };
    const lum = ({ r, g, b }) => {
      const c = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
    };
    const effectiveBg = el => {
      let cur = el;
      while (cur) {
        const bg = parseRgb(getComputedStyle(cur).backgroundColor);
        if (bg && bg.a > 0.5) return bg;
        cur = cur.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const root = document.querySelector(sel);
    if (!root) return [{ text: `missing ${sel}`, ratio: 0 }];
    const fails = [];
    for (const el of root.querySelectorAll('h2,h3,h4,p,a,strong,code,th,td,label,button,.status')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      const fg = parseRgb(getComputedStyle(el).color);
      if (!fg || fg.a < 0.5) continue;
      const bg = effectiveBg(el);
      const l1 = Math.max(lum(fg), lum(bg)), l2 = Math.min(lum(fg), lum(bg));
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      if (ratio < 4.5) fails.push({ tag: el.tagName, cls: el.className, text: txt.slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
    }
    return fails;
  }, rootSelector);
}

test('global SSH host pool and project machine SSH bindings/exclusive hosts work end-to-end across roles, themes, and viewports', async ({ page }) => {
  test.setTimeout(120_000);
  const cleanup = [];
  const sshServer = await startSshServer();
  cleanup.push(sshServer.close);
  const manager = await managerFixture({ after: action => cleanup.push(action) });
  const h = await harness(undefined, manager.manager);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  try {
    const { admin, password } = await setup(h);
    const acc = await account(admin);
    await repository(admin, acc.id, '101');
    await h.projects.reconcile();

    const memberRes = await admin('/api/users', 'POST', {
      username: 'proj-admin',
      password: 'ProjectAdminPassword123!',
      role: 'project_admin',
      repository_ids: ['101'],
    });
    expect(memberRes.status).toBe(201);

    // 1. Login as super_admin and navigate via sidebar: 全局设置 -> SSH 远程主机
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(h.admin);
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();

    await consoleNavigate(page, '全局设置');
    await expect(page).toHaveURL(/#\/settings\/work-computers$/);
    const settingsNav = page.locator('#console-secondary-nav .project-nav');
    await settingsNav.getByRole('link', { name: 'SSH 远程主机', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/ssh-targets$/);

    const globalCard = page.getByTestId('global-ssh-targets');
    await expect(globalCard).toBeVisible();
    await expect(globalCard.getByRole('tab')).toHaveCount(0);

    // Top guidance distinguishes compute nodes and jumps cleanly to #/settings/compute-nodes
    const toNodesLink = globalCard.getByTestId('ssh-to-compute-nodes-link');
    await expect(toNodesLink).toHaveAttribute('href', '#/settings/compute-nodes');
    await toNodesLink.click();
    await expect(page).toHaveURL(/#\/settings\/compute-nodes$/);
    await settingsNav.getByRole('link', { name: 'SSH 远程主机', exact: true }).click();
    await expect(globalCard).toBeVisible();

    // 2. Create a global SSH host, test connectivity (real loopback ssh2), and edit it
    await globalCard.getByRole('button', { name: '新增全局主机', exact: true }).click();
    const editor = globalCard.getByTestId('ssh-target-editor-form');
    await expect(editor).toBeVisible();
    await editor.getByLabel('别名', { exact: true }).fill('lab-gw');
    await editor.getByLabel('主机地址', { exact: true }).fill('127.0.0.1');
    await editor.getByLabel('端口', { exact: true }).fill(String(sshServer.port));
    await editor.getByLabel('用户名', { exact: true }).fill('tester');
    await editor.getByLabel('主机公钥指纹', { exact: true }).fill(sshServer.fingerprint);
    await editor.getByLabel('允许角色（逗号分隔）', { exact: true }).fill('dev, qa');
    await editor.getByRole('combobox', { name: '认证方式', exact: true }).selectOption('password');
    await editor.getByLabel('SSH 密码', { exact: true }).fill('ssh-pass-1412');
    await editor.getByRole('button', { name: '保存', exact: true }).click();

    const globalRow = globalCard.locator('tr[data-ssh-alias="lab-gw"]');
    await expect(globalRow).toBeVisible();
    await expect(globalRow).toContainText('未绑定项目');

    await globalRow.getByRole('button', { name: '测试连通性', exact: true }).click();
    await expect(globalRow).toContainText('认证成功');

    await globalRow.getByRole('button', { name: '编辑', exact: true }).click();
    await globalCard.getByTestId('ssh-target-editor-form').getByLabel('允许角色（逗号分隔）', { exact: true }).fill('dev, qa, release');
    await globalCard.getByTestId('ssh-target-editor-form').getByRole('button', { name: '保存', exact: true }).click();
    await expect(globalRow).toContainText('release');

    // 3. Navigate to project machine page: flat layout, bind global host, manage project-exclusive host
    await page.goto(h.admin + '/#/projects/101/machine');
    const sshCard = page.getByTestId('machine-ssh-targets');
    await expect(sshCard).toBeVisible();
    await expect(sshCard.getByRole('tab')).toHaveCount(0);
    await expect(sshCard).toContainText('即时生效');

    const bindSection = sshCard.getByTestId('project-ssh-global-bindings');
    const ownSection = sshCard.getByTestId('project-ssh-own-targets');
    await expect(bindSection).toBeVisible();
    await expect(ownSection).toBeVisible();

    // Global binding section has NO edit/delete/test controls, only 绑定/解除绑定 + direct link to global settings
    const bindRow = bindSection.locator('tr[data-ssh-alias="lab-gw"]');
    await expect(bindRow).toBeVisible();
    await expect(bindRow).toContainText('未绑定');
    await expect(bindSection.getByRole('button', { name: '编辑' })).toHaveCount(0);
    await expect(bindSection.getByRole('button', { name: '删除' })).toHaveCount(0);
    await expect(bindSection.getByRole('button', { name: '测试连通性' })).toHaveCount(0);

    await bindRow.getByRole('button', { name: '绑定', exact: true }).click();
    await expect(bindRow).toContainText('已绑定');
    await expect(bindRow.getByRole('button', { name: '解除绑定', exact: true })).toBeVisible();

    // Direct link「管理全局 SSH 主机 →」jumps to #/settings/ssh-targets and reflects bound_projects
    await bindSection.getByTestId('machine-ssh-global-link').click();
    await expect(page).toHaveURL(/#\/settings\/ssh-targets$/);
    await expect(globalCard.locator('tr[data-ssh-alias="lab-gw"]')).toContainText('fixture/project-101');

    // Delete confirmation on a bound global host warns about the bound project; cancel keeps it intact
    await globalCard.locator('tr[data-ssh-alias="lab-gw"]').getByRole('button', { name: '删除', exact: true }).click();
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toContainText('fixture/project-101');
    await confirmDialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(globalCard.locator('tr[data-ssh-alias="lab-gw"]')).toBeVisible();

    // Check light & dark contrast and zero overflow on #/settings/ssh-targets (including open editor)
    await globalCard.getByRole('button', { name: '新增全局主机', exact: true }).click();
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(vp);
        await expect(globalCard).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `global ssh-targets ${scheme} at ${vp.width}px overflow`).toBe(true);
        expect(await checkContrast(page, '[data-testid="global-ssh-targets"]'),
          `global ssh-targets ${scheme} at ${vp.width}px contrast`).toEqual([]);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await globalCard.getByTestId('ssh-target-editor-form').getByRole('button', { name: '取消', exact: true }).click();

    // Click bound project link -> returns directly to #/projects/101/machine
    await globalCard.locator('tr[data-ssh-alias="lab-gw"] .ssh-bound-project-link').click();
    await expect(page).toHaveURL(/#\/projects\/101\/machine$/);
    await expect(ownSection).toBeVisible();

    // 4. Create, test, edit a project-exclusive SSH host (and verify bound global host is available as jump host)
    await ownSection.getByRole('button', { name: '新增项目专属主机', exact: true }).click();
    const ownEditor = ownSection.getByTestId('ssh-target-editor-form');
    await ownEditor.getByRole('combobox', { name: '连接方式', exact: true }).selectOption('proxy_jump');
    await expect(ownEditor.getByRole('combobox', { name: '跳板主机', exact: true })).toContainText('lab-gw（全局主机）');
    await ownEditor.getByRole('combobox', { name: '连接方式', exact: true }).selectOption('direct');
    await ownEditor.getByLabel('别名', { exact: true }).fill('proj-dut');
    await ownEditor.getByLabel('主机地址', { exact: true }).fill('127.0.0.1');
    await ownEditor.getByLabel('端口', { exact: true }).fill(String(sshServer.port));
    await ownEditor.getByLabel('用户名', { exact: true }).fill('tester');
    await ownEditor.getByLabel('主机公钥指纹', { exact: true }).fill(sshServer.fingerprint);
    await ownEditor.getByLabel('允许角色（逗号分隔）', { exact: true }).fill('qa');
    await ownEditor.getByRole('combobox', { name: '认证方式', exact: true }).selectOption('password');
    await ownEditor.getByLabel('SSH 密码', { exact: true }).fill('ssh-pass-1412');
    await ownEditor.getByRole('button', { name: '保存', exact: true }).click();

    const ownRow = ownSection.locator('tr[data-ssh-alias="proj-dut"]');
    await expect(ownRow).toBeVisible();
    await ownRow.getByRole('button', { name: '测试连通性', exact: true }).click();
    await expect(ownRow).toContainText('认证成功');

    // Light & dark responsive check on project machine SSH card
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(vp);
        await expect(sshCard).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `project machine ${scheme} at ${vp.width}px overflow`).toBe(true);
        expect(await checkContrast(page, '[data-testid="machine-ssh-targets"]'),
          `project machine ssh card ${scheme} at ${vp.width}px contrast`).toEqual([]);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1440, height: 960 });

    // 5. Verify project_admin sees read-only bound global host + project-exclusive host and cannot open #/settings/ssh-targets
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill('proj-admin');
    await page.getByLabel('密码', { exact: true }).fill('ProjectAdminPassword123!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();

    await page.goto(h.admin + '/#/settings/ssh-targets');
    await expect(page.locator('#settings-panel')).toBeHidden();

    await page.goto(h.admin + '/#/projects/101/machine');
    await expect(sshCard).toBeVisible();
    await expect(bindSection).toContainText('lab-gw');
    await expect(ownSection).toContainText('proj-dut');
    await expect(sshCard.getByTestId('machine-ssh-global-link')).toHaveCount(0);
    await expect(sshCard.getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('machine-node-binding').getByTestId('machine-compute-nodes-link')).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await h.stop();
    for (const action of cleanup) await action();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
