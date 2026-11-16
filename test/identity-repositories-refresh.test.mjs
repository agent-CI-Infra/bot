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
