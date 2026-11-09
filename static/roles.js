// Role settings share one draft across the overview and role pages. Only an explicit save changes the configuration.
const policyLabels = { controller: '任务主控', 'controller-coordination': '任务主控与跨任务协调', coordinator: '跨任务建议', writer: '开发执行', observer: '观察与测试', 'observer-readonly': '只读观察', evaluator: '独立验收' };
const environmentLabels = { 'control-session': '受限主控会话', 'task-workspace': '任务工作区', 'candidate-checkout': '候选的独立检出', 'evaluation-checkout': '验收的独立检出', 'isolated-workspace': '每次运行独立容器', 'isolated-candidate': '独立容器内的固定候选' };
const outputLabels = { 'delivery-nomination': '提名交付候选', 'coordination-result': '跨任务建议', 'entry-delivery': '任务交付结果', 'role-findings': '检视或测试发现', 'acceptance-verdict': '独立验收结论' };
const authorityLabels = { query_facts: '读取任务事实', delegate: '委派角色', coordinate: '协调任务', nominate: '提名候选', edit_candidate: '修改候选代码', decide_acceptance: '独立验收', finish_task: '直接结束任务', override_qa: '覆盖验收结论', publish: '直接发布', merge: '合并 PR', grant_permissions: '授予权限' };
const budgetFields = [['max_turns', '单次运行最多模型轮数', 4, 256], ['max_output_tokens', '单次输出最多 token', 256, 32768], ['max_total_tokens', '任务累计 token', 1000, 100000000], ['max_model_requests', '任务累计模型请求', 1, 10000], ['max_tool_calls', '任务累计工具调用', 1, 10000], ['max_wall_seconds', '任务累计秒数', 60, 86400]];

