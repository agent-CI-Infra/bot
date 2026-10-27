titles.onboarding='接入向导';
let onboardingStep=0;
let onboardingTunnel=false;
const onboardingSteps=['公网 HTTPS','GitHub App','安装','模型','规则','完成'];
$('logout').addEventListener('click',()=>{$('onboarding-panel').replaceChildren();onboardingStep=0;onboardingTunnel=false;});
function wizardForm(title,fields,submit,save){
  const section=card(title),form=element('form','','project-form'),message=element('p','','view-error');message.setAttribute('role','alert');
  const action=element('button',submit);action.type='submit';form.append(...fields,message,action);section.append(form);
  form.onsubmit=async event=>{event.preventDefault();action.disabled=true;message.textContent='';try{if(await save(Object.fromEntries(new FormData(form)),form)!==false)await render();}catch(error){message.textContent=error.message;}finally{action.disabled=false;}};return section;
}
function wizardNext(step){onboardingStep=step;void render().catch(error);}
// GitHub has no API that changes an App's permissions. The check lists what is missing in GitHub's own wording and links
// the App's permission page (one save) and each installation's review page (one acceptance each). Names come from views.js.
function githubLinkElement(text,href){const link=element('a',text);link.href=href;link.target='_blank';link.rel='noopener';return link;}
function permissionReport(report){
  if(report.ok)return [element('p',report.installations.length?`权限齐全：App 和 ${report.installations.length} 个安装都已具备所需权限。`:'App 权限齐全，还没有安装。','view-success')];
  const rows=[],name=item=>permissionNames[item.permission]||item.permission;
  if(report.app.missing.length){
    const list=element('ul','');
    for(const item of report.app.missing)list.append(element('li',`${name(item)}：改为「${accessNames[item.required]}」（当前「${item.current?accessNames[item.current]||item.current:'No access'}」）`));
    rows.push(element('p','第 1 步：App 所有者打开 Permissions & events，把下列各项改好，然后点一次「Save changes」。'),list,githubLinkElement('打开 App 的 Permissions & events',report.app.settings_url));
  }
  const pending=report.installations.filter(item=>!item.suspended&&item.missing.length);
  if(pending.length){
    const list=element('ul','');
    for(const item of pending){const row=element('li',`${item.account||'安装 '+item.id}：${item.missing.map(name).join('、')} `);if(item.review_url)row.append(githubLinkElement('前往接受',item.review_url));list.append(row);}
    rows.push(element('p',(report.app.missing.length?'第 2 步：':'')+'App 保存后，GitHub 会向下列安装发出权限请求，需要该账号的管理员打开链接接受。'),list);
  }
  rows.push(element('p','改完后点「重新检查」。','muted'));return rows;
}
function appPermissionCheck(account){
  const box=element('div','','permission-check'),result=element('div','','permission-result');result.setAttribute('role','status');
  const check=button('检查权限',async()=>{
    check.disabled=true;result.replaceChildren(element('p','正在检查…','muted'));
    try{result.replaceChildren(...permissionReport(await api(`/api/accounts/${encodeURIComponent(account.id)}/permissions`)));check.textContent='重新检查';}
    catch(err){result.replaceChildren(element('p','检查失败：'+err.message,'view-error'));}
    finally{check.disabled=false;}
  });
  box.append(check,result);return box;
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
async function renderOnboarding(request){
  const data=await api('/api/onboarding'),{models}=await api('/api/models');if(request!==renderVersion)return;
  const panel=$('onboarding-panel');panel.replaceChildren();$('count').textContent=`第 ${onboardingStep+1} / ${onboardingSteps.length} 步`;
  const nav=element('nav','','wizard-steps');nav.setAttribute('aria-label','接入步骤');onboardingSteps.forEach((title,index)=>{const b=button(`${index+1}. ${title}`,()=>wizardNext(index));if(index===onboardingStep)b.setAttribute('aria-current','step');nav.append(b);});panel.append(nav);
  if(data.installation_skipped||data.app&&!data.app.installations)panel.append(element('p','尚未确认 App 安装。可以继续配置模型和规则；安装并启用项目之前，仓库检视不会开始。','wizard-notice'));
  const next=()=>panel.append(button('下一步',()=>wizardNext(Math.min(onboardingStep+1,5)),''));
  if(onboardingStep===0){
    panel.append(note('需要你拥有的公网域名。HTTPS 地址只连接 webhook 8791，管理端口 8792 保持本机或独立管理入口；检查会拒绝管理页面和其他实例。'));
    if(data.public_address)panel.append(facts([['已验证地址',data.public_address.origin],['检查时间',timestamp(data.public_address.checked_at)]]));
    const mode=card('选择连接方式'),choices=element('div','','actions');
    const choose=value=>{onboardingTunnel=value;$('wizard-proxy').hidden=value;$('wizard-tunnel').hidden=!value;mode.querySelector('p').textContent='已选：'+(value?'Cloudflare Tunnel':'自建 HTTPS 中转');for(const b of choices.children){const chosen=(b.textContent==='Cloudflare Tunnel')===value;b.setAttribute('aria-pressed',String(chosen));b.className=chosen?'':'quiet';}};
    const proxyChoice=button('自建 HTTPS 中转',()=>choose(false)),tunnelChoice=button('Cloudflare Tunnel',()=>choose(true));proxyChoice.setAttribute('aria-pressed',String(!onboardingTunnel));tunnelChoice.setAttribute('aria-pressed',String(onboardingTunnel));proxyChoice.className=onboardingTunnel?'quiet':'';tunnelChoice.className=onboardingTunnel?'':'quiet';choices.append(proxyChoice,tunnelChoice);mode.append(choices,note('已选：'+(onboardingTunnel?'Cloudflare Tunnel':'自建 HTTPS 中转')));panel.append(mode);
    const proxy=wizardForm('自建中转',[note('将专用域名反向代理到 http://本机:8791，整个域名只转发 webhook，不要转发管理页面。准备证书后在这里检查。'),field('公网 HTTPS 地址',input('origin',data.public_address?.origin||'',{type:'url',required:true,placeholder:'填写你自己的域名，不带路径'}))],'检查并使用',value=>api('/api/onboarding/address','POST',value));proxy.id='wizard-proxy';panel.append(proxy);
    proxy.hidden=onboardingTunnel;const tunnel=card('Cloudflare Tunnel');tunnel.id='wizard-tunnel';tunnel.hidden=!onboardingTunnel;
    tunnel.append(note('在 Cloudflare 中创建 tunnel 并配置自有域名，可以粘贴 token 或包含 token 的完整安装、运行命令。保存后由独立 Docker tunnel 服务连接，不需要把 token 写入 Compose。'),link('https://one.dash.cloudflare.com/','打开 Cloudflare → Networks → Tunnels'));
    const credential=input('token','',{type:'password',autocomplete:'new-password',maxLength:131072,placeholder:data.tunnel.token_configured?'已保存；留空保持原值':'粘贴 tunnel token 或 Cloudflare 完整命令'});
    credential.addEventListener('paste',event=>{
      const pasted=event.clipboardData?.getData('text/plain');if(!pasted||!/[\r\n]/.test(pasted))return;
      // Password inputs strip newlines; preserve word boundaries when pasting multi-line instructions.
      event.preventDefault();const start=credential.selectionStart,end=credential.selectionEnd,room=credential.maxLength-credential.value.length+end-start;
      credential.setRangeText(pasted.replace(/\\\r?\n/g,'').replace(/[\r\n]+/g,' ').slice(0,Math.max(0,room)),start,end,'end');
    });
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
    const existing=accounts.filter(a=>a.type==='github_app');if(existing.length){const list=card('使用已登记的 App');list.append(note('使用此 App 会将它的 webhook 更新为第 1 步验证过的地址；已有账号凭据保持不变。'));for(const account of existing){const row=element('div','','row'),info=element('div','','row-content');info.append(element('p',account.name+' · App ID '+account.app_id),appPermissionCheck(account));row.append(info,button('使用此 App',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:account.id,update_webhook:true});wizardNext(2);}catch(e){error(e);}}));list.append(row);}panel.append(list);}
    const section=wizardForm('创建新的 GitHub App',[note('不填写权限，不使用 PAT。这里生成 manifest；浏览器提交到 GitHub 后，你只需确认创建。已有 App 时优先使用上面的账号。'),field('App 所属组织',input('organization','',{required:true})),field('App 名称',input('name','',{required:true})),checkbox('public',false,'公开 App，允许安装到其他账号'),note('这是 App 的归属组织；实际安装目标在第 3 步选择。不勾选时是组织私有 App；需要安装到其他组织或个人账号时勾选。权限始终固定。')],'准备 GitHub 确认页',async value=>{
      const result=await api('/api/onboarding/manifest','POST',{...value,public:value.public==='on'}),form=element('form','');form.method='POST';form.action=result.create_url;form.target='_blank';
      const manifest=element('textarea','');manifest.name='manifest';manifest.value=JSON.stringify(result.manifest);manifest.hidden=true;form.append(manifest,element('p','固定权限：Contents／Issues／Pull requests／Commit statuses／Actions／Checks 写，Metadata 读；只订阅 issues 和 pull_request。'),element('p','在 GitHub 确认后会回到本机向导。不要关闭本机服务。'));
      const submit=element('button','前往 GitHub 确认创建');submit.type='submit';form.append(submit);section.replaceChildren(element('h3','等待你在 GitHub 确认'),form);return false;
    });if(!data.public_address)section.append(note('先在第 1 步验证公网 HTTPS 地址，才能准备 manifest。'));panel.append(section);if(data.app)next();
  }else if(onboardingStep===2){
    const install=card('安装到目标账号');if(data.app){install.append(facts([['App',data.app.slug],['App ID',data.app.app_id],['已确认安装数',data.app.installations||0]]),link(data.app.install_url,'在 GitHub 选择账号','button-link'),button('重新检查安装',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:data.app.account_id});await api('/api/installations/sync','POST',{});await start();}catch(e){error(e);}}));}else install.append(note('尚未选择 App。可以返回第 2 步使用已登记的账号，或准备 manifest 后由你在 GitHub 确认。'));
    install.append(button('暂时跳过安装',async()=>{await api('/api/onboarding/installation','POST',{skip:true});wizardNext(3);}));panel.append(install);if(data.app)panel.append(accountInstallationForm(),note('安装到其他组织或个人账号要求 App 为公开，且你拥有相应安装权限；最终由 GitHub 校验。安装完成后点「重新检查安装」，再到第 6 步同步并启动仓库。'));next();
  }else if(onboardingStep===3){
    const shared=models.filter(model=>!model.repository_id&&model.key_configured),list=card('使用已配置的模型');for(const model of shared){const row=element('div','','row');row.append(element('p',model.model_name+' · '+model.api_url),button('选用此模型',async()=>{await api('/api/onboarding/model','POST',{model_id:model.id});wizardNext(4);}));list.append(row);}if(shared.length)panel.append(list);
    panel.append(wizardForm('添加模型',[note('保存的接口视为可信，可接收启用项目的代码、日志和测试材料。Key 加密保存，不明文回读。'),field('接口 URL',input('api_url','',{type:'url',required:true})),field('API Key',input('api_key','',{type:'password',required:true,autocomplete:'new-password'})),field('模型名',input('model_name','',{required:true}))],'保存并继续',async value=>{const result=await api('/api/models','POST',{...value,repository_id:null});await api('/api/onboarding/model','POST',{model_id:result.model.id});onboardingStep=4;}));next();
  }else if(onboardingStep===4){
    panel.append(note('四个内置 skill 覆盖标签、Issue 检视、PR 检视和明确要求改代码时的开发。优先级：内置默认 → 项目控制台 → 默认分支仓库文件。PR 修改行为文件时必须由人决定，不能自动合并。'));
    for(const [path,content]of Object.entries(data.defaults))panel.append(collapsible(path+' · 内置默认',content));
    panel.append(note('仓库还可提供 .agents/skills/**/SKILL.md。项目 → 规则总览 列出每份文件的作用、路径和覆盖情况；检视和开发规则在项目的「检视」「开发」里编辑；computer.yaml 接到现有机器配置，不另建资源系统。'));next();
  }else{
    const summary=card('接入状态');summary.append(facts([['公网地址',data.public_address?.origin||'待验证'],['App',data.app?.slug||'待选择'],['安装',data.installation_skipped?'已跳过':data.app?.installations?'已确认':'待安装'],['默认模型',models.find(m=>m.id===data.model_id)?.model_name||'待配置'],['Agent','Pi 1.4.0 · 每仓库长期容器 · 模型请求经控制面代理']]));panel.append(summary);
    const projects=card('选择项目开始检视'),sync=button('同步已安装仓库',async()=>{sync.disabled=true;sync.textContent='正在同步安装范围…';try{const result=await api('/api/installations/sync','POST',{});if(result.results.some(r=>r.error))throw new Error('安装同步失败：'+result.results.filter(r=>r.error).map(r=>r.error).join('，'));await render();}catch(e){error(e);}finally{sync.disabled=false;sync.textContent='同步已安装仓库';}});projects.append(sync);
    const installed=await api('/api/installations');if(request!==renderVersion)return;
    for(const repo of installed.repositories){
      const row=element('div','','row');row.append(element('p',repo.full_name),...installedBadges(repo));
      if(repo.registered)row.append(button('打开项目设置',()=>openProject(repo.id)));
      if(!repo.registered||!repo.enabled||!repo.review_enabled){
        const activate=button(!repo.registered?'启动并启用检视':!repo.enabled?'重新启用检视':'启用检视',async()=>{activate.disabled=true;try{if(!data.model_id)throw new Error('请先在第 4 步选用模型');await api('/api/installations/'+repo.id+'/activate','POST',{model_id:data.model_id,development_enabled:false});await start();}catch(e){error(e);activate.disabled=false;}});
        activate.disabled=!data.public_address||!data.app?.installations||data.installation_skipped||repo.installed===false;row.append(activate);
      }
      projects.append(row);
    }
    projects.append(note('这里包括已安装但尚未启动的仓库。未看到新仓时点击同步。自动开发默认关闭，在对应项目的「开发」中单独开启；尚未安装时不开始检视。'));panel.append(projects,button('完成向导',async()=>{await api('/api/onboarding/complete','POST',{});tab='projects';history.replaceState(null,'',location.pathname);await start();},''));
  }
  nav.querySelector('[aria-current=step]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
