let openTaskId = null, taskTimer = null, taskRetryDelay = 0, renderedLogs = new Set(), liveCommand = null, snapshotProgress = null, taskLogState = null, taskReadVersion = 0, taskInboxOrigin = null, taskPollError = '';
let taskReturnOrigin = null, pendingTaskReturn = null, currentTaskRepoId = null, taskFoldState = null;

function hasPendingTaskReturn() {
  return Boolean(pendingTaskReturn && typeof me !== 'undefined' && pendingTaskReturn.actor === me && location.hash === pendingTaskReturn.address);
}

function tryRestoreTaskReturn({ settle = false } = {}) {
  if (!pendingTaskReturn) return false;
  if (typeof me === 'undefined' || pendingTaskReturn.actor !== me || location.hash !== pendingTaskReturn.address) {
    pendingTaskReturn = null;
    return false;
  }
  const ret = pendingTaskReturn;
  if (ret.deliveryRecordId) {
    pendingTaskReturn = null;
    if (typeof scrollTo === 'function') scrollTo(0, ret.y || 0);
    void openTaskDelivery(ret.deliveryRecordId).catch(error);
    return true;
  }
  let trigger = null;
  if (ret.taskId && typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(ret.taskId) : ret.taskId;
    for (const candidate of document.querySelectorAll(`[data-attention-task="${escaped}"], [data-task-id="${escaped}"] a, [data-task-id="${escaped}"] button`)) {
      if (!candidate.closest?.('[hidden]')) { trigger = candidate; break; }
    }
  }
  if (trigger) {
    pendingTaskReturn = null;
    if (typeof scrollTo === 'function') scrollTo(0, ret.y || 0);
    trigger.focus?.({ preventScroll: true });
    return true;
  }
  if (settle) {
    pendingTaskReturn = null;
    if (typeof scrollTo === 'function') scrollTo(0, ret.y || 0);
  }
  return false;
}

function navigateTaskAddress(hash) {
  if (location.hash !== hash) {
    if (typeof history !== 'undefined' && typeof history.pushState === 'function') history.pushState(null, '', hash);
    if (location.hash !== hash) location.hash = hash;
  }
  if (typeof route === 'function') return route();
  return Promise.resolve();
}

function ensureTaskFoldState(id) {
  if (!taskFoldState || taskFoldState.id !== id) {
    taskFoldState = { id, outer: new Map(), inner: new Map() };
  }
  return taskFoldState;
}

function resetTaskRendering() {
  renderedLogs = new Set(); liveCommand = null; snapshotProgress = null;
  const actions = $('task-actions');
  if (actions?.dataset) delete actions.dataset.signature;
}

function computeTaskReturnLabel() {
  const proj = typeof projectRoute === 'function' ? projectRoute() : null;
  if (proj) {
    const repo = (typeof repositories !== 'undefined' ? repositories : []).find(r => String(r.id) === String(proj.id));
    const name = repo?.full_name ? repo.full_name.split('/').pop() : `项目 ${proj.id}`;
    const isTaskList = proj.section === 'overview' && /^(tasks|active|queued|attention|all|completed)(?:[./]|$)/.test(proj.item || '');
    return `返回 ${name} ${isTaskList ? '任务视图' : proj.section === 'overview' ? '角色视图' : '项目页'}`;
  }
  if (typeof tab !== 'undefined') {
    if (tab === 'inbox') return '返回待处理列表';
    if (tab === 'board') return '返回任务看板';
    if (tab === 'conversations') return '返回飞书会话';
    if (tab === 'costs') return '返回用量与成本';
  }
  return '返回项目总览';
}

function bindTaskDetailControls(node) {
  const backLink = node.querySelector('#task-back-link') || $('task-back-link');
  if (backLink && !backLink.dataset.bound) {
    backLink.dataset.bound = '1';
    backLink.addEventListener('click', event => {
      event.preventDefault();
      closeTaskDetail();
    });
  }
  const expandAll = node.querySelector('#task-expand-all') || $('task-expand-all');
  if (expandAll && !expandAll.dataset.bound) {
    expandAll.dataset.bound = '1';
    expandAll.addEventListener('click', () => { if (typeof setAllTaskFolds === 'function') setAllTaskFolds(true); });
  }
  const collapseAll = node.querySelector('#task-collapse-all') || $('task-collapse-all');
  if (collapseAll && !collapseAll.dataset.bound) {
    collapseAll.dataset.bound = '1';
    collapseAll.addEventListener('click', () => { if (typeof setAllTaskFolds === 'function') setAllTaskFolds(false); });
  }
}

