// Project workbench (#952): two focused views under #/projects/:id/overview —
// 1. Default "角色视图" (Role View): live occupancy, configured capacity limits, running tasks and genuinely attributable queues per role.
// 2. "任务视图" (Task List View): single-row task list with associated Issue/PR/Actions badges and inline Role Flow Diagram.

const workspaceTaskGroups = [
  ['all', '全部'],
  ['active', '执行中'],
  ['queued', '排队中'],
  ['attention', '需关注'],
  ['completed', '已完成'],
];

const roleDutyLabels = {
  controller: '主控编排',
  writer: '代码与修改',
  observer: '只读检视',
  evaluator: '独立验收',
};

function parseWorkbenchRoute(item) {
  if (!item || item === 'roles') return { view: 'roles', group: 'all', offset: 0 };
  if (item === 'tasks') return { view: 'tasks', group: 'all', offset: 0 };
  const prefixed = /^tasks\.(all|active|queued|attention|completed)(?:\.(\d+))?$/.exec(item);
  if (prefixed) return { view: 'tasks', group: prefixed[1], offset: Number(prefixed[2] || 0) };
  const legacy = /^(all|active|queued|attention|completed)(?:\.(\d+))?$/.exec(item);
  if (legacy) return { view: 'tasks', group: legacy[1], offset: Number(legacy[2] || 0) };
  return null;
}

function roleTaskRefLabel(entry) {
  if (entry.object_number != null) {
    return `${String(entry.kind || '').endsWith('.pr') ? 'PR' : '#'}#${entry.object_number}`.replace('##', '#');
  }
  return '#' + shortId(entry.task_id);
}

function formatElapsedText(iso) {
  if (!iso || typeof formatDurationMs !== 'function') return '';
  const durMs = Date.now() - Date.parse(iso);
  return Number.isFinite(durMs) && durMs >= 0 ? formatDurationMs(durMs) : '';
}

function refreshWorkbenchTimes(container) {
  if (!container?.querySelectorAll) return;
  for (const el of container.querySelectorAll('[data-started-at]')) {
    const text = formatElapsedText(el.dataset.startedAt);
    if (text) { el.textContent = text; el.hidden = false; }
  }
  if (typeof waitedFor === 'function') {
    for (const el of container.querySelectorAll('[data-queued-at]')) {
      const waited = waitedFor(el.dataset.queuedAt);
      if (waited) { el.textContent = waited; el.hidden = false; }
    }
    for (const el of container.querySelectorAll('[data-updated-at]')) {
      const rel = waitedFor(el.dataset.updatedAt);
      if (rel) el.textContent = `${rel}前`;
    }
  }
}

