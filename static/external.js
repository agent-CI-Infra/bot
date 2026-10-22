// Repository-scoped integrations share the existing login and management API.
titles.external='外部执行端';
const externalDialog=dialog('external-editor','<form id="external-form"><h2 id="external-title"></h2><p class="muted" id="external-help"></p><div id="external-fields"></div><p id="external-error" role="alert"></p><div class="actions"><button type="button" id="external-cancel" class="quiet">取消</button><button type="submit">保存</button></div></form>');
externalDialog.setAttribute('aria-labelledby','external-title');
const credentialDialog=dialog('external-credential','<h2>请保存新凭据</h2><p>仅显示一次，请保存到外部执行端；关闭后无法读取。</p><label>新凭据<input id="external-secret" type="password" readonly autocomplete="off"></label><div class="actions"><button id="external-show" class="quiet">显示</button><button id="external-copy" class="quiet">复制凭据</button><button id="external-done">已保存并关闭</button></div><p id="external-copy-status" role="status"></p>');
externalDialog.classList.remove('wide');credentialDialog.classList.remove('wide');
credentialDialog.setAttribute('aria-label','一次性凭据');
let saveExternal=null;
function externalField(name,caption,value='',choices=null){
  const label=element('label',caption),input=document.createElement(choices?'select':'input');input.name=name;
  if(choices)choices.forEach(([id,name])=>input.add(new Option(name,id)));input.value=value;input.required=true;label.append(input);return label;
}
function externalSecret(secret){$('external-secret').value=secret;$('external-secret').type='password';$('external-show').textContent='显示';$('external-copy-status').textContent='';credentialDialog.showModal();}
credentialDialog.addEventListener('close',()=>{$('external-secret').value='';$('external-copy-status').textContent='';});
$('external-done').onclick=()=>credentialDialog.close();$('external-show').onclick=()=>{const field=$('external-secret');field.type=field.type==='password'?'text':'password';$('external-show').textContent=field.type==='password'?'显示':'隐藏';};
$('external-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('external-secret').value);$('external-copy-status').textContent='已复制';}catch{$('external-copy-status').textContent='请显示凭据后手动复制';}};
$('external-cancel').onclick=()=>externalDialog.close();externalDialog.addEventListener('close',()=>{$('external-form').reset();$('external-fields').replaceChildren();saveExternal=null;});
$('logout').addEventListener('click',()=>{externalDialog.close();credentialDialog.close();$('external-panel').replaceChildren();});
$('external-form').onsubmit=async event=>{
  event.preventDefault();const save=saveExternal,submit=event.currentTarget.querySelector('[type=submit]');submit.disabled=true;$('external-error').textContent='';
  try{const result=await save(Object.fromEntries(new FormData(event.currentTarget)));externalDialog.close();await render();if(result.client_secret||result.signing_secret)externalSecret(result.client_secret||result.signing_secret);}
  catch(err){$('external-error').textContent=err.message;}finally{submit.disabled=false;}
};
function editor(title,help,fields,save){$('external-title').textContent=title;$('external-help').textContent=help;$('external-fields').replaceChildren(...fields);$('external-error').textContent='';saveExternal=save;externalDialog.showModal();}
function addClient(){
  if(!repositories.length){error(new Error('请先登记有权使用的 GitHub App 仓库'));return;}
  const name=externalField('name','客户端名称'),repo=externalField('repository_id','授权仓库',repositories[0].id,repositories.map(r=>[r.id,r.full_name])),type=externalField('auth_type','身份认证','client_secret',[['client_secret','个人电脑 / 客户端凭据'],['github_actions_oidc','GitHub Actions OIDC']]);
  const trust=element('fieldset','');trust.hidden=true;trust.append(element('legend','受信任工作流'));
  const entries=[['audience','Audience'],['subject','Subject'],['repository','工作流仓库 owner/repo'],['repository_id','工作流仓库 ID'],['owner_id','工作流组织 ID'],['workflow_ref','Workflow ref'],['ref','分支 ref']];
  for(const [key,caption]of entries){const field=externalField('trust_'+key,caption,key==='ref'?'refs/heads/main':'');field.querySelector('input').disabled=true;trust.append(field);}
  type.querySelector('select').onchange=event=>{trust.hidden=event.target.value!=='github_actions_oidc';trust.querySelectorAll('input').forEach(input=>input.disabled=trust.hidden);};
  editor('新增客户端','授权限定为单仓库的代码读取与 Issue / PR 写入；GitHub 凭据不能细分到单个 PR。',[name,repo,type,trust],data=>{
    const body={name:data.name,repository_id:data.repository_id,auth_type:data.auth_type};if(data.auth_type==='github_actions_oidc')body.trust=Object.fromEntries(entries.map(([key])=>[key,data['trust_'+key]]));return api('/api/external/clients','POST',body);
  });
}
function editSubscription(clients,row=null){
  if(!clients.length){error(new Error('请先新增客户端'));return;}
  const client=externalField('client_id','外部客户端',row?.client_id||clients[0].id,clients.map(c=>[c.id,c.name+' · 仓库 '+c.repository_id]));client.querySelector('select').disabled=!!row;
  const list=values=>String(values).split(',').map(v=>v.trim()).filter(Boolean);
  const fields=[client,externalField('name','订阅名称',row?.name||''),externalField('url','接收 URL',row?.url||'')];fields[2].querySelector('input').type='url';
  fields.push(externalField('events','事件类型（逗号分隔）',(row?.filters.events||['pull_request']).join(',')),externalField('actions','事件动作（留空表示全部）',(row?.filters.actions||['opened','ready_for_review','synchronize']).join(',')));fields.at(-1).querySelector('input').required=false;
  const draft=element('label',''),check=document.createElement('input');check.type='checkbox';check.name='exclude_drafts';check.checked=row?.filters.exclude_drafts??true;draft.className='external-check';draft.append(check,element('span','排除草稿 PR'));fields.push(draft);
  editor(row?'编辑转发订阅':'新增转发订阅','接收端须校验签名，并按转发 ID 去重；内网地址需部署管理员加入允许名单。',fields,data=>{
    const body={name:data.name,url:data.url,filters:{events:list(data.events),actions:list(data.actions),exclude_drafts:data.exclude_drafts==='on'}};
    if(row){return api('/api/external/subscriptions/'+row.id,'PATCH',body);}body.client_id=data.client_id;return api('/api/external/subscriptions','POST',body);
  });
}
function externalGroup(title,action){const group=element('section','','external-group'),head=element('div','','heading');head.append(element('h2',title));if(action)head.append(action);group.append(head);return group;}
function externalRow(name,detail,stateLabel,actions=[]){const row=element('div','','row'+(actions.length?' has-actions':'')),content=element('div','','row-content');content.append(element('strong',name),element('p',detail));row.append(content,element('span',stateLabel,'status'));if(actions.length){const group=element('div','','actions');group.append(...actions);row.append(group);}return row;}
async function renderExternal(params,request){
  const suffix='?'+params;
  const [{clients},{subscriptions},{deliveries},{grants}]=await Promise.all(['clients','subscriptions','deliveries','grants'].map(type=>api('/api/external/'+type+suffix)));
  if(request!==renderVersion)return;$('count').textContent=clients.length+' 个客户端 · '+subscriptions.length+' 个订阅';const panel=$('external-panel');panel.replaceChildren();
  const mutate=async(path,body)=>{const result=await api(path,'PATCH',body);await render();if(result.client_secret||result.signing_secret)externalSecret(result.client_secret||result.signing_secret);};
  const group=externalGroup('客户端',button('新增客户端',addClient));
  for(const c of clients){const actions=[button(c.enabled?'停用':'启用',()=>mutate('/api/external/clients/'+c.id,{enabled:!c.enabled}).catch(error))];if(c.auth_type==='client_secret')actions.push(button('轮换凭据',()=>mutate('/api/external/clients/'+c.id,{rotate_secret:true}).catch(error)));
    const row=externalRow(c.name,`仓库 ${c.repository_id} · ${c.auth_type==='client_secret'?'客户端凭据':'GitHub Actions OIDC'} · ID ${c.id}`,c.enabled?'已启用':'已停用',actions);group.append(row);}
  if(!clients.length)group.append(element('p','尚未配置外部客户端','muted'));panel.append(group);
  const subs=externalGroup('Webhook 转发订阅',button('新增转发订阅',()=>editSubscription(clients)));
  for(const s of subscriptions)subs.append(externalRow(s.name,`仓库 ${s.repository_id} · ${s.url} · ${s.filters.events.join(',')} / ${s.filters.actions.join(',')||'全部动作'}${s.filters.exclude_drafts?' · 排除草稿':''}`,s.enabled?'已启用':'已停用',[
    button('编辑',()=>editSubscription(clients,s)),button(s.enabled?'停用':'启用',()=>mutate('/api/external/subscriptions/'+s.id,{enabled:!s.enabled}).catch(error))]));
  if(!subscriptions.length)subs.append(element('p','尚未配置转发订阅','muted'));panel.append(subs);
  const records=externalGroup('最近转发（最多 100 条）');for(const d of deliveries)records.append(externalRow(d.id,`仓库 ${d.repository_id} · 尝试 ${d.attempts} 次${d.http_status?' · HTTP '+d.http_status:''}${d.error?' · '+d.error:''}`,({pending:'待投递',sending:'投递中',retry:'等待重试',succeeded:'已送达',failed:'失败',cancelled:'已取消'})[d.state]||d.state,d.state==='failed'?[button('重试',async()=>{try{await api('/api/external/deliveries/'+d.id+'/retry','POST',{});await render();}catch(e){error(e);}})]:[]));
  if(!deliveries.length)records.append(element('p','暂无转发记录','muted'));panel.append(records);
  const tokens=externalGroup('最近临时授权（最多 100 条）');for(const g of grants)tokens.append(externalRow(g.id,`仓库 ${g.repository_id} · 客户端 ${g.client_id}${g.expires_at?' · 到期 '+timestamp(g.expires_at):''}`,({issuing:'签发中',issued:'已签发',failed:'失败',revoked:'已撤销'})[g.state]||g.state));if(!grants.length)tokens.append(element('p','暂无签发记录','muted'));panel.append(tokens);
}
