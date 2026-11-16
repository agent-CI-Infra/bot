// #866: when the GitHub permission check ends, the console reads the projects the person may now manage. That read can
// fail — a 5xx from the control plane, a timeout — and the check is already answered, so the watch is over: nothing reads
// again, and the reader kept the old project list without a word. The line now says the list could not be read and offers
// to read it again; only that read is repeated, and a read that comes back draws the new projects and clears the notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

const listed = [{ id: 101, full_name: 'fixture/project-101' }];
const load = respond => loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], (method, path) => {
  if (path === '/api/repositories') return respond();
  return [200, {}];
});
const refused = () => [500, { error: 'fixture_unavailable' }];
const served = () => [200, { repositories: listed }];
// The notice line as the reader sees it: whether it shows, the state that turns the spinner off, and its parts in order.
const line = page => page.run(`(() => { const el = $('github-verification');
  return JSON.stringify({ hidden: el.hidden, state: el.dataset.state, parts: [...el.children].map(node => node.textContent) }); })()`);
const notice = async page => JSON.parse(await line(page));

test('a project-list read that fails after the check says so on the line instead of ending silently', async () => {
  const page = load(refused);
  page.run("me = { id: 7 }; tab = 'settings'; $('repository-filter').options = [];");
  // The rejection used to reach the caller's `.catch(error)`: the watch had already ended, so nothing read again.
  await page.run('finishGithubVerification({ id: 7 })');
  const read = await notice(page);
  assert.equal(read.hidden, false, 'the check no longer follows, but the failed list read stays visible');
  assert.equal(read.state, 'failed');
  assert.deepEqual(read.parts,
    [await page.run("t('verification.repositories_failed')"), await page.run("t('verification.repositories_retry')")],
    'the line says the read failed, beside a button that reads again');
});

test('the button reads the list again, and a read that comes back draws the new projects and clears the line', async () => {
  let failures = 1;
  const page = load(() => failures-- > 0 ? refused() : served());
  page.run("me = { id: 7 }; tab = 'settings'; $('repository-filter').options = [];");
  await page.run('finishGithubVerification({ id: 7 })');
  assert.equal((await notice(page)).state, 'failed');
  assert.equal(await page.run("$('repository-filter').childElementCount"), 0, 'the failed read listed nothing');
  await page.run("$('github-verification').querySelector('button').listeners.click[0]()");
  const read = await notice(page);
  assert.equal(read.hidden, true, 'a read that came back takes the notice away');
  assert.deepEqual(JSON.parse(await page.run("JSON.stringify(repositories.map(project => project.full_name))")), ['fixture/project-101']);
  assert.deepEqual(JSON.parse(await page.run("JSON.stringify([...$('repository-filter').children].map(node => node.textContent))")),
    ['fixture/project-101'], 'and the project picker carries the projects it named');
});

test('a project-list read that works shows no notice at all', async () => {
  const page = load(served);
  page.run("me = { id: 7 }; tab = 'settings'; $('repository-filter').options = [];");
  await page.run('finishGithubVerification({ id: 7 })');
  const read = await notice(page);
  assert.equal(read.hidden, true);
  assert.equal(read.state, undefined);
  assert.deepEqual(read.parts, []);
  assert.deepEqual(JSON.parse(await page.run("JSON.stringify(repositories.map(project => project.full_name))")), ['fixture/project-101']);
});

// #866 review: the project picker stands for the whole list. The list page reads one page of it — offset, limit 51 and
// maybe a filter — so such a read is a slice and must leave the notice, its account and the picker exactly as they are.
const sixty = Array.from({ length: 60 }, (_, index) => ({ id: String(100 + index), full_name: `fixture/project-${100 + index}` }));
const picker = page => page.run(`JSON.stringify([...$('repository-filter').children].map(node => node.value))`);
const setupPage = page => page.run("me = { id: 7, role: 'project_admin', github_verification: null }; repositories = []; tab = 'projects'; var projectRoute = () => null; " +
  "$('repository-filter').options = [{ value: '' }]; $('repository-filter').value = ''; $('account-filter').options = [{ value: '' }]; $('owner-filter').options = [{ value: '' }];");