function renderRoleBoardRow(role, unsupportedQueue, projectConcurrency) {
  const row = element('div', '', 'role-board-row');
  row.dataset.roleRow = role.role;

  // 1. Role identity + backend/model
  const idCell = element('div', '', 'role-cell role-cell-identity');
  const titleLine = element('div', '', 'role-title-line');
  const dot = element('span', '', `role-dot role-dot-${role.kind || 'worker'}`);
  dot.setAttribute('aria-hidden', 'true');
  titleLine.append(dot, element('strong', role.name || role.role, 'role-name-text'));
  if (roleDutyLabels[role.kind]) titleLine.append(element('span', roleDutyLabels[role.kind], 'role-duty-tag'));
  const backendName = typeof harnessName === 'function' ? harnessName(role.harness) : (role.harness || '默认后端');
  const modelText = role.model ? `${backendName} · ${role.model}` : `${backendName}${['claude_code', 'codex'].includes(role.harness) ? '' : ' · 未配置模型'}`;
  idCell.append(titleLine, element('p', modelText, 'muted role-backend-line'));

  // 2. Capacity & status badge
  const capCell = element('div', '', 'role-cell role-cell-capacity');
  const activeRuns = (role.running || []).filter(r => !r.delegated_active);
  const delegatedCount = (role.running || []).length - activeRuns.length;
  const readyList = role.ready || [];
  const limit = role.limit;
  let capBadge;
  if (limit !== null && activeRuns.length >= limit) {
    capBadge = badge(`满载 ${activeRuns.length}/${limit}${readyList.length ? ` · 排队 ${readyList.length}` : ''}`, 'warning');
  } else if (activeRuns.length > 0) {
    capBadge = badge(`执行中 ${limit !== null ? `${activeRuns.length}/${limit}` : activeRuns.length}${readyList.length ? ` · 排队 ${readyList.length}` : ''}`, 'info');
  } else if (readyList.length > 0) {
    capBadge = badge(`待调度 · 排队 ${readyList.length}`, 'warning');
  } else {
    capBadge = badge(limit !== null ? `空闲 0/${limit}` : Number.isFinite(projectConcurrency) ? `空闲 0/${projectConcurrency}` : '空闲', '');
  }
  capCell.append(capBadge);

  // 3. Running tasks
  const runCell = element('div', '', 'role-cell role-cell-running');
  runCell.append(element('span', '正在执行', 'role-mobile-label'));
  if (activeRuns.length > 0) {
    const list = element('div', '', 'role-chip-list');
    for (const run of activeRuns) {
      const chip = element('button', '', 'quiet role-task-chip role-task-running');
      chip.type = 'button';
      chip.dataset.taskId = run.task_id;
      chip.dataset.attentionTask = run.task_id;
      chip.addEventListener('click', () => openTask(run.task_id).catch(error));
      const pulse = element('span', '', 'flow-pulse-dot');
      pulse.setAttribute('aria-hidden', 'true');
      const ref = element('strong', roleTaskRefLabel(run), 'role-chip-ref');
      const sum = element('span', clipText(run.summary || (kindLabels[run.kind] || run.kind), 44), 'role-chip-summary');
      const dur = formatElapsedText(run.started_at);
      chip.append(pulse, ref, sum);
      if (run.started_at) {
        const timeSpan = element('span', dur, 'role-chip-time');
        timeSpan.dataset.startedAt = run.started_at;
        timeSpan.hidden = !dur;
        chip.append(timeSpan);
      }
      list.append(chip);
    }
    runCell.append(list);
  } else if (delegatedCount > 0) {
    runCell.append(element('span', `已委派子角色推进中（${delegatedCount} 项）`, 'muted role-idle-note'));
  } else {
    runCell.append(element('span', '当前空闲', 'muted role-idle-note'));
  }

  // 4. Queued tasks
  const queueCell = element('div', '', 'role-cell role-cell-queue');
  queueCell.append(element('span', '排队队列', 'role-mobile-label'));
  if (readyList.length > 0) {
    const list = element('div', '', 'role-chip-list');
    readyList.forEach((item, idx) => {
      const chip = element('button', '', 'quiet role-task-chip role-task-queued');
      chip.type = 'button';
      chip.dataset.taskId = item.task_id;
      chip.dataset.attentionTask = item.task_id;
      chip.addEventListener('click', () => openTask(item.task_id).catch(error));
      chip.append(
        element('span', `#${idx + 1}`, 'role-queue-pos'),
        element('strong', roleTaskRefLabel(item), 'role-chip-ref'),
        element('span', clipText(item.summary || (kindLabels[item.kind] || item.kind), 40), 'role-chip-summary'),
      );
      if (item.priority && item.priority !== 'P2') {
        chip.append(badge(item.priority, item.priority === 'P0' ? 'danger' : item.priority === 'P1' ? 'warning' : ''));
      }
      if (item.queue_reason === 'role_capacity') {
        chip.append(badge('等槽位', 'warning'));
      } else if (item.queued_at) {
        const waited = typeof waitedFor === 'function' ? waitedFor(item.queued_at) : null;
        const waitSpan = element('span', waited || '', 'role-chip-time');
        waitSpan.dataset.queuedAt = item.queued_at;
        waitSpan.hidden = !waited;
        chip.append(waitSpan);
      }
      list.append(chip);
    });
    queueCell.append(list);
  } else if (unsupportedQueue) {
    queueCell.append(element('span', '多候选阶段策略，调度时确定归属', 'muted role-idle-note'));
  } else {
    queueCell.append(element('span', '无排队任务', 'muted role-idle-note'));
  }

  row.append(idCell, capCell, runCell, queueCell);
  return row;
}

