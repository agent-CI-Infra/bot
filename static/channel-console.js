titles.preferences = '设置'; titles.conversations = '飞书会话';

async function renderPreferences(request) {
  const page = $('console-page'), head = element('div', '', 'console-page-head'), groups = element('div', '', 'console-groups');
  head.append(element('p', '个人与项目', 'eyebrow'), element('h1', '设置'), note('管理本人的身份与绑定，或进入当前授权项目的设置。'));
  const personal = card('个人设置'); personal.append(consoleLink('#/identity', '身份与权限', '当前账户、组织与项目授权'),
    consoleLink('#/identity/feishu', '飞书身份绑定', '私聊身份、机器人和群绑定概览'), consoleLink('#/identity/feishu/groups', '群助手设置', '服务角色、项目范围与负责人'));
  const project = card('项目设置'), selector = document.createElement('select'), links = element('div'); selector.setAttribute('aria-label', '要设置的项目');
  selector.add(new Option('选择项目', ''));
  for (const repo of repositories) selector.add(new Option(repo.full_name, repo.id));
  selector.value = consoleScope() || '';
  const draw = () => { links.replaceChildren(); const id = selector.value;
    if (!id) { links.append(note('请选择项目。具体操作按当前账户的项目权限显示。')); return; }
    for (const [key, name] of projectSections.filter(([key]) => ['basic', 'roles', 'model', 'machine', 'members', 'external', 'schedules'].includes(key))) { links.append(consoleLink(`#/projects/${id}/${key}`, name, '仅影响这个项目'));
    }
  }; selector.addEventListener('change', draw); draw(); project.append(field('项目', selector), links);
  groups.append(personal, project); page.replaceChildren(head, groups);
  try {
    const data = await api('/api/channels/bindings');
    if (request === renderVersion && data.can_manage_applications && me.role !== 'super_admin') personal.append(consoleLink('#/identity/feishu-apps', '组织飞书应用', '仅管理当前授权组织的应用'));
  } catch (err) { if (request === renderVersion) personal.append(note('组织应用入口暂不可读取，可刷新重试。')); }
}

