// #754: while a GitHub permission check runs the console follows it by reading /api/auth/me. A read that fails — a 5xx,
// a timeout, a dropped network — used to be retried at the same 1.5 s pace for as long as the endpoint kept failing, and
// said nothing about it. It now doubles the wait (1.5 s, 3 s, 6 s … capped at 30 s), says on the line that reading failed
// once three in a row have, offers a read now, reads nothing at all in a hidden tab, and keeps the expired-session exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

const progress = { checked: 0, total: 1 };
// `respond` answers one /api/auth/me read; every other path is an empty 200.
const load = respond => loadConsole(['static/app.js', 'static/views.js', 'static/project.js'], (method, path) => {
  if (path !== '/api/auth/me') return [200, {}];
  return respond();
});
const reads = page => page.requests.filter(request => request === 'GET /api/auth/me').length;
// A clock of its own: the follow-up waits are read from the timers it schedules, and `tick` runs what is due in order,
// awaiting each read so the next request is counted before the assertion.
const clock = page => page.run(`(() => {
  let now = 0, next = 0; const queue = [];
  setTimeout = (fn, ms = 0) => { const id = ++next; queue.push({ id, fn, at: now + ms }); return id; };
  clearTimeout = id => { const at = queue.findIndex(timer => timer.id === id); if (at >= 0) queue.splice(at, 1); };
  globalThis.tick = async ms => {
    const until = now + ms;
    for (;;) {
      const due = queue.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      queue.splice(queue.indexOf(due), 1); now = due.at; await due.fn();
    }
    now = until;
  };
  globalThis.nextDelay = () => queue.length ? Math.min(...queue.map(timer => timer.at - now)) : null;
})()`);
// Signed in with the check running, which is the only state in which the console follows it.
const arrange = page => page.run('me = { id: 7, github_verification: { checked: 0, total: 1 } }; watchGithubVerification();');
const line = page => page.run("$('github-verification').textContent");
const following = () => [200, { id: 7, github_verification: progress }];
const failing = () => [500, { error: 'fixture_unavailable' }];

test('a progress read that fails is retried after a wait that doubles, up to a 30 s cap', async () => {
  const page = load(failing); clock(page); arrange(page);
  assert.equal(await page.run('nextDelay()'), 1500, 'a healthy follow-up keeps the 1.5 s pace');
  await page.run('tick(1500)'); assert.equal(reads(page), 1);
  assert.equal(await page.run('nextDelay()'), 3000, 'one failure doubles it');
  await page.run('tick(2999)'); assert.equal(reads(page), 1, 'not before the wait is over');
  await page.run('tick(1)'); assert.equal(reads(page), 2);
  assert.equal(await page.run('nextDelay()'), 6000);
  await page.run('tick(6000)'); assert.equal(reads(page), 3);
  assert.equal(await page.run('nextDelay()'), 12000);
  await page.run('tick(12000)'); assert.equal(reads(page), 4);
  assert.equal(await page.run('nextDelay()'), 24000);
  await page.run('tick(24000)'); assert.equal(reads(page), 5);
  assert.equal(await page.run('nextDelay()'), 30000, '24 s doubles to 48 s, so the cap takes over');
  await page.run('tick(30000)'); assert.equal(reads(page), 6);
  assert.equal(await page.run('nextDelay()'), 30000, 'and stays at the cap');
});

test('three failed reads in a row say so on the line, beside a button that reads now', async () => {
  const page = load(failing); clock(page); arrange(page);
  const failed = await page.run("t('verification.failed')"), retry = await page.run("t('verification.retry')");
  // The sandbox's arrays come from another realm, so they cross back as JSON.
  const parts = async () => JSON.parse(await page.run("JSON.stringify([...$('github-verification').children].map(node => node.textContent))"));
  await page.run('tick(1500)'); await page.run('tick(3000)');
  assert.doesNotMatch(await line(page), new RegExp(failed.split('，')[0]), 'two failures still look like progress');
  await page.run('tick(6000)');
  assert.deepEqual(await parts(), [failed, retry], 'a third failure replaces the progress line with the failure and a read-now button');
  assert.equal(await page.run("$('github-verification').dataset.state"), 'failed', 'and the spinner gives way to it');
  // The button reads at once instead of waiting out the 12 s the third failure asked for; that read fails too, so the
  // wait it leaves behind is the next doubling.
  await page.run("$('github-verification').querySelector('button').listeners.click[0]()");
  assert.equal(reads(page), 4);
  assert.equal(await page.run('nextDelay()'), 24000);
});

test('a read that comes back clears the failure state and the 1.5 s pace resumes', async () => {
  let failures = 3;
  const page = load(() => failures-- > 0 ? failing() : following());
  clock(page); arrange(page);
  await page.run('tick(1500)'); await page.run('tick(3000)'); await page.run('tick(6000)');
  assert.equal(reads(page), 3);
  assert.equal(await page.run("$('github-verification').dataset.state"), 'failed');
  // The fourth read, after the 12 s wait, answers: the line is the check's progress again.
  await page.run('tick(12000)');
  assert.equal(reads(page), 4);
  assert.equal(await page.run("$('github-verification').dataset.state"), undefined);
  assert.match(await line(page), /0\/1/);
  assert.equal(await page.run('nextDelay()'), 1500, 'the failure count is forgotten');
  await page.run('tick(1500)'); assert.equal(reads(page), 5);
});

test('an expired session still ends the watch at once, without a backoff retry', async () => {
  const page = load(() => [401, { error: 'unauthorized' }]); clock(page); arrange(page);
  await page.run('tick(1500)');
  assert.equal(reads(page), 1);
  assert.equal(await page.run('nextDelay()'), null, 'no retry is scheduled');
  assert.equal(await page.run("$('github-verification').hidden"), true, 'the expiry banner takes over');
  await page.run('tick(60000)');
  assert.equal(reads(page), 1, 'and it never reads again');
});

test('a hidden tab reads nothing, and coming back reads at once', async () => {
  const page = load(failing); clock(page); arrange(page);
  page.run('document.hidden = true');
  await page.run('tick(1500)');
  assert.equal(reads(page), 0, 'the timer that fired while hidden reads nothing');
  assert.equal(await page.run('nextDelay()'), null, 'and schedules nothing to fire in the background');
  await page.run('document.hidden = false; resumeGithubVerification()');
  assert.equal(reads(page), 1, 'becoming visible reads at once');
  assert.equal(await page.run('nextDelay()'), 3000, 'a failed read still backs off');
});
