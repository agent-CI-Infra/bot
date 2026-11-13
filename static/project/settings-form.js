// A settings form: fields, an error line and a save button; `save` receives the form and reports through the error line.
// `after` receives the result text; without it the project page shows the text and reloads.
const projectSettingDrafts = new Map();
function settingsForm(title, nodes, save, { editable = true, caption = '保存', after = null, draftKey = null } = {}) {
  const target = current, address = location.hash;
  const live = () => current === target && location.hash === address && form.isConnected;
  const section = card(title), form = document.createElement('form'), message = element('p', '', 'view-error'), submit = element('button', caption);
  form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert');
  const set = element('fieldset', ''); set.disabled = !editable; set.append(...nodes); form.append(set, message);
  if (editable) { const actions = element('div', '', 'actions form-actions'); actions.append(submit); form.append(actions); }
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
    const update = () => { draftNotice.textContent = Object.keys(draft).length ? '草稿未保存；刷新会保留输入，保存时重新核对当前权限。' : ''; };
    form.addEventListener('input', event => {
      const control = event.target; if (!control.name) return;
      if (valueOf(control) === baseline[control.name]) delete draft[control.name]; else draft[control.name] = valueOf(control);
      projectSettingDrafts.set(key, draft); update();
    });
    update(); form.prepend(draftNotice);
    const discard = button('放弃本组草稿', async () => {
      if (!await askConfirm({ title: '放弃未保存的设置？', body: ['仅清除此组草稿，并读取最新已保存设置。'], action: '放弃草稿' })) return;
      projectSettingDrafts.delete(key); if (live()) await reloadProject();
    }, 'quiet');
    form.querySelector('.form-actions').append(discard);
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled || !editable || !live()) return; message.className = 'view-error'; message.textContent = '';
    const invalid = [...form.querySelectorAll('input')].find(el => !el.checkValidity());
    if (invalid) {
      const label = invalid.closest('label')?.firstChild?.textContent?.trim() || invalid.name, range = invalid.validity.rangeOverflow || invalid.validity.rangeUnderflow;
      message.textContent = range ? `${label}需在 ${invalid.min}–${invalid.max} 之间` : invalid.validity.stepMismatch ? `${label}的取值步长是 ${invalid.step}` : `${label}：${invalid.validationMessage}`; invalid.focus(); return;
    }
    const submittedDraft = key && projectSettingDrafts.get(key);
    submit.disabled = true; if (key) set.disabled = true;
    // The page re-renders after saving, so the result is shown at the top of the refreshed section.
    try {
      const done = await save(form, text => { message.className = 'view-progress'; message.textContent = text; }), text = typeof done === 'string' && done ? done : '已保存';
      if (key && projectSettingDrafts.get(key) === submittedDraft) projectSettingDrafts.delete(key);
      if (!live()) return;
      if (after) await after(text); else { current.flash = text; await reloadProject(); }
    }
    catch (err) { message.className = 'view-error'; message.textContent = err.message; } finally { submit.disabled = false; set.disabled = !editable; }
  });
  section.append(form); return section;
}

