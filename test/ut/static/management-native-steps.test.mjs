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