function renderWorkbenchTaskRow(row) {
  const item = element('article', '', 'workbench-task-row');
  item.dataset.taskId = row.id;

  // Col 1: Summary & associated objects
  const infoCol = element('div', '', 'task-col task-col-info');
  const openBtn = button(row.summary || objectLabel(row) || row.id, () => openTask(row.id).catch(error), 'btn-text linkish task-row-open');
  openBtn.dataset.attentionTask = row.id;
  infoCol.append(openBtn);

  const metaLine = element('div', '', 'task-row-sub');
  const prio = row.priority || 'P2';
  metaLine.append(badge(prio, prio === 'P0' ? 'danger' : prio === 'P1' ? 'warning' : ''));

  const ext = row.external || {};
  if (ext.issue) {
    metaLine.append(element('span', `Issue #${ext.issue.number}`, 'task-assoc-tag'));
  } else if (row.object_number != null && !String(row.kind || '').endsWith('.pr')) {
    metaLine.append(element('span', `Issue #${row.object_number}`, 'task-assoc-tag'));
  }
  if (ext.pull_request) {
    const pr = ext.pull_request;
    metaLine.append(element('span', `PR #${pr.number}${pr.state === 'merged' ? ' (已合入)' : pr.draft ? ' (Draft)' : ''}`, 'task-assoc-tag task-assoc-pr'));
  } else if (row.object_number != null && String(row.kind || '').endsWith('.pr')) {
    metaLine.append(element('span', `PR #${row.object_number}`, 'task-assoc-tag task-assoc-pr'));
  }
  if (ext.actions && ext.actions.total > 0) {
    const act = ext.actions;
    const actText = act.failed > 0 ? `Actions ${act.failed} 失败 ✕` : act.running > 0 ? `Actions ${act.running} 运行中` : `Actions ${act.passed}/${act.total} ✓`;
    const actCls = act.failed > 0 ? 'check-pill-fail' : act.running > 0 ? 'check-pill-running' : 'check-pill-pass';
    metaLine.append(element('span', actText, `task-check-pill ${actCls}`));
  }
  infoCol.append(metaLine);

  const guidance = typeof consoleAttention !== 'undefined' && consoleAttention[row.status];
  if (guidance) {
    infoCol.append(element('p', row.error_cause?.action || guidance[1], 'muted task-row-guidance'));
  }

  // Col 2: Current status
  const stateCol = element('div', '', 'task-col task-col-state');
  stateCol.append(taskState(row));

  // Col 3: Inline Role Flow Diagram
  const flowCol = element('div', '', 'task-col task-col-flow');
  const flowWrap = element('div', '', 'flow-scroll-wrap');
  if (typeof renderRoleFlowDiagram === 'function') {
    flowWrap.append(renderRoleFlowDiagram(row.role_flow, { compact: true }));
  }
  flowCol.append(flowWrap);

  // Col 4: Updated timestamp
  const timeCol = element('div', '', 'task-col task-col-updated');
  const updatedIso = row.updated_at || row.created_at || '';
  const rel = typeof waitedFor === 'function' ? waitedFor(updatedIso) : null;
  const fullTime = timestamp(updatedIso) || '—';
  const timeSpan = element('span', rel ? `${rel}前` : fullTime, 'muted task-updated-text');
  if (updatedIso) timeSpan.dataset.updatedAt = updatedIso;
  timeSpan.title = fullTime;
  timeCol.append(timeSpan);

  item.append(infoCol, stateCol, flowCol, timeCol);
  return item;
}

