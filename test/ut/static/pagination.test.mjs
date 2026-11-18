import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #747: the shared list renderer asked for `limit=50` and treated a full page as "there is more", so a total that is a
// multiple of 50 enabled 下一页 and the next click drew an empty page. The list APIs only slice, so the probe has to ask
// for one row beyond the page; these tests answer with the slice the real API would return, for whatever limit is asked.
const repository = n => ({ id: String(n), full_name: `fixture/project-${n}`, owner_id: '10', owner_login: 'fixture', private: false,
  installed: true, registered: true, enabled: true, review_enabled: true, development_enabled: false, model_id: 'm',
  running_tasks: 0, queued_tasks: 0, permission: 'admin' });

function projectList(total) {
  const rows = Array.from({ length: total }, (_, index) => repository(1000 + index));
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    const url = new URL('http://console' + path);
    if (method === 'GET' && url.pathname === '/api/integrations') return [200, { integrations: [] }];
    if (method === 'GET' && url.pathname === '/api/installations') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return [200, { syncs: [], repositories: rows.slice(offset, offset + limit) }];
    }
    return [404, { error: 'not_found' }];
  });
  page.run("var projectRoute = () => null; me = { role: 'super_admin', csrf_token: 'csrf' }; tab = 'projects'; offset = 0;");
  return page;
}

const state = (page, id, property = 'textContent') => page.run(`document.getElementById(${JSON.stringify(id)}).${property}`);
const drawn = page => page.$('rows').querySelectorAll('.row');

test('a full page of exactly 50 repositories has no next page, and 下一页 stays disabled', async () => {
  const page = projectList(50);
  await page.run('render()');
  assert.equal(drawn(page).length, 50);
  assert.equal(state(page, 'count'), '50 个仓库 · 尚未同步');
  assert.equal(state(page, 'page-number'), '第 1 页');
  assert.equal(state(page, 'previous', 'disabled'), true);
  // The old implementation asked for 50 and read a full answer as "more to come"; the probe must not.
  assert.equal(state(page, 'next', 'disabled'), true, '总数正好 50 时不应出现下一页');
  assert.ok(!page.requests.some(request => request.includes('offset=50')), 'no second page may be requested');
  assert.equal(page.requests.filter(request => request.startsWith('GET /api/installations')).length, 1);
});

test('51 repositories give one next page holding the last repository, and no page after it', async () => {
  const page = projectList(51);
  await page.run('render()');
  assert.equal(drawn(page).length, 50, 'the probe row is not drawn');
  assert.equal(state(page, 'count'), '50 个仓库 · 尚未同步');
  assert.equal(state(page, 'next', 'disabled'), false);

  page.run('offset = 50;');
  await page.run('render()');
  assert.equal(drawn(page).length, 1);
  assert.equal(state(page, 'page-number'), '第 2 页');
  assert.equal(state(page, 'count'), '1 个仓库 · 尚未同步');
  assert.equal(state(page, 'next', 'disabled'), true, 'the last page must not offer another one');
  assert.equal(state(page, 'previous', 'disabled'), false);
});

test('an empty list disables both directions and keeps the empty state', async () => {
  const page = projectList(0);
  await page.run('render()');
  assert.equal(drawn(page).length, 0);
  assert.equal(state(page, 'next', 'disabled'), true);
  assert.equal(state(page, 'previous', 'disabled'), true);
  assert.equal(state(page, 'page-number'), '第 1 页');
});

test('a quiet refresh notices the row that made a new page possible', async () => {
  let total = 50;
  const rows = Array.from({ length: 51 }, (_, index) => repository(1000 + index));
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    const url = new URL('http://console' + path);
    if (method === 'GET' && url.pathname === '/api/installations') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return [200, { syncs: [], repositories: rows.slice(0, total).slice(offset, offset + limit) }];
    }
    if (method === 'GET' && url.pathname === '/api/integrations') return [200, { integrations: [] }];
    return [404, { error: 'not_found' }];
  });
  page.run("var projectRoute = () => null; me = { role: 'super_admin', csrf_token: 'csrf' }; tab = 'projects'; offset = 0;");
  await page.run('render()');
  assert.equal(state(page, 'next', 'disabled'), true);
  // The first fifty rows are unchanged; only the row beyond the page appeared. The periodic refresh must still update it.
  total = 51;
  await page.run('render(true)');
  assert.equal(state(page, 'next', 'disabled'), false, 'a quiet refresh must not leave a stale 下一页');
  assert.equal(drawn(page).length, 50);
});

test('the global project batch list pages by the probe row too', async () => {
  const build = total => {
    const rows = Array.from({ length: total }, (_, index) => repository(2000 + index));
    const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/settings.js'], (method, path) => {
      const url = new URL('http://console' + path);
      if (method === 'GET' && url.pathname === '/api/installations') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return [200, { syncs: [], repositories: rows.slice(offset, offset + limit) }];
      }
      if (method === 'GET' && url.pathname === '/api/integrations') return [200, { integrations: [] }];
      return [404, { error: 'not_found' }];
    });
    page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; request = 1;");
    return page;
  };
  const section = async (page, id) => (await page.run(`globalProjectSettings(1, ${JSON.stringify(id)})`))[0];
  const batch = card => card.querySelectorAll('.global-project-row');
  const links = card => card.querySelectorAll('a').map(link => link.href)
    .filter(href => String(href).startsWith('#/settings/projects/list.'));

  const fifty = build(50);
  const fiftyPage = await section(fifty, 'list.0');
  assert.equal(batch(fiftyPage).length, 50, 'the probe row is not listed');
  assert.deepEqual(links(fiftyPage), [], '总数正好 50 时不应出现下一页链接');

  const fiftyOne = build(51);
  const firstPage = await section(fiftyOne, 'list.0');
  assert.equal(batch(firstPage).length, 50);
  assert.deepEqual(links(firstPage), ['#/settings/projects/list.50']);
  const secondPage = await section(fiftyOne, 'list.50');
  assert.equal(batch(secondPage).length, 1, 'the last page holds only the row that exists');
  assert.deepEqual(links(secondPage), ['#/settings/projects/list.0']);
});
