// #757: a GitHub permission check ends in the background. The pages that list what it just proved are drawn again, but
// an identity sub-page holding unsaved input is a form of its own — the Feishu app wizard, the binding page — and the
// check's answer changes nothing on it, so redrawing it would only take the input away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectScopeConsole } from '../../../fixtures/console-page.mjs';

const repositories = [{ id: 101, full_name: 'fixture/project-101' }, { id: 102, full_name: 'fixture/project-102' }];
const load = () => loadProjectScopeConsole(
  (_method, path) => path === '/api/repositories' ? [200, { repositories }] : [200, {}]);
// The console as the check ends on it: signed in, the check had been running, the address and tab are the reader's.
const arrange = (page, hash, tab = 'identity') => page.run(`location.hash = ${JSON.stringify(hash)}; tab = ${JSON.stringify(tab)};
  me = { id: 7, github_verification: { checked: 0, total: 1 } };`);
// What the reader typed into the page: a field with a value, in the identity panel the console would replace.
const typed = (page, value = 'cli_typed_by_person') => page.run(`(() => { const field = document.createElement('input');
  field.name = 'app_id'; field.value = ${JSON.stringify(value)}; $('identity-panel').append(field); return $('identity-panel').childElementCount; })()`);
// The check ends: count the redraws, and read the project picker the end updates either way.
const endCheck = page => page.run(`(async () => { let drawn = 0; route = async () => { drawn++; syncScopePicker(); };
  await finishGithubVerification({ id: 7, github_verification: null });
  return { drawn, picker: $('console-scope-list').querySelectorAll('[role=option]').filter(node => node.dataset.projectId).length, line: $('github-verification').hidden }; })()`);

test('the app wizard keeps what was typed into it when the permission check ends', async () => {
  const page = load(); arrange(page, '#/identity/feishu-apps/new/1'); typed(page);
  const ended = await endCheck(page);
  assert.equal(ended.drawn, 0, 'the page holding the input is not drawn again');
  // The projects the check just proved still arrive, and the line stops.
  assert.equal(ended.picker, 2, 'the project picker follows the new repositories');
  assert.equal(ended.line, true, 'the progress line goes with the check');
});

test('the binding page keeps its typed confirmation string when the permission check ends', async () => {
  const page = load(); arrange(page, '#/identity/feishu'); typed(page, 'ABCD-1234');
  const ended = await endCheck(page);
  assert.equal(ended.drawn, 0);
  assert.equal(ended.picker, 2);
});

test('a sub-page nobody is typing on is still drawn again when the check ends', async () => {
  const page = load(); arrange(page, '#/identity/feishu-apps/new/1'); typed(page, '');
  page.run(`(() => { const copy = document.createElement('textarea'); copy.readOnly = true; copy.value = '{"scopes":{}}';
    const sel = document.createElement('select'); sel.value = 'enterprise'; $('identity-panel').append(copy, sel); })()`);
  const ended = await endCheck(page);
  assert.equal(ended.drawn, 1, 'an untouched sub-page follows the check as before');
  assert.equal(ended.picker, 2);
});

test('an open dialog on the identity page also keeps the page from being drawn again', async () => {
  const page = load(); arrange(page, '#/identity/feishu-apps/new/1');
  page.run("(() => { const dialog = document.createElement('dialog'); dialog.showModal(); $('identity-panel').append(dialog); })()");
  const ended = await endCheck(page);
  assert.equal(ended.drawn, 0);
});

test('the root identity page and the project list are drawn again, as the contract says', async () => {
  const identity = load(); arrange(identity, '#/identity'); typed(identity);
  assert.equal((await endCheck(identity)).drawn, 1, 'the root authorization view follows the check');
  const projects = load(); arrange(projects, '#/projects', 'projects'); typed(projects);
  assert.equal((await endCheck(projects)).drawn, 1, 'the project list follows the check');
});
