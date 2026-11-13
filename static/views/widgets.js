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
function scroller(node) { return getComputedStyle(node).overflowY === 'auto' ? node : node.parentElement; }
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
      catch (err) { if (settleConfirm !== settle) return; confirmBusy = false; cancel.disabled = submit.disabled = false; status.className = 'confirm-status error'; status.textContent = err.message; }
    });
    confirmView.replaceChildren(form); confirmView.showModal(); (field || cancel).focus();
  });
}
const askConfirm = options => confirmDialog(options).then(value => value === true);
// Esc closes the dialog as a cancel, except while its action is running.
confirmView.addEventListener('cancel', event => { if (confirmBusy) event.preventDefault(); });
confirmView.addEventListener('close', () => { if (!confirmView.open) settleConfirm?.(null); });
const taskView = dialog('task-view', `<div class="view-head"><div class="title-group"><h2 id="task-title"></h2><span id="task-badges" class="actions"></span></div><div id="task-actions" class="actions"></div></div>
<p id="task-error" class="view-error" role="alert"></p>
<section id="task-next" class="task-next" aria-labelledby="task-next-heading" hidden><h3 id="task-next-heading">下一步</h3><p id="task-next-text" class="task-next-text"></p></section>
<div id="task-picker" class="task-picker" hidden></div>
<div id="task-layout" class="task-layout"><section class="timeline-panel" aria-labelledby="timeline-heading"><h3 id="timeline-heading">公开工作日志</h3><p class="muted">展示公开输出、工具调用与结果；执行阶段和验收结论按实际记录分别呈现。</p><div id="task-log-controls" class="task-log-controls"></div><ol id="timeline" class="timeline"></ol><div id="timeline-command" class="step step-running" aria-live="off" hidden></div><p id="timeline-live" class="live" role="status" hidden></p></section><aside id="task-side" class="task-side" aria-label="任务信息"></aside></div>`);
taskView.setAttribute('aria-labelledby', 'task-title');

