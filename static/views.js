// Task process and project computer views. Loaded after app.js and reuses its helpers ($, api, element, state, states, timestamp).
const terminalStates = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed'];
const kindLabels = { 'review.issue': '检视 Issue', 'review.pr': '检视 PR', 'development.issue': '开发 Issue', 'development.pr': '跟进 bot PR', 'release.observe': 'CI 观察', 'release.notes': '发行说明', 'actions.failures': 'Actions 失败分析',
  'workflow.issue': '自定义工作流 Issue', 'workflow.pr': '自定义工作流 PR' };
const modeLabels = { 'review.issue': '检视', 'review.pr': '检视', 'development.issue': '开发', 'development.pr': '跟进' };
const phaseLabels = { prepare: '准备工作区', model: '模型执行', validate: '测试验证', publish: '发布', done: '完成' };
const publicationLabels = { comment: '总结评论', review: '行内检视（COMMENT）', label: '标签', branch: 'bot 分支', pull_request: 'PR' };
const publicationStates = { sent: ['已发布', 'success'], pending: ['待发布', 'info'], inflight: ['发布中', 'info'], unknown: ['结果待确认', 'warning'], recheck: ['重试前再查一次', 'info'] };
const emptyRepositoryMessage = '仓库还没有提交；默认分支出现提交后会自动继续。';
function taskErrorText(code) { return code === 'repository_has_no_commit' ? emptyRepositoryMessage : code; }
// The cause says whose move it is (a passing outage, a GitHub setting, the bot itself); the code stays for searching logs.
function faultSummary(code, cause) { return code === 'repository_has_no_commit' || !cause ? taskErrorText(code) : `${cause.label}（${code}）`; }
// What a project computer's fault code means.
const environmentErrors = {
  manager_unavailable: '连不上虚拟电脑管理服务（manager）', recovery_failed: '容器停止后没能恢复', provision_failed: '创建虚拟电脑失败',
  operation_failed: '操作中途失败，电脑已停止', reset_interrupted: '重置被 manager 重启打断，需要再次重置', runner_not_ready: '容器启动后 runner 没有就绪',
  approved_image_missing: '找不到批准的项目镜像', image_build_failed: '软件包镜像构建失败', docker_operation_failed: 'Docker 拒绝了操作',
  docker_protocol_failed: 'Docker 返回了无法识别的内容', container_not_stopped: '容器没能停止', container_missing: '容器不存在',
  resource_ownership_mismatch: '同名容器、卷或网络不属于这个部署', recovery_required: '容器在命令执行中重启', runner_failed: 'runner 执行请求失败',
  runner_protocol_failed: 'runner 返回了无法识别的内容', environment_not_ready: '电脑还没有就绪', unauthorized: 'manager 拒绝了控制面的内部令牌' };
// Where each code's cause is written down: the control plane logs a manager it cannot reach; a refused internal token is
// logged by neither side; everything else comes from the manager.
const environmentFaultCause = {
  manager_unavailable: '原因见控制面日志：docker compose -p bot logs bot',
  unauthorized: 'bot 和 manager 读到的内部令牌不一致（两边日志都不记录这种拒绝）：检查共用的 internal-keys 卷里的 manager.token，然后重启 bot 和 manager' };
function environmentFault(code) { return code ? `${environmentErrors[code] || '未归类的故障'}（${code}）。${environmentFaultCause[code] || '原因见日志：docker compose -p bot logs manager bot'}` : null; }
function taskState(task) { return task.status === 'waiting_configuration' && task.error_code === 'repository_has_no_commit' ? badge('仓库还没有提交', 'warning') : state(task.status); }