function focusRoleRunBlock(runId) {
  if (!runId) return;
  const state = ensureTaskFoldState(openTaskId);
  state.outer.set(runId, true);
  const list = $('role-runs-list');
  const target = list?.querySelectorAll ? [...list.querySelectorAll('details.role-run-fold')].find(el => el.dataset.runId === runId) : null;
  if (target) {
    target.open = true;
    target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    target.querySelector('summary')?.focus?.({ preventScroll: true });
  }
}

function leaveTaskDetailPage() {
  clearTimeout(taskTimer);
  taskTimer = null;
  openTaskId = null;
  taskReadVersion++;
  taskLogState = null;
  taskPollError = '';
}

function closeTaskPicker() {
  if (typeof taskPickerDialog !== 'undefined' && taskPickerDialog?.open) taskPickerDialog.close();
}

function closeTaskDetail() {
  const closingTaskId = openTaskId;
  const repoId = currentTaskRepoId;
  const inboxOrigin = taskInboxOrigin; taskInboxOrigin = null;
  const retOrigin = taskReturnOrigin; taskReturnOrigin = null;
  leaveTaskDetailPage();

  if (typeof me !== 'undefined' && me && typeof route === 'function') {
    if (inboxOrigin && inboxOrigin.actor === me) {
      if (typeof rememberInboxReturn === 'function') rememberInboxReturn(inboxOrigin, inboxOrigin.repositoryId || repoId || '');
      if (typeof consoleInboxReturn !== 'undefined') consoleInboxReturn = inboxOrigin;
      if (location.hash === inboxOrigin.address) {
        if (typeof refreshInboxAfterTask === 'function') void refreshInboxAfterTask(inboxOrigin);
      } else {
        void navigateTaskAddress(inboxOrigin.address).catch(error);
      }
      return;
    }
    const fallbackHash = repoId ? `#/projects/${repoId}/overview` : '#/projects';
    const destHash = retOrigin && retOrigin.actor === me && retOrigin.address && !/^#\/tasks(?:\/|$)/.test(retOrigin.address)
      ? retOrigin.address
      : fallbackHash;
    pendingTaskReturn = retOrigin && retOrigin.actor === me ? {
      address: destHash,
      actor: me,
      taskId: closingTaskId,
      y: retOrigin.y || 0,
      deliveryRecordId: retOrigin.deliveryRecordId || null,
    } : null;
    void navigateTaskAddress(destHash).catch(error);
  }
}

async function startTaskDetailSession(id, routeRequest = null) {
  ensureTaskDetailView();
  taskReadVersion++;
  ensureTaskFoldState(id);
  taskLogState = { id, logs: [], page: null, error: '', olderPending: false, roleRuns: [] };
  $('task-log-controls').replaceChildren();
  openTaskId = id;
  resetTaskRendering();
  $('timeline-command').hidden = true;
  clearTimeout(taskTimer);
  taskRetryDelay = 0;
  closeTaskPicker();
  $('task-layout').hidden = false;
  $('task-archive-fold').hidden = false;
  $('task-archive-fold').open = false;
  $('task-next').hidden = true;
  $('task-next-text').textContent = '';
  $('task-fault-box').hidden = true;
  $('task-fault-box').replaceChildren();
  for (const part of ['timeline', 'role-runs-list', 'task-side', 'task-badges', 'task-actions', 'task-goal-box', 'task-external-bar', 'task-flow-bar']) {
    $(part)?.replaceChildren();
  }
  $('role-runs-list').hidden = true;
  $('timeline').hidden = false;
  const backLink = $('task-back-link');
  if (backLink) {
    const label = taskReturnOrigin?.label || '返回项目总览';
    backLink.textContent = '← ' + label;
    backLink.href = taskReturnOrigin?.address || (currentTaskRepoId ? `#/projects/${currentTaskRepoId}/overview` : '#/projects');
  }
  $('task-title').textContent = '正在加载…';
  taskPollError = '';
  notice('task-error');
  $('timeline-live').hidden = true;
  if (typeof scrollTo === 'function') scrollTo(0, 0);
  if (routeRequest !== null && typeof renderVersion !== 'undefined' && routeRequest !== renderVersion) return;
  await refreshTask();
}
async function renderTaskRoute(request) {
  const parsed = typeof taskRoute === 'function' ? taskRoute() : null;
  if (!parsed?.id) {
    if (typeof renderNotFoundPage === 'function') renderNotFoundPage();
    return;
  }
  await startTaskDetailSession(parsed.id, request);
}

