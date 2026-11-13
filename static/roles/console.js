function rolesConsole() {
  const target = current, id = target.id, token = renderToken, holder = element('div', '', 'roles-page'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  const live = () => current === target && renderToken === token && current.section === 'roles' && holder.isConnected;
  let state, request = 0;
  const failed = err => {
    if (!live()) return;
    if ([401, 403].includes(err.status)) { target.rolesDraft = null; state = null; holder.replaceChildren(note('当前身份无权读取或修改角色配置，已清空本页草稿。'), message); }
    const description = err.code === 'invalid_stage_policy' ? stagePolicyErrorText(err.field) : err.message;
    if (err.code === 'invalid_stage_policy' && state) { state.stageError = { field: err.field, message: description }; state.focusStageError = true; }
    message.textContent = `${description}${err.field ? '（配置项：' + err.field + '）' : ''}`;
  };
  const compare = async () => {
    if (!state || state.busy) return;
    const revision = ++request; state.busy = true; draw(); message.textContent = '';
    try {
      const latest = await api(`/api/repositories/${id}/roles`);
      if (!live() || revision !== request) return;
      state.comparison = { base: state.base, latest }; state.conflict = true; state.focusComparison = true;
    } catch (err) { failed(err); }
    finally { if (state) state.busy = false; if (state) state.redraw?.(); }
  };
  const draw = () => {
    if (!live() || !state) return;
    state.redraw = draw;
    holder.replaceChildren(); roleDraftStatus = null;
    const nav = element('nav', '', 'role-nav'); nav.setAttribute('aria-label', '角色列表');
    const requestedView = new URLSearchParams(location.hash.split('?')[1] || '').get('view');
    const auxiliaryView = !current.item && ['skills', 'stages'].includes(requestedView) ? requestedView : '';
    for (const [key, title] of [['', '概览'], ...state.draft.roles.map(role => [role.role_id, roleLabel(role.role_id, role.name)])]) {
      const item = element('a', title); item.href = `#/projects/${id}/roles${key ? '/' + key : ''}`;
      if ((current.item || '') === key && !auxiliaryView) item.setAttribute('aria-current', 'page'); nav.append(item);
    }
    for (const [view, title] of [['stages', '阶段策略'], ['skills', '技能包目录']]) {
      const link = element('a', title); link.href = `#/projects/${id}/roles?view=${view}`;
      if (auxiliaryView === view) link.setAttribute('aria-current', 'page'); nav.insertBefore(link, nav.children[1] || null);
    }
    const fields = element('fieldset', '', 'role-editor-fields'); fields.disabled = !!state.busy;
    const role = state.draft.roles.find(role => role.role_id === current.item);
    if (auxiliaryView === 'skills') { roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; fields.append(roleDraftStatus, roleSkillsWorkspace(state, draw)); }
    else if (auxiliaryView === 'stages') { roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; fields.append(roleDraftStatus, roleStageWorkspace(state, draw)); }
    else if (current.item && !role) fields.append(note('这个角色已不存在，请在概览选择角色。'));
    else if (role) {
      roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; fields.append(roleDraftStatus, roleSettingsCard(role, state, draw, { live, failed }));
      if (role.role_id === 'manager') fields.append(...managerSection(state.data));
    } else fields.append(...roleOverviewCards(state, draw));
    holder.append(nav);
    const comparison = state.comparison ? roleComparison(state, draw, () => { message.textContent = ''; }) : null;
    const actions = element('div', '', 'actions role-save');
    const status = note(state.busy ? '正在读取或保存…' : state.dirty ? '草稿未保存；运行中任务保留原有快照。' : '保存后影响新任务和后续委派；运行中任务保留原有快照。'); status.setAttribute('role', 'status');
    const save = button('保存角色配置', async () => {
      if (state.busy || state.conflict) return;
      state.busy = true; draw(); message.textContent = '';
      try {
        const { required_stages, ...draft } = structuredClone(state.draft);
        const stagesChanged = JSON.stringify(required_stages) !== JSON.stringify(state.data.configuration.required_stages || []);
        await api(`/api/repositories/${id}/roles`, 'PUT', { ...draft, roles: draft.roles.map(({ kind, ...role }) => role), ...(stagesChanged ? { required_stages } : {}), expected_revision: state.data.configuration.revision });
        // The result belongs to this project; navigating elsewhere must not clear that other project's draft.
        if (target.rolesDraft === state) target.rolesDraft = null;
        if (current === target && current.section === 'roles') await reloadWith('角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
      } catch (err) {
        if (live() && err.code === 'role_configuration_conflict') { state.conflict = true; message.textContent = '角色配置已被别人修改。当前草稿仍保留，请读取最新版本并比较。'; }
        else if (live() && err.code === 'retired_skill_source') message.textContent = '旧指南来源已停用。请读取最新配置保留已迁移文件，或改用仓库技能文件、自定义文件。';
        else failed(err);
      } finally { if (state) state.busy = false; if (state) state.redraw?.(); }
    }, ''); save.disabled = !!state.busy || !!state.conflict;
    const compareButton = button('读取最新版本并比较', compare); compareButton.disabled = !!state.busy;
    const discard = button('放弃草稿并刷新', async () => {
      if (state.busy) return;
      if (state.dirty && !await askConfirm({ title: '放弃未保存的角色修改？', body: ['刷新后读取服务器上的最新配置。'], action: '放弃并刷新' })) return;
      if (!live()) return; target.rolesDraft = null; await read();
    }); discard.disabled = !!state.busy;
    actions.append(status, message, save, compareButton, discard); holder.append(actions);
    if (comparison) holder.append(comparison); holder.append(fields);
    if (state.stageError && state.focusStageError) { state.focusStageError = false; focusStagePolicyError(holder, state.stageError); }
    if (comparison && state.focusComparison) {
      state.focusComparison = false;
      comparison.style.scrollMarginTop = `${Math.ceil(actions.getBoundingClientRect().height) + 16}px`;
      comparison.scrollIntoView({ block: 'start' });
      const heading = comparison.querySelector('h3'); heading.tabIndex = -1; heading.focus({ preventScroll: true });
    }
  };
  const read = async () => {
    const revision = ++request; holder.replaceChildren(note('正在读取角色配置…'), message); message.textContent = '';
    try {
      const data = await api(`/api/repositories/${id}/roles`);
      if (!live() || revision !== request) return;
      state = target.rolesDraft;
      if (!state || !state.dirty) {
        const base = editableRoleDraft(data);
        state = { data, base, dirty: false, draft: { ...editableRoleDraft(data, true), deleted_roles: [] } }; target.rolesDraft = state;
      }
      draw();
    } catch (err) {
      if (!live() || revision !== request) return;
      failed(err);
      if (![401,403].includes(err.status)) holder.replaceChildren(note('角色配置读取失败，当前状态未知。保留的草稿尚未提交。'), message, button('重试读取角色配置', read));
    }
  };
  holder.append(note('正在读取角色配置…')); void read(); return [holder];
}
