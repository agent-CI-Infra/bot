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
const moduleSheets = ['style.css', 'views.css', 'board.css', 'costs.css', 'management.css'];
const SHARED = {
  '--color-brand': '#245de0', '--color-text-muted': '#607087', '--font-size-2': '14px', '--control-min': '44px',
  '--color-brand-weak': '#edf2ff',
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
