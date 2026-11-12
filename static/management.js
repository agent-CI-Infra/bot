// Model text is untrusted. Parse Markdown, then allow only document markup before attaching it to the live page.
function renderManagementMarkdown(node, text) {
  const fragment = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
  });
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove(); else input.disabled = true;
  }
  for (const anchor of fragment.querySelectorAll('a')) {
    const href = anchor.getAttribute('href');
    try {
      const url = new URL(href, location.href);
      if (!href || !['https:', 'http:', 'mailto:'].includes(url.protocol)) anchor.removeAttribute('href');
      else if (url.origin !== location.origin) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
    } catch { anchor.removeAttribute('href'); }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const wrap = element('div', '', 'management-table'); table.replaceWith(wrap); wrap.append(table);
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '回答中的表格');
  }
  node.replaceChildren(fragment);
}
const managementOperationLabels = {
  list_projects: '查询项目', list_tasks: '查询任务', get_task: '读取任务状态', get_effective_config: '读取项目配置',
  get_usage: '查询成本与预算', list_audit: '查询操作记录', 'task.create': '创建任务', 'task.pause': '暂停任务',
  'task.cancel': '取消任务', 'task.retry': '重试任务', 'task.instructions': '追加任务指令', 'task.contract': '修订任务目标',
  'task.adopt-config': '采用新执行配置', 'workflow.update': '更新工作配置', 'manager.update': '更新 Manager 配置',
  'project.update': '更新项目配置', 'roles.update': '更新角色', 'rules.update': '更新规则', 'configuration.pr': '创建配置 PR'
};
// A console write is shown before it is sent (#355): the preview is drawn only from the command this page builds — the
// operation label above, its target, its arguments and the expected revision — so it never claims an effect the server
// does not have. Nothing reaches POST /api/management/commands until 确认执行; the receipt afterwards is still the
// execution result, because there is no approval step (#312).
function managementPreview(command, context = {}) {
  const box = element('section', '', 'management-command-preview');
  box.dataset.commandPreview = ''; box.dataset.operation = command.operation;
  box.setAttribute('role', 'region'); box.setAttribute('aria-label', '执行前确认');
  const place = [context.project && '项目 ' + context.project, context.task && '任务 ' + context.task, context.workflow && '工作类型 ' + context.workflow].filter(Boolean).join(' · ');
  const rows = [['操作', managementOperationLabels[command.operation] ?? command.operation], ['目标', place || command.target.project_id],
    ['预计版本', String(command.expected_revision)]];
  for (const [key, value] of Object.entries(command.arguments ?? {})) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    rows.push(['参数 ' + key, text.length > 120 ? text.slice(0, 120) + '…' : text]);
  }
  const actions = element('div', '', 'actions'), confirm = button('确认执行', () => {}, ''), cancel = button('取消', () => {});
  actions.append(confirm, cancel);
  box.append(element('h3', '执行前确认'), facts(rows),
    note('确认后立即提交并执行：控制台没有审批步骤，执行结果写在回执里。版本不一致或权限已变更时，服务端会拒绝这次操作。'), actions);
  return { box, confirm, cancel };
}
// Commands execute directly (#312): a receipt is the execution result, never a pending decision. "rejected" only appears on
// receipts recorded before the approval flow was retired.
const managementCommandStates = {
  pending: ['等待执行', '已提交，等待执行。结果出来后会更新这条回执。'],
  executing: ['执行中', '执行中，结果出来后会更新这条回执。'],
  succeeded: ['已执行', '已执行。下方是这次操作的执行回执。'],
  rejected: ['已拒绝', '这条命令在审批流程取消前被拒绝，没有执行。'],
  failed: ['执行失败', '执行失败，命令未完成。原因见下方回执。'],
  unknown: ['结果待确认', '结果待确认。对账回读之前不会再次执行。'],
  not_operator: ['未执行：只有发起人可以执行', '只有这条命令的发起人可以执行它；命令保持原状态，没有执行。']
};
const managementCommandState = state => managementCommandStates[state] ?? [state, '当前状态：' + state];
// One authenticated chat surface survives page navigation. Minimizing it never cancels a submitted command.
let managementChat = null;
function syncManagementChat() {
  if (managementChat?.user === me?.id && me) return;
  managementChat?.client?.dispose();
  managementChat?.cleanup();
  managementChat?.window.remove(); managementChat?.launcher.remove(); managementChat = null;
  document.body.classList.remove('management-page-mode', 'management-fullscreen-mode');
  if (!me) return;
  const box = element('section', '', 'management-window'); box.id = 'management-chat'; box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'management-chat-title');
  const head = element('div', '', 'management-window-head'), title = element('div', '', 'management-window-title');
  const heading = element('h2', '管理助手'); heading.id = 'management-chat-title';
  title.append(heading, element('p', '从了解情况，到推进下一步'));
  const minimize = button('收起', () => Promise.resolve(minimizeManagementChat()).catch(error), 'quiet');
  const maximize = button('全屏', () => toggleManagementFullscreen(), 'quiet');
  const controls = element('div', '', 'actions'); controls.append(maximize, minimize); head.append(title, controls);
  const resize = button('↖', () => {}, 'management-size-handle');
  resize.setAttribute('aria-label', '调整管理助手窗口大小'); resize.title = '拖动左上角调整大小；方向键微调';
  const panel = element('div', '', 'management-panel'); box.append(resize, head, panel);
  const launcher = button('', () => openManagementChat(), 'management-launcher'); launcher.id = 'management-launcher';
  launcher.setAttribute('aria-controls', box.id); launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-label', '打开管理助手');
  const icon = element('span', '✦', 'management-launcher-icon'); icon.setAttribute('aria-hidden', 'true');
  const label = element('span', '', 'management-launcher-label'), state = element('small', '随时唤起');
  label.append(element('strong', '管理助手'), state); launcher.append(icon, label);
  document.body.append(box, launcher);
  const chat = managementChat = { user: me.id, window: box, launcher, panel, state, minimize, maximize, resize, client: null, loading: null, openVersion: 0, active: false, unread: false,
    mode: 'floating', fullscreenFrom: 'floating', returnAddress: '#/projects', requestedProject: null, size: { width: 480, height: 740 } };
  try { const saved = JSON.parse(localStorage.getItem('management-window-size:' + chat.user)); if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) chat.size = saved; } catch { /* Use the default size when storage is unavailable. */ }
  const header = document.querySelector('body > header');
  const updateViewport = () => {
    box.style.setProperty('--management-header-height', (header?.getBoundingClientRect().height || 0) + 'px');
    if (chat.mode === 'floating') fitManagementWindow(chat);
  };
  chat.updateViewport = updateViewport;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateViewport) : null;
  if (header) observer?.observe(header);
  window.addEventListener('resize', updateViewport);
  chat.cleanup = () => { observer?.disconnect(); window.removeEventListener('resize', updateViewport); };
  resize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || chat.mode !== 'floating') return;
    event.preventDefault(); resize.setPointerCapture(event.pointerId);
    const start = box.getBoundingClientRect(), x = event.clientX, y = event.clientY;
    const move = next => resizeManagementWindow(chat, start.width + x - next.clientX, start.height + y - next.clientY);
    const end = () => { resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', end); resize.removeEventListener('pointercancel', end); };
    resize.addEventListener('pointermove', move); resize.addEventListener('pointerup', end); resize.addEventListener('pointercancel', end);
  });
  resize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const rect = box.getBoundingClientRect(), step = event.shiftKey ? 64 : 24;
    resizeManagementWindow(chat, rect.width + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0), rect.height + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0));
  });
  setManagementPresentation(chat, 'floating');
  box.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && chat.mode !== 'page') {
      event.preventDefault(); event.stopPropagation();
      if (chat.mode === 'fullscreen') { toggleManagementFullscreen(); maximize.focus(); } else minimizeManagementChat();
    }
    if (event.key === 'Tab' && chat.mode === 'fullscreen') {
      const items = [...box.querySelectorAll('button, input, textarea, select, summary, a[href]')].filter(node => !node.disabled && node.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  });
}
// The same DOM and client serve all three presentations; changing size or mode never reopens a conversation.
function fitManagementWindow(chat) {
  const margin = innerWidth <= 600 ? 10 : 24, maxWidth = Math.max(1, innerWidth - margin * 2), maxHeight = Math.max(1, innerHeight - margin * 2);
  const width = Math.max(Math.min(360, maxWidth), Math.min(chat.size.width, maxWidth)), height = Math.max(Math.min(460, maxHeight), Math.min(chat.size.height, maxHeight));
  chat.window.style.width = Math.round(width) + 'px'; chat.window.style.height = Math.round(height) + 'px';
}
function resizeManagementWindow(chat, width, height) {
  chat.size = { width, height }; fitManagementWindow(chat);
  const rect = chat.window.getBoundingClientRect(); chat.size = { width: rect.width, height: rect.height };
  try { localStorage.setItem('management-window-size:' + chat.user, JSON.stringify(chat.size)); } catch { /* Keep the size for this visit. */ }
}
function setManagementPresentation(chat, mode) {
  chat.mode = mode;
  const page = mode === 'page' || mode === 'fullscreen' && chat.fullscreenFrom === 'page';
  chat.window.classList.toggle('management-page', mode === 'page'); chat.window.classList.toggle('management-fullscreen', mode === 'fullscreen');
  chat.window.setAttribute('role', mode === 'page' ? 'region' : 'dialog');
  if (mode === 'fullscreen') chat.window.setAttribute('aria-modal', 'true'); else chat.window.removeAttribute('aria-modal');
  document.body.classList.toggle('management-page-mode', page); document.body.classList.toggle('management-fullscreen-mode', mode === 'fullscreen');
  chat.maximize.textContent = mode === 'fullscreen' ? '退出全屏' : '全屏'; chat.maximize.setAttribute('aria-label', mode === 'fullscreen' ? '退出管理助手全屏' : '全屏显示管理助手');
  chat.minimize.textContent = page ? '悬浮窗口' : '收起'; chat.minimize.setAttribute('aria-label', page ? '切换为悬浮窗口' : '收起管理助手');
  chat.resize.hidden = mode !== 'floating';
  if (mode !== 'floating') { chat.window.style.removeProperty('width'); chat.window.style.removeProperty('height'); }
  chat.updateViewport();
}
function toggleManagementFullscreen() {
  const chat = managementChat; if (!chat) return;
  if (chat.mode === 'fullscreen') setManagementPresentation(chat, chat.fullscreenFrom);
  else { chat.fullscreenFrom = chat.mode; setManagementPresentation(chat, 'fullscreen'); }
}
async function openManagementPage(projectId = null) {
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  syncManagementChat(); const chat = managementChat; if (!chat) return;
  if (location.hash !== '#/management') { chat.returnAddress = location.hash || '#/projects'; history.pushState(null, '', '#/management'); }
  chat.requestedProject = projectId; await route();
}
// Why a command did not run, in words instead of only the code the server returned. A code the console cannot explain
// keeps its bare value below the sentence rather than being guessed at.
const managementFailureHints = {
  task_already_delivered: '任务已经交付，这个操作不能再执行。',
  management_revision_conflict: '提交之后项目配置的版本变了，命令没有执行；先读回当前配置再提交。',
  authorization_changed: '发起人的权限在命令提交之后变了，命令没有执行。',
  execution_context_changed: '执行上下文（权限或环境）在提交之后变了，命令没有执行。',
  command_operator_required: '只有这条命令的发起人可以执行它。',
  approval_retired: '这条命令来自审批流程取消之前，已经作废，不会执行。',
  role_setting_forbidden: '这个项目不允许通过这些字段修改角色。',
  external_result_unknown: '外部调用可能已经生效，对账回读之前不知道结果；不要重复提交。',
  management_tool_failed: '服务端在处理这条命令时出错，命令没有完成。'
};
const managementChannels = { api: '接口调用', console: '控制台', im: '即时消息' };
const managementStateTone = { succeeded: 'success', failed: 'danger', rejected: 'warning', unknown: 'warning', pending: 'warning', executing: 'warning', not_operator: 'warning' };
// The target keys this page can name; a key it does not know keeps its own name.
const managementTargetNames = { project_id: '项目', task_id: '任务', workflow_id: '工作类型', repository_id: '仓库' };
// A command receipt has an address of its own (#235). It renders the one GET /api/management/commands/<id> the console
// already exposes and nothing else, and it is read-only: no approval, retry or reconcile, so a bookmarked receipt can
// never turn into a second execution.
// #382: the same receipt address can be routed twice while the shell is still booting (a hashchange while the login
// form's start() is finishing its own reads, then start()'s trailing route). The page keeps the id it has already read
// so the second render does not issue a second GET; leaving for any other page clears it, so a later visit reads again.
let receiptShownId = null, receiptLoading = null;
function hideManagementReceiptPage(keepShown = false) {
  const page = document.getElementById('management-receipt-page'); if (page) page.hidden = true;
  if (!keepShown) receiptShownId = null;
}
// The console's link() only builds absolute http(s) anchors, so a hash address or an API path needs a plain anchor:
// a receipt page that looks like a link but is not one would be worse than no link at all.
function managementReceiptLink(href, caption) {
  const anchor = element('a', caption); anchor.href = href;
  if (/^https?:/.test(href)) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
  return anchor;
}
function managementReceiptPage() {
  let page = document.getElementById('management-receipt-page'); if (page) return page;
  page = element('section', '', 'project-page'); page.id = 'management-receipt-page'; page.hidden = true;
  page.setAttribute('aria-label', '命令回执详情');
  const body = element('div', '', 'project-body settings-body'), nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content');
  nav.setAttribute('aria-label', '命令回执导航');
  body.append(nav, content); page.append(body); document.getElementById('workspace').append(page);
  return page;
}
function receiptSourceLine(receipt) {
  if (!receipt.source_conversation) return element('span', '这条回执没有记录来源会话（更早的命令不写这一列）。', 'muted');
  const line = element('span', ''); line.dataset.receiptSource = '';
  line.append(element('code', receipt.source_conversation), document.createTextNode(' · 消息 '),
    element('code', receipt.source_message || '未记录'), document.createTextNode(' '),
    managementReceiptLink('#/management', '回到管理会话'));
  return line;
}
async function renderManagementReceiptPage(id) {
  const page = managementReceiptPage(), nav = page.querySelector('.project-nav'), content = page.querySelector('.project-content');
  // A completed render of this id is already on screen: show it instead of reading the same receipt again.
  if (receiptShownId === id) { page.hidden = false; return; }
  page.hidden = false;
  const back = element('a', '返回管理对话'); back.href = '#/management'; nav.replaceChildren(back);
  content.replaceChildren(element('p', '正在加载命令回执…', 'muted'));
  let receipt;
  try {
    // A read for this id that is still in flight is shared instead of started again.
    const pending = receiptLoading?.id === id ? receiptLoading.promise : null;
    if (pending) receipt = await pending;
    else {
      const load = { id }; load.promise = api('/api/management/commands/' + encodeURIComponent(id)); receiptLoading = load;
      try { receipt = await load.promise; } finally { if (receiptLoading === load) receiptLoading = null; }
    }
  }
  catch (err) { if (!page.hidden) content.replaceChildren(element('p', '读不到这条回执：' + err.message, 'view-error')); return; }
  if (page.hidden) return;
  if (receipt.project_id) {
    const roles = element('a', '项目配置'); roles.href = '#/projects/' + receipt.project_id + '/roles';
    const activity = element('a', '任务'); activity.href = '#/projects/' + receipt.project_id + '/activity';
    nav.append(roles, activity);
  }
  content.replaceChildren(...managementReceiptBody(receipt));
  receiptShownId = id;
  window.scrollTo(0, 0);
}
function managementReceiptBody(receipt) {
  const operation = managementOperationLabels[receipt.operation] ?? receipt.operation, nodes = [];
  // The same state machine the transcript card uses: the page never restates a state the console can already name.
  const shown = receipt.state === 'failed' && receipt.result?.error === 'command_operator_required' ? 'not_operator' : receipt.state;
  const [caption, explanation] = managementCommandState(shown);
  const head = element('div', '', 'management-receipt-head'), state = badge(caption, managementStateTone[shown] ?? 'warning');
  state.dataset.receiptState = '';
  head.append(element('h1', '命令回执'), state); nodes.push(head);
  nodes.push(element('p', explanation, 'management-receipt-page-note'));
  // The project is named from the list the console already loaded; the initiator is only called "you" when it is you.
  const project = (typeof repositories === 'undefined' ? [] : repositories).find(row => String(row.id) === String(receipt.project_id));
  const projectLine = element('span', project ? project.full_name : `项目 ${receipt.project_id}`);
  if (project) projectLine.append(' · ', managementReceiptLink('#/projects/' + receipt.project_id + '/basic', '打开项目'));
  const initiator = element('span', ''); initiator.dataset.receiptInitiator = '';
  initiator.textContent = me && String(receipt.principal_id) === String(me.id)
    ? '你（当前登录用户） · ' + receipt.principal_id
    : receipt.principal_id + '（不是当前登录用户；只有发起人可以执行或对账这条命令）';
  const version = receipt.before_revision ? receipt.before_revision.slice(0, 12) + ' → ' + (receipt.after_revision ?? receipt.before_revision).slice(0, 12) : null;
  const overview = card('这次操作');
  overview.append(facts([['操作', `${operation}（${receipt.operation}）`], ['项目', projectLine], ['发起人', initiator],
    ['渠道', managementChannels[receipt.channel] ?? receipt.channel], ['版本', version],
    ['提交时间', timestamp(receipt.created_at)], ['更新时间', timestamp(receipt.updated_at)],
    ['参数指纹', receipt.parameter_hash ? receipt.parameter_hash.slice(0, 12) : null],
    // #355: a receipt names the conversation and the message it came from, so a reader can walk back to the request
    // that produced it instead of matching timestamps by eye. Older receipts without those columns say so.
    ['来源', receiptSourceLine(receipt)]]));
  // The key alone only means something with the rule it drives (#355): the same principal submitting the same key and
  // the same arguments gets this receipt back instead of a second execution. A receipt without one says so, because an
  // empty cell would read as "a repeat always runs again".
  const idempotency = element('div', ''); idempotency.dataset.receiptIdempotency = '';
  idempotency.append(facts([['幂等键', receipt.idempotency_key]]));
  idempotency.append(element('p', receipt.idempotency_key
    ? '同一个幂等键重放不会重复执行：同一发起人用同一个键和同一份参数再提交，服务端直接返回这份回执，不再执行一次。'
    : '这条回执没有幂等键：服务端无法用它识别重放，重复提交会再执行一次。', 'muted'));
  overview.append(idempotency);
  // What the command is expected to affect. The server does not record it today, so the page says that rather than
  // leaving the reader to assume "nothing".
  const impactValue = [receipt.result?.impact, receipt.impact].find(value => typeof value === 'string' && value.trim());
  const impact = element('div', ''); impact.dataset.receiptImpact = '';
  impact.append(facts([['影响', impactValue]]));
  impact.append(element('p', impactValue ? '上面是服务端为这次操作记录的影响描述。' : '服务端未提供影响描述：这次操作会影响什么，只能从「具体变更」和「配置差异」里读。', 'muted'));
  overview.append(impact);
  nodes.push(overview);
  // What the command named and what it wrote, as fields instead of one JSON blob.
  const change = card('具体变更'), target = element('div', ''); target.dataset.receiptTarget = '';
  target.append(facts(Object.entries(receipt.target || {}).map(([key, value]) => [managementTargetNames[key] ?? key, typeof value === 'object' ? JSON.stringify(value) : String(value)])));
  if (!target.querySelector('dd')) target.append(element('p', '这次操作没有指定目标字段。', 'muted'));
  const args = element('div', ''); args.dataset.receiptArguments = '';
  args.append(facts(Object.entries(receipt.arguments || {}).map(([key, value]) => [key, value === null || value === undefined ? '未设置' : typeof value === 'object' ? JSON.stringify(value) : String(value)])));
  if (!args.querySelector('dd')) args.append(element('p', '这次操作没有提交参数。', 'muted'));
  change.append(target, args); nodes.push(change);
  // The recorded diff, one row per field: before, after. A command that records no diff says so rather than showing an
  // empty table that could be read as "nothing changed".
  const difference = card('配置差异'), differenceBox = element('div', ''); differenceBox.dataset.receiptDiff = '';
  const before = receipt.result?.diff?.before, after = receipt.result?.diff?.after;
  const text = value => value === null || value === undefined || value === '' ? '未设置' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (before || after) {
    const table = element('table', '', 'rule-table'), thead = element('thead', ''), tbody = element('tbody', ''), headRow = element('tr', '');
    for (const column of ['字段', '之前', '之后']) headRow.append(element('th', column));
    thead.append(headRow);
    for (const key of [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]) {
      const row = element('tr', ''); row.append(element('td', key), element('td', text(before?.[key])), element('td', text(after?.[key]))); tbody.append(row);
    }
    table.append(thead, tbody); const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); differenceBox.append(wrap);
  } else differenceBox.append(element('p', '这个操作不回执字段级差异；执行结果写在下面的回执里。', 'muted'));
  difference.append(differenceBox); nodes.push(difference);
  // The outcome gets the section its state deserves (#355): a success, a refusal and an unconfirmed result read
  // differently, so they never share one block. What is not the outcome — links, notices, the receipt id — stays in its
  // own record section, so a refusal cannot be mistaken for a result.
  const resultTitles = { succeeded: '执行结果', failed: '执行失败', not_operator: '未执行', rejected: '未执行', unknown: '结果待确认', pending: '执行进度', executing: '执行进度' };
  const result = card(resultTitles[shown] ?? '执行结果'), resultBox = element('div', ''); resultBox.dataset.receiptResult = shown;
  const outcome = receipt.result || {};
  if (receipt.state === 'failed' || shown === 'not_operator') {
    resultBox.append(element('p', '命令未执行：' + (managementFailureHints[outcome.error] ?? '服务端拒绝了这个操作，原因见下方代码。')));
    resultBox.append(facts([['错误代码', String(outcome.error ?? '未提供')], ['HTTP 状态', outcome.http_status ? String(outcome.http_status) : null]]));
  } else if (receipt.state === 'unknown') {
    resultBox.append(element('p', '结果待确认：外部调用可能已经生效，对账回读之前不要重复提交这条命令。'));
    resultBox.append(facts([['错误代码', String(outcome.error ?? '未提供')]]));
  } else if (receipt.state === 'pending' || receipt.state === 'executing') {
    resultBox.append(element('p', '结果还没出来：执行结束后回执会更新，刷新这一页即可看到最新状态。'));
  } else if (shown === 'rejected') {
    resultBox.append(element('p', '这条命令在审批流程取消前被拒绝，没有执行，也没有修改任何东西。'));
  } else if (shown === 'succeeded') {
    // A successful command says so in its own words instead of leaving an empty section beside the state badge.
    resultBox.append(element('p', '已执行，服务端没有记录错误。'));
    if (receipt.after_revision) resultBox.append(facts([['执行后版本', receipt.after_revision.slice(0, 12)]]));
  }
  result.append(resultBox); nodes.push(result);
  // Everything that is a record of the command rather than its outcome: server notes, the links it produced and the
  // receipt id with the raw JSON behind it.
  const recordCard = card('回执记录'), recordBox = element('div', ''); recordBox.dataset.receiptRecord = '';
  if (outcome.notice) recordBox.append(element('p', String(outcome.notice)));
  if (outcome.pr_url) recordBox.append(managementReceiptLink(String(outcome.pr_url), '查看配置 PR（待合入）'));
  if (outcome.configuration_url) recordBox.append(managementReceiptLink(String(outcome.configuration_url), '查看当前配置'));
  const taskId = receipt.target?.task_id ?? (receipt.operation === 'task.create' ? outcome.id : null);
  if (taskId) recordBox.append(managementReceiptLink('#/projects/' + receipt.project_id + '/activity', '查看任务 ' + taskId));
  if (outcome.rollback) recordBox.append(element('p', '这条回执带有原值回滚；需要回滚时在管理对话里发起，会重新校验权限与版本。', 'muted'));
  const record = element('p', ''); record.append('回执 ID ' + receipt.id + ' · ', managementReceiptLink('/api/management/commands/' + receipt.id, '原始回执（JSON）'));
  recordBox.append(record);
  recordCard.append(recordBox); nodes.push(recordCard);
  // Read-only by design: retry and reconcile are executions, and they belong to the conversation that can show them.
  nodes.push(element('p', '这一页只读：不提供批准、重试或对账。需要重试或对账时回管理对话，那里的操作会重新校验权限与版本。', 'management-receipt-page-note'));
  return nodes;
}
async function renderManagementPage() {
  const receipt = /^#\/management\/commands\/([a-f0-9]+)$/.exec(location.hash)?.[1];
  if (receipt) { leaveManagementPage(receiptShownId === receipt); await renderManagementReceiptPage(receipt); return; }
  hideManagementReceiptPage();
  syncManagementChat(); const project = managementChat?.requestedProject || null;
  if (managementChat) managementChat.requestedProject = null;
  window.scrollTo(0, 0); await openManagementChat(project, { mode: 'page' });
}
function leaveManagementPage(keepReceipt = false) {
  hideManagementReceiptPage(keepReceipt);
  const chat = managementChat; if (!chat || !(chat.mode === 'page' || chat.mode === 'fullscreen' && chat.fullscreenFrom === 'page')) return;
  chat.openVersion++; setManagementPresentation(chat, 'floating'); minimizeManagementChat(false);
}
async function floatManagementPage() {
  const chat = managementChat; if (!chat) return;
  // The chat is already open: keep it and focus synchronously. Loading the underlying page must not take focus back
  // from a resize handle or another control the person has started using in the meantime.
  chat.openVersion++; setManagementPresentation(chat, 'floating'); chat.client?.focus();
  history.replaceState(null, '', chat.returnAddress); await route();
}
function minimizeManagementChat(focus = true) {
  const chat = managementChat; if (!chat || chat.window.hidden) return;
  if (chat.mode === 'page' || chat.mode === 'fullscreen' && chat.fullscreenFrom === 'page') return floatManagementPage();
  if (chat.mode === 'fullscreen') setManagementPresentation(chat, 'floating');
  chat.window.hidden = true; chat.launcher.hidden = false; chat.launcher.setAttribute('aria-expanded', 'false');
  if (focus) chat.launcher.focus();
}
async function openManagementChat(projectId = null, { mode = 'floating' } = {}) {
  syncManagementChat(); const chat = managementChat; if (!chat) return;
  const version = ++chat.openVersion;
  setManagementPresentation(chat, mode);
  chat.window.hidden = false; chat.launcher.hidden = true; chat.launcher.setAttribute('aria-expanded', 'true'); chat.unread = false;
  const focusAtOpen = document.activeElement;
  const activity = (active, received = false) => {
    if (managementChat !== chat) return;
    chat.active = active; if (received && chat.window.hidden) chat.unread = true;
    chat.state.textContent = active ? '正在处理…' : chat.unread ? '有新回复' : '随时唤起';
    chat.launcher.classList.toggle('has-update', active || chat.unread);
  };
  if (!chat.loading && !chat.client) {
    chat.panel.replaceChildren(note('正在连接管理助手…'));
    chat.loading = renderManagement(chat.panel, projectId, activity).then(client => {
      if (managementChat !== chat) { client?.dispose(); return; }
      chat.client = client;
    }).catch(err => {
      if (managementChat !== chat) return;
      chat.panel.replaceChildren(element('p', '暂时无法连接：' + err.message, 'view-error'), button('重新连接', () => openManagementChat(projectId, { mode: chat.mode }), 'quiet'));
    }).finally(() => { chat.loading = null; });
  }
  await chat.loading;
  if (managementChat !== chat || version !== chat.openVersion || !chat.client) return;
  if (projectId) await chat.client.setScope('project:' + projectId);
  if (!chat.window.hidden && document.activeElement === focusAtOpen) chat.client.focus();
  activity(chat.active);
}

