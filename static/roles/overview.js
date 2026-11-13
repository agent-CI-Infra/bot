function roleListComparable(role) {
  return JSON.stringify({
    role_id: role.role_id, enabled: role.enabled, name: role.name,
    responsibility: role.responsibility, persona_prompt: role.persona_prompt,
    model_profile_ref: role.model_profile_ref ? { model_id: role.model_profile_ref.model_id, api: role.model_profile_ref.api, tool_calls: role.model_profile_ref.tool_calls, structured_output: role.model_profile_ref.structured_output } : null,
    skill_bundle_ref: role.skill_bundle_ref ? { id: role.skill_bundle_ref.id } : null,
    harness_ref: role.harness_ref ? { id: role.harness_ref.id } : null,
    permissions: role.permissions || null,
    environment_profile_ref: role.environment_profile_ref ? { id: role.environment_profile_ref.id } : null,
    budget_policy_ref: role.budget_policy_ref ? Object.fromEntries(Object.entries(role.budget_policy_ref).filter(([key]) => key !== 'version')) : null,
    output_schema_ref: role.output_schema_ref ? { id: role.output_schema_ref.id } : null,
    kind: role.kind
  });
}
function roleListStart(role, data) {
  if (data.configured !== false) return role;
  return { ...role, harness_ref: { ...(role.harness_ref || {}), id: data.recommended_backend || 'pi' } };
}
function roleListStatus(role, state, start) {
  const parts = [role.enabled ? rolePageText('statusEnabled') : rolePageText('statusDisabled')];
  if (!start || roleListComparable(role) !== roleListComparable(start)) parts.push(rolePageText('statusUnsaved'));
  else if (state.data.configured) parts.push(rolePageText('statusSaved'));
  else parts.push(rolePageText('statusRecommended'));
  return parts.join(' · ');
}
function roleOverviewCards(state, redraw) {
  const { data, draft } = state, overview = card(rolePageText('overview')), { table, body } = projectTable(rolePageText('columns'), rolePageText('tableLabel'));
  // The version line is the one place that says whether what is on screen is in force or still a draft.
  roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; overview.append(roleDraftStatus);
  overview.append(note(rolePageText('overviewNote')));
  const starting = new Map((data.configuration.roles || []).map(role => [role.role_id, roleListStart(role, data)]));
  for (const role of draft.roles) {
    const row = document.createElement('tr'); row.dataset.role = role.role_id;
    const link = element('a', roleConfigName(role.role_id, role.name)); link.href = `#/projects/${current.id}/roles/${role.role_id}`;
    link.dataset.testid = 'role-list-' + role.role_id;
    tableCell(row, rolePageText('columns')[0], link);
    tableCell(row, rolePageText('columns')[1], roleCheck(rolePageText('enableList') + ' ' + roleConfigName(role.role_id, role.name), role, 'enabled', state, requiredRoleLocked(role), { reason: requiredEnableReason(role), redraw }));
    const dutyText = roleConfigDuty(role.role_id, role.responsibility);
    const duty = note(dutyText || rolePageText('emptyDuty')); if (dutyText) duty.title = dutyText; tableCell(row, rolePageText('columns')[2], duty);
    const saved = data.configuration.roles.find(entry => entry.role_id === role.role_id);
    const status = note(roleListStatus(role, state, starting.get(role.role_id)));
    if (role.role_id === 'dev' && data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') status.append(element('span', '检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更', 'muted'));
    tableCell(row, rolePageText('columns')[3], status);
    body.append(row);
  }
  overview.append(table);
  const coordination = card('角色协调设置'); coordination.append(roleCheck('开启角色协调', draft, 'enabled', state));
  for (const [id, title, covers] of roleEntries) coordination.append(roleCheck(`${title}交给主控（${covers}）`, draft.controller.entries, id, state));
  coordination.append(note('关闭协调时，任务沿用原执行器；独立 QA 仍然负责验收。正在运行的任务保留启动时的配置快照。'));
  const custom = card('自定义角色'), name = input('new_role', '', { placeholder: '如 security_checker', maxLength: 32 });
  const error = element('p', '', 'view-error'); custom.append(field('新角色标识', name), button('添加角色', () => {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name.value) || draft.roles.some(role => role.role_id === name.value)) { error.textContent = '使用小写字母开头的唯一名称，可包含数字、下划线或连字符。'; return; }
    const defaults = structuredClone(Object.hasOwn(data.role_defaults, name.value) ? data.role_defaults[name.value] : data.role_defaults.observer);
    draft.roles.push({ role_id: name.value, enabled: true, name: name.value, responsibility: '', persona_prompt: Object.hasOwn(data.role_templates || {}, name.value) ? data.role_templates[name.value] : data.role_templates.observer, model_profile_ref: null, skill_bundle_ref: null, harness_ref: { id: data.recommended_backend || 'pi' }, budget_policy_ref: { id: 'entry-default' }, ...defaults }); draft.deleted_roles = (draft.deleted_roles || []).filter(id => id !== name.value); markRoleDirty(state); redraw();
  }), note(rolePageText('requiredNote')), error);
  return [overview, coordination, roleSkillsCard(state, redraw), roleStagesCard(state, redraw), custom];
}
