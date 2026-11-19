const stepToolLabels = {
  read_file: '读取文件',
  write_file: '写入文件',
  run_command: '执行命令',
  finish_review: '提交检视结论',
  create_pull_request: '创建 PR',
  submit_role_result: '提交角色结论',
  nominate_delivery: '提名候选进入 QA 验收',
  finish_coordination: '结束本轮主控编排',
  delegate_role: '委派角色执行',
  delegate_roles: '并行委派多角色检视',
  plan_task: '规划阶段策略',
  read_stage_schedule: '读取阶段进度',
  read_task_record: '读取任务记录',
  read_task_history: '读取历史证据',
  set_task_priority: '调整任务优先级',
  relate_task: '关联相关任务',
  search_project_memory: '检索项目知识库',
  read_project_memory: '读取项目知识条目',
  acceptance: '提交独立验收结论',
};

function setAllTaskFolds(expand) {
  const foldState = typeof ensureTaskFoldState === 'function' ? ensureTaskFoldState(openTaskId) : null;
  const roleList = $('role-runs-list');
  if (roleList && !roleList.hidden) {
    for (const outer of roleList.querySelectorAll('details.role-run-fold')) {
      outer.open = expand;
      if (foldState && outer.dataset.runId) foldState.outer.set(outer.dataset.runId, expand);
      if (!expand) {
        for (const inner of outer.querySelectorAll('details.step-fold')) {
          inner.open = false;
          if (foldState && inner.dataset.stepKey) foldState.inner.set(inner.dataset.stepKey, false);
        }
      }
    }
  }
  const timeline = $('timeline');
  if (timeline && !timeline.hidden) {
    for (const d of timeline.querySelectorAll('details')) d.open = expand;
  }
}

function isDocumentScroller(node) {
  return typeof document !== 'undefined' && (node === document.scrollingElement || node === document.documentElement || node === document.body);
}

function renderTimeline(task, logs, roleRuns = []) {
  const roleList = $('role-runs-list');
  const list = $('timeline');
  const live = liveText(task);
  $('timeline-live').hidden = !live;
  $('timeline-live').textContent = live || '';

  if (Array.isArray(roleRuns) && roleRuns.length > 0 && roleList) {
    list.hidden = true;
    roleList.hidden = false;
    renderRoleRunTimeline(task, logs, roleRuns, roleList);
    return;
  }

  if (roleList) roleList.hidden = true;
  list.hidden = false;
  const cmdBox = $('timeline-command'), layout = $('task-layout');
  if (cmdBox && layout && cmdBox.parentElement !== layout) {
    if (typeof layout.insertBefore === 'function' && $('timeline-live')?.parentElement === layout) layout.insertBefore(cmdBox, $('timeline-live'));
    else layout.append(cmdBox);
  }

  let modelStep = 0;
  const box = scroller(list.parentElement), first = !list.childElementCount, atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (let log of logs) {
    let value; try { value = JSON.parse(log.content); } catch {}
    if (value?.type === 'model') {
      modelStep++;
      if (!Number.isSafeInteger(value.step) && !taskLogState?.page?.has_older) log = { ...log, content: JSON.stringify({ ...value, step: modelStep }) };
    }
    if (renderedLogs.has(log.id)) continue;
    renderedLogs.add(log.id);
    if (value?.type === 'phase' && value.phase === 'prepare' || ['snapshot_progress', 'snapshot_skipped', 'snapshot_git', 'snapshot'].includes(value?.type)) {
      appendSnapshotProgress(list, log, value); continue;
    }
    if (snapshotProgress) {
      if (value?.type === 'prepared' || value?.type === 'phase' && value.phase !== 'prepare') {
        snapshotProgress.prepared = true; setSnapshotStatus(snapshotProgress, 'succeeded');
      } else if (value?.type === 'fault' && !snapshotProgress.prepared) setSnapshotStatus(snapshotProgress, value.state);
    }
    list.append(step(log));
  }
  if (snapshotProgress) setSnapshotStatus(snapshotProgress, snapshotProgress.prepared ? 'succeeded' : task.status);
  if (isDocumentScroller(box) ? (!first && atBottom && box.scrollTop > 0) : (first ? !!live : atBottom)) box.scrollTop = box.scrollHeight;
}

