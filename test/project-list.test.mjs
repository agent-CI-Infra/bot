import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,setup,account,repository,testPassword} from './helpers.mjs';
import {loadConsole} from './console-page.mjs';

for (const view of ['project_admin', 'super_admin', 'hidden']) {
  test(`${view} project list groups by owner id in first-seen order, with login and name fallbacks`, async () => {
    const row = (id, owner_id, full_name, owner_login = '') => ({id, owner_id, full_name, owner_login, registered: true, enabled: true, running_tasks: 0, queued_tasks: 0});
    let rows = [row('1', '20', 'old-name/first'), row('2', '10', 'alpha/second'), row('3', '20', 'new-name/third', 'renamed-owner'),
      row('4', '30', 'no-slash'), row('5', '40', 'alpha/fourth'), row('6', '10', 'alpha/last')];
    const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
      if (path.startsWith('/api/integrations')) return [200, {integrations: []}];
      return [200, {repositories: rows, syncs: []}];
    });
    page.run(`var projectRoute = () => null; me = {role: '${view === 'hidden' ? 'super_admin' : view}'}; tab = 'projects';`);
    page.$('hidden-filter').checked = view === 'hidden';
    await page.run('render()');
    const groups = page.$('rows').querySelectorAll('.project-owner-group');
    assert.deepEqual(groups.map(group => group.dataset.ownerId), ['20', '10', '30', '40']);
    assert.deepEqual(groups.map(group => group.querySelector('h2').textContent), ['renamed-owner', 'alpha', '所有者 30', 'alpha']);
    assert.deepEqual(groups.map(group => group.querySelectorAll('.row').map(line => line.dataset.key)), [['1', '3'], ['2', '6'], ['4'], ['5']]);
    assert.equal(page.$('rows').querySelectorAll('.row').length, rows.length, 'every project remains exactly once');
    rows = [rows[0]]; await page.run('render()');
    assert.deepEqual(page.$('rows').querySelectorAll('h2').map(title => title.textContent), ['old-name']);
    assert.equal(page.$('rows').querySelectorAll('.row').length, 1);
    rows = []; await page.run('render()');
    assert.equal(page.$('rows').querySelectorAll('.project-owner-group').length, 0, 'an empty page has no empty owner groups');
    assert.equal(page.$('rows').querySelectorAll('.row').length, 0, 'access guidance does not invent project rows');
    if (view === 'project_admin') {
      assert.equal(page.$('rows').childElementCount, 1);
      const guidance = page.$('rows').querySelector('.console-state');
      assert.equal(guidance.querySelector('h2').textContent, '已登录，尚无可管理的项目');
      assert.equal(guidance.querySelector('a').href, '#/identity');
      assert.equal(guidance.getAttribute('data-testid'), 'console-state-empty');
      assert.equal(guidance.getAttribute('role'), 'status');
    } else {
      assert.equal(page.$('rows').childElementCount, 1);
      const empty = page.$('rows').querySelector('.console-state');
      assert.equal(empty.querySelector('h2').textContent, view === 'hidden' ? '没有已隐藏的仓库' : '还没有仓库');
      assert.equal(empty.getAttribute('data-testid'), 'console-state-empty');
      assert.equal(empty.getAttribute('role'), 'status');
      assert.match(empty.querySelector('p').textContent, /不是读取失败/);
    }
  });
}

