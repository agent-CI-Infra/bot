const participationOptions = [['mentions', '仅回应 @'], ['questions', '回应 @、提问或求助的文字'], ['all', '读取每条新文字后判断是否发言']];
const bindingStates = { active: '生效中', paused: '已暂停', disabled: '已停用' };
// Group binding permissions are split into three orthogonal dimensions (#1206): GitHub, project tasks, and platform capabilities.
const githubLevelOptions = [
  ['read', '只读', '读取范围内仓库的 Issue、PR、代码、Actions 和检查状态；不写 GitHub。'],
  ['comment', 'Issue / PR / Actions 读写', '可以在 Issue 和 PR 上评论、加删标签、指派人、新建和修改 Issue，开 PR、发检视（含批准和要求修改）、请求检视人，并触发、重跑或取消 Actions 工作流（例如「跑一下 Nightly」）。不含 Contents 写，不能改代码或合并。'],
  ['custom', '逐项设置', '按下面 6 项 GitHub 资源分别选择。Contents 读写（提交文件、推送分支；在群里合并 PR 另需 Pull Request 读写并按项目的自动合并策略）只能在这里打开。'],
];
const groupTaskOptions = [
  ['none', '不可访问', '无法查看、创建或管理项目任务。'],
  ['read', '只读', '查看范围内任务的列表、进展与详情。'],
  ['create', '只读 + 可新增', '查看范围内任务，经 Manager 派活，只能给本群创建的任务补充说明或取消；开发任务按项目测试与 QA 流程开 bot PR（需项目能力上限为开发），不依赖本群 Contents 写权限。'],
  ['write', '完全可读写', '查看和创建任务，还可暂停、重试、取消、补充说明或修改范围内任何任务的约定。'],
];
const groupQuickPresets = [
  { name: '只读问答', github: 'read', task: 'none', platform: { project_memory: 'read', project_configuration: 'none', schedules: 'none' } },
  { name: '只读 + 可派活', github: 'read', task: 'create', platform: { project_memory: 'read', project_configuration: 'none', schedules: 'none' } },
  { name: '可协作 + 可派活', github: 'comment', task: 'create', platform: { project_memory: 'read', project_configuration: 'none', schedules: 'none' } },
];
function groupTaskScope(binding) {
  const option = groupTaskOptions.find(([id]) => id === binding.task_mode);
  if (option) return option[1] + ' · ' + option[2];
  const p = binding.permissions, legacy = p.project_tasks === 'custom', tasks = legacy ? p.legacy_project_tasks : p.project_tasks;
  const controls = legacy && p.legacy_delegation_controls === 'allow';
  const rights = [p.delegation === 'allow' && '新建任务', (controls || ['read', 'write'].includes(tasks)) && '查看任务',
    (controls || tasks === 'write') && '追加说明和取消', (controls || tasks === 'write' && !legacy) && '修改约定', tasks === 'write' && '暂停和重试'];
  return '保留旧权限 · ' + (rights.filter(Boolean).join('、') || '无法访问任务');
}
function groupTaskShort(binding) {
  const option = groupTaskOptions.find(([id]) => id === binding.task_mode);
  return option ? option[1] : groupTaskScope(binding);
}
const githubLevelName = level => githubLevelOptions.find(([id]) => id === level)?.[1] || level;
const groupPermissionModeLabels = { none: '无权限', read: '只读', write: '读写', deny: '不允许', allow: '允许', custom: '保留旧权限' };
// Per-item controls for one permission group (GitHub items when custom, or platform capabilities directly visible).
function bindingGroupItemsEditor(permissions, items, group) {
  const wrap = element('div', '', 'role-permissions');
  for (const item of items.filter(item => item.group === group && item.id !== 'project_tasks')) {
    const choices = item.modes.map(mode => [mode, groupPermissionModeLabels[mode] || mode]);
    if (permissions[item.id] === 'custom') choices.unshift(['custom', groupPermissionModeLabels.custom]);
    const select = document.createElement('select');
    select.setAttribute('aria-label', item.name);
    for (const [value, caption] of choices) select.add(new Option(caption, value));
    select.value = permissions[item.id] ?? item.modes[0];
    select.addEventListener('change', () => { permissions[item.id] = select.value; });
    const row = element('div', '', 'role-permission-row');
    row.append(field(item.name, select), note(item.detail));
    wrap.append(row);
  }
  return wrap;
}
// A refused save in words, naming the projects that do not fit the chosen role (#849).
function bindingSaveError(err) {
  const projects = (err.detail?.projects || []).join('、');
  if (err.code === 'service_role_project_scope') return `「${err.detail?.project || '所选项目'}」的专属助手角色只能用于范围只有这个项目的群${projects ? `；${projects} 不属于它` : ''}。请改选全局角色，或把范围缩小到这个项目。`;
  if (err.code === 'channel_service_model_unavailable') return `所选助手角色的模型没有授权给 ${projects || '范围内的部分项目'}。群助手只能用对范围内每个项目都可用的模型：请换一个角色，或请超级管理员把共享模型授权给这些项目。`;
  return employeeError(readErrorText(err));
}
function bindingGithubSummary(b, items) {
  if (b.github_level && b.github_level !== 'custom') return githubLevelName(b.github_level);
  const open = items.filter(item => item.group === 'github' && !['none', 'deny'].includes(b.permissions[item.id])).map(item => `${item.name} ${groupPermissionModeLabels[b.permissions[item.id]] || b.permissions[item.id]}`);
  return '逐项：' + (open.join('；') || '全部无权限');
}
function bindingPlatformSummary(b, items) {
  const open = items.filter(item => item.group === 'platform' && item.id !== 'project_tasks' && !['none', 'deny'].includes(b.permissions[item.id]))
    .map(item => `${item.name} ${groupPermissionModeLabels[b.permissions[item.id]] || b.permissions[item.id]}`);
  return open.length ? open.join('；') : '未开放额外平台能力';
}
function bindingStateBadgeClass(state) {
  if (state === 'active') return 'feishu-binding-badge feishu-binding-badge-success';
  if (state === 'paused') return 'feishu-binding-badge feishu-binding-badge-warning';
  return 'feishu-binding-badge feishu-binding-badge-muted';
}

