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
      :`Subscribe to events：勾选 ${eventNames[gap.name]||gap.name}，${used(gap)}需要`));
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
        link(resolved.install_url,resolved.installed?'打开 '+account.login+' 安装设置':'前往 '+account.login+' 安装','button-link'));
    }catch(error){
      if(request!==version)return false;result.replaceChildren();
      const code=error.message.replace(/^\d+\s*·\s*/,'');
      throw new Error(({invalid_installation_target:'请填写个人或组织名，或有效的 github.com 账号／仓库链接。',installation_target_not_found:'未找到该 GitHub 账号，请检查名称或链接。',installation_target_not_installable:'仅支持 GitHub 组织或个人账号。',installation_target_lookup_failed:'无法读取 GitHub 账号或安装信息，请稍后重试，并检查 App 凭据与 GitHub 访问状态。',github_app_not_selected:'请先在第 2 步选择 GitHub App。',github_app_check_failed:'GitHub App 凭据校验失败，请检查已登记的 App。'})[code]||error.message);
    }
    return false;
  });
  const form=section.querySelector('form'),actions=element('div','','actions');actions.append(form.querySelector('[type=submit]'));form.append(actions,result);return section;
}
function githubLoginForm(saved, app){
  saved ||= {enabled:false,client_id:'',admin_origin:location.origin,secret_configured:false};
  const client=input('client_id',saved.client_id||'',{maxLength:200,autocomplete:'off'}),
    secret=input('client_secret','',{type:'password',autocomplete:'new-password',maxLength:32768,placeholder:saved.secret_configured?'已保存；留空保留原值':'粘贴 GitHub App 的 Client secret'}),
    origin=input('admin_origin',saved.admin_origin||location.origin,{type:'url',required:true,placeholder:'浏览器访问控制台的 HTTPS 地址，不带路径'}),
    enabled=checkbox('enabled',!!saved.enabled,'启用 GitHub 账号登录'),
    revoke=checkbox('revoke_secret',false,'清除已保存的 Client secret，并停用 GitHub 登录'),
    callback=element('code','','github-login-callback');
  const preview=()=>{try{callback.textContent=new URL(origin.value).origin+'/auth/github/callback';}catch{callback.textContent='请先填写控制台地址';}};
  origin.addEventListener('input',preview);preview();
  revoke.querySelector('input').addEventListener('change',e=>{if(e.target.checked)enabled.querySelector('input').checked=false;});
  const section=wizardForm('GitHub 账号登录',[
    note(app?`使用当前 App：${app.slug}（App ID ${app.app_id}）。Client ID 是该 App 的另一个字段。`:'可先配置用户登录；项目管理能力仍需有效的 App 安装和授权。'),
    note('保存后立即生效，重启后保留。已有环境变量配置可继续使用；在这里保存后，以向导配置为准。'),
    enabled,field('Client ID',client),field('Client secret（只保存，不回读）',secret),
    note(saved.secret_configured?'已保存登录凭据，留空可保留；新建 App 的返回凭据可以直接复用。':'在现有 GitHub App 的设置中获取 Client ID，并生成 Client secret。用户不需要自己创建 App。'),
    field('控制台访问地址',origin),
    note('多人使用时准备独立的 HTTPS 管理域名，反向代理到管理服务 8792；Webhook 域名继续连接 8791。本机可用 http://127.0.0.1:8792。证书和反向代理由部署方配置；修改访问地址后，请从新地址重新登录。'),
    element('p','把下面的用户授权 Callback URL 加到同一个 GitHub App，保留已有 Setup URL：'),callback,
    note('组织 owner 识别需要 Members 只读权限；新增权限须由安装目标批准。登录按钮会发起 OAuth，安装时自动请求授权可保持关闭。'),
    note('首次 GitHub 登录会创建独立账号；已有本地账号应先登录后绑定。项目与组织管理员不会获得系统超级管理员权限。'),revoke,
  ],'保存登录配置',async (value,form)=>{
    const clear=form.elements.revoke_secret.checked;
    const payload={enabled:form.elements.enabled.checked&&!clear,client_id:value.client_id,client_secret:clear?'':value.client_secret,
      admin_origin:value.admin_origin,revoke_secret:clear};
    try{await api('/api/onboarding/github-login','PUT',payload);}catch(err){
      const code=err.message.replace(/^\d+\s*·\s*/,'');
      throw new Error(({github_client_id_required:'请填写同一个 GitHub App 的 Client ID。',github_login_secret_required:'启用前需要保存 Client secret。',
        github_login_https_required:'控制台地址需要 HTTPS；本机测试可使用 localhost 或 127.0.0.1。',invalid_admin_origin:'请填写完整的控制台 origin，不含路径、查询或账号密码。',
        invalid_github_client_id:'Client ID 格式无效，请从 GitHub App 设置复制。'})[code]||err.message);
    }
    secret.value='';await start();notice('message',payload.enabled?'GitHub 登录已启用，用户可从登录页授权登录。':'已保存；当前使用本地账号登录。');return false;
  });
  section.append(githubLinkElement('查看 GitHub App 用户授权配置说明','https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app'));
  return section;
}
async function renderOnboarding(request,panel){
  const data=await api('/api/onboarding'),{models}=await api('/api/models');if(request!==renderVersion)return;
  const step=addressedStep();if(step!==onboardingStep)onboardingTunnel=null;onboardingStep=step;
  panel.replaceChildren(element('h2','接入向导'));$('count').textContent=`第 ${onboardingStep+1} / ${onboardingSteps.length} 步`;
  const nav=element('nav','','wizard-steps');nav.setAttribute('aria-label','接入步骤');onboardingSteps.forEach((title,index)=>{const b=button(`${index+1}. ${title}`,()=>wizardNext(index));if(index===onboardingStep)b.setAttribute('aria-current','step');nav.append(b);});panel.append(nav);
  if(data.installation_skipped||data.app&&!data.app.installations)panel.append(element('p','尚未确认 App 安装。可以继续配置模型和规则；安装并启用项目之前，仓库检视不会开始。','wizard-notice'));
  const next=()=>panel.append(button('下一步',()=>wizardNext(Math.min(onboardingStep+1,6)),''));
  if(onboardingStep===0){
    panel.append(note('需要你拥有的公网域名。HTTPS 地址只连接 webhook 8791，管理端口 8792 保持本机或独立管理入口；检查会拒绝管理页面和其他实例。'));
    if(data.public_address)panel.append(facts([['已验证地址',data.public_address.origin],['检查时间',timestamp(data.public_address.checked_at)]]));
    onboardingTunnel??=data.tunnel.token_configured;
    const mode=card('选择连接方式'),choices=element('div','','actions');
    const choose=value=>{onboardingTunnel=value;$('wizard-proxy').hidden=value;$('wizard-tunnel').hidden=!value;mode.querySelector('p').textContent='已选：'+(value?'Cloudflare Tunnel':'自建 HTTPS 中转');for(const b of choices.children){const chosen=(b.textContent==='Cloudflare Tunnel')===value;b.setAttribute('aria-pressed',String(chosen));b.className=chosen?'':'quiet';}};
    const proxyChoice=button('自建 HTTPS 中转',()=>choose(false)),tunnelChoice=button('Cloudflare Tunnel',()=>choose(true));proxyChoice.setAttribute('aria-pressed',String(!onboardingTunnel));tunnelChoice.setAttribute('aria-pressed',String(onboardingTunnel));proxyChoice.className=onboardingTunnel?'quiet':'';tunnelChoice.className=onboardingTunnel?'':'quiet';choices.append(proxyChoice,tunnelChoice);mode.append(choices,note('已选：'+(onboardingTunnel?'Cloudflare Tunnel':'自建 HTTPS 中转')));panel.append(mode);
    const proxy=wizardForm('自建中转',[note('将专用域名反向代理到 http://本机:8791，整个域名只转发 webhook，不要转发管理页面。准备证书后在这里检查。'),field('公网 HTTPS 地址',input('origin',data.public_address?.origin||'',{type:'url',required:true,placeholder:'填写你自己的域名，不带路径'}))],'检查并使用',value=>api('/api/onboarding/address','POST',value));proxy.id='wizard-proxy';panel.append(proxy);
    proxy.hidden=onboardingTunnel;const tunnel=card('Cloudflare Tunnel');tunnel.id='wizard-tunnel';tunnel.hidden=!onboardingTunnel;
    tunnel.append(note('在 Cloudflare 中创建 tunnel 并配置自有域名，可以粘贴 token 或包含 token 的完整安装、运行命令。保存后由独立 Docker tunnel 服务连接，不需要把 token 写入 Compose。'),link('https://one.dash.cloudflare.com/','打开 Cloudflare → Networks → Tunnels'));
    const credential=tunnelCredential(data.tunnel.token_configured?'已保存；留空保持原值':'粘贴 tunnel token 或 Cloudflare 完整命令');
    tunnel.append(wizardForm('连接凭据',[field('Tunnel token 或完整命令（只保存 token，不回读）',credential)],'保存 token',value=>api('/api/onboarding/tunnel','POST',value)));
    tunnel.append(facts([['连接状态',data.tunnel.state],['Published application 的 Service URL',data.tunnel.origin]]),note('在 tunnel 的 Routes → Published application 配置自己的域名，Service URL 必须是 http://webhook:8791。不要填管理端口 8792。'));
    let fallback=false;
    for(const route of data.tunnel.routes){
      if(!route.hostname&&/^http_status:\d{3}$/.test(route.service)){fallback=true;continue;}
      const item=element('div','','row');item.append(element('p',route.hostname+' → '+route.service));if(route.webhook_route)item.append(button('检查并使用此域名',async()=>{try{await api('/api/onboarding/address','POST',{origin:'https://'+route.hostname});await render();}catch(e){error(e);}}));else item.append(badge('不是 webhook 路由','danger'));tunnel.append(item);
    }
    if(fallback)tunnel.append(note('没有匹配到已发布域名的请求会返回 404。这是 Cloudflare Tunnel 自带的兜底规则，不是连接故障。'));
    tunnel.append(button('刷新 tunnel 状态',()=>render().catch(error)));if(data.tunnel.token_configured)tunnel.append(button('停用 tunnel',async()=>{await api('/api/onboarding/tunnel','POST',{revoke:true});await render();}));panel.append(tunnel);next();
  }else if(onboardingStep===1){
    panel.append(note('GitHub 登录另需组织 Members 只读权限和 organization 事件订阅，用于验证 owner 与及时失效权限；不申请成员写权限。用户登录回调为 /auth/github/callback，与安装和注册回调分开。'));
    panel.append(note('已有 App 不会随代码更新自动新增事件订阅；App 所有者仍需在 GitHub App 的 Permissions & events 中勾选 Issue comment、Pull request review、Pull request review comment 并保存，评论和检视回复才会触发再次检视。'));
    const existing=accounts.filter(a=>a.type==='github_app');if(existing.length){const list=card('使用已登记的 App');list.append(note('使用此 App 会将它的 webhook 更新为第 1 步验证过的地址；已有账号凭据保持不变。'));for(const account of existing){const row=element('div','','row'),info=element('div','','row-content');info.append(element('p',account.name+' · App ID '+account.app_id),appPermissionCheck(account));row.append(info,button('使用此 App',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:account.id,update_webhook:true});wizardNext(2);}catch(e){error(e);}}));list.append(row);}panel.append(list);}
    const section=wizardForm('创建新的 GitHub App',[note('不填写权限，不使用 PAT。这里生成 manifest；浏览器提交到 GitHub 后，你只需确认创建。已有 App 时优先使用上面的账号。'),field('App 所属组织',input('organization','',{required:true})),field('App 名称',input('name','',{required:true})),checkbox('public',false,'公开 App，允许安装到其他账号'),note('这是 App 的归属组织；实际安装目标在第 4 步选择。不勾选时是组织私有 App；需要安装到其他组织或个人账号时勾选。权限始终固定。')],'准备 GitHub 确认页',async value=>{
      const result=await api('/api/onboarding/manifest','POST',{...value,public:value.public==='on'}),form=element('form','');form.method='POST';form.action=result.create_url;form.target='_blank';
      const manifest=element('textarea','');manifest.name='manifest';manifest.value=JSON.stringify(result.manifest);manifest.hidden=true;form.append(manifest,element('p','固定权限：Contents／Issues／Pull requests／Commit statuses／Actions／Checks 写，Metadata 读；订阅 issues、pull_request、issue_comment、pull_request_review 和 pull_request_review_comment。'),element('p','身份验证另申请 Members 读权限并订阅 organization；用户登录回调为 /auth/github/callback。'),element('p','在 GitHub 确认后会回到本机向导。不要关闭本机服务。'));
      const submit=element('button','前往 GitHub 确认创建');submit.type='submit';form.append(submit);section.replaceChildren(element('h3','等待你在 GitHub 确认'),form);return false;
    });if(!data.public_address)section.append(note('先在第 1 步验证公网 HTTPS 地址，才能准备 manifest。'));panel.append(section);if(data.app)next();
  }else if(onboardingStep===2){
    panel.append(githubLoginForm(data.github_login, data.app));next();
  }else if(onboardingStep===3){
    const install=card('安装到目标账号');if(data.app){install.append(facts([['App',data.app.slug],['App ID',data.app.app_id],['已确认安装数',data.app.installations||0]]),link(data.app.install_url,'在 GitHub 选择账号','button-link'),button('重新检查安装',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:data.app.account_id});await api('/api/installations/sync','POST',{});await start();}catch(e){error(e);}}));}else install.append(note('尚未选择 App。可以返回第 2 步使用已登记的账号，或准备 manifest 后由你在 GitHub 确认。'));
    install.append(button('暂时跳过安装',async()=>{await api('/api/onboarding/installation','POST',{skip:true});wizardNext(4);}));panel.append(install);if(data.app)panel.append(accountInstallationForm(),note('安装到其他组织或个人账号要求 App 为公开，且你拥有相应安装权限；最终由 GitHub 校验。安装完成后点「重新检查安装」，再到第 7 步同步并启动仓库。'));next();
  }else if(onboardingStep===4){
    const shared=models.filter(model=>!model.repository_id&&model.key_configured),list=card('使用已配置的模型');for(const model of shared){const row=element('div','','row');row.append(modelAddress(model),button('选用此模型',async()=>{await api('/api/onboarding/model','POST',{model_id:model.id});wizardNext(5);}));list.append(row);}if(shared.length)panel.append(list);
    // The same model fields as a project's add-model form: resolved addresses, upstream list and test (project.js).
    panel.append(wizardForm('添加模型',[note('保存的接口视为可信，可接收启用项目的代码、日志和测试材料。Key 加密保存，不明文回读。'),...modelFields(null)],'保存并继续',async value=>{const result=await api('/api/models','POST',{...value,repository_id:null});await api('/api/onboarding/model','POST',{model_id:result.model.id});wizardStep(5);}));next();
  }else if(onboardingStep===5){
    panel.append(note('四个内置 skill 覆盖标签、Issue 检视、PR 检视和明确要求改代码时的开发。优先级：内置默认 → 项目控制台 → 默认分支仓库文件。PR 修改行为文件时必须由人决定，不能自动合并。'));
    for(const [path,content]of Object.entries(data.defaults))panel.append(collapsible(path+' · 内置默认',content));
    panel.append(note('仓库还可提供 .agents/skills/**/SKILL.md。项目「模型」页配置项目默认模型和各工作流的模型；「工作流」页列出每条工作流的触发源、流程、提示词来源和模型，在页内编辑提示词（含流程图）、权限和触发源，通用准则位于表格上方；computer.yaml 接到现有机器配置，不另建资源系统。'));next();
  }else{
    const summary=card('接入状态');summary.append(facts([['公网地址',data.public_address?.origin||'待验证'],['App',data.app?.slug||'待选择'],['安装',data.installation_skipped?'已跳过':data.app?.installations?'已确认':'待安装'],['GitHub 登录',data.github_login?.enabled?'已启用':'使用本地账号'],['默认模型',models.find(m=>m.id===data.model_id)?.model_name||'待配置'],['Agent','Pi 1.4.0 · 每仓库长期容器 · 模型请求经控制面代理']]));panel.append(summary);
    const projects=card('选择项目开始检视'),sync=button('同步已安装仓库',async()=>{sync.disabled=true;sync.textContent='正在同步安装范围…';try{const result=await api('/api/installations/sync','POST',{});if(result.results.some(r=>r.error))throw new Error('安装同步失败：'+result.results.filter(r=>r.error).map(r=>r.error).join('，'));await render();}catch(e){error(e);}finally{sync.disabled=false;sync.textContent='同步已安装仓库';}});projects.append(sync);
    const installed=await api('/api/installations');if(request!==renderVersion)return;
    for(const repo of installed.repositories){
      const row=element('div','','row');row.append(element('p',repo.full_name),...installedBadges(repo));
      if(repo.registered)row.append(button('打开项目设置',()=>openProject(repo.id)));
      if(!repo.registered||!repo.enabled||!repo.review_enabled){
        const activate=button(!repo.registered?'启动并启用检视':!repo.enabled?'重新启用检视':'启用检视',async()=>{activate.disabled=true;try{if(!data.model_id)throw new Error('请先在第 5 步选用模型');await api('/api/installations/'+repo.id+'/activate','POST',{model_id:data.model_id,development_enabled:false});await start();}catch(e){error(e);activate.disabled=false;}});
        activate.disabled=!data.public_address||!data.app?.installations||data.installation_skipped||repo.installed===false;row.append(activate);
      }
      projects.append(row);
    }
    projects.append(note('这里包括已安装但尚未启动的仓库。未看到新仓时点击同步。自动开发默认关闭，在对应项目的「开发」中单独开启；尚未安装时不开始检视。'));panel.append(projects,button('完成向导',async()=>{await api('/api/onboarding/complete','POST',{});history.replaceState(null,'','#/projects');await start();},''));
  }
  nav.querySelector('[aria-current=step]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