function assignLogsToRuns(logs, roleRuns) {
  const byRun = new Map(roleRuns.map(r => [r.run_id, []]));
  const spans = roleRuns.map(r => ({
    id: r.run_id,
    role: r.role,
    start: Date.parse(r.started_at || '') || 0,
    end: r.ended_at ? (Date.parse(r.ended_at) || Infinity) : Infinity,
  }));
  for (const log of logs) {
    if (log.run_id && byRun.has(log.run_id)) {
      byRun.get(log.run_id).push(log);
      continue;
    }
    const at = Date.parse(log.created_at || '');
    let chosen = null;
    if (!Number.isNaN(at)) {
      const matching = spans.filter(s => at >= s.start - 500 && at <= s.end + 500);
      chosen = (matching.find(s => s.role !== 'manager') || matching.at(-1))?.id || null;
      if (!chosen) chosen = at < spans[0].start ? spans[0].id : spans.at(-1).id;
    } else {
      chosen = spans.at(-1)?.id || null;
    }
    if (chosen && byRun.has(chosen)) byRun.get(chosen).push(log);
  }
  return byRun;
}

function summarizeLogStep(log, index) {
  let value; try { value = JSON.parse(log.content); } catch { value = { type: 'raw' }; }
  const args = value.arguments || {}, result = value.result || {};
  const timeText = log.created_at ? timestamp(log.created_at).slice(11, 19) : '';
  let caption = '', badgeNode = null, bodyNodes = [], defaultOpen = false;

  if (value.type === 'tool' && value.name === 'run_command' || value.type === 'command') {
    const cmd = value.type === 'command' ? value : { command: args.command, ...result };
    caption = `执行命令 ${clipText(cmd.command || '', 72)}`;
    badgeNode = exitBadge(cmd);
    bodyNodes.push(element('pre', '$ ' + (cmd.command || ''), 'command'));
    if (cmd.output) bodyNodes.push(element('pre', String(cmd.output), 'output'));
  } else if (value.type === 'tool' && value.name === 'read_file') {
    const bytes = result.error || ((result.bytes ?? new TextEncoder().encode(result.content || '').length) + ' 字节');
    caption = `读取文件 ${args.path || ''}`;
    badgeNode = element('span', String(bytes), 'step-fold-stat');
    if (result.content) bodyNodes.push(element('pre', String(result.content), 'output'));
    else bodyNodes.push(element('p', `${args.path || ''} · ${bytes}`, 'muted'));
  } else if (value.type === 'tool' && value.name === 'write_file') {
    const bytes = (args.bytes ?? new TextEncoder().encode(args.content || '').length) + ' 字节';
    caption = `写入文件 ${args.path || ''}`;
    badgeNode = element('span', bytes, 'step-fold-stat');
    bodyNodes.push(element('p', `写入路径：${args.path || '未知'}（${bytes}）`, 'muted'));
  } else if (value.type === 'tool_start') {
    const act = stepToolLabels[value.name] || value.name;
    caption = `${act} ${clipText(value.path || value.command || '', 64)}`.trim();
    bodyNodes.push(element('p', `开始调用工具 ${value.name}：${value.path || value.command || value.name}`, 'muted'));
  } else if (value.type === 'model') {
    const snippet = value.content ? clipText(String(value.content).replace(/\s+/g, ' ').trim(), 68) : '';
    const callCount = Array.isArray(value.tool_calls) ? value.tool_calls.length : 0;
    caption = snippet ? `模型输出：${snippet}` : `模型推理（发起 ${callCount} 项工具调用）`;
    if (callCount) badgeNode = element('span', `${callCount} 项调用`, 'step-fold-stat');
    if (value.content) bodyNodes.push(element('p', value.content, 'say'));
    if (callCount) {
      const calls = element('div', '', 'calls');
      for (const call of value.tool_calls) calls.append(element('span', toolCaption(call), 'call'));
      bodyNodes.push(calls);
    }
  } else if (value.type === 'fault') {
    defaultOpen = true;
    const cause = log.cause;
    caption = cause ? `暂停或异常 · ${cause.label}` : `异常 · ${taskErrorText(value.code)}`;
    badgeNode = state(value.state);
    if (value.detail) bodyNodes.push(element('p', value.detail, 'say'));
    if (cause) bodyNodes.push(element('p', '处理：' + cause.action, 'fault-action'));
  } else if (value.type === 'phase') {
    const phaseLabel = { prepare: '准备工作区', model: '启动模型与角色执行', validate: '运行仓库测试', publish: '发布到 GitHub' }[value.phase] || '阶段切换';
    caption = `${phaseLabel}${value.detail ? ' · ' + clipText(value.detail, 56) : ''}`;
    if (value.detail) bodyNodes.push(element('p', value.detail, 'muted'));
  } else if (value.type === 'prepared') {
    caption = `工作区就绪 · 固定基线 ${String(value.sha || '').slice(0, 12)}`;
    for (const line of value.coverage || []) bodyNodes.push(element('p', line, 'muted'));
  } else if (value.type === 'publication_decision') {
    // #1100: why a review publishes now, and which updates its next round answers.
    caption = decisionCaption(value);
    badgeNode = badge('发布决定', 'info');
    if (value.detail) bodyNodes.push(element('p', value.detail, 'say'));
  } else if (value.type === 'published') {
    caption = '已发布结果至 GitHub';
    badgeNode = badge('已发布', 'success');
    bodyNodes.push(step(log));
  } else {
    caption = value.type === 'tool' ? `${stepToolLabels[value.name] || ('工具 ' + value.name)}` : `运行记录 (${value.type || 'log'})`;
    bodyNodes.push(element('pre', typeof log.content === 'string' ? log.content : JSON.stringify(log.content, null, 2), 'output'));
  }

  return { key: `log:${log.id}`, index, caption, timeText, badgeNode, bodyNodes, defaultOpen, sourceRef: null, bodyOmitted: false };
}

