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
      if (token === renderToken) {
        // #614: the scope bar must stop saying 正在读取项目… once the read has failed, whatever the reason.
        if (current?.id === route.id) current.unavailable = unstarted ? null : projectUnavailableKind(err);
        page.replaceChildren(unstarted || projectUnavailable(err, route));
        if (typeof syncConsoleShell === 'function') syncConsoleShell();
      } }
    return; }
  if (token !== renderToken) return;
  current.unavailable = null;
  const known = route.section === 'menu' || projectSections.some(([key, , superOnly]) => key === route.section && (!superOnly || me.role === 'super_admin'));
  const section = known ? route.section : 'basic';
  // A newly granted or externally created project may not be in the list loaded at login.
  if (!repositories.some(repo => String(repo.id) === String(current.id))) repositories.push(current.repository);
  // #642: an unknown section is not quietly replaced by another page: the address and the content have to agree.
  const missing = section !== route.section; setNotFoundTitle(missing);
  current.section = missing ? null : section; current.item = route.item || null; page.replaceChildren(projectHeader(), projectBody(current.section));
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
  const box = consoleState(title, text, { tone: 'error' });
  box.classList.add('project-unavailable'); box.dataset.projectUnavailable = kind;
  const actions = element('div', '', 'actions console-state-actions'), back = element('a', '返回项目列表', 'button-link btn-primary');
  back.href = '#/projects';
  if (kind === 'forbidden') {
    const identity = element('a', '查看身份与权限', 'button-link btn-secondary'); identity.href = '#/identity';
    actions.append(back, identity);
  } else if (kind === 'missing') actions.append(back);
  else if (kind === 'login') actions.append(button('重新登录', () => location.reload(), 'btn-primary'));
  else actions.append(button('重试', () => renderProject(route).catch(error), 'btn-primary'), Object.assign(back, { className: 'button-link btn-secondary' }));
  const details = element('details', '', 'console-state-details');
  details.append(element('summary', '详细信息'), element('code', err.message));
  box.append(actions, details); return box;
}
async function loadProject(id,section=current.section) {
  const superUser = me.role === 'super_admin';
  // Capture the visited object before awaiting: a different project replaces current while this request is in flight.
  const overview = section === 'overview' || section === 'menu', target = current;
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
  const trail = element('div', '', 'project-trail');
  const back = element('a', '← 全部项目', 'back-link'); back.href = '#/projects';
  trail.append(back);
  if (current.section !== 'menu') {
    const toHub = element('a', '项目入口', 'back-link');
    toHub.href = `#/projects/${current.id}/menu`;
    toHub.dataset.testid = 'project-hub-link';
    trail.append(toHub);
  }
  title.append(element('h1', repository.full_name), ...projectStatus());
  const chat = element('a', '管理对话', 'button-link');
  chat.href = `#/projects/${current.id}/management`;
  chat.dataset.testid = 'project-open-chat';
  chat.addEventListener('click', event => { event.preventDefault(); void openManagementChat(current.id).catch(error); });
  actions.append(chat, link(`https://github.com/${repository.full_name}`, '在 GitHub 打开', 'button-link'));
  if (current.section === 'basic') actions.append(button('刷新项目设置', () => reloadProject().catch(error)));
  head.append(trail, title, actions); return head;
}
function projectCrumb(section) {
  const nav = element('nav', '', 'project-nav'), caption = (projectSections.find(([key]) => key === section) || [section, section])[1];
  nav.setAttribute('aria-label', '项目入口');
  // #481/#565: the phone's 当前页面 picker still lists every project entry in its groups (see syncConsoleShell).
  nav.dataset.pickerProject = current.id;
  const back = element('a', '← 项目入口');
  back.href = `#/projects/${current.id}/menu`;
  if (!section) { nav.append(back); return nav; }
  const here = element('a', caption);
  here.href = `#/projects/${current.id}/${section}`;
  here.setAttribute('aria-current', 'page');
  nav.append(back, here);
  return nav;
}
function menuSection() {
  const wrap = element('div', '', 'project-hub');
  wrap.dataset.testid = 'project-hub';
  wrap.append(element('h2', '项目入口'), note('从这里进入项目的工作和设置。打开某一页后，可用「项目入口」返回。'));
  for (const [title, items] of projectSectionGroups) {
    const group = element('section', '', 'project-hub-group');
    group.append(element('h3', title));
    const grid = element('div', '', 'project-hub-grid');
    for (const [key, caption, hint] of items) {
      const card = element('a', '', 'project-hub-card');
      card.href = `#/projects/${current.id}/${key}`;
      card.setAttribute('aria-label', caption);
      card.dataset.testid = 'project-hub-' + key;
      card.append(element('strong', caption), element('span', hint));
      if (key === 'management') {
        const project = current.id;
        card.addEventListener('click', event => { event.preventDefault(); void openManagementChat(project).catch(error); });
      }
      grid.append(card);
    }
    group.append(grid);
    wrap.append(group);
  }
  return [wrap];
}
function projectHubNav() {
  const nav = element('nav', '', 'project-nav');
  nav.setAttribute('aria-label', '项目入口');
  nav.dataset.pickerProject = current.id;
  const here = element('a', '项目入口');
  here.href = `#/projects/${current.id}/menu`;
  here.setAttribute('aria-current', 'page');
  nav.append(here);
  return nav;
}
function projectBody(section) {
  const body = element('div', '', 'project-body'), content = element('div', '', 'project-content');
  // #642: an unknown subpage has no crumb of its own; it only offers the way back to 项目入口.
  body.append(section === 'menu' ? projectHubNav() : projectCrumb(section));
  if (current.flash) { const flash = element('p', current.flash, 'view-success flash'); flash.setAttribute('role', 'status'); content.append(flash); current.flash = null; }
  if (!section) content.append(pageNotFoundState(current.id));
  else content.append(...({ overview: workspaceOverview, basic: basicSection, machine: machineSection, model: modelsSection, release: releaseSection, schedules: schedulesSection, knowledge: knowledgeSection, roles: rolesSection, external: externalSection, members: membersSection, activity: activitySection, menu: menuSection }[section])());
  body.append(content); return body;
}
const patchPolicy = changes => Object.keys(changes).length ? api(`/api/repositories/${current.id}/policy`, 'PATCH', changes) : Promise.resolve();
const changed = (values, saved) => Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key]));

