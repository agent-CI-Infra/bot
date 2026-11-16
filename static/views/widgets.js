// An event task has no Issue or PR: it names its summary instead (the release or the Actions run).
function objectLabel(task) { return task.object_number == null ? String(task.summary || kindLabels[task.kind] || task.kind) : `${task.kind.endsWith('.pr') ? 'PR' : 'Issue'} #${task.object_number}`; }
function githubUrl(task) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(task.full_name || '') || !task.object_number) return null;
  return `https://github.com/${task.full_name}/${task.kind.endsWith('.pr') ? 'pull' : 'issues'}/${task.object_number}`;
}
function link(url, text, className) {
  try {
    const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
    const a = element('a', text, className); a.href = parsed.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  } catch { return element('span', text, className); }
}
function clipText(value, limit) { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; }
function badge(caption, tone) { return element('span', caption, 'status' + (tone ? ' status-' + tone : '')); }
function exitBadge(result) {
  if (!result) return badge('无结果');
  if (result.error) return badge(result.error, 'danger');
  if (result.timed_out) return badge('超时', 'warning');
  return badge(`退出码 ${result.exit_code}`, result.exit_code === 0 ? 'success' : 'danger');
}
function collapsible(title, text, open = false) {
  const details = element('details', '', 'fold'); details.open = open;
  details.append(element('summary', title), element('pre', text, 'output')); return details;
}
function output(text) { return collapsible(`输出（${String(text).split('\n').length} 行）`, text, text.length < 800); }
function button(caption, onClick, className = 'quiet') { const b = element('button', caption, className); b.type = 'button'; b.addEventListener('click', onClick); return b; }
function card(title) { const section = element('section', '', 'side-card'); section.append(element('h3', title)); return section; }
function facts(rows) {
  const list = element('dl', '', 'facts');
  for (const [key, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    const dd = element('dd', ''); if (value instanceof Node) dd.append(value); else dd.textContent = String(value);
    list.append(element('dt', key), dd);
  }
  return list;
}
// Re-rendering every few seconds must not collapse sections the reader opened.
function keepOpen(container, render) {
  const open = new Set([...container.querySelectorAll('details[open] > summary')].map(s => s.textContent));
  render(); container.querySelectorAll('details > summary').forEach(s => { if (open.has(s.textContent)) s.parentElement.open = true; });
}
function networkText(pc) { return pc.network_policy === 'internet egress' ? '可访问外网（项目独立网络）' : pc.network_policy === 'internal, no egress' ? '项目内部网络，无外网' : pc.network_policy; }
function scroller(node) {
  for (let cur = node; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
    if (typeof getComputedStyle === 'function' && ['auto', 'scroll'].includes(getComputedStyle(cur).overflowY)) return cur;
  }
  return document.scrollingElement || document.documentElement || node;
}
function operationId() { return [...crypto.getRandomValues(new Uint8Array(24))].map(n => n.toString(16).padStart(2, '0')).join(''); }
// busy: tasks are running on the computer, so stopping it asks for confirmation first.
function environmentButtons(environment, busy, after, report) {
  return [['start', '启动'], ['stop', '停止'], ['reset', '重置']].map(([action, caption]) => {
    const b = button(caption, async () => {
      if (action === 'reset' && !await askConfirm({ title: `重置 ${environment.full_name} 的虚拟电脑？`, body: ['旧工作卷会保留，新环境从空工作卷开始。'], action: '重置', danger: true })) return;
      if (action === 'stop' && busy && !await askConfirm({ title: `停止 ${environment.full_name} 的虚拟电脑？`, body: ['仓库会被停用，正在执行的任务都会中止。'], action: '停止', danger: true })) return;
      b.disabled = true;
      try { await api(`/api/environments/${environment.repository_id}/${action}`, 'POST', { operation_id: operationId(), generation: environment.generation }); }
      catch (err) { report(err); }
      await after();
    });
    b.disabled = !!environment.operation_pending || !environment.generation || ['provisioning', 'recovering', 'resetting', 'busy'].includes(environment.state)
      || action === 'start' && ['ready', 'reset_failed'].includes(environment.state) || action === 'stop' && environment.state === 'stopped';
    return b;
  });
}

function dialog(id, markup) {
  const view = document.createElement('dialog'); view.id = id; view.className = 'wide'; view.innerHTML = markup; document.body.append(view); return view;
}
// The console's own confirmation, in place of the browser's confirm() and prompt(). `body` items are paragraphs; an array
// item is a bulleted list. With `input` the dialog asks for one value and resolves to it. With `run` the dialog stays open
// while the action runs, shows `progress`, and shows the action's error in place so it can be tried again. Resolves the
// confirmed value (true without input) or null when cancelled, closed with Esc, or replaced by a newer request.
const confirmView = document.createElement('dialog'); confirmView.className = 'confirm-dialog'; confirmView.setAttribute('aria-labelledby', 'confirm-title');
document.body.append(confirmView);
let settleConfirm = null, confirmBusy = false;
function confirmDialog({ title, body = [], action = '确认', danger = false, input = null, run = null, progress = '正在处理…' }) {
  settleConfirm?.(null);
  return new Promise(resolve => {
    const settle = value => { if (settleConfirm !== settle) return; settleConfirm = null; confirmBusy = false; if (confirmView.open) confirmView.close(); resolve(value); };
    settleConfirm = settle;
    const form = element('form', '', 'confirm-form'), head = element('div', '', 'confirm-head'), text = element('div', '', 'confirm-body');
    // #749: the body is what a screen reader was missing — including a list of what a delete stops or removes. The one
    // body container carries a fixed id, so the dialog can name it without collecting a second id on every open.
    text.id = 'confirm-description';
    const heading = element('h2', title); heading.id = 'confirm-title';
    head.append(element('span', danger ? '!' : '?', 'confirm-icon' + (danger ? ' danger' : '')), heading);
    for (const item of body) {
      if (!Array.isArray(item)) { text.append(element('p', item)); continue; }
      const list = element('ul', ''); item.forEach(line => list.append(element('li', line))); text.append(list);
    }
    let field = null;
    if (input) {
      field = document.createElement('input'); Object.assign(field, { type: input.type || 'text', name: 'value', autocomplete: input.type === 'password' ? 'new-password' : 'off', spellcheck: false });
      const label = element('label', input.label); label.append(field); text.append(label);
    }
    const status = element('p', '', 'confirm-status'), actions = element('div', '', 'confirm-actions');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const cancel = button('取消', () => settle(null)), submit = element('button', action, danger ? 'danger' : ''); submit.type = 'submit';
    actions.append(cancel, submit); form.append(head, text, status, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (confirmBusy) return;
      const value = field ? field.value.trim() : true;
      if (field && !value) { status.className = 'confirm-status error'; status.textContent = `请填写${input.label}`; field.focus(); return; }
      if (!run) { settle(value); return; }
      confirmBusy = true; cancel.disabled = submit.disabled = true; status.className = 'confirm-status progress'; status.textContent = progress;
      try { await run(value); settle(value); }
      catch (err) { if (settleConfirm !== settle) return; confirmBusy = false; cancel.disabled = submit.disabled = false; status.className = 'confirm-status error'; status.textContent = readErrorText(err); }
    });
    confirmView.replaceChildren(form);
    // A request without a body points at nothing: a dangling aria-describedby would be worse than none, and an input's
    // own <label> still names the field. The id stays on the container either way.
    if (body.length) confirmView.setAttribute('aria-describedby', 'confirm-description'); else confirmView.removeAttribute('aria-describedby');
    confirmView.showModal(); (field || cancel).focus();
  });
}
const askConfirm = options => confirmDialog(options).then(value => value === true);
// Esc closes the dialog as a cancel, except while its action is running.
confirmView.addEventListener('cancel', event => { if (confirmBusy) event.preventDefault(); });
confirmView.addEventListener('close', () => { if (!confirmView.open) settleConfirm?.(null); });
function slot(tag, id, className = '') {
  const existing = document.getElementById(id);
  if (existing) {
    if (className) existing.className = className;
    return existing;
  }
  const el = document.createElement(tag);
  el.id = id;
  if (className) el.className = className;
  return el;
}

