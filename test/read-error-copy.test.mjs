import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConsole} from './console-page.mjs';

// #800: a read that fails because the network is gone showed the browser's own English text on the page
// ("Failed to fetch" in Chrome, "NetworkError when attempting to fetch resource." in Firefox, "Load failed" in
// Safari), because read cards interpolate err.message directly. Every read card now goes through one helper, so the
// failure is told in the page's language and the raw browser text never reaches the screen.
const text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');
const click = node => node.listeners.click[0]({ currentTarget: node });
const network = () => new TypeError('Failed to fetch');
const costData = { from: '2026-10-22', to: '2026-10-23', currency: 'USD', collection_started_at: null,
  summary: { cost: 0, requests: 0, unpriced_requests: 0, usage_missing_requests: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }, prices: [], days: [] };

function costsPage(respond) {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/metrics.js', 'static/costs.js'], respond);
  page.run("me={id:'admin'};tab='costs';costState={from:'2026-10-22',to:'2026-10-23',currency:'USD'};document.createTextNode=text=>element('span',text);");
  return page;
}

test('a costs read that fails on the network says so in Chinese, keeps the warning and the retry', async () => {
  let offline = true;
  const page = costsPage((method, path) => { if (offline) throw network(); return [200, costData]; });
  await page.run('loadCosts(0)');
  const body = page.$('cost-body'), shown = text(body);
  assert.ok(!shown.includes('Failed to fetch'), `the browser's English never reaches the page: ${shown}`);
  assert.ok(shown.includes('网络连接失败，请稍后重试。'), shown);
  assert.ok(shown.includes('这不是空结果'), 'the failure still says the range is unknown, not empty');
  assert.equal(body.querySelector('[data-testid=console-state-error]').getAttribute('role'), 'alert');
  const retry = body.querySelectorAll('button').find(node => node.textContent === '重新加载');
  assert.ok(retry, 'the retry button survives');
  offline = false;
  await click(retry);
  assert.ok(!text(page.$('cost-body')).includes('统计未能读取'), 'a successful retry clears the card');
});

test('a cancelled read is not reported as a network failure', async () => {
  const page = costsPage(() => { throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }); });
  await page.run('loadCosts(0)');
  const shown = text(page.$('cost-body'));
  assert.ok(!shown.includes('Failed to fetch'), shown);
  assert.ok(!shown.includes('网络连接失败'), `a page switch cancels reads on purpose: ${shown}`);
});

test('an HTTP error keeps its own message', async () => {
  const page = costsPage(() => { throw Object.assign(new Error('502 · gateway_error'), { status: 502, code: 'gateway_error' }); });
  await page.run('loadCosts(0)');
  const shown = text(page.$('cost-body'));
  assert.ok(shown.includes('502 · gateway_error'), shown);
  assert.ok(!shown.includes('网络连接失败'), 'an answered request is not a network failure');
});
