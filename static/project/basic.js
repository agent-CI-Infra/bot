// Shared role labels and editable definitions; roles.js renders the overview and role forms.
const modelSources = { role: '角色', workflow: '工作类型', project: '项目默认' };

/**
 * The roles the controller may delegate in one entry (src/roles/team.ts, src/agent/loop.ts). Development and ordinary
 * requests offer every enabled writer and observer role; review and Actions analysis offer only Dev, whose work stays
 * on the entry's own Pi executor. QA is never delegated: it accepts the candidate the controller nominates.
 */
const entryWorkers = (config, entry) => ['review', 'actions'].includes(entry) ? config.roles.filter(role => role.role_id === 'dev')
  : config.roles.filter(role => role.enabled && ['writer', 'observer'].includes(role.kind));
const workerNames = roles => roles.map(role => roleLabel(role.role_id, role.name)).join('、') || '无';
const entryDevText = config => { const dev = entryDevBackend(config); return `只委派 ${dev.name}，使用这个入口的工具和工作区，后端 ${harnessName(dev.id)}${dev.kept ? '（旧 V2 配置沿用 Pi，该角色的后端选择改变后才换）' : ''}`; };
/**
 * The backend Dev uses when the controller delegates it in review or Actions analysis (src/roles/definition.ts): Dev's
 * own backend once its choice applies to these entries (entry_harness_source "role"); an older V2 configuration keeps
 * Pi there until Dev's backend selection changes.
 */
function entryDevBackend(config) {
  const dev = config.roles.find(role => role.role_id === 'dev');
  const own = dev?.entry_harness_source === 'role';
  return { name: dev?.name || 'dev', id: own ? dev.harness_ref.id : 'pi', kept: !own && !!dev && dev.harness_ref.id !== 'pi' };
}
function roleModelText(preview) {
  if (!preview) return '—';
  if (preview.error === 'subscription_mode_not_implemented') return '供应商订阅（预留 · 未实现）';
  if (preview.error) return `${preview.error}${preview.detail ? '：' + preview.detail : ''}`;
  return preview.model.source === 'external_harness' ? '后端自带模型' : `${preview.model.name}（${own(modelSources, preview.model.source) || preview.model.source}）`;
}
// Only editable fields cross the API; saved versions are pinned again by the server.
const editableRole = r => ({ role_id: r.role_id, enabled: r.enabled, name: r.name, responsibility: r.responsibility, persona_prompt: r.persona_prompt,
  model_profile_ref: r.model_profile_ref ? { model_id: r.model_profile_ref.model_id, api: r.model_profile_ref.api, tool_calls: r.model_profile_ref.tool_calls, structured_output: r.model_profile_ref.structured_output } : null,
  skill_bundle_ref: r.skill_bundle_ref ? { id: r.skill_bundle_ref.id } : null,
  harness_ref: { id: r.harness_ref.id, ...(['claude_code', 'codex'].includes(r.harness_ref.id) ? { model_source: r.harness_ref.model_source || 'gateway' } : r.harness_ref.model_source && r.harness_ref.model_source !== 'gateway' ? { model_source: r.harness_ref.model_source } : {}) },
  permissions: structuredClone(r.permissions),
  environment_profile_ref: { id: r.environment_profile_ref.id }, budget_policy_ref: Object.fromEntries(Object.entries(r.budget_policy_ref).filter(([key]) => key !== 'version')),
  output_schema_ref: { id: r.output_schema_ref.id } });

