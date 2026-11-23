import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

const page = () => loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/management.js'], () => [200, {}]);

// A Pi turn's own tools on the computer (#1296) read as what they do, then how they ended and how long they took.
test('native steps say what they do while running and how they ended', () => {
  const console = page();
  assert.equal(console.run(`managementNativeCaption('bash', true)`), '正在电脑上执行');
  assert.equal(console.run(`managementNativeCaption('bash', false)`), '在电脑上执行');
  assert.equal(console.run(`managementNativeCaption('grep', false)`), '在电脑上搜索');
  assert.equal(console.run(`managementNativeCaption('unknown_tool', true)`), '正在电脑上操作');
  assert.equal(console.run(`managementNativeStatus(null, 65000)`), '执行中 · 1 分 5 秒');
  assert.equal(console.run(`managementNativeStatus(null, 400)`), '执行中 · 不到 1 秒');
  assert.equal(console.run(`managementNativeStatus({ state: 'succeeded', duration_ms: 1234 })`), '已完成 · 1.2 秒');
  assert.equal(console.run(`managementNativeStatus({ state: 'failed', exit_code: 3, duration_ms: 2000 })`), '退出码 3 · 2 秒');
  assert.equal(console.run(`managementNativeStatus({ state: 'failed' })`), '失败');
});

test('a running turn tells how long ago it last did something; notices name compaction, restarts and merged steps', () => {
  const console = page();
  assert.equal(console.run(`managementActivity(NaN, 5000)`), '');
  assert.equal(console.run(`managementActivity(10000, 11500)`), '刚刚有活动');
  assert.equal(console.run(`managementActivity(10000, 52000)`), '最近活动 42 秒前');
  assert.equal(console.run(`managementActivity(10000, 135000)`), '最近活动 2 分 5 秒前');
  assert.equal(console.run(`managementActivity(10000, 9000)`), '刚刚有活动', 'a clock behind the server reads as just now');
  assert.equal(console.run(`managementProgressNotice({ notice: 'compacting' })`), '会话内容较长，正在压缩上下文');
  assert.equal(console.run(`managementProgressNotice({ notice: 'restarted' })`), '请求已修改，按修改后的请求重新开始');
  assert.equal(console.run(`managementProgressNotice({ notice: 'skipped', count: 7 })`), '另有 7 个电脑步骤未逐条显示（步骤较密时会合并）');
  assert.equal(console.run(`managementProgressNotice({ notice: 'future_notice' })`), null);
});

// Replays one conversation from its event history and returns, per turn, what its 执行进展 panel shows.
async function replayedTurns(turns) {
  const at = '2026-11-23T08:00:00.000Z', conversation = { id: 'c1', scope: 'project:101', title: '会话', created_at: at, last_activity_at: at };
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
  // The history read runs after the page is drawn; it is done once the status line says the conversation is ready.
  for (let tries = 0; !console.run(`panel.querySelector('.management-status').textContent`).startsWith('就绪'); tries++) {
    assert.ok(tries < 50, 'the conversation history is read');
    await new Promise(resolve => setImmediate(resolve));
  }
  return JSON.parse(console.run(`JSON.stringify(panel.querySelectorAll('.management-turn').map(turn => {
    const progress = turn.querySelector('.management-progress');
    return { hidden: progress.hidden, summary: progress.querySelector('summary').textContent, notes: progress.querySelectorAll('.management-step-note').map(note => note.textContent) };
  }))`));
}

// #1300: a Pi turn with model steps only keeps its notices visible. Live rows and a history replay go through the same
// event handler; this replays history, the case that must also hold after a reload.
test('a turn with notices and no steps shows its notices; a turn with neither keeps the panel hidden; steps still count', async () => {
  const [modelOnly, plain, native, bot] = await replayedTurns([
    [['model_start', { turn: 0 }], ['progress', { notice: 'compacted' }], ['model_start', { turn: 1 }], ['done']],
    [['model_start', { turn: 0 }], ['done']],
    [['model_start', { turn: 0 }], ['tool_call', { native: true, call_id: 'n1', name: 'bash', preview: 'ls' }],
      ['tool_result', { native: true, call_id: 'n1', name: 'bash', result: { state: 'succeeded', duration_ms: 10 } }], ['progress', { notice: 'restarted' }], ['done']],
    [['model_start', { turn: 0 }], ['tool_call', { call_id: 'b1', name: 'management_query', arguments: { operation: 'list_tasks' } }],
      ['tool_result', { call_id: 'b1', name: 'management_query', result: { tasks: [] } }], ['done']],
  ]);
  assert.deepEqual(modelOnly, { hidden: false, summary: '执行进展 · 1 条提示', notes: ['上下文已压缩，继续处理'] });
  assert.equal(plain.hidden, true, 'a turn with no steps and no notices has no panel');
  assert.deepEqual(native, { hidden: false, summary: '执行进展 · 1/1 步完成', notes: ['请求已修改，按修改后的请求重新开始'] });
  assert.deepEqual(bot, { hidden: false, summary: '执行进展 · 1/1 步完成', notes: [] }, 'a turn of bot tools (the Native loop) is unchanged');
});
