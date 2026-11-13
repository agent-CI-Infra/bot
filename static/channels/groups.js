const participationOptions = [['mentions', '仅回应 @'], ['questions', '回应 @ 及以问号结尾的文字'], ['all', '读取每条新文字后判断是否发言']];
const bindingStates = { active: '生效中', paused: '已暂停', disabled: '已停用' };

// Group bindings list + on-demand creator/permission editor.
async function buildGroupBindingsSection(data, { initialOpen = false, initialChat = null } = {}) {
  const root = element('div'), editorWrap = element('div', '', 'feishu-creator-panel'), form = element('form', '', 'project-form');
  editorWrap.id = 'feishu-group-editor';
  editorWrap.hidden = !initialOpen;

  const editorHead = element('div', '', 'feishu-creator-head'), editorTitle = element('strong', '创建群绑定');
  editorHead.append(editorTitle, button('收起配置', () => { editorWrap.hidden = true; }, 'quiet'));
  editorWrap.append(editorHead,
    note('第一个配置的维护人成为该群助手负责人（需已绑定个人飞书、在该群中，并对所选仓库或组织有配置权限）；之后负责人、所属组织管理员和超级管理员均可在此修改仓库范围与服务角色。'));

  const chatOrganization = new Map([...data.chats.map(c => [c.id, c.organization || null]), ...data.bindings.map(b => [b.chat_id, b.chat.organization || null])]);
  const profiles = new Map([...data.chats.map(c => [c.id, c]), ...data.bindings.map(b => [b.chat_id, b.chat])]);
  const chatLabel = c => `${channelChatName(c)} · ${c.tenant_name || '企业名称暂未获取'} · ${c.app_name || '机器人名称暂未获取'} · ${c.chat_id}`;
  const chats = new Map([...profiles].map(([id, c]) => [id, chatLabel(c)]));
  const chat = channelSelect(form, '助手所在群', 'binding_chat', [...chats]);
  const updateOption = selected => { const option = [...chat.options].find(o => o.value === selected.id); if (option) option.textContent = chatLabel(selected); };
  const request = renderVersion;
  for (const selected of profiles.values()) if (!selected.display_name && selected.can_refresh_name) {
    void channelNameRequest('/api/channels/chats/' + encodeURIComponent(selected.id) + '/name').then(result => {
      if (request === renderVersion) { Object.assign(selected, result); updateOption(selected); }
    }).catch(() => {});
  }
  const profile = element('div'); form.append(profile);
  const showProfile = () => {
    const selected = profiles.get(chat.value); profile.replaceChildren();
    if (selected) profile.append(channelProfileDetails(selected, () => updateOption(selected)));
  };
  chat.addEventListener('change', showProfile);

  // Repository / Organization scope controls
  const scope = element('fieldset', '', 'role-choices'); scope.append(element('legend', '仓库与组织权限范围'));
  const kind = name => { const control = document.createElement('input'); control.type = 'radio'; control.name = 'binding_scope'; control.value = name; return control; };
  const repositoriesKind = kind('repositories'), organizationKind = kind('organization');
  const repositoriesLabel = element('label', '', 'check'), organizationLabel = element('label', '', 'check');
  repositoriesLabel.append(repositoriesKind, ' 选择仓库（按仓库精细授权）');
  organizationLabel.append(organizationKind, ' 整个组织（覆盖该组织全部可配置仓库）');

  const repositoriesWrap = element('div', '', 'feishu-repo-picker');
  const repoFilter = data.projects.length > 5 ? input('binding_repo_filter', '', { type: 'search', placeholder: '输入仓库名称筛选…' }) : null;
  if (repoFilter) repoFilter.setAttribute('aria-label', '筛选可选择的仓库');
  const repoCounter = note('');
  const repositories = element('div', '', 'role-choices feishu-repo-grid'); repositories.setAttribute('aria-label', '可选择的仓库');
  const boxes = new Map(data.projects.map(p => {
    const wrap = checkbox('binding_repository:' + p.id, false, p.full_name);
    repositories.append(wrap); return [p.id, wrap.querySelector('input')];
  }));
  const projectOrganization = new Map(data.projects.map(p => [p.id, p.organization]));

  const updateRepoCounter = () => {
    const allowed = [...boxes.values()].filter(control => control.closest('label').dataset.orgHidden !== '1');
    const checked = allowed.filter(control => control.checked);
    repoCounter.textContent = allowed.length ? `已勾选 ${checked.length} / ${allowed.length} 个你有配置权限的仓库` : '当前群所属组织下暂无可配置仓库';
  };
  const applyRepoVisibility = () => {
    const keyword = repoFilter ? repoFilter.value.trim().toLocaleLowerCase() : '';
    for (const [, control] of boxes) {
      const labelNode = control.closest('label');
      const orgHidden = labelNode.dataset.orgHidden === '1';
      const filterHidden = !!keyword && !labelNode.textContent.toLocaleLowerCase().includes(keyword);
      labelNode.hidden = orgHidden || filterHidden;
    }
    updateRepoCounter();
  };
  if (repoFilter) repoFilter.addEventListener('input', applyRepoVisibility);
  for (const [, control] of boxes) control.addEventListener('change', updateRepoCounter);

  const repoToolbar = element('div', '', 'actions');
  if (data.projects.length > 2) {
    repoToolbar.append(
      button('全选可见仓库', () => { for (const [, c] of boxes) if (!c.closest('label').hidden) c.checked = true; updateRepoCounter(); }, 'quiet'),
      button('清空勾选', () => { for (const [, c] of boxes) c.checked = false; updateRepoCounter(); }, 'quiet')
    );
  }
  if (repoFilter) repositoriesWrap.append(repoFilter);
  if (repoToolbar.childElementCount) repositoriesWrap.append(repoToolbar);
  repositoriesWrap.append(repoCounter, repositories);

  const organization = document.createElement('select'); organization.setAttribute('aria-label', '组织');
  for (const o of data.organizations) organization.add(new Option(o.name, o.id));
  organizationKind.disabled = !data.organizations.length;
  const organizationField = field('组织', organization), orgScopeNote = note('');
  const updateOrgNote = () => {
    const orgId = organization.value, count = data.projects.filter(p => p.organization === orgId).length;
    orgScopeNote.textContent = orgId ? `当前按整个组织授权（覆盖你在该组织下可配置的 ${count} 个仓库）。如需仅开放部分仓库，请切换上方「选择仓库」逐个勾选。` : '';
  };
  organization.addEventListener('change', updateOrgNote);
  scope.append(repositoriesLabel, repositoriesWrap, organizationLabel, organizationField, orgScopeNote,
    ...(data.organizations.length ? [] : [note('你没有组织级配置权限，只能按单个仓库勾选。')]));
  form.append(scope);

  // Service role & concrete permissions
  const role = channelSelect(form, '服务角色', 'binding_role', data.service_roles.map(r => [r.id, r.name + (r.recommended ? '（推荐）' : '')]));
  const roleNote = note(''), rolePermTags = element('div', '', 'feishu-perm-tags');
  form.append(roleNote, rolePermTags, note(me.role === 'super_admin'
    ? '群聊助手的实际操作权限 = 所选「服务角色权限」∩ 上方「仓库访问范围」。如需开启 GitHub 写入、任务创建或派活，可在「全局设置 → 服务角色」新增或调整角色。'
    : '群聊助手的实际操作权限 = 所选「服务角色权限」∩ 上方「仓库访问范围」。如需可写或可派活角色，请联系超级管理员在「全局设置 → 服务角色」中配置。'));

  const participation = channelSelect(form, '助手发言范围', 'binding_participation', participationOptions);
  form.append(note('注意：群内所有成员都能看到助手读取的所选仓库内容（包括私有仓库），由配置人负责控制范围。所有获准消息都会存入本地；扩大发言范围会增加模型用量，用量记在服务角色上，不计入项目。'));
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const ownership = note(''); ownership.setAttribute('role', 'status');
  const save = element('button', '保存群聊助手'); save.type = 'submit';
  const submitActions = element('div', '', 'actions');
  submitActions.append(save, button('取消', () => { editorWrap.hidden = true; }, 'quiet'));
  form.append(ownership, status, submitActions);

  let expected = 0;
  const unavailable = !chats.size || !data.service_roles.length || !data.projects.length && !data.organizations.length;
  const roleById = new Map(data.service_roles.map(r => [r.id, r]));
  const formatRoleSummary = roleId => {
    const r = roleById.get(roleId);
    if (!r) return '角色已停用或不可用';
    return data.permission_items.map(item => `${item.name} ${permissionModeLabels[r.permissions[item.id]] || r.permissions[item.id] || '无权限'}`).join('；');
  };
  const describeRole = () => {
    const r = roleById.get(role.value);
    rolePermTags.replaceChildren();
    if (!r) { roleNote.textContent = ''; return; }
    roleNote.textContent = `${r.responsibility || '自定义服务角色'} 权限：${formatRoleSummary(r.id)}。`;
    for (const item of data.permission_items) {
      const mode = r.permissions[item.id] || 'none', active = mode !== 'none' && mode !== 'deny';
      rolePermTags.append(element('span', `${item.name}：${permissionModeLabels[mode] || mode}`, 'feishu-perm-tag' + (active ? ' feishu-perm-tag-active' : '')));
    }
  };
  const showScope = () => {
    repositoriesWrap.hidden = !repositoriesKind.checked;
    organizationField.hidden = !organizationKind.checked;
    orgScopeNote.hidden = !organizationKind.checked;
    updateOrgNote();
  };
  const fill = () => {
    const current = data.bindings.find(b => b.chat_id === chat.value), organizationOnly = chatOrganization.get(chat.value) || null;
    expected = current?.revision || 0;
    editorTitle.textContent = current ? `配置仓库与权限 · ${channelChatName(current.chat)}` : '创建群绑定';
    // An organization app's group offers only that organization's repositories and the organization itself.
    for (const [id, control] of boxes) {
      const hidden = !!organizationOnly && projectOrganization.get(id) !== organizationOnly;
      control.closest('label').dataset.orgHidden = hidden ? '1' : '0';
      if (hidden) control.checked = false;
    }
    for (const option of organization.options) option.disabled = !!organizationOnly && option.value !== organizationOnly;
    if (organizationOnly && [...organization.options].some(o => o.value === organizationOnly)) organization.value = organizationOnly;
    organizationKind.disabled = !data.organizations.some(o => !organizationOnly || o.id === organizationOnly);
    const locked = !!current && !current.can_manage;
    ownership.textContent = locked ? `这个群的助手由 ${current.owner || '原负责人'} 负责；只有负责人、所属组织的管理员和超级管理员可以修改。` : current?.owner ? '负责人：' + current.owner : '';
    save.disabled = unavailable || locked;
    role.value = current?.enabled && data.service_roles.some(r => r.id === current.service_role.id) ? current.service_role.id : (data.service_roles.find(r => r.recommended) || data.service_roles[0])?.id || '';
    participation.value = current?.participation || 'mentions';
    const org = current?.enabled && current.scope.organization;
    organizationKind.checked = !!org && !organizationKind.disabled; repositoriesKind.checked = !organizationKind.checked;
    if (org) organization.value = org.id;
    for (const [id, control] of boxes) control.checked = !!current?.enabled && current.scope.repositories.some(r => r.id === id);
    showProfile(); applyRepoVisibility(); describeRole(); showScope();
  };
  for (const control of [repositoriesKind, organizationKind]) control.addEventListener('change', showScope);
  role.addEventListener('change', describeRole); chat.addEventListener('change', fill);
  save.disabled = unavailable;
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '正在核验你的飞书绑定、群成员身份和所选范围的配置权限…';
    const selected = organizationKind.checked ? { kind: 'organization', organization: organization.value } : { kind: 'repositories', repositories: [...boxes].filter(([, control]) => control.checked).map(([id]) => id) };
    try {
      await api('/api/channels/chats/' + chat.value + '/service-binding', 'PUT', { service_role_id: role.value, scope: selected, participation: participation.value, enabled: true, expected_revision: expected });
      if (location.hash.includes('?')) history.replaceState(null, '', '#/identity/feishu');
      await start();
    } catch (err) { status.textContent = employeeError(err.message); save.disabled = false; }
  });

  if (!chats.size) editorWrap.append(note('尚无可选择的群。请先完成个人绑定，在机器人已加入的目标群发一条消息，再刷新本页。'));
  if (!data.projects.length && !data.organizations.length) editorWrap.append(note('当前没有可配置的仓库。个人绑定不会增加项目权限。'));
  if (!data.service_roles.length) editorWrap.append(note('当前没有可用于群聊的服务角色，请联系超级管理员。'));
  editorWrap.append(form);

  const selectTargetChat = targetChatId => {
    if (targetChatId && [...chat.options].some(o => o.value === targetChatId)) chat.value = targetChatId;
    else if (!targetChatId) {
      const unbound = data.chats.find(c => !data.bindings.some(b => b.chat_id === c.id && b.enabled));
      if (unbound && [...chat.options].some(o => o.value === unbound.id)) chat.value = unbound.id;
    }
    if (chats.size) fill();
  };
  selectTargetChat(initialChat);

  const openEditor = (targetChatId = null) => {
    editorWrap.hidden = false;
    status.textContent = '';
    selectTargetChat(targetChatId);
    editorWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    (targetChatId ? repositoriesKind : chat).focus({ preventScroll: true });
  };

  root.append(editorWrap);

  const list = element('div', '', 'feishu-binding-list');
  list.setAttribute('aria-label', '飞书群绑定列表');
  if (!data.bindings.length) {
    list.append(element('p', '当前尚无已绑定的飞书群。点击「创建群绑定」可为机器人所在群配置仓库范围与角色权限。', 'muted'));
  }

  for (const b of data.bindings) {
    const row = element('article', '', 'feishu-binding-row channel-binding');
    const scopeText = b.scope.organization ? '整个组织 ' + b.scope.organization.name : b.scope.repositories.map(r => r.full_name).join('、');
    const canViewChat = b.can_view !== false;
    row.setAttribute('aria-label', '群聊助手绑定');
    if (canViewChat) {
      row.classList.add('feishu-binding-clickable');
      makeFeishuRowClickable(row, () => '#/conversations/' + b.chat_id);
    }

    const mainRow = element('div', '', 'feishu-row-main'), info = element('div', '', 'feishu-row-info'), actions = element('div', '', 'actions feishu-row-actions');
    const titleWrap = element('div', '', 'feishu-row-title'), groupName = element('strong', channelChatName(b.chat));
    const badge = element('span', `${bindingStates[b.state] || b.state} · ${b.service_role.name || '服务角色已删除'}`,
      'feishu-binding-badge' + (b.state === 'active' ? '' : ' feishu-binding-badge-muted'));
    titleWrap.append(groupName, badge);

    info.append(titleWrap,
      note('项目范围：' + scopeText),
      ...(b.scope.organization && b.enabled ? [note(b.reachable.length ? `可达仓库（${b.reachable.length}）：${b.reachable.join('、')}` : '当前组织范围下暂无可达仓库')] : []),
      note('角色权限：' + formatRoleSummary(b.service_role.id)),
      note('发言范围：' + (participationOptions.find(([id]) => id === b.participation)?.[1] || b.participation)),
      note(`负责人：${b.owner || '账户已删除'}${b.configured_by && b.configured_by !== b.owner ? '；最近修改：' + b.configured_by : ''}`),
      channelProfileDetails(b.chat, () => { groupName.textContent = channelChatName(b.chat); updateOption(b.chat); }),
      ...(b.paused.length ? [note('暂停的仓库（配置人权限已变化）：' + b.paused.join('、'))] : []),
      ...(b.migrated ? [note('由旧群员工自动迁移为仓库问答助手。')] : []),
      ...(b.error ? [note(employeeError(b.error))] : []),
      ...(!canViewChat ? [note('需要该群负责人或拥有全部绑定范围的配置权限才能查看聊天记录。')] : []));

    const scheduleDrawer = element('div', '', 'feishu-row-drawer'); scheduleDrawer.hidden = true;
    const transferDrawer = element('div', '', 'feishu-row-drawer'); transferDrawer.hidden = true;

    if (canViewChat) actions.append(channelLink('#/conversations/' + b.chat_id, '查看聊天记录', 'button-link quiet'));
    if (b.can_manage) actions.append(button(b.enabled ? '配置仓库与权限' : '重新启用并配置', () => openEditor(b.chat_id), 'quiet'));
    if (b.enabled && b.can_manage) {
      actions.append(button('定时任务', async () => {
        scheduleDrawer.hidden = !scheduleDrawer.hidden;
        if (!scheduleDrawer.hidden && !scheduleDrawer.dataset.loaded) {
          scheduleDrawer.dataset.loaded = '1';
          scheduleDrawer.replaceChildren(note('正在读取定时任务…'));
          scheduleDrawer.replaceChildren(await channelSchedules(b.chat_id));
        }
      }, 'quiet'));
    }
    if (b.can_transfer) {
      transferDrawer.append(channelOwnerTransfer(b));
      actions.append(button('转交负责人', () => { transferDrawer.hidden = !transferDrawer.hidden; }, 'quiet'));
    }
    if (b.enabled && b.can_manage) {
      actions.append(button('停用群聊助手', async () => {
        try { await api('/api/channels/chats/' + b.chat_id + '/service-binding', 'PUT', { enabled: false, expected_revision: b.revision }); await start(); }
        catch (err) { error(err); }
      }, 'quiet'));
    }

    mainRow.append(info, actions);
    row.append(mainRow, transferDrawer, scheduleDrawer);
    list.append(row);
  }
  root.append(list);

  const legacy = data.legacy_employees.filter(g => g.enabled);
  if (legacy.length) {
    const old = element('div', '', 'feishu-binding-list'); old.append(element('h4', '旧群员工'), note('旧群员工已不再接收群消息，只用于继续核验升级前已创建的任务。确认这些任务不再需要后可以停用。'));
    for (const g of legacy) {
      const row = element('article', '', 'feishu-binding-row channel-binding');
      row.append(element('strong', `仍有效 · ${g.full_name} · ${g.role_id}`), note(`未结束的任务：${g.open_tasks} 个`), button('停用旧群员工授权', async () => {
        try { await api('/api/channels/chats/' + g.chat_id + '/employee', 'PUT', { project_id: g.project_id, enabled: false, expected_revision: g.revision }); await start(); }
        catch (err) { error(err); }
      }, 'quiet'));
      old.append(row);
    }
    root.append(old);
  }

  return { root, editorWrap, openEditor };
}

