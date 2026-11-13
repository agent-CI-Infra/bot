// #224-A / #262: one declaration site for the console theme, and the values the module sheets still read are pinned.
// docs/console-ui.md says modules reference the shared variables and do not copy a second theme. Three things are
// machine-checkable here: `static/shell.css` is the only :root that declares custom properties, every var() a sheet reads
// resolves to something, and a token a module sheet reads through shell.css cannot change value silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const sheets = readdirSync(new URL('static/', root)).filter(name => name.endsWith('.css')).sort();
const shell = read('static/shell.css');
const rootBlocks = text => [...text.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1]);
const names = text => [...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(match => match[1]);
const reads = text => [...text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,?)/g)].map(match => ({ name: match[1], fallback: match[2] === ',' }));
const shellTokens = new Set(rootBlocks(shell).flatMap(names));
// A few layout variables are measured and written by the module's own script (management.js heights); they are declared
// at runtime, not in a stylesheet, so a read of one is not a missing declaration.
const scripts = readdirSync(new URL('static/', root)).filter(name => name.endsWith('.js')).map(name => read('static/' + name)).join('\n');
const runtime = new Set([...scripts.matchAll(/setProperty\(\s*['"](--[a-z0-9-]+)['"]/g)].map(match => match[1]));

test('shell.css is the only sheet that declares custom properties in :root', () => {
  for (const name of sheets) {
    const declared = rootBlocks(read('static/' + name)).flatMap(names);
    if (name === 'shell.css') assert.ok(declared.length > 0, 'shell.css declares the console tokens');
    else assert.deepEqual(declared, [], `${name} must reference the shared tokens, not declare its own :root block`);
  }
});

test('every var() a sheet reads is declared by shell.css, locally, at runtime, or carries its own fallback', () => {
  for (const name of sheets) {
    const text = read('static/' + name);
    const local = new Set(names(text));
    for (const { name: token, fallback } of reads(text)) {
      if (fallback) continue;
      assert.ok(shellTokens.has(token) || local.has(token) || runtime.has(token),
        `${name} reads var(${token}) with no fallback, but neither shell.css, ${name} nor a module script declares it`);
    }
  }
});

// The first two tests prove a declaration exists somewhere; this one proves the resolved value did not change. Pin the
// shell.css value of every token a module sheet reads through the contract, and refuse a new such read until it is pinned.
// Sheets that predate shell.css: a value change in the contract restyles these legacy pages, so their reads are pinned.
const moduleSheets = ['style.css', 'views.css', 'board.css', 'costs.css', 'management.css', 'channel-console.css', 'access.css'];
const SHARED = {
  '--color-surface': '#fff',
  '--color-brand': '#245de0', '--color-text-muted': '#607087', '--font-size-2': '14px', '--control-min': '44px',
  '--color-brand-weak': '#edf2ff',
  '--color-border': '#dce3ed', '--color-surface-alt': '#f8fafc', '--radius-card': '12px',
  '--space-2': '6px', '--space-3': '8px', '--space-4': '12px', '--space-5': '16px', '--space-6': '20px',
  '--font-size-1': '12px', '--font-size-3': '17px', '--font-size-5': '30px', '--radius-3': '6px',
  // #551: style.css (a module sheet) now reads the shared theme end-to-end. Existing
  // values above stay pinned; the new tokens keep the values declared in shell.css.
  '--color-bg': '#f5f7fb', '--color-text': '#17243b', '--color-text-inverse': '#fff',
  '--color-danger': '#ad3039', '--color-danger-bg': '#fbeaea',
  '--color-warning': '#875a0a', '--color-warning-bg': '#fff2d9', '--color-warning-border': '#e9c27a',
  '--color-success': '#24603d', '--color-success-bg': '#e5f2e9',
  '--color-info': '#2c5791', '--color-info-bg': '#e8f0fb',
  // Review of #584: the neutral status badge keeps its own AA-contrast pair and the info
  // alert keeps a visible ring; border and surface tokens are too light for either job.
  '--color-info-border': '#b9cdec', '--color-status-neutral': '#536c78', '--color-status-neutral-bg': '#edf1f4',
  '--color-hover': '#f1f5fb', '--color-overlay': '#16374470',
  '--focus-ring': '#245de0', '--focus-ring-width': '3px',
  '--font-size-4': '18px', '--font-size-micro': '11px', '--font-size-label': '13px',
  '--font-size-row': '15px', '--font-size-touch': '16px', '--font-size-display': '24px',
  '--line-height-body': '1.5', '--line-height-tight': '1.35',
  '--radius-1': '4px', '--radius-2': '5px',
};

test('tokens the module sheets read through shell.css keep their contract value', () => {
  const shellRoot = rootBlocks(shell)[0] ?? '';
  const declared = new Map([...shellRoot.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
  for (const [token, value] of Object.entries(SHARED))
    assert.equal(declared.get(token), value, `shell.css must keep ${token}: ${value} (upstream changes it -> the module sheets restyle silently)`);
  for (const name of moduleSheets) {
    const text = read('static/' + name);
    const local = new Set(names(text));
    for (const { name: token, fallback } of reads(text)) {
      if (SHARED[token] || local.has(token) || runtime.has(token)) continue;
      assert.ok(!shellTokens.has(token),
        `${name} reads var(${token}) through shell.css without a pinned value; add it to SHARED with the value it must keep`);
      assert.ok(fallback, `${name} reads var(${token}) with no fallback and shell.css does not declare it`);
    }
  }
});

// #551: the leftover teal palette in style.css was a second theme. Login, projects and
// identity must read the shared tokens so the same heading / body / muted level looks
// the same on every page. New hard-coded values of those colours are a regression.
const LEGACY_THEME = ['#637c89', '#5b7481', '#52707d', '#183142', '#16636b', '#f3f6f8', '#365564', '#13394b'];

test('#551 style.css and access.css no longer hard-code the leftover teal theme', () => {
  for (const name of ['style.css', 'access.css']) {
    const source = read('static/' + name);
    for (const colour of LEGACY_THEME) {
      assert.equal(source.toLowerCase().includes(colour), false,
        `${name} still hard-codes leftover theme colour ${colour}`);
    }
  }
});

test('#551 page body, muted text and heading sizes in style.css and access.css use tokens', () => {
  const style = read('static/style.css');
  assert.match(style, /:root\{[^}]*color:\s*var\(--color-text\)/);
  assert.match(style, /:root\{[^}]*background:\s*var\(--color-bg\)/);
  assert.match(style, /\.muted\{[^}]*color:\s*var\(--color-text-muted\)/);
  assert.match(style, /h1\{font-size:\s*var\(--font-size-display\)/);
  assert.match(style, /h2\{font-size:\s*var\(--font-size-4\)/);
  const access = read('static/access.css');
  assert.match(access, /#access h1 \{[^}]*font-size:\s*var\(--font-size-5\)/);
  assert.match(access, /#access-form label \{[^}]*font-size:\s*var\(--font-size-2\)/);
  assert.match(access, /#access-description \{ color:\s*var\(--color-text-muted\)/);
});

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('#584 neutral status badges keep AA text contrast and the info alert ring stays visible', () => {
  const source = read('static/style.css');
  assert.match(source, /\.status\{[^}]*background:var\(--color-status-neutral-bg\);color:var\(--color-status-neutral\)/);
  assert.match(source, /\.status-info\.status-alert\{box-shadow:inset 0 0 0 1px var\(--color-info-border\)\}/);
  assert.ok(contrast(SHARED['--color-status-neutral'], SHARED['--color-status-neutral-bg']) >= 4.5, 'neutral badge text must stay at WCAG AA for 12px text');
  assert.ok(contrast(SHARED['--color-info-border'], SHARED['--color-info-bg']) >= 1.3, 'info alert ring must be distinguishable from the info badge fill');
});
