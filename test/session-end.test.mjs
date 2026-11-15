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
