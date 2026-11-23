import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #527: installation archive read and re-sync failures format through static/i18n.js in both English and Chinese,
// never leaking Chinese clauses into English sentences or raw service prose into either language.
const cjk = /[\u4e00-\u9fff]/;
const visible = node => [node.textContent, ...node.children.flatMap(visible)].filter(Boolean).join(' ');
const detail = {
  target: { login: 'fixture-org' },
  installation: { installation_id: 77, app_id: 123 },
  status: 'active',
  repository_selection: 'selected',
  completeness: 'complete',
  last_success_at: '2026-11-19T09:00:00Z',
  execution_blocked: false,
  projection_version: 4,
  scope_version: 2,
  permissions_version: 1,
  permissions: { contents: 'read' },
  evidence: {
    sender: { login: 'fixture-sender', id: 5 },
    requester: { login: 'fixture-requester', id: 6 },
    approval: { label: 'fixture-approver' },
    history_missing: false,
  },
};

function withRawResponses(locale, onFetch) {
  let seq = 0;
  const page = loadConsole(
    ['static/i18n.js', 'static/app.js', 'static/views.js', 'static/project/fields.js', 'static/settings/lists.js', 'static/settings/installations.js'],
    async (method, path) => {
      const outcome = await onFetch(method, path);
      if (outcome.throwError) throw outcome.throwError;
      if (outcome.syntaxError) return [outcome.status, { __syntaxError: ++seq }];
      return [outcome.status, outcome.json];
    },
  );
  page.run(`
    const __baseFetch = fetch;
    fetch = async (path, init) => {
      const res = await __baseFetch(path, init);
      const origJson = res.json;
      res.json = async () => {
        const data = await origJson();
        if (data && data.__syntaxError) throw new SyntaxError('Unexpected token < in JSON');
        return data;
      };
      return res;
    };
    setLocale(${JSON.stringify(locale)});
    me = { id: 'admin', role: 'super_admin', csrf_token: 'csrf' };
    accounts = [];
    function settingsCard(title) { const s = element('section', '', 'side-card'); s.append(element('h2', title)); return s; }
    function appPermissionCheck() { return element('div', ''); }
  `);
  return page;
}

const englishFailures = [
  { name: 'network', response: { throwError: new TypeError('Failed to fetch') },
    expected: 'Cannot read this installation: the network request failed, try again shortly' },
  { name: 'gateway page on 500', response: { status: 500, syntaxError: true },
    expected: 'Cannot read this installation: the gateway answered 500 · an error page with no reason; try again shortly, and ask an administrator to check the service log if it keeps happening' },
  { name: 'unreadable body on 200', response: { status: 200, syntaxError: true },
    expected: 'Cannot read this installation: the service answered 200 · content the console could not read; refresh the page and try again' },
  { name: 'permission change', response: { status: 409, json: { error: 'authorization_changed' } },
    expected: 'Cannot read this installation: your permissions changed; refresh the page and retry with your current permissions' },
  { name: 'unknown code', response: { status: 500, json: { error: 'internal' } },
    expected: 'Cannot read this installation: the service answered 500 · internal' },
  { name: 'prose code', response: { status: 500, json: { error: '服务暂时不可用，请联系管理员' } },
    expected: 'Cannot read this installation: the service answered 500 · —' },
  { name: 'missing code', response: { status: 500, json: {} },
    expected: 'Cannot read this installation: the service answered 500 · —' },
];

test('English installation detail read failures stay purely English across every failure kind', async () => {
  for (const failure of englishFailures) {
    const page = withRawResponses('en', () => failure.response);
    const [section] = await page.run(`installationDetail(1, 'github.com/123/77')`);
    const strip = section.querySelector('p.muted');
    assert.ok(strip, `missing error strip for ${failure.name}`);
    assert.equal(strip.textContent, failure.expected, failure.name);
    assert.doesNotMatch(strip.textContent, cjk, `Chinese leaked into English failure (${failure.name}): ${strip.textContent}`);
  }
});

test('English installation re-sync failure uses dictionary wording with no Chinese', async () => {
  const page = withRawResponses('en', (method, path) => {
    if (method === 'POST') return { status: 500, json: { error: 'internal' } };
    if (path.endsWith('/repositories')) return { status: 200, json: { repositories: [] } };
    if (path.endsWith('/events')) return { status: 200, json: { events: [] } };
    return { status: 200, json: { installation: detail } };
  });
  const [section] = await page.run(`installationDetail(1, 'github.com/123/77')`);
  const sync = section.querySelectorAll('button').find(btn => btn.textContent === 'Re-sync');
  assert.ok(sync, 'expected Re-sync button');
  await sync.listeners.click[0]();
  const strip = section.querySelector('p.view-error');
  assert.ok(strip, 'expected view-error strip after failed re-sync');
  assert.equal(strip.textContent, 'Re-sync failed: the service answered 500 · internal');
  assert.doesNotMatch(strip.textContent, cjk);
});

const chineseFailures = [
  { name: 'network', response: { throwError: new TypeError('Failed to fetch') },
    expected: '读不到这条安装：网络连接失败，请稍后重试' },
  { name: 'gateway page on 500', response: { status: 500, syntaxError: true },
    expected: '读不到这条安装：500 · 入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。' },
  { name: 'unreadable body on 200', response: { status: 200, syntaxError: true },
    expected: '读不到这条安装：200 · 服务返回了无法识别的内容，请刷新页面后重试。' },
  { name: 'prose code', response: { status: 500, json: { error: '服务暂时不可用，请联系管理员' } },
    expected: '读不到这条安装：500 · —' },
  { name: 'missing code', response: { status: 500, json: {} },
    expected: '读不到这条安装：500 · —' },
];

test('Chinese installation detail read and re-sync failures preserve exact wording and replace non-code prose with em dash', async () => {
  for (const failure of chineseFailures) {
    const page = withRawResponses('zh-CN', () => failure.response);
    const [section] = await page.run(`installationDetail(1, 'github.com/123/77')`);
    const strip = section.querySelector('p.muted');
    assert.ok(strip, `missing error strip for ${failure.name}`);
    assert.equal(strip.textContent, failure.expected, failure.name);
  }
  const page = withRawResponses('zh-CN', (method, path) => {
    if (method === 'POST') return { status: 500, json: { error: 'internal' } };
    if (path.endsWith('/repositories')) return { status: 200, json: { repositories: [] } };
    if (path.endsWith('/events')) return { status: 200, json: { events: [] } };
    return { status: 200, json: { installation: detail } };
  });
  const [section] = await page.run(`installationDetail(1, 'github.com/123/77')`);
  const sync = section.querySelectorAll('button').find(btn => btn.textContent === '重新同步');
  assert.ok(sync, `expected 重新同步 button in ${visible(section)}`);
  await sync.listeners.click[0]();
  const strip = section.querySelector('p.view-error');
  assert.ok(strip, 'expected view-error strip');
  assert.equal(strip.textContent, '重新同步失败：500 · internal');
});
