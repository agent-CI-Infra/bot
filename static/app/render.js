
async function render(quiet = false) {
  // The list renderer never owns a console page. This is the second line of defence for #365: even when a stale route
  // reaches here after `tab` has moved to #/more, it must not turn that tab name into an API path.
  if (consoleTabs.includes(tab)) return;
  // The list this call belongs to. A hash change can land while a read below is still in flight; the call must finish
  // the list it started for, or step aside, and never re-point its own address at whatever `tab` became (#365).
  const pageTab = tab;
  const request=++renderVersion, taskTab = !!taskKinds[tab], isIdentity = tab === 'identity' || tab === 'preferences';
  const identityTitle = /^#\/identity\/feishu-apps(?:\/|$)/.test(location.hash) ? t('nav.feishu_apps')
    : /^#\/identity\/feishu(?:$|\?|\/)/.test(location.hash) ? t('nav.feishu') : t('identity.title');
  $('page-title').textContent = isIdentity ? identityTitle : titles[tab];
  const activeNavTab = ['preferences', 'identity', 'external', 'conversations'].includes(tab) ? 'preferences' : tab;
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === activeNavTab ? 'page' : 'false'));
  $('filters').hidden = !listTabs.includes(tab);
  const filtersFold = document.querySelector('[data-testid=project-filters-fold]');
  if (filtersFold) {
    filtersFold.hidden = $('filters').hidden;
    const active = $('repository-filter').value || $('account-filter').value || $('owner-filter').value;
    const summary = filtersFold.querySelector('summary');
    if (summary) summary.textContent = active ? '筛选（已设条件）' : '筛选';
    if (active) filtersFold.open = true;
  } $('account-filter-label').hidden = me.role !== 'super_admin' || tab==='external'; $('owner-filter').parentElement.hidden=tab==='external'; $('paging').hidden = tab==='external' || !listTabs.includes(tab);
  $('rows').hidden=['external','board','costs','settings','identity','preferences'].includes(tab);$('external-panel').hidden=tab!=='external';$('board-panel').hidden=tab!=='board';$('costs-panel').hidden=tab!=='costs';$('settings-panel').hidden=tab!=='settings';$('identity-panel').hidden=!isIdentity;$('sync').hidden=true;$('hidden-filter-label').hidden=true;
  $('filters').classList.toggle('project-filters',me.role !== 'super_admin');
  const params = listParams();
  // Only lists that render into #rows show its loading state; console pages draw their own and must not keep a stale one.
  $('rows').dataset.view=tab;if(!quiet){$('rows').replaceChildren(...($('rows').hidden||consoleTabs.includes(tab)?[]:[consoleState('正在加载列表','正在读取当前范围的记录。',{tone:'loading'})]));listSignature='';$('count').textContent='正在加载…';$('rows').setAttribute('aria-busy','true');}
  if(tab==='board'){try{await renderBoard(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='costs'){try{await renderCosts(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(isIdentity){try{await renderIdentity();}finally{$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='settings'){try{await renderSettings(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='external'){params.delete('account_id');params.delete('owner_id');try{await renderExternal(params,request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if (taskTab) params.set('kind', taskKinds[tab]);
  // Super administrators see every installed repository; project administrators see their registered ones.
  const installedView = tab === 'projects' && me.role === 'super_admin'; $('sync').hidden = true;
  $('hidden-filter-label').hidden = true;
  // The 已隐藏 filter swaps the list for the rows an administrator removed from it; each one can be restored.
  const hiddenView = installedView && $('hidden-filter').checked;
  // Gate / dashboard connection status (cached; refreshed on demand).
  const integrationMap = new Map(); let staleIntegrations = false;
  if (installedView && !hiddenView) {
    let integrations = [], checked = false; try { integrations = (await api('/api/integrations')).integrations || []; } catch {}
    if (!integrations.length) {
      checked = true;
      try { $('count').textContent = '正在检查门禁和看板的接入状态…'; integrations = (await api('/api/integrations/check', 'POST', {})).integrations || []; } catch {}
    }
    integrations.forEach(item => integrationMap.set(item.repository_id, item));
    // What a check just returned is not checked again here, even if part of it is still stale.
    staleIntegrations = !checked && integrations.some(item => item.stale);
  }
  if (tab !== pageTab || consoleTabs.includes(tab)) return;
  const endpoint = taskTab ? 'tasks' : tab === 'projects' ? 'repositories' : tab;
  const address = tab === 'projects' ? projectListAddress(hiddenView, params) : `/api/${endpoint}${listTabs.includes(tab) ? '?' + params : ''}`;
  let result;
  try { result = await api(address); }
  catch (err) {
    if (request !== renderVersion) return;
    $('rows').removeAttribute('aria-busy');
    const heading = tab === 'projects' ? '项目列表未能读取' : tab === 'events' ? '投递记录未能读取' : '列表未能读取';
    $('count').textContent = '读取失败';
    $('rows').replaceChildren(consoleState(heading, (err.message || '请求失败') + '。这不是空列表，当前无法判断是否有记录。', { tone: 'error', retry: () => render().catch(error) }));
    return;
  }
  finally { if (request === renderVersion) $('rows').removeAttribute('aria-busy'); }
  if(request!==renderVersion)return;const rows=result[installedView ? 'repositories' : endpoint];
  let pendingRepositories=[];
  let pendingRepositoriesError=null;
  const projectListFiltered=!!(params.get('repository_id')||params.get('account_id')||params.get('owner_id'));
  if(tab==='projects'&&!installedView&&!hiddenView&&!projectListFiltered){
    // Started repos come from /api/repositories. Installed-but-not-started names come from GET /api/identity;
    // the installations admin API stays closed to project users. A list filter hides the unfiltered pending group.
    try{pendingRepositories=(await api('/api/identity')).github_connection?.pending_repositories||[];}catch(err){pendingRepositoriesError=err;pendingRepositories=[];}
    if(request!==renderVersion)return;
    const started=new Set(rows.map(row=>String(row.id)));
    pendingRepositories=pendingRepositories.filter(repo=>repo&&repo.full_name&&!started.has(String(repo.id)));
  }
  const signature=tab+'\n'+(hiddenView?'hidden\n':'')+params+'\n'+JSON.stringify(rows)+'\n'+JSON.stringify(pendingRepositories)+'\n'+String(!!pendingRepositoriesError);if(quiet&&signature===listSignature)return;listSignature=signature;
  const lines=[]; $('count').textContent = tab === 'events' ? `本页 ${rows.length} 条投递` : hiddenView ? `${rows.length} 个已隐藏仓库` : installedView ? `${rows.length} 个仓库 · ${syncSummary(result.syncs)}` : tab === 'projects' ? `${rows.length} 个项目${pendingRepositories.length?`，${pendingRepositories.length} 个等待管理员启动`:pendingRepositoriesError?'，等待启动的仓库暂时无法读取':''}` : `${rows.length} 条记录`;
  if (installedView && !hiddenView) $('count').textContent += ' · 看板公开可访问：公开仓默认开，私有仓默认关';
  $('previous').disabled = offset === 0; $('next').disabled = rows.length < 50; $('page-number').textContent = `第 ${offset / 50 + 1} 页`;
  rows.forEach(row => {
    const line = element('div', '', 'row'), content = element('div', '', 'row-content'), status=element('div','','row-state');line.setAttribute('role','listitem');line.dataset.key=String(row.id);rowSignatures.set(line,JSON.stringify(row));
    if (tab === 'events') {
      line.dataset.deliveryKey = String(row.delivery_id || ''); line.dataset.deliveryRecord = String(row.id);
      line.dataset.deliverySource = row.source?.reference || 'deliveries:' + row.id;
    }
    const name = taskTab ? `${row.kind === 'development.pr' ? '跟进 ' : ''}${objectLabel(row)} · ${row.full_name || '仓库 ' + row.repository_id}` : (tab==='events'?(row.full_name?row.full_name+' · '+row.route:row.route):row.full_name) || row.name || row.username || row.model_name || row.summary || row.route || '未知事件';
    content.append(element('strong', name));
    if (tab === 'projects' && !hiddenView && row.registered !== false) content.append(consoleLink(`#/projects/${row.id}/overview`, '项目总览', '查看工作进展与待处理事项'));
    if (tab === 'events') {
      // The delivery ID and the archive reference are the two handles a maintainer copies when checking GitHub's own log.
      content.append(element('p', `${timestamp(row.received_at)} · ${row.event || '未知事件'} · 来源 ${line.dataset.deliverySource}`));
      const delivery = element('code', String(row.delivery_id || '')); delivery.dataset.deliveryId = ''; delivery.title = 'GitHub delivery ID'; content.append(delivery);
      line.append(content);
      status.append(...['reception','signature','processing'].map(kind => deliveryFacet(kind, row)));
    } else {
      const detail = taskTab ? `${phaseLabels[row.phase] || row.phase} · ${row.head_sha ? '提交 ' + row.head_sha.slice(0,12) : '等待材料'} · 第 ${row.attempt} 次 · 更新于 ${timestamp(row.updated_at)}${row.error_code ? ' · '+faultSummary(row.error_code,row.error_cause) : ''}${tab === 'reviews' && Array.isArray(row.result?.findings) ? ` · ${row.result.findings.length} 条发现` : ''}`
        : installedView ? installedDetail(row) : `仓库 ID ${row.id}${row.model_id ? '' : ' · 未选模型'}`;
      content.append(element('p', detail)); line.append(content);
      if(listTabs.includes(tab))status.append(taskTab ? taskState(row) : state(row.status));
    }
    if(tab==='events'){
      for(const task of row.tasks||[])content.append(button(`${kindLabels[task.kind]||task.kind} #${task.object_number} · 查看任务`,()=>openTask(task.id),'quiet linkish'));
      // The Manager trace stays next to the outcome: what it did, or why the delivery never reached it.
      const managerRow=(row.dispatch||[])[0];
      if(managerRow)content.append(element('p','Manager 分派：'+dispatchCaption(managerRow)+(managerRow.reason?' · '+managerRow.reason:''),'muted'));
      else if(row.processing_result&&deliveryIgnoreReasons[row.processing_result])content.append(element('p','未交给 Manager：'+deliveryIgnoreReasons[row.processing_result],'muted'));
    }
    if(installedView){status.append(...installedBadges(row));if(!hiddenView)status.append(...installedIntegration(integrationMap.get(row.id),row));}
    if(tab==='projects'&&!hiddenView){line.classList.add('project-list-row');line.dataset.repositoryId=row.id;status.classList.add('project-overview');status.append(projectListControls(row));}
    if(taskTab&&row.result?.pr_url){try{const url=new URL(row.result.pr_url);if(['https:','http:'].includes(url.protocol)){const link=element('a',row.result.pr_number?'PR #'+row.result.pr_number:'查看 PR','result-link');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';content.lastElementChild.append(link);}}catch{}}
    if(status.childElementCount)line.append(status);
    // An installed repository that was never started has no project page yet; it offers 启动 instead of 设置.
    if(installedView){const actions=element('div','','actions');
      if(row.registered)actions.append(button('设置',()=>openProject(row.id),'quiet'));
      else if(row.installed&&!hiddenView)actions.append(button('启动',()=>openActivation(row,()=>start()).catch(error),'quiet'));
      if(hiddenView)actions.append(button('恢复',()=>restoreInstalled(row,()=>start()).catch(error),'quiet'));
      if(actions.childElementCount)line.append(actions);}
    else if(tab==='projects'){const actions=element('div','','actions');actions.append(button('设置',()=>openProject(row.id),'quiet'));line.append(actions);}
    if (tab === 'events') {
      const button = element('button', '查看详情', 'quiet'); button.addEventListener('click', async () => {
        try { $('detail-title').textContent='投递详情'; $('detail-body').replaceChildren(...deliveryDetail(await api('/api/events/' + row.id))); $('detail').showModal(); } catch (err) { error(err); }
      }); const actions=element('div','','actions');actions.append(button);line.append(actions);
    }
    if(taskTab){
      const actions=element('div','','actions'),detail=element('button','查看过程','quiet');
      detail.addEventListener('click',()=>openTask(row.id).catch(error));actions.append(detail);
      if(retryableStates.includes(row.status)){
        const retry=element('button','重试','quiet');retry.addEventListener('click',async()=>{
          retry.disabled=true;const address=tab+':'+location.hash;
          try{await api('/api/tasks/'+row.id+'/retry','POST',{});if(address!==tab+':'+location.hash)return;notice('message');await render();}
          catch(err){if(address===tab+':'+location.hash)notice('message',retryErrorText(err));retry.disabled=false;}
        });actions.append(retry);
      }line.append(actions);
    }
    if(taskTab)content.append(taskMetricsLine(row));
    line.classList.toggle('has-actions',!!line.querySelector(':scope > .actions'));lines.push(line);
  });
  const entries = tab === 'projects' ? groupProjectRows(rows, lines) : lines, shown = [...$('rows').children];
  if(quiet&&shown.length===entries.length&&shown.every((node,index)=>node.dataset.key===entries[index].dataset.key))
    shown.forEach((node,index)=>{if(rowSignatures.get(node)!==rowSignatures.get(entries[index]))node.replaceWith(entries[index]);});
  else $('rows').replaceChildren(...entries);
  if (tab === 'projects' && !installedView && !hiddenView && pendingRepositories.length) {
    $('rows').append(pendingActivationGroup(pendingRepositories));
  }
  if (tab === 'projects' && !installedView && !hiddenView && pendingRepositoriesError) {
    $('rows').append(consoleState('等待启动的仓库暂时无法读取', pendingRepositoriesError.message || '请稍后重试。', { tone: 'error', retry: () => start().catch(error) }));
  }
  if (tab === 'events' && !rows.length) $('rows').replaceChildren(eventsEmptyState(params));
  if (tab === 'projects' && !installedView && !repositories.length && !rows.length && !pendingRepositories.length && !pendingRepositoriesError) {
    const empty = consoleState('已登录，尚无可管理的项目', '可以先查看身份与权限；安装待同步或权限待核验时，按身份页提示重新验证，或联系管理员分配项目。', { retry: () => start().catch(error) });
    empty.append(consoleLink('#/identity', '查看身份与权限')); $('rows').replaceChildren(empty);
  } else if (tab === 'projects' && !rows.length && (hiddenView || installedView)) {
    // Installed / hidden warehouse lists only. Do not replace a pending-activation
    // group or a pending-read error that was just appended on the project list.
    const empty = consoleState(
      hiddenView ? '没有已隐藏的仓库' : '还没有仓库',
      hiddenView ? '没有从项目列表中隐藏的仓库。当前看到的是空列表，不是读取失败。' : '安装 GitHub App 并启动仓库后，它们会出现在这里。当前看到的是空列表，不是读取失败。'
    );
    $('rows').replaceChildren(empty);
  }
  if(staleIntegrations)refreshStaleIntegrations();
  if(installedView&&!hiddenView&&rows.some(row=>row.permissions_stale))refreshStalePermissions();
}