test('project list read failure is an error state, not an empty list', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/integrations')) return [200, {integrations: []}];
    return [500, { error: 'upstream failed' }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'super_admin'}; tab = 'projects';`);
  await page.run('render()');
  const state = page.$('rows').querySelector('.console-state');
  assert.equal(state.getAttribute('data-testid'), 'console-state-error');
  assert.equal(state.getAttribute('role'), 'alert');
  assert.equal(state.querySelector('h2').textContent, '项目列表未能读取');
  assert.match(state.querySelector('p').textContent, /这不是空列表/);
  assert.equal(page.$('rows').querySelectorAll('.row').length, 0);
  assert.ok(state.querySelector('[data-testid=console-state-retry]'));
  assert.equal(page.$('count').textContent, '读取失败');
});


test('project administrators see installed-but-not-started repositories as waiting for activation', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [200, { github_connection: { pending_repositories: [{ id: '101', full_name: 'fixture/project-101' }] } }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  await page.run('render()');
  assert.equal(page.$('rows').querySelector('.console-state'), null, 'pending installations are not the empty-project guidance');
  assert.equal(page.$('rows').querySelector('h2').textContent, '等待管理员启动');
  assert.equal(page.$('rows').querySelector('strong').textContent, 'fixture/project-101');
  assert.ok([...page.$('rows').querySelectorAll('span')].some(el => el.textContent === '等待管理员启动'));
  assert.equal(page.$('rows').querySelector('p').textContent, '已安装到 GitHub，等待管理员在控制台启动后即可打开。');
  const links = [...page.$('rows').querySelectorAll('a')];
  assert.ok(links.every(a => a.href !== '#/projects/101/overview'), 'an unstarted repository has no project page');
  assert.equal(page.$('count').textContent, '0 个项目，1 个等待管理员启动');
  assert.equal(links.length, 1); assert.equal(links[0].href, '#/identity');
  assert.equal(links[0].querySelector('span').textContent, '查看身份与权限');
});


test('a failed identity read is a retryable error, not an empty project list', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [500, { error: 'identity_unavailable' }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  await page.run('render()');
  const state = page.$('rows').querySelector('.console-state');
  assert.equal(state.querySelector('h2').textContent, '等待启动的仓库暂时无法读取');
  assert.ok([...state.querySelectorAll('button')].some(el => el.textContent === '重新加载'));
  assert.ok(![...page.$('rows').querySelectorAll('h2')].some(h => h.textContent === '已登录，尚无可管理的项目'));
  assert.match(page.$('count').textContent, /等待启动的仓库暂时无法读取/);
});

test('the pending-activation group is hidden while a project list filter is set', async () => {
  const page = loadConsole(['static/app.js', 'static/views.js'], (method, path) => {
    if (path.startsWith('/api/identity')) return [200, { github_connection: { pending_repositories: [{ id: '101', full_name: 'fixture/project-101' }] } }];
    if (path.startsWith('/api/integrations')) return [200, { integrations: [] }];
    return [200, { repositories: [], syncs: [] }];
  });
  page.run(`var projectRoute = () => null; me = {role: 'project_admin'}; tab = 'projects'; repositories = [];`);
  page.$('owner-filter').value = '10';
  await page.run('render()');
  assert.equal(page.$('rows').querySelector('.project-pending-group'), null);
  assert.equal(page.$('count').textContent, '0 个项目');
  page.$('owner-filter').value = '';
  await page.run('render()');
  assert.equal(page.$('rows').querySelector('.project-pending-group h2').textContent, '等待管理员启动');
  assert.equal(page.$('count').textContent, '0 个项目，1 个等待管理员启动');
});

test('project list endpoints filter before taking 50 rows and never expand administrator scope', async t => {
  const h = await harness(t), {admin} = await setup(h), a = await account(admin);
  for (let i = 0; i < 53; i++) {
    const id = String(1000 + i), owner = i % 2 ? '20' : '10', name = `fixture/project-${id}`;
    h.store.run('INSERT INTO repositories(id,full_name,owner_id,account_id) VALUES(?,?,?,?)', id, name, owner, a.id);
    h.store.run('INSERT INTO policies(repository_id) VALUES(?)', id);
    h.store.run('INSERT INTO installed_repositories(account_id,repository_id,full_name,owner_id,installed,synced_at) VALUES(?,?,?,?,1,?)', a.id, id, name, owner, new Date().toISOString());
  }
  const ids = result => result.value.repositories.map(row => row.id);
  for (const endpoint of ['/api/repositories', '/api/installations']) {
    const all = ids(await admin(endpoint));
    assert.equal(ids(await admin(endpoint + '?limit=50&offset=0')).length, 50);
    assert.deepEqual(ids(await admin(endpoint + '?limit=50&offset=50')), all.slice(50));
    const owned = (await admin(endpoint + '?owner_id=20&limit=50&offset=0')).value.repositories;
    assert.equal(owned.length, 26); assert.ok(owned.every(row => row.owner_id === '20'));
    assert.deepEqual(ids(await admin(endpoint + '?repository_id=1002&limit=50')), ['1002']);
    assert.deepEqual(ids(await admin(endpoint + '?account_id=unknown&limit=50')), []);
    assert.equal((await admin(endpoint + '?limit=1.5')).status, 400);
  }
  const password = testPassword();
  await admin('/api/users', 'POST', {username: 'scoped', password, repository_ids: ['1000', '1001']});
  const member = h.client(); await member('/api/auth/login', 'POST', {username: 'scoped', password});
  assert.deepEqual(ids(await member('/api/repositories?limit=50&offset=0')), ['1000', '1001']);
  assert.deepEqual(ids(await member('/api/repositories?owner_id=20&limit=50')), ['1001']);
  assert.deepEqual(ids(await member('/api/repositories?repository_id=1002&limit=50')), []);
  assert.equal((await member('/api/installations?limit=50')).status, 403);
  h.store.run('UPDATE installed_repositories SET hidden=1');
  const hidden = '/api/installations/hidden';
  assert.equal(ids(await admin(hidden + '?limit=50&offset=0')).length, 50);
  assert.deepEqual(ids(await admin(hidden + '?limit=50&offset=50')), ['1050', '1051', '1052']);
  assert.equal(ids(await admin(hidden + '?owner_id=20&limit=50')).length, 26);
  assert.deepEqual(ids(await admin(hidden + '?repository_id=1002&limit=50')), ['1002']);
  assert.equal((await member(hidden + '?limit=50')).status, 403);
});

test('project lists count all executing and queued tasks without including waiting or finished work, within administrator scope',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'202');
  const insert=(id,repo,status)=>h.store.run('INSERT INTO tasks(id,repository_id,kind,status,summary) VALUES(?,?,?,?,?)',id,repo,'review.issue',status,'fixture task');
  insert('running','101','running');insert('other','202','running');
  for(let i=0;i<65;i++)insert('queued-'+i,'101','queued');
  for(const status of ['waiting_configuration','waiting_environment','waiting_pr_head','retry_wait','failed','succeeded','completed','cancelled','superseded'])insert(status,'101',status);
  const counts=rows=>rows.map(r=>[r.id,r.running_tasks,r.queued_tasks]);
  assert.deepEqual(counts((await admin('/api/repositories')).value.repositories),[['101',1,65],['202',1,0]]);
  assert.deepEqual(counts((await admin('/api/installations')).value.repositories),[['101',1,65],['202',1,0]]);
  for(const status of ['preparing','implementing','validating','publishing','result_ready']){
    h.store.run('UPDATE tasks SET status=? WHERE id=?',status,'running');
    assert.equal((await admin('/api/repositories')).value.repositories[0].running_tasks,1);
  }
  h.store.run("UPDATE tasks SET status='succeeded' WHERE id='running'");
  h.store.run("UPDATE tasks SET status='running' WHERE id='queued-0'");
  assert.deepEqual(counts((await admin('/api/repositories')).value.repositories),[['101',1,64],['202',1,0]]);
  const password=testPassword();await admin('/api/users','POST',{username:'member',password,repository_ids:['101']});
  const member=h.client();await member('/api/auth/login','POST',{username:'member',password});
  assert.deepEqual(counts((await member('/api/repositories')).value.repositories),[['101',1,64]]);
  assert.equal((await member('/api/installations')).status,403);
  assert.equal((await member('/api/repositories/202/policy','PATCH',{review_enabled:true})).status,403);
  assert.equal((await member('/api/repositories/101/policy','PATCH',{development_enabled:true})).status,200);
  assert.equal((await member('/api/repositories/101/policy','PATCH',{review_enabled:true})).status,200);
  const policy=(await admin('/api/repositories/101')).value.policy;
  assert.equal(policy.review_enabled,1);assert.equal(policy.development_enabled,1);
  assert.equal((await admin('/api/repositories/202')).value.policy.review_enabled,0);
  await admin('/api/project-admin-assignments','PUT',{user_id:(await admin('/api/users')).value.users.find(u=>u.username==='member').id,repository_ids:[]});
  assert.deepEqual((await member('/api/repositories')).value.repositories,[]);
});
