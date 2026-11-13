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
