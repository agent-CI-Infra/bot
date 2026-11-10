import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const output = resolve('.tmp/github-login-163/docker'); mkdirSync(output, { recursive: true });
const suffix = randomBytes(4).toString('hex'), project = 'bot-github-163-' + suffix, image = project + ':test';
const env = { ...process.env, DOCKER_CONFIG: resolve(output, 'docker-config'), BUILDX_CONFIG: resolve(output, 'buildx') };
const docker = args => execFileSync('docker', args, { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const file = resolve(output, 'compose.json'), empty = resolve(output, 'empty.env'); writeFileSync(empty, '');
writeFileSync(file, JSON.stringify({ services: { identity: { image, command: ['node', 'test/fixtures/github-identity-control.mjs'],
  volumes: ['data:/data', `${resolve('test/fixtures/github-identity-control.mjs')}:/app/test/fixtures/github-identity-control.mjs:ro`],
  ports: ['127.0.0.1::8791', '127.0.0.1::8080'], read_only: true, tmpfs: ['/tmp'] } }, volumes: { data: {} } }));
const compose = args => docker(['compose', '--env-file', empty, '-p', project, '-f', file, ...args]);
const evidence = { project, image, checks: [], github: '本地模拟，无真实 GitHub 写入' }; let browser, page, base, fixture;
const passed = value => { evidence.checks.push(value); console.log('PASS ' + value); };
async function ready() { for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('isolated_container_not_ready'); }
const post = (path, body) => fetch(fixture + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
try {
  writeFileSync(resolve(output, 'build.log'), docker(['build', '-t', image, '.'])); compose(['up', '-d']);
  base = 'http://' + compose(['port', 'identity', '8791']).trim(); fixture = 'http://' + compose(['port', 'identity', '8080']).trim(); await ready();
  await post('/fixture/config', { origin: base, fixture });
  const password = randomBytes(20).toString('hex');
  assert.equal((await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'recovery', password }) })).status, 201);
  await post('/fixture/seed', {});
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  evidence.browser_errors = [];
  page.on('pageerror', error => evidence.browser_errors.push(error.message));
  page.on('requestfailed', req => evidence.browser_errors.push({ path: new URL(req.url()).pathname, error: req.failure()?.errorText }));
  await page.goto(base); await page.getByRole('link', { name: '使用 GitHub 登录' }).click();
  await page.getByRole('heading', { name: '当前角色与授权来源' }).waitFor();
  assert.ok((await page.locator('#identity-panel').innerText()).includes('组织管理员'));
  assert.ok(!(await page.locator('body').innerText()).includes('docker-fixture-user'));
  await page.screenshot({ path: resolve(output, 'login.png'), fullPage: true }); passed('独立容器真实浏览器完成 S256 登录并展示派生组织权限，无 token 回显');
  compose(['restart', 'identity']); base = 'http://' + compose(['port', 'identity', '8791']).trim(); fixture = 'http://' + compose(['port', 'identity', '8080']).trim(); await ready(); await post('/fixture/config', { origin: base, fixture }); await page.goto(base + '/#/identity');
  await page.getByRole('heading', { name: '当前角色与授权来源' }).waitFor();
  assert.ok((await page.locator('#identity-panel').innerText()).includes('组织管理员')); passed('容器重启后二次迁移保留本地恢复账号、外部身份、会话和授权来源');
  await post('/fixture/owner', { owner: false }); await page.getByRole('button', { name: '重新验证 GitHub 权限' }).click();
  await page.getByText('已撤销', { exact: true }).first().waitFor(); await page.screenshot({ path: resolve(output, 'revoked.png'), fullPage: true });
  passed('降级后重新验证显示撤销，旧派生权限失效'); evidence.result = '通过';
} catch (error) { writeFileSync(resolve(output, 'failure-container.log'), compose(['logs', '--tail', '60', 'identity'])); if (page) { evidence.page = { path: new URL(page.url()).origin + new URL(page.url()).pathname, text: (await page.locator('body').innerText()).slice(0,3000) }; await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }); } evidence.result = '失败'; evidence.error = error.message; process.exitCode = 1; console.error(error.message); }
finally {
  await browser?.close();
  try { compose(['down', '--remove-orphans']); } finally {
    for (const volume of docker(['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project]).trim().split('\n').filter(Boolean)) docker(['volume', 'rm', volume]);
    docker(['image', 'rm', image]);
  }
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
