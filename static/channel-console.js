titles.preferences = t('nav.preferences'); titles.conversations = t('nav.conversations');

// Whether the signed-in user may manage their organization's Feishu apps. It belongs to one user: a different sign-in
// starts from false, and every /api/channels/bindings read updates it, so the nav never depends on the page visited first.
let personalCanManageApps = false, personalAppsOwner = null;
function notePersonalApps(data) {
  const next = !!(data?.can_manage_applications && me?.role !== 'super_admin');
  personalAppsOwner = me?.id ?? null;
  if (next !== personalCanManageApps) { personalCanManageApps = next; if (typeof syncConsoleShell === 'function') syncConsoleShell(); }
}
function resetPersonalApps() { personalCanManageApps = false; personalAppsOwner = null; }
function personalSettingsNav() {
  titles.preferences = t('nav.preferences'); titles.conversations = t('nav.conversations');
  if (me && personalAppsOwner !== me.id) {
    // First personal page for this user: read the capability once instead of waiting for the identity overview.
    personalCanManageApps = false; personalAppsOwner = me.id;
    if (me.role !== 'super_admin') { const owner = me; api('/api/channels/bindings').then(data => { if (me === owner) notePersonalApps(data); }).catch(() => {}); }
  }
  const nav = element('nav', '', 'project-nav'), hash = location.hash;
  nav.setAttribute('aria-label', t('nav.personal_categories'));
  const navLabel = element('p', t('nav.personal'), 'console-nav-label'); navLabel.setAttribute('data-i18n', 'nav.personal'); nav.append(navLabel);
  const activeKey = tab === 'external' ? 'external'
    : tab === 'conversations' || hash === '#/identity/feishu/conversations' ? 'conversations'
    : /^#\/identity\/feishu-apps(?:\/|$)/.test(hash) ? 'feishu-apps'
    : /^#\/identity\/feishu(?:$|\?|\/)/.test(hash) ? 'feishu' : 'identity';
  const items = [
    ['identity', '#/identity', t('nav.identity')],
    ['feishu', '#/identity/feishu', t('nav.feishu')],
    ...(personalCanManageApps || activeKey === 'feishu-apps' ? [['feishu-apps', '#/identity/feishu-apps', t('nav.feishu_apps')]] : []),
    ['conversations', '#/conversations', t('nav.conversations')],
    ['external', '#/external', t('nav.external')]
  ];
  for (const [key, href, caption] of items) {
    const item = element('a', caption); item.href = href;
    if (key === activeKey) item.setAttribute('aria-current', 'page');
    nav.append(item);
  }
  return nav;
}

