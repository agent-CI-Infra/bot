import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #738: `#message` used to keep whatever role the last write gave it — a failed login set role=alert and only a successful
// login put role=status back — while every other failure (a save, a retry, an installation sync, an auth error) was
// announced politely because `notice()` never wrote `role` at all. The strip must now carry the semantics of the message
// in it: an error is an alert, the next ordinary message is a status again. Both attributes are written because
// `static/index.html` sets `aria-live="polite"` statically, which otherwise wins over role=alert's assertive default.
test('#738: notice() writes role and aria-live for the message it shows, so an error does not stay an alert', async () => {
  const page = loadConsole(['static/app/state.js', 'static/app/api.js'], async () => [200, {}]);
  const message = page.$('message');

  page.run(`notice('message', '保存失败：权限不足', '', 'alert')`);
  assert.equal(message.getAttribute('role'), 'alert');
  assert.equal(message.getAttribute('aria-live'), 'assertive');

  page.run(`notice('message', '已保存')`);
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(message.getAttribute('aria-live'), 'polite');

  // The shared error path is an alert on its own, without a hand-written role in the caller.
  page.run(`notice('message')`);
  page.run(`error(new Error('500 · internal_error'))`);
  assert.equal(message.getAttribute('role'), 'alert');
  assert.equal(message.getAttribute('aria-live'), 'assertive');

  // Clearing the strip leaves nothing to announce, and it must not keep the previous message's role: a failed login's
  // alert used to survive into the retry because the old reset was the only thing that put role=status back.
  page.run(`notice('message')`);
  assert.equal(message.childElementCount, 0);
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(message.getAttribute('aria-live'), 'polite');
  page.run(`notice('message', '安装列表已同步', 'view-success')`);
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(message.getAttribute('aria-live'), 'polite');
});

// #738 review: `#task-error` is created by static/views/widgets.js as a role=alert box that only ever holds an error, and
// every caller (task-session.js, task-cards.js) passes it an error message. Treating it like the shared strip and
// defaulting it to `kind: 'status'` made it polite, so a failed task read or a failed retry was announced after the page
// had moved on. A box a page authored keeps its own role unless the caller says otherwise; aria-live follows the role that
// is actually written, so the announcement stays assertive either way.
test('#738: a notice in an authored alert box stays an alert, and an explicit kind still wins', async () => {
  const page = loadConsole(['static/app/state.js', 'static/app/api.js'], async () => [200, {}]);
  const taskError = page.$('task-error');
  taskError.setAttribute('role', 'alert');

  page.run(`notice('task-error', '503 · service_unavailable')`);
  assert.equal(taskError.getAttribute('role'), 'alert');
  assert.equal(taskError.getAttribute('aria-live'), 'assertive');
  assert.equal(taskError.querySelector('span').textContent, '503 · service_unavailable');

  // A box without an authored role is not silently promoted to an alert, but a caller can still ask for one.
  const editorError = page.$('editor-error');
  page.run(`notice('editor-error', '保存失败：权限不足')`);
  assert.equal(editorError.getAttribute('role'), 'status');
  assert.equal(editorError.getAttribute('aria-live'), 'polite');
  page.run(`notice('editor-error', '保存失败：权限不足', '', 'alert')`);
  assert.equal(editorError.getAttribute('role'), 'alert');
  assert.equal(editorError.getAttribute('aria-live'), 'assertive');
});