async function openTask(id) {
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  closeTaskPicker();
  if (typeof me !== 'undefined' && me && !/^#\/tasks(?:\/|$)/.test(location.hash || '')) {
    const openDeliveryId = $('detail')?.open ? ($('detail').dataset?.recordId || null) : null;
    taskInboxOrigin = typeof captureConsoleInbox === 'function' ? captureConsoleInbox(id) : null;
    taskReturnOrigin = {
      address: location.hash || '#/projects',
      label: computeTaskReturnLabel(),
      taskId: id,
      y: typeof scrollY === 'number' ? scrollY : 0,
      deliveryRecordId: openDeliveryId,
      actor: me,
    };
  }
  if (typeof me !== 'undefined' && me && typeof renderConsolePage === 'function' && typeof route === 'function') {
    const targetHash = '#/tasks/' + encodeURIComponent(id);
    if (typeof consolePositions !== 'undefined') consolePositions.delete(targetHash);
    if (location.hash !== targetHash) {
      if (typeof rememberConsolePosition === 'function') rememberConsolePosition();
      await navigateTaskAddress(targetHash);
      return;
    }
  }
  await startTaskDetailSession(id);
}

// A task's source delivery opens the archived delivery in this dialog. There is no delivery-list page.
async function openTaskDelivery(deliveryId) {
  const event = await api('/api/events/' + encodeURIComponent(deliveryId));
  $('detail-title').textContent = '投递详情';
  $('detail-body').replaceChildren(...deliveryDetail(event));
  $('detail').showModal();
}

function openTaskChoices(label, tasks, hasMore = false, onMore = null) {
  taskReadVersion++;
  taskLogState = null;
  resetTaskRendering();
  taskRetryDelay = 0;
  openTaskId = null;
  clearTimeout(taskTimer);
  taskPollError = '';
  notice('task-picker-error');
  $('task-picker-title').textContent = `${label} · 选择任务`;
  $('task-picker-actions').replaceChildren(button('关闭', () => closeTaskPicker()));
  const picker = $('task-picker'), list = element('div', '', 'task-choice-list');
  picker.hidden = false;
  picker.replaceChildren();
  picker.append(element('p', tasks.length ? `当前筛选下有 ${tasks.length}${hasMore ? '+' : ''} 个关联任务，选择一个查看完整过程。` : '当前筛选下没有关联任务。', 'muted'));
  if (tasks.length) picker.append(list);
  for (const task of tasks) {
    const row = element('div', '', 'task-choice-row');
    const choose = button(`${kindLabels[task.kind] || task.kind} · ${timestamp(task.updated_at || task.created_at)}`, () => {
      closeTaskPicker();
      openTask(task.id).catch(error);
    }, 'task-choice-open');
    row.append(choose, taskState(task));
    const metrics = typeof taskMetricsLine === 'function' ? taskMetricsLine(task) : null;
    if (metrics) row.append(metrics);
    list.append(row);
  }
  if (hasMore && onMore) {
    const more = button('更多关联任务', async () => {
      more.disabled = true;
      try { const result = await onMore(); openTaskChoices(label, result.tasks, result.hasMore, onMore); }
      catch (err) { notice('task-picker-error', readErrorText(err)); more.disabled = false; }
    }, 'quiet');
    picker.append(more);
  }
  if (!taskPickerDialog.open) taskPickerDialog.showModal();
}

// #877: the bar is written by the poll's own catch, so a refresh that succeeds has to take it back — the task is readable
// again and a bar still saying otherwise makes the screen reader repeat an outage that ended. The same box carries the
// retry path's conflict text (#745), which is meant to outlive refreshes, so only the exact text this poll wrote is
// withdrawn; anything else stays until its own writer clears it.
function withdrawTaskError() {
  if (!taskPollError) return;
  const shown = $('task-error').firstElementChild?.textContent || '';
  if (shown === taskPollError || !shown) notice('task-error');
  taskPollError = '';
}

