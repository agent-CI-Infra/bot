import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #740: the global settings category for the Agent CLI tool volume. The API is already there; the page has to make it
// usable without a hand-written curl: the volume, each CLI with its manifests, an install form and a prune form.
// What the page reads is the API's own shape (no field is invented here), so these tests answer with that shape only.
// The fallback test draws the 存储 category, which is where an address this role cannot open lands.
const scripts = ['static/app.js', 'static/views.js', 'static/project.js', 'static/metrics.js', 'static/costs.js', 'static/settings.js'];
const text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');
const claudeManifest = {
  schema: 'bot.agent-tools/1', cli: 'claude_code', version: '2.1.319', arch: 'x64', libc: 'glibc', installed_at: '2026-11-14T08:00:00.000Z',
  container_executable: '/opt/agent-tools/claude_code/2.1.319/bin/claude',
  container_node_executable: '/opt/agent-tools/node/22.15.0/bin/node', node_version: '22.15.0',
  artifacts: [{ role: 'package', source_url: 'https://registry.example/claude-code-2.1.319.tgz', sha256: 'a'.repeat(64), bytes: 4321 }],
};
const claude = (overrides = {}) => ({
  cli: 'claude_code', available: true, compatible_range: '>=2.1.0 <3.0.0', tested_version: '2.1.319', selected_version: '2.1.319',
  container_executable: '/opt/agent-tools/claude_code/2.1.319/bin/claude', node_version: '22.15.0',
  compatible_versions: ['2.1.310', '2.1.319'], incompatible_versions: ['3.0.0'], installed_manifests: [claudeManifest], reason: null, ...overrides,
});
const codex = (overrides = {}) => ({
  cli: 'codex', available: false, compatible_range: '>=0.166.0 <1.0.0', tested_version: '0.166.0', selected_version: null,
  container_executable: null, node_version: null, compatible_versions: [], incompatible_versions: [], installed_manifests: [],
  reason: 'cli_not_installed', ...overrides,
});
const status = (overrides = {}) => ({
  volume_root: '/srv/agent-tools', container_root: '/opt/agent-tools', volume_present: true, arch: 'x64', node_versions: ['22.15.0'],
  retain_count: 3, retain_bounds: [1, 10], clis: { claude_code: claude(), codex: codex() }, ...overrides,
});
// #1039: a settings card title is an h2 (its sub-sections are h3), so match the card by the heading it starts with.
const section = (panel, title) => panel.querySelectorAll('section').find(node => (node.querySelector('h2') || node.querySelector('h3'))?.textContent === title);