function workspaceOverview() {
  const parsed = parseWorkbenchRoute(current.item);
  if (!parsed) return [pageNotFoundState(current.id)];

  const id = current.id, owner = me.id, routeKey = location.hash;
  const { view: viewMode, group, offset } = parsed;
  const size = 10;
  const taskAddress = (key, next = 0) => key === 'all' && !next
    ? `#/projects/${id}/overview/tasks`
    : `#/projects/${id}/overview/${key}${next ? '.' + next : ''}`;

  const root = element('section', '', 'workspace-overview');
  const alive = () => root.isConnected && me?.id === owner && current?.id === id && current.section === 'overview' && location.hash === routeKey;

  // View tabs move into the global project header; this row keeps live capacity and actions.
  const topBar = element('div', '', 'workbench-top');
  const viewTabs = element('nav', '', 'workbench-tabs');
  viewTabs.setAttribute('aria-label', '项目工作台视图');
  viewTabs.dataset.projectId = id;

  const roleTab = element('a', '', 'workbench-tab');
  roleTab.href = `#/projects/${id}/overview`;
  roleTab.dataset.workbenchView = 'roles';
  const roleCountBadge = element('span', '—', 'workbench-tab-count');
  roleTab.append(element('span', '角色视图'), roleCountBadge);
  if (viewMode === 'roles') roleTab.setAttribute('aria-current', 'page');

  const taskTab = element('a', '', 'workbench-tab');
  taskTab.href = `#/projects/${id}/overview/tasks`;
  taskTab.dataset.workbenchView = 'tasks';
  const taskTotalBadge = element('span', '—', 'workbench-tab-count');
  taskTab.append(element('span', '任务视图'), taskTotalBadge);
  if (viewMode === 'tasks') taskTab.setAttribute('aria-current', 'page');

  viewTabs.append(roleTab, taskTab);

  const rightBar = element('div', '', 'workbench-right-bar');
  const liveSummary = element('div', '', 'workbench-live-stats');
  const statRunning = element('span', '正在执行：—', 'workbench-stat');
  const statQueued = element('span', '排队中：—', 'workbench-stat');
  const statSlots = element('span', '项目并发槽位：—', 'workbench-stat');
  liveSummary.append(statRunning, statQueued, statSlots);

  const refresh = button('刷新总览', () => void update(), 'quiet');
  const newTaskBtn = element('a', '+ 新建任务', 'button-link btn-primary workbench-new-task');
  newTaskBtn.href = consolePageAddress('new-task', id);
  rightBar.append(liveSummary, refresh, newTaskBtn);
  topBar.append(viewTabs, rightBar);
  root.append(topBar);

  // Filter pills (rendered in Task View, and kept in DOM with counts updated so deep links & tests work seamlessly)
  const metrics = element('nav', '', 'workspace-metrics workbench-filter-pills');
  metrics.setAttribute('aria-label', '项目任务范围');
  const numbers = new Map();
  for (const [key, caption] of workspaceTaskGroups) {
    const a = element('a', '', 'workbench-filter-pill');
    a.href = taskAddress(key, 0);
    a.dataset.taskGroup = key;
    if (viewMode === 'tasks' && key === group) a.setAttribute('aria-current', 'page');
    const count = element('strong', '—');
    a.append(element('span', caption), count);
    numbers.set(key, count);
    metrics.append(a);
  }

  let searchQuery = '';
  let searchTimer = null;
  const searchInput = element('input', '', 'workbench-task-search');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索任务简介、Issue 或 PR 编号…';
  searchInput.setAttribute('aria-label', '搜索任务');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      signature = '';
      void tasks();
    }, 180);
  });

  const taskToolbar = element('div', '', 'workbench-task-toolbar');
  taskToolbar.append(metrics, searchInput);

  // Role View Section
  const roleSection = element('section', '', 'workbench-role-section');
  roleSection.hidden = viewMode !== 'roles';
  const roleStatus = note('正在读取角色队列与并发状态…');
  roleStatus.classList.add('workspace-role-status');
  roleStatus.setAttribute('role', 'status');
  const roleTable = element('div', '', 'role-board-table');
  roleTable.dataset.testid = 'project-role-board';
  const roleHead = element('div', '', 'role-board-head');
  roleHead.append(
    element('span', '角色与执行后端'),
    element('span', '状态 / 容量'),
    element('span', '正在执行'),
    element('span', '排队队列'),
  );
  const roleRows = element('div', '', 'role-board-rows');
  roleTable.append(roleHead, roleRows);
  roleSection.append(roleStatus, roleTable);

  // Task View Section
  const taskSection = element('section', '', 'workbench-task-section');
  taskSection.hidden = viewMode !== 'tasks';
  const taskStatus = note('正在读取完整任务范围…');
  taskStatus.classList.add('workspace-task-status');
  taskStatus.setAttribute('role', 'status');
  const taskHead = element('div', '', 'workbench-task-head');
  taskHead.append(
    element('span', '任务简介与关联对象'),
    element('span', '当前状态'),
    element('span', '角色流转情况（框图）'),
    element('span', '更新'),
  );
  const rows = element('div', '', 'workspace-task-rows');
  const paging = element('nav', '', 'console-inbox-paging');
  paging.setAttribute('aria-label', '总览任务分页');
  taskSection.append(taskToolbar, taskStatus, taskHead, rows, paging);

  // Compact Workbench Footer (quick links + honest environment status)
  const footer = element('footer', '', 'workbench-footer');
  const healthStatus = note('正在读取环境记录…');
  healthStatus.className = 'muted workspace-health-status';
  healthStatus.setAttribute('role', 'status');
  const quickLinks = element('div', '', 'workbench-quick-links');
  quickLinks.append(
    element('a', '角色与并发配置 →', 'workbench-quick-link'),
    element('a', '待处理中心 →', 'workbench-quick-link'),
    element('a', '项目电脑状态 →', 'workbench-quick-link'),
  );
  quickLinks.children[0].href = `#/projects/${id}/roles`;
  quickLinks.children[1].href = consolePageAddress('inbox', id);
  quickLinks.children[2].href = `#/projects/${id}/machine`;
  footer.append(healthStatus, quickLinks);

  root.append(roleSection, taskSection, footer);

  let pending = false, lastRoles = null, lastTasks = null, lastHealth = null;
  let roleSignature = '', signature = '', taskReqSeq = 0;

  const rowKey = row => JSON.stringify([row.id, row.repository_id, row.kind, row.object_number, row.status, row.priority, row.summary, row.error_code, row.updated_at, row.external, row.role_flow]);

  const expired = (node, err, time) => {
    node.classList.add('view-error'); node.setAttribute('role', 'alert');
    node.textContent = `${readErrorText(err)}。${time ? '保留上次成功数据（' + timestamp(time) + '），可能已过期。' : '暂时无法判断，不显示为零或正常。'}可用“刷新总览”重试。`;
  };
  const revoke = err => {
    if (![401, 403, 404].includes(err?.status) || !alive()) return false;
    $('project-page').replaceChildren(consoleState('项目访问已变化', '无法继续读取这个项目，请重新加载当前授权。', { tone: 'error', retry: () => start().catch(error) }));
    current = { id, unavailable: err.status === 404 ? 'missing' : err.status === 401 ? 'login' : 'forbidden' };
    repositories = repositories.filter(repo => String(repo.id) !== String(id));
    syncConsoleShell(); return true;
  };

  async function loadRoleBoard() {
    try {
      const board = await api(`/api/repositories/${id}/role-board`);
      if (!alive()) return;
      lastRoles = new Date().toISOString();
      roleStatus.classList.remove('view-error');
      roleStatus.setAttribute('role', 'status');
      newTaskBtn.hidden = board.can_write_tasks === false;

      const visibleRoles = (board.roles || []).filter(r => r.enabled && (r.role !== 'coordinator' || r.running?.length || r.ready?.length));
      roleCountBadge.textContent = String(visibleRoles.length);

      const activeRoleCount = visibleRoles.filter(r => (r.running || []).some(run => !run.delegated_active)).length;
      const queuedTaskCount = board.project?.queued_tasks ?? 0;
      const capacityWaitingCount = board.project?.capacity_waiting_tasks ?? 0;
      const unattributedQueued = board.project?.unattributed_queued ?? 0;
      const runningSlots = board.project?.running_tasks ?? 0;
      const projectConcurrency = board.project?.task_concurrency ?? null;
      const maxSlots = projectConcurrency ?? '—';
      statRunning.textContent = `正在执行：${activeRoleCount} 个角色`;
      statQueued.textContent = capacityWaitingCount > 0
        ? `排队中：${queuedTaskCount} 项（另 ${capacityWaitingCount} 项等槽位）`
        : `排队中：${queuedTaskCount} 项`;
      statSlots.textContent = `项目并发槽位：${runningSlots} / ${maxSlots}`;

      const unsupportedQueue = Array.isArray(board.unsupported) && board.unsupported.includes('role_queue');
      roleStatus.textContent = `共启用 ${visibleRoles.length} 个项目角色 · 角色并发限额${board.enforced ? '已启用' : '未单独限制（共享项目槽位）'}${unattributedQueued > 0 ? ` · ${unattributedQueued} 项排队任务待调度确定角色` : ''} · 更新于 ${timestamp(lastRoles)}`;

      if (viewMode === 'roles') {
        const nextSig = JSON.stringify([visibleRoles, board.unsupported, projectConcurrency]);
        if (roleSignature !== nextSig || !roleRows.childElementCount) {
          roleSignature = nextSig;
          const focusedTask = roleRows.contains(document.activeElement) ? document.activeElement.dataset?.attentionTask : null;
          roleRows.replaceChildren(...visibleRoles.map(r => renderRoleBoardRow(r, unsupportedQueue, projectConcurrency)));
          if (focusedTask) roleRows.querySelector(`[data-attention-task="${CSS.escape(focusedTask)}"]`)?.focus({ preventScroll: true });
        } else {
          refreshWorkbenchTimes(roleRows);
        }
        if (typeof tryRestoreTaskReturn === 'function') tryRestoreTaskReturn({ settle: true });
      }
    } catch (err) {
      if (!alive() || revoke(err)) return;
      expired(roleStatus, err, lastRoles);
    }
  }

  async function tasks() {
    const req = ++taskReqSeq;
    if (viewMode === 'tasks') rows.setAttribute('aria-busy', 'true');
    try {
      const params = new URLSearchParams({
        repository_id: id,
        summary: '1',
        group,
        limit: viewMode === 'tasks' ? String(size) : '1',
        offset: viewMode === 'tasks' ? String(offset) : '0',
      });
      if (viewMode === 'tasks') params.set('flow', '1');
      if (viewMode === 'tasks' && searchQuery) params.set('q', searchQuery);
      const data = await api('/api/tasks?' + params);
      if (!alive() || req !== taskReqSeq) return;
      lastTasks = data.summary.sampled_at;
      if (!searchQuery) taskTotalBadge.textContent = String(data.summary.all ?? '—');
      for (const [key, count] of numbers) {
        const val = key === 'completed' ? (data.completed_count ?? 0) : data.summary[key];
        count.textContent = String(val ?? 0);
      }
      if (viewMode !== 'tasks') return;

      taskStatus.classList.remove('view-error');
      taskStatus.setAttribute('role', 'status');
      const total = group === 'completed' ? (data.completed_count ?? 0) : data.summary[group];
      taskStatus.textContent = `${total} 项任务记录 · ${data.tasks.length ? `显示 ${offset + 1}–${offset + data.tasks.length} 项 · ` : ''}更新于 ${timestamp(lastTasks)}`;

      const nextSignature = JSON.stringify(data.tasks.map(rowKey));
      if (signature !== nextSignature || !rows.childElementCount) {
        signature = nextSignature;
        const focusedTask = rows.contains(document.activeElement) ? document.activeElement.dataset.attentionTask : null;
        const old = new Map([...rows.children].filter(node => node.dataset.taskId).map(node => [node.dataset.taskId, node]));
        if (!data.tasks.length) {
          rows.replaceChildren(consoleState(
            offset ? '本页已没有任务' : (searchQuery ? '没有匹配搜索条件的任务' : '当前范围没有任务'),
            offset ? '任务状态可能已变化，可返回上一页。' : '这里没有匹配的任务记录，不代表环境、CI 或其他范围全部正常。',
          ));
        } else {
          const wanted = data.tasks.map(row => {
            const key = rowKey(row), existing = old.get(row.id);
            if (existing?.taskSignature === key) return existing;
            const node = renderWorkbenchTaskRow(row);
            node.taskSignature = key;
            return node;
          });
          wanted.forEach((node, index) => { if (rows.children[index] !== node) rows.insertBefore(node, rows.children[index] || null); });
          [...rows.children].filter(node => !wanted.includes(node)).forEach(node => node.remove());
        }
        if (focusedTask) rows.querySelector(`[data-attention-task="${CSS.escape(focusedTask)}"]`)?.focus({ preventScroll: true });
      } else {
        refreshWorkbenchTimes(rows);
      }
      if (typeof tryRestoreTaskReturn === 'function') tryRestoreTaskReturn({ settle: true });

      const hasNext = offset + data.tasks.length < total, pageKey = `${group}:${offset}:${hasNext}`;
      if (paging.dataset.pageKey !== pageKey) {
        paging.dataset.pageKey = pageKey; paging.replaceChildren();
        if (offset) paging.append(consoleLink(taskAddress(group, Math.max(0, offset - size)), '上一页'));
        if (hasNext) paging.append(consoleLink(taskAddress(group, offset + size), '下一页'));
      }
    } catch (err) {
      if (!alive() || req !== taskReqSeq || revoke(err)) return;
      expired(taskStatus, err, lastTasks);
    } finally { if (req === taskReqSeq) rows.removeAttribute('aria-busy'); }
  }

  async function environment() {
    try {
      const [data, repo] = await Promise.all([api(`/api/environments/${id}`), api(`/api/repositories/${id}`)]);
      if (!alive()) return;
      lastHealth = new Date().toISOString();
      healthStatus.classList.remove('view-error');
      healthStatus.setAttribute('role', 'status');
      const env = data.environment;
      const envStateLabel = states[env.state]?.[0] || env.state || '未知';
      healthStatus.textContent = `项目配置：${repo.policy.enabled ? '已启用' : '已停用'} · 项目电脑：${envStateLabel} · 记录读取于 ${timestamp(lastHealth)}（环境就绪不代表任务或 CI 成功）。`;
    } catch (err) {
      if (!alive() || revoke(err)) return;
      expired(healthStatus, err, lastHealth);
    }
  }

  async function update() {
    if (!alive() || pending) return;
    pending = true; refresh.disabled = true;
    try { await Promise.all([loadRoleBoard(), tasks(), environment()]); }
    finally { pending = false; refresh.disabled = false; }
  }

  const poll = async () => { if (!alive()) return; if (!document.hidden) await update(); if (alive()) setTimeout(poll, 5000); };
  queueMicrotask(() => void poll());
  return [root];
}
