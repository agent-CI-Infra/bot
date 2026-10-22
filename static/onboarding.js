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
async function renderOnboarding(request){
  const data=await api('/api/onboarding'),{models}=await api('/api/models');if(request!==renderVersion)return;
  const panel=$('onboarding-panel');panel.replaceChildren();$('count').textContent=`第 ${onboardingStep+1} / ${onboardingSteps.length} 步`;
  const nav=element('nav','','wizard-steps');nav.setAttribute('aria-label','接入步骤');onboardingSteps.forEach((title,index)=>{const b=button(`${index+1}. ${title}`,()=>wizardNext(index));if(index===onboardingStep)b.setAttribute('aria-current','step');nav.append(b);});panel.append(nav);
  if(data.installation_skipped||data.app&&!data.app.installations)panel.append(element('p','尚未确认 App 安装。可以继续配置模型和规则；安装并启用项目之前，仓库检视不会开始。','wizard-notice'));
  const next=()=>panel.append(button('下一步',()=>wizardNext(Math.min(onboardingStep+1,5)),''));
  if(onboardingStep===0){
    panel.append(note('需要你拥有的公网域名。HTTPS 地址只连接 webhook 8791，管理端口 8792 保持本机或独立管理入口；检查会拒绝管理页面和其他实例。'));
    if(data.public_address)panel.append(facts([['已验证地址',data.public_address.origin],['检查时间',timestamp(data.public_address.checked_at)]]));
    const mode=card('选择连接方式'),choices=element('div','','actions');choices.append(button('自建 HTTPS 中转',()=>{onboardingTunnel=false;$('wizard-proxy').hidden=false;$('wizard-tunnel').hidden=true;}),button('Cloudflare Tunnel',()=>{onboardingTunnel=true;$('wizard-proxy').hidden=true;$('wizard-tunnel').hidden=false;}));mode.append(choices);panel.append(mode);
    const proxy=wizardForm('自建中转',[note('将专用域名反向代理到 http://本机:8791，整个域名只转发 webhook，不要转发管理页面。准备证书后在这里检查。'),field('公网 HTTPS 地址',input('origin',data.public_address?.origin||'',{type:'url',required:true,placeholder:'填写你自己的域名，不带路径'}))],'检查并使用',value=>api('/api/onboarding/address','POST',value));proxy.id='wizard-proxy';panel.append(proxy);
    proxy.hidden=onboardingTunnel;const tunnel=card('Cloudflare Tunnel');tunnel.id='wizard-tunnel';tunnel.hidden=!onboardingTunnel;
    tunnel.append(note('在 Cloudflare 中创建 tunnel 并配置自有域名，粘贴 token 后由独立 Docker tunnel 服务连接，不需要把 token 写入 Compose。'),link('https://one.dash.cloudflare.com/','打开 Cloudflare → Networks → Tunnels'));
    tunnel.append(wizardForm('连接凭据',[field('Tunnel token（只保存，不回读）',input('token','',{type:'password',autocomplete:'new-password',placeholder:data.tunnel.token_configured?'已保存；留空保持原值':'粘贴 tunnel token'}))],'保存 token',value=>api('/api/onboarding/tunnel','POST',value)));
    tunnel.append(facts([['连接状态',data.tunnel.state],['Published application 的 Service URL',data.tunnel.origin]]),note('在 tunnel 的 Routes → Published application 配置自己的域名，Service URL 必须是 http://webhook:8791。不要填管理端口 8792。'));
    for(const route of data.tunnel.routes){const item=element('div','','row');item.append(element('p',route.hostname+' → '+route.service));if(route.webhook_route)item.append(button('检查并使用此域名',async()=>{try{await api('/api/onboarding/address','POST',{origin:'https://'+route.hostname});await render();}catch(e){error(e);}}));else item.append(badge('不是 webhook 路由','danger'));tunnel.append(item);}
    tunnel.append(button('刷新 tunnel 状态',()=>render().catch(error)));if(data.tunnel.token_configured)tunnel.append(button('停用 tunnel',async()=>{await api('/api/onboarding/tunnel','POST',{revoke:true});await render();}));panel.append(tunnel);next();
  }else if(onboardingStep===1){
    const existing=accounts.filter(a=>a.type==='github_app');if(existing.length){const list=card('使用已登记的 App');list.append(note('使用此 App 会将它的 webhook 更新为第 1 步验证过的地址；已有账号凭据保持不变。'));for(const account of existing){const row=element('div','','row');row.append(element('p',account.name+' · App ID '+account.app_id),button('使用此 App',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:account.id,update_webhook:true});wizardNext(2);}catch(e){error(e);}}));list.append(row);}panel.append(list);}
    const section=wizardForm('创建新的 GitHub App',[note('不填写权限，不使用 PAT。这里生成 manifest；浏览器提交到 GitHub 后，你只需确认创建。已有 App 时优先使用上面的账号。'),field('目标组织',input('organization','',{required:true})),field('App 名称',input('name','',{required:true})),checkbox('public',false,'公开 App，允许安装到其他组织'),note('不勾选时是组织私有 App；需要一个 App 覆盖多个组织时勾选。权限始终固定。')],'准备 GitHub 确认页',async value=>{
      const result=await api('/api/onboarding/manifest','POST',{...value,public:value.public==='on'}),form=element('form','');form.method='POST';form.action=result.create_url;form.target='_blank';
      const manifest=element('textarea','');manifest.name='manifest';manifest.value=JSON.stringify(result.manifest);manifest.hidden=true;form.append(manifest,element('p','固定权限：Contents／Issues／Pull requests 写，Metadata 读；只订阅 issues 和 pull_request。'),element('p','在 GitHub 确认后会回到本机向导。不要关闭本机服务。'));
      const submit=element('button','前往 GitHub 确认创建');submit.type='submit';form.append(submit);section.replaceChildren(element('h3','等待你在 GitHub 确认'),form);return false;
    });if(!data.public_address)section.append(note('先在第 1 步验证公网 HTTPS 地址，才能准备 manifest。'));panel.append(section);if(data.app)next();
  }else if(onboardingStep===2){
    const install=card('安装到目标组织');if(data.app){install.append(facts([['App',data.app.slug],['App ID',data.app.app_id],['已确认安装数',data.app.installations||0]]),link(data.app.install_url,'在 GitHub 安装此 App','button-link'),button('重新检查安装',async()=>{try{await api('/api/onboarding/use-app','POST',{account_id:data.app.account_id});await api('/api/installations/sync','POST',{});await start();}catch(e){error(e);}}));}else install.append(note('尚未选择 App。可以返回第 2 步使用已登记的账号，或准备 manifest 后由你在 GitHub 确认。'));
    install.append(button('暂时跳过安装',async()=>{await api('/api/onboarding/installation','POST',{skip:true});wizardNext(3);}));panel.append(install);next();
  }else if(onboardingStep===3){
    const shared=models.filter(model=>!model.repository_id&&model.key_configured),list=card('使用已配置的模型');for(const model of shared){const row=element('div','','row');row.append(element('p',model.model_name+' · '+model.api_url),button('选用此模型',async()=>{await api('/api/onboarding/model','POST',{model_id:model.id});wizardNext(4);}));list.append(row);}if(shared.length)panel.append(list);
    panel.append(wizardForm('添加模型',[note('保存的接口视为可信，可接收启用项目的代码、日志和测试材料。Key 加密保存，不明文回读。'),field('接口 URL',input('api_url','',{type:'url',required:true})),field('API Key',input('api_key','',{type:'password',required:true,autocomplete:'new-password'})),field('模型名',input('model_name','',{required:true}))],'保存并继续',async value=>{const result=await api('/api/models','POST',{...value,repository_id:null});await api('/api/onboarding/model','POST',{model_id:result.model.id});onboardingStep=4;}));next();
  }else if(onboardingStep===4){
    panel.append(note('四个内置 skill 覆盖标签、Issue 检视、PR 检视和明确要求改代码时的开发。优先级：内置默认 → 项目控制台 → 默认分支仓库文件。PR 修改行为文件时必须由人决定，不能自动合并。'));
    for(const [path,content]of Object.entries(data.defaults))panel.append(collapsible(path+' · 内置默认',content));
    panel.append(note('仓库还可提供 .agents/skills/**/SKILL.md。项目 → 生效规则 可查看每份文件的来源、覆盖层和最终内容；computer.yaml 接到现有机器配置，不另建资源系统。'));next();
  }else{
    const summary=card('接入状态');summary.append(facts([['公网地址',data.public_address?.origin||'待验证'],['App',data.app?.slug||'待选择'],['安装',data.installation_skipped?'已跳过':data.app?.installations?'已确认':'待安装'],['默认模型',models.find(m=>m.id===data.model_id)?.model_name||'待配置'],['Agent','Pi 1.4.0 · 每仓库长期容器 · 模型请求经控制面代理']]));panel.append(summary);
    const projects=card('选择项目开始检视');for(const repo of repositories){const row=element('div','','row');row.append(element('p',repo.full_name),button('打开项目设置',()=>openProject(repo.id)),button('启用此项目检视',async()=>{try{if(!data.model_id)throw new Error('请先在第 4 步选用模型');await api('/api/repositories/'+repo.id+'/policy','PATCH',{model_id:data.model_id,enabled:true,review_enabled:true,development_enabled:false});openProject(repo.id,'review');}catch(e){error(e);}}));row.querySelector('button:last-child').disabled=!data.public_address||!data.app?.installations||data.installation_skipped;projects.append(row);}projects.append(note('自动开发默认关闭。需要时在对应项目的开发设置中单独开启。尚未安装时不开始检视。'));panel.append(projects,button('完成向导',async()=>{await api('/api/onboarding/complete','POST',{});tab='projects';history.replaceState(null,'',location.pathname);await start();},''));
  }
  nav.querySelector('[aria-current=step]')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