function summarizeHistoryStep(item, index) {
  const label = stepToolLabels[item.tool] || (item.kind === 'model' ? '模型消息' : item.tool || '执行步骤');
  const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : null;
  let argHint = '';
  if (args) {
    if (typeof args.role === 'string') argHint = `${args.role}${args.purpose ? ' · ' + clipText(args.purpose, 48) : ''}`;
    else if (Array.isArray(args.assignments)) argHint = args.assignments.map(a => a?.role).filter(Boolean).join(' + ');
    else if (typeof args.path === 'string') argHint = args.path;
    else if (typeof args.command === 'string') argHint = clipText(args.command, 60);
    else if (typeof args.ref === 'string') argHint = args.ref;
    else if (typeof args.result_ref === 'string') argHint = args.result_ref;
  } else if (item.kind === 'model' && typeof item.output === 'string') {
    argHint = clipText(item.output.replace(/\s+/g, ' ').trim(), 60);
  }
  const caption = argHint ? `${label}：${argHint}` : label;
  const timeText = item.created_at ? timestamp(item.created_at).slice(11, 19) : '';
  const tone = item.status === 'error' ? 'danger' : item.status === 'returned' ? 'warning' : item.status === 'running' ? 'info' : 'success';
  const statusText = item.status === 'error' ? '异常' : item.status === 'returned' ? '发现问题' : item.status === 'running' ? '执行中' : '完成';
  const badgeNode = badge(statusText, tone);

  const bodyNodes = [];
  if (args && Object.keys(args).length) {
    bodyNodes.push(element('p', '调用参数', 'muted'), element('pre', JSON.stringify(args, null, 2), 'output'));
  }
  if (item.output !== null && item.output !== undefined) {
    const outText = typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2);
    bodyNodes.push(element('p', '返回结果', 'muted'), element('pre', outText, 'output'));
  }
  return {
    key: item.id,
    index,
    caption,
    timeText,
    badgeNode,
    bodyNodes,
    defaultOpen: false,
    sourceRef: item.source_ref || null,
    bodyOmitted: !!item.body_omitted,
  };
}

