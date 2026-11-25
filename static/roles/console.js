function rolesConsole() {
  const target = current, id = target.id, token = renderToken, holder = element('div', '', 'roles-page'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  const live = () => current === target && renderToken === token && current.section === 'roles' && holder.isConnected;
  let state, request = 0;
  const failed = err => {
    if (!live()) return;
    if ([401, 403].includes(err.status)) { target.rolesDraft = null; state = null; holder.replaceChildren(note('当前身份无权读取或修改角色配置，已清空本页草稿。'), message); }
    const description = readErrorText(err);
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
    let saveRoles = async () => {};
    holder.replaceChildren(); roleDraftStatus = null;
    const requestedView = new URLSearchParams(location.hash.split('?')[1] || '').get('view');
    const auxiliaryView = !current.item && (requestedView === 'skills' || requestedView === 'library') ? requestedView : '';
    const fields = element('fieldset', '', 'role-editor-fields'); fields.disabled = !!state.busy;
    const role = state.draft.roles.find(role => role.role_id === current.item);
    // #566: overview is a list; a role (or auxiliary) page only has a back crumb, not a tab strip of every role.
    const nav = element('nav', '', 'role-nav'); nav.setAttribute('aria-label', '角色列表');
    if (current.item || auxiliaryView) {
      const back = element('a', '← 角色列表');
      back.href = `#/projects/${id}/roles`;
      back.dataset.testid = 'role-list-link';
      nav.append(back);
      if (current.item) {
        const here = element('a', role ? roleConfigName(role) : current.item);
        here.href = `#/projects/${id}/roles/${current.item}`;
        here.setAttribute('aria-current', 'page');
        nav.append(here);
      } else {
        const libLink = element('a', '技能库');
        libLink.href = `#/projects/${id}/roles?view=library`;
        libLink.dataset.testid = 'role-skill-library-link';
        if (auxiliaryView === 'library') libLink.setAttribute('aria-current', 'page');
        const skillsLink = element('a', '技能包目录');
        skillsLink.href = `#/projects/${id}/roles?view=skills`;
        skillsLink.dataset.testid = 'role-skills-link';
        if (auxiliaryView === 'skills') skillsLink.setAttribute('aria-current', 'page');
        nav.append(libLink, skillsLink);
      }
    } else {
      const libLink = element('a', '技能库'); libLink.href = `#/projects/${id}/roles?view=library`; libLink.dataset.testid = 'role-skill-library-link';
      const skills = element('a', '技能包目录'); skills.href = `#/projects/${id}/roles?view=skills`; skills.dataset.testid = 'role-skills-link';
      nav.append(libLink, skills);
    }
    if (auxiliaryView === 'library') {
      fields.append(roleSkillLibraryWorkspace(state, draw, { live, failed, repositoryId: id }));
    } else if (auxiliaryView === 'skills') {
      roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = '';
      fields.append(roleDraftStatus, roleSkillsWorkspace(state, draw));
    } else if (current.item && !role) fields.append(note('这个角色已不存在，请在概览选择角色。'));
    else if (role) {
      roleDraftStatus = note(roleVersionText(state)); roleDraftStatus.dataset.roleVersion = ''; fields.append(roleDraftStatus);
      if (role.role_id === 'manager') fields.append(...managerSection(state.data));
      fields.append(roleSettingsCard(role, state, draw, { live, failed }));
    } else fields.append(...roleOverviewCards(state, draw)); // Defaults included, the list shows the configuration in force (#1068).
    holder.append(nav);
    const comparison = state.comparison ? roleComparison(state, draw, () => { message.textContent = ''; }) : null;
    saveRoles = async () => {
      if (state.busy || state.conflict) return;
      state.busy = true; draw(); message.textContent = '';
      try {
        const draft = structuredClone(state.draft);
        await api(`/api/repositories/${id}/roles`, 'PUT', { ...draft, roles: draft.roles.map(({ kind, ...role }) => role), expected_revision: state.data.configuration.revision });
        // The result belongs to this project; navigating elsewhere must not clear that other project's draft.
        if (target.rolesDraft === state) target.rolesDraft = null;
        if (current === target && current.section === 'roles') await reloadWith(state.data.configured === false ? rolePageText('savedCustom') : '角色配置已保存，新任务使用新配置；收回权限会阻止后续调用');
      } catch (err) {
        if (live() && err.code === 'role_configuration_conflict') { state.conflict = true; message.textContent = '角色配置已被别人修改。当前草稿仍保留，请读取最新版本并比较。'; }
        else if (live() && err.code === 'retired_skill_source') message.textContent = '旧指南来源已停用。请读取最新配置保留已迁移文件，或改用技能库、仓库技能文件或自定义文件。';
        else if (live() && err.code === 'skill_version_conflict') {
          const slug = err.detail?.slug ? `（Skill：${err.detail.slug}）` : '';
          message.textContent = `同一角色或技能包绑定了同名 Skill 的不同版本或来源${slug}，请统一版本或调整绑定后再保存。`;
        }
        else failed(err);
      } finally { if (state) state.busy = false; if (state) state.redraw?.(); }
    };
    // Restoring the defaults replaces the project's own configuration with the "follow the defaults" revision (#1068).
    state.restoreDefaults = async () => {
      if (state.busy || state.conflict || state.data.configured === false) return;
      if (!await askConfirm({ title: rolePageText('restoreTitle'), body: [...rolePageText('restoreBody'), ...(state.dirty ? [rolePageText('restoreDraft')] : [])], action: rolePageText('restore') })) return;
      if (!live()) return;
      state.busy = true; draw(); message.textContent = '';
      try {
        await api(`/api/repositories/${id}/roles`, 'PUT', { expected_revision: state.data.configuration.revision, follow_default: true });
        if (target.rolesDraft === state) target.rolesDraft = null;
        if (current === target && current.section === 'roles') await reloadWith(rolePageText('restored'));
      } catch (err) {
        if (live() && err.code === 'role_configuration_conflict') { state.conflict = true; message.textContent = '角色配置已被别人修改。当前草稿仍保留，请读取最新版本并比较。'; }
        else failed(err);
      } finally { if (state) state.busy = false; if (state) state.redraw?.(); }
    };
    const compareButton = button('读取最新版本并比较', compare, 'quiet'); compareButton.disabled = !!state.busy;
    const discardRoles = async () => {
      if (state.busy) return;
      if (state.dirty && !await askConfirm({ title: '放弃未保存的更改？', body: ['将丢弃这次修改，并重新读取已保存的配置。'], action: '放弃更改' })) return;
      if (!live()) return; target.rolesDraft = null; await read();
    };
    const dirtyText = state.data.configured === false ? rolePageText('defaultDirty') : '有未保存的更改。保存后新任务会用新配置，正在运行的任务不受影响。';
    const actions = consoleSaveBar({
      status: state.busy ? '正在读取或保存…' : state.dirty ? dirtyText : roleVersionText(state),
      dirty: !!state.dirty,
      busy: !!state.busy,
      conflict: !!state.conflict,
      saveLabel: '保存',
      onSave: () => saveRoles(),
      onDiscard: discardRoles,
      advanced: [compareButton],
      message,
    });
    actions.classList.add('role-save');
    state.saveBar = actions;
    if (auxiliaryView !== 'library' || state.dirty || state.conflict) holder.append(actions);

    if (comparison) holder.append(comparison); holder.append(fields);
    if (comparison && state.focusComparison) {
      state.focusComparison = false;
      comparison.style.scrollMarginTop = `${Math.ceil(actions.getBoundingClientRect().height) + 16}px`;
      comparison.scrollIntoView({ block: 'start' });
      const heading = comparison.querySelector('h3'); heading.tabIndex = -1; heading.focus({ preventScroll: true });
    }
  };
  const refreshSkillLibrary = async () => {
    try {
      const lib = await api(`/api/repositories/${id}/skills?limit=100`);
      if (!live() || !state) return null;
      state.skillLibrary = lib;
      state.skillLibraryError = '';
      return lib;
    } catch (err) {
      if (live() && state) state.skillLibraryError = readErrorText(err);
      return null;
    }
  };
  const read = async () => {
    const revision = ++request; holder.replaceChildren(note('正在读取角色配置…'), message); message.textContent = '';
    try {
      const [data, skillLibrary] = await Promise.all([
        api(`/api/repositories/${id}/roles`),
        api(`/api/repositories/${id}/skills?limit=100`).catch(() => null),
      ]);
      if (!live() || revision !== request) return;
      state = target.rolesDraft;
      if (!state || !state.dirty) {
        const base = editableRoleDraft(data);
        state = { data, base, dirty: false, draft: { ...editableRoleDraft(data), deleted_roles: [] }, skillLibrary };
        target.rolesDraft = state;
      } else if (skillLibrary) {
        state.skillLibrary = skillLibrary;
      }
      state.refreshSkillLibrary = refreshSkillLibrary;
      draw();
    } catch (err) {
      if (!live() || revision !== request) return;
      failed(err);
      if (![401,403].includes(err.status)) holder.replaceChildren(note('角色配置读取失败，当前状态未知。保留的草稿尚未提交。'), message, button('重试读取角色配置', read));
    }
  };
  holder.append(note('正在读取角色配置…')); void read();
  return [holder];
}
