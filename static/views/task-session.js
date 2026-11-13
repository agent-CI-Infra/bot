let openTaskId = null, taskTimer = null, renderedLogs = new Set(), liveCommand = null, snapshotProgress = null, taskLogState = null, taskReadVersion = 0, taskInboxOrigin = null;
function resetTaskRendering() {
  renderedLogs = new Set(); liveCommand = null; snapshotProgress = null;
  delete $('task-actions').dataset.signature;
}
async function openTask(id) {
  if (!taskView.open) taskInboxOrigin = typeof captureConsoleInbox === 'function' ? captureConsoleInbox(id) : null;
  taskReadVersion++; taskLogState = { id, logs: [], page: null, error: '', olderPending: false };
  $('task-log-controls').replaceChildren();
  openTaskId = id; resetTaskRendering(); $('timeline-command').hidden = true; clearTimeout(taskTimer);
  $('task-picker').hidden = true; $('task-layout').hidden = false; $('task-next').hidden = true; $('task-next-text').textContent = '';
  for (const part of ['timeline', 'task-side', 'task-badges', 'task-actions']) $(part).replaceChildren();
  $('task-title').textContent = '正在加载…'; notice('task-error'); $('timeline-live').hidden = true;
  if (!taskView.open) taskView.showModal();
  await refreshTask();
}
// The delivery detail already exists behind the events list; a task's source delivery opens that same view, no new route.
async function openTaskDelivery(deliveryId) {
  const event = await api('/api/events/' + encodeURIComponent(deliveryId));
  $('detail-title').textContent = '投递详情';
  $('detail-body').replaceChildren(...deliveryDetail(event));
  $('detail').showModal();
}
function openTaskChoices(label, tasks, hasMore = false, onMore = null) {
  taskReadVersion++; taskLogState = null;
  resetTaskRendering();
  openTaskId = null; clearTimeout(taskTimer); $('timeline-command').hidden = true; $('timeline-live').hidden = true; notice('task-error');
  for (const part of ['timeline', 'task-side', 'task-badges', 'task-actions']) $(part).replaceChildren();
  $('task-title').textContent = `${label} · 选择任务`; $('task-actions').append(button('关闭', () => taskView.close()));
  $('task-layout').hidden = true; $('task-next').hidden = true;
  const picker = $('task-picker'), list = element('div', '', 'task-choice-list'); picker.hidden = false; picker.replaceChildren();
  picker.append(element('p', tasks.length ? `当前筛选下有 ${tasks.length}${hasMore ? '+' : ''} 个关联任务，选择一个查看完整过程。` : '当前筛选下没有关联任务。', 'muted'));
  if (tasks.length) picker.append(list);
  for (const task of tasks) {
    const row = element('div', '', 'task-choice-row'), choose = button(`${kindLabels[task.kind] || task.kind} · ${timestamp(task.updated_at || task.created_at)}`, () => openTask(task.id).catch(error), 'task-choice-open');
    row.append(choose, taskState(task)); const metrics = taskMetricsLine(task); if (metrics) row.append(metrics); list.append(row);
  }
  if (hasMore && onMore) {
    const more = button('更多关联任务', async () => {
      more.disabled = true;
      try { const result = await onMore(); openTaskChoices(label, result.tasks, result.hasMore, onMore); }
      catch (err) { notice('task-error', err.message); more.disabled = false; }
    }, 'quiet'); picker.append(more);
  }
  if (!taskView.open) taskView.showModal();
}
async function refreshTask() {
  clearTimeout(taskTimer); const id = openTaskId; if (!id || !taskView.open) return;
  if (!taskLogState || taskLogState.id !== id) taskLogState = { id, logs: [], page: null, error: '', olderPending: false };
  const request = ++taskReadVersion, logState = taskLogState;
  const current = () => openTaskId === id && taskView.open && request === taskReadVersion;
  try {
    const after = logState?.page && logState.logs.at(-1)?.sequence;
    const [detail, logResult, roleView] = await Promise.all([api('/api/tasks/' + id), api('/api/tasks/' + id + '/logs' + (after ? '?after=' + after : '')).catch(error => ({ error })), taskRoleView(id)]);
    const environment = await api('/api/environments/' + detail.task.repository_id).catch(() => null);
    const roles = roleRecords(roleView), purposes = await rolePurposes(id, roles);
    if (!current()) return;
    renderTaskHeader(detail.task); renderTaskNext(detail.task, roles, purposes);
    if (logResult.error && [401, 403, 404].includes(logResult.error.status)) throw logResult.error;
    if (logResult.error) logState.error = logResult.error.message;
    else {
      logState.error = ''; mergeTaskLogs(logState, logResult, !after); renderTimeline(detail.task, logState.logs);
    }
    logState.task = detail.task; updateTaskLogControls(logState);
    await refreshLive(detail.task, current); if (!current()) return;
    keepOpen($('task-side'), () => renderTaskSide(detail, environment, roles, purposes));
    if (!terminalStates.includes(detail.task.status)) taskTimer = setTimeout(refreshTask, detail.task.status.startsWith('waiting_') ? 5000 : 2000);
  } catch (err) {
    if (!current()) return;
    if ([401, 403, 404].includes(err.status)) {
      resetTaskRendering();
      taskLogState = { id, logs: [], page: null, error: '', olderPending: false };
      for (const part of ['timeline', 'task-side', 'task-badges', 'task-actions', 'task-log-controls']) $(part).replaceChildren();
      $('task-next').hidden = $('timeline-command').hidden = $('timeline-live').hidden = true;
      $('task-title').textContent = '任务暂不可访问';
      $('task-actions').append(button('关闭', () => taskView.close()));
    }
    notice('task-error', err.message); taskTimer = setTimeout(refreshTask, 5000);
  }
}
function mergeTaskLogs(cache, result, initial = false) {
  const rows = new Map(cache.logs.map(log => [log.id, log]));
  for (const log of result.logs || []) rows.set(log.id, log);
  cache.logs = [...rows.values()];
  if (result.log_page) {
    cache.logs.sort((a, b) => a.sequence - b.sequence);
    cache.page = { ...result.log_page, has_older: initial ? result.log_page.has_older : cache.page?.has_older || false };
  }
}
function updateTaskLogControls(cache) {
  if (taskLogState !== cache) return;
  if (!cache.controls) {
    const status = element('p', '', 'muted'), message = element('p', '', 'view-error'); status.setAttribute('role', 'status'); message.setAttribute('role', 'alert');
    const older = button('加载更早日志', () => loadOlderTaskLogs(cache));
    const retry = button('重新读取日志', () => refreshTask());
    const newer = button('加载后续日志', () => refreshTask());
    $('task-log-controls').replaceChildren(status, older, newer, retry, message); cache.controls = { status, older, newer, retry, message };
  }
  const { status, older, newer, retry, message } = cache.controls;
  status.textContent = `已读取 ${cache.logs.length} 条日志` + (cache.page?.has_older ? ' · 还有更早记录' : '') + (cache.page?.has_newer ? ' · 后续记录待载入' : '');
  older.hidden = !cache.page?.has_older; older.disabled = cache.olderPending;
  newer.hidden = !cache.page?.has_newer; retry.hidden = !cache.error;
  message.textContent = cache.error ? '日志读取失败：' + cache.error + '。已读取内容保留，可重试。' : '';
}
async function loadOlderTaskLogs(cache) {
  if (taskLogState !== cache || cache.olderPending || !cache.logs.length) return;
  cache.olderPending = true; updateTaskLogControls(cache);
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(cache.id)}/logs?before=${cache.logs[0].sequence}`);
    if (taskLogState !== cache || !taskView.open) return;
    mergeTaskLogs(cache, result); cache.page.has_older = result.log_page.has_older; cache.error = '';
    const panel = scroller($('timeline').parentElement), top = panel.scrollTop, height = panel.scrollHeight;
    keepOpen($('timeline'), () => {
      $('timeline').replaceChildren(); renderedLogs = new Set(); snapshotProgress = null; renderTimeline(cache.task, cache.logs);
    });
    panel.scrollTop = top + panel.scrollHeight - height;
  } catch (err) { if (taskLogState === cache) cache.error = err.message; }
  finally { cache.olderPending = false; if (taskLogState === cache) updateTaskLogControls(cache); }
}
function renderTaskHeader(task) {
  $('task-title').textContent = task.object_number == null ? objectLabel(task) : `${modeLabels[task.kind] || task.kind} · ${objectLabel(task)}`;
  $('task-badges').replaceChildren(taskState(task), element('span', task.full_name || '仓库 ' + task.repository_id, 'muted'));
  const actions = $('task-actions'), url = githubUrl(task), destination = taskConfigurationDestination(task), signature = `${task.id}:${task.status}:${url || ''}:${destination?.section || ''}`;
  if (actions.childElementCount && actions.dataset.signature === signature) return;
  actions.dataset.signature = signature; actions.replaceChildren();
  if (url) actions.append(link(url, '在 GitHub 打开', 'button-link'));
  if (destination) actions.append(button(destination.caption, () => {
    if (typeof rememberInboxReturn === 'function') rememberInboxReturn(taskInboxOrigin, task.repository_id);
    taskView.close(); openProject(task.repository_id, destination.section);
  }));
  if (retryableStates.includes(task.status)) actions.append(button('重试', async event => {
    const retry = event.currentTarget; retry.disabled = true;
    try { await api('/api/tasks/' + task.id + '/retry', 'POST', {}); if(openTaskId===task.id){notice('task-error');notice('message');} }
    catch (err) { if(openTaskId===task.id)notice('task-error',retryErrorText(err)); }
    finally { retry.disabled = false; }
    await refreshTask();
  }));
  actions.append(button('刷新任务', () => refreshTask()), button('关闭', () => taskView.close()));
}
// Route only configuration failures whose remedy belongs to a project page. An upstream outage or an unknown
// failure must keep its recorded explanation rather than being presented as a model configuration problem.
function taskConfigurationDestination(task) {
  if (!task.repository_id || !['failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'paused'].includes(task.status)) return null;
  if (task.error_cause?.cause === 'role_configuration') return { section: 'roles', caption: '打开角色配置' };
  if (task.error_cause?.cause === 'environment') return { section: 'machine', caption: '检查项目电脑' };
  if (['model_not_configured', 'task_models_invalid', 'model_not_available', 'model_configuration_changed', 'model_key_missing', 'model_authentication_failed'].includes(task.error_code))
    return { section: 'model', caption: '打开项目模型配置' };
  return null;
}
// The command running right now in the project computer, with its output streamed by byte offset.
async function refreshLive(task, current = () => openTaskId === task.id && taskView.open) {
  const box = $('timeline-command');
  if (task.status !== 'running') { box.hidden = true; liveCommand = null; return; }
  let live = await api(`/api/tasks/${task.id}/live?offset=${liveCommand?.offset || 0}`).catch(() => null);
  if (!current()) return;
  if (live?.running && liveCommand && live.operation_id !== liveCommand.operation_id) { liveCommand = null; live = await api(`/api/tasks/${task.id}/live?offset=0`).catch(() => null); }
  if (!current()) return;
  if (!live?.running) { box.hidden = true; liveCommand = null; return; }
  if (!liveCommand) liveCommand = { operation_id: live.operation_id, offset: 0, text: '', seen: Date.now() };
  liveCommand.text = (liveCommand.text + live.output).slice(-65536); liveCommand.offset = live.offset;
  const panel = scroller(box.parentElement), atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
  const head = element('div', '', 'step-head'), meta = element('span', '', 'step-meta');
  // Commands run until they end; only a timeout the agent chose for itself is shown.
  const notes = [live.timeout_ms ? `超时 ${Math.max(1, Math.round(live.timeout_ms / 60000))} 分钟` : '', live.keep_background ? '保留后台进程' : ''].filter(Boolean);
  meta.append(badge('运行中', 'info'), element('span', notes.join(' · ')));
  head.append(element('strong', '正在执行命令'), meta);
  box.replaceChildren(head, element('pre', '$ ' + live.command, 'command'), element('pre', liveCommand.text || '（还没有输出）', 'output live-output'));
  box.hidden = false; if (atBottom) panel.scrollTop = panel.scrollHeight;
}
const ownershipErrors={bot_pr_identity_changed:'PR 身份改变，需要核对原 PR',bot_pr_author_changed:'PR 作者改变，需要管理员确认',bot_pr_head_repository_changed:'PR 的 head 仓库改变，需要管理员确认',bot_pr_branch_changed:'PR 的 head 分支改变，需要管理员确认'};
function liveText(task) {
  if (terminalStates.includes(task.status)) return null;
  if (task.status === 'queued') return '排队中，等待这个仓库的虚拟电脑空闲…';
  const next = task.error_cause?.attempt_retry && task.next_run_at ? `下次重试：${timestamp(task.next_run_at)}。` : '';
  if (task.status === 'waiting_configuration' && task.error_code === 'repository_has_no_commit') return emptyRepositoryMessage;
  if(task.status==='waiting_pr_head')return `PR 尚未指向刚推送的提交 ${task.pushed_sha||'（读取中）'}；正在自动重读 PR head，匹配后继续更新 PR 描述。不会重复推送或增加修订轮数。`;
  if (task.status === 'publishing') return '正在发布到 GitHub…';
  if(ownershipErrors[task.error_code])return ownershipErrors[task.error_code]+'；已暂停，不会推送其他作者或分支。';
  if (task.status.startsWith('waiting_') || task.status === 'retry_wait' || ['needs_replan','needs_help'].includes(task.status) || task.status === 'paused') {
    const caption = (states[task.status] || [task.status])[0], cause = task.error_cause;
    if (!cause) return `已暂停：${caption}${task.error_code ? '（' + task.error_code + '）' : ''}`;
    const count = !cause.retry_cycle && task.status === 'retry_wait' && task.error_code !== 'github_rate_limited' && task.retry_count ? `同一种失败已连续出现 ${task.retry_count} 次，满 5 次后改为每 8 小时重试。` : '';
    return `已暂停：${caption} · ${cause.label}（${task.error_code}）。${count}${cause.action}${next}`;
  }
  return { prepare: '正在准备工作区：拉取固定提交并写入虚拟电脑…', model: 'Agent 正在请求模型或执行工具…', validate: '正在虚拟电脑里运行仓库测试…', publish: '正在发布到 GitHub…' }[task.phase] || '执行中…';
}
