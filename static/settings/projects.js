async function globalProjectSettings(request, id) {
  const selection = card('项目管理');
  selection.append(note('仅超级管理员可配置。项目管理员使用「设置」管理项目策略、模型、角色和成员。'));
  const listing = /^(list|hidden)\.(\d+)$/.exec(id || ''), hidden = listing?.[1] === 'hidden', offset = Number(listing?.[2] || 0);
  // #494: this page keeps only the batch list. app.js sends every numeric project id to the project workspace, and a list
  // offset is the only id the list itself reads, so any other id falls through to the list instead of starting a project
  // load that cannot answer (#/settings/projects/abc and #/settings/projects/0 used to stay at 正在加载…).
  if (!listing) id = null;
  // #747: the batch list asks for one row past the page for the same reason the shared list does — a total that is a
  // multiple of 50 used to add an empty page whose number kept counting.
  const { repositories: received } = await api('/api/installations' + (hidden ? '/hidden' : '') + '?offset=' + offset + '&limit=51');
  const installed = received.slice(0, 50), hasMore = received.length > 50;
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
    } catch (err) { if (request === renderVersion) notice('message', readErrorText(err), '', 'alert'); } finally { control.disabled = false; }
  }), consoleLink('#/settings/projects/' + (hidden ? 'list.0' : 'hidden.0'), hidden ? '返回项目管理' : '管理已隐藏仓库'));
  selection.append(tools, note(`${hidden ? '已隐藏仓库' : '项目'} · 第 ${offset / 50 + 1} 页 · 本页 ${installed.length} 个`));
  for (const row of installed) {
    const item = element('article', '', 'channel-binding global-project-row'); item.dataset.key = row.id; item.dataset.repositoryId = row.id; item.append(element('strong', row.full_name));
    if (hidden) item.append(button('恢复', () => restoreInstalled(row, () => route()).catch(error), 'quiet'));
    else {
      item.append(...installedBadges(row), ...installedIntegration(null, row), projectListControls(row), installedActions(row, () => route()));
      // Only a started repository has a project page; one never started is started from its 启动 action above.
      if (row.registered) item.append(consoleLink('#/projects/' + row.id + '/basic', '全局管理此项目', '启停、删除和公开可见性'));
    }
    selection.append(item);
  }
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
  box.append(note('受信任组织的仓库管理员可以在项目列表里自己启动仓库：模型和是否开启自动开发用下面的默认值，资源用全局默认值，机器配置仍只由超级管理员修改。撤销信任只影响以后的启动，已启动的项目照常运行。'));
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
    const development = document.createElement('input'); development.type = 'checkbox'; development.checked = !!value?.development_enabled;
    const toggle = element('label', '', 'check'); toggle.append(development, document.createTextNode(' 启动时同时开启自动开发'));
    return { model, development, controls: [field('默认模型', model), toggle] };
  };
  const save = async (owner, form) => {
    message.textContent = '';
    try { await api('/api/trusted-organizations/' + owner, 'PUT', { model_id: form.model.value || null, development_enabled: form.development.checked }); await route(); }
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