async function refreshTask() {
  clearTimeout(taskTimer); taskTimer = null;
  const id = openTaskId;
  if (!id || !taskView.open) return;
  if (!taskLogState || taskLogState.id !== id) taskLogState = { id, logs: [], page: null, error: '', olderPending: false, roleRuns: [] };
  const request = ++taskReadVersion, logState = taskLogState;
  const current = () => openTaskId === id && taskView.open && request === taskReadVersion;
  try {
    const after = logState?.page && logState.logs.at(-1)?.sequence;
    const [detail, logResult, roleView] = await Promise.all([
      api('/api/tasks/' + encodeURIComponent(id)),
      api('/api/tasks/' + encodeURIComponent(id) + '/logs' + (after ? '?after=' + after : '')).catch(error => ({ error })),
      taskRoleView(id),
    ]);
    const environment = detail?.task?.repository_id ? await api('/api/environments/' + detail.task.repository_id).catch(() => null) : null;
    const roles = roleRecords(roleView), purposes = await rolePurposes(id, roles);
    if (!current()) return;
    withdrawTaskError();
    taskRetryDelay = 0;
    currentTaskRepoId = detail.task.repository_id || null;
    logState.roleRuns = Array.isArray(detail.role_runs) ? detail.role_runs : Array.isArray(roleView?.role_runs) ? roleView.role_runs : [];

    renderTaskHeader(detail.task, detail);
    renderTaskNext(detail.task, roles, purposes);
    renderTaskSummaryBody(detail.task, detail);

    if (logResult.error && pollAfterError(logResult.error).terminal) throw logResult.error;
    if (logResult.error) logState.error = readErrorText(logResult.error);
    else {
      logState.error = '';
      mergeTaskLogs(logState, logResult, !after);
      renderTimeline(detail.task, logState.logs, logState.roleRuns);
    }
    logState.task = detail.task;
    updateTaskLogControls(logState);
    await refreshLive(detail.task, current);
    if (!current()) return;
    if (typeof applyDocumentTitle === 'function') applyDocumentTitle(false, null);
    keepOpen($('task-side'), () => renderTaskSide(detail, environment, roles, purposes));
    if (!terminalStates.includes(detail.task.status)) {
      taskTimer = setTimeout(refreshTask, detail.task.status.startsWith('waiting_') ? 5000 : 2000);
    }
  } catch (err) {
    if (!current()) return;
    taskPollError = readErrorText(err);
    const poll = pollAfterError(err, taskRetryDelay);
    if (poll.terminal) {
      resetTaskRendering();
      taskLogState = { id, logs: [], page: null, error: '', olderPending: false, roleRuns: [] };
      for (const part of ['timeline', 'role-runs-list', 'task-side', 'task-badges', 'task-actions', 'task-log-controls', 'task-goal-box', 'task-external-bar', 'task-flow-bar', 'task-fault-box']) {
        $(part)?.replaceChildren();
      }
      $('task-next').hidden = $('timeline-command').hidden = $('timeline-live').hidden = $('task-fault-box').hidden = true;
      $('role-runs-list').hidden = true;
      $('task-archive-fold').hidden = true;
      $('task-title').textContent = '任务暂不可访问';
      $('task-actions').append(button('关闭', () => taskView.close()), button('重新读取', () => refreshTask()));
      notice('task-error', taskPollError);
      taskRetryDelay = 0;
      return;
    }
    notice('task-error', taskPollError);
    taskTimer = setTimeout(refreshTask, taskRetryDelay = poll.delay);
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
    const status = element('p', '', 'muted'), message = element('p', '', 'view-error');
    status.setAttribute('role', 'status'); message.setAttribute('role', 'alert');
    const older = button('加载更早日志', () => loadOlderTaskLogs(cache));
    const retry = button('重新读取日志', () => refreshTask());
    const newer = button('加载后续日志', () => refreshTask());
    $('task-log-controls').replaceChildren(status, older, newer, retry, message);
    cache.controls = { status, older, newer, retry, message };
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
    const container = cache.roleRuns?.length ? $('role-runs-list') : $('timeline');
    const panel = scroller(container.parentElement), top = panel.scrollTop, height = panel.scrollHeight;
    keepOpen(container, () => {
      $('timeline').replaceChildren();
      $('role-runs-list').replaceChildren();
      renderedLogs = new Set(); snapshotProgress = null;
      renderTimeline(cache.task, cache.logs, cache.roleRuns || []);
    });
    panel.scrollTop = top + panel.scrollHeight - height;
  } catch (err) { if (taskLogState === cache) cache.error = readErrorText(err); }
  finally { cache.olderPending = false; if (taskLogState === cache) updateTaskLogControls(cache); }
}

