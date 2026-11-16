function formatDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60), secs = totalSec % 60;
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60), remMins = mins % 60;
  return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
}

function taskElapsedLabel(task) {
  if (!task?.created_at) return '';
  const start = Date.parse(task.created_at);
  if (!Number.isFinite(start)) return '';
  const end = terminalStates.includes(task.status) && task.updated_at ? Date.parse(task.updated_at) : Date.now();
  if (!Number.isFinite(end) || end < start) return '';
  return (terminalStates.includes(task.status) ? '耗时 ' : '已运行 ') + formatDurationMs(end - start);
}

function renderFlowNode(node, options = {}) {
  const stateClass = 'flow-node-' + (node.state || 'pending');
  const interactive = !options.compact && node.run_id && typeof options.onSelectRun === 'function';
  const box = interactive
    ? button('', () => options.onSelectRun(node.run_id), `quiet flow-node ${stateClass} flow-node-clickable`)
    : element('span', '', `flow-node ${stateClass}`);
  if (node.run_id) box.dataset.flowRunId = node.run_id;
  box.dataset.flowRole = node.role || '';
  box.dataset.flowState = node.state || '';
  if (node.summary) box.title = `${node.full_name || node.name}：${node.summary}`;

  if (node.state === 'running') {
    const dot = element('span', '', 'flow-pulse-dot');
    dot.setAttribute('aria-hidden', 'true');
    box.append(dot);
  } else if (node.state === 'paused') {
    const icon = element('span', '◷', 'flow-node-mark');
    icon.setAttribute('aria-hidden', 'true');
    box.append(icon);
  } else if (node.state === 'queued') {
    const icon = element('span', '…', 'flow-node-mark');
    icon.setAttribute('aria-hidden', 'true');
    box.append(icon);
  }

  const labelText = (!options.compact && node.index_label ? `${node.index_label}. ` : '') + (node.name || node.role);
  box.append(element('span', labelText, 'flow-node-name'));

  if (node.badge) {
    box.append(element('span', node.badge, 'flow-node-badge'));
  }
  return box;
}

function renderRoleFlowDiagram(flow, options = {}) {
  const wrap = element('div', '', 'role-flow-diagram' + (options.compact ? ' role-flow-compact' : ' role-flow-detail'));
  wrap.setAttribute('role', 'list');
  wrap.setAttribute('aria-label', '角色流转情况');

  const stages = Array.isArray(flow?.stages) ? flow.stages : [];
  if (!stages.length) {
    const empty = element('span', '单步执行记录', 'flow-node flow-node-queued');
    empty.setAttribute('role', 'listitem');
    wrap.append(empty);
    return wrap;
  }

  stages.forEach((stage, idx) => {
    if (idx > 0) {
      const arrow = element('span', '→', 'flow-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      wrap.append(arrow);
    }
    const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
    if (stage.parallel && nodes.length > 1) {
      const stack = element('div', '', 'flow-parallel-stack');
      stack.setAttribute('role', 'listitem');
      stack.setAttribute('aria-label', '并行角色阶段');
      for (const node of nodes) {
        stack.append(renderFlowNode(node, options));
      }
      wrap.append(stack);
    } else if (nodes[0]) {
      const item = renderFlowNode(nodes[0], options);
      item.setAttribute('role', 'listitem');
      wrap.append(item);
    }
  });
  return wrap;
}