async function channelBindingOverview(data) {
  const owner = me, overview = element('section', '', 'feishu-overview'); overview.setAttribute('aria-label', '飞书绑定概览');
  const active = data.bindings.filter(b => b.status === 'active' && (!b.expires_at || b.expires_at > Date.now()));
  const metrics = element('div', '', 'feishu-metrics');
  const metric = (name, value, hint) => { const box = element('div', '', 'feishu-metric'); box.append(element('span', name), element('strong', value), element('small', hint)); metrics.append(box); return box; };
  metric('已绑定身份', String(active.length), '当前账户 ' + me.username);
  const privateCount = metric('本人私聊', '—', '正在读取'), groupCount = metric('维护的群', '—', '正在读取');
  overview.append(metrics);
  const links = element('div', '', 'actions'); links.append(channelLink('#/identity/feishu', '管理身份绑定', 'button-link quiet'),
    channelLink('#/identity/feishu/groups', '管理群助手', 'button-link quiet'), channelLink('#/conversations', '查看飞书会话', 'button-link quiet')); overview.append(links);
  const summary = element('div', '', 'feishu-bound-summary'); overview.append(summary);
  const show = (node, value, hint) => { node.querySelector('strong').textContent = String(value); node.querySelector('small').textContent = hint; };
  void Promise.all([
    api('/api/channels/employees').then(result => {
      const belongs = (binding, chat) => binding.connector === chat.connector_id + ':' + chat.app_id && binding.external_actor === chat.actor_id && binding.external_tenant === chat.actor_tenant;
      const currentChats = result.personal_chats.filter(c => active.some(b => belongs(b, c)));
      show(privateCount, currentChats.length, '当前绑定对应的私聊' + (result.personal_chats.length > currentChats.length ? `；另有 ${result.personal_chats.length - currentChats.length} 个历史会话` : ''));
      for (const b of active) {
        const chats = result.personal_chats.filter(c => belongs(b, c));
        const row = element('div', '', 'feishu-summary-row');
        const name = element('strong', b.display_name && b.display_name !== b.external_actor ? b.display_name : owner.username + ' 的飞书身份');
        const profile = { ...b, binding_id: b.id, can_refresh_name: !!b.can_read_name, display_name: b.display_name !== b.external_actor ? b.display_name : '' };
        row.append(name, channelProfileDetails(profile, () => { name.textContent = channelChatName(profile); }),
          note(chats.length ? `私聊已建立 ${chats.length} 个 · 使用管理助手` : '身份已绑定，尚未建立私聊会话；请给机器人发送一条普通消息。'));
        for (const chat of chats) row.append(channelLink('#/conversations/' + chat.id, '打开私聊会话', 'button-link quiet'));
        summary.append(row);
      }
    }).catch(err => show(privateCount, '未知', '读取失败，可刷新重试')),
    api('/api/channels/service-bindings').then(result => {
      const groups = result.bindings.filter(b => b.can_manage), activeGroups = groups.filter(b => b.enabled);
      show(groupCount, activeGroups.length, `另有 ${groups.length - activeGroups.length} 个已停用；按管理权限统计`);
      if (groups.length) {
        const list = element('details', '', 'fold'); list.append(element('summary', '查看维护的群与绑定范围'));
        for (const b of groups) {
          const row = element('div', '', 'feishu-summary-row'), name = element('strong', channelChatName(b.chat)); row.append(name,
            channelProfileDetails(b.chat, () => { name.textContent = channelChatName(b.chat); }),
            note(`${bindingStates[b.state] || b.state} · ${b.service_role.name || '服务角色已删除'} · ${b.scope.organization?.name || b.scope.repositories.map(r => r.full_name).join('、')}`),
            channelLink('#/conversations/' + b.chat_id, '查看群会话', 'button-link quiet')); list.append(row);
        } summary.append(list);
      }
    }).catch(err => show(groupCount, '未知', '读取失败，可刷新重试'))
  ]);
  return overview;
}

const channelStepLabels = { running: '开始执行', model_start: '请求模型', model_done: '模型已返回', model_request: '模型请求已记录', tool_call: '调用工具', tool_result: '工具已返回', tool_error: '工具调用失败', done: '本轮完成', error: '本轮失败', stopped: '已停止' };
const channelToolLabels = { list_projects: '查看项目范围', list_project_tasks: '查询项目任务', read_project_task: '读取任务', create_project_task: '创建项目任务', manage_project_task: '管理项目任务',
  start_own_task: '开始独立任务', continue_own_task: '继续独立任务', list_own_tasks: '查看独立任务', management_query: '查询管理信息', management_command: '执行管理操作', github_read: '读取 GitHub', github_write: '写入 GitHub', send_message: '发布进展消息' };
