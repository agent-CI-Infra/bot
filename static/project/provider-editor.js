// Adding and editing use one provider form. URL/key changes and newly selected models commit together.
function providerEditor(group, repositoryId, after) {
  const editing=!!group.length, existing=new Set(group.map(model=>model.model_name)), selected=new Set();
  let source=group.find(model=>model.key_configured)||group[0];
  const modal=document.createElement('dialog'),form=document.createElement('form'),head=element('div','','heading'),title=element('h2',editing?'编辑供应商':'新增供应商');
  modal.id='provider-edit';title.id='provider-edit-title';modal.setAttribute('aria-labelledby',title.id);head.append(title);
  const fields=document.createElement('fieldset');fields.className='provider-fields';
  // The name tells providers of one scope apart; a new one is named after its address host until someone types a name.
  const name=input('provider_name',group[0]?.provider_name||'',{required:true,maxLength:100,placeholder:'例如 deepseek-responses'});let named=editing;
  const protocol=interfaceSelect(providerInterface(group)),protocolHint=element('p','','muted provider-protocol-hint');let urlProtocol=null;
  const url=input('api_url',source?.api_url||'',{type:'url',required:true,placeholder:'填写供应商接口地址'}),key=input('api_key','',{type:'password',autocomplete:'new-password',required:!editing,placeholder:editing?'留空保持已保存的 Key':'填写 API Key'});
  const preview=element('div','','endpoint-preview'),endpointDetail=element('details','','fold'),result=probeResult(),choices=element('div','','model-chips'),picked=element('div','','model-chips provider-selected'),filter=input('filter','',{type:'search',placeholder:'筛选上游模型'}),manual=input('model_name','',{maxLength:200,placeholder:'例如模型列表中没有列出的名称'});
  filter.setAttribute('aria-label','筛选上游模型');filter.hidden=true;manual.setAttribute('aria-label','手动模型名');
  endpointDetail.append(element('summary','查看实际请求地址'),preview);if(source?.endpoints)preview.append(...endpointFacts(source.endpoints));
  const message=element('p','','view-error'),selectedLabel=element('p','待添加','provider-selection-summary');message.setAttribute('role','alert');selectedLabel.hidden=true;let request=0,available=[];
  const impact=element('section','','provider-impact'), impactTitle=element('h3','保存影响'), impactText=element('p'); impact.append(impactTitle,impactText);
  const renamed=()=>editing&&name.value.trim()!==(group[0].provider_name||''),reprotocol=()=>editing&&protocol.value!==providerInterface(group);
  const drawImpact=()=>{impactText.textContent=editing?`将更新 ${group.length} 个现有模型${selected.size?'，新增 '+selected.size+' 个模型':''}；${key.value.trim()?'替换连接 Key':'保留已保存的 Key'}${renamed()?'；名称改为 '+name.value.trim():''}${reprotocol()?'；接口协议改为'+(protocol.value==='auto'?'自动':' '+interfaceName(protocol.value)):''}。现有任务的历史配置和费用快照不会重写。`:`新增 ${selected.size} 个${repositoryId===null?'部署共享':'项目专属'}模型；保存后仍需显式选择默认或覆写。`;};
  // "Auto" shows what it would choose: for the saved address, each model's own inference; for a new or changed address,
  // what the URL alone gives (models the catalog knows may still get another interface once added).
  const drawProtocol=()=>{
    if(protocol.value!=='auto'){protocolHint.textContent=`全部模型使用 ${interfaceName(protocol.value)}（手动），之后加入的模型也使用它。`;return;}
    if(editing&&url.value.trim()===source.api_url){const byText=new Map();for(const model of group)if(model.protocol?.inferred){const text=protocolText(model.protocol.inferred);byText.set(text,[...(byText.get(text)||[]),model.model_name]);}
      protocolHint.textContent='自动推断：'+[...byText].map(([text,names])=>`${names.join('、')} → ${text}`).join('；');return;}
    protocolHint.textContent=!urlProtocol?'自动推断：填写地址后显示。':urlProtocol.source==='url'?`自动推断：${protocolText(urlProtocol)}，地址已指明接口。`:`自动推断：${protocolText(urlProtocol)}；目录里有记录的模型按目录推断。`;
  };
  const draw=()=>{
    selectedLabel.hidden=false;selectedLabel.textContent=`已选 ${selected.size} 个待添加模型 · 获取列表不等于模型可用`;drawImpact();
    picked.replaceChildren(...[...selected].map(name=>button(name+' ×',()=>{selected.delete(name);draw();},'quiet model-chip')));
    choices.replaceChildren(...available.filter(name=>name.toLowerCase().includes(filter.value.trim().toLowerCase())).map(name=>{
      const have=existing.has(name),chosen=selected.has(name),item=button(name+(have?' · 已添加':chosen?' ✓':''),()=>{selected.has(name)?selected.delete(name):selected.add(name);draw();},'quiet model-chip');
      item.disabled=have;item.setAttribute('aria-pressed',String(chosen));return item;
    }));
  };
  const stale=()=>{request++;available=[];selected.clear();filter.hidden=true;result.replaceChildren();draw();};
  const refreshEndpoint=watchEndpoint(url,preview,()=>{if(!named){let host='';try{host=new URL(url.value.trim()).host;}catch{}name.value=host;}stale();drawProtocol();},()=>protocol.value,value=>{urlProtocol=value;drawProtocol();});
  key.addEventListener('input',stale);filter.addEventListener('input',draw);
  name.addEventListener('input',()=>{named=true;drawImpact();});
  // Another interface lists and tests through other addresses, so earlier upstream answers no longer apply; the models
  // already picked stay picked.
  protocol.addEventListener('change',()=>{request++;result.replaceChildren();drawImpact();drawProtocol();refreshEndpoint(0);});
  const fetchModels=button('获取模型列表',async()=>{
    const address=url.value.trim();if(!address||!editing&&!key.value.trim()){message.textContent='先填写接口 URL 和 API Key';return;}
    message.textContent='';const version=++request;fetchModels.disabled=true;result.replaceChildren(element('p','正在获取模型列表…','view-progress'));
    try{
      const value=await api(editing?`/api/models/${source.id}/upstream`:'/api/models/upstream','POST',editing?{version:source.version,api_url:address,api_key:key.value,interface_type:protocol.value}:{repository_id:repositoryId,api_url:address,api_key:key.value,interface_type:protocol.value});
      if(version!==request||!modal.isConnected)return;
      if(!value.ok){result.replaceChildren(...probeFailure(value));return;}available=value.models;filter.hidden=!available.length;draw();
      result.replaceChildren(element('p',`返回 ${value.total} 个模型${value.truncated?'（仅显示前 '+value.models.length+' 个）':''}，选择要添加的模型后保存。`,'view-success'));
    }catch(err){if(version===request)result.replaceChildren(element('p',readErrorText(err),'view-error'));}finally{fetchModels.disabled=false;}
  });
  const addManual=button('加入待添加',()=>{const name=manual.value.trim();if(!name)return;if(existing.has(name)){message.textContent='这个模型已经在该供应商下';return;}selected.add(name);manual.value='';message.textContent='';draw();});
  // Enter in a text box submits its form, which here saves the provider: in the filter it only filters, in the manual
  // name box it adds the name to the list. An Enter that ends an input method composition is left alone.
  filter.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();draw();}});
  manual.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();addManual.click();}});
  const manualRow=element('div','','actions provider-manual');manualRow.append(field('手动模型名',manual),addManual);
  fields.append(field('名称',name),field('接口 URL',url),field('接口协议',protocol),protocolHint,field(editing?'API Key（留空保持不变）':'API Key',key),
    note(editing?`修改 URL 或填写新 Key 将应用于本供应商的 ${group.length} 个模型。留空则保留各模型现有 Key，页面不会回显。`:'填写连接信息，获取模型列表或手动添加至少一个模型后保存。Key 加密保存，不会回显。'),endpointDetail);
  if(editing)fields.append(element('h3','已配置模型'),note([...existing].join('、')),note(group.some(model=>model.key_configured)?'Key 已保存；如需更换，在上方填写新 Key。':'Key 已撤销；填写新 Key 后才能调用模型。'));
  fields.append(element('h3',editing?'添加模型':'选择模型'),fetchModels,result,filter,choices,manualRow,selectedLabel,picked);
  const testDraft=button('测试当前连接',async()=>{
    const model=manual.value.trim()||[...selected][0]||source?.model_name,address=url.value.trim();
    if(!model||!address||!editing&&!key.value.trim()){message.textContent='填写连接信息，并选择或手动填写一个待测试模型。';return;}
    const version=++request;testDraft.disabled=true;result.replaceChildren(element('p','正在测试当前连接…','view-progress'));
    try{
      const value=await api(editing?`/api/models/${source.id}/test`:'/api/models/test','POST',editing?{version:source.version,api_url:address,api_key:key.value,model_name:model,interface_type:protocol.value}:{repository_id:repositoryId,api_url:address,api_key:key.value,model_name:model,interface_type:protocol.value});
      if(version===request&&modal.isConnected)result.replaceChildren(...testOutcome(value),note(`本次测试模型：${model}；测试不会保存连接或添加模型。`));
    }catch(err){if(version===request&&modal.isConnected)result.replaceChildren(element('p',readErrorText(err),'view-error'));}
    finally{testDraft.disabled=false;}
  });
  fields.append(testDraft,note('测试使用当前填写的 URL、接口协议与 Key；编辑时 Key 留空则复用已保存的 Key。测试通过不代表所有待添加模型都可用。'),impact);
  const actions=element('div','','actions provider-editor-actions'),save=element('button','保存'),cancel=button('取消',()=>modal.close());save.type='submit';
  const latest=button('读取最新版本并比较',async()=>{
    latest.disabled=true;
    try{
      const value=await api('/api/models'),next=byProvider(value.models.filter(model=>model.repository_id===source.repository_id)).find(models=>models.some(model=>model.id===source.id));
      if(!next)throw new Error('该供应商已删除，草稿仍保留，请取消后确认最新列表。');
      const comparison=element('p',`服务器当前名称：${next[0].provider_name||'（未命名）'}；地址：${next[0].api_url}；接口协议：${providerInterface(next)==='auto'?'自动':interfaceName(providerInterface(next))}；模型：${next.map(model=>model.model_name).join('、')}。当前表单仍为你的草稿，核对后再保存。`,'provider-comparison');
      group=next;source=next.find(model=>model.key_configured)||next[0];existing.clear();next.forEach(model=>existing.add(model.model_name));
      for(const name of selected)if(existing.has(name))selected.delete(name);
      message.replaceChildren(comparison);draw();latest.hidden=true;
    }catch(err){message.textContent = readErrorText(err);}finally{latest.disabled=false;}
  });latest.hidden=true;actions.append(latest);
  const snapshot=()=>group.map(model=>({id:model.id,version:model.version}));
  if(editing&&group.some(model=>model.key_configured))actions.append(button('撤销供应商 Key',async()=>{
    const revoked=await confirmDialog({title:'撤销此供应商的 API Key？',body:[`撤销这 ${group.length} 个模型的 Key，使用它们的任务将等待配置。`,'未保存的 URL 和待添加模型不会保存。'],action:'撤销',danger:true,
      run:()=>api(`/api/models/${source.id}/provider`,'PATCH',{versions:snapshot(),revoke_key:true})});
    if(revoked){modal.close();await after('已撤销供应商下全部模型的 Key');}
  },'quiet destructive'));
  actions.append(cancel,save);const scroll=element('div','','provider-editor-scroll');scroll.append(fields);form.append(head,scroll,message,actions);modal.append(form);document.body.append(modal);
  form.addEventListener('submit',async event=>{
    event.preventDefault();message.textContent='';const address=url.value.trim(),pending=manual.value.trim(),title=name.value.trim();if(pending&&!existing.has(pending))selected.add(pending);
    if(!title){message.textContent='请填写供应商名称';return;}
    if(!address||!editing&&!key.value.trim()){message.textContent='请填写接口 URL 和 API Key';return;}
    if(!editing&&!selected.size){message.textContent='请先选择或手动添加至少一个模型';return;}
    const changes={};if(editing){if(renamed())changes.name=title;if(reprotocol())changes.interface_type=protocol.value;if(address!==source.api_url)changes.api_url=address;if(key.value.trim())changes.api_key=key.value;if(selected.size)changes.model_names=[...selected];}
    if(editing&&!Object.keys(changes).length){modal.close();return;}drawImpact();
    fields.disabled=true;for(const control of actions.querySelectorAll('button'))control.disabled=true;
    try{
      await api(editing?`/api/models/${source.id}/provider`:'/api/models/provider',editing?'PATCH':'POST',editing?{versions:snapshot(),...changes}:{repository_id:repositoryId,name:title,api_url:address,api_key:key.value,model_names:[...selected],interface_type:protocol.value});
      modal.close();await after(editing?'已保存供应商配置'+(selected.size?'，已添加 '+[...selected].join('、'):''):'已新增供应商，已添加 '+[...selected].join('、'));
    }catch(err){const code=err.message.replace(/^\d+\s*·\s*/,'');message.textContent=({version_conflict:'供应商已被其他页面修改。草稿已保留，请读取最新版本并核对差异后再保存。',...providerErrors,model_key_missing:'请填写 API Key 后添加模型。',model_already_exists:'要添加的模型已经存在，请重新打开供应商。'})[code]|| readErrorText(err);latest.hidden=code!=='version_conflict';}
    finally{fields.disabled=false;for(const control of actions.querySelectorAll('button'))control.disabled=false;}
  });
  modal.addEventListener('close',()=>{request++;key.value='';modal.remove();},{once:true});draw();drawProtocol();if(!editing||protocol.value!=='auto')refreshEndpoint(0);modal.showModal();
}
function probeResult(className = '') { const box = element('div', '', ('probe-result ' + className).trim()); box.setAttribute('role', 'status'); return box; }
const probeErrors = { upstream_timeout: '上游 15 秒内没有响应', upstream_unreachable: '无法连接上游', upstream_redirect: '上游要求重定向，请改填最终地址',
  upstream_http_error: '上游返回错误', upstream_response_invalid: '上游返回的内容无法识别', upstream_response_too_large: '上游返回的内容过大' };
