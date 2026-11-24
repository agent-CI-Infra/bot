import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #355: a failed management call says why in words, not only in the server's code. The sentences are the ones the receipt
// page already uses (static/management/receipts.js); a code the console cannot explain keeps its bare value.
async function failureNotices(turns) {
  const at = '2026-11-24T08:00:00.000Z', conversation = { id: 'c1', scope: 'project:101', title: '会话', created_at: at, last_activity_at: at };
  const messages = turns.map((_, index) => ({ id: 'm' + index, state: 'completed', input: { content: '请求 ' + index }, created_at: at, updated_at: at }));
  let sequence = 0;
  const events = turns.flatMap((rows, index) => rows.map(([type, data = {}]) => ({ sequence: ++sequence, message_id: 'm' + index, type, data, created_at: at })));
  const console = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/management.js'], (_, path) => {
    if (path === '/api/management/query') return [200, { projects: [{ id: '101', full_name: 'acme/alpha', enabled: true, configuration_gaps: [] }], pending_repositories: [] }];
    if (path === '/api/management/conversations') return [200, { conversations: [conversation] }];
    if (path === '/api/management/conversations/c1/events?after=0') return [200, { conversation, messages, events, has_more: false, title_pending: false }];
    return [404, { error: 'not_found' }];
  });
  console.run(`me = { id: 'u1', csrf_token: 'csrf' }; var getSelection = () => null;
    var panel = Object.assign(document.createElement('section'), { isConnected: true }), view = renderManagement(panel, '101');`);
  await console.run('view');
  for (let tries = 0; !console.run(`panel.querySelector('.management-status').textContent`).startsWith('就绪'); tries++) {
    assert.ok(tries < 50, 'the conversation history is read');
    await new Promise(resolve => setImmediate(resolve));
  }
  return JSON.parse(console.run(`JSON.stringify(panel.querySelectorAll('.management-run-notice').map(note => note.textContent))`));
}

const call = name => ['tool_call', { call_id: 'b1', name, arguments: { operation: 'manager.update' } }];

test('a known failure code is explained in words and keeps its code as secondary text', async () => {
  const [notice] = await failureNotices([[['model_start', { turn: 0 }], call('management_command'),
    ['tool_error', { call_id: 'b1', name: 'management_command', error: 'management_revision_conflict' }], ['done']]]);
  assert.equal(notice, '操作未完成：提交之后项目配置的版本变了，命令没有执行；先读回当前配置再提交。（management_revision_conflict）');
});

test('a code the console cannot explain keeps its bare value, not a guess', async () => {
  const [notice] = await failureNotices([[['model_start', { turn: 0 }], call('management_command'),
    ['tool_error', { call_id: 'b1', name: 'management_command', error: 'future_server_code' }], ['done']]]);
  assert.equal(notice, '操作未完成：future_server_code');
});

test('a finished turn that failed on a known code does not send the reader to the model and permission settings', async () => {
  const [notice] = await failureNotices([[['model_start', { turn: 0 }], ['error', { error: 'authorization_changed' }]]]);
  assert.equal(notice, '这次处理未完成：发起人的权限在命令提交之后变了，命令没有执行。');
});