const channelTime = value => timestamp(typeof value === 'number' ? value : Date.parse(value));
async function renderChannelConsole(request) {
  const page = $('console-page'), owner = me, address = location.hash, root = element('div', '', 'channel-console');
  const alive = () => renderVersion === request && me === owner && location.hash === address && root.isConnected && root.contains(thread);
  const selected = /^#\/conversations\/([a-f0-9]{48})$/.exec(address)?.[1];
  const head = element('div', '', 'console-page-head'); head.append(element('p', '消息与执行', 'eyebrow'), element('h1', '飞书会话'), note('在同一处查看成员消息、助手执行过程和派生任务。'));
  const layout = element('div', '', 'channel-console-layout'), sidebar = element('aside', '', 'channel-chat-list'), thread = element('section', '', 'channel-thread'), related = element('aside', '', 'channel-related');
  sidebar.setAttribute('aria-label', '可查看的飞书会话'); thread.setAttribute('aria-label', '当前飞书会话'); related.setAttribute('aria-label', '会话派生任务');
  layout.append(sidebar, thread, related); root.append(head, layout); page.replaceChildren(root);
  const failRead = (target, err, retry) => {
    if (!alive()) return;
    if ([401, 403, 404].includes(err.status)) {
      layout.replaceChildren(consoleState('会话访问已变化', '无法继续读取这些会话。请重新加载当前身份和授权。', { tone: 'error', retry: () => render().catch(error) }));
    } else target.replaceChildren(consoleState('会话读取失败', err.message, { tone: 'error', retry }));
  };
  let allChats = [], listOffset = 0, pending = false, messageCursor = null, turnOffset = null, taskOffset = 0, sampledAt = null;
  const search = input('conversation_search', '', { type: 'search', placeholder: '搜索姓名、群名、企业或机器人' }); search.setAttribute('aria-label', '搜索飞书会话');
  const kind = document.createElement('select'); kind.setAttribute('aria-label', '会话类型'); for (const [value, label] of [['', '全部会话'], ['group', '群聊'], ['p2p', '私聊']]) kind.add(new Option(label, value));
  const listStatus = note('正在读取…'), chatList = element('div'), listMore = button('更多会话', () => readList(true), 'quiet'); listMore.hidden = true;
  const chooser = element('details', '', 'channel-chooser'); chooser.open = !selected || !consoleMedia.matches;
  chooser.append(element('summary', '切换或搜索会话'), field('搜索', search), field('类型', kind), listStatus, chatList, listMore);
  sidebar.append(element('h2', '会话'), chooser);
  const drawList = () => {
    const keyword = search.value.trim().toLocaleLowerCase(); chatList.replaceChildren();
    for (const chat of allChats.filter(c => (!kind.value || c.type === kind.value) && `${c.display_name} ${c.app_name} ${c.tenant_name} ${c.organization_name} ${c.chat_id}`.toLocaleLowerCase().includes(keyword))) {
      const row = element('article'), link = channelLink('#/conversations/' + chat.id, '', 'console-link'), name = element('strong'), context = element('small');
      const describe = () => { name.textContent = `${chat.type === 'p2p' ? '私聊' : '群聊'} · ${channelChatName(chat)}`; context.textContent = `${chat.tenant_name || '企业名称暂未获取'} · ${chat.app_name || '机器人名称暂未获取'}${chat.organization_name ? ' · 应用所属组织：' + chat.organization_name : ''}`; };
      describe(); link.append(name, context);
      link.classList.add('channel-chat-choice'); if (chat.id === selected) link.setAttribute('aria-current', 'page');
      link.append(element('small', `${channelTime(chat.last_received_at)}${!chat.connection_enabled ? ' · 连接已停用' : ''}`));
      const details = element('details'); details.append(element('summary', '会话信息'),
        channelProfileDetails(chat, () => { describe(); if (chat.id === selected) conversationTitle.textContent = channelChatName(chat); }));
      row.append(link, details); chatList.append(row);
    }
    if (!chatList.childElementCount) chatList.append(note('当前已加载范围没有匹配会话。'));
  }; search.addEventListener('input', drawList); kind.addEventListener('change', drawList);
  async function readList(more = false) {
    listMore.disabled = true;
    try {
      const result = await api('/api/channels/conversations?offset=' + (more ? listOffset : 0)); if (!alive()) return;
      allChats = more ? [...allChats, ...result.conversations] : result.conversations; listOffset = result.next_offset;
      listStatus.textContent = `有权查看 ${result.total} 个 · 群聊 ${result.counts.group} · 私聊 ${result.counts.private}`; listMore.hidden = listOffset === null; drawList();
    } catch (err) { failRead(chatList, err, () => readList(more)); } finally { listMore.disabled = false; }
  }
  if (!selected) {
    thread.append(consoleState('选择一个飞书会话', '左侧列出你有权查看的群聊和私聊。'));
    related.append(consoleState('执行与任务', '选择会话后，可查看助手步骤、独立任务与交给项目团队的任务。'));
    await readList(); return;
  }
  const toolbar = element('div', '', 'channel-thread-head'), caption = element('div'), actions = element('div', '', 'actions'), status = note('正在读取会话…'); status.setAttribute('role', 'status');
  const conversationTitle = element('h2', '会话记录'); caption.append(conversationTitle, status);
  const auto = checkbox('conversation_auto_refresh', false, '自动刷新（5 秒）'), refresh = button('刷新会话', () => update());
  actions.append(refresh, auto); toolbar.append(caption, actions);
  const history = element('div', '', 'channel-messages'); history.setAttribute('aria-label', '消息与执行时间线'); history.setAttribute('tabindex', '0');
  const older = element('div', '', 'actions channel-history-actions'), moreMessages = button('更早消息', () => update('messages'), 'quiet'), moreTurns = button('更早执行回合', () => update('turns'), 'quiet');
  moreMessages.hidden = moreTurns.hidden = true; older.append(moreMessages, moreTurns);
  const diagnostics = element('details', '', 'fold channel-sync-details'), diagnosticText = note(''); diagnostics.append(element('summary', '同步与用量说明'), diagnosticText);
  thread.append(toolbar, older, history, diagnostics, note('请在飞书中继续对话。生成内容与实际送达分别记录；展开记录时自动刷新暂停，手动刷新仍可使用。'));
  let messages = new Map(), turns = new Map(), tasks = new Map(), refreshTimer, conversationMode;
  const time = value => typeof value === 'number' ? value : Date.parse(value);
  function drawTimeline() {
    const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80, previous = history.scrollTop, height = history.scrollHeight;
    history.replaceChildren();
    const rows = [...[...messages.values()].map(value => ({ type: 'message', value })), ...[...turns.values()].map(value => ({ type: 'turn', value }))]
      .sort((a, b) => time(a.value.created_at) - time(b.value.created_at) || String(a.value.message_id || a.value.id).localeCompare(String(b.value.message_id || b.value.id)));
    for (const { type, value } of rows) {
      if (type === 'message') {
        const bot = value.sender_type === 'app' || value.sender_type === 'bot', row = element('article', '', 'channel-message' + (bot ? ' channel-message-bot' : ''));
        row.setAttribute('aria-label', bot ? '机器人消息' : '成员消息');
        const meta = element('div', '', 'channel-message-meta'); meta.append(element('strong', value.sender_name || (bot ? '机器人 · ' + (value.sender_id || '未知') : value.sender_id || '发送者未知')), element('time', channelTime(value.created_at)));
        const body = element('div', value.content || (value.resources?.length ? '附件消息（本页展示已同步的文字与附件名称）' : '本地未保存可展示的文字'), 'channel-message-body');
        row.append(meta, body);
        if (value.resources?.length) for (const resource of value.resources) row.append(note('附件：' + (resource.name || resource.file_name || resource.kind || '未命名附件')));
        if (value.parent_id || value.thread_id) row.append(element('small', '回复 / 话题：' + (value.parent_id || value.thread_id), 'muted'));
        history.append(row);
      } else {
        const row = element('article', '', 'channel-run'); row.setAttribute('aria-label', '助手执行回合');
        const title = element('div', '', 'heading'); const statusBadge = state(value.state); if (value.state_label) statusBadge.textContent = value.state_label;
        title.append(element('strong', value.role_id || '管理助手'), statusBadge, element('time', channelTime(value.created_at))); row.append(title);
        const details = element('details'), steps = element('div'); details.append(element('summary', '查看执行过程'), steps);
        details.addEventListener('toggle', () => { if (details.open && !details.dataset.loaded) { details.dataset.loaded = '1'; void readSteps(value.id, steps); } }); row.append(details);
        if (value.incoming_messages?.length) {
          const incoming = element('details'); incoming.setAttribute('aria-label', '回合并入的消息');
          incoming.append(element('summary', '并入的消息（' + value.incoming_messages.length + '）'));
          for (const message of value.incoming_messages) {
            const status = { pending: '尚未交给模型', injected: '已交给模型', answered: '本轮处理完成', released: '已交回待处理' }[message.state] || message.state;
            incoming.append(element('p', `${message.sender_id} · ${message.message_id} · ${message.needs_reply ? '需要回复' : '仅供参考'} · ${status}`, 'channel-step'));
          }
          row.append(incoming);
        }
        for (const message of value.messages || []) {
          const progress = element('section', '', 'channel-progress-message'); progress.setAttribute('aria-label', '助手进展消息');
          progress.append(element('strong', '进展消息 ' + message.sequence), element('p', message.text, 'channel-message-body'),
            note(message.delivery?.state === 'sent' ? '已发送至飞书' : message.delivery?.state === 'failed' ? '发送失败' : '尚未核验飞书送达结果'));
          row.append(progress);
        }
        if (value.can_stop) row.append(button('停止回答', () => stopTurn(value).catch(error), 'quiet'));
        if (value.reply) {
          if (conversationMode === 'management') row.append(element('p', value.reply, 'channel-message-body'));
          else { const answer = element('details'); answer.append(element('summary', '本轮生成的回答'), element('p', value.reply, 'channel-message-body')); row.append(answer); }
          row.append(note(value.delivery?.state === 'sent' ? '本轮回答已发送至飞书。' : value.delivery?.state === 'unknown' ? '飞书发送结果未知，请先核对。' : value.delivery?.state === 'failed' ? '发送失败；执行结果不代表已经送达。' : '已生成回答，尚未核验飞书送达结果。'));
        }
        else if (value.state === 'completed') row.append(note('本轮没有生成可展示的回答。'));
        if (value.error) row.append(note(employeeError(value.error)));
        history.append(row);
      }
    }
    if (!rows.length) history.append(consoleState('暂无本地会话记录', '尚未同步到消息或助手执行回合，可刷新查看。'));
    if (nearBottom) history.scrollTop = history.scrollHeight; else history.scrollTop = previous + Math.max(0, history.scrollHeight - height);
  }
  async function stopTurn(turn) {
    if (!alive()) return;
    const stopped = await askConfirm({ title: '停止这次回答？', body: ['不再发送本轮最终回答，已经发出的进展消息保留。'], action: '停止回答', danger: true,
      run: () => api(`/api/channels/chats/${selected}/service-turns/${turn.id}/stop`, 'POST', {}) });
    if (stopped && alive()) await update();
  }
  async function readSteps(turn, target, after = 0) {
    try {
      const result = await api(`/api/channels/chats/${selected}/turns/${turn}?after=${after}`); if (!alive() || !target.isConnected) return;
      if (!after) target.replaceChildren();
      for (const event of result.events) target.append(element('p', `${channelTime(event.created_at)} · ${channelStepLabels[event.type] || event.type}${event.name ? ' · ' + (channelToolLabels[event.name] || event.name) : ''}`, 'channel-step'));
      if (result.coverage === 'legacy_steps_unavailable') target.append(note('这轮执行发生在步骤记录启用前，没有可补写的执行步骤。'));
      if (result.has_more) { const next = button('更多执行步骤', async () => { next.remove(); await readSteps(turn, target, result.next_after); }, 'quiet'); target.append(next); }
    } catch (err) { failRead(target, err, () => readSteps(turn, target, after)); }
  }
  async function readTasks(more = false) {
    const result = await api(`/api/channels/chats/${selected}/tasks?offset=${more ? taskOffset : 0}`); if (!alive()) return;
    if (!more) tasks.clear(); for (const task of result.tasks) tasks.set(task.id, task); taskOffset = result.next_offset;
    related.replaceChildren(element('h2', '派生任务'), note('项目任务交给项目团队处理；独立任务由本会话的服务角色处理。'));
    const projectTasks = element('section'); projectTasks.append(element('h3', '项目任务'));
    for (const task of tasks.values()) { const row = element('article', '', 'channel-related-task'); row.append(element('strong', task.summary), state(task.status), note(task.project_name), button('查看任务过程', () => openTask(task.id).catch(error), 'quiet')); projectTasks.append(row); }
    if (!tasks.size) projectTasks.append(note('当前授权和来源范围暂无项目任务。'));
    if (taskOffset !== null) projectTasks.append(button('更多项目任务', () => readTasks(true).catch(err => failRead(related, err, () => readTasks(true))), 'quiet'));
    const own = element('section'); own.append(element('h3', '独立任务（最近 20 项）'));
    for (const task of result.own_tasks) { const row = element('article', '', 'channel-related-task'); row.append(element('strong', task.title), state(task.state));
      if (task.last_conclusion) { const detail = element('details'); detail.append(element('summary', '查看最近结论'), element('p', task.last_conclusion, 'channel-message-body')); row.append(detail); } own.append(row); }
    if (!result.own_tasks.length) own.append(note('当前会话暂无可见独立任务。'));
    related.append(projectTasks, own, consoleLink('#/identity/feishu/groups', '群助手设置', '管理角色、项目范围与负责人'));
  }
  async function update(more) {
    if (pending || !alive()) return; pending = true; refresh.disabled = moreMessages.disabled = moreTurns.disabled = true; clearTimeout(refreshTimer);
    if (more) auto.querySelector('input').checked = false;
    try {
      const query = new URLSearchParams();
      if (more === 'messages' && messageCursor) query.set('cursor', messageCursor);
      if (more === 'turns' && turnOffset !== null) query.set('turn_offset', String(turnOffset));
      const result = await api(`/api/channels/chats/${selected}/timeline?${query}`); if (!alive()) return;
      if (!more) { messages.clear(); turns.clear(); }
      if (more !== 'turns') { for (const message of result.messages) messages.set(message.message_id, message); messageCursor = result.next_cursor; }
      if (more !== 'messages') { for (const turn of result.conversation.turns) turns.set(turn.id, turn); turnOffset = result.conversation.next_offset; }
      conversationMode = result.conversation.mode; sampledAt = result.read_at; moreMessages.hidden = !messageCursor; moreTurns.hidden = turnOffset === null;
      conversationTitle.textContent = channelChatName(allChats.find(c => c.id === selected && c.display_name) || result.chat);
      status.textContent = `${result.chat.type === 'p2p' ? '私聊' : '群聊'} · ${channelChatContext(result.chat)} · 读取于 ${channelTime(sampledAt)}`;
      diagnosticText.textContent = `本地同步：${channelSyncText(result.sync_state)}。缺口：${result.gaps.map(g => channelGapText(g.reason)).join('、') || '本次未报告'}。可见范围受飞书权限与保留策略约束。模型请求 ${result.conversation.usage.requests || 0} 次；未知费用不按零处理。`;
      drawTimeline(); await readTasks();
    } catch (err) {
      if (sampledAt && ![401, 403, 404].includes(err.status) && alive()) status.textContent = `刷新失败：${err.message}。保留 ${channelTime(sampledAt)} 的旧记录，可能已过期。`;
      else failRead(history, err, () => update());
    } finally {
      pending = false; refresh.disabled = moreMessages.disabled = moreTurns.disabled = false;
      scheduleRefresh();
    }
  }
  function scheduleRefresh() {
    if (alive() && auto.querySelector('input').checked) refreshTimer = setTimeout(() => {
      if (!alive()) return;
      if (document.hidden || pending || history.querySelector('details[open]')) scheduleRefresh(); else void update();
    }, 5000);
  }
  auto.querySelector('input').addEventListener('change', () => { clearTimeout(refreshTimer); if (auto.querySelector('input').checked) void update(); });
  await Promise.all([readList(), update()]);
}
