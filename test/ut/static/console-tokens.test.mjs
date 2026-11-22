// #224-A / #262: one declaration site for the console theme. docs/design/console-and-api.md says modules
// reference the shared variables and do not copy a second theme. shell.css is the only :root
// that declares custom properties, and every var() a sheet reads resolves to a declaration,
// a runtime write, or its own fallback. Contrast checks read the declared colours from shell.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
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

// #551: the leftover teal palette in style.css was a second theme. Login, projects and
// identity must read the shared tokens so the same heading / body / muted level looks
// the same on every page. New hard-coded values of those colours are a regression.
const LEGACY_THEME = ['#637c89', '#5b7481', '#52707d', '#183142', '#16636b', '#f3f6f8', '#365564', '#13394b'];

test('#551 style.css, access.css, management.css and views.css no longer hard-code the leftover teal theme', () => {
  for (const name of ['style.css', 'access.css', 'management.css', 'views.css']) {
    const source = read('static/' + name);
    for (const colour of LEGACY_THEME) {
      assert.equal(source.toLowerCase().includes(colour), false,
        `${name} still hard-codes leftover theme colour ${colour}`);
    }
  }
});

test('#551 management.css and views.css no longer hard-code leftover colours, and role cards keep the caller heading level', () => {
  const management = read('static/management.css');
  for (const literal of ['#166e70', '#66827c', '#8a9aa1']) assert.equal(management.includes(literal), false, literal);
  // Only icon glyph sizes (welcome badge and avatar) stay literal; text reads the shared scale.
  const literalSizes = [...management.matchAll(/^\s*([^{}]+?)\s*\{[^}]*font-size:\s*\d+px/gm)].map(match => match[1]);
  assert.deepEqual(literalSizes.filter(selector => !/-(icon|avatar|size-handle)\b/.test(selector)), [], 'management.css text sizes read the shared scale');
  assert.equal(management.includes('#183142'), false);
  assert.equal(management.includes('#6d818a'), false);
  assert.equal(management.includes('#16636b'), false);
  const views = read('static/views.css');
  const rateLimits = read('static/settings/rate-limits.js');
  assert.match(rateLimits, /element\('h3',[^)]*'rate-account'\)/, 'the quota account names keep their own level and class');
  // #1039: serviceRoleCard is drawn on the settings page (h2 under 全局设置) and inside the Feishu bindings page's own h3
  // card, so the level is an argument: the settings caller passes h2, the bindings caller keeps the h3 default. Without
  // this the settings default would leak out and make an h2 → h4 skip on #/identity/feishu.
  const serviceRoles = read('static/settings/service-roles.js');
  assert.match(serviceRoles, /function serviceRoleCard\(view, initial, level = 'h3'\)/, 'the role card level is the caller\'s');
  assert.match(serviceRoles, /\}, level\);/, 'the level reaches liveCard');
  assert.match(serviceRoles, /querySelector\(level\)/, 'the saved name is rewritten on the heading of that level');
  assert.match(read('static/settings/page.js'), /serviceRoleCard\(view, role, 'h2'\)/, 'the settings page asks for h2');
  assert.match(read('static/channels/assistant-roles.js'), /serviceRoleCard\(view, role\)/, 'the Feishu bindings page keeps h3');
  // A card created in place is a card of the calling page too: the create form passes the level on, so the new card is an
  // h2 on settings instead of falling back to the h3 default and reading as a child of the card above it.
  assert.match(serviceRoles, /function serviceRoleCreate\(view, level = 'h3'\)/, 'the create form takes the same level');
  assert.match(serviceRoles, /section\.before\(serviceRoleCard\(view, created, level\)\)/, 'the created card is drawn at that level');
  assert.match(read('static/settings/page.js'), /serviceRoleCreate\(view, 'h2'\)/, 'the settings page creates h2 cards');
  assert.equal(views.toLowerCase().includes('#637c89'), false);
  assert.equal(views.toLowerCase().includes('#365564'), false);
  for (const literal of ['#718793', '#536c78']) assert.equal(views.toLowerCase().includes(literal), false, literal);
  assert.equal(views.toLowerCase().includes('#16636b'), false);
  assert.equal(views.toLowerCase().includes('#13394b'), false);
  assert.equal(views.toLowerCase().includes('#183142'), false);
});

// #563: the lighter leftover teals fail 4.5:1 on the page background. They must
// not return in the remaining console sheets or the usage chart.
const LIGHT_LEFTOVER = ['#637c89', '#5b7481', '#52707d'];

test('#563 module sheets and the usage chart no longer hard-code light leftover teals', () => {
  for (const name of ['static/costs.css', 'static/views.css', 'static/workspace.css', 'static/costs.js', 'static/management.css']) {
    const source = read(name);
    for (const colour of LIGHT_LEFTOVER) {
      assert.equal(source.toLowerCase().includes(colour), false,
        `${name} still hard-codes light leftover colour ${colour}`);
    }
  }
});

test('#563 nav labels use the shared type step', () => {
  assert.match(read('static/shell.css'), /\.console-nav-label \{[^}]*font-size:\s*var\(--font-size-1\)/);
});

test('#552 login and identity actions use the named button classes', () => {
  const html = read('static/index.html');
  assert.match(html, /id="access-submit"[^>]*class="btn-primary"/);
  assert.match(html, /id="refresh"[^>]*class="btn-text"/);
  assert.match(html, /data-testid="project-filter-submit"/);
  const identity = read('static/identity.js');
  assert.match(identity, /t\('identity.bind_github'\), 'btn-secondary'/);
  assert.match(identity, /t\('identity.switch_org'\), 'btn-secondary'/);
  // The page no longer has a manual 刷新身份与授权 button (it refreshes automatically on return from GitHub).
  assert.equal(identity.includes("button('刷新身份与授权'"), false);
  // First-screen GitHub action is the only solid primary; Advanced actions stay secondary or text.
  assert.match(identity, /identity-primary btn-primary/);
});

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
// Read the colour from the :root declaration. A copied hex in this file would pin the
// palette again, which is the table this test no longer keeps.
const shellHex = token => {
  const blocks = rootBlocks(shell).join('\n');
  const found = [...blocks.matchAll(new RegExp(`(?:^|[\\s{;])${token}\\s*:\\s*([^;]+);`, 'g'))];
  const value = found.at(-1)?.[1].trim() ?? '';
  assert.match(value, /^#[0-9a-f]{6}$/i, `${token} is a 6-digit colour in shell.css :root, got ${JSON.stringify(value)}`);
  return value;
};

test('#584 neutral status badges keep AA text contrast and the info alert ring stays visible', () => {
  const source = read('static/style.css');
  assert.match(source, /\.status\{[^}]*background:var\(--color-status-neutral-bg\);color:var\(--color-status-neutral\)/);
  assert.match(source, /\.status-info\.status-alert\{box-shadow:inset 0 0 0 1px var\(--color-info-border\)\}/);
  assert.ok(contrast(shellHex('--color-status-neutral'), shellHex('--color-status-neutral-bg')) >= 4.5, 'neutral badge text must stay at WCAG AA for 12px text');
  assert.ok(contrast(shellHex('--color-info-border'), shellHex('--color-info-bg')) >= 1.3, 'info alert ring must be distinguishable from the info badge fill');
});
