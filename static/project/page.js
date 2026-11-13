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
  try { await loadProject(route.id,route.section); } catch (err) { if (token === renderToken) { if ([401,403].includes(err.status)) { if (typeof resetKnowledgeFiles === 'function') resetKnowledgeFiles(); if (current?.id === route.id) current.rolesDraft = null; } page.replaceChildren(element('p', err.message, 'view-error')); } return; }
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
function projectSettingsDirectory() {
  const root = element('section', '', 'project-settings-directory'), links = element('div', '', 'console-groups');
  root.append(element('h2', '项目设置'));
  for (const [key, caption] of projectSettingsSections) {
    const item = consoleLink(`#/projects/${current.id}/${key}`, caption); item.classList.add('console-group'); links.append(item);
  }
  root.append(links);
  const location = element('div', '', 'project-setting-location'), back = element('a', '返回项目总览', 'button-link quiet');
  back.href = `#/projects/${current.id}/overview`; location.append(back);
  return [location, root];
}
function projectBody(section) {
  const body = element('div', '', 'project-body'), nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content');
  const setting = projectSettingsSections.find(([key]) => key === section);
  nav.setAttribute('aria-label', '项目工作');
  for (const [key, caption] of projectWorkSections) {
    const item = element('a', caption); item.href = `#/projects/${current.id}/${key}`; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item);
    if (key === 'management') { const project = current.id; item.addEventListener('click', event => { event.preventDefault(); void openManagementChat(project).catch(error); }); }
  }
  if (setting) {
    const location = element('div', '', 'project-setting-location'), back = element('a', '返回项目设置', 'button-link quiet');
    back.href = `#/projects/${current.id}/settings`;
    location.append(back, element('h2', setting[1])); content.append(location);
  }
  if (current.flash) { const flash = element('p', current.flash, 'view-success flash'); flash.setAttribute('role', 'status'); content.append(flash); current.flash = null; }
  content.append(...({ overview: workspaceOverview, settings: projectSettingsDirectory, basic: basicSection, machine: machineSection, model: modelsSection, release: releaseSection, schedules: schedulesSection, knowledge: knowledgeSection, roles: rolesSection, external: externalSection, members: membersSection, activity: activitySection }[section])());
  // A configuration page shows its own controls, not a third row of sibling pages above the role editor.
  if (!setting) body.append(nav);
  body.append(content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

