function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
// Connections belong to the provider editor; testing, naming, pricing and deletion stay with each model.
function modelActions(model, result, after = reloadWith) {
  const actions = element('div', '', 'actions'), editable = me.role === 'super_admin' || model.repository_id === current?.id;
  if (!editable) return actions;
  if (model.key_configured) actions.append(probeButton('测试模型', result, () => api(`/api/models/${model.id}/test`, 'POST', {}), testOutcome));
  actions.append(button('修改模型名', () => modelEdit(model, after)), button('计费单价', () => modelPricing(model, after)));
  actions.append(button('删除', async () => {
    const actor=me,target=current,address=location.hash,live=()=>me===actor&&current===target&&location.hash===address;
    let detail;
    try { detail = (await api(`/api/models/${model.id}`)).model; }
    catch (err) { if(live()){result.hidden = false; result.replaceChildren(element('p', err.message, 'view-error'));} return; }
    if(!live())return;
    if(!Array.isArray(detail.used_by)||!Array.isArray(detail.role_used_by)||typeof detail.onboarding_default!=='boolean'
      ||detail.role_used_by.some(role=>!['project_role','service_role'].includes(role.type))){
      result.hidden=false;result.replaceChildren(element('p','暂时无法确认完整引用范围，请重新读取后再删除。','view-error'));return;
    }
    const used = detail.used_by || [], body = [
      '只从本系统删除这条模型配置，并销毁封存的 API Key；页面和日志都不会显示它。',
      '不会删除 GitHub 上的任何东西。已有成本记录保留，仍使用当时记下的模型名和单价。'];
    if (used.length) body.push('以下项目正在使用它。默认选择会改回“不使用模型”；任务专属选择保留为不可用，相关任务进入“配置待补”：', used.map(repo => repo.full_name));
    else body.push('当前没有项目默认或工作类型模型选用它。');
    const roles=detail.role_used_by,projectRoles=roles.filter(role=>role.type==='project_role'),serviceRoles=roles.filter(role=>role.type==='service_role');
    const roleName=role=>`${role.full_name?role.full_name+' · ':''}${role.name}（${role.role_id}）${!role.enabled?' · 已停用':role.configuration_enabled===false?' · 角色配置未启用':''}`;
    if(projectRoles.length)body.push('以下项目角色的显式模型引用会保留为不可用，后续执行等待补充配置，不会换用其他模型：',projectRoles.map(roleName));
    if(serviceRoles.length)body.push('以下平台服务角色将变为未配置模型，之后的调用等待重新配置：',serviceRoles.map(roleName));
    if(!roles.length)body.push('当前没有已保存角色显式引用它。');
    if(detail.onboarding_default)body.push('这也是接入向导的默认模型；删除后需要重新选择接入默认模型。');
    body.push('以上是本次读取的已保存配置引用，不包括历史运行快照。已有运行快照和成本记录不会被改写。');
    if (detail.repository_id === null) body.push('这是部署共享模型，删除后所有项目都不能再选它。');
    const deleted = await confirmDialog({ title: `删除模型 ${detail.model_name}？`, body, action: '删除', danger: true,
      progress: '正在删除模型…', run: () => {if(!live())throw new Error('页面或身份已变化，请重新读取模型后再删除。');return api(`/api/models/${model.id}`, 'DELETE', {});} });
    if (deleted&&live()) await after(`已删除模型 ${detail.model_name}`);
  }, 'quiet destructive'));
  return actions;
}
// Model-specific edits do not change its provider's connection settings.
function modelEdit(model, after) {
  const modal = document.createElement('dialog'), form = document.createElement('form'), heading = element('h2', `修改 ${model.model_name} 的模型名`);
  modal.id = 'model-edit'; heading.id = 'model-edit-title'; modal.setAttribute('aria-labelledby', heading.id);
  const name = input('model_name', model.model_name, {required:true,maxLength:200}), message = element('p','','view-error'), actions = element('div','','actions'), save = element('button','保存');
  message.setAttribute('role','alert'); save.type = 'submit'; actions.append(button('取消',()=>modal.close()),save);
  form.append(heading,field('模型名',name),message,actions);
  form.addEventListener('submit',async event=>{
    event.preventDefault();const value=name.value.trim();if(!value){message.textContent='请填写模型名';return;}
    if(value===model.model_name){modal.close();return;}save.disabled=true;
    try{await api('/api/models/'+model.id,'PATCH',{version:model.version,model_name:value});modal.close();await after(`已保存模型名 ${value}`);}
    catch(err){message.textContent=err.message;}finally{save.disabled=false;}
  });
  modal.append(form);document.body.append(modal);modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
}
function providerCreate(repositoryId, after = reloadWith) {
  const actions=element('div','','actions provider-create');
  actions.append(button('新增供应商',()=>providerEditor([],repositoryId,after)));return actions;
}

