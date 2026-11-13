function githubAddresses(saved,app){
  const origin=saved.origin||location.origin,row=(url,where)=>{const value=element('span','');value.append(element('code',url),element('span',where,'muted'));return value;};
  const list=facts([
    ['登录 Callback URL',row(saved.callback_url||origin+'/auth/github/callback','独立 OAuth App → Authorization callback URL')],
    ['安装 Setup URL',row(origin+'/onboarding/github/setup','仓库 GitHub App → Post installation → Setup URL；向导自动填写')],
    ['App 注册回调',row('/onboarding/github/callback','只在向导创建仓库 GitHub App 时使用一次，不填进 OAuth App')],
    ['Webhook URL',row(app?.webhook_url||origin+'/hooks/github/<account_id>/<endpoint_id>','仓库 GitHub App → Webhook URL；由向导写入')],
  ]);list.classList.add('login-addresses');return [note('两类 App 各有用途，下面的地址不能互相替代：'),list];
}
