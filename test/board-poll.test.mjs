import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #789: the board's quiet refresh is a read like any other. A 404 answers the same way however often it is asked, so the
// refresh stops and leaves a control the reader can press; anything else keeps asking with the shared backoff, and one
// success puts the board back on its 15 second rhythm.
function loaded() {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/board.js'], () => [200, {}]);
  page.run(`
    me = { id: '1' };
    tab = 'board';
    boardState = { owner: '1', viewId: 'default', group: 'bot_stage', filters: [], fields: [], workflows: [], stages: [],
      type: 'all', cards: [], workCount: 0, signature: '[[],false,{},0,{}]', offset: 0, hasMore: false, columnCounts: {} };
    document.activeElement = document.body;
    Node.prototype.contains = function (node) { for (let at = node; at; at = at.parentElement) if (at === this) return true; return false; };
    globalThis.requests = 0;
    globalThis.delays = [];
    globalThis.setTimeout = (fn, ms) => { delays.push(ms); return delays.length; };
    globalThis.clearTimeout = () => {};
  `);
  return page;
}
const status = page => page.run("$('board-status').children.map(child => child.textContent)");
const call = page => page.run('boardPoll().then(() => {}, () => {})');

test('a 404 stops the refresh and leaves a control the reader can press', async () => {
  const page = loaded();
  page.run(`globalThis.api = async () => { requests++; const err = new Error('missing'); err.status = 404; throw err; };`);
  await call(page);
  assert.equal(page.run('requests'), 1);
  // No next tick is scheduled: asking again would get the same answer.
  // Values built inside the sandbox realm are compared as JSON: their prototypes are not this realm's.
  assert.equal(JSON.stringify(page.run('delays')), '[]');
  const children = status(page);
  assert.match(children.join(' '), /刷新已停止/);
  // The entry is a real button with a click handler, not a sentence promising a click that does nothing.
  assert.equal(page.run("$('board-status').children.map(child => child.tagName)").at(-1), 'BUTTON');
  assert.equal(page.run("$('board-status').children.at(-1).listeners.click.length"), 1);
});

test('a 5xx keeps asking with a doubling backoff, and one success returns to 15 seconds', async () => {
  const page = loaded();
  page.run(`globalThis.api = async () => { requests++; const err = new Error('temporary'); err.status = 503; throw err; };`);
  for (let attempt = 0; attempt < 5; attempt++) await call(page);
  assert.equal(page.run('requests'), 5);
  assert.equal(JSON.stringify(page.run('delays')), '[5000,10000,20000,30000,30000]');
  page.run(`globalThis.api = async () => ({ cards: [], has_more: false, counts: {}, release_count: 0, work_count: 0, column_counts: {} });`);
  await call(page);
  assert.equal(JSON.stringify(page.run('delays')), '[5000,10000,20000,30000,30000,15000]');
  assert.equal(page.run('typeof boardPollTimer'), 'number');
});

// #789 review: a newer read bumps boardRequest, so the in-flight poll's answer is stale. The old unconditional interval
// kept the chain alive through that; a single-shot chain must do the same, or one toolbar 刷新 stops the quiet refresh
// until the board is rendered again.
test('a poll superseded by a newer read keeps the chain alive on both answers', async () => {
  for (const status of [null, 503]) {
    const page = loaded();
    page.run(`
      globalThis.api = async () => {
        requests++; boardRequest++;
        ${status === null ? "return { cards: [], has_more: false, counts: {}, release_count: 0, work_count: 0, column_counts: {} };" : "const err = new Error('temporary'); err.status = 503; throw err;"}
      };
    `);
    await call(page);
    assert.equal(page.run('requests'), 1);
    assert.equal(JSON.stringify(page.run('delays')), '[15000]', `a superseded ${status === null ? 'success' : 'failure'} still schedules the next tick`);
  }
});

test('signing out or a changed owner still ends the chain', async () => {
  for (const setup of ["me = null;", "boardState.owner = '2';", "tab = 'projects';"]) {
    const page = loaded();
    page.run(`${setup}globalThis.api = async () => { requests++; return { cards: [] }; };`);
    await call(page);
    assert.equal(JSON.stringify(page.run('delays')), '[]', `${setup} stops the chain`);
  }
});

test('a full read resets the backoff, and so does leaving the board', async () => {
  const page = loaded();
  page.run(`globalThis.api = async () => { const err = new Error('temporary'); err.status = 503; throw err; };`);
  for (let attempt = 0; attempt < 3; attempt++) await call(page);
  assert.equal(page.run('boardPollBackoff'), 20000);
  page.run('resetBoard()');
  assert.equal(page.run('boardPollBackoff'), 0);
});