function createInnerStepFold(task, spec, foldState) {
  const details = element('details', '', 'step-fold step');
  details.dataset.stepKey = spec.key;
  const isOpen = foldState.inner.has(spec.key) ? foldState.inner.get(spec.key) : spec.defaultOpen;
  details.open = !!isOpen;

  const summary = element('summary', '', 'step-fold-summary');
  const left = element('span', '', 'step-fold-title');
  left.append(element('span', `${spec.index}.`, 'step-fold-num'), element('span', spec.caption, 'step-fold-caption'));
  const right = element('span', '', 'step-fold-meta');
  if (spec.badgeNode) right.append(spec.badgeNode);
  if (spec.timeText) right.append(element('time', spec.timeText));
  summary.append(left, right);

  const body = element('div', '', 'step-fold-body');
  if (spec.bodyNodes.length) {
    body.append(...spec.bodyNodes);
  } else if (spec.bodyOmitted && spec.sourceRef) {
    body.append(element('p', '展开后按当前授权读取原始记录…', 'muted'));
  } else {
    body.append(element('p', '该步骤无额外正文输出。', 'muted'));
  }

  let loadedSource = false;
  details.addEventListener('toggle', () => {
    foldState.inner.set(spec.key, details.open);
    if (details.open && spec.bodyOmitted && spec.sourceRef && !loadedSource) {
      loadedSource = true;
      api(`/api/tasks/${encodeURIComponent(task.id)}/source?ref=${encodeURIComponent(spec.sourceRef)}`)
        .then(res => {
          const data = res?.source?.data ?? res?.source ?? res;
          body.replaceChildren(element('pre', JSON.stringify(data, null, 2), 'output'));
        })
        .catch(err => {
          body.replaceChildren(element('p', '无法读取步骤原始正文：' + readErrorText(err), 'muted'));
        });
    }
  });

  details.append(summary, body);
  return details;
}

function roleVerdictTone(stateName) {
  if (stateName === 'running') return 'info';
  if (stateName === 'completed' || stateName === 'delegated') return 'success';
  if (stateName === 'returned' || stateName === 'paused') return 'warning';
  if (stateName === 'failed') return 'danger';
  return '';
}

