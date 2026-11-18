// Shared navigation wraps the existing console; business pages keep their routes and renderers.
const consoleMedia = matchMedia('(max-width:767px)');
let consoleOwner = null, consoleRouteKey = null;
const consolePositions = new Map();
// What a project is currently short of, from the installation snapshot: one read per project and page session, because the
// navigation is redrawn on every route and must not turn a badge into a request per click.
const consoleGaps = new Map();
function loadConsoleGaps(id) {
  if (consoleGaps.has(id)) return;
  consoleGaps.set(id, null);
  api('/api/installations?repository_id=' + encodeURIComponent(id)).then(result => {
    consoleGaps.set(id, (result.repositories || []).find(row => String(row.id) === id) || null);
    if (consoleScope() === id) syncConsoleShell();
  }).catch(() => { /* a failed read keeps the row null, so the badge is drawn empty instead of showing the project left behind */ });
}
// A sync can close a gap, so the navigation must not answer from the snapshot it cached before the reader re-read it.
function forgetConsoleGaps() { consoleGaps.clear(); }
// A background snapshot read answers with the same rows this cache holds, so its result has to reach the bar as well.
function updateConsoleGaps(rows) {
  let changed = false, currentRow = null;
  const scope = consoleScope();
  for (const row of rows || []) if (row && row.id != null) {
    consoleGaps.set(String(row.id), row); changed = true;
    if (scope && String(row.id) === String(scope)) currentRow = row;
  }
  if (!changed) return;
  syncConsoleShell();
  // The project header draws its own read of the same snapshot; without this it keeps the previous answer while the bar
  // shows the new one, so one screen contradicts itself until the reader navigates away and back. It is handed the row
  // rather than reloaded, so a reader who is halfway through a form does not lose what was typed.
  if (currentRow && typeof applyInstalledRow === 'function') applyInstalledRow(currentRow);
}
const consoleAttention = {
  failed: ['执行失败', '查看失败证据后选择修复方式；不是所有失败都适合直接重试。'],
  paused: ['任务已暂停', '查看暂停原因，确认可以继续后再操作。'],
  waiting_configuration: ['配置待补', '补齐任务所需的模型、凭据或项目配置。'],
  waiting_environment: ['环境待恢复', '检查项目电脑和连接状态，保留现有任务与证据。'],
  waiting_permission: ['权限待处理', '核对当前授权，必要时联系项目或应用管理员。'],
  waiting_publication: ['发布待核实', '先核对远程写入结果，避免重复发布。'],
  needs_help: ['需要帮助', 'Manager 已明确请求外部帮助；查看所需操作与恢复条件。'],
  needs_replan: ['需要重新规划', '查看验收缺口和已有产物，再决定下一步。']
};
function consoleInboxRoute() {
  const project = projectRoute();
  if (project?.section === 'inbox') return [location.hash, project.id, project.item || '0'];
  return /^#\/inbox(?:\/(all|[1-9]\d*))?(?:\/(\d+))?$/.exec(location.hash);
}
// Return metadata stays in memory: no draft, credential or task detail is stored in a URL or browser storage.
let consoleInboxReturn = null;
function captureConsoleInbox(taskId) {
  return consoleInboxRoute() ? { address: location.hash, actor: me, taskId, y: scrollY } : null;
}
function rememberInboxReturn(origin, repositoryId) {
  consoleInboxReturn = origin && origin.actor === me ? { ...origin, repositoryId } : null;
}
function inboxReturnLink(repositoryId) {
  const origin = consoleInboxReturn;
  if (!origin || origin.actor !== me || String(origin.repositoryId) !== String(repositoryId)) return null;
  return consoleLink(origin.address, '返回待处理列表', '重新读取原来的项目范围和分页；配置保存不代表任务已恢复。');
}
async function refreshInboxAfterTask(origin) {
  const live = () => me === origin.actor && tab === 'inbox' && location.hash === origin.address && !taskView.open;
  if (!live()) return;
  const request = ++renderVersion;
  await renderConsoleInbox(request);
  if (!live() || request !== renderVersion) return;
  restoreInboxPosition(origin);
}
function restoreInboxPosition(origin) {
  const target = document.querySelector(`[data-attention-task="${CSS.escape(origin.taskId)}"]`) || $('console-page').querySelector('.console-inbox-filters button');
  scrollTo(0, origin.y); target?.focus({ preventScroll: true });
}
// Same wording as the task detail (static/views.js): the list must not invent a second name for a level.
const consolePriority = { P0: '紧急止损', P1: '核心阻塞', P2: '正常开发', P3: '非核心完善' };
// How long an item has waited, from the state change the list is already sorted by; coarse on purpose, because the
// exact second would imply a precision the record does not have.
function waitedFor(iso) {
  const started = Date.parse(iso); if (!Number.isFinite(started)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60000));
  if (minutes < 1) return '少于 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24), restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}
