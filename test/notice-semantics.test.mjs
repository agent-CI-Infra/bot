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

  // Clearing the strip leaves nothing to announce, and the next status message is polite again.
  page.run(`notice('message')`);
  assert.equal(message.childElementCount, 0);
  page.run(`notice('message', '安装列表已同步', 'view-success')`);
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(message.getAttribute('aria-live'), 'polite');
});
