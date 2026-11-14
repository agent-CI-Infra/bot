import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #614: a project page that cannot be read shows a plain state with a next step, never the bare status and code.
test('project unavailable state: forbidden and missing look the same, other failures offer a retry', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], () => [200, {}]);
  const kind = (status, code) => page.run(`projectUnavailableKind(Object.assign(new Error(''), { status: ${status}, code: ${JSON.stringify(code)} }))`);
  assert.equal(kind(403, 'repository_forbidden'), 'forbidden');
  assert.equal(kind(404, 'repository_not_found'), 'forbidden', 'the page does not reveal whether the project exists');
  assert.equal(kind(500, 'internal_error'), 'failed');
  assert.equal(kind(502, 'response_not_json'), 'failed');
  const render = (status, code) => page.run(`projectUnavailable(Object.assign(new Error('${status} · ${code}'), { status: ${status}, code: '${code}' }), { id: '7', section: 'overview' })`);
  const forbidden = render(403, 'repository_forbidden');
  assert.equal(forbidden.querySelector('h2').textContent, '没有权限打开这个项目');
  assert.deepEqual(forbidden.querySelectorAll('.console-state-actions a').map(a => [a.textContent, a.href]), [['返回项目列表', '#/projects'], ['查看身份与权限', '#/identity']]);
  assert.match(forbidden.querySelector('.console-state-actions a').className, /btn-primary/);
  assert.equal(forbidden.querySelector('details code').textContent, '403 · repository_forbidden', 'the raw code is only under 详细信息');
  assert.ok(!forbidden.querySelector('p').textContent.includes('repository_forbidden'));
  const failed = render(500, 'internal_error');
  assert.equal(failed.querySelector('h2').textContent, '暂时打不开这个项目');
  assert.equal(failed.querySelector('.console-state-actions button').textContent, '重试');
  assert.deepEqual(failed.querySelectorAll('.console-state-actions a').map(a => [a.textContent, a.href]), [['返回项目列表', '#/projects']]);
});
