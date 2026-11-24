// Model address, upstream list and test, shared by the project page, global settings and the onboarding wizard
// (settings.js and onboarding.js load after this file). The server resolves addresses, so the page shows exactly where
// tasks will send their requests.
const modelUrlRule = '地址按填写的路径使用，末尾的 / 会去掉。Chat Completions：去掉 /chat/completions 后接上 /chat/completions 发送对话、接上 /models 获取模型列表，不会自动添加或删除 /v1。Responses：以 /responses 结尾时原样使用，否则接上 /responses，只填主机时接上 /v1/responses。Anthropic Messages：以 /messages 结尾时原样使用，否则接上 /messages，地址不以 /v1 结尾时接上 /v1/messages。';
const modelV1Warning = '当前地址不含末尾的 /v1；多数兼容接口需要它，只有上游确认不用时才这样填写。';
// One interface per provider (#1332); "auto" keeps inferring it per model: manual → URL → catalog → default.
const interfaceNames = { 'openai-chat-completions': 'Chat Completions', 'openai-responses': 'Responses', 'anthropic-messages': 'Anthropic Messages' };
const protocolSources = { manual: '手动', url: 'URL', catalog: '目录', default: '默认' };
const interfaceName = type => interfaceNames[type] || type;
const protocolText = protocol => `${interfaceName(protocol.interface_type)}（${protocolSources[protocol.source] || protocol.source}）`;
const providerErrors = { provider_name_taken: '同一范围内已有同名供应商，请换一个名称。', invalid_provider_name: '供应商名称需为 1–100 个字符，不能包含换行等控制字符。' };
const providerErrorText = err => providerErrors[err?.code] || readErrorText(err);
// A model in a picker or a summary: its name and its provider's, so same-named models of two providers stay apart.
const modelChoiceName = model => { const provider = model.provider_name || (model.api_url ? hostOf(model.api_url) : ''); return provider ? `${model.model_name} · ${provider}` : model.model_name; };
function endpointFacts(endpoints) {
  const rows = [['对话地址', endpoints.chat_url], ['模型列表地址', endpoints.models_url]];
  if (endpoints.interface_type) rows.unshift(['接口协议', protocolText(endpoints)]);
  const nodes = [facts(rows)];
  if (!endpoints.has_v1) nodes.push(element('p', modelV1Warning, 'endpoint-warning'));
  return nodes;
}
// Saved models are shown by provider: the models of one scope saved under one name, exactly the members the server
// updates together, so an editor's version list always matches its provider.
function byProvider(models) {
  const groups = new Map();
  for (const model of models) { const key = JSON.stringify([model.repository_id, model.provider_name ?? null]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(model); }
  return [...groups.values()];
}
// The provider's interface setting: one manual interface for all its models, or "auto".
const providerInterface = group => group[0]?.protocol?.override?.interface_type || 'auto';
function providerTitle(group, className = 'provider-title') {
  const model = group[0], title = element('div', '', className), chosen = providerInterface(group);
  const name = element('span', '', 'provider-name'); name.append(element('strong', model.provider_name || hostOf(model.api_url)), badge(chosen === 'auto' ? '接口 自动' : '接口 ' + interfaceName(chosen), 'info'));
  title.append(name, element('span', model.api_url, 'muted'));
  if (model.endpoints && !model.endpoints.has_v1) { const flag = badge('地址不含 /v1', 'warning'); flag.title = modelV1Warning; title.append(' ', flag); }
  return title;
}
// A model with its provider and address on one line, where it is not shown inside a provider group (the onboarding wizard).
function modelAddress(model) {
  const address = element('span', `${modelChoiceName(model)} · ${model.api_url}`, 'model-address');
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
  if (model.protocol) box.append(element('span', '接口 ' + protocolText(model.protocol), 'model-protocol'));
  if (price) box.append(element('span', `${price.currency} / 百万 token · 输入 ${price.input_per_million} · 输出 ${price.output_per_million} · 缓存 ${price.cache_per_million}`, 'model-price'));
  else box.append(element('span', '未定价 · 不按 0 估算', 'model-price'));
  const capabilities=model.capabilities, match=capabilities?.catalog, manualCaps=model.capabilities_override||{};
  if(capabilities) {
    const imageText = typeof manualCaps.image_input === 'boolean'
      ? (capabilities.image_input ? '支持图像输入' : '不支持图像输入')
      : match?.entry
        ? (capabilities.image_input ? '支持图像输入' : '不支持图像输入')
        : (capabilities.image_input ? '图像输入（默认允许）' : '不支持图像输入');
    box.append(element('span',`上下文 ${capabilities.context_window} · 最大输出 ${capabilities.max_output_tokens} · ${capabilities.reasoning?'推理模型':'非推理模型'} · ${imageText}`));
  }
  if(match) box.append(element('span',`${match.entry?.ref||({ambiguous:'目录匹配不唯一',disabled:'已取消目录匹配',unavailable:'目录不可用',missing:'指定目录条目已不存在'}[match.state]||'未匹配目录')} · ${match.fetched_at?timeText(match.fetched_at):'无快照'}${model.pricing_source==='catalog'?' · 目录 USD 参考价':model.pricing_source==='mixed'?' · 手填与目录计价':''}`));
  if (policy?.model_id === model.id) box.append(badge('项目默认', 'success'));
  const used = model.used_by || [];
  box.append(element('span', Array.isArray(model.used_by)?used.length ? `项目默认引用：${used.map(repo => repo.full_name).join('、')}` : '无项目默认引用':'项目配置引用尚未读取', 'model-usage'));
  return box;
}
function providerList(models, row, after = reloadWith, { editable = true } = {}) {
  const list = element('div', '', 'provider-list'), tools = element('div', '', 'provider-list-tools'), search = input('provider_search', '', { type: 'search', placeholder: '搜索供应商名称、地址或模型名称' }), count = element('span', '', 'muted');
  search.setAttribute('aria-label', '搜索供应商或模型'); count.setAttribute('role', 'status'); tools.append(search, count); list.append(tools);
  const entries = [];
  for (const group of byProvider(models)) {
    const section = element('section', '', 'provider-group'), head = element('div', '', 'provider-head'), rows = element('ul', '', 'history');
    head.append(providerTitle(group), element('span', `${group.length} 个模型`, 'muted provider-count'));
    head.append(badge(group.every(model => model.key_configured) ? 'Key 已配置' : group.some(model => model.key_configured) ? '部分 Key 已撤销' : 'Key 已撤销', group.every(model => model.key_configured) ? '' : 'warning'));
    const canEdit = editable && (me.role === 'super_admin' || group[0].repository_id === current?.id);
    if (canEdit) head.append(button('编辑供应商',()=>providerEditor(group,group[0].repository_id,after)));
    else head.append(badge('只读'));
    const modelsInGroup = [];
    for (const model of group) { const item = row(model); item.append(modelConnectionFacts(model)); rows.append(item); modelsInGroup.push({ item, name: model.model_name.toLowerCase() }); }
    section.append(head, rows); list.append(section); entries.push({ section, host: `${group[0].provider_name || ''} ${group[0].api_url}`.toLowerCase(), models: modelsInGroup });
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
