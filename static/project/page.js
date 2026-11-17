let current = null, projectTimer = null, renderToken = 0;
function leaveProjectPage() { clearTimeout(projectTimer); renderToken++; $('project-page').replaceChildren(); }
// Loads the project once per visit and re-renders the active section; status cards refresh on their own.
async function renderProject(route) {
  if (route.section === 'notes') { route = { ...route, section: 'knowledge' }; history.replaceState(null, '', `#/projects/${route.id}/knowledge`); }
  const legacyFocus = legacyProjectSections[route.section];
  if (legacyFocus !== undefined) {
    route = { ...route, section: 'roles', item: null };
    history.replaceState(null, '', `#/projects/${route.id}/roles`);
  }
  const token = ++renderToken, page = $('project-page'); clearTimeout(projectTimer);
  if (current?.id !== route.id || current.globalSettings) { current = { id: route.id, shownSection: route.section }; page.replaceChildren(projectLoadingState(route.section)); }
  // #697: another page of the same project shows that page's loading state at once. Keeping the previous page until
  // loadProject() answers left the address, the 当前页面 picker and the body naming three different pages.
  // An unsaved knowledge file keeps its page: knowledge.js asks before leaving and puts the old address back.
  // The comparison is with the page on screen (shownSection), which includes another page's pending loading state:
  // current.section only changes once loadProject() answers, so going back mid-read would otherwise look like a refresh.
  else if (current.repository && route.section !== current.shownSection && !(typeof knowledgeUnsaved === 'function' && knowledgeUnsaved())) { current.shownSection = route.section; page.replaceChildren(projectHeader(route.section), projectLoadingBody(route.section)); if (typeof syncConsoleShell === 'function') syncConsoleShell(); }
  if (legacyFocus) current.focusAnchor = legacyFocus;
  try { await loadProject(route.id,route.section); } catch (err) {
    if (token !== renderToken) return;
    if ([401,403].includes(err.status)) {
      if (err.status === 403) repositories = repositories.filter(repo => String(repo.id) !== route.id);
      if (typeof resetKnowledgeFiles === 'function') resetKnowledgeFiles();
      if (current?.id === route.id) current.rolesDraft = null;
      // A newly forbidden project must not retain the work page it displayed before its grant was revoked.
      $('console-page').replaceChildren(); $('costs-panel').replaceChildren();
      if (typeof resetBoard === 'function') resetBoard();
      if (typeof taskCreationDrafts !== 'undefined') taskCreationDrafts.delete(route.id);
      if (typeof leaveManagementPage === 'function') leaveManagementPage();
    }
    const unstarted = await unstartedProject(route.id, err);
    if (token !== renderToken) return;
    if (current?.id === route.id) { current.unavailable = unstarted ? null : projectUnavailableKind(err); current.shownSection = null; }
    page.replaceChildren(unstarted || projectUnavailable(err, route));
    if (typeof syncConsoleShell === 'function') syncConsoleShell();
    applyDocumentTitle(false, route);
    return;
  }
  if (token !== renderToken) return;
  current.unavailable = null;
  if (projectConsoleRoute(route)) {
    current.section = route.section; current.shownSection = route.section;
    if (!repositories.some(repo => String(repo.id) === route.id)) repositories.push(current.repository);
    page.replaceChildren(); page.hidden = true;
    const consolePage = ['inbox', 'new-task'].includes(route.section);
    document.querySelector('.list-panel').hidden = consolePage || route.section === 'management';
    $('console-page').hidden = !consolePage;
    if (consolePage) await renderConsolePage(renderVersion);
    else if (route.section === 'management') await renderManagementPage();
    else await render();
    if (token === renderToken && typeof syncConsoleShell === 'function') syncConsoleShell();
    return;
  }
  const known = projectSections.some(([key, , superOnly]) => key === route.section && (!superOnly || me.role === 'super_admin') && (!projectConsolePages.includes(key) || projectConsoleRoute(route)));
  const section = known ? route.section : 'basic';
  // A newly granted or externally created project may not be in the list loaded at login.
  if (!repositories.some(repo => String(repo.id) === String(current.id))) repositories.push(current.repository);
  // #642: an unknown section is not quietly replaced by another page: the address and the content have to agree.
  const missing = section !== route.section; setNotFoundTitle(missing);
  current.section = missing ? null : section; current.shownSection = route.section; current.item = route.item || null; page.replaceChildren(projectHeader(), projectBody(current.section));
  const inboxReturn = typeof inboxReturnLink === 'function' ? inboxReturnLink(current.id) : null;
  if (inboxReturn) page.prepend(inboxReturn);
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  // The Manager page draws its cards after reading them; the anchor of an older address is scrolled to once they are there.
  if (current.focusAnchor) { const anchor = current.focusAnchor; current.focusAnchor = null;
    const scroll = () => page.querySelector(`[data-overview-anchor="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' });
    if (section === 'roles') current.managerAnchor = scroll; else scroll(); }
  // Opening a rule file from the overview, or saving one, brings its card into view.
  if (current.focusRule) { page.querySelector(`[data-rule-path="${CSS.escape(current.focusRule)}"]`)?.scrollIntoView({ block: 'start' }); current.focusRule = null; }
  if (['machine', 'activity'].includes(section)) refreshProjectStatus(token);
  if (section === 'triggers' && current.policy.actions_failures_enabled) projectTimer = setTimeout(() => refreshActionsFailureStatus(token), 5000);
}
// The address of an installed repository nobody has started yet (a bookmark, or a link from elsewhere): it has no project
// page until it is started, so a super administrator gets that explanation and the 启动 action instead of a bare 404.
async function unstartedProject(id, err) {
  if (err.code !== 'repository_not_found' || me.role !== 'super_admin') return null;
  const row = (await api('/api/installations?repository_id=' + encodeURIComponent(id)).catch(() => null))?.repositories?.[0];
  if (!row || row.registered) return null;
  // The scope bar names started projects only; the installation row it caches lets it name this one as not started.
  if (typeof updateConsoleGaps === 'function') updateConsoleGaps([row]);
  const box = consoleState(`${row.full_name} 还没有启动`, row.installed ? '这个仓库已经安装了 GitHub App，但还没有在控制台启动；启动后才有项目页。'
    : '这个仓库已不在 GitHub App 的安装范围内，不能启动。'), actions = element('div', '', 'actions');
  if (row.installed) actions.append(onboardingEntry(row), button('启动', () => openActivation(row, () => route()).catch(error)));
  actions.append(consoleLink('#/settings/projects', '全局设置 · 项目', '启动、隐藏和公开看板'));
  box.append(actions); return box;
}
// #614: a project address this account cannot open. A project administrator gets 403 repository_forbidden whether or not
// the project exists (#595), so that state never says which one it is. Only a super administrator is answered 404
// repository_not_found, for a repository that is not registered; for that account the project simply does not exist.
// An expired session (401 login_required) asks to sign in again instead of blaming the network.
// The raw status and code stay under 详细信息 for support.
function projectUnavailableKind(err) {
  if (err.status === 403 || err.code === 'repository_forbidden') return 'forbidden';
  if (err.status === 404 || err.code === 'repository_not_found') return 'missing';
  if (err.status === 401 || err.code === 'login_required') return 'login';
  return 'failed';
}
const projectUnavailableCopy = {
  forbidden: ['没有权限打开这个项目', '当前账号看不到这个项目。若你觉得自己应该有权限，可到身份与权限里核对组织范围，或联系管理员。'],
  missing: ['找不到这个项目', '这个地址对应的项目不存在或还没有登记，链接可能已过期或输入有误。'],
  login: ['登录已过期', '当前登录已失效，请重新登录后再打开这个项目。'],
  failed: ['暂时打不开这个项目', '读取项目时出错，可能是网络或服务暂时不可用。请稍后重试，或先回到项目列表。']
};
function projectUnavailable(err, route) {
  const kind = projectUnavailableKind(err), [title, text] = projectUnavailableCopy[kind];
  if (kind === 'login' && sessionExpired) return sessionExpiredState(title, readErrorText(err));
  const box = consoleState(title, text, { tone: 'error' });
  box.classList.add('project-unavailable'); box.dataset.projectUnavailable = kind;
  // #715: while the session is expired consoleState already returns the shared 登录已过期 card with 重新登录.
  if (box.dataset.sessionExpired) return box;
  const actions = element('div', '', 'actions console-state-actions'), back = element('a', '返回项目列表', 'button-link btn-primary');
  back.href = '#/projects';
  if (kind === 'forbidden') {
    const identity = element('a', '查看身份与权限', 'button-link btn-secondary'); identity.href = '#/identity';
    actions.append(back, identity);
  } else if (kind === 'missing') actions.append(back);
  else if (kind === 'login') actions.append(button('重新登录', () => signInAgain(), 'btn-primary'));
  else actions.append(button('重试', () => renderProject(route).catch(error), 'btn-primary'), Object.assign(back, { className: 'button-link btn-secondary' }));
  const details = element('details', '', 'console-state-details');
  details.append(element('summary', '详细信息'), element('code', readErrorText(err)));
  box.append(actions, details); return box;
}
async function loadProject(id,section=current.section) {
  const superUser = me.role === 'super_admin';
  // Capture the visited object before awaiting: a different project replaces current while this request is in flight.
  const overview = section === 'overview' || projectConsolePages.includes(section), target = current;
  const [repo, environment, installed, rules, models] = await Promise.all([api('/api/repositories/' + id), overview ? null : api('/api/environments/' + id).catch(() => null), superUser ? api('/api/installations').catch(() => null) : null, overview ? null : api('/api/repositories/'+id+'/rules').catch(()=>null), overview ? null : api(superUser ? '/api/models' : '/api/models?repository_id='+id).catch(()=>null)]);
  const external=section==='external'?await loadExternalProject(id):null;
  Object.assign(target, { external, repository: repo.repository, canConfigure: repo.can_configure, policy: repo.policy, actionsFailures: repo.actions_failures, concurrencyDefault: repo.task_concurrency_default, environment, environmentReadError:'', installed: installed?.repositories.find(r => r.id === id) || null, rules:rules?.rules,
    models:(models?.models||[]).filter(model=>model.repository_id===null||model.repository_id===id) });
}
async function reloadProject() {
  const target = current, address = { id: target.id, section: target.section, item: target.item };
  if (target.globalSettings) return route();
  await loadProject(target.id, target.section);
  if (current === target && projectRoute()?.id === address.id && projectRoute()?.section === address.section) return renderProject(address);
}
// Reloads the project with the outcome of an action shown at the top of the section.
async function reloadWith(notice) { if (notice) current.flash = notice; await reloadProject(); }
function projectStatus() {
  const { policy, installed } = current;
  const status = !policy.enabled ? badge('已禁用', 'warning') : badge('已启用', 'info');
  const permission = installed?.access_gaps?.length ? [permissionBadge(installed)] : [];
  return [status, ...(installed?.installed === false ? [badge('已移出安装', 'danger')] : []), ...permission, ...(current.environment ? [projectEnvironmentState()] : [])];
}
// A background permission check answers with the whole snapshot row for every repository. This header drew its own read
// earlier, so it has to take that answer too; otherwise one screen shows the old grant next to the bar's new one. Only the
// header is redrawn: re-reading the page would discard what the reader has already typed into the settings forms.
function applyInstalledRow(row) {
  if (!row || !current || String(row.id) !== String(current.id) || projectRoute()?.id !== String(current.id)) return false;
  current.installed = { ...(current.installed || {}), ...row };
  const title = document.querySelector('#project-page .project-head .title-group'), name = title?.querySelector('h1');
  if (!name || current.section !== 'overview') return false;
  title.replaceChildren(name, ...projectStatus());
  return true;
}
function projectEnvironmentState() {
  const observed=current.environment?.observation;
  const known=observed?.status==='available'&&Object.hasOwn(states,observed.state)&&!current.environmentReadError;
  const unknown=current.environmentReadError?'电脑待核验':observed?.status==='recovering'?'管理服务恢复中':observed?.status==='absent'?'电脑记录缺失':observed?.status==='error'||observed?.status==='available'?'电脑状态未知':'电脑待核验';
  const node=known?state(observed.state):badge(unknown,'warning');
  node.dataset.projectEnvironmentState='';return node;
}
function projectHeader(section = current.section) {
  const head = element('div', '', 'project-head'), title = element('div', '', 'title-group');
  const overview = section === 'overview', caption = overview ? current.repository.full_name : projectSectionCaption(section) || '找不到页面';
  const heading = element('h1', caption); title.append(heading);
  if (overview) title.append(...projectStatus());
  head.append(title);
  if (overview) {
    const actions = element('div', '', 'actions');
    actions.append(link(`https://github.com/${current.repository.full_name}`, '在 GitHub 打开', 'button-link btn-secondary'));
    head.append(actions);
  } else if (section === 'basic') head.append(button('刷新项目设置', () => reloadProject().catch(error), 'btn-secondary'));
  return head;
}
function projectSettingsNav(section) {
  const nav = element('nav', '', 'project-nav project-settings-nav');
  nav.setAttribute('aria-label', '项目设置类别');
  for (const [key, caption] of projectSettingsSections) {
    const item = element('a', caption); item.href = `#/projects/${current.id}/${key}`;
    if (key === section) item.setAttribute('aria-current', 'page');
    nav.append(item);
  }
  return nav;
}
function projectNav(section) {
  return projectSettingsSections.some(([key]) => key === section) ? projectSettingsNav(section) : null;
}
const projectSectionCaption = section => projectSections.find(([key]) => key === section)?.[1] || null;
// #697: the loading state names the page being opened, so the reader sees the click took effect.
function projectLoadingState(section) {
  const caption = projectSectionCaption(section);
  return consoleState(caption ? `正在打开「${caption}」` : '正在加载项目', '正在读取这个项目的最新信息。', { tone: 'loading' });
}
// The nav already names the new page, so the 当前页面 picker can follow it before the data arrives.
function projectLoadingBody(section) {
  const body = element('div', '', 'project-body'), content = element('div', '', 'project-content');
  const known = !!projectSectionCaption(section);
  const nav = projectNav(known ? section : null); if (nav) body.append(nav);
  content.append(projectLoadingState(section)); body.append(content); return body;
}
function projectBody(section) {
  const body = element('div', '', 'project-body'), content = element('div', '', 'project-content');
  const nav = projectNav(section); if (nav) body.append(nav);
  if (current.flash) { const flash = element('p', current.flash, 'view-success flash'); flash.setAttribute('role', 'status'); content.append(flash); current.flash = null; }
  if (!section) content.append(pageNotFoundState(current.id));
  else content.append(...({ overview: workspaceOverview, basic: basicSection, triggers: projectTriggersSection, machine: machineSection, model: modelsSection, release: releaseSection, schedules: schedulesSection, knowledge: knowledgeSection, roles: rolesSection, external: externalSection, members: membersSection, activity: activitySection }[section])());
  body.append(content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

