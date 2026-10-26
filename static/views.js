// Task process and project computer views. Loaded after app.js and reuses its helpers ($, api, element, state, states, timestamp).
const terminalStates = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed'];
const retryableStates = ['failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'waiting_pr_head', 'retry_wait', 'needs_replan'];
const kindLabels = { 'review.issue': '检视 Issue', 'review.pr': '检视 PR', 'development.issue': '开发 Issue', 'development.pr': '跟进 bot PR' };
const modeLabels = { 'review.issue': '检视', 'review.pr': '检视', 'development.issue': '开发', 'development.pr': '跟进' };
const phaseLabels = { prepare: '准备工作区', model: '模型执行', validate: '测试验证', publish: '发布', done: '完成' };
const publicationLabels = { comment: '总结评论', review: '行内检视（COMMENT）', label: '标签', branch: 'bot 分支', pull_request: 'PR' };
const publicationStates = { sent: ['已发布', 'success'], pending: ['待发布', 'info'], inflight: ['发布中', 'info'], unknown: ['结果待确认', 'warning'] };
const emptyRepositoryMessage = '仓库还没有提交；默认分支出现提交后会自动继续。';
function taskErrorText(code) { return code === 'repository_has_no_commit' ? emptyRepositoryMessage : code; }
function taskState(task) { return task.status === 'waiting_configuration' && task.error_code === 'repository_has_no_commit' ? badge('仓库还没有提交', 'warning') : state(task.status); }

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
      if (action === 'reset' && !await askConfirm({ title: `重置 ${environment.full_name} 的虚拟电脑？`, body: ['旧工作卷会保留，新环境从空工作卷开始。'], action: '重置', danger: true })) return;
      if (action === 'stop' && task && !await askConfirm({ title: `停止 ${environment.full_name} 的虚拟电脑？`, body: ['仓库会被停用，正在执行的任务会中止。'], action: '停止', danger: true })) return;
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
// The console's own confirmation, in place of the browser's confirm() and prompt(). `body` items are paragraphs; an array
// item is a bulleted list. With `input` the dialog asks for one value and resolves to it. With `run` the dialog stays open
// while the action runs, shows `progress`, and shows the action's error in place so it can be tried again. Resolves the
// confirmed value (true without input) or null when cancelled, closed with Esc, or replaced by a newer request.
const confirmView = document.createElement('dialog'); confirmView.className = 'confirm-dialog'; confirmView.setAttribute('aria-labelledby', 'confirm-title');
document.body.append(confirmView);
let settleConfirm = null, confirmBusy = false;
function confirmDialog({ title, body = [], action = '确认', danger = false, input = null, run = null, progress = '正在处理…' }) {
  settleConfirm?.(null);
  return new Promise(resolve => {
    const settle = value => { if (settleConfirm !== settle) return; settleConfirm = null; confirmBusy = false; if (confirmView.open) confirmView.close(); resolve(value); };
    settleConfirm = settle;
    const form = element('form', '', 'confirm-form'), head = element('div', '', 'confirm-head'), text = element('div', '', 'confirm-body');
    const heading = element('h2', title); heading.id = 'confirm-title';
    head.append(element('span', danger ? '!' : '?', 'confirm-icon' + (danger ? ' danger' : '')), heading);
    for (const item of body) {
      if (!Array.isArray(item)) { text.append(element('p', item)); continue; }
      const list = element('ul', ''); item.forEach(line => list.append(element('li', line))); text.append(list);
    }
    let field = null;
    if (input) {
      field = document.createElement('input'); Object.assign(field, { type: input.type || 'text', name: 'value', autocomplete: input.type === 'password' ? 'new-password' : 'off', spellcheck: false });
      const label = element('label', input.label); label.append(field); text.append(label);
    }
    const status = element('p', '', 'confirm-status'), actions = element('div', '', 'confirm-actions');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const cancel = button('取消', () => settle(null)), submit = element('button', action, danger ? 'danger' : ''); submit.type = 'submit';
    actions.append(cancel, submit); form.append(head, text, status, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (confirmBusy) return;
      const value = field ? field.value.trim() : true;
      if (field && !value) { status.className = 'confirm-status error'; status.textContent = `请填写${input.label}`; field.focus(); return; }
      if (!run) { settle(value); return; }
      confirmBusy = true; cancel.disabled = submit.disabled = true; status.className = 'confirm-status progress'; status.textContent = progress;
      try { await run(value); settle(value); }
      catch (err) { if (settleConfirm !== settle) return; confirmBusy = false; cancel.disabled = submit.disabled = false; status.className = 'confirm-status error'; status.textContent = err.message; }
    });
    confirmView.replaceChildren(form); confirmView.showModal(); (field || cancel).focus();
  });
}
const askConfirm = options => confirmDialog(options).then(value => value === true);
// Esc closes the dialog as a cancel, except while its action is running.
confirmView.addEventListener('cancel', event => { if (confirmBusy) event.preventDefault(); });
confirmView.addEventListener('close', () => { if (!confirmView.open) settleConfirm?.(null); });
const taskView = dialog('task-view', `<div class="view-head"><div class="title-group"><h2 id="task-title"></h2><span id="task-badges" class="actions"></span></div><div id="task-actions" class="actions"></div></div>
<p id="task-error" class="view-error" role="alert"></p>
<div class="task-layout"><section class="timeline-panel" aria-labelledby="timeline-heading"><h3 id="timeline-heading">Agent 工作过程</h3><ol id="timeline" class="timeline"></ol><div id="timeline-command" class="step step-running" aria-live="off" hidden></div><p id="timeline-live" class="live" role="status" hidden></p></section><aside id="task-side" class="task-side" aria-label="任务信息"></aside></div>`);
taskView.setAttribute('aria-labelledby', 'task-title');

