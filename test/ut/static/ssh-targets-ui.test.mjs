import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from '../../fixtures/console-page.mjs';

const scripts = ['static/app.js', 'static/views.js', 'static/project.js', 'static/settings.js'];
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const textOf = node => [node.textContent, ...node.children.flatMap(textOf)].join(' ');
const buttonsOf = (node, caption) => node.querySelectorAll('button').filter(b => caption === undefined || b.textContent === caption);

test('global settings ssh-targets page lists bound projects, links to compute-nodes, uses h3 editor, and warns on deleting bound host', async () => {
  const sent = [];
  let pool = [
    {
      id: 'a'.repeat(48),
      owner_project: null,
      alias: 'lab-arm64',
      host: '10.0.0.10',
      port: 22,
      username: 'tester',
      host_key_sha256: 'SHA256:' + 'A'.repeat(43),
      auth: 'password',
      route: 'direct',
      jump_id: null,
      relay_node: null,
      allowed_roles: ['dev', 'qa'],
      allow_untrusted_pr: false,
      bound_projects: [
        { id: '101', full_name: 'acme/alpha' },
        { id: '202', full_name: 'acme/beta' },
      ],
    },
  ];
  const page = loadConsole(scripts, (method, path, body) => {
    sent.push([method, path, body]);
    if (method === 'GET' && path === '/api/ssh-targets') return [200, { targets: pool }];
    if (method === 'POST' && path === `/api/ssh-targets/${pool[0].id}/test`) return [200, { ok: false, error: 'ssh_host_key_mismatch' }];
    if (method === 'DELETE' && path === `/api/ssh-targets/${pool[0].id}`) {
      pool = [];
      return [200, { id: 'a'.repeat(48) }];
    }
    if (method === 'POST' && path === '/api/ssh-targets') {
      const created = { id: 'b'.repeat(48), owner_project: null, ...body, relay_node: null, bound_projects: [] };
      pool = [...pool, created];
      return [201, { id: created.id }];
    }
    return [404, { error: 'not_found' }];
  });

  page.run("me = { role: 'super_admin', csrf_token: 'csrf' }; location.hash = '#/settings/ssh-targets';");
  await page.run('renderSettings(renderVersion)');

  const panel = page.$('settings-panel');
  const navLinks = panel.querySelectorAll('nav a').map(a => [a.textContent, a.href]);
  const computeIdx = navLinks.findIndex(([label]) => label === '计算节点');
  assert.deepEqual(navLinks[computeIdx + 1], ['SSH 远程主机', '#/settings/ssh-targets']);
  assert.equal(panel.querySelector('nav a[aria-current=page]').textContent, 'SSH 远程主机');

  const card = panel.querySelector('[data-testid=global-ssh-targets]');
  assert.ok(card, 'renders global-ssh-targets card');
  assert.equal(card.querySelector('h2').textContent, '全局 SSH 远程主机池');

  const computeLink = card.querySelector('[data-testid=ssh-to-compute-nodes-link]');
  assert.equal(computeLink.href, '#/settings/compute-nodes');
  assert.equal(computeLink.textContent, '计算节点');

  // Bound projects rendered as clickable links to each project's machine page
  const boundLinks = card.querySelectorAll('.ssh-bound-project-link').map(a => [a.textContent, a.href]);
  assert.deepEqual(boundLinks, [
    ['acme/alpha', '#/projects/101/machine'],
    ['acme/beta', '#/projects/202/machine'],
  ]);

  // Connectivity test preserves stable error code
  buttonsOf(card, '测试连通性')[0].click();
  await settle();
  assert.match(textOf(card), /测试失败：ssh_host_key_mismatch/);

  // Opening inline create form uses h3 (never skips from h2 to h4)
  buttonsOf(card, '新增全局主机')[0].click();
  const editorForm = card.querySelector('[data-testid=ssh-target-editor-form]');
  assert.ok(editorForm);
  assert.equal(editorForm.querySelector('h3').textContent, '新增全局主机');
  assert.equal(editorForm.querySelector('h4'), null);

  // Deleting a bound global host warns with affected projects in confirmDialog
  const deleteBtn = buttonsOf(card, '删除')[0];
  deleteBtn.click();
  await settle();
  const dialog = page.run('confirmView');
  const dialogText = textOf(dialog);
  assert.match(dialogText, /删除全局 SSH 主机「lab-arm64」/);
  assert.match(dialogText, /当前有 2 个项目绑定了此全局主机/);
  assert.match(dialogText, /acme\/alpha/);
  assert.match(dialogText, /acme\/beta/);

  // Confirm deletion and verify API call + empty state
  dialog.querySelector('form').listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.ok(sent.some(([m, p]) => m === 'DELETE' && p === `/api/ssh-targets/${'a'.repeat(48)}`));
  assert.match(textOf(card), /尚未登记全局 SSH 主机/);
});

