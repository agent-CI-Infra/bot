// Project workbench (#952, #1215): three focused views under #/projects/:id/overview —
// 1. Default "角色视图" (Role View): live occupancy, configured capacity limits, running tasks and genuinely attributable queues per role.
// 2. "任务视图" (Task List View): single-row task list with associated Issue/PR/Actions badges and inline Role Flow Diagram.
// 3. "Issue 进展" (Issue Auto-Development View): per-Issue lifecycle status, linked PRs, why an Issue could not be developed, and expandable dispatch/task chain.

const workspaceTaskGroups = [
  ['all', '全部'],
  ['active', '执行中'],
  ['queued', '排队中'],
  ['attention', '需关注'],
  ['completed', '已完成'],
];

const workspaceIssueGroups = [
  ['all', '全部'],
  ['pr_opened', '已开 PR'],
  ['developing', '开发中'],
  ['needs_human', '开发不了 · 需人工'],
  ['skipped', '无需 / 暂不开发'],
  ['pending', '待检视'],
];

const workspaceIssueSubGroups = [
  ['needs_information', '需补充信息'],
  ['human_decision_required', '需人工决定'],
  ['blocked', '开发受阻'],
];

const issueStatusMeta = {
  pr_opened: ['已开 PR', 'success'],
  developing: ['开发中', 'info'],
  needs_information: ['需补充信息', 'warning'],
  human_decision_required: ['需人工决定', 'warning'],
  blocked: ['开发受阻', 'danger'],
  skipped: ['无需 / 暂不开发', ''],
  pending: ['待检视', ''],
};

const dispatchDecisionMeta = {
  create: ['创建任务', 'info'],
  continue: ['续接任务', 'info'],
  ignore: ['跳过 / 忽略', ''],
};

const roleDutyLabels = {
  controller: '主控编排',
  writer: '代码与修改',
  observer: '只读检视',
  evaluator: '独立验收',
};

