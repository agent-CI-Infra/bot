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
  if (current?.id !== route.id || current.globalSettings) { current = { id: route.id }; page.replaceChildren(element('p', '正在加载…', 'muted')); }
  if (legacyFocus) current.focusAnchor = legacyFocus;
  try { await loadProject(route.id,route.section); } catch (err) {
    if (token === renderToken) { if ([401,403].includes(err.status)) { if (typeof resetKnowledgeFiles === 'function') resetKnowledgeFiles(); if (current?.id === route.id) current.rolesDraft = null; }
      const unstarted = await unstartedProject(route.id, err);
      if (token === renderToken) page.replaceChildren(unstarted || element('p', err.message, 'view-error')); }
    return; }
  if (token !== renderToken) return;
  const section = projectSections.some(([key, , superOnly]) => key === route.section && (!superOnly || me.role === 'super_admin')) ? route.section : 'basic';
  // A newly granted or externally created project may not be in the list loaded at login.
  if (!repositories.some(repo => String(repo.id) === String(current.id))) repositories.push(current.repository);
  current.section = section; current.item = route.item || null; page.replaceChildren(projectHeader(), projectBody(section));
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
  if (section === 'roles' && current.policy.actions_failures_enabled) projectTimer = setTimeout(() => refreshActionsFailureStatus(token), 5000);
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
  if (row.installed) actions.append(button('启动', () => openActivation(row, () => route()).catch(error)));
  actions.append(consoleLink('#/settings/projects', '全局设置 · 项目', '启动、隐藏和公开看板'));
  box.append(actions); return box;
}
async function loadProject(id,section=current.section) {
  const superUser = me.role === 'super_admin';
  // Capture the visited object before awaiting: a different project replaces current while this request is in flight.
  const overview = section === 'overview', target = current;
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
  if (!name) return false;
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
function projectHeader() {
  const { repository, policy } = current, head = element('div', '', 'project-head'), title = element('div', '', 'title-group'), actions = element('div', '', 'actions');
  const back = element('a', '← 全部项目', 'back-link'); back.href = '#/projects';
  title.append(element('h1', repository.full_name), ...projectStatus());
  actions.append(link(`https://github.com/${repository.full_name}`, '在 GitHub 打开', 'button-link'));
  if (current.section === 'basic') actions.append(button('刷新项目设置', () => reloadProject().catch(error)));
  head.append(back, title, actions); return head;
}
function projectBody(section) {
  const body = element('div', '', 'project-body'), nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content');
  nav.setAttribute('aria-label', '项目设置类别');
  for (const [key, caption, superOnly] of projectSections) {
    if (key === 'overview' || key === 'basic') nav.append(element('p', key === 'overview' ? '项目工作' : '设置', 'console-nav-label'));
    if (superOnly && me.role !== 'super_admin') continue;
    const item = element('a', caption); item.href = `#/projects/${current.id}/${key}`; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item);
    if (key === 'management') { const project = current.id; item.addEventListener('click', event => { event.preventDefault(); void openManagementChat(project).catch(error); }); }
  }
  if (current.flash) { const flash = element('p', current.flash, 'view-success flash'); flash.setAttribute('role', 'status'); content.append(flash); current.flash = null; }
  content.append(...({ overview: workspaceOverview, basic: basicSection, machine: machineSection, model: modelsSection, release: releaseSection, schedules: schedulesSection, knowledge: knowledgeSection, roles: rolesSection, external: externalSection, members: membersSection, activity: activitySection }[section])());
  body.append(nav, content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