function renderRoleRunTimeline(task, logs, roleRuns, container) {
  const cmdBox = $('timeline-command');
  const foldState = ensureTaskFoldState(task.id);
  const logsByRun = assignLogsToRuns(logs, roleRuns);
  const existingNodes = new Map([...container.children].filter(el => el.dataset?.runId).map(el => [el.dataset.runId, el]));
  const nextChildren = [];
  let activeBody = null;

  for (const block of roleRuns) {
    const runId = block.run_id;
    const runLogs = logsByRun.get(runId) || [];

    // Filter out raw snapshot flood lines into a single concise snapshot summary item
    const filteredLogs = [];
    let lastSnap = null;
    for (const l of runLogs) {
      let v; try { v = JSON.parse(l.content); } catch {}
      if (['snapshot_progress', 'snapshot_skipped', 'snapshot_git', 'snapshot'].includes(v?.type)) {
        lastSnap = l;
      } else {
        if (lastSnap) { filteredLogs.push(lastSnap); lastSnap = null; }
        filteredLogs.push(l);
      }
    }
    if (lastSnap) filteredLogs.push(lastSnap);

    const hasRichLogs = filteredLogs.some(l => {
      try { const v = JSON.parse(l.content); return ['tool', 'command', 'model'].includes(v?.type); } catch { return false; }
    });
    const historySteps = Array.isArray(block.history_steps) ? block.history_steps : [];

    const stepSpecs = [];
    if (hasRichLogs) {
      filteredLogs.forEach((l, idx) => stepSpecs.push(summarizeLogStep(l, idx + 1)));
      // Append final role_result / acceptance step from history if not already in logs
      for (const hs of historySteps.filter(s => ['role_result', 'nomination', 'acceptance'].includes(s.kind))) {
        stepSpecs.push(summarizeHistoryStep(hs, stepSpecs.length + 1));
      }
    } else {
      // Combine lifecycle/fault logs (if any) + normalized history tool/protocol steps
      for (const hs of historySteps) stepSpecs.push(summarizeHistoryStep(hs, stepSpecs.length + 1));
      for (const l of filteredLogs) stepSpecs.push(summarizeLogStep(l, stepSpecs.length + 1));
    }

    const totalSteps = stepSpecs.length;
    const modelMeta = [block.harness ? harnessName(block.harness) : null, block.model || null].filter(Boolean).join(' · ');
    const durText = typeof formatDurationMs === 'function' && block.duration_ms != null ? formatDurationMs(block.duration_ms) : '';
    const blockSig = JSON.stringify([block.state, block.verdict_badge, block.summary, modelMeta, totalSteps, durText, stepSpecs.map(s => [s.key, s.caption])]);

    let outer = existingNodes.get(runId);
    const wantedOpen = foldState.outer.has(runId) ? foldState.outer.get(runId) : !!block.default_open;

    if (!outer) {
      outer = element('details', '', `role-run-fold role-run-${block.state}`);
      outer.dataset.runId = runId;
      outer.id = 'role-run-' + runId;
      outer.open = wantedOpen;
      outer.addEventListener('toggle', () => { foldState.outer.set(runId, outer.open); });
    } else {
      outer.className = `role-run-fold role-run-${block.state}`;
      outer.open = wantedOpen;
    }

    if (outer.dataset.signature !== blockSig) {
      outer.dataset.signature = blockSig;
      const summary = element('summary', '', 'role-run-summary');
      const left = element('div', '', 'role-run-title-row');
      left.append(
        element('strong', `${block.index_label}. ${block.name}`, 'role-run-name'),
        badge(block.verdict_badge, roleVerdictTone(block.state)),
      );
      if (block.summary) left.append(element('span', block.summary, 'role-run-brief'));

      const right = element('div', '', 'role-run-meta');
      if (modelMeta) right.append(element('span', modelMeta, 'role-run-model'));
      right.append(element('span', `${totalSteps} 步`, 'role-run-count'));
      if (durText) right.append(element('span', durText, 'role-run-duration'));
      summary.append(left, right);

      const body = element('div', '', 'role-run-body');
      if (block.summary || block.purpose || (Array.isArray(block.findings) && block.findings.length)) {
        const banner = element('div', '', 'role-run-conclusion');
        if (block.purpose) banner.append(element('p', '委派目标：' + block.purpose, 'muted role-run-purpose'));
        if (block.summary) {
          const line = element('p', '', 'role-run-verdict-line');
          line.append(element('strong', '本棒结论：'), element('span', block.summary));
          banner.append(line);
        }
        if (Array.isArray(block.findings) && block.findings.length) {
          const ul = element('ul', '', 'role-run-findings');
          for (const f of block.findings) {
            const text = typeof f === 'string' ? f : (f?.description || JSON.stringify(f));
            ul.append(element('li', text));
          }
          banner.append(ul);
        }
        body.append(banner);
      }

      if (stepSpecs.length) {
        const stepToolbar = element('div', '', 'role-step-toolbar');
        stepToolbar.append(
          element('span', `执行步骤（共 ${stepSpecs.length} 步，点击单步展开输出详情）`, 'muted'),
          button('展开本棒步骤', () => {
            for (const el of body.querySelectorAll('details.step-fold')) {
              el.open = true;
              if (el.dataset.stepKey) foldState.inner.set(el.dataset.stepKey, true);
            }
          }, 'quiet btn-xs'),
          button('折叠本棒步骤', () => {
            for (const el of body.querySelectorAll('details.step-fold')) {
              el.open = false;
              if (el.dataset.stepKey) foldState.inner.set(el.dataset.stepKey, false);
            }
          }, 'quiet btn-xs'),
        );
        const stepList = element('ol', '', 'role-step-list');
        for (const spec of stepSpecs) {
          stepList.append(createInnerStepFold(task, spec, foldState));
        }
        body.append(stepToolbar, stepList);
      } else {
        body.append(element('p', block.state === 'running' ? '该角色已启动，正在等待首个步骤回执…' : '该角色本棒未产生额外步骤明细。', 'muted role-empty-steps'));
      }

      outer.replaceChildren(summary, body);
    }

    if (block.state === 'running') {
      activeBody = outer.querySelector('.role-run-body');
    }
    nextChildren.push(outer);
  }

  if (typeof container.insertBefore === 'function') {
    nextChildren.forEach((node, idx) => {
      if (container.children[idx] !== node) container.insertBefore(node, container.children[idx] || null);
    });
    [...container.children].filter(node => !nextChildren.includes(node)).forEach(node => node.remove());
  } else {
    container.replaceChildren(...nextChildren);
  }

  if (cmdBox) {
    const targetParent = activeBody || $('task-layout');
    if (targetParent && cmdBox.parentElement !== targetParent) {
      if (targetParent === $('task-layout') && typeof targetParent.insertBefore === 'function' && $('timeline-live')?.parentElement === targetParent) {
        targetParent.insertBefore(cmdBox, $('timeline-live'));
      } else {
        targetParent.append(cmdBox);
      }
    }
  }
}

function setSnapshotStatus(progress, status) {
  const waiting = status?.startsWith('waiting_') || status === 'retry_wait' || ['needs_replan', 'needs_help'].includes(status) || status === 'paused';
  progress.status.replaceChildren(waiting ? badge('已暂停', 'warning') : state(status));
}

