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
