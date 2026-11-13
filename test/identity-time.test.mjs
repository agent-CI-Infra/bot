import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

function page() {
  return loadConsole(['static/app.js', 'static/identity.js'], () => [200, {}]);
}

function zoneLabel() {
  const offset = -new Date().getTimezoneOffset(), sign = offset >= 0 ? '+' : '-', abs = Math.abs(offset);
  const hours = Math.floor(abs / 60), minutes = abs % 60;
  return minutes ? `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}` : `UTC${sign}${hours}`;
}

test('identity times name the browser time zone and do not look like unlabeled UTC', () => {
  const console = page(), now = Date.now(), zone = zoneLabel();
  const text = console.run(`identityTime(${now})`);
  assert.match(text, new RegExp(`（${zone.replace('+', '\\+')}）$`));
  assert.equal(console.run(`identityTimezoneLabel(new Date(${now}))`), zone);
  // Local getters, not UTC: in a zone east of UTC the hour must differ from getUTCHours unless it is a whole-day offset of 0.
  const date = new Date(now);
  const formattedHour = Number((/ (\d{2}):/.exec(text) || [])[1]);
  assert.equal(formattedHour, date.getHours());
});

test('grant expiry is written as remaining minutes, then the absolute time with a zone', () => {
  const console = page(), zone = zoneLabel();
  const remaining = console.run(`identityExpiry(Date.now() + 4 * 60_000 + 500)`);
  assert.match(remaining, /^还剩 5 分钟（/);
  assert.match(remaining, new RegExp(`（.+（${zone.replace('+', '\\+')}））$`));
  const hour = console.run(`identityExpiry(Date.now() + 2 * 60 * 60_000 + 3 * 60_000)`);
  assert.match(hour, /^还剩 2 小时 3 分钟（/);
  const expired = console.run(`identityExpiry(Date.now() - 1)`);
  assert.match(expired, /^已过期（/);
  assert.equal(console.run('identityExpiry(null)'), '未知');
});
