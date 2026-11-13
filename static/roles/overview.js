function roleListStatus(role, state) {
  const parts = [role.enabled ? '已启用' : '已关闭'];
  if (state.dirty) parts.push('有未保存的更改');
  else if (state.data.configured) parts.push('已保存');
  else parts.push('推荐配置');
  return parts.join(' · ');
}
function roleOverviewCards(state, redraw) {
  const { data, draft } = state, overview = card('角色概览'), { table, body } = projectTable(['角色', '启用', '职责', '状态'], '角色解析结果');
  // The version line is the one place that says whether what is on screen is in force or still a draft.
  roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; overview.append(roleDraftStatus);
  overview.append(note('点角色名称打开完整表单，在同一页编辑并保存。列表只展示名称、是否启用、职责和状态。'));
  for (const role of draft.roles) {
    const row = document.createElement('tr'); row.dataset.role = role.role_id;
    const link = element('a', roleLabel(role.role_id, role.name)); link.href = `#/projects/${current.id}/roles/${role.role_id}`;
    link.dataset.testid = 'role-list-' + role.role_id;
    tableCell(row, '角色', link);
    tableCell(row, '启用', roleCheck(role.role_id + ' 启用', role, 'enabled', state, ['controller', 'evaluator'].includes(role.kind)));
    tableCell(row, '职责', note(role.responsibility || '未填写职责'));
    const saved = data.configuration.roles.find(entry => entry.role_id === role.role_id);
    const status = note(roleListStatus(role, state));
    if (role.role_id === 'dev' && data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') status.append(element('span', '检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更', 'muted'));
    tableCell(row, '状态', status);
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
  }), note('新增角色默认使用可编辑的检视模板。Manager、Coordinator 和 QA 是必需角色，其余角色都可以删除。'), error);
  return [overview, coordination, roleSkillsCard(state, redraw), roleStagesCard(state, redraw), custom];
}
