// One account or user as a list row, the same markup as the other lists; drawn by the global settings sections.
function settingsRow(title, detail, extra, badges, actions) {
  const line = element('div', '', 'row has-actions'), content = element('div', '', 'row-content'), status = element('div', '', 'row-state'), group = element('div', '', 'actions');
  line.setAttribute('role', 'listitem'); content.append(element('strong', title), element('p', detail), ...extra); status.append(...badges); group.append(...actions);
  line.append(content, status, group); return line;
}
function accountLine(row) {
  const extra = [];
  if (row.type === 'github_app' && row.credentials_configured) extra.push(appPermissionCheck(row));
  if (row.endpoints.length) { const endpoints = element('details', ''); endpoints.append(element('summary', `${row.endpoints.length} 个 Webhook 入口`), ...row.endpoints.map(e => element('code', e.webhook_path))); extra.push(endpoints); }
  return settingsRow(row.name, row.type === 'github_app' ? 'GitHub App · App ID ' + row.app_id : '机器人账号（Token）', extra,
    [element('span', row.credentials_configured ? '凭据已配置' : '凭据已撤销', 'status status-' + (row.credentials_configured ? 'success' : 'warning'))],
    [button('删除', () => deleteAccount(row).catch(error), 'quiet destructive')]);
}
function userDisplayName(user) { return user.github_login ? '@' + user.github_login : user.username; }
function userAccessLines(user) {
  const projects = user.access?.projects || [], lines = [element('p', projects.length ? `当前可见项目（${projects.length}）：` : '当前没有可访问的项目')];
  if (projects.length) {
    const list = element('ul', '', 'user-project-access');
    for (const project of projects) list.append(element('li', `${project.full_name} · ${project.can_configure ? '可配置' : '可查看'} · ${project.sources.map(source => source === 'github_derived' ? 'GitHub 继承权限' : 'Bot 显式委派').join('、')}`));
    lines.push(list);
  }
  if (user.access?.github_pending) lines.push(element('p', 'GitHub 权限待验证，未计入当前可见项目；用户可在「身份与权限」重新验证。', 'warning'));
  lines.push(element('p', grantSummary(user))); return lines;
}
function userLine(row) {
  return settingsRow(userDisplayName(row), `${row.role === 'super_admin' ? '超级管理员 · 管理全部项目' : '项目管理员'} · ID ${row.id}`, row.role === 'project_admin' ? userAccessLines(row) : [],
    [element('span', row.active ? '已启用' : '已停用', 'status' + (row.active ? ' status-success' : ''))],
    [...(row.role === 'project_admin' ? [button('修改仓库权限', () => editGrants(row))] : []), button('删除', () => deleteUser(row).catch(error), 'quiet destructive')]);
}
async function deleteUser(row) {
  const self = row.id === me.id, kept = '仓库和组织授权、个人看板设置一并去掉，登录名可以重新使用；操作审计保留。';
  const deleted = await askConfirm({ title: self ? `删除你自己的账号 ${userDisplayName(row)}？` : `删除用户 ${userDisplayName(row)}？`, action: '删除', danger: true,
    body: self ? ['只有还剩另一名活跃的超级管理员时才能删除。删除后当前会话立即失效，需要用其他超级管理员登录。', kept] : ['它的会话立即失效。', kept, '不能删除最后一名活跃的超级管理员。'],
    run: () => api('/api/users/' + encodeURIComponent(row.id), 'DELETE', { confirm: true }).catch(err => { throw new Error(removalMessage(err)); }) });
  if (!deleted) return;
  // The session ended with the user; show the login page without calling logout.
  if (self) { renderVersion++; me = null; tab = 'projects'; repositories = []; accounts = []; $('rows').replaceChildren(); }
  await start();
}
async function deleteAccount(row) {
  const kind = row.type === 'github_app' ? 'GitHub App' : '机器人账号';
  const deleted = await askConfirm({ title: `删除${kind} ${row.name}？`, action: '删除', danger: true,
    body: ['只从本系统移除：它的 Webhook 入口、安装同步记录和封存的凭据一并删除。', '不会在 GitHub 上卸载 App，也不会删除任何 GitHub 仓库。', '还有项目使用这个账号时不能删除，需要先删除这些项目。'],
    run: () => api('/api/accounts/' + encodeURIComponent(row.id), 'DELETE', { confirm: true }).catch(err => {
      const used = repositories.filter(repo => repo.account_id === row.id).map(repo => repo.full_name);
      throw new Error(removalMessage(err) + (/account_has_projects/.test(err.message) && used.length ? `（${used.join('、')}）` : ''));
    }) });
  if (deleted) await start();
}
// Removes the project's records, environment and notes without changing anything on GitHub.
async function deleteProjectRecord(row, after) {
  const deleted = await askConfirm({ title: `删除项目 ${row.full_name}？`, action: '删除', danger: true,
    body: ['只从本系统移除：项目环境、长期笔记、项目策略、成员分配、专属模型、公共配置记录、任务记录和安装列表里的这一行一并删除，操作审计保留。',
      '不会在 GitHub 上删除仓库，也不会卸载 App 安装，GitHub 上的内容完全不动。',
      '以后安装同步如果又看到这个仓库，它会像新仓库一样出现；需要时重新启动即可。'],
    run: () => api(`/api/projects/${encodeURIComponent(row.id)}`, 'DELETE', {}).catch(err => { throw new Error(removalMessage(err)); }) });
  if (deleted) await after();
}
