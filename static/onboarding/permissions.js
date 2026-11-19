// GitHub has no API that changes an App's permissions or event subscriptions. Global settings describe only the App definition.
// Names come from views.js (GitHub's own spelling for permissions, events and access levels).
// #527: the widget's own words come from static/i18n.js (permissions.*), so the same component reads English or Chinese on
// the account row, in the setup wizard and on the two installation pages. A key the dictionary does not know falls back to
// the catalog the project list uses, so a new feature or event keeps its word instead of showing a raw key.
function githubLinkElement(text,href){const link=element('a',text);link.href=href;link.target='_blank';link.rel='noopener';return link;}
function translatedOr(key,fallback){const text=t(key);return text===key?fallback:text;}
function permissionReport(report){
  const rows=[],name=item=>permissionNames[item.permission]||item.permission,
    joined=list=>list.join(t('permissions.list_separator')),
    events=list=>joined(list.map(event=>eventNames[event]||event)),
    features=gap=>joined(gap.features.map(feature=>translatedOr('permissions.feature.'+feature,featureNames[feature]||feature))),
    current=value=>value?(accessNames[value]||value):t('permissions.no_access'),
    note=gap=>{const text=translatedOr('permissions.event_note.'+gap.name,null);return text?t('permissions.event_note_suffix',{note:text}):'';};
  const appEvents=report.app.missing_events||[],featureGaps=report.app.feature_gaps||[],baseline=!report.app.missing.length&&!appEvents.length;
  const settings=()=>githubLinkElement(t('permissions.open_settings'),report.app.settings_url);
  if(baseline&&!featureGaps.length)return [element('p',t('permissions.all_complete'),'view-success'),settings()];
  if(!baseline){
    const list=element('ul','');
    for(const item of report.app.missing)list.append(element('li',t('permissions.missing_permission_item',
      {permission:name(item),required:accessNames[item.required]||item.required,current:current(item.current)})));
    if(appEvents.length)list.append(element('li',t('permissions.missing_events_item',{events:events(appEvents)})));
    rows.push(element('p',t('permissions.missing_intro')),list);
  }else rows.push(element('p',t('permissions.baseline_ok'),'view-success'));
  // Only some features need these; they never fail the baseline check, but the project list flags them on every repository.
  if(featureGaps.length){
    const list=element('ul','');
    for(const gap of featureGaps)list.append(element('li',gap.kind==='permission'
      ?t('permissions.feature_permission_item',{permission:permissionNames[gap.name]||gap.name,required:accessNames[gap.required]||gap.required,
        current:current(gap.current),features:features(gap)})
      :t('permissions.feature_event_item',{event:eventNames[gap.name]||gap.name,features:features(gap),note:note(gap)})));
    rows.push(element('p',t('permissions.features_intro')),list);
  }
  rows.push(settings(),element('p',t('permissions.recheck_hint'),'muted'));return rows;
}
function appPermissionCheck(account){
  const box=element('div','','permission-check'),result=element('div','','permission-result');result.setAttribute('role','status');
  const check=button(t('permissions.check_button'),async()=>{
    check.disabled=true;result.replaceChildren(element('p',t('permissions.checking'),'muted'));
    try{result.replaceChildren(...permissionReport(await api(`/api/accounts/${encodeURIComponent(account.id)}/permissions`)));check.textContent=t('permissions.check_again');}
    catch(err){result.replaceChildren(element('p',t('permissions.check_failed',{message:readErrorText(err)}),'view-error'));}
    finally{check.disabled=false;}
  });
  box.append(check,result);return box;
}
