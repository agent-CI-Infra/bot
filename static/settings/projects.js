let projectActionsMenuBound = false;
function globalProjectActions(row, actions) {
  const menu = element('div', '', 'project-actions-menu'), panel = element('div', '', 'project-actions-panel');
  const setOpen = open => {
    menu.classList.toggle('open', open); panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  const toggle = button('操作', () => setOpen(!menu.classList.contains('open')), 'quiet project-actions-toggle');
  toggle.setAttribute('aria-label', row.full_name + ' 操作'); toggle.setAttribute('aria-expanded', 'false');
  panel.hidden = true; panel.append(actions); menu.append(toggle, panel);
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); setOpen(false); toggle.focus();
  });
  if (!projectActionsMenuBound) {
    projectActionsMenuBound = true;
    document.addEventListener('click', event => {
      for (const open of document.querySelectorAll('.project-actions-menu.open') ) if (!open.contains(event.target)) {
        open.classList.remove('open'); open.querySelector('.project-actions-panel').hidden = true;
        open.querySelector('.project-actions-toggle').setAttribute('aria-expanded', 'false');
      }
    });
  }
  return menu;
}
function globalProjectRow(row, hidden) {
  const item = element('article', '', 'row project-list-row global-project-row');
  item.setAttribute('role', 'listitem'); item.dataset.key = row.id; item.dataset.repositoryId = row.id;
  const content = element('div', '', 'row-content project-cell'); content.dataset.label = '项目'; content.setAttribute('aria-labelledby', projectColumnId('项目'));
  const heading = element('strong', row.full_name, 'row-title'); heading.title = row.full_name; content.append(heading);
  if (hidden) {
    item.append(content, projectCell('操作', button('恢复', () => restoreInstalled(row, () => route()).catch(error), 'quiet')));
    return item;
  }
  if (row.registered) content.append(consoleLink('#/projects/' + row.id + '/basic', '项目设置', '策略、模型、角色和成员'));
  const detail = element('p', installedDetail(row)); detail.title = detail.textContent; content.append(detail);
  const cells = projectRowCells(row, null, true), board = cells.find(cell => cell.dataset.label === '看板'), permission = cells.find(cell => cell.dataset.label === '权限');
  permission.replaceChildren(permissionCell(row));
  board.replaceChildren(boardChip(row), projectListControls(row, { showStatus: false, showTasks: false }));
  const actions = installedActions(row, () => route(), { includeSettings: false });
  item.append(content, ...cells, projectCell('操作', row.registered ? globalProjectActions(row, actions) : actions));
  return item;
}
async function globalProjectSettings(request, id) {
  const selection = card('项目管理');
  selection.append(note('按统一列查看项目状态并进入管理操作。仅超级管理员可配置；项目管理员请使用项目内的「设置」。'));
  const listing = /^(list|hidden)\.(\d+)$/.exec(id || ''), hidden = listing?.[1] === 'hidden', offset = Number(listing?.[2] || 0);
  // #494: this page keeps only the batch list. app.js sends every numeric project id to the project workspace, and a list
  // offset is the only id the list itself reads, so any other id falls through to the list instead of starting a project
  // load that cannot answer (#/settings/projects/abc and #/settings/projects/0 used to stay at 正在加载…).
  if (!listing) id = null;
  // #747: the batch list asks for one row past the page for the same reason the shared list does — a total that is a
  // multiple of 50 used to add an empty page whose number kept counting.
  const { repositories: received } = await api('/api/installations' + (hidden ? '/hidden' : '') + '?offset=' + offset + '&limit=51');
  const installed = received.slice(0, 50), hasMore = received.length > 50;
  const tools = element('div', '', 'actions');
  tools.append(button('同步安装列表', async event => {
    const control = event.currentTarget, owner = me; control.disabled = true;
    try { const result = await api('/api/installations/sync', 'POST', {}); if (me !== owner) return;
      forgetConsoleGaps(); syncConsoleShell(); if (request !== renderVersion) return; const conclusion = installationSyncNotice(result); notice('message', conclusion.text, conclusion.tone); await route();
    } catch (err) { if (request === renderVersion) notice('message', readErrorText(err), '', 'alert'); } finally { control.disabled = false; }
  }), consoleLink('#/settings/projects/' + (hidden ? 'list.0' : 'hidden.0'), hidden ? '返回项目管理' : '管理已隐藏仓库'));
  selection.append(tools, note(`${hidden ? '已隐藏仓库' : '项目'} · 第 ${offset / 50 + 1} 页 · 本页 ${installed.length} 个`));
  if (installed.length) {
    const table = element('div', '', 'global-project-table' + (hidden ? ' is-hidden' : ''));
    table.setAttribute('role', 'list'); table.setAttribute('aria-label', hidden ? '已隐藏仓库' : '全局项目列表');
    table.append(projectTableHead(hidden ? ['项目', '操作'] : projectColumnLabels));
    for (const row of installed) table.append(globalProjectRow(row, hidden));
    selection.append(table);
  } else selection.append(consoleState(hidden ? '没有已隐藏的仓库' : '还没有项目', hidden ? '当前没有从项目列表隐藏的仓库。' : '安装 GitHub App 后，仓库会出现在这里。'));
  const prefix = '#/settings/projects/' + (hidden ? 'hidden.' : 'list.');
  const paging = element('nav', '', 'actions'); paging.setAttribute('aria-label', '全局项目分页');
  if (offset) paging.append(consoleLink(prefix + Math.max(0, offset - 50), '上一页'));
  if (hasMore) paging.append(consoleLink(prefix + (offset + 50), '下一页')); selection.append(paging);
  if (!hidden) void api('/api/integrations').then(result => {
    if (request === renderVersion) updateIntegrationChips(result.integrations || []);
  }).catch(() => { if (request === renderVersion) updateIntegrationChips(installed.map(row => ({ repository_id: row.id, gate_state: 'unknown' }))); });
  return hidden ? [selection] : [selection, await trustedOrganizations(request)];
}
// #848: GitHub owners (organizations or personal accounts) whose repository administrators start their own repositories.
async function trustedOrganizations(request) {
  const box = card('受信任的组织');
  box.append(note('受信任组织的仓库管理员可以在项目列表里自己启动仓库：模型和能力上限用下面的默认值，资源用全局默认值，机器配置仍只由超级管理员修改。撤销信任只影响以后的启动，已启动的项目照常运行。'));
  // A failed read stays inside this card: the project list above keeps working.
  let organizations, candidates, models;
  try { [{ organizations, candidates }, { models }] = await Promise.all([api('/api/trusted-organizations'), api('/api/models')]); }
  catch (err) { box.append(consoleState('受信任的组织读取失败', readErrorText(err), { tone: 'error', retry: () => route() })); return box; }
  if (request !== renderVersion) return box;
  const message = element('p', '', 'view-error'); message.setAttribute('role', 'alert');
  const shared = models.filter(model => model.repository_id === null);
  const defaults = (owner, value) => {
    const model = document.createElement('select'); model.setAttribute('aria-label', `${owner} 的默认模型`);
    model.add(new Option('不设默认模型（项目会等待模型配置）', '')); shared.forEach(m => model.add(new Option(m.model_name, m.id))); model.value = value?.model?.id || '';
    // #850: projects started under the organization get this capability ceiling.
    const ceiling = document.createElement('select'); ceiling.setAttribute('aria-label', `${owner} 的默认能力上限`);
    projectCeilingOptions.forEach(([level, title]) => ceiling.add(new Option(title, level))); ceiling.value = value?.capability_ceiling || 'comment';
    return { model, ceiling, controls: [field('默认模型', model), field('默认能力上限', ceiling)] };
  };
  const save = async (owner, form) => {
    message.textContent = '';
    try { await api('/api/trusted-organizations/' + owner, 'PUT', { model_id: form.model.value || null, capability_ceiling: form.ceiling.value }); await route(); }
    catch (err) { if (request === renderVersion) message.textContent = readErrorText(err); }
  };
  for (const organization of organizations) {
    const item = element('article', '', 'channel-binding trusted-organization'), form = defaults(organization.owner_login, organization);
    item.dataset.key = organization.owner_id;
    const actions = element('div', '', 'actions');
    actions.append(button('保存默认值', () => save(organization.owner_id, form)),
      button('撤销信任', async () => {
        if (!await askConfirm({ title: `撤销对 ${organization.owner_login} 的信任？`, body: ['之后它的仓库管理员不能再自己启动仓库；已启动的项目照常运行。'], action: '撤销信任', danger: true })) return;
        try { await api('/api/trusted-organizations/' + organization.owner_id, 'DELETE', {}); await route(); }
        catch (err) { if (request === renderVersion) message.textContent = readErrorText(err); }
      }, 'quiet destructive'));
    item.append(element('strong', organization.owner_login), note(`由 ${organization.trusted_by || '超级管理员'} 于 ${timestamp(Date.parse(organization.trusted_at))} 信任`), ...form.controls, actions);
    box.append(item);
  }
  if (!organizations.length) box.append(note('还没有受信任的组织；启动某个组织的第一个仓库时也可以勾选信任它。'));
  if (candidates.length) {
    const owner = document.createElement('select'); owner.setAttribute('aria-label', '要信任的组织');
    candidates.forEach(candidate => owner.add(new Option(`${candidate.owner_login}（${candidate.repositories} 个已安装仓库）`, candidate.owner_id)));
    const form = defaults('新组织'), add = element('div', '', 'trusted-organization-add');
    const actions = element('div', '', 'actions'); actions.append(button('信任', () => save(owner.value, form)));
    add.append(element('h4', '信任一个组织'), field('组织', owner), ...form.controls, actions);
    box.append(add);
  }
  box.append(message);
  return box;
}
