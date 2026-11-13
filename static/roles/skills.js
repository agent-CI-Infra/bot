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
  const section = card(roleLabel(role.role_id, role.name) + ' 设置');
  section.dataset.testid = 'role-form';
  const group = (key, title, parent = section) => {
    const box = element('section', '', 'role-editor-group'), heading = element('h4', title); box.id = `role-${role.role_id}-${key}`; heading.tabIndex = -1;
    box.append(heading); parent.append(box); return box;
  };
  const basic = group('basic', '基本信息');
  basic.append(roleText('显示名称', role, 'name', state, { maxLength: 80 }), roleCheck('启用角色', role, 'enabled', state, ['controller', 'evaluator'].includes(role.kind)),
    roleText('职责', role, 'responsibility', state, { multiline: true, rows: 3, maxLength: 2000 }));
  const agent = group('agent', 'Agent 与模型');
  agent.append(note('已保存 · ' + workTypeName(state.data.workflow) + '：' + roleModelText(state.data.preview.find(row => row.role === role.role_id))), note('下面是待保存的选择；修改不会重写运行中任务的模型快照。'), field('Agent 后端', roleBackendPicker(role, state, redraw)), field('模型', roleModelPicker(role, state, redraw)));
  const saved = state.data.configuration.roles.find(entry => entry.role_id === role.role_id);
  if (role.role_id === 'dev' && state.data.configured && saved?.entry_harness_source !== 'role' && saved?.harness_ref.id !== 'pi') {
    agent.append(note('检视与 Actions 的开发执行器仍为 Pi，直到该角色的后端选择发生变更'));
  }
  const profile = role.model_profile_ref, backend = state.data.harnesses.find(entry => entry.id === role.harness_ref.id);
  const advanced = element('details', '', 'fold role-form-advanced');
  advanced.dataset.testid = 'role-form-advanced';
  advanced.open = !!state.roleFormAdvancedOpen;
  advanced.addEventListener('toggle', () => { state.roleFormAdvancedOpen = advanced.open; });
  advanced.append(element('summary', '高级设置'));
  if (profile) {
    const modelExtra = group('model-extra', '模型细节', advanced);
    modelExtra.append(field('模型 API', roleSelect('模型 API', profile.api, (backend?.model_api || []).map(id => [id, id]), value => { profile.api = value; markRoleDirty(state); })),
      roleCheck('模型支持工具调用', profile, 'tool_calls', state), field('结构化输出方式', roleSelect('结构化输出方式', profile.structured_output, (backend?.structured_output || []).map(id => [id, id]), value => { profile.structured_output = value; markRoleDirty(state); })),
      roleModelResolution(role, state, access));
  } else {
    group('model-extra', '模型细节', advanced).append(roleModelResolution(role, state, access));
  }
  const prompts = group('prompts', '提示词');
  const system = textarea('system_prompt', state.data.system_prompt, { rows: 6, readOnly: true }); system.setAttribute('aria-label', '系统提示词'); system.readOnly = true;
  prompts.append(field('系统提示词', system), note('所有角色共用的系统背景、环境说明和基本行为准则。角色职责与任务记录规则在下面的提示词中直接修改。'));
  prompts.append(roleText('角色提示词', role, 'persona_prompt', state, { multiline: true, rows: 18, maxLength: 32000 }), note('这份提示词包含角色完整的职责与行为要求，可以全部修改或清空；系统不会再追加固定职责。'), button('恢复角色模板', async () => {
    if (!await askConfirm({ title: '恢复角色模板？', body: ['当前角色提示词将替换为默认模板，保存后生效。'], action: '恢复模板' })) return;
    role.persona_prompt = (Object.hasOwn(state.data.role_templates, role.role_id) ? state.data.role_templates[role.role_id] : state.data.role_templates.observer); markRoleDirty(state); redraw();
  }));
  group('skills', '技能包', advanced).append(field('技能包', roleSkillPicker(role, state)));
  group('permissions', '权限', advanced).append(rolePermissionEditor(role, state));
  const runtime = group('runtime', '环境与输出', advanced);
  const environment = state.data.environment_profiles.filter(entry => entry.kinds.includes(role.kind));
  runtime.append(field('运行环境', roleSelect('运行环境', role.environment_profile_ref.id, environment.map(entry => [entry.id, environmentLabels[entry.id] || entry.id, entry.isolation === 'run_container' && backend?.capabilities?.isolation !== 'run_environment']), id => { role.environment_profile_ref = { id }; markRoleDirty(state); })));
  runtime.append(field('输出结果', roleSelect('输出结果', role.output_schema_ref.id, state.data.output_schemas.filter(entry => entry.kinds.includes(role.kind)).map(entry => [entry.id, outputLabels[entry.id] || entry.id]), id => { role.output_schema_ref = { id }; markRoleDirty(state); })));
  const budget = group('budget', '预算', advanced);
  budget.append(field('预算方式', roleSelect('预算方式', role.budget_policy_ref.id, [['entry-default', '沿用任务限制'], ['bounded', '限制单次运行'], ['metered', '限制任务累计用量']], id => {
    const old = role.budget_policy_ref; role.budget_policy_ref = id === 'entry-default' ? { id } : { id, max_turns: old.max_turns || 32, max_output_tokens: old.max_output_tokens || 4096 }; markRoleDirty(state); redraw();
  })));
  budget.append(note('未配置的轮次沿用运行入口缺省值：通用任务 16 轮、角色对话 24 轮（摘要 4 轮）、任务管理 32 轮、开发 64 轮、独立 QA 32 轮、协调 12 轮；恢复与收尾入口另有 8／12／24 轮缺省值。单次输出通常为 8192 token，开发和部分 DeepSeek 入口为 16384 token。显式配置的轮次和输出上限优先于这些缺省值；累计模型请求数单独计算。'));
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
  if (!(state.data.required_roles || ['manager', 'coordinator', 'qa']).includes(role.role_id)) group('danger', '删除角色', advanced).append(button('删除这个角色', async () => {
    const stages = state.draft.required_stages.filter(stage => stage.role_constraints.role_ids?.includes(role.role_id));
    if (stages.length) { await askConfirm({ title: '先调整任务阶段', body: ['这些阶段仍指定了该角色：' + stages.map(stage => stage.stage_id).join('、') + '。请在概览中修改阶段角色或移除阶段，再删除角色。'], action: '知道了' }); return; }
    if (!await askConfirm({ title: '删除角色 ' + role.name + '？', body: ['保存后该角色不再参与新任务，正在运行的角色也会停止使用工具。阶段要求如引用此角色，需要一并调整。'], action: '删除角色' })) return;
    state.draft.roles = state.draft.roles.filter(entry => entry !== role);
    if (state.data.configuration.roles.some(entry => entry.role_id === role.role_id)) state.draft.deleted_roles = [...new Set([...(state.draft.deleted_roles || []), role.role_id])]; markRoleDirty(state); current.item = null; history.replaceState(null, '', `#/projects/${current.id}/roles`); redraw(); }, 'quiet destructive'));
  section.append(advanced);
  return section;
}
const skillSourceNames = { repository: '固定仓库提交', inline: '控制台文件' };
function roleSkillFacts(bundle, state) {
  const saved = state.data.configuration.skills.find(entry => entry.id === bundle.id), box = element('section', '', 'skill-saved-facts'); box.setAttribute('aria-label', '已保存技能版本');
  const savedBindings = state.data.configuration.roles.filter(role => role.skill_bundle_ref?.id === bundle.id).map(role => roleLabel(role.role_id, role.name));
  box.append(facts([['已保存版本', saved ? String(saved.revision) : '此标识尚未保存'], ['已保存来源', saved ? skillSourceNames[saved.source.type] || saved.source.type : '尚未保存'], ['已保存绑定角色', savedBindings.join('、') || '无'], ['内容哈希', saved?.content_hash || '保存后由服务端计算']]));
  if (saved?.source.origin) box.append(note('已迁移为控制台文件；保留原绑定内容和文件哈希。原指南：' + saved.source.origin.playbooks.join('、') + '；原版本：' + saved.source.origin.revision + '；原内容哈希：' + saved.source.origin.content_hash));
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
  section.append(note('创建技能包后，可以在概览或角色设置中绑定。仓库文件和自定义文本都通过表单配置。'));
  for (const bundle of selected ? [selected] : draft.skills) {
    const group = element('fieldset', '', 'role-skill'); const name = roleBound(input('bundle_id', bundle.id), value => { const old = bundle.id; bundle.id = value; for (const role of draft.roles) if (role.skill_bundle_ref?.id === old) role.skill_bundle_ref.id = value; }, state);
    name.addEventListener('change', redraw);
    group.append(element('legend', bundle.id), field('技能包名称', name));
    if (selected) group.append(roleSkillFacts(bundle, state));
    group.append(field('来源', roleSelect('技能来源', bundle.source.type, [['repository', '仓库技能文件'], ['inline', '自定义文件']], type => {
      bundle.source = type === 'repository' ? { type, commit: data.skill_sources?.repository?.commit || '', paths: [] } : { type, files: [{ path: 'guide.md', content: '' }] }; markRoleDirty(state); redraw();
    })));
    if (bundle.source.type === 'repository') {
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