// An event workflow's task has no Issue or PR: it names its summary instead (the release or the Actions run).
function objectLabel(task) { return task.object_number == null ? String(task.summary || kindLabels[task.kind] || task.kind) : `${task.kind.endsWith('.pr') ? 'PR' : 'Issue'} #${task.object_number}`; }
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
// busy: tasks are running on the computer, so stopping it asks for confirmation first.
function environmentButtons(environment, busy, after, report) {
  return [['start', '启动'], ['stop', '停止'], ['reset', '重置']].map(([action, caption]) => {
    const b = button(caption, async () => {
      if (action === 'reset' && !await askConfirm({ title: `重置 ${environment.full_name} 的虚拟电脑？`, body: ['旧工作卷会保留，新环境从空工作卷开始。'], action: '重置', danger: true })) return;
      if (action === 'stop' && busy && !await askConfirm({ title: `停止 ${environment.full_name} 的虚拟电脑？`, body: ['仓库会被停用，正在执行的任务都会中止。'], action: '停止', danger: true })) return;
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
<div id="task-picker" class="task-picker" hidden></div>
<div id="task-layout" class="task-layout"><section class="timeline-panel" aria-labelledby="timeline-heading"><h3 id="timeline-heading">Agent 工作过程</h3><ol id="timeline" class="timeline"></ol><div id="timeline-command" class="step step-running" aria-live="off" hidden></div><p id="timeline-live" class="live" role="status" hidden></p></section><aside id="task-side" class="task-side" aria-label="任务信息"></aside></div>`);
taskView.setAttribute('aria-labelledby', 'task-title');

let openTaskId = null, taskTimer = null, renderedLogs = new Set(), liveCommand = null, snapshotProgress = null;
async function openTask(id) {
  openTaskId = id; renderedLogs = new Set(); liveCommand = null; snapshotProgress = null; $('timeline-command').hidden = true; clearTimeout(taskTimer);
  $('task-picker').hidden = true; $('task-layout').hidden = false;
  for (const part of ['timeline', 'task-side', 'task-badges', 'task-actions']) $(part).replaceChildren();
  $('task-title').textContent = '正在加载…'; notice('task-error'); $('timeline-live').hidden = true;
  if (!taskView.open) taskView.showModal();
  await refreshTask();
}
function openTaskChoices(label, tasks, hasMore = false, onMore = null) {
  openTaskId = null; clearTimeout(taskTimer); $('timeline-command').hidden = true; $('timeline-live').hidden = true; notice('task-error');
  for (const part of ['timeline', 'task-side', 'task-badges', 'task-actions']) $(part).replaceChildren();
  $('task-title').textContent = `${label} · 选择任务`; $('task-actions').append(button('关闭', () => taskView.close()));
  $('task-layout').hidden = true;
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
  try {
    const [detail, { logs }] = await Promise.all([api('/api/tasks/' + id), api('/api/tasks/' + id + '/logs')]);
    const environment = await api('/api/environments/' + detail.task.repository_id).catch(() => null);
    if (openTaskId !== id || !taskView.open) return;
    renderTaskHeader(detail.task); renderTimeline(detail.task, logs); await refreshLive(detail.task); keepOpen($('task-side'), () => renderTaskSide(detail, environment));
    if (!terminalStates.includes(detail.task.status)) taskTimer = setTimeout(refreshTask, detail.task.status.startsWith('waiting_') ? 5000 : 2000);
  } catch (err) { if(openTaskId!==id||!taskView.open)return;if(!$('task-error').childElementCount)notice('task-error',err.message);taskTimer = setTimeout(refreshTask, 5000); }
}
function renderTaskHeader(task) {
  $('task-title').textContent = task.object_number == null ? objectLabel(task) : `${modeLabels[task.kind] || task.kind} · ${objectLabel(task)}`;
  $('task-badges').replaceChildren(taskState(task), element('span', task.full_name || '仓库 ' + task.repository_id, 'muted'));
  const actions = $('task-actions'), url = githubUrl(task); actions.replaceChildren();
  if (url) actions.append(link(url, '在 GitHub 打开', 'button-link'));
  if (retryableStates.includes(task.status)) actions.append(button('重试', async event => {
    event.currentTarget.disabled = true;
    try { await api('/api/tasks/' + task.id + '/retry', 'POST', {}); if(openTaskId===task.id){notice('task-error');notice('message');} }
    catch (err) { if(openTaskId===task.id)notice('task-error',retryErrorText(err)); }
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
  const next = task.error_cause?.attempt_retry && task.next_run_at ? `下次重试：${timestamp(task.next_run_at)}。` : '';
  if (task.status === 'waiting_configuration' && task.error_code === 'repository_has_no_commit') return emptyRepositoryMessage;
  if(task.status==='waiting_pr_head')return `PR 尚未指向刚推送的提交 ${task.pushed_sha||'（读取中）'}；正在自动重读 PR head，匹配后继续更新 PR 描述。不会重复推送或增加修订轮数。`;
  if (task.status === 'publishing') return '正在发布到 GitHub…';
  if(ownershipErrors[task.error_code])return ownershipErrors[task.error_code]+'；已暂停，不会推送其他作者或分支。';
  if (task.status.startsWith('waiting_') || task.status === 'retry_wait' || task.status === 'needs_replan') {
    const caption = (states[task.status] || [task.status])[0], cause = task.error_cause;
    if (!cause) return `已暂停：${caption}${task.error_code ? '（' + task.error_code + '）' : ''}`;
    const count = !cause.retry_cycle && task.status === 'retry_wait' && task.error_code !== 'github_rate_limited' && task.retry_count ? `同一种失败已连续出现 ${task.retry_count} 次，满 5 次后改为每 8 小时重试。` : '';
    return `已暂停：${caption} · ${cause.label}（${task.error_code}）。${count}${cause.action}${next}`;
  }
  return { prepare: '正在准备工作区：拉取固定提交并写入虚拟电脑…', model: 'Agent 正在思考，或在虚拟电脑里执行工具…', validate: '正在虚拟电脑里运行仓库测试…', publish: '正在发布到 GitHub…' }[task.phase] || '执行中…';
}
function renderTimeline(task, logs) {
  let modelStep=0;
  const list = $('timeline'), box = scroller(list.parentElement), first = !list.childElementCount, atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (let log of logs) {
    let value;try{value=JSON.parse(log.content);}catch{}
    if(value?.type==='model'){modelStep++;if(!Number.isSafeInteger(value.step))log={...log,content:JSON.stringify({...value,step:modelStep})};}
    if(renderedLogs.has(log.id))continue;
    renderedLogs.add(log.id);
    if(value?.type==='phase'&&value.phase==='prepare'||['snapshot_progress','snapshot_skipped','snapshot_git','snapshot'].includes(value?.type)){
      appendSnapshotProgress(list,log,value);continue;
    }
    if(snapshotProgress){
      if(value?.type==='prepared'||value?.type==='phase'&&value.phase!=='prepare'){
        snapshotProgress.prepared=true;setSnapshotStatus(snapshotProgress,'succeeded');
      }else if(value?.type==='fault'&&!snapshotProgress.prepared)setSnapshotStatus(snapshotProgress,value.state);
    }
    list.append(step(log));
  }
  if(snapshotProgress)setSnapshotStatus(snapshotProgress,snapshotProgress.prepared?'succeeded':task.status);
  const live = liveText(task); $('timeline-live').hidden = !live; $('timeline-live').textContent = live || '';
  // A finished task opens at its first step; a running one follows the newest step unless the reader scrolled up.
  if (first ? !!live : atBottom) box.scrollTop = box.scrollHeight;
}
function setSnapshotStatus(progress,status) {
  const waiting=status?.startsWith('waiting_')||status==='retry_wait'||status==='needs_replan';
  progress.status.replaceChildren(waiting?badge('已暂停','warning'):state(status));
}
function snapshotMessage(value) {
  if(value.type!=='snapshot')return value.detail||({snapshot_progress:`已写入 ${value.files} 个文件，${value.bytes} 字节；刚写完 ${value.path}`,
    snapshot_skipped:`已跳过路径 ${value.path}：${value.reason}`,snapshot_git:`正在构建本地 Git 树：${value.tree_sha}`}[value.type]||'正在准备仓库快照…');
  const lines=[`提交 ${value.sha} · 已接收 ${value.files} 个文件，${value.bytes} 字节 · 跳过 ${value.skipped} 项`];
  if(value.source)lines.push(value.source==='git_cache'?(value.cache==='hit'?'文件来自仓库 Git 缓存，这个提交已缓存，没有访问 GitHub。':'文件来自仓库 Git 缓存，本次从 GitHub 拉取了这个提交。')
    :value.cache==='unavailable'?'Git 缓存不可用，文件经 GitHub API 逐个读取。':'文件经 GitHub API 逐个读取。');
  if(value.directory_fallback)lines.push('递归树被截断，已改为逐目录列举。');
  if(value.detail)lines.push(value.detail);
  return lines.join('\n');
}
function appendSnapshotProgress(list,log,value) {
  // One DOM node per preparation keeps the reader's fold and scroll position across polling updates.
  if(!snapshotProgress||value.type==='phase'||value.sha&&snapshotProgress.sha&&value.sha!==snapshotProgress.sha){
    const item=element('li','','step step-snapshot'),details=element('details','','snapshot-progress'),summary=element('summary','');
    const head=element('span','','snapshot-heading'),status=element('span','','step-meta'),time=element('time',''),latest=element('span','','snapshot-latest');
    const output=element('pre','','output snapshot-output');output.tabIndex=0;output.setAttribute('aria-label','仓库快照实时日志');
    details.open=false;head.append(element('strong','仓库快照进度'),status,time);summary.append(head,latest);details.append(summary,output);item.append(details);list.append(item);
    details.addEventListener('toggle',()=>{if(details.open)output.scrollTop=output.scrollHeight;});
    snapshotProgress={details,status,time,latest,output,prepared:false};setSnapshotStatus(snapshotProgress,'running');
  }
  if(value.sha)snapshotProgress.sha=value.sha;
  const {output,latest,time}=snapshotProgress,follow=output.scrollHeight-output.scrollTop-output.clientHeight<60,message=snapshotMessage(value);
  if(log.created_at){time.textContent=timestamp(log.created_at).slice(11,19);time.dateTime=log.created_at;time.title=timestamp(log.created_at);}
  latest.textContent=value.type==='snapshot'?`已接收 ${value.files} 个文件 · ${value.bytes} 字节 · 跳过 ${value.skipped} 项`
    :value.type==='snapshot_progress'&&value.files!==undefined?`已写入 ${value.files} 个文件 · ${value.bytes} 字节`
    :value.type==='snapshot_git'?'正在构建本地 Git 树…':message.split('\n')[0];
  output.append((log.created_at?'['+time.textContent+'] ':'')+message+'\n');
  if(follow)output.scrollTop=output.scrollHeight;
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
  if (log.created_at) { const time = element('time', timestamp(log.created_at).slice(11, 19)); time.dateTime = log.created_at; time.title = timestamp(log.created_at); meta.append(time); }
  const add = (...nodes) => item.append(...nodes), args = value.arguments || {}, result = value.result || {};
  if (value.type === 'queued') {
    title.textContent = '任务排队日志'; add(element('p', value.detail));
  } else if (value.type === 'phase') {
    title.textContent = {prepare:'工作区准备日志',model:'Agent 执行日志',validate:'仓库测试日志',publish:'GitHub 发布日志'}[value.phase] || '运行阶段日志';
    add(element('p', value.detail));
  } else if (value.type === 'tool_start') {
    title.textContent = '工具开始日志';
    const action={read_file:'读取文件',write_file:'写入文件',run_command:'执行命令',finish_review:'提交检视结论',create_pull_request:'创建 PR',github_read_token:'申请 GitHub 只读令牌'}[value.name] || value.name;
    add(element('p', `正在${action}：${value.path || value.command || value.name}`));
  } else if (value.type === 'prepared') {
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
    const cause = empty ? null : log.cause;
    title.textContent = empty ? '仓库还没有提交' : cause ? '暂停或失败 · ' + cause.label : '任务暂停或失败'; meta.prepend(empty ? badge('等待首次提交', 'warning') : state(value.state));
    if (!cause) add(element('p', taskErrorText(value.code), 'muted'));
    if (value.detail) add(element('p', value.detail, 'say'));
    if (cause) add(element('p', '处理：' + cause.action, 'fault-action'), element('p', '错误码 ' + value.code, 'muted'));
  }
  else if (value.type === 'restart_attempt') { title.textContent = '重新开始一次尝试'; add(element('p', '中断的工作目录保留，新的尝试使用新目录。', 'muted')); }
  else if (value.type === 'runtime_fault') { title.textContent = '运行故障'; add(element('p', value.message || '', 'muted')); if (value.where) add(collapsible('出错位置', value.where)); }
  else if (value.type === 'agent_failure') { title.textContent = '执行进程失败'; add(element('p', value.detail || '执行进程没有给出原因。', 'say')); if (value.error) add(element('p', '错误码 ' + value.error, 'muted')); }
  else { title.textContent = value.type === 'tool' ? '工具 ' + value.name : '记录'; add(element('pre', log.content, 'output')); }
  return item;
}
function renderTaskSide(detail, environment) {
  const { task, publications } = detail, side = $('task-side'); side.replaceChildren();
  const info = card('任务');
  info.append(facts([['阶段', phaseLabels[task.phase] || task.phase], ['尝试', `第 ${task.attempt} 次`], ['提交', task.head_sha?.slice(0, 12)],
    [task.error_code==='repository_has_no_commit'?'等待原因':'故障', task.error_detail||(task.error_code==='pr_head_pending'?'PR 尚未指向刚推送的提交':ownershipErrors[task.error_code]||taskErrorText(task.error_code))],
    ['原因', task.error_code&&task.error_code!=='repository_has_no_commit'&&task.error_cause?faultSummary(task.error_code,task.error_cause):null], ['处理', task.error_code!=='repository_has_no_commit'?task.error_cause?.action:null], ['已推送提交',task.pushed_sha], ['创建', timestamp(task.created_at)], ['更新', timestamp(task.updated_at)]]));
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
  const env = environment.environment, pc = env.computer || {}, running = environment.running_tasks || [];
  const others = running.filter(other => other.id !== task.id).length, mine = running.length > others;
  const usage = mine ? (others ? `本任务正在使用，另有 ${others} 个任务同时执行` : '本任务正在使用') : running.length ? `正在执行 ${running.length} 个任务` : '空闲';
  const head = element('div', '', 'actions'); head.append(state(env.state), element('span', usage, 'muted')); section.append(head);
  section.append(facts([['容器', pc.container], ['代次', task.generation && env.generation && task.generation !== env.generation ? `当前 g${env.generation}，本任务用 g${task.generation}` : env.generation ? 'g' + env.generation : '待创建'],
    ['资源', pc.cpus ? `${pc.cpus} CPU · ${pc.memory_mb} MB 内存 · ${pc.pids} 进程` : null], ['网络', networkText(pc)]]));
  const actions = element('div', '', 'actions');
  actions.append(button('打开项目机器配置', () => { taskView.close(); openProject(task.repository_id, 'machine'); }), ...environmentButtons(env, running.length > 0, refreshTask, err => notice('task-error',err.message)));
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

// Project automation switches update their own policy fields; board publication is independent.
const projectFeatures = [['review_enabled', '检视'], ['development_enabled', '开发']];
function updateProjectTaskPreview(preview, row) {
  preview.replaceChildren(element('span', `执行中 ${row.running_tasks}`, row.running_tasks ? 'task-count-active' : ''));
  if (row.queued_tasks) preview.append(element('span', `排队 ${row.queued_tasks}`, 'muted'));
  preview.title = `正在执行 ${row.running_tasks} 个任务，排队 ${row.queued_tasks} 个任务`;
  preview.setAttribute('aria-label', `${row.full_name}：${preview.title}，查看运行状态`);
}
function projectListControls(row) {
  const registered = row.registered !== false, group = element('div', '', 'project-controls'), features = element('div', '', 'project-features');
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', row.full_name + ' 功能与任务');
  const availability = badge(!registered ? '未启动' : row.enabled ? '已启用' : '已禁用', !registered ? 'info' : row.enabled ? 'success' : 'warning');
  features.append(availability);
  if (row.installed === false) features.append(badge('已移出安装', 'danger'));
  else if (row.installed === null) features.append(badge('不在安装列表'));
  const feedback = element('p', '', 'project-control-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  let pending = false, boardSavedAt = 0; const switches = [];
  const sync = () => switches.forEach(({control, value, key, caption}) => {
    const on = !!row[key]; control.setAttribute('aria-checked', String(on)); value.textContent = on ? '开' : '关';
    if (key === 'board_enabled') {
      control.disabled = pending || row.installed !== true;
      control.title = row.installed !== true ? '仓库不在安装范围' : '开启后单仓看板与 Dashboard 汇总无需登录即可访问；未保存选择时公开仓默认开、私有仓默认关，保存后不随可见性变化';
      return;
    }
    control.disabled = pending || !registered;
    control.title = !registered ? '请先启动项目' : !row.enabled ? '项目已禁用；此开关只保存配置，重新启用项目后才会生效' : row.installed === false ? '项目已移出安装范围；此开关只保存配置' : caption === '开发' ? 'Issue 明确要求改代码时自动开发；只修改 bot 自己的分支' : '检视这个项目的 Issue 和 PR';
  });
  const featuresToShow = [...projectFeatures, ...(me.role === 'super_admin' ? [['board_enabled', '看板']] : [])];
  for (const [key, caption] of featuresToShow) {
    const control = button('', async () => {
      if (pending) return; pending = true; sync(); features.setAttribute('aria-busy', 'true'); feedback.className = 'project-control-feedback'; feedback.textContent = `正在保存${caption}…`;
      try {
        if (key === 'board_enabled') {
          const {board} = await api(`/api/installations/${row.id}/board`, 'PATCH', {enabled: !row.board_enabled});
          Object.assign(row, {board_enabled: board.enabled, board_state: board.state, board_url: board.url});
          boardSavedAt = Date.now();
          updateBoardChip(group, row);
          feedback.textContent = board.enabled ? '看板已开启；数据公开可访问' : '看板已关闭；不再公开展示';
        } else {
          const {policy} = await api(`/api/repositories/${row.id}/policy`, 'PATCH', {[key]: !row[key]});
          Object.assign(row, policy); feedback.textContent = `${caption}已${row[key] ? '开启' : '关闭'}${!row.enabled ? '；项目仍已禁用' : ''}`;
        }
      } catch (err) { feedback.classList.add('control-error'); feedback.textContent = `${caption}保存失败：${err.message}`; }
      finally { pending = false; features.removeAttribute('aria-busy'); sync(); }
    }, 'project-feature-switch');
    control.setAttribute('role', 'switch'); control.setAttribute('aria-label', row.full_name + ' ' + caption);
    const track = element('span', '', 'switch-track'), value = element('span', '', 'switch-value'); track.setAttribute('aria-hidden', 'true');
    control.append(element('span', caption), track, value); features.append(control); switches.push({control, value, key, caption});
  }
  group.updateBoard = (next, requestedAt) => {
    if (pending || next.board_enabled === undefined || requestedAt <= boardSavedAt) return;
    Object.assign(row, {board_enabled: next.board_enabled, board_state: next.board_state, board_url: next.board_url});
    sync(); updateBoardChip(group, row);
  };
  sync();
  const preview = element(registered ? 'a' : 'span', '', 'project-task-preview');
  if (registered) preview.href = `#/projects/${row.id}/activity`;
  updateProjectTaskPreview(preview, row); features.append(preview); group.append(features, feedback); return group;
}
let projectActivityPending = false;
async function refreshProjectActivity() {
  if (projectActivityPending) return; projectActivityPending = true; const request = renderVersion, requestedAt = Date.now();
  try {
    const {repositories} = await api(me.role === 'super_admin' ? '/api/installations' : '/api/repositories');
    if (request !== renderVersion || tab !== 'projects' || projectRoute()) return;
    const rows = new Map(repositories.map(row => [row.id, row]));
    for (const line of document.querySelectorAll('#rows .project-list-row')) {
      const row = rows.get(line.dataset.repositoryId); if (row) {
        updateProjectTaskPreview(line.querySelector('.project-task-preview'), row);
        line.querySelector('.project-controls')?.updateBoard?.(row, requestedAt);
      }
    }
  } catch (err) {
    if (request === renderVersion) for (const preview of document.querySelectorAll('#rows .project-task-preview')) preview.title = `任务数更新失败：${err.message}；点击刷新重试`;
  } finally { projectActivityPending = false; }
}

// Installed repositories: automation needs activation; board publication has its own switch.
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
  if (row.hidden) badges.push(badge('已隐藏', 'info'));
  if (row.installed === false) badges.push(badge('已移出安装', 'danger'));
  else if (row.installed === null) badges.push(badge('不在安装列表'));
  badges.push(permissionBadge(row));
  return badges;
}
// GitHub's own wording for App permissions, shared by the project list and the App permission check.
const permissionNames = { contents: 'Contents', issues: 'Issues', pull_requests: 'Pull requests', statuses: 'Commit statuses', actions: 'Actions', checks: 'Checks', metadata: 'Metadata', workflows: 'Workflows' };
// GitHub's names for the webhook events under Permissions & events → Subscribe to events.
const eventNames = { issues: 'Issues', pull_request: 'Pull request', issue_comment: 'Issue comment', pull_request_review: 'Pull request review', pull_request_review_comment: 'Pull request review comment', workflow_run: 'Workflow run' };
const accessNames = { read: 'Read-only', write: 'Read and write', admin: 'Admin' }, roleNames = { read: 'Read', triage: 'Triage', write: 'Write' };
// Access gaps (access_gaps) name the features they stop; src/app/access.ts holds what each feature needs.
const featureNames = { review: '检视', review_threads: '关闭已修复的行内意见', development: '开发', ci_reads: '任务读取 CI 结果', board: '看板', release: '发版本', gate: '接入门禁', actions_failures: 'Actions 失败分析' };
const featureImpact = {
  review: '读不到代码或发不出检视意见', review_threads: '检视照常发布，但作者修复后的行内意见不会自动关闭', development: '推不了分支、开不了或更新不了 PR', ci_reads: '任务看不到 Actions、检查和提交状态',
  board: '采集不到看板数据', release: '打不了标签、写不了 Release、重跑不了发布运行', gate: '提交不了 .github/workflows 门禁配置 PR',
  actions_failures: '读不到运行、重跑不了外部失败、提报不了 Issue',
};
// What a missing event stops, in the words of the triggers it carries (src/review/queue.ts, src/actions).
const eventImpact = {
  issues: '新 Issue 不检视，编辑后不重新检视，加开发标签不会开始开发，关闭后相关任务不会自动取消',
  issue_comment: 'Issue 和 PR 下的评论不会触发检视跟进', pull_request: 'PR 打开、转为可检视、推送新提交或编辑后不检视，关闭后相关任务不会自动取消',
  pull_request_review: '提交 PR 检视意见后不会触发跟进', pull_request_review_comment: 'PR 行内评论和回复不会触发跟进',
  workflow_run: 'Actions 失败分析在读取运行之前停止：不分类、不重跑、不提报 Issue',
};
const gapLabels = { permission: '权限不足', role: '权限不足', event: '事件未订阅', account: '需要 GitHub App' };
// Whether a stopped feature is in use on this row: on, off, or run by hand (releases and gate PRs have no switch).
function featureState(row, feature) {
  const active = !!row.enabled, on = { review: row.review_enabled, review_threads: row.review_enabled, development: row.development_enabled, ci_reads: row.review_enabled || row.development_enabled,
    board: row.board_enabled, actions_failures: row.actions_failures_enabled }[feature];
  if (feature === 'release' || feature === 'gate') return row.registered === false ? 'off' : 'manual';
  return feature === 'board' ? on ? 'on' : 'off' : active && on ? 'on' : 'off';
}
const stateNames = { on: '已开启', off: '未开启', manual: '手动使用时' };
function gapWhat(gap) {
  if (gap.kind === 'permission') return `${permissionNames[gap.name] || gap.name} 需要「${accessNames[gap.required] || gap.required}」，现在「${gap.current ? accessNames[gap.current] || gap.current : 'No access'}」`;
  if (gap.kind === 'event') return `未订阅事件 ${eventNames[gap.name] || gap.name}`;
  if (gap.kind === 'role') return `机器人账号的仓库角色需要「${roleNames.write}」，现在「${roleNames[gap.current] || gap.current || '无'}」`;
  return '项目挂在机器人账号上，不是 GitHub App 安装';
}
function gapHow(gap, row) {
  const owner = row.owner_login ? `（${row.owner_login}）` : '';
  if (gap.kind === 'permission') return `GitHub App 管理员在 App 设置的 Permissions & events 中把 ${permissionNames[gap.name] || gap.name} 设为「${accessNames[gap.required] || gap.required}」并保存；新增权限要由安装所有者${owner}在 GitHub 的安装设置里接受。App 已经有这项权限时，只需接受安装上的待批准变更。`;
  if (gap.kind === 'event') return `GitHub App 管理员在 App 设置的 Permissions & events → Subscribe to events 勾选 ${eventNames[gap.name] || gap.name} 并保存；所需权限已经授予时，安装无需重新批准。App 已经勾选时，到安装设置接受待批准的变更。`;
  if (gap.kind === 'role') return '在仓库 Settings → Collaborators and teams 把机器人账号的角色改为 Write 或更高。';
  return '这些功能只用 GitHub App 安装令牌。在「接入向导」创建 GitHub App 并安装到这个仓库，项目改用该 App 账号后才能使用。';
}
function gapImpact(gap, row) {
  const used = gap.features.map(feature => `${featureNames[feature] || feature}（${stateNames[featureState(row, feature)]}）`).join('、');
  if (!gap.features.length) return '接入基线要求这一级别；各功能目前用到的级别已经满足，暂不影响使用。';
  if (gap.kind === 'event') return `${eventImpact[gap.name] || '相关触发不会到达'}。涉及：${used}。`;
  return gap.features.map(feature => `${featureNames[feature] || feature}（${stateNames[featureState(row, feature)]}）：${featureImpact[feature] || '无法使用'}`).join('；') + '。';
}
function gapSummary(gap) {
  const names = gap.features.map(feature => featureNames[feature] || feature).join('、');
  return gapWhat(gap) + (names ? `（影响${/^[A-Za-z]/.test(names) ? ' ' : ''}${names}）` : '');
}
// Use the full sync's installation snapshots: one installation can cover many repositories, including hidden ones.
function installationSyncNotice(result) {
  const failed = result.results.filter(row => row.error), installations = result.results.flatMap(row => row.installations || []);
  const gaps = installations.filter(row => row.gaps?.length).map(row => `${row.account || '安装'}（安装 ${row.id}）：${row.gaps.map(gapSummary).join('；')}`);
  // Bot accounts have no installation snapshot; their repositories carry the gaps.
  for (const row of result.repositories || []) if (!row.installation_id && row.access_gaps?.length) gaps.push(`${row.full_name}：${row.access_gaps.map(gapSummary).join('；')}`);
  const parts = [failed.length ? '部分账号同步失败：' + failed.map(row => (accounts.find(account => account.id === row.account_id)?.name || row.account_id) + '（' + row.error + '）').join('、') + '，因此还不能判断全部安装的权限和事件订阅是否正常。'
    : gaps.length ? '安装列表已同步，权限和事件订阅并非全部正常。' : `安装列表已同步，${installations.length} 个安装的权限和事件订阅都正常。`];
  if (gaps.length) parts.push(gaps.join('；') + '。点仓库行上的提示查看处理方法。');
  const appMissing = result.results.some(row => row.app && (row.app.missing?.length || row.app.missing_events?.length || row.app.feature_gaps?.length)), appUnknown = result.results.some(row => row.app?.error);
  if (appMissing)
    parts.push('App 定义仍有缺口，请到「全局设置 → 机器人账号」查看。');
  if (appUnknown) parts.push('App 定义暂时无法核对，请到「全局设置 → 机器人账号」检查。');
  return { text: parts.join(''), tone: failed.length || gaps.length || appMissing || appUnknown ? '' : 'view-success' };
}
function warningIcon() {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'status-icon');
  svg.innerHTML = '<path d="M8 1.4 15.3 14.2H.7z" fill="currentColor"/><path d="M8 5.7v4M8 11.8v.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>';
  return svg;
}
// One dialog lists every gap of a repository: what is missing, how to fix it, and which features it stops.
const accessView = document.createElement('dialog'); accessView.className = 'access-dialog'; accessView.setAttribute('aria-labelledby', 'access-title');
document.body.append(accessView);
function openAccessGaps(row) {
  const title = element('h2', '权限与事件缺口 · ' + row.full_name); title.id = 'access-title';
  const list = element('ol', '', 'access-gaps');
  for (const gap of row.access_gaps) {
    const item = element('li', ''), facts = element('dl', '');
    for (const [term, text] of [['缺少', gapWhat(gap)], ['怎么操作', gapHow(gap, row)], ['会影响什么', gapImpact(gap, row)]]) facts.append(element('dt', term), element('dd', text));
    item.append(facts); list.append(item);
  }
  const close = button('关闭', () => accessView.close(), 'quiet'), actions = element('div', '', 'actions');
  actions.append(close);
  accessView.replaceChildren(title, element('p', '对照所有功能检查，未开启的功能也列出。改完后点「同步安装列表」重新读取。', 'muted'), list, actions);
  accessView.showModal(); close.focus();
}
// Every access gap of a repository the account still lists, against every feature whether or not it is on. Warning tone
// when a stopped feature is on; a gap only for unused features is informational. Always drawn (hidden when nothing is
// missing) so that a later permission check can swap it in place.
function permissionBadge(row) {
  const gaps = row.access_gaps || [], labels = [...new Set(gaps.map(gap => gapLabels[gap.kind]))];
  if (!labels.length) { const chip = element('span', ''); chip.hidden = true; chip.dataset.permission = ''; return chip; }
  const urgent = gaps.some(gap => gap.features.some(feature => featureState(row, feature) === 'on'));
  const chip = button(labels.join(' · '), () => openAccessGaps(row), `status status-${urgent ? 'warning' : 'info'} status-alert`);
  chip.prepend(warningIcon()); chip.dataset.permission = '';
  chip.title = gaps.map(gapSummary).join('；') + '。点击查看处理方法。';
  chip.setAttribute('aria-label', `${labels.join('、')}：${chip.title}`);
  return chip;
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
  project_account_pending: '项目的虚拟电脑或门禁接入还有未完成的操作，稍后再删除。',
};
function removalMessage(err) {
  const code = String(err.message).replace(/^\d+\s*·\s*/, '');
  return removalErrors[code] || (code.startsWith('github_') ? `无法向 GitHub 核对（${code}），记录保留，没有删除。` : err.message);
}
// The server asks GitHub again before deleting; the badges on the list are never enough. A refusal stays in the dialog.
async function deleteProject(row, after) {
  const check = '删除前会当场向 GitHub 核对：只有仓库已删除，或当前账号已完全不能访问它（已移出安装、安装被暂停、读取返回 404 或 403）时才会删除。仍能访问（包括权限不足），或 GitHub 暂时无法核对时，记录保留。';
  const body = row.registered === false ? [check, '这个仓库从未启动，只去掉安装列表里的这一行。以后安装同步如果又看到它，会像新仓库一样出现。']
    : [check, '删除后：', ['这个项目从项目列表消失', '正在执行的任务会停止', '虚拟电脑的容器和网络、项目长期笔记及其卷会删除', '工作卷按现有环境删除保留，重置留下的旧代次卷也保留',
      '项目的策略、成员分配、专属模型、外部执行客户端、任务记录、投递和看板数据一并删除，操作审计保留'], '以后安装同步如果又看到这个仓库，它会像新仓库一样出现。'];
  const deleted = await askConfirm({ title: `${row.registered === false ? '从项目列表删除' : '删除项目'} ${row.full_name}？`, body, action: '删除', danger: true,
    progress: `正在向 GitHub 核对 ${row.full_name}…`, run: () => api(`/api/installations/${row.id}/removal`, 'DELETE', { confirm: true }).catch(err => { throw new Error(removalMessage(err)); }) });
  if (deleted) await after();
  return deleted;
}
// Installed but never started: no project record to delete. Hiding only removes the list row, and sync keeps it hidden.
async function hideInstalled(row, after) {
  const hidden = await askConfirm({ title: `从列表隐藏 ${row.full_name}？`, action: '隐藏', danger: true,
    body: ['只从列表里隐藏这一行；不会卸载 App、不会删除 GitHub 仓库，下次同步也不会再出现（可用“恢复”找回）。'],
    run: () => api(`/api/installations/${row.id}`, 'DELETE', {}).catch(err => { throw new Error(removalMessage(err)); }) });
  if (hidden) await after();
  return hidden;
}
async function restoreInstalled(row, after) {
  try { await api(`/api/installations/${row.id}/restore`, 'POST', {}); $('message').textContent = ''; } catch (err) { error(err); }
  await after();
}
const gateLabels = { none: ['门禁未接入', 'info'], configured: ['门禁已配置', 'warning'], live: ['门禁已生效', 'success'], unknown: ['门禁未知', 'info'] };
function integrationChip(caption, tone, href, title) {
  if (!href) { const chip = badge(caption, tone); if (title) chip.title = title; return chip; }
  const link = element('a', caption, `status status-${tone} status-link`);
  link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = title || href;
  return link;
}
function boardChip(row) {
  const published = row.board_enabled && row.board_state === 'published';
  const chip = integrationChip(!row.board_enabled ? '看板已关闭' : published ? '查看看板' : '看板采集中',
    !row.board_enabled ? 'info' : published ? 'success' : 'warning', published ? row.board_url : null,
    row.board_enabled ? '看板数据公开可访问' : '开启仓库列表中的看板开关后对外提供');
  chip.dataset.boardStatus = ''; return chip;
}
function updateBoardChip(group, row) {
  const current = group.closest('.project-list-row')?.querySelector('[data-board-status]');
  if (current) current.replaceWith(boardChip(row));
}
function installedIntegration(integration, row) {
  const gate = integration ? gateLabels[integration.gate_state] || gateLabels.unknown : null;
  const chip = gate ? integrationChip(gate[0], gate[1], integration.gate_url, integration.gate_detail) : badge('门禁未检查', 'info');
  chip.dataset.integration = '';
  return row ? [chip, boardChip(row)] : [chip];
}
// Gate checks and board publication refresh independently without redrawing the row.
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
  // Gate onboarding is a conversation in static/gate-onboarding.js; boards are managed by the list switch.
  actions.append(button('接入门禁', () => openGateOnboarding(row, after), ''));
  if (!row.registered && row.installed) actions.append(button('启动', () => openActivation(row, after), ''));
  // Review has its own switch; this action resumes a disabled project.
  if (row.registered && !row.enabled) actions.append(button('启用', () => call('activate', {}, `正在启用 ${row.full_name}…`)));
  if (row.registered && row.enabled) actions.append(button('禁用', async () => {
    if (await askConfirm({ title: `禁用 ${row.full_name}？`, body: ['新的 Issue／PR 不再处理，正在执行的任务会中止，虚拟电脑停止但数据保留，之后可以再启用。'], action: '禁用', danger: true }))
      call('disable', {}, `正在禁用 ${row.full_name}…`);
  }));
  if (row.registered) actions.append(button('设置', () => openProject(row.id)));
  // A project still off the installation is deleted only after GitHub confirms the account lost it; a started project can
  // also be deleted here from the control plane alone; an installed but never started repository is only hidden.
  if (row.installed !== true) actions.append(button('删除', () => deleteProject(row, after), 'quiet destructive'));
  else if (row.registered) actions.append(button('删除', () => deleteProjectRecord(row, after), 'quiet destructive'));
  else actions.append(button('删除', () => hideInstalled(row, after), 'quiet destructive'));
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

