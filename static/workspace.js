// Project overview is a read-only projection. Task details and actions keep their existing authorization and receipts.
const workspaceGroups = [
  ['active', '推进中任务', '执行、验证和发布，含结果待发布。'],
  ['queued', '排队任务', '等待自动调度。'],
  ['attention', '需要关注', '查看原因与下一步。'],
  ['all', '全部任务记录', '包含历史；按任务记录计数。']
];
function workspaceOverview() {
  const id = current.id, owner = me.id, routeKey = location.hash, root = element('section', '', 'workspace-overview');
  const match = /^(active|queued|attention|all)(?:\.(\d+))?$/.exec(current.item || 'active');
  const group = match?.[1] || 'active', rawOffset = Number(match?.[2] || 0), offset = Number.isSafeInteger(rawOffset) ? rawOffset : 0, size = 10;
  const address = (key, next = 0) => `#/projects/${id}/overview/${key}${next ? '.' + next : ''}`;
  const alive = () => root.isConnected && me?.id === owner && current?.id === id && current.section === 'overview' && location.hash === routeKey;
  const head = element('div', '', 'console-page-head'), heading = element('div');
  heading.append(element('p', 'PROJECT OVERVIEW', 'eyebrow'), element('h2', '项目总览'), note('查看工作进展，处理阻塞，并进入项目设置。'));
  const refresh = button('刷新总览', () => void update()); head.append(heading, refresh);
  const metrics = element('nav', '', 'workspace-metrics'); metrics.setAttribute('aria-label', '项目任务范围');
  const numbers = new Map();
  for (const [key, caption, hint] of workspaceGroups) {
    const a = consoleLink(address(key), caption, hint), count = element('strong', '—'); a.dataset.taskGroup = key;
    if (key === group) a.setAttribute('aria-current', 'page');
    a.prepend(count); numbers.set(key, count); metrics.append(a);
  }
  const layout = element('div', '', 'workspace-layout'), work = card(workspaceGroups.find(([key]) => key === group)[1]);
  const taskStatus = note('正在读取完整任务范围…'); taskStatus.classList.add('workspace-task-status'); taskStatus.setAttribute('role', 'status');
  const rows = element('div', '', 'workspace-task-rows'), paging = element('nav', '', 'console-inbox-paging'); paging.setAttribute('aria-label', '总览任务分页');
  work.append(taskStatus, rows, paging);
  const aside = element('aside', '', 'workspace-context'), health = card('项目与环境'), healthStatus = note('正在读取环境记录…'), factsBox = element('div');
  healthStatus.className = 'muted workspace-health-status'; healthStatus.setAttribute('role', 'status'); health.append(healthStatus, factsBox);
  const access = card('下一步'); access.append(
    consoleLink(`#/new-task/${id}`, '新建任务', '填写原始需求、目标、验收条件和交付类型'),
    consoleLink(`#/inbox/${id}`, '打开待处理中心', '查看原因和任务证据后决定下一步'),
    consoleLink(`#/projects/${id}/roles`, '角色与 Manager', '查看实际配置和分派记录'),
    consoleLink(`#/projects/${id}/machine`, '项目电脑', '检查连接、运行状态与资源'),
    consoleLink(`#/projects/${id}/basic`, '项目设置', '分支、启用状态与配置来源'));
  aside.append(health, access); layout.append(work, aside); root.append(head, metrics, layout);
  let pending = false, lastTasks = null, lastHealth = null, signature = '', healthSignature = '';
  const rowKey = row => JSON.stringify([row.id,row.repository_id,row.full_name,row.kind,row.object_number,row.status,row.summary,row.error_code,row.updated_at,row.origin]);
  const expired = (node, err, time) => {
    node.classList.add('view-error'); node.setAttribute('role', 'alert');
    node.textContent = `${err.message}。${time ? '保留上次成功数据（' + timestamp(time) + '），可能已过期。' : '暂时无法判断，不显示为零或正常。'}可用“刷新总览”重试。`;
  };
  const revoke = err => {
    if (![401, 403, 404].includes(err.status) || !alive()) return false;
    $('project-page').replaceChildren(consoleState('项目访问已变化', '无法继续读取这个项目，请重新加载当前授权。', { tone: 'error', retry: () => start().catch(error) }));
    current = null; return true;
  };
  async function tasks() {
    rows.setAttribute('aria-busy', 'true');
    try {
      const data = await api('/api/tasks?' + new URLSearchParams({ repository_id: id, summary: '1', group, limit: String(size), offset: String(offset) }));
      if (!alive()) return;
      lastTasks = data.summary.sampled_at;
      for (const [key, count] of numbers) count.textContent = String(data.summary[key]);
      taskStatus.classList.remove('view-error'); taskStatus.setAttribute('role', 'status');
      const total = data.summary[group];
      taskStatus.textContent = `${total} 项任务记录 · ${data.tasks.length ? `显示 ${offset + 1}–${offset + data.tasks.length} 项 · ` : ''}更新于 ${timestamp(lastTasks)}`;
      const nextSignature = JSON.stringify(data.tasks.map(rowKey));
      // Leave unchanged rows and their focused buttons in place during refresh.
      if (signature !== nextSignature || !rows.childElementCount) {
        signature = nextSignature;
        const focusedTask = rows.contains(document.activeElement) ? document.activeElement.dataset.attentionTask : null;
        const old = new Map([...rows.children].filter(node => node.dataset.taskId).map(node => [node.dataset.taskId, node]));
        if (!data.tasks.length) rows.replaceChildren(consoleState(offset ? '本页已没有任务' : '当前范围没有任务', offset ? '任务状态可能已变化，可返回上一页。' : '这里没有匹配的任务记录，不代表环境、CI 或其他范围全部正常。'));
        else {
          const wanted = data.tasks.map(row => {
            const key = rowKey(row), existing = old.get(row.id);
            if (existing?.taskSignature === key) return existing;
            const node = consoleTaskRow(row, true); node.taskSignature = key; return node;
          });
          // insertBefore keeps an unchanged focused row connected; replaceChildren would blur it.
          wanted.forEach((node, index) => { if (rows.children[index] !== node) rows.insertBefore(node, rows.children[index] || null); });
          [...rows.children].filter(node => !wanted.includes(node)).forEach(node => node.remove());
        }
        // A changed row may replace its button; keep the same action focused if the task remains in this range.
        if (focusedTask) rows.querySelector(`[data-attention-task="${CSS.escape(focusedTask)}"]`)?.focus({ preventScroll: true });
      }
      const hasNext = offset + data.tasks.length < total, pageKey = `${offset}:${hasNext}`;
      if (paging.dataset.pageKey !== pageKey) {
        paging.dataset.pageKey = pageKey; paging.replaceChildren();
        if (offset) paging.append(consoleLink(address(group, Math.max(0, offset - size)), '上一页'));
        if (hasNext) paging.append(consoleLink(address(group, offset + size), '下一页'));
      }
    } catch (err) {
      if (!alive() || revoke(err)) return;
      expired(taskStatus, err, lastTasks);
    } finally { rows.removeAttribute('aria-busy'); }
  }
  async function environment() {
    try {
      const [data, repo] = await Promise.all([api(`/api/environments/${id}`), api(`/api/repositories/${id}`)]);
      if (!alive()) return;
      lastHealth = new Date().toISOString(); healthStatus.classList.remove('view-error'); healthStatus.setAttribute('role', 'status');
      healthStatus.textContent = `记录读取于 ${timestamp(lastHealth)}。环境就绪不代表任务或 CI 成功。`;
      const env = data.environment, nextSignature = JSON.stringify([env.state, !!env.computer, env.operation_pending, repo.policy.enabled]);
      if (healthSignature !== nextSignature) {
        healthSignature = nextSignature;
        factsBox.replaceChildren(facts([['项目配置', repo.policy.enabled ? '已启用' : '已禁用'], ['环境记录', states[env.state]?.[0] || env.state || '未知'],
          ['实时电脑连接', env.computer ? '已取得当前电脑信息' : '尚未核实，查看项目电脑'], ['配置操作', env.operation_pending ? '等待服务端完成' : '没有待完成操作']]));
      }
    } catch (err) {
      if (!alive() || revoke(err)) return;
      expired(healthStatus, err, lastHealth);
    }
  }
  async function update() {
    if (!alive() || pending) return;
    pending = true; refresh.disabled = true;
    try { await Promise.all([tasks(), environment()]); }
    finally { pending = false; refresh.disabled = false; }
  }
  // Poll only this read-only projection; never redraw forms, details or the surrounding page.
  const poll = async () => { if (!alive()) return; if (!document.hidden) await update(); if (alive()) setTimeout(poll, 5000); };
  queueMicrotask(() => void poll()); return [root];
}
