import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #715: a 401 from a signed-in console is one expired-session state, not a per-page read failure.
const page = (respond = () => [401, { error: 'login_required' }]) => {
  const p = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], respond);
  p.run(`var projectRoute = () => null; me = { role: 'project_admin', username: 'member', csrf_token: 'x' };`);
  return p;
};

test('concurrent 401 login_required answers raise one banner and the header stops naming a role', async () => {
  const p = page();
  assert.equal(p.run('currentRoleText()'), '项目管理员');
  const results = await p.run(`Promise.allSettled([api('/api/repositories'), api('/api/identity'), api('/api/costs')])`);
  assert.deepEqual(JSON.parse(JSON.stringify(results.map(r => r.status))), ['rejected', 'rejected', 'rejected']);
  assert.equal(results[0].reason.code, 'login_required', 'callers still get the error');
  const banners = p.$('main-content').querySelectorAll('.session-expired-banner');
  assert.equal(banners.length, 1);
  assert.equal(banners[0].getAttribute('role'), 'alert');
  assert.equal(banners[0].querySelector('span').textContent, '登录已过期，请重新登录后继续。');
  assert.equal(banners[0].querySelector('button').textContent, '重新登录');
  assert.ok(p.run('document.body.classList.contains("session-expired")'));
  assert.equal(p.run('currentRoleText()'), '登录已过期');
  assert.equal(p.$('console-account-role').textContent, '登录已过期');
  assert.ok(!p.$('who').querySelectorAll('span').some(el => el.textContent === '项目管理员'));
  // The raw toast is not added on top of the banner.
  p.run(`error(Object.assign(new Error('401 · login_required'), { status: 401, code: 'login_required' }))`);
  assert.equal(p.$('message').childElementCount, 0);
});

test('every error card shown while expired says 登录已过期 with 重新登录 and keeps the raw text under 技术信息', async () => {
  const p = page();
  await p.run(`api('/api/costs').catch(() => {})`);
  const card = p.run(`consoleState('统计未能读取', '401 · login_required。这不是空结果，当前无法判断这个范围内是否有记录。', { tone: 'error', retry: () => {} })`);
  assert.equal(card.querySelector('h2').textContent, '登录已过期');
  assert.equal(card.querySelector('p').textContent, '当前登录已失效，请重新登录后再查看。');
  assert.deepEqual(card.querySelectorAll('button').map(b => b.textContent), ['重新登录'], 'no useless 重新加载');
  assert.equal(card.querySelector('details summary').textContent, '技术信息');
  assert.match(card.querySelector('details code').textContent, /401 · login_required/);
  // Empty and loading states are not affected.
  assert.equal(p.run(`consoleState('还没有仓库', '空列表')`).querySelector('h2').textContent, '还没有仓库');
  // The project page's own login branch now uses the same card instead of stacking a second set of actions.
  const project = p.run(`projectUnavailable(Object.assign(new Error('401 · login_required'), { status: 401, code: 'login_required' }), { id: '7', section: 'overview' })`);
  assert.equal(project.dataset.projectUnavailable, 'login');
  assert.equal(project.querySelectorAll('button').length, 1);
});

test('the list page error card becomes the expired-session card', async () => {
  const p = page();
  p.run(`tab = 'projects'; repositories = [];`);
  await p.run('render().catch(() => {})');
  const card = p.$('rows').querySelector('.console-state');
  assert.equal(card.querySelector('h2').textContent, '登录已过期');
  assert.ok(!card.querySelector('p').textContent.includes('login_required'));
});

test('a wrong password, a signed-out boot check and other errors are not an expired session', async () => {
  const signedOut = page(() => [401, { error: 'login_required' }]);
  signedOut.run('me = null');
  await signedOut.run(`api('/api/auth/me').catch(() => {})`);
  assert.equal(signedOut.$('main-content').querySelectorAll('.session-expired-banner').length, 0);
  const wrong = page(() => [401, { error: 'invalid_login' }]);
  await wrong.run(`api('/api/auth/login', 'POST', {}).catch(() => {})`);
  assert.equal(wrong.run('sessionExpired'), false);
  const forbidden = page(() => [403, { error: 'repository_forbidden' }]);
  await forbidden.run(`api('/api/repositories/7').catch(() => {})`);
  assert.equal(forbidden.run('sessionExpired'), false);
  assert.equal(forbidden.run(`consoleState('读取失败', '403', { tone: 'error' })`).querySelector('h2').textContent, '读取失败');
});

test('重新登录 keeps the address for one boot and GitHub sign-in comes back to it', async () => {
  const p = page((method, path) => path === '/api/auth/github/status' ? [200, { enabled: true }] : [401, { error: 'login_required' }]);
  p.run(`globalThis.sessionStorage = { getItem: k => globalThis.__store.get(k) ?? null, setItem: (k, v) => globalThis.__store.set(k, v), removeItem: k => globalThis.__store.delete(k) };
    location.hash = '#/costs'; location.assign = url => { globalThis.__assigned = url; };`);
  p.run('globalThis.__store = new Map()');
  await p.run(`api('/api/costs').catch(() => {})`);
  await p.run('signInAgain()');
  assert.equal(p.run('globalThis.__assigned'), '/auth/github/start');
  assert.equal(p.run(`globalThis.__store.get('launchpad.session_return_hash')`), '#/costs');
  // The GitHub callback always lands on #/identity; the next boot puts the saved address back once.
  p.run(`location.hash = '#/identity'; location.search = '?github_auth=1'; history.replaceState = (s, t, url) => { globalThis.__replaced = url; };`);
  p.run('restoreSessionReturn()');
  assert.equal(p.run('globalThis.__replaced'), '/?github_auth=1#/costs');
  assert.equal(p.run(`globalThis.__store.has('launchpad.session_return_hash')`), false);
  p.run('clearSessionExpired()');
  assert.equal(p.$('main-content').querySelectorAll('.session-expired-banner').length, 0);
  assert.equal(p.run('sessionExpired'), false);
});
