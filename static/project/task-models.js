// Event tasks (CI observation, Actions failures, gate onboarding turns) have no Issue or PR number.
function projectTaskLabel(task) { return `${kindLabels[task.kind] || task.kind}${task.object_number == null ? '' : ' #' + task.object_number}`; }
const builtInTasks = [
  { kind: 'manager', group: 'Manager', title: 'Manager 分派', description: '每个交给 Manager 的事件调用一次：决定新建任务、续接已有任务还是不处理。' },
  { kind: 'review.issue', group: '检视', title: '检视 Issue', description: '检视 Issue，判断意图、核对代码证据，回复评论并加分类标签。', rule: '.bot/rules/issue-review.md' },
  { kind: 'review.pr', group: '检视', title: '检视 PR', description: '检视 PR 的变更、测试与证据，发布 COMMENT 检视结论。', rule: '.bot/rules/pr-review.md' },
  { kind: 'development.issue', group: '开发', title: '开发 Issue', description: 'Issue 明确要求改代码时，在虚拟电脑里实现、测试并创建 bot PR。', rule: '.bot/rules/issue-development.md' },
  { kind: 'development.pr', group: '开发', title: '跟进 bot PR', description: '检视采纳了 bot PR 上的修改要求，或发现可执行问题后，修订 bot 自己的 PR。' },
  { kind: 'reply', group: '通用', title: '通用回复', description: '按 Manager 提示词「通用回复」章节在 Issue 或 PR 上完成一项工作并回复。' },
  { kind: 'release.observe', group: '发版本', title: 'CI 观察', description: '只读分析一次 Release 工作流运行并汇总失败线索；观察操作仍留在「发版本」。' },
  { kind: 'release.notes', group: '发版本', title: '发行说明', description: '把已核验的提交和合并 PR 整理成发行说明；起草与正式发布仍留在「发版本」。' },
  { kind: 'actions.failures', group: 'Actions', title: 'Actions 失败处理', description: '分析默认分支 Actions 运行失败的原因，外部原因重跑一次，其他提报 Issue。' },
  { kind: 'gate.onboarding', group: '门禁', title: '接入门禁', description: '「接入门禁」对话的每一轮。' },
  { kind: 'task.development', group: '开发', title: '开发任务', description: '直接创建或由 Manager 拆解的开发任务，沿用项目开发授权、角色团队和独立 QA。' },
  { kind: 'task.request', group: '通用', title: '普通任务与定时检查', description: '管理对话、接口或定时检查发起的通用任务。' }
];
const releaseNotesSkill = '.agents/skills/release-notes/SKILL.md';
function taskModelMap(policy) {
  const values = JSON.parse(policy.task_models || '{}');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('当前任务模型配置无效，请先在仓库配置中修正。');
  return { ...values };
}
function modelOption(select, value, caption) { const option = element('option', caption); option.value = value; select.append(option); }
function modelOptions(select, models, selected, empty = null) {
  if (empty) modelOption(select, '', empty);
  for (const model of models) modelOption(select, model.id, `${model.model_name} · ${model.repository_id ? '本项目专属' : '部署共享'} · ${hostOf(model.api_url)}${model.key_configured ? '' : ' · Key 已撤销'}`);
  if (selected && !models.some(model => model.id === selected)) modelOption(select, selected, `模型不可用（${selected}）`);
  select.value = selected || '';
}
function projectDefaultModelCard(policy, models, draft, sync) {
  const section = card('项目默认模型'), select = document.createElement('select'), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'project-default-model'; message.setAttribute('role', 'alert');
  const selected = models.find(model => model.id === policy.model_id);
  modelOptions(select, models, draft ? draft.defaultId : policy.model_id, '不使用默认模型（继承它的任务会等待配置）');
  select.addEventListener('change', () => { if (draft) { draft.defaultId = select.value; sync?.(); } });
  section.append(note('未单独指定模型的任务继承这里的选择。部署共享模型由超级管理员提供，本项目专属模型只对这个项目可见。'),
    note(policy.model_id && !selected ? `当前默认模型不可用（${policy.model_id}），不会自动换成其他模型。` : selected?.key_configured === false ? `当前默认模型 ${selected.model_name} 的 Key 已撤销，任务会等待配置。` : '需要时，可在下方「按任务类型覆写」里为个别工作类型单独指定。'),
    field('默认模型', select), message);
  return section;
}
function modelManagementSections() {
  const models = current.models, own = card('本项目专属模型'), shared = card('部署共享模型');
  own.dataset.overviewAnchor = 'project-own-models'; shared.dataset.overviewAnchor = 'deployment-shared-models';
  const row = model => { const li = element('li', '', 'model-entry'), result = probeResult('wide-cell'); li.append(modelLabel(model), modelActions(model, result), result); return li; };
  const ownModels = models.filter(model => model.repository_id === current.id), sharedModels = models.filter(model => model.repository_id === null);
  own.append(...(ownModels.length ? [providerList(ownModels, row)] : [note('还没有专属模型。点击「新增供应商」添加。')]), providerCreate(current.id));
  const sharedRow = model => { const li = element('li', '', 'model-entry'); li.append(modelLabel(model)); return li; };
  shared.append(note('这里只读展示，可在上方选作项目默认或任务模型。供应商、Key、模型名和计费单价统一在「全局设置 → 模型」中管理。'),
    ...(sharedModels.length ? [providerList(sharedModels, sharedRow, reloadWith, { editable: false })] : [note('还没有可供本项目使用的共享模型，请联系超级管理员配置。')]));
  return [own, shared];
}
function taskModelEditor(kind, title, policy, models, { custom = false, draft = null, sync = null } = {}) {
  const section = element('section', '', 'task-model-editor'), select = document.createElement('select'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  let initial = {}; try { initial = draft ? { ...draft.tasks } : taskModelMap(policy); } catch (err) { message.textContent = err.message; }
  const configured = Object.hasOwn(initial, kind), selected = configured ? initial[kind] : policy.model_id;
  const defaultModel = models.find(model => model.id === policy.model_id);
  modelOptions(select, models, configured ? selected : '', custom ? null : `继承项目默认${defaultModel ? `（${defaultModel.model_name}）` : policy.model_id ? `（模型不可用 ${policy.model_id}）` : '（未选择）'}`);
  const selectedModel = models.find(model => model.id === selected);
  const currentText = configured
    ? selectedModel ? `${selectedModel.model_name} · 此任务指定${selectedModel.key_configured ? '' : ' · Key 已撤销，不会自动切换'}` : `模型不可用（${selected}） · 此任务指定，不会自动切换`
    : selectedModel ? `${selectedModel.model_name} · 继承项目默认${selectedModel.key_configured ? '' : ' · Key 已撤销'}` : policy.model_id ? `模型不可用（${policy.model_id}） · 继承项目默认，不会自动切换` : '未选择项目默认模型，任务会等待配置';
  const actions = element('div', '', 'actions form-actions');
  if (!draft) {
    // Pages outside the unified save bar (the Manager rules page's「Manager 分派」) still save this one entry at once.
    const persist = async (value, notice) => {
      message.textContent = ''; for (const control of actions.querySelectorAll('button')) control.disabled = true;
      try {
        const values = taskModelMap(current.policy);
        if (value) values[kind] = value; else delete values[kind];
        await patchPolicy({ task_models: values }); current.focusAnchor = kind; await reloadWith(notice);
      } catch (err) { message.textContent = err.message; }
      finally { for (const control of actions.querySelectorAll('button')) control.disabled = false; }
    };
    actions.append(button('保存模型', () => persist(select.value, `已保存${title}的模型`)));
    if (!custom && configured) actions.append(button('恢复继承', () => persist('', `已恢复${title}继承项目默认模型`), 'quiet'));
    if (custom) actions.append(button('移除这项设置', () => persist('', `已移除 ${kind} 的模型设置`), 'quiet destructive'));
    section.append(note(`当前使用：${currentText}`), field('任务模型', select), message, actions);
    return section;
  }
  const apply = value => {
    if (value) draft.tasks[kind] = value; else delete draft.tasks[kind];
    sync?.();
  };
  select.addEventListener('change', () => apply(select.value));
  if (!custom) {
    const inherit = button('恢复继承', () => { select.value = ''; apply(''); inherit.hidden = true; }, 'quiet');
    inherit.hidden = !configured;
    select.addEventListener('change', () => { inherit.hidden = !Object.hasOwn(draft.tasks, kind); });
    actions.append(inherit);
  }
  if (custom) actions.append(button('移除这项设置', () => { select.value = ''; apply(''); }, 'quiet destructive'));
  section.append(note(`当前使用：${currentText}`), field('任务模型', select), message, actions);
  return section;
}
