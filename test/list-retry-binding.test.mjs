import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConsole} from './console-page.mjs';

// #872: the error card's retry belongs to the read that failed, not to whatever `tab`/`offset`/filters happen to say
// when the button is pressed. The console bumps `renderVersion` on every navigation and redraw, so a card whose version
// is behind is a card for a page the console has already left.
function failedProjectsPage() {
  let failing = true;
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, {integrations: []}];
    if (failing) return [500, {error: 'fixture_unavailable'}];
    return [200, {repositories: [{id: '101', owner_id: '10', full_name: 'fixture/project-101', registered: true, enabled: true, running_tasks: 0, queued_tasks: 0}], syncs: []}];
  });
  page.run("me = {role: 'project_admin'}; tab = 'projects'; offset = 0;");
  return {page, recover: () => { failing = false; }};
}
const retryButton = page => page.$('rows').querySelector('[data-testid=console-state-retry]');
// The listener wrapper drops the promise, so a click is waited on the way the page is: let the read it starts finish.
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('the error card retries the list whose read failed, at the same address', async () => {
  const {page, recover} = failedProjectsPage();
  await page.run('render()');
  const card = page.$('rows').querySelector('[data-testid=console-state-error]');
  assert.ok(card, 'the failed read draws the error card');
  assert.equal(card.getAttribute('role'), 'alert');
  const button = retryButton(page);
  assert.ok(button, 'the card offers a retry');
  const read = page.requests.filter(request => request.startsWith('GET /api/repositories'));
  assert.equal(read.length, 1);
  recover();
  button.listeners.click[0]();
  await settle();
  const again = page.requests.filter(request => request.startsWith('GET /api/repositories'));
  assert.equal(again.length, 2, 'the retry reads the list again');
  assert.equal(again[1], again[0], 'and asks for exactly the address that failed');
  assert.equal(page.$('rows').querySelectorAll('.row').length, 1, 'the rows that came back are the same list');
});

test('a card the console has left behind redraws nothing and says where to retry', async () => {
  const {page, recover} = failedProjectsPage();
  await page.run('render()');
  const button = retryButton(page);
  assert.ok(button);
  // A navigation that keeps the card in the DOM but moves the console on: `route()` bumps the version before it draws
  // its own page (a project page, a console page), and the list panel is hidden rather than emptied.
  page.run("tab = 'board'; renderVersion++");
  const before = page.requests.length;
  recover();
  button.listeners.click[0]();
  await settle();
  assert.equal(page.requests.length, before, 'the stale card issues no read for the page the console is on');
  assert.equal(page.$('rows').querySelectorAll('.row').length, 0, 'and draws no rows over it');
  assert.equal(retryButton(page), null, 'the stale button is not left offering the same mistake');
  assert.match(page.$('rows').querySelector('p.muted').textContent, /已经离开当前页面/);
});

test('a newer read of the same list replaces the card and its retry', async () => {
  const {page, recover} = failedProjectsPage();
  await page.run('render()');
  const stale = retryButton(page);
  assert.ok(stale);
  recover();
  await page.run('render()');
  assert.equal(retryButton(page), null, 'the drawn list carries no error card');
  stale.listeners.click[0]();
  await settle();
  const reads = page.requests.filter(request => request.startsWith('GET /api/repositories'));
  assert.equal(reads.length, 2, 'the replaced button reads nothing further');
  assert.equal(page.$('rows').querySelectorAll('.row').length, 1, 'and leaves the drawn rows alone');
});
