import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #1403: a delivery body kept in its own file can be unreadable (gone, damaged, or briefly unreadable). The raw section
// names the reason, so it never looks like a body the retention cleanup emptied.
const scripts = ['static/app/states.js', 'static/app/state.js', 'static/app/api.js', 'static/app/addresses.js', 'static/views/status-text.js',
  'static/views/widgets.js', 'static/app/boot.js', 'static/app/delivery.js'];
const textOf = node => [node.textContent, ...node.children.flatMap(textOf)].join(' ');
const event = extra => ({ id: 'd1', delivery_id: 'gh-1', event: 'pull_request', route: 'pull_request.opened', status: 'accepted', http_status: 200,
  received_at: '2026-11-26T08:00:00.000Z', request_headers: {}, payload: '', response: {}, processing_result: 'not_trigger', tasks: [], dispatch: [],
  reception: { accepted: true, code: 'accepted', http_status: 200, body_complete: true, received_at: '2026-11-26T08:00:00.000Z' },
  signature: { state: 'verified', reason: null }, source: { reference: 'deliveries:d1', record_id: 'd1', delivery_id: 'gh-1', event: 'pull_request' }, ...extra });

test('the raw section says why a body file cannot be shown, and says nothing for a readable body', () => {
  const page = loadConsole(scripts, async () => [200, {}]);
  const raw = value => page.run(`deliveryDetail(${JSON.stringify({ event: value })})`).find(node => node.className?.includes('raw-payload'));
  assert.match(textOf(raw(event({ payload_unreadable: 'delivery_body_corrupt' }))), /正文文件与归档时记录的校验值不一致，已拒绝显示。/);
  assert.match(textOf(raw(event({ payload_unreadable: 'delivery_body_missing' }))), /正文文件已不存在/);
  assert.match(textOf(raw(event({ payload_unreadable: 'delivery_body_other' }))), /正文文件读取失败（delivery_body_other）/);
  assert.doesNotMatch(textOf(raw(event({ payload: '{"action":"opened"}' }))), /正文文件/);
});
