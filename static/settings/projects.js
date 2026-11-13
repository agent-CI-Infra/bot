async function globalProjectSettings(request, id) {
  const selection = card('项目管理');
  selection.append(note('仅超级管理员可配置。项目管理员使用「设置」管理项目策略、模型、角色和成员。'));
  const listing = /^(list|hidden)\.(\d+)$/.exec(id || ''), hidden = listing?.[1] === 'hidden', offset = Number(listing?.[2] || 0);
  // #494: this page keeps only the batch list. app.js sends every numeric project id to the project workspace, and a list
  // offset is the only id the list itself reads, so any other id falls through to the list instead of starting a project
  // load that cannot answer (#/settings/projects/abc and #/settings/projects/0 used to stay at 正在加载…).
  if (!listing) id = null;
  const { repositories: installed } = await api('/api/installations' + (hidden ? '/hidden' : '') + '?offset=' + offset + '&limit=50');
  const selector = document.createElement('select'); selector.setAttribute('aria-label', '全局设置中的项目');
  selector.add(new Option('选择项目', ''));
  for (const repo of installed) selector.add(new Option(repo.full_name, repo.id)); selector.value = '';
  // #480: a single project is edited only in the project workspace; the list stays the batch surface.
  selector.addEventListener('change', () => { location.hash = selector.value ? '#/projects/' + selector.value + '/basic' : '#/settings/projects'; });
  selection.append(field('选择项目', selector));
  const tools = element('div', '', 'actions');
  tools.append(button('同步安装列表', async event => {
    const control = event.currentTarget, owner = me; control.disabled = true;
    try { const result = await api('/api/installations/sync', 'POST', {}); if (me !== owner) return;
      forgetConsoleGaps(); syncConsoleShell(); if (request !== renderVersion) return; const conclusion = installationSyncNotice(result); notice('message', conclusion.text, conclusion.tone); await route();
    } catch (err) { if (request === renderVersion) notice('message', err.message); } finally { control.disabled = false; }
  }), consoleLink('#/settings/projects/' + (hidden ? 'list.0' : 'hidden.0'), hidden ? '返回项目管理' : '管理已隐藏仓库'));
  selection.append(tools, note(`${hidden ? '已隐藏仓库' : '项目'} · 第 ${offset / 50 + 1} 页 · 本页 ${installed.length} 个`));
  for (const row of installed) {
    const item = element('article', '', 'channel-binding global-project-row'); item.dataset.key = row.id; item.dataset.repositoryId = row.id; item.append(element('strong', row.full_name));
    if (hidden) item.append(button('恢复', () => restoreInstalled(row, () => route()).catch(error), 'quiet'));
    else item.append(...installedBadges(row), ...installedIntegration(null, row), projectListControls(row), installedActions(row, () => route()), consoleLink('#/projects/' + row.id + '/basic', '全局管理此项目', '启停、删除和公开可见性'));
    selection.append(item);
  }
  const prefix = '#/settings/projects/' + (hidden ? 'hidden.' : 'list.');
  const paging = element('nav', '', 'actions'); paging.setAttribute('aria-label', '全局项目分页');
  if (offset) paging.append(consoleLink(prefix + Math.max(0, offset - 50), '上一页'));
  if (installed.length === 50) paging.append(consoleLink(prefix + (offset + 50), '下一页')); selection.append(paging);
  if (!hidden) void api('/api/integrations').then(result => {
    if (request === renderVersion) updateIntegrationChips(result.integrations || []);
  }).catch(() => { if (request === renderVersion) updateIntegrationChips(installed.map(row => ({ repository_id: row.id, gate_state: 'unknown' }))); });
  return [selection];
}