function rolesSection() { return rolesConsole(); }
function basicSection() {
  const target = current, { repository, policy, installed, environment } = target, info = card('项目概况');
  const id = target.id, save = values => api(`/api/repositories/${id}/policy`, 'PATCH', values);
  const editable = target.canConfigure !== false;
  // #570: first screen keeps the repository name; technical identifiers and install internals go into 高级.
  info.append(facts([['仓库', link(`https://github.com/${repository.full_name}`, repository.full_name)],
    ['可见性', installed ? installed.private ? '私有' : '公开' : null],
    ['项目状态', policy.enabled ? '已启用' : '已禁用']]));
  if (target.rules?.retired_files?.length) info.append(retiredRulesNotice(target.rules));
  // #934: the onboarding wizard again, against the project as it is now: it lists only what it would change.
  if (editable) info.append(consoleLink(`#/onboarding/${id}`, '重新运行接入向导', '助手对照现在的设置给出建议，只列出要改变的项；不确认就不改'));
  const summary = card('当前配置一览');
  const machineSize = current.rules?.computer?.cpus
    ? `${current.rules.computer.cpus} CPU · ${current.rules.computer.memory_mb} MB`
    : environment?.environment.computer ? `${environment.environment.computer.cpus} CPU · ${environment.environment.computer.memory_mb} MB` : null;
  summary.append(facts([['能力上限', Object.fromEntries(projectCeilingOptions.map(([level, title]) => [level, title]))[projectCeilingOf(policy)]],
    ['模型', current.models.find(m=>m.id===policy.model_id)?.model_name || (policy.model_id?'模型不可用':'未选择，任务会等待配置')],
    ['机器', machineSize]]));
  summary.append(consoleLink(`#/projects/${id}/triggers`, '监听与触发设置', '项目整体的事件来源与自动处理范围'));
  const advanced = element('details', '', 'fold basic-advanced');
  advanced.dataset.testid = 'basic-advanced';
  advanced.append(element('summary', '高级'));
  const tech = card('技术信息');
  tech.append(facts([['仓库 ID', repository.id], ['所有者', installed?.owner_login ? `${installed.owner_login}（${repository.owner_id}）` : repository.owner_id],
    ['处理账号', installed?.account_name || repository.account_id],
    ['安装', !installed ? null : installed.installed === null ? '不在安装列表' : `${installed.installation_id ? '安装 ' + installed.installation_id : '机器人账号可见'}${installed.installed === false ? '（已移出）' : ''}`],
    ['虚拟电脑', projectEnvironmentState()],
    ['机器', environment?.environment.computer ? `${environment.environment.computer.cpus} CPU · ${environment.environment.computer.memory_mb} MB` : null]]));
  const branch = settingsForm('分支', [field('基准分支', input('base_branch', policy.base_branch, { maxLength: 256, placeholder: '留空使用仓库默认分支' })),
    note('开发任务从这个分支拉取代码并向它开 PR；检视 Issue 时也读取这个分支的代码。')],
    form => save(changed({ base_branch: form.elements.base_branch.value.trim() }, { base_branch: policy.base_branch || '' })), { editable, draftKey: 'branch', hideActions: true });
  // The review and development labels are project settings (#935): the review label marks a published review (empty: none),
  // and a person adds the development label to ask for development. The developing label is on an Issue while the bot
  // develops it (#1047; empty: none).
  const labels = settingsForm('标签', [field('检视标签', input('review_label', policy.review_label ?? '', { maxLength: 50, placeholder: '留空表示检视后不加标签' })),
    field('开发标签', input('development_label', policy.development_label ?? '', { maxLength: 50, required: true })),
    field('开发中标签', input('developing_label', policy.developing_label ?? '', { maxLength: 50, placeholder: '留空表示开发时不加标签' })),
    note('检视结论发布后 bot 给 Issue 或 PR 加检视标签；人给 Issue 加上开发标签，表示要求 bot 开发它；bot 开发 Issue 期间给它加开发中标签，开出 PR 或停下时去掉，仓库没有这个标签时 bot 先创建。标签最长 50 个字符，首尾不能有空格。')],
    form => save(changed({ review_label: form.elements.review_label.value, development_label: form.elements.development_label.value, developing_label: form.elements.developing_label.value },
      { review_label: policy.review_label ?? '', development_label: policy.development_label ?? '', developing_label: policy.developing_label ?? '' })), { editable, draftKey: 'labels', hideActions: true });
  advanced.append(tech);
  const layout = element('div', '', 'project-settings-layout');
  layout.append(info, summary, branch, labels, ...globalProjectControls(), advanced);
  if (editable) attachUnifiedSettingsBar(layout, [branch, labels]);
  return [layout];
}

