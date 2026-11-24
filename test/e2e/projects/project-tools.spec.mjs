import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { harness, setup, account, repository } from '../../fixtures/helpers.mjs';
import { RuleService } from '../../../dist/rules/service.js';

function makeTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    Buffer.from(entry.name, 'utf8').copy(header, 0, 0, 100);
    Buffer.from((entry.mode ?? 0o755).toString(8).padStart(7, '0') + '\0', 'ascii').copy(header, 100);
    Buffer.from('0000000\0', 'ascii').copy(header, 108);
    Buffer.from('0000000\0', 'ascii').copy(header, 116);
    const body = Buffer.from(entry.content || '');
    Buffer.from(body.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124);
    Buffer.from('00000000000\0', 'ascii').copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
    blocks.push(header);
    if (body.length) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

async function createFixture() {
  const ptRoot = mkdtempSync(join(tmpdir(), 'e2e-pt-'));
  const state = { toolsRevision: null, appliedToolsRevision: null };
  const manager = {
    async call(method, path, body) {
      if (method === 'GET' && path === '/v1/project-tools/mounts') return { mounts: [] };
      if (path.endsWith('/stats')) return { running: true, cpu_percent: 1, memory_bytes: 1024 ** 2, memory_limit_bytes: 4 * 1024 ** 3, pids: 4, sampled_at: new Date().toISOString() };
      if (method === 'PUT' && path.endsWith('/tools')) {
        state.toolsRevision = body?.revision ?? null;
        return {
          repository_id: '101', generation: 1, state: 'ready', desired: 'ready', revision: 2,
          computer: {
            cpus: 2, memory_mb: 4096, pids: 512, tmp_mb: 1024,
            defaults: { cpus: 2, memory_mb: 4096, pids: 512, tmp_mb: 1024 },
            inherited: ['cpus', 'memory_mb', 'pids', 'tmp_mb'],
            packages: [], env: {}, setup_script: '', network_policy: 'internet egress',
            tools_revision: state.toolsRevision,
            applied_tools_revision: state.appliedToolsRevision,
            tools_pending: state.toolsRevision !== state.appliedToolsRevision,
            build: { state: 'none', toolchain: 'Node.js 22, Python 3.11' },
          },
        };
      }
      return {
        repository_id: '101', generation: 1, state: 'ready', desired: 'ready', revision: 1,
        computer: {
          cpus: 2, memory_mb: 4096, pids: 512, tmp_mb: 1024,
          defaults: { cpus: 2, memory_mb: 4096, pids: 512, tmp_mb: 1024 },
          inherited: ['cpus', 'memory_mb', 'pids', 'tmp_mb'],
          packages: [], env: {}, setup_script: '', network_policy: 'internet egress',
          tools_revision: state.toolsRevision,
          applied_tools_revision: state.appliedToolsRevision,
          tools_pending: state.toolsRevision !== state.appliedToolsRevision,
          build: { state: 'none', toolchain: 'Node.js 22, Python 3.11' },
        },
      };
    },
  };
  const h = await harness(undefined, manager, { projectToolsDir: ptRoot });
  const { admin, password } = await setup(h);
  const acc = await account(admin);
  await repository(admin, acc.id, '101');
  new RuleService(h.store).cache('101', 'a'.repeat(40), {});
  return {
    h, admin, password, ptRoot, state,
    close: async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); rmSync(ptRoot, { recursive: true, force: true }); },
  };
}

test('project tools volume streaming upload, merge archive, pending badge, rollback, and light/dark responsive layout', async ({ page }) => {
  const f = await createFixture();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.h.admin + '/#/projects/101/machine');
    await page.getByLabel('用户名', { exact: true }).fill('administrator');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    const toolsCard = page.getByTestId('machine-project-tools');
    await expect(toolsCard).toBeVisible();
    await expect(toolsCard).toContainText('工具配置优先级');
    await expect(toolsCard).toContainText('预编译镜像');
    await expect(toolsCard).toContainText('未配置工具卷');

    // Upload single executable file -> rev-1
    await page.getByTestId('project-tools-file').setInputFiles({
      name: 'hello-cli',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('#!/bin/sh\necho hello\n'),
    });
    await expect(page.getByTestId('project-tools-target-path')).toHaveValue('bin/hello-cli');
    await page.getByTestId('project-tools-note').fill('initial binary');
    await page.getByTestId('project-tools-upload-submit').click();

    await expect(toolsCard).toContainText('当前版本 rev-1');
    await expect(toolsCard).toContainText('等待空闲切换');
    await expect(page.getByTestId('project-tools-files-table')).toContainText('bin/hello-cli');
    await expect(page.getByTestId('project-tools-files-table')).toContainText('可执行文件 (+x)');

    // Upload .tar.gz archive in merge mode -> rev-2 contains both files
    const archive = makeTarGz([{ name: 'bin/second-cli', mode: 0o755, content: '#!/bin/sh\necho second\n' }]);
    await page.getByTestId('project-tools-file').setInputFiles({
      name: 'more-tools.tar.gz',
      mimeType: 'application/gzip',
      buffer: archive,
    });
    await expect(page.getByTestId('project-tools-kind')).toHaveValue('archive');
    await page.getByTestId('project-tools-mode').selectOption('merge');
    await page.getByTestId('project-tools-upload-submit').click();

    await expect(toolsCard).toContainText('当前版本 rev-2');
    await expect(page.getByTestId('project-tools-files-table')).toContainText('bin/hello-cli');
    await expect(page.getByTestId('project-tools-files-table')).toContainText('bin/second-cli');

    // Roll back to rev-1 via confirmation dialog
    await page.getByTestId('project-tools-rollback-1').click();
    await page.getByRole('button', { name: '确认回滚', exact: true }).click();
    await expect(toolsCard).toContainText('当前版本 rev-1');
    await expect(page.getByTestId('project-tools-files-table')).not.toContainText('bin/second-cli');

    // Verify WCAG AA (>= 4.5:1) contrast and zero horizontal overflow across 1440px and 390px,
    // and confirm OS dark preference does not break contrast on the machine card or existing costs page.
    const checkContrast = async rootSelector => page.evaluate(sel => {
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
      for (const el of root.querySelectorAll('h2,h3,h4,p,li,strong,code,th,td,dt,dd,label,button,.status')) {
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

    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(vp);
        await expect(toolsCard).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `${scheme} at ${vp.width}px must not overflow horizontally`).toBe(false);
        const fails = await checkContrast('[data-testid="machine-project-tools"]');
        expect(fails, `${scheme} at ${vp.width}px machine-project-tools contrast`).toEqual([]);
      }
    }

    // Confirm existing costs page remains readable under OS prefers-color-scheme: dark (no global dark regression)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(f.h.admin + '/#/costs');
    await expect(page.locator('#costs-panel')).toBeVisible();
    const costFails = await checkContrast('#costs-panel');
    expect(costFails, 'costs page contrast under OS dark preference').toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});