let openTaskId = null, taskTimer = null, renderedLogs = new Set(), liveCommand = null;
async function openTask(id) {
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
  $('task-badges').replaceChildren(taskState(task), element('span', task.full_name || '仓库 ' + task.repository_id, 'muted'));
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
  if (task.status === 'waiting_configuration' && task.error_code === 'repository_has_no_commit') return emptyRepositoryMessage;
  if(task.status==='waiting_pr_head')return `PR 尚未指向刚推送的提交 ${task.pushed_sha||'（读取中）'}；正在自动重读 PR head，匹配后继续更新 PR 描述。不会重复推送或增加修订轮数。`;
  if (task.status === 'publishing') return '正在发布到 GitHub…';
  if(ownershipErrors[task.error_code])return ownershipErrors[task.error_code]+'；已暂停，不会推送其他作者或分支。';
  if (task.status.startsWith('waiting_') || task.status === 'retry_wait') return `已暂停：${(states[task.status] || [task.status])[0]}${task.error_code ? '（' + task.error_code + '）' : ''}，条件满足后自动继续`;
  return { prepare: '正在准备工作区：拉取固定提交并写入虚拟电脑…', model: 'Agent 正在思考，或在虚拟电脑里执行工具…', validate: '正在虚拟电脑里运行仓库测试…', publish: '正在发布到 GitHub…' }[task.phase] || '执行中…';
}
function renderTimeline(task, logs) {
  let modelStep=0;
  const list = $('timeline'), box = scroller(list.parentElement), first = !list.childElementCount, atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (let log of logs) {let value;try{value=JSON.parse(log.content);}catch{}if(value?.type==='model'){modelStep++;if(!Number.isSafeInteger(value.step))log={...log,content:JSON.stringify({...value,step:modelStep})};}if(!renderedLogs.has(log.id)){renderedLogs.add(log.id);list.append(step(log));}}
  const live = liveText(task); $('timeline-live').hidden = !live; $('timeline-live').textContent = live || '';
  // A finished task opens at its first step; a running one follows the newest step unless the reader scrolled up.
  if (first ? !!live : atBottom) box.scrollTop = box.scrollHeight;
}
function toolCaption(call) {
  let args = {}; try { args = JSON.parse(call.arguments); } catch { /* Long arguments are clipped in the log. */ }
  return { run_command: '执行命令：' + clipText(args.command, 80), read_file: '读取 ' + (args.path || '文件'), write_file: '写入 ' + (args.path || '文件'),
    finish_review: '提交检视结论', create_pull_request: '创建 PR' }[call.name] || call.name;
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
    title.textContent = '读取文件'; add(element('p', `${args.path} · ${result.error || (result.bytes??new TextEncoder().encode(result.content||'').length) + ' 字节'}`));
    if (result.content) add(collapsible('文件内容', result.content));
  } else if (value.type === 'tool' && value.name === 'write_file') {
    title.textContent = '写入文件'; add(element('p', `${args.path} · ${args.bytes??new TextEncoder().encode(args.content||'').length} 字节`));
  } else if (value.type==='tool' && ['finish_review','create_pull_request'].includes(value.name)) {
    title.textContent=value.name==='finish_review'?'提交检视结论':'创建 PR';
    if(args.summary)add(element('p',clipText(args.summary,240)));
    if(args.test_command)add(element('p','测试：'+args.test_command,'muted'));
    add(collapsible('原始 JSON',JSON.stringify({arguments:args,result},null,2)));
  } else if (value.type === 'published') {
    title.textContent = '发布到 GitHub'; const links = element('div', '', 'calls');
    for (const out of value.outputs || []) {
      if (out.labels) out.labels.forEach(name => links.append(element('span', '标签 ' + name, 'call')));
      else if (out.html_url) links.append(link(out.html_url, out.branch ? 'PR · ' + out.branch : out.inline_comments ? `行内检视 · ${out.inline_comments} 条` : /pull\/\d+$/.test(out.html_url) ? 'PR' : '总结评论', 'call call-link'));
    }
    add(links);
  } else if(value.type==='pr_head_wait'){
    title.textContent='等待 GitHub 更新 PR head';add(element('p','已推送 '+value.expected_sha),element('p','当前 PR '+value.observed_sha+'；自动重读，确认后继续。','muted'));
  } else if (value.type === 'completed') { title.textContent = '任务结束'; meta.prepend(state(value.status)); }
  else if (value.type === 'fault') {
    const empty = value.code === 'repository_has_no_commit' && value.state === 'waiting_configuration';
    if (empty) item.classList.replace('step-fault', 'step-waiting');
    title.textContent = empty ? '仓库还没有提交' : '任务暂停或失败'; meta.prepend(empty ? badge('等待首次提交', 'warning') : state(value.state));
    add(element('p', taskErrorText(value.code), 'muted'));
  }
  else if (value.type === 'restart_attempt') { title.textContent = '重新开始一次尝试'; add(element('p', '中断的工作目录保留，新的尝试使用新目录。', 'muted')); }
  else if (value.type === 'runtime_fault') { title.textContent = '运行故障'; add(element('p', value.message || '', 'muted')); }
  else { title.textContent = value.type === 'tool' ? '工具 ' + value.name : '记录'; add(element('pre', log.content, 'output')); }
  return item;
}
function renderTaskSide(detail, environment) {
  const { task, publications } = detail, side = $('task-side'); side.replaceChildren();
  const info = card('任务');
  info.append(facts([['阶段', phaseLabels[task.phase] || task.phase], ['尝试', `第 ${task.attempt} 次`], ['提交', task.head_sha?.slice(0, 12)],
    [task.error_code==='repository_has_no_commit'?'等待原因':'故障', task.error_code==='pr_head_pending'?'PR 尚未指向刚推送的提交':ownershipErrors[task.error_code]||taskErrorText(task.error_code)], ['已推送提交',task.pushed_sha], ['创建', timestamp(task.created_at)], ['更新', timestamp(task.updated_at)]]));
  if (task.source_task_id) info.append(button('查看来源检视', () => openTask(task.source_task_id)));
  side.append(info,taskMetricsCard(task), computerCard(task, environment));
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
  actions.append(button('打开项目机器配置', () => { taskView.close(); openProject(task.repository_id, 'machine'); }), ...environmentButtons(env, current, refreshTask, err => { $('task-error').textContent = err.message; }));
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

taskView.addEventListener('close', () => { clearTimeout(taskTimer); openTaskId = null; });
$('logout').addEventListener('click', () => { if (taskView.open) taskView.close(); });

// Add future project feature switches here; each one updates only its own policy field.
const projectFeatures = [['review_enabled', '检视'], ['development_enabled', '开发']];
function updateProjectTaskPreview(preview, row) {
  preview.replaceChildren(element('span', `执行中 ${row.running_tasks}`, row.running_tasks ? 'task-count-active' : ''));
  if (row.queued_tasks) preview.append(element('span', `排队 ${row.queued_tasks}`, 'muted'));
  preview.title = `正在执行 ${row.running_tasks} 个任务，排队 ${row.queued_tasks} 个任务`;
  preview.setAttribute('aria-label', `${row.full_name}：${preview.title}，查看运行记录`);
}
function projectListControls(row) {
  const registered = row.registered !== false, group = element('div', '', 'project-controls'), features = element('div', '', 'project-features');
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', row.full_name + ' 功能与任务');
  const availability = badge(!registered ? '未启动' : row.enabled ? '已启用' : '已禁用', !registered ? 'info' : row.enabled ? 'success' : 'warning');
  features.append(availability);
  if (row.installed === false) features.append(badge('已移出安装', 'danger'));
  else if (row.installed === null) features.append(badge('不在安装列表'));
  const feedback = element('p', '', 'project-control-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  let pending = false; const switches = [];
  const sync = () => switches.forEach(({control, value, key, caption}) => {
    const on = !!row[key]; control.setAttribute('aria-checked', String(on)); value.textContent = on ? '开' : '关';
    control.disabled = pending || !registered;
    control.title = !registered ? '请先启动项目' : !row.enabled ? '项目已禁用；此开关只保存配置，重新启用项目后才会生效' : row.installed === false ? '项目已移出安装范围；此开关只保存配置' : caption === '开发' ? 'Issue 明确要求改代码时自动开发；只修改 bot 自己的分支' : '检视这个项目的 Issue 和 PR';
  });
  for (const [key, caption] of projectFeatures) {
    const control = button('', async () => {
      if (pending) return; pending = true; sync(); features.setAttribute('aria-busy', 'true'); feedback.className = 'project-control-feedback'; feedback.textContent = `正在保存${caption}…`;
      try {
        const {policy} = await api(`/api/repositories/${row.id}/policy`, 'PATCH', {[key]: !row[key]});
        Object.assign(row, policy); feedback.textContent = `${caption}已${row[key] ? '开启' : '关闭'}${!row.enabled ? '；项目仍已禁用' : ''}`;
      } catch (err) { feedback.classList.add('control-error'); feedback.textContent = `${caption}保存失败：${err.message}`; }
      finally { pending = false; features.removeAttribute('aria-busy'); sync(); }
    }, 'project-feature-switch');
    control.setAttribute('role', 'switch'); control.setAttribute('aria-label', row.full_name + ' ' + caption);
    const track = element('span', '', 'switch-track'), value = element('span', '', 'switch-value'); track.setAttribute('aria-hidden', 'true');
    control.append(element('span', caption), track, value); features.append(control); switches.push({control, value, key, caption});
  }
  sync();
  const preview = element(registered ? 'a' : 'span', '', 'project-task-preview');
  if (registered) preview.href = `#/projects/${row.id}/activity`;
  updateProjectTaskPreview(preview, row); features.append(preview); group.append(features, feedback); return group;
}
let projectActivityPending = false;
async function refreshProjectActivity() {
  if (projectActivityPending) return; projectActivityPending = true; const request = renderVersion;
  try {
    const {repositories} = await api(me.role === 'super_admin' ? '/api/installations' : '/api/repositories');
    if (request !== renderVersion || tab !== 'projects' || projectRoute()) return;
    const rows = new Map(repositories.map(row => [row.id, row]));
    for (const line of document.querySelectorAll('#rows .project-list-row')) {
      const row = rows.get(line.dataset.repositoryId); if (row) updateProjectTaskPreview(line.querySelector('.project-task-preview'), row);
    }
  } catch (err) {
    if (request === renderVersion) for (const preview of document.querySelectorAll('#rows .project-task-preview')) preview.title = `任务数更新失败：${err.message}；点击刷新重试`;
  } finally { projectActivityPending = false; }
}

// Installed repositories (super administrator): GitHub shows what is installed; nothing works until it is started here.
function syncSummary(syncs = []) {
  if (!syncs.length) return '尚未同步';
  return syncs.map(s => s.error ? `${s.account_name} 同步失败（${s.error}）` : `${s.account_name} 同步于 ${timestamp(s.synced_at).slice(11, 19)}`).join(' · ');
}
function installedDetail(row) {
  const parts = [row.owner_login || '所有者 ' + row.owner_id, row.private ? '私有' : '公开'];
  if (row.account_name) parts.push(row.account_name + (row.installation_id ? ' 安装 ' + row.installation_id : ''));
  parts.push('仓库 ID ' + row.id);
  if (row.registered && !row.model_id) parts.push('未选模型');
  return parts.join(' · ');
}
function installedBadges(row) {
  const badges = [!row.registered ? badge('未启动', 'info') : !row.enabled ? badge('已禁用', 'warning') : row.review_enabled ? badge('工作中', 'success') : badge('未开检视', 'warning')];
  if (row.installed === false) badges.push(badge('已移出安装', 'danger'));
  else if (row.installed === null) badges.push(badge('不在安装列表'));
  badges.push(permissionBadge(row));
  return badges;
}
// GitHub's own wording for App permissions, shared by the project list and the App permission check.
const permissionNames = { contents: 'Contents', issues: 'Issues', pull_requests: 'Pull requests', statuses: 'Commit statuses', actions: 'Actions', checks: 'Checks', metadata: 'Metadata' };
const accessNames = { read: 'Read-only', write: 'Read and write', admin: 'Admin' }, roleNames = { read: 'Read', triage: 'Triage', write: 'Write' };
function permissionGapText(missing) {
  return missing.map(item => item.permission === 'repository_role' ? `仓库角色需要「${roleNames.write}」，现在「${roleNames[item.current] || item.current || '无'}」`
    : `${permissionNames[item.permission] || item.permission} 需要「${accessNames[item.required] || item.required}」，现在「${item.current ? accessNames[item.current] || item.current : 'No access'}」`).join('；');
}
// A repository the account still lists but with less than the bot needs. Always drawn (hidden when nothing is missing) so
// that a later permission check can swap it in place.
function permissionBadge(row) {
  const missing = row.permission_missing?.length ? row.permission_missing : null, chip = missing ? badge('权限不足', 'warning') : element('span', '');
  if (missing) chip.title = `仍能看到这个仓库，但授予的权限低于所需：${permissionGapText(missing)}。这种仓库不能删除。`; else chip.hidden = true;
  chip.dataset.permission = ''; return chip;
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
  last_super_admin: '不能删除最后一名活跃的超级管理员。',
  account_has_projects: '还有项目使用这个账号，请先删除这些项目。',
};
function removalMessage(err) {
  const code = String(err.message).replace(/^\d+\s*·\s*/, '');
  return removalErrors[code] || (code.startsWith('github_') ? `无法向 GitHub 核对（${code}），记录保留，没有删除。` : err.message);
}
// The server asks GitHub again before deleting; the badges on the list are never enough. A refusal stays in the dialog.
async function deleteProject(row, after) {
  const check = '删除前会当场向 GitHub 核对：只有仓库已删除，或当前账号已完全不能访问它（已移出安装、安装被暂停、读取返回 404 或 403）时才会删除。仍能访问（包括权限不足），或 GitHub 暂时无法核对时，记录保留。';
  const body = row.registered === false ? [check, '这个仓库从未启动，只去掉安装列表里的这一行。以后安装同步如果又看到它，会像新仓库一样出现。']
    : [check, '删除后：', ['这个项目从项目列表消失', '正在执行的任务会停止', '虚拟电脑的容器和网络会去掉', '工作卷按现有环境删除保留，重置留下的旧代次卷也保留',
      '项目的策略、成员分配、专属模型、外部执行客户端、任务记录、投递和看板数据一并删除，操作审计保留'], '以后安装同步如果又看到这个仓库，它会像新仓库一样出现。'];
  const deleted = await askConfirm({ title: `${row.registered === false ? '从项目列表删除' : '删除项目'} ${row.full_name}？`, body, action: '删除', danger: true,
    progress: `正在向 GitHub 核对 ${row.full_name}…`, run: () => api(`/api/installations/${row.id}`, 'DELETE', { confirm: true }).catch(err => { throw new Error(removalMessage(err)); }) });
  if (deleted) await after();
  return deleted;
}
const gateLabels = { none: ['门禁未接入', 'info'], configured: ['门禁已配置', 'warning'], live: ['门禁已生效', 'success'], unknown: ['门禁未知', 'info'] };
const dashboardLabels = { none: ['看板未接入', 'info'], registered: ['看板待发布', 'warning'], published: ['看板已接入', 'success'], unknown: ['看板未知', 'info'] };
function integrationChip(caption, tone, href, title) {
  if (!href) { const chip = badge(caption, tone); if (title) chip.title = title; return chip; }
  const link = element('a', caption, `status status-${tone} status-link`);
  link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = title || href;
  return link;
}
function isBoardRepository(row) { return /-board$/.test(String(row?.full_name || '').split('/')[1] || ''); }
function installedIntegration(integration, row) {
  if (row && isBoardRepository(row)) {
    const [owner = '', name = ''] = String(row.full_name).split('/');
    return [integrationChip('看板仓', 'info', `https://${owner}.github.io/${name}/`, '接入流程生成的看板仓库，不需要再接入')];
  }
  let chips = [badge('接入未检查', 'info')];
  if (integration) {
    const gate = gateLabels[integration.gate_state] || gateLabels.unknown, dashboard = dashboardLabels[integration.dashboard_state] || dashboardLabels.unknown;
    chips = [integrationChip(gate[0], gate[1], integration.gate_url, integration.gate_detail),
      integrationChip(dashboard[0], dashboard[1], integration.dashboard_url, integration.dashboard_detail)];
  }
  // Marked so that updateIntegrationChips can swap them in place.
  chips.forEach(chip => { chip.dataset.integration = ''; });
  return chips;
}
// Replaces the gate and dashboard chips of rows already on the list; nothing else in a row is redrawn.
function updateIntegrationChips(integrations) {
  const byId = new Map(integrations.map(item => [item.repository_id, item]));
  for (const line of document.querySelectorAll('#rows .project-list-row')) {
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
  // Gate PR, board repository and dashboard registration live in one dialog and run item by item.
  if (!isBoardRepository(row)) actions.append(button('公共配置', () => openQuickstart(row, after), ''));
  if (!row.registered && row.installed) actions.append(button('启动', () => openActivation(row, after), ''));
  // Review has its own switch; this action resumes a disabled project.
  if (row.registered && !row.enabled) actions.append(button('启用', () => call('activate', {}, `正在启用 ${row.full_name}…`)));
  if (row.registered && row.enabled) actions.append(button('禁用', async () => {
    if (await askConfirm({ title: `禁用 ${row.full_name}？`, body: ['新的 Issue／PR 不再处理，正在执行的任务会中止，虚拟电脑停止但数据保留，之后可以再启用。'], action: '禁用', danger: true }))
      call('disable', {}, `正在禁用 ${row.full_name}…`);
  }));
  if (row.registered) actions.append(button('设置', () => openProject(row.id)));
  // Only a repository the list no longer shows as installed can be deleted; the server checks with GitHub again.
  if (row.installed !== true) actions.append(button('删除', () => deleteProject(row, after), 'quiet destructive'));
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

// Shared configuration: the gate PR, the board repository and the dashboard registration. Each item has its own checks
// and can run alone; running all of them still lets an item that cannot run stop without stopping the others.
const quickstartView = document.createElement('dialog'); quickstartView.id = 'quickstart-view'; quickstartView.setAttribute('aria-labelledby', 'quickstart-title');
quickstartView.innerHTML = `<h2 id="quickstart-title">公共配置</h2>
<p class="muted" id="quickstart-hint"></p>
<p id="quickstart-preflight" class="muted"></p>
<ol id="quickstart-steps" class="quickstart-steps"></ol>
<p id="quickstart-error" class="view-error" role="alert"></p>
<div class="actions"><button type="button" id="quickstart-start">全部执行</button><button type="button" class="quiet" id="quickstart-close">关闭</button></div>`;
document.body.append(quickstartView);
let quickstartRow = null, quickstartAfter = null, quickstartTimer = null, quickstartState = { run: null, items: {} }, quickstartWasBusy = false;
const quickstartStepStatus = { pending: '等待', running: '进行中', done: '完成', skipped: '跳过', blocked: '需人工', failed: '失败' };
const quickstartErrors = { board_repository: '这是看板仓库，不需要配置；请对源码仓操作。', repository_not_found: 'GitHub App 读不到这个仓库。',
  github_app_required: '公共配置只使用 GitHub App 安装令牌；这个仓库挂在机器人账号上。', github_credentials_missing: 'GitHub App 账号没有保存私钥。' };
const quickstartBusy = run => !!run && ['running', 'queued'].includes(run.state);
function quickstartItemList(row) {
  // The board repository lives in the GitHub App's organization, named after the source owner and repository.
  const boardName = row.full_name.replace('/', '-') + '-board';
  return [['gate_pr', '门禁 PR', '给源码仓开一个 PR，加入 CI-workflow 门禁和工作流，合入后门禁生效。'],
    ['board', '看板仓库', `在 GitHub App 所属组织下创建 ${boardName}，开启 GitHub Pages（站点形如 https://<App 所属组织>.github.io/${boardName}/）。只接受公开仓库。`],
    ['dashboard', 'Dashboard 登记', '向公共 dashboard 提登记 PR。需要同一个 GitHub App 也安装在 dashboard 仓库，并且看板仓库已经就绪。']];
}
function renderQuickstart() {
  if (!quickstartRow) return;
  const { run, items } = quickstartState, busy = quickstartBusy(run), preflight = run?.steps?.find(item => item.id === 'preflight');
  $('quickstart-preflight').textContent = preflight && preflight.status !== 'pending' ? `预检 · ${quickstartStepStatus[preflight.status] || preflight.status}：${preflight.detail}` : '';
  const list = $('quickstart-steps'); list.replaceChildren();
  for (const [id, title, description] of quickstartItemList(quickstartRow)) {
    // While a run is active, its own steps show live progress; otherwise each item shows its latest result.
    const item = (busy && run.steps.find(entry => entry.id === id && entry.selected !== false)) || items[id];
    const li = element('li', '', 'quickstart-step');
    li.append(element('strong', `${title} · ${item ? (quickstartStepStatus[item.status] || item.status) : '未执行'}`), element('p', description, 'muted'));
    if (item) li.append(element('p', item.detail));
    if (item?.url) { const link = element('a', '查看详情', 'result-link'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; li.append(link); }
    const execute = button('执行', () => startQuickstart([id])); execute.disabled = busy; execute.setAttribute('aria-label', '执行' + title); li.append(execute);
    list.append(li);
  }
  // Item problems are explained on the item; only a run the preflight stopped needs a message here.
  const stopped = run && preflight && ['blocked', 'failed'].includes(preflight.status);
  $('quickstart-error').textContent = stopped ? quickstartErrors[run.error] || run.error || '' : '';
  $('quickstart-start').disabled = busy;
}
async function refreshQuickstart() {
  if (!quickstartRow) return;
  const value = await api(`/api/projects/${quickstartRow.id}/quickstart`);
  quickstartState = { run: value.run, items: value.items || {} }; renderQuickstart();
  clearTimeout(quickstartTimer);
  if (quickstartBusy(value.run)) { quickstartWasBusy = true; quickstartTimer = setTimeout(() => refreshQuickstart().catch(() => {}), 1500); }
  else if (quickstartWasBusy) { quickstartWasBusy = false; if (quickstartAfter) quickstartAfter(); }
}
async function startQuickstart(steps) {
  if (!quickstartRow) return;
  $('quickstart-error').textContent = ''; $('quickstart-start').disabled = true;
  try { await api(`/api/projects/${quickstartRow.id}/quickstart`, 'POST', steps ? { steps } : {}); quickstartWasBusy = true; await refreshQuickstart(); }
  catch (err) { $('quickstart-error').textContent = err.message; $('quickstart-start').disabled = false; }
}
async function openQuickstart(row, after) {
  quickstartRow = row; quickstartAfter = after; quickstartState = { run: null, items: {} }; quickstartWasBusy = false;
  $('quickstart-title').textContent = '公共配置 · ' + row.full_name;
  $('quickstart-hint').textContent = '三项可以单独执行，也可以全部执行；某一项条件不满足只停这一项，其他照常进行。全程使用 GitHub App 安装令牌，缺少权限时在对应项里列出。';
  $('quickstart-error').textContent = ''; renderQuickstart();
  quickstartView.showModal();
  try { await refreshQuickstart(); } catch {}
}
$('quickstart-close').addEventListener('click', () => { clearTimeout(quickstartTimer); quickstartRow = null; quickstartView.close(); });
$('quickstart-start').addEventListener('click', () => startQuickstart(null));
