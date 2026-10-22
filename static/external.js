// Repository-scoped integrations share the existing login and management API.
titles.external='外部执行端';
const externalDialog=dialog('external-editor','<form id="external-form"><h2 id="external-title"></h2><p class="muted" id="external-help"></p><div id="external-fields"></div><p id="external-error" role="alert"></p><div class="actions"><button type="button" id="external-cancel" class="quiet">取消</button><button type="submit">保存</button></div></form>');
externalDialog.setAttribute('aria-labelledby','external-title');
const credentialDialog=dialog('external-credential','<h2>请保存新凭据</h2><p>仅显示一次，请保存到外部执行端；关闭后无法读取。</p><label>新凭据<input id="external-secret" type="password" readonly autocomplete="off"></label><div class="actions"><button id="external-show" class="quiet">显示</button><button id="external-copy" class="quiet">复制凭据</button><button id="external-done">已保存并关闭</button></div><p id="external-copy-status" role="status"></p>');
externalDialog.classList.remove('wide');credentialDialog.classList.remove('wide');
credentialDialog.setAttribute('aria-label','一次性凭据');
let saveExternal=null;
let externalAudience='';
const externalKeyCommands='umask 077\nopenssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out bot-client.pem\nopenssl pkey -in bot-client.pem -pubout -out bot-client.pub.pem';
const externalTokenPermissions='contents: read、issues: write、pull_requests: write';
function externalTokenCommand(client,audience){
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  return 'node scripts/external-token.mjs --url '+quote(audience)+' --client-id '+quote(client.id)+' --key ./bot-client.pem';
}
function externalAgentInstructions(client,audience){
  const exchange=audience
    ?'兑换地址（同时是签名证明的 audience）：'+audience+'\n公钥登记完成后运行：\n'+externalTokenCommand(client,audience)
    :'兑换地址尚未配置。请先让超级管理员在「外部执行端 → 设置兑换地址」保存以 /external/token 结尾的 HTTPS 地址，再从页面重新复制指令；不要猜测或编造 URL，配置完成前不要兑换。';
  return '请在我的个人电脑上完成部门 Bot 公钥接入。客户端 ID：'+client.id+'；绑定仓库 ID：'+client.repository_id+'。\n\n'
    +'1. 确保本机有 OpenSSL 和 Node.js 22+。从 https://github.com/agent-CI-Infra/bot 获取现有 scripts/external-token.mjs，保持此相对路径，协议以该仓库 docs/external-executors.md 为准，不要另造兑换方法。先检查密钥文件是否已存在，不要覆盖已有私钥；如果没有，在本机私有目录运行：\n'+externalKeyCommands+'\n只将 bot-client.pub.pem 的公钥内容交给我，由我在这个客户端的「登记公钥／更换公钥」中保存，并等待我确认。只接受 BEGIN PUBLIC KEY 的 SPKI PEM、2048–4096 位 RSA。bot-client.pem 私钥始终留在我的电脑，不要粘贴到 Bot、聊天或日志。\n\n'
    +'2. '+exchange+'\n脚本只发送最长 120 秒的签名证明，不上传私钥。不要在聊天、日志或提交中显示私钥、签名证明或响应 token；安全地保留响应里的 grant_id、token 和 expires_at 供本次任务使用。\n\n'
    +'3. 成功响应里的 token 是该仓库的 GitHub App 安装令牌。以 Authorization: Bearer <token> 调用 GitHub，只操作绑定仓库。固定权限为 '+externalTokenPermissions+'，不能扩大权限，不能当 Contents write 使用；按 expires_at 到期。\n\n'
    +'4. 完成任务后，对'+(audience?' '+new URL('/external/revoke',audience).href+' ':'与兑换地址同源的 /external/revoke ')+'发送 POST，Content-Type: application/json，正文为 {"grant_id":"<响应中的 grant_id>","token":"<响应中的 token>"}，撤销本次令牌。不要输出实际 token。';
}
function externalKeyHelp(){
  const help=element('details','','external-key-help');help.append(element('summary','如何在个人电脑生成公钥'));
  help.append(element('p','在个人电脑的私有目录执行；先检查文件是否存在，不要覆盖已有私钥。'),element('pre',externalKeyCommands),element('p','只粘贴 bot-client.pub.pem 中 BEGIN PUBLIC KEY 的 SPKI PEM 公钥，支持 2048–4096 位 RSA。bot-client.pem 私钥留在个人电脑，不要交给 Bot、聊天或日志。'));return help;
}
function externalPublicKeyGuide(client=null,audience=externalAudience){
  const guide=element('details','','external-guide');guide.append(element('summary',client?'公钥接入说明与复制指令':'个人电脑接入：生成公钥、兑换与使用 token'));
  const body=element('div','','external-guide-body'),head=element('div','','heading'),status=element('p','','muted');status.setAttribute('role','status');
  head.append(element('strong',client?'客户端 '+client.id:'按以下步骤接入个人电脑'));
  if(client){
    const text=externalAgentInstructions(client,audience),fallback=element('textarea','');fallback.readOnly=true;fallback.hidden=true;fallback.rows=10;fallback.setAttribute('aria-label','可手动复制的接入指令');
    head.append(button('复制给我的 AI agent',async()=>{try{await navigator.clipboard.writeText(text);status.textContent='已复制接入指令';}catch{fallback.value=text;fallback.hidden=false;fallback.focus();fallback.select();status.textContent='剪贴板不可用，请手动复制下方完整指令。';}}));body.append(head,status,fallback);
  }else body.append(head);
  const steps=element('ol','');
  const keyStep=element('li','');keyStep.append(element('strong','在个人电脑生成公钥'),element('pre',externalKeyCommands),element('p','先检查文件是否已存在，不要覆盖已有私钥。仅将 bot-client.pub.pem 的公钥粘贴到 Bot；只接受 BEGIN PUBLIC KEY 的 SPKI PEM、2048–4096 位 RSA。bot-client.pem 私钥留在个人电脑，不要粘贴进 Bot、聊天或日志。'));
  const exchangeStep=element('li','');exchangeStep.append(element('strong','兑换自己的 GitHub token'),element('p','超级管理员先设置以 /external/token 结尾的 HTTPS 兑换地址；该完整地址就是签名证明的 audience。'));
  if(audience){exchangeStep.append(element('p','当前兑换地址：'+audience));if(client)exchangeStep.append(element('pre',externalTokenCommand(client,audience)));else exchangeStep.append(element('p','新增客户端并登记公钥后，在该客户端的接入说明中取得带真实客户端 ID 的命令。'));}
  else exchangeStep.append(element('p','兑换地址尚未配置：请超级管理员先设置，再重新打开说明。配置前无法兑换，不要猜测 URL。'));
  const scriptHelp=element('p','在个人电脑使用 Node.js 22+，获取 '),scriptLink=element('a','scripts/external-token.mjs');scriptLink.href='https://github.com/agent-CI-Infra/bot/blob/main/scripts/external-token.mjs';scriptLink.target='_blank';scriptLink.rel='noopener noreferrer';scriptHelp.append(scriptLink,document.createTextNode(' 后运行。工具只发送最长 120 秒的签名证明，不上传私钥；成功响应的 token 是绑定仓库的 GitHub App 安装令牌。'));exchangeStep.append(scriptHelp);
  const tokenStep=element('li','');tokenStep.append(element('strong','使用并撤销 token'),element('p','用 Authorization: Bearer <token> 调用 GitHub。权限固定为 '+externalTokenPermissions+'，只限客户端绑定仓库，不能扩大权限，不能当 Contents write。按响应 expires_at 到期，不要将 token 写入聊天、日志或提交。'),element('p','用完调用 POST '+(audience?new URL('/external/revoke',audience).href:'/external/revoke（与兑换地址同源）')+'，Content-Type: application/json，正文：'),element('pre','{"grant_id":"<响应中的 grant_id>","token":"<响应中的 token>"}'));
  steps.append(keyStep,exchangeStep,tokenStep);body.append(steps);guide.append(body);return guide;
}
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
  try{const result=await save(Object.fromEntries(new FormData(event.currentTarget)));externalDialog.close();await render();if(result.signing_secret)externalSecret(result.signing_secret);}
  catch(err){$('external-error').textContent=({invalid_client_public_key:'请填写 2048–4096 位 RSA 公钥（BEGIN PUBLIC KEY），不要提交私钥。',invalid_token_audience:'请填写以 /external/token 结尾的 HTTPS 地址，不能带查询参数、用户名或密码。'})[err.message]||err.message;}finally{submit.disabled=false;}
};
function editor(title,help,fields,save){$('external-title').textContent=title;$('external-help').textContent=help;$('external-fields').replaceChildren(...fields);$('external-error').textContent='';saveExternal=save;externalDialog.showModal();}
function addClient(){
  if(!repositories.length){error(new Error('请先登记有权使用的 GitHub App 仓库'));return;}
  const name=externalField('name','客户端名称'),repo=externalField('repository_id','授权仓库',repositories[0].id,repositories.map(r=>[r.id,r.full_name])),type=externalField('auth_type','身份认证','private_key_jwt',[['private_key_jwt','个人电脑 / 公钥签名'],['github_actions_oidc','GitHub Actions OIDC']]);
  const key=publicKeyField(),keyHelp=externalKeyHelp();
  const trust=element('fieldset','');trust.hidden=true;trust.append(element('legend','受信任工作流'));
  const entries=[['audience','Audience'],['subject','Subject'],['repository','工作流仓库 owner/repo'],['repository_id','工作流仓库 ID'],['owner_id','工作流组织 ID'],['workflow_ref','Workflow ref'],['ref','分支 ref']];
  for(const [key,caption]of entries){const field=externalField('trust_'+key,caption,key==='ref'?'refs/heads/main':'');field.querySelector('input').disabled=true;trust.append(field);}
  type.querySelector('select').onchange=event=>{trust.hidden=event.target.value!=='github_actions_oidc';trust.querySelectorAll('input').forEach(input=>input.disabled=trust.hidden);key.hidden=!trust.hidden;keyHelp.hidden=key.hidden;key.querySelector('textarea').disabled=key.hidden;$('external-help').textContent=trust.hidden?'在个人电脑生成密钥，只登记 RSA 公钥，私钥留在本机。授权限定为单仓库。':'GitHub Actions OIDC 使用受信任工作流身份，不登记个人电脑公钥。';};
  editor('新增客户端','在个人电脑生成密钥，只登记 RSA 公钥，私钥留在本机。授权限定为单仓库。',[name,repo,type,keyHelp,key,trust],data=>{
    const body={name:data.name,repository_id:data.repository_id,auth_type:data.auth_type};if(data.auth_type==='github_actions_oidc')body.trust=Object.fromEntries(entries.map(([key])=>[key,data['trust_'+key]]));else body.public_key=publicKeyValue(data.public_key);return api('/api/external/clients','POST',body);
  });
}
function publicKeyField(){const label=element('label','RSA 公钥（PEM）'),input=document.createElement('textarea');input.name='public_key';input.required=true;input.rows=7;input.spellcheck=false;input.placeholder='-----BEGIN PUBLIC KEY-----';label.append(input);return label;}
function publicKeyValue(value){if(!value.trim().startsWith('-----BEGIN PUBLIC KEY-----')||value.includes('PRIVATE KEY'))throw new Error('请只粘贴公钥（BEGIN PUBLIC KEY），私钥必须留在个人电脑。');return value;}
function registerPublicKey(client){editor(client.key_configured?'更换客户端公钥':'登记客户端公钥','只粘贴公钥，不能提交私钥。保存后旧公钥立即失效，客户端 ID 和订阅保留。',[externalPublicKeyGuide(client),publicKeyField()],data=>api('/api/external/clients/'+client.id,'PATCH',{public_key:publicKeyValue(data.public_key)}));}
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
  const [{clients},{subscriptions},{deliveries},{grants},{settings}]=await Promise.all(['clients','subscriptions','deliveries','grants','settings'].map(type=>api('/api/external/'+type+suffix)));
  if(request!==renderVersion)return;externalAudience=settings.token_audience||'';$('count').textContent=clients.length+' 个客户端 · '+subscriptions.length+' 个订阅';const panel=$('external-panel');panel.replaceChildren();
  const mutate=async(path,body)=>{const result=await api(path,'PATCH',body);await render();if(result.signing_secret)externalSecret(result.signing_secret);};
  const endpoint=externalGroup('签名证明的兑换地址',me.role==='super_admin'?button('设置兑换地址',()=>editor('设置兑换地址','填写客户端实际访问的 HTTPS /external/token 地址，作为签名证明的固定 audience。',[externalField('token_audience','兑换地址',settings.token_audience||'')],data=>api('/api/external/settings','PUT',data))):null);
  endpoint.append(element('p',settings.token_audience||'尚未配置，个人电脑客户端暂不能兑换；请超级管理员设置。','muted'),externalPublicKeyGuide());panel.append(endpoint);
  const group=externalGroup('客户端',button('新增客户端',addClient));
  for(const c of clients){const actions=[button(c.enabled?'停用':'启用',()=>mutate('/api/external/clients/'+c.id,{enabled:!c.enabled}).catch(error))];if(c.auth_type==='private_key_jwt')actions.push(button(c.key_configured?'更换公钥':'登记公钥',()=>registerPublicKey(c)));
    const pending=c.auth_type==='private_key_jwt'&&!c.key_configured,row=externalRow(c.name,`仓库 ${c.repository_id} · ${c.auth_type==='private_key_jwt'?'公钥签名':'GitHub Actions OIDC'} · ID ${c.id}`,pending?'待登记公钥':c.enabled?'已启用':'已停用',actions);if(c.key_fingerprint)row.querySelector('.row-content').append(element('p','公钥指纹 SHA256 '+c.key_fingerprint));if(pending)row.querySelector('.row-content').append(element('p','旧客户端凭据已停用，请在个人电脑生成密钥后登记公钥。'));if(c.auth_type==='private_key_jwt')row.append(externalPublicKeyGuide(c));group.append(row);}
  if(!clients.length)group.append(element('p','尚未配置外部客户端','muted'));panel.append(group);
  const subs=externalGroup('Webhook 转发订阅',button('新增转发订阅',()=>editSubscription(clients)));
  for(const s of subscriptions)subs.append(externalRow(s.name,`仓库 ${s.repository_id} · ${s.url} · ${s.filters.events.join(',')} / ${s.filters.actions.join(',')||'全部动作'}${s.filters.exclude_drafts?' · 排除草稿':''}`,s.enabled?'已启用':'已停用',[
    button('编辑',()=>editSubscription(clients,s)),button(s.enabled?'停用':'启用',()=>mutate('/api/external/subscriptions/'+s.id,{enabled:!s.enabled}).catch(error))]));
  if(!subscriptions.length)subs.append(element('p','尚未配置转发订阅','muted'));panel.append(subs);
  const records=externalGroup('最近转发（最多 100 条）');for(const d of deliveries)records.append(externalRow(d.id,`仓库 ${d.repository_id} · 尝试 ${d.attempts} 次${d.http_status?' · HTTP '+d.http_status:''}${d.error?' · '+d.error:''}`,({pending:'待投递',sending:'投递中',retry:'等待重试',succeeded:'已送达',failed:'失败',cancelled:'已取消'})[d.state]||d.state,d.state==='failed'?[button('重试',async()=>{try{await api('/api/external/deliveries/'+d.id+'/retry','POST',{});await render();}catch(e){error(e);}})]:[]));
  if(!deliveries.length)records.append(element('p','暂无转发记录','muted'));panel.append(records);
  const tokens=externalGroup('最近临时授权（最多 100 条）');for(const g of grants)tokens.append(externalRow(g.id,`仓库 ${g.repository_id} · 客户端 ${g.client_id}${g.expires_at?' · 到期 '+timestamp(g.expires_at):''}`,({issuing:'签发中',issued:'已签发',failed:'失败',revoked:'已撤销'})[g.state]||g.state));if(!grants.length)tokens.append(element('p','暂无签发记录','muted'));panel.append(tokens);
}