function renderTaskHeader(task, detail = null) {
  const backLink = $('task-back-link');
  if (backLink && !taskReturnOrigin) {
    const repoLabel = task.full_name ? task.full_name.split('/').pop() : (task.repository_id ? `项目 ${task.repository_id}` : '工作区');
    backLink.textContent = `← 返回 ${repoLabel} 角色视图`;
    backLink.href = task.repository_id ? `#/projects/${task.repository_id}/overview` : '#/projects';
  }

  const realSummary = task.summary && task.summary !== task.id ? String(task.summary) : '';
  $('task-title').textContent = task.object_number == null
    ? objectLabel(task)
    : realSummary
      ? (realSummary.includes('#' + task.object_number) ? realSummary : `${objectLabel(task)} · ${realSummary}`)
      : `${modeLabels[task.kind] || task.kind} · ${objectLabel(task)}`;

  const badges = $('task-badges');
  badges.replaceChildren(taskState(task));
  const activeRole = detail?.role_flow?.active_role;
  if (activeRole && task.status === 'running') {
    const roleCap = ({ manager: 'Manager 规划中', dev: 'Dev 执行中', reviewer: 'Reviewer 检视中', test: 'Tester 测试中', qa: 'QA 验收中', ux: 'UX 评估中' })[activeRole] || `${activeRole} 执行中`;
    badges.append(badge(roleCap, 'info'));
  }
  const prio = task.priority || 'P2';
  badges.append(badge(prio, prio === 'P0' ? 'danger' : prio === 'P1' ? 'warning' : ''));
  badges.append(element('code', '#' + shortId(task.id), 'task-id-chip'));
  const elapsed = typeof taskElapsedLabel === 'function' ? taskElapsedLabel(task) : '';
  if (elapsed) badges.append(element('span', elapsed, 'muted task-elapsed-chip'));
  if (task.repository_id) {
    const repoLink = element('a', task.full_name || '仓库 ' + task.repository_id, 'muted task-repo-link');
    repoLink.href = `#/projects/${task.repository_id}/overview`;
    badges.append(repoLink);
  }

  const actions = $('task-actions');
  const url = githubUrl(task), destination = taskConfigurationDestination(task);
  const canManage = detail?.can_manage !== false;
  const pausable = canManage && ['running', 'preparing', 'implementing', 'validating', 'publishing', 'queued', 'retry_wait'].includes(task.status);
  const cancellable = canManage && !terminalStates.includes(task.status) && task.status !== 'cancelled';
  const signature = `${task.id}:${task.status}:${url || ''}:${destination?.section || ''}:${canManage}:${pausable}:${cancellable}`;
  if (actions.childElementCount && actions.dataset.signature === signature) return;
  actions.dataset.signature = signature;
  actions.replaceChildren();

  if (destination) {
    actions.append(button(destination.caption, () => {
      if (typeof rememberInboxReturn === 'function') rememberInboxReturn(taskInboxOrigin, task.repository_id);
      leaveTaskDetailPage();
      openProject(task.repository_id, destination.section);
    }));
  }
  if (canManage && !terminalStates.includes(task.status)) {
    actions.append(button('追加指令', () => {
      void confirmDialog({
        title: '追加任务指令',
        body: ['补充指令将在下一轮安全检查点送达执行角色，不会覆盖已有任务契约与权限上限。'],
        action: '发送指令',
        input: { label: '补充指令内容' },
        progress: '正在写入指令…',
        run: async instruction => {
          await api('/api/tasks/' + encodeURIComponent(task.id) + '/instructions', 'POST', { instruction });
          if (openTaskId === task.id) { taskPollError = ''; notice('task-error'); }
          await refreshTask();
        },
      });
    }, 'quiet'));
  }
  if (pausable) {
    actions.append(button('暂停', async event => {
      const btn = event.currentTarget; btn.disabled = true;
      try { await api('/api/tasks/' + encodeURIComponent(task.id) + '/pause', 'POST', {}); if (openTaskId === task.id) { taskPollError = ''; notice('task-error'); } }
      catch (err) { if (openTaskId === task.id) { taskPollError = ''; notice('task-error', readErrorText(err)); } }
      finally { btn.disabled = false; }
      await refreshTask();
    }, 'quiet'));
  }
  if (canManage && taskRetryable(task)) {
    actions.append(button('重试', async event => {
      const retry = event.currentTarget; retry.disabled = true;
      try { await api('/api/tasks/' + task.id + '/retry', 'POST', {}); if (openTaskId === task.id) { taskPollError = ''; notice('task-error'); notice('message'); } }
      catch (err) { if (openTaskId === task.id) { taskPollError = ''; notice('task-error', retryErrorText(err)); } }
      finally { retry.disabled = false; }
      await refreshTask();
    }));
  }
  if (cancellable) {
    actions.append(button('取消任务', async () => {
      const ok = await askConfirm({ title: '取消当前任务？', body: ['取消后将立即回收执行租约并停止正在运行的角色进程，已有记录保留供审计。'], action: '确认取消', danger: true });
      if (!ok) return;
      try { await api('/api/tasks/' + encodeURIComponent(task.id) + '/cancel', 'POST', {}); if (openTaskId === task.id) { taskPollError = ''; notice('task-error'); } await refreshTask(); }
      catch (err) { if (openTaskId === task.id) { taskPollError = ''; notice('task-error', readErrorText(err)); } }
    }, 'quiet task-cancel-btn'));
  }
  actions.append(button('刷新任务', () => refreshTask(), 'quiet'), button('关闭', () => taskView.close(), 'quiet'));
}