function parseWorkbenchRoute(item) {
  if (!item || item === 'roles') return { view: 'roles', group: 'all', offset: 0 };
  if (item === 'tasks') return { view: 'tasks', group: 'all', offset: 0 };
  if (item === 'issues') return { view: 'issues', group: 'all', offset: 0 };
  const issueRoute = /^issues\.(all|pr_opened|developing|needs_human|needs_information|human_decision_required|blocked|skipped|pending)(?:\.(\d+))?$/.exec(item);
  if (issueRoute) return { view: 'issues', group: issueRoute[1], offset: Number(issueRoute[2] || 0) };
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

function renderIssueChainPanel(detail, repoId, issueNumber) {
  const panel = element('div', '', 'issue-chain-panel');
  panel.dataset.issueChain = String(issueNumber);
  const issue = detail.issue || {};
  if (issue.review?.recommendation || issue.review?.human_action) {
    const summaryBox = element('div', '', 'issue-chain-block');
    summaryBox.append(element('h3', '检视结论与建议', 'issue-chain-heading'));
    if (issue.review.human_action) summaryBox.append(element('p', `需人工处理：${issue.review.human_action}`, 'issue-chain-highlight'));
    if (issue.review.recommendation) summaryBox.append(element('p', issue.review.recommendation, 'muted issue-chain-text'));
    panel.append(summaryBox);
  }

  const tasksBlock = element('div', '', 'issue-chain-block');
  const tasksTotal = Number(detail.tasks_total ?? (detail.tasks || []).length);
  const tasksHeading = detail.tasks_truncated
    ? `关联任务（显示 ${(detail.tasks || []).length} / 共 ${tasksTotal} 条）`
    : `关联任务（${tasksTotal}）`;
  tasksBlock.append(element('h3', tasksHeading, 'issue-chain-heading'));
  if (!detail.tasks?.length) {
    tasksBlock.append(element('p', '暂无关联任务记录。', 'muted issue-chain-text'));
  } else {
    const list = element('div', '', 'issue-chain-list');
    for (const item of detail.tasks) {
      const row = element('div', '', 'issue-chain-item');
      const roleCaption = item.role_kind === 'development' ? '开发' : item.role_kind === 'review' ? '检视' : '通用';
      const open = button(item.summary || `任务 ${shortId(item.id)}`, () => openTask(item.id).catch(error), 'btn-text linkish issue-chain-link');
      open.dataset.attentionTask = item.id;
      const meta = element('div', '', 'issue-chain-meta');
      meta.append(badge(roleCaption, item.role_kind === 'development' ? 'info' : ''), state(item.status));
      if (item.updated_at) meta.append(element('span', timestamp(item.updated_at) || item.updated_at, 'muted issue-chain-time'));
      row.append(meta, open);
      if (item.error_cause?.label || item.error_cause?.action) {
        row.append(element('p', [item.error_cause.label, item.error_cause.action].filter(Boolean).join('：'), 'muted issue-chain-text'));
      }
      list.append(row);
    }
    tasksBlock.append(list);
    if (detail.tasks_truncated) {
      tasksBlock.append(element('p', `仅展示最近 ${detail.tasks.length} 条任务记录（共 ${tasksTotal} 条）。`, 'muted issue-chain-text'));
    }
  }
  panel.append(tasksBlock);

  const dispatchBlock = element('div', '', 'issue-chain-block');
  const allEvents = detail.dispatch_events || [];
  const eventsTotal = Number(detail.dispatch_events_total ?? allEvents.length);
  const dispatchHeading = detail.dispatch_events_truncated
    ? `Manager 分派记录（显示 ${allEvents.length} / 共 ${eventsTotal} 条）`
    : `Manager 分派记录（${eventsTotal}）`;
  dispatchBlock.append(element('h3', dispatchHeading, 'issue-chain-heading'));
  if (!allEvents.length) {
    dispatchBlock.append(element('p', '暂无 Manager 分派决策记录。', 'muted issue-chain-text'));
  } else {
    const list = element('div', '', 'issue-chain-list');
    const renderEventItem = ev => {
      const row = element('div', '', 'issue-chain-item');
      const meta = element('div', '', 'issue-chain-meta');
      const [decLabel, decTone] = ev.state === 'filtered'
        ? ['已过滤', '']
        : (dispatchDecisionMeta[ev.decision] || [ev.state === 'pending' || ev.state === 'dispatching' ? '等待分派' : (ev.decision || ev.state), '']);
      meta.append(badge(decLabel, decTone), element('span', ev.summary || ev.type, 'issue-chain-ev-title'));
      if (ev.decided_at || ev.created_at) meta.append(element('span', timestamp(ev.decided_at || ev.created_at) || '', 'muted issue-chain-time'));
      row.append(meta);
      if (ev.reason) row.append(element('p', ev.reason, 'muted issue-chain-text'));
      return row;
    };
    const initialCount = 8;
    for (const ev of allEvents.slice(0, initialCount)) list.append(renderEventItem(ev));
    dispatchBlock.append(list);
    if (allEvents.length > initialCount) {
      const rest = allEvents.slice(initialCount);
      const moreBtn = button(`展开其余 ${rest.length} 条分派记录`, () => {
        for (const ev of rest) list.append(renderEventItem(ev));
        moreBtn.remove();
      }, 'btn-text linkish issue-chain-link');
      dispatchBlock.append(moreBtn);
    }
    if (detail.dispatch_events_truncated) {
      dispatchBlock.append(element('p', `仅展示最近 ${allEvents.length} 条分派记录（共 ${eventsTotal} 条）。`, 'muted issue-chain-text'));
    }
  }
  panel.append(dispatchBlock);
  return panel;
}

function renderWorkbenchIssueRow(item, { expanded, detail, loading, err, onToggle }) {
  const row = element('article', '', 'workbench-issue-row' + (expanded ? ' is-expanded' : ''));
  row.dataset.issueNumber = String(item.number);
  row.dataset.issueStatus = item.status;

  // Col 1: Issue number, title, GitHub link
  const infoCol = element('div', '', 'issue-col issue-col-info');
  const headLine = element('div', '', 'issue-title-line');
  const numSpan = element('strong', `#${item.number}`, 'issue-num-tag');
  const titleSpan = element('span', item.title || `Issue #${item.number}`, 'issue-title-text');
  titleSpan.title = item.title || `Issue #${item.number}`;
  headLine.append(numSpan, titleSpan);
  if (item.url) {
    const gh = link(item.url, '↗', 'issue-gh-link');
    gh.setAttribute('aria-label', `在 GitHub 打开 Issue #${item.number}`);
    gh.title = '在 GitHub 打开';
    headLine.append(gh);
  }
  infoCol.append(headLine);
  const sub = element('div', '', 'issue-row-sub');
  if (item.github_state === 'closed') sub.append(badge('已关闭', ''));
  if (item.pr) {
    const prText = `→ PR #${item.pr.number}`;
    const prNode = item.pr.url ? link(item.pr.url, prText, 'issue-pr-link') : element('span', prText, 'issue-pr-link');
    sub.append(prNode);
    if (item.pr.checks && item.pr.checks.total > 0) {
      const c = item.pr.checks;
      const cls = c.failed > 0 ? 'check-pill-fail' : c.running > 0 ? 'check-pill-running' : 'check-pill-pass';
      const txt = c.failed > 0 ? `CI ${c.failed} 失败` : c.running > 0 ? 'CI 运行中' : `CI ${c.passed}/${c.total} ✓`;
      sub.append(element('span', txt, `task-check-pill ${cls}`));
    }
  }
  if (sub.childElementCount) infoCol.append(sub);

  // Col 2: Auto-development status badge
  const statusCol = element('div', '', 'issue-col issue-col-status');
  const [stLabel, stTone] = issueStatusMeta[item.status] || [item.status, ''];
  statusCol.append(badge(stLabel, stTone));

  // Col 3: Outcome or reason why not developed + next step
  const reasonCol = element('div', '', 'issue-col issue-col-reason');
  reasonCol.append(element('p', item.reason || '—', 'issue-reason-text'));
  if (item.next_step) reasonCol.append(element('p', `下一步：${item.next_step}`, 'muted issue-next-step'));

  // Col 4: Activity time & toggle detail chain
  const actionCol = element('div', '', 'issue-col issue-col-actions');
  const actIso = item.last_activity || '';
  const rel = typeof waitedFor === 'function' ? waitedFor(actIso) : null;
  const fullTime = timestamp(actIso) || '—';
  const timeSpan = element('span', rel ? `${rel}前` : fullTime, 'muted task-updated-text');
  if (actIso) timeSpan.dataset.updatedAt = actIso;
  timeSpan.title = fullTime;
  const toggleBtn = button(expanded ? '收起链路' : '查看链路', () => onToggle(item.number), 'quiet issue-chain-toggle');
  toggleBtn.setAttribute('aria-expanded', String(!!expanded));
  toggleBtn.setAttribute('aria-label', `${expanded ? '收起' : '查看'} Issue #${item.number} 的处理链路`);
  toggleBtn.dataset.issueToggle = String(item.number);
  actionCol.append(timeSpan, toggleBtn);

  row.append(infoCol, statusCol, reasonCol, actionCol);

  if (expanded) {
    if (loading) {
      const box = element('div', '', 'issue-chain-panel');
      box.append(element('p', '正在读取该 Issue 的决策与任务链路…', 'muted'));
      row.append(box);
    } else if (err) {
      const box = element('div', '', 'issue-chain-panel');
      const alertP = element('p', `链路读取失败：${readErrorText(err)}`, 'view-error');
      alertP.setAttribute('role', 'alert');
      box.append(alertP);
      row.append(box);
    } else if (detail) {
      row.append(renderIssueChainPanel(detail, item.repository_id, item.number));
    }
  }
  return row;
}

function workspaceOverview() {
  const parsed = parseWorkbenchRoute(current.item);
  if (!parsed) return [pageNotFoundState(current.id)];

  const id = current.id, owner = me.id, routeKey = location.hash;
  const { view: viewMode, group, offset } = parsed;
  const size = 10;
  const issueSize = 20;
  const taskAddress = (key, next = 0) => key === 'all' && !next
    ? `#/projects/${id}/overview/tasks`
    : `#/projects/${id}/overview/${key}${next ? '.' + next : ''}`;
  const issueAddress = (key, next = 0) => key === 'all' && !next
    ? `#/projects/${id}/overview/issues`
    : `#/projects/${id}/overview/issues.${key}${next ? '.' + next : ''}`;

  const root = element('section', '', 'workspace-overview');
  const alive = () => root.isConnected && me?.id === owner && current?.id === id && current.section === 'overview' && location.hash === routeKey;

  // View tabs stay with live capacity and actions in this row.
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

  const issueTab = element('a', '', 'workbench-tab');
  issueTab.href = `#/projects/${id}/overview/issues`;
  issueTab.dataset.workbenchView = 'issues';
  const issueTotalBadge = element('span', '—', 'workbench-tab-count');
  issueTab.append(element('span', 'Issue 进展'), issueTotalBadge);
  if (viewMode === 'issues') issueTab.setAttribute('aria-current', 'page');

  viewTabs.append(roleTab, taskTab, issueTab);

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

  // Issue Auto-Development Progress Section (#1215)
  const issueSection = element('section', '', 'workbench-issue-section');
  issueSection.hidden = viewMode !== 'issues';
  issueSection.append(element('h2', 'Issue 进展', 'sr-only'));
  const issuePills = element('nav', '', 'workspace-metrics workbench-filter-pills');
  issuePills.setAttribute('aria-label', 'Issue 自动开发状态范围');
  const issueCounts = new Map();
  const inNeedsHumanGroup = ['needs_human', 'needs_information', 'human_decision_required', 'blocked'].includes(group);
  for (const [key, caption] of workspaceIssueGroups) {
    const a = element('a', '', 'workbench-filter-pill');
    a.href = issueAddress(key, 0);
    a.dataset.issueGroup = key;
    if (viewMode === 'issues' && (key === group || (key === 'needs_human' && inNeedsHumanGroup))) a.setAttribute('aria-current', 'page');
    const count = element('strong', '—');
    a.append(element('span', caption), count);
    issueCounts.set(key, count);
    issuePills.append(a);
  }

  const issueSubPills = element('nav', '', 'workbench-issue-subpills');
  issueSubPills.setAttribute('aria-label', '不可开发原因细分');
  issueSubPills.hidden = !(viewMode === 'issues' && inNeedsHumanGroup);
  for (const [key, caption] of workspaceIssueSubGroups) {
    const a = element('a', '', 'workbench-filter-pill workbench-sub-pill');
    a.href = issueAddress(key, 0);
    a.dataset.issueGroup = key;
    if (viewMode === 'issues' && key === group) a.setAttribute('aria-current', 'page');
    const count = element('strong', '—');
    a.append(element('span', caption), count);
    issueCounts.set(key, count);
    issueSubPills.append(a);
  }

  let issueSearchQuery = '';
  let issueIncludeClosed = false;
  let issueSearchTimer = null;
  const issueSearchInput = element('input', '', 'workbench-task-search');
  issueSearchInput.type = 'search';
  issueSearchInput.placeholder = '搜索 Issue 编号或标题…';
  issueSearchInput.setAttribute('aria-label', '搜索 Issue');
  issueSearchInput.addEventListener('input', () => {
    clearTimeout(issueSearchTimer);
    issueSearchTimer = setTimeout(() => {
      issueSearchQuery = issueSearchInput.value.trim();
      issueSignature = '';
      void loadIssues();
    }, 180);
  });

  const closedLabel = element('label', '', 'workbench-issue-closed-check');
  const closedCheck = document.createElement('input');
  closedCheck.type = 'checkbox';
  closedCheck.checked = false;
  closedCheck.addEventListener('change', () => {
    issueIncludeClosed = closedCheck.checked;
    issueSignature = '';
    void loadIssues();
  });
  closedLabel.append(closedCheck, document.createTextNode('含已关闭'));

  const issueControls = element('div', '', 'workbench-issue-controls');
  issueControls.append(issueSearchInput, closedLabel);

  const issueToolbar = element('div', '', 'workbench-task-toolbar');
  issueToolbar.append(issuePills, issueControls);

  const issueStatus = note('正在读取 Issue 自动开发进展…');
  issueStatus.classList.add('workspace-issue-status');
  issueStatus.setAttribute('role', 'status');
  const issueHead = element('div', '', 'workbench-issue-head');
  issueHead.append(
    element('span', 'Issue'),
    element('span', '自动开发状态'),
    element('span', '结果与原因'),
    element('span', '最近活动 / 链路'),
  );
  const issueRows = element('div', '', 'workspace-issue-rows');
  const issuePaging = element('nav', '', 'console-inbox-paging');
  issuePaging.setAttribute('aria-label', 'Issue 进展分页');
  issueSection.append(issueToolbar, issueSubPills, issueStatus, issueHead, issueRows, issuePaging);

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

  root.append(roleSection, taskSection, issueSection, footer);

  let pending = false, lastRoles = null, lastTasks = null, lastIssues = null, lastHealth = null;
  let roleSignature = '', signature = '', issueSignature = '', taskReqSeq = 0, issueReqSeq = 0;
  let latestIssuesList = [];
  const expandedIssues = new Set();
  const issueDetails = new Map();
  const issueDetailLoading = new Set();
  const issueDetailErrors = new Map();

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

      const visibleRoles = (board.roles || []).filter(r => r.enabled);
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

  function renderIssueListNodes() {
    const focusedToggle = issueRows.contains(document.activeElement) ? document.activeElement.dataset?.issueToggle : null;
    if (!latestIssuesList.length) {
      issueRows.replaceChildren(consoleState(
        offset ? '本页已没有 Issue' : (issueSearchQuery ? '没有匹配搜索条件的 Issue' : '当前筛选下没有 Issue'),
        offset ? 'Issue 状态可能已变化，可返回上一页。' : '这里只统计系统已接收事件或任务关联过的 Issue；没有条目不代表仓库没有开放 Issue。',
      ));
      return;
    }
    issueRows.replaceChildren(...latestIssuesList.map(item => renderWorkbenchIssueRow(item, {
      expanded: expandedIssues.has(item.number),
      detail: issueDetails.get(item.number) || null,
      loading: issueDetailLoading.has(item.number),
      err: issueDetailErrors.get(item.number) || null,
      onToggle: toggleIssueChain,
    })));
    if (focusedToggle) issueRows.querySelector(`[data-issue-toggle="${CSS.escape(focusedToggle)}"]`)?.focus({ preventScroll: true });
  }

  async function toggleIssueChain(issueNumber) {
    if (expandedIssues.has(issueNumber)) {
      expandedIssues.delete(issueNumber);
      renderIssueListNodes();
      return;
    }
    expandedIssues.add(issueNumber);
    issueDetailLoading.add(issueNumber);
    issueDetailErrors.delete(issueNumber);
    renderIssueListNodes();
    try {
      const detail = await api(`/api/board/issues/${encodeURIComponent(id)}/${issueNumber}`);
      if (!alive()) return;
      issueDetails.set(issueNumber, detail);
    } catch (err) {
      if (!alive() || revoke(err)) return;
      issueDetailErrors.set(issueNumber, err);
    } finally {
      issueDetailLoading.delete(issueNumber);
      if (alive() && viewMode === 'issues') renderIssueListNodes();
    }
  }

  async function loadIssues() {
    const req = ++issueReqSeq;
    if (viewMode === 'issues') issueRows.setAttribute('aria-busy', 'true');
    try {
      const effectiveOffset = (issueSearchQuery || issueIncludeClosed) ? 0 : offset;
      const params = new URLSearchParams({
        repository_id: id,
        status: viewMode === 'issues' ? group : 'all',
        limit: viewMode === 'issues' ? String(issueSize) : '1',
        offset: viewMode === 'issues' ? String(effectiveOffset) : '0',
      });
      if (viewMode === 'issues' && issueIncludeClosed) params.set('include_closed', '1');
      if (viewMode === 'issues' && issueSearchQuery) params.set('q', issueSearchQuery);
      const data = await api('/api/board/issues?' + params);
      if (!alive() || req !== issueReqSeq) return;
      lastIssues = data.sampled_at;
      if (!issueSearchQuery && !issueIncludeClosed) issueTotalBadge.textContent = String(data.counts?.all ?? '—');
      for (const [key, count] of issueCounts) count.textContent = String(data.counts?.[key] ?? 0);
      if (viewMode !== 'issues') return;

      issueStatus.classList.remove('view-error');
      issueStatus.setAttribute('role', 'status');
      const total = data.total ?? 0;
      const shown = data.issues?.length ? `显示 ${effectiveOffset + 1}–${effectiveOffset + data.issues.length} 项 · ` : '';
      issueStatus.textContent = `${total} 个 Issue · 已开 PR ${data.counts?.pr_opened ?? 0} · 需人工 ${data.counts?.needs_human ?? 0} · ${shown}更新于 ${timestamp(lastIssues)}`;

      const nextSig = JSON.stringify(data.issues || []);
      if (issueSignature !== nextSig || !issueRows.childElementCount) {
        issueSignature = nextSig;
        latestIssuesList = data.issues || [];
        renderIssueListNodes();
      } else {
        refreshWorkbenchTimes(issueRows);
      }

      const hasNext = Boolean(data.has_more), pageKey = `issues:${group}:${effectiveOffset}:${hasNext}`;
      if (issuePaging.dataset.pageKey !== pageKey) {
        issuePaging.dataset.pageKey = pageKey; issuePaging.replaceChildren();
        if (effectiveOffset) issuePaging.append(consoleLink(issueAddress(group, Math.max(0, effectiveOffset - issueSize)), '上一页'));
        if (hasNext && !issueSearchQuery && !issueIncludeClosed) issuePaging.append(consoleLink(issueAddress(group, effectiveOffset + issueSize), '下一页'));
      }
    } catch (err) {
      if (!alive() || req !== issueReqSeq || revoke(err)) return;
      expired(issueStatus, err, lastIssues);
    } finally { if (req === issueReqSeq) issueRows.removeAttribute('aria-busy'); }
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
    try { await Promise.all([loadRoleBoard(), tasks(), loadIssues(), environment()]); }
    finally { pending = false; refresh.disabled = false; }
  }

  const poll = async () => { if (!alive()) return; if (!document.hidden) await update(); if (alive()) setTimeout(poll, 5000); };
  queueMicrotask(() => void poll());
  return [root];
}
