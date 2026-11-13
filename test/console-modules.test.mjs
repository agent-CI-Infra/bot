import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consoleModulePaths, readConsoleScriptSync } from '../dist/console/modules.js';

test('a console manifest concatenates its modules in order', () => {
  assert.equal(readConsoleScriptSync('test/fixtures/console-modules/entry.js'), 'var left = 1;\nvar right = 2;\n');
});

test('a script that is not a manifest is left unchanged', () => {
  const raw = readFileSync('static/app.js', 'utf8');
  assert.equal(readConsoleScriptSync('static/app.js'), raw);
  assert.equal(consoleModulePaths('function ready() {}\n'), null);
});

test('a manifest with a path outside its directory is refused', () => {
  assert.throws(() => readConsoleScriptSync('test/fixtures/console-modules/escape.js'), /escapes its directory/);
});

test('a manifest that does not match the grammar is refused', () => {
  assert.throws(() => consoleModulePaths('/** @console-modules\n * Not a path\n */\n'), /malformed/);
});

// The split keeps the original source order. These names are far apart in each page, so a module
// listed too early or too late fails here before a browser test has to draw the page.
test('split console pages still define their entry functions in source order', () => {
  const pages = {
    'static/project.js': ['function renderProject', 'function membersSection', 'function schedulesSection'],
    'static/views.js': ['function openTask', 'function renderTimeline', 'function installedActions'],
    'static/channels.js': ['async function renderFeishuBindingsPage', 'async function channelSchedules', 'function channelLink'],
    'static/roles.js': ['function rolesConsole', 'function stagePolicyGraph'],
    'static/settings.js': ['function settingsRoute', 'function installationDetail', 'function serviceRoleCreate'],
  };
  for (const [file, markers] of Object.entries(pages)) {
    const source = readConsoleScriptSync(file);
    assert.equal(source.includes('@console-modules'), false, file);
    let at = -1;
    for (const marker of markers) {
      const next = source.indexOf(marker);
      assert.ok(next > at, `${file} missing ${marker}`);
      at = next;
    }
  }
});
