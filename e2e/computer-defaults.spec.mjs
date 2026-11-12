import { test, expect } from '@playwright/test';
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { harness, setup, account, repository } from '../test/helpers.mjs';
import { Projects } from '../manager/projects.mjs';
import { ManagerError } from '../manager/docker.mjs';
import { FakeDocker } from '../test/fake-docker.mjs';
import { fail } from '../dist/core/security.js';
import { RuleService } from '../dist/rules/service.js';

const mib = 1024 * 1024;
test('全局设置修改虚拟电脑默认资源，空闲电脑按新值重建；项目留空的资源跟随默认', async ({ page }) => {
  // The real manager project logic over a Docker stand-in with an 8-CPU, 32 GiB host.
  mkdirSync('.tmp/computer-defaults', { recursive: true }); const directory = mkdtempSync(resolve('.tmp/computer-defaults/manager-')), docker = new FakeDocker();
  docker.info = { NCPU: 8, MemTotal: 32768 * mib };
  const projects = new Projects({ database: join(directory, 'manager.sqlite'), docker, deployment: 'fixture', image: 'approved' });
  const route = async (method, path, input) => {
    if (path === '/v1/defaults') return method === 'PUT' ? projects.setDefaults(input) : projects.defaultsView();
    const [, repo, action] = /^\/v1\/projects\/(\d+)(?:\/(\w+))?$/.exec(path);
    if (action === 'parallel') return projects.parallelism(repo, input.tasks);
    if (action === 'stats') return { running: false };
    if (method === 'GET' && !action) return projects.describe(repo);
    if (method === 'PUT') return projects.register(repo);
    return projects.operate(repo, action, input);
  };
  const manager = { call: (method, path, input) => route(method, path, input).catch(error => error instanceof ManagerError ? fail(error.status, error.message) : Promise.reject(error)) };
  const host = () => docker.containers.get(projects.names('101', 1).container).HostConfig;
  const h = await harness(undefined, manager), errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const { admin, password } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
    new RuleService(h.store).cache('101', 'a'.repeat(40), {});
    for (let i = 0; i < 2; i++) await h.projects.reconcile();
    await page.goto(h.admin + '/#/settings/work-computers'); await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    const panel = page.locator('#settings-panel'), defaults = panel.locator('section').filter({ has: page.getByRole('heading', { name: '默认资源', exact: true }) });
    await expect(defaults).toContainText('8 CPU · 32 GB 内存'); await expect(defaults).toContainText('1 台，共分配 2 CPU · 4 GB 内存');
    // Common sizes inside the bounds, none above the host's 8 CPUs; the built-in value is marked.
    const cpu = defaults.locator('select[name=cpus]');
    await expect(cpu.locator('option')).toHaveText(['0.5 核', '1 核', '2 核（内置默认）', '4 核', '6 核', '8 核']);
    await expect(cpu).toHaveValue('2');
    await page.screenshot({ path: '.tmp/computer-defaults/settings-desktop.png', fullPage: true });
    await cpu.selectOption('4'); await defaults.locator('select[name=memory_mb]').selectOption('8192');
    await defaults.getByRole('button', { name: '保存', exact: true }).click();
    await expect(defaults).toContainText('已保存：新建的虚拟电脑立即使用，已有的在空闲时重建');
    expect(projects.resourceDefaults()).toEqual({ cpus: 4, memory_mb: 8192, pids: 1024, tmp_mb: 1024 });
    // Saving reconciles at once; no task runs on 101, so it is rebuilt with the new defaults.
    await expect.poll(() => [host().NanoCpus, host().Memory]).toEqual([4e9, 8192 * mib]);
    expect(projects.describe('101').computer.resources_pending).toBe(false);

    // The project form leaves resources that follow the default empty; a value of its own stays when the default changes.
    await page.goto(h.admin + '/#/projects/101/machine');
    const form = page.locator('.project-form').filter({ has: page.getByLabel('CPU（核）', { exact: true }) }), cores = form.getByLabel('CPU（核）', { exact: true });
    await expect(cores).toHaveValue(''); await expect(cores).toHaveAttribute('placeholder', '留空使用全局默认（4）');
    await form.screenshot({ path: '.tmp/computer-defaults/project-machine.png' });
    await cores.fill('3'); await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    await expect.poll(() => [projects.own('101').cpus, host().NanoCpus]).toEqual([3, 3e9]);
    await expect(cores).toHaveValue('3');
    await cores.fill(''); await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#project-page')).toContainText('已保存，虚拟电脑已按新配置重建');
    await expect.poll(() => [projects.own('101').cpus, host().NanoCpus]).toEqual([undefined, 4e9]);

    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(h.admin + '/#/settings/work-computers'); await expect(defaults).toContainText('8 CPU');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.tmp/computer-defaults/settings-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await h.stop(); projects.db.close(); rmSync(h.directory, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); }
});
