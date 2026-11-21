function roleListComparable(role) {
  return JSON.stringify({
    role_id: role.role_id, enabled: role.enabled, name: role.name,
    responsibility: role.responsibility, persona_prompt: role.persona_prompt,
    model_profile_ref: role.model_profile_ref ? { model_id: role.model_profile_ref.model_id, api: role.model_profile_ref.api, tool_calls: role.model_profile_ref.tool_calls, structured_output: role.model_profile_ref.structured_output } : null,
    skill_bundle_ref: role.skill_bundle_ref ? { id: role.skill_bundle_ref.id } : null,
    harness_ref: role.harness_ref ? { id: role.harness_ref.id, ...(role.harness_ref.model_source && role.harness_ref.model_source !== 'gateway' ? { model_source: role.harness_ref.model_source } : {}) } : null,
    permissions: role.permissions || null,
    environment_profile_ref: role.environment_profile_ref ? { id: role.environment_profile_ref.id } : null,
    budget_policy_ref: role.budget_policy_ref ? Object.fromEntries(Object.entries(role.budget_policy_ref).filter(([key]) => key !== 'version')) : null,
    output_schema_ref: role.output_schema_ref ? { id: role.output_schema_ref.id } : null,
    kind: role.kind
  });
}
function roleListStatus(role, state, start) {
  const parts = [role.enabled ? rolePageText('statusEnabled') : rolePageText('statusDisabled')];
  if (!start || roleListComparable(role) !== roleListComparable(start)) parts.push(rolePageText('statusUnsaved'));
  else if (state.data.configured) parts.push(rolePageText('statusSaved'));
  else parts.push(rolePageText('statusDefault'));
  return parts.join(' · ');
}
// A configuration of the project's own no longer follows built-in updates; returning to the defaults is one confirmed
// step, and the saved revisions stay in the history (#1068).
function roleDefaultsControl(state) {
  const box = element('div', '', 'role-config-source'); box.dataset.testid = 'role-config-source';
  box.append(note(rolePageText('customNote')));
  if (state.data.can_edit === false) return box;
  const restore = button(rolePageText('restore'), () => state.restoreDefaults?.(), 'quiet');
  restore.dataset.testid = 'restore-default-roles';
  restore.disabled = !!state.busy || !!state.conflict;
  box.append(restore);
  return box;
}
function roleBackendAvailabilityCard(state) {
  const containerBackends = (state.data.backends || []).filter(entry => entry.runtime_status);
  if (!containerBackends.length) return null;
  const section = card('容器内 Agent 后端可用性');
  section.dataset.testid = 'backend-availability-card';
  section.append(note('在项目电脑内执行的后端列在这里：Claude Code 与 Codex 从只读工具卷 /opt/agent-tools 加载二进制并经容器内模型中转调用平台模型；其他后端按它自己的声明显示就绪状态，安装与版本由产品自身管理。'));
  const { table, body } = projectTable(['后端', '状态', '已安装版本', '兼容范围', '说明'], '容器内 Agent 后端状态');
  for (const backend of containerBackends) {
    const rt = backend.runtime_status;
    const conn = rt.connectivity;
    const connFailed = rt.ready && conn?.state === 'failed';
    const srcLabels = { project: '项目默认', role: '角色指定' };
    let detailText;
    if (!rt.ready) {
      detailText = rt.reason || '尚未就绪';
    } else if (rt.resolved_model) {
      const src = srcLabels[rt.resolved_model.source] || rt.resolved_model.source;
      if (conn?.state === 'ok') detailText = `模型 ${rt.resolved_model.name}（${src}）· 连通正常${conn.http_status ? '（HTTP ' + conn.http_status + '）' : ''}`;
      else if (conn?.state === 'failed') detailText = `模型 ${rt.resolved_model.name}（${src}）· 连通失败：${conn.detail || conn.error || '请求失败'}`;
      else detailText = `已配置模型 ${rt.resolved_model.name}（${src} · 连通性未探测）`;
    } else if (rt.source === 'declaration') {
      // #1042: nothing in the console inspects this product's install path yet; say that instead of claiming a model
      // status the row never measured.
      detailText = '由后端声明决定：在项目电脑内执行，安装与版本由产品自身管理，控制台尚未检查。';
    } else if (rt.config_override) {
      detailText = '本地配置覆盖（连通性未探测）';
    } else {
      detailText = '已配置模型（连通性未探测）';
    }
    const row = document.createElement('tr');
    row.dataset.backend = backend.id;
    tableCell(row, '后端', element('strong', backend.name));
    tableCell(row, '状态', rt.source === 'declaration'
      // #1042/#1192: the console has not inspected this backend's install path, so the badge states who manages it
      // instead of claiming it is ready — the same wording the role box uses.
      ? badge('由产品管理', 'warning')
      : badge(!rt.ready ? '未就绪' : connFailed ? '连通异常' : '可用', !rt.ready || connFailed ? 'warning' : 'success'));
    tableCell(row, '已安装版本', note(rt.installed_versions?.length ? `${rt.installed_versions.join(', ')}${rt.selected_version ? '（选用 ' + rt.selected_version + '）' : ''}` : rt.source === 'declaration' ? '由产品声明管理' : rt.config_override ? '本地配置覆盖' : '未安装'));
    tableCell(row, '兼容范围', element('code', rt.compatible_range || '—'));
    tableCell(row, '说明', note(detailText));
    body.append(row);
  }
  section.append(table);
  return section;
}
function roleOverviewCards(state, redraw) {
  const { data, draft } = state, overview = card(rolePageText('overview')), { table, body } = projectTable(rolePageText('columns'), rolePageText('tableLabel'));
  // The version line is the one place that says whether what is on screen is in force or still a draft.
  roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; overview.append(roleDraftStatus);
  if (data.configured !== false) overview.append(roleDefaultsControl(state));
  overview.append(note(rolePageText('overviewNote')));
  const starting = new Map((data.configuration.roles || []).map(role => [role.role_id, role]));
  for (const role of draft.roles) {
    const row = document.createElement('tr'); row.dataset.role = role.role_id;
    const link = element('a', roleConfigName(role)); link.href = `#/projects/${current.id}/roles/${role.role_id}`;
    link.dataset.testid = 'role-list-' + role.role_id;
    tableCell(row, rolePageText('columns')[0], link);
    tableCell(row, rolePageText('columns')[1], roleCheck(rolePageText('enableList') + ' ' + roleConfigName(role), role, 'enabled', state, requiredRoleLocked(role), { reason: requiredEnableReason(role), redraw }));
    const dutyText = roleConfigDuty(role.role_id, role.responsibility);
    const duty = note(dutyText || rolePageText('emptyDuty')); if (dutyText) duty.title = dutyText; tableCell(row, rolePageText('columns')[2], duty);
    const saved = data.configuration.roles.find(entry => entry.role_id === role.role_id);
    const status = note(roleListStatus(role, state, starting.get(role.role_id)));
    if (role.role_id === 'dev' && data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') status.append(element('span', '检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更', 'muted'));
    tableCell(row, rolePageText('columns')[3], status);
    body.append(row);
  }
  overview.append(table);
  const controller = draft.roles.find(role => role.role_id === draft.controller.role);
  overview.append(consoleLink(`#/projects/${current.id}/triggers`, '监听与触发设置', `配置项目整体的事件来源；新任务默认由 ${controller?.name || draft.controller.role} 安排`));
  const requiredNames = new Intl.ListFormat(consoleLocale()).format(draft.roles.filter(requiredRoleLocked).map(roleConfigName));
  const custom = card('自定义角色'), name = input('new_role', '', { placeholder: '如 security_checker', maxLength: 32 });
  const error = element('p', '', 'view-error'); custom.append(field('新角色标识', name), button('添加角色', () => {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name.value) || draft.roles.some(role => role.role_id === name.value)) { error.textContent = '使用小写字母开头的唯一名称，可包含数字、下划线或连字符。'; return; }
    const defaults = structuredClone(Object.hasOwn(data.role_defaults, name.value) ? data.role_defaults[name.value] : data.role_defaults.observer);
    draft.roles.push({ role_id: name.value, enabled: true, name: name.value, responsibility: '', persona_prompt: Object.hasOwn(data.role_templates || {}, name.value) ? data.role_templates[name.value] : data.role_templates.observer, model_profile_ref: null, skill_bundle_ref: null, harness_ref: { id: data.recommended_backend || 'pi' }, budget_policy_ref: { id: 'entry-default' }, ...defaults }); draft.deleted_roles = (draft.deleted_roles || []).filter(id => id !== name.value); markRoleDirty(state); redraw();
  }), note(rolePageText('requiredNote')(requiredNames)), error);
  const availability = roleBackendAvailabilityCard(state);
  return [overview, ...(availability ? [availability] : []), roleSkillsCard(state, redraw), custom];
}
