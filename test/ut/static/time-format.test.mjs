import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #691: the console showed the same kind of timestamp three ways — the shared clock ("2026-11-18 09:03:00"),
// zh-CN medium ("2026年11月18日 09:03:00") and the browser's own language ("11/18/2026, 9:03:00 AM" in en-US).
// The issue asks for one reading across pages, so every clock uses the shared helpers in static/app/boot.js and
// no page formats a time with the browser locale any more. This guard scans the shipped sources: a page that
// reintroduces toLocaleString() for a time, a local formatter or a 12-hour clock fails here.
const STATIC = new URL('../../../static/', import.meta.url);
const source = file => readFileSync(new URL(file, STATIC), 'utf8');

// Files that render a clock. boot.js carries the shared helpers; the rest are the pages with a time row.
const FILES = ['app/boot.js', 'knowledge.js', 'channels/feishu-page.js', 'channels/transfer.js',
  'project/model-address.js', 'project/model-catalog.js', 'schedules.js', 'channels/schedules.js',
  'settings/page.js', 'subscriptions.js', 'schedule-records.js'];

// One row per displayed time (file:line in the issue's list): a token unique to that row, and the helper it must call.
// Rows that keep a zone suffix call timestampAt(value, zone); the rest call timestamp(value).
const ROWS = [
  ['knowledge.js', '时间未提供', 'timestamp'],
  ['channels/feishu-page.js', '有效期', 'timestamp'],
  ['channels/transfer.js', 'messages.append(facts', 'timestamp'],
  ['channels/transfer.js', '最后收到事件', 'timestamp'],
  ['channels/transfer.js', '未知发送者', 'timestamp'],
  ['project/model-address.js', '目录匹配不唯一', 'timestamp'],
  ['project/model-catalog.js', '快照：', 'timestamp'],
  ['project/model-catalog.js', '当前：', 'timestamp'],
  ['schedules.js', '迁移时间', 'timestamp'],
  ['schedules.js', '无记录', 'timestampAt'],
  ['channels/schedules.js', 'scheduleTime', 'timestampAt'],
  ['settings/page.js', 'state.last_pass ?', 'timestamp'],
  ['settings/page.js', 'const time = value =>', 'timestamp'],
  ['settings/page.js', 'phase.finished_at', 'timestamp'],
  ['subscriptions.js', '未安排发送', 'timestampAt'],
  ['subscriptions.js', 'model.lastReadRevision=value.revision', 'timestamp'],
  ['schedule-records.js', 'const at = (value, zone', 'timestampAt'],
];

// Every new Intl.DateTimeFormat(...) call in the text, with its own parentheses balanced, so the rule can read the
// options it was given rather than guessing from one line.
function intlCalls(text) {
  const calls = [];
  for (let start = text.indexOf('new Intl.DateTimeFormat('); start >= 0; start = text.indexOf('new Intl.DateTimeFormat(', start + 1)) {
    let depth = 0, end = text.indexOf('(', start);
    for (; end < text.length; end += 1) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')') { depth -= 1; if (depth === 0) break; }
    }
    calls.push(text.slice(start, end + 1));
  }
  return calls;
}

test('no console page formats a displayed time with the browser locale or a 12-hour clock', () => {
  for (const file of FILES) {
    const text = source(file);
    assert.doesNotMatch(text, /new Date\([^)]*\)\.toLocaleString\(/, `${file} formats a time with toLocaleString()`);
    assert.doesNotMatch(text, /\.toLocaleTimeString\(/, `${file} formats a time with toLocaleTimeString()`);
    assert.doesNotMatch(text, /\.toLocaleDateString\(/, `${file} formats a date with toLocaleDateString()`);
    assert.doesNotMatch(text, /\bhour12\s*:/, `${file} picks a 12/24-hour clock`);
    assert.doesNotMatch(text, /\b(?:dateStyle|timeStyle)\s*:/, `${file} formats a time with dateStyle/timeStyle`);
    // Intl is allowed only where the call names its zone and pins a 24-hour clock; a call without them is the
    // browser-language clock this issue is about.
    for (const call of intlCalls(text)) {
      assert.match(call, /timeZone\s*:/, `${file} formats a time without naming its zone: ${call.slice(0, 80)}`);
      assert.match(call, /hourCycle\s*:\s*'h23'/, `${file} formats a time without hourCycle 'h23': ${call.slice(0, 80)}`);
    }
  }
});

test('every displayed time calls the shared clock helper, and knowledge uses it instead of a local one', () => {
  const lines = file => source(file).split('\n').map((line, index) => ({ line, number: index + 1 }));
  for (const [file, token, helper] of ROWS) {
    // A row can wrap over a few lines (schedule-records' at()), so the helper is looked for in the row and just after it.
    const all = lines(file), start = all.findIndex(({ line }) => line.includes(token));
    assert.ok(start >= 0, `${file} no longer has the row "${token}"`);
    const nearby = all.slice(start, start + 5);
    assert.ok(nearby.some(({ line }) => line.includes(helper + '(')),
      `${file}: "${token}" must call ${helper}() (row ${all[start].number})`);
  }
  // knowledge.js used to shadow the shared clock with a local one; that shadow is what kept its page at the browser locale.
  assert.doesNotMatch(source('knowledge.js'), /\b(?:const|let|var)\s+timestamp\s*=/, 'knowledge.js shadows the shared clock');
  assert.doesNotMatch(source('knowledge.js'), /function\s+timestamp\s*\(/, 'knowledge.js shadows the shared clock');
  // The zone-aware helper lives next to the shared clock, so a page with a " · zone" suffix keeps rendering that zone.
  const boot = source('app/boot.js'), start = boot.indexOf('function timestampAt');
  assert.ok(start >= 0, 'app/boot.js must define timestampAt(value, zone)');
  const definition = boot.slice(start, start + 400);
  assert.match(definition, /timeZone\s*:/, 'timestampAt must pass a timeZone');
  assert.match(definition, /hourCycle\s*:\s*'h23'/, "timestampAt must pin hourCycle 'h23'");
});
