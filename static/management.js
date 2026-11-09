// One authenticated chat surface survives page navigation. Minimizing it never cancels a submitted command.
let managementChat = null;
function syncManagementChat() {
  if (managementChat?.user === me?.id && me) return;
  managementChat?.client?.dispose();
  managementChat?.window.remove(); managementChat?.launcher.remove(); managementChat = null;
  if (!me) return;
  const box = element('section', '', 'management-window'); box.id = 'management-chat'; box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'management-chat-title');
  const head = element('div', '', 'management-window-head'), title = element('div', '', 'management-window-title');
  const heading = element('h2', '管理助手'); heading.id = 'management-chat-title';
  title.append(heading, element('p', '聊任务、查进展、调整项目配置'));
  const minimize = button('收起', () => minimizeManagementChat(), 'quiet'); minimize.setAttribute('aria-label', '收起管理助手');
  head.append(title, minimize);
  const panel = element('div', '', 'management-panel'); box.append(head, panel);
  const launcher = button('', () => openManagementChat(), 'management-launcher'); launcher.id = 'management-launcher';
  launcher.setAttribute('aria-controls', box.id); launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-label', '打开管理助手');
  const icon = element('span', '✦', 'management-launcher-icon'); icon.setAttribute('aria-hidden', 'true');
  const label = element('span', '', 'management-launcher-label'), state = element('small', '随时唤起');
  label.append(element('strong', '管理助手'), state); launcher.append(icon, label);
  document.body.append(box, launcher);
  managementChat = { user: me.id, window: box, launcher, panel, state, client: null, loading: null, openVersion: 0, active: false, unread: false };
  box.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); minimizeManagementChat(); }
  });
}
function minimizeManagementChat(focus = true) {
  const chat = managementChat; if (!chat || chat.window.hidden) return;
  chat.window.hidden = true; chat.launcher.hidden = false; chat.launcher.setAttribute('aria-expanded', 'false');
  if (focus) chat.launcher.focus();
}
async function openManagementChat(projectId = null) {
  syncManagementChat(); const chat = managementChat; if (!chat) return;
  const version = ++chat.openVersion;
  // Keep the two existing assistants from covering each other; their sessions continue while minimized.
  const workflow = $('workflow-assistant'); if (workflow) workflow.hidden = true;
  chat.window.hidden = false; chat.launcher.hidden = true; chat.launcher.setAttribute('aria-expanded', 'true'); chat.unread = false;
  const activity = (active, received = false) => {
    if (managementChat !== chat) return;
    chat.active = active; if (received && chat.window.hidden) chat.unread = true;
    chat.state.textContent = active ? '正在处理…' : chat.unread ? '有新回复' : '随时唤起';
    chat.launcher.classList.toggle('has-update', active || chat.unread);
  };
  if (!chat.loading && !chat.client) {
    chat.panel.replaceChildren(note('正在连接管理助手…'));
    chat.loading = renderManagement(chat.panel, projectId, activity).then(client => {
      if (managementChat !== chat) { client?.dispose(); return; }
      chat.client = client;
    }).catch(err => {
      if (managementChat !== chat) return;
      chat.panel.replaceChildren(element('p', '暂时无法连接：' + err.message, 'view-error'), button('重新连接', () => openManagementChat(projectId), 'quiet'));
    }).finally(() => { chat.loading = null; });
  }
  await chat.loading;
  if (managementChat !== chat || version !== chat.openVersion || !chat.client) return;
  if (projectId) await chat.client.setScope('project:' + projectId);
  if (!chat.window.hidden) chat.client.focus();
  activity(chat.active);
}