test('project machine ssh card separates global bindings from project-specific hosts and enforces role boundaries', async () => {
  const globalHost = {
    id: 'a'.repeat(48),
    owner_project: null,
    alias: 'shared-gw',
    host: 'gw.internal',
    port: 22,
    username: 'ops',
    host_key_sha256: 'SHA256:' + 'A'.repeat(43),
    auth: 'key',
    route: 'direct',
    jump_id: null,
    relay_node: null,
    allowed_roles: ['dev'],
    allow_untrusted_pr: false,
    bound_projects: [],
  };
  const ownHost = {
    id: 'b'.repeat(48),
    owner_project: '101',
    alias: 'proj-board',
    host: '10.1.2.3',
    port: 2222,
    username: 'root',
    host_key_sha256: 'SHA256:' + 'B'.repeat(43),
    auth: 'password',
    route: 'direct',
    jump_id: null,
    relay_node: null,
    allowed_roles: ['qa'],
    allow_untrusted_pr: false,
  };
  let bound = false;
  const sent = [];

  const respond = (method, path) => {
    sent.push([method, path]);
    if (method === 'GET' && path === '/api/ssh-targets') return [200, { targets: [globalHost] }];
    if (method === 'GET' && path === '/api/repositories/101/ssh-targets') {
      return [200, { targets: bound ? [globalHost, ownHost] : [ownHost] }];
    }
    if (method === 'PUT' && path === `/api/repositories/101/ssh-targets/${globalHost.id}/binding`) {
      bound = true;
      return [200, { id: globalHost.id }];
    }
    if (method === 'DELETE' && path === `/api/repositories/101/ssh-targets/${globalHost.id}/binding`) {
      bound = false;
      return [200, { id: globalHost.id }];
    }
    return [404, { error: 'not_found' }];
  };

  // Super admin view on project machine page
  const superPage = loadConsole(scripts, respond);
  superPage.run("me = { role: 'super_admin', csrf_token: 'csrf' }; current = { id: '101' };");
  const superCard = superPage.run("sshTargetsCard('101', true)");
  await settle();

  assert.match(textOf(superCard), /即时生效/);
  const globalSection = superCard.querySelector('[data-testid=project-ssh-global-bindings]');
  const ownSection = superCard.querySelector('[data-testid=project-ssh-own-targets]');
  assert.ok(globalSection && ownSection);

  // Super admin gets direct link to #/settings/ssh-targets
  const globalLink = globalSection.querySelector('[data-testid=machine-ssh-global-link]');
  assert.equal(globalLink.href, '#/settings/ssh-targets');

  // Global section must ONLY offer bind/unbind — NO add/edit/delete/test buttons
  assert.deepEqual(buttonsOf(globalSection).map(b => b.textContent), ['绑定']);
  assert.equal(buttonsOf(globalSection, '编辑').length, 0);
  assert.equal(buttonsOf(globalSection, '删除').length, 0);
  assert.equal(buttonsOf(globalSection, '测试连通性').length, 0);

  // Bind global host -> button flips to 解除绑定 and jump candidates include bound global host
  buttonsOf(globalSection, '绑定')[0].click();
  await settle();
  const updatedGlobalSection = superCard.querySelector('[data-testid=project-ssh-global-bindings]');
  assert.deepEqual(buttonsOf(updatedGlobalSection).map(b => b.textContent), ['解除绑定']);

  const updatedOwnSection = superCard.querySelector('[data-testid=project-ssh-own-targets]');
  assert.deepEqual(buttonsOf(updatedOwnSection).map(b => b.textContent), ['新增项目专属主机', '测试连通性', '编辑', '删除']);
  buttonsOf(updatedOwnSection, '新增项目专属主机')[0].click();
  const ownEditor = updatedOwnSection.querySelector('[data-testid=ssh-target-editor-form]');
  assert.equal(ownEditor.querySelector('h4').textContent, '新增项目专属主机');
  const jumpOptions = ownEditor.querySelectorAll('select')[1].options.map(o => [o.value, o.textContent]);
  assert.ok(jumpOptions.some(([v, label]) => v === globalHost.id && label.includes('shared-gw') && label.includes('全局主机')));

  // Project admin view: read-only, never requests /api/ssh-targets, no mutation controls or global settings link
  sent.length = 0;
  const adminPage = loadConsole(scripts, respond);
  adminPage.run("me = { role: 'project_admin', csrf_token: 'csrf' }; current = { id: '101' };");
  const adminCard = adminPage.run("sshTargetsCard('101', false)");
  await settle();

  assert.equal(sent.some(([, path]) => path === '/api/ssh-targets'), false, 'project_admin must not call /api/ssh-targets');
  assert.equal(adminCard.querySelector('[data-testid=machine-ssh-global-link]'), null);
  assert.deepEqual(buttonsOf(adminCard), []);
  assert.match(textOf(adminCard.querySelector('[data-testid=project-ssh-global-bindings]')), /shared-gw/);
  assert.match(textOf(adminCard.querySelector('[data-testid=project-ssh-own-targets]')), /proj-board/);
});