async function channelBindingOverview(data) {
  const owner = me, overview = element('section', '', 'feishu-overview'); overview.setAttribute('aria-label', t('feishu.overview'));
  const active = data.bindings.filter(b => b.status === 'active' && (!b.expires_at || b.expires_at > Date.now()));
  const metrics = element('div', '', 'feishu-metrics');
  const metric = (name, value, hint) => { const box = element('div', '', 'feishu-metric'); box.append(element('span', name), element('strong', value), element('small', hint)); metrics.append(box); return box; };
  metric(t('feishu.bound_identities'), String(active.length), t('feishu.current_account', { name: me.username }));
  const privateCount = metric(t('feishu.personal_chats'), '—', t('feishu.reading')), groupCount = metric(t('feishu.managed_groups'), '—', t('feishu.reading'));
  overview.append(metrics);
  const links = element('div', '', 'actions');
  links.append(channelLink('#/identity/feishu', t('feishu.manage'), 'button-link quiet'));
  // #555: keep the Feishu card on the identity first screen (#514), but fold leftover create/session links.
  const more = element('details', '', 'fold feishu-more-actions');
  more.setAttribute('data-testid', 'feishu-more-actions');
  more.append(
    element('summary', t('feishu.more_actions')),
    channelLink('#/identity/feishu?create=personal', t('feishu.create_personal'), 'button-link quiet'),
    channelLink('#/identity/feishu?create=group', t('feishu.create_group'), 'button-link quiet'),
    channelLink('#/conversations', t('feishu.view_conversations'), 'button-link quiet')
  );
  links.append(more);
  overview.append(links);
  const summary = element('div', '', 'feishu-bound-summary'); overview.append(summary);
  const show = (node, value, hint) => { node.querySelector('strong').textContent = String(value); node.querySelector('small').textContent = hint; };
  void Promise.all([
    api('/api/channels/employees').then(result => {
      const belongs = (binding, chat) => binding.connector === chat.connector_id + ':' + chat.app_id && binding.external_actor === chat.actor_id && binding.external_tenant === chat.actor_tenant;
      const currentChats = result.personal_chats.filter(c => active.some(b => belongs(b, c)));
      show(privateCount, currentChats.length, t('feishu.personal_hint') + (result.personal_chats.length > currentChats.length ? t('feishu.personal_hint_extra', { count: result.personal_chats.length - currentChats.length }) : ''));
      for (const b of active) {
        const chats = result.personal_chats.filter(c => belongs(b, c));
        const row = element('div', '', 'feishu-summary-row');
        const name = element('strong', b.display_name && b.display_name !== b.external_actor ? b.display_name : t('feishu.identity_of', { name: owner.username }));
        const profile = { ...b, binding_id: b.id, can_refresh_name: !!b.can_read_name, display_name: b.display_name !== b.external_actor ? b.display_name : '' };
        row.append(name, channelProfileDetails(profile, () => { name.textContent = channelChatName(profile); }),
          note(chats.length ? t('feishu.chats_ready', { count: chats.length }) : t('feishu.chats_empty')));
        for (const chat of chats) row.append(channelLink('#/conversations/' + chat.id, t('feishu.open_chat'), 'button-link quiet'));
        summary.append(row);
      }
    }).catch(() => show(privateCount, t('feishu.unknown'), t('feishu.read_failed'))),
    api('/api/channels/service-bindings').then(result => {
      const groups = result.bindings.filter(b => b.can_manage), activeGroups = groups.filter(b => b.enabled);
      show(groupCount, activeGroups.length, t('feishu.groups_hint', { count: groups.length - activeGroups.length }));
      if (groups.length) {
        const list = element('details', '', 'fold'); list.append(element('summary', t('feishu.groups_summary')));
        for (const b of groups) {
          const row = element('div', '', 'feishu-summary-row'), name = element('strong', channelChatName(b.chat)), rowActions = element('div', '', 'actions');
          if (b.can_view !== false) rowActions.append(channelLink('#/conversations/' + b.chat_id, t('feishu.view_history'), 'button-link quiet'));
          rowActions.append(channelLink('#/identity/feishu?group=' + b.chat_id, t('feishu.configure'), 'button-link quiet'));
          row.append(name,
            channelProfileDetails(b.chat, () => { name.textContent = channelChatName(b.chat); }),
            note(`${( { active: t('feishu.state.active'), paused: t('feishu.state.paused'), disabled: t('feishu.state.disabled') } )[b.state] || b.state} · ${b.service_role.name || t('feishu.role_deleted')} · ${b.scope.organization?.name || b.scope.repositories.map(r => r.full_name).join('、')}`),
            rowActions);
          list.append(row);
        }
        summary.append(list);
      }
    }).catch(() => show(groupCount, t('feishu.unknown'), t('feishu.read_failed')))
  ]);
  return overview;
}

const channelStepLabels = { running: '开始执行', model_start: '请求模型', model_done: '模型已返回', model_request: '模型请求已记录', model_retry: '模型请求失败，等待后重试', tool_call: '调用工具', tool_result: '工具已返回', tool_error: '工具调用失败', done: '本轮完成', error: '本轮失败', stopped: '已停止' };
const channelToolLabels = { list_projects: '查看项目范围', list_project_tasks: '查询项目任务', read_project_task: '读取任务', create_project_task: '创建项目任务', manage_project_task: '管理项目任务',
  start_own_task: '开始独立任务', continue_own_task: '继续独立任务', list_own_tasks: '查看独立任务', management_query: '查询管理信息', management_command: '执行管理操作', github_read: '读取 GitHub', github_write: '写入 GitHub', send_message: '发布进展消息' };
