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