function roleSelect(name, value, choices, change) {
  const select = document.createElement('select'); select.name = name; select.setAttribute('aria-label', name);
  for (const choice of choices) { const [id, title, disabled] = choice; const option = new Option(title, id); option.disabled = !!disabled; select.add(option); }
  if (!Array.from(select.querySelectorAll('option')).some(option => option.value === String(value ?? ''))) select.add(new Option(`当前选项不可用：${value}`, value));
  select.value = value ?? ''; select.addEventListener('change', () => change(select.value)); return select;
}
function roleBound(control, change, state) {
  const edit = () => { change(control.type === 'checkbox' ? control.checked : control.value); state.dirty = true; };
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
    state.dirty = true;
    role.model_profile_ref = id ? { model_id: id, api: backend?.model_api?.[0] || 'openai-chat-completions', tool_calls: true, structured_output: backend?.structured_output?.includes('tool_call') ? 'tool_call' : backend?.structured_output?.[0] || 'tool_call' } : null;
  });
  if (redraw) select.addEventListener('change', redraw);
  select.disabled = external; return select;
}
function roleBackendPicker(role, state, redraw) {
  return roleSelect(role.role_id + ' Agent 后端', role.harness_ref.id, state.data.backends.map(backend => [backend.id, backend.name + (backend.recommended ? '（推荐）' : '') + (backend.available ? '' : '（尚不可用）'), !backend.available || !backend.kinds.includes(role.kind)]), id => {
    role.harness_ref = { id }; state.dirty = true;
    // A backend that brings its own model cannot accept a project model profile.
    if (state.data.harnesses.find(backend => backend.id === id)?.externalModel) role.model_profile_ref = null;
    redraw();
  });
}
function rolePolicyPicker(role, state, redraw) {
  return roleSelect(role.role_id + ' 能力策略', role.capability_policy_ref.id, state.data.capability_policies.filter(policy => policy.kind === role.kind).map(policy => [policy.id, policyLabels[policy.id] || policy.id]), id => {
    role.capability_policy_ref = { id }; state.dirty = true; redraw();
  });
}
function roleCapabilityDetails(role, data) {
  const box = element('div', '', 'role-capabilities'), policy = data.capability_policies.find(entry => entry.id === role.capability_policy_ref.id);
  if (!policy) { box.append(note('当前策略已不可用，请重新选择。')); return box; }
  const allowed = Object.entries(policy.authorities).filter(([, on]) => on).map(([key]) => authorityLabels[key] || key), denied = Object.entries(policy.authorities).filter(([, on]) => !on).map(([key]) => authorityLabels[key] || key);
  box.append(element('p', '允许：' + (allowed.join('、') || '无')), note('不允许：' + denied.join('、')));
  box.append(note(policy.tools === null ? '工具由当前任务入口提供，并受任务范围和项目授权约束。' : '可调用工具：' + policy.tools.join('、')));
  box.append(note('策略由控制面执行；提示词、模型和 Agent 后端都不能扩大这些权限。内容变化时系统会记录新版本，页面无需填写哈希。')); return box;
}
function rolesConsole() {
  const id = current.id, holder = element('div', '', 'roles-page'), message = element('p', '', 'view-error'); message.setAttribute('role', 'alert');
  holder.append(note('正在读取角色配置…'));
  void (async () => {
    try {
      const data = await api(`/api/repositories/${id}/roles`);
      if (current?.id !== id || current.section !== 'roles') return;
      let state = current.rolesDraft;
      if (!state || !state.dirty) {
        const config = data.configuration;
        state = { data, dirty: false, draft: { enabled: config.enabled, controller: structuredClone(config.controller), roles: config.roles.map(role => ({ ...editableRole(role), kind: role.kind, ...(!data.configured ? { harness_ref: { id: data.recommended_backend || 'pi' } } : {}) })), skills: structuredClone(data.skill_inputs), required_stages: structuredClone(config.required_stages || []) } };
        current.rolesDraft = state;
      }
      const draw = () => {
        holder.replaceChildren();
        const nav = element('nav', '', 'role-nav'); nav.setAttribute('aria-label', '角色列表');
        for (const [key, title] of [['', '概览'], ...state.draft.roles.map(role => [role.role_id, roleLabel(role.role_id, role.name)])]) {
          const item = element('a', title); item.href = `#/projects/${id}/roles${key ? '/' + key : ''}`;
          if ((current.item || '') === key) item.setAttribute('aria-current', 'page'); nav.append(item);
        }
        holder.append(nav);
        const role = state.draft.roles.find(role => role.role_id === current.item);
        if (current.item && !role) holder.append(note('这个角色已不存在，请在概览选择角色。'));
        else if (role) {
          holder.append(roleSettingsCard(role, state, draw));
          if (role.role_id === 'manager') holder.append(...managerSection(state.data));
        } else holder.append(...roleOverviewCards(state, draw));
        const actions = element('div', '', 'actions role-save');
        const save = button('保存角色配置', async () => {
          save.disabled = true; message.textContent = '';
          try {
            const { required_stages, ...draft } = state.draft;
            const stagesChanged = JSON.stringify(required_stages) !== JSON.stringify(state.data.configuration.required_stages || []);
            await api(`/api/repositories/${id}/roles`, 'PUT', { ...draft, roles: draft.roles.map(({ kind, ...role }) => role), ...(stagesChanged ? { required_stages } : {}), expected_revision: state.data.configuration.revision });
            current.rolesDraft = null; await reloadWith('角色配置已保存，新任务使用新配置');
          } catch (err) { message.textContent = /role_configuration_conflict/.test(err.message) ? '角色配置已被别人修改。请刷新读取最新版本，再应用你的修改。当前草稿仍保留。' : `${err.message}${err.field ? '（配置项：' + err.field + '）' : ''}`; }
          finally { save.disabled = false; }
        });
        actions.append(save, button('放弃草稿并刷新', async () => {
          if (state.dirty && !await askConfirm({ title: '放弃未保存的角色修改？', body: ['刷新后读取服务器上的最新配置。'], action: '放弃并刷新' })) return;
          current.rolesDraft = null; await reloadProject();
        })); holder.append(actions);
      };
      draw();
    } catch (err) { message.textContent = err.message; }
  })();
  return [holder, message];
}
function roleOverviewCards(state, redraw) {
  const { data, draft } = state, overview = card('角色概览'), { table, body } = projectTable(['角色', '启用', 'Agent 后端', '模型', '技能包', '能力策略'], '角色解析结果');
  overview.append(note('这里可以直接修改每个角色的配置；点角色名称可编辑提示词和完整设置。修改在点击「保存角色配置」后生效。模型解析结果来自最近一次读取的已保存配置。'));
  for (const role of draft.roles) {
    const row = document.createElement('tr'); row.dataset.role = role.role_id;
    const link = element('a', roleLabel(role.role_id, role.name)); link.href = `#/projects/${current.id}/roles/${role.role_id}`;
    tableCell(row, '角色', link, roleText(role.role_id + ' 名称', role, 'name', state));
    tableCell(row, '启用', roleCheck(role.role_id + ' 启用', role, 'enabled', state, ['controller', 'evaluator'].includes(role.kind)));
    const saved = data.configuration.roles.find(entry => entry.role_id === role.role_id);
    tableCell(row, 'Agent 后端', roleBackendPicker(role, state, redraw), note(data.configured ? '已保存：' + harnessName(saved?.harness_ref.id) : '尚未保存，当前显示推荐配置'));
    if (role.role_id === 'dev' && data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') row.lastElementChild.append(note('检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更')); 
    tableCell(row, '模型', roleModelPicker(role, state), note('当前解析：' + roleModelText(data.preview.find(entry => entry.role === role.role_id))));
    tableCell(row, '技能包', roleSkillPicker(role, state));
    const details = element('details', '', 'role-policy-details'); details.append(element('summary', '查看允许和禁止的动作'), roleCapabilityDetails(role, data));
    tableCell(row, '能力策略', rolePolicyPicker(role, state, redraw), details); body.append(row);
  }
  overview.append(table, note('Agent 后端：' + data.backends.map(backend => backend.name + (backend.available ? '（可用）' : '（尚未接入）')).join('；')));
  const coordination = card('角色协调设置'); coordination.append(roleCheck('开启角色协调', draft, 'enabled', state));
  for (const [id, title, covers] of roleEntries) coordination.append(roleCheck(`${title}交给主控（${covers}）`, draft.controller.entries, id, state));
  coordination.append(note('关闭协调时，任务沿用原执行器；独立 QA 仍然负责验收。正在运行的任务保留启动时的配置快照。'));
  const custom = card('自定义角色'), name = input('new_role', '', { placeholder: '如 security_checker', maxLength: 32 });
  const error = element('p', '', 'view-error'); custom.append(field('新角色标识', name), button('添加观察角色', () => {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name.value) || draft.roles.some(role => role.role_id === name.value)) { error.textContent = '使用小写字母开头的唯一名称，可包含数字、下划线或连字符。'; return; }
    draft.roles.push({ role_id: name.value, enabled: true, kind: 'observer', name: name.value, responsibility: '', persona_prompt: '', model_profile_ref: null, skill_bundle_ref: null, harness_ref: { id: data.recommended_backend || 'pi' }, capability_policy_ref: { id: 'observer' }, environment_profile_ref: { id: 'candidate-checkout' }, budget_policy_ref: { id: 'entry-default' }, output_schema_ref: { id: 'role-findings' } }); state.dirty = true; redraw();
  }), error);
  return [overview, coordination, roleSkillsCard(state, redraw), roleStagesCard(state, redraw), custom];
}
function roleSkillPicker(role, state) {
  return roleSelect(role.role_id + ' 技能包', role.skill_bundle_ref?.id || '', [['', '不绑定技能包'], ...state.draft.skills.map(bundle => [bundle.id, bundle.id])], id => { role.skill_bundle_ref = id ? { id } : null; state.dirty = true; });
}
function roleSettingsCard(role, state, redraw) {
  const section = card(roleLabel(role.role_id, role.name) + ' 设置');
  section.append(roleText('显示名称', role, 'name', state, { maxLength: 80 }), roleCheck('启用角色', role, 'enabled', state, ['controller', 'evaluator'].includes(role.kind)),
    roleText('职责', role, 'responsibility', state, { multiline: true, rows: 3, maxLength: 2000 }), field('Agent 后端', roleBackendPicker(role, state, redraw)), field('模型', roleModelPicker(role, state, redraw)));
  const profile = role.model_profile_ref, backend = state.data.harnesses.find(entry => entry.id === role.harness_ref.id);
  if (profile) {
    section.append(field('模型 API', roleSelect('模型 API', profile.api, (backend?.model_api || []).map(id => [id, id]), value => { profile.api = value; state.dirty = true; })),
      roleCheck('模型支持工具调用', profile, 'tool_calls', state), field('结构化输出方式', roleSelect('结构化输出方式', profile.structured_output, (backend?.structured_output || []).map(id => [id, id]), value => { profile.structured_output = value; state.dirty = true; })));
  }
  section.append(roleText('角色提示词', role, 'persona_prompt', state, { multiline: true, rows: 12, maxLength: 16000 }), note('角色提示词补充职责与行为要求；工具和权限由下面的能力策略执行。'));
  const builtin = state.data.builtin_prompts?.[role.role_id]; if (builtin) section.append(collapsible('查看固定职责与任务记录规则', builtin));
  section.append(field('技能包', roleSkillPicker(role, state)), field('能力策略', rolePolicyPicker(role, state, redraw)), roleCapabilityDetails(role, state.data));
  const environment = state.data.environment_profiles.filter(entry => entry.kinds.includes(role.kind));
  section.append(field('运行环境', roleSelect('运行环境', role.environment_profile_ref.id, environment.map(entry => [entry.id, environmentLabels[entry.id] || entry.id, entry.isolation === 'run_container' && backend?.capabilities?.isolation !== 'run_environment']), id => { role.environment_profile_ref = { id }; state.dirty = true; })));
  section.append(field('输出结果', roleSelect('输出结果', role.output_schema_ref.id, state.data.output_schemas.filter(entry => entry.kinds.includes(role.kind)).map(entry => [entry.id, outputLabels[entry.id] || entry.id]), id => { role.output_schema_ref = { id }; state.dirty = true; })));
  section.append(field('预算方式', roleSelect('预算方式', role.budget_policy_ref.id, [['entry-default', '沿用任务限制'], ['bounded', '限制单次运行'], ['metered', '限制任务累计用量']], id => {
    const old = role.budget_policy_ref; role.budget_policy_ref = id === 'entry-default' ? { id } : { id, max_turns: old.max_turns || 32, max_output_tokens: old.max_output_tokens || 4096 }; state.dirty = true; redraw();
  })));
  if (role.budget_policy_ref.id !== 'entry-default') {
    for (const [key, title, min, max] of budgetFields.slice(0, role.budget_policy_ref.id === 'bounded' ? 2 : undefined)) {
      const control = input(key, role.budget_policy_ref[key] ?? '', { type: 'number', min, max, step: 1 });
      section.append(field(title, roleBound(control, value => { if (value === '') delete role.budget_policy_ref[key]; else role.budget_policy_ref[key] = Number(value); }, state)));
    }
    if (role.budget_policy_ref.id === 'metered') {
      const cost = role.budget_policy_ref.max_cost, amount = input('max_cost', cost?.amount || '', { type: 'number', min: 0.000001, max: 1000000, step: 'any' });
      const currency = roleSelect('预算币种', cost?.currency || 'USD', [['USD', '美元'], ['CNY', '人民币']], value => { if (role.budget_policy_ref.max_cost) role.budget_policy_ref.max_cost.currency = value; state.dirty = true; });
      section.append(field('任务累计金额上限（留空不设置）', roleBound(amount, value => { if (value === '') delete role.budget_policy_ref.max_cost; else role.budget_policy_ref.max_cost = { amount: Number(value), currency: currency.value }; }, state)), field('预算币种', currency));
    }
  }
  if (!['manager', 'dev', 'test', 'reviewer', 'ux', 'qa', 'coordinator'].includes(role.role_id)) section.append(button('移除这个角色', () => { state.draft.roles = state.draft.roles.filter(entry => entry !== role); state.dirty = true; current.item = null; history.replaceState(null, '', `#/projects/${current.id}/roles`); redraw(); }, 'quiet destructive'));
  return section;
}
function roleSkillsCard(state, redraw) {
  const section = card('技能包'), { draft, data } = state;
  section.append(note('创建技能包后，可以在概览或角色设置中绑定。内置指南、仓库文件和自定义文本都通过表单配置。'));
  for (const bundle of draft.skills) {
    const group = element('fieldset', '', 'role-skill'); const name = roleBound(input('bundle_id', bundle.id), value => { const old = bundle.id; bundle.id = value; for (const role of draft.roles) if (role.skill_bundle_ref?.id === old) role.skill_bundle_ref.id = value; }, state);
    name.addEventListener('change', redraw);
    group.append(element('legend', bundle.id), field('技能包名称', name));
    group.append(field('来源', roleSelect('技能来源', bundle.source.type, [['builtin', '内置指南'], ['repository', '仓库技能文件'], ['inline', '自定义文件']], type => {
      bundle.source = type === 'builtin' ? { type, playbooks: [] } : type === 'repository' ? { type, commit: data.skill_sources?.repository?.commit || '', paths: [] } : { type, files: [{ path: 'guide.md', content: '' }] }; state.dirty = true; redraw();
    })));
    if (bundle.source.type === 'builtin') group.append(roleChoices('内置指南', bundle.source, 'playbooks', (data.playbooks || []).map(entry => [entry.id, entry.name]), state));
    else if (bundle.source.type === 'repository') {
      group.append(roleText('固定仓库提交', bundle.source, 'commit', state, { maxLength: 40 }), roleChoices('仓库技能文件', bundle.source, 'paths', (data.skill_sources?.repository?.paths || []).map(path => [path, path]), state));
    } else {
      for (const file of bundle.source.files) group.append(roleText('文件路径', file, 'path', state), roleText('文件内容', file, 'content', state, { multiline: true, rows: 5 }), button('移除文件', () => { bundle.source.files = bundle.source.files.filter(entry => entry !== file); state.dirty = true; redraw(); }));
      group.append(button('添加文件', () => { bundle.source.files.push({ path: '', content: '' }); state.dirty = true; redraw(); }));
    }
    group.append(button('移除技能包', () => { draft.skills = draft.skills.filter(entry => entry !== bundle); for (const role of draft.roles) if (role.skill_bundle_ref?.id === bundle.id) role.skill_bundle_ref = null; state.dirty = true; redraw(); }, 'quiet destructive')); section.append(group);
  }
  section.append(button('添加技能包', () => { let n = 1; while (draft.skills.some(bundle => bundle.id === 'skills_' + n)) n++; draft.skills.push({ id: 'skills_' + n, source: { type: 'inline', files: [{ path: 'guide.md', content: '' }] } }); state.dirty = true; redraw(); })); return section;
}
function roleStagesCard(state, redraw) {
  const section = card('任务阶段要求'), { draft } = state;
  section.append(note('配置任务必须完成的阶段、依赖和证据。独立验收始终保留；这里的要求由控制面检查。'));
  for (const stage of draft.required_stages) {
    const group = element('fieldset', '', 'role-stage');
    const name = roleBound(input('stage_id', stage.stage_id), value => { const old = stage.stage_id; stage.stage_id = value; for (const entry of draft.required_stages) entry.depends_on = entry.depends_on.map(id => id === old ? value : id); }, state);
    name.addEventListener('change', redraw);
    group.append(element('legend', stage.stage_id), field('阶段标识', name), roleCheck('必须完成', stage, 'required', state));
    group.append(roleChoices('适用交付', stage, 'delivery_types', [['code', '代码'], ['artifact', '文档或其他产物'], ['no_changes', '无需修改']], state),
      roleChoices('依赖阶段', stage, 'depends_on', draft.required_stages.filter(entry => entry !== stage).map(entry => [entry.stage_id, entry.stage_id]), state));
    group.append(field('执行角色类型', roleSelect('执行角色类型', stage.role_constraints.kinds[0], [['writer', '开发角色'], ['observer', '观察角色']], kind => { stage.role_constraints.kinds = [kind]; state.dirty = true; redraw(); })),
      roleChoices('限定角色（不选表示同类型任一角色）', stage.role_constraints, 'role_ids', draft.roles.filter(role => stage.role_constraints.kinds.includes(role.kind)).map(role => [role.role_id, roleLabel(role.role_id, role.name)]), state),
      roleCheck('要求独立执行', stage.role_constraints, 'independent', state),
      roleChoices('执行器必需能力', stage.role_constraints, 'capabilities', (state.data.stage_capabilities || []).map(entry => [entry.id, entry.name]), state),
      roleChoices('完成证据', stage.completion, 'evidence_types', [['tool_observation', '工具观察'], ['execution_evidence', '执行证据'], ['role_result', '角色结果']], state),
      roleCheck('必须没有待处理发现', stage.completion, 'no_findings', state), roleChoices('证据工具（可选）', stage.completion, 'tools', ['read_file', 'run_command', 'read_task_record', 'read_evidence', 'submit_delivery', 'finish'].map(id => [id, id]), state));
    for (const [object, key, caption, max, optional] of [[stage.completion, 'min_evidence', '最少证据数', 100], [stage.retry, 'max_attempts', '最多尝试次数', 20], [stage.budget, 'max_tool_calls', '阶段最多工具调用', 10000, true], [stage.budget, 'max_wall_seconds', '阶段最多秒数', 86400, true]]) {
      const control = input(key, object[key] ?? '', { type: 'number', min: 1, max, step: 1 }); group.append(field(caption, roleBound(control, value => { if (optional && !value) delete object[key]; else object[key] = Number(value); }, state)));
    }
    group.append(button('移除阶段', () => { draft.required_stages = draft.required_stages.filter(entry => entry !== stage); for (const entry of draft.required_stages) entry.depends_on = entry.depends_on.filter(id => id !== stage.stage_id); state.dirty = true; redraw(); }, 'quiet destructive')); section.append(group);
  }
  section.append(button('添加阶段', () => { let n = 1; while (draft.required_stages.some(stage => stage.stage_id === 'review_' + n)) n++; draft.required_stages.push({ stage_id: 'review_' + n, depends_on: [], delivery_types: ['code', 'artifact', 'no_changes'], role_constraints: { kinds: ['observer'], capabilities: ['fresh_context', 'fixed_candidate_read', 'raw_evidence'], independent: true }, required: true, completion: { evidence_types: ['role_result'], min_evidence: 1, no_findings: true }, retry: { max_attempts: 3 }, budget: {} }); state.dirty = true; redraw(); })); return section;
}
