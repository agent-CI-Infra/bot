// Shared navigation wraps the existing console; business pages keep their routes and renderers.
const consoleMedia = matchMedia('(max-width:767px)');
let consoleOwner = null, consoleProject = null, consoleNavSignature = '', consoleRouteKey = null;
const consolePositions = new Map();
const consoleAttention = {
  failed: ['执行失败', '查看失败证据后选择修复方式；不是所有失败都适合直接重试。'],
  paused: ['任务已暂停', '查看暂停原因，确认可以继续后再操作。'],
  waiting_configuration: ['配置待补', '补齐任务所需的模型、凭据或项目配置。'],
  waiting_environment: ['环境待恢复', '检查项目电脑和连接状态，保留现有任务与证据。'],
  waiting_permission: ['权限待处理', '核对当前授权，必要时联系项目或应用管理员。'],
  waiting_publication: ['发布待核实', '先核对远程写入结果，避免重复发布。'],
  needs_replan: ['需要重新规划', '查看验收缺口和已有产物，再决定下一步。']
};
function consoleInboxRoute() { return /^#\/inbox(?:\/(all|[1-9]\d*))?(?:\/(\d+))?$/.exec(location.hash); }
function consoleTaskRow(row, attention = false) {
  const item = element('article', '', 'console-attention-row'), text = element('div');
  const guidance = attention && consoleAttention[row.status];
  text.append(element('p', `${row.full_name || row.repository_id} · ${guidance?.[0] || projectTaskLabel(row)}`, 'eyebrow'), element('h2', row.summary || row.id));
  if (guidance) text.append(element('p', guidance[1]));
  if (row.error_code) text.append(element('p', row.error_code, 'muted'));
  text.append(element('p', `更新于 ${timestamp(row.updated_at) || '未知时间'}`, 'muted'));
  const open = button('查看任务', () => openTask(row.id).catch(error)); open.dataset.attentionTask = row.id;
  item.dataset.taskId = row.id; item.append(text, state(row.status), open); return item;
}
function consoleScope() {
  const inbox = consoleInboxRoute();
  return projectRoute()?.id || (inbox ? (inbox[1] === 'all' ? null : inbox[1]) : consoleProject);
}
function consoleGroups() {
  const id = consoleScope(), repo = repositories.find(r => String(r.id) === id);
  const groups = [{ title: '工作区', items: [
    ['#/projects', '全部项目', '查看有权访问的项目'], ['#/board', '任务看板', '任务状态、角色与运行证据'],
    ['#/inbox' + (repo ? '/' + id : ''), '待处理', '配置、权限、环境与失败事项'],
    ['#/management', '管理对话', '实时回答、执行进展与命令回执']
  ] }];
  if (repo) groups.push({ title: repo.full_name, items: projectSections
    .filter(([, , admin]) => !admin || me.role === 'super_admin')
    .map(([key, name]) => [`#/projects/${id}/${key}`, name, '当前项目']) });
  groups.push({ title: '分析与身份', items: [
    ['#/costs', '用量与成本', '按项目、日期与工作类型查看'],
    ['#/events', 'Webhook 投递', '接收、验证和处理结果'],
    ['#/identity', '身份与权限', '本人绑定与当前有效授权'],
    ['#/external', '外部执行端', '接入与连接诊断']
  ] });
  if (me.role === 'super_admin') groups.push({ title: '平台管理', items: settingsSections.map(([key, name]) => [
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
    consoleOwner = me?.id || null; consoleProject = null; consoleNavSignature = ''; consolePositions.clear(); consoleRouteKey = null;
    $('console-secondary-nav').replaceChildren(); $('console-page').replaceChildren();
  }
  if (!signedIn) return;
  const project = projectRoute(), inbox = consoleInboxRoute();
  if (project || inbox) consoleProject = project?.id || (inbox[1] === 'all' ? null : inbox[1]) || null;
  const repo = repositories.find(r => String(r.id) === consoleProject);
  // A revoked project is never kept in the project picker merely because it was selected earlier.
  if (!repo) consoleProject = null;
  const signature = JSON.stringify([me.id, consoleProject, repositories.map(r => [r.id, r.full_name])]);
  if (signature !== consoleNavSignature) {
    consoleNavSignature = signature;
    const picker = $('console-project'); picker.replaceChildren(new Option('全部项目', ''));
    for (const r of repositories) picker.add(new Option(r.full_name, r.id)); picker.value = consoleProject || '';
  }
  const platform = tab === 'settings';
  $('console-area').textContent = platform ? '平台管理' : project ? '项目工作区' : tab === 'identity' ? '我的身份' : '工作区';
  $('console-context').textContent = project ? (repo?.full_name || '正在读取项目…') : ({ more: '更多功能', inbox: '待处理', settings: '全局设置' }[tab] || titles[tab] || '身份与权限');
  $('console-inbox-link').href = '#/inbox' + (consoleProject ? '/' + consoleProject : '');
  const secondary = project ? $('project-page').querySelector('.project-nav') : platform ? $('settings-panel').querySelector('.project-nav') : null;
  if (secondary) $('console-secondary-nav').replaceChildren(secondary);
  else if (!project && !platform) $('console-secondary-nav').replaceChildren();
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
  const head = element('div', '', 'console-page-head'); head.append(element('p', 'WORKSPACE', 'eyebrow'), element('h1', '更多功能'), element('p', '按工作内容找到入口，当前项目和权限范围会随你继续。', 'muted'));
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
  title.append(element('p', 'NEEDS ATTENTION', 'eyebrow'), element('h1', '待处理'), element('p', '需要关注的真实任务；自动排队和正常执行不计入。具体操作以当前权限和任务回执为准。', 'muted'));
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
  if (tab === 'more') renderConsoleMore(); else await renderConsoleInbox(request);
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
  picker.id = 'console-project'; picker.setAttribute('aria-label', '切换项目'); picker.addEventListener('change', () => { consoleProject = picker.value || null; location.hash = picker.value ? `#/projects/${picker.value}/overview` : '#/projects'; }); scope.append(picker);
  sidebar.append(scope, kicker, $('tabs'));
  const inbox = consoleLink('#/inbox', '待处理'); inbox.id = 'console-inbox-link'; sidebar.append(inbox);
  const secondary = element('div'); secondary.id = 'console-secondary-nav'; sidebar.append(secondary);
  const more = consoleLink('#/more', '更多功能'); more.classList.add('console-more-link'); sidebar.append(more);
  const locationBox = element('div', '', 'console-location'); locationBox.id = 'console-location'; locationBox.hidden = true;
  const area = element('span', '', 'eyebrow'), context = element('span'); area.id = 'console-area'; context.id = 'console-context'; locationBox.append(area, context);
  $('main-content').prepend(locationBox);
  const section = element('label', '当前页面', 'console-section-picker'), sectionPicker = document.createElement('select'); section.id = 'console-section-label'; sectionPicker.id = 'console-section'; sectionPicker.setAttribute('aria-label', '当前页面'); section.hidden = true;
  sectionPicker.addEventListener('change', () => { location.hash = sectionPicker.value; }); section.append(sectionPicker); locationBox.append(section);
  const mobile = element('nav', '', 'console-mobile-nav'); mobile.id = 'console-mobile-nav'; mobile.hidden = true; mobile.setAttribute('aria-label', '移动工作区导航');
  for (const [key, href, caption, glyph] of [['projects', '#/projects', '总览', '⌂'], ['board', '#/board', '任务', '▤'], ['inbox', '#/inbox', '待处理', '◷'], ['more', '#/more', '更多', '⋯']]) {
    const a = consoleLink(href, caption); a.dataset.page = key; const icon = element('span', glyph, 'console-nav-icon'); icon.setAttribute('aria-hidden', 'true'); a.prepend(icon); mobile.append(a);
  }
  document.body.append(mobile);
  document.addEventListener('click', event => { if (event.target.closest('a[href^="#/"], [data-tab]')) rememberConsolePosition(); }, true);
  addEventListener('scroll', rememberConsolePosition, { passive: true });
  // The browser's native modal focus restoration is retained; Escape keeps each existing dialog's semantics.
  document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); $('main-content').focus(); });
  consoleMedia.addEventListener('change', () => syncConsoleShell());
}
initConsoleShell();
