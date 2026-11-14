// Why a user change was refused, in words instead of the bare server code.
function userChangeMessage(err) {
  const code = err.code || String(err.message).replace(/^\d+\s*·\s*/, '');
  if (code === 'last_super_admin') return '这是最后一名可管理全部项目的活跃管理员，不能停用。先启用或新增另一名这样的管理员。';
  if (code === 'user_not_found') return '这个用户已经不存在，请刷新用户列表。';
  return err.message;
}
// #547: how the account signs in, read from the server's own projection (a password sentinel and a GitHub identity),
// never guessed in the browser from whether a display name happens to exist.
function userLoginMethods(user) {
  const methods = user.login_methods || [];
  if (methods.includes('local') && methods.includes('github')) return '本地 + GitHub';
  if (methods.includes('github')) return '仅 GitHub';
  return '本地';
}
function userBindingLabel(user) {
  return ({ none: '未绑定 GitHub', bound: '同一用户，已绑定', pending_verification: '待验证', revoked: '已解绑' })[user.github_binding] ?? '状态未知';
}
// The GitHub column never prints the internal placeholder username; an unbound account says exactly that, and a revoked
// binding does not keep showing the login it no longer accepts (the server stops sending it).
function userGithubName(user) {
  if (user.github_binding === 'none') return '未绑定';
  if (user.github_binding === 'revoked') return '已解绑';
  return user.github?.login ? '@' + user.github.login : '未知';
}
// One platform account per row. The first cell keeps the access lines the old list showed, so a project administrator's
// visible projects and manual grants stay readable without opening the detail.
function userTable(users, intro) {
  const section = card('用户'), head = element('div', '', 'actions settings-list-head');
  head.append(note(intro), button('新增用户', () => openEditor('users'), ''));
  if (!users.length) { section.append(head, element('p', '还没有用户。', 'muted')); return section; }
  const captions = ['用户', '登录方式', '本地账号', 'GitHub 账号', '绑定关系', '角色', '状态', '操作'];
  const table = element('table', '', 'rule-table users-table'), headRow = element('tr', '');
  for (const caption of captions) headRow.append(element('th', caption));
  const thead = document.createElement('thead'), body = document.createElement('tbody');
  thead.append(headRow); table.append(thead, body);
  for (const user of users) {
    const line = element('tr', ''), cell = (index, value) => { const td = element('td'); td.dataset.label = captions[index]; td.append(value); return td; };
    line.dataset.userId = user.id;
    const name = element('div', '', 'user-main'), actions = element('div', '', 'actions');
    name.append(element('strong', userDisplayName(user)), ...(user.role === 'project_admin' ? userAccessLines(user) : []));
    actions.append(settingsLink('#/settings/users/' + encodeURIComponent(user.id), '详情'));
    if (user.role === 'project_admin') actions.append(button('修改仓库权限', () => editGrants(user)));
    actions.append(button('删除', () => deleteUser(user).catch(error), 'quiet destructive'));
    line.append(cell(0, name), cell(1, userLoginMethods(user)),
      cell(2, user.local_login ? (user.local_account || '未知') : '无本地登录'), cell(3, userGithubName(user)),
      cell(4, userBindingLabel(user)), cell(5, user.role === 'super_admin' ? '管理员 · 可管理全部项目' : '项目管理员'),
      cell(6, badge(user.active ? '已启用' : '已停用', user.active ? 'success' : 'warning')), cell(7, actions));
    body.append(line);
  }
  const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table);
  section.append(head, wrap); return section;
}
// One user's access projection plus the enable/disable switch the API already offered but the console did not show.
function userDetail(id, users) {
  const section = card('用户详情'), content = element('div', ''), back = settingsLink('#/settings/users', '返回用户列表'),
    message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  section.append(back, content);
  const user = users.find(row => row.id === id);
  if (!user) { content.append(note('找不到这个用户，可能已被删除。')); return section; }
  let notice = '';
  const draw = () => {
    content.replaceChildren();
    if (notice) content.append(element('p', notice, 'view-success'));
    // The same fields as the row, so the list and the detail cannot disagree about how someone signs in.
    content.append(element('h4', userDisplayName(user)),
      facts([['角色', user.role === 'super_admin' ? '管理员 · 可管理全部项目' : '项目管理员'], ['状态', user.active ? '已启用' : '已停用'],
        ['账号 ID', user.id], ['登录方式', userLoginMethods(user)],
        ['本地账号', user.local_login ? (user.local_account || '未知') : '无本地登录'],
        ['GitHub 账号', userGithubName(user)], ['绑定关系', userBindingLabel(user)]]));
    if (user.role === 'project_admin') content.append(...userAccessLines(user));
    else content.append(note('管理员可管理全部项目和全局设置，不需要逐个仓库授权。'));
    const toggle = button(user.active ? '停用' : '启用', async () => {
      toggle.disabled = true; message.className = 'view-error'; message.textContent = '';
      try {
        const saved = await api('/api/users/' + encodeURIComponent(user.id), 'PATCH', { active: !user.active });
        user.active = saved.user.active;
        notice = user.active ? '已启用，该账号可以立即登录。' : '已停用，该账号的会话已立即失效。';
        draw();
      } catch (err) { message.textContent = userChangeMessage(err); }
      finally { toggle.disabled = false; }
    });
    const actions = element('div', '', 'actions'); actions.append(toggle);
    content.append(actions, message);
  };
  draw();
  return section;
}
