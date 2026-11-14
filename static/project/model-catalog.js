function catalogStatusText(status) {
  if (!status?.fetched_at) return '目录尚未成功下载，使用现有默认能力；未手填价格的请求暂不计价。';
  return `快照：${new Date(status.fetched_at).toLocaleString()} · ${status.entries} 个模型${status.rejected ? ` · 已丢弃 ${status.rejected} 个非法条目` : ''}${status.last_error ? ' · 最近刷新失败，继续使用此快照' : ''}`;
}
function modelCatalogPanel() {
  const panel = element('section', '', 'model-catalog-status'), message = element('p', '正在读取目录…', 'muted');
  message.setAttribute('role', 'status'); panel.append(element('h4', '在线能力与价格目录'), message, note('目录来自 models.dev，每 6 小时刷新。中转模型参考官方 USD 定价，不做人民币换算；手填值优先。'));
  const actor = me, address = location.hash, live = () => me === actor && location.hash === address && panel.isConnected;
  const show = status => { if (live()) message.textContent = catalogStatusText(status); };
  if (me.role === 'super_admin') panel.append(button('立即刷新目录', async event => {
    const control = event.currentTarget; control.disabled = true;
    try { const { catalog } = await api('/api/models/catalog/refresh', 'POST', {}); show(catalog); if (live()) await (current && projectRoute() ? reloadProject() : refreshSettingsModels()); }
    catch (err) { if (live()) message.textContent = err.message; }
    finally { control.disabled = false; }
  }));
  void api('/api/models/catalog?limit=1').then(value => show(value.catalog)).catch(err => { if (live()) message.textContent = err.message; });
  return panel;
}
function modelCapabilitiesEditor(model, after) {
  const modal = document.createElement('dialog'), form = document.createElement('form'), title = element('h2', `${model.model_name} · 能力与目录`);
  modal.id = 'model-capabilities'; title.id = 'model-capabilities-title'; modal.setAttribute('aria-labelledby', title.id);
  const effective = model.capabilities, match = effective?.catalog, manual = model.capabilities_override || {}, message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  const mode = document.createElement('select'); mode.name = 'catalog_mode'; mode.setAttribute('aria-label','目录匹配');
  for (const [value, text] of [['auto','自动匹配'],['manual','手动指定条目'],['disabled','取消目录匹配']]) mode.add(new Option(text,value));
  mode.value = match?.mode || 'auto';
  const search = input('catalog_search', '', { type:'search', placeholder:'按 provider/model 搜索目录' }), choices = document.createElement('select'); choices.name = 'catalog_ref'; choices.setAttribute('aria-label','目录条目');
  const currentRef = match?.selected_ref || match?.entry?.ref;
  if (currentRef) choices.add(new Option(currentRef,currentRef));
  const results = element('p', '', 'muted'); let generation = 0;
  const query = async () => {
    const request = ++generation, q = search.value;
    try { const value = await api('/api/models/catalog?limit=100&q=' + encodeURIComponent(q));
      if (!modal.isConnected || request !== generation) return;
      const selected = choices.value, entries = value.entries;
      choices.replaceChildren(...entries.map(entry => new Option(entry.ref,entry.ref)));
      if (selected && !entries.some(entry => entry.ref === selected)) choices.add(new Option(selected,selected));
      if (selected) choices.value = selected;
      results.textContent = `共 ${value.total} 个匹配条目${value.next_offset !== null ? '，请继续输入以缩小范围' : ''}`;
    } catch (err) { if (modal.isConnected && request === generation) results.textContent = err.message; }
  };
  const pick = field('目录条目',choices), searchField = field('搜索目录',search);
  const sync = () => { pick.hidden = searchField.hidden = results.hidden = mode.value !== 'manual'; choices.required = mode.value === 'manual'; };
  mode.addEventListener('change', () => {sync(); if(mode.value === 'manual') void query();});
  search.addEventListener('input', () => void query()); sync();
  form.append(title, note(`当前：${match?.entry?.ref || ({ambiguous:'多个候选，请手动选择',disabled:'已取消匹配',unavailable:'目录不可用',missing:'指定条目已不存在'}[match?.state] || '未匹配')} · ${match?.fetched_at ? new Date(match.fetched_at).toLocaleString() : '无快照'}`), field('目录匹配',mode), searchField,pick,results,
    note('留空的能力值继承目录；没有匹配时使用 128000 上下文、8192 最大输出、非推理模型。保存只影响新请求，不改写历史。'));
  for (const [name, caption] of [['context_window','上下文窗口（token）'],['max_output_tokens','最大输出（token）']]) {
    const value = input(name, manual[name] ?? '', {type:'number',min:1,max:name === 'context_window'?32000000:16000000,step:1,placeholder:String(effective?.[name] ?? '')}); form.append(field(caption,value));
  }
  const reasoning = document.createElement('select'); reasoning.name = 'reasoning'; reasoning.setAttribute('aria-label','推理能力');
  for (const [value,text] of [['','继承目录 / 默认'],['true','推理模型'],['false','非推理模型']]) reasoning.add(new Option(text,value));
  reasoning.value = typeof manual.reasoning === 'boolean' ? String(manual.reasoning) : '';
  const actions = element('div','','actions'), save = element('button','保存能力与目录'); save.type = 'submit'; actions.append(button('取消',()=>modal.close()),save);
  form.append(field('推理能力',reasoning),message,actions);
  const actor = me, address = location.hash, live = () => me === actor && location.hash === address && modal.isConnected;
  form.addEventListener('submit',async event => {event.preventDefault(); if(!live())return;save.disabled=true;
    const data = Object.fromEntries(new FormData(form)), capabilities = {};
    for (const key of ['context_window','max_output_tokens']) if (data[key] !== '') capabilities[key] = Number(data[key]);
    if (data.reasoning !== '') capabilities.reasoning = data.reasoning === 'true';
    try {await api('/api/models/'+model.id,'PATCH',{version:model.version,capabilities,catalog:{mode:mode.value,...(mode.value==='manual'?{ref:choices.value}:{})}});if(live()){modal.close();await after('已保存模型能力与目录');}}
    catch(err){if(live())message.textContent=err.message;}finally{save.disabled=false;}
  });
  modal.append(form); document.body.append(modal); modal.addEventListener('close',()=>{generation++;modal.remove();},{once:true});modal.showModal();
}
