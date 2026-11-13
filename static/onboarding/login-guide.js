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
