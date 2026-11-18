import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #691: the console showed the same kind of timestamp three ways — the shared clock ("2026-11-18 09:03:00"),
// zh-CN medium ("2026年11月18日 09:03:00") and the browser's own language ("11/18/2026, 9:03:00 AM" in en-US).
// The issue asks for one reading across pages, so every clock uses the shared helpers in static/app/boot.js and
// no page formats a time with the browser locale any more. This guard scans the shipped sources: a page that
// reintroduces toLocaleString() for a time, a local formatter or a 12-hour clock fails here.
const STATIC = new URL('../../../static/', import.meta.url);
const source = file => readFileSync(new URL(file, STATIC), 'utf8');

// Files that render a clock. boot.js carries the shared helpers; the rest are the pages with a time row.
// Deliberately not here: the zh-CN thousand separators in costs.js, metrics.js, settings/page.js:160 and
// storage-overview.js (numbers, not clocks) and the timezone-name lookups in costs.js and manager.js (a zone name is
// not a time reading). The rules below only judge the rows that print a time.
const FILES = ['app/boot.js', 'knowledge.js', 'channels/feishu-page.js', 'channels/transfer.js',
  'project/model-address.js', 'project/model-catalog.js', 'schedules.js', 'channels/schedules.js',
  'settings/page.js', 'subscriptions.js', 'schedule-records.js'];

