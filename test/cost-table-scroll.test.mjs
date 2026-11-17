import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #904: the box that scrolls is the thing a screen reader has to hear and the keyboard has to reach. The role and the
// name are set where the table is built; the Tab stop is a measurement of the box, so a stand-in DOM without layout must
// show no `tabindex` at all — that is what keeps a table that fits out of the Tab sequence.
const text = node => [node.textContent, ...node.children.flatMap(text)].join(' ');

const costsData = {
  from: '2026-11-03', to: '2026-11-03', currency: 'USD', collection_started_at: null,
  summary: { cost: 2, requests: 1, unpriced_requests: 0, usage_missing_requests: 0, input_tokens: 1000, output_tokens: 100, cached_input_tokens: 0 },
  prices: [{ model_name: 'fixture-model', currency: 'USD', input_per_million: 2, output_per_million: 10, cache_per_million: 0 }],
  days: [{ date: '2026-11-03', repository_id: '101', full_name: 'fixture/project-101', cost: 2, requests: 1, unpriced_requests: 0, input_tokens: 1000, output_tokens: 100, cached_input_tokens: 0 }],
  tasks: { summary: [{ kind: 'review.issue', count: 1, runtime_ms: 1000, incomplete_tasks: 0, running_tasks: 0 }], days: [{ date: '2026-11-03', kind: 'review.issue', count: 1, runtime_ms: 1000, incomplete_tasks: 0, running_tasks: 0 }], undated: [] },
};

const storageView = () => ({
  refreshed_at: '2026-11-15T08:00:00.000Z', alerts: [], projects: [{ repository_id: '101', name: 'fixture/project-101', files: { count: 1, bytes: 10 }, records: {}, blobs: { count: 0, bytes: 0 }, open: { count: 0, bytes: 0 }, manager: null,
    computer: { total_bytes: 100, complete: true, scanned_at: '2026-11-15T08:00:00.000Z' } }],
});

const namedScrollBoxes = panel => panel.querySelectorAll('.cost-table-scroll').map(node => ({
  role: node.getAttribute('role'), name: node.getAttribute('aria-label'), tabindex: node.getAttribute('tabindex'),
}));

test('every cost table is a named group, and no table takes a Tab stop without a measured overflow', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/metrics.js', 'static/project.js', 'static/costs.js'], () => [200, costsData]);
  page.run("me={id:'admin'};tab='costs';costState={from:'2026-11-03',to:'2026-11-03',currency:'USD'};document.createTextNode=text=>element('span',text);costChart=()=>{};");
  await page.run('loadCosts(0)');
  const boxes = namedScrollBoxes(page.$('cost-body'));
  assert.ok(boxes.length >= 3, 'the page draws its price, project and daily tables');
  for (const box of boxes) {
    assert.equal(box.role, 'group', 'a scroll box is a group, so its name is allowed');
    assert.match(box.name, /^表格：/, 'a scroll box says what it holds');
    assert.equal(box.tabindex, null, 'without layout nothing overflows, so nothing takes a Tab stop');
  }
  // The name is the columns of that table, not a shared label across all of them.
  assert.ok(boxes.some(box => /模型/.test(box.name)), 'the price table is named after its own columns');
  assert.ok(new Set(boxes.map(box => box.name)).size > 1, 'each table is named after its own columns');
});

test('the storage tables are named groups too, and the fit tables take no Tab stop', async () => {
  const view = storageView();
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/costs.js', 'static/project.js', 'static/settings.js'], (method, path) => {
    if (method === 'GET' && path === '/api/storage') return [200, view];
    throw new Error('Unexpected request: ' + method + ' ' + path);
  });
  page.run("me = { role: 'administrator', repositories: ['101'], csrf_token: 'csrf' }; location.hash = '#/settings/storage';");
  await page.run('renderSettings(renderVersion)');
  const panel = page.$('settings-panel');
  const boxes = namedScrollBoxes(panel);
  assert.ok(boxes.length > 0, 'the storage page draws its tables');
  for (const box of boxes) {
    assert.equal(box.role, 'group');
    assert.match(box.name, /^表格：/);
    assert.equal(box.tabindex, null);
  }
  assert.match(text(panel), /按项目/, 'the per-project table is the one that scrolls at 390');
});