function renderTaskSummaryBody(task, detail) {
  // 1. Task Goal
  const goalBox = $('task-goal-box');
  if (goalBox) {
    const goalText = task.structured?.contract?.goal || task.summary || objectLabel(task);
    const criteria = task.structured?.contract?.criteria || [];
    const sig = JSON.stringify([goalText, criteria]);
    if (goalBox.dataset.signature !== sig) {
      goalBox.dataset.signature = sig;
      goalBox.replaceChildren();
      const p = element('p', '', 'task-goal-line');
      p.append(element('strong', '任务目标：'), element('span', goalText));
      goalBox.append(p);
      if (criteria.length) {
        const fold = element('details', '', 'fold task-criteria-fold');
        fold.append(element('summary', `验收标准（${criteria.length} 项）`));
        const ul = element('ul', '', 'task-criteria-list');
        for (const item of criteria) ul.append(element('li', item));
        fold.append(ul);
        goalBox.append(fold);
      }
    }
  }

  // 2. Active Fault Callout (visible without opening details)
  const faultBox = $('task-fault-box');
  if (faultBox) {
    const showFault = !['succeeded', 'pr_opened', 'completed', 'running', 'queued'].includes(task.status) && (task.error_code || task.error_detail);
    if (!showFault) {
      faultBox.hidden = true;
      faultBox.replaceChildren();
    } else {
      const detailText = task.error_detail || (task.error_code === 'pr_head_pending' ? 'PR 尚未指向刚推送的提交' : ownershipErrors[task.error_code] || taskErrorText(task.error_code));
      faultBox.replaceChildren(
        element('strong', task.error_code === 'repository_has_no_commit' ? '等待原因：' : '异常原因：'),
        element('span', detailText || task.error_code || ''),
        ...(task.error_cause?.action ? [element('span', ' · 处理建议：' + task.error_cause.action, 'muted')] : []),
      );
      faultBox.hidden = false;
    }
  }

  // 3. External Associations Bar (Issue, PR, GitHub Actions, Source Delivery)
  const extBar = $('task-external-bar');
  if (extBar) {
    const ext = task.external || {};
    const sourceDelivery = task.structured?.contract?.source?.delivery_id || task.source_delivery_id || null;
    const originText = task.origin && typeof taskOriginCaption === 'function' ? taskOriginCaption(task.origin) : '';
    const extSig = JSON.stringify([ext, sourceDelivery, originText, githubUrl(task)]);
    if (extBar.dataset.signature !== extSig) {
      extBar.dataset.signature = extSig;
      extBar.replaceChildren();

      // Issue item
      const issueItem = element('div', '', 'task-ext-item');
      issueItem.append(element('span', '关联 Issue', 'task-ext-label'));
      if (ext.issue) {
        const text = `#${ext.issue.number}${ext.issue.title ? ' · ' + clipText(ext.issue.title, 44) : ''}`;
        issueItem.append(ext.issue.url ? link(ext.issue.url, text, 'task-ext-link') : element('span', text, 'task-ext-value'));
        if (ext.issue.state) issueItem.append(badge(ext.issue.state === 'closed' ? '已关闭' : 'Open', ext.issue.state === 'closed' ? '' : 'success'));
      } else if (task.object_number && !String(task.kind || '').endsWith('.pr')) {
        const fbUrl = githubUrl(task);
        issueItem.append(fbUrl ? link(fbUrl, `#${task.object_number}`, 'task-ext-link') : element('span', `#${task.object_number}`, 'task-ext-value'));
      } else {
        issueItem.append(element('span', '未关联 Issue', 'muted'));
      }
      extBar.append(issueItem);

      // PR item
      const prItem = element('div', '', 'task-ext-item');
      prItem.append(element('span', '关联 PR', 'task-ext-label'));
      if (ext.pull_request) {
        const pr = ext.pull_request;
        const label = `PR #${pr.number}${pr.branch ? ` (${pr.branch})` : ''}`;
        prItem.append(pr.url ? link(pr.url, label, 'task-ext-link') : element('span', label, 'task-ext-value'));
        const prTone = pr.state === 'merged' ? 'success' : pr.draft ? 'warning' : pr.state === 'open' ? 'info' : '';
        const prText = pr.state === 'merged' ? '已合入' : pr.draft ? 'Draft' : pr.state === 'closed' ? '已关闭' : 'Open';
        prItem.append(badge(prText, prTone));
      } else if (task.object_number && String(task.kind || '').endsWith('.pr')) {
        const fbUrl = githubUrl(task);
        prItem.append(fbUrl ? link(fbUrl, `PR #${task.object_number}`, 'task-ext-link') : element('span', `PR #${task.object_number}`, 'task-ext-value'));
      } else {
        prItem.append(element('span', '尚未创建 PR', 'muted'));
      }
      extBar.append(prItem);

      // GitHub Actions item
      const actItem = element('div', '', 'task-ext-item task-ext-actions');
      actItem.append(element('span', 'GitHub Actions', 'task-ext-label'));
      const act = ext.actions;
      if (act && act.total > 0) {
        const pills = element('div', '', 'task-check-pills');
        for (const chk of act.checks || []) {
          const ok = chk.status === 'completed' && ['success', 'neutral', 'skipped'].includes(chk.conclusion);
          const running = chk.status !== 'completed';
          const mark = running ? '● 运行中' : ok ? '✓' : '✕';
          const cls = running ? 'check-pill-running' : ok ? 'check-pill-pass' : 'check-pill-fail';
          const pillText = `${chk.name} ${mark}`;
          pills.append(chk.details_url ? link(chk.details_url, pillText, `task-check-pill ${cls}`) : element('span', pillText, `task-check-pill ${cls}`));
        }
        actItem.append(pills);
        if (act.url) actItem.append(link(act.url, '查看运行 ↗', 'task-ext-sublink'));
      } else {
        actItem.append(element('span', '暂无检查记录', 'muted'));
        if (act?.url) actItem.append(link(act.url, '查看 Actions ↗', 'task-ext-sublink'));
      }
      extBar.append(actItem);

      // Plain-language origin caption (#699)
      if (originText) {
        const orgItem = element('div', '', 'task-ext-item');
        orgItem.append(element('span', originText, 'muted task-origin-inline'));
        extBar.append(orgItem);
      }

      // Source webhook delivery (#238)
      if (sourceDelivery) {
        const srcItem = element('div', '', 'task-ext-item');
        srcItem.dataset.sourceDelivery = sourceDelivery;
        srcItem.append(element('span', '来源投递', 'task-ext-label'));
        srcItem.append(button('查看投递', () => openTaskDelivery(sourceDelivery).catch(error), 'quiet linkish'));
        extBar.append(srcItem);
      }
    }
  }

  // 4. Role Flow Diagram
  const flowBar = $('task-flow-bar');
  if (flowBar && typeof renderRoleFlowDiagram === 'function') {
    const flowData = detail?.role_flow || null;
    const flowSig = JSON.stringify(flowData);
    if (flowBar.dataset.signature !== flowSig) {
      flowBar.dataset.signature = flowSig;
      flowBar.replaceChildren();
      const head = element('div', '', 'task-flow-head');
      head.append(element('span', '角色流转框图', 'task-ext-label'), element('span', '点击任一已执行角色可定位并展开下方对应记录', 'muted task-flow-hint'));
      const scrollerWrap = element('div', '', 'flow-scroll-wrap');
      scrollerWrap.append(renderRoleFlowDiagram(flowData, { compact: false, onSelectRun: focusRoleRunBlock }));
      flowBar.append(head, scrollerWrap);
    }
  }
}