const taskPickerDialog = (() => {
  const view = document.createElement('dialog');
  view.id = 'task-picker-dialog';
  view.className = 'wide task-picker-modal';
  view.setAttribute('aria-labelledby', 'task-picker-title');
  const head = element('div', '', 'view-head'), tg = element('div', '', 'title-group');
  const title = slot('h2', 'task-picker-title');
  tg.append(title);
  head.append(tg, slot('div', 'task-picker-actions', 'actions'));
  const err = slot('p', 'task-picker-error', 'view-error');
  err.setAttribute('role', 'alert');
  view.append(head, err, slot('div', 'task-picker', 'task-picker'));
  document.body.append(view);
  return view;
})();

function ensureTaskDetailView() {
  const host = document.getElementById('console-page');
  let node = document.getElementById('task-view');
  if (!node || !node.classList?.contains('task-detail-page')) {
    node = slot('article', 'task-view', 'task-detail-page');
    node.replaceChildren();
    node.setAttribute('aria-labelledby', 'task-title');

    const backbar = element('div', '', 'task-detail-backbar');
    const backLink = slot('a', 'task-back-link', 'back-link task-back-link');
    backLink.href = '#/projects';
    backLink.textContent = '← 返回工作区';
    backbar.append(backLink);

    const summaryCard = element('section', '', 'task-summary-card');
    summaryCard.setAttribute('aria-labelledby', 'task-title');
    const topRow = element('div', '', 'task-summary-top');
    topRow.append(slot('div', 'task-badges', 'actions task-summary-badges'), slot('div', 'task-actions', 'actions task-summary-actions'));
    const err = slot('p', 'task-error', 'view-error');
    err.setAttribute('role', 'alert');
    const title = slot('h1', 'task-title', 'task-detail-title');
    const goalBox = slot('div', 'task-goal-box', 'task-goal-box');
    const nextSec = slot('section', 'task-next', 'task-next');
    nextSec.hidden = true;
    nextSec.setAttribute('aria-labelledby', 'task-next-heading');
    const nextHeading = slot('h3', 'task-next-heading', 'sr-only');
    nextHeading.textContent = '当前进展';
    nextSec.append(nextHeading, slot('p', 'task-next-text', 'task-next-text'));
    const faultBox = slot('div', 'task-fault-box', 'task-fault-box');
    faultBox.hidden = true;
    const extBar = slot('div', 'task-external-bar', 'task-external-bar');
    extBar.setAttribute('aria-label', '外部关联信息');
    const flowBar = slot('div', 'task-flow-bar', 'task-flow-bar');
    summaryCard.append(topRow, err, title, goalBox, nextSec, faultBox, extBar, flowBar);

    const traceSec = slot('section', 'task-layout', 'task-trace-section');
    traceSec.setAttribute('aria-labelledby', 'timeline-heading');
    const traceHead = element('div', '', 'task-trace-head');
    const traceTitles = element('div', '', 'task-trace-title-group');
    const traceH2 = slot('h2', 'timeline-heading');
    traceH2.textContent = '任务执行过程（按角色流转历史）';
    const traceSub = slot('span', 'task-trace-subtitle', 'muted');
    traceSub.textContent = '已完成角色默认折叠，当前执行中角色默认展开；点击任意步骤可独立展开详情。';
    traceTitles.append(traceH2, traceSub);
    const foldBtns = slot('div', 'task-fold-buttons', 'actions task-fold-buttons');
    const expandAll = slot('button', 'task-expand-all', 'quiet');
    expandAll.type = 'button'; expandAll.textContent = '全部展开';
    const collapseAll = slot('button', 'task-collapse-all', 'quiet');
    collapseAll.type = 'button'; collapseAll.textContent = '全部折叠';
    foldBtns.replaceChildren(expandAll, collapseAll);
    traceHead.append(traceTitles, foldBtns);

    const logControls = slot('div', 'task-log-controls', 'task-log-controls');
    const roleRunsList = slot('div', 'role-runs-list', 'role-runs-list');
    roleRunsList.hidden = true;
    const timeline = slot('ol', 'timeline', 'timeline');
    const liveCmd = slot('div', 'timeline-command', 'step step-running');
    liveCmd.setAttribute('aria-live', 'off');
    liveCmd.hidden = true;
    const liveStatus = slot('p', 'timeline-live', 'live');
    liveStatus.setAttribute('role', 'status');
    liveStatus.hidden = true;
    traceSec.append(traceHead, logControls, roleRunsList, timeline, liveCmd, liveStatus);

    const archiveFold = slot('details', 'task-archive-fold', 'task-archive-fold');
    const archiveSummary = slot('summary', 'task-archive-summary');
    archiveSummary.textContent = '任务契约、优先级调整与完整审计记录';
    const side = slot('aside', 'task-side', 'task-side task-archive-body');
    side.setAttribute('aria-label', '任务信息');
    archiveFold.replaceChildren(archiveSummary, side);

    node.append(backbar, summaryCard, traceSec, archiveFold);
    if (typeof bindTaskDetailControls === 'function') bindTaskDetailControls(node);
  }
  if (host && node.parentElement !== host) {
    host.replaceChildren(node);
    host.hidden = false;
  }
  return node;
}

const taskView = {
  get open() { return Boolean(typeof openTaskId !== 'undefined' && openTaskId); },
  showModal() { ensureTaskDetailView(); },
  close() { if (typeof closeTaskDetail === 'function') closeTaskDetail(); }
};

