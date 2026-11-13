// Project automation switches update their own policy fields; board publication is independent.
const projectFeatures = [['review_enabled', '检视'], ['development_enabled', '开发']];
function updateProjectTaskPreview(preview, row) {
  preview.replaceChildren(element('span', `执行中 ${row.running_tasks}`, row.running_tasks ? 'task-count-active' : ''));
  if (row.queued_tasks) preview.append(element('span', `排队 ${row.queued_tasks}`, 'muted'));
  preview.title = `正在执行 ${row.running_tasks} 个任务，排队 ${row.queued_tasks} 个任务`;
  preview.setAttribute('aria-label', `${row.full_name}：${preview.title}，查看运行状态`);
}
async function confirmBoardVisibility(repository, enabled) {
  const actor = me, address = location.hash;
  const confirmed = await askConfirm({ title: enabled ? '开启公开看板？' : '关闭公开看板？',
    body: [`项目：${repository.full_name}`,
      enabled ? '允许无需登录访问单仓看板及 Dashboard 汇总，包括私有仓显式公开的看板数据。' : '保存后停止对外提供本项目看板。',
      '公开内容由看板采集服务生成，不开放管理端任务日志、身份、提示词或成本。'],
    action: enabled ? '开启公开看板' : '关闭公开看板', danger: enabled });
  // A choice made on a previous page or by a previous signed-in account cannot authorize this write.
  return confirmed && me === actor && location.hash === address;
}
function projectListControls(row) {
  const registered = row.registered !== false, group = element('div', '', 'project-controls'), features = element('div', '', 'project-features');
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', row.full_name + ' 功能与任务');
  const availability = badge(!registered ? '未启动' : row.enabled ? '已启用' : '已禁用', !registered ? 'info' : row.enabled ? 'success' : 'warning');
  features.append(availability);
  if (row.installed === false) features.append(badge('已移出安装', 'danger'));
  else if (row.installed === null) features.append(badge('不在安装列表'));
  const feedback = element('p', '', 'project-control-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  let pending = false, boardSavedAt = 0; const switches = [];
  const sync = () => switches.forEach(({control, value, key, caption}) => {
    const on = !!row[key]; control.setAttribute('aria-checked', String(on)); value.textContent = on ? '开' : '关';
    if (key === 'board_enabled') {
      control.disabled = pending || row.installed !== true;
      control.title = row.installed !== true ? '仓库不在安装范围' : '开启后单仓看板与 Dashboard 汇总无需登录即可访问；未保存选择时公开仓默认开、私有仓默认关，保存后不随可见性变化';
      return;
    }
    control.disabled = pending || !registered;
    control.title = !registered ? '请先启动项目' : !row.enabled ? '项目已禁用；此开关只保存配置，重新启用项目后才会生效' : row.installed === false ? '项目已移出安装范围；此开关只保存配置' : caption === '开发' ? 'Issue 明确要求改代码时自动开发；只修改 bot 自己的分支' : '检视这个项目的 Issue 和 PR';
  });
  const featuresToShow = tab === 'settings' ? [['board_enabled', '看板']] : projectFeatures;
  for (const [key, caption] of featuresToShow) {
    if (tab !== 'settings') { features.append(badge(caption + (row[key] ? '已开启' : '已关闭'))); continue; }
    const control = button('', async () => {
      if (pending) return; pending = true; sync(); feedback.className = 'project-control-feedback';
      try {
        const enabled = !row.board_enabled;
        if (key === 'board_enabled') {
          feedback.textContent = '请确认公开看板的访问范围。';
          if (!await confirmBoardVisibility(row, enabled)) { feedback.textContent = '已取消公开看板变更'; return; }
        }
        features.setAttribute('aria-busy', 'true'); feedback.textContent = `正在保存${caption}…`;
        if (key === 'board_enabled') {
          const {board} = await api(`/api/installations/${row.id}/board`, 'PATCH', {enabled});
          Object.assign(row, {board_enabled: board.enabled, board_state: board.state, board_url: board.url});
          boardSavedAt = Date.now();
          updateBoardChip(group, row);
          feedback.textContent = board.enabled ? '看板已开启；数据公开可访问' : '看板已关闭；不再公开展示';
        } else {
          const {policy} = await api(`/api/repositories/${row.id}/policy`, 'PATCH', {[key]: !row[key]});
          Object.assign(row, policy); feedback.textContent = `${caption}已${row[key] ? '开启' : '关闭'}${!row.enabled ? '；项目仍已禁用' : ''}`;
        }
      } catch (err) { feedback.classList.add('control-error'); feedback.textContent = `${caption}保存失败：${err.message}`; }
      finally { pending = false; features.removeAttribute('aria-busy'); sync(); }
    }, 'project-feature-switch');
    control.setAttribute('role', 'switch'); control.setAttribute('aria-label', row.full_name + ' ' + caption);
    const track = element('span', '', 'switch-track'), value = element('span', '', 'switch-value'); track.setAttribute('aria-hidden', 'true');
    control.append(element('span', caption), track, value); features.append(control); switches.push({control, value, key, caption});
  }
  group.updateBoard = (next, requestedAt) => {
    if (pending || next.board_enabled === undefined || requestedAt <= boardSavedAt) return;
    Object.assign(row, {board_enabled: next.board_enabled, board_state: next.board_state, board_url: next.board_url});
    sync(); updateBoardChip(group, row);
  };
  sync();
  const preview = element(registered ? 'a' : 'span', '', 'project-task-preview');
  if (registered) preview.href = `#/projects/${row.id}/activity`;
  updateProjectTaskPreview(preview, row); features.append(preview); group.append(features, feedback); return group;
}
let projectActivityPending = false;
async function refreshProjectActivity() {
  if (projectActivityPending) return; projectActivityPending = true; const request = renderVersion, requestedAt = Date.now();
  try {
    const {repositories} = await api(projectListAddress());
    if (request !== renderVersion || tab !== 'projects' || projectRoute()) return;
    const rows = new Map(repositories.map(row => [row.id, row]));
    for (const line of document.querySelectorAll('#rows .project-list-row, .global-project-row')) {
      const row = rows.get(line.dataset.repositoryId); if (row) {
        updateProjectTaskPreview(line.querySelector('.project-task-preview'), row);
        line.querySelector('.project-controls')?.updateBoard?.(row, requestedAt);
      }
    }
  } catch (err) {
    if (request === renderVersion) for (const preview of document.querySelectorAll('#rows .project-task-preview')) preview.title = `任务数更新失败：${err.message}；点击刷新重试`;
  } finally { projectActivityPending = false; }
}

// Installed repositories: automation needs activation; board publication has its own switch.
function syncSummary(syncs = []) {
  if (!syncs.length) return '尚未同步';
  return syncs.map(s => s.error ? `${s.account_name} 同步失败（${s.error}）` : `${s.account_name} 同步于 ${timestamp(s.synced_at).slice(11, 19)}`).join(' · ');
}
function installedDetail(row) {
  const parts = [row.owner_login || '所有者', row.private ? '私有' : '公开'];
  if (row.account_name) parts.push(row.account_name);
  if (row.registered && !row.model_id) parts.push('还没有默认模型');
  return parts.join(' · ');
}
function installedBadges(row) {
  const badges = [!row.registered ? badge('未启动', 'info') : !row.enabled ? badge('已禁用', 'warning') : badge('已启用', 'info')];
  if (row.registered) badges.push(badge(row.review_enabled ? '检视已开启' : '检视未开启', row.review_enabled ? 'info' : ''));
  if (row.hidden) badges.push(badge('已隐藏', 'info'));
  if (row.installed === false) badges.push(badge('已移出安装', 'danger'));
  else if (row.installed === null) badges.push(badge('不在安装列表'));
  badges.push(permissionBadge(row));
  return badges;
}
// GitHub's own wording for App permissions, shared by the project list and the App permission check.
const permissionNames = { contents: 'Contents', issues: 'Issues', pull_requests: 'Pull requests', statuses: 'Commit statuses', actions: 'Actions', checks: 'Checks', metadata: 'Metadata', workflows: 'Workflows' };
// What GitHub needs before an event can be ticked. Workflow run is easy to mistake for the Workflows permission, which
// only lets an App edit .github/workflows files (gate onboarding needs it, Actions failure analysis does not).
const eventPermissionNotes = { workflow_run: '这是事件订阅，不是 Workflows 权限：GitHub 只要求 App 至少有 Actions「Read-only」，不需要 Workflows；App 没有 Actions 权限时这个选项不会出现，先补 Actions。' };
// GitHub's names for the webhook events under Permissions & events → Subscribe to events.
const eventNames = { issues: 'Issues', pull_request: 'Pull request', issue_comment: 'Issue comment', pull_request_review: 'Pull request review', pull_request_review_comment: 'Pull request review comment', workflow_run: 'Workflow run' };
const accessNames = { read: 'Read-only', write: 'Read and write', admin: 'Admin' }, roleNames = { read: 'Read', triage: 'Triage', write: 'Write' };
// Access gaps (access_gaps) name the features they stop; src/app/access.ts holds what each feature needs.
const featureNames = { review: '检视', review_threads: '关闭已修复的行内意见', development: '开发', ci_reads: '任务读取 CI 结果', board: '看板', release: '发版本', gate: '接入门禁', actions_failures: 'Actions 失败分析' };
const featureImpact = {
  review: '读不到代码或发不出检视意见', review_threads: '检视照常发布，但作者修复后的行内意见不会自动关闭', development: '推不了分支、开不了或更新不了 PR', ci_reads: '任务看不到 Actions、检查和提交状态',
  board: '采集不到看板数据', release: '打不了标签、写不了 Release、重跑不了发布运行', gate: '提交不了 .github/workflows 门禁配置 PR',
  actions_failures: '读不到运行、重跑不了外部失败、提报不了 Issue',
};
// What a missing event stops, in the words of the triggers it carries (src/review/queue.ts, src/actions).
const eventImpact = {
  issues: '新 Issue 不检视，编辑后不重新检视，加开发标签不会开始开发，关闭后相关任务不会自动取消',
  issue_comment: 'Issue 和 PR 下的评论不会触发检视跟进', pull_request: 'PR 打开、转为可检视、推送新提交或编辑后不检视，关闭后相关任务不会自动取消',
  pull_request_review: '提交 PR 检视意见后不会触发跟进', pull_request_review_comment: 'PR 行内评论和回复不会触发跟进',
  workflow_run: 'Actions 失败分析在读取运行之前停止：不分类、不重跑、不提报 Issue',
};
const gapLabels = { permission: '权限不足', role: '权限不足', event: '事件未订阅', account: '需要 GitHub App' };
// Whether a stopped feature is in use on this row: on, off, or run by hand (releases and gate PRs have no switch).
function featureState(row, feature) {
  const active = !!row.enabled, on = { review: row.review_enabled, review_threads: row.review_enabled, development: row.development_enabled, ci_reads: row.review_enabled || row.development_enabled,
    board: row.board_enabled, actions_failures: row.actions_failures_enabled }[feature];
  if (feature === 'release' || feature === 'gate') return row.registered === false ? 'off' : 'manual';
  return feature === 'board' ? on ? 'on' : 'off' : active && on ? 'on' : 'off';
}
const stateNames = { on: '已开启', off: '未开启', manual: '手动使用时' };
function gapWhat(gap) {
  if (gap.kind === 'permission') return `${permissionNames[gap.name] || gap.name} 需要「${accessNames[gap.required] || gap.required}」，现在「${gap.current ? accessNames[gap.current] || gap.current : 'No access'}」`;
  if (gap.kind === 'event') return `未订阅事件 ${eventNames[gap.name] || gap.name}`;
  if (gap.kind === 'role') return `机器人账号的仓库角色需要「${roleNames.write}」，现在「${roleNames[gap.current] || gap.current || '无'}」`;
  return '项目挂在机器人账号上，不是 GitHub App 安装';
}
function gapHow(gap, row) {
  const owner = row.owner_login ? `（${row.owner_login}）` : '';
  if (gap.kind === 'permission') return `GitHub App 管理员在 App 设置的 Permissions & events 中把 ${permissionNames[gap.name] || gap.name} 设为「${accessNames[gap.required] || gap.required}」并保存；新增权限要由安装所有者${owner}在 GitHub 的安装设置里接受。App 已经有这项权限时，只需接受安装上的待批准变更。`;
  if (gap.kind === 'event') return `GitHub App 管理员在 App 设置的 Permissions & events → Subscribe to events 勾选 ${eventNames[gap.name] || gap.name} 并保存。${eventPermissionNotes[gap.name] || ''}GitHub 只在新增权限时要求安装所有者批准；App 已经勾选但这里仍显示未订阅时，到安装设置接受待批准的变更。`;
  if (gap.kind === 'role') return '在仓库 Settings → Collaborators and teams 把机器人账号的角色改为 Write 或更高。';
  return '这些功能只用 GitHub App 安装令牌。在「接入向导」创建 GitHub App 并安装到这个仓库，项目改用该 App 账号后才能使用。';
}
function gapImpact(gap, row) {
  const used = gap.features.map(feature => `${featureNames[feature] || feature}（${stateNames[featureState(row, feature)]}）`).join('、');
  if (!gap.features.length) return '接入基线要求这一级别；各功能目前用到的级别已经满足，暂不影响使用。';
  if (gap.kind === 'event') return `${eventImpact[gap.name] || '相关触发不会到达'}。涉及：${used}。`;
  return gap.features.map(feature => `${featureNames[feature] || feature}（${stateNames[featureState(row, feature)]}）：${featureImpact[feature] || '无法使用'}`).join('；') + '。';
}
function gapSummary(gap) {
  const names = gap.features.map(feature => featureNames[feature] || feature).join('、');
  return gapWhat(gap) + (names ? `（影响${/^[A-Za-z]/.test(names) ? ' ' : ''}${names}）` : '');
}
// Use the full sync's installation snapshots: one installation can cover many repositories, including hidden ones.
function installationSyncNotice(result) {
  const failed = result.results.filter(row => row.error), installations = result.results.flatMap(row => row.installations || []);
  const gaps = installations.filter(row => row.gaps?.length).map(row => `${row.account || '安装'}（安装 ${row.id}）：${row.gaps.map(gapSummary).join('；')}`);
  // Bot accounts have no installation snapshot; their repositories carry the gaps.
  for (const row of result.repositories || []) if (!row.installation_id && row.access_gaps?.length) gaps.push(`${row.full_name}：${row.access_gaps.map(gapSummary).join('；')}`);
  const parts = [failed.length ? '部分账号同步失败：' + failed.map(row => (accounts.find(account => account.id === row.account_id)?.name || row.account_id) + '（' + row.error + '）').join('、') + '，因此还不能判断全部安装的权限和事件订阅是否正常。'
    : gaps.length ? '安装列表已同步，权限和事件订阅并非全部正常。' : `安装列表已同步，${installations.length} 个安装的权限和事件订阅都正常。`];
  if (gaps.length) parts.push(gaps.join('；') + '。点仓库行上的提示查看处理方法。');
  const appMissing = result.results.some(row => row.app && (row.app.missing?.length || row.app.missing_events?.length || row.app.feature_gaps?.length)), appUnknown = result.results.some(row => row.app?.error);
  if (appMissing)
    parts.push('App 定义仍有缺口，请到「全局设置 → 机器人账号」查看。');
  if (appUnknown) parts.push('App 定义暂时无法核对，请到「全局设置 → 机器人账号」检查。');
  return { text: parts.join(''), tone: failed.length || gaps.length || appMissing || appUnknown ? '' : 'view-success' };
}
function warningIcon() {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'status-icon');
  svg.innerHTML = '<path d="M8 1.4 15.3 14.2H.7z" fill="currentColor"/><path d="M8 5.7v4M8 11.8v.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>';
  return svg;
}
// One dialog lists every gap of a repository: what is missing, how to fix it, and which features it stops.
const accessView = document.createElement('dialog'); accessView.className = 'access-dialog'; accessView.setAttribute('aria-labelledby', 'access-title');
document.body.append(accessView);
function openAccessGaps(row) {
  const title = element('h2', '权限与事件缺口 · ' + row.full_name); title.id = 'access-title';
  const list = element('ol', '', 'access-gaps');
  for (const gap of row.access_gaps) {
    const item = element('li', ''), facts = element('dl', '');
    for (const [term, text] of [['缺少', gapWhat(gap)], ['怎么操作', gapHow(gap, row)], ['会影响什么', gapImpact(gap, row)]]) facts.append(element('dt', term), element('dd', text));
    item.append(facts); list.append(item);
  }
  const close = button('关闭', () => accessView.close(), 'quiet'), actions = element('div', '', 'actions');
  actions.append(close);
  accessView.replaceChildren(title, element('p', '对照所有功能检查，未开启的功能也列出。改完后点「同步安装列表」重新读取。', 'muted'), list, actions);
  accessView.showModal(); close.focus();
}
// Every access gap of a repository the account still lists, against every feature whether or not it is on. Warning tone
// when a stopped feature is on; a gap only for unused features is informational. Always drawn (hidden when nothing is
// missing) so that a later permission check can swap it in place.
function permissionBadge(row) {
  const gaps = row.access_gaps || [], labels = [...new Set(gaps.map(gap => gapLabels[gap.kind]))];
  if (!labels.length) { const chip = element('span', ''); chip.hidden = true; chip.dataset.permission = ''; return chip; }
  const urgent = gaps.some(gap => gap.features.some(feature => featureState(row, feature) === 'on'));
  const chip = button(labels.join(' · '), () => openAccessGaps(row), `status status-${urgent ? 'warning' : 'info'} status-alert`);
  chip.prepend(warningIcon()); chip.dataset.permission = '';
  chip.title = gaps.map(gapSummary).join('；') + '。点击查看处理方法。';
  chip.setAttribute('aria-label', `${labels.join('、')}：${chip.title}`);
  return chip;
}
// Replaces the permission badge of rows already on the list; nothing else in a row is redrawn.
function updatePermissionBadges(rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const line of document.querySelectorAll('#rows .project-list-row')) {
    const row = byId.get(line.dataset.repositoryId), chip = line.querySelector('[data-permission]');
    if (row && chip) chip.replaceWith(permissionBadge(row));
  }
}
// Deletions answer with a stable code; the ones a person can act on get a sentence.
const removalErrors = {
  repository_still_accessible: '当前账号仍能访问这个仓库，权限也齐全，不能删除。',
  repository_permissions_insufficient: '当前账号仍能看到这个仓库，只是权限不足，不能删除。',
  github_credentials_missing: '账号没有保存凭据，无法向 GitHub 核对，记录保留，没有删除。',
  github_rate_limited: 'GitHub 限流，暂时无法核对，记录保留，没有删除。',
  sync_not_configured: '控制面没有配置 GitHub 访问，无法核对，记录保留。',
  tasks_still_stopping: '项目已禁用，但正在执行的任务还没停下；稍后再删除。',
  manager_unavailable: '虚拟电脑管理服务不可用，容器和网络没能去掉；项目已禁用，记录保留，稍后再删除。',
  repository_deleting: '这个项目正在删除。',
  last_super_admin: '不能删除最后一名活跃的管理员。',
  account_has_projects: '还有项目使用这个账号，请先删除这些项目。',
  project_account_pending: '项目的虚拟电脑或门禁接入还有未完成的操作，稍后再删除。',
};
function removalMessage(err) {
  const code = String(err.message).replace(/^\d+\s*·\s*/, '');
  return removalErrors[code] || (code.startsWith('github_') ? `无法向 GitHub 核对（${code}），记录保留，没有删除。` : err.message);
}
// The server asks GitHub again before deleting; the badges on the list are never enough. A refusal stays in the dialog.
async function deleteProject(row, after) {
  const check = '删除前会当场向 GitHub 核对：只有仓库已删除，或当前账号已完全不能访问它（已移出安装、安装被暂停、读取返回 404 或 403）时才会删除。仍能访问（包括权限不足），或 GitHub 暂时无法核对时，记录保留。';
  const body = row.registered === false ? [check, '这个仓库从未启动，只去掉安装列表里的这一行。以后安装同步如果又看到它，会像新仓库一样出现。']
    : [check, '删除后：', ['这个项目从项目列表消失', '正在执行的任务会停止', '虚拟电脑的容器和网络、项目长期笔记及其卷会删除', '工作卷按现有环境删除保留，重置留下的旧代次卷也保留',
      '项目的策略、成员分配、专属模型、外部执行客户端、任务记录、投递和看板数据一并删除，操作审计保留'], '以后安装同步如果又看到这个仓库，它会像新仓库一样出现。'];
  const deleted = await askConfirm({ title: `${row.registered === false ? '从项目列表删除' : '删除项目'} ${row.full_name}？`, body, action: '删除', danger: true,
    progress: `正在向 GitHub 核对 ${row.full_name}…`, run: () => api(`/api/installations/${row.id}/removal`, 'DELETE', { confirm: true }).catch(err => { throw new Error(removalMessage(err)); }) });
  if (deleted) await after();
  return deleted;
}
// Installed but never started: no project record to delete. Hiding only removes the list row, and sync keeps it hidden.
async function hideInstalled(row, after) {
  const hidden = await askConfirm({ title: `从列表隐藏 ${row.full_name}？`, action: '隐藏', danger: true,
    body: ['只从列表里隐藏这一行；不会卸载 App、不会删除 GitHub 仓库，下次同步也不会再出现（可用“恢复”找回）。'],
    run: () => api(`/api/installations/${row.id}`, 'DELETE', {}).catch(err => { throw new Error(removalMessage(err)); }) });
  if (hidden) await after();
  return hidden;
}
async function restoreInstalled(row, after) {
  try { await api(`/api/installations/${row.id}/restore`, 'POST', {}); $('message').textContent = ''; } catch (err) { error(err); }
  await after();
}
const gateLabels = { none: ['门禁未接入', 'info'], configured: ['门禁已配置', 'warning'], live: ['门禁已生效', 'success'], unknown: ['门禁未知', 'info'] };
function integrationChip(caption, tone, href, title) {
  if (!href) { const chip = badge(caption, tone); if (title) chip.title = title; return chip; }
  const link = element('a', caption, `status status-${tone} status-link`);
  link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = title || href;
  return link;
}
function boardChip(row) {
  const published = row.board_enabled && row.board_state === 'published';
  const chip = integrationChip(!row.board_enabled ? '看板已关闭' : published ? '查看看板' : '看板采集中',
    !row.board_enabled ? 'info' : published ? 'success' : 'warning', published ? row.board_url : null,
    row.board_enabled ? '看板数据公开可访问' : '在全局设置的项目管理中开启后对外提供');
  chip.dataset.boardStatus = ''; return chip;
}
function updateBoardChip(group, row) {
  const current = group.closest('.project-list-row, .global-project-row')?.querySelector('[data-board-status]');
  if (current) current.replaceWith(boardChip(row));
}
function installedIntegration(integration, row) {
  const gate = integration ? gateLabels[integration.gate_state] || gateLabels.unknown : null;
  const chip = gate ? integrationChip(gate[0], gate[1], integration.gate_url, integration.gate_detail) : badge('发布检查未完成', 'info');
  chip.dataset.integration = '';
  return row ? [chip, boardChip(row)] : [chip];
}
// Gate checks and board publication refresh independently without redrawing the row.
function updateIntegrationChips(integrations) {
  const byId = new Map(integrations.map(item => [item.repository_id, item]));
  for (const line of document.querySelectorAll('#rows .project-list-row, .global-project-row')) {
    const integration = byId.get(line.dataset.repositoryId), chips = [...line.querySelectorAll('[data-integration]')];
    if (!integration || !chips.length) continue;
    chips[0].replaceWith(...installedIntegration(integration)); chips.slice(1).forEach(chip => chip.remove());
  }
}
function installedActions(row, after) {
  const actions = element('div', '', 'actions');
  const call = async (path, body, caption) => {
    actions.querySelectorAll('button').forEach(b => { b.disabled = true; }); $('message').textContent = caption;
    try { await api(`/api/installations/${row.id}/${path}`, 'POST', body); $('message').textContent = ''; } catch (err) { error(err); }
    await after();
  };
  // Gate onboarding is a conversation in static/gate-onboarding.js; boards are managed by the list switch.
  actions.append(button('接入门禁', () => openGateOnboarding(row, after), ''));
  if (!row.registered && row.installed) actions.append(button('启动', () => openActivation(row, after), ''));
  // Review has its own switch; this action resumes a disabled project.
  if (row.registered && !row.enabled) actions.append(button('启用', () => call('activate', {}, `正在启用 ${row.full_name}…`)));
  if (row.registered && row.enabled) actions.append(button('禁用', async () => {
    if (await askConfirm({ title: `禁用 ${row.full_name}？`, body: ['新的 Issue／PR 不再处理，正在执行的任务会中止，虚拟电脑停止但数据保留，之后可以再启用。'], action: '禁用', danger: true }))
      call('disable', {}, `正在禁用 ${row.full_name}…`);
  }));
  if (row.registered) actions.append(button('设置', () => openProject(row.id), 'quiet'));
  // A project still off the installation is deleted only after GitHub confirms the account lost it; a started project can
  // also be deleted here from the control plane alone; an installed but never started repository is only hidden.
  if (row.installed !== true) actions.append(button('删除', () => deleteProject(row, after), 'quiet destructive'));
  else if (row.registered) actions.append(button('删除', () => deleteProjectRecord(row, after), 'quiet destructive'));
  else actions.append(button('删除', () => hideInstalled(row, after), 'quiet destructive'));
  return actions;
}
const activationView = document.createElement('dialog'); activationView.id = 'activation-view'; activationView.setAttribute('aria-labelledby', 'activation-title');
activationView.innerHTML = `<form id="activation-form" method="dialog"><h2 id="activation-title"></h2>
<p class="muted">启动后为这个仓库创建虚拟电脑，并开始检视新打开的 Issue 和 PR。启动前收到的事件只存档，不会补跑。</p>
<label>检视和开发使用的模型<select name="model_id"></select></label>
<label class="check"><input type="checkbox" name="development_enabled"> 同时开启自动开发：Issue 明确要求改代码时，在虚拟电脑里实现、测试并开 bot PR</label>
<p id="activation-error" class="view-error" role="alert"></p>
<div class="actions"><button type="button" class="quiet" id="activation-cancel">取消</button><button type="submit">启动</button></div></form>`;
document.body.append(activationView);
let activationTarget = null;
async function openActivation(row, after) {
  activationTarget = { row, after }; const form = $('activation-form'), select = form.elements.model_id;
  $('activation-title').textContent = '启动 ' + row.full_name; $('activation-error').textContent = ''; form.reset(); select.replaceChildren();
  const models = (await api('/api/models')).models.filter(m => m.repository_id === null || m.repository_id === row.id);
  for (const m of models) select.add(new Option(`${m.model_name} · ${m.repository_id ? '本仓库专属' : '部署共享'}${m.key_configured ? '' : '（Key 已撤销）'}`, m.id));
  select.add(new Option('暂不选择（任务会等待模型配置）', ''));
  activationView.showModal();
}
$('activation-cancel').addEventListener('click', () => activationView.close());
$('activation-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('[type=submit]'), target = activationTarget; if (!target) return;
  submit.disabled = true;
  try {
    await api(`/api/installations/${target.row.id}/activate`, 'POST', { model_id: form.elements.model_id.value || null, development_enabled: form.elements.development_enabled.checked });
    activationView.close(); await target.after();
  } catch (err) { $('activation-error').textContent = err.message; } finally { submit.disabled = false; }
});

