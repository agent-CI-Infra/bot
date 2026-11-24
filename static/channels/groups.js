const participationOptions = [['mentions', '仅回应 @'], ['questions', '回应 @、提问或求助的文字'], ['all', '读取每条新文字后判断是否发言']];
const bindingStates = { active: '生效中', paused: '已暂停', disabled: '已停用' };
// Pi is the default backend (#1255): a new group starts on it, and only another backend is shown as a badge or opens the
// advanced settings.
const defaultGroupHarness = 'pi';
const groupHarnessOptions = [['pi', 'Pi（推荐）'], ['codex', 'Codex'], ['claude_code', 'Claude Code']];
const groupHarnessName = id => groupHarnessOptions.find(([key]) => key === id)?.[1] || id;
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
// A refused save in words, naming the projects that do not fit the chosen model (#849, #1249).
function bindingSaveError(err) {
  const projects = (err.detail?.projects || []).join('、');
  if (err.code === 'channel_service_model_unavailable') return `所选模型没有授权给 ${projects || '范围内的部分项目'}。群助手只能用对范围内每个项目都可用的模型：请换一个模型，或请超级管理员把共享模型授权给这些项目。`;
  if (err.code === 'shared_model_required') return '绑定整个组织时只能选择部署共享模型，不能选择单个项目的专属模型。';
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
    note('第一个配置的维护人成为该群助手负责人（需已绑定个人飞书、在该群中，并对所选仓库或组织有配置权限）；之后负责人、所属组织管理员和超级管理员均可在此修改仓库范围、权限、模型与提示词。'));

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

  let updateModelOptions = () => {};
  const updateRepoCounter = () => {
    const allowed = [...boxes.values()].filter(control => control.closest('label').dataset.orgHidden !== '1');
    const checked = allowed.filter(control => control.checked);
    repoCounter.textContent = allowed.length ? `已勾选 ${checked.length} / ${allowed.length} 个你有配置权限的仓库` : '当前群所属组织下暂无可配置仓库';
    updateModelOptions();
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
    updateModelOptions();
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

  // Inline group assistant configuration (#1249): model (filtered to the selected scope), prompt/responsibility, and Agent harness.
  const assistantFieldset = element('fieldset', '', 'feishu-assistant-fieldset');
  assistantFieldset.append(element('legend', '助手模型与提示词'));
  const modelList = Array.isArray(data.models) ? data.models : [];
  const modelById = new Map(modelList.map(m => [m.id, m]));
  for (const b of data.bindings || []) {
    if (b.model && !modelById.has(b.model.id)) {
      modelById.set(b.model.id, { ...b.model, all_projects: false, authorized_projects: [] });
    }
  }
  const modelSelect = document.createElement('select'); modelSelect.name = 'binding_model'; modelSelect.setAttribute('aria-label', '助手模型');
  const modelWarning = element('p', '', 'endpoint-warning feishu-model-warning'); modelWarning.hidden = true;
  const modelHint = note('');
  const modelCaption = m => `${m.model_name} · ${hostOf(m.api_url)}${m.project_id ? '（项目专属）' : '（共享）'}${m.key_configured ? '' : '（Key 已撤销）'}`;
  const selectedScopeProjects = () => {
    if (organizationKind.checked) return data.projects.filter(p => p.organization === organization.value);
    return [...boxes].filter(([, control]) => control.checked && control.closest('label').dataset.orgHidden !== '1')
      .map(([id]) => projectById.get(id)).filter(Boolean);
  };
  const modelServesProject = (m, projectId) => m.project_id !== null
    ? m.project_id === projectId
    : m.all_projects || (Array.isArray(m.authorized_projects) && m.authorized_projects.includes(projectId));
  const modelGapsForScope = m => {
    if (organizationKind.checked && m.project_id !== null) return ['整个组织只能使用部署共享模型'];
    const scopeProjects = selectedScopeProjects();
    if (organizationKind.checked && !m.all_projects && !scopeProjects.length) return ['当前组织尚未启用项目，仅开放对全部项目可用的共享模型'];
    return scopeProjects.filter(p => !modelServesProject(m, p.id)).map(p => p.full_name);
  };
  let preferredModelId = '';
  const updateModelFeedback = () => {
    const selected = modelById.get(modelSelect.value);
    if (!selected) {
      modelWarning.textContent = ''; modelWarning.hidden = true;
      modelHint.textContent = modelList.length
        ? '未选择模型时，群内消息会提示先为本群选择模型，不会改用其他模型。'
        : '当前范围还没有可用模型，请先在项目「模型」页或全局「模型」页配置。';
      return;
    }
    const gaps = modelGapsForScope(selected);
    if (gaps.length) {
      modelWarning.textContent = organizationKind.checked && selected.project_id !== null
        ? '所选模型是单个项目的专属模型，绑定整个组织时只能选择部署共享模型。请更换模型或改按单个仓库勾选。'
        : organizationKind.checked && !selected.all_projects && !selectedScopeProjects().length
          ? '所选共享模型仅授权了部分项目，当前组织尚未启用项目，不能绑定。请改选对全部项目可用的共享模型。'
          : `所选模型尚未覆盖当前范围内的：${gaps.join('、')}。请更换对全部范围都可用的模型，或调整所选仓库。`;
      modelWarning.hidden = false;
    } else if (!selected.key_configured) {
      modelWarning.textContent = '所选模型的 API Key 已撤销，保存后本群无法回答，请更换模型或先补回 Key。';
      modelWarning.hidden = false;
    } else {
      modelWarning.textContent = ''; modelWarning.hidden = true;
    }
    modelHint.textContent = selected.project_id
      ? '项目专属模型仅可用于范围只包含该项目的群，用量同时计入该项目成本。'
      : '部署共享模型可用于所有已获授权的仓库；单仓库群同时计入该项目成本。';
  };
  updateModelOptions = ({ autoSelectDefault = false } = {}) => {
    const previous = preferredModelId || modelSelect.value;
    const eligible = modelList.filter(m => modelGapsForScope(m).length === 0);
    modelSelect.replaceChildren();
    const noneOption = element('option', '暂不选择模型'); noneOption.value = ''; modelSelect.append(noneOption);
    for (const m of eligible) {
      const opt = element('option', modelCaption(m)); opt.value = m.id; modelSelect.append(opt);
    }
    if (previous && !eligible.some(m => m.id === previous)) {
      const stale = modelById.get(previous);
      if (stale) {
        const opt = element('option', modelCaption(stale) + '（未覆盖当前全部范围）'); opt.value = stale.id; modelSelect.append(opt);
      }
    }
    if (previous && [...modelSelect.options].some(o => o.value === previous)) {
      modelSelect.value = previous;
    } else if (autoSelectDefault && data.default_model_id && eligible.some(m => m.id === data.default_model_id)) {
      modelSelect.value = data.default_model_id;
    } else {
      modelSelect.value = '';
    }
    preferredModelId = modelSelect.value;
    updateModelFeedback();
  };
  modelSelect.addEventListener('change', () => { preferredModelId = modelSelect.value; updateModelFeedback(); });

  const promptInput = textarea('binding_prompt', '', {
    maxLength: 35000,
    rows: 4,
    placeholder: '选填：补充本群助手的职责、回答风格或协作要求（附加在内置安全提示之后，不能扩大工具或权限）',
  });
  promptInput.setAttribute('aria-label', '提示词与职责说明');
  const harnessSelect = document.createElement('select'); harnessSelect.name = 'binding_harness'; harnessSelect.setAttribute('aria-label', 'Agent 后端');
  for (const [id, label] of groupHarnessOptions) { const opt = element('option', label); opt.value = id; harnessSelect.append(opt); }
  harnessSelect.value = defaultGroupHarness;
  const harnessDetails = element('details', '', 'fold feishu-guide-details');
  const computerWarning = harnessComputerWarning();
  harnessDetails.append(element('summary', '高级设置：Agent 后端'), field('Agent 后端', harnessSelect));

  const assistantPresetBar = element('div', '', 'feishu-preset-bar');
  const copySourceSelect = document.createElement('select'); copySourceSelect.setAttribute('aria-label', '选择要复制配置的已有群');
  const copyBtn = button('复制模型与提示词', () => {
    const source = data.bindings.find(b => b.chat_id === copySourceSelect.value);
    if (!source) return;
    promptInput.value = source.prompt || '';
    harnessSelect.value = source.harness || defaultGroupHarness;
    if (harnessSelect.value !== defaultGroupHarness) harnessDetails.open = true;
    preferredModelId = source.model_id || '';
    updateModelOptions();
  }, 'quiet');
  const copyRow = element('div', '', 'feishu-copy-row');
  copyRow.append(copySourceSelect, copyBtn);
  const refreshCopySources = () => {
    const others = data.bindings.filter(b => b.chat_id !== chat.value && (b.model_id || b.prompt || (b.harness && b.harness !== defaultGroupHarness)));
    copySourceSelect.replaceChildren();
    for (const b of others) copySourceSelect.add(new Option(`${channelChatName(b.chat)}${b.model ? ' · ' + b.model.model_name : ''}`, b.chat_id));
    copyRow.hidden = !others.length;
  };
  assistantPresetBar.append(
    element('span', '快捷填充：'),
    button('填入默认问答提示', () => { promptInput.value = data.default_prompt || ''; }, 'quiet'),
    copyRow,
  );
  assistantFieldset.append(field('助手模型', modelSelect), modelWarning, modelHint, assistantPresetBar, field('提示词与职责说明', promptInput), harnessDetails,
    // Outside the folded section: every backend needs an assistant computer, so a group set up with the defaults still
    // learns that its turns would fail.
    computerWarning);
  form.append(assistantFieldset);

  const participation = channelSelect(form, '助手发言范围', 'binding_participation', participationOptions);
  form.append(note('注意：群内所有成员都能看到助手读取的所选仓库内容（包括私有仓库），由配置人负责控制范围。所有获准消息都会存入本地；扩大发言范围会增加模型用量（单仓库群同时计入该项目成本）。'));
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const ownership = note(''); ownership.setAttribute('role', 'status');
  const save = element('button', '保存群聊助手'); save.type = 'submit';
  const submitActions = element('div', '', 'actions');
  submitActions.append(save, button('取消', onClose, 'quiet'));
  form.append(ownership, status, submitActions);

  let expected = 0;
  const unavailable = !chats.size || !data.projects.length && !data.organizations.length;
  const showScope = () => {
    repositoriesWrap.hidden = !repositoriesKind.checked;
    organizationField.hidden = !organizationKind.checked;
    orgScopeNote.hidden = !organizationKind.checked;
    updateOrgNote();
    updateModelOptions();
  };
  const fill = () => {
    const current = data.bindings.find(b => b.chat_id === chat.value), organizationOnly = chatOrganization.get(chat.value) || null;
    expected = current?.revision || 0;
    editorTitle.textContent = current ? `配置群聊助手 · ${channelChatName(current.chat)}` : '创建群绑定';
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
    const initial = current?.permissions ? { ...current.permissions } : defaultPermissions();
    const ghLevel = current?.github_level || 'read';
    for (const [id, control] of githubControls) control.checked = id === ghLevel;
    githubStartFrom = { ...initial }; githubItemsWrap.replaceChildren(); showGithubItems();
    fillTaskMode(current?.task_mode || 'none');
    renderPlatformItems(initial);
    participation.value = current?.participation || 'mentions';
    promptInput.value = current ? (current.prompt || '') : '';
    harnessSelect.value = current?.harness || defaultGroupHarness;
    harnessDetails.open = harnessSelect.value !== defaultGroupHarness;
    preferredModelId = current ? (current.model_id || '') : '';
    const org = current?.enabled && current.scope.organization;
    organizationKind.checked = !!org && !organizationKind.disabled; repositoriesKind.checked = !organizationKind.checked;
    if (org) organization.value = org.id;
    for (const [id, control] of boxes) control.checked = !!current?.enabled && current.scope.repositories.some(r => r.id === id);
    refreshCopySources();
    showProfile(); applyRepoVisibility(); showScope();
    updateModelOptions({ autoSelectDefault: !current });
  };
  for (const control of [repositoriesKind, organizationKind]) control.addEventListener('change', showScope);
  chat.addEventListener('change', fill);
  save.disabled = unavailable;
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '正在核验你的飞书绑定、群成员身份和所选范围的配置权限…';
    const selected = organizationKind.checked ? { kind: 'organization', organization: organization.value } : { kind: 'repositories', repositories: [...boxes].filter(([, control]) => control.checked).map(([id]) => id) };
    try {
      const ghLevel = chosenGithubLevel(), taskMode = selectedTaskMode();
      const permissions = { ...(ghLevel === 'custom' ? githubEdited : githubPresetOf(ghLevel)), ...platformEdited };
      if (taskMode !== 'custom') permissions.project_tasks = taskMode;
      await api('/api/channels/chats/' + chat.value + '/service-binding', 'PUT', {
        scope: selected,
        participation: participation.value,
        permissions,
        model_id: modelSelect.value || null,
        prompt: promptInput.value,
        harness: harnessSelect.value,
        enabled: true,
        expected_revision: expected,
      });
      history.replaceState(null, '', '#/identity/feishu');
      await start();
    } catch (err) { status.textContent = bindingSaveError(err); save.disabled = false; }
  });

  if (!chats.size) section.append(note('尚无可选择的群。请先完成个人绑定，在机器人已加入的目标群发一条消息，再刷新本页。'));
  if (!data.projects.length && !data.organizations.length) section.append(note('当前没有可配置的仓库。个人绑定不会增加项目权限。'));
  section.append(form);

  if (targetChatId && [...chat.options].some(o => o.value === targetChatId)) chat.value = targetChatId;
  else if (!targetChatId) {
    const unbound = data.chats.find(c => !data.bindings.some(b => b.chat_id === c.id && b.enabled));
    if (unbound && [...chat.options].some(o => o.value === unbound.id)) chat.value = unbound.id;
  }
  if (chats.size) fill();
  else updateModelOptions({ autoSelectDefault: true });

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
    const modelLabel = b.model ? `${b.model.model_name}${b.model.key_configured ? '' : '（Key 已撤销）'}` : '未配置模型';
    const modelBadge = element('span', modelLabel, b.model?.key_configured ? 'feishu-binding-badge' : 'feishu-binding-badge feishu-binding-badge-warning');
    titleWrap.append(groupName, stateBadge, modelBadge);
    if (b.harness && b.harness !== defaultGroupHarness) titleWrap.append(element('span', groupHarnessName(b.harness), 'feishu-binding-badge feishu-binding-badge-info'));

    const participationLabel = participationOptions.find(([id]) => id === b.participation)?.[1] || b.participation;
    const permSummary = `GitHub ${bindingGithubSummary(b, data.permission_items)} · 项目任务 ${groupTaskShort(b)} · 平台 ${bindingPlatformSummary(b, data.permission_items)}`;
    const ownerLine = `发言范围：${participationLabel} · 负责人：${b.owner || '账户已删除'}${b.configured_by && b.configured_by !== b.owner ? '（最近修改：' + b.configured_by + '）' : ''}`;
    const promptPreview = b.prompt ? (b.prompt.length > 80 ? b.prompt.slice(0, 80) + '…' : b.prompt) : '';
    const profileDetails = element('details', '', 'feishu-chat-profile-fold');
    profileDetails.append(element('summary', '群与应用信息'), channelProfileDetails(b.chat, () => { groupName.textContent = channelChatName(b.chat); }));

    info.append(
      titleWrap,
      note('项目范围：' + scopeText + (b.scope.organization && b.enabled ? `（可达 ${b.reachable.length} 个仓库）` : '')),
      note('权限：' + permSummary),
      ...(promptPreview ? [note('提示词：' + promptPreview)] : []),
      ...(b.usage?.requests && typeof serviceUsageText === 'function' ? [note('累计用量：' + serviceUsageText(b.usage))] : []),
      note(ownerLine),
      profileDetails,
      ...(b.paused.length ? [note('暂停的仓库（配置人权限已变化）：' + b.paused.join('、'))] : []),
      ...(b.model_gaps?.length ? [note('所选模型没有授权给：' + b.model_gaps.join('、') + '。本群暂停回答，请点击「配置群聊助手」换一个对范围内每个项目都可用的模型或调整范围。')] : []),
      ...(b.migrated ? [note('由旧群员工自动迁移。')] : []),
      ...(b.error ? [note(employeeError(b.error))] : []),
      ...(!canViewChat ? [note('需要该群负责人或拥有全部绑定范围的配置权限才能查看聊天记录。')] : []),
    );

    const transferDrawer = element('div', '', 'feishu-row-drawer'); transferDrawer.hidden = true;

    if (canViewChat) actions.append(channelLink('#/conversations/' + b.chat_id, '查看聊天记录', 'button-link quiet'));
    if (b.can_manage) actions.append(channelLink('#/identity/feishu/groups/' + b.chat_id, b.enabled ? '配置群聊助手' : '重新启用并配置', 'button-link quiet'));
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
      : '当前尚无已绑定的飞书群。点击「创建群绑定」可为机器人所在群配置仓库范围、权限、模型与提示词。', 'muted'));
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