// Commands still use durable, versioned management messages. History and reconnect only read events.
async function renderManagement(panel, projectId = null, onActivity = () => {}) {
  const endpoint = '/api/management', user = me.id;
  const projects = (await api(endpoint + '/query', 'POST', { operation: 'list_projects', target: {}, arguments: { limit: 100 } })).projects;
  if (!panel.isConnected || me?.id !== user) return null;
  panel.replaceChildren(); panel.className = 'management-panel';
  const header = element('div', '', 'management-scope'), scope = document.createElement('select');
  scope.setAttribute('aria-label', '当前管理作用域');
  const addScope = (value, caption) => { const option = element('option', caption); option.value = value; scope.append(option); };
  addScope('platform', '全部有权访问的项目');
  for (const tenant of new Set(projects.map(p => p.tenant_id).filter(Boolean))) addScope('tenant:' + tenant, '组织 ' + tenant);
  for (const project of projects) addScope('project:' + project.id, project.full_name);
  const scopeKey = 'management-scope:' + user, conversationKey = () => 'management-conversation:' + user + ':' + scope.value;
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Session still works when storage is disabled. */ } };
  const available = value => [...scope.options].some(option => option.value === value);
  scope.value = projectId && available('project:' + projectId) ? 'project:' + projectId : available(stored(scopeKey)) ? stored(scopeKey) : 'platform';
  const toolsButton = button('快捷操作', () => showTools(!toolsOpen), 'quiet'); toolsButton.setAttribute('aria-expanded', 'false'); toolsButton.setAttribute('aria-controls', 'management-tools');
  header.append(field('管理范围', scope), toolsButton); panel.append(header);
  const sessions = element('details', '', 'management-sessions'), sessionBody = element('div', '', 'management-session-controls');
  sessions.append(element('summary', '会话记录'));
  const conversations = document.createElement('select'); conversations.setAttribute('aria-label', '持久会话');
  const fresh = button('新建会话', () => openConversation(true).catch(showError), 'quiet');
  sessionBody.append(field('切换会话', conversations), fresh); sessions.append(sessionBody); panel.append(sessions);
  const feed = element('div', '', 'management-feed'); feed.setAttribute('aria-label', '管理会话记录'); feed.setAttribute('role', 'log'); feed.setAttribute('aria-live', 'polite');
  const welcome = element('div', '', 'management-welcome');
  welcome.append(element('span', '✦', 'management-welcome-icon'), element('h3', '有什么需要我帮你？'), element('p', '可以直接问任务进展，也可以告诉我想调整什么。', 'muted'));
  for (const text of ['有哪些任务需要处理？', '当前项目的配置是什么？']) welcome.append(button(text, () => { message.value = text; message.focus(); }, 'quiet'));
  feed.append(welcome); panel.append(feed);
  const tools = element('div', '', 'management-tools'); tools.id = 'management-tools'; tools.hidden = true;
  tools.append(element('h3', '快捷操作'), note('直接查询或使用表单。操作结果会回到对话里。'),
    note('默认配置只影响新任务；补充指令会追加记录。修改目标或验收条件会使旧候选和验收失效。采用新执行配置前，请先暂停并等待旧执行结束。'));
  const actions = element('div', '', 'management-queries'), forms = element('div', '', 'management-forms'); tools.append(actions, forms); panel.append(tools);
  const status = element('p', '正在读取会话…', 'management-status muted'); status.setAttribute('role', 'status'); panel.append(status);
  const input = document.createElement('form'), message = textarea('management-message', '', { rows: 3, placeholder: '告诉管理助手你想做什么…' });
  input.className = 'management-input'; message.setAttribute('aria-label', '管理消息'); message.maxLength = 16000;
  const send = element('button', '发送'), stopButton = button('停止', async () => {
    const id = active, owner = conversation; if (!id) return;
    try { await api(endpoint + '/conversations/' + owner + '/messages/' + id + '/stop', 'POST', {}); } catch (err) { showError(err); }
  }, 'quiet');
  send.type = 'submit'; send.disabled = true; stopButton.hidden = true;
  const footer = element('div', '', 'management-input-footer'), controls = element('div', '', 'actions');
  controls.append(stopButton, send); footer.append(element('span', 'Ctrl / ⌘ + Enter 发送', 'muted'), controls); input.append(message, footer); panel.append(input);
  let conversation = null, cursor = 0, active = null, reading = null, scopeGeneration = 0, streamController = null, formGeneration = 0;
  let disposed = false, opening = false, submitting = false, historyReady = false, toolsOpen = false, toolsDirty = true;
  const drafts = new Map(), turns = new Map(), messages = new Map();
  const alive = generation => !disposed && panel.isConnected && me?.id === user && generation === scopeGeneration;
  const showError = err => { if (!disposed) { status.textContent = err.message; status.classList.add('view-error'); } };
  const updateBusy = () => {
    message.disabled = opening || !conversation;
    for (const suggestion of welcome.querySelectorAll('button')) suggestion.disabled = message.disabled;
    send.disabled = opening || !historyReady || submitting || !!active; stopButton.hidden = !active; onActivity(!!active);
  };
  function showTools(open) {
    toolsOpen = open; tools.hidden = !open; feed.hidden = open; input.hidden = open;
    toolsButton.textContent = open ? '返回对话' : '快捷操作'; toolsButton.setAttribute('aria-expanded', String(open));
    if (open && toolsDirty) void refreshTools();
  }
  async function refreshTools() {
    const generation = scopeGeneration;
    try { await configureForms(); } catch (err) { if (alive(generation)) { toolsDirty = true; forms.replaceChildren(note('快捷操作暂不可用：' + err.message), button('重新读取', refreshTools, 'quiet')); } }
  }
  const target = () => scope.value.startsWith('project:') ? { project_id: scope.value.slice(8) } : {};
  const query = (operation, targetValue = target()) => submit({ query: { operation, target: targetValue, arguments: {} } });
  actions.append(button('查询项目', () => query('list_projects', {}), 'quiet'), button('查询任务', () => query('list_tasks'), 'quiet'), button('查询有效配置', () => query('get_effective_config'), 'quiet'), button('成本与预算', () => query('get_usage'), 'quiet'), button('操作审计', () => query('list_audit'), 'quiet'), button('重新连接', () => read(), 'quiet'));
  const turn = id => {
    if (turns.has(id)) return turns.get(id);
    welcome.hidden = true;
    const item = element('article', '', 'management-turn'), request = messages.get(id)?.input;
    if (request) {
      const userMessage = element('div', '', 'management-user');
      userMessage.append(element('strong', '你'), element('p', request.content ?? request.query?.operation ?? request.command?.operation ?? '管理请求')); item.append(userMessage);
    }
    const replies = element('div', '', 'management-replies'); item.append(replies); feed.append(item);
    const value = { replies, provisional: null }; turns.set(id, value); return value;
  };
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
      else if (value.operation) {
        box.open = true;
        box.append(element('p', value.result?.notice ?? (value.state === 'succeeded' ? '操作已执行，可回读当前状态。' : value.state === 'awaiting_approval' ? '组织策略要求有权用户批准这个参数与版本。' : '操作未成功：' + (value.result?.error ?? value.state))));
        if (value.before_revision) box.append(note('版本 ' + value.before_revision.slice(0, 12) + ' → ' + (value.after_revision ?? value.before_revision).slice(0, 12)));
        if (value.result?.diff) { const diff = element('details', ''); diff.append(element('summary', '查看配置差异'), element('pre', JSON.stringify(value.result.diff, null, 2))); box.append(diff); }
        if (value.result?.pr_url) box.append(link(value.result.pr_url, '查看配置 PR（待合入）'));
      }
      const details = element('details', ''); details.append(element('summary', '原始事实与回执'), element('pre', JSON.stringify(value, null, 2))); box.append(details);
    }
    parent.append(box); return box;
  };
  function event(row) {
    if (row.sequence <= cursor) return; cursor = row.sequence;
    const data = row.data, currentTurn = turn(row.message_id), replies = currentTurn.replies;
    if (row.type === 'tool_result') {
      const receipt = data.result;
      const box = output(replies, receipt.operation ? `操作 ${receipt.operation} · ${receipt.state}` : '查询事实', receipt, true);
      if (receipt.id && receipt.operation) {
        toolsDirty = true;
        const links = element('p', ''); links.append(link('/api/management/commands/' + receipt.id, '命令回执'));
        if (receipt.project_id) links.append(' · ', link('#/projects/' + receipt.project_id + '/workflows', '配置'), ' · ', link('#/projects/' + receipt.project_id + '/activity', '任务'));
        box.append(links);
        const taskId = receipt.target?.task_id ?? (receipt.operation === 'task.create' ? receipt.result?.id : null);
        if (taskId) box.append(button('查看任务', () => openTask(taskId), 'quiet'));
        if (receipt.result?.rollback) box.append(button('按原值回滚', () => submit({ command: receipt.result.rollback }), 'quiet'));
        if (['unknown', 'executing'].includes(receipt.state)) box.append(button('对账并回读', async () => {
          try { output(replies, '对账回执', await api(endpoint + '/commands/' + receipt.id + '/resume', 'POST', {}), true); } catch (err) { showError(err); }
        }, 'quiet'));
        if (receipt.state === 'awaiting_approval') box.append(button('批准此版本', async () => {
          try { output(replies, '审批结果', await api(endpoint + '/commands/' + receipt.id + '/approval', 'POST', { parameter_hash: receipt.parameter_hash, expected_revision: receipt.expected_revision, decision: 'approve' }), true); } catch (err) { showError(err); }
        }, 'quiet'));
      }
      onActivity(!!active, true);
    } else if (row.type === 'reply') {
      currentTurn.provisional?.remove(); currentTurn.provisional = null;
      output(replies, '管理助手', data.text); onActivity(!!active, true);
    } else if (['error', 'tool_error', 'stopped'].includes(row.type)) output(replies, '运行状态', data, true);
    else if (row.type === 'text') {
      if (!currentTurn.provisional) { currentTurn.provisional = element('p', '', 'management-stream'); replies.append(currentTurn.provisional); }
      currentTurn.provisional.textContent += data.delta ?? ''; status.textContent = '助手正在回复…';
    }
    feed.scrollTop = feed.scrollHeight;
  }
  async function read() {
    if (reading || !conversation || disposed) return reading;
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
          for (const message of page.messages) turn(message.id);
          if (!pending) { status.textContent = '会话已就绪 · 操作结果以回执为准'; break; }
          status.textContent = '管理助手正在处理，收起窗口后仍会继续。';
          streamController = new AbortController();
          const response = await fetch(endpoint + '/conversations/' + id + '/events?stream=1&after=' + cursor, { signal: streamController.signal });
          if (!response.ok) throw new Error('读取运行流失败，请重新连接。');
          const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
          for (;;) {
            const part = await reader.read(); if (!alive(generation) || conversation !== id) { await reader.cancel(); return; }
            if (part.done) break; text += decoder.decode(part.value, { stream: true });
            let at; while ((at = text.indexOf('\n')) >= 0) { const line = text.slice(0, at); text = text.slice(at + 1); if (line) event(JSON.parse(line)); }
          }
        }
      } catch (err) { if (alive(generation)) showError(new Error(err.message + ' 已提交的命令仍可回读，请在快捷操作中重新连接。')); }
    })();
    reading = work;
    try { await work; } finally { if (reading === work) reading = null; if (!disposed && generation !== scopeGeneration && conversation) void read(); }
  }
  async function openConversation(create = false, selected = null) {
    if (conversation) drafts.set(conversation, message.value);
    const generation = ++scopeGeneration; formGeneration++; streamController?.abort(); conversation = null; active = null; submitting = false; historyReady = false; opening = true; updateBusy();
    remember(scopeKey, scope.value); cursor = 0; turns.clear(); messages.clear(); feed.replaceChildren(welcome); welcome.hidden = false; message.value = '';
    forms.replaceChildren(); toolsDirty = true; status.classList.remove('view-error'); status.textContent = '正在读取会话…';
    try {
      const all = (await api(endpoint + '/conversations')).conversations.filter(item => item.scope === scope.value);
      if (!alive(generation)) return;
      conversations.replaceChildren(...all.map(item => { const option = element('option', timestamp(item.created_at) + ' · ' + item.id.slice(0, 8)); option.value = item.id; return option; }));
      if (create || !all.length) {
        const result = await api(endpoint + '/conversations', 'POST', { scope: scope.value }); if (!alive(generation)) return;
        conversation = result.conversation.id; const option = element('option', '新会话 ' + conversation.slice(0, 8)); option.value = conversation; conversations.prepend(option);
      } else conversation = all.find(item => item.id === (selected || stored(conversationKey())))?.id ?? all[0].id;
      conversations.value = conversation; remember(conversationKey(), conversation); message.value = drafts.get(conversation) ?? '';
      if (toolsOpen) void refreshTools(); void read();
    } finally { if (alive(generation)) { opening = false; updateBusy(); } }
  }
  async function submit(body) {
    if (!conversation || opening || !historyReady || submitting || active) return false;
    const id = conversation, generation = scopeGeneration; submitting = true; updateBusy(); status.classList.remove('view-error');
    try {
      const result = await api(endpoint + '/conversations/' + id + '/messages', 'POST', { source_message: crypto.randomUUID(), ...body });
      if (!alive(generation) || conversation !== id) return true;
      messages.set(result.id, { input: body }); turn(result.id); active = result.id; showTools(false); sessions.open = false; void read(); return true;
    } catch (err) { if (alive(generation)) showError(err); return false; }
    finally { if (alive(generation)) { submitting = false; updateBusy(); } }
  }
  async function configureForms(){
    const generation=++formGeneration; toolsDirty=false;
    const submitForm = body => generation === formGeneration ? submit(body) : Promise.resolve(false);
    forms.replaceChildren();if(!target().project_id){forms.append(note('选择具体项目后可以修改配置或管理任务。'));return;}
    const project=target().project_id;
    const effective=await api(endpoint+'/query','POST',{operation:'get_effective_config',target:{project_id:project},arguments:{}});
    if(generation!==formGeneration)return;
    const workflow=document.createElement('select');workflow.setAttribute('aria-label','工作流');
    for(const w of effective.workflows){const o=element('option',w.name+' · '+w.prompt.source);o.value=w.id;workflow.append(o);}
    const prompt=textarea('prompt','',{rows:5});prompt.setAttribute('aria-label','默认提示词');
    const chosen=()=>effective.workflows.find(w=>w.id===workflow.value);
    const fill=()=>{prompt.value=chosen()?.prompt.effective??'';};workflow.onchange=fill;fill();
    const form=document.createElement('form'),save=element('button','保存默认提示词');form.append(element('h3','工作流默认行为'),field('工作流',workflow),field('默认提示词',prompt),note('仓库来源高于控制台层。被覆盖时会保存控制台设置并明确显示实际行为尚未改变；配置 PR 合入后才生效。'),save);
    form.onsubmit=async e=>{e.preventDefault();await submitForm({command:{operation:'workflow.update',target:{project_id:project,workflow_id:workflow.value},arguments:{prompt:prompt.value},expected_revision:effective.revision}});};if(chosen()?.prompt.path){const publish=button('创建配置 PR',()=>submitForm({command:{operation:'configuration.pr',target:{project_id:project},arguments:{path:chosen().prompt.path,content:prompt.value},expected_revision:effective.revision}}),'quiet');form.append(publish);}
    forms.append(form);
    const tasks=(await api(endpoint+'/query','POST',{operation:'list_tasks',target:{project_id:project},arguments:{limit:100}})).tasks;
    if(generation!==formGeneration)return;
    const task=document.createElement('select');task.setAttribute('aria-label','管理任务');
    for(const t of tasks){const o=element('option',t.task.summary+' · '+t.task.status);o.value=t.task.id;task.append(o);}
    const taskBox=element('section','');taskBox.append(element('h3','任务管理'),field('任务',task));
    taskBox.append(button('查看阻塞原因',()=>query('get_task',{project_id:project,task_id:task.value}), 'quiet'));
    for(const [action,caption] of [['pause','暂停任务'],['cancel','取消任务'],['retry','重试任务'],['adopt-config','采用新执行配置']])taskBox.append(button(caption,async()=>{try{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});await submitForm({command:{operation:'task.'+action,target:{project_id:project,task_id:task.value},arguments:{},expected_revision:current.revision}});}catch(e){status.textContent=e.message;}},'quiet'));
    const instruction=textarea('instruction','',{rows:2});instruction.setAttribute('aria-label','补充指令');taskBox.append(field('追加补充指令',instruction),button('追加指令',async()=>{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});await submitForm({command:{operation:'task.instructions',target:{project_id:project,task_id:task.value},arguments:{instruction:instruction.value},expected_revision:current.revision}});},'quiet'));
    forms.append(taskBox);
    if (typeof renderSchedules === 'function') {
      const schedules = element('section', ''); forms.append(schedules);
      try { await renderSchedules(schedules, project); } catch (e) { schedules.append(note('定时计划暂不可用：' + e.message)); }
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
  scope.onchange = () => openConversation().catch(showError);
  conversations.onchange = () => openConversation(false, conversations.value).catch(showError);
  await openConversation();
  return {
    async setScope(value) { if (!available(value)) { showError(new Error('当前账号无权管理这个项目。')); return; } if (scope.value !== value) { scope.value = value; await openConversation(); } },
    focus() { if (toolsOpen) toolsButton.focus(); else message.focus(); },
    dispose() { disposed = true; scopeGeneration++; formGeneration++; streamController?.abort(); drafts.clear(); }
  };
}
