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
const roleVersionText = state => plainSaveStatus(!!state.dirty, { configured: state.data.configured !== false });
function markRoleDirty(state) {
  state.dirty = true;
  const text = roleVersionText(state);
  document.querySelectorAll('[data-role-version]').forEach(el => { el.textContent = text; });
  if (roleDraftStatus) roleDraftStatus.textContent = text;
  // Show「保存」without waiting for a full redraw (e.g. after a prompt edit). If the bar was omitted
  // (unconfigured overview), redraw once so it appears.
  if (state.saveBar) state.saveBar.refresh({ dirty: true, status: text, saveLabel: '保存' });
  else state.redraw?.();
}
function roleBound(control, change, state) {
  const edit = () => { change(control.type === 'checkbox' ? control.checked : control.value); markRoleDirty(state); };
  control.addEventListener('input', edit); control.addEventListener('change', edit); return control;
}
function roleText(label, object, key, state, { multiline = false, ...attributes } = {}) {
  const raw = object[key];
  const shown = key === 'name' ? roleConfigName(object.role_id, raw)
    : key === 'responsibility' ? roleConfigDuty(object.role_id, raw)
    : raw;
  return field(label, roleBound((multiline ? textarea : input)(key, shown, attributes), value => { object[key] = value; }, state));
}
function requiredRoleLocked(role) {
  return ['controller', 'evaluator'].includes(role.kind);
}
function requiredEnableReason(role) {
  if (!requiredRoleLocked(role)) return '';
  return rolePageText('requiredEnable').replace('{name}', roleConfigName(role.role_id, role.name));
}
// `reason` explains a locked required-role control (#569); `redraw` refreshes per-row list status on change (d016f0ed).
function roleCheck(label, object, key, state, disabled = false, { reason = '', redraw = null } = {}) {
  const wrap = checkbox(key, object[key], label), control = wrap.querySelector('input');
  control.disabled = disabled;
  wrap.classList.add('role-enable');
  roleBound(control, value => { object[key] = value; }, state);
  if (redraw) control.addEventListener('change', redraw);
  if (!disabled || !reason) return wrap;
  control.setAttribute('aria-disabled', 'true');
  const why = element('p', reason, 'role-enable-reason muted');
  why.setAttribute('data-testid', 'role-enable-reason');
  const block = element('div', '', 'role-enable-block');
  block.append(wrap, why);
  // One space-free id per role, so every locked row in the list points at its own reason.
  why.id = 'role-enable-reason-' + String(object.role_id || control.id || key).replace(/[^A-Za-z0-9_-]/g, '-');
  control.setAttribute('aria-describedby', why.id);
  return block;
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
  const { data } = state, backend = data.harnesses.find(entry => entry.id === role.harness_ref.id);
  const subscription = role.harness_ref?.model_source === 'subscription';
  const external = !!backend?.externalModel;
  const defaultLabel = subscription ? '供应商订阅模式（预留 · 未实现）' : external ? 'Agent 自带模型' : '继承任务模型或项目默认';
  const select = roleSelect(role.role_id + ' 模型', role.model_profile_ref?.model_id || '', [['', defaultLabel], ...(data.models || []).map(model => [model.id, model.name + (model.shared ? '（共享）' : '')])], id => {
    markRoleDirty(state);
    role.model_profile_ref = id ? { model_id: id, api: backend?.model_api?.[0] || 'openai-chat-completions', tool_calls: true, structured_output: backend?.structured_output?.includes('tool_call') ? 'tool_call' : backend?.structured_output?.[0] || 'tool_call' } : null;
  });
  if (redraw) select.addEventListener('change', redraw);
  select.disabled = external || subscription; return select;
}
function roleBackendPicker(role, state, redraw) {
  return roleSelect(role.role_id + ' Agent 后端', role.harness_ref.id, state.data.backends.map(backend => [
    backend.id,
    backend.name + (backend.recommended ? '（推荐）' : '') + (backend.runtime_status && !backend.runtime_status.ready ? '（未就绪）' : '') + (backend.available ? '' : '（尚不可用）'),
    !backend.available || !backend.kinds.includes(role.kind),
  ]), id => {
    const info = state.data.backends.find(entry => entry.id === id);
    const supportsSubscription = !!info?.supported_model_sources?.includes('subscription');
    const keepSubscription = supportsSubscription && role.harness_ref?.model_source === 'subscription';
    role.harness_ref = supportsSubscription ? { id, model_source: keepSubscription ? 'subscription' : 'gateway' } : { id };
    markRoleDirty(state);
    if (state.data.harnesses.find(backend => backend.id === id)?.externalModel || keepSubscription) role.model_profile_ref = null;
    redraw();
  });
}
function roleModelSourcePicker(role, state, redraw) {
  return roleSelect(role.role_id + ' 模型来源', role.harness_ref?.model_source || 'gateway', [
    ['gateway', '平台网关（容器内模型中转）'],
    ['subscription', '供应商订阅（预留 · 未实现）'],
  ], source => {
    role.harness_ref = { id: role.harness_ref.id, model_source: source === 'subscription' ? 'subscription' : 'gateway' };
    if (source === 'subscription') role.model_profile_ref = null;
    markRoleDirty(state);
    redraw();
  });
}
function roleBackendRuntimeBox(role, state) {
  const info = (state.data.backends || []).find(entry => entry.id === role.harness_ref.id);
  const rt = info?.runtime_status;
  if (!rt) return null;
  const cliReady = !!(rt.config_override || rt.selected_version);
  const isSubscription = role.harness_ref?.model_source === 'subscription';
  let roleModelReady = false, targetModelId = null, targetModelName = null, targetSourceLabel = '', conn = null, relayText = '';
  if (isSubscription) {
    relayText = '未就绪（供应商订阅模式预留未实现，请切换回平台网关）';
  } else if (role.model_profile_ref?.model_id) {
    const chosen = (state.data.models || []).find(entry => entry.id === role.model_profile_ref.model_id);
    if (chosen) {
      roleModelReady = true; targetModelId = chosen.id; targetModelName = chosen.name; targetSourceLabel = '角色指定模型'; conn = chosen.connectivity || null;
    } else {
      relayText = '未就绪（本角色指定的模型不可用或缺少凭据）';
    }
  } else if (rt.resolved_model && rt.resolved_model.source !== 'role') {
    const chosen = (state.data.models || []).find(entry => entry.id === rt.resolved_model.id);
    roleModelReady = true; targetModelId = rt.resolved_model.id; targetModelName = rt.resolved_model.name;
    targetSourceLabel = rt.resolved_model.source === 'workflow' ? '工作类型模型' : '项目默认模型';
    conn = chosen?.connectivity || rt.connectivity || null;
  } else if (rt.config_override) {
    roleModelReady = true;
    relayText = '本地配置覆盖（连通性未探测）';
  } else {
    relayText = rt.model_count > 0
      ? `未配置默认或工作类型模型（项目已有 ${rt.model_count} 个带密钥模型，请在项目设置选择默认模型或为本角色指定模型）`
      : '未配置（需先添加上游模型与凭据）';
  }
  if (roleModelReady && targetModelName) {
    if (conn?.state === 'ok') relayText = `已配置 ${targetModelName}（${targetSourceLabel}）· 连通正常${conn.http_status ? '（HTTP ' + conn.http_status + '）' : ''}`;
    else if (conn?.state === 'failed') relayText = `已配置 ${targetModelName}（${targetSourceLabel}）· 连通失败：${conn.detail || conn.error || '请求失败'}`;
    else relayText = `已配置 ${targetModelName}（${targetSourceLabel} · 连通性未探测）`;
  }
  const overallReady = cliReady && roleModelReady;
  const connFailed = overallReady && conn?.state === 'failed';
  const box = element('div', '', 'role-backend-runtime');
  box.dataset.testid = 'backend-runtime-status';
  const head = element('p', '', 'muted');
  const statusLabel = !overallReady ? '未就绪' : connFailed ? '连通异常' : '可用';
  const statusTone = !overallReady || connFailed ? 'warning' : 'success';
  const summaryText = !cliReady
    ? (rt.reason || `${info.name} 容器运行条件尚未就绪。`)
    : !roleModelReady
      ? relayText
      : connFailed
        ? `${info.name} CLI 已就绪，但模型 ${targetModelName} 连通探测或最近请求失败（${conn.detail || conn.error || '请求失败'}）。`
        : `${info.name} 容器运行配置已就绪（${conn?.state === 'ok' ? '最近连通正常' : '模型连通性未探测'}）。`;
  head.append(badge(statusLabel, statusTone), ' ', summaryText);
  box.append(head, facts([
    ['工具卷', `${rt.volume_root}（${rt.volume_present ? '已挂载' : '未挂载'}）`],
    ['兼容版本范围', rt.compatible_range || '—'],
    ['已安装版本', rt.installed_versions?.length ? rt.installed_versions.join(', ') : (rt.config_override ? '本地配置覆盖' : '未安装')],
    ['当前选用版本', rt.selected_version || (rt.config_override ? '本地配置覆盖' : '无可用兼容版本')],
    ['容器内模型中转', relayText],
  ]));
  if (overallReady && targetModelId && state.data.can_edit !== false && typeof current === 'object' && current?.id) {
    const repoId = current.id, tokenSnapshot = typeof renderToken === 'number' ? renderToken : 0;
    const probeNote = element('span', '', 'muted');
    const probeBtn = button(state.probingModel ? '正在探测…' : '探测模型连通性', async () => {
      if (state.probingModel) return;
      state.probingModel = true; probeBtn.disabled = true; probeBtn.textContent = '正在探测…'; probeNote.textContent = '';
      try {
        const res = await api(`/api/repositories/${repoId}/roles/probe-model`, 'POST', { model_id: targetModelId, role: role.role_id, workflow: state.data.workflow });
        if (res?.connectivity) {
          const modelEntry = (state.data.models || []).find(entry => entry.id === targetModelId);
          if (modelEntry) modelEntry.connectivity = res.connectivity;
          for (const b of state.data.backends || []) {
            if (b.runtime_status?.resolved_model?.id === targetModelId) b.runtime_status.connectivity = res.connectivity;
          }
        }
        state.probingModel = false;
        if (current?.id === repoId && current?.section === 'roles' && (typeof renderToken !== 'number' || renderToken === tokenSnapshot)) state.redraw?.();
      } catch (err) {
        state.probingModel = false;
        if (current?.id === repoId && current?.section === 'roles' && (typeof renderToken !== 'number' || renderToken === tokenSnapshot) && probeBtn.isConnected) {
          probeBtn.disabled = false;
          probeBtn.textContent = '探测模型连通性';
          probeNote.textContent = `探测失败：${err.message || err.code || '请求错误'}`;
        }
      }
    }, 'quiet');
    probeBtn.dataset.testid = 'probe-role-model';
    probeBtn.disabled = !!state.probingModel;
    const actions = element('p', '', 'role-runtime-actions');
    actions.append(probeBtn, ' ', probeNote);
    box.append(actions);
  }
  return box;
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
