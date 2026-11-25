// #750: the console follows the system theme, and a manual choice overrides it without a repaint flash. Three things are
// machine-checkable here: the boot script runs before the first stylesheet, the two dark blocks declare exactly the same
// colour tokens as the light :root (an override that misses a token silently falls back to the light value), and the
// dark palette itself meets WCAG AA on the surfaces phase 1 covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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
    ['--color-code-text', '--color-code-bg', 4.5],
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

test('#750 status text that paints no background takes a dark token in both dark blocks', () => {
  // F2: `.view-success`, `.view-progress` and `.machine-config-error` are dark literals on no background of their own,
  // so in dark they are dark-on-dark (2.27–2.33:1 on `--color-surface`). The identity page — the page this change adds
  // the three-way control to — writes its success notice as `.view-success`, so both blocks must swap these three for
  // the palette tokens; a light-only fix would leave the manual dark choice broken.
  const views = read('static/views.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...views.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const rows = [
    ['.view-success', '--color-success'],
    ['.view-progress', '--color-info'],
    ['.machine-config-error', '--color-danger']
  ];
  for (const scope of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const scoped = rules.filter((rule) => rule.selector.startsWith(scope));
    for (const [selector, token] of rows) {
      const hit = scoped.find((rule) => rule.selector.includes(selector) && new RegExp(`color:\\s*var\\(${token}\\)`).test(rule.body));
      assert.ok(hit, `${scope} must set ${selector} to var(${token})`);
      const ratio = contrast(darkManual.get(token), darkManual.get('--color-surface'));
      assert.ok(ratio >= 4.5, `${selector} on the dark surface is ${ratio.toFixed(2)}:1, needs 4.5:1`);
    }
  }
});

test('#750 the token root declares --surface for light and for both dark blocks', () => {
  // #1067 C: `.console-save-bar` reads `var(--surface, #fff)`; phase 1 never declared `--surface`, so the fallback was
  // the only value and the whole bar stayed white in dark (its muted status read 2.14:1). The token belongs to the
  // token root: one light value, one value in each dark block, and the light value is the old fallback so light pixels
  // do not move.
  assert.equal(light.get('--surface'), '#fff', 'the light :root must declare --surface: #fff');
  for (const rule of dark) assert.equal(rule.tokens.get('--surface'), '#161d27', `${rule.selector} must declare --surface: #161d27`);
});

test('#750 the costs page takes its surfaces from the dark tokens in both dark blocks', () => {
  // The costs page hardcodes the light palette (`.cost-filters` #fafcfd, `.cost-stat` #f8fbfc, `.cost-table-scroll th`
  // #f5f8fa, borders #dde6eb / #e3eaf0, the incomplete notice #fff7e8), while its text already comes from the tokens.
  // Following the system preference therefore puts token-coloured text on light plates — the e2e guard in
  // `test/e2e/projects/project-tools.spec.mjs` measures 1.1–2.1:1 on those nodes. Both dark blocks must repaint the
  // surfaces, not only the text.
  const views = read('static/views.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...views.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const rows = [
    ['#costs-panel', 'border-top-color', '--color-border'],
    ['.cost-filters', 'background', '--color-surface-alt'],
    ['.cost-stat', 'background', '--color-surface-alt'],
    ['.cost-stat', 'border-color', '--color-border'],
    ['.cost-chart-section', 'border-color', '--color-border'],
    ['.cost-table-scroll', 'border-bottom-color', '--color-border'],
    ['.cost-table-scroll th', 'background', '--color-surface-alt'],
    ['.cost-incomplete', 'background', '--color-warning-bg'],
    ['.cost-incomplete', 'color', '--color-warning'],
    ['.cost-chart-detail', 'color', '--color-text-muted']
  ];
  for (const scope of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const scoped = rules.filter((rule) => rule.selector.startsWith(scope));
    for (const [selector, property, token] of rows) {
      const hit = scoped.find((rule) => rule.selector.includes(selector) && new RegExp(`(^|;|\\s)${property}:\\s*var\\(${token}\\)`).test(rule.body));
      assert.ok(hit, `${scope} must set ${property} of ${selector} to var(${token})`);
    }
  }
  const muted = contrast(darkManual.get('--color-text-muted'), darkManual.get('--color-surface-alt'));
  assert.ok(muted >= 4.5, `muted text on the dark surface-alt is ${muted.toFixed(2)}:1, needs 4.5:1`);
});

