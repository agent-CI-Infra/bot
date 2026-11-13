import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { harness } from './helpers.mjs';

function messages() {
  const src = readFileSync(new URL('../static/i18n.js', import.meta.url), 'utf8');
  const start = src.indexOf('const i18nMessages = ');
  const end = src.indexOf('\nlet i18nLocale');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = createContext({});
  runInContext(src.slice(start, end) + '\nthis.messages = i18nMessages;', context);
  return context.messages;
}

function loadI18n() {
  const context = createContext({ console });
  runInContext(readFileSync(new URL('../static/i18n.js', import.meta.url), 'utf8'), context, { filename: 'i18n.js' });
  return context;
}

function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
}

test('zh-CN and en dictionaries have the same keys and placeholders', () => {
  const all = messages(), zh = all['zh-CN'], en = all.en;
  assert.ok(zh && en);
  const zhKeys = Object.keys(zh).sort(), enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys);
  assert.ok(zhKeys.length > 50, 'dictionaries should cover login, identity, and chrome');
  for (const key of zhKeys) {
    assert.notEqual(String(zh[key]).trim(), '', key);
    assert.notEqual(String(en[key]).trim(), '', key);
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), key);
  }
});

test('resolveLocale prefers user choice, then stored preference, then the browser, then zh-CN', () => {
  const i18n = loadI18n();
  assert.equal(i18n.resolveLocale({ choice: 'en', stored: 'zh-CN', browser: 'zh-CN' }), 'en');
  assert.equal(i18n.resolveLocale({ choice: 'zh-CN', stored: 'en', browser: 'en-US' }), 'zh-CN');
  assert.equal(i18n.resolveLocale({ stored: 'en', browser: 'zh-CN' }), 'en');
  assert.equal(i18n.resolveLocale({ stored: 'en-GB', browser: 'de-DE' }), 'en');
  assert.equal(i18n.resolveLocale({ browser: 'en-US' }), 'en');
  assert.equal(i18n.resolveLocale({ browser: 'zh-TW' }), 'zh-CN');
  assert.equal(i18n.resolveLocale({ browser: 'zh' }), 'zh-CN');
  assert.equal(i18n.resolveLocale({ browser: 'de-DE' }), 'zh-CN');
  assert.equal(i18n.resolveLocale({ choice: 'fr', stored: 'not-a-locale', browser: '' }), 'zh-CN');
  assert.equal(i18n.resolveLocale({}), 'zh-CN');
});

test('t() interpolates placeholders and falls back to zh-CN, then the key', () => {
  const i18n = loadI18n();
  i18n.applyLocale('zh-CN', { persist: false, notify: false });
  assert.equal(i18n.t('login.submit'), '登录');
  assert.equal(i18n.t('identity.grant_count', { count: 3 }), '3 条');
  assert.equal(i18n.t('identity.github.status.connected', { count: 2 }), '已连接 GitHub，可访问 2 个仓库');
  i18n.applyLocale('en', { persist: false, notify: false });
  assert.equal(i18n.t('login.submit'), 'Sign in');
  assert.equal(i18n.t('identity.grant_count', { count: 3 }), '3');
  assert.equal(i18n.t('identity.github.status.connected', { count: 2 }), 'Connected to GitHub, with access to 2 repositories');
  assert.equal(i18n.t('identity.github.status.disconnected'), 'GitHub is not connected');
  assert.equal(i18n.currentLocale(), 'en');
  // A key missing from English would still resolve through the Chinese dictionary.
  const table = messages().en;
  assert.equal(table['no.such.key'], undefined);
  assert.equal(i18n.t('no.such.key'), 'no.such.key');
});

test('the console serves /i18n.js', async (t) => {
  const h = await harness();
  t.after(async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); });
  const response = await fetch(h.admin + '/i18n.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  const body = await response.text();
  assert.match(body, /function t\(/);
  assert.match(body, /'zh-CN'/);
  assert.match(body, /\ben:\s*\{/);
});

test('the console page has no inline script and serves /locale-boot.js', async (t) => {
  const html = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  assert.equal([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].length, 0);
  assert.match(html, /<script src="\/locale-boot\.js"><\/script>/);
  const h = await harness();
  t.after(async () => { await h.stop(); rmSync(h.directory, { recursive: true, force: true }); });
  const boot = await fetch(h.admin + '/locale-boot.js');
  assert.equal(boot.status, 200);
  assert.match(boot.headers.get('content-type'), /^text\/javascript/);
  assert.match(await boot.text(), /launchpad\.locale/);
  const page = await fetch(h.admin + '/');
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const body = await page.text();
  assert.equal([...body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].length, 0);
});
