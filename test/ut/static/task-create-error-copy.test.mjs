import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #527: this page formats its own request failures through static/task-create.js's taskCreationRequestError, in both
// languages. A kind it can name is a dictionary phrase; anything else keeps the status and, only when the service's
// code is a short ASCII identifier, that code — never the service's prose, which can be Chinese on an English page.
const cjk = /[\u4e00-\u9fff]/;

function page(locale) {
  const console = loadConsole(['static/task-create.js'], () => [200, {}]);
  console.run(`setLocale(${JSON.stringify(locale)})`);
  return console;
}
const message = (locale, expression) => page(locale).run(`taskCreationRequestError(${expression})`);

const cancelled = `(() => { const err = new Error('aborted'); err.name = 'AbortError'; return err; })()`;
const cases = [
  { name: 'a cancelled request', error: cancelled, en: 'Request cancelled', zh: '请求已取消' },
  { name: 'a refused connection', error: `new TypeError('Failed to fetch')`,
    en: 'The network request failed, try again shortly', zh: '网络连接失败，请稍后重试' },
  { name: 'a gateway error page on 500', error: `({ code: 'response_not_json', status: 500 })`,
    en: '500 · The gateway answered with an error page and no specific reason. Try again shortly; if it persists, ask an administrator to read the service log.',
    zh: '500 · 入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。' },
  { name: 'an unreadable body on 200', error: `({ code: 'response_not_json', status: 200 })`,
    en: '200 · The service answered with content that could not be read; reload the page and try again.',
    zh: '200 · 服务返回了无法识别的内容，请刷新页面后重试。' },
  { name: 'a changed authorization', error: `({ code: 'authorization_changed', status: 409 })`,
    en: 'Permissions changed; reload the page and retry under the current permissions.',
    zh: '权限已变化，请刷新页面后按当前权限重试。' },
  { name: 'a safe ASCII code kept', error: `({ status: 403, code: 'capability_forbidden' })`,
    en: '403 · capability_forbidden', zh: '403 · capability_forbidden' },
  // The service answers prose when it does not answer a code; the page shows the status alone rather than that prose.
  { name: 'a prose code dropped', error: `({ status: 500, code: '服务暂时不可用，请联系管理员' })`, en: '500', zh: '500' },
  { name: 'a code missing', error: `({ status: 500 })`, en: '500', zh: '500' },
  { name: 'neither status nor code', error: `({})`, en: 'The request failed', zh: '请求失败' },
];

test('English new-task request failures stay purely English across every failure kind', () => {
  for (const failure of cases) {
    const text = message('en', failure.error);
    assert.equal(text, failure.en, failure.name);
    assert.doesNotMatch(text, cjk, `Chinese leaked into English (${failure.name}): ${text}`);
    assert.doesNotMatch(text, /taskCreate\./, `raw dictionary key left for ${failure.name}: ${text}`);
  }
});

test('Chinese new-task request failures ' + 'preserve the exact wording the page showed before', () => {
  for (const failure of cases) {
    const text = message('zh-CN', failure.error);
    assert.equal(text, failure.zh, failure.name);
    assert.doesNotMatch(text, /taskCreate\./, `raw dictionary key left for ${failure.name}: ${text}`);
  }
});
