import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';
import { readFileSync } from 'node:fs';

// #790: the project list asks for its task counts every five seconds. A 401/403/404 will answer the same way however
// often it is asked, so the poll stops and says so where the reader can see it, with one manual way to read again;
// anything else may clear on its own, so it keeps asking on a delay that doubles up to half a minute.
const row = { id: '101', owner_id: '10', full_name: 'fixture/one', registered: true, enabled: true, installed: true,
  running_tasks: 2, queued_tasks: 0, review_enabled: false, development_enabled: false, access_gaps: [] };

const pageWith = respond => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [200, {}];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return respond(method, path);
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects';`);
  return page;
};

test('a task-count read that answers 403 stops the poll, keeps the rows and says so once', async () => {
  let status = 200, reads = 0;
  const page = pageWith(() => { reads++; return status === 200 ? [200, { repositories: [row], syncs: [] }] : [status, { error: 'forbidden' }]; });
  page.run('Date.now = () => 0');
  await page.run('render()');
  assert.equal(page.$('rows').querySelectorAll('.row').length, 1);
  const afterRender = reads;
  status = 403;
  await page.run('refreshProjectActivity()');
  assert.equal(reads - afterRender, 1, 'the failing read is the one request');
  const notice = page.$('rows').querySelector('[data-testid=project-activity-status]');
  assert.ok(notice, 'the stop is visible in the list, not hidden in a preview title');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.match(notice.textContent, /任务数已停止更新/);
  assert.equal(page.$('rows').querySelectorAll('.row').length, 1, 'the numbers already on the list stay');
  // The five-second tick asks refreshProjectActivity(); a terminal answer must not become another request.
  const afterStop = reads;
  await page.run('refreshProjectActivity()');
  await page.run('refreshProjectActivity()');
  assert.equal(reads, afterStop, 'a 403 is not asked again every five seconds');
});

test('a task-count read that answers 5xx backs off, and a success restores the five-second cadence', async () => {
  let mode = 'ok', reads = 0;
  const page = pageWith(() => {
    reads++;
    return mode === 'fail' ? [503, { error: 'unavailable' }] : [200, { repositories: [row], syncs: [] }];
  });
  page.run(`Date.now = () => globalThis.__now;`); page.run('__now = 1000');
  await page.run('render()');
  const afterRender = reads;
  mode = 'fail';
  await page.run('refreshProjectActivity()');
  assert.equal(reads - afterRender, 1);
  const notice = () => page.$('rows').querySelector('[data-testid=project-activity-status]');
  assert.ok(notice(), 'a retried failure is stated too');
  assert.match(notice().textContent, /5 秒后重试/);
  // The next tick lands before the delay is over: nothing is asked, and the note still says the same.
  page.run('__now = 5000'); const afterFirstFailure = reads;
  await page.run('refreshProjectActivity()');
  assert.equal(reads, afterFirstFailure, 'the poll waits out the delay instead of asking every five seconds');
  // The delay doubles: 5 s → 10 s → 20 s → at most 30 s.
  page.run('__now = 6000'); await page.run('refreshProjectActivity()');
  assert.equal(reads, afterFirstFailure + 1, 'the read is asked again once the delay is over');
  assert.match(notice().textContent, /10 秒后重试/);
  page.run('__now = 11000'); const afterSecondFailure = reads;
  await page.run('refreshProjectActivity()');
  assert.equal(reads, afterSecondFailure, 'the doubled delay is waited out as well');
  // A success clears the note and the backoff: the next tick asks straight away again.
  mode = 'ok'; page.run('__now = 16000');
  await page.run('refreshProjectActivity()');
  assert.equal(notice(), null, 'a successful read takes the stopped or delayed note away');
  const afterSuccess = reads;
  await page.run('refreshProjectActivity()');
  assert.equal(reads, afterSuccess + 1, 'the five-second cadence is back after a success');
});

test('the visible stop offers one manual read, and it works once the listing is readable again', async () => {
  let status = 200, reads = 0;
  const page = pageWith(() => { reads++; return status === 200 ? [200, { repositories: [row], syncs: [] }] : [status, { error: 'forbidden' }]; });
  page.run('Date.now = () => 0');
  await page.run('render()');
  status = 403; await page.run('refreshProjectActivity()');
  const notice = page.$('rows').querySelector('[data-testid=project-activity-status]');
  const retry = notice.querySelector('button');
  assert.ok(retry, 'the reader has one control to read the counts again');
  assert.match(retry.textContent, /重新读取任务数/);
  status = 200; const before = reads;
  await retry.listeners.click[0]();
  assert.equal(reads, before + 1, 'the control reads the list again by hand');
  assert.equal(page.$('rows').querySelector('[data-testid=project-activity-status]'), null);
});

// The review's second point: the status line names .view-warning, so that class has to carry a visible warning style;
// otherwise the stop is drawn as ordinary body text.
test('the visible warning has its own stylesheet rule', () => {
  const css = readFileSync(new URL('../../../static/views.css', import.meta.url), 'utf8');
  assert.match(css, /\.view-warning\{[^}]*background:/, 'a .view-warning rule must give the status line its own background');
  assert.match(css, /\.view-warning\{[^}]*color:/, 'and its own text colour');
});