// Standalone group binding configuration view (#/identity/feishu/groups/new or #/identity/feishu/groups/<chat-id>).
function buildGroupBindingEditor(data, { targetChatId = null, onClose = () => { location.hash = '#/identity/feishu'; } } = {}) {
  const section = element('section', '', 'side-card feishu-group-editor-card');
  section.id = 'feishu-group-editor';
  const form = element('form', '', 'project-form');

  const head = element('div', '', 'feishu-detail-head');
  const titleWrap = element('div', '', 'feishu-detail-title');
  const editorTitle = element('h2', '创建群绑定');
  titleWrap.append(editorTitle);
  head.append(titleWrap, channelLink('#/identity/feishu', '← 返回飞书绑定', 'button-link quiet'));
  section.append(head,
    note('第一个配置的维护人成为该群助手负责人（需已绑定个人飞书、在该群中，并对所选仓库或组织有配置权限）；之后负责人、所属组织管理员和超级管理员均可在此修改仓库范围、权限与助手角色。'));

  const chatOrganization = new Map([...data.chats.map(c => [c.id, c.organization || null]), ...data.bindings.map(b => [b.chat_id, b.chat.organization || null])]);
  const profiles = new Map([...data.chats.map(c => [c.id, c]), ...data.bindings.map(b => [b.chat_id, b.chat])]);
  const chatLabel = c => `${channelChatName(c)} · ${c.tenant_name || '企业名称暂未获取'} · ${c.app_name || '机器人名称暂未获取'} · ${c.chat_id}`;
  const chats = new Map([...profiles].map(([id, c]) => [id, chatLabel(c)]));
  const chat = channelSelect(form, '助手所在群', 'binding_chat', [...chats]);
  const updateOption = selected => { const option = [...chat.options].find(o => o.value === selected.id); if (option) option.textContent = chatLabel(selected); };
  const request = renderVersion;
  for (const selected of profiles.values()) if (!selected.display_name && selected.can_refresh_name && channelNameAutoRead(selected)) {
    void channelNameRequest('/api/channels/chats/' + encodeURIComponent(selected.id) + '/name').then(result => {
      channelNameFailures.delete(channelNameKey(selected));
      if (request === renderVersion) { Object.assign(selected, result); updateOption(selected); }
    }).catch(() => { channelNameFailures.add(channelNameKey(selected)); });
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
  const projectById = new Map(data.projects.map(p => [p.id, p]));
  const boxes = new Map(data.projects.map(p => {
    const wrap = checkbox('binding_repository:' + p.id, false, p.full_name);
    repositories.append(wrap); return [p.id, wrap.querySelector('input')];
  }));
  const projectOrganization = new Map(data.projects.map(p => [p.id, p.organization]));

  let updateRoleLinks = () => {};
  const updateRepoCounter = () => {
    const allowed = [...boxes.values()].filter(control => control.closest('label').dataset.orgHidden !== '1');
    const checked = allowed.filter(control => control.checked);
    repoCounter.textContent = allowed.length ? `已勾选 ${checked.length} / ${allowed.length} 个你有配置权限的仓库` : '当前群所属组织下暂无可配置仓库';
    updateRoleLinks();
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
      button('清空勾选', () => { for (const [, c] of boxes) c.checked = false; updateRepoCounter(); }, 'quiet'),
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

  // Decoupled group permissions (#1206): quick presets fill the three orthogonal dimensions below without locking them together.
  const githubItems = data.permission_items.filter(item => item.group === 'github');
  const platformItems = data.permission_items.filter(item => item.group === 'platform' && item.id !== 'project_tasks');
  const githubPresetOf = id => data.github_levels?.find(level => level.id === id)?.permissions
    || Object.fromEntries(githubItems.map(item => [item.id, id === 'comment' && ['github_issues', 'github_pull_requests', 'github_actions'].includes(item.id) ? 'write' : 'read']));
  const defaultPermissions = () => ({ ...(data.default_permissions || {
    ...githubPresetOf('read'), project_tasks: 'none', project_memory: 'read', project_configuration: 'none', schedules: 'none',
  }) });

  const githubFieldset = element('fieldset', '', 'feishu-level-choices'); githubFieldset.append(element('legend', 'GitHub 权限'));
  const githubControls = new Map(), githubItemsWrap = element('div', '', 'feishu-level-items');
  let githubEdited = {}, githubStartFrom = null, platformEdited = {};
  for (const [id, title, detail] of githubLevelOptions) {
    const control = document.createElement('input'); control.type = 'radio'; control.name = 'binding_github_level'; control.value = id;
    const label = element('label', '', 'check'); label.append(control, ' ' + title);
    githubFieldset.append(label, note(detail)); githubControls.set(id, control);
  }
  const chosenGithubLevel = () => [...githubControls].find(([, control]) => control.checked)?.[0] || 'read';
  const showGithubItems = () => {
    githubItemsWrap.hidden = chosenGithubLevel() !== 'custom';
    if (!githubItemsWrap.hidden && !githubItemsWrap.childElementCount) {
      githubEdited = Object.fromEntries(githubItems.map(item => [item.id, githubStartFrom?.[item.id] ?? 'read']));
      githubItemsWrap.append(bindingGroupItemsEditor(githubEdited, data.permission_items, 'github'));
    }
  };
  for (const [id, control] of githubControls) control.addEventListener('change', () => {
    if (id !== 'custom') { githubStartFrom = { ...githubPresetOf(id) }; githubItemsWrap.replaceChildren(); }
    showGithubItems();
  });
  githubFieldset.append(githubItemsWrap);

  const taskModes = element('fieldset', '', 'feishu-level-choices');
  const selectedTaskMode = () => taskModes.querySelector('input:checked')?.value || 'none';
  const fillTaskMode = mode => {
    taskModes.replaceChildren(element('legend', '项目任务权限'));
    const options = [...groupTaskOptions];
    if (mode === 'custom') options.push(['custom', '保留旧权限', groupTaskScope(data.bindings.find(b => b.chat_id === chat.value))]);
    for (const [id, title, detail] of options) {
      const control = document.createElement('input');
      control.type = 'radio'; control.name = 'binding_task_mode'; control.value = id; control.checked = id === mode;
      const label = element('label', '', 'check'); label.append(control, ' ' + title);
      taskModes.append(label, note(detail));
    }
  };

  const platformFieldset = element('fieldset', '', 'role-permission-group');
  platformFieldset.append(element('legend', '平台能力'));
  const platformItemsWrap = element('div');
  const renderPlatformItems = source => {
    platformEdited = Object.fromEntries(platformItems.map(item => [item.id, source?.[item.id] ?? (item.id === 'project_memory' ? 'read' : 'none')]));
    platformItemsWrap.replaceChildren(bindingGroupItemsEditor(platformEdited, data.permission_items, 'platform'));
  };
  platformFieldset.append(platformItemsWrap,
    note('基础能力默认全部允许：使用虚拟电脑、使用任务浏览器（用于派发任务）以及在群里直接设置本群定时任务（例如每天早 8 点统计昨天的 PR 和 Issue）无需单独开关；「项目定时与通知」仅控制仓库的项目级定时任务和事件订阅，不影响本群定时任务。'));

  const presetBar = element('div', '', 'feishu-preset-bar');
  presetBar.append(element('span', '快捷填充：'));
  for (const preset of groupQuickPresets) {
    presetBar.append(button(preset.name, () => {
      for (const [id, control] of githubControls) control.checked = id === preset.github;
      githubStartFrom = { ...githubPresetOf(preset.github) }; githubItemsWrap.replaceChildren(); showGithubItems();
      fillTaskMode(preset.task);
      renderPlatformItems(preset.platform);
    }, 'quiet'));
  }

  form.append(presetBar, githubFieldset, taskModes, platformFieldset,
    element('p', '保存后，群内所有成员（包括没有平台账号的人和其他企业的外部成员）都按以上权限配置使用助手，不核对发言人。实际能做的还不超过你本人在这些仓库的当前权限、各项目的能力上限和 GitHub App 的安装权限。', 'endpoint-warning'));

  // The assistant role: its prompt and model only. Direct links jump to project settings -> roles?view=assistant-roles.
  const role = channelSelect(form, '助手角色', 'binding_role', data.service_roles.map(r => [r.id, r.name + (r.project ? `（${r.project.full_name} 专属）` : '') + (r.recommended ? '（推荐）' : '')]));
  const roleNote = note('');
  const roleLinks = element('div', '', 'feishu-project-role-links');
  updateRoleLinks = () => {
    roleLinks.replaceChildren();
    const checkedIds = repositoriesKind.checked
      ? [...boxes].filter(([, control]) => control.checked && control.closest('label').dataset.orgHidden !== '1').map(([id]) => id)
      : [];
    const linkedProjects = checkedIds.length === 1 && projectById.has(checkedIds[0])
      ? [projectById.get(checkedIds[0])]
      : data.projects.slice(0, 3);
    if (linkedProjects.length) {
      roleLinks.append(element('span', '在项目设置中维护专属群助手角色：', 'muted'));
      for (const p of linkedProjects) {
        roleLinks.append(channelLink(`#/projects/${p.id}/roles?view=assistant-roles`, `${p.full_name} 群助手角色`, 'button-link quiet'));
      }
    }
    if (me.role === 'super_admin') roleLinks.append(channelLink('#/settings/service-roles', '管理全局服务角色', 'button-link quiet'));
    roleLinks.hidden = !roleLinks.childElementCount;
  };
  form.append(roleNote, note('助手角色只决定提示词和模型，不决定群能做什么。'), roleLinks);

  const participation = channelSelect(form, '助手发言范围', 'binding_participation', participationOptions);
  form.append(note('注意：群内所有成员都能看到助手读取的所选仓库内容（包括私有仓库），由配置人负责控制范围。所有获准消息都会存入本地；扩大发言范围会增加模型用量，用量记在服务角色上，不计入项目。'));
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const ownership = note(''); ownership.setAttribute('role', 'status');
  const save = element('button', '保存群聊助手'); save.type = 'submit';
  const submitActions = element('div', '', 'actions');
  submitActions.append(save, button('取消', onClose, 'quiet'));
  form.append(ownership, status, submitActions);

  let expected = 0;
  const unavailable = !chats.size || !data.service_roles.length || !data.projects.length && !data.organizations.length;
  const roleById = new Map(data.service_roles.map(r => [r.id, r]));
  const describeRole = () => {
    const r = roleById.get(role.value);
    if (!r) { roleNote.textContent = ''; return; }
    const model = r.model ? `模型：${r.model.model_name}${r.model.project_id ? '（项目专属）' : '（共享）'}` : '尚未配置模型';
    roleNote.textContent = [r.responsibility || '自定义服务角色', model, r.project ? `只能用于范围只有 ${r.project.full_name} 的群` : ''].filter(Boolean).join('；') + '。';
  };
  const showScope = () => {
    repositoriesWrap.hidden = !repositoriesKind.checked;
    organizationField.hidden = !organizationKind.checked;
    orgScopeNote.hidden = !organizationKind.checked;
    updateOrgNote();
    updateRoleLinks();
  };
  const fill = () => {
    const current = data.bindings.find(b => b.chat_id === chat.value), organizationOnly = chatOrganization.get(chat.value) || null;
    expected = current?.revision || 0;
    editorTitle.textContent = current ? `配置仓库与权限 · ${channelChatName(current.chat)}` : '创建群绑定';
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
    const initial = current?.permissions ? { ...current.permissions } : defaultPermissions();
    const ghLevel = current?.github_level || 'read';
    for (const [id, control] of githubControls) control.checked = id === ghLevel;
    githubStartFrom = { ...initial }; githubItemsWrap.replaceChildren(); showGithubItems();
    fillTaskMode(current?.task_mode || 'none');
    renderPlatformItems(initial);
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
      const ghLevel = chosenGithubLevel(), taskMode = selectedTaskMode();
      const permissions = { ...(ghLevel === 'custom' ? githubEdited : githubPresetOf(ghLevel)), ...platformEdited };
      if (taskMode !== 'custom') permissions.project_tasks = taskMode;
      await api('/api/channels/chats/' + chat.value + '/service-binding', 'PUT', { service_role_id: role.value, scope: selected, participation: participation.value,
        permissions, enabled: true, expected_revision: expected });
      history.replaceState(null, '', '#/identity/feishu');
      await start();
    } catch (err) { status.textContent = bindingSaveError(err); save.disabled = false; }
  });

  if (!chats.size) section.append(note('尚无可选择的群。请先完成个人绑定，在机器人已加入的目标群发一条消息，再刷新本页。'));
  if (!data.projects.length && !data.organizations.length) section.append(note('当前没有可配置的仓库。个人绑定不会增加项目权限。'));
  if (!data.service_roles.length) section.append(note('当前没有可用于群聊的服务角色，请联系超级管理员。'));
  section.append(form);

  if (targetChatId && [...chat.options].some(o => o.value === targetChatId)) chat.value = targetChatId;
  else if (!targetChatId) {
    const unbound = data.chats.find(c => !data.bindings.some(b => b.chat_id === c.id && b.enabled));
    if (unbound && [...chat.options].some(o => o.value === unbound.id)) chat.value = unbound.id;
  }
  if (chats.size) fill();
  else updateRoleLinks();

  return section;
}

