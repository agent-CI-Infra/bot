// Model address, upstream list and test, shared by the project page, global settings and the onboarding wizard
// (settings.js and onboarding.js load after this file). The server resolves addresses, so the page shows exactly where
// tasks will send their requests.
const modelUrlRule = '地址按填写的路径使用：去掉末尾的 / 和 /chat/completions 后，接上 /chat/completions 发送对话，接上 /models 获取模型列表；不会自动添加或删除 /v1。';
const modelV1Warning = '当前地址不含末尾的 /v1；多数兼容接口需要它，只有上游确认不用时才这样填写。';
function endpointFacts(endpoints) {
  const nodes = [facts([['对话地址', endpoints.chat_url], ['模型列表地址', endpoints.models_url]])];
  if (!endpoints.has_v1) nodes.push(element('p', modelV1Warning, 'endpoint-warning'));
  return nodes;
}
// Saved models are shown by provider: one group per request address. The key is the server's chat_url, so URLs that
// differ only in what the server ignores (a trailing / or /chat/completions) are one provider, as they are for tasks.
function byProvider(models) {
  const groups = new Map();
  for (const model of models) { const key = model.endpoints?.chat_url || model.api_url; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(model); }
  return [...groups.values()];
}
function providerTitle(model, className = 'provider-title') {
  const title = element('div', '', className); title.append(element('strong', hostOf(model.api_url)), ' ', element('span', model.api_url, 'muted'));
  if (model.endpoints && !model.endpoints.has_v1) { const flag = badge('地址不含 /v1', 'warning'); flag.title = modelV1Warning; title.append(' ', flag); }
  return title;
}
// A model with its address on one line, where it is not shown inside a provider group (the onboarding wizard).
function modelAddress(model) {
  const address = element('span', `${model.model_name} · ${model.api_url}`, 'model-address');
  if (model.endpoints && !model.endpoints.has_v1) { const flag = badge('地址不含 /v1', 'warning'); flag.title = modelV1Warning; address.append(' ', flag); }
  return address;
}
// Historical task kind label helper.
const workTypeName = kind => { const id = String(kind); return kindLabels[id] || id; };
// A model inside its provider group: the name, and `extra` badges such as the wizard's default.
function modelLabel(model, extra = []) {
  const label = element('span', model.model_name, 'model-address');
  for (const flag of [...extra, ...(model.key_configured ? [] : [badge('Key 已撤销', 'warning')])]) label.append(' ', flag);
  return label;
}
// The provider groups of one list (models of one project, or the shared ones); `row` draws each model. Whoever may edit
// the models can add more of a provider's models with its saved key.
function modelConnectionFacts(model) {
  const box = element('div', '', 'model-connection-facts'), price = model.pricing, policy = current && projectRoute()?.id === current.id ? current.policy : null;
  box.append(badge(model.repository_id === null ? '部署共享' : '项目专属', 'info'));
  if (price) box.append(element('span', `${price.currency} / 百万 token · 输入 ${price.input_per_million} · 输出 ${price.output_per_million} · 缓存 ${price.cache_per_million}`, 'model-price'));
  else box.append(element('span', '未定价 · 不按 0 估算', 'model-price'));
  const capabilities=model.capabilities, match=capabilities?.catalog;
  if(capabilities) box.append(element('span',`上下文 ${capabilities.context_window} · 最大输出 ${capabilities.max_output_tokens} · ${capabilities.reasoning?'推理模型':'非推理模型'}`));
  if(match) box.append(element('span',`${match.entry?.ref||({ambiguous:'目录匹配不唯一',disabled:'已取消目录匹配',unavailable:'目录不可用',missing:'指定目录条目已不存在'}[match.state]||'未匹配目录')} · ${match.fetched_at?timeText(match.fetched_at):'无快照'}${model.pricing_source==='catalog'?' · 目录 USD 参考价':model.pricing_source==='mixed'?' · 手填与目录计价':''}`));
  if (policy?.model_id === model.id) box.append(badge('项目默认', 'success'));
  const used = model.used_by || [];
  box.append(element('span', Array.isArray(model.used_by)?used.length ? `项目默认引用：${used.map(repo => repo.full_name).join('、')}` : '无项目默认引用':'项目配置引用尚未读取', 'model-usage'));
  return box;
}
function providerList(models, row, after = reloadWith, { editable = true } = {}) {
  const list = element('div', '', 'provider-list'), tools = element('div', '', 'provider-list-tools'), search = input('provider_search', '', { type: 'search', placeholder: '搜索供应商地址或模型名称' }), count = element('span', '', 'muted');
  search.setAttribute('aria-label', '搜索供应商或模型'); count.setAttribute('role', 'status'); tools.append(search, count); list.append(tools);
  const entries = [];
  for (const group of byProvider(models)) {
    const section = element('section', '', 'provider-group'), head = element('div', '', 'provider-head'), rows = element('ul', '', 'history');
    head.append(providerTitle(group[0]), element('span', `${group.length} 个模型`, 'muted provider-count'));
    head.append(badge(group.every(model => model.key_configured) ? 'Key 已配置' : group.some(model => model.key_configured) ? '部分 Key 已撤销' : 'Key 已撤销', group.every(model => model.key_configured) ? '' : 'warning'));
    const canEdit = editable && (me.role === 'super_admin' || group[0].repository_id === current?.id);
    if (canEdit) head.append(button('编辑供应商',()=>providerEditor(group,group[0].repository_id,after)));
    else head.append(badge('只读'));
    const modelsInGroup = [];
    for (const model of group) { const item = row(model); item.append(modelConnectionFacts(model)); rows.append(item); modelsInGroup.push({ item, name: model.model_name.toLowerCase() }); }
    section.append(head, rows); list.append(section); entries.push({ section, host: group[0].api_url.toLowerCase(), models: modelsInGroup });
  }
  const filter = () => {
    const value = search.value.trim().toLowerCase(); let visible = 0;
    for (const entry of entries) {
      for (const model of entry.models) { model.item.hidden = !!value && !entry.host.includes(value) && !model.name.includes(value); if (!model.item.hidden) visible++; }
      entry.section.hidden = entry.models.every(model => model.item.hidden);
    }
    count.textContent = `${visible} / ${models.length} 个模型`; empty.hidden = !!visible;
  };
  const empty = element('p', '没有匹配的供应商或模型，清空搜索可恢复全部。', 'provider-search-empty'); empty.hidden = true; list.append(empty); search.addEventListener('input', filter); filter();
  return list;
}
