// A settings form: fields, an error line and a save button; `save` receives the form and reports through the error line.
// `after` receives the result text; without it the project page shows the text and reloads.
const projectSettingDrafts = new Map();
function settingsForm(title, nodes, save, { editable = true, caption = '保存', after = null, draftKey = null, hideActions = false, onDraftChange = null } = {}) {
  const target = current, address = location.hash;
  const live = () => current === target && location.hash === address && form.isConnected;
  const section = card(title), form = document.createElement('form'), message = element('p', '', 'view-error'), submit = element('button', caption);
  form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert');
  const set = element('fieldset', ''); set.disabled = !editable; set.append(...nodes); form.append(set, message);
  if (editable && !hideActions) { const actions = element('div', '', 'actions form-actions'); actions.append(submit); form.append(actions); }
  else if (editable && hideActions) { submit.hidden = true; form.append(submit); }
  const key = draftKey && `${me.id}:${me.actor?.tenant_id || ''}:${target.id}:${draftKey}`;
  const draftNotice = element('p', '', 'muted'); draftNotice.setAttribute('role', 'status');
  if (key && editable) {
    const valueOf = control => control.type === 'checkbox' ? control.checked : control.value;
    const baseline = Object.fromEntries([...form.elements].filter(c => c.name).map(c => [c.name, valueOf(c)]));
    const draft = { ...projectSettingDrafts.get(key) };
    for (const [name, value] of Object.entries(draft)) {
      const control = form.elements[name]; if (!control) continue;
      if (control.type === 'checkbox') control.checked = value; else control.value = value;
    }
    const update = () => { draftNotice.textContent = Object.keys(draft).length ? '有未保存的更改' : ''; };
    form.addEventListener('input', event => {
      const control = event.target; if (!control.name) return;
      if (valueOf(control) === baseline[control.name]) delete draft[control.name]; else draft[control.name] = valueOf(control);
      projectSettingDrafts.set(key, draft); update(); onDraftChange?.({ dirty: Object.keys(draft).length > 0 });
    });
    update(); form.prepend(draftNotice);
    const discard = async () => {
      projectSettingDrafts.delete(key); if (live()) await reloadProject();
    };
    section.settingDiscard = discard;
    if (!hideActions) {
      const discardBtn = button('放弃本组草稿', async () => {
        if (!await askConfirm({ title: '放弃未保存的设置？', body: ['仅清除此组草稿，并读取最新已保存设置。'], action: '放弃草稿' })) return;
        await discard();
      }, 'quiet');
      form.querySelector('.form-actions').append(discardBtn);
    }
  }
  section.settingForm = form;
  section.settingDirty = () => !!(key && Object.keys(projectSettingDrafts.get(key) || {}).length);
  section.settingClearDraft = () => { if (key) projectSettingDrafts.delete(key); };
  section.settingCommit = () => new Promise((resolve, reject) => {
    const onDone = event => { form.removeEventListener('setting-committed', onDone); resolve(event.detail); };
    form.addEventListener('setting-committed', onDone, { once: true });
    const onFail = event => { form.removeEventListener('setting-failed', onFail); reject(event.detail); };
    form.addEventListener('setting-failed', onFail, { once: true });
    form.requestSubmit();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled || !editable || !live()) return; message.className = 'view-error'; message.textContent = '';
    const invalid = [...form.querySelectorAll('input')].find(el => !el.checkValidity());
    if (invalid) {
      const label = invalid.closest('label')?.firstChild?.textContent?.trim() || invalid.name, range = invalid.validity.rangeOverflow || invalid.validity.rangeUnderflow;
      message.textContent = range ? `${label}需在 ${invalid.min}–${invalid.max} 之间` : invalid.validity.stepMismatch ? `${label}的取值步长是 ${invalid.step}` : `${label}：${invalid.validationMessage}`; invalid.focus(); form.dispatchEvent(new CustomEvent('setting-failed', { detail: new Error(message.textContent) })); return;
    }
    const submittedDraft = key && projectSettingDrafts.get(key);
    submit.disabled = true; if (key) set.disabled = true;
    // The page re-renders after saving, so the result is shown at the top of the refreshed section.
    try {
      const done = await save(form, text => { message.className = 'view-progress'; message.textContent = text; }), text = typeof done === 'string' && done ? done : '已保存';
      if (key && projectSettingDrafts.get(key) === submittedDraft) projectSettingDrafts.delete(key);
      if (!live()) { form.dispatchEvent(new CustomEvent('setting-committed', { detail: { text, left: true } })); return; }
      form.dispatchEvent(new CustomEvent('setting-committed', { detail: { text } }));
      if (form.skipReload) return;
      if (after) await after(text); else { current.flash = text; await reloadProject(); }
    }
    catch (err) { message.className = 'view-error'; message.textContent = err.message; form.dispatchEvent(new CustomEvent('setting-failed', { detail: err })); } finally { submit.disabled = false; set.disabled = !editable; }
  });
  section.append(form); return section;
}


/** One sticky「保存」bar for a page that hosts several settingsForm sections (#567). */
function attachUnifiedSettingsBar(host, sections, { dirty: dirtyFn = null, advanced = null, afterDiscard = null } = {}) {
  const isDirty = dirtyFn || (() => sections.some(section => section.settingDirty?.()));
  const bar = consoleSaveBar({
    status: isDirty() ? '有未保存的更改' : '已保存',
    dirty: isDirty(),
    onSave: async () => {
      const targets = sections.filter(section => section.settingDirty?.());
      if (!targets.length) return;
      const texts = [];
      try {
        for (const section of targets) {
          if (section.settingForm) section.settingForm.skipReload = true;
          try { texts.push((await section.settingCommit()).text); }
          finally { if (section.settingForm) section.settingForm.skipReload = false; }
        }
      } catch (err) { bar.messageEl.textContent = err.message || String(err); return; }
      current.flash = texts.filter(Boolean).pop() || '已保存';
      await reloadProject();
    },
    onDiscard: async () => {
      if (!isDirty()) return;
      if (!await askConfirm({ title: '放弃未保存的更改？', body: ['将丢弃本页未保存的修改，并重新读取已保存的设置。'], action: '放弃更改' })) return;
      for (const section of sections) section.settingClearDraft?.();
      if (afterDiscard) await afterDiscard();
      else await reloadProject();
    },
    advanced,
  });
  const sync = () => bar.refresh({ dirty: isDirty(), status: isDirty() ? '有未保存的更改' : '已保存' });
  for (const section of sections) {
    section.settingForm?.addEventListener('input', sync);
    section.settingForm?.addEventListener('change', sync);
  }
  host.prepend(bar);
  return { bar, sync };
}
