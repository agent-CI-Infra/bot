import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #642: route matching. An address under #/ that names no page is reported as unknown, so the console can say
// 找不到这个页面 instead of keeping (or silently loading) another page; every address the console knows is left alone.
test('unknownAddress separates unknown console addresses from known ones and in-page anchors', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], () => [200, {}]);
  const unknown = hash => page.run(`location.hash = ${JSON.stringify(hash)}; unknownAddress(location.hash)`);
  for (const hash of ['#/nonexistent', '#/nonexistent/deeper', '#/events', '#/projects/abc', '#/projects/101/Members', '#/projects/101/a-b', '#/Projects', '#/123'])
    assert.equal(unknown(hash), true, hash);
  for (const hash of ['', '#', '#/', '#main-content', '#external', '#/projects', '#/projects/101', '#/projects/101/overview', '#/projects/101/bogus',
    '#/board', '#/costs', '#/inbox', '#/inbox/101', '#/more', '#/new-task', '#/new-task/2', '#/conversations', '#/identity',
    '#/identity/feishu?section=groups', '#/preferences', '#/management', '#/settings', '#/settings/users', '#/settings/onboarding/3', '#/design',
    '#/reviews', '#/developments', '#/accounts', '#/users'])
    assert.equal(unknown(hash), false, hash);
});

// #736: an address whose id cannot be decoded is no address the console knows. The legacy computer address is unknown
// (it would otherwise redirect to a project path built from garbage); a settings detail id that cannot be decoded reads
// as "no id", so its section still opens as a list.
test('an address with malformed percent-encoding is unknown, except where the id reads as no id', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], () => [200, {}]);
  const unknown = hash => page.run(`location.hash = ${JSON.stringify(hash)}; unknownAddress(location.hash)`);
  assert.equal(unknown('#/settings/computers/%E0%A4%A'), true);
  for (const hash of ['#/settings/users/%E0%A4%A', '#/settings/installations/%E0%A4%A', '#/settings/work-computers'])
    assert.equal(unknown(hash), false, hash);
  // The shared decoder answers the decoded value or null, and leaves a legal encoding alone.
  assert.equal(page.run("safeDecode('%61')"), 'a');
  assert.equal(page.run("safeDecode('%E0%A4%A')"), null);
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
  // #779: a title belongs to a session. Without one the sign-in screen keeps the chrome name, so a project render still
  // in flight when the reader signs out cannot rename it; the page names below are written for a signed-in reader.
  page.run("document.title = 'launchpad 管理'");
  page.run('setNotFoundTitle(true)'); assert.equal(page.run('document.title'), 'launchpad 管理');
  page.run("me = { role: 'super_admin' }");
  page.run('setNotFoundTitle(true)'); assert.equal(page.run('document.title'), '找不到页面 · launchpad 管理');
  // #737: the title names the page the address belongs to; the default tab here is 项目.
  page.run('setNotFoundTitle(false)'); assert.equal(page.run('document.title'), '项目 · launchpad 管理');
});

// #966: the old delivery list has no page. #/events is the same unknown address as any other missing hash, so it draws
// 找不到这个页面 and never reads GET /api/events.
test('#/events is unknown and does not read the delivery list', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], () => [200, {}]);
  page.run("me = { role: 'super_admin' }; projectRoute = () => null; renderConsolePage = () => { if (tab === 'not-found') renderNotFoundPage(); }; $('list-panel').className = 'list-panel'; location.hash = '#/events';");
  await page.run('route()');
  assert.equal(page.run('tab'), 'not-found');
  assert.equal(page.run("unknownAddress('#/events')"), true);
  const missing = page.$('console-page').querySelector('[data-page-not-found=console]');
  assert.equal(missing.querySelector('h2').textContent, '找不到这个页面');
  assert.equal(page.requests.some(request => request.includes('/api/events')), false);
  assert.equal(page.$('console-page').querySelector('[data-delivery-record]'), null);
});
