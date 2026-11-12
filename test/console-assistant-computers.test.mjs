import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// The global settings category for the assistants' computers (#457): its settings form and the list of HOMEs.
const scripts = ['static/app.js', 'static/views.js', 'static/project.js', 'static/settings.js', 'static/onboarding.js'];
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const gib = 1024 ** 3;
const defaults = { idle_minutes: 5, max_containers: 20, max_lifetime_minutes: 240, cpus: 1, memory_mb: 2048, pids: 512, tmp_mb: 512, workspace_mb: 512 };
const computers = { settings: { ...defaults }, defaults,
  bounds: { idle_minutes: [1, 120], max_containers: [1, 500], max_lifetime_minutes: [10, 10080], cpus: [0.25, 16], memory_mb: [256, 65536], pids: [64, 16384], tmp_mb: [16, 16384], workspace_mb: [16, 16384] },
  host: { cpus: 4, memory_mb: 16384 }, usage: { computers: 2, busy: 1, waiting: 0 } };
const homes = { settings: { home_limit_gb: 5, retention_days: 30, total_alert_gb: 50 }, defaults: { home_limit_gb: 5, retention_days: 30, total_alert_gb: 50 },
  bounds: { home_limit_gb: [1, 1024], retention_days: [1, 3650], total_alert_gb: [1, 1000000] } };
const owner = 'a'.repeat(32);
const overview = alert => ({ totals: { bytes: alert ? 60 * gib : 2 * gib, alert_bytes: 50 * gib, alert }, disk: { free_bytes: 170 * gib, total_bytes: 1024 * gib }, computers: { running: 2, busy: 1 },
  homes: [{ owner, kind: 'group', subject: 'chat-1', name: '数据分析群', generation: 2, bytes: 6 * gib, files: 1200, active_at: Date.UTC(2026, 10, 12), read_only: true, computer: 'busy',
    sealed: [{ generation: 1, sealed_at: Date.UTC(2026, 10, 1), reason: 'scope_narrowed', bytes: gib }] },
  { owner: 'b'.repeat(32), kind: 'person', subject: 'principal-1', name: 'alice', generation: 1, bytes: 1024, files: 3, active_at: Date.UTC(2026, 10, 10), read_only: false, computer: null, sealed: [] }] });

test('the assistant computer category saves timers and HOME limits together, each computer\'s resources on their own, and clears a HOME after confirmation', async () => {
  let saved = null, cleared = null, alert = true;
  const page = loadConsole(scripts, (method, path, body) => {
    if (path === '/api/settings' && method === 'PATCH') { saved = body; return [200, { settings: { assistant_computers: { computers: { ...computers, settings: { ...computers.settings, ...body.assistant_computers } }, homes } } }]; }
    if (path === '/api/settings') return [200, { settings: { task_concurrency: 1, task_concurrency_bounds: [1, 32], computer_defaults: null, assistant_computers: { computers, homes } } }];
    if (path === '/api/assistant-computers') return [200, overview(alert)];
    if (path === `/api/assistant-computers/${owner}/clear` && method === 'POST') { cleared = owner; alert = false; return [200, { owner, cleared: true }]; }
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/assistant-computers';");
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel'), text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');
  const section = title => panel.querySelectorAll('section').find(node => node.querySelector('h3')?.textContent === title);
  assert.deepEqual(panel.querySelectorAll('h3').map(node => node.textContent), ['助手电脑设置', '每台电脑的资源', 'HOME 占用']);
  assert.equal(panel.querySelector('nav a[aria-current=page]').textContent, '助手电脑');
  const form = section('助手电脑设置').querySelector('form'), value = name => form.querySelectorAll('input').find(i => i.name === name);
  assert.deepEqual(['idle_minutes', 'max_containers', 'max_lifetime_minutes', 'home_limit_gb', 'retention_days', 'total_alert_gb'].map(name => String(value(name).value)), ['5', '20', '240', '5', '30', '50']);
  assert.match(text(section('助手电脑设置')), /2 台（使用中 1 台，排队 0 个）/);
  value('idle_minutes').value = '10'; value('home_limit_gb').value = '8';
  await form.listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(saved, { assistant_computers: { idle_minutes: 10, home_limit_gb: 8 } });
  // Each computer's resources, in the same fields as the work computers' defaults plus the working directory; no runtime choice.
  const resources = section('每台电脑的资源'), select = name => resources.querySelectorAll('select').find(node => node.name === name);
  assert.deepEqual(resources.querySelectorAll('select').map(node => node.name), ['cpus', 'memory_mb', 'pids', 'tmp_mb', 'workspace_mb']);
  assert.deepEqual(select('cpus').querySelectorAll('option').map(node => node.textContent), ['0.5 核', '1 核（默认）', '2 核', '4 核'], 'no size above the host');
  assert.match(text(resources), /4 CPU · 16 GB 内存/);
  assert.doesNotMatch(text(panel), /运行时/);
  select('memory_mb').value = '4096'; select('workspace_mb').value = '1024';
  await resources.querySelector('form').listeners.submit[0]({ preventDefault() {} }); await settle();
  assert.deepEqual(saved, { assistant_computers: { memory_mb: 4096, workspace_mb: 1024 } });
  assert.match(text(section('每台电脑的资源')), /已保存：新建的电脑立即使用，已有的在下一个回合重建/);
  // The HOME list: the total over the alert threshold is an alert, each HOME shows its use, state and sealed generations.
  const list = section('HOME 占用');
  assert.match(text(list), /所有 HOME 合计 60\.00 GB，超过告警值 50\.00 GB/);
  assert.match(text(list), /群 数据分析群.*6\.00 GB.*1200.*超过上限，只读 · 电脑使用中；封存 1 代（1\.00 GB）/);
  assert.match(text(list), /个人 alice.*1 KB.*3.*可写/);
  const clear = list.querySelectorAll('button').find(b => b.textContent === '清空');
  const confirmed = clear.listeners.click[0](); await settle();
  const dialog = page.run('confirmView');
  assert.match(text(dialog), /清空群 数据分析群的 HOME？/);
  await dialog.querySelector('form').listeners.submit[0]({ preventDefault() {} }); await confirmed;
  assert.equal(cleared, owner);
  assert.doesNotMatch(text(section('HOME 占用')), /超过告警值/);
});

test('without assistant computers the category says so instead of a form', async () => {
  const page = loadConsole(scripts, (_method, path) => {
    if (path === '/api/settings') return [200, { settings: { task_concurrency: 1, task_concurrency_bounds: [1, 32], computer_defaults: null, assistant_computers: null } }];
    if (path === '/api/assistant-computers') return [503, { error: 'assistant_computers_unavailable' }];
    throw new Error('Unexpected request: ' + path);
  });
  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/assistant-computers';");
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel'), text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');
  assert.equal(panel.querySelectorAll('form').length, 0);
  assert.match(text(panel), /助手电脑不可用/);
});