const channelTime = value => timestamp(typeof value === 'number' ? value : Date.parse(value));
async function renderChannelConsole(request) {
  const page = $('console-page'), owner = me, address = location.hash, root = element('div', '', 'channel-console');
  const alive = () => renderVersion === request && me === owner && location.hash === address && root.isConnected && root.contains(thread);
  const selected = /^#\/conversations\/([a-f0-9]{48})$/.exec(address)?.[1];
  const head = element('div', '', 'console-page-head'), headTop = element('div', '', 'feishu-section-head');
  headTop.append(element('h1', '飞书会话'), channelLink('#/identity/feishu', '返回飞书绑定', 'button-link quiet'));
  head.append(element('p', '消息与执行', 'eyebrow'), headTop, note('在同一处查看成员消息、助手执行过程和派生任务。'));
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
    thread.append(consoleState('选择一个飞书会话', '左侧列出你有权查看的群聊和私聊，也可从「飞书绑定」点击任意绑定直接进入。'));
    related.append(consoleState('执行与任务', '选择会话后，可查看助手步骤、独立任务与交给项目团队的任务。'));
    await readList(); return;
  }
  const toolbar = element('div', '', 'channel-thread-head'), caption = element('div'), actions = element('div', '', 'actions'), status = note('正在读取会话…'); status.setAttribute('role', 'status');
  const conversationTitle = element('h2', '会话记录'), bindingMeta = note(''); bindingMeta.hidden = true;
  caption.append(conversationTitle, status, bindingMeta);
  const contextActions = element('span', '', 'feishu-inline-actions');
  const auto = checkbox('conversation_auto_refresh', false, '自动刷新（5 秒）'), refresh = button('刷新会话', () => update());
  actions.append(contextActions, refresh, auto); toolbar.append(caption, actions);
  const history = element('div', '', 'channel-messages'); history.setAttribute('aria-label', '消息与执行时间线'); history.setAttribute('tabindex', '0');
  const older = element('div', '', 'actions channel-history-actions'), moreMessages = button('更早消息', () => update('messages'), 'quiet'), moreTurns = button('更早执行回合', () => update('turns'), 'quiet');
  moreMessages.hidden = moreTurns.hidden = true; older.append(moreMessages, moreTurns);
  const diagnostics = element('details', '', 'fold channel-sync-details'), diagnosticText = note(''); diagnostics.append(element('summary', '同步与用量说明'), diagnosticText);
  const localSearch = element('details', '', 'fold channel-local-search'), searchBody = element('div');
  localSearch.append(element('summary', '搜索本地消息记录'), searchBody);
  localSearch.addEventListener('toggle', () => {
    if (localSearch.open && !localSearch.dataset.loaded) {
      localSearch.dataset.loaded = '1';
      void channelEmployeeHistory({ chat_id: selected }, searchBody).catch(error);
    }
  });
  thread.append(toolbar, older, history, diagnostics, localSearch, note('请在飞书中继续对话。生成内容与实际送达分别记录；展开记录时自动刷新暂停，手动刷新仍可使用。'));
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
            const status = { pending: '尚未交给模型', injected: '已交给模型', answered: '本轮处理完成', released: '已交回待处理', changed: '原消息已变更' }[message.state] || message.state;
            const mention = conversationMode === 'service' ? message.is_direct_mention ? ' · @助手' : ' · 未 @助手' : '';
            // Whether a merged message needs an answer is the assistant's own judgement; the line shows who sent it and the facts.
            const sender = message.sender_name ? `${message.sender_name}（${message.sender_id}）` : message.sender_id;
            incoming.append(element('p', `${sender} · ${message.message_id}${mention} · ${status}`, 'channel-step'));
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
        } else if (value.state === 'running') row.append(note('正在回答…'));
        else if (value.state === 'stopped') row.append(note('已在控制台停止，不再发送最终回答；已发出的进展消息保留。'));
        else if (value.silent) row.append(note('本轮保持安静，未发送回答' + (value.silent_reason ? '：' + value.silent_reason : '。')));
        else if (value.state === 'completed') row.append(note('本轮没有生成可展示的回答。'));
        if (value.error) row.append(note(employeeError(value.error)));
        if (value.error_detail) row.append(note('原因：' + value.error_detail));
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
    related.append(projectTasks, own, consoleLink(conversationMode === 'service' ? '#/identity/feishu?group=' + selected : '#/identity/feishu', '飞书绑定', '管理个人绑定、群仓库范围与角色权限'));
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
      contextActions.replaceChildren();
      if (result.conversation.mode === 'service' && result.conversation.binding) {
        const b = result.conversation.binding;
        const scopeText = b.scope.organization ? '整个组织 ' + b.scope.organization.name : b.scope.repositories.map(r => r.full_name).join('、');
        bindingMeta.textContent = `当前群绑定：${b.service_role.name || '服务角色已删除'} · 范围：${scopeText}`;
        bindingMeta.hidden = false;
        if (result.conversation.can_manage) contextActions.append(channelLink('#/identity/feishu?group=' + selected, '配置仓库与权限', 'button-link quiet'));
      } else {
        bindingMeta.hidden = true;
        if (result.conversation.mode === 'management' && result.conversation.can_continue) {
          contextActions.append(channelLink('#/management', '打开管理对话与执行记录', 'button-link quiet'));
        }
      }
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
