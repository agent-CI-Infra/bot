import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #779: signing out and deleting your own account end the same session. The sign-in screen keeps the chrome title, the
// next sign-in opens and announces a page of its own, and the previous reader's address is gone.
const respond = (method, path) => method === 'DELETE' && /^\/api\/users\//.test(path) ? [204, {}] : [200, {}];

test('endSession() clears the page name, the announcement, the address and the lists it drew', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], respond);
  page.run(`me = { id: '1', role: 'super_admin' }; tab = 'settings'; location.hash = '#/settings/users';
    document.title = '设置 · launchpad 管理'; announcedPage = 'page:settings';
    $('rows').append(document.createElement('div')); $('detail-body').append(document.createElement('div'));
    globalThis.replaced = null; history.replaceState = (...args) => { globalThis.replaced = args; location.hash = ''; };`);
  page.run('endSession()');
  assert.equal(page.run('document.title'), 'launchpad 管理');
  assert.equal(page.run('announcedPage'), null);
  assert.equal(page.run('me'), null);
  assert.equal(page.run('tab'), 'projects');
  assert.equal(page.run('location.hash'), '');
  // The call is compared as JSON: the value was built inside the sandbox realm, so its prototypes are not this realm's.
  assert.equal(JSON.stringify(page.run('replaced')), JSON.stringify([null, '', '/']));
  assert.equal(page.run("$('rows').children.length"), 0);
  assert.equal(page.run("$('detail-body').children.length"), 0);
  // The next sign-in's first page is drawn from nothing announced yet, so it is set up without being announced.
  page.run(`me = { id: '2', role: 'super_admin' }; announcedPage = null;`);
  const heading = page.run("pageHeading(null) || null");
  page.run('announcePage(false, null)');
  assert.equal(page.run('announcedPage'), 'page:projects');
  assert.equal(heading.ownerFocus, undefined);
});

test('endSession() keeps the wizard address, which onboarding.js resets to its first step', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], respond);
  page.run(`me = { id: '1' }; location.hash = '#/settings/onboarding/3';
    globalThis.replaced = null; history.replaceState = (...args) => { globalThis.replaced = args; location.hash = ''; };`);
  page.run('endSession()');
  assert.equal(page.run('replaced'), null);
});

// #779 F2: a project render still in flight when the reader signed out must not rename the sign-in screen.
test('applyDocumentTitle() writes nothing without a session', () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], respond);
  page.run("document.title = 'launchpad 管理';");
  page.run('applyDocumentTitle(true)');
  assert.equal(page.run('document.title'), 'launchpad 管理');
  page.run("applyDocumentTitle(false, { id: '101', section: 'overview' })");
  assert.equal(page.run('document.title'), 'launchpad 管理');
  page.run("me = { id: '1', role: 'super_admin' }; tab = 'projects';");
  page.run('applyDocumentTitle(false)');
  assert.equal(page.run('document.title'), '项目 · launchpad 管理');
});

// #869 review F1: the recorded check failure belongs to the signed-in account. Signing out drops it, so the next
// reader is not shown the previous account's failed check, its reading time, or a retry the new session cannot use.
test('endSession() drops the project check statement so the next account does not inherit it', async () => {
  const base = { owner_id: '10', full_name: 'fixture/project-101', registered: true, enabled: true, installed: true, running_tasks: 0,
    queued_tasks: 0, review_enabled: true, development_enabled: false, model_id: 'm', board_enabled: false, board_state: 'none' };
  const stale = { ...base, id: '101', access_gaps: [], permissions_stale: true, permissions_checked_at: '2026-01-01T00:00:00.000Z' };
  const fresh = { ...base, id: '101', access_gaps: [], permissions_stale: false, permissions_checked_at: '2026-01-02T00:00:00.000Z' };
  let rows = [stale];
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    if (method === 'POST' && path === '/api/installations/permissions/check') return [503, { error: 'github_unavailable' }];
    return [200, { repositories: rows, syncs: [] }];
  });
  page.run("var projectRoute = () => null; history.replaceState = () => {}; me = { id: '1', role: 'super_admin' }; tab = 'projects';");
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  await page.run('render()'); await settle();
  assert.equal(page.run('projectCheckFailures.size'), 1, 'the failed check is recorded for the account that ran it');
  assert.ok(page.$('rows').querySelector('[data-testid=project-check-status]'), 'the failed check is stated for that account');
  page.run('endSession()');
  assert.equal(page.run('projectCheckFailures.size'), 0, 'signing out forgets the failed check');
  assert.equal(page.run('projectCheckReads.size'), 0, 'signing out forgets when the reading was taken');
  // The next account reads a list it can judge itself; nothing of the previous reader's check may appear on it.
  rows = [fresh];
  page.run("me = { id: '2', role: 'super_admin' }; tab = 'projects';");
  await page.run('render()'); await settle();
  assert.equal(page.$('rows').querySelector('[data-testid=project-check-status]'), null, 'the next account inherits no statement');
  assert.equal(page.run('projectCheckFailures.size'), 0);
});

// #869 review F1: a check that answers after the reader signed out must not write into the session that comes next.
test('a project check that answers after sign-out writes nothing', async () => {
  let checks = 0;
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (method === 'POST' && path === '/api/installations/permissions/check') { checks++; return [503, { error: 'github_unavailable' }]; }
    return [200, { integrations: [], repositories: [], syncs: [] }];
  });
  page.run("var projectRoute = () => null; history.replaceState = () => {}; me = { id: '1', role: 'super_admin' }; tab = 'projects';");
  const pending = page.run('refreshStalePermissions()');
  page.run('endSession()');
  await pending;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(checks, 1, 'the check did run for the account that asked');
  assert.equal(page.run('projectCheckFailures.size'), 0, 'the late answer is not recorded for the next reader');
  assert.equal(page.run('projectCheckReads.size'), 0);
  assert.equal(page.$('rows').querySelector('[data-testid=project-check-status]'), null, 'the sign-in screen gets no project statement');
});
