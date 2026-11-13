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