function globalProjectControls() {
  const target = current, { repository, policy, installed } = target, id = target.id;
  const publication = card('公开可见性');
  if (me.role !== 'super_admin') publication.append(note('公开看板由平台超级管理员管理；项目配置权限不会增加公开授权。'));
  else if (!installed) publication.append(consoleState('公开设置暂不可读取', '安装信息读取失败，公开状态未知。', { retry: () => reloadProject().catch(error) }));
  else {
    const status = element('p', '', 'muted'), feedback = element('p', '', 'view-error'); feedback.setAttribute('role', 'status');
    const toggle = button('', async () => {
      const enabled = !installed.board_enabled;
      if (!await confirmBoardVisibility(repository, enabled)) return;
      toggle.disabled = true; feedback.textContent = '正在保存公开设置…';
      try {
        const { board } = await api(`/api/installations/${id}/board`, 'PATCH', { enabled });
        Object.assign(installed, { board_enabled: board.enabled, board_state: board.state, board_url: board.url });
        show(); feedback.textContent = board.enabled ? '公开设置已保存；看板数据允许公开访问。' : '已关闭公开访问。';
      } catch (err) { feedback.textContent = '公开设置保存失败：' + readErrorText(err); }
      finally { toggle.disabled = installed.installed !== true; }
    });
    const show = () => { status.textContent = !installed.board_enabled ? '看板未公开' : installed.board_state === 'published' ? '看板已公开' : '已允许公开，等待采集'; toggle.textContent = installed.board_enabled ? '关闭公开看板' : '开启公开看板'; };
    show(); toggle.disabled = installed.installed !== true;
    publication.append(status, note('公开与项目启用分别保存。私有仓也可显式选择公开，请确认数据范围后操作。'), toggle, feedback);
    if (installed.board_enabled && installed.board_url) publication.append(link(installed.board_url, '查看公开看板'));
  }
  const dangerFold = element('details', '', 'fold project-danger-fold');
  dangerFold.dataset.testid = 'project-danger-fold';
  dangerFold.append(element('summary', '危险区'));
  const danger = card('危险操作'); danger.classList.add('project-danger');
  danger.append(note('禁用会停止新任务、中止正在执行的任务并停止虚拟电脑，保留现有数据；删除会清除本系统项目数据，且仍须通过服务端的实时检查。'));
  // The sentence above states the policy; this line says what it costs right now. A failed read says so instead of
  // showing zero, because "nothing is in flight" and "cannot tell" lead an administrator to different decisions.
  const impact = element('p', '', 'muted'); impact.dataset.projectDangerTasks = ''; impact.setAttribute('role', 'status');
  impact.textContent = '正在读取推进中的任务…';
  danger.append(impact, consoleLink(`#/projects/${id}/overview/active`, '查看推进中的任务', '打开总览里同一范围的任务记录'));
  api(`/api/tasks?${new URLSearchParams({ repository_id: id, summary: '1', group: 'active', limit: '1' })}`).then(data => {
    if (current !== target) return;
    const active = data.summary?.active;
    if (!Number.isSafeInteger(active)) throw new Error('任务计数格式无法识别');
    impact.textContent = active ? `当前 ${active} 项任务在推进中；禁用会中止其中正在执行的任务，已有数据保留。`
      : '当前没有推进中的任务；禁用后不再处理新的 Issue／PR。';
  }).catch(() => {
    if (current !== target) return;
    impact.classList.add('view-error');
    impact.textContent = '暂时无法读取推进中的任务数；禁用会中止正在执行的任务，这里不按零处理。可用页面上的“刷新”重试。';
  });
  if (me.role === 'super_admin') {
    const feedback = element('p', '', 'view-error'); feedback.setAttribute('role', 'alert');
    const change = button(policy.enabled ? '禁用项目' : '启用项目', async () => {
      if (!await askConfirm({ title: `${policy.enabled ? '禁用' : '启用'} ${repository.full_name}？`,
        body: [policy.enabled ? '新 Issue／PR 不再处理；正在执行的任务会中止，虚拟电脑停止，已有数据保留。' : '恢复按当前检视、开发与模型配置处理任务。', '公开看板的可见性由上方独立设置控制。'], action: policy.enabled ? '禁用' : '启用', danger: !!policy.enabled })) return;
      change.disabled = true; feedback.textContent = '';
      try { await api(`/api/installations/${id}/${policy.enabled ? 'disable' : 'activate'}`, 'POST', {}); if (current === target) await reloadProject(); }
      catch (err) { feedback.textContent = `项目${policy.enabled ? '禁用' : '启用'}失败：${readErrorText(err)}`; }
      finally { change.disabled = false; }
    }, policy.enabled ? 'destructive' : '');
    danger.append(change, button('删除项目', () => deleteProject({ id, full_name: repository.full_name, registered: true }, async () => {
      // #480: a reader who arrived through the legacy single-project address still returns to the batch list.
      const fromList = !!(history.state && history.state.projectListOrigin);
      if (current === target) { current = null; location.hash = target.globalSettings || fromList ? '#/settings/projects' : '#/projects'; }
    }), 'quiet destructive'), feedback);
  } else danger.append(note('启用、禁用与删除项目由平台超级管理员处理。请联系该管理员；项目管理员不因页面入口获得这些能力。'));
  dangerFold.append(danger);
  return [publication, dangerFold];
}