function snapshotMessage(value) {
  if (value.type !== 'snapshot') return value.detail || ({ snapshot_progress: `已写入 ${value.files} 个文件，${value.bytes} 字节；刚写完 ${value.path}`,
    snapshot_skipped: `已跳过路径 ${value.path}：${value.reason}`, snapshot_git: `正在构建本地 Git 树：${value.tree_sha}` }[value.type] || '正在准备仓库快照…');
  const lines = [`提交 ${value.sha} · 已接收 ${value.files} 个文件，${value.bytes} 字节 · 跳过 ${value.skipped} 项`];
  if (value.source) lines.push(value.source === 'git_cache' ? (value.cache === 'hit' ? '文件来自仓库 Git 缓存，这个提交已缓存，没有访问 GitHub。' : '文件来自仓库 Git 缓存，本次从 GitHub 拉取了这个提交。')
    : value.cache === 'unavailable' ? 'Git 缓存不可用，文件经 GitHub API 逐个读取。' : '文件经 GitHub API 逐个读取。');
  if (value.directory_fallback) lines.push('递归树被截断，已改为逐目录列举。');
  if (value.detail) lines.push(value.detail);
  return lines.join('\n');
}

function appendSnapshotProgress(list, log, value) {
  if (!snapshotProgress || value.type === 'phase' || value.sha && snapshotProgress.sha && value.sha !== snapshotProgress.sha) {
    const item = element('li', '', 'step step-snapshot'), details = element('details', '', 'snapshot-progress'), summary = element('summary', '');
    const head = element('span', '', 'snapshot-heading'), status = element('span', '', 'step-meta'), time = element('time', ''), latest = element('span', '', 'snapshot-latest');
    const output = element('pre', '', 'output snapshot-output'); output.tabIndex = 0; output.setAttribute('aria-label', '仓库快照实时日志');
    details.open = false; head.append(element('strong', '仓库快照进度'), status, time); summary.append(head, latest); details.append(summary, output); item.append(details); list.append(item);
    details.addEventListener('toggle', () => { if (details.open) output.scrollTop = output.scrollHeight; });
    snapshotProgress = { details, status, time, latest, output, prepared: false }; setSnapshotStatus(snapshotProgress, 'running');
  }
  if (value.sha) snapshotProgress.sha = value.sha;
  const { output, latest, time } = snapshotProgress, follow = output.scrollHeight - output.scrollTop - output.clientHeight < 60, message = snapshotMessage(value);
  if (log.created_at) { time.textContent = timestamp(log.created_at).slice(11, 19); time.dateTime = log.created_at; time.title = timestamp(log.created_at); }
  latest.textContent = value.type === 'snapshot' ? `已接收 ${value.files} 个文件 · ${value.bytes} 字节 · 跳过 ${value.skipped} 项`
    : value.type === 'snapshot_progress' && value.files !== undefined ? `已写入 ${value.files} 个文件 · ${value.bytes} 字节`
    : value.type === 'snapshot_git' ? '正在构建本地 Git 树…' : message.split('\n')[0];
  output.append((log.created_at ? '[' + time.textContent + '] ' : '') + message + '\n');
  if (follow) output.scrollTop = output.scrollHeight;
}

function toolCaption(call) {
  let args = {}; try { args = JSON.parse(call.arguments); } catch {}
  return { run_command: '执行命令：' + clipText(args.command, 80), read_file: '读取 ' + (args.path || '文件'), write_file: '写入 ' + (args.path || '文件'),
    finish_review: '提交检视结论', create_pull_request: '创建 PR' }[call.name] || call.name;
}

const shortSha = sha => String(sha || '').slice(0, 7);
function decisionCaption(value) {
  const carried = Array.isArray(value.carried) ? value.carried.length : 0;
  return carried ? `发布检视 · ${carried} 条更新留给下一轮` : '发布检视 · 结果已覆盖收到的更新';
}

function updateCaption(value) {
  if (value.reason === 'pull_request_head_changed') return `新提交：工作区从 ${shortSha(value.previous_head)} 移到 ${shortSha(value.current_head)}`;
  return ({ comment: '的评论', mention: '提到 bot 的评论', issue_edited: '修改了 Issue', pull_request_edited: '修改了 PR', review_submitted: '的检视',
    review_comment: '的行内评论', review_reply: '回复了行内评论', labeled: '加了标签', pushed: `推送了新提交 ${shortSha(value.after)}` })[value.reason] || '的更新';
}

