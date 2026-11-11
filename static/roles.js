// Role settings share one draft across the overview and role pages. Only an explicit save changes the configuration.
const environmentLabels = { 'control-session': '受限主控会话', 'task-workspace': '任务工作区', 'candidate-checkout': '候选的独立检出', 'evaluation-checkout': '验收的独立检出', 'isolated-workspace': '每次运行独立容器', 'isolated-candidate': '独立容器内的固定候选' };
const outputLabels = { 'delivery-nomination': '提名交付候选', 'coordination-result': '跨任务建议', 'entry-delivery': '任务交付结果', 'role-findings': '检视或测试发现', 'acceptance-verdict': '独立验收结论' };
const budgetFields = [['max_turns', '单次运行最多模型轮数', 4, 256], ['max_output_tokens', '单次输出最多 token', 256, 32768], ['max_total_tokens', '任务累计 token', 1000, 100000000], ['max_model_requests', '任务累计模型请求', 1, 10000], ['max_tool_calls', '任务累计工具调用', 1, 10000], ['max_wall_seconds', '任务累计秒数', 60, 86400]];

function roleSelect(name, value, choices, change) {
  const select = document.createElement('select'); select.name = name; select.setAttribute('aria-label', name);
  for (const choice of choices) { const [id, title, disabled] = choice; const option = new Option(title, id); option.disabled = !!disabled; select.add(option); }
  if (!Array.from(select.querySelectorAll('option')).some(option => option.value === String(value ?? ''))) select.add(new Option(`当前选项不可用：${value}`, value));
  select.value = value ?? ''; select.addEventListener('change', () => change(select.value)); return select;
}
// The list states which revision is in force and whether the draft has moved away from it; every control that
// dirties the draft refreshes that line, so "saved" and "edited but not saved" are never confused.
let roleDraftStatus = null;
const roleVersionText = state => state.data.configured === false ? '推荐配置 · 尚未保存' : `配置版本 ${state.data.revision} · ${state.dirty ? '草稿未保存' : '已生效'}`;
function markRoleDirty(state) {
  state.dirty = true;
  if (roleDraftStatus) roleDraftStatus.textContent = roleVersionText(state);
}
function roleBound(control, change, state) {
  const edit = () => { change(control.type === 'checkbox' ? control.checked : control.value); markRoleDirty(state); };
  control.addEventListener('input', edit); control.addEventListener('change', edit); return control;
}
function roleText(label, object, key, state, { multiline = false, ...attributes } = {}) {
  return field(label, roleBound((multiline ? textarea : input)(key, object[key], attributes), value => { object[key] = value; }, state));
}
function roleCheck(label, object, key, state, disabled = false) {
  const wrap = checkbox(key, object[key], label), control = wrap.querySelector('input'); control.disabled = disabled;
  roleBound(control, value => { object[key] = value; }, state); return wrap;
}
function roleChoices(title, object, key, choices, state) {
  const group = element('fieldset', '', 'role-choices'); group.append(element('legend', title));
  for (const [id, caption] of choices) {
    const wrap = checkbox(key + ':' + id, (object[key] || []).includes(id), caption), control = wrap.querySelector('input');
    roleBound(control, checked => { object[key] = checked ? [...new Set([...(object[key] || []), id])] : (object[key] || []).filter(value => value !== id); if (['role_ids', 'tools'].includes(key) && !object[key].length) delete object[key]; }, state); group.append(wrap);
  }
  return group;
}
function roleModelPicker(role, state, redraw) {
  const { data } = state, backend = data.harnesses.find(entry => entry.id === role.harness_ref.id), external = !!backend?.externalModel;
  const select = roleSelect(role.role_id + ' 模型', role.model_profile_ref?.model_id || '', [['', external ? 'Agent 自带模型' : '继承任务模型或项目默认'], ...(data.models || []).map(model => [model.id, model.name + (model.shared ? '（共享）' : '')])], id => {
    markRoleDirty(state);
    role.model_profile_ref = id ? { model_id: id, api: backend?.model_api?.[0] || 'openai-chat-completions', tool_calls: true, structured_output: backend?.structured_output?.includes('tool_call') ? 'tool_call' : backend?.structured_output?.[0] || 'tool_call' } : null;
  });
  if (redraw) select.addEventListener('change', redraw);
  select.disabled = external; return select;
}
function roleBackendPicker(role, state, redraw) {
  return roleSelect(role.role_id + ' Agent 后端', role.harness_ref.id, state.data.backends.map(backend => [backend.id, backend.name + (backend.recommended ? '（推荐）' : '') + (backend.available ? '' : '（尚不可用）'), !backend.available || !backend.kinds.includes(role.kind)]), id => {
    role.harness_ref = { id }; markRoleDirty(state);
    // A backend that brings its own model cannot accept a project model profile.
    if (state.data.harnesses.find(backend => backend.id === id)?.externalModel) role.model_profile_ref = null;
    redraw();
  });
}
const permissionModeLabels = { none: '无权限', read: '只读', write: '读写', allow: '允许', deny: '不允许', custom: '待迁移：保留原有操作' };
function permissionEditor(permissions, items, change, prefix = '', fixed = false) {
  const box = element('div', '', 'role-permissions');
  box.append(note('基础能力默认可用：处理自己的任务、读取当前会话、使用自己的技能与记忆、记录进度和提交本次结果。项目范围、运行契约和外部授权仍会检查。'));
  if (fixed) box.append(note('全部能力已允许；实际执行仍受当前用户授权、项目范围和入口支持情况约束。'));
  for (const [group, title] of [['platform', '平台能力'], ['github', 'GitHub']]) {
    const section = element('fieldset', '', 'role-permission-group'); section.append(element('legend', title));
    if (group === 'github') section.append(note('只读开放 github_read 等读取工具；读写还开放 github_write，由控制面以 bot 身份按 GitHub REST 接口写入，每次只签发这一项资源的短期写令牌，并转义 @、脱敏和记录审计。默认只有 Manager 可写，且只写它正在处理的事件所在仓库。检视结论、测试通过的 PR、Actions 重跑与失败提报、发行说明和门禁方案属于框架交付，由项目工作类型的写入控制，不需要这里的写权限。角色权限不会扩大 GitHub App 安装授权。'));
    for (const item of items.filter(item => item.group === group)) {
      const choices = item.modes.map(mode => [mode, permissionModeLabels[mode]]);
      if (permissions[item.id] === 'custom') choices.unshift(['custom', permissionModeLabels.custom, true]);
      const control = roleSelect(prefix + item.name + (prefix ? '权限' : ''), permissions[item.id], choices, value => { permissions[item.id] = value; change(); });
      control.disabled = fixed || item.supported === false;
      const row = element('div', '', 'role-permission-row'); row.append(field(item.name, control), note(item.detail));
      if (item.supported === false) row.append(note('当前没有通用角色执行工具；仅在已有专用入口提供。'));
      if (permissions[item.id] === 'custom') {
        const detail = item.id === 'computer' ? `文件：${permissionModeLabels[permissions.legacy_repository]}；命令：${permissionModeLabels[permissions.legacy_commands]}`
          : item.id === 'project_tasks' ? `其他任务：${permissionModeLabels[permissions.legacy_project_tasks || 'none']}；协调：${permissionModeLabels[permissions.legacy_coordination || 'none']}；调度：${permissionModeLabels[permissions.legacy_nomination || 'deny']}；旧派活附带任务控制：${permissionModeLabels[permissions.legacy_delegation_controls || 'deny']}`
          : Object.entries(permissions).filter(([key,value]) => key.startsWith('legacy_' + item.id.slice(7) + '_') && value === 'allow')
            .map(([key]) => ({ read: '读取', create: '创建', reply: '评论', labels: '分类标签', publish: '发布候选', report: '追加报障', write: '全部写入' })[key.split('_').at(-1)]).filter(Boolean).join('、');
        row.append(note('旧配置保留的能力：' + (detail || '无') + '。选择新等级后按该等级生效，新增能力不会静默启用。'));
      }
      section.append(row);
    }
    box.append(section);
  }
  return box;
}
function rolePermissionEditor(role, state) {
  return permissionEditor(role.permissions, state.data.permission_items || [], () => markRoleDirty(state), role.role_id + ' ');
}
// Arrays of named records merge by identity; order-sensitive lists (tools, dependencies, files) stay atomic.
// Undefined means removal. A conflicting removal cannot silently delete another editor's changes.
function mergeRoleDraft(base, draft, latest, choices = {}) {
  const conflicts = [], equal = (a, b) => JSON.stringify(a) === JSON.stringify(b), clone = value => structuredClone(value);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const merge = (before, local, remote, path) => {
    if (equal(local, before)) return clone(remote);
    if (equal(remote, before) || equal(local, remote)) return clone(local);
    const key = path.length === 1 && ({ roles: 'role_id', skills: 'id', required_stages: 'stage_id' })[path[0]];
    if (key && [before, local, remote].every(value => Array.isArray(value) && value.every(row => object(row) && typeof row[key] === 'string'))) {
      const maps = [before, local, remote].map(rows => new Map(rows.map(row => [row[key], row]))), rows = [];
      for (const id of new Set([...remote.map(row => row[key]), ...local.map(row => row[key])])) {
        const row = merge(...maps.map(map => map.get(id)), [...path, id]); if (row !== undefined) rows.push(row);
      }
      return rows;
    }
    if ([before, local, remote].every(object)) {
      const merged = {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(remote)])) {
        const value = merge(before[key], local[key], remote[key], [...path, key]); if (value !== undefined) merged[key] = value;
      }
      return merged;
    }
    const id = JSON.stringify(path), choice = choices[id];
    conflicts.push({ id, path, before: clone(before), draft: clone(local), latest: clone(remote), resolved: ['draft', 'latest'].includes(choice) });
    return clone(choice === 'draft' ? local : remote);
  };
  return { draft: merge(base, draft, latest, []), conflicts };
}
function editableRoleDraft(data, recommend = false) {
  const config = data.configuration;
  return { enabled: config.enabled, controller: structuredClone(config.controller),
    roles: config.roles.map(role => ({ ...editableRole(role), kind: role.kind,
      ...(recommend && !data.configured ? { harness_ref: { id: data.recommended_backend || 'pi' } } : {}) })),
    skills: structuredClone(data.skill_inputs), required_stages: structuredClone(config.required_stages || []) };
}
function roleComparison(state, redraw, clearFeedback) {
  const comparison = state.comparison, section = card('比较角色配置'), choices = {};
  const local = structuredClone(state.draft); delete local.deleted_roles;
  const merged = () => mergeRoleDraft(comparison.base, local, editableRoleDraft(comparison.latest), choices);
  section.append(note(`草稿基于版本 ${state.data.configuration.revision}；服务器最新版本 ${comparison.latest.configuration.revision}。未重叠的修改会合并，重叠字段须逐项选择。此操作只更新草稿，仍需保存。`));
  const status = note(''), apply = button('将修改应用到最新版本草稿', () => {
    const now = structuredClone(state.draft); delete now.deleted_roles;
    if (JSON.stringify(now) !== JSON.stringify(local)) { status.textContent = '草稿已变化，请重新读取最新版本并比较。'; apply.disabled = true; return; }
    const result = merged(); if (result.conflicts.some(row => !row.resolved)) return;
    const ids = new Set(result.draft.roles.map(role => role.role_id));
    state.draft = { ...result.draft, deleted_roles: comparison.latest.configuration.roles.filter(role => !ids.has(role.role_id)).map(role => role.role_id) };
    state.data = comparison.latest; state.base = editableRoleDraft(comparison.latest); state.conflict = false; state.comparison = null;
    markRoleDirty(state); clearFeedback(); redraw();
  });
  const conflicts = merged().conflicts;
  if (!conflicts.length) section.append(note('没有重叠修改：可以保留你的修改，同时保留服务器上其他人的更新。'));
  for (const row of conflicts) {
    const entry = element('fieldset', '', 'role-compare-field'); entry.append(element('legend', row.path.join(' › ') || '完整配置'));
    const values = element('div', '', 'role-compare-values');
    for (const [label, value] of [['原版本', row.before], ['你的草稿', row.draft], ['最新版本', row.latest]]) {
      const column = element('div'); column.append(element('strong', label), element('pre', value === undefined ? '（已移除）' : JSON.stringify(value, null, 2))); values.append(column);
    }
    entry.append(values, field('处理 ' + row.path.join(' › '), roleSelect('处理 ' + row.path.join(' › '), '', [['', '选择处理方式'], ['draft', '使用我的修改'], ['latest', '采用最新值']], value => {
      choices[row.id] = value; apply.disabled = merged().conflicts.some(row => !row.resolved);
    }))); section.append(entry);
  }
  apply.disabled = conflicts.length > 0;
  const localChanges = element('details'); localChanges.append(element('summary', '查看这份草稿与最新配置'));
  for (const [label, value] of [['你的草稿', local], ['最新配置', editableRoleDraft(comparison.latest)]]) { localChanges.append(element('h4', label), element('pre', JSON.stringify(value, null, 2))); }
  section.append(localChanges, status, apply); return section;
}
function rolesConsole() {
  const target = current, id = target.id, token = renderToken, holder = element('div', '', 'roles-page'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  const live = () => current === target && renderToken === token && current.section === 'roles' && holder.isConnected;
  let state, request = 0;
  const failed = err => {
    if (!live()) return;
    if ([401, 403].includes(err.status)) { target.rolesDraft = null; state = null; holder.replaceChildren(note('当前身份无权读取或修改角色配置，已清空本页草稿。'), message); }
    const description = err.code === 'invalid_stage_policy' ? stagePolicyErrorText(err.field) : err.message;
    if (err.code === 'invalid_stage_policy' && state) { state.stageError = { field: err.field, message: description }; state.focusStageError = true; }
    message.textContent = `${description}${err.field ? '（配置项：' + err.field + '）' : ''}`;
  };
  const compare = async () => {
    if (!state || state.busy) return;
    const revision = ++request; state.busy = true; draw(); message.textContent = '';
    try {
      const latest = await api(`/api/repositories/${id}/roles`);
      if (!live() || revision !== request) return;
      state.comparison = { base: state.base, latest }; state.conflict = true; state.focusComparison = true;
    } catch (err) { failed(err); }
    finally { if (state) state.busy = false; if (state) state.redraw?.(); }
  };
  const draw = () => {
    if (!live() || !state) return;
    state.redraw = draw;
    holder.replaceChildren(); roleDraftStatus = null;
    const nav = element('nav', '', 'role-nav'); nav.setAttribute('aria-label', '角色列表');
    const requestedView = new URLSearchParams(location.hash.split('?')[1] || '').get('view');
    const auxiliaryView = !current.item && ['skills', 'stages'].includes(requestedView) ? requestedView : '';
    for (const [key, title] of [['', '概览'], ...state.draft.roles.map(role => [role.role_id, roleLabel(role.role_id, role.name)])]) {
      const item = element('a', title); item.href = `#/projects/${id}/roles${key ? '/' + key : ''}`;
      if ((current.item || '') === key && !auxiliaryView) item.setAttribute('aria-current', 'page'); nav.append(item);
    }
    for (const [view, title] of [['stages', '阶段策略'], ['skills', '技能包目录']]) {
      const link = element('a', title); link.href = `#/projects/${id}/roles?view=${view}`;
      if (auxiliaryView === view) link.setAttribute('aria-current', 'page'); nav.insertBefore(link, nav.children[1] || null);
    }
    const fields = element('fieldset', '', 'role-editor-fields'); fields.disabled = !!state.busy;
    const role = state.draft.roles.find(role => role.role_id === current.item);
    if (auxiliaryView === 'skills') { roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; fields.append(roleDraftStatus, roleSkillsWorkspace(state, draw)); }
    else if (auxiliaryView === 'stages') { roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; fields.append(roleDraftStatus, roleStageWorkspace(state, draw)); }
    else if (current.item && !role) fields.append(note('这个角色已不存在，请在概览选择角色。'));
    else if (role) {
      roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; fields.append(roleDraftStatus, roleSettingsCard(role, state, draw, { live, failed }));
      if (role.role_id === 'manager') fields.append(...managerSection(state.data));
    } else fields.append(...roleOverviewCards(state, draw));
    holder.append(nav);
    const comparison = state.comparison ? roleComparison(state, draw, () => { message.textContent = ''; }) : null;
    const actions = element('div', '', 'actions role-save');
    const status = note(state.busy ? '正在读取或保存…' : state.dirty ? '草稿未保存；运行中任务保留原有快照。' : '保存后影响新任务和后续委派；运行中任务保留原有快照。'); status.setAttribute('role', 'status');
    const save = button('保存角色配置', async () => {
      if (state.busy || state.conflict) return;
      state.busy = true; draw(); message.textContent = '';
      try {
        const { required_stages, ...draft } = structuredClone(state.draft);
        const stagesChanged = JSON.stringify(required_stages) !== JSON.stringify(state.data.configuration.required_stages || []);
        await api(`/api/repositories/${id}/roles`, 'PUT', { ...draft, roles: draft.roles.map(({ kind, ...role }) => role), ...(stagesChanged ? { required_stages } : {}), expected_revision: state.data.configuration.revision });
        // The result belongs to this project; navigating elsewhere must not clear that other project's draft.
        if (target.rolesDraft === state) target.rolesDraft = null;
        if (current === target && current.section === 'roles') await reloadWith('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
      } catch (err) {
        if (live() && err.code === 'role_configuration_conflict') { state.conflict = true; message.textContent = '角色配置已被别人修改。当前草稿仍保留，请读取最新版本并比较。'; }
        else failed(err);
      } finally { if (state) state.busy = false; if (state) state.redraw?.(); }
    }, ''); save.disabled = !!state.busy || !!state.conflict;
    const compareButton = button('读取最新版本并比较', compare); compareButton.disabled = !!state.busy;
    const discard = button('放弃草稿并刷新', async () => {
      if (state.busy) return;
      if (state.dirty && !await askConfirm({ title: '放弃未保存的角色修改？', body: ['刷新后读取服务器上的最新配置。'], action: '放弃并刷新' })) return;
      if (!live()) return; target.rolesDraft = null; await read();
    }); discard.disabled = !!state.busy;
    actions.append(status, message, save, compareButton, discard); holder.append(actions);
    if (comparison) holder.append(comparison); holder.append(fields);
    if (state.stageError && state.focusStageError) { state.focusStageError = false; focusStagePolicyError(holder, state.stageError); }
    if (comparison && state.focusComparison) {
      state.focusComparison = false;
      comparison.style.scrollMarginTop = `${Math.ceil(actions.getBoundingClientRect().height) + 16}px`;
      comparison.scrollIntoView({ block: 'start' });
      const heading = comparison.querySelector('h3'); heading.tabIndex = -1; heading.focus({ preventScroll: true });
    }
  };
  const read = async () => {
    const revision = ++request; holder.replaceChildren(note('正在读取角色配置…'), message); message.textContent = '';
    try {
      const data = await api(`/api/repositories/${id}/roles`);
      if (!live() || revision !== request) return;
      state = target.rolesDraft;
      if (!state || !state.dirty) {
        const base = editableRoleDraft(data);
        state = { data, base, dirty: false, draft: { ...editableRoleDraft(data, true), deleted_roles: [] } }; target.rolesDraft = state;
      }
      draw();
    } catch (err) {
      if (!live() || revision !== request) return;
      failed(err);
      if (![401,403].includes(err.status)) holder.replaceChildren(note('角色配置读取失败，当前状态未知。保留的草稿尚未提交。'), message, button('重试读取角色配置', read));
    }
  };
  holder.append(note('正在读取角色配置…')); void read(); return [holder];
}
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
function roleSkillPicker(role, state) {
  return roleSelect(role.role_id + ' 技能包', role.skill_bundle_ref?.id || '', [['', '不绑定技能包'], ...state.draft.skills.map(bundle => [bundle.id, bundle.id])], id => { role.skill_bundle_ref = id ? { id } : null; markRoleDirty(state); });
}
function roleModelResolution(role, state, access) {
  const region = element('section', '', 'role-model-resolution'); region.setAttribute('aria-label', '按工作类型检查已保存模型');
  const repositoryId = current.id, saved = state.data.configuration.roles.find(entry => entry.role_id === role.role_id);
  region.append(element('h5', '按工作类型检查已保存模型'), note('只读取已保存角色定义，未保存的选择不参与解析；不会启动任务或修改运行历史。具体任务使用的配置仍以任务详情中的运行快照为准。'));
  if (role.role_id === 'dev' && state.data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') region.append(note('尚未显式变更开发角色的后端时，检视与 Actions 开发入口仍使用 Pi；这里读取的是角色定义本身。'));
  const choices = new Map(builtInTasks.map(task => [task.kind, task.title]));
  try { for (const kind of Object.keys(taskModelMap(current.policy))) if (!choices.has(kind)) choices.set(kind, kind); } catch { /* The server remains authoritative for an invalid saved policy. */ }
  state.modelResolutionTypes ||= new Map();
  const selected = state.modelResolutionTypes.get(role.role_id) || (role.role_id === 'manager' ? 'manager' : state.data.workflow || 'development.issue');
  if (!choices.has(selected)) choices.set(selected, selected);
  const result = element('div'), status = note('尚未读取此工作类型的已保存解析，当前结果未知。'); status.setAttribute('role', 'status');
  let request = 0;
  const version = state.data.configuration.revision, live = () => access.live() && region.isConnected && state.data.configuration.revision === version;
  const selector = roleSelect('解析工作类型', selected, [...choices], value => {
    state.modelResolutionTypes.set(role.role_id, value); request++; result.replaceChildren();
    status.textContent = '尚未读取此工作类型的已保存解析，当前结果未知。'; read.disabled = false;
  });
  const read = button('读取已保存模型解析', async () => {
    const sequence = ++request, workflow = selector.value; read.disabled = true; result.replaceChildren(); status.textContent = '正在读取已保存配置的解析…';
    try {
      const value = await api(`/api/repositories/${repositoryId}/roles/resolve`, 'POST', { role: role.role_id, workflow, expected_revision: version });
      if (!live() || sequence !== request) return;
      const snapshot = value.snapshot, model = snapshot.model, external = model.source === 'external_harness';
      const facts = element('dl');
      for (const [caption, text] of [['工作类型', choices.get(workflow) || workflow], ['配置版本', snapshot.config_revision], ['角色版本', snapshot.role_revision],
        ['Agent 后端', `${harnessName(snapshot.harness.id)} · ${snapshot.harness.version}`], ['模型来源', external ? '执行器自带模型' : own(modelSources, model.source) || model.source],
        ['模型名称', external ? '由执行器管理，不使用项目模型' : model.name], ['模型标识', external ? '不适用' : model.id], ['模型记录版本', external ? '不适用' : model.version]]) {
        facts.append(element('dt', caption), element('dd', String(text)));
      }
      result.append(facts, note('解析标识：' + value.snapshot_id)); status.textContent = '已读取已保存配置；没有保存草稿或启动任务。';
    } catch (err) {
      if (!live() || sequence !== request) return;
      if ([401, 403].includes(err.status)) { access.failed(err); return; }
      const reasons = { role_configuration_changed: '配置版本已变化，请读取最新角色配置并比较草稿后再检查。', role_disabled: '此角色已停用。',
        role_model_not_available: '显式选择的角色模型已删除、撤销或不可访问，不会换用其他模型。', role_model_profile_changed: '角色模型的地址或名称已变化，需要重新保存角色配置。',
        model_unavailable: '继承的模型当前不可用，不会换用其他模型。', model_not_configured: '此工作类型没有可用的已配置模型。',
        harness_model_profile_unsupported: '此执行器使用自带模型，不能指定项目模型。', harness_role_unsupported: '执行器不支持此角色类型。' };
      status.textContent = `解析失败，当前结果未知：${reasons[err.code] || err.message}${err.field ? '（配置项：' + err.field + '）' : ''}`;
    } finally { if (live() && sequence === request) read.disabled = false; }
  });
  region.append(field('解析工作类型', selector), read, status, result); return region;
}
function roleSettingsCard(role, state, redraw, access) {
  const section = card(roleLabel(role.role_id, role.name) + ' 设置'), nav = element('nav', '', 'role-editor-nav');
  nav.setAttribute('aria-label', '角色设置分区'); section.append(nav);
  const group = (key, title) => {
    const box = element('section', '', 'role-editor-group'), heading = element('h4', title); box.id = `role-${role.role_id}-${key}`; heading.tabIndex = -1;
    const jump = button(title, () => {
      const toolbar = section.closest('.roles-page').querySelector('.role-save');
      box.style.scrollMarginTop = `${Math.ceil(toolbar.getBoundingClientRect().height) + 16}px`;
      box.scrollIntoView({ block: 'start' }); heading.focus({ preventScroll: true });
    }, 'quiet'); jump.setAttribute('aria-controls', box.id); nav.append(jump);
    box.append(heading); section.append(box); return box;
  };
  const basic = group('basic', '基本信息');
  basic.append(roleText('显示名称', role, 'name', state, { maxLength: 80 }), roleCheck('启用角色', role, 'enabled', state, ['controller', 'evaluator'].includes(role.kind)),
    roleText('职责', role, 'responsibility', state, { multiline: true, rows: 3, maxLength: 2000 }));
  const agent = group('agent', 'Agent 与模型');
  agent.append(note('已保存 · ' + workTypeName(state.data.workflow) + '：' + roleModelText(state.data.preview.find(row => row.role === role.role_id))), note('下面是待保存的选择；修改不会重写运行中任务的模型快照。'), field('Agent 后端', roleBackendPicker(role, state, redraw)), field('模型', roleModelPicker(role, state, redraw)));
  const profile = role.model_profile_ref, backend = state.data.harnesses.find(entry => entry.id === role.harness_ref.id);
  if (profile) {
    agent.append(field('模型 API', roleSelect('模型 API', profile.api, (backend?.model_api || []).map(id => [id, id]), value => { profile.api = value; markRoleDirty(state); })),
      roleCheck('模型支持工具调用', profile, 'tool_calls', state), field('结构化输出方式', roleSelect('结构化输出方式', profile.structured_output, (backend?.structured_output || []).map(id => [id, id]), value => { profile.structured_output = value; markRoleDirty(state); })));
  }
  agent.append(roleModelResolution(role, state, access));
  const prompts = group('prompts', '提示词');
  const system = textarea('system_prompt', state.data.system_prompt, { rows: 6, readOnly: true }); system.setAttribute('aria-label', '系统提示词'); system.readOnly = true;
  prompts.append(field('系统提示词', system), note('所有角色共用的系统背景、环境说明和基本行为准则。角色职责与任务记录规则在下面的提示词中直接修改。'));
  prompts.append(roleText('角色提示词', role, 'persona_prompt', state, { multiline: true, rows: 18, maxLength: 32000 }), note('这份提示词包含角色完整的职责与行为要求，可以全部修改或清空；系统不会再追加固定职责。'), button('恢复角色模板', async () => {
    if (!await askConfirm({ title: '恢复角色模板？', body: ['当前角色提示词将替换为默认模板，保存后生效。'], action: '恢复模板' })) return;
    role.persona_prompt = (Object.hasOwn(state.data.role_templates, role.role_id) ? state.data.role_templates[role.role_id] : state.data.role_templates.observer); markRoleDirty(state); redraw();
  }));
  group('skills', '技能包').append(field('技能包', roleSkillPicker(role, state)));
  group('permissions', '权限').append(rolePermissionEditor(role, state));
  const runtime = group('runtime', '环境与输出');
  const environment = state.data.environment_profiles.filter(entry => entry.kinds.includes(role.kind));
  runtime.append(field('运行环境', roleSelect('运行环境', role.environment_profile_ref.id, environment.map(entry => [entry.id, environmentLabels[entry.id] || entry.id, entry.isolation === 'run_container' && backend?.capabilities?.isolation !== 'run_environment']), id => { role.environment_profile_ref = { id }; markRoleDirty(state); })));
  runtime.append(field('输出结果', roleSelect('输出结果', role.output_schema_ref.id, state.data.output_schemas.filter(entry => entry.kinds.includes(role.kind)).map(entry => [entry.id, outputLabels[entry.id] || entry.id]), id => { role.output_schema_ref = { id }; markRoleDirty(state); })));
  const budget = group('budget', '预算');
  budget.append(field('预算方式', roleSelect('预算方式', role.budget_policy_ref.id, [['entry-default', '沿用任务限制'], ['bounded', '限制单次运行'], ['metered', '限制任务累计用量']], id => {
    const old = role.budget_policy_ref; role.budget_policy_ref = id === 'entry-default' ? { id } : { id, max_turns: old.max_turns || 32, max_output_tokens: old.max_output_tokens || 4096 }; markRoleDirty(state); redraw();
  })));
  if (role.budget_policy_ref.id !== 'entry-default') {
    for (const [key, title, min, max] of budgetFields.slice(0, role.budget_policy_ref.id === 'bounded' ? 2 : undefined)) {
      const control = input(key, role.budget_policy_ref[key] ?? '', { type: 'number', min, max, step: 1 });
      budget.append(field(title, roleBound(control, value => { if (value === '') delete role.budget_policy_ref[key]; else role.budget_policy_ref[key] = Number(value); }, state)));
    }
    if (role.budget_policy_ref.id === 'metered') {
      const cost = role.budget_policy_ref.max_cost, amount = input('max_cost', cost?.amount || '', { type: 'number', min: 0.000001, max: 1000000, step: 'any' });
      const currency = roleSelect('预算币种', cost?.currency || 'USD', [['USD', '美元'], ['CNY', '人民币']], value => { if (role.budget_policy_ref.max_cost) role.budget_policy_ref.max_cost.currency = value; markRoleDirty(state); });
      budget.append(field('任务累计金额上限（留空不设置）', roleBound(amount, value => { if (value === '') delete role.budget_policy_ref.max_cost; else role.budget_policy_ref.max_cost = { amount: Number(value), currency: currency.value }; }, state)), field('预算币种', currency));
    }
  }
  if (!(state.data.required_roles || ['manager', 'coordinator', 'qa']).includes(role.role_id)) group('danger', '删除角色').append(button('删除这个角色', async () => {
    const stages = state.draft.required_stages.filter(stage => stage.role_constraints.role_ids?.includes(role.role_id));
    if (stages.length) { await askConfirm({ title: '先调整任务阶段', body: ['这些阶段仍指定了该角色：' + stages.map(stage => stage.stage_id).join('、') + '。请在概览中修改阶段角色或移除阶段，再删除角色。'], action: '知道了' }); return; }
    if (!await askConfirm({ title: '删除角色 ' + role.name + '？', body: ['保存后该角色不再参与新任务，正在运行的角色也会停止使用工具。阶段要求如引用此角色，需要一并调整。'], action: '删除角色' })) return;
    state.draft.roles = state.draft.roles.filter(entry => entry !== role);
    if (state.data.configuration.roles.some(entry => entry.role_id === role.role_id)) state.draft.deleted_roles = [...new Set([...(state.draft.deleted_roles || []), role.role_id])]; markRoleDirty(state); current.item = null; history.replaceState(null, '', `#/projects/${current.id}/roles`); redraw(); }, 'quiet destructive'));
  return section;
}
const skillSourceNames = { builtin: '内置指南', repository: '固定仓库提交', inline: '控制台文件' };
function roleSkillFacts(bundle, state) {
  const saved = state.data.configuration.skills.find(entry => entry.id === bundle.id), box = element('section', '', 'skill-saved-facts'); box.setAttribute('aria-label', '已保存技能版本');
  const savedBindings = state.data.configuration.roles.filter(role => role.skill_bundle_ref?.id === bundle.id).map(role => roleLabel(role.role_id, role.name));
  box.append(facts([['已保存版本', saved ? String(saved.revision) : '此标识尚未保存'], ['已保存来源', saved ? skillSourceNames[saved.source.type] || saved.source.type : '尚未保存'], ['已保存绑定角色', savedBindings.join('、') || '无'], ['内容哈希', saved?.content_hash || '保存后由服务端计算']]));
  if (saved?.source.type === 'repository') box.append(note('已固定提交：' + saved.source.commit));
  const table = projectTable(['文件', '大小', 'SHA-256'], '已保存技能文件');
  for (const file of saved?.files || []) { const row = document.createElement('tr'); tableCell(row, '文件', element('code', file.path)); tableCell(row, '大小', note(String(file.bytes) + ' B')); tableCell(row, 'SHA-256', element('code', file.sha256)); table.body.append(row); }
  if (saved?.files?.length) box.append(table.table); else box.append(note('尚无已保存的文件清单；下面编辑的是草稿。'));
  if (bundle.source.type === 'repository') {
    const cached = state.data.skill_sources?.repository;
    box.append(note(cached ? '当前可选仓库文件来自提交：' + cached.commit : '尚未读取仓库技能缓存；新的仓库来源需要先读取默认分支规则文件。'));
    if (cached?.commit !== bundle.source.commit) box.append(note('草稿指定的提交与当前仓库缓存不同。未更改的已固定包可原样保存；更换标识、路径或提交需要先取得对应版本，不会自动更新到分支最新内容。'));
  }
  return box;
}
function roleSkillsWorkspace(state, redraw) {
  const section = card('技能包目录'); section.classList.add('skill-workspace'); section.setAttribute('aria-label', '技能包目录');
  section.append(note('技能是角色的工作材料，不会增加工具、权限或必需阶段。已保存的来源、版本和文件清单与下面的待保存草稿分开显示。'));
  const layout = element('div', '', 'skill-catalog-layout'), sidebar = element('div', '', 'skill-catalog-sidebar'), search = input('skill_search', state.skillSearch || '', { placeholder: '按标识或来源搜索' });
  const list = element('nav', '', 'skill-catalog-nav'); list.setAttribute('aria-label', '技能包列表'); search.setAttribute('aria-label', '搜索技能包'); sidebar.append(field('搜索技能包', search), list);
  const active = state.draft.skills.includes(state.activeSkill) ? state.activeSkill : state.draft.skills.find(bundle => bundle.id === state.activeSkill?.id) || state.draft.skills[0]; state.activeSkill = active;
  const drawList = () => {
    const query = search.value.trim().toLowerCase(), matching = state.draft.skills.filter(bundle => (bundle.id + ' ' + bundle.source.type + ' ' + (skillSourceNames[bundle.source.type] || bundle.source.type)).toLowerCase().includes(query)); list.replaceChildren();
    for (const bundle of matching) { const item = button(bundle.id + ' · ' + (skillSourceNames[bundle.source.type] || bundle.source.type), () => { state.activeSkill = bundle; redraw(); }, 'quiet');
      item.setAttribute('aria-pressed', String(bundle === active)); list.append(item); }
    if (!matching.length) list.append(note(state.draft.skills.length ? '没有匹配的技能包；当前编辑草稿仍保留。' : '尚无技能包，请在右侧或下方创建。'));
  };
  search.addEventListener('input', () => { state.skillSearch = search.value; drawList(); }); drawList();
  const editor = roleSkillsCard(state, redraw, active || null); editor.classList.add('skill-catalog-editor');
  layout.append(sidebar, editor); section.append(layout); return section;
}
function roleSkillsCard(state, redraw, selected = null) {
  const section = card('技能包'), { draft, data } = state;
  section.append(note('创建技能包后，可以在概览或角色设置中绑定。内置指南、仓库文件和自定义文本都通过表单配置。'));
  for (const bundle of selected ? [selected] : draft.skills) {
    const group = element('fieldset', '', 'role-skill'); const name = roleBound(input('bundle_id', bundle.id), value => { const old = bundle.id; bundle.id = value; for (const role of draft.roles) if (role.skill_bundle_ref?.id === old) role.skill_bundle_ref.id = value; }, state);
    name.addEventListener('change', redraw);
    group.append(element('legend', bundle.id), field('技能包名称', name));
    if (selected) group.append(roleSkillFacts(bundle, state));
    group.append(field('来源', roleSelect('技能来源', bundle.source.type, [['builtin', '内置指南'], ['repository', '仓库技能文件'], ['inline', '自定义文件']], type => {
      bundle.source = type === 'builtin' ? { type, playbooks: [] } : type === 'repository' ? { type, commit: data.skill_sources?.repository?.commit || '', paths: [] } : { type, files: [{ path: 'guide.md', content: '' }] }; markRoleDirty(state); redraw();
    })));
    if (bundle.source.type === 'builtin') group.append(roleChoices('内置指南', bundle.source, 'playbooks', (data.playbooks || []).map(entry => [entry.id, entry.name]), state));
    else if (bundle.source.type === 'repository') {
      group.append(roleText('固定仓库提交', bundle.source, 'commit', state, { maxLength: 40 }), roleChoices('仓库技能文件', bundle.source, 'paths', [...new Set([...(bundle.source.paths || []), ...(data.skill_sources?.repository?.paths || [])])].map(path => [path, path]), state));
    } else {
      for (const file of bundle.source.files) group.append(roleText('文件路径', file, 'path', state), roleText('文件内容', file, 'content', state, { multiline: true, rows: 5 }), button('移除文件', () => { bundle.source.files = bundle.source.files.filter(entry => entry !== file); markRoleDirty(state); redraw(); }));
      group.append(button('添加文件', () => { bundle.source.files.push({ path: '', content: '' }); markRoleDirty(state); redraw(); }));
    }
    if (selected) {
      const bindings = element('fieldset', '', 'role-choices'); bindings.append(element('legend', '草稿绑定角色'));
      for (const role of draft.roles) { const wrap = checkbox('bind:' + role.role_id, role.skill_bundle_ref?.id === bundle.id, roleLabel(role.role_id, role.name));
        roleBound(wrap.querySelector('input'), checked => { if (checked) role.skill_bundle_ref = { id: bundle.id }; else if (role.skill_bundle_ref?.id === bundle.id) role.skill_bundle_ref = null; }, state); bindings.append(wrap); }
      group.append(bindings, note('移除技能包会同时解除草稿中的角色绑定；保存后影响新任务，运行中的快照保持。'));
    }
    group.append(button('移除技能包', () => { draft.skills = draft.skills.filter(entry => entry !== bundle); for (const role of draft.roles) if (role.skill_bundle_ref?.id === bundle.id) role.skill_bundle_ref = null; markRoleDirty(state); redraw(); }, 'quiet destructive')); section.append(group);
  }
  section.append(button('添加技能包', () => { let n = 1; while (draft.skills.some(bundle => bundle.id === 'skills_' + n)) n++; const bundle = { id: 'skills_' + n, source: { type: 'inline', files: [{ path: 'guide.md', content: '' }] } }; draft.skills.push(bundle); state.activeSkill = bundle; state.skillSearch = ''; markRoleDirty(state); redraw(); })); return section;
}

// A read-only layout of the current draft, not an execution plan or a substitute for server validation.
function stagePolicyGraph(stages) {
  if (!Array.isArray(stages)) return { layers: [], issues: [{ code: 'unavailable' }] };
  const nodes = new Map(), issues = [];
  for (const [index, stage] of stages.entries()) {
    const id = stage?.stage_id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) { issues.push({ code: 'invalid_id', index, id }); continue; }
    if (nodes.has(id)) issues.push({ code: 'duplicate_id', id });
    else nodes.set(id, stage);
    if (!Array.isArray(stage.depends_on) || stage.depends_on.some(id => typeof id !== 'string') || new Set(stage.depends_on).size !== stage.depends_on.length) issues.push({ code: 'invalid_dependencies', id });
  }
  if (issues.length) return { layers: [], issues };
  for (const [id, stage] of nodes) for (const dependency of stage.depends_on) {
    const parent = nodes.get(dependency);
    if (!parent) issues.push({ code: 'missing_dependency', id, dependency });
    else {
      if (stage.required && !parent.required) issues.push({ code: 'optional_dependency', id, dependency });
      const missing = (stage.delivery_types || []).filter(type => !(parent.delivery_types || []).includes(type));
      if (missing.length) issues.push({ code: 'delivery_mismatch', id, dependency, types: missing });
    }
  }
  if (issues.length) return { layers: [], issues };
  const remaining = new Set(nodes.keys()), done = new Set(), layers = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => nodes.get(id).depends_on.every(parent => done.has(parent)));
    if (!ready.length) return { layers: [], issues: [{ code: 'cycle', ids: [...remaining] }] };
    layers.push(ready); for (const id of ready) { remaining.delete(id); done.add(id); }
  }
  return { layers, issues: [] };
}
const stageDeliveryNames = { code: '代码', artifact: '文档或其他产物', no_changes: '无需修改' };
function stageIssueText(issue) {
  return issue.code === 'unavailable' ? '阶段草稿不可读取，依赖结构未知。'
    : issue.code === 'invalid_id' ? `第 ${issue.index + 1} 个阶段标识无效：以小写字母开头，最多 64 个小写字母、数字、下划线或连字符。`
    : issue.code === 'duplicate_id' ? `阶段标识 ${issue.id} 重复，请为阶段使用唯一标识。`
    : issue.code === 'invalid_dependencies' ? `阶段 ${issue.id} 的依赖列表无效或有重复。`
    : issue.code === 'missing_dependency' ? `${issue.id} 依赖的 ${issue.dependency} 不存在。`
    : issue.code === 'optional_dependency' ? `必需阶段 ${issue.id} 依赖了可选阶段 ${issue.dependency}。`
    : issue.code === 'delivery_mismatch' ? `${issue.id} 用于${issue.types.map(type => stageDeliveryNames[type] || type).join('、')}，但依赖阶段 ${issue.dependency} 不覆盖这些交付类型。`
    : `以下阶段存在循环或依赖于循环，无法按依赖排序：${issue.ids.join('、')}。`;
}
function stagePolicyErrorText(field) {
  const key = String(field || '').split('.').at(-1);
  return ({ cycle: '阶段依赖形成循环，请调整依赖。', unreachable_dependency: '阶段依赖不可达，请查看依赖预览中的缺失、可选或交付范围提示。',
    unreachable_role: '没有启用且符合约束的执行角色，请检查角色类型、限定角色和启用状态。', independence: '独立阶段需使用观察角色，并具备全新上下文、读取固定候选和原始证据能力。',
    writer_dependency: '开发阶段不能依赖其他阶段。', completion: '检查证据类型、最少证据数和待处理发现要求；开发阶段不能要求没有待处理发现。',
    retry: '最多尝试次数需要是 1–20 的整数。', budget: '阶段工具调用需要是 1–10000 的整数，秒数为 1–86400；留空不新增阶段限制。',
    multiple_writers: '同一种交付类型最多配置一个开发阶段。', duplicate_stage_id: '阶段标识重复，请使用唯一标识。', stage_id: '阶段标识需要以小写字母开头，最多 64 个小写字母、数字、下划线或连字符。',
    depends_on: '依赖列表无效，请为阶段选择不同的依赖。', role_constraints: '请选择执行角色类型和必需能力，并检查限定角色。',
    delivery_types: '请为阶段选择至少一种适用交付类型。', stages: '阶段列表无效，最多配置 32 个阶段。' })[key] || '阶段策略未通过检查，请查看标出的阶段及配置项。';
}
function scrollToRoleStage(group) {
  const toolbar = group.closest('.roles-page')?.querySelector('.role-save');
  group.style.scrollMarginTop = `${Math.ceil(toolbar?.getBoundingClientRect().height || 0) + 16}px`; group.tabIndex = -1;
  group.scrollIntoView({ block: 'start' }); group.focus({ preventScroll: true });
}
function focusStagePolicyError(holder, failure) {
  if (typeof failure.field !== 'string' || !failure.field.startsWith('required_stages')) return;
  const id = failure.field.split('.')[1], groups = [...holder.querySelectorAll('.role-stage')];
  const group = groups.find(group => group.dataset.stageId === id)
    || (id === 'stage_id' ? groups.find(group => !/^[a-z][a-z0-9_-]{0,63}$/.test(group.dataset.stageId)) : null);
  const target = group || holder.querySelector('[data-stage-policy-root]'); if (!target) return;
  target.setAttribute('aria-invalid', 'true');
  const message = target.querySelector(':scope > .stage-policy-error'); if (message) message.textContent = failure.message;
  scrollToRoleStage(target);
}
function roleStageWorkspace(state, redraw) {
  const section = element('div', '', 'stage-policy-page'), preview = card('阶段依赖预览'); preview.setAttribute('aria-label', '阶段依赖预览');
  const content = element('div'); preview.append(note('图中显示当前草稿的依赖层级；实际执行还受交付类型、角色、证据与预算约束。保存时仍由服务端检查，不会从图中创建任务。'), content);
  const forms = roleStagesCard(state, redraw, true);
  const render = () => {
    const graph = stagePolicyGraph(state.draft.required_stages); content.replaceChildren();
    if (graph.issues.length) {
      const errors = element('ul', '', 'stage-policy-issues'); for (const issue of graph.issues) errors.append(element('li', stageIssueText(issue)));
      content.append(element('p', '依赖预览暂不可用，请先修正以下问题；下方草稿仍保留。', 'view-error'), errors); return;
    }
    if (!graph.layers.length) { content.append(note('当前草稿没有额外阶段，原有交付与独立验收规则继续生效。')); return; }
    const levels = element('ol', '', 'stage-graph-layout'); levels.setAttribute('role', 'list');
    for (const [index, ids] of graph.layers.entries()) {
      const level = element('li', '', 'stage-graph-level'), nodes = element('ul', '', 'stage-graph-nodes'); level.append(element('h4', `依赖层 ${index + 1}`), nodes);
      for (const id of ids) {
        const stage = state.draft.required_stages.find(stage => stage.stage_id === id), node = element('li', '', 'side-card stage-graph-node');
        const jump = button('编辑阶段 ' + id, () => { const group = [...forms.querySelectorAll('.role-stage')].find(group => group.dataset.stageId === id); if (group) scrollToRoleStage(group); }, 'quiet');
        node.append(jump, badge(stage.required ? '必需' : '可选', 'info'), note('依赖：' + (stage.depends_on.join('、') || '无')),
          note('适用交付：' + (stage.delivery_types.map(type => stageDeliveryNames[type]).join('、') || '未选择'))); nodes.append(node);
      }
      levels.append(level);
    }
    content.append(levels);
  };
  section.addEventListener('input', render); section.addEventListener('change', render); render(); section.append(preview, forms); return section;
}
function stageDependencyReferences(state) {
  const stages = state.draft.required_stages, references = state.stageDependencies || new Map(); state.stageDependencies = references;
  const resolve = id => { const matches = stages.filter(stage => stage.stage_id === id); return matches.length === 1 ? matches[0] : id; };
  for (const stage of references.keys()) if (!stages.includes(stage)) references.delete(stage);
  for (const stage of stages) {
    const old = references.get(stage), ids = old?.map(parent => typeof parent === 'string' ? parent : parent.stage_id);
    // A new draft or an explicit dependency edit replaces its references; ordinary typing keeps stage identity.
    const parents = !old || JSON.stringify(ids) !== JSON.stringify(stage.depends_on) || old.some(parent => typeof parent !== 'string' && !stages.includes(parent))
      ? stage.depends_on.map(resolve) : old.map(parent => typeof parent === 'string' ? resolve(parent) : parent);
    references.set(stage, parents);
  }
  return references;
}
function syncStageDependencies(references) {
  for (const [stage, parents] of references) stage.depends_on = parents.map(parent => typeof parent === 'string' ? parent : parent.stage_id);
}
// Object references preserve the intended dependency even if typing briefly gives two stages the same id.
function roleStageDependencies(stage, state, references) {
  const group = element('fieldset', '', 'role-choices'); group.append(element('legend', '依赖阶段')); const controls = [];
  for (const parent of state.draft.required_stages.filter(entry => entry !== stage)) {
    const label = element('span', parent.stage_id), wrap = checkbox('depends_on:' + parent.stage_id, references.get(stage).includes(parent), ''); wrap.append(label); const control = wrap.querySelector('input');
    roleBound(control, checked => {
      const parents = references.get(stage).filter(entry => entry !== parent && !(typeof entry === 'string' && entry === parent.stage_id));
      if (checked) parents.push(parent); references.set(stage, parents); syncStageDependencies(references);
    }, state);
    group.append(wrap); controls.push({ control, label, parent });
  }
  return { group, refresh: () => { for (const { control, label, parent } of controls) { label.textContent = parent.stage_id; control.name = 'depends_on:' + parent.stage_id; control.checked = references.get(stage).includes(parent); } } };
}
function roleStagesCard(state, redraw, ordered = false) {
  const section = card('任务阶段要求'), { draft } = state; section.dataset.stagePolicyRoot = '';
  const stageRows = [], dependencies = [], references = stageDependencyReferences(state), list = ordered ? element('ol', '', 'stage-policy-cards') : section;
  section.append(note('配置任务必须完成的阶段、依赖和证据。独立验收始终保留；这里的要求由控制面检查。'));
  if (ordered) section.append(note('卡片顺序用于阅读与错误定位；实际执行以依赖关系和策略检查为准。'), list);
  const policyError = element('p', '', 'view-error stage-policy-error'); section.append(policyError);
  for (const stage of draft.required_stages) {
    const group = element('fieldset', '', 'role-stage'), legend = element('legend', stage.stage_id); group.dataset.stageId = stage.stage_id; stageRows.push({ group, legend, stage });
    const dependency = roleStageDependencies(stage, state, references); dependencies.push(dependency);
    const name = roleBound(input('stage_id', stage.stage_id, { maxLength: 64 }), value => { stage.stage_id = value; syncStageDependencies(references); }, state);
    group.append(legend, field('阶段标识', name), roleCheck('必须完成', stage, 'required', state));
    group.append(roleChoices('适用交付', stage, 'delivery_types', [['code', '代码'], ['artifact', '文档或其他产物'], ['no_changes', '无需修改']], state),
      dependency.group);
    group.append(field('执行角色类型', roleSelect('执行角色类型', stage.role_constraints.kinds[0], [['writer', '开发角色'], ['observer', '观察角色']], kind => { stage.role_constraints.kinds = [kind]; markRoleDirty(state); redraw(); })),
      roleChoices('限定角色（不选表示同类型任一角色）', stage.role_constraints, 'role_ids', draft.roles.filter(role => stage.role_constraints.kinds.includes(role.kind)).map(role => [role.role_id, roleLabel(role.role_id, role.name)]), state),
      roleCheck('要求独立执行', stage.role_constraints, 'independent', state),
      roleChoices('执行器必需能力', stage.role_constraints, 'capabilities', (state.data.stage_capabilities || []).map(entry => [entry.id, entry.name]), state),
      roleChoices('完成证据', stage.completion, 'evidence_types', [['tool_observation', '工具观察'], ['execution_evidence', '执行证据'], ['role_result', '角色结果']], state),
      roleCheck('必须没有待处理发现', stage.completion, 'no_findings', state), roleChoices('证据工具（可选）', stage.completion, 'tools', ['read_file', 'run_command', 'read_task_record', 'read_evidence', 'submit_delivery', 'finish'].map(id => [id, id]), state));
    for (const [object, key, caption, max, optional] of [[stage.completion, 'min_evidence', '最少证据数', 100], [stage.retry, 'max_attempts', '最多尝试次数', 20], [stage.budget, 'max_tool_calls', '阶段最多工具调用', 10000, true], [stage.budget, 'max_wall_seconds', '阶段最多秒数', 86400, true]]) {
      const control = input(key, object[key] ?? '', { type: 'number', min: 1, max, step: 1 }); group.append(field(caption, roleBound(control, value => { if (optional && !value) delete object[key]; else object[key] = Number(value); }, state)));
    }
    group.append(button('移除阶段', () => {
      draft.required_stages = draft.required_stages.filter(entry => entry !== stage); references.delete(stage);
      for (const [entry, parents] of references) references.set(entry, parents.filter(parent => parent !== stage));
      syncStageDependencies(references); markRoleDirty(state); redraw();
    }, 'quiet destructive'));
    const localError = element('p', '', 'view-error stage-policy-error'); group.append(localError);
    if (ordered) { const item = element('li'); item.append(group); list.append(item); } else section.append(group);
  }
  const refresh = () => { for (const { group, legend, stage } of stageRows) { group.dataset.stageId = stage.stage_id; legend.textContent = stage.stage_id; group.removeAttribute('aria-invalid'); group.querySelector('.stage-policy-error').textContent = ''; } for (const entry of dependencies) entry.refresh(); state.stageError = null; };
  section.addEventListener('input', refresh); section.addEventListener('change', refresh);
  const add = button('添加阶段', () => { let n = 1; while (draft.required_stages.some(stage => stage.stage_id === 'review_' + n)) n++; draft.required_stages.push({ stage_id: 'review_' + n, depends_on: [], delivery_types: ['code', 'artifact', 'no_changes'], role_constraints: { kinds: ['observer'], capabilities: ['fresh_context', 'fixed_candidate_read', 'raw_evidence'], independent: true }, required: true, completion: { evidence_types: ['role_result'], min_evidence: 1, no_findings: true }, retry: { max_attempts: 3 }, budget: {} }); markRoleDirty(state); redraw(); }); add.disabled = draft.required_stages.length >= 32; section.append(add); return section;
}
