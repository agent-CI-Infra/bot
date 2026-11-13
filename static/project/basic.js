// Shared role labels and editable definitions; roles.js renders the overview and role forms.
const roleEntries = [['development', '开发', '开发 Issue、跟进 bot PR'], ['request', '普通任务', '管理对话或接口创建的任务'], ['review', '检视', '检视 Issue、检视 PR'], ['actions', 'Actions 失败分析', 'Actions 失败处理']];
const modelSources = { role: '角色', workflow: '工作类型', project: '项目默认' };

/**
 * The roles the controller may delegate in one entry (src/roles/team.ts, src/agent/loop.ts). Development and ordinary
 * requests offer every enabled writer and observer role; review and Actions analysis offer only Dev, whose work stays
 * on the entry's own Pi executor. QA is never delegated: it accepts the candidate the controller nominates.
 */
const entryWorkers = (config, entry) => ['review', 'actions'].includes(entry) ? config.roles.filter(role => role.role_id === 'dev')
  : config.roles.filter(role => role.enabled && ['writer', 'observer'].includes(role.kind));
const workerNames = roles => roles.map(role => roleLabel(role.role_id, role.name)).join('、') || '无';
const entryDevText = config => { const dev = entryDevBackend(config); return `只委派 Dev，Dev 用这个入口的工具和工作区，后端 ${harnessName(dev.id)}${dev.kept ? '（旧 V2 配置沿用 Pi，Dev 的后端选择改变后才换）' : ''}`; };
/**
 * The backend Dev uses when the controller delegates it in review or Actions analysis (src/roles/definition.ts): Dev's
 * own backend once its choice applies to these entries (entry_harness_source "role"); an older V2 configuration keeps
 * Pi there until Dev's backend selection changes.
 */
function entryDevBackend(config) {
  const dev = config.roles.find(role => role.role_id === 'dev');
  const own = dev?.entry_harness_source === 'role';
  return { id: own ? dev.harness_ref.id : 'pi', kept: !own && !!dev && dev.harness_ref.id !== 'pi' };
}
function roleModelText(preview) {
  if (!preview) return '—';
  if (preview.error) return `${preview.error}${preview.detail ? '：' + preview.detail : ''}`;
  return preview.model.source === 'external_harness' ? '后端自带模型' : `${preview.model.name}（${own(modelSources, preview.model.source) || preview.model.source}）`;
}
// Only editable fields cross the API; saved versions are pinned again by the server.
const editableRole = r => ({ role_id: r.role_id, enabled: r.enabled, name: r.name, responsibility: r.responsibility, persona_prompt: r.persona_prompt,
  model_profile_ref: r.model_profile_ref ? { model_id: r.model_profile_ref.model_id, api: r.model_profile_ref.api, tool_calls: r.model_profile_ref.tool_calls, structured_output: r.model_profile_ref.structured_output } : null,
  skill_bundle_ref: r.skill_bundle_ref ? { id: r.skill_bundle_ref.id } : null, harness_ref: { id: r.harness_ref.id }, permissions: structuredClone(r.permissions),
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
  const summary = card('当前配置一览');
  const machineSize = current.rules?.computer?.cpus
    ? `${current.rules.computer.cpus} CPU · ${current.rules.computer.memory_mb} MB`
    : environment?.environment.computer ? `${environment.environment.computer.cpus} CPU · ${environment.environment.computer.memory_mb} MB` : null;
  summary.append(facts([['检视', policy.review_enabled ? '开启' : '关闭'], ['自动开发', policy.development_enabled ? '开启' : '关闭'],
    ['模型', current.models.find(m=>m.id===policy.model_id)?.model_name || (policy.model_id?'模型不可用':'未选择，任务会等待配置')],
    ['机器', machineSize]]));
  const advanced = element('details', '', 'fold basic-advanced');
  advanced.dataset.testid = 'basic-advanced';
  advanced.append(element('summary', '高级'));
  const tech = card('技术信息');
  tech.append(facts([['仓库 ID', repository.id], ['所有者', installed?.owner_login ? `${installed.owner_login}（${repository.owner_id}）` : repository.owner_id],
    ['处理账号', installed?.account_name || repository.account_id],
    ['安装', !installed ? null : installed.installed === null ? '不在安装列表' : `${installed.installation_id ? '安装 ' + installed.installation_id : '机器人账号可见'}${installed.installed === false ? '（已移出）' : ''}`],
    ['虚拟电脑', projectEnvironmentState()],
    ['机器', current.rules?.computer?.cpus ? `${current.rules.computer.cpus} CPU · ${current.rules.computer.memory_mb} MB（${current.rules.files.find(f=>f.path==='.bot/computer.yaml').source==='repository'?'仓库 .bot/computer.yaml':'控制台'}）` : environment?.environment.computer ? `${environment.environment.computer.cpus} CPU · ${environment.environment.computer.memory_mb} MB` : null]]));
  const branch = settingsForm('分支', [field('基准分支', input('base_branch', policy.base_branch, { maxLength: 256, placeholder: '留空使用仓库默认分支' })),
    note('开发任务从这个分支拉取代码并向它开 PR；检视 Issue 时也读取这个分支的代码。')],
    form => save(changed({ base_branch: form.elements.base_branch.value.trim() }, { base_branch: policy.base_branch || '' })), { editable, draftKey: 'branch', hideActions: true });
  const automation = settingsForm('检视与开发策略', [
    checkbox('review_enabled', policy.review_enabled, '开启 Issue 与 PR 检视'), checkbox('development_enabled', policy.development_enabled, '开启自动开发'),
    note('此处保存功能开关，不代表任务正在执行。项目禁用时仍可保存，重新启用后生效。')],
    form => save(changed({ review_enabled: form.elements.review_enabled.checked, development_enabled: form.elements.development_enabled.checked },
      { review_enabled: !!policy.review_enabled, development_enabled: !!policy.development_enabled })), { editable, draftKey: 'automation', hideActions: true });
  const sources = card('规则来源');
  sources.append(note('内置默认、项目控制台和默认分支仓库文件依次覆盖。这里仅展示来源，编辑入口沿用角色与机器页面。'));
  if (!target.rules) sources.append(consoleState('规则来源暂不可读取', '请重新读取；当前不能判断哪一层生效。', { retry: () => reloadProject().catch(error) }));
  else for (const file of target.rules.files.filter(f => f.path === '.bot/guide.md' || f.path === '.bot/computer.yaml')) {
    sources.append(facts([['规则', file.path], ['当前来源', layerNames[file.source] || file.source]]));
  }
  sources.append(consoleLink(`#/projects/${id}/roles/manager`, '查看与修改规则', '保留现有的来源比较和版本检查'));
  advanced.append(tech, sources);
  const layout = element('div', '', 'project-settings-layout');
  layout.append(info, summary, branch, automation, ...globalProjectControls(), advanced);
  if (editable) attachUnifiedSettingsBar(layout, [branch, automation]);
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
      } catch (err) { feedback.textContent = '公开设置保存失败：' + err.message; }
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
      catch (err) { feedback.textContent = `项目${policy.enabled ? '禁用' : '启用'}失败：${err.message}`; }
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

