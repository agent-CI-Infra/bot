/** Sticky save bar shared by role, basic, model and machine settings (#567). */
function consoleSaveBar({
  status = '已保存',
  dirty = false,
  busy = false,
  conflict = false,
  saveLabel = '保存',
  discardLabel = '放弃更改',
  onSave = null,
  onDiscard = null,
  advanced = null,
  message = null,
  testid = 'console-save-bar',
} = {}) {
  const bar = element('div', '', 'actions console-save-bar');
  bar.dataset.testid = testid;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', '保存更改');
  const statusEl = note(status);
  statusEl.setAttribute('role', 'status');
  statusEl.dataset.testid = 'console-save-status';
  const messageEl = message || element('p', '', 'view-error');
  if (!message) messageEl.setAttribute('role', 'alert');
  const actions = element('div', '', 'console-save-actions');
  const save = button(saveLabel, () => onSave?.(), '');
  save.dataset.testid = 'console-save';
  const discard = button(discardLabel, () => onDiscard?.(), 'quiet');
  discard.dataset.testid = 'console-save-discard';
  actions.append(save, discard);
  bar.append(statusEl, messageEl, actions);
  if (advanced) {
    const fold = element('details', '', 'fold console-save-advanced');
    fold.dataset.testid = 'console-save-advanced';
    fold.append(element('summary', '高级'));
    const body = element('div', '', 'console-save-advanced-body');
    body.append(...(Array.isArray(advanced) ? advanced : [advanced]));
    fold.append(body);
    bar.append(fold);
  }
  const refresh = (next = {}) => {
    if (next.status != null) statusEl.textContent = next.status;
    if (next.dirty != null) dirty = next.dirty;
    if (next.busy != null) busy = next.busy;
    if (next.conflict != null) conflict = next.conflict;
    if (next.saveLabel != null) save.textContent = next.saveLabel;
    // Actions (保存 / 放弃更改) appear only when there is something to save.
    actions.hidden = !dirty;
    save.disabled = !!busy || !!conflict || !dirty;
    discard.disabled = !!busy || !dirty;
    bar.classList.toggle('console-save-bar-dirty', !!dirty);
  };
  refresh({ dirty, busy, conflict, status });
  bar.refresh = refresh;
  bar.statusEl = statusEl;
  bar.saveButton = save;
  bar.discardButton = discard;
  bar.messageEl = messageEl;
  return bar;
}

function plainSaveStatus(dirty, { configured = true, busy = false, unconfiguredText = '尚未保存。可先使用推荐配置。' } = {}) {
  if (busy) return '正在读取或保存…';
  if (configured === false && !dirty) return unconfiguredText;
  return dirty ? '有未保存的更改' : '已保存';
}
