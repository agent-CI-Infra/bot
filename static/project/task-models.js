// Event tasks (CI observation, Actions failures) have no Issue or PR number.
function projectTaskLabel(task) { return `${kindLabels[task.kind] || task.kind}${task.object_number == null ? '' : ' #' + task.object_number}`; }
const releaseNotesSkill = '.agents/skills/release-notes/SKILL.md';
function modelOption(select, value, caption) { const option = element('option', caption); option.value = value; select.append(option); }
function modelOptions(select, models, selected, empty = null) {
  if (empty) modelOption(select, '', empty);
  for (const model of models) modelOption(select, model.id, `${modelChoiceName(model)} · ${model.repository_id ? '本项目专属' : '部署共享'}${model.key_configured ? '' : ' · Key 已撤销'}`);
  if (selected && !models.some(model => model.id === selected)) modelOption(select, selected, `模型不可用（${selected}）`);
  select.value = selected || '';
}
function projectDefaultModelCard(policy, models, draft, sync) {
  const section = card('项目默认模型'), select = document.createElement('select'), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'project-default-model'; message.setAttribute('role', 'alert');
  const selected = models.find(model => model.id === policy.model_id);
  modelOptions(select, models, draft ? draft.defaultId : policy.model_id, '不使用默认模型（继承它的角色会等待配置）');
  select.addEventListener('change', () => { if (draft) { draft.defaultId = select.value; sync?.(); } });
  section.append(note('模型选择分为两层：项目默认模型 + 按角色覆写。未在角色设置中单独指定模型的角色（含 Manager）继承这里的选择。部署共享模型由超级管理员提供，本项目专属模型只对这个项目可见。'),
    note(policy.model_id && !selected ? `当前默认模型不可用（${policy.model_id}），不会自动换成其他模型。` : selected?.key_configured === false ? `当前默认模型 ${selected.model_name} 的 Key 已撤销，任务会等待配置。` : '需要为个别角色单独指定模型时，可在「角色」页配置。'),
    field('默认模型', select),
    consoleLink(`#/projects/${current.id}/roles`, '按角色配置模型', '为 Manager、Reviewer、Dev、Test、QA 等角色单独选择模型与 Agent 后端'),
    message);
  return section;
}
function modelManagementSections() {
  const models = current.models, own = card('本项目专属模型'), shared = card('部署共享模型');
  own.dataset.overviewAnchor = 'project-own-models'; shared.dataset.overviewAnchor = 'deployment-shared-models';
  const row = model => { const li = element('li', '', 'model-entry'), result = probeResult('wide-cell'); li.append(modelLabel(model), modelActions(model, result), result); return li; };
  const ownModels = models.filter(model => model.repository_id === current.id), sharedModels = models.filter(model => model.repository_id === null);
  own.append(...(ownModels.length ? [providerList(ownModels, row)] : [note('还没有专属模型。点击「新增供应商」添加。')]), providerCreate(current.id));
  const sharedRow = model => { const li = element('li', '', 'model-entry'); li.append(modelLabel(model)); return li; };
  shared.append(note('这里只读展示，可在上方选作项目默认模型或在「角色」页绑定给指定角色。供应商、Key、模型名和计费单价统一在「全局设置 → 模型」中管理。'),
    ...(sharedModels.length ? [providerList(sharedModels, sharedRow, reloadWith, { editable: false })] : [note('还没有可供本项目使用的共享模型，请联系超级管理员配置。')]));
  return [own, shared];
}
