// Why a user change was refused, in words instead of the bare server code.
function userChangeMessage(err) {
  const code = err.code || String(err.message).replace(/^\d+\s*·\s*/, '');
  if (code === 'last_super_admin') return '这是最后一名活跃的超级管理员，不能停用。先启用或新增另一名超级管理员。';
  if (code === 'user_not_found') return '这个用户已经不存在，请刷新用户列表。';
  return err.message;
}
function userProfileLine(user) {
  const line = userLine(user), actions = line.querySelector('.actions');
  if (actions) actions.prepend(settingsLink('#/settings/users/' + encodeURIComponent(user.id), '详情'));
  return line;
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
    content.append(element('h4', userDisplayName(user)),
      facts([['角色', user.role === 'super_admin' ? '超级管理员 · 管理全部项目' : '项目管理员'], ['状态', user.active ? '已启用' : '已停用'],
        ['账号 ID', user.id], ['登录来源', user.github_login ? 'GitHub OAuth 已关联' : '本地账号']]));
    if (user.role === 'project_admin') content.append(...userAccessLines(user));
    else content.append(note('超级管理员管理全部项目和全局设置，不需要逐个仓库授权。'));
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