function consoleTaskRow(row, attention = false) {
  const item = element('article', '', 'console-attention-row'), text = element('div');
  const guidance = attention && consoleAttention[row.status], priority = row.priority || 'P2';
  const level = consolePriority[priority] ? `${priority} ${consolePriority[priority]}` : priority;
  // A waiting item says which level it is: P0 and P2 look alike otherwise, and the list is sorted by age, not urgency.
  text.append(element('p', `${row.full_name || row.repository_id} · ${guidance?.[0] || projectTaskLabel(row)}${guidance ? ' · ' + level : ''}`, 'eyebrow'), element('h2', row.summary || row.id));
  if (guidance) text.append(element('p', row.error_cause?.action || guidance[1]));
  if (row.origin) text.append(element('p', taskOriginCaption(row.origin), 'muted'));
  if (row.error_code) text.append(element('p', row.error_code, 'muted'));
  const waited = guidance ? waitedFor(row.updated_at) : null;
  text.append(waited ? element('p', `已等待 ${waited}，最近状态变更于 ${timestamp(row.updated_at) || '未知时间'}`, 'muted')
    : element('p', `更新于 ${timestamp(row.updated_at) || '未知时间'}`, 'muted'));
  const open = button('查看任务', () => openTask(row.id).catch(error)); open.dataset.attentionTask = row.id;
  item.dataset.taskId = row.id; item.append(text, state(row.status), open); return item;
}
// #699: one plain sentence for where the work came from and who took it. The stored kinds (event / operator / role) and
// role ids are not words a reader knows; role names follow the role page (roleConfigName, #608), and the conversation id
// is left out because the task page already links the conversation.
const taskOriginKinds = { event: 'GitHub 事件', operator: '有人手动创建', role: '角色委派' };
function taskOriginRole(id) { return typeof roleConfigName === 'function' ? roleConfigName(id, null) : id; }
function taskOriginCaption(origin) {
  const source = origin.conversation_id ? '连续会话' : Object.hasOwn(taskOriginKinds, origin.source_kind) ? taskOriginKinds[origin.source_kind] : '其他来源';
  const from = origin.source_role ? taskOriginRole(origin.source_role) : '', to = origin.executor_role ? taskOriginRole(origin.executor_role) : '';
  const handoff = !to ? '按原执行流程处理' : from && origin.source_role === origin.executor_role ? `${to}自己执行` : `${from}交给${to}`;
  return '来源：' + source + ' · ' + handoff;
}
// #481: the phone's bottom bar owns the five primary destinations (项目 / 任务 / 待处理 / 助手 / 更多), so this page is
// the supplement behind 更多. It must not repeat what the bar already carries, and it stays short enough to read on a
// phone. #549: a project administrator's 更多 is only personal settings — usage, storage and the external
// runner belong to the management area (#550). Scoped project work and settings are also available here.
function consoleGroups() {
  const id = consoleScope(), repo = repositories.find(r => String(r.id) === id);
  const groups = [];
  const personal = [
    // #615: the old 个人设置 entry pointed at #/identity, so the directory drew the same page twice with two names.
    ['#/identity/feishu', '飞书绑定', '个人绑定、群绑定、仓库权限与聊天记录'],
    ['#/identity', '身份与权限', '本人绑定与当前有效授权'],
    ['#/conversations', '飞书会话', '成员消息、执行过程与派生任务']
  ];
  // #550: usage, storage, the external runner and (for a super administrator) onboarding,
  // installation archives and robot accounts live in one 管理 group. Permissions are unchanged:
  // a project administrator only sees the pages their role can already open.
  const management = [
    ...(!(repo && me.role === 'super_admin') ? [[consolePageAddress('costs', repo ? id : null), '用量与成本', '按项目、日期与工作类型查看']] : []),
    ['#/external', '外部执行端', '接入与连接诊断'],
    ['#/settings/storage', '存储', '本人项目的轨迹与数据量']
  ];
  if (me.role === 'super_admin') {
    management.push(
      ['#/settings/onboarding', '接入向导', '部署接入步骤'],
      ['#/settings/installations', '安装档案', 'GitHub App 安装记录'],
      ['#/settings/accounts', '机器人账号', '接入使用的 GitHub App'],
      ['#/settings/work-computers', '全局设置', '系统算力、接入、渠道与用户']
    );
  }
  const adminGroup = { title: '管理', items: management, testid: 'console-admin-group' };
  if (repo) groups.push({ title: '当前项目', items: [
    ...projectWorkSections().filter(([key]) => ['release', 'knowledge', 'activity'].includes(key)),
    ['basic', t('nav.project_settings')], ...projectWorkSections().filter(([key]) => key === 'costs')
  ].map(([key, name]) => [`#/projects/${id}/${key}`, name, repo.full_name]) });
  groups.push({ title: me.role === 'super_admin' ? '个人与平台' : '设置', wide: me.role !== 'super_admin', items: personal }, { ...adminGroup, wide: true });
  return groups;
}
// Real links expose their scope before activation. Reconcile in place so async page reads do not discard keyboard focus.
function syncConsoleNavigation(repo) {
  const project = projectRoute(), id = repo ? String(repo.id) : null, isSuper = me.role === 'super_admin';
  const entries = id ? projectWorkSections() : [['projects', t('nav.projects')], ['board', t('nav.board')], ['inbox', t('nav.inbox')], ['management', t('nav.management')], ...(isSuper ? [['costs', t('nav.costs')]] : [])];
  const active = tab === 'task' ? null : project ? (projectSettingsSections.some(([key]) => key === project.section) ? 'basic' : project.section) : ['identity', 'preferences', 'external', 'conversations'].includes(tab) ? 'preferences' : tab;
  const primary = document.querySelector('.console-primary-nav'), settings = document.querySelector('.console-settings-nav');
  const rows = [...entries.map(([key, caption]) => ({ key, caption, href: consolePageAddress(key, id) })),
    ...(id ? [{ key: 'basic', caption: t('nav.project_settings'), href: `#/projects/${id}/basic`, group: t('nav.project_settings_group') }] : []),
    ...(!isSuper ? [{ key: 'more', caption: t('nav.more'), href: '#/more' }] : [])];
  const pinned = isSuper ? [{ key: 'preferences', caption: t('nav.preferences'), href: '#/identity' }, { key: 'settings', caption: t('nav.settings'), href: '#/settings/work-computers' }] : [];
  const reconcile = (container, items) => {
    const signature = JSON.stringify(items);
    if (container.dataset.entries !== signature) {
      const nodes = [];
      for (const item of items) {
        if (item.group) nodes.push(element('p', item.group, 'console-nav-label'));
        const a = consoleLink(item.href, item.caption); a.dataset.consoleNav = item.key;
        if (item.key === 'inbox') a.id = 'console-inbox-link';
        if (item.key === 'more') { a.id = 'console-more-link'; a.dataset.testid = 'console-more-link'; }
        const icon = consoleIcon(item.key === 'preferences' ? 'user' : item.key === 'more' ? 'more' : consoleIconName(item.href)); icon.classList.add('console-nav-icon'); a.prepend(icon); nodes.push(a);
      }
      container.replaceChildren(...nodes); container.dataset.entries = signature;
    }
    for (const a of container.querySelectorAll('[data-console-nav]')) {
      if (a.dataset.consoleNav === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
  };
  reconcile(primary, rows); reconcile(settings, pinned); settings.hidden = !pinned.length;
}
function syncConsoleShell() {
  const signedIn = !!me && !$('workspace').hidden;
  // #481: the account menu belongs to the page that opened it. Every shell re-sync is a route or a breakpoint change, so
  // closing here keeps it from hanging over the page it just navigated to, and from staying open past 767px where its
  // trigger is hidden (the menu is a sibling of #console-account, not a child of it).
  const accountMenu = $('console-account-menu');
  if (accountMenu && !accountMenu.hidden) setAccountMenu(false);
  document.body.classList.toggle('console-ready', signedIn);
  $('console-sidebar').hidden = !signedIn;
  $('console-mobile-nav').hidden = !signedIn;
  $('console-location').hidden = !signedIn;
  $('console-mobile-scope').hidden = !signedIn;
  if (!signedIn || consoleOwner !== me.id) {
    if (typeof resetTaskCreation === 'function') resetTaskCreation();
    if (typeof resetKnowledgeFiles === 'function') resetKnowledgeFiles();
    if (typeof resetScheduleViews === 'function') resetScheduleViews();
    if (typeof resetBoard === 'function') resetBoard();
    if (typeof resetPersonalApps === 'function') resetPersonalApps();
    consoleOwner = me?.id || null; consolePositions.clear(); consoleRouteKey = null;
    syncConsoleScope();
    closeScopePicker(false);
    $('console-secondary-nav').replaceChildren(); $('console-page').replaceChildren();
    setAccountMenu(false);
    // #481: the bar's assistant state belongs to one session. A different owner starts idle and read, so a turn left
    // running or a reply left unread by the previous user never survives the sign-out.
    updateConsoleAssistant();
  }
  if (!signedIn) {
    const globalHeader = $('console-project-header');
    globalHeader.hidden = true;
    globalHeader.querySelector('.project-head')?.remove(); globalHeader.querySelector('.workbench-tabs')?.remove();
    const locationBox = $('console-location'), permission = $('console-permission');
    if (permission.parentElement !== locationBox) locationBox.insertBefore(permission, locationBox.querySelector('.console-section-picker'));
    syncScopePicker(); return;
  }
  // The menu names the same person the header used to print beside the sign-out button.
  $('console-account-login').textContent = userDisplayName(me);
  $('console-account-role').textContent = currentRoleText();
  const project = projectRoute();
  syncConsoleScope();
  const consoleProject = consoleScope(), repo = repositories.find(r => String(r.id) === consoleProject);
  syncConsoleNavigation(repo);
  if (typeof syncManagementScope === 'function') syncManagementScope();
  // A GitHub full name carries its owner, so the picker groups by organization without asking for another projection:
  // the same repository name can arrive from two owners and then must not look like one project.
  const organization = scopeOrganization;
  syncScopePicker();
  const platform = tab === 'settings', personal = !project && ['preferences', 'identity', 'external', 'conversations'].includes(tab);
  const settingsContext = platform && typeof settingsPageTitle === 'function' ? settingsPageTitle() : t('nav.settings');
  $('console-area').textContent = platform ? (typeof settingsScope === 'function' ? settingsScope() : t('nav.platform')) : project ? t('nav.project_workspace') : personal ? t('nav.personal') : t('nav.workspace');
  // The scope bar names both halves of the current address: a project name alone does not say which organization it is in.
  const shortName = r => (r.full_name || '').includes('/') ? r.full_name.split('/').slice(1).join('/') : r.full_name;
  // #558: the identity page already has a single h1; repeating the same words in the
  // breadcrumb made two visible titles. The crumb stays "个人设置" and the h1 names the page.
  // An installed repository nobody has started is no project yet; its cached installation row still names it.
  const unstarted = project && !repo ? consoleGaps.get(String(project.id)) : null;
  $('console-context').textContent = project ? (repo ? organization(repo) + ' / ' + shortName(repo) + (project.section === 'overview' ? '' : ' / ' + (projectSectionCaption(project.section) || '找不到页面'))
    : unstarted?.registered === false ? organization(unstarted) + ' · ' + shortName(unstarted) + ' · ' + t('nav.unstarted')
      : typeof current !== 'undefined' && current?.unavailable && String(current.id) === String(project.id) ? t(current.unavailable === 'missing' ? 'nav.project_not_found' : 'nav.project_unavailable') : t('nav.reading_project'))
    : tab === 'identity' || tab === 'preferences' ? '' : ({ more: t('nav.more'), inbox: t('nav.inbox'), settings: settingsContext, 'repository-onboarding': t('nav.repository_onboarding') }[tab] || titles[tab] || t('identity.title'));
  // A project can be reachable while some of its features cannot run; the navigation every page shares has to say so.
  // Only the installation snapshot names the gaps, and only a super administrator may read it, so nothing is invented.
  const permission = $('console-permission');
  // Until this project's own snapshot answers, the bar must not keep the badge of the project the reader just left:
  // the badge names a project and opens its dialog, so a stale one would describe something other than the scope text.
  if (!repo || me.role !== 'super_admin' || !consoleGaps.has(String(repo.id))) permission.replaceChildren();
  else {
    const row = consoleGaps.get(String(repo.id));
    permission.replaceChildren(...(row?.access_gaps?.length ? [permissionBadge(row)] : []));
  }
  const locationBox = $('console-location'), overview = project?.section === 'overview', globalHeader = $('console-project-header');
  const activeOverview = overview && String(current?.id) === String(project.id) && current.section === 'overview' && !!current.repository && !current.unavailable;
  const existingHead = globalHeader.querySelector('.project-head');
  const nextHead = activeOverview ? $('project-page').querySelector('.project-head') : null;
  if (nextHead && nextHead !== existingHead) { existingHead?.remove(); globalHeader.prepend(nextHead); }
  else if (!nextHead && (!activeOverview || existingHead?.dataset.projectId !== String(project.id))) existingHead?.remove();
  const existingTabs = globalHeader.querySelector('.workbench-tabs');
  const tabs = activeOverview ? $('project-page').querySelector('.workbench-tabs') : null;
  if (tabs && tabs !== existingTabs) { existingTabs?.remove(); globalHeader.append(tabs); }
  else if (!tabs && (!activeOverview || existingTabs?.dataset.projectId !== String(project.id))) existingTabs?.remove();
  if (activeOverview) globalHeader.append(permission);
  else if (permission.parentElement !== locationBox) locationBox.insertBefore(permission, locationBox.querySelector('.console-section-picker'));
  globalHeader.hidden = !activeOverview;
  locationBox.hidden = !signedIn || activeOverview && !consoleMedia.matches;
  if (repo && me.role === 'super_admin' && !consoleGaps.has(String(repo.id))) setTimeout(() => loadConsoleGaps(String(repo.id)), 0);

  const scopeKey = project ? 'project:' + project.id : platform ? 'settings' : personal ? 'personal' : '';
  const secondary = project ? $('project-page').querySelector('.project-nav')
    : platform ? $('settings-panel').querySelector('.project-nav')
    : personal && typeof personalSettingsNav === 'function' ? personalSettingsNav() : null;
  if (secondary) {
    secondary.dataset.navScope = scopeKey;
    $('console-secondary-nav').replaceChildren(secondary);
  } else if (!scopeKey || project && !projectSettingsSections.some(([key]) => key === project.section) || $('console-secondary-nav').firstElementChild?.dataset.navScope !== scopeKey) {
    $('console-secondary-nav').replaceChildren();
  }
  $('console-secondary-nav').hidden = !$('console-secondary-nav').childElementCount;
  const nav = $('console-secondary-nav').querySelector('nav'), sectionPicker = $('console-section');
  $('console-section-label').hidden = !nav;
  sectionPicker.replaceChildren();
  // Work navigation and settings categories share the sidebar's role-aware source.
  if (project && repo) {
    $('console-section-label').hidden = false;
    const here = `#/projects/${project.id}/${project.section}`, caption = projectSectionCaption(project.section);
    for (const [title, items] of projectNavigationGroups()) {
      const group = document.createElement('optgroup'); group.label = title;
      for (const [key, name] of items) {
        const href = `#/projects/${project.id}/${key}`; group.append(new Option(name, href, false, href === here));
      }
      sectionPicker.append(group);
    }
    if (![...sectionPicker.options].some(option => option.value === here)) {
      const missing = new Option(caption || '找不到页面', here, true, true); missing.disabled = true; sectionPicker.prepend(missing);
    }
  } else if (nav) {
    let group = null;
    for (const child of nav.children) {
      if (child.classList.contains('console-nav-label')) {
        group = document.createElement('optgroup'); group.label = child.textContent; sectionPicker.append(group); continue;
      }
      if (child.matches?.('a')) (group || sectionPicker).append(new Option(child.textContent, child.getAttribute('href'), false, child.getAttribute('aria-current') === 'page'));
    }
  }
  syncConsoleMobileCurrent();
  $('console-sidebar').classList.toggle('console-platform', platform);
}
// #481: 更多 stands for every page the bar cannot carry, and 助手 is the assistant itself: while the chat is open the bar
// reports it as the current destination instead of naming a page underneath it.
function syncConsoleMobileCurrent() {
  const chat = typeof managementChatState === 'function' ? managementChatState() : null;
  const chosen = chat?.open ? 'assistant' : ['projects', 'board', 'inbox'].includes(tab) ? tab : ['design', 'not-found'].includes(tab) ? '' : 'more';
  for (const a of $('console-mobile-nav').querySelectorAll('a')) {
    if (['projects', 'board', 'inbox'].includes(a.dataset.page)) a.href = consolePageAddress(a.dataset.page);
    if (a.dataset.page === chosen) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
// The account menu is a small disclosure, not a dialog: Escape closes it and hands focus back to the control that opened
// it, and opening it moves focus inside so the keyboard reaches the entries without passing through the page behind.
function setAccountMenu(open) {
  const account = $('console-account'), menu = $('console-account-menu');
  if (!account || !menu) return;
  menu.hidden = !open; account.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) menu.querySelector('a, button')?.focus();
}
// The bar carries the live assistant state the floating launcher carries on wide screens: a turn in progress survives the
// chat being closed, and a reply that arrived while it was closed stays unread until the bar opens it again.
function updateConsoleAssistant() {
  const link = $('console-mobile-nav').querySelector('a[data-page="assistant"]'); if (!link) return;
  const chat = typeof managementChatState === 'function' ? managementChatState() : null;
  const running = !!chat?.active, unread = !running && !!chat?.unread;
  if (running) link.dataset.active = '1'; else delete link.dataset.active;
  if (unread) link.dataset.unread = '1'; else delete link.dataset.unread;
  link.setAttribute('aria-label', '助手' + (running ? ' · 正在处理' : unread ? ' · 未读' : ''));
  link.classList.toggle('console-nav-busy', running);
  syncConsoleMobileCurrent();
}
function renderConsoleMore() {
  const page = $('console-page'); page.replaceChildren();
  // Complete user-visible phrases, ready to move into a locale dictionary later (#527).
  const head = element('div', '', 'console-page-head'); head.append(element('p', '工作区', 'eyebrow'), element('h1', '更多功能'), element('p', '按工作内容找到入口，当前项目和权限范围会随你继续。', 'muted'));
  const groups = element('div', '', 'console-groups');
  for (const group of consoleGroups()) {
    const section = element('section', '', 'console-group'); if (group.wide) section.classList.add('console-group-wide');
    if (group.testid) section.dataset.testid = group.testid; section.append(element('h2', group.title));
    for (const [href, caption, hint] of group.items) {
      const link = consoleLink(href, caption, hint);
      const icon = consoleIcon(consoleIconName(href));
      icon.classList.add('console-nav-icon');
      const copy = element('div', '', 'console-link-copy');
      while (link.firstChild) copy.append(link.firstChild);
      link.append(icon, copy);
      link.classList.add('console-link-with-icon');
      section.append(link);
    }
    groups.append(section);
  }
  page.append(head, groups);
}
async function renderConsoleInbox(request) {
  const page = $('console-page'), match = consoleInboxRoute(), id = match?.[1] === 'all' ? '' : match?.[1] || '', offset = Number(match?.[2] || 0);
  const head = element('div', '', 'console-page-head'), title = element('div');
  title.append(element('p', '需要关注', 'eyebrow'), element('h1', '待处理'), element('p', '需要关注的真实任务；自动排队和正常执行不计入。具体操作以当前权限和任务回执为准。', 'muted'));
  head.append(title); page.replaceChildren(head);
  const filters = element('div', '', 'console-inbox-filters');
  filters.append(button('刷新待处理', () => renderConsoleInbox(++renderVersion))); page.append(filters);
  // #934: start requests (#933) wait for a super administrator before any task exists, so they head the inbox.
  if (!id && me.role === 'super_admin' && typeof renderStartRequests === 'function') {
    const requests = element('div', '', 'console-start-requests'); page.append(requests);
    void renderStartRequests(requests, () => request === renderVersion && tab === 'inbox' && requests.isConnected);
  }
  const body = element('div', '', 'console-inbox'); body.setAttribute('aria-busy', 'true');
  body.append(consoleState('正在读取待处理事项', '按当前授权范围读取任务记录。')); page.append(body);
  try {
    const params = new URLSearchParams({ attention: '1', limit: '51', offset: String(offset) }); if (id) params.set('repository_id', id);
    const result = await api('/api/tasks?' + params);
    if (request !== renderVersion || tab !== 'inbox' || !body.isConnected) return;
    const rows = result.tasks.slice(0, 50); body.replaceChildren();
    if (!rows.length) {
      body.append(consoleState('当前范围没有待处理任务', '这表示未发现上述等待或失败事项，不代表服务、CI 或其他任务已经全部成功。'));
      const next = element('div', '', 'console-inbox-next');
      next.append(consoleLink(consolePageAddress('board', id || null), '查看任务看板'), consoleLink(consolePageAddress('new-task', id || null), '新建任务'));
      body.append(next);
    } else {
      body.append(element('p', `本页 ${rows.length} 项 · 按最近状态变更时间从早到晚排列`, 'muted'));
      for (const row of rows) {
        body.append(consoleTaskRow(row, true));
      }
    }
    const paging = element('nav', '', 'console-inbox-paging'); paging.setAttribute('aria-label', '待处理分页');
    const href = next => id ? consolePageAddress('inbox', id) + '/' + next : '#/inbox/all/' + next;
    // The explicit "all" segment preserves an unscoped page when navigating pagination links.
    if (offset) paging.append(consoleLink(href(Math.max(0, offset - 50)), '上一页'));
    if (result.tasks.length > 50) paging.append(consoleLink(href(offset + 50), '下一页'));
    body.append(paging);
  } catch (err) {
    if (request !== renderVersion || !body.isConnected) return;
    body.replaceChildren(consoleState('待处理事项未能读取', readErrorText(err) + '。尚不能判断是否有待处理任务。', { tone: 'error', retry: () => renderConsoleInbox(++renderVersion) }));
  } finally { body.removeAttribute('aria-busy'); }
}
async function renderConsolePage(request) {
  if (tab === 'not-found') renderNotFoundPage();
  else if (tab === 'task') await renderTaskRoute(request);
  else if (tab === 'new-task') await renderNewTask(request);
  else if (tab === 'conversations') await renderChannelConsole(request);
  else if (tab === 'more') renderConsoleMore();
  else if (tab === 'repository-onboarding') await renderRepositoryOnboarding(request);
  else {
    await renderConsoleInbox(request);
    const origin = consoleInboxReturn;
    if (request === renderVersion && tab === 'inbox' && origin?.actor === me && origin.address === location.hash) {
      consoleInboxReturn = null; restoreInboxPosition(origin);
    }
  }
}
// Keep only position/focus metadata in memory: never persist field values, passwords or credentials.
function rememberConsolePosition() {
  if (!me || !consoleRouteKey) return;
  consolePositions.set(consoleRouteKey, { y: scrollY, focus: document.activeElement?.id });
}
function restoreConsolePosition() {
  if (consoleRouteKey === location.hash) return;
  consoleRouteKey = location.hash;
  if (typeof hasPendingTaskReturn === 'function' && hasPendingTaskReturn()) return;
  const key = consoleRouteKey, saved = consolePositions.get(key);
  requestAnimationFrame(() => {
    if (location.hash !== key) return;
    if (typeof hasPendingTaskReturn === 'function' && hasPendingTaskReturn()) return;
    scrollTo(0, saved?.y || 0);
    if (saved?.focus) document.getElementById(saved.focus)?.focus({ preventScroll: true });
  });
}

// #554: one linear SVG set for workspace navigation. Icons are decorative
// (aria-hidden); the visible caption remains the accessible name. The five
// mobile destinations and their addresses stay as #481 defined them.
function consoleIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'console-icon console-icon-' + name);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shapes = (consoleIcon.shapes[name] || consoleIcon.shapes.link);
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}
consoleIcon.shapes = {
  home: [['path', { d: 'M4 11.5 12 4l8 7.5' }], ['path', { d: 'M6 10.8V20a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1v-9.2' }]],
  board: [['rect', { x: '3.5', y: '4', width: '5', height: '16', rx: '1' }], ['rect', { x: '9.5', y: '4', width: '5', height: '10', rx: '1' }], ['rect', { x: '15.5', y: '4', width: '5', height: '13', rx: '1' }]],
  inbox: [['path', { d: 'M4 13h4l1.2 2.4a1 1 0 0 0 .9.6h3.8a1 1 0 0 0 .9-.6L16 13h4' }], ['path', { d: 'M5.5 13 7 20h10l1.5-7' }], ['path', { d: 'M12 4v8' }], ['path', { d: 'M8.5 8.5 12 12l3.5-3.5' }]],
  more: [['circle', { cx: '6.5', cy: '6.5', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '12', cy: '6.5', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '17.5', cy: '6.5', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '6.5', cy: '12', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '12', cy: '12', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '17.5', cy: '12', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '6.5', cy: '17.5', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '12', cy: '17.5', r: '1.45', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '17.5', cy: '17.5', r: '1.45', fill: 'currentColor', stroke: 'none' }]],
  chat: [['path', { d: 'M5 6h14a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H9l-4.5 3.2V8a2 2 0 0 1 2-2z' }]],
  messages: [['path', { d: 'M7 15.5H5.5A1.5 1.5 0 0 1 4 14V6.5A1.5 1.5 0 0 1 5.5 5h11A1.5 1.5 0 0 1 18 6.5V8' }], ['path', { d: 'M8 10h11.5A1.5 1.5 0 0 1 21 11.5V18a1.5 1.5 0 0 1-1.5 1.5H14l-3.5 2.4V19.5H9.5A1.5 1.5 0 0 1 8 18z' }]],
  chart: [['path', { d: 'M4 19V5' }], ['path', { d: 'M4 19h16' }], ['path', { d: 'M8 19v-6' }], ['path', { d: 'M12 19V8' }], ['path', { d: 'M16 19v-9' }]],
  webhook: [['circle', { cx: '6.5', cy: '12', r: '2.4' }], ['circle', { cx: '17.5', cy: '6.5', r: '2.4' }], ['circle', { cx: '17.5', cy: '17.5', r: '2.4' }], ['path', { d: 'M8.7 11.1 15.3 7.5' }], ['path', { d: 'M8.7 12.9 15.3 16.5' }]],
  user: [['circle', { cx: '12', cy: '8', r: '3.2' }], ['path', { d: 'M5 19.5c0-3.3 3.1-5.7 7-5.7s7 2.4 7 5.7' }]],
  users: [['circle', { cx: '9', cy: '8', r: '2.8' }], ['path', { d: 'M3.5 19c0-2.9 2.5-5 5.5-5s5.5 2.1 5.5 5' }], ['circle', { cx: '16.5', cy: '8.5', r: '2.3' }], ['path', { d: 'M15 14.2c2.4.4 4.5 2.1 4.5 4.8' }]],
  gear: [['circle', { cx: '12', cy: '12', r: '3' }], ['path', { d: 'M12 3.5v2.2M12 18.3v2.2M4.9 6.5l1.6 1.6M17.5 15.9l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.9 17.5l1.6-1.6M17.5 8.1l1.6-1.6' }]],
  plus: [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }], ['path', { d: 'M12 8v8M8 12h8' }]],
  badge: [['path', { d: 'M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v10.2l-6.5 4-6.5-4V6A1.5 1.5 0 0 1 7 4.5z' }], ['circle', { cx: '12', cy: '10', r: '2.1' }], ['path', { d: 'M8.8 16c.7-1.3 1.9-2 3.2-2s2.5.7 3.2 2' }]],
  plug: [['path', { d: 'M9 7V3M15 7V3' }], ['path', { d: 'M8 7h8v5.5a4 4 0 0 1-3 3.87V21h-2v-4.63A4 4 0 0 1 8 12.5z' }]],
  drive: [['rect', { x: '3.5', y: '6', width: '17', height: '12', rx: '2' }], ['path', { d: 'M3.5 13h17' }], ['circle', { cx: '16.5', cy: '16', r: '1' }]],
  package: [['path', { d: 'M4.5 8.5 12 4.5l7.5 4V16.5L12 20.5 4.5 16.5z' }], ['path', { d: 'M12 20.5v-8' }], ['path', { d: 'M4.5 8.5 12 12.5l7.5-4' }]],
  book: [['path', { d: 'M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16.5H7.5A2.5 2.5 0 0 0 5 21z' }], ['path', { d: 'M5 5.5v15.5' }], ['path', { d: 'M8.5 7.5h7' }]],
  pulse: [['path', { d: 'M3 12h4l2-6 4 12 2-6h6' }]],
  sliders: [['path', { d: 'M5 8h14M5 16h14' }], ['circle', { cx: '9', cy: '8', r: '2' }], ['circle', { cx: '15', cy: '16', r: '2' }]],
  calendar: [['rect', { x: '4', y: '5', width: '16', height: '15', rx: '2' }], ['path', { d: 'M8 3v4M16 3v4M4 10h16' }]],
  monitor: [['rect', { x: '3.5', y: '4', width: '17', height: '12', rx: '1.5' }], ['path', { d: 'M8 20h8M12 16v4' }]],
  cpu: [['rect', { x: '7', y: '7', width: '10', height: '10', rx: '1.5' }], ['path', { d: 'M12 3.5v3.5M12 17v3.5M3.5 12H7M17 12h3.5M6.2 6.2l2 2M15.8 15.8l2 2M17.8 6.2l-2 2M8.2 15.8l-2 2' }]],
  map: [['path', { d: 'M9 4.5 3.5 7v13L9 17.5 15 20.5 20.5 18V5L15 7.5z' }], ['path', { d: 'M9 4.5v13M15 7.5v13' }]],
  bot: [['rect', { x: '5', y: '8', width: '14', height: '11', rx: '2.5' }], ['path', { d: 'M12 8V4.5M9.5 4.5h5' }], ['circle', { cx: '9.2', cy: '13', r: '1' }], ['circle', { cx: '14.8', cy: '13', r: '1' }]],
  download: [['path', { d: 'M12 4v11' }], ['path', { d: 'M8 11.5 12 15.5 16 11.5' }], ['path', { d: 'M5 19h14' }]],
  folder: [['path', { d: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h5l2 2.5h7A1.5 1.5 0 0 1 20.5 10v7.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z' }]],
  message: [['path', { d: 'M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8A1.5 1.5 0 0 1 19 16.5H9L5 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z' }]],
  link: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M12 8v8M8 12h8' }]],
  // consoleState() marks: an empty tray, and an alert for a failed read.
  tray: [['path', { d: 'M4 13h4l1.2 2.4a1 1 0 0 0 .9.6h3.8a1 1 0 0 0 .9-.6L16 13h4' }], ['path', { d: 'M5.5 13 7 20h10l1.5-7' }], ['path', { d: 'M12 4v8' }], ['path', { d: 'M8.5 8.5 12 12l3.5-3.5' }]],
  alert: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 8v5M12 16.5h.01' }]]
};
function consoleIconName(href) {
  const path = String(href || '').replace(/^#/, '');
  if (/^\/projects\/[^/]+\/overview/.test(path) || path === '/projects') return 'home';
  if (/\/board(?:\/|$)/.test(path)) return 'board';
  if (/\/new-task(?:\/|$)/.test(path)) return 'plus';
  if (/\/inbox(?:\/|$)/.test(path)) return 'inbox';
  if (/\/management(\/|$)/.test(path) || path === '/management') return 'chat';
  if (/^\/conversations/.test(path)) return 'messages';
  if (/\/costs(?:\/|$)/.test(path)) return 'chart';
  if (/feishu/.test(path)) return 'message';
  if (/^\/identity/.test(path)) return 'badge';
  if (/\/external(\/|$)/.test(path)) return 'plug';
  if (/storage/.test(path)) return 'drive';
  if (/^\/preferences/.test(path)) return 'user';
  if (/\/release(\/|$)/.test(path)) return 'package';
  if (/\/knowledge(\/|$)/.test(path)) return 'book';
  if (/\/activity(\/|$)/.test(path)) return 'pulse';
  if (/\/roles(\/|$)/.test(path)) return 'users';
  if (/\/model(\/|$)/.test(path) || /\/models(\/|$)/.test(path)) return 'cpu';
  if (/machine|work-computers|assistant-computers/.test(path)) return 'monitor';
  if (/schedules/.test(path)) return 'calendar';
  if (/\/members(\/|$)/.test(path) || /\/users(\/|$)/.test(path)) return 'users';
  if (/\/basic(\/|$)/.test(path) || /service-roles/.test(path)) return 'sliders';
  if (/onboarding/.test(path)) return 'map';
  if (/\/accounts(\/|$)/.test(path)) return 'bot';
  if (/installations/.test(path)) return 'download';
  if (/\/access(\/|$)/.test(path)) return 'plug';
  if (/^\/settings\/projects/.test(path)) return 'folder';
  if (/^\/settings/.test(path)) return 'gear';
  if (/^\/projects\//.test(path)) return 'folder';
  return 'link';
}

function initConsoleShell() {
  const sidebar = $('console-sidebar');
  initScopePicker();
  const scopeCaption = element('span', t('nav.switch_project')); scopeCaption.setAttribute('data-i18n', 'nav.switch_project');
  const scope = element('div', '', 'console-project-picker'); scope.append(scopeCaption, scopePickerButton('console-project'));
  const tabs = $('tabs'), primary = element('div', '', 'console-primary-nav'), settings = element('div', '', 'console-settings-nav');
  settings.setAttribute('role', 'group'); settings.setAttribute('aria-label', t('nav.settings_group'));
  settings.setAttribute('data-i18n', 'nav.settings_group'); settings.setAttribute('data-i18n-attr', 'aria-label');
  tabs.replaceChildren(primary, settings); sidebar.append(scope, tabs);
  const globalHeader = element('div', '', 'console-project-header'); globalHeader.id = 'console-project-header'; globalHeader.hidden = true;
  document.querySelector('body > header').insertBefore(globalHeader, $('header-tools'));
  const locationBox = element('div', '', 'console-location'); locationBox.id = 'console-location'; locationBox.hidden = true;
  const area = element('span', '', 'eyebrow'), context = element('span'); area.id = 'console-area'; context.id = 'console-context';
  const permission = element('span', '', 'console-permission'); permission.id = 'console-permission';
  locationBox.append(area, context, permission);
  const secondary = element('div', '', 'console-secondary-nav'); secondary.id = 'console-secondary-nav'; secondary.hidden = true;
  const mobileScope = element('div', '', 'console-mobile-scope'); mobileScope.id = 'console-mobile-scope'; mobileScope.hidden = true;
  mobileScope.append(scopePickerButton('console-mobile-project'));
  $('main-content').prepend(mobileScope, locationBox, secondary);
  // The fixed assistant page and the board's filter scroller share the space the mobile range bar consumes.
  new ResizeObserver(() => {
    const height = mobileScope.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--console-scope-height', height ? Math.ceil(height + 12) + 'px' : '0px');
  }).observe(mobileScope);
  const sectionCaption = element('span', t('nav.current_page')); sectionCaption.setAttribute('data-i18n', 'nav.current_page');
  const section = element('label', '', 'console-section-picker'); section.append(sectionCaption);
  const sectionPicker = document.createElement('select'); section.id = 'console-section-label'; sectionPicker.id = 'console-section'; sectionPicker.setAttribute('aria-label', t('nav.current_page')); sectionPicker.setAttribute('data-i18n', 'nav.current_page'); sectionPicker.setAttribute('data-i18n-attr', 'aria-label'); section.hidden = true;
  sectionPicker.addEventListener('change', () => { location.hash = sectionPicker.value; }); section.append(sectionPicker); locationBox.append(section);
  // #481: five destinations own the phone's navigation. Linear SVG icons (#554) are decorative; the link's text —
  // and its accessible name — is exactly its destination, and the badge stays decorative.
  const mobile = element('nav', '', 'console-mobile-nav'); mobile.id = 'console-mobile-nav'; mobile.hidden = true; mobile.setAttribute('aria-label', t('nav.mobile')); mobile.setAttribute('data-i18n', 'nav.mobile'); mobile.setAttribute('data-i18n-attr', 'aria-label');
  for (const [key, href, captionKey, iconName] of [
    ['projects', '#/projects', 'nav.projects', 'home'], ['board', '#/board', 'nav.tasks_short', 'board'], ['inbox', '#/inbox', 'nav.inbox', 'inbox'],
    ['assistant', '#/management', 'nav.assistant', 'chat'], ['more', '#/more', 'nav.more_short', 'more']]) {
    const caption = t(captionKey);
    const a = consoleLink(href, caption);
    a.dataset.page = key; a.setAttribute('aria-label', caption);
    const icon = consoleIcon(iconName); icon.classList.add('console-nav-icon'); a.prepend(icon);
    const mobileLabel = [...a.querySelectorAll('span')].find(s => !s.classList.contains('console-nav-badge'));
    if (mobileLabel) mobileLabel.setAttribute('data-i18n', captionKey);
    const badge = element('span', '', 'console-nav-badge'); badge.setAttribute('aria-hidden', 'true'); a.append(badge);
    // 助手 opens the assistant in place: it is a destination of the shell, not an address the reader leaves the page for.
    if (key === 'assistant') a.addEventListener('click', event => {
      event.preventDefault();
      if (typeof openManagementChat === 'function') Promise.resolve(openManagementChat()).catch(error);
    });
    mobile.append(a);
  }
  document.body.append(mobile);
  // #481: the phone header cannot carry a login, a role and a separate sign-out button. They move into one account menu
  // that opens from a single control; the working sign-out handler stays the one the header always had.
  const identity = $('identity');
  const account = button('', () => setAccountMenu($('console-account-menu').hidden), 'quiet console-account');
  account.id = 'console-account'; account.setAttribute('aria-expanded', 'false');
  account.setAttribute('aria-controls', 'console-account-menu'); account.setAttribute('aria-label', t('chrome.account_menu')); account.setAttribute('data-i18n', 'chrome.account_menu'); account.setAttribute('data-i18n-attr', 'aria-label');
  const mark = element('span', '⋯', 'console-account-mark'); mark.setAttribute('aria-hidden', 'true'); account.append(mark);
  const accountMenu = element('div', '', 'console-account-menu'); accountMenu.id = 'console-account-menu'; accountMenu.hidden = true;
  const accountLogin = element('p', '', 'console-account-login'), accountRole = element('p', '', 'console-account-role');
  accountLogin.id = 'console-account-login'; accountRole.id = 'console-account-role';
  const accountPrefs = consoleLink('#/identity', t('nav.identity'));
  const accountPrefsLabel = accountPrefs.querySelector('span'); if (accountPrefsLabel) accountPrefsLabel.setAttribute('data-i18n', 'nav.identity');
  accountMenu.append(accountLogin, accountRole, accountPrefs, button(t('chrome.logout'), () => $('logout').click(), 'quiet console-account-signout'));
  identity.append(account, accountMenu);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || $('console-account-menu').hidden) return;
    event.preventDefault(); setAccountMenu(false); $('console-account').focus();
  });
  document.addEventListener('click', event => {
    const menu = $('console-account-menu');
    if (!menu.hidden && !event.target.closest('#identity')) setAccountMenu(false);
  });
  // Defer focus transfer until click so restored mobile navigation cannot steal pointer-up.
  // Commit the editor's change before the button handler captures a command or submitted draft.
  let pressedAction = null;
  document.addEventListener('pointerdown', event => {
    pressedAction = null;
    const control = event.target.closest('button'), focused = document.activeElement;
    if (consoleMedia.matches && document.body.classList.contains('console-ready') && event.button === 0
      && control && focused.matches('input,textarea')) {
      event.preventDefault(); pressedAction = control;
    }
  });
  document.addEventListener('pointercancel', () => { pressedAction = null; });
  document.addEventListener('click', event => {
    const control = event.target.closest('button');
    if (control && control === pressedAction) control.focus({ preventScroll: true });
    pressedAction = null;
  }, true);
  document.addEventListener('click', event => { if (event.target.closest('a[href^="#/"], [data-tab]')) rememberConsolePosition(); }, true);
  addEventListener('scroll', rememberConsolePosition, { passive: true });
  // The browser's native modal focus restoration is retained; Escape keeps each existing dialog's semantics.
  document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); $('main-content').focus(); });
  consoleMedia.addEventListener('change', () => syncConsoleShell());
}
initConsoleShell();
