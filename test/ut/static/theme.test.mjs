// #750: the console follows the system theme, and a manual choice overrides it without a repaint flash. Three things are
// machine-checkable here: the boot script runs before the first stylesheet, the two dark blocks declare exactly the same
// colour tokens as the light :root (an override that misses a token silently falls back to the light value), and the
// dark palette itself meets WCAG AA on the surfaces phase 1 covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const html = read('static/index.html');
const boot = read('static/theme-boot.js');
const shell = read('static/shell.css');
const server = read('src/server.ts');

const source = shell.replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = (text) => new Map([...text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
// A block body cannot contain braces here, so one level of nesting is read with a non-greedy body each time.
const block = (pattern) => { const match = source.match(pattern); assert.ok(match, `shell.css has ${pattern}`); return tokens(match[1]); };
const light = block(/:root\s*\{([^}]*)\}/);
const darkSystem = block(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/);
const darkManual = block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
const colorTokens = (map) => [...map.keys()].filter((name) => name.startsWith('--color-')).sort();
const dark = [
  { selector: '@media (prefers-color-scheme: dark)', tokens: darkSystem },
  { selector: ':root[data-theme="dark"]', tokens: darkManual }
];

const channel = (value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const hex = (value) => {
  const raw = String(value).trim();
  const match = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  assert.ok(match, `${value} is a hex colour`);
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
};
const luminance = (value) => { const [r, g, b] = hex(value); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('#750 the theme boot script runs before the first stylesheet and is served by the control plane', () => {
  const bootTag = html.indexOf('<script src="/theme-boot.js"></script>');
  const localeTag = html.indexOf('<script src="/locale-boot.js"></script>');
  const firstSheet = html.indexOf('<link rel="stylesheet"');
  assert.ok(bootTag > -1, 'index.html loads /theme-boot.js');
  assert.ok(localeTag > -1 && bootTag > localeTag, 'theme-boot runs after locale-boot');
  assert.ok(firstSheet > bootTag, 'theme-boot runs before the first stylesheet');
  assert.doesNotMatch(html.slice(0, firstSheet), /<script[^>]*\/theme-boot\.js[^>]*(defer|async)/, 'theme-boot is not deferred');
  assert.match(server, /'\/theme-boot\.js':\s*\['theme-boot\.js',\s*'text\/javascript'\]/, 'the asset map serves /theme-boot.js');
});

test('#750 a manual choice is the only thing that writes data-theme, and storage keeps the three-state value', () => {
  assert.match(boot, /localStorage\.getItem\(KEY\)/);
  assert.match(boot, /stored === 'light' \|\| stored === 'dark' \|\| stored === 'system'/);
  assert.match(boot, /root\.removeAttribute\('data-theme'\)/);
  assert.match(boot, /root\.setAttribute\('data-theme', choice\)/);
  assert.match(boot, /root\.style\.colorScheme = dark \? 'dark' : 'light'/);
  assert.match(boot, /localStorage\.setItem\(KEY, value\)/);
  assert.match(boot, /query\.addEventListener\('change'/, 'a system switch repaints without a reload');
  assert.doesNotMatch(boot, /innerHTML|document\.write|eval\(/, 'the boot script stays a plain reader');
});

test('#750 both dark blocks declare the same colour tokens as the light :root', () => {
  assert.equal(dark.length, 2, 'one @media block and one [data-theme="dark"] block');
  const expected = colorTokens(light);
  assert.ok(expected.includes('--color-brand-text'), 'the light :root declares the text brand token');
  for (const rule of dark) assert.deepEqual(colorTokens(rule.tokens), expected, `${rule.selector} must cover every colour token`);
  assert.deepEqual(colorTokens(darkSystem), colorTokens(darkManual), 'the system and the manual block carry the same palette');
  // A manual light choice has to beat a dark system, so its rule comes after the media query.
  assert.ok(shell.lastIndexOf(':root[data-theme="light"]') > shell.indexOf('@media (prefers-color-scheme: dark)'), 'the light override comes after the media query');
});

test('#750 the dark palette meets AA on the surfaces phase 1 covers', () => {
  const manual = darkManual;
  const pairs = [
    ['--color-text', '--color-bg', 4.5], ['--color-text', '--color-surface', 4.5],
    ['--color-text', '--color-surface-alt', 4.5],
    ['--color-text-muted', '--color-surface', 4.5], ['--color-text-muted', '--color-bg', 4.5],
    ['--color-brand-text', '--color-surface', 4.5], ['--color-brand-text', '--color-bg', 4.5],
    ['--color-brand-text', '--color-surface-alt', 4.5],
    ['--color-text-inverse', '--color-brand', 4.5],
    ['--color-warning', '--color-warning-bg', 4.5], ['--color-success', '--color-success-bg', 4.5],
    ['--color-danger', '--color-danger-bg', 4.5], ['--color-danger', '--color-surface', 4.5],
    ['--color-info', '--color-info-bg', 4.5],
    ['--color-status-neutral', '--color-status-neutral-bg', 4.5],
    ['--color-border', '--color-surface', 3], ['--color-border', '--color-bg', 3],
    ['--focus-ring', '--color-bg', 3]
  ];
  for (const [foreground, background, minimum] of pairs) {
    assert.ok(manual.has(foreground) && manual.has(background), `${foreground} on ${background} is declared`);
    const ratio = contrast(manual.get(foreground), manual.get(background));
    assert.ok(ratio >= minimum, `${foreground} on ${background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
  }
});