test('#750 the flash notice keeps a dark plate in both dark blocks', () => {
  // `.flash` paints `#e5f2e9` and lets the text follow the tokens, so in dark the light plate meets the light text
  // (about 1.2:1) and `view-success flash` (the notification `liveCard()` and the project save path paint) reads
  // 1.46:1. The light rule stays as it is; the two dark blocks give the plate the success background token.
  const views = read('static/views.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...views.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const lightFlash = rules.find((rule) => rule.selector === '.flash');
  assert.ok(lightFlash && /background:\s*#e5f2e9/.test(lightFlash.body), 'the light flash plate is unchanged');
  for (const scope of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const hit = rules.find((rule) => rule.selector === `${scope} .flash` && /background:\s*var\(--color-success-bg\)/.test(rule.body));
    assert.ok(hit, `${scope} must paint .flash with var(--color-success-bg)`);
  }
  const ratio = contrast(darkManual.get('--color-text'), darkManual.get('--color-success-bg'));
  assert.ok(ratio >= 4.5, `text on the dark flash plate is ${ratio.toFixed(2)}:1, needs 4.5:1`);
});


test('#750 no stylesheet in static/ paints text with the fill token', () => {
  // #1067 E/F: the Review swept six more nodes that still painted text with `--color-brand`, the token the design note
  // reserves for fills (docs/design/console-and-api.md:13 says text, links and icons take `--color-brand-text`). The
  // guard scans the WHOLE `static/` tree by declaration, not a list of known selectors: a new `.foo { color:
  // var(--color-brand) }` written later fails here as well, which a pinned selector list would miss. The light values of
  // the two tokens are the same #245de0, so swapping them moves no light pixel.
  const styles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(path + '/');
      else if (entry.name.endsWith('.css')) styles.push(path);
    }
  };
  walk('static/');
  assert.ok(styles.length > 10, 'the guard reads the whole static/ tree');
  // Two rows keep the fill token on purpose, and the reason is written here instead of being filtered out silently.
  // `.management-receipt a` (:89) and `.management-markdown a` (:109) sit on `.management-feed`, which still paints the
  // light literal `#fcfdfd` (:25) and that no dark block overrides; the dark text token `#96b4ff` reads 2.01:1 on that
  // plate, while the fill token `#245de0` reads 5.54:1 there and 5.65:1 on the receipt's white box. The management feed
  // is not themed yet — that is a separate job — so the exception is explicit, checked, and fails as soon as the plate
  // stops being the literal (then both rows must move to the text token).
  const unthemedPlate = { path: 'static/management.css', selectors: ['.management-receipt a', '.management-markdown a'] };
  const allowed = new Set(unthemedPlate.selectors);
  const used = new Set();
  const violations = [];
  for (const path of styles) {
    const text = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const declaration of body.split(';')) {
        // Only the `color` property counts: `border-color` and `background-color` legitimately keep the fill token.
        const match = declaration.match(/^\s*color\s*:\s*(.+)$/);
        if (!match || !/var\(\s*--color-brand\s*\)/.test(match[1])) continue;
        if (path === unthemedPlate.path && allowed.has(selector.trim())) used.add(selector.trim());
        else violations.push(`${path}: ${selector.trim()} { color: ${match[1].trim()} }`);
      }
    }
  }
  assert.deepEqual(violations, [], 'no static/ rule may paint text with var(--color-brand) unless its plate is the unthemed management feed');
  assert.deepEqual([...used].sort(), [...allowed].sort(), 'the management-feed exception is exactly the two declared rows');
  const management = read(unthemedPlate.path).replace(/\/\*[\s\S]*?\*\//g, '');
  const managementRules = [...management.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  for (const selector of unthemedPlate.selectors) {
    const rule = managementRules.find((entry) => entry.selector === selector);
    assert.ok(rule, `${unthemedPlate.path} still declares ${selector}`);
    assert.match(rule.body, /color:\s*var\(--color-brand\)/, `${selector} keeps the fill token while its plate is the light literal`);
    assert.doesNotMatch(rule.body, /--color-brand-text/, `${selector} must not take the text token on the unthemed plate`);
  }
  // The exception is valid only while the feed has no dark plate: one literal, and no other declaration that repaints it.
  const feed = managementRules.find((entry) => entry.selector === '.management-feed');
  assert.ok(feed && /background:\s*#fcfdfd/.test(feed.body), 'the management feed still paints the light literal #fcfdfd');
  const repainted = [];
  for (const path of styles) {
    const text = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.management-feed\b/.test(selector)) continue;
      for (const declaration of body.split(';')) {
        const match = declaration.match(/^\s*background(?:-color)?\s*:\s*(.+)$/);
        if (match && !/#fcfdfd/i.test(match[1])) repainted.push(`${path}: ${selector.trim()} { background: ${match[1].trim()} }`);
      }
    }
  }
  assert.deepEqual(repainted, [], 'the unthemed management feed keeps its single light literal, so the exception still holds');
  // The other half of the same guard: a row that carries the fill itself must keep `--color-brand` as its text colour,
  // because the dark text token is the light #96b4ff and the dark fill is the saturated #245de0 — swapping a filled
  // control's label to the text token lowers its contrast instead of raising it. A rule that sets both at once is the
  // shape this catches; the 22 swapped rows all paint text on a neutral or brand-weak plate, none on the fill.
  const hardSwaps = [];
  for (const path of styles) {
    const text = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = body.split(';').map((entry) => entry.trim());
      const paintsFill = declarations.some((entry) => /^background(-color)?\s*:\s*var\(--color-brand\)$/.test(entry));
      const paintsText = declarations.some((entry) => /^color\s*:\s*var\(--color-brand-text\)$/.test(entry));
      if (paintsFill && paintsText) hardSwaps.push(`${path}: ${selector.trim()} paints text with the text token on the fill token`);
    }
  }
  assert.deepEqual(hardSwaps, [], 'a filled control must not take the text token for its label');
  // The light-invariance claim is structural: both tokens carry the same light value, so every swap above is a no-op in
  // light, and the dark text token is the palette's own light blue rather than the fill colour.
  assert.equal(light.get('--color-brand-text'), light.get('--color-brand'), 'light --color-brand-text keeps the fill value');
  for (const rule of dark) assert.notEqual(rule.tokens.get('--color-brand-text'), rule.tokens.get('--color-brand'), `${rule.selector} separates the text token from the fill`);
  // The incomplete-metrics note was the one node in this family that painted a light literal instead of a token; it now
  // reads the warning token, whose light value is the old #875a0a (shell.css :root) and whose dark value is #f0c882.
  const costs = read('static/costs.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const incomplete = [...costs.matchAll(/([^{}]*\.metric-incomplete[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector, body }));
  const note = incomplete.find((rule) => rule.selector.includes('.task-metrics .metric-incomplete'));
  assert.ok(note, 'costs.css still declares .task-metrics .metric-incomplete');
  assert.match(note.body, /color:\s*var\(--color-warning\)/, '.metric-incomplete takes the warning token');
  assert.doesNotMatch(note.body, /#875a0a/i, '.metric-incomplete no longer carries the light literal');
});
