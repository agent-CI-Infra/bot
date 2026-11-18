import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #799: a project administrator opens #/settings/storage, so the page has to name it 存储 and speak plainly: the
// category bar is not "全局设置", the two tables name what they count, and the original terms stay in the th title.
const scripts = ['static/app.js', 'static/views.js', 'static/costs.js', 'static/project.js', 'static/settings.js', 'static/onboarding.js'];
const textOf = node => [node.textContent, ...node.children.flatMap(textOf)].join(' ');
const byTag = (node, tag) => node.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...byTag(child, tag)]);
const pageFor = role => {
  const page = loadConsole(scripts, (method, path) => {
    if (method === 'GET' && path === '/api/storage') return [200, { refreshed_at: '2026-11-15T08:00:00.000Z', alerts: [], projects: [{ repository_id: '101', name: 'fixture/project-101',
      files: { count: 1, bytes: 10 }, records: {}, blobs: { count: 0, bytes: 0 }, open: { count: 0, bytes: 0 }, manager: null,
      computer: { total_bytes: 100, complete: true, scanned_at: '2026-11-15T08:00:00.000Z' } }] }];
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run(`me = { role: '${role}', repositories: ['101'], csrf_token: 'csrf' }; location.hash = '#/settings/storage';`);
  return page;
};

test('the storage page speaks plainly without its old jargon in the headers', async () => {
  const page = pageFor('project_admin');
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel'), shown = textOf(panel);
  // The intro says what is counted and how often, not how the snapshot is implemented.
  assert.match(shown, /这里统计/, 'the opening note says what this page counts');
  assert.match(shown, /每 5 分钟更新一次/, 'and how often it updates');
  assert.doesNotMatch(shown, /轨迹文件按运行保存模型请求/, 'the implementation paragraph is gone');
  // Headers are words a project administrator can read; the old term is still there for anyone who knows it.
  const headers = byTag(panel, 'th');
  const caption = text => headers.find(header => header.textContent === text);
  for (const [text, term] of [['文件块', 'blob'], ['管理过程记录', 'manager 轨迹'], ['运行日志', 'runner journal'], ['Git 仓库缓存', 'git 存储'], ['工作目录缓存', 'HOME 缓存']]) {
    const header = caption(text);
    assert.ok(header, `a ${text} column header exists`);
    assert.equal(header.getAttribute('title'), term, `${text} keeps the original term in its title`);
  }
  for (const term of ['blob', 'manager 轨迹', 'runner journal', 'git 存储', 'HOME 缓存']) assert.ok(!headers.some(header => header.textContent === term), `no header is just ${term}`);
  // A project administrator has no "全局设置" category bar.
  const nav = byTag(panel, 'nav')[0];
  assert.equal(nav.getAttribute('aria-label'), '设置类别', 'the category bar is not called 全局设置 for a project administrator');
});

test('a super administrator still sees the platform category bar, and the storage category keeps its own name', async () => {
  const page = pageFor('super_admin');
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel');
  assert.equal(byTag(panel, 'nav')[0].getAttribute('aria-label'), '全局设置类别', 'the platform category bar keeps its name');
  // The same plain headers apply to both roles.
  assert.ok(byTag(panel, 'th').some(header => header.textContent === '文件块'));
});
