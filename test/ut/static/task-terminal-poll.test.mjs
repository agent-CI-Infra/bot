import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

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

// A backoff belongs to the task that paid it: without this reset, a task opened later in the same page session starts its
// own first recoverable failure where the previous task stopped (review of #745, non-blocking).
test('a task opened after another backed off starts its first retry at five seconds', async t => {
  const { page } = taskPage([503, { error: 'unavailable' }]);
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('openTask("t9")');
  await page.run('(async () => { clearTimeout(taskTimer); await refreshTask(); })()');
  assert.equal(page.run('taskRetryDelay'), 10000, 'the first task has backed off');
  page.run('openTaskChoices("全部任务", [])');
  assert.equal(page.run('taskRetryDelay'), 0, 'the picker clears the delay the previous task reached');
  await page.run('openTask("t9")');
  assert.equal(page.run('taskRetryDelay'), 5000, 'the next task waits five seconds, not the delay the previous one reached');
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

// #877: the failure bar is written by the poll's own catch, so a later refresh that succeeds has to withdraw it — the
// task is readable again and the bar still claiming otherwise is a lie the screen reader repeats. The bar is shared with
// the retry path (#745), whose conflict text must outlive refreshes, so only the exact text the poll wrote may be
// withdrawn, and only after the existing `current()` guard has passed.
const polledTask = { id: 't9', repository_id: '101', kind: 'review.issue', object_number: 1, status: 'waiting_pr_head', phase: 'publish', attempt: 1 };
function pollPage(read, retry = () => [409, { error: 'task_already_running' }]) {
  const page = loadConsole(['static/app.js', 'static/views.js'], async (method, path) => {
    if (method === 'POST') return retry();
    if (method === 'GET' && path === '/api/tasks/t9') return read();
    if (path.endsWith('/logs')) return [200, { logs: [], log_page: { has_older: false, has_newer: false } }];
    return [200, { task: polledTask, publications: [] }];
  });
  page.run("renderTimeline=()=>{};refreshLive=async()=>{};renderTaskSide=()=>{};keepOpen=(node,draw)=>draw();openTaskId='t9';taskView.showModal();");
  return page;
}
const barText = page => page.$('task-error').querySelector('span')?.textContent || '';

test('a refresh that succeeds withdraws the failure the poll wrote (#877)', async t => {
  let online = false;
  const page = pollPage(() => online ? [200, { task: polledTask, publications: [] }] : [500, { error: 'internal_error' }]);
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('refreshTask()');
  assert.match(barText(page), /500 · internal_error/, 'the failed refresh reports itself');
  online = true;
  await page.run('refreshTask()');
  assert.equal(page.$('task-error').childElementCount, 0, 'a recovered task no longer claims it is unreadable');
});

test('a failure that keeps happening keeps its bar (#877)', async t => {
  const page = pollPage(() => [503, { error: 'unavailable' }]);
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('refreshTask()');
  await page.run('refreshTask()');
  assert.match(barText(page), /503 · unavailable/);
  assert.equal(page.$('task-error').childElementCount, 2, 'the bar still holds its text and close button');
});

test('an explicit re-read after a terminal failure clears the old bar too (#877)', async t => {
  let status = 403;
  const page = pollPage(() => status === 403 ? [403, { error: 'forbidden' }] : [200, { task: polledTask, publications: [] }]);
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('refreshTask()');
  assert.equal(page.$('task-title').textContent, '任务暂不可访问');
  assert.match(barText(page), /403 · forbidden/);
  status = 200;
  await page.run('refreshTask()');
  assert.equal(page.$('task-error').childElementCount, 0, 'the re-read ends the outage, so the bar goes with it');
});

test('a retry conflict stays visible across a refresh that succeeds (#877 guard)', async t => {
  const page = pollPage(() => [200, { task: polledTask, publications: [] }]) ;
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  await page.run('refreshTask()');
  const retry = page.$('task-actions').querySelectorAll('button').find(node => node.textContent === '重试');
  assert.ok(retry, 'a waiting task offers a retry');
  await retry.listeners.click[0]({ currentTarget: retry });
  assert.match(barText(page), /这个任务已经在执行或排队/);
  await page.run('refreshTask()');
  assert.match(barText(page), /这个任务已经在执行或排队/, 'the retry path owns its text, so the poll leaves it alone');
});

test('a slow success from before the failure cannot withdraw the newer error (#877 guard)', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const page = loadConsole(['static/app.js', 'static/views.js'], async (method, path) => {
    if (method === 'GET' && path === '/api/tasks/t9') {
      reads += 1;
      if (reads === 1) { await gate; return [200, { task: polledTask, publications: [] }]; }
      return [500, { error: 'boom' }];
    }
    if (path.endsWith('/logs')) return [200, { logs: [], log_page: { has_older: false, has_newer: false } }];
    return [200, { task: polledTask, publications: [] }];
  });
  page.run("renderTimeline=()=>{};refreshLive=async()=>{};renderTaskSide=()=>{};keepOpen=(node,draw)=>draw();openTaskId='t9';taskView.showModal();");
  t.after(() => page.run('taskView.close(); clearTimeout(taskTimer);'));
  const stale = page.run('refreshTask()');
  await new Promise(resolve => setTimeout(resolve, 20));
  await page.run('refreshTask()');
  assert.match(barText(page), /500 · boom/);
  release(); await stale;
  assert.match(barText(page), /500 · boom/, 'a newer failure outranks the success that predates it');
});