function step(log) {
  let value; try { value = JSON.parse(log.content); } catch { value = { type: 'raw' }; }
  const item = element('li', '', 'step step-' + value.type), head = element('div', '', 'step-head'), title = element('strong', ''), meta = element('span', '', 'step-meta');
  head.append(title, meta); item.append(head);
  if (log.created_at) { const time = element('time', timestamp(log.created_at).slice(11, 19)); time.dateTime = log.created_at; time.title = timestamp(log.created_at); meta.append(time); }
  const add = (...nodes) => item.append(...nodes), args = value.arguments || {}, result = value.result || {};
  if (value.type === 'queued') {
    title.textContent = '任务排队日志'; add(element('p', value.detail));
  } else if (value.type === 'phase') {
    title.textContent = { prepare: '工作区准备日志', model: 'Agent 执行日志', validate: '仓库测试日志', publish: 'GitHub 发布日志' }[value.phase] || '运行阶段日志';
    add(element('p', value.detail));
  } else if (value.type === 'tool_start') {
    title.textContent = '工具开始日志';
    const action = { read_file: '读取文件', write_file: '写入文件', run_command: '执行命令', finish_review: '提交检视结论', create_pull_request: '创建 PR', github_read_token: '申请 GitHub 只读令牌' }[value.name] || value.name;
    add(element('p', `正在${action}：${value.path || value.command || value.name}`));
  } else if (value.type === 'prepared') {
    title.textContent = '准备项目工作区'; add(element('p', `固定提交 ${String(value.sha || '').slice(0, 12)}`));
    for (const line of value.coverage || []) add(element('p', line, 'muted'));
  } else if (value.type === 'model') {
    title.textContent = Number.isSafeInteger(value.step) ? `第 ${value.step} 步 · 模型公开输出` : '模型公开输出';
    if (value.content) add(element('p', value.content, 'say'));
    const calls = element('div', '', 'calls'); for (const call of value.tool_calls || []) calls.append(element('span', toolCaption(call), 'call'));
    if (calls.childElementCount) add(calls);
  } else if (value.type === 'tool' && value.name === 'run_command' || value.type === 'command') {
    const command = value.type === 'command' ? value : { command: args.command, ...result };
    title.textContent = '执行命令'; meta.prepend(exitBadge(command)); add(element('pre', '$ ' + command.command, 'command'));
    if (command.output) add(output(command.output));
  } else if (value.type === 'tool' && value.name === 'read_file') {
    title.textContent = '读取文件'; add(element('p', `${args.path} · ${result.error || (result.bytes ?? new TextEncoder().encode(result.content || '').length) + ' 字节'}`));
    if (result.content) add(collapsible('文件内容', result.content));
  } else if (value.type === 'tool' && value.name === 'write_file') {
    title.textContent = '写入文件'; add(element('p', `${args.path} · ${args.bytes ?? new TextEncoder().encode(args.content || '').length} 字节`));
  } else if (value.type === 'tool' && ['finish_review', 'create_pull_request'].includes(value.name)) {
    title.textContent = value.name === 'finish_review' ? '提交检视结论' : '创建 PR';
    if (args.summary) add(element('p', clipText(args.summary, 240)));
    if (args.test_command) add(element('p', '测试：' + args.test_command, 'muted'));
    add(collapsible('原始 JSON', JSON.stringify({ arguments: args, result }, null, 2)));
  } else if (value.type === 'published') {
    title.textContent = '发布到 GitHub'; const links = element('div', '', 'calls');
    for (const out of value.outputs || []) {
      if (out.labels) out.labels.forEach(name => links.append(element('span', '标签 ' + name, 'call')));
      else if (out.html_url) links.append(link(out.html_url, out.branch ? 'PR · ' + out.branch : out.inline_comments ? `行内检视 · ${out.inline_comments} 条` : /pull\/\d+$/.test(out.html_url) ? 'PR' : '总结评论', 'call call-link'));
    }
    add(links);
  } else if (value.type === 'pr_head_wait') {
    title.textContent = '等待 GitHub 更新 PR head'; add(element('p', '已推送 ' + value.expected_sha), element('p', '当前 PR ' + value.observed_sha + '；自动重读，确认后继续。', 'muted'));
  } else if (value.type === 'completed') { title.textContent = '任务结束'; meta.prepend(state(value.status)); }
  else if (value.type === 'obsolete') { title.textContent = '自动移出待处理'; meta.prepend(state(value.status)); add(element('p', value.detail || '', 'say'), element('p', '原因码 ' + value.code, 'muted')); }
  else if (value.type === 'fault') {
    const empty = value.code === 'repository_has_no_commit' && value.state === 'waiting_configuration';
    if (empty) item.classList.replace('step-fault', 'step-waiting');
    const cause = empty ? null : log.cause;
    title.textContent = empty ? '仓库还没有提交' : cause ? '暂停或失败 · ' + cause.label : '任务暂停或失败'; meta.prepend(empty ? badge('等待首次提交', 'warning') : state(value.state));
    if (!cause) add(element('p', taskErrorText(value.code), 'muted'));
    if (value.detail) add(element('p', value.detail, 'say'));
    if (cause) add(element('p', '处理：' + cause.action, 'fault-action'), element('p', '错误码 ' + value.code, 'muted'));
  } else if (value.type === 'development_waiting') {
    title.textContent = '开发等待';
    add(element('p', value.reason === 'assigned' ? `Issue 已指派给 ${(value.assignees || []).join('、')}，bot 不接手；取消指派后重新加开发标签才会开发。`
      : value.reason === 'app' ? '开发标签是 App 加的，要由人加上才会开发。' : '等有人加上开发标签。', 'muted'));
  // revision_requests and revision_deferred are no longer written (#1104); tasks recorded before that still show them.
  } else if (value.type === 'revision_requests') {
    title.textContent = '修订请求';
    const list = element('ul');
    for (const r of value.requests || []) { const li = element('li'); li.append(`${r.author_type === 'Bot' ? '其他机器人' : '成员'} ${r.author} 的`, link(r.url || '', r.type === 'review' ? '检视' : r.type === 'review_comment' ? '行内评论' : '评论')); list.append(li); }
    add(element('p', '检视采纳了这些修改请求，核对作者后据此修订 PR。', 'muted'), list);
  } else if (value.type === 'revision_deferred') { title.textContent = '修订顺延'; add(element('p', value.detail || '', 'muted')); }
  else if (value.type === 'restart_attempt') { title.textContent = '重新开始一次尝试'; add(element('p', '中断的工作目录保留，新的尝试使用新目录。', 'muted')); }
  else if (value.type === 'dispatch') { title.textContent = value.relation === 'continued' ? 'Manager 续接更新' : 'Manager 新建任务'; add(element('p', value.reason || value.detail || '', 'say')); }
  else if (value.type === 'review_update') {
    title.textContent = '接收更新';
    const what = updateCaption(value), line = element('p', '', 'say');
    line.append(value.actor ? `@${value.actor} ` : '', value.url ? link(value.url, what) : what);
    add(line);
  } else if (value.type === 'workspace_chosen') { title.textContent = '工作区'; meta.prepend(badge(value.decided_by === 'system' ? '系统选择' : '自选', 'info')); add(element('p', value.detail || '', 'say')); }
  else if (value.type === 'head_moved') { title.textContent = 'PR 有新提交'; add(element('p', value.detail || `${shortSha(value.previous_head)} → ${shortSha(value.current_head)}`, 'say')); }
  else if (value.type === 'publication_decision') { title.textContent = decisionCaption(value); meta.prepend(badge('发布决定', 'info')); add(element('p', value.detail || '', 'say')); }
  else if (value.type === 'continued') { title.textContent = `第 ${value.round} 轮`; meta.prepend(badge('续接', 'info')); add(element('p', value.detail || '', 'say')); }
  else if (value.type === 'runtime_fault') { title.textContent = '运行故障'; add(element('p', value.message || '', 'muted')); if (value.where) add(collapsible('出错位置', value.where)); }
  else if (value.type === 'agent_failure') { title.textContent = '执行进程失败'; add(element('p', value.detail || '执行进程没有给出原因。', 'say')); if (value.error) add(element('p', '错误码 ' + value.error, 'muted')); }
  else { title.textContent = value.type === 'tool' ? '工具 ' + value.name : '记录'; add(element('pre', log.content, 'output')); }
  return item;
}
