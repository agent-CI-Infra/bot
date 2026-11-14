// The model the wizard's last step starts repositories with; projects keep their own choice.
function defaultModelBody(view, redraw) {
  const shared = view.models.filter(model => model.repository_id === null), chosen = shared.find(model => model.id === view.onboarding.model_id), usable = shared.filter(model => model.key_configured);
  const nodes = [facts([['当前默认', chosen ? `${chosen.model_name} · ${chosen.api_url}` : view.onboarding.model_id ? '已不可用，请重新选择' : '未设置']])];
  if (chosen && !chosen.key_configured) nodes.push(element('p', 'Key 已撤销：在下方供应商编辑中填写新 Key，或改选另一条模型。', 'endpoint-warning'));
  nodes.push(note('接入向导最后一步启用仓库时使用这个模型；已启用的项目在各自的「模型」页选择，不受影响。只能选 Key 仍在的部署共享模型。'));
  if (!usable.length) { nodes.push(note('还没有 Key 可用的部署共享模型，先在「部署共享模型」里添加。')); return nodes; }
  const select = document.createElement('select'), empty = element('option', '选择部署共享模型'); select.name = 'model_id'; empty.value = ''; select.append(empty);
  for (const model of usable) { const option = element('option', `${model.model_name} · ${hostOf(model.api_url)}`); option.value = model.id; select.append(option); }
  select.value = chosen?.key_configured ? chosen.id : '';
  nodes.push(actionForm([field('默认模型', select)], '设为默认', async () => {
    if (!select.value) throw new Error('先选择一条部署共享模型');
    view.onboarding.model_id = (await api('/api/onboarding/model', 'POST', { model_id: select.value })).model_id; redraw('已设为默认模型');
  }));
  return nodes;
}
// The same row actions and add form as the project page, refreshing only these two cards instead of a project.
function sharedModelsBody(view) {
  const shared = view.models.filter(row => row.repository_id === null), row = model => {
    const item = element('li', '', 'model-entry'), result = probeResult('wide-cell');
    item.append(modelLabel(model, model.id === view.onboarding.model_id ? [badge('默认', 'info')] : []), modelActions(model, result, refreshSettingsModels), result); return item;
  };
  const list = shared.length ? providerList(shared, row, refreshSettingsModels) : element('p', '还没有部署共享模型。', 'muted');
  return [modelCatalogPanel(), note('部署共享模型可供项目和平台服务角色选用。删除后，项目默认和服务角色模型清空；工作类型与项目角色的显式引用保留为不可用。已有请求和成本记录保留。'), list,
    providerCreate(null, refreshSettingsModels)];
}
async function refreshSettingsModels(notice) {
  const view = settingsView; if (!view) return;
  const [{ models }, { model_id }] = await Promise.all([api('/api/models'), api('/api/onboarding')]);
  if (view !== settingsView || view.request !== renderVersion) return;
  Object.assign(view, { models }); view.onboarding.model_id = model_id;
  view.defaultModel.redraw(); view.sharedModels.redraw(notice);
}
