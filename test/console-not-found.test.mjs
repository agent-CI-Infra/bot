import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #642: route matching. An address under #/ that names no page is reported as unknown, so the console can say
// 找不到这个页面 instead of keeping (or silently loading) another page; every address the console knows is left alone.
test('unknownAddress separates unknown console addresses from known ones and in-page anchors', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], () => [200, {}]);
  const unknown = hash => page.run(`location.hash = ${JSON.stringify(hash)}; unknownAddress(location.hash)`);
  for (const hash of ['#/nonexistent', '#/nonexistent/deeper', '#/projects/abc', '#/projects/101/Members', '#/projects/101/a-b', '#/Projects', '#/123'])
    assert.equal(unknown(hash), true, hash);
  for (const hash of ['', '#', '#/', '#main-content', '#external', '#/projects', '#/projects/101', '#/projects/101/overview', '#/projects/101/bogus',
    '#/board', '#/costs', '#/events', '#/inbox', '#/inbox/101', '#/more', '#/new-task', '#/new-task/2', '#/conversations', '#/identity',
    '#/identity/feishu?section=groups', '#/preferences', '#/management', '#/settings', '#/settings/users', '#/settings/onboarding/3', '#/design',
    '#/reviews', '#/developments', '#/accounts', '#/users'])
    assert.equal(unknown(hash), false, hash);
});

test('the not-found state has one primary way back: the project list, or the project overview inside a project', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], () => [200, {}]);
  const links = state => state.querySelectorAll('a').map(a => [a.textContent, a.href, /btn-primary/.test(a.className)]);
  const top = page.run('pageNotFoundState()');
  assert.equal(top.querySelector('h2').textContent, '找不到这个页面');
  assert.equal(top.querySelector('p').textContent, '链接可能已过期或输入有误。');
  assert.deepEqual(links(top), [['回到项目列表', '#/projects', true], ['查看身份与权限', '#/identity', false]]);
  const inner = page.run("pageNotFoundState('101')");
  assert.equal(inner.dataset.pageNotFound, 'project');
  assert.deepEqual(links(inner), [['回到项目总览', '#/projects/101/overview', true], ['回到项目列表', '#/projects', false]]);
  page.run('setNotFoundTitle(true)'); assert.equal(page.run('document.title'), '找不到页面 · launchpad 管理');
  page.run('setNotFoundTitle(false)'); assert.equal(page.run('document.title'), 'launchpad 管理');
});
