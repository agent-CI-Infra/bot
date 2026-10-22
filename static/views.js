// Task process and project computer views. Loaded after app.js and reuses its helpers ($, api, element, state, states, timestamp).
const terminalStates = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed'];
const retryableStates = ['failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'retry_wait', 'needs_replan'];
const kindLabels = { 'review.issue': '检视 Issue', 'review.pr': '检视 PR', 'development.issue': '开发 Issue', 'development.pr': '跟进 bot PR' };
const modeLabels = { 'review.issue': '检视', 'review.pr': '检视', 'development.issue': '开发', 'development.pr': '跟进' };
const phaseLabels = { prepare: '准备工作区', model: '模型执行', validate: '测试验证', publish: '发布', done: '完成' };
const publicationLabels = { comment: '总结评论', review: '行内检视（COMMENT）', label: '标签', branch: 'bot 分支', pull_request: 'PR' };
const publicationStates = { sent: ['已发布', 'success'], pending: ['待发布', 'info'], inflight: ['发布中', 'info'], unknown: ['结果待确认', 'warning'] };

function objectLabel(task) { return `${task.kind.endsWith('.pr') ? 'PR' : 'Issue'} #${task.object_number}`; }
function githubUrl(task) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(task.full_name || '') || !task.object_number) return null;
  return `https://github.com/${task.full_name}/${task.kind.endsWith('.pr') ? 'pull' : 'issues'}/${task.object_number}`;
}
function link(url, text, className) {
  try {
    const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
    const a = element('a', text, className); a.href = parsed.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  } catch { return element('span', text, className); }
}
function clipText(value, limit) { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; }
function badge(caption, tone) { return element('span', caption, 'status' + (tone ? ' status-' + tone : '')); }
function exitBadge(result) {
  if (!result) return badge('无结果');
  if (result.error) return badge(result.error, 'danger');
  if (result.timed_out) return badge('超时', 'warning');
  return badge(`退出码 ${result.exit_code}`, result.exit_code === 0 ? 'success' : 'danger');
}
function collapsible(title, text, open = false) {
  const details = element('details', '', 'fold'); details.open = open;
  details.append(element('summary', title), element('pre', text, 'output')); return details;
}
function output(text) { return collapsible(`输出（${String(text).split('\n').length} 行）`, text, text.length < 800); }
function button(caption, onClick, className = 'quiet') { const b = element('button', caption, className); b.type = 'button'; b.addEventListener('click', onClick); return b; }
function card(title) { const section = element('section', '', 'side-card'); section.append(element('h3', title)); return section; }
function facts(rows) {
  const list = element('dl', '', 'facts');
  for (const [key, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    const dd = element('dd', ''); if (value instanceof Node) dd.append(value); else dd.textContent = String(value);
    list.append(element('dt', key), dd);
  }
  return list;
}
// Re-rendering every few seconds must not collapse sections the reader opened.
function keepOpen(container, render) {
  const open = new Set([...container.querySelectorAll('details[open] > summary')].map(s => s.textContent));
  render(); container.querySelectorAll('details > summary').forEach(s => { if (open.has(s.textContent)) s.parentElement.open = true; });
}
function networkText(pc) { return pc.network_policy === 'internet egress' ? '可访问外网（项目独立网络）' : pc.network_policy === 'internal, no egress' ? '项目内部网络，无外网' : pc.network_policy; }
function scroller(node) { return getComputedStyle(node).overflowY === 'auto' ? node : node.parentElement; }
function operationId() { return [...crypto.getRandomValues(new Uint8Array(24))].map(n => n.toString(16).padStart(2, '0')).join(''); }
function environmentButtons(environment, task, after, report) {
  return [['start', '启动'], ['stop', '停止'], ['reset', '重置']].map(([action, caption]) => {
    const b = button(caption, async () => {
      if (action === 'reset' && !confirm(`重置 ${environment.full_name} 的虚拟电脑？旧工作卷会保留，新环境从空工作卷开始。`)) return;
      if (action === 'stop' && task && !confirm(`停止 ${environment.full_name} 的虚拟电脑？仓库会被停用，正在执行的任务会中止。`)) return;
      b.disabled = true;
      try { await api(`/api/environments/${environment.repository_id}/${action}`, 'POST', { operation_id: operationId(), generation: environment.generation }); }
      catch (err) { report(err); }
      await after();
    });
    b.disabled = !!environment.operation_pending || !environment.generation || ['provisioning', 'recovering', 'resetting', 'busy'].includes(environment.state)
      || action === 'start' && ['ready', 'reset_failed'].includes(environment.state) || action === 'stop' && environment.state === 'stopped';
    return b;
  });
}

function dialog(id, markup) {
  const view = document.createElement('dialog'); view.id = id; view.className = 'wide'; view.innerHTML = markup; document.body.append(view); return view;
}
const taskView = dialog('task-view', `<div class="view-head"><div class="title-group"><h2 id="task-title"></h2><span id="task-badges" class="actions"></span></div><div id="task-actions" class="actions"></div></div>
<p id="task-error" class="view-error" role="alert"></p>
<div class="task-layout"><section class="timeline-panel" aria-labelledby="timeline-heading"><h3 id="timeline-heading">Agent 工作过程</h3><ol id="timeline" class="timeline"></ol><div id="timeline-command" class="step step-running" aria-live="off" hidden></div><p id="timeline-live" class="live" role="status" hidden></p></section><aside id="task-side" class="task-side" aria-label="任务信息"></aside></div>`);
taskView.setAttribute('aria-labelledby', 'task-title');
const environmentView = dialog('environment-view', `<div class="view-head"><div class="title-group"><h2 id="environment-title"></h2><span id="environment-badges" class="actions"></span></div><div id="environment-actions" class="actions"></div></div>
<p id="environment-error" class="view-error" role="alert"></p><div id="environment-body" class="environment-layout"></div>`);
environmentView.setAttribute('aria-labelledby', 'environment-title');

let openTaskId = null, taskTimer = null, renderedLogs = new Set(), liveCommand = null;
async function openTask(id) {
  if (environmentView.open) environmentView.close();
  openTaskId = id; renderedLogs = new Set(); liveCommand = null; $('timeline-command').hidden = true; clearTimeout(taskTimer);
  for (const part of ['timeline', 'task-side', 'task-badges', 'task-actions']) $(part).replaceChildren();
  $('task-title').textContent = '正在加载…'; $('task-error').textContent = ''; $('timeline-live').hidden = true;
  if (!taskView.open) taskView.showModal();
  await refreshTask();
}
async function refreshTask() {
  clearTimeout(taskTimer); const id = openTaskId; if (!id || !taskView.open) return;
  try {
    const [detail, { logs }] = await Promise.all([api('/api/tasks/' + id), api('/api/tasks/' + id + '/logs')]);
    const environment = await api('/api/environments/' + detail.task.repository_id).catch(() => null);
    if (openTaskId !== id || !taskView.open) return;
    $('task-error').textContent = '';
    renderTaskHeader(detail.task); renderTimeline(detail.task, logs); await refreshLive(detail.task); keepOpen($('task-side'), () => renderTaskSide(detail, environment));
    if (!terminalStates.includes(detail.task.status)) taskTimer = setTimeout(refreshTask, detail.task.status.startsWith('waiting_') ? 5000 : 2000);
  } catch (err) { $('task-error').textContent = err.message; taskTimer = setTimeout(refreshTask, 5000); }
}
function renderTaskHeader(task) {
  $('task-title').textContent = `${modeLabels[task.kind] || task.kind} · ${objectLabel(task)}`;
  $('task-badges').replaceChildren(state(task.status), element('span', task.full_name || '仓库 ' + task.repository_id, 'muted'));
  const actions = $('task-actions'), url = githubUrl(task); actions.replaceChildren();
  if (url) actions.append(link(url, '在 GitHub 打开', 'button-link'));
  if (retryableStates.includes(task.status)) actions.append(button('重试', async event => {
    event.currentTarget.disabled = true;
    try { await api('/api/tasks/' + task.id + '/retry', 'POST', {}); } catch (err) { $('task-error').textContent = err.message; }
    await refreshTask();
  }));
  actions.append(button('关闭', () => taskView.close()));
}
// The command running right now in the project computer, with its output streamed by byte offset.
async function refreshLive(task) {
  const box = $('timeline-command');
  if (task.status !== 'running') { box.hidden = true; liveCommand = null; return; }
  let live = await api(`/api/tasks/${task.id}/live?offset=${liveCommand?.offset || 0}`).catch(() => null);
  if (live?.running && liveCommand && live.operation_id !== liveCommand.operation_id) { liveCommand = null; live = await api(`/api/tasks/${task.id}/live?offset=0`).catch(() => null); }
  if (!live?.running) { box.hidden = true; liveCommand = null; return; }
  if (!liveCommand) liveCommand = { operation_id: live.operation_id, offset: 0, text: '', seen: Date.now() };
  liveCommand.text = (liveCommand.text + live.output).slice(-65536); liveCommand.offset = live.offset;
  const panel = scroller(box.parentElement), atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
  const head = element('div', '', 'step-head'), meta = element('span', '', 'step-meta');
  meta.append(badge('运行中', 'info'), element('span', `最长 ${Math.round((live.timeout_ms || 120000) / 60000)} 分钟${live.keep_background ? ' · 保留后台进程' : ''}`));
  head.append(element('strong', '正在执行命令'), meta);
  box.replaceChildren(head, element('pre', '$ ' + live.command, 'command'), element('pre', liveCommand.text || '（还没有输出）', 'output live-output'));
  box.hidden = false; if (atBottom) panel.scrollTop = panel.scrollHeight;
}
function liveText(task) {
  if (terminalStates.includes(task.status)) return null;
  if (task.status === 'queued') return '排队中，等待这个仓库的虚拟电脑空闲…';
  if (task.status === 'publishing') return '正在发布到 GitHub…';
  if (task.status.startsWith('waiting_') || task.status === 'retry_wait') return `已暂停：${(states[task.status] || [task.status])[0]}${task.error_code ? '（' + task.error_code + '）' : ''}，条件满足后自动继续`;
  return { prepare: '正在准备工作区：拉取固定提交并写入虚拟电脑…', model: 'Agent 正在思考，或在虚拟电脑里执行工具…', validate: '正在虚拟电脑里运行仓库测试…', publish: '正在发布到 GitHub…' }[task.phase] || '执行中…';
}
function renderTimeline(task, logs) {
  const list = $('timeline'), box = scroller(list.parentElement), first = !list.childElementCount, atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (const log of logs) if (!renderedLogs.has(log.id)) { renderedLogs.add(log.id); list.append(step(log)); }
  const live = liveText(task); $('timeline-live').hidden = !live; $('timeline-live').textContent = live || '';
  // A finished task opens at its first step; a running one follows the newest step unless the reader scrolled up.
  if (first ? !!live : atBottom) box.scrollTop = box.scrollHeight;
}
function toolCaption(call) {
  let args = {}; try { args = JSON.parse(call.arguments); } catch { /* Long arguments are clipped in the log. */ }
  return { run_command: '执行命令：' + clipText(args.command, 80), read_file: '读取 ' + (args.path || '文件'), write_file: '写入 ' + (args.path || '文件'),
    finish_review: '提交检视结论', finish_development: '提交开发结果' }[call.name] || call.name;
}
function step(log) {
  let value; try { value = JSON.parse(log.content); } catch { value = { type: 'raw' }; }
  const item = element('li', '', 'step step-' + value.type), head = element('div', '', 'step-head'), title = element('strong', ''), meta = element('span', '', 'step-meta');
  head.append(title, meta); item.append(head);
  if (log.created_at) { const time = element('time', log.created_at.slice(11, 19)); time.dateTime = log.created_at; time.title = timestamp(log.created_at); meta.append(time); }
  const add = (...nodes) => item.append(...nodes), args = value.arguments || {}, result = value.result || {};
  if (value.type === 'prepared') {
    title.textContent = '准备项目工作区'; add(element('p', `固定提交 ${String(value.sha || '').slice(0, 12)}`));
    for (const line of value.coverage || []) add(element('p', line, 'muted'));
  } else if (value.type === 'model') {
    title.textContent = `第 ${value.step} 步 · 模型决策`;
    if (value.reasoning) add(collapsible(`思考过程（${value.reasoning.length} 字）`, value.reasoning));
    if (value.content) add(element('p', value.content, 'say'));
    const calls = element('div', '', 'calls'); for (const call of value.tool_calls || []) calls.append(element('span', toolCaption(call), 'call'));
    if (calls.childElementCount) add(calls);
  } else if (value.type === 'tool' && value.name === 'run_command' || value.type === 'command') {
    const command = value.type === 'command' ? value : { command: args.command, ...result };
    title.textContent = '执行命令'; meta.prepend(exitBadge(command)); add(element('pre', '$ ' + command.command, 'command'));
    if (command.output) add(output(command.output));
  } else if (value.type === 'tool' && value.name === 'read_file') {
    title.textContent = '读取文件'; add(element('p', `${args.path} · ${result.error || result.bytes + ' 字节'}`));
    if (result.content) add(collapsible('文件内容', result.content));
  } else if (value.type === 'tool' && value.name === 'write_file') {
    title.textContent = '写入文件'; add(element('p', `${args.path} · ${args.bytes} 字节`));
  } else if (value.type === 'published') {
    title.textContent = '发布到 GitHub'; const links = element('div', '', 'calls');
    for (const out of value.outputs || []) {
      if (out.labels) out.labels.forEach(name => links.append(element('span', '标签 ' + name, 'call')));
      else if (out.html_url) links.append(link(out.html_url, out.branch ? 'PR · ' + out.branch : out.inline_comments ? `行内检视 · ${out.inline_comments} 条` : /pull\/\d+$/.test(out.html_url) ? 'PR' : '总结评论', 'call call-link'));
    }
    add(links);
  } else if (value.type === 'completed') { title.textContent = '任务结束'; meta.prepend(state(value.status)); }
  else if (value.type === 'fault') { title.textContent = '任务暂停或失败'; meta.prepend(state(value.state)); add(element('p', value.code, 'muted')); }
  else if (value.type === 'restart_attempt') { title.textContent = '重新开始一次尝试'; add(element('p', '中断的工作目录保留，新的尝试使用新目录。', 'muted')); }
  else if (value.type === 'runtime_fault') { title.textContent = '运行故障'; add(element('p', value.message || '', 'muted')); }
  else { title.textContent = value.type === 'tool' ? '工具 ' + value.name : '记录'; add(element('pre', log.content, 'output')); }
  return item;
}
function renderTaskSide(detail, environment) {
  const { task, publications } = detail, side = $('task-side'); side.replaceChildren();
  const info = card('任务');
  info.append(facts([['阶段', phaseLabels[task.phase] || task.phase], ['尝试', `第 ${task.attempt} 次`], ['提交', task.head_sha?.slice(0, 12)],
    ['故障', task.error_code], ['创建', timestamp(task.created_at)], ['更新', timestamp(task.updated_at)]]));
  if (task.source_task_id) info.append(button('查看来源检视', () => openTask(task.source_task_id)));
  side.append(info, computerCard(task, environment));
  const result = resultCard(task); if (result) side.append(result);
  if (publications?.length) {
    const section = card('GitHub 发布记录'), list = element('ul', '', 'history');
    for (const p of publications) {
      const row = element('li', ''), [caption, tone] = publicationStates[p.state] || [p.state, ''], name = publicationLabels[p.kind] || p.kind;
      row.append(p.response?.html_url ? link(p.response.html_url, name) : element('span', p.kind === 'label' && Array.isArray(p.response) ? `${name} ${p.response.map(l => l.name).join('、')}` : name), badge(caption, tone));
      list.append(row);
    }
    section.append(list); side.append(section);
  }
  const raw = element('details', '', 'fold raw'); raw.append(element('summary', '原始数据'), element('pre', JSON.stringify(detail, null, 2), 'output')); side.append(raw);
}
function computerCard(task, environment) {
  const section = card('虚拟电脑（项目环境）');
  if (!environment) { section.append(element('p', '无法读取环境状态。', 'muted')); return section; }
  const env = environment.environment, pc = env.computer || {}, current = environment.current_task;
  const usage = current?.id === task.id ? '本任务正在使用' : current ? `正在执行 ${kindLabels[current.kind] || current.kind} #${current.object_number}` : '空闲';
  const head = element('div', '', 'actions'); head.append(state(env.state), element('span', usage, 'muted')); section.append(head);
  section.append(facts([['容器', pc.container], ['代次', task.generation && env.generation && task.generation !== env.generation ? `当前 g${env.generation}，本任务用 g${task.generation}` : env.generation ? 'g' + env.generation : '待创建'],
    ['资源', pc.cpus ? `${pc.cpus} CPU · ${pc.memory_mb} MB 内存 · ${pc.pids} 进程` : null], ['网络', networkText(pc)]]));
  const actions = element('div', '', 'actions');
  actions.append(button('查看虚拟电脑', () => openEnvironment(task.repository_id)), ...environmentButtons(env, current, refreshTask, err => { $('task-error').textContent = err.message; }));
  section.append(actions); return section;
}
function resultCard(task) {
  const result = task.result; if (!result) return null;
  const review = task.kind.startsWith('review.'), section = card(review ? '检视结论' : '开发结果');
  if (result.summary) section.append(element('p', result.summary, 'say'));
  if (review && Array.isArray(result.findings)) {
    section.append(element('p', `${result.findings.length} 条发现`, 'muted'));
    const list = element('ol', '', 'findings');
    for (const finding of result.findings) {
      const item = element('li', '');
      item.append(element('span', finding.format === 'inline' && finding.path ? `行内 · ${finding.path}:${finding.line}` : '讨论评论', 'call'), element('p', clipText(finding.body, 500)));
      if (finding.selection_reason) item.append(element('p', '选择理由：' + finding.selection_reason, 'muted'));
      list.append(item);
    }
    section.append(list);
  } else if (!review) {
    section.append(facts([['分支', result.branch], ['PR', result.pr_url ? link(result.pr_url, 'PR #' + result.pr_number) : null],
      ['测试', result.validation ? `${result.validation.command} · 退出码 ${result.validation.exit_code}` : result.test_command], ['提交', result.sha?.slice(0, 12)]]));
  }
  return section;
}

let openEnvironmentId = null, environmentTimer = null;
async function openEnvironment(repositoryId) {
  if (taskView.open) taskView.close();
  openEnvironmentId = repositoryId; clearTimeout(environmentTimer);
  for (const part of ['environment-body', 'environment-badges', 'environment-actions']) $(part).replaceChildren();
  $('environment-title').textContent = '正在加载…'; $('environment-error').textContent = '';
  if (!environmentView.open) environmentView.showModal();
  await refreshEnvironment();
}
async function refreshEnvironment() {
  clearTimeout(environmentTimer); const id = openEnvironmentId; if (!id || !environmentView.open) return;
  try {
    const detail = await api('/api/environments/' + id); if (openEnvironmentId !== id || !environmentView.open) return;
    $('environment-error').textContent = ''; keepOpen($('environment-body'), () => renderEnvironment(detail));
  } catch (err) { $('environment-error').textContent = err.message; }
  environmentTimer = setTimeout(refreshEnvironment, 3000);
}
function renderEnvironment({ environment: env, current_task: current, tasks, commands }) {
  const pc = env.computer || {};
  $('environment-title').textContent = `虚拟电脑 · ${env.full_name}`;
  $('environment-badges').replaceChildren(state(env.state), element('span', env.enabled ? '仓库已启用' : '仓库已停用', 'muted'));
  $('environment-actions').replaceChildren(button('设置', () => openSettings(env.repository_id, refreshEnvironment).catch(err => { $('environment-error').textContent = err.message; })),
    ...environmentButtons(env, current, refreshEnvironment, err => { $('environment-error').textContent = err.message; }), button('关闭', () => environmentView.close()));
  const machine = card('机器');
  machine.append(facts([['容器', pc.container], ['代次', env.generation ? 'g' + env.generation : '待创建'], ['启动于', timestamp(env.started_at)], ['工作卷', pc.volume ? `${pc.volume} → ${pc.workdir}` : null],
    ['网络', pc.network ? `${pc.network}（${networkText(pc)}）` : null], ['单条命令', pc.max_command_minutes ? `最长 ${pc.max_command_minutes} 分钟，容器不随命令重启` : null], ['镜像', pc.image ? pc.image.slice(0, 19) : null], ['运行用户', pc.user],
    ['资源', pc.cpus ? `${pc.cpus} CPU · ${pc.memory_mb} MB 内存 · ${pc.pids} 进程 · /tmp ${pc.tmp_mb} MB` : null], ['根文件系统', pc.root_filesystem === 'read-only' ? '只读' : pc.root_filesystem],
    ['保留代次', pc.retained_generations], ['故障', env.error]]));
  if (!env.computer) machine.append(element('p', '暂时读不到 manager 的机器信息。', 'muted'));
  const work = card('正在执行');
  work.append(current ? button(`${kindLabels[current.kind] || current.kind} #${current.object_number} · ${(states[current.status] || [current.status])[0]}`, () => openTask(current.id), 'quiet linkish') : element('p', '空闲。每个仓库同一时间只执行一个任务。', 'muted'));
  const recent = card('最近任务'), taskList = element('ul', '', 'history');
  for (const task of tasks) {
    const row = element('li', ''); row.append(button(`${kindLabels[task.kind] || task.kind} #${task.object_number}`, () => openTask(task.id), 'quiet linkish'), state(task.status));
    row.append(element('span', `${task.generation ? 'g' + task.generation + ' · ' : ''}${timestamp(task.updated_at)}`, 'muted wide-cell')); taskList.append(row);
  }
  recent.append(tasks.length ? taskList : element('p', '还没有任务。', 'muted'));
  const history = card('最近在这台电脑上执行的命令'), commandList = element('ul', '', 'history commands');
  for (const command of commands) {
    const row = element('li', ''); row.append(element('code', '$ ' + clipText(command.command, 160)), exitBadge(command));
    row.append(element('span', `${command.created_at ? command.created_at.slice(11, 19) + ' · ' : ''}${kindLabels[command.kind] || command.kind} #${command.object_number}`, 'muted wide-cell'));
    commandList.append(row);
  }
  history.append(commands.length ? commandList : element('p', '还没有命令记录。新任务的命令会显示在这里。', 'muted'));
  const left = element('div', '', 'stack'), right = element('div', '', 'stack'); left.append(machine, work); right.append(recent, history);
  $('environment-body').replaceChildren(left, right);
}
for (const view of [taskView, environmentView]) view.addEventListener('close', () => { clearTimeout(taskTimer); clearTimeout(environmentTimer); if (view === taskView) openTaskId = null; else openEnvironmentId = null; });
$('logout').addEventListener('click', () => { for (const view of [taskView, environmentView]) if (view.open) view.close(); });

// Installed repositories (super administrator): GitHub shows what is installed; nothing works until it is started here.
function syncSummary(syncs = []) {
  if (!syncs.length) return '尚未同步';
  return syncs.map(s => s.error ? `${s.account_name} 同步失败（${s.error}）` : `${s.account_name} 同步于 ${timestamp(s.synced_at).slice(11, 19)}`).join(' · ');
}
function installedDetail(row) {
  const parts = [row.owner_login || '所有者 ' + row.owner_id, row.private ? '私有' : '公开'];
  if (row.account_name) parts.push(row.account_name + (row.installation_id ? ' 安装 ' + row.installation_id : ''));
  parts.push('仓库 ID ' + row.id);
  if (row.registered) parts.push(`检视${row.review_enabled ? '开' : '关'} · 开发${row.development_enabled ? '开' : '关'}${row.model_id ? '' : ' · 未选模型'}`);
  return parts.join(' · ');
}
function installedBadges(row) {
  const badges = [!row.registered ? badge('未启动', 'info') : !row.enabled ? badge('已禁用', 'warning') : row.review_enabled ? badge('工作中', 'success') : badge('未开检视', 'warning')];
  if (row.installed === false) badges.push(badge('已移出安装', 'danger'));
  else if (row.installed === null) badges.push(badge('手动登记'));
  return badges;
}
function installedActions(row, after) {
  const actions = element('div', '', 'actions');
  const call = async (path, body, caption) => {
    actions.querySelectorAll('button').forEach(b => { b.disabled = true; }); $('message').textContent = caption;
    try { await api(`/api/installations/${row.id}/${path}`, 'POST', body); $('message').textContent = ''; } catch (err) { error(err); }
    await after();
  };
  if (!row.registered && row.installed) actions.append(button('启动', () => openActivation(row, after), ''));
  // Enabling also turns review on, so a manually registered repository starts working too.
  if (row.registered && (!row.enabled || !row.review_enabled)) actions.append(button('启用', () => call('activate', {}, `正在启用 ${row.full_name}…`)));
  if (row.registered && row.enabled) actions.append(button('禁用', () => {
    if (confirm(`禁用 ${row.full_name}？新的 Issue／PR 不再处理，正在执行的任务会中止，虚拟电脑停止但数据保留。`)) call('disable', {}, `正在禁用 ${row.full_name}…`);
  }));
  if (row.registered) actions.append(button('设置', () => openSettings(row.id, after).catch(error)), button('查看虚拟电脑', () => openEnvironment(row.id).catch(error)));
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

// Project settings: review/development policy (repository administrators) and the project computer spec (super administrators).
const settingsView = document.createElement('dialog'); settingsView.id = 'settings-view'; settingsView.setAttribute('aria-labelledby', 'settings-title');
settingsView.innerHTML = `<form id="settings-form" novalidate><h2 id="settings-title"></h2>
<fieldset><legend>检视与开发</legend>
<label>模型<select name="model_id"></select></label>
<label class="check"><input type="checkbox" name="review_enabled"> 检视新打开的 Issue 和 PR</label>
<label class="check"><input type="checkbox" name="development_enabled"> 自动开发：Issue 明确要求改代码时，在虚拟电脑里实现、测试并开 bot PR</label>
<div class="field-grid"><label>测试命令<input name="test_command" maxlength="2048" placeholder="如 npm test；留空时用模型给出的命令"></label>
<label>基准分支<input name="base_branch" maxlength="256" placeholder="留空使用仓库默认分支"></label>
<label>bot PR 自动修订轮数<input name="max_revisions" type="number" min="0" max="10" step="1"></label>
<label>检视后打的标签<input name="review_label" maxlength="50" placeholder="留空不打标签"></label></div>
</fieldset>
<fieldset id="settings-computer"><legend>虚拟电脑</legend><p id="settings-computer-note" class="muted"></p>
<div class="field-grid"><label>CPU（核）<input name="cpus" type="number" step="0.25"></label><label>内存（MB）<input name="memory_mb" type="number" step="128"></label>
<label>进程数上限<input name="pids" type="number" step="1"></label><label>/tmp 大小（MB）<input name="tmp_mb" type="number" step="16"></label></div>
<label class="check"><input type="checkbox" name="egress"> 允许访问外网（安装依赖、访问测试地址）</label>
</fieldset>
<p id="settings-error" class="view-error" role="alert"></p>
<div class="actions settings-actions"><button type="button" class="quiet" id="settings-cancel">取消</button><button type="submit">保存</button></div></form>`;
document.body.append(settingsView);
const specFields = ['cpus', 'memory_mb', 'pids', 'tmp_mb'];
let settingsTarget = null;
async function openSettings(repositoryId, after = async () => {}) {
  const form = $('settings-form'), superUser = me.role === 'super_admin';
  const [{ repository, policy }, environment, models] = await Promise.all([api('/api/repositories/' + repositoryId),
    api('/api/environments/' + repositoryId).catch(() => null), api(superUser ? '/api/models' : '/api/models?repository_id=' + repositoryId)]);
  const pc = environment?.environment?.computer, select = form.elements.model_id;
  settingsTarget = { repositoryId, after, policy, environment: environment?.environment, computer: pc };
  $('settings-title').textContent = '项目设置 · ' + repository.full_name; $('settings-error').textContent = ''; form.reset(); select.replaceChildren(new Option('未选择（任务会等待模型配置）', ''));
  for (const m of models.models.filter(m => m.repository_id === null || m.repository_id === repositoryId))
    select.add(new Option(`${m.model_name} · ${m.repository_id ? '本仓库专属' : '部署共享'}${m.key_configured ? '' : '（Key 已撤销）'}`, m.id));
  select.value = policy.model_id || '';
  for (const name of ['review_enabled', 'development_enabled']) form.elements[name].checked = !!policy[name];
  for (const name of ['test_command', 'base_branch', 'max_revisions', 'review_label']) form.elements[name].value = policy[name] ?? '';
  // The manager reports the bounds it enforces; the form mirrors them so out-of-range values are caught before saving.
  for (const name of specFields) { const input = form.elements[name]; input.value = pc?.[name] ?? ''; if (pc?.bounds?.[name]) [input.min, input.max] = pc.bounds[name]; }
  form.elements.egress.checked = pc ? pc.network_policy === 'internet egress' : false;
  const editable = superUser && !!pc;
  $('settings-computer').disabled = !editable;
  $('settings-computer-note').textContent = !pc ? '暂时读不到虚拟电脑规格，稍后再试。' : !superUser ? '虚拟电脑规格由超级管理员设置。'
    : '保存后虚拟电脑按新规格重建：工作卷和代次保留，正在执行的命令先执行完，任务保留的后台进程会结束。';
  settingsView.showModal();
}
$('settings-cancel').addEventListener('click', () => settingsView.close());
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, target = settingsTarget, submit = form.querySelector('[type=submit]'); if (!target) return;
  const invalid = [...form.querySelectorAll('input')].find(input => !input.disabled && !input.checkValidity());
  if (invalid) {
    const label = invalid.closest('label').firstChild.textContent.trim(), range = invalid.validity.rangeOverflow || invalid.validity.rangeUnderflow;
    $('settings-error').textContent = range ? `${label}需在 ${invalid.min}–${invalid.max} 之间` : invalid.validity.stepMismatch ? `${label}的取值步长是 ${invalid.step}` : `${label}：${invalid.validationMessage}`;
    invalid.focus(); return;
  }
  // Only changed fields are sent, so saving the policy never touches the computer and vice versa.
  const values = { model_id: form.elements.model_id.value || null, review_enabled: form.elements.review_enabled.checked, development_enabled: form.elements.development_enabled.checked,
    test_command: form.elements.test_command.value, base_branch: form.elements.base_branch.value.trim(), max_revisions: Number(form.elements.max_revisions.value), review_label: form.elements.review_label.value.trim() };
  const saved = target.policy, current = { model_id: saved.model_id || null, review_enabled: !!saved.review_enabled, development_enabled: !!saved.development_enabled,
    test_command: saved.test_command || '', base_branch: saved.base_branch || '', max_revisions: saved.max_revisions, review_label: saved.review_label || '' };
  const policy = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== current[key]));
  const spec = {};
  if (!$('settings-computer').disabled) {
    for (const name of specFields) if (Number(form.elements[name].value) !== target.computer[name]) spec[name] = Number(form.elements[name].value);
    if (form.elements.egress.checked !== (target.computer.network_policy === 'internet egress')) spec.egress = form.elements.egress.checked;
  }
  submit.disabled = true; $('settings-error').textContent = '';
  try {
    if (Object.keys(policy).length) await api(`/api/repositories/${target.repositoryId}/policy`, 'PATCH', policy);
    if (Object.keys(spec).length) {
      $('settings-error').textContent = '正在按新规格重建虚拟电脑…';
      await api(`/api/environments/${target.repositoryId}/configure`, 'POST', { operation_id: operationId(), generation: target.environment.generation, spec });
    }
    settingsView.close(); await target.after();
  } catch (err) { $('settings-error').textContent = err.message; } finally { submit.disabled = false; }
});
