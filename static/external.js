// Repository-scoped integrations share the existing login and management API.
titles.external='外部执行端';
const externalDialog=dialog('external-editor','<form id="external-form"><h2 id="external-title"></h2><p class="muted" id="external-help"></p><div id="external-fields"></div><p id="external-error" role="alert"></p><div class="actions"><button type="button" id="external-cancel" class="quiet">取消</button><button type="submit">保存</button></div></form>');
externalDialog.setAttribute('aria-labelledby','external-title');
const credentialDialog=dialog('external-credential','<h2>请保存新凭据</h2><p>仅显示一次，请保存到外部执行端；关闭后无法读取。</p><label>新凭据<input id="external-secret" type="password" readonly autocomplete="off"></label><div class="actions"><button id="external-show" class="quiet">显示</button><button id="external-copy" class="quiet">复制凭据</button><button id="external-done">已保存并关闭</button></div><p id="external-copy-status" role="status"></p>');
externalDialog.classList.remove('wide');credentialDialog.classList.remove('wide');
credentialDialog.setAttribute('aria-label','一次性凭据');
let saveExternal=null,externalEditorVersion=0;
let externalAudience='',externalAudienceSource=null;
// The audience can come from the super-admin setting or from the address the wizard verified;
// saying which one it is stops a project administrator from hunting for a button they cannot have.
function audienceCaption(audience=externalAudience,source=externalAudienceSource){
  if(!audience)return '尚未配置，个人电脑客户端暂不能兑换；请超级管理员设置，或先在接入向导中验证公开地址。';
  return source==='onboarding'?audience+'（来自接入向导已验证的公开地址；超级管理员可覆写）':audience;
}
const externalKeyCommands='umask 077\nopenssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out bot-client.pem\nopenssl pkey -in bot-client.pem -pubout -out bot-client.pub.pem';
const externalTokenPermissions='contents: read、issues: write、pull_requests: write';
const externalTokenDocs='/docs/external-token-api.md';
function externalTokenRequest(audience){
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  return 'curl --fail-with-body --silent --show-error \\\n  --request POST '+quote(audience)+' \\\n  --header \'Content-Type: application/json\' \\\n  --header @proof-header.txt \\\n  --data-binary @token-request.json \\\n  --output token-response.json';
}
function externalAgentInstructions(client,audience){
  const exchange=audience
    ?'兑换地址（同时是签名证明的 audience）：'+audience+'\n公钥登记完成后，用本机私钥签名，再通过任意 HTTP 客户端兑换。curl 请求示例：\n'+externalTokenRequest(audience)
    :'兑换地址尚未配置。请先让超级管理员在「外部执行端 → 设置兑换地址」保存以 /external/token 结尾的 HTTPS 地址，再从页面重新复制指令；不要猜测或编造 URL，配置完成前不要兑换。';
  return '请在我的个人电脑上完成 launchpad 公钥接入。客户端 ID：'+client.id+'；绑定仓库 ID：'+client.repository_id+'。\n\n'
    +'1. 可使用任意语言或工具，不需要 Node.js，也不要求下载项目脚本。详细接口规则和 OpenSSL＋curl 完整示例：https://github.com/agent-CI-Infra/bot/blob/main/docs/external-token-api.md（管理入口也可打开 '+new URL(externalTokenDocs,location.origin).href+'）。先检查密钥文件是否已存在，不要覆盖已有私钥；如果没有，在本机私有目录运行：\n'+externalKeyCommands+'\n只将 bot-client.pub.pem 的公钥内容交给我，由我在这个客户端的「登记公钥／更换公钥」中保存，并等待我确认。只接受 BEGIN PUBLIC KEY 的 SPKI PEM、2048–4096 位 RSA。bot-client.pem 私钥始终留在我的电脑，不要粘贴到 Bot、聊天或日志。\n\n'
    +'2. '+exchange+'\n签名证明是最长 120 秒的 RS256 JWT：header 为 {"alg":"RS256","typ":"JWT"}；payload 中 iss 和 sub 都为 '+client.id+'，aud 必须与上面的完整兑换地址一致，iat 为当前 Unix 秒，exp 大于 iat 且不超过 iat + 120，jti 为每次新生成的 16–128 位字母、数字、下划线或短横线。JWT 三段都用无填充 base64url 编码，对 header.payload 用 RSA-SHA256 签名。\n'
    +'在 umask 077 的私有目录中，将 Authorization: Bearer <签名JWT> 写入 proof-header.txt；将 '+JSON.stringify({client_id:client.id,request_id:'<与 jti 完全相同>'})+' 写入 token-request.json，再发送上面的 POST 请求。只发送签名证明，不上传私钥；不要开启 shell 跟踪或在聊天、日志、提交中显示私钥、签名证明或响应 token。请求不可重放，失败时先查看原因，确需重新兑换时生成新的 jti 和证明。安全地保留响应里的 grant_id、token 和 expires_at 供本次任务使用。\n\n'
    +'3. 成功响应里的 token 是该仓库的 GitHub App 安装令牌。以 Authorization: Bearer <token> 调用 GitHub，只操作绑定仓库。固定权限为 '+externalTokenPermissions+'，不能扩大权限，不能当 Contents write 使用；按 expires_at 到期。\n\n'
    +'4. 使用同一个 token，以 Authorization: Bearer <token> 调用 GET '+(audience?new URL('/external/events',audience).href:'与兑换地址同源的 /external/events')+' 轮询事件，不需要第二种令牌或管理登录，也不消耗每小时 20 次兑换额度。只返回绑定仓库最近 24 小时的 issues 和 pull_request 事件，每批最多 100 条，没有新事件时返回 {"events":[]}。每个客户端各自记住进度，换令牌不重置；服务端成功返回 200 并写出事件后旧事件不再返回，其他客户端不受影响。成功响应若在客户端丢失，服务端不补发；响应发出前失败不推进进度。未知、过期、已撤销令牌不能轮询。Webhook 转发仍然保留。\n\n'
    +'5. 完成任务后，对'+(audience?' '+new URL('/external/revoke',audience).href+' ':'与兑换地址同源的 /external/revoke ')+'发送 POST，Content-Type: application/json，正文为 {"grant_id":"<响应中的 grant_id>","token":"<响应中的 token>"}，撤销本次令牌。不要输出实际 token。';
}
function externalKeyHelp(){
  const help=element('details','','external-key-help');help.append(element('summary','如何在个人电脑生成公钥'));
  help.append(element('p','在个人电脑的私有目录执行；先检查文件是否存在，不要覆盖已有私钥。'),element('pre',externalKeyCommands),element('p','只粘贴 bot-client.pub.pem 中 BEGIN PUBLIC KEY 的 SPKI PEM 公钥，支持 2048–4096 位 RSA。bot-client.pem 私钥留在个人电脑，不要交给 Bot、聊天或日志。'));return help;
}
function externalPublicKeyGuide(clients=[],audience=externalAudience,{expanded=false}={}){
  const guide=element('details','','external-guide');guide.open=expanded;guide.append(element('summary','个人电脑接入：生成公钥、兑换与使用 token'));
  const body=element('div','','external-guide-body'),head=element('div','','heading'),status=element('p','','muted');status.setAttribute('role','status');
  const available=clients.filter(c=>c.auth_type==='private_key_jwt');
  head.append(element('strong','按以下步骤接入个人电脑'));
  if(available.length){
    const selection=externalField('guide_client','复制指令所用客户端',available[0].id,available.map(c=>[c.id,c.name+' · 仓库 '+c.repository_id]));
    const select=selection.querySelector('select'),fallback=element('textarea','');fallback.readOnly=true;fallback.hidden=true;fallback.rows=10;fallback.setAttribute('aria-label','可手动复制的接入指令');
    select.onchange=()=>{fallback.value='';fallback.hidden=true;status.textContent='';};
    head.append(button('复制给我的 AI agent',async()=>{
      const text=externalAgentInstructions(available.find(c=>c.id===select.value),audience);
      try{await navigator.clipboard.writeText(text);status.textContent='已复制接入指令';}catch{fallback.value=text;fallback.hidden=false;fallback.focus();fallback.select();status.textContent='剪贴板不可用，请手动复制下方完整指令。';}
    }));body.append(head,selection,status,fallback);
  }else body.append(head,element('p',expanded?'在本项目新增个人电脑客户端后，即可在这里选择并复制接入指令。':'先在项目设置 → 外部执行中新增个人电脑客户端，再回到这里选择客户端并复制接入指令。'));
  const steps=element('ol','');
  const keyStep=element('li','');keyStep.append(element('strong','在个人电脑生成公钥'),element('pre',externalKeyCommands),element('p','先检查文件是否已存在，不要覆盖已有私钥。仅将 bot-client.pub.pem 的公钥粘贴到 Bot；只接受 BEGIN PUBLIC KEY 的 SPKI PEM、2048–4096 位 RSA。bot-client.pem 私钥留在个人电脑，不要粘贴进 Bot、聊天或日志。'));
  const exchangeStep=element('li','');exchangeStep.append(element('strong','兑换自己的 GitHub token'),element('p','兑换地址以 /external/token 结尾，取自部署的公开入口：超级管理员可设置或覆写，未设置时使用接入向导已验证的公开地址；该完整地址就是签名证明的 audience。'));
  if(audience){exchangeStep.append(element('p','当前兑换地址：'+audience));exchangeStep.append(element('pre',externalTokenRequest(audience)));}
  else exchangeStep.append(element('p','兑换地址尚未配置：请超级管理员设置，或先在接入向导中验证公开地址，再重新打开说明。配置前无法兑换，不要猜测 URL。'));
  exchangeStep.append(element('p','可用任意语言或 HTTP 工具，不要求 Node.js 或项目脚本。用本机私钥签名 RS256 JWT，最长 120 秒：iss、sub 均为客户端 ID，aud 为完整兑换地址，iat 为当前 Unix 秒，exp ≤ iat + 120；每次生成唯一 jti（16–128 位字母、数字、下划线或短横线）。'),element('p','POST /external/token：Authorization: Bearer <签名JWT>，Content-Type: application/json。正文的 request_id 必须等于 jti；只发送证明，不上传私钥。'));
  exchangeStep.append(element('pre',JSON.stringify({client_id:'<所选客户端ID>',request_id:'<与 jti 完全相同>'},null,2)),element('p','curl 示例从私有文件读取请求头和正文（umask 077），响应保存到 token-response.json，不要输出到公共日志。成功的 token 是绑定仓库的 GitHub App 安装令牌。'));
  const docs=element('a','详细接口文档：OpenSSL 签名、curl 兑换与撤销');docs.href=externalTokenDocs;docs.target='_blank';docs.rel='noopener noreferrer';exchangeStep.append(docs);
  const pollStep=element('li','');pollStep.append(element('strong','用同一个 token 轮询事件'),element('p','GET '+(audience?new URL('/external/events',audience).href:'/external/events（与兑换地址同源）')+'，Authorization: Bearer <token>。不需要第二种令牌，不消耗每小时 20 次兑换额度。只返回绑定仓库最近 24 小时的 issues 和 pull_request，每批最多 100 条，没有新事件时返回空列表。'),element('p','每个客户端各自记住进度，换令牌不重置。成功返回 200 并写出这批事件后，旧事件不再返回；其他客户端不受影响。客户端丢失成功响应时服务端不补发；响应发出前失败不推进进度。过期、撤销或未知令牌不能轮询。Webhook 推送继续可用。'));
  const tokenStep=element('li','');tokenStep.append(element('strong','使用并撤销 token'),element('p','用 Authorization: Bearer <token> 调用 GitHub。权限固定为 '+externalTokenPermissions+'，只限客户端绑定仓库，不能扩大权限，不能当 Contents write。按响应 expires_at 到期，不要将 token 写入聊天、日志或提交。'),element('p','用完调用 POST '+(audience?new URL('/external/revoke',audience).href:'/external/revoke（与兑换地址同源）')+'，Content-Type: application/json，正文：'),element('pre','{"grant_id":"<响应中的 grant_id>","token":"<响应中的 token>"}'));
  steps.append(keyStep,exchangeStep,pollStep,tokenStep);body.append(steps);guide.append(body);return guide;
}
function externalField(name,caption,value='',choices=null){
  const label=element('label',caption),input=document.createElement(choices?'select':'input');input.name=name;
  if(choices)choices.forEach(([id,name])=>input.add(new Option(name,id)));input.value=value;input.required=true;label.append(input);return label;
}
function externalSecret(secret){$('external-secret').value=secret;$('external-secret').type='password';$('external-show').textContent='显示';$('external-copy-status').textContent='';credentialDialog.showModal();}
credentialDialog.addEventListener('close',()=>{if(credentialDialog.open)return;$('external-secret').value='';$('external-copy-status').textContent='';});
function clearExternalCredential(){ $('external-secret').value='';$('external-copy-status').textContent='';credentialDialog.close(); }
$('external-done').onclick=clearExternalCredential;$('external-show').onclick=()=>{const field=$('external-secret');field.type=field.type==='password'?'text':'password';$('external-show').textContent=field.type==='password'?'显示':'隐藏';};
$('external-copy').onclick=async()=>{const value=$('external-secret').value,live=()=>credentialDialog.open&&$('external-secret').value===value;try{await navigator.clipboard.writeText(value);if(live())$('external-copy-status').textContent='已复制';}catch{if(live())$('external-copy-status').textContent='请显示凭据后手动复制';}};
$('external-cancel').onclick=()=>externalDialog.close();externalDialog.addEventListener('close',()=>{if(externalDialog.open)return;$('external-form').reset();$('external-fields').replaceChildren();saveExternal=null;});
window.addEventListener('hashchange',()=>{externalDialog.close();clearExternalCredential();});
$('logout').addEventListener('click',()=>{externalDialog.close();clearExternalCredential();$('external-panel').replaceChildren();});
$('external-form').onsubmit=async event=>{
  event.preventDefault();const save=saveExternal,submit=event.currentTarget.querySelector('[type=submit]');if(!save||submit.disabled||!externalDialog.open)return;
  const version=externalEditorVersion,address=location.hash,actor=me?.id,project=projectRoute()?.id;
  const samePage=()=>location.hash===address&&me?.id===actor&&externalEditorVersion===version;
  const live=()=>samePage()&&externalDialog.open&&saveExternal===save;
  submit.disabled=true;$('external-error').textContent='正在提交；关闭不会撤回已发送的请求，结果请在原项目列表核对。';
  try{
    const result=await save(Object.fromEntries(new FormData(event.currentTarget)));if(!live())return;
    externalDialog.close();const redraw=route(),request=renderVersion;await redraw;
    // A one-time secret belongs only to the page that submitted it, including while its refresh is pending.
    if(samePage()&&request===renderVersion&&!externalDialog.open&&(!project||current?.id===project&&$('project-page').querySelector('.external-group'))&&result.signing_secret)externalSecret(result.signing_secret);
  }
  catch(err){
    if(live()&&[401,403].includes(err.status)){
      externalDialog.close();clearExternalCredential();if(project&&current?.id===project)current.external=null;
      $(project?'project-page':'external-panel').replaceChildren(consoleState('外部执行端暂不可访问','权限已变化，原记录和输入已清除。'+err.message,{tone:'error'}));
    }else if(live())$('external-error').textContent=({invalid_client_public_key:'请填写 2048–4096 位 RSA 公钥（BEGIN PUBLIC KEY），不要提交私钥。',invalid_token_audience:'请填写以 /external/token 结尾的 HTTPS 地址，不能带查询参数、用户名或密码。'})[err.message]||err.message;
  }
  finally{if(externalEditorVersion===version)submit.disabled=false;}
};
function editor(title,help,fields,save){externalEditorVersion++;$('external-title').textContent=title;$('external-help').textContent=help;$('external-fields').replaceChildren(...fields);$('external-error').textContent='';$('external-form').querySelector('[type=submit]').disabled=false;saveExternal=save;externalDialog.showModal();}
function addClient(repositoryId){
  if(!repositoryId){error(new Error('请先登记有权使用的 GitHub App 仓库'));return;}
  const name=externalField('name','客户端名称'),type=externalField('auth_type','身份认证','private_key_jwt',[['private_key_jwt','个人电脑 / 公钥签名'],['github_actions_oidc','GitHub Actions OIDC']]);
  const key=publicKeyField(),keyHelp=externalKeyHelp();
  const trust=element('fieldset','');trust.hidden=true;trust.append(element('legend','受信任工作流'));
  const entries=[['audience','Audience'],['subject','Subject'],['repository','工作流仓库 owner/repo'],['repository_id','工作流仓库 ID'],['owner_id','工作流组织 ID'],['workflow_ref','Workflow ref'],['ref','分支 ref']];
  for(const [key,caption]of entries){const field=externalField('trust_'+key,caption,key==='ref'?'refs/heads/main':'');field.querySelector('input').disabled=true;trust.append(field);}
  type.querySelector('select').onchange=event=>{trust.hidden=event.target.value!=='github_actions_oidc';trust.querySelectorAll('input').forEach(input=>input.disabled=trust.hidden);key.hidden=!trust.hidden;keyHelp.hidden=key.hidden;key.querySelector('textarea').disabled=key.hidden;$('external-help').textContent=trust.hidden?'在个人电脑生成密钥，只登记 RSA 公钥，私钥留在本机。授权限定为单仓库。':'GitHub Actions OIDC 使用受信任工作流身份，不登记个人电脑公钥。';};
  editor('新增客户端','在个人电脑生成密钥，只登记 RSA 公钥，私钥留在本机。授权限定为单仓库。',[name,type,keyHelp,key,trust],data=>{
    const body={name:data.name,auth_type:data.auth_type};if(data.auth_type==='github_actions_oidc')body.trust=Object.fromEntries(entries.map(([key])=>[key,data['trust_'+key]]));else body.public_key=publicKeyValue(data.public_key);return externalProjectApi(repositoryId,'/clients','POST',body);
  });
}
function publicKeyField(){const label=element('label','RSA 公钥（PEM）'),input=document.createElement('textarea');input.name='public_key';input.required=true;input.rows=7;input.spellcheck=false;input.placeholder='-----BEGIN PUBLIC KEY-----';label.append(input);return label;}
function publicKeyValue(value){if(!value.trim().startsWith('-----BEGIN PUBLIC KEY-----')||value.includes('PRIVATE KEY'))throw new Error('请只粘贴公钥（BEGIN PUBLIC KEY），私钥必须留在个人电脑。');return value;}
function registerPublicKey(client){editor(client.key_configured?'更换客户端公钥':'登记客户端公钥','只粘贴公钥，不能提交私钥。保存后旧公钥立即失效，尚未发出的转发取消，客户端 ID 和订阅保留；已签发的 GitHub 令牌需由执行端主动撤销或等待到期。',[publicKeyField()],data=>externalProjectApi(client.repository_id,'/clients/'+client.id,'PATCH',{public_key:publicKeyValue(data.public_key)}));}
function editSubscription(repositoryId,clients,row=null){
  if(!clients.length){error(new Error('请先新增客户端'));return;}
  const client=externalField('client_id','外部客户端',row?.client_id||clients[0].id,clients.map(c=>[c.id,c.name+' · 仓库 '+c.repository_id]));client.querySelector('select').disabled=!!row;
  const list=values=>String(values).split(',').map(v=>v.trim()).filter(Boolean);
  const fields=[client,externalField('name','订阅名称',row?.name||''),externalField('url','接收 URL',row?.url||'')];fields[2].querySelector('input').type='url';
  fields.push(externalField('events','事件类型（逗号分隔）',(row?.filters.events||['pull_request']).join(',')),externalField('actions','事件动作（留空表示全部）',(row?.filters.actions||['opened','ready_for_review','synchronize']).join(',')));fields.at(-1).querySelector('input').required=false;
  const draft=element('label',''),check=document.createElement('input');check.type='checkbox';check.name='exclude_drafts';check.checked=row?.filters.exclude_drafts??true;draft.className='external-check';draft.append(check,element('span','排除草稿 PR'));fields.push(draft);
  editor(row?'编辑转发订阅':'新增转发订阅','接收端须校验签名，并按转发 ID 去重；内网地址需部署管理员加入允许名单。',fields,data=>{
    const body={name:data.name,url:data.url,filters:{events:list(data.events),actions:list(data.actions),exclude_drafts:data.exclude_drafts==='on'}};
    if(row){return externalProjectApi(repositoryId,'/subscriptions/'+row.id,'PATCH',body);}body.client_id=data.client_id;return externalProjectApi(repositoryId,'/subscriptions','POST',body);
  });
}
function externalGroup(title,action){const group=element('section','','external-group'),head=element('div','','heading');head.append(element('h2',title));if(action)head.append(action);group.append(head);return group;}
function externalRow(name,detail,stateLabel,actions=[]){const row=element('div','','row'+(actions.length?' has-actions':'')),content=element('div','','row-content');content.append(element('strong',name),element('p',detail));row.append(content,element('span',stateLabel,'status'));if(actions.length){const group=element('div','','actions');group.append(...actions);row.append(group);}return row;}
const externalProjectApi=(repositoryId,path,method='GET',body)=>api('/api/repositories/'+repositoryId+'/external'+path,method,body);
// Deletes one client with its grants, subscriptions, event progress and pending forwards; the project itself stays.
async function deleteExternalClient(client){
  const address=location.hash,actor=me?.id;
  const deleted=await askConfirm({title:'删除外部客户端 '+client.name+'？',action:'删除',danger:true,
    body:['一并删除：',['临时授权记录','Webhook 转发订阅及其转发记录','事件轮询进度','尚未发出的转发'],'之后不能再用它兑换令牌或轮询事件，已兑换的 GitHub 令牌按原到期时间失效。项目本身不受影响。'],
    run:()=>externalProjectApi(client.repository_id,'/clients/'+client.id,'DELETE',{confirm:true})});
  if(!deleted||location.hash!==address||me?.id!==actor)return;
  const target=projectRoute();
  if(target?.id===client.repository_id&&target.section==='external'&&target.item===client.id)location.hash=`#/projects/${client.repository_id}/external`;
  else await route();
}
async function loadExternalProject(repositoryId){
  const [{clients},{subscriptions},{deliveries},{grants},{settings}]=await Promise.all([
    ...['clients','subscriptions','deliveries','grants'].map(type=>externalProjectApi(repositoryId,'/'+type)),api('/api/external/settings')]);
  return {clients,subscriptions,deliveries,grants,settings};
}
async function renderExternal(params,request){
  const [{clients},{settings}]=await Promise.all([api('/api/external/clients?'+params),api('/api/external/settings')]);
  if(request!==renderVersion)return;externalAudience=settings.token_audience||'';externalAudienceSource=settings.token_audience_source||null;
  $('count').textContent=clients.length+' 个客户端';const panel=$('external-panel');panel.replaceChildren();
  const endpoint=externalGroup('签名证明的兑换地址',me.role==='super_admin'?button('设置兑换地址',()=>editor('设置兑换地址','填写客户端实际访问的 HTTPS /external/token 地址，作为签名证明的固定 audience。',[externalField('token_audience','兑换地址',externalAudience)],data=>api('/api/external/settings','PUT',data))):null);
  endpoint.append(element('p',audienceCaption(),'muted'),externalPublicKeyGuide(clients));panel.append(endpoint);
  const projects=externalGroup('已配置外部客户端的项目');
  for(const id of [...new Set(clients.map(c=>c.repository_id))]){
    const repo=repositories.find(r=>r.id===id),open=element('a','配置项目外部执行','button-link');open.href='#/projects/'+id+'/external';
    projects.append(externalRow(repo?.full_name||'仓库 '+id,'客户端、公钥、Webhook 订阅和状态在项目内配置',clients.filter(c=>c.repository_id===id).length+' 个客户端',[open]));
  }
  if(!clients.length)projects.append(element('p','尚未配置外部客户端，请到项目设置 → 外部执行添加。','muted'));panel.append(projects);
  if(clients.length){
    const list=externalGroup('外部客户端');
    for(const c of clients)list.append(externalRow(c.name,`${repositories.find(r=>r.id===c.repository_id)?.full_name||'仓库 '+c.repository_id} · ${c.auth_type==='private_key_jwt'?'公钥签名':'GitHub Actions OIDC'} · ID ${c.id}`,c.enabled?'已启用':'已停用',[externalClientLink(c),...(me.role==='super_admin'?[button('删除',()=>deleteExternalClient(c),'quiet destructive')]:[])]));
    panel.append(list);
  }
}
function externalClientLink(client){
  const link=consoleLink(`#/projects/${client.repository_id}/external/${client.id}`,'查看详情');
  link.setAttribute('aria-label',`查看客户端 ${client.name} 的认证与活动详情`);return link;
}
function externalClientToggle(client){
  return button(client.enabled?'停用':'启用',async()=>{
    const address=location.hash,actor=me?.id,live=()=>location.hash===address&&me?.id===actor;
    if(client.enabled&&!await askConfirm({title:'停用客户端 '+client.name+'？',action:'停用',danger:true,
      body:['阻止新的令牌兑换，并取消此客户端尚未发出的转发。','已签发的 GitHub 令牌仍按原到期时间有效；执行端可以用原令牌调用撤销接口。客户端、公钥、订阅和已有记录保留。']}))return;
    if(!live())return;
    try{await externalProjectApi(client.repository_id,'/clients/'+client.id,'PATCH',{enabled:!client.enabled});if(live())await route();}catch(err){if(live())error(err);}
  });
}
function externalGrantGroup(grants){
  const group=externalGroup('最近临时授权（最多 100 条）');
  for(const g of grants)group.append(externalRow(g.id,`客户端 ${g.client_id} · 创建 ${timestamp(g.created_at)}${g.expires_at?' · 到期 '+timestamp(g.expires_at):''}`,({issuing:'签发中',issued:'已签发',failed:'失败',revoked:'已撤销'})[g.state]||g.state));
  if(!grants.length)group.append(element('p','暂无签发记录','muted'));return group;
}
function externalDeliveryGroup(repositoryId,deliveries,editable=true){
  const group=externalGroup('最近转发（最多 100 条）');
  for(const d of deliveries)group.append(externalRow(d.id,`创建 ${timestamp(d.created_at)} · 尝试 ${d.attempts} 次${d.http_status?' · HTTP '+d.http_status:''}${d.error?' · '+d.error:''}`,({pending:'待投递',sending:'投递中',retry:'等待重试',succeeded:'已送达',failed:'失败',cancelled:'已取消'})[d.state]||d.state,editable&&d.state==='failed'?[button('重试',async()=>{try{await externalProjectApi(repositoryId,'/deliveries/'+d.id+'/retry','POST',{});await route();}catch(e){error(e);}})]:[]));
  if(!deliveries.length)group.append(element('p','暂无转发记录','muted'));return group;
}
function externalClientDetail(client,data){
  const editable=current.canConfigure===true;
  const ownSubscriptions=data.subscriptions.filter(row=>row.client_id===client.id),ids=new Set(ownSubscriptions.map(row=>row.id));
  const deliveries=data.deliveries.filter(row=>ids.has(row.subscription_id)),grants=data.grants.filter(row=>row.client_id===client.id);
  // Grants use epoch milliseconds; deliveries use ISO strings. Normalize once before filtering or comparing either source.
  const activity=row=>({...row,activityTime:['number','string'].includes(typeof row.created_at)?new Date(row.created_at).getTime():NaN});
  const records=[...grants.map(row=>({...row,kind:'临时授权'})),...deliveries.map(row=>({...row,kind:'转发'}))].map(activity)
    .filter(row=>Number.isFinite(row.activityTime)).sort((a,b)=>b.activityTime-a.activityTime);
  const identity=externalGroup('客户端详情'),actions=element('div','','actions');identity.classList.add('external-client-identity');
  identity.append(element('h3',client.name),facts([['客户端 ID',client.id],['绑定项目',current.repository.full_name],['认证方式',client.auth_type==='private_key_jwt'?'个人电脑 · 公钥签名':'GitHub Actions OIDC'],
    ['认证状态',!client.enabled?'已停用':client.auth_type==='private_key_jwt'&&!client.key_configured?'待登记公钥':'已启用'],['客户端配置版本',client.version],['创建时间',timestamp(client.created_at)]]));
  if(editable)actions.append(externalClientToggle(client));
  if(client.auth_type==='private_key_jwt'){
    identity.append(facts([['公钥状态',client.key_configured?'已登记':'待登记'],['公钥指纹 SHA256',client.key_fingerprint||'未提供']]));
    if(client.public_key)identity.append(collapsible('已登记公钥（公开信息）',client.public_key));
    if(editable)actions.append(button(client.key_configured?'更换公钥':'登记公钥',()=>registerPublicKey(client)));
  }else{
    const captions={audience:'Audience',subject:'Subject',repository:'工作流仓库',repository_id:'不可变仓库 ID',owner_id:'组织 ID',workflow_ref:'Workflow ref',ref:'分支 ref'};
    identity.append(facts(Object.entries(captions).map(([key,caption])=>[caption,client.trust[key]||'未提供'])));
  }
  if(editable)actions.append(button('删除',()=>deleteExternalClient(client),'quiet destructive'));identity.append(actions);
  const capabilities=externalGroup('接入能力与运行记录');
  capabilities.append(facts([['协议能力','单仓库 GitHub 临时授权、事件轮询与 Webhook 转发'],['令牌权限',externalTokenPermissions],['Agent 与模型版本','未提供记录'],['运行隔离核验','未提供记录'],['项目转发订阅',ownSubscriptions.length]]),
    note('认证启用表示允许按当前身份规则请求授权。这里没有执行环境心跳、模型运行或隔离验证结果。'),
    note(records.length?`已读取范围内最新记录：${records[0].kind} · ${timestamp(records[0].created_at)}。`:'当前已读取记录中暂无活动，无法据此判断执行端在线状态。'),
    note('下方分别从当前项目最近最多 100 条授权和转发中筛选此客户端，不代表完整历史或最后一次实际执行。'));
  const grid=element('div','','external-client-detail');grid.append(identity,capabilities,externalGrantGroup(grants),externalDeliveryGroup(client.repository_id,deliveries,editable));return grid;
}
function externalSection(){
  const repositoryId=current.id,{clients,subscriptions,deliveries,grants,settings}=current.external,editable=current.canConfigure===true;
  const mutate=async(path,body)=>{const result=await externalProjectApi(repositoryId,path,'PATCH',body);await route();if(result.signing_secret)externalSecret(result.signing_secret);};
  const intro=externalGroup('当前项目的外部执行');
  intro.append(element('p','客户端只授权当前仓库，固定权限为 '+externalTokenPermissions+'。Webhook 推送和事件轮询可同时使用。','muted'),element('p','兑换地址：'+audienceCaption(settings.token_audience||'',settings.token_audience_source),'muted'),externalPublicKeyGuide(current.item?clients.filter(row=>row.id===current.item):clients,settings.token_audience||'',{expanded:!current.item}));
  if(!editable)intro.append(note('当前身份仅可查看本项目的外部执行记录；配置客户端、公钥和转发订阅或重试转发，需要联系具有项目配置权限的管理员。'));
  if(current.item){
    const client=clients.find(row=>row.id===current.item),back=consoleLink(`#/projects/${repositoryId}/external`,'返回客户端列表');
    return [intro,back,client?externalClientDetail(client,current.external):consoleState('找不到此外部客户端','客户端可能已删除，或不属于当前项目。请返回列表重新读取。',{tone:'error'})];
  }
  const group=externalGroup('客户端',...(editable?[button('新增客户端',()=>addClient(repositoryId))]:[]));
  for(const c of clients){const actions=[externalClientLink(c)];if(editable){actions.push(externalClientToggle(c));if(c.auth_type==='private_key_jwt')actions.push(button(c.key_configured?'更换公钥':'登记公钥',()=>registerPublicKey(c)));actions.push(button('删除',()=>deleteExternalClient(c),'quiet destructive'));}
    const pending=c.auth_type==='private_key_jwt'&&!c.key_configured,row=externalRow(c.name,`仓库 ${c.repository_id} · ${c.auth_type==='private_key_jwt'?'公钥签名':'GitHub Actions OIDC'} · ID ${c.id}`,pending?'待登记公钥':c.enabled?'已启用':'已停用',actions);
    if(c.key_fingerprint)row.querySelector('.row-content').append(element('p','公钥指纹 SHA256 '+c.key_fingerprint));
    if(pending)row.querySelector('.row-content').append(element('p','旧客户端凭据已停用，请在个人电脑生成密钥后登记公钥。'));group.append(row);
  }
  if(!clients.length)group.append(element('p','尚未配置外部客户端','muted'));
  const subs=externalGroup('Webhook 转发订阅',...(editable?[button('新增转发订阅',()=>editSubscription(repositoryId,clients))]:[]));
  for(const s of subscriptions)subs.append(externalRow(s.name,`${s.url} · ${s.filters.events.join(',')} / ${s.filters.actions.join(',')||'全部动作'}${s.filters.exclude_drafts?' · 排除草稿':''}`,s.enabled?'已启用':'已停用',editable?[
    button('编辑',()=>editSubscription(repositoryId,clients,s)),button(s.enabled?'停用':'启用',()=>mutate('/subscriptions/'+s.id,{enabled:!s.enabled}).catch(error))]:[]));
  if(!subscriptions.length)subs.append(element('p','尚未配置转发订阅','muted'));
  const records=externalDeliveryGroup(repositoryId,deliveries,editable),tokens=externalGrantGroup(grants);
  return [intro,group,subs,records,tokens];
}