// Commands still use durable, versioned management messages. History and reconnect only read events.
async function renderManagement(panel, projectId = null, onActivity = () => {}) {
  const endpoint = '/api/management', user = me.id;
  const projects = (await api(endpoint + '/query', 'POST', { operation: 'list_projects', target: {}, arguments: { limit: 100 } })).projects;
  if (!panel.isConnected || me?.id !== user) return null;
  panel.replaceChildren(); panel.className = 'management-panel';
  const header = element('div', '', 'management-scope'), scope = document.createElement('select');
  scope.setAttribute('aria-label', '当前管理作用域');
  const addScope = (value, caption) => { const option = element('option', caption); option.value = value; scope.append(option); };
  addScope('platform', '全部有权访问的项目');
  for (const tenant of new Set(projects.map(p => p.tenant_id).filter(Boolean))) addScope('tenant:' + tenant, '组织 ' + tenant);
  for (const project of projects) addScope('project:' + project.id, project.full_name);
  const scopeKey = 'management-scope:' + user, conversationKey = () => 'management-conversation:' + user + ':' + scope.value;
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Session still works when storage is disabled. */ } };
  const available = value => [...scope.options].some(option => option.value === value);
  scope.value = projectId && available('project:' + projectId) ? 'project:' + projectId : available(stored(scopeKey)) ? stored(scopeKey) : 'platform';
  const toolsButton = button('快捷操作', () => showTools(!toolsOpen), 'quiet'); toolsButton.setAttribute('aria-expanded', 'false'); toolsButton.setAttribute('aria-controls', 'management-tools');
  const fresh = button('＋ 新建会话', () => openConversation(true).catch(showError), 'quiet management-new-conversation');
  fresh.setAttribute('aria-label', '新建会话');
  header.append(field('管理范围', scope), fresh, toolsButton); panel.append(header);
  const sessions = element('details', '', 'management-sessions'), sessionBody = element('div', '', 'management-session-controls');
  sessions.append(element('summary', '会话记录'));
  const conversations = document.createElement('select'); conversations.setAttribute('aria-label', '持久会话');
  sessionBody.append(field('切换会话', conversations)); sessions.append(sessionBody); panel.append(sessions);
  const feed = element('div', '', 'management-feed'); feed.setAttribute('aria-label', '管理会话记录'); feed.setAttribute('role', 'log'); feed.setAttribute('aria-live', 'polite');
  const welcome = element('div', '', 'management-welcome');
  welcome.append(element('span', '✦', 'management-welcome-icon'), element('p', '你的项目工作台', 'management-eyebrow'), element('h3', '一起推进下一步'), element('p', '查进展、找原因、调整配置。执行过程和结果都会在这里实时呈现。', 'muted'));
  const suggestions = element('div', '', 'management-suggestions');
  for (const [caption, text] of [['查看任务进展', '有哪些任务需要处理？'], ['分析阻塞原因', '帮我看看任务为什么没有继续。'], ['了解项目配置', '当前项目的配置是什么？']]) {
    const suggestion = button('', () => { message.value = text; message.focus(); }, 'quiet');
    suggestion.append(element('strong', caption), element('span', text)); suggestions.append(suggestion);
  }
  welcome.append(suggestions); feed.append(welcome);
  const feedWrap = element('div', '', 'management-feed-wrap'), latest = button('↓ 回到最新消息', () => { flushMarkdown(true); scrollOutput(true); }, 'quiet management-latest');
  // Blurring the composer can restore mobile navigation and move this button before pointer-up.
  latest.addEventListener('pointerdown', event => event.preventDefault());
  latest.hidden = true; feedWrap.append(feed, latest); panel.append(feedWrap);
  const tools = element('div', '', 'management-tools'); tools.id = 'management-tools'; tools.hidden = true;
  tools.append(element('h3', '快捷操作'), note('直接查询或使用表单。操作结果会回到对话里。'),
    note('默认配置只影响新任务；补充指令会追加记录。修改目标或验收条件会使旧候选和验收失效。采用新执行配置前，请先暂停并等待旧执行结束。'));
  const actions = element('div', '', 'management-queries'), forms = element('div', '', 'management-forms'); tools.append(actions, forms); panel.append(tools);
  const statusBar = element('div', '', 'management-status-bar'), status = element('p', '正在读取会话…', 'management-status muted'); status.setAttribute('role', 'status');
  const reconnect = button('重新连接', () => read(), 'quiet'); reconnect.hidden = true; statusBar.append(status, reconnect); panel.append(statusBar);
  const input = document.createElement('form'), message = textarea('management-message', '', { rows: 3, placeholder: '发消息，或告诉我你想推进什么…' });
  input.className = 'management-input'; message.setAttribute('aria-label', '管理消息'); message.maxLength = 16000;
  const send = element('button', '发送'), stopButton = button('停止', async () => {
    const id = active, owner = conversation; if (!id) return;
    try { await api(endpoint + '/conversations/' + owner + '/messages/' + id + '/stop', 'POST', {}); } catch (err) { showError(err); }
  }, 'quiet');
  send.type = 'submit'; send.disabled = true; stopButton.hidden = true;
  const footer = element('div', '', 'management-input-footer'), controls = element('div', '', 'actions');
  controls.append(stopButton, send); footer.append(element('span', '支持 Markdown · Ctrl / ⌘ + Enter 发送', 'muted'), controls); input.append(message, footer); panel.append(input);
  let conversation = null, cursor = 0, active = null, reading = null, scopeGeneration = 0, streamController = null, formGeneration = 0;
  let disposed = false, opening = false, submitting = false, historyReady = false, toolsOpen = false, toolsDirty = true, followOutput = true, unseenOutput = false, renderFrame = 0;
  const pendingMarkdown = new Set();
  const drafts = new Map(), turns = new Map(), messages = new Map();
  const alive = generation => !disposed && panel.isConnected && me?.id === user && generation === scopeGeneration;
  const showError = err => { if (!disposed) { status.textContent = err.message; status.classList.add('view-error'); } };
  const selectedWithin = node => {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode));
  };
  const holdingReading = () => selectedWithin(feed) || document.activeElement === message && message.value.length > 0;
  feed.addEventListener('scroll', () => {
    followOutput = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;
    if (followOutput && !holdingReading()) { unseenOutput = false; latest.hidden = true; }
  });
  const scrollOutput = (force = false) => {
    if (force) followOutput = true;
    else if (holdingReading()) followOutput = false;
    if (followOutput) { feed.scrollTop = feed.scrollHeight; unseenOutput = false; }
    latest.hidden = !unseenOutput;
  };
  function flushMarkdown(force = false) {
    renderFrame = 0;
    const top = feed.scrollTop; let rendered = false;
    for (const item of pendingMarkdown) {
      // Replacing a selected answer's DOM would destroy the selection even if scrolling were disabled.
      if (!force && selectedWithin(item.body)) continue;
      renderManagementMarkdown(item.body, item.text); pendingMarkdown.delete(item); rendered = true;
    }
    if (rendered) unseenOutput = true;
    if (!followOutput) feed.scrollTop = top;
    scrollOutput();
  }
  const scheduleMarkdown = () => { if (!renderFrame) renderFrame = requestAnimationFrame(() => flushMarkdown()); };
  const selectionChanged = () => { if (!disposed && panel.isConnected && pendingMarkdown.size && !selectedWithin(feed)) scheduleMarkdown(); };
  document.addEventListener('selectionchange', selectionChanged);
  const queueMarkdown = answer => { pendingMarkdown.add(answer); scheduleMarkdown(); };
  const updateBusy = () => {
    message.disabled = opening || !conversation;
    for (const suggestion of welcome.querySelectorAll('button')) suggestion.disabled = message.disabled;
    send.disabled = opening || !historyReady || submitting || !!active; stopButton.hidden = !active;
    fresh.disabled = opening || submitting; input.classList.toggle('is-running', !!active); onActivity(!!active);
  };
  function showTools(open) {
    toolsOpen = open; tools.hidden = !open; feedWrap.hidden = open; feed.hidden = open; input.hidden = open;
    toolsButton.textContent = open ? '返回对话' : '快捷操作'; toolsButton.setAttribute('aria-expanded', String(open));
    if (open && toolsDirty) void refreshTools();
  }
  async function refreshTools() {
    const generation = scopeGeneration;
    try { await configureForms(); } catch (err) { if (alive(generation)) { toolsDirty = true; forms.replaceChildren(note('快捷操作暂不可用：' + err.message), button('重新读取', refreshTools, 'quiet')); } }
  }
  const target = () => scope.value.startsWith('project:') ? { project_id: scope.value.slice(8) } : {};
  const query = (operation, targetValue = target()) => submit({ query: { operation, target: targetValue, arguments: {} } });
  // One pending command at a time across the whole console (#355): opening another preview drops the earlier one, and a
  // write leaves this page only after 确认执行 — for a quick action and for a receipt's rollback alike.
  let pendingPreview = null;
  function previewCommand(slot, command, context) {
    pendingPreview?.(); const drawn = managementPreview(command, context);
    const close = () => { if (pendingPreview === close) pendingPreview = null; slot.replaceChildren(); };
    drawn.cancel.addEventListener('click', close);
    drawn.confirm.addEventListener('click', async () => {
      drawn.confirm.disabled = true;
      if (await submit({ command })) close(); else drawn.confirm.disabled = false;
    });
    pendingPreview = close; slot.replaceChildren(drawn.box); drawn.box.scrollIntoView({ block: 'nearest' });
    return drawn;
  }
  actions.append(button('查询项目', () => query('list_projects', {}), 'quiet'), button('查询任务', () => query('list_tasks'), 'quiet'), button('查询有效配置', () => query('get_effective_config'), 'quiet'), button('成本与预算', () => query('get_usage'), 'quiet'), button('操作审计', () => query('list_audit'), 'quiet'), button('重新连接', () => read(), 'quiet'));
  const turn = id => {
    if (turns.has(id)) return turns.get(id);
    welcome.hidden = true;
    const record = messages.get(id), item = element('article', '', 'management-turn'), request = record?.input;
    if (request) {
      const userMessage = element('div', '', 'management-user');
      userMessage.append(element('strong', '你'), element('p', request.content ?? managementOperationLabels[request.query?.operation ?? request.command?.operation] ?? request.query?.operation ?? request.command?.operation ?? '管理请求')); item.append(userMessage);
    }
    const assistant = element('div', '', 'management-assistant'), avatar = element('span', '✦', 'management-avatar'); avatar.setAttribute('aria-hidden', 'true');
    const content = element('div', '', 'management-assistant-content'), meta = element('div', '', 'management-assistant-meta');
    const badge = element('span', '', 'management-turn-state'), elapsed = element('span', '', 'management-elapsed');
    meta.append(element('strong', '管理助手'), badge, elapsed);
    const progress = element('details', '', 'management-progress'), progressSummary = element('summary', '执行进展'), stepsBody = element('div', '', 'management-steps');
    progress.hidden = true; progress.open = true; progress.append(progressSummary, stepsBody);
    const replies = element('div', '', 'management-replies'); content.append(meta, progress, replies); assistant.append(avatar, content); item.append(assistant); feed.append(item);
    const value = { item, replies, badge, elapsed, progress, progressSummary, stepsBody, steps: [], provisional: null,
      state: record?.state ?? 'pending', stage: '正在连接助手', startedAt: record?.created_at ?? new Date().toISOString(), finishedAt: record?.updated_at, notice: null };
    turns.set(id, value); paintTurn(value); return value;
  };
  function paintTurn(value) {
    const running = ['pending', 'running'].includes(value.state);
    const uncertain = value.steps.some(step => ['unknown', 'executing'].includes(step.state));
    value.badge.textContent = running ? value.stage : { completed: uncertain ? '结果待确认' : value.steps.some(step => step.state === 'failed' || step.state === 'rejected') ? '操作未成功' : '已完成', failed: '处理失败', stopped: '已停止', interrupted: '运行中断' }[value.state] ?? value.state;
    value.badge.dataset.state = running ? 'running' : uncertain ? 'unknown' : value.state;
    const end = running ? Date.now() : Date.parse(value.finishedAt || value.startedAt), seconds = Math.max(0, Math.floor((end - Date.parse(value.startedAt)) / 1000));
    value.elapsed.textContent = seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
    const completed = value.steps.filter(step => step.state === 'succeeded').length;
    value.progressSummary.textContent = '执行进展 · ' + completed + '/' + value.steps.length + ' 步完成';
    value.progress.hidden = !value.steps.length;
    value.item.setAttribute('aria-busy', String(running));
  }
  function finishTurn(value, state, at) {
    value.state = state; value.finishedAt = at;
    if (value.provisional) { value.provisional.node.classList.remove('management-stream'); value.provisional = null; }
    for (const step of value.steps.filter(step => step.state === 'running')) setStepState(step, state === 'completed' ? 'unknown' : 'interrupted');
    if (state === 'interrupted' && !value.notice) {
      value.notice = element('p', '服务重启中断了这次处理。已产生的结果保留在执行进展中，请核对后再继续。', 'management-run-notice'); value.replies.append(value.notice);
    }
    paintTurn(value);
  }
  function answer(value) {
    if (value.provisional) return value.provisional;
    const node = element('article', '', 'management-answer management-stream'), body = element('div', '', 'management-markdown');
    const item = { node, body, text: '' }, actions = element('div', '', 'management-answer-actions');
    const copy = button('复制回答', async () => {
      try { await navigator.clipboard.writeText(item.text); copy.textContent = '已复制'; }
      catch { showError(new Error('复制失败，请选中回答后复制。')); }
    }, 'quiet');
    actions.append(copy); node.append(body, actions); value.replies.append(node); value.provisional = item; return item;
  }
  function setStepState(step, state) {
    step.state = state; step.box.dataset.state = state;
    step.status.textContent = { running: '进行中', succeeded: '已完成', failed: '失败', rejected: '已拒绝', unknown: '待确认', executing: '执行中', interrupted: '结果未确认' }[state] ?? state;
  }
  function toolStep(value, data, sequence) {
    const box = element('details', '', 'management-step'), summary = element('summary', '', 'management-step-summary');
    // The assistant's own independent tasks (#312) are named by their title; the inner queries and commands show as their own steps.
    const own = { start_own_task: '独立任务', continue_own_task: '继续独立任务', list_own_tasks: '查看独立任务' }[data.name];
    const operation = data.arguments?.operation, caption = own ? own + (data.arguments?.title ? '：' + data.arguments.title : '')
      : managementOperationLabels[operation] ?? operation ?? (data.name === 'management_command' ? '执行操作' : '查询事实');
    const indicator = element('span', '', 'management-step-indicator'); indicator.setAttribute('aria-hidden', 'true');
    const state = element('span', '', 'management-step-status'), detail = element('div', '', 'management-step-detail');
    summary.append(indicator, element('span', caption, 'management-step-caption'), state); box.append(summary, detail); value.stepsBody.append(box);
    if (data.arguments) {
      const args = element('details', '', 'management-step-arguments'); args.append(element('summary', '查看请求参数'), element('pre', JSON.stringify(data.arguments, null, 2))); detail.append(args);
    }
    const step = { id: data.call_id ?? 'legacy-' + sequence, box, detail, status: state, name: data.name, state: 'running' };
    value.steps.push(step); setStepState(step, 'running'); paintTurn(value); return step;
  }
  // The event log keeps a receipt as it stood when the call ran, so every rendered receipt re-reads its command before
  // telling the person what is true now; re-reading never repeats the command.
  function commandReceipt(parent, receipt, step, onState = () => {}) {
    const box = element('details', '', 'management-observation management-receipt'), summary = element('summary', ''), body = element('div', '', 'management-receipt-body');
    box.open = true; box.append(summary, body); parent.append(box);
    const view = { box, step, receipt, busy: false };
    const repaint = next => {
      if (next) view.receipt = { ...view.receipt, ...next };
      const value = view.receipt;
      // A failed command carries its own server reason; name the one the console can explain instead of a bare failure.
      const shown = value.state === 'failed' && value.result?.error === 'command_operator_required' ? 'not_operator' : value.state;
      const [caption, explanation] = managementCommandState(shown);
      box.dataset.state = value.state;
      summary.replaceChildren(element('strong', '操作 ' + (managementOperationLabels[value.operation] ?? value.operation)), element('span', ' · ' + caption, 'management-receipt-state'));
      body.replaceChildren(element('p', explanation, 'management-receipt-note'), element('p', '发起人 ' + value.principal_id + ' · 项目 ' + value.project_id + ' · 更新于 ' + timestamp(value.updated_at), 'management-receipt-meta'), element('p', '具体变更：' + (managementOperationLabels[value.operation] ?? value.operation) + '（目标 ' + (value.target?.task_id ?? value.target?.workflow_id ?? value.project_id ?? '—') + '）', 'management-receipt-change'));
      if (value.result?.notice) body.append(element('p', String(value.result.notice)));
      if (value.before_revision) body.append(note('版本 ' + value.before_revision.slice(0, 12) + ' → ' + (value.after_revision ?? value.before_revision).slice(0, 12)));
      if (value.arguments) { const args = element('details', ''); args.append(element('summary', '查看请求参数'), element('pre', JSON.stringify(value.arguments, null, 2))); body.append(args); }
      if (value.result?.diff) { const diff = element('details', ''); diff.append(element('summary', '查看配置差异'), element('pre', JSON.stringify(value.result.diff, null, 2))); body.append(diff); }
      if (value.result?.pr_url) body.append(link(value.result.pr_url, '查看配置 PR（待合入）'));
      // The card stays a summary; the structured, bookmarked view of the same receipt is the page behind this link.
      const links = element('p', ''); links.append(managementReceiptLink('#/management/commands/' + value.id, '回执详情'), ' · ', managementReceiptLink('/api/management/commands/' + value.id, '原始回执（JSON）'));
      if (value.project_id) links.append(' · ', link('#/projects/' + value.project_id + '/roles', '配置'), ' · ', link('#/projects/' + value.project_id + '/activity', '任务'));
      body.append(links);
      const taskId = value.target?.task_id ?? (value.operation === 'task.create' ? value.result?.id : null);
      if (taskId) body.append(button('查看任务', () => openTask(taskId), 'quiet'));
      // A rollback writes too, so it takes the same preview→confirm path as every other console write (#355): the receipt
      // shows the command it would send, and nothing is submitted until 确认执行.
      if (value.result?.rollback && value.state !== 'rejected') {
        const slot = element('div', '', 'management-command-preview-slot');
        body.append(button('按原值回滚', () => previewCommand(slot, value.result.rollback, { project: value.project_id }), 'quiet'), slot);
      }
      if (['unknown', 'executing'].includes(value.state)) body.append(button('对账并回读', reconcile, 'quiet'));
      const details = element('details', ''); details.append(element('summary', '原始事实与回执'), element('pre', JSON.stringify(value, null, 2))); body.append(details);
      onState(value);
    };
    view.paint = repaint;
    // A re-read is read-only: it may repaint the card but never repeats a command.
    const refresh = () => view.receipt.id ? api(endpoint + '/commands/' + view.receipt.id, 'GET').then(next => {
      if (next && panel.isConnected && me?.id === user) repaint(next);
    }).catch(() => { /* Keep the recorded receipt when the re-read fails. */ }) : Promise.resolve();
    async function reconcile() {
      if (view.busy || !view.receipt.id) return;
      view.busy = true; repaint();
      try { repaint(await api(endpoint + '/commands/' + view.receipt.id + '/resume', 'POST', {})); }
      catch (err) { showError(err); }
      finally { view.busy = false; repaint(); }
    }
    repaint();
    void refresh();
    return view;
  }
  const output = (parent, label, value, receipt = false) => {
    const box = element(receipt ? 'details' : 'article', '', 'management-observation' + (receipt ? ' management-receipt' : ' management-answer'));
    box.append(element(receipt ? 'summary' : 'strong', label));
    if (typeof value === 'string') box.append(element('p', value));
    else {
      if (value.task) {
        box.open = true; const task = value.task;
        box.append(element('p', task.summary + ' · ' + (states[task.status]?.[0] ?? task.status)), element('p', '当前阶段：' + (phaseLabels[task.phase] ?? task.phase)));
        if (task.error_code) box.append(element('p', (task.error_cause?.label ?? '等待原因') + ' · ' + task.error_code), element('p', task.error_detail ?? task.error_cause?.description ?? ''));
        box.append(button('查看任务', () => openTask(task.id), 'quiet'), ' · ', link(value.logs_url, '原始日志'), ' · ', link(value.runs_url, '执行记录'));
        if (value.allowed_next_steps?.length) box.append(note('允许的下一步：' + value.allowed_next_steps.map(op => ({ 'task.pause': '暂停', 'task.cancel': '取消', 'task.retry': '重试', 'task.instructions': '追加指令', 'task.contract': '修订目标与验收', 'task.adopt-config': '采用新配置' }[op] ?? op)).join('、')));
      } else if (value.projects) for (const project of value.projects) box.append(element('p', project.full_name + ' · ' + (project.enabled ? '已启用' : '已停用') + (project.configuration_gaps.length ? ' · 待补：' + project.configuration_gaps.join('、') : '')));
      else if (value.tasks) for (const task of value.tasks) box.append(element('p', task.task.summary + ' · ' + (states[task.task.status]?.[0] ?? task.task.status)));
      else if (value.workflows) for (const workflow of value.workflows) box.append(element('p', workflow.name + ' · 生效来源：' + (layerNames[workflow.prompt.source] ?? workflow.prompt.source) + ' · 版本 ' + workflow.prompt.version.slice(0, 12)));
      const details = element('details', ''); details.append(element('summary', '原始事实与回执'), element('pre', JSON.stringify(value, null, 2))); box.append(details);
    }
    parent.append(box); return box;
  };
  function event(row) {
    if (row.sequence <= cursor) return; cursor = row.sequence;
    const data = row.data, currentTurn = turn(row.message_id), replies = currentTurn.replies;
    if (row.type === 'running' || row.type === 'model_start') {
      currentTurn.state = 'running'; currentTurn.stage = data.turn > 0 ? '正在整理结果' : '正在分析请求';
      if (row.type === 'model_start' && currentTurn.provisional) { currentTurn.provisional.node.classList.remove('management-stream'); currentTurn.provisional = null; }
    } else if (row.type === 'tool_call') {
      if (currentTurn.provisional) { currentTurn.provisional.node.classList.remove('management-stream'); currentTurn.provisional = null; }
      const step = toolStep(currentTurn, data, row.sequence);
      currentTurn.stage = step.box.querySelector('.management-step-caption').textContent;
    } else if (row.type === 'tool_result') {
      const receipt = data.result;
      const step = currentTurn.steps.find(item => data.call_id ? item.id === data.call_id : item.name === data.name && item.state === 'running') ?? toolStep(currentTurn, data, row.sequence);
      const ownStep = ['start_own_task', 'continue_own_task', 'list_own_tasks'].includes(step.name);
      setStepState(step, receipt.operation ? receipt.state : ownStep && receipt.error ? 'failed' : 'succeeded');
      if (receipt.operation) commandReceipt(replies, receipt, step, next => { setStepState(step, next.state); paintTurn(currentTurn); });
      else output(step.detail, ownStep ? '独立任务结果' : '查询事实', receipt, true);
      currentTurn.stage = '正在整理结果';
      if (receipt.id && receipt.operation) toolsDirty = true;
      onActivity(!!active, true);
    } else if (row.type === 'reply') {
      const item = answer(currentTurn); item.text = data.text; item.node.classList.remove('management-stream'); queueMarkdown(item); currentTurn.provisional = null;
      onActivity(!!active, true);
    } else if (row.type === 'message') {
      // A progress message the assistant sent while working (#435): its own labelled entry, in order, before the final answer.
      if (currentTurn.provisional) { currentTurn.provisional.node.classList.remove('management-stream'); currentTurn.provisional = null; }
      const item = answer(currentTurn); item.node.classList.remove('management-stream'); item.node.classList.add('management-progress-message');
      item.node.prepend(element('span', '进展消息 ' + data.sequence, 'management-progress-label'));
      item.text = data.text; queueMarkdown(item); currentTurn.provisional = null;
      currentTurn.stage = '已发送进展'; onActivity(!!active, true);
    } else if (row.type === 'text') {
      const item = answer(currentTurn); item.text += data.delta ?? ''; queueMarkdown(item);
      currentTurn.stage = '正在回复'; status.textContent = '助手正在回复…';
    } else if (row.type === 'tool_error') {
      const step = currentTurn.steps.find(item => data.call_id ? item.id === data.call_id : item.name === data.name && item.state === 'running') ?? toolStep(currentTurn, data, row.sequence);
      setStepState(step, currentTurn.state === 'stopped' ? 'interrupted' : 'failed');
      step.detail.append(element('p', '操作未完成：' + data.error, 'management-run-notice'));
    } else if (row.type === 'done') finishTurn(currentTurn, data.state ?? 'completed', row.created_at);
    else if (row.type === 'error' || row.type === 'stopped') {
      finishTurn(currentTurn, row.type === 'error' ? 'failed' : 'stopped', row.created_at);
      if (!currentTurn.notice) {
        currentTurn.notice = element('p', row.type === 'stopped' ? '已停止后续处理。已提交的操作仍保留结果，请在执行进展中核对。' : data.notice ? '这次处理未完成：' + data.notice : '这次处理未完成：' + data.error + '。可以检查管理助手的模型与权限配置后继续。', 'management-run-notice');
        replies.append(currentTurn.notice);
      }
      onActivity(!!active, true);
    }
    paintTurn(currentTurn); unseenOutput = true; scrollOutput();
  }
  async function read() {
    if (reading || !conversation || disposed) return reading;
    reconnect.hidden = true; status.classList.remove('view-error');
    const id = conversation, generation = scopeGeneration;
    const work = (async () => {
      try {
        while (alive(generation) && conversation === id) {
          streamController = new AbortController();
          const page = await api(endpoint + '/conversations/' + id + '/events?after=' + cursor, 'GET', undefined, { signal: streamController.signal });
          if (!alive(generation) || conversation !== id) return;
          for (const message of page.messages) messages.set(message.id, message);
          for (const row of page.events) event(row);
          const pending = page.messages.find(message => ['pending', 'running'].includes(message.state));
          active = pending?.id ?? null; historyReady = !page.has_more; updateBusy();
          if (page.has_more) continue;
          for (const message of page.messages) {
            const value = turn(message.id);
            if (!['pending', 'running'].includes(message.state)) finishTurn(value, message.state, message.updated_at);
          }
          if (!pending) { status.textContent = '就绪 · 操作结果可在执行进展中核对'; break; }
          status.textContent = '处理中 · 可以继续写草稿，收起窗口后仍会继续';
          streamController = new AbortController();
          const response = await fetch(endpoint + '/conversations/' + id + '/events?stream=1&after=' + cursor, { signal: streamController.signal });
          if (!response.ok) throw new Error('读取运行流失败，请重新连接。');
          const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
          for (;;) {
            const part = await reader.read(); if (!alive(generation) || conversation !== id) { await reader.cancel(); return; }
            if (part.done) { if (text.trim()) event(JSON.parse(text)); break; } text += decoder.decode(part.value, { stream: true });
            let at; while ((at = text.indexOf('\n')) >= 0) { const line = text.slice(0, at); text = text.slice(at + 1); if (line) event(JSON.parse(line)); }
          }
        }
      } catch (err) { if (alive(generation)) { reconnect.hidden = false; showError(new Error('连接已中断，已提交的操作会继续。点击重新连接以读取进展。' + err.message)); } }
    })();
    reading = work;
    try { await work; } finally { if (reading === work) reading = null; if (!disposed && generation !== scopeGeneration && conversation) void read(); }
  }
  async function openConversation(create = false, selected = null) {
    if (conversation) drafts.set(conversation, message.value);
    const generation = ++scopeGeneration; formGeneration++; streamController?.abort(); conversation = null; active = null; submitting = false; historyReady = false; opening = true; updateBusy();
    remember(scopeKey, scope.value); cursor = 0; turns.clear(); messages.clear(); pendingMarkdown.clear(); followOutput = true; unseenOutput = false; latest.hidden = true; reconnect.hidden = true; feed.replaceChildren(welcome); welcome.hidden = false; message.value = '';
    forms.replaceChildren(); toolsDirty = true; status.classList.remove('view-error'); status.textContent = '正在读取会话…';
    try {
      const all = (await api(endpoint + '/conversations')).conversations.filter(item => item.scope === scope.value);
      if (!alive(generation)) return;
      conversations.replaceChildren(...all.map(item => { const option = element('option', timestamp(item.created_at) + ' · ' + item.id.slice(0, 8)); option.value = item.id; return option; }));
      if (create || !all.length) {
        const result = await api(endpoint + '/conversations', 'POST', { scope: scope.value }); if (!alive(generation)) return;
        conversation = result.conversation.id; const option = element('option', '新会话 ' + conversation.slice(0, 8)); option.value = conversation; conversations.prepend(option);
      } else conversation = all.find(item => item.id === (selected || stored(conversationKey())))?.id ?? all[0].id;
      conversations.value = conversation; remember(conversationKey(), conversation); message.value = drafts.get(conversation) ?? '';
      if (toolsOpen) void refreshTools(); void read();
    } finally { if (alive(generation)) { opening = false; updateBusy(); } }
  }
  async function submit(body) {
    if (!conversation || opening || !historyReady || submitting || active) return false;
    const id = conversation, generation = scopeGeneration; submitting = true; updateBusy(); status.classList.remove('view-error');
    try {
      const result = await api(endpoint + '/conversations/' + id + '/messages', 'POST', { source_message: crypto.randomUUID(), ...body });
      if (!alive(generation) || conversation !== id) return true;
      messages.set(result.id, { input: body, state: result.state, created_at: new Date().toISOString() }); turn(result.id); active = result.id;
      followOutput = true; showTools(false); sessions.open = false; scrollOutput(true); status.textContent = '请求已发送 · 正在连接助手'; void read(); return true;
    } catch (err) { if (alive(generation)) showError(err); return false; }
    finally { if (alive(generation)) { submitting = false; updateBusy(); } }
  }
  async function configureForms(){
    const generation=++formGeneration; toolsDirty=false;
    // One pending preview at a time: clicking another write replaces it instead of stacking two commands. A confirm that
    // the page cannot send (connection, authorization) keeps the preview so the person can retry or cancel it.
    const previewSlot = element('div', '', 'management-command-preview-slot');
    const confirmCommand = (command, context) => previewCommand(previewSlot, command, context);
    forms.replaceChildren();if(!target().project_id){forms.append(note('选择具体项目后可以修改配置或管理任务。'));return;}
    const project=target().project_id;
    const effective=await api(endpoint+'/query','POST',{operation:'get_effective_config',target:{project_id:project},arguments:{}});
    if(generation!==formGeneration)return;
    const workflow=document.createElement('select');workflow.setAttribute('aria-label','工作类型');
    for(const w of effective.workflows){const o=element('option',w.name+' · '+w.prompt.source);o.value=w.id;workflow.append(o);}
    const prompt=textarea('prompt','',{rows:5});prompt.setAttribute('aria-label','默认提示词');
    const chosen=()=>effective.workflows.find(w=>w.id===workflow.value);
    const fill=()=>{prompt.value=chosen()?.prompt.effective??'';};workflow.onchange=fill;fill();
    const form=document.createElement('form'),save=element('button','保存默认提示词');form.append(element('h3','Manager 章节'),field('工作类型',workflow),field('默认提示词',prompt),note('保存的是 Manager 提示词里这类工作的章节。仓库来源高于控制台层：被覆盖时会保存章节并明确显示实际行为尚未改变；配置 PR 合入后才生效。'),save);
    form.onsubmit=e=>{e.preventDefault();confirmCommand({operation:'workflow.update',target:{project_id:project,workflow_id:workflow.value},arguments:{prompt:prompt.value},expected_revision:effective.revision},{project,workflow:chosen()?.name});};if(chosen()?.prompt.path){const publish=button('创建配置 PR',()=>confirmCommand({operation:'configuration.pr',target:{project_id:project},arguments:{path:chosen().prompt.path,content:prompt.value},expected_revision:effective.revision},{project,workflow:chosen()?.name}),'quiet');form.append(publish);}
    forms.append(form);
    const tasks=(await api(endpoint+'/query','POST',{operation:'list_tasks',target:{project_id:project},arguments:{limit:100}})).tasks;
    if(generation!==formGeneration)return;
    const task=document.createElement('select');task.setAttribute('aria-label','管理任务');
    for(const t of tasks){const o=element('option',t.task.summary+' · '+t.task.status);o.value=t.task.id;task.append(o);}
    const taskBox=element('section','');taskBox.append(element('h3','任务管理'),field('任务',task));
    taskBox.append(button('查看阻塞原因',()=>query('get_task',{project_id:project,task_id:task.value}), 'quiet'));
    for(const [action,caption] of [['pause','暂停任务'],['cancel','取消任务'],['retry','重试任务'],['adopt-config','采用新执行配置']])taskBox.append(button(caption,async()=>{try{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});confirmCommand({operation:'task.'+action,target:{project_id:project,task_id:task.value},arguments:{},expected_revision:current.revision},{project,task:tasks.find(item=>item.task.id===task.value)?.task.summary});}catch(e){status.textContent=e.message;}},'quiet'));
    const instruction=textarea('instruction','',{rows:2});instruction.setAttribute('aria-label','补充指令');taskBox.append(field('追加补充指令',instruction),button('追加指令',async()=>{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});confirmCommand({operation:'task.instructions',target:{project_id:project,task_id:task.value},arguments:{instruction:instruction.value},expected_revision:current.revision},{project,task:tasks.find(item=>item.task.id===task.value)?.task.summary});},'quiet'));
    forms.append(taskBox, previewSlot);
    if (typeof renderSchedules === 'function') {
      const schedules = element('section', ''); forms.append(schedules);
      try { await renderSchedules(schedules, project); } catch (e) { schedules.append(note('定时计划暂不可用：' + e.message)); }
    }
  }
  input.onsubmit = async event => {
    event.preventDefault(); const value = message.value, id = conversation;
    if (!value.trim() || !await submit({ content: value })) return;
    // The receipt belongs to the sending conversation even if another one is now visible. Drop the sent draft,
    // but keep any newer text the person composed while waiting for it.
    if (drafts.get(id) === value) drafts.delete(id);
    if (conversation === id && message.value === value) message.value = '';
  };
  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); input.requestSubmit(); }
  });
  scope.onchange = () => openConversation().catch(showError);
  conversations.onchange = () => openConversation(false, conversations.value).catch(showError);
  const elapsedTimer = setInterval(() => { for (const value of turns.values()) if (['pending', 'running'].includes(value.state)) paintTurn(value); }, 1000);
  try { await openConversation(); } catch (err) { clearInterval(elapsedTimer); document.removeEventListener('selectionchange', selectionChanged); throw err; }
  return {
    async setScope(value) { if (!available(value)) { showError(new Error('当前账号无权管理这个项目。')); return; } if (scope.value !== value) { scope.value = value; await openConversation(); } },
    focus() { if (toolsOpen) toolsButton.focus(); else message.focus(); },
    dispose() { disposed = true; scopeGeneration++; formGeneration++; streamController?.abort(); clearInterval(elapsedTimer); cancelAnimationFrame(renderFrame); document.removeEventListener('selectionchange', selectionChanged); pendingMarkdown.clear(); drafts.clear(); }
  };
}
