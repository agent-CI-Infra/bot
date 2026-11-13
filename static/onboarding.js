titles.onboarding='接入向导';
let onboardingStep=0;
// Null until step 1 is drawn, which then picks Cloudflare Tunnel when a tunnel token is saved; leaving step 1 resets it.
let onboardingTunnel=null;
const onboardingSteps=['公网 HTTPS','GitHub App','GitHub 登录','安装','模型','规则','完成'];
$('logout').addEventListener('click',()=>{$('onboarding-panel')?.replaceChildren();onboardingStep=0;onboardingTunnel=null;if(onboardingAddress.test(location.hash))history.replaceState(null,'','#/settings/onboarding/0');});
function wizardForm(title,fields,submit,save){
  const section=card(title),form=element('form','','project-form'),message=element('p','','view-error');message.setAttribute('role','alert');
  const action=element('button',submit);action.type='submit';form.append(...fields,message,action);section.append(form);
  form.onsubmit=async event=>{event.preventDefault();action.disabled=true;message.textContent='';try{if(await save(Object.fromEntries(new FormData(form)),form)!==false)await render();}catch(error){message.textContent=error.message;}finally{action.disabled=false;}};return section;
}
function wizardDetails(title,...nodes){
  const details=element('details','','fold');details.append(element('summary',title),...nodes);return details;
}
// The step lives in the address (#/settings/onboarding/<index>) so a reload stays on it. replaceState adds no history entry and
// fires no hashchange; the caller draws the step.
function wizardStep(step){history.replaceState(null,'','#/settings/onboarding/'+step);}
function wizardNext(step){wizardStep(step);void render().catch(error);}
// #/settings/onboarding/<0-6> names a step; #/settings/onboarding or an unknown step is the first. Without a wizard address (the tab
// button, the first login) the wizard stays on its current step.
function addressedStep(){
  if(!/^#\/settings\/onboarding(?:\/|$)/.test(location.hash))return onboardingStep;
  return Number(onboardingAddress.exec(location.hash)?.[1]||0);
}
// GitHub has no API that changes an App's permissions or event subscriptions. Global settings describe only the App definition.
// Names come from views.js.
function githubLinkElement(text,href){const link=element('a',text);link.href=href;link.target='_blank';link.rel='noopener';return link;}
function permissionReport(report){
  const rows=[],name=item=>permissionNames[item.permission]||item.permission,events=list=>list.map(event=>eventNames[event]||event).join('、');
  const appEvents=report.app.missing_events||[],features=report.app.feature_gaps||[],baseline=!report.app.missing.length&&!appEvents.length;
  const settings=()=>githubLinkElement('打开 App 的 Permissions & events',report.app.settings_url);
  if(baseline&&!features.length)return [element('p','App 权限和事件订阅齐全，覆盖全部功能。','view-success'),settings()];
  if(!baseline){
    const list=element('ul','');
    for(const item of report.app.missing)list.append(element('li',`${name(item)}：改为「${accessNames[item.required]}」（当前「${item.current?accessNames[item.current]||item.current:'No access'}」）`));
    if(appEvents.length)list.append(element('li',`Subscribe to events：勾选 ${events(appEvents)}（缺少时评论、检视或检视回复不会触发检视）`));
    rows.push(element('p','App 所有者打开 Permissions & events，把下列各项改好，然后点一次「Save changes」。'),list);
  }else rows.push(element('p','检视和开发所需的 App 权限和事件订阅齐全。','view-success'));
  // Only some features need these; they never fail the baseline check, but the project list flags them on every repository.
  if(features.length){
    const list=element('ul',''),used=gap=>gap.features.map(feature=>featureNames[feature]||feature).join('、');
    for(const gap of features)list.append(element('li',gap.kind==='permission'?`${permissionNames[gap.name]||gap.name}：改为「${accessNames[gap.required]}」（当前「${gap.current?accessNames[gap.current]||gap.current:'No access'}」），${used(gap)}需要`
      :`Subscribe to events：勾选 ${eventNames[gap.name]||gap.name}，${used(gap)}需要${eventPermissionNotes[gap.name]?`。${eventPermissionNotes[gap.name]}`:''}`));
    rows.push(element('p','下列各项只有部分功能需要，不影响检视和开发；要使用这些功能，在同一页改好并保存：'),list);
  }
  rows.push(settings(),element('p','改完后点「重新检查」。','muted'));return rows;
}
function appPermissionCheck(account){
  const box=element('div','','permission-check'),result=element('div','','permission-result');result.setAttribute('role','status');
  const check=button('检查权限和事件订阅',async()=>{
    check.disabled=true;result.replaceChildren(element('p','正在检查…','muted'));
    try{result.replaceChildren(...permissionReport(await api(`/api/accounts/${encodeURIComponent(account.id)}/permissions`)));check.textContent='重新检查';}
    catch(err){result.replaceChildren(element('p','检查失败：'+err.message,'view-error'));}
    finally{check.disabled=false;}
  });
  box.append(check,result);return box;
}
// The tunnel token field, also used by global settings: the server keeps only the token found in what is pasted.
function tunnelCredential(placeholder){
  const credential=input('token','',{type:'password',autocomplete:'new-password',maxLength:131072,placeholder});
  credential.addEventListener('paste',event=>{
    const pasted=event.clipboardData?.getData('text/plain');if(!pasted||!/[\r\n]/.test(pasted))return;
    // Password inputs strip newlines; preserve word boundaries when pasting multi-line instructions.
    event.preventDefault();const start=credential.selectionStart,end=credential.selectionEnd,room=credential.maxLength-credential.value.length+end-start;
    credential.setRangeText(pasted.replace(/\\\r?\n/g,'').replace(/[\r\n]+/g,' ').slice(0,Math.max(0,room)),start,end,'end');
  });
  return credential;
}
function accountInstallationForm(){
  const target=input('target','',{required:true,placeholder:'个人或组织名、账号链接、仓库链接或 SSH 克隆地址',autocomplete:'off'}),result=element('div','','installation-target-result');
  result.setAttribute('role','status');result.setAttribute('aria-live','polite');let version=0;
  target.addEventListener('input',()=>{version++;result.replaceChildren();target.closest('form').querySelector('[role=alert]').textContent='';});
  const section=wizardForm('指定安装账号',[field('安装账号',target),note('支持个人或组织名、owner/repo、GitHub 个人／组织／仓库／Issue／PR 链接和 SSH 克隆地址。自动识别账号类型，仓库范围由你在 GitHub 确认。')],'解析账号',async value=>{
    const request=++version;result.replaceChildren(element('p','正在向 GitHub 核对账号…','muted'));
    try{
      const resolved=await api('/api/onboarding/installation-target','POST',value);if(request!==version)return false;
      const account=resolved.account;result.replaceChildren(facts([['已识别账号',link(account.html_url,account.login)],['账号类型',account.type==='Organization'?'组织':'个人账号']]),
        note(resolved.installed?'此 App 已安装到该账号，可打开安装设置调整仓库范围。':'请前往此账号的 GitHub 安装页，选择仓库并确认授权。'),
        link(rewriteGithubAppInstallUrl(resolved.install_url),resolved.installed?'打开 '+account.login+' 安装设置':'前往 '+account.login+' 安装','button-link'));
    }catch(error){
      if(request!==version)return false;result.replaceChildren();
      const code=error.message.replace(/^\d+\s*·\s*/,'');
      throw new Error(({invalid_installation_target:'请填写个人或组织名，或有效的 github.com 账号／仓库链接。',installation_target_not_found:'未找到该 GitHub 账号，请检查名称或链接。',installation_target_not_installable:'仅支持 GitHub 组织或个人账号。',installation_target_lookup_failed:'无法读取 GitHub 账号或安装信息，请稍后重试，并检查 App 凭据与 GitHub 访问状态。',github_app_not_selected:'请先在第 2 步选择 GitHub App。',github_app_check_failed:'GitHub App 凭据校验失败，请检查已登记的 App。'})[code]||error.message);
    }
    return false;
  });
  const form=section.querySelector('form'),actions=element('div','','actions');actions.append(form.querySelector('[type=submit]'));form.append(actions,result);return section;
}
// Login has its own OAuth App; the repository App and its installation are configured in their own steps.
function githubLoginGuide(saved,controls){
  const steps=element('ol','','login-guide');
  const step=(title,...nodes)=>{const item=element('li','');item.append(element('strong',title),...nodes);steps.append(item);};
  step('创建独立 OAuth App',
    link('https://github.com/settings/applications/new','在 GitHub 创建 OAuth App'),
    note('个人 Settings → Developer settings → OAuth Apps → New OAuth App。也可以由组织在组织设置中登记 OAuth App。不要选择 GitHub Apps，也不要复制第 2 步仓库 App 的凭据。'),
    note('Application name 填容易辨认的名称，例如 Bot 登录；Homepage URL 填下面的 Bot 入口；Authorization callback URL 填下面的登录回调。'),
    facts([['Homepage URL',saved.origin||location.origin]]),element('code',saved.callback_url,'github-login-callback'),
    note('不需要启用 Device flow，也不需要安装到仓库。Bot 不申请额外 scope，只读取 GitHub 公开身份资料；仓库操作和权限核验由第 2 步的 GitHub App 完成。'));
  step('复制这个 OAuth App 的登录凭据',
    link('https://github.com/settings/developers','打开已有的 OAuth Apps'),
    note('登记后进入这个 OAuth App 的设置，复制 Client ID。它不是 App ID，也不是仓库 GitHub App 的 Client ID。'),controls.client,
    note(saved.secret_configured?'已加密保存此 OAuth App 的 Client secret；留空保留。更换 Client ID 时，必须同时填写新 App 的 secret。':'在这个 OAuth App 的 Client secrets 区域点「Generate a new client secret」，把生成的值填入下面。'),
    controls.secret,note('Client secret 只保存、不回显。请管理员本人填写，不要经聊天、Issue 或邮件转发。'));
  step('保存并启用登录',controls.enabled,
    note('保存前，当前生效的登录配置继续使用；保存并启用后切换为独立 OAuth App。用户下次登录会在 GitHub 确认身份授权。也可以暂不启用，继续安装仓库 App。'),controls.revoke);
  return steps;
}
function githubAddresses(saved,app){
  const origin=saved.origin||location.origin,row=(url,where)=>{const value=element('span','');value.append(element('code',url),element('span',where,'muted'));return value;};
  const list=facts([
    ['登录 Callback URL',row(saved.callback_url||origin+'/auth/github/callback','独立 OAuth App → Authorization callback URL')],
    ['安装 Setup URL',row(origin+'/onboarding/github/setup','仓库 GitHub App → Post installation → Setup URL；向导自动填写')],
    ['App 注册回调',row('/onboarding/github/callback','只在向导创建仓库 GitHub App 时使用一次，不填进 OAuth App')],
    ['Webhook URL',row(app?.webhook_url||origin+'/hooks/github/<account_id>/<endpoint_id>','仓库 GitHub App → Webhook URL；由向导写入')],
  ]);list.classList.add('login-addresses');return [note('两类 App 各有用途，下面的地址不能互相替代：'),list];
}
function githubLoginForm(saved,app){
  saved ||= {enabled:false,client_id:'',secret_configured:false,origin:location.origin,callback_url:location.origin+'/auth/github/callback'};
  const migration=saved.migration_required;
  const draft=migration?{...saved,client_id:'',secret_configured:false}:saved;
  const client=input('client_id',draft.client_id||'',{maxLength:200,autocomplete:'off'}),
    secret=input('client_secret','',{type:'password',autocomplete:'new-password',maxLength:32768,placeholder:draft.secret_configured?'已保存；留空保留原值':'粘贴独立 OAuth App 的 Client secret'}),
    enabled=checkbox('enabled',!!saved.enabled,'启用 GitHub 账号登录'),
    revoke=checkbox('revoke_secret',false,'清除登录 Client secret，并停用 GitHub 登录');
  const loginEnabled=enabled.querySelector('input');
  const requireClient=()=>{client.required=loginEnabled.checked;};loginEnabled.addEventListener('change',requireClient);requireClient();
  revoke.querySelector('input').addEventListener('change',e=>{if(e.target.checked)loginEnabled.checked=false;requireClient();});
  const notices=[];
  if(migration)notices.push(element('p','当前登录仍复用旧 GitHub App。请在本页创建独立 OAuth App 并填写新凭据；保存前旧登录继续可用。切换后原 GitHub 会话失效，已有账号在重新登录后保留绑定；请到 GitHub 的 Authorized GitHub Apps 撤销旧的个人授权，保留仓库 App 安装。','endpoint-warning'));
  if(saved.previous_callback_url)notices.push(element('p',`Callback URL 已随统一入口从 ${saved.previous_callback_url} 改为 ${saved.callback_url}。请在 OAuth App 中更新回调地址，再保存一次。`,'endpoint-warning'));
  if(saved.origin_source==='local')notices.push(element('p','还没有验证公网 HTTPS 地址，下面的 Callback URL 只适合在本机测试。完成第 1 步后它会改为公网地址。','endpoint-warning'));
  const guide=githubLoginGuide(draft,{client:field('Client ID',client),secret:field('Client secret（只保存，不回读）',secret),enabled,revoke});
  const section=wizardForm('独立 OAuth App 登录',[
    note('登录和仓库连接分别配置：OAuth App 只确认用户身份；GitHub App 安装负责仓库连接、组织和项目权限核验。更换仓库 App 不会更换登录配置。'),
    ...notices,guide,
    note('保存后立即生效，重启后保留。已有环境变量配置可继续使用；在这里保存后，以向导配置为准。'),
    note('首次 GitHub 登录会创建独立账号；已有本地账号应先登录后绑定。项目与组织管理员不会获得系统超级管理员权限。'),
  ],'保存登录配置',async(value,form)=>{
    const clear=form.elements.revoke_secret.checked;
    const payload={enabled:form.elements.enabled.checked&&!clear,client_id:value.client_id,client_secret:clear?'':value.client_secret,revoke_secret:clear};
    try{await api('/api/onboarding/github-login','PUT',payload);}catch(err){
      const code=err.message.replace(/^\d+\s*·\s*/,'');
      throw new Error(({github_client_id_required:'请填写独立 OAuth App 的 Client ID。',github_login_secret_required:'启用前需要保存这个 OAuth App 的 Client secret。',
        github_login_oauth_app_required:'这里需要 OAuth App 的凭据；请到 Developer settings → OAuth Apps 创建，不能使用仓库 GitHub App 的 Client ID。',
        github_login_https_required:'GitHub 登录需要 HTTPS 地址：先在第 1 步验证公网 HTTPS 地址；本机测试可从 127.0.0.1 或 localhost 打开。',
        invalid_admin_origin:'无法生成登录回调，请先验证公网 HTTPS 地址。',invalid_github_client_id:'Client ID 格式无效，请从 OAuth App 设置复制。'})[code]||err.message);
    }
    secret.value='';await start();notice('message',payload.enabled?'GitHub 登录已启用，用户可从登录页授权登录。':'已保存；当前使用本地账号登录。');return false;
  });
  section.append(wizardDetails('GitHub 地址及用途',...githubAddresses(saved,app)),
    githubLinkElement('GitHub 文档：创建 OAuth App','https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app'));
  return section;
}
function onboardingProgress(data){
  const ready=data.readiness||{},configured=ready.can_complete===true;
  return [
    {ready:!!ready.public_address,text:ready.public_address?'地址已验证':'需要验证公网地址'},
    {ready:!!ready.app,text:ready.app?'已选择仓库 App':'需要选择仓库 App'},
    {ready:true,text:data.github_login?.enabled?'GitHub 登录已启用':'本地账号可用，GitHub 登录可选'},
    {ready:!!ready.installation,text:ready.installation?`${ready.installation_count} 个有效安装`:data.installation_skipped?'已跳过，尚未完成接入':'需要安装并同步范围'},
    {ready:!!ready.model,text:ready.model?'默认模型已配置':'需要选择有效的共享模型'},
    {ready:true,text:'内置规则可用，可按项目覆盖'},
    {ready:!!configured,text:configured?'接入配置齐全':'仍有必需配置待补齐'},
  ];
}
async function renderOnboarding(request,panel,feedback=''){
  const rootPanel=panel,address=location.hash;
  const data=await api('/api/onboarding'),{models}=await api('/api/models');if(request!==renderVersion||location.hash!==address)return;
  const count=data.readiness?.installation_count,installations=Number.isSafeInteger(count)&&count>=0?count:null;
  const step=addressedStep();
  // Read every dependency before replacing the live panel, so conflict-recovery errors keep their controls attached.
  const installed=step===6?await api('/api/installations'):null;
  if(request!==renderVersion||location.hash!==address)return;
  if(step!==onboardingStep)onboardingTunnel=null;onboardingStep=step;
  const progress=onboardingProgress(data),intro=element('div','','onboarding-intro'),layout=element('div','','onboarding-layout'),content=element('div','','onboarding-content');
  intro.append(element('h2','接入向导'),note('配置会分别保存。可随时返回已完成步骤；浏览步骤不会自动启用项目或开始任务。'));
  panel.replaceChildren(intro,layout);$('count').textContent=`第 ${onboardingStep+1} / ${onboardingSteps.length} 步`;
  const nav=element('nav','','wizard-steps onboarding-progress');nav.setAttribute('aria-label','接入步骤');onboardingSteps.forEach((title,index)=>{const item=element('div','','onboarding-step'),b=button(`${index+1}. ${title}`,()=>wizardNext(index)),status=element('small',progress[index].text);item.dataset.ready=String(progress[index].ready);if(index===onboardingStep)b.setAttribute('aria-current','step');item.append(b,status);nav.append(item);});layout.append(nav,content);panel=content;
  if(data.installation_skipped||data.app&&installations===0)panel.append(element('p','尚未确认 App 安装。可以继续配置模型和规则；安装并启用项目之前，仓库检视不会开始。','wizard-notice'));
  const next=()=>panel.append(button('下一步',()=>wizardNext(Math.min(onboardingStep+1,6)),''));
  if(onboardingStep===0){
    panel.append(note('需要你拥有的公网域名。这个 HTTPS 地址是 Bot 唯一的入口：控制台、用户登录、GitHub App 回调和 Webhook 都经它到达本机业务端口 8791，不需要第二个域名或端口。检查会核对当前实例的一次性凭证，拒绝 HTTP、重定向、其他实例和私网地址。'));
    if(data.public_address)panel.append(facts([['已验证地址',data.public_address.origin],['检查时间',timestamp(data.public_address.checked_at)]]));
    onboardingTunnel??=data.tunnel.token_configured;
    const mode=card('选择连接方式'),choices=element('div','','actions');
    const choose=value=>{onboardingTunnel=value;$('wizard-proxy').hidden=value;$('wizard-tunnel').hidden=!value;mode.querySelector('p').textContent='已选：'+(value?'Cloudflare Tunnel':'自建 HTTPS 中转');for(const b of choices.children){const chosen=(b.textContent==='Cloudflare Tunnel')===value;b.setAttribute('aria-pressed',String(chosen));b.className=chosen?'':'quiet';}};
    const proxyChoice=button('自建 HTTPS 中转',()=>choose(false)),tunnelChoice=button('Cloudflare Tunnel',()=>choose(true));proxyChoice.setAttribute('aria-pressed',String(!onboardingTunnel));tunnelChoice.setAttribute('aria-pressed',String(onboardingTunnel));proxyChoice.className=onboardingTunnel?'quiet':'';tunnelChoice.className=onboardingTunnel?'':'quiet';choices.append(proxyChoice,tunnelChoice);mode.append(choices,note('已选：'+(onboardingTunnel?'Cloudflare Tunnel':'自建 HTTPS 中转')));panel.append(mode);
    const proxy=wizardForm('自建中转',[note('将专用域名整个反向代理到 http://本机:8791（不按路径拆分，保留原始 Host）。业务端口默认只绑定本机回环地址；反向代理在另一台机器时，在 .env 设置 BOT_BIND_ADDRESS=0.0.0.0，并只对代理开放这个端口。准备证书后在这里检查。'),field('公网 HTTPS 地址',input('origin',data.public_address?.origin||'',{type:'url',required:true,placeholder:'填写你自己的域名，不带路径'}))],'检查并使用',value=>api('/api/onboarding/address','POST',value));proxy.id='wizard-proxy';panel.append(proxy);
    proxy.hidden=onboardingTunnel;const tunnel=card('Cloudflare Tunnel');tunnel.id='wizard-tunnel';tunnel.hidden=!onboardingTunnel;
    tunnel.append(note('在 Cloudflare 中创建 tunnel 并配置自有域名，可以粘贴 token 或包含 token 的完整安装、运行命令。保存后由独立 Docker tunnel 服务连接，不需要把 token 写入 Compose。'),link('https://one.dash.cloudflare.com/','打开 Cloudflare → Networks → Tunnels'));
    const credential=tunnelCredential(data.tunnel.token_configured?'已保存；留空保持原值':'粘贴 tunnel token 或 Cloudflare 完整命令');
    tunnel.append(wizardForm('连接凭据',[field('Tunnel token 或完整命令（只保存 token，不回读）',credential)],'保存 token',value=>api('/api/onboarding/tunnel','POST',value)));
    tunnel.append(facts([['连接状态',data.tunnel.state],['Published application 的 Service URL',data.tunnel.origin]]),note('在 tunnel 的 Routes → Published application 配置自己的域名，Service URL 必须是 http://webhook:8791：Compose 里的入口网关把整个域名转发到 Bot 的业务端口；tunnel 不能直接连接 bot 或 manager。'));
    let fallback=false;
    for(const route of data.tunnel.routes){
      if(!route.hostname&&/^http_status:\d{3}$/.test(route.service)){fallback=true;continue;}
      const item=element('div','','row');item.append(element('p',route.hostname+' → '+route.service));if(route.webhook_route)item.append(button('检查并使用此域名',async()=>{try{await api('/api/onboarding/address','POST',{origin:'https://'+route.hostname});await render();}catch(e){error(e);}}));else item.append(badge('不是 Bot 入口路由','danger'));tunnel.append(item);
    }
    if(fallback)tunnel.append(note('没有匹配到已发布域名的请求会返回 404。这是 Cloudflare Tunnel 自带的兜底规则，不是连接故障。'));
    tunnel.append(button('刷新 tunnel 状态',()=>render().catch(error)));if(data.tunnel.token_configured)tunnel.append(button('停用 tunnel',async()=>{await api('/api/onboarding/tunnel','POST',{revoke:true});await render();}));panel.append(tunnel);next();
  }else if(onboardingStep===1){
    panel.append(note('这个 GitHub App 用于连接和操作仓库。组织 Members 只读权限和 organization 事件用于核验组织 owner 与及时失效权限；不申请成员写权限。用户登录在第 3 步单独登记 OAuth App，登录回调不填在这个仓库 App 中。'));
    if(data.app){
      const selected=card('当前仓库 GitHub App'),status=element('p','','muted');let app=data.app;
      const draw=()=>{selected.replaceChildren(element('h3','当前仓库 GitHub App'),note(`${app.slug} · App ID ${app.app_id}`));if(app.settings_url)selected.append(link(app.settings_url,'打开仓库 App 设置'),link(app.settings_url+'/permissions','打开 Permissions & events'));selected.append(refresh,status);};
      const refresh=button('刷新 App 信息',async()=>{refresh.disabled=true;try{app=(await api('/api/onboarding/app/refresh','POST',{account_id:app.account_id})).app;draw();status.textContent='App 设置入口已更新。';}catch{status.textContent='暂时无法读取 App 信息，请在本页重试。';}finally{refresh.disabled=false;}});draw();panel.append(selected);
      if(!app.settings_url)refresh.click();
    }
    panel.append(note('已有 App 不会随代码更新自动新增事件订阅；App 所有者仍需在 GitHub App 的 Permissions & events 中勾选 Issue comment、Pull request review、Pull request review comment 并保存，评论和检视回复才会触发再次检视。'));
    const existing=accounts.filter(a=>a.type==='github_app');if(existing.length){const list=card('使用已登记的 App');list.append(note('使用此 App 会将它的 webhook 更新为第 1 步验证过的地址；已有账号凭据保持不变。'));for(const account of existing){const row=element('div','','row'),info=element('div','','row-content');info.append(element('p',account.name+' · App ID '+account.app_id),appPermissionCheck(account));row.append(info,button('使用此 App',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:account.id,update_webhook:true});wizardNext(2);}catch(e){error(e);}}));list.append(row);}panel.append(list);}
    const section=wizardForm('创建新的 GitHub App',[note('不填写权限，不使用 PAT。这里生成 manifest；浏览器提交到 GitHub 后，你只需确认创建。已有 App 时优先使用上面的账号。'),field('App 所属组织',input('organization','',{required:true})),field('App 名称',input('name','',{required:true})),checkbox('public',false,'公开 App，允许安装到其他账号'),note('这是 App 的归属组织；实际安装目标在第 4 步选择。不勾选时是组织私有 App；需要安装到其他组织或个人账号时勾选。权限始终固定。')],'准备 GitHub 确认页',async value=>{
      const result=await api('/api/onboarding/manifest','POST',{...value,public:value.public==='on'}),form=element('form','');form.method='POST';form.action=result.create_url;form.target='_blank';
      const manifest=element('textarea','');manifest.name='manifest';manifest.value=JSON.stringify(result.manifest);manifest.hidden=true;form.append(manifest,element('p','固定权限：Contents／Issues／Pull requests／Commit statuses／Actions／Checks 写，Metadata 读；订阅 issues、pull_request、issue_comment、pull_request_review 和 pull_request_review_comment。'),element('p','权限核验另申请 Members 读权限并订阅 organization；用户登录使用第 3 步的独立 OAuth App。'),element('p','在 GitHub 确认后会回到本机向导。不要关闭本机服务。'));
      const submit=element('button','前往 GitHub 确认创建');submit.type='submit';form.append(submit);section.replaceChildren(element('h3','等待你在 GitHub 确认'),form);return false;
    });if(!data.public_address)section.append(note('先在第 1 步验证公网 HTTPS 地址，才能准备 manifest。'));panel.append(section);if(data.app)next();
  }else if(onboardingStep===2){
    panel.append(githubLoginForm(data.github_login, data.app));next();
  }else if(onboardingStep===3){
    const install=card('安装到目标账号');if(data.app){install.append(facts([['App',data.app.slug],['App ID',data.app.app_id],['当前有效安装数',installations===null?'未知（状态未提供）':String(installations)]]),note('统计来自当前安装记录，暂停、卸载或范围尚未同步的安装不计入。'),link(rewriteGithubAppInstallUrl(data.app.install_url,data.app.slug),'在 GitHub 选择账号','button-link'),button('重新检查安装',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:data.app.account_id});await api('/api/installations/sync','POST',{});if(typeof forgetConsoleGaps==='function')forgetConsoleGaps();await start();}catch(e){error(e);}}));}else install.append(note('尚未选择 App。可以返回第 2 步使用已登记的账号，或准备 manifest 后由你在 GitHub 确认。'));
    install.append(button('暂时跳过安装',async()=>{await api('/api/onboarding/installation','POST',{skip:true});wizardNext(4);}));panel.append(install);if(data.app)panel.append(accountInstallationForm(),note('安装到其他组织或个人账号要求 App 为公开，且你拥有相应安装权限；最终由 GitHub 校验。安装完成后点「重新检查安装」，再到第 7 步同步并启动仓库。'));next();
  }else if(onboardingStep===4){
    const shared=models.filter(model=>!model.repository_id&&model.key_configured),list=card('使用已配置的模型');for(const model of shared){const row=element('div','','row');row.append(modelAddress(model),button('选用此模型',async()=>{await api('/api/onboarding/model','POST',{model_id:model.id});wizardNext(5);}));list.append(row);}if(shared.length)panel.append(list);
    // The same model fields as a project's add-model form: resolved addresses, upstream list and test (project.js).
    panel.append(wizardForm('添加模型',[note('保存的接口视为可信，可接收启用项目的代码、日志和测试材料。Key 加密保存，不明文回读。'),...modelFields(null)],'保存并继续',async value=>{const result=await api('/api/models','POST',{...value,repository_id:null});await api('/api/onboarding/model','POST',{model_id:result.model.id});wizardStep(5);}));next();
  }else if(onboardingStep===5){
    panel.append(note('四个内置 skill 覆盖标签、Issue 检视、PR 检视和明确要求改代码时的开发。优先级：内置默认 → 项目控制台 → 默认分支仓库文件。PR 修改行为文件时必须由人决定，不能自动合并。'));
    for(const [path,content]of Object.entries(data.defaults))panel.append(collapsible(path+' · 内置默认',content));
    panel.append(note('仓库还可提供 .agents/skills/**/SKILL.md。项目「模型」页配置项目默认模型和各工作类型的模型；「Manager 与角色」页编辑 Manager 提示词（检视、开发、标签和行为指南几章就是 .bot 规则文件的控制台层）、各工作类型的开关和写入、交给 Manager 的事件，并查看规则文件来源；computer.yaml 接到现有机器配置，不另建资源系统。'));next();
  }else{
    const summary=card('接入状态');summary.append(facts([['公网地址',data.public_address?.origin||'待验证'],['App',data.app?.slug||'待选择'],['安装',progress[3].text],['GitHub 登录',data.github_login?.enabled?'已启用':'使用本地账号'],['默认模型',progress[4].ready?models.find(m=>m.id===data.model_id)?.model_name||'已配置':'待配置'],['Agent','Pi 1.4.0 · 每仓库长期容器 · 模型请求经控制面代理']]));panel.append(summary);
    const missing=progress.slice(0,6).map((item,index)=>({...item,index})).filter(item=>!item.ready);
    if(missing.length){const gaps=card('接入尚未完成');gaps.append(note('以下必需配置仍待补齐。可以继续查看或返回项目，当前状态不会标记为已完成。'));for(const item of missing)gaps.append(button(`前往第 ${item.index+1} 步：${onboardingSteps[item.index]}`,()=>wizardNext(item.index)));panel.append(gaps);}
    const projects=card('选择项目开始检视'),sync=button('同步已安装仓库',async()=>{sync.disabled=true;sync.textContent='正在同步安装范围…';try{const result=await api('/api/installations/sync','POST',{});if(result.results.some(r=>r.error))throw new Error('安装同步失败：'+result.results.filter(r=>r.error).map(r=>r.error).join('，'));if(typeof forgetConsoleGaps==='function')forgetConsoleGaps();await render();}catch(e){error(e);}finally{sync.disabled=false;sync.textContent='同步已安装仓库';}});projects.append(sync);
    for(const repo of installed.repositories){
      const row=element('div','','row');row.append(element('p',repo.full_name),...installedBadges(repo));
      if(repo.registered)row.append(button('打开项目设置',()=>openProject(repo.id)));
      if(!repo.registered||!repo.enabled||!repo.review_enabled){
        const activate=button(!repo.registered?'启动并启用检视':!repo.enabled?'重新启用检视':'启用检视',async()=>{activate.disabled=true;try{if(!data.model_id)throw new Error('请先在第 5 步选用模型');await api('/api/installations/'+repo.id+'/activate','POST',{model_id:data.model_id,development_enabled:false});await start();}catch(e){error(e);activate.disabled=false;}});
        activate.disabled=!data.public_address||!data.app?.installations||data.installation_skipped||repo.installed===false;row.append(activate);
      }
      projects.append(row);
    }
    projects.append(note('这里包括已安装但尚未启动的仓库。未看到新仓时点击同步。自动开发默认关闭，在对应项目的「开发」中单独开启；尚未安装时不开始检视。'));
    const actions=element('div','','actions'),message=element('p','','view-error');message.setAttribute('role','alert');
    message.textContent=feedback;
    const current=()=>request===renderVersion&&location.hash===address&&rootPanel.isConnected;
    let refreshing=false;
    const refreshReadiness=async()=>{
      if(!current()||refreshing)return;refreshing=true;finish.disabled=true;message.textContent='接入配置已变化，正在重新读取状态…';
      try{await renderOnboarding(request,rootPanel,'接入配置已变化，已重新读取状态，请补齐缺项。');}
      catch(err){if(current()){
        for(const item of nav.children){item.dataset.ready='unknown';item.querySelector('small').textContent='状态待重新核验';}
        summary.replaceChildren(element('h3','接入状态待重新核验'),note('配置已变化，目前无法确认最新状态。请重新读取后继续。'));
        message.textContent='接入配置已变化，状态读取失败：'+err.message+'。请重新读取后继续。';
        let retry=actions.querySelector('[data-readiness-retry]');
        if(!retry){retry=button('重新读取接入状态',async()=>{retry.disabled=true;await refreshReadiness();});retry.dataset.readinessRetry='';actions.append(retry);}retry.disabled=false;
      }}finally{refreshing=false;}
    };
    const finish=button('完成向导',async()=>{
      if(finish.disabled)return;finish.disabled=true;message.textContent='';
      try{await api('/api/onboarding/complete','POST',{});if(!current())return;history.replaceState(null,'','#/projects');await start();}
      catch(err){if(!current())return;if(err.message.includes('onboarding_incomplete'))await refreshReadiness();else{message.textContent=err.message;finish.disabled=false;}}
    },'');
    finish.disabled=missing.length>0;actions.append(finish,consoleLink('#/projects','返回项目，稍后继续'));panel.append(projects,actions,message);
  }
  nav.querySelector('[aria-current=step]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