// Scannable group bindings list for #/identity/feishu (active/paused first, disabled folded).
function buildGroupBindingsList(data) {
  const root = element('div');
  const activeOrPaused = data.bindings.filter(b => b.state !== 'disabled');
  const disabledBindings = data.bindings.filter(b => b.state === 'disabled');

  const buildRow = b => {
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
    const stateBadge = element('span', bindingStates[b.state] || b.state, bindingStateBadgeClass(b.state));
    const roleBadge = element('span', b.service_role.name || '服务角色已删除', 'feishu-binding-badge');
    titleWrap.append(groupName, stateBadge, roleBadge);

    const participationLabel = participationOptions.find(([id]) => id === b.participation)?.[1] || b.participation;
    const permSummary = `GitHub ${bindingGithubSummary(b, data.permission_items)} · 项目任务 ${groupTaskShort(b)} · 平台 ${bindingPlatformSummary(b, data.permission_items)}`;
    const ownerLine = `发言范围：${participationLabel} · 负责人：${b.owner || '账户已删除'}${b.configured_by && b.configured_by !== b.owner ? '（最近修改：' + b.configured_by + '）' : ''}`;
    const profileDetails = element('details', '', 'feishu-chat-profile-fold');
    profileDetails.append(element('summary', '群与应用信息'), channelProfileDetails(b.chat, () => { groupName.textContent = channelChatName(b.chat); }));

    info.append(
      titleWrap,
      note('项目范围：' + scopeText + (b.scope.organization && b.enabled ? `（可达 ${b.reachable.length} 个仓库）` : '')),
      note('权限：' + permSummary),
      note(ownerLine),
      profileDetails,
      ...(b.paused.length ? [note('暂停的仓库（配置人权限已变化）：' + b.paused.join('、'))] : []),
      ...(b.model_gaps?.length ? [note('助手角色的模型没有授权给：' + b.model_gaps.join('、') + '。本群暂停回答，直到换一个对范围内每个项目都可用的角色或调整范围。')] : []),
      ...(b.migrated ? [note('由旧群员工自动迁移为仓库问答助手。')] : []),
      ...(b.error ? [note(employeeError(b.error))] : []),
      ...(!canViewChat ? [note('需要该群负责人或拥有全部绑定范围的配置权限才能查看聊天记录。')] : []),
    );

    const transferDrawer = element('div', '', 'feishu-row-drawer'); transferDrawer.hidden = true;

    if (canViewChat) actions.append(channelLink('#/conversations/' + b.chat_id, '查看聊天记录', 'button-link quiet'));
    if (b.can_manage) actions.append(channelLink('#/identity/feishu/groups/' + b.chat_id, b.enabled ? '配置仓库与权限' : '重新启用并配置', 'button-link quiet'));
    if (b.enabled && b.can_manage) actions.append(channelLink(`#/conversations/${b.chat_id}?section=schedules`, '定时任务', 'button-link quiet'));
    if (b.can_transfer) {
      transferDrawer.append(channelOwnerTransfer(b));
      actions.append(button('转交负责人', () => { transferDrawer.hidden = !transferDrawer.hidden; }, 'quiet'));
    }
    if (b.enabled && b.can_manage) {
      actions.append(button('停用群聊助手', async () => {
        const confirmed = await askConfirm({
          title: '停用群聊助手',
          body: [`停用「${channelChatName(b.chat)}」的群聊助手后，本群将不再响应机器人消息，本群定时任务也会暂停；已保存的历史记录保留，随时可重新启用。`],
          action: '确认停用',
          danger: true,
          run: () => api('/api/channels/chats/' + b.chat_id + '/service-binding', 'PUT', { enabled: false, expected_revision: b.revision }),
        });
        if (confirmed) await start();
      }, 'quiet destructive'));
    }

    mainRow.append(info, actions);
    row.append(mainRow, transferDrawer);
    return row;
  };

  const list = element('div', '', 'feishu-binding-list');
  list.setAttribute('aria-label', '飞书群绑定列表');
  if (!activeOrPaused.length) {
    list.append(element('p', disabledBindings.length
      ? '当前没有生效中的飞书群绑定，可在下方展开已停用记录重新启用，或点击「创建群绑定」。'
      : '当前尚无已绑定的飞书群。点击「创建群绑定」可为机器人所在群配置仓库范围、权限与助手角色。', 'muted'));
  }
  for (const b of activeOrPaused) list.append(buildRow(b));
  root.append(list);

  if (disabledBindings.length) {
    const disabledFold = element('details', '', 'fold feishu-history-fold');
    disabledFold.open = activeOrPaused.length === 0;
    disabledFold.append(element('summary', `已停用的群绑定（${disabledBindings.length}）`));
    const disabledList = element('div', '', 'feishu-binding-list');
    for (const b of disabledBindings) disabledList.append(buildRow(b));
    disabledFold.append(disabledList);
    root.append(disabledFold);
  }

  const legacy = data.legacy_employees.filter(g => g.enabled);
  if (legacy.length) {
    const old = element('div', '', 'feishu-binding-list'); old.append(element('h3', '旧群员工'), note('旧群员工已不再接收群消息，只用于继续核验升级前已创建的任务。确认这些任务不再需要后可以停用。'));
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

  return root;
}
