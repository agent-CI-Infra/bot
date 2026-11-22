// Each category loads only what its cards show.
// Cleanup by days (#671): one form for every window, saved with PUT /api/storage/retention (platform administrators,
// audited) and applied by the daily cleanup; group chats keep their own per-chat setting, summarised here.
async function retentionCard(size, count, time, refresh) {
  const view = await api('/api/storage/retention'), section = settingsCard('空间回收', 'h2'), form = element('form', '', 'project-form');
  const { settings, defaults, bounds } = view, status = note(''); status.setAttribute('role', 'status');
  const number = (name, value, [min, max]) => input(name, value ?? '', { type: 'number', min, max, step: 1 });
  const fields = [
    ['trajectory_days', '轨迹正文：任务结束后保留天数（留空不过期）', `结束的任务和 Manager 分派的轨迹文件，关闭超过这么多天后删除；会话的轨迹不删。同一次运行的模型请求、工具调用和日志在同一个文件里，所以按文件整体删除。同一窗口也清理 bot-data 上已结束任务的 browser-evidence/ 截图目录；没有对应任务的目录视为遗留并删除。`],
    ['manager_payload_days', 'manager 重复正文保留天数', `默认 ${defaults.manager_payload_days} 天。控制面另存了同样的请求和结果。`],
    ['workspace_finished_days', '任务工作区：任务结束后保留天数', `默认 ${defaults.workspace_finished_days} 天；没有任务记录的目录也按这个。为打开的 PR 保留的不受影响。`],
    ['workspace_failed_days', '任务工作区：任务失败后保留天数', `默认 ${defaults.workspace_failed_days} 天。`],
    ['webhook_payload_days', 'Webhook 投递正文保留天数（留空不过期）', `至少 ${bounds.webhook_payload_days[0]} 天：外部执行端会读最近的投递。删除后投递记录、状态和正文的 sha256 保留。`]];
  const controls = {}, windows = element('div', '', 'storage-windows');
  for (const [key, label, help] of fields) {
    controls[key] = number(key, settings[key], bounds[key]);
    const group = element('div');
    group.append(field(label, controls[key]), note(help)); windows.append(group);
  }
  form.append(windows);
  const overrides = costTable(['项目', '保留天数']), perProject = {};
  overrides.wrap.classList.add('storage-overrides');
  for (const project of view.projects) {
    const control = number('trajectory_days_' + project.id, settings.trajectory_days_by_project[project.id], bounds.trajectory_days);
    // #882: the project name is in a sibling cell, and a sibling is not an accessible name — name the input itself.
    control.setAttribute('aria-label', `${project.name} 轨迹正文保留天数`);
    perProject[project.id] = control;
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.append(perProject[project.id]); row.append(element('td', project.name), cell); overrides.body.append(row);
  }
  if (view.projects.length) form.append(element('p', '项目轨迹正文保留天数（留空沿用全局设置）', 'muted'), overrides.wrap);
  const save = element('button', '保存清理设置'); save.type = 'submit';
  form.append(status, save);
  form.addEventListener('submit', async event => {
    event.preventDefault(); announceSave(status, '', false);
    const value = control => control.value.trim() === '' ? null : Number(control.value);
    const body = Object.fromEntries(fields.map(([key]) => [key, value(controls[key])]));
    for (const key of ['manager_payload_days', 'workspace_finished_days', 'workspace_failed_days']) if (body[key] === null) body[key] = defaults[key];
    body.trajectory_days_by_project = Object.fromEntries(Object.entries(perProject).map(([id, control]) => [id, value(control)]));
    save.disabled = true;
    try { await api('/api/storage/retention', 'PUT', body); announceSave(status, '已保存，下一次每日清理按新设置执行。', false); }
    catch (err) { announceSave(status, readErrorText(err), true); } finally { save.disabled = false; }
  });
  const settingsPanel = element('details', '', 'storage-settings');
  settingsPanel.append(element('summary', '保留天数与项目设置'));
  const action = element('button', '立即回收'), outcome = note('');
  action.type = 'button'; outcome.setAttribute('role', 'status');
  function show(result) {
    action.disabled = result?.status === 'running';
    const when = result?.finished_at ? time(result.finished_at) + ' · ' : '';
    const totals = '已清理 ' + count(result?.count ?? 0) + ' 项，文件 ' + size(result?.file_bytes ?? 0) + '，库内正文 ' + size(result?.payload_bytes ?? 0);
    const messages = { running: '正在按已保存策略回收…', completed: when + (result?.count ? totals : '没有可回收内容。'),
      partial: when + totals + '。有 ' + count(result?.failed) + ' 项清理失败，可稍后重试。',
      failed: '回收失败，请核对统计后重试。', interrupted: '上次回收被服务重启中断，可重新执行。' };
    announceSave(outcome, messages[result?.status] ?? '', ['failed', 'partial', 'interrupted'].includes(result?.status));
  }
  async function follow(result) {
    show(result);
    while (result?.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!section.isConnected) return;
      result = await api('/api/storage/reclaim'); show(result);
    }
    if (section.isConnected) {
      const updated = await api('/api/storage/retention');
      history.replaceChildren(cleanupFacts(updated));
      await refresh?.(section);
    }
  }
  function problem(err) { action.disabled = false; announceSave(outcome, '无法确认回收状态，请稍后重试。' + readErrorText(err), true); }
  action.addEventListener('click', async () => {
    if (action.disabled) return;
    show({ status: 'running' });
    try { await follow(await api('/api/storage/reclaim', 'POST', {})); } catch (err) { problem(err); }
  });
  show(view.reclaim);
  if (view.reclaim?.status === 'running') void follow(view.reclaim).catch(problem);
  section.append(note('按已保存天数清理过期正文、证据和工作区。运行中的任务、会话及为打开的 PR 保留的工作区继续受保护。'), action, outcome);
  settingsPanel.append(note('设置了天数的类别，每天在后台分批清理一次：只删正文，记录行、计费、审计和哈希保留，引用到已删正文的地方会显示「已过保留期删除」。留空表示不过期。'), form);
  section.append(settingsPanel);
  const history = element('div');
  function cleanupFacts(current) {
    const last = current.last_cleanup;
    return facts([
      ['最近一次清理', last?.finished_at ? `${time(last.finished_at)}：轨迹文件 ${count(last.trajectories?.count ?? 0)} 个（${size(last.trajectories?.bytes ?? 0)}），Webhook 正文 ${count(last.deliveries?.count ?? 0)} 条（${size(last.deliveries?.bytes ?? 0)}），浏览器证据 ${count(last.evidence?.count ?? 0)} 个目录（${size(last.evidence?.bytes ?? 0)}），提交检查记录 ${count(last.commit_checks?.count ?? 0)} 条`
        + ((last.trajectories?.failed || last.deliveries?.failed || last.evidence?.failed || last.commit_checks?.failed) ? `；${count((last.trajectories?.failed ?? 0) + (last.deliveries?.failed ?? 0) + (last.evidence?.failed ?? 0) + (last.commit_checks?.failed ?? 0))} 项没能清理，下次再试` : '')
        + (last.manager_window === null ? '；manager 没有应答，保留天数下次再同步' : '') + (last.last_error ? `；最近一个错误：${last.last_error}` : '') : '尚未运行'],
      ['群聊记录', current.chats ? `${count(current.chats.configured)} / ${count(current.chats.chats)} 个群设置了保留天数${current.chats.configured ? `（${current.chats.min_days}–${current.chats.max_days} 天）` : ''}；在「飞书会话」按会话设置` : '没有群聊']]);
  }
  history.append(cleanupFacts(view));
  settingsPanel.append(history);
  return section;
}
