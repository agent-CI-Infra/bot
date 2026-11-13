// Shared navigation wraps the existing console; business pages keep their routes and renderers.
const consoleMedia = matchMedia('(max-width:767px)');
let consoleOwner = null, consoleProject = null, consoleNavSignature = '', consoleRouteKey = null;
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
function consoleInboxRoute() { return /^#\/inbox(?:\/(all|[1-9]\d*))?(?:\/(\d+))?$/.exec(location.hash); }
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
function taskOriginCaption(origin) {
  const source = origin.conversation_id ? '连续会话 ' + origin.conversation_id : origin.source_kind;
  return '来源：' + source + ' · ' + (origin.source_role || '操作者') + ' → ' + (origin.executor_role || '原执行流程') +
    (origin.source_role && origin.source_role === origin.executor_role ? '（自己执行）' : origin.source_role && origin.executor_role ? '（委派）' : '');
}
function consoleScope() {
  const inbox = consoleInboxRoute();
  return projectRoute()?.id || (inbox ? (inbox[1] === 'all' ? null : inbox[1]) : consoleProject);
}
// #481: the phone's bottom bar owns the five primary destinations (项目 / 任务 / 待处理 / 助手 / 更多), so this page is
// the supplement behind 更多. It must not repeat what the bar already carries, and it stays short enough to read on a
// phone. #549: a project administrator's 更多 is only personal settings — webhook, usage, storage and the external
// runner belong to the management area (#550), and project sections stay on the project page and 当前页面 picker.
function consoleGroups() {
  const id = consoleScope(), repo = repositories.find(r => String(r.id) === id);
  const groups = [];
  const personal = [
    ['#/preferences', '个人设置', '个人身份、飞书绑定与外部执行端'],
    ['#/identity/feishu', '飞书绑定', '个人绑定、群绑定、仓库权限与聊天记录'],
    ['#/identity', '身份与权限', '本人绑定与当前有效授权'],
    ['#/conversations', '飞书会话', '成员消息、执行过程与派生任务']
  ];
  // #550: webhook, usage, storage, the external runner and (for a super administrator) onboarding,
  // installation archives and robot accounts live in one 管理 group. Permissions are unchanged:
  // a project administrator only sees the pages their role can already open.
  const management = [
    ['#/costs', '用量与成本', '按项目、日期与工作类型查看'],
    ['#/events', 'Webhook 投递', '接收、验证和处理结果'],
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
  if (me.role !== 'super_admin') {
    groups.push({ title: '设置', wide: true, items: personal }, { ...adminGroup, wide: true });
    return groups;
  }
  // 管理对话 is the bar's 助手 destination, and each project section is one address the phone can reach from here.
  if (repo) groups.push({ title: '当前项目', items: projectSections
    .filter(([key]) => key !== 'management')
    .map(([key, name]) => [`#/projects/${id}/${key}`, name, repo.full_name]) });
  // `wide` (#557) keys the full-row layout on the group itself: 当前项目 and 个人与平台 share the first row, and the
  // longer 管理 group (#550) spans the full row under them with its entries in three columns.
  groups.push({ title: '个人与平台', items: personal }, { ...adminGroup, wide: true });
  return groups;
}
// #549: a project administrator's desktop primary nav is 项目 / 管理对话 / 看板 / 待处理, plus a visible
// 更多功能 entry so 个人设置 stays reachable at desktop widths (the account menu is phone-only).
// 统计, Webhook, 个人设置 and 存储 leave the sidebar itself; they remain in 更多 (and, for super
// administrators, in the pinned settings nav).
function applyConsoleNavVisibility() {
  if (!me) return;
  const isSuper = me.role === 'super_admin';
  for (const tab of ['costs', 'events', 'preferences', 'settings']) {
    const node = document.querySelector('#tabs [data-tab="' + tab + '"]');
    if (node) node.hidden = !isSuper;
  }
  const more = document.getElementById('console-more-link') || document.querySelector('#tabs [data-tab="more"]');
  if (more) more.hidden = isSuper;
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
  if (!signedIn || consoleOwner !== me.id) {
    if (typeof resetTaskCreation === 'function') resetTaskCreation();
    if (typeof resetGateOnboarding === 'function') resetGateOnboarding();
    if (typeof resetKnowledgeFiles === 'function') resetKnowledgeFiles();
    if (typeof resetScheduleViews === 'function') resetScheduleViews();
    if (typeof resetBoard === 'function') resetBoard();
    if (typeof resetPersonalApps === 'function') resetPersonalApps();
    consoleOwner = me?.id || null; consoleProject = null; consoleNavSignature = ''; consolePositions.clear(); consoleRouteKey = null;
    // #480: the shared default is this session's choice, so a different user never inherits it.
    if (typeof setConsoleDefaultProject === 'function') setConsoleDefaultProject(null);
    const clearedPicker = $('console-project'); if (clearedPicker) clearedPicker.value = '';
    $('console-secondary-nav').replaceChildren(); $('console-page').replaceChildren();
    setAccountMenu(false);
    // #481: the bar's assistant state belongs to one session. A different owner starts idle and read, so a turn left
    // running or a reply left unread by the previous user never survives the sign-out.
    updateConsoleAssistant();
  }
  if (!signedIn) return;
  applyConsoleNavVisibility();
  // The menu names the same person the header used to print beside the sign-out button.
  $('console-account-login').textContent = '@' + (me.github?.login || me.username);
  $('console-account-role').textContent = me.role === 'super_admin' ? t('role.super_admin') : t('role.project_admin');
  const project = projectRoute(), inbox = consoleInboxRoute();
  const routed = project?.id || (inbox ? (inbox[1] === 'all' ? null : inbox[1]) : null) || null;
  // #480: the address wins where it names a project; the board, costs and management pages follow the shell picker.
  // A page that names no project keeps the project the reader last stood in, and only a chosen default replaces it.
  if (project || inbox) {
    consoleProject = routed;
    // The picker shows this project, so it is also the default the board, costs and management read. An address that
    // names a project must not leave those three describing another one.
    if (routed && typeof setConsoleDefaultProject === 'function') setConsoleDefaultProject(routed);
    // #494: an inbox address that names no project shows 「全部项目」 in the picker, so the shared default has to become empty
    // as well. Otherwise the picker, the board, usage and the assistant would read two different values for one choice.
    else if (inbox && typeof setConsoleDefaultProject === 'function') setConsoleDefaultProject(null);
  } else if (typeof consoleDefaultProject === 'function' && consoleDefaultProject()) consoleProject = consoleDefaultProject();
  const repo = repositories.find(r => String(r.id) === consoleProject);
  // A revoked project is never kept in the project picker merely because it was selected earlier.
  if (!repo && consoleProject) { consoleProject = null; if (typeof setConsoleDefaultProject === 'function') setConsoleDefaultProject(null); }
  // A GitHub full name carries its owner, so the picker groups by organization without asking for another projection:
  // the same repository name can arrive from two owners and then must not look like one project.
  const organization = r => (r.full_name || '').includes('/') ? r.full_name.split('/')[0] : (r.account_name || '其他组织');
  const signature = JSON.stringify([me.id, consoleProject, typeof currentLocale === 'function' ? currentLocale() : '', repositories.map(r => [r.id, r.full_name, organization(r)])]);
  if (signature !== consoleNavSignature) {
    consoleNavSignature = signature;
    const picker = $('console-project'); picker.replaceChildren(new Option(t('nav.all_projects'), ''));
    const groups = new Map();
    for (const r of repositories) { const name = organization(r); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(r); }
    for (const [name, rows] of [...groups].sort((left, right) => left[0].localeCompare(right[0]))) {
      const group = document.createElement('optgroup'); group.label = name;
      for (const r of rows) group.append(new Option(r.full_name, r.id));
      picker.append(group);
    }
    picker.value = consoleProject || '';
  }
  const platform = tab === 'settings', personal = !project && ['preferences', 'identity', 'external', 'conversations'].includes(tab);
  $('console-project').closest('label').hidden = platform;
  $('console-area').textContent = platform ? t('nav.platform') : project ? t('nav.project_workspace') : personal ? t('nav.personal') : t('nav.workspace');
  // The scope bar names both halves of the current address: a project name alone does not say which organization it is in.
  const shortName = r => (r.full_name || '').includes('/') ? r.full_name.split('/').slice(1).join('/') : r.full_name;
  const personalTitle = /^#\/identity\/feishu-apps(?:\/|$)/.test(location.hash) ? t('nav.feishu_apps')
    : /^#\/identity\/feishu(?:$|\?|\/)/.test(location.hash) ? t('nav.feishu') : t('identity.title');
  // An installed repository nobody has started is no project yet; its cached installation row still names it.
  const unstarted = project && !repo ? consoleGaps.get(String(project.id)) : null;
  $('console-context').textContent = project ? (repo ? organization(repo) + ' · ' + shortName(repo)
    : unstarted?.registered === false ? organization(unstarted) + ' · ' + shortName(unstarted) + ' · ' + t('nav.unstarted')
      : typeof current !== 'undefined' && current?.unavailable && String(current.id) === String(project.id) ? t(current.unavailable === 'missing' ? 'nav.project_not_found' : 'nav.project_unavailable') : t('nav.reading_project'))
    : tab === 'identity' || tab === 'preferences' ? personalTitle : ({ more: t('nav.more'), inbox: t('nav.inbox'), settings: t('nav.settings') }[tab] || titles[tab] || t('identity.title'));
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
  if (repo && me.role === 'super_admin' && !consoleGaps.has(String(repo.id))) setTimeout(() => loadConsoleGaps(String(repo.id)), 0);

  $('console-inbox-link').href = '#/inbox' + (consoleProject ? '/' + consoleProject : '');
  const scopeKey = project ? 'project:' + project.id : platform ? 'settings' : personal ? 'personal' : '';
  const secondary = project ? $('project-page').querySelector('.project-nav')
    : platform ? $('settings-panel').querySelector('.project-nav')
    : personal && typeof personalSettingsNav === 'function' ? personalSettingsNav() : null;
  if (secondary) {
    secondary.dataset.navScope = scopeKey;
    $('console-secondary-nav').replaceChildren(secondary);
  } else if (!scopeKey || $('console-secondary-nav').firstElementChild?.dataset.navScope !== scopeKey) {
    $('console-secondary-nav').replaceChildren();
  }
  $('console-secondary-nav').hidden = !$('console-secondary-nav').childElementCount;
  const nav = $('console-secondary-nav').querySelector('nav'), sectionPicker = $('console-section');
  $('console-section-label').hidden = !nav;
  sectionPicker.replaceChildren();
  // #481: the picker keeps the groups the page's own navigation draws, so a long project page stays readable on a phone
  // instead of flattening every entry into one list.
  if (nav) {
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
  const chosen = chat?.open ? 'assistant' : ['projects', 'board', 'inbox'].includes(tab) ? tab : tab === 'design' ? '' : 'more';
  for (const a of $('console-mobile-nav').querySelectorAll('a')) {
    if (a.dataset.page === 'inbox') a.href = '#/inbox' + (consoleProject ? '/' + consoleProject : '');
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
    for (const [href, caption, hint] of group.items) section.append(consoleLink(href, caption, hint)); groups.append(section);
  }
  page.append(head, groups);
}
async function renderConsoleInbox(request) {
  const page = $('console-page'), match = consoleInboxRoute(), id = match?.[1] === 'all' ? '' : match?.[1] || '', offset = Number(match?.[2] || 0);
  const head = element('div', '', 'console-page-head'), title = element('div');
  title.append(element('p', '需要关注', 'eyebrow'), element('h1', '待处理'), element('p', '需要关注的真实任务；自动排队和正常执行不计入。具体操作以当前权限和任务回执为准。', 'muted'));
  head.append(title); page.replaceChildren(head);
  const filters = element('div', '', 'console-inbox-filters'), label = element('label', '项目'), picker = document.createElement('select');
  picker.add(new Option('所有有权访问的项目', '')); repositories.forEach(r => picker.add(new Option(r.full_name, r.id))); picker.value = id;
  picker.addEventListener('change', () => { location.hash = '#/inbox' + (picker.value ? '/' + picker.value : ''); }); label.append(picker);
  filters.append(label, button('刷新待处理', () => renderConsoleInbox(++renderVersion))); page.append(filters);
  const body = element('div', '', 'console-inbox'); body.setAttribute('aria-busy', 'true');
  body.append(consoleState('正在读取待处理事项', '按当前授权范围读取任务记录。')); page.append(body);
  try {
    const params = new URLSearchParams({ attention: '1', limit: '51', offset: String(offset) }); if (id) params.set('repository_id', id);
    const result = await api('/api/tasks?' + params);
    if (request !== renderVersion || tab !== 'inbox' || !body.isConnected) return;
    const rows = result.tasks.slice(0, 50); body.replaceChildren();
    if (!rows.length) body.append(consoleState('当前范围没有待处理任务', '这表示未发现上述等待或失败事项，不代表服务、CI 或其他任务已经全部成功。'));
    else {
      body.append(element('p', `本页 ${rows.length} 项 · 按最近状态变更时间从早到晚排列`, 'muted'));
      for (const row of rows) {
        body.append(consoleTaskRow(row, true));
      }
    }
    const paging = element('nav', '', 'console-inbox-paging'); paging.setAttribute('aria-label', '待处理分页');
    const href = next => '#/inbox/' + (id || 'all') + '/' + next;
    // The explicit "all" segment preserves an unscoped page when navigating pagination links.
    if (offset) paging.append(consoleLink(href(Math.max(0, offset - 50)), '上一页'));
    if (result.tasks.length > 50) paging.append(consoleLink(href(offset + 50), '下一页'));
    body.append(paging);
  } catch (err) {
    if (request !== renderVersion || !body.isConnected) return;
    body.replaceChildren(consoleState('待处理事项未能读取', err.message + '。尚不能判断是否有待处理任务。', { tone: 'error', retry: () => renderConsoleInbox(++renderVersion) }));
  } finally { body.removeAttribute('aria-busy'); }
}
async function renderConsolePage(request) {
  if (tab === 'new-task') await renderNewTask(request);
  else if (tab === 'conversations') await renderChannelConsole(request);
  else if (tab === 'more') renderConsoleMore();
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
  const key = consoleRouteKey, saved = consolePositions.get(key);
  requestAnimationFrame(() => {
    if (location.hash !== key) return;
    scrollTo(0, saved?.y || 0);
    if (saved?.focus) document.getElementById(saved.focus)?.focus({ preventScroll: true });
  });
}
function initConsoleShell() {
  const sidebar = $('console-sidebar');
  const kicker = element('p', t('nav.workspace'), 'console-nav-label'); kicker.setAttribute('data-i18n', 'nav.workspace');
  const scopeCaption = element('span', t('nav.switch_project')); scopeCaption.setAttribute('data-i18n', 'nav.switch_project');
  const scope = element('label', '', 'console-project-picker'); scope.append(scopeCaption);
  const picker = document.createElement('select');
  picker.id = 'console-project'; picker.setAttribute('aria-label', t('nav.switch_project')); picker.setAttribute('data-i18n', 'nav.switch_project'); picker.setAttribute('data-i18n-attr', 'aria-label');
  // #480: the picker is the console-wide default. The board and the usage page read that default, so choosing a project
  // there re-reads the page in place and keeps the reader where the scope applies; the management assistant follows the
  // default itself (its own scope control and conversation move together), so re-rendering that page would open a second
  // conversation for one choice. Every other page is a navigation surface, unchanged: it opens the chosen project (or the
  // projects list), because its address names what it shows.
  picker.addEventListener('change', () => {
    const id = picker.value || null;
    if (typeof setConsoleDefaultProject === 'function') setConsoleDefaultProject(id);
    consoleProject = id;
    if (/^#\/(board|costs)(\/|$)/.test(location.hash)) route().catch(error);
    // The open assistant follows the default itself, so this page is not re-rendered. The console link that names the
    // project comes from that same default and is written only in syncConsoleShell(), so it is refreshed here too (#494).
    else if (/^#\/management(\/|$)/.test(location.hash)) syncConsoleShell();
    else location.hash = id ? `#/projects/${id}/overview` : '#/projects';
  }); scope.append(picker);
  const tabs = $('tabs'), primary = element('div', '', 'console-primary-nav'), settings = element('div', '', 'console-settings-nav');
  settings.setAttribute('role', 'group'); settings.setAttribute('aria-label', t('nav.settings_group')); settings.setAttribute('data-i18n', 'nav.settings_group'); settings.setAttribute('data-i18n-attr', 'aria-label');
  settings.append(tabs.querySelector('[data-tab=preferences]'), tabs.querySelector('[data-tab=settings]'));
  primary.append(kicker, ...tabs.children);
  const inbox = consoleLink('#/inbox', t('nav.inbox')); inbox.id = 'console-inbox-link'; const inboxLabel = inbox.querySelector('span'); if (inboxLabel) inboxLabel.setAttribute('data-i18n', 'nav.inbox'); primary.append(inbox);
  // Project administrators have no pinned 个人设置 / 全局设置 and the account menu is phone-only, so
  // 更多功能 has to stay visible in the desktop sidebar or those pages have no on-screen entry.
  const more = consoleLink('#/more', t('nav.more'));
  const moreLabel = more.querySelector('span'); if (moreLabel) moreLabel.setAttribute('data-i18n', 'nav.more');
  more.id = 'console-more-link';
  more.dataset.tab = 'more';
  more.dataset.testid = 'console-more-link';
  primary.append(more);
  // Keep the original tabs and their click handling, but let only the work navigation scroll above the settings.
  tabs.replaceChildren(primary, settings); sidebar.append(scope, tabs);
  const locationBox = element('div', '', 'console-location'); locationBox.id = 'console-location'; locationBox.hidden = true;
  const area = element('span', '', 'eyebrow'), context = element('span'); area.id = 'console-area'; context.id = 'console-context';
  const permission = element('span', '', 'console-permission'); permission.id = 'console-permission';
  locationBox.append(area, context, permission);
  const secondary = element('div', '', 'console-secondary-nav'); secondary.id = 'console-secondary-nav'; secondary.hidden = true;
  $('main-content').prepend(locationBox, secondary);
  const sectionCaption = element('span', t('nav.current_page')); sectionCaption.setAttribute('data-i18n', 'nav.current_page');
  const section = element('label', '', 'console-section-picker'); section.append(sectionCaption);
  const sectionPicker = document.createElement('select'); section.id = 'console-section-label'; sectionPicker.id = 'console-section'; sectionPicker.setAttribute('aria-label', t('nav.current_page')); sectionPicker.setAttribute('data-i18n', 'nav.current_page'); sectionPicker.setAttribute('data-i18n-attr', 'aria-label'); section.hidden = true;
  sectionPicker.addEventListener('change', () => { location.hash = sectionPicker.value; }); section.append(sectionPicker); locationBox.append(section);
  // #481: five destinations own the phone's navigation. The glyph is drawn by CSS from data-glyph, so the link's text —
  // and its accessible name — is exactly its destination, and the badge stays decorative.
  const mobile = element('nav', '', 'console-mobile-nav'); mobile.id = 'console-mobile-nav'; mobile.hidden = true; mobile.setAttribute('aria-label', t('nav.mobile')); mobile.setAttribute('data-i18n', 'nav.mobile'); mobile.setAttribute('data-i18n-attr', 'aria-label');
  for (const [key, href, captionKey, glyph] of [
    ['projects', '#/projects', 'nav.projects', '⌂'], ['board', '#/board', 'nav.tasks_short', '▤'], ['inbox', '#/inbox', 'nav.inbox', '◷'],
    ['assistant', '#/management', 'nav.assistant', '✦'], ['more', '#/more', 'nav.more_short', '⋯']]) {
    const caption = t(captionKey);
    const a = consoleLink(href, caption);
    a.dataset.page = key; a.dataset.glyph = glyph; a.setAttribute('aria-label', caption);
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
  const accountPrefs = consoleLink('#/preferences', t('nav.preferences'));
  const accountPrefsLabel = accountPrefs.querySelector('span'); if (accountPrefsLabel) accountPrefsLabel.setAttribute('data-i18n', 'nav.preferences');
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