test('the tool volume category shows the volume, each CLI, every manifest and a usable install form', async () => {
  const page = loadConsole(scripts, (method, path) => {
    if (method === 'GET' && path === '/api/agent-tools') return [200, status()];
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/agent-tools';");
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel');
  // The entry sits between 助手电脑 and 存储: the system group keeps its last category at the end.
  const captions = panel.querySelectorAll('nav a').filter(a => !a.classList.contains('console-nav-label')).map(a => a.textContent);
  assert.ok(captions.includes('Agent CLI 工具卷'), 'the category appears in the navigation');
  assert.equal(captions[captions.indexOf('Agent CLI 工具卷') - 1], '助手电脑');
  assert.equal(captions[captions.indexOf('Agent CLI 工具卷') + 1], '存储');
  assert.equal(panel.querySelector('nav a[aria-current=page]').textContent, 'Agent CLI 工具卷');
  // The volume card names both roots, the architecture and the saved retain count with its allowed range.
  const volume = section(panel, '工具卷');
  assert.match(text(volume), /\/srv\/agent-tools/);
  assert.match(text(volume), /\/opt\/agent-tools/);
  assert.match(text(volume), /x64/);
  assert.match(text(volume), /22\.15\.0/);
  assert.match(text(volume), /保留版本数/);
  assert.match(text(volume), /1–10/);
  // One card per CLI: range, versions, the reason it is unavailable, and the manifest the volume will execute.
  const claudeCard = section(panel, 'Claude Code');
  assert.match(text(claudeCard), />=2\.1\.0 <3\.0\.0/);
  assert.match(text(claudeCard), /当前选用 2\.1\.319/);
  assert.match(text(claudeCard), /不兼容 3\.0\.0/);
  assert.match(text(claudeCard), /registry\.example\/claude-code-2\.1\.319\.tgz/);
  assert.match(text(claudeCard), /a{12}/);
  assert.match(text(claudeCard), /4321/);
  assert.match(text(claudeCard), /2026-11-14T08:00:00\.000Z/);
  const codexCard = section(panel, 'Codex');
  assert.match(text(codexCard), /尚未安装/);
  assert.match(text(codexCard), />=0\.166\.0 <1\.0\.0/);
  // The install form asks for the exact version and, for Claude Code only, the native binary's hash.
  const install = section(panel, '安装版本').querySelector('form');
  const field = name => install.querySelectorAll('input').find(node => node.name === name);
  const select = name => install.querySelectorAll('select').find(node => node.name === name);
  assert.deepEqual(select('cli').querySelectorAll('option').map(node => node.value), ['claude_code', 'codex']);
  assert.equal(field('version').value, '');
  assert.ok(field('sha256'), 'an exact download hash can be given');
  assert.ok(field('native_sha256'), 'Claude Code checks its native binary too');
  // The install form says what the service does with the number typed here (#740 review F1/F2).
  assert.match(text(install), /安装成功即保存为默认值/);
  assert.match(text(install), /agent_tool_version_in_use/);
  assert.doesNotMatch(text(install), /重装正在运行的版本会替换目录/);
  assert.doesNotMatch(text(section(panel, '工具卷')), /保留版本数\s+保留版本数/);
  select('cli').value = 'codex';
  select('cli').listeners.change[0]({ target: select('cli') });
  assert.equal(section(panel, '安装版本').querySelectorAll('input').find(node => node.name === 'native_sha256'), undefined,
    'Codex has no native subtraction to check');
  // The prune form says which versions it keeps and that a running version is never removed.
  const prune = section(panel, '清理旧版本').querySelector('form');
  assert.deepEqual(prune.querySelectorAll('select').find(node => node.name === 'cli').querySelectorAll('option').map(node => node.value), ['', 'claude_code', 'codex']);
  assert.ok(prune.querySelectorAll('input').find(node => node.name === 'retain_count'));
  assert.match(text(section(panel, '清理旧版本')), /正在运行/);
  // A directory whose manifest cannot be read is cleared unless a running or just-installed version still points at it,
  // so the note must not promise that every unreadable version survives (#740 review F3).
  assert.match(text(section(panel, '清理旧版本')), /清单读不到的残留平时会被清理/);
});

test('installing a version redraws the page from the status the service answered with', async () => {
  let posted = null, current = status();
  const page = loadConsole(scripts, (method, path, body) => {
    if (method === 'GET' && path === '/api/agent-tools') return [200, current];
    if (method === 'POST' && path === '/api/agent-tools/install') {
      posted = body;
      // The retained default is whatever the service stored: the page must not assume its own field won.
      current = status({ retain_count: 2, clis: { claude_code: claude(), codex: codex({ available: true, selected_version: '0.166.0', container_executable: '/opt/agent-tools/codex/0.166.0/bin/codex', compatible_versions: ['0.166.0'], installed_manifests: [{ ...claudeManifest, cli: 'codex', version: '0.166.0', node_version: null, container_node_executable: null, container_executable: '/opt/agent-tools/codex/0.166.0/bin/codex' }] }) } });
      return [200, { installed: { cli: 'codex', version: '0.166.0' }, compatible: true, pruned: {}, protected_invalid: {}, status: current }];
    }
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/agent-tools';");
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel');
  let form = section(panel, '安装版本').querySelector('form');
  form.querySelectorAll('select').find(node => node.name === 'cli').value = 'codex';
  form.querySelectorAll('input').find(node => node.name === 'version').value = '0.166.0';
  form.querySelectorAll('input').find(node => node.name === 'retain_count').value = '2';
  await form.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(posted, { cli: 'codex', version: '0.166.0', retain_count: 2 });
  // The page redraws from the response: the selected version, the manifest and the saved default all come from it.
  assert.equal(page.requests.filter(request => request === 'GET /api/agent-tools').length, 1, 'the answer already carries the new status');
  form = section(panel, '安装版本').querySelector('form');
  assert.equal(form.querySelectorAll('input').find(node => node.name === 'retain_count').value, '2', 'the field shows the default the service saved');
  assert.match(text(section(panel, '工具卷')), /保留版本数 2（允许 1–10）/);
  assert.match(text(section(panel, 'Codex')), /当前选用 0\.166\.0/);
  assert.match(text(panel), /0\.166\.0/);
});

test('a failed download keeps the form and says what the service refused', async () => {
  const page = loadConsole(scripts, (method, path) => {
    if (method === 'GET' && path === '/api/agent-tools') return [200, status()];
    if (method === 'POST' && path === '/api/agent-tools/install') return [502, { error: 'agent_tool_hash_mismatch' }];
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/agent-tools';");
  await page.run('renderSettings(renderVersion)');
  const form = section(page.$('settings-panel'), '安装版本').querySelector('form');
  form.querySelectorAll('input').find(node => node.name === 'version').value = '2.1.319';
  await form.listeners.submit[0]({ preventDefault() {} });
  const message = section(page.$('settings-panel'), '安装版本').querySelector('.view-error');
  assert.match(text(message), /502/);
  assert.match(text(message), /agent_tool_hash_mismatch/);
  assert.equal(form.listeners.submit.length, 1, 'the form stays for a corrected version');
  assert.equal(form.querySelectorAll('input').find(node => node.name === 'version').value, '2.1.319', 'the typed version is kept');
  assert.equal(page.requests.filter(request => request === 'GET /api/agent-tools').length, 1, 'a failure does not pretend the volume changed');
});

test('an unmounted volume and an unknown architecture show deployment guidance instead of a form that cannot work', async () => {
  const page = loadConsole(scripts, (method, path) => {
    if (method === 'GET' && path === '/api/agent-tools') return [200, status({
      volume_present: false, arch: null, node_versions: [], retain_count: 3,
      clis: { claude_code: claude({ available: false, selected_version: null, container_executable: null, node_version: null, compatible_versions: [], installed_manifests: [], reason: 'agent_tools_volume_missing' }),
        codex: codex({ reason: 'agent_tools_volume_missing' }) },
    })];
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/agent-tools';");
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel'), volume = section(panel, '工具卷');
  assert.match(text(volume), /读不到架构/);
  assert.match(text(volume), /BOT_AGENT_TOOLS_DIR/);
  assert.match(text(volume), /compose\.yaml/);
  assert.equal(section(panel, '安装版本').querySelector('form').querySelectorAll('button').find(node => node.type === 'submit').disabled, true);
});

test('pruning reports what was removed, what is protected, and the saved retain count the service answered with', async () => {
  let posted = null, current = status();
  const page = loadConsole(scripts, (method, path, body) => {
    if (method === 'GET' && path === '/api/agent-tools') return [200, current];
    if (method === 'POST' && path === '/api/agent-tools/prune') {
      posted = body;
      current = status({ retain_count: 2, clis: { claude_code: claude({ installed_manifests: [claudeManifest] }), codex: codex() } });
      return [200, { pruned: { claude_code: ['2.1.310'], codex: [] }, protected_invalid: { claude_code: ['2.1.319'], codex: [] }, status: current }];
    }
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/agent-tools';");
  await page.run('renderSettings(renderVersion)');
  const form = section(page.$('settings-panel'), '清理旧版本').querySelector('form');
  form.querySelectorAll('select').find(node => node.name === 'cli').value = 'claude_code';
  form.querySelectorAll('input').find(node => node.name === 'retain_count').value = '2';
  await form.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(posted, { cli: 'claude_code', retain_count: 2 });
  const prune = section(page.$('settings-panel'), '清理旧版本');
  assert.match(text(prune), /已清理/);
  assert.match(text(prune), /2\.1\.310/);
  assert.match(text(prune), /受保护/);
  assert.match(text(prune), /2\.1\.319/);
  // The saved default comes from the response, and 2 is now what the volume card shows.
  assert.equal(section(page.$('settings-panel'), '清理旧版本').querySelectorAll('input').find(node => node.name === 'retain_count').value, '2');
  assert.match(text(section(page.$('settings-panel'), '工具卷')), /保留版本数 2（允许 1–10）/);
});

test('a project administrator sees no entry and the address falls back to 存储', () => {
  const page = loadConsole(scripts, () => [200, {}]);
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/agent-tools';");
  assert.equal(page.run('settingsRoute().section'), 'agent-tools', 'a super administrator opens the category by its address');
  page.run("me = { role: 'project_admin', csrf_token: 'csrf', projects: [{ id: '101', name: 'fixture-project' }] }; location.hash = '#/settings/agent-tools';");
  assert.equal(page.run("visibleSettingsSections().some(([key]) => key === 'agent-tools')"), false, 'the category is not offered to a project administrator');
  assert.equal(page.run('settingsRoute().section'), 'storage', 'the address lands on 存储 instead of an empty page');
});