test('a page read of the project list does not clear the notice or put its fifty rows in the project picker', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], (method, path) => {
    if (path === '/api/repositories') return refused();
    if (path.startsWith('/api/repositories?')) return [200, { repositories: sixty.slice(0, 51) }];
    return [200, {}];
  });
  setupPage(page);
  await page.run('finishGithubVerification({ id: 7 })');
  assert.equal((await notice(page)).state, 'failed');
  await page.run('render()');
  const read = await notice(page);
  assert.equal(read.state, 'failed', 'a page is not the list the notice waits for');
  assert.equal(await page.run('repositoriesUnreadOwner'), 7, 'and it does not take the account the notice belongs to');
  assert.deepEqual(JSON.parse(await picker(page)), [], 'the picker still holds no list rather than one page of it');
  assert.deepEqual(JSON.parse(await page.run('JSON.stringify(repositories)')), [], 'and the list the picker draws from is untouched');
  assert.ok(page.requests.some(request => /^GET \/api\/repositories\?offset=0&limit=51$/.test(request)), 'the page asked for one page');
});

test('a filtered read leaves the notice alone, and the notice\'s own read still recovers the whole list', async () => {
  let failures = 1;
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], (method, path) => {
    if (path === '/api/repositories') return failures-- > 0 ? refused() : [200, { repositories: sixty }];
    if (path.startsWith('/api/repositories?')) return [200, { repositories: sixty.slice(0, 1) }];
    return [200, {}];
  });
  setupPage(page);
  await page.run('finishGithubVerification({ id: 7 })');
  page.run("$('repository-filter').value = '100'");
  await page.run('render()');
  assert.match(page.requests.at(-1), /repository_id=100/, 'the page read one repository');
  assert.equal((await notice(page)).state, 'failed', 'a range is not the list either: the notice stays');
  assert.equal(await page.run('repositoriesUnreadOwner'), 7, 'and so does its account, so a later whole read can still recover');
  assert.deepEqual(JSON.parse(await picker(page)), [], 'the picker does not follow a filtered read');
  await page.run("$('github-verification').querySelector('button').listeners.click[0]()");
  const read = await notice(page);
  assert.equal(read.hidden, true, 'the whole-list read is the recovery');
  assert.equal(await page.run('repositories.length'), 60, 'every project the read listed, not the fifty of a page');
  assert.equal(JSON.parse(await picker(page)).length, 60, 'and the picker carries all of them');
});

test('a new session does not inherit the failed read of the session before it', async () => {
  const page = load(refused);
  page.run("me = { id: 7, role: 'project_admin', github_verification: null }; repositories = []; tab = 'settings'; $('repository-filter').options = [{ value: '' }];");
  await page.run('finishGithubVerification({ id: 7 })');
  assert.equal(await page.run('repositoriesUnreadOwner'), 7);
  page.run("me = { id: 8, role: 'project_admin', github_verification: null }; watchGithubVerification();");
  assert.equal(await page.run('repositoriesUnreadOwner'), null, 'the signed-out or switched session leaves no unread state behind');
});

// The redraw that puts the finished check on screen used to call route() on the project list, which reads the list again:
// a transient failure drew fresh rows beside a notice that said the read failed, and an outage offered two retries for
// one read. The notice's button now owns that read, and the list shows the failure without a second retry.
test('the list is drawn as a failed read without reading again or offering a second retry', async () => {
  const page = load(refused);
  page.run("me = { id: 7 }; tab = 'projects'; $('repository-filter').options = [];");
  await page.run('finishGithubVerification({ id: 7 })');
  assert.deepEqual(page.requests.filter(request => request === 'GET /api/repositories'), ['GET /api/repositories'],
    'one failed read: the redraw draws the state it knows instead of reading the list again');
  const rows = page.$('rows');
  assert.equal(rows.querySelectorAll('.console-state-error').length, 1, 'the project list says the read failed');
  assert.equal(rows.querySelectorAll('button').length, 0, 'the notice above the list is the only retry for this read');
  assert.ok(rows.querySelectorAll('.console-state-error')[0].querySelectorAll('h2').some(heading => heading.textContent === '项目列表未能读取'));
  assert.equal((await notice(page)).state, 'failed');
});