function taskConfigurationDestination(task) {
  if (!task.repository_id || !['failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'paused'].includes(task.status)) return null;
  if (task.error_cause?.cause === 'role_configuration') return { section: 'roles', caption: '打开角色配置' };
  if (task.error_cause?.cause === 'environment') return { section: 'machine', caption: '检查项目电脑' };
  if (['model_not_configured', 'task_models_invalid', 'model_not_available', 'model_configuration_changed', 'model_key_missing', 'model_authentication_failed'].includes(task.error_code))
    return { section: 'model', caption: '打开项目模型配置' };
  return null;
}

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
  const notes = [live.timeout_ms ? `超时 ${Math.max(1, Math.round(live.timeout_ms / 60000))} 分钟` : '', live.keep_background ? '保留后台进程' : ''].filter(Boolean);
  meta.append(badge('运行中', 'info'), element('span', notes.join(' · ')));
  head.append(element('strong', '正在执行实时命令'), meta);
  box.replaceChildren(head, element('pre', '$ ' + live.command, 'command'), element('pre', liveCommand.text || '（还没有输出）', 'output live-output'));
  const docPanel = typeof document !== 'undefined' && (panel === document.scrollingElement || panel === document.documentElement || panel === document.body);
  box.hidden = false; if (atBottom && (!docPanel || panel.scrollTop > 0)) panel.scrollTop = panel.scrollHeight;
}

const ownershipErrors = { bot_pr_identity_changed: 'PR 身份改变，需要核对原 PR', bot_pr_author_changed: 'PR 作者改变，需要管理员确认', bot_pr_head_repository_changed: 'PR 的 head 仓库改变，需要管理员确认', bot_pr_branch_changed: 'PR 的 head 分支改变，需要管理员确认' };
function liveText(task) {
  if (terminalStates.includes(task.status)) return null;
  if (task.status === 'queued') return '排队中，等待这个仓库的虚拟电脑空闲…';
  const next = task.error_cause?.attempt_retry && task.next_run_at ? `下次重试：${timestamp(task.next_run_at)}。` : '';
  if (task.status === 'waiting_configuration' && task.error_code === 'repository_has_no_commit') return emptyRepositoryMessage;
  if (task.status === 'waiting_pr_head') return `PR 尚未指向刚推送的提交 ${task.pushed_sha || '（读取中）'}；正在自动重读 PR head，匹配后继续更新 PR 描述。不会重复推送或增加修订轮数。`;
  if (task.status === 'publishing') return '正在发布到 GitHub…';
  if (ownershipErrors[task.error_code]) return ownershipErrors[task.error_code] + '；已暂停，不会推送其他作者或分支。';
  if (task.status.startsWith('waiting_') || task.status === 'retry_wait' || ['needs_replan', 'needs_help'].includes(task.status) || task.status === 'paused') {
    const caption = (states[task.status] || [task.status])[0], cause = task.error_cause;
    if (!cause) return `已暂停：${caption}${task.error_code ? '（' + task.error_code + '）' : ''}`;
    const count = !cause.retry_cycle && task.status === 'retry_wait' && task.error_code !== 'github_rate_limited' && task.retry_count ? `同一种失败已连续出现 ${task.retry_count} 次，满 5 次后改为每 8 小时重试。` : '';
    return `已暂停：${caption} · ${cause.label}（${task.error_code}）。${count}${cause.action}${next}`;
  }
  return { prepare: '正在准备工作区：拉取固定提交并写入虚拟电脑…', model: 'Agent 正在请求模型或执行工具…', validate: '正在虚拟电脑里运行仓库测试…', publish: '正在发布到 GitHub…' }[task.phase] || '执行中…';
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !openTaskId) return;
  if (typeof tab !== 'undefined' && tab !== 'task') return;
  if (confirmView?.open || $('detail')?.open || $('editor')?.open || taskPickerDialog?.open) return;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
  event.preventDefault();
  closeTaskDetail();
});
