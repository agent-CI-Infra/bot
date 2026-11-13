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
