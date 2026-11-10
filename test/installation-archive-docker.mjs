import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, generateKeyPairSync, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const output = resolve('.tmp/install-archive-162/docker'); mkdirSync(output, { recursive: true });
const suffix = randomBytes(4).toString('hex'), project = 'bot-install-archive-162-' + suffix, image = 'bot-install-archive-162:' + suffix;
const dockerEnv = { ...process.env, DOCKER_CONFIG: resolve(output, 'docker-config'), BUILDX_CONFIG: resolve(output, 'buildx') };
const docker = args => execFileSync('docker', args, { env: dockerEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const composeFile = resolve(output, 'compose.json'), emptyEnv = resolve(output, 'empty.env'); writeFileSync(emptyEnv, '');
const compose = args => docker(['compose', '--env-file', emptyEnv, '-p', project, '-f', composeFile, ...args]);
const composeConfig = {
  services: {
    github: { image, command: ['node', 'test/fixtures/installation-github.mjs'], ports: ['127.0.0.1::8080'],
      volumes: [`${resolve('test/fixtures/installation-github.mjs')}:/app/test/fixtures/installation-github.mjs:ro`] },
    'key-init': { image, command: ['node', 'dist/keygen.js', '/keys/master.key', '/internal/manager.token'], volumes: ['keys:/keys', 'internal:/internal'], network_mode: 'none' },
    bot: { image, depends_on: { 'key-init': { condition: 'service_completed_successfully' }, github: { condition: 'service_started' } },
      environment: { BOT_DATABASE_PATH: '/data/control.sqlite', BOT_MASTER_KEY_FILE: '/keys/master.key', BOT_MANAGER_TOKEN_FILE: '/internal/manager.token',
        BOT_MANAGER_URL: 'http://github:8080', BOT_GITHUB_API_URL: 'http://github:8080', BOT_COOKIE_SECURE: 'false' },
      volumes: ['data:/data', 'keys:/keys:ro', 'internal:/internal:ro'], ports: ['127.0.0.1::8791'], read_only: true, tmpfs: ['/tmp'] },
  }, volumes: { data: {}, keys: {}, internal: {} },
};
writeFileSync(composeFile, JSON.stringify(composeConfig, null, 2));
const evidence = { project, image, github: '本地模拟 GitHub，无真实外部写入', checks: [] };
const passed = name => { evidence.checks.push(name); console.log('PASS ' + name); };
let cookie = '', csrf = '', base, hookBase, fixtureBase, browser;
const password = randomBytes(24).toString('hex'), webhookSecret = randomBytes(24).toString('hex');
async function wait(check, description) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('等待超时：' + description);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert.ok(response.ok, path + ': ' + value.error);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  if (value.csrf_token) csrf = value.csrf_token;
  return value;
}
const archive = '/api/installations/archive/github.com/123/77';
const snapshot = async () => (await api(archive)).installation;
const setFixture = value => fetch(fixtureBase + '/fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
let a;
async function hook(id, action, event = 'installation', extra = {}) {
  const payload = JSON.stringify({ action, installation: { id: 77, account: { id: 10, login: 'agent-test-zone', type: 'Organization' } },
    sender: { id: 20, login: 'installer' }, requester: { id: 30, login: 'requester' }, ...extra });
  const response = await fetch(hookBase + a.endpoints[0].webhook_path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-GitHub-Event': event, 'X-GitHub-Delivery': id, 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', webhookSecret).update(payload).digest('hex') }, body: payload });
  assert.equal(response.status, 200); return response.json();
}
try {
  writeFileSync(resolve(output, 'build.log'), docker(['build', '--tag', image, '.']));
  compose(['up', '-d']);
  const address = (service, port) => 'http://' + compose(['port', service, String(port)]).trim();
  base = hookBase = address('bot', 8791); fixtureBase = address('github', 8080);
  evidence.ports = { entry: new URL(base).port, fixture: new URL(fixtureBase).port };
  await wait(async () => (await fetch(base + '/healthz')).ok, '独立控制面启动');
  await api('/api/setup', 'POST', { username: 'administrator', password });
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  a = (await api('/api/accounts', 'POST', { name: 'Installation archive fixture', type: 'github_app', app_id: '123', private_key: privateKey, webhook_secret: webhookSecret })).account;
  await hook('docker-created', 'created'); await wait(async () => (await snapshot()).completeness === 'complete', '安装自动同步');
  let value = await snapshot(); assert.equal(value.target.id, '10'); assert.equal(value.evidence.sender.id, '20'); assert.equal(value.evidence.requester.id, '30');
  assert.equal(value.evidence.approval.label, '批准者未知'); assert.equal((await api('/api/repositories')).repositories.length, 0);
  assert.equal((await hook('docker-created', 'created')).duplicate, true); assert.equal((await api(archive + '/events')).events.length, 1);
  passed('签名安装事务落库、异步范围同步、操作者与申请者事实、重复投递去重，不自动启动项目');
  await setFixture({ failure: 403 });
  const result = await api('/api/installations/sync', 'POST', {}); assert.ok(result.results.some(row => row.error));
  value = await snapshot(); assert.equal(value.status, 'active'); assert.equal(value.completeness, 'error');
  assert.equal((await api(archive + '/repositories')).repositories.filter(row => row.present).length, 1);
  await setFixture({ failure: 0 }); compose(['restart', 'bot']);
  base = hookBase = address('bot', 8791);
  evidence.ports_after_restart = { entry: new URL(base).port };
  await wait(async () => (await snapshot()).completeness === 'complete', '容器重启后恢复同步');
  assert.equal((await api(archive + '/events')).events.length, 1);
  passed('403 保留最后成功范围；真实容器重启后恢复持久化同步且档案不丢失');
  await setFixture({ selection: 'selected', repository_ids: [] });
  await hook('docker-selected', 'removed', 'installation_repositories', { repository_selection: 'selected', repositories_removed: [], repositories_added: [] });
  await wait(async () => { const s = await snapshot(); return s.repository_selection === 'selected' && s.completeness === 'complete'; }, '空范围全量重算');
  assert.equal((await snapshot()).status, 'active'); assert.equal((await api(archive + '/repositories')).repositories.filter(row => row.present).length, 0);
  passed('all 改为 selected 且 removed 为空时重算；零仓库安装仍有独立档案');
  await setFixture({ suspended: true }); await hook('docker-suspend', 'suspend');
  assert.equal((await snapshot()).status, 'suspended');
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base); await page.getByLabel('用户名', { exact: true }).fill('administrator'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.goto(base + '/#/settings/installations');
  await page.getByText('GitHub App 安装档案', { exact: true }).waitFor();
  const text = await page.locator('#settings-panel').innerText();
  for (const word of ['agent-test-zone', '已暂停', 'installer', 'requester', '批准者未知']) assert.ok(text.includes(word), word);
  assert.ok(!text.includes('PRIVATE KEY')); assert.ok(!text.includes('fixture-installation-token'));
  await page.screenshot({ path: resolve(output, 'archive-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'archive-mobile.png'), fullPage: true }); await browser.close(); browser = undefined;
  await setFixture({ suspended: false }); await hook('docker-unsuspend', 'unsuspend');
  await wait(async () => (await snapshot()).status === 'active', '权威核实后恢复');
  await hook('docker-deleted', 'deleted'); await hook('docker-late-created', 'created');
  await api('/api/installations/sync', 'POST', {}); assert.equal((await snapshot()).status, 'deleted');
  passed('暂停与恢复需权威核实，卸载后晚到 created 无法复活；桌面及手机浏览器展示真实未知项');
  evidence.result = '通过';
} catch (error) {
  evidence.result = '失败'; evidence.error = error.message; process.exitCode = 1;
  console.error(error.message);
} finally {
  await browser?.close();
  try { compose(['down', '--remove-orphans']); } finally {
    for (const volume of docker(['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project]).trim().split('\n').filter(Boolean)) docker(['volume', 'rm', volume]);
    docker(['image', 'rm', image]);
  }
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
