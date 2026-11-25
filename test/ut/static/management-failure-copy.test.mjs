import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #355: a failed management call says why in words, not only in the server's code. A failed command reuses the sentences
// the receipt page already uses (static/management/receipts.js `managementFailureHints`), because those sentences describe
// a command that was submitted. A turn that stopped before submitting anything uses the access sentences instead, so it
// never claims a command was submitted. A code the console cannot explain keeps its bare value.
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
  assert.equal(notice, '这次处理未完成：权限已变化，请刷新页面后按当前权限重试。');
});

test('a turn-level known command code names the code and points at the failed step, not the model settings', async () => {
  const [notice] = await failureNotices([[['model_start', { turn: 0 }], ['error', { error: 'management_revision_conflict' }]]]);
  assert.equal(notice, '这次处理未完成：management_revision_conflict。请在执行进展里核对失败的那一步。');
});

test('a code the console does not know at turn level keeps the settings advice', async () => {
  const [notice] = await failureNotices([[['model_start', { turn: 0 }], ['error', { error: 'future_server_code' }]]]);
  assert.equal(notice, '这次处理未完成：future_server_code。可以检查管理助手的模型与权限配置后继续。');
});

test('a post-execution guard error does not claim the command did not run', async () => {
  const [notice] = await failureNotices([[['model_start', { turn: 0 }], call('management_command'),
    ['tool_error', { call_id: 'b1', name: 'management_command', error: 'authorization_changed' }], ['done']]]);
  assert.equal(notice, '操作未完成：权限在执行过程中变了，这一步可能已经生效，请在回执与执行进展里核对后再重试。（authorization_changed）');
});

test('a receipt sentence is not used for a tool that is not a management command', async () => {
  const [notice] = await failureNotices([[['model_start', { turn: 0 }], call('github_write'),
    ['tool_error', { call_id: 'b1', name: 'github_write', error: 'management_tool_failed' }], ['done']]]);
  assert.equal(notice, '操作未完成：management_tool_failed');
});
