
// Commands still use durable, versioned management messages. History and reconnect only read events.
async function renderManagement(panel, projectId = null, onActivity = () => {}, { signal } = {}) {
  const endpoint = '/api/management', user = me.id;
  const projects = (await api(endpoint + '/query', 'POST', { operation: 'list_projects', target: {}, arguments: { limit: 100 } }, { signal })).projects;
  if (!panel.isConnected || me?.id !== user) return null;
  panel.replaceChildren(); panel.className = 'management-panel';
  const header = element('div', '', 'management-scope'), scope = document.createElement('select');
  scope.setAttribute('aria-label', '当前管理作用域');
  const addScope = (value, caption) => { const option = element('option', caption); option.value = value; scope.append(option); };
  addScope('platform', '全部有权访问的项目');
  for (const tenant of new Set(projects.map(p => p.tenant_id).filter(Boolean))) addScope('tenant:' + tenant, '组织 ' + tenant);
  for (const project of projects) addScope('project:' + project.id, project.full_name);
  const conversationKey = () => 'management-conversation:' + user + ':' + scope.value;
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Session still works when storage is disabled. */ } };
  const available = value => [...scope.options].some(option => option.value === value);
  // #480: what the assistant opens on is, in order, the project this page was opened for, the shell picker's project, and
  // the platform scope. A per-user stored scope no longer decides it (and is not rewritten here); 「全部项目」 is platform.
  const defaultScopeOf = () => {
    const shared = typeof consoleDefaultProject === 'function' ? consoleDefaultProject() : null;
    return shared && available('project:' + shared) ? 'project:' + shared : 'platform';
  };
  const scopeName = value => value === 'platform' ? '全部有权访问的项目'
    : (projects.find(project => 'project:' + project.id === value)?.full_name || '组织 ' + value.slice('tenant:'.length));
  // A scope is an override only while it names something the shell default does not. Choosing the default's own project is
  // the default, so it keeps following the picker and the note keeps one wording instead of claiming both at once.
  const isOwnScope = value => value !== defaultScopeOf();
  // #493: one place decides the flag, from the control's value and the default as they are now. The render, applyScope and
  // the note a picker change rewrites all ask here, so the sentence, the control and the flag cannot disagree: a scope that
  // the picker has since made the default stops being an override, and the next change follows it instead of only rewording.
  const syncOverride = () => { scope.dataset.override = isOwnScope(scope.value) ? '1' : ''; };
  scope.value = projectId && available('project:' + projectId) ? 'project:' + projectId : defaultScopeOf();
  syncOverride();
  const scopeNote = element('p', '', 'management-scope-note'), scopeNoteId = 'management-scope-note';
  scopeNote.id = scopeNoteId;
  const scopeCaption = () => {
    const shared = defaultScopeOf();
    if (!isOwnScope(scope.value)) return shared === 'platform'
      ? '生效范围：全部有权访问的项目（顶栏未选项目）' : '生效范围：' + scopeName(shared) + '（顶栏默认）';
    return shared === 'platform'
      ? '生效范围：' + scopeName(scope.value) + '（本页覆盖；顶栏未选项目）'
      : `生效范围：${scopeName(scope.value)}（本页覆盖；顶栏默认：${scopeName(shared)}）`;
  };
  const toolsButton = button('快捷操作', () => showTools(!toolsOpen), 'quiet'); toolsButton.setAttribute('aria-expanded', 'false'); toolsButton.setAttribute('aria-controls', 'management-tools');
  const fresh = button('＋ 新建会话', () => openConversation(true).catch(showAccessError), 'quiet management-new-conversation');
  fresh.setAttribute('aria-label', '新建会话');
  header.append(field('管理范围', scope), fresh, toolsButton); scopeNote.textContent = scopeCaption(); header.append(scopeNote); panel.append(header);
  const sessions = element('details', '', 'management-sessions'), sessionBody = element('div', '', 'management-session-controls');
  sessions.append(element('summary', '会话记录'));
  const conversations = document.createElement('select'); conversations.setAttribute('aria-label', '持久会话');
  sessionBody.append(field('切换会话', conversations)); sessions.append(sessionBody); panel.append(sessions);
  const feed = element('div', '', 'management-feed'); feed.setAttribute('aria-label', '管理会话记录'); feed.setAttribute('role', 'log'); feed.setAttribute('aria-live', 'polite');
  const welcome = element('div', '', 'management-welcome');
  welcome.append(element('span', '✦', 'management-welcome-icon'), element('p', '你的项目工作台', 'management-eyebrow'), element('h3', '一起推进下一步'), element('p', '查进展、找原因、调整配置。执行过程和结果都会在这里实时呈现。', 'muted'));
  const suggestions = element('div', '', 'management-suggestions');
  for (const [caption, text] of [['查看任务进展', '有哪些任务需要处理？'], ['分析阻塞原因', '帮我看看任务为什么没有继续。'], ['了解项目配置', '当前项目的配置是什么？']]) {
    const suggestion = button('', () => { message.value = text; message.focus(); }, 'quiet');
    suggestion.append(element('strong', caption), element('span', text)); suggestions.append(suggestion);
  }
  welcome.append(suggestions); feed.append(welcome);
  const feedWrap = element('div', '', 'management-feed-wrap'), latest = button('↓ 回到最新消息', () => { flushMarkdown(true); scrollOutput(true); }, 'quiet management-latest');
  // Blurring the composer can restore mobile navigation and move this button before pointer-up.
  latest.addEventListener('pointerdown', event => event.preventDefault());
  latest.hidden = true; feedWrap.append(feed, latest); panel.append(feedWrap);
  const tools = element('div', '', 'management-tools'); tools.id = 'management-tools'; tools.hidden = true;
  tools.append(element('h3', '快捷操作'), note('直接查询或使用表单。操作结果会回到对话里。'),
    note('默认配置只影响新任务；补充指令会追加记录。修改目标或验收条件会使旧候选和验收失效。采用新执行配置前，请先暂停并等待旧执行结束。'));
  const actions = element('div', '', 'management-queries'), forms = element('div', '', 'management-forms'); tools.append(actions, forms); panel.append(tools);
  const statusBar = element('div', '', 'management-status-bar'), status = element('p', '正在读取会话…', 'management-status muted'); status.setAttribute('role', 'status');
  const reconnect = button('重新连接', () => read(), 'quiet'); reconnect.hidden = true; statusBar.append(status, reconnect); panel.append(statusBar);
  const input = document.createElement('form'), message = textarea('management-message', '', { rows: 3, placeholder: '发消息，或告诉我你想推进什么…' });
  input.className = 'management-input'; message.setAttribute('aria-label', '管理消息'); message.maxLength = 16000;
  const send = element('button', '发送', 'management-send btn-primary'), stopButton = button('停止', async () => {
    const id = active, owner = conversation; if (!id) return;
    try { await api(endpoint + '/conversations/' + owner + '/messages/' + id + '/stop', 'POST', {}); } catch (err) { showError(err); }
  }, 'quiet');
  send.type = 'submit'; send.disabled = true; stopButton.hidden = true;
  const footer = element('div', '', 'management-input-footer'), controls = element('div', '', 'actions');
  controls.append(stopButton, send); footer.append(element('span', '支持 Markdown · Ctrl / ⌘ + Enter 发送', 'muted'), controls); input.append(message, footer); panel.append(input);
  let conversation = null, cursor = 0, active = null, reading = null, scopeGeneration = 0, streamController = null, formGeneration = 0;
  let disposed = false, opening = false, submitting = false, historyReady = false, toolsOpen = false, toolsDirty = true, followOutput = true, unseenOutput = false, renderFrame = 0;
  const pendingMarkdown = new Set();
  const drafts = new Map(), turns = new Map(), messages = new Map();
  const alive = generation => !disposed && panel.isConnected && me?.id === user && generation === scopeGeneration;
  // #874: one error used to leave this line assertive for good, so every ordinary progress written after it was
  // announced as an alert. Ordinary progress goes through showStatus, which hands the line back to its polite role;
  // showError and showAccessError still give it the alert role for as long as the error stands.
  const showStatus = (text = status.textContent) => { if (disposed) return; status.classList.remove('view-error'); status.setAttribute('role', 'status'); status.textContent = text; };
  const showError = err => { if (!disposed) { status.textContent = readErrorText(err); status.classList.add('view-error'); status.setAttribute('role', 'alert'); } };
  const showAccessError = err => {
    if (disposed) return;
    status.textContent = managementAccessMessage(err);
    status.classList.add('view-error');
    status.setAttribute('role', 'alert');
    welcome.hidden = true;
    const empty = consoleState('无法打开管理会话', managementAccessMessage(err), { tone: 'error', retry: () => openConversation().catch(showAccessError) });
    const reload = empty.querySelector('button'); if (reload) reload.textContent = '重试';
    empty.append(consoleLink('#/projects', '查看项目列表'), consoleLink('#/identity', '查看身份与权限'));
    feed.replaceChildren(empty);
  };
  const selectedWithin = node => {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode));
  };
  const holdingReading = () => selectedWithin(feed) || document.activeElement === message && message.value.length > 0;
  feed.addEventListener('scroll', () => {
    followOutput = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;
    if (followOutput && !holdingReading()) { unseenOutput = false; latest.hidden = true; }
  });
  const scrollOutput = (force = false) => {
    if (force) followOutput = true;
    else if (holdingReading()) followOutput = false;
    if (followOutput) { feed.scrollTop = feed.scrollHeight; unseenOutput = false; }
    latest.hidden = !unseenOutput;
  };
  function flushMarkdown(force = false) {
    renderFrame = 0;
    const top = feed.scrollTop; let rendered = false;
    for (const item of pendingMarkdown) {
      // Replacing a selected answer's DOM would destroy the selection even if scrolling were disabled.
      if (!force && selectedWithin(item.body)) continue;
      renderManagementMarkdown(item.body, item.text); pendingMarkdown.delete(item); rendered = true;
    }
    if (rendered) unseenOutput = true;
    if (!followOutput) feed.scrollTop = top;
    scrollOutput();
  }
  const scheduleMarkdown = () => { if (!renderFrame) renderFrame = requestAnimationFrame(() => flushMarkdown()); };
  const selectionChanged = () => { if (!disposed && panel.isConnected && pendingMarkdown.size && !selectedWithin(feed)) scheduleMarkdown(); };
  document.addEventListener('selectionchange', selectionChanged);
  const queueMarkdown = answer => { pendingMarkdown.add(answer); scheduleMarkdown(); };
  const updateBusy = () => {
    message.disabled = opening || !conversation;
    for (const suggestion of welcome.querySelectorAll('button')) suggestion.disabled = message.disabled;
    send.disabled = opening || !historyReady || submitting || !!active; stopButton.hidden = !active;
    fresh.disabled = opening || submitting; input.classList.toggle('is-running', !!active); onActivity(!!active);
  };
  function showTools(open) {
    toolsOpen = open; tools.hidden = !open; feedWrap.hidden = open; feed.hidden = open; input.hidden = open;
    toolsButton.textContent = open ? '返回对话' : '快捷操作'; toolsButton.setAttribute('aria-expanded', String(open));
    if (open && toolsDirty) void refreshTools();
  }
  async function refreshTools() {
    const generation = scopeGeneration;
    try { await configureForms(); } catch (err) { if (alive(generation)) { toolsDirty = true; forms.replaceChildren(note('快捷操作暂不可用：' + readErrorText(err)), button('重新读取', refreshTools, 'quiet')); } }
  }
  const target = () => scope.value.startsWith('project:') ? { project_id: scope.value.slice(8) } : {};
  const query = (operation, targetValue = target()) => submit({ query: { operation, target: targetValue, arguments: {} } });
  // One pending command at a time across the whole console (#355): opening another preview drops the earlier one, and a
  // write leaves this page only after 确认执行 — for a quick action and for a receipt's rollback alike.
  let pendingPreview = null;
  function previewCommand(slot, command, context) {
    pendingPreview?.(); const drawn = managementPreview(command, context);
    const close = () => { if (pendingPreview === close) pendingPreview = null; slot.replaceChildren(); };
    drawn.cancel.addEventListener('click', close);
    drawn.confirm.addEventListener('click', async () => {
      drawn.confirm.disabled = true;
      if (await submit({ command })) close(); else drawn.confirm.disabled = false;
    });
    pendingPreview = close; slot.replaceChildren(drawn.box); drawn.box.scrollIntoView({ block: 'nearest' });
    return drawn;
  }
  actions.append(button('查询项目', () => query('list_projects', {}), 'quiet'), button('查询任务', () => query('list_tasks'), 'quiet'), button('查询有效配置', () => query('get_effective_config'), 'quiet'), button('成本与预算', () => query('get_usage'), 'quiet'), button('操作审计', () => query('list_audit'), 'quiet'), button('重新连接', () => read(), 'quiet'));
  const turn = id => {
    if (turns.has(id)) return turns.get(id);
    welcome.hidden = true;
    const record = messages.get(id), item = element('article', '', 'management-turn'), request = record?.input;
    if (request) {
      const userMessage = element('div', '', 'management-user');
      userMessage.append(element('strong', '你'), element('p', request.content ?? managementOperationLabels[request.query?.operation ?? request.command?.operation] ?? request.query?.operation ?? request.command?.operation ?? '管理请求')); item.append(userMessage);
    }
    const assistant = element('div', '', 'management-assistant'), avatar = element('span', '✦', 'management-avatar'); avatar.setAttribute('aria-hidden', 'true');
    const content = element('div', '', 'management-assistant-content'), meta = element('div', '', 'management-assistant-meta');
    const badge = element('span', '', 'management-turn-state'), elapsed = element('span', '', 'management-elapsed');
    meta.append(element('strong', '管理助手'), badge, elapsed);
    const progress = element('details', '', 'management-progress'), progressSummary = element('summary', '执行进展'), stepsBody = element('div', '', 'management-steps');
    progress.hidden = true; progress.open = true; progress.append(progressSummary, stepsBody);
    const replies = element('div', '', 'management-replies'); content.append(meta, progress, replies); assistant.append(avatar, content); item.append(assistant); feed.append(item);
    const value = { item, replies, badge, elapsed, progress, progressSummary, stepsBody, steps: [], provisional: null,
      state: record?.state ?? 'pending', stage: '正在连接助手', startedAt: record?.created_at ?? new Date().toISOString(), finishedAt: record?.updated_at, notice: null };
    turns.set(id, value); paintTurn(value); return value;
  };
  function paintTurn(value) {
    const running = ['pending', 'running'].includes(value.state);
    const uncertain = value.steps.some(step => ['unknown', 'executing'].includes(step.state));
    value.badge.textContent = running ? value.stage : { completed: uncertain ? '结果待确认' : value.steps.some(step => step.state === 'failed' || step.state === 'rejected') ? '操作未成功' : '已完成', failed: '处理失败', stopped: '已停止', interrupted: '运行中断' }[value.state] ?? value.state;
    value.badge.dataset.state = running ? 'running' : uncertain ? 'unknown' : value.state;
    const end = running ? Date.now() : Date.parse(value.finishedAt || value.startedAt), seconds = Math.max(0, Math.floor((end - Date.parse(value.startedAt)) / 1000));
    value.elapsed.textContent = seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
    const completed = value.steps.filter(step => step.state === 'succeeded').length;
    value.progressSummary.textContent = '执行进展 · ' + completed + '/' + value.steps.length + ' 步完成';
    value.progress.hidden = !value.steps.length;
    value.item.setAttribute('aria-busy', String(running));
  }
  function finishTurn(value, state, at) {
    value.state = state; value.finishedAt = at;
    if (value.provisional) { value.provisional.node.classList.remove('management-stream'); value.provisional = null; }
    for (const step of value.steps.filter(step => step.state === 'running')) setStepState(step, state === 'completed' ? 'unknown' : 'interrupted');
    if (state === 'interrupted' && !value.notice) {
      value.notice = element('p', '服务重启中断了这次处理。已产生的结果保留在执行进展中，请核对后再继续。', 'management-run-notice'); value.replies.append(value.notice);
    }
    paintTurn(value);
  }
  function answer(value) {
    if (value.provisional) return value.provisional;
    const node = element('article', '', 'management-answer management-stream'), body = element('div', '', 'management-markdown');
    const item = { node, body, text: '' }, actions = element('div', '', 'management-answer-actions');
    const copy = button('复制回答', async () => {
      try { await navigator.clipboard.writeText(item.text); copy.textContent = '已复制'; }
      catch { showError(new Error('复制失败，请选中回答后复制。')); }
    }, 'quiet');
    actions.append(copy); node.append(body, actions); value.replies.append(node); value.provisional = item; return item;
  }
  function setStepState(step, state) {
    step.state = state; step.box.dataset.state = state;
    step.status.textContent = { running: '进行中', succeeded: '已完成', failed: '失败', rejected: '已拒绝', unknown: '待确认', executing: '执行中', interrupted: '结果未确认' }[state] ?? state;
  }
  function toolStep(value, data, sequence) {
    const box = element('details', '', 'management-step'), summary = element('summary', '', 'management-step-summary');
    // The assistant's own independent tasks (#312) are named by their title; the inner queries and commands show as their own steps.
    const own = { start_own_task: '独立任务', continue_own_task: '继续独立任务', list_own_tasks: '查看独立任务' }[data.name];
    const operation = data.arguments?.operation, caption = own ? own + (data.arguments?.title ? '：' + data.arguments.title : '')
      : managementOperationLabels[operation] ?? operation ?? (data.name === 'management_command' ? '执行操作' : '查询事实');
    const indicator = element('span', '', 'management-step-indicator'); indicator.setAttribute('aria-hidden', 'true');
    const state = element('span', '', 'management-step-status'), detail = element('div', '', 'management-step-detail');
    summary.append(indicator, element('span', caption, 'management-step-caption'), state); box.append(summary, detail); value.stepsBody.append(box);
    if (data.arguments) {
      const args = element('details', '', 'management-step-arguments'); args.append(element('summary', '查看请求参数'), element('pre', JSON.stringify(data.arguments, null, 2))); detail.append(args);
    }
    const step = { id: data.call_id ?? 'legacy-' + sequence, box, detail, status: state, name: data.name, state: 'running' };
    value.steps.push(step); setStepState(step, 'running'); paintTurn(value); return step;
  }
  // The event log keeps a receipt as it stood when the call ran, so every rendered receipt re-reads its command before
  // telling the person what is true now; re-reading never repeats the command.
  function commandReceipt(parent, receipt, step, onState = () => {}) {
    const box = element('details', '', 'management-observation management-receipt'), summary = element('summary', ''), body = element('div', '', 'management-receipt-body');
    box.open = true; box.append(summary, body); parent.append(box);
    const view = { box, step, receipt, busy: false };
    const repaint = next => {
      if (next) view.receipt = { ...view.receipt, ...next };
      const value = view.receipt;
      // A failed command carries its own server reason; name the one the console can explain instead of a bare failure.
      const shown = value.state === 'failed' && value.result?.error === 'command_operator_required' ? 'not_operator' : value.state;
      const [caption, explanation] = managementCommandState(shown);
      box.dataset.state = value.state;
      summary.replaceChildren(element('strong', '操作 ' + (managementOperationLabels[value.operation] ?? value.operation)), element('span', ' · ' + caption, 'management-receipt-state'));
      body.replaceChildren(element('p', explanation, 'management-receipt-note'), element('p', '发起人 ' + value.principal_id + ' · 项目 ' + value.project_id + ' · 更新于 ' + timestamp(value.updated_at), 'management-receipt-meta'), element('p', '具体变更：' + (managementOperationLabels[value.operation] ?? value.operation) + '（目标 ' + (value.target?.task_id ?? value.target?.workflow_id ?? value.project_id ?? '—') + '）', 'management-receipt-change'));
      if (value.result?.notice) body.append(element('p', String(value.result.notice)));
      if (value.before_revision) body.append(note('版本 ' + value.before_revision.slice(0, 12) + ' → ' + (value.after_revision ?? value.before_revision).slice(0, 12)));
      if (value.arguments) { const args = element('details', ''); args.append(element('summary', '查看请求参数'), element('pre', JSON.stringify(value.arguments, null, 2))); body.append(args); }
      if (value.result?.diff) { const diff = element('details', ''); diff.append(element('summary', '查看配置差异'), element('pre', JSON.stringify(value.result.diff, null, 2))); body.append(diff); }
      if (value.result?.pr_url) body.append(link(value.result.pr_url, '查看配置 PR（待合入）'));
      // The card stays a summary; the structured, bookmarked view of the same receipt is the page behind this link.
      const links = element('p', ''); links.append(managementReceiptLink('#/management/commands/' + value.id, '回执详情'), ' · ', managementReceiptLink('/api/management/commands/' + value.id, '原始回执（JSON）'));
      if (value.project_id) links.append(' · ', link('#/projects/' + value.project_id + '/roles', '配置'), ' · ', link('#/projects/' + value.project_id + '/activity', '任务'));
      body.append(links);
      const taskId = value.target?.task_id ?? (value.operation === 'task.create' ? value.result?.id : null);
      if (taskId) body.append(button('查看任务', () => openTask(taskId), 'quiet'));
      // A rollback writes too, so it takes the same preview→confirm path as every other console write (#355): the receipt
      // shows the command it would send, and nothing is submitted until 确认执行.
      if (value.result?.rollback && value.state !== 'rejected') {
        const slot = element('div', '', 'management-command-preview-slot');
        body.append(button('按原值回滚', () => previewCommand(slot, value.result.rollback, { project: value.project_id }), 'quiet'), slot);
      }
      if (['unknown', 'executing'].includes(value.state)) body.append(button('对账并回读', reconcile, 'quiet'));
      const details = element('details', ''); details.append(element('summary', '原始事实与回执'), element('pre', JSON.stringify(value, null, 2))); body.append(details);
      onState(value);
    };
    view.paint = repaint;
    // A re-read is read-only: it may repaint the card but never repeats a command.
    const refresh = () => view.receipt.id ? api(endpoint + '/commands/' + view.receipt.id, 'GET').then(next => {
      if (next && panel.isConnected && me?.id === user) repaint(next);
    }).catch(() => { /* Keep the recorded receipt when the re-read fails. */ }) : Promise.resolve();
    async function reconcile() {
      if (view.busy || !view.receipt.id) return;
      view.busy = true; repaint();
      try { repaint(await api(endpoint + '/commands/' + view.receipt.id + '/resume', 'POST', {})); }
      catch (err) { showError(err); }
      finally { view.busy = false; repaint(); }
    }
    repaint();
    void refresh();
    return view;
  }
  const output = (parent, label, value, receipt = false) => {
    const box = element(receipt ? 'details' : 'article', '', 'management-observation' + (receipt ? ' management-receipt' : ' management-answer'));
    box.append(element(receipt ? 'summary' : 'strong', label));
    if (typeof value === 'string') box.append(element('p', value));
    else {
      if (value.task) {
        box.open = true; const task = value.task;
        box.append(element('p', task.summary + ' · ' + (states[task.status]?.[0] ?? task.status)), element('p', '当前阶段：' + (phaseLabels[task.phase] ?? task.phase)));
        if (task.error_code) box.append(element('p', (task.error_cause?.label ?? '等待原因') + ' · ' + task.error_code), element('p', task.error_detail ?? task.error_cause?.description ?? ''));
        box.append(button('查看任务', () => openTask(task.id), 'quiet'), ' · ', link(value.logs_url, '原始日志'), ' · ', link(value.runs_url, '执行记录'));
        if (value.allowed_next_steps?.length) box.append(note('允许的下一步：' + value.allowed_next_steps.map(op => ({ 'task.pause': '暂停', 'task.cancel': '取消', 'task.retry': '重试', 'task.instructions': '追加指令', 'task.contract': '修订目标与验收', 'task.adopt-config': '采用新配置' }[op] ?? op)).join('、')));
      } else if (value.projects) for (const project of value.projects) box.append(element('p', project.full_name + ' · ' + (project.enabled ? '已启用' : '已停用') + (project.configuration_gaps.length ? ' · 待补：' + project.configuration_gaps.join('、') : '')));
      else if (value.tasks) for (const task of value.tasks) box.append(element('p', task.task.summary + ' · ' + (states[task.task.status]?.[0] ?? task.task.status)));
      else if (value.workflows) for (const workflow of value.workflows) box.append(element('p', workflow.name + ' · 生效来源：' + (layerNames[workflow.prompt.source] ?? workflow.prompt.source) + ' · 版本 ' + workflow.prompt.version.slice(0, 12)));
      const details = element('details', ''); details.append(element('summary', '原始事实与回执'), element('pre', JSON.stringify(value, null, 2))); box.append(details);
    }
    parent.append(box); return box;
  };
  function event(row) {
    if (row.sequence <= cursor) return; cursor = row.sequence;
    const data = row.data, currentTurn = turn(row.message_id), replies = currentTurn.replies;
    if (row.type === 'running' || row.type === 'model_start') {
      currentTurn.state = 'running'; currentTurn.stage = data.turn > 0 ? '正在整理结果' : '正在分析请求';
      if (row.type === 'model_start' && currentTurn.provisional) { currentTurn.provisional.node.classList.remove('management-stream'); currentTurn.provisional = null; }
    } else if (row.type === 'tool_call') {
      if (currentTurn.provisional) { currentTurn.provisional.node.classList.remove('management-stream'); currentTurn.provisional = null; }
      const step = toolStep(currentTurn, data, row.sequence);
      currentTurn.stage = step.box.querySelector('.management-step-caption').textContent;
    } else if (row.type === 'tool_result') {
      const receipt = data.result;
      const step = currentTurn.steps.find(item => data.call_id ? item.id === data.call_id : item.name === data.name && item.state === 'running') ?? toolStep(currentTurn, data, row.sequence);
      const ownStep = ['start_own_task', 'continue_own_task', 'list_own_tasks'].includes(step.name);
      setStepState(step, receipt.operation ? receipt.state : ownStep && receipt.error ? 'failed' : 'succeeded');
      if (receipt.operation) commandReceipt(replies, receipt, step, next => { setStepState(step, next.state); paintTurn(currentTurn); });
      else output(step.detail, ownStep ? '独立任务结果' : '查询事实', receipt, true);
      currentTurn.stage = '正在整理结果';
      if (receipt.id && receipt.operation) toolsDirty = true;
      onActivity(!!active, true);
    } else if (row.type === 'reply') {
      const item = answer(currentTurn); item.text = data.text; item.node.classList.remove('management-stream'); queueMarkdown(item); currentTurn.provisional = null;
      onActivity(!!active, true);
    } else if (row.type === 'message') {
      // A progress message the assistant sent while working (#435): its own labelled entry, in order, before the final answer.
      if (currentTurn.provisional) { currentTurn.provisional.node.classList.remove('management-stream'); currentTurn.provisional = null; }
      const item = answer(currentTurn); item.node.classList.remove('management-stream'); item.node.classList.add('management-progress-message');
      item.node.prepend(element('span', '进展消息 ' + data.sequence, 'management-progress-label'));
      item.text = data.text; queueMarkdown(item); currentTurn.provisional = null;
      currentTurn.stage = '已发送进展'; onActivity(!!active, true);
    } else if (row.type === 'model_retry') {
      // The failed attempt's partial answer is not the answer: drop it, the retry writes a new one.
      if (currentTurn.provisional) { currentTurn.provisional.node.remove(); currentTurn.provisional = null; }
      currentTurn.stage = `模型暂时没有响应，正在重试（第 ${data.retry}/${data.retries} 次）`;
    } else if (row.type === 'text') {
      const item = answer(currentTurn); item.text += data.delta ?? ''; queueMarkdown(item);
      currentTurn.stage = '正在回复'; showStatus('助手正在回复…');
    } else if (row.type === 'tool_error') {
      const step = currentTurn.steps.find(item => data.call_id ? item.id === data.call_id : item.name === data.name && item.state === 'running') ?? toolStep(currentTurn, data, row.sequence);
      setStepState(step, currentTurn.state === 'stopped' ? 'interrupted' : 'failed');
      step.detail.append(element('p', '操作未完成：' + data.error, 'management-run-notice'));
    } else if (row.type === 'done') finishTurn(currentTurn, data.state ?? 'completed', row.created_at);
    else if (row.type === 'error' || row.type === 'stopped') {
      finishTurn(currentTurn, row.type === 'error' ? 'failed' : 'stopped', row.created_at);
      if (!currentTurn.notice) {
        currentTurn.notice = element('p', row.type === 'stopped' ? '已停止后续处理。已提交的操作仍保留结果，请在执行进展中核对。' : data.notice ? '这次处理未完成：' + data.notice : data.detail ? '这次处理未完成：' + data.detail + '（' + data.error + '）' : '这次处理未完成：' + data.error + '。可以检查管理助手的模型与权限配置后继续。', 'management-run-notice');
        replies.append(currentTurn.notice);
      }
      onActivity(!!active, true);
    }
    paintTurn(currentTurn); unseenOutput = true; scrollOutput();
  }
  async function read() {
    if (reading || !conversation || disposed) return reading;
    reconnect.hidden = true; showStatus();
    const id = conversation, generation = scopeGeneration;
    const work = (async () => {
      try {
        while (alive(generation) && conversation === id) {
          streamController = new AbortController();
          const page = await api(endpoint + '/conversations/' + id + '/events?after=' + cursor, 'GET', undefined, { signal: streamController.signal });
          if (!alive(generation) || conversation !== id) return;
          for (const message of page.messages) messages.set(message.id, message);
          for (const row of page.events) event(row);
          const pending = page.messages.find(message => ['pending', 'running'].includes(message.state));
          active = pending?.id ?? null; historyReady = !page.has_more; updateBusy();
          if (page.has_more) continue;
          for (const message of page.messages) {
            const value = turn(message.id);
            if (!['pending', 'running'].includes(message.state)) finishTurn(value, message.state, message.updated_at);
          }
          if (!pending) { showStatus('就绪 · 操作结果可在执行进展中核对'); break; }
          showStatus('处理中 · 可以继续写草稿，收起窗口后仍会继续');
          streamController = new AbortController();
          const response = await fetch(endpoint + '/conversations/' + id + '/events?stream=1&after=' + cursor, { signal: streamController.signal });
          if (!response.ok) throw new Error('读取运行流失败，请重新连接。');
          const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
          for (;;) {
            const part = await reader.read(); if (!alive(generation) || conversation !== id) { await reader.cancel(); return; }
            if (part.done) { if (text.trim()) event(JSON.parse(text)); break; } text += decoder.decode(part.value, { stream: true });
            let at; while ((at = text.indexOf('\n')) >= 0) { const line = text.slice(0, at); text = text.slice(at + 1); if (line) event(JSON.parse(line)); }
          }
        }
      } catch (err) { if (alive(generation)) { reconnect.hidden = false; showError(new Error('连接已中断，已提交的操作会继续。点击重新连接以读取进展。' + readErrorText(err))); } }
    })();
    reading = work;
    try { await work; } finally { if (reading === work) reading = null; if (!disposed && generation !== scopeGeneration && conversation) void read(); }
  }
  async function openConversation(create = false, selected = null) {
    if (conversation) drafts.set(conversation, message.value);
    const generation = ++scopeGeneration; formGeneration++; streamController?.abort(); conversation = null; active = null; submitting = false; historyReady = false; opening = true; updateBusy();
    cursor = 0; turns.clear(); messages.clear(); pendingMarkdown.clear(); followOutput = true; unseenOutput = false; latest.hidden = true; reconnect.hidden = true; feed.replaceChildren(welcome); welcome.hidden = false; message.value = '';
    forms.replaceChildren(); toolsDirty = true; showStatus('正在读取会话…');
    try {
      const all = (await api(endpoint + '/conversations')).conversations.filter(item => item.scope === scope.value);
      if (!alive(generation)) return;
      conversations.replaceChildren(...all.map(item => { const option = element('option', timestamp(item.created_at) + ' · ' + item.id.slice(0, 8)); option.value = item.id; return option; }));
      if (create || !all.length) {
        if (!projects.length) {
          showAccessError(Object.assign(new Error(managementAccessHints.scope_forbidden), { code: 'scope_forbidden' }));
          return;
        }
        const result = await api(endpoint + '/conversations', 'POST', { scope: scope.value }); if (!alive(generation)) return;
        conversation = result.conversation.id; const option = element('option', '新会话 ' + conversation.slice(0, 8)); option.value = conversation; conversations.prepend(option);
      } else conversation = all.find(item => item.id === (selected || stored(conversationKey())))?.id ?? all[0].id;
      conversations.value = conversation; remember(conversationKey(), conversation); message.value = drafts.get(conversation) ?? '';
      if (toolsOpen) void refreshTools(); void read();
    } catch (err) {
      if (alive(generation)) showAccessError(err);
    } finally { if (alive(generation)) { opening = false; updateBusy(); } }
  }
  async function submit(body) {
    if (!conversation || opening || !historyReady || submitting || active) return false;
    const id = conversation, generation = scopeGeneration; submitting = true; updateBusy(); showStatus();
    try {
      const result = await api(endpoint + '/conversations/' + id + '/messages', 'POST', { source_message: crypto.randomUUID(), ...body });
      if (!alive(generation) || conversation !== id) return true;
      messages.set(result.id, { input: body, state: result.state, created_at: new Date().toISOString() }); turn(result.id); active = result.id;
      followOutput = true; showTools(false); sessions.open = false; scrollOutput(true); showStatus('请求已发送 · 正在连接助手'); void read(); return true;
    } catch (err) { if (alive(generation)) showError(err); return false; }
    finally { if (alive(generation)) { submitting = false; updateBusy(); } }
  }
  async function configureForms(){
    const generation=++formGeneration; toolsDirty=false;
    // One pending preview at a time: clicking another write replaces it instead of stacking two commands. A confirm that
    // the page cannot send (connection, authorization) keeps the preview so the person can retry or cancel it.
    const previewSlot = element('div', '', 'management-command-preview-slot');
    const confirmCommand = (command, context) => previewCommand(previewSlot, command, context);
    forms.replaceChildren();if(!target().project_id){forms.append(note('选择具体项目后可以修改配置或管理任务。'));return;}
    const project=target().project_id;
    const effective=await api(endpoint+'/query','POST',{operation:'get_effective_config',target:{project_id:project},arguments:{}});
    if(generation!==formGeneration)return;
    const workflow=document.createElement('select');workflow.setAttribute('aria-label','工作类型');
    for(const w of effective.workflows){const o=element('option',w.name+' · '+w.prompt.source);o.value=w.id;workflow.append(o);}
    const prompt=textarea('prompt','',{rows:5});prompt.setAttribute('aria-label','默认提示词');
    const chosen=()=>effective.workflows.find(w=>w.id===workflow.value);
    const fill=()=>{prompt.value=chosen()?.prompt.effective??'';};workflow.onchange=fill;fill();
    const form=document.createElement('form'),save=element('button','保存默认提示词');form.append(element('h3','Manager 章节'),field('工作类型',workflow),field('默认提示词',prompt),note('保存的是 Manager 提示词里这类工作的章节。仓库来源高于控制台层：被覆盖时会保存章节并明确显示实际行为尚未改变；配置 PR 合入后才生效。'),save);
    form.onsubmit=e=>{e.preventDefault();confirmCommand({operation:'workflow.update',target:{project_id:project,workflow_id:workflow.value},arguments:{prompt:prompt.value},expected_revision:effective.revision},{project,workflow:chosen()?.name});};if(chosen()?.prompt.path){const publish=button('创建配置 PR',()=>confirmCommand({operation:'configuration.pr',target:{project_id:project},arguments:{path:chosen().prompt.path,content:prompt.value},expected_revision:effective.revision},{project,workflow:chosen()?.name}),'quiet');form.append(publish);}
    forms.append(form);
    const tasks=(await api(endpoint+'/query','POST',{operation:'list_tasks',target:{project_id:project},arguments:{limit:100}})).tasks;
    if(generation!==formGeneration)return;
    const task=document.createElement('select');task.setAttribute('aria-label','管理任务');
    for(const t of tasks){const o=element('option',t.task.summary+' · '+t.task.status);o.value=t.task.id;task.append(o);}
    const taskBox=element('section','');taskBox.append(element('h3','任务管理'),field('任务',task));
    taskBox.append(button('查看阻塞原因',()=>query('get_task',{project_id:project,task_id:task.value}), 'quiet'));
    for(const [action,caption] of [['pause','暂停任务'],['cancel','取消任务'],['retry','重试任务'],['adopt-config','采用新执行配置']])taskBox.append(button(caption,async()=>{try{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});confirmCommand({operation:'task.'+action,target:{project_id:project,task_id:task.value},arguments:{},expected_revision:current.revision},{project,task:tasks.find(item=>item.task.id===task.value)?.task.summary});}catch(e){status.textContent = readErrorText(e);}},'quiet'));
    const instruction=textarea('instruction','',{rows:2});instruction.setAttribute('aria-label','补充指令');taskBox.append(field('追加补充指令',instruction),button('追加指令',async()=>{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});confirmCommand({operation:'task.instructions',target:{project_id:project,task_id:task.value},arguments:{instruction:instruction.value},expected_revision:current.revision},{project,task:tasks.find(item=>item.task.id===task.value)?.task.summary});},'quiet'));
    forms.append(taskBox, previewSlot);
    if (typeof renderSchedules === 'function') {
      const schedules = element('section', ''); forms.append(schedules);
      try { await renderSchedules(schedules, project); } catch (e) { schedules.append(note('定时计划暂不可用：' + readErrorText(e))); }
    }
  }
  input.onsubmit = async event => {
    event.preventDefault(); const value = message.value, id = conversation;
    if (!value.trim() || !await submit({ content: value })) return;
    // The receipt belongs to the sending conversation even if another one is now visible. Drop the sent draft,
    // but keep any newer text the person composed while waiting for it.
    if (drafts.get(id) === value) drafts.delete(id);
    if (conversation === id && message.value === value) message.value = '';
  };
  message.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); input.requestSubmit(); }
  });
  // One place writes the control, so the note, the "override" state and the conversation always describe the same scope.
  // It reports whether the scope really changed: a control the reader moved has already written the value itself.
  const applyScope = value => {
    const changed = scope.value !== value;
    scope.value = value;
    syncOverride();
    scopeNote.textContent = scopeCaption();
    return changed;
  };
  scope.onchange = () => { applyScope(scope.value); openConversation().catch(showAccessError); };
  conversations.onchange = () => openConversation(false, conversations.value).catch(showAccessError);
  const elapsedTimer = setInterval(() => { for (const value of turns.values()) if (['pending', 'running'].includes(value.state)) paintTurn(value); }, 1000);
  try { await openConversation(); } catch (err) { clearInterval(elapsedTimer); document.removeEventListener('selectionchange', selectionChanged); throw err; }
  return {
    async setScope(value) { if (!available(value)) { showAccessError(Object.assign(new Error('当前账号无权管理这个项目。'), { code: 'scope_forbidden' })); return; } if (applyScope(value)) await openConversation().catch(showAccessError); },
    // #493: a shell-picker change may rewrite the note while an override is active; the control and the conversation stay
    // where the reader put them, and the flag is re-decided here from the default the picker now shows. The note is still
    // the only thing this writes, and applyScope stays the single writer of the control's value.
    refreshScopeNote() { syncOverride(); scopeNote.textContent = scopeCaption(); },
    focus() { if (toolsOpen) toolsButton.focus(); else message.focus(); },
    dispose() { disposed = true; scopeGeneration++; formGeneration++; streamController?.abort(); clearInterval(elapsedTimer); cancelAnimationFrame(renderFrame); document.removeEventListener('selectionchange', selectionChanged); pendingMarkdown.clear(); drafts.clear(); }
  };
}