function probeFailure(value) {
  const reason = (probeErrors[value.error] || value.error) + (value.status ? `（HTTP ${value.status}）` : '') + (value.message ? '：' + value.message : '');
  return [element('p', reason, 'view-error'), facts([['请求地址', value.chat_url || value.models_url]])];
}
// `current` is the saved model's name; an unsaved form passes nothing and offers the ids in its own picker.
function listOutcome(value, current) {
  if (!value.ok) return probeFailure(value);
  const nodes = [element('p', `上游返回 ${value.total} 个模型${value.truncated ? `，只列出按名称排序的前 ${value.models.length} 个` : ''}。`, 'view-success')];
  if (current !== undefined) nodes.push(note(value.models.includes(current) ? `当前模型名 ${current} 在列表中。`
    : `当前模型名 ${current} 不在${value.truncated ? '列出的部分' : '列表'}中；上游没有列出的名字也可能可用，可以用「测试模型」确认。`));
  if (value.models.length) nodes.push(collapsible(`模型 id（${value.models.length}）`, value.models.join('\n')));
  return nodes;
}
function testOutcome(value) {
  if (!value.ok) return probeFailure(value);
  const reply = value.reply || (value.finish_reason === 'length' ? '（空，已达到测试的输出上限）' : '（空）');
  return [element('p', `测试通过 · HTTP ${value.status} · ${value.elapsed_ms} ms`, 'view-success'), facts([['上游返回的模型', value.model || '（未返回）'], ['回复摘录', reply]])];
}
// A button that runs one upstream call and writes its outcome to `result`; a newer call or `stale()` discards older answers.
function probeButton(caption, result, call, render, check = () => '') {
  const run = button(caption, async () => {
    const problem = check(); if (problem) { result.replaceChildren(element('p', problem, 'view-error')); return; }
    const request = result.dataset.request = String(Number(result.dataset.request || 0) + 1);
    run.disabled = true; result.replaceChildren(element('p', `正在${caption}…`, 'view-progress'));
    try { const value = await call(); if (result.dataset.request === request) result.replaceChildren(...render(value)); }
    catch (err) { if (result.dataset.request === request) result.replaceChildren(element('p', readErrorText(err), 'view-error')); }
    finally { run.disabled = false; }
  });
  return run;
}
// The address preview follows the typing and the chosen interface (`chosen()`, "auto" by default); `changed` runs on
// every edit of the URL and `seen` gets each answer (null once the URL is empty). Returns a refresh for other inputs.
function watchEndpoint(url, preview, changed = () => {}, chosen = () => 'auto', seen = () => {}) {
  let previewRequest = 0, timer = null;
  const refresh = (delay = 250) => {
    clearTimeout(timer); const value = url.value.trim(), request = ++previewRequest;
    if (!value) { preview.replaceChildren(); seen(null); return; }
    timer = setTimeout(async () => {
      try { const endpoints = await api('/api/models/endpoints?' + new URLSearchParams({ api_url: value, interface_type: chosen() })); if (request === previewRequest) { preview.replaceChildren(...endpointFacts(endpoints)); seen(endpoints); } }
      catch (err) { if (request === previewRequest) preview.replaceChildren(element('p', String(err?.message || '').includes('insecure_api_url')
        ? '明文 HTTP 只允许本机地址（localhost、127.0.0.1 或 [::1]）；其他地址请用 https://。'
        : '地址无效：需要 http:// 或 https://，不能包含用户名、密码、? 或 #。', 'endpoint-warning')); }
    }, delay);
  };
  url.addEventListener('input', () => { changed(); refresh(); });
  return refresh;
}
// The interface of a provider form: "auto" or one manual interface.
function interfaceSelect(value = 'auto') {
  const select = document.createElement('select'); select.name = 'interface_type';
  for (const [id, caption] of [['auto', '自动（按模型推断）'], ...Object.entries(interfaceNames)]) select.add(new Option(caption, id));
  select.value = value; return select;
}
