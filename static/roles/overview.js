function roleOverviewCards(state, redraw) {
  const { data, draft } = state, overview = card('角色概览'), { table, body } = projectTable(['角色', '启用', '职责', 'Agent 后端', '模型', '技能包', '预算', '权限控制'], '角色解析结果');
  // The version line is the one place that says whether what is on screen is in force or still a draft.
  roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; overview.append(roleDraftStatus);
  overview.append(note(`这里可以直接修改每个角色的配置；点角色名称可编辑提示词和完整设置。修改在点击「保存角色配置」后生效。模型解析按「${workTypeName(data.workflow)}」工作类型展示最近读取的已保存配置；角色详情可切换工作类型检查。`));
  for (const role of draft.roles) {
    const row = document.createElement('tr'); row.dataset.role = role.role_id;
    const link = element('a', roleLabel(role.role_id, role.name)); link.href = `#/projects/${current.id}/roles/${role.role_id}`;
    tableCell(row, '角色', link, roleText(role.role_id + ' 名称', role, 'name', state));
    tableCell(row, '启用', roleCheck(role.role_id + ' 启用', role, 'enabled', state, ['controller', 'evaluator'].includes(role.kind)));
    // Responsibility and budget are summary facts here; they stay editable on the role page itself.
    tableCell(row, '职责', note(role.responsibility || '未填写职责'));
    tableCell(row, '预算', note(role.budget_policy_ref?.id || '未设置'));
    const saved = data.configuration.roles.find(entry => entry.role_id === role.role_id);
    tableCell(row, 'Agent 后端', roleBackendPicker(role, state, redraw), note(data.configured ? '已保存：' + harnessName(saved?.harness_ref.id) : '尚未保存，当前显示推荐配置'));
    if (role.role_id === 'dev' && data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') row.lastElementChild.append(note('检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更')); 
    tableCell(row, '模型', roleModelPicker(role, state), note('已保存 · ' + workTypeName(data.workflow) + '：' + roleModelText(data.preview.find(entry => entry.role === role.role_id))));
    tableCell(row, '技能包', roleSkillPicker(role, state));
    const details = element('details', '', 'role-permission-details'); details.append(element('summary', '编辑权限'), rolePermissionEditor(role, state));
    tableCell(row, '权限控制', details); body.append(row);
  }
  overview.append(table, note('Agent 后端：' + data.backends.map(backend => backend.name + (backend.available ? '（可用）' : '（尚未接入）')).join('；')));
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
