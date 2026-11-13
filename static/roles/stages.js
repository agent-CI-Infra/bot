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
      roleChoices('限定角色（不选表示同类型任一角色）', stage.role_constraints, 'role_ids', draft.roles.filter(role => stage.role_constraints.kinds.includes(role.kind)).map(role => [role.role_id, roleConfigName(role.role_id, role.name)]), state),
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
