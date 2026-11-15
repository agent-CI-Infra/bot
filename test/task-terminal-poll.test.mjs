import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #739: 401/403/404 on the task detail cannot start working by retrying: the page has already said the task is out of
// reach, so the poll has to stop and offer an explicit read instead. Only a recoverable failure (5xx, network) keeps
// polling, and it backs off instead of hitting a failing endpoint every five seconds.
function taskPage(detail) {
  const requests = [];
  const page = loadConsole(['static/app.js', 'static/views.js'], (_method, path) => {
    requests.push(path);
    if (path.endsWith('/logs')) return [200, { logs: [], log_page: { has_older: false, has_newer: false } }];
    if (path.includes('/roles?')) return [200, { instances: [], assignments: [], runs: [], snapshots: {} }];
    if (path.includes('/events?type=role_handoff')) return [200, { events: [] }];
    if (path.startsWith('/api/environments/')) return [404, {}];
    if (path === '/api/tasks/t9') return detail;
    return [404, {}];
  });
  page.run("scroller = node => node; taskMetricsCard = () => element('section','');");
  return { page, requests };
}

const detailReads = requests => requests.filter(path => path === '/api/tasks/t9').length;

test('a 403 on the task detail stops the poll, says it once and offers an explicit read', async t => {
  const { page, requests } = taskPage([403, { error: 'forbidden' }]);
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('openTask("t9")');
  assert.equal(page.$('task-title').textContent, '任务暂不可访问');
  assert.equal(detailReads(requests), 1);
  // Nothing is scheduled: the next read would fail the same way.
  assert.equal(page.run('taskTimer'), null, 'no timer is left behind after a terminal answer');
  // The page reports the failure once and offers closing or reading again by hand, not a silent retry loop.
  assert.equal(page.$('task-actions').querySelectorAll('button').length, 2);
  assert.deepEqual(page.$('task-actions').querySelectorAll('button').map(node => node.textContent), ['关闭', '重新读取']);
  // notice() draws its text as a child span, so the failure is read there.
  assert.match(page.$('task-error').querySelector('span').textContent, /403 · forbidden/);
});

test('a 404 and a 401 are terminal too, and the log read lands in the same place', async t => {
  for (const status of [401, 404]) {
    const { page } = taskPage([status, { error: 'gone' }]);
    t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
    await page.run('openTask("t9")');
    assert.equal(page.run('taskTimer'), null, `a ${status} schedules nothing`);
    assert.equal(page.$('task-actions').querySelectorAll('button').length, 2);
  }
});

test('a recoverable failure keeps polling, backing off instead of retrying every five seconds', async t => {
  const { page, requests } = taskPage([503, { error: 'unavailable' }]);
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('openTask("t9")');
  assert.notEqual(page.run('taskTimer'), null, 'a 5xx still polls');
  assert.equal(page.run('taskRetryDelay'), 5000);
  // The dialog stays open; the next attempt backs off further, up to a ceiling.
  await page.run('(async () => { clearTimeout(taskTimer); await refreshTask(); })()');
  assert.equal(page.run('taskRetryDelay'), 10000);
  await page.run('(async () => { clearTimeout(taskTimer); await refreshTask(); })()');
  assert.equal(page.run('taskRetryDelay'), 20000);
  await page.run('(async () => { clearTimeout(taskTimer); await refreshTask(); })()');
  assert.equal(page.run('taskRetryDelay'), 30000);
  await page.run('(async () => { clearTimeout(taskTimer); await refreshTask(); })()');
  assert.equal(page.run('taskRetryDelay'), 30000, 'the delay stops growing at 30 s');
  assert.equal(detailReads(requests), 5);
});

// The decision lives in one helper so every polled page (task detail, channels, release, model fields) stops on the same
// statuses instead of each page deciding for itself.
test('pollAfterError is one rule: access lost stops, anything else backs off to half a minute', async () => {
  const { page } = taskPage([500, { error: 'unavailable' }]);
  const decide = code => JSON.stringify(page.run(code));
  assert.equal(decide('pollAfterError({ status: 403 })'), '{"terminal":true,"delay":0}');
  assert.equal(decide('pollAfterError({ status: 401 }, 10000)'), '{"terminal":true,"delay":0}');
  assert.equal(decide('pollAfterError({ status: 404 }, 30000)'), '{"terminal":true,"delay":0}');
  assert.equal(decide('pollAfterError({ status: 500 })'), '{"terminal":false,"delay":5000}');
  assert.equal(decide('pollAfterError({ status: 502 }, 5000)'), '{"terminal":false,"delay":10000}');
  assert.equal(decide('pollAfterError({ status: 0 }, 20000)'), '{"terminal":false,"delay":30000}');
  assert.equal(decide('pollAfterError(null, 30000)'), '{"terminal":false,"delay":30000}');
});
