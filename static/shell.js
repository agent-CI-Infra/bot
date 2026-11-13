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
function consoleGroups() {
  const id = consoleScope(), repo = repositories.find(r => String(r.id) === id);
  const groups = [{ title: '工作区', items: [
    ['#/projects', '全部项目', '查看有权访问的项目'], ['#/board', '任务看板', '任务状态、角色与运行证据'],
    ['#/new-task' + (repo ? '/' + id : ''), '新建任务', '填写需求、验收条件和交付类型'],
    ['#/inbox' + (repo ? '/' + id : ''), '待处理', '配置、权限、环境与失败事项'],
    ['#/management', '管理对话', '实时回答、执行进展与命令回执'],
    ['#/conversations', '飞书会话', '成员消息、执行过程与派生任务']
  ] }];
  if (repo) groups.push({ title: repo.full_name, items: projectSections
    .filter(([key]) => ['overview', 'management', 'release', 'knowledge', 'activity'].includes(key))
    .map(([key, name]) => [`#/projects/${id}/${key}`, name, '当前项目']) });
  groups.push({ title: '分析与身份', items: [
    ['#/costs', '用量与成本', '按项目、日期与工作类型查看'],
    ['#/events', 'Webhook 投递', '接收、验证和处理结果'],
    ['#/identity', '身份与权限', '本人绑定与当前有效授权'],
    ['#/external', '外部执行端', '接入与连接诊断'],
    ...(me.role === 'super_admin' ? [] : [['#/settings/storage', '存储', '本人项目的轨迹与数据量']])
  ] });
  groups.push({ title: '设置', items: [['#/preferences', '个人设置', '个人身份、飞书绑定与外部执行端'],
    ['#/identity/feishu', '飞书绑定', '个人绑定、群绑定、仓库权限与聊天记录'], ...(repo ? projectSections
    .filter(([key]) => ['basic', 'roles', 'model', 'machine', 'schedules', 'external', 'members'].includes(key))
    .map(([key, name]) => [`#/projects/${id}/${key}`, name, repo.full_name]) : [])] });
  if (me.role === 'super_admin') groups.push({ title: '全局设置', items: settingsSections.map(([key, name]) => [
    key === 'onboarding' ? '#/settings/onboarding/0' : '#/settings/' + key, name, '平台超级管理员'
  ]) });
  return groups;
}
function syncConsoleShell() {
  const signedIn = !!me && !$('workspace').hidden;
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
  }
  if (!signedIn) return;
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
  const signature = JSON.stringify([me.id, consoleProject, repositories.map(r => [r.id, r.full_name, organization(r)])]);
  if (signature !== consoleNavSignature) {
    consoleNavSignature = signature;
    const picker = $('console-project'); picker.replaceChildren(new Option('全部项目', ''));
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
  $('console-area').textContent = platform ? '平台管理' : project ? '项目工作区' : personal ? '个人设置' : '工作区';
  // The scope bar names both halves of the current address: a project name alone does not say which organization it is in.
  const shortName = r => (r.full_name || '').includes('/') ? r.full_name.split('/').slice(1).join('/') : r.full_name;
  const personalTitle = /^#\/identity\/feishu-apps(?:\/|$)/.test(location.hash) ? '组织飞书应用'
    : /^#\/identity\/feishu(?:$|\?|\/)/.test(location.hash) ? '飞书绑定' : '身份与权限';
  // An installed repository nobody has started is no project yet; its cached installation row still names it.
  const unstarted = project && !repo ? consoleGaps.get(String(project.id)) : null;
  $('console-context').textContent = project ? (repo ? organization(repo) + ' · ' + shortName(repo)
    : unstarted?.registered === false ? organization(unstarted) + ' · ' + shortName(unstarted) + ' · 未启动' : '正在读取项目…')
    : tab === 'identity' || tab === 'preferences' ? personalTitle : ({ more: '更多功能', inbox: '待处理', settings: '全局设置' }[tab] || titles[tab] || '身份与权限');
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
  if (nav) for (const a of nav.querySelectorAll('a')) sectionPicker.add(new Option(a.textContent, a.getAttribute('href'), false, a.getAttribute('aria-current') === 'page'));
  for (const a of $('console-mobile-nav').querySelectorAll('a')) {
    if (a.dataset.page === 'inbox') a.href = '#/inbox' + (consoleProject ? '/' + consoleProject : '');
    const mobilePage = ['projects', 'board', 'inbox'].includes(tab) ? tab : tab === 'design' ? '' : 'more';
    const active = a.dataset.page === mobilePage;
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('console-sidebar').classList.toggle('console-platform', platform);
}
function renderConsoleMore() {
  const page = $('console-page'); page.replaceChildren();
  // Complete user-visible phrases, ready to move into a locale dictionary later (#527).
  const head = element('div', '', 'console-page-head'); head.append(element('p', '工作区', 'eyebrow'), element('h1', '更多功能'), element('p', '按工作内容找到入口，当前项目和权限范围会随你继续。', 'muted'));
  const groups = element('div', '', 'console-groups');
  for (const group of consoleGroups()) {
    const section = element('section', '', 'console-group'); section.append(element('h2', group.title));
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
  const sidebar = $('console-sidebar'), kicker = element('p', '工作区', 'console-nav-label'), scope = element('label', '切换项目', 'console-project-picker'), picker = document.createElement('select');
  picker.id = 'console-project'; picker.setAttribute('aria-label', '切换项目');
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
  settings.setAttribute('role', 'group'); settings.setAttribute('aria-label', '设置与管理');
  settings.append(tabs.querySelector('[data-tab=preferences]'), tabs.querySelector('[data-tab=settings]'));
  primary.append(kicker, ...tabs.children);
  const inbox = consoleLink('#/inbox', '待处理'); inbox.id = 'console-inbox-link'; primary.append(inbox);
  // Keep the original tabs and their click handling, but let only the work navigation scroll above the settings.
  tabs.replaceChildren(primary, settings); sidebar.append(scope, tabs);
  const locationBox = element('div', '', 'console-location'); locationBox.id = 'console-location'; locationBox.hidden = true;
  const area = element('span', '', 'eyebrow'), context = element('span'); area.id = 'console-area'; context.id = 'console-context';
  const permission = element('span', '', 'console-permission'); permission.id = 'console-permission';
  locationBox.append(area, context, permission);
  const secondary = element('div', '', 'console-secondary-nav'); secondary.id = 'console-secondary-nav'; secondary.hidden = true;
  $('main-content').prepend(locationBox, secondary);
  const section = element('label', '当前页面', 'console-section-picker'), sectionPicker = document.createElement('select'); section.id = 'console-section-label'; sectionPicker.id = 'console-section'; sectionPicker.setAttribute('aria-label', '当前页面'); section.hidden = true;
  sectionPicker.addEventListener('change', () => { location.hash = sectionPicker.value; }); section.append(sectionPicker); locationBox.append(section);
  const mobile = element('nav', '', 'console-mobile-nav'); mobile.id = 'console-mobile-nav'; mobile.hidden = true; mobile.setAttribute('aria-label', '移动工作区导航');
  for (const [key, href, caption, glyph] of [['projects', '#/projects', '总览', '⌂'], ['board', '#/board', '任务', '▤'], ['inbox', '#/inbox', '待处理', '◷'], ['more', '#/more', '更多', '⋯']]) {
    const a = consoleLink(href, caption); a.dataset.page = key; const icon = element('span', glyph, 'console-nav-icon'); icon.setAttribute('aria-hidden', 'true'); a.prepend(icon); mobile.append(a);
  }
  document.body.append(mobile);
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