// One row per displayed time (file:line in the issue's list): a token unique to that row, and the helper it must call.
// Rows that keep a zone suffix call timestampAt(value, zone); the rest call timestamp(value).
// One row per displayed time (file:line in the issue's list): the token on that row, and the exact call the row makes.
// The call is matched with its arguments, so a row cannot pass by having the helper mentioned somewhere else.
const ROWS = [
  ['knowledge.js', 'function metadata(file)', /timeText\(file\.created_at, '时间未提供'\)/],
  ['channels/feishu-page.js', '有效期', /timeText\(p\.expires_at\)/],
  ['channels/transfer.js', 'messages.append(facts', /timestamp\(m\.created_at\)/],
  ['channels/transfer.js', '最后收到事件', /timestamp\(c\.health\.last_received_at\)/],
  ['channels/transfer.js', '未知发送者', /timestamp\(m\.created_at\)/],
  ['project/model-address.js', '目录匹配不唯一', /timeText\(match\.fetched_at\)/],
  ['project/model-catalog.js', '快照：', /timeText\(status\.fetched_at\)/],
  ['project/model-catalog.js', '当前：', /timeText\(match\.fetched_at\)/],
  ['schedules.js', '迁移时间', /timestamp\(m\.created_at\)/],
  ['schedules.js', '无记录', /stamped\(value,zone\)/],
  ['channels/schedules.js', 'scheduleTime', /timestampAt\(at, zone\) \|\|/],
  ['settings/page.js', 'state.last_pass ?', /timeText\(state\.last_pass\.finished_at\)/],
  ['settings/page.js', 'const time = value =>', /timeText\(value\)/],
  ['settings/page.js', 'phase.finished_at', /timeText\(phase\.finished_at\)/],
  ['subscriptions.js', '未安排发送', /stamped\(value,result\.timezone\)/],
  ['subscriptions.js', 'model.lastReadRevision=value.revision', /timestamp\(new Date\(\)\)/],
  ['schedule-records.js', 'const at = (value, zone', /stamped\(value, zone\)/],
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

// What a page may not do with a clock. Kept as one function so the same rule can be exercised on synthetic shapes,
// which is what proves it is a rule and not "any Intl call passes".
function clockProblems(text) {
  const problems = [];
  const ban = (pattern, why) => { if (pattern.test(text)) problems.push(why); };
  ban(/new Date\([^)]*\)\.toLocaleString\(/, 'toLocaleString()');
  ban(/\.toLocaleTimeString\(/, 'toLocaleTimeString()');
  ban(/\.toLocaleDateString\(/, 'toLocaleDateString()');
  ban(/\bhour12\s*:/, 'hour12');
  ban(/\b(?:dateStyle|timeStyle)\s*:/, 'dateStyle/timeStyle');
  for (const call of intlCalls(text)) {
    // The one allowed shape: this same call names its zone and pins a 24-hour clock.
    if (!/timeZone\s*:/.test(call)) problems.push('Intl.DateTimeFormat without timeZone');
    if (!/hourCycle\s*:\s*['"]h23['"]/.test(call)) problems.push("Intl.DateTimeFormat without hourCycle 'h23'");
  }
  return problems;
}

test('no console page formats a displayed time with the browser locale or a 12-hour clock', () => {
  for (const file of FILES) {
    const problems = clockProblems(source(file));
    assert.deepEqual(problems, [], `${file}: ${problems.join(', ')}`);
  }
});

test('the clock rule rejects every browser-language shape and accepts only the explicit-zone one', () => {
  assert.deepEqual(clockProblems("new Date(value).toLocaleString()"), ['toLocaleString()']);
  assert.deepEqual(clockProblems("new Date(value).toLocaleTimeString()"), ['toLocaleTimeString()']);
  assert.deepEqual(clockProblems('new Intl.DateTimeFormat("zh-CN",{hour12:true,timeZone:"UTC"})'), ['hour12', 'Intl.DateTimeFormat without hourCycle \'h23\'']);
  assert.deepEqual(clockProblems('new Intl.DateTimeFormat("zh-CN",{hourCycle:"h12",timeZone:"UTC"})'), ["Intl.DateTimeFormat without hourCycle 'h23'"]);
  assert.deepEqual(clockProblems('new Intl.DateTimeFormat("zh-CN",{hourCycle:"h23"})'), ['Intl.DateTimeFormat without timeZone']);
  assert.deepEqual(clockProblems("new Intl.DateTimeFormat('en-CA',{timeZone:zone,hourCycle:'h23'})"), []);
});

test('every displayed time calls the shared clock helper, and knowledge uses it instead of a local one', () => {
  const lines = file => source(file).split('\n').map((line, index) => ({ line, number: index + 1 }));
  for (const [file, token, call] of ROWS) {
    // A row can wrap over a few lines (schedule-records' at()), so the exact call is looked for from the row it starts on.
    const all = lines(file), start = all.findIndex(({ line }) => line.includes(token));
    assert.ok(start >= 0, `${file} no longer has the row "${token}"`);
    const nearby = all.slice(start, start + 6).map(({ line }) => line).join('\n');
    assert.match(nearby, call, `${file}: "${token}" must call ${call} (row ${all[start].number})`);
  }
  // knowledge.js used to shadow the shared clock with a local one; that shadow is what kept its page at the browser locale.
  assert.doesNotMatch(source('knowledge.js'), /\b(?:const|let|var)\s+timestamp\s*=/, 'knowledge.js shadows the shared clock');
  assert.doesNotMatch(source('knowledge.js'), /function\s+timestamp\s*\(/, 'knowledge.js shadows the shared clock');
  // The zone-aware helper lives next to the shared clock, so a page with a " · zone" suffix keeps rendering that zone.
  const boot = source('app/boot.js'), start = boot.indexOf('function timestampAt');
  assert.ok(start >= 0, 'app/boot.js must define timestampAt(value, zone)');
  const definition = boot.slice(start, start + 400);
  assert.match(definition, /timeZone\s*:/, 'timestampAt must pass a timeZone');
  assert.match(definition, /hourCycle\s*:\s*['"]h23['"]/, "timestampAt must pin hourCycle 'h23'");
});

// #691 review: an unreadable time used to be rendered by Intl.format, which threw and let each row show its own
// fallback. timestampAt() returns '' for a bad value, so a row that appends ' · zone' unconditionally printed a bare
// suffix. The shared contract is: an unreadable value gets its own text, never a zone with no reading in front of it.
test('an unreadable time gets its own text instead of a bare zone suffix', () => {
  const page = loadConsole(['static/app.js', 'static/channels/schedules.js'], () => [404, {}]);
  assert.equal(page.run("timestampAt('not-a-date','UTC')"), '');
  assert.equal(page.run("stamped('not-a-date','UTC')"), '时间或时区无法识别');
  assert.equal(page.run("stamped(null,'UTC')"), '时间或时区无法识别');
  assert.equal(page.run("timeText('not-a-date','时间未提供')"), '时间或时区无法识别');
  assert.equal(page.run("timeText(null,'时间未提供')"), '时间未提供');
  assert.equal(page.run("timeText('','时间未提供')"), '时间未提供');
  assert.equal(page.run("timeText('2026-11-18T09:03:00Z','时间未提供')"), '2026-11-18 09:03:00');
  // The shared clock keeps its own meaning of an empty reading, because many other rows slice it.
  assert.equal(page.run("timestamp('not-a-date')"), '');
  assert.equal(page.run("stamped('2026-11-18T09:03:00Z','UTC')"), '2026-11-18 09:03:00 · UTC');
  assert.equal(page.run("scheduleTime('not-a-date','Asia/Shanghai')"), '时间或时区无法识别');
  assert.equal(page.run("scheduleTime('2026-11-18T09:03:00Z','Asia/Shanghai')"), '2026-11-18 17:03:00');
});
