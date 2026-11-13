// Unified Feishu bindings page (#/identity/feishu): personal bindings and group bindings sit on one page as scannable lists,
// with explicit Create buttons, per-group repository & role permission configuration, and one-click chat history access.
async function renderFeishuBindingsPage(panel, current) {
  const request = renderVersion, queryIndex = location.hash.indexOf('?');
  const params = new URLSearchParams(queryIndex >= 0 ? location.hash.slice(queryIndex + 1) : '');
  const challenge = /^[a-f0-9]{48}$/.test(params.get('challenge') || '') ? params.get('challenge') : null;
  const queryCreate = params.get('create'), querySection = params.get('section');
  const queryGroup = /^[a-f0-9]{48}$/.test(params.get('group') || '') ? params.get('group') : null;

  panel.replaceChildren(consoleState('正在读取飞书绑定', '正在核对本人的飞书绑定与获准管理的群绑定。'));
  let data;
  try { data = await api('/api/channels/bindings'); }
  catch (err) {
    if (current()) panel.replaceChildren(consoleState('飞书绑定读取失败', err.message, { tone: 'error', retry: () => renderFeishuBindingsPage(panel, current) }));
    return;
  }
  if (!current()) return;
  if (typeof notePersonalApps === 'function') notePersonalApps(data);

  const activePersonal = data.bindings.filter(b => b.status === 'active' && (!b.expires_at || b.expires_at > Date.now()));
  const overview = element('section', '', 'side-card feishu-overview');
  overview.setAttribute('aria-label', '飞书绑定概览');
  overview.append(note('在同一页查看与管理个人飞书绑定和群绑定。列表直接展示仓库范围与角色权限，点击已建立会话的绑定条目（或「查看聊天记录」）即可查看聊天记录。'));

  let openPersonalCreator = () => {}, openGroupEditor = null, pendingGroupEditor = false, pendingGroupChat = null, retryGroups = null;
  const requestGroupEditor = (chatId = null) => {
    if (openGroupEditor) { openGroupEditor(chatId); return; }
    pendingGroupEditor = true; pendingGroupChat = chatId;
    groupSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (retryGroups) retryGroups();
  };

  const topActions = element('div', '', 'feishu-page-actions');
  topActions.append(
    button('创建个人绑定', () => openPersonalCreator()),
    button('创建群绑定', () => requestGroupEditor(null)),
    button('刷新飞书绑定状态', () => start().catch(error), 'quiet'),
    channelLink('#/conversations', '查看全部飞书会话', 'button-link quiet')
  );
  overview.append(topActions);

  const metrics = element('div', '', 'feishu-metrics');
  const metric = (name, value, hint) => {
    const box = element('div', '', 'feishu-metric');
    box.append(element('span', name), element('strong', value), element('small', hint));
    metrics.append(box); return box;
  };
  metric('已绑定身份', String(activePersonal.length), '当前账户 ' + me.username);
  const privateCount = metric('本人私聊', '—', '正在读取');
  const groupCount = metric('维护的群', '—', '正在读取');
  overview.append(metrics);
  const showMetric = (node, value, hint) => { node.querySelector('strong').textContent = String(value); node.querySelector('small').textContent = hint; };

  // Section 1: Personal Bindings (#feishu-identity)
  const personalSection = element('section', '', 'side-card'), nameLookups = [];
  personalSection.id = 'feishu-identity';
  const personalHead = element('div', '', 'feishu-section-head'), personalActions = element('div', '', 'actions');
  personalHead.append(element('h3', '飞书身份绑定'), personalActions);
  if (me.role === 'super_admin') personalActions.append(channelLink('#/settings/feishu', '管理员：连接或管理飞书应用', 'button-link quiet'));
  else if (data.can_manage_applications) personalActions.append(channelLink('#/identity/feishu-apps', '连接或管理本组织的飞书应用', 'button-link quiet'));
  personalSection.append(personalHead,
    note('将本人的飞书账号关联到当前平台账户（本地账户和 GitHub 登录均可使用）。私聊使用管理助手并按当前账户实际获准的项目权限执行，绑定本身不会增加仓库权限。'));

  if (challenge) {
    const challengeBox = element('div', '', 'feishu-creator-panel'), status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
    const claim = button('绑定到当前平台账户', async () => {
      claim.disabled = true; status.textContent = '';
      try {
        await api('/api/channels/bindings/claim', 'POST', { challenge });
        history.replaceState(null, '', '#/identity/feishu'); await start();
      } catch (err) {
        const reason = { binding_expired: '绑定链接已过期，请在原飞书私聊重新发送 /bind。',
          binding_replayed: '此绑定请求已处理，请刷新状态或在原私聊重新发送 /bind。',
          binding_login_already_started: '此请求已关联平台账户，请完成原私聊确认；需要更换账户时重新发送 /bind。',
          channel_application_forbidden: '你在这个机器人所属的组织没有授权，不能通过它绑定。' };
        status.textContent = Object.entries(reason).find(([code]) => err.message.includes(code))?.[1] || err.message;
        claim.disabled = false;
      }
    }, '');
    challengeBox.append(element('strong', '确认飞书私聊发起的绑定请求'),
      note(`将绑定到当前平台账户：${me.username}。如需使用其他账户，请先退出登录并重新打开绑定链接。`), claim, status);
    personalSection.append(challengeBox);
  }

  // Personal binding creator panel: auto-open when user has no active personal binding yet or requested ?create=personal;
  // otherwise collapsed so existing bindings stay front-and-center in a clean list.
  const personalCreator = element('div', '', 'feishu-creator-panel');
  personalCreator.id = 'feishu-personal-creator';
  personalCreator.hidden = activePersonal.length > 0 && !challenge && queryCreate !== 'personal';
  const creatorHead = element('div', '', 'feishu-creator-head');
  const closePersonalCreator = button('收起', () => { personalCreator.hidden = true; }, 'quiet');
  creatorHead.append(element('strong', '创建个人绑定'), closePersonalCreator);
  personalCreator.append(creatorHead);

  let selectConnectorControl = null, firstIssueButton = null;
  const steps = element('ol', '', 'feishu-binding-steps');
  for (const caption of ['打开所选机器人的私聊，添加机器人联系人。',
    '生成并复制完整绑定消息，在这个私聊中发送一次。本页会自动读取服务端确认结果。']) steps.append(element('li', caption));
  if (data.applications.length) {
    const flow = element('div', '', 'feishu-binding-layout'), main = element('div'), help = element('aside', '', 'feishu-binding-help');
    help.append(element('h4', '找不到机器人？'), note('请先登录飞书，再打开机器人名片。也可在飞书中搜索机器人的名称；仍不可见时，请联系管理员检查应用发布和可用范围。'),
      note('绑定串五分钟内有效，只能使用一次。仅发送到本人与所选机器人的私聊，请勿转发。复制或打开私聊不代表绑定成功。'));
    main.append(steps); flow.append(main, help); personalCreator.append(flow);
    const apps = element('div'); apps.setAttribute('aria-label', '可绑定的飞书应用');
    const label = a => `${a.tenant_name || '企业名称暂未获取'} · ${a.app_name || '机器人名称暂未获取'}${a.organization ? ' · 组织 ' + a.organization + ' 的应用' : ''}`;
    const active = a => data.bindings.some(b => b.status === 'active' && b.connector === a.id + ':' + a.app_id);
    // The console issues the code for the chosen bot (#236): the private-chat message that carries it completes the
    // binding in one step, and this page only shows 已绑定 after it reads the binding back from the server.
    const consoleBind = async (a, slot) => {
      steps.hidden = false;
      const box = element('div', '', 'channel-binding-console'); box.setAttribute('aria-label', '控制台发起的绑定');
      slot.replaceChildren(box);
      const status = element('p', '', 'muted'); status.setAttribute('role', 'status');
      box.append(status); status.textContent = '正在向服务端申请一次性绑定串…';
      try {
        const issued = await api('/api/channels/bindings/issue', 'POST', { connector_id: a.id }), command = '绑定 ' + issued.code;
        if (!box.isConnected) return;
        const copy = button('复制绑定串', async () => {
          try { await navigator.clipboard.writeText(command); status.textContent = '已复制。复制只影响剪贴板，绑定仍以服务端确认为准。'; }
          catch { status.textContent = '复制失败，请选中上面的文字手动复制。'; }
        }, 'quiet');
        box.replaceChildren(element('strong', '在飞书中发送这一条'), element('code', command), copy, status);
        status.textContent = '等待飞书中发送这条消息…（五分钟内有效，仅可使用一次，请勿转发）';
        const deadline = issued.expires_at;
        const poll = async () => {
          if (!box.isConnected) return;
          const stop = message => { box.replaceChildren(status); status.textContent = message; };
          try {
            const result = await api('/api/channels/bindings/requests/' + issued.request_id);
            if (!box.isConnected) return;
            if (result.state === 'completed') { stop('服务端已确认绑定，正在读取身份。'); await start(); return; }
            const terminal = { expired: '绑定串已过期，请重新生成。', superseded: '这条绑定串已失效，请使用最新生成的消息。',
              invalidated: '登录会话或机器人配置已变化，请重新生成绑定串。', revoked: '这次绑定已经解除，请重新生成绑定串。' };
            if (terminal[result.state]) { stop(terminal[result.state]); return; }
            status.textContent = result.state === 'processing' ? '服务端正在核验这次绑定，尚未确认完成。' : '等待飞书中发送这条消息…（五分钟内有效，仅可使用一次，请勿转发）';
          } catch (error) {
            if (!box.isConnected) return;
            if ([401, 403, 404].includes(error.status)) { stop('无法继续读取这次绑定，请刷新登录与机器人状态后重新生成。'); return; }
            if (Date.now() > deadline) { stop('绑定串已过期，暂时无法确认结果，请刷新飞书绑定状态。'); return; }
            status.textContent = '暂时无法读取服务端绑定状态，仍在等待确认。';
          }
          setTimeout(poll, 2000);
        };
        void poll();
      } catch (err) { status.textContent = err.message; }
    };
    const rows = new Map();
    for (const a of data.applications) {
      const row = element('div', '', 'channel-binding'), link = channelLink(a.chat_url, '打开机器人私聊', 'button-link');
      row.dataset.bindingConnector = a.id;
      const slot = element('div', '', 'channel-binding-slot'); slot.setAttribute('aria-live', 'polite');
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      const issueBtn = button(active(a) ? '重新绑定' : '生成绑定串', () => consoleBind(a, slot), 'quiet');
      if (!firstIssueButton) firstIssueButton = issueBtn;
      row.append(element('strong', label(a)), link, issueBtn, slot);
      rows.set(a.id, row);
      if (a.organization) row.append(note(`这是组织 ${a.organization} 的应用：经它绑定的飞书身份只能使用你在该组织内的权限。`));
      apps.append(row);
    }
    if (data.applications.length > 1) {
      const selected = channelSelect(main, '选择飞书机器人', 'personal_binding_connector', data.applications.map(a => [a.id, label(a)]));
      const choose = () => { for (const [id, row] of rows) row.hidden = id !== selected.value; steps.hidden = active(data.applications.find(a => a.id === selected.value)); };
      selected.addEventListener('change', choose); choose();
      selectConnectorControl = selected;
    } else steps.hidden = active(data.applications[0]);
    main.append(apps);
    const form = element('form', '', 'project-form'), app = channelSelect(form, '要绑定的飞书机器人', 'binding_connector', data.applications.map(a => [a.id, label(a)]));
    const code = channelField(form, '飞书认证字符串', 'binding_code'); code.required = true; code.autocomplete = 'off'; code.spellcheck = false;
    code.placeholder = '粘贴机器人私聊返回的 FSB- 开头字符串'; code.maxLength = 100;
    const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
    const submit = element('button', '确认绑定到当前账户'); submit.type = 'submit';
    form.append(note(`将绑定到当前平台账户：${me.username}。请仅使用本人私聊收到的认证字符串。`), status, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return;
      submit.disabled = true; status.textContent = '';
      try {
        await api('/api/channels/bindings/confirm', 'POST', { code: code.value.trim(), connector_id: app.value });
        history.replaceState(null, '', '#/identity/feishu'); await start();
      } catch (err) {
        const reasons = { binding_code_invalid: '认证字符串无效，或不属于所选机器人。请核对后重试。', binding_expired: '认证字符串已过期，请在机器人私聊重新发送 /bind。',
          binding_replayed: '认证字符串已使用，请刷新状态；需要重新认证时发送 /reauth。', binding_login_already_started: '此请求已进入链接绑定流程，请回原私聊确认，或重新发送 /bind 获取认证字符串。',
          external_identity_conflict: '这个飞书身份已属于其他平台账户，请登录原账户处理。',
          channel_application_forbidden: '你在这个机器人所属的组织没有授权，不能通过它绑定。' };
        status.textContent = Object.entries(reasons).find(([key]) => err.message.includes(key))?.[1] || err.message;
        submit.disabled = false;
      }
    });
    const legacy = element('details', '', 'fold feishu-legacy-binding');
    legacy.append(element('summary', '使用旧私聊认证字符串（兼容入口）'), note('仅用于继续处理之前从机器人私聊发起的认证。首次绑定请使用上方两步流程。'), form);
    personalCreator.append(legacy);
  } else personalCreator.append(note('暂无你可以使用的飞书应用。请联系超级管理员或本组织的管理员配置。'));

  openPersonalCreator = (connectorId = null) => {
    personalCreator.hidden = false;
    if (connectorId && selectConnectorControl && [...selectConnectorControl.options].some(o => o.value === connectorId)) {
      selectConnectorControl.value = connectorId;
      selectConnectorControl.dispatchEvent(new Event('change'));
    }
    personalCreator.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    (selectConnectorControl || firstIssueButton)?.focus({ preventScroll: true });
  };
  personalSection.append(personalCreator);

  for (const p of data.pending) {
    const pending = element('div', '', 'feishu-binding-row channel-binding'); pending.setAttribute('aria-label', '待确认的飞书身份');
    pending.append(element('strong', '等待原飞书操作者确认'), facts([['平台账户', p.account.username],
      ['飞书账号', '发起本次绑定的飞书账号'], ['机器人', p.app_name || '机器人名称暂未获取'],
      ['机器人所属企业', p.tenant_name || '企业名称暂未获取'], ['有效期', new Date(p.expires_at).toLocaleString()]]),
      channelCopy('在原私聊发送的确认指令', '确认绑定 ' + p.confirmation));
    personalSection.append(pending);
  }

  const personalList = element('div', '', 'feishu-binding-list');
  personalList.setAttribute('aria-label', '个人飞书绑定列表');
  if (!data.bindings.length && !data.pending.length) {
    personalList.append(element('p', '尚未绑定飞书身份。可通过上方向导或点击「创建个人绑定」关联本人飞书账号。', 'muted'));
  }

  const personalRowEntries = [];
  for (const b of data.bindings) {
    const row = element('article', '', 'feishu-binding-row channel-binding'), active = b.status === 'active';
    const name = () => { const value = typeof b.display_name === 'string' ? b.display_name.trim() : ''; return value && value !== b.external_actor ? value : ''; };
    const stateLabel = active ? '已绑定' : b.status === 'revoked' ? '已解绑' : '需要重新认证';
    const mainRow = element('div', '', 'feishu-row-main'), info = element('div', '', 'feishu-row-info'), rowActions = element('div', '', 'actions feishu-row-actions');
    const titleWrap = element('div', '', 'feishu-row-title'), title = element('strong');
    const renderName = () => { title.textContent = `${name() || me.username + ' 的飞书账号'} · ${stateLabel}`; };
    renderName();
    titleWrap.append(title);
    if (active) titleWrap.append(element('span', '私聊管理助手', 'feishu-binding-badge'));
    else titleWrap.append(element('span', stateLabel, 'feishu-binding-badge feishu-binding-badge-muted'));

    row.setAttribute('aria-label', '我的飞书账号');
    info.append(titleWrap, note(channelChatContext(b)), note(`关联平台账户：${me.username}`));
    const chatHint = note(active ? '正在核对私聊会话记录…' : '需要恢复时，可在原飞书私聊发送 /reauth，或点击「重新绑定」生成新绑定串。');
    info.append(chatHint);
    const nameStatus = note(name() ? '' : '飞书姓名暂不可读取，当前显示关联的平台账户。'); nameStatus.setAttribute('role', 'status');
    info.append(nameStatus);
    if (b.connection_enabled === 0) info.append(note('此机器人连接已停用。'));
    else if (b.connection_enabled === null) info.append(note('原机器人连接已不可用。'));

    const chatActionSlot = element('span', '', 'feishu-inline-actions');
    rowActions.append(chatActionSlot);

    if (b.can_read_name) {
      const refreshName = async () => {
        if (refresh.disabled) return;
        refresh.disabled = true; nameStatus.textContent = '正在读取飞书姓名…';
        try {
          const result = await channelNameRequest('/api/channels/bindings/' + encodeURIComponent(b.id) + '/name');
          if (request !== renderVersion) return;
          b.display_name = result.display_name; renderName(); nameStatus.textContent = '飞书姓名已更新。';
        } catch (err) {
          if (request !== renderVersion) return;
          const changed = ['authorization_changed', 'external_binding_required', 'identity_not_found', 'channel_connector_inactive', 'channel_configuration_changed', 'login_required'].some(code => err.message.includes(code));
          nameStatus.textContent = changed ? '绑定或机器人连接状态已变化，请刷新飞书绑定状态。' : `${name() ? '暂时无法更新飞书姓名，保留上次读取的姓名。' : '飞书暂未提供姓名，当前显示关联的平台账户。'}${err.message.includes('channel_user_name_permission_required') ? channelNamePermissionHint : '请管理员检查完整应用权限、发布状态和通讯录可见范围后重试。'}`;
        } finally { refresh.disabled = false; }
      };
      const refresh = button('刷新飞书姓名', refreshName, 'quiet');
      rowActions.append(refresh);
      if (!name()) nameLookups.push(refreshName);
    }

    const connectorId = typeof b.connector === 'string' ? b.connector.split(':')[0] : '';
    if (active) {
      rowActions.append(button('解除飞书绑定', async () => {
        if (!confirm('解除绑定后，这个飞书身份不能继续管理项目。继续？')) return;
        try { await api('/api/identity/bindings/' + b.id, 'DELETE', {}); await start(); } catch (err) { error(err); }
      }, 'quiet'));
    } else if (data.applications.some(a => a.id === connectorId)) {
      rowActions.append(button('重新绑定', () => openPersonalCreator(connectorId), 'quiet'));
    }

    const scheduleDrawer = element('div', '', 'feishu-row-drawer'); scheduleDrawer.hidden = true;
    mainRow.append(info, rowActions);
    row.append(mainRow, scheduleDrawer);

    let primaryChatId = null;
    makeFeishuRowClickable(row, () => primaryChatId ? '#/conversations/' + primaryChatId : '', () => {
      if (active) chatHint.textContent = '尚未建立私聊记录：请先在飞书中向该机器人发送一条普通消息，之后即可点击查看聊天记录。';
    });
    personalRowEntries.push({ binding: b, active, row, chatHint, chatActionSlot, scheduleDrawer, setPrimaryChat: id => { primaryChatId = id; } });
    personalList.append(row);
  }
  const orphanChatsSlot = element('div');
  personalSection.append(personalList, orphanChatsSlot);

  // Section 2: Group Bindings (#feishu-group-bindings)
  const groupSection = element('section', '', 'side-card');
  groupSection.id = 'feishu-group-bindings';
  const groupHead = element('div', '', 'feishu-section-head'), groupHeadActions = element('div', '', 'actions');
  groupHead.append(element('h3', '飞书群聊助手'), groupHeadActions);
  if (me.role === 'super_admin') groupHeadActions.append(channelLink('#/settings/service-roles', '管理服务角色与读写权限', 'button-link quiet'));
  groupSection.append(groupHead,
    note('为机器人所在的群配置服务角色与仓库访问范围（可按单个仓库勾选或授权整个组织）。群成员无需绑定本人飞书即可按本群权限使用助手；点击条目可查看群聊天记录。'));
  const groupBody = element('div');
  groupBody.append(consoleState('正在读取群绑定', '个人飞书绑定已就绪，正在读取可查看或管理的群绑定。'));
  groupSection.append(groupBody);

  panel.replaceChildren(overview, personalSection, groupSection);

  // Names are presentation metadata: fill missing names asynchronously without blocking rendering.
  void (async () => { for (const lookup of nameLookups) { if (request !== renderVersion) break; await lookup(); } })();

  // Pair personal bindings with private chats asynchronously so personal chat history & timers are one click away.
  void api('/api/channels/employees').then(result => {
    if (!current() || !personalSection.isConnected) return;
    const belongs = (binding, chat) => binding.connector === chat.connector_id + ':' + chat.app_id && binding.external_actor === chat.actor_id && binding.external_tenant === chat.actor_tenant;
    const activeMatched = result.personal_chats.filter(c => activePersonal.some(b => belongs(b, c)));
    showMetric(privateCount, activeMatched.length, '当前绑定对应的私聊' + (result.personal_chats.length > activeMatched.length ? `；另有 ${result.personal_chats.length - activeMatched.length} 个历史会话` : ''));
    const pairedIds = new Set();
    for (const entry of personalRowEntries) {
      const chats = result.personal_chats.filter(c => belongs(entry.binding, c));
      for (const c of chats) pairedIds.add(c.id);
      entry.chatActionSlot.replaceChildren();
      if (chats.length) {
        entry.setPrimaryChat(chats[0].id);
        entry.row.classList.add('feishu-binding-clickable');
        entry.chatHint.textContent = `${entry.active ? '私聊会话已建立' : '保留历史私聊记录'}（${chats.length} 个） · 点击此条或「查看聊天记录」查看消息与执行回执`;
        chats.forEach((chat, index) => {
          entry.chatActionSlot.append(channelLink('#/conversations/' + chat.id, chats.length > 1 ? `查看聊天记录 ${index + 1}` : '查看聊天记录', 'button-link quiet'));
        });
        if (entry.active) {
          entry.chatActionSlot.append(button('定时任务', async () => {
            entry.scheduleDrawer.hidden = !entry.scheduleDrawer.hidden;
            if (!entry.scheduleDrawer.hidden && !entry.scheduleDrawer.dataset.loaded) {
              entry.scheduleDrawer.dataset.loaded = '1';
              entry.scheduleDrawer.replaceChildren(note('正在读取定时任务…'));
              entry.scheduleDrawer.replaceChildren(await channelSchedules(chats[0].id));
            }
          }, 'quiet'));
        }
      } else if (entry.active) {
        entry.chatHint.textContent = '身份已绑定，尚无私聊记录；请先在飞书给该机器人发送一条普通消息，之后点击即可查看聊天记录。';
      }
    }
    const unmatched = result.personal_chats.filter(c => !pairedIds.has(c.id));
    if (unmatched.length) {
      const historyFold = element('details', '', 'fold');
      historyFold.append(element('summary', `其他历史私聊记录（${unmatched.length}）`));
      const historyList = element('div', '', 'feishu-binding-list');
      for (const chat of unmatched) {
        const row = element('article', '', 'feishu-binding-row channel-binding feishu-binding-clickable');
        const mainRow = element('div', '', 'feishu-row-main'), info = element('div', '', 'feishu-row-info'), actions = element('div', '', 'actions feishu-row-actions');
        const nameNode = element('strong', '私信 · ' + channelChatName(chat));
        info.append(nameNode, channelProfileDetails(chat, () => { nameNode.textContent = '私信 · ' + channelChatName(chat); }));
        actions.append(channelLink('#/conversations/' + chat.id, '查看聊天记录', 'button-link quiet'));
        mainRow.append(info, actions); row.append(mainRow);
        makeFeishuRowClickable(row, () => '#/conversations/' + chat.id);
        historyList.append(row);
      }
      historyFold.append(historyList);
      orphanChatsSlot.replaceChildren(historyFold);
    }
  }).catch(() => {
    if (current() && personalSection.isConnected) showMetric(privateCount, '未知', '读取失败，可刷新重试');
  });

  // Load group bindings independently: a slow or failed group read never blocks personal binding actions.
  const loadGroups = async () => {
    retryGroups = null;
    groupBody.replaceChildren(consoleState('正在读取群绑定', '正在核对你有权查看或管理的飞书群绑定与仓库范围。'));
    try {
      const groupData = await api('/api/channels/service-bindings');
      if (!current() || !groupSection.isConnected) return;
      const manageable = groupData.bindings.filter(b => b.can_manage), activeGroups = manageable.filter(b => b.enabled);
      showMetric(groupCount, activeGroups.length, `另有 ${manageable.length - activeGroups.length} 个已停用；按管理权限统计`);
      const initialChat = pendingGroupChat || queryGroup;
      const initialOpen = pendingGroupEditor || queryCreate === 'group' || Boolean(initialChat) || (querySection === 'groups' && !groupData.bindings.length);
      pendingGroupEditor = false; pendingGroupChat = null;
      const rendered = await buildGroupBindingsSection(groupData, { initialOpen, initialChat });
      if (!current() || !groupSection.isConnected) return;
      openGroupEditor = rendered.openEditor;
      groupBody.replaceChildren(rendered.root);
      if (initialOpen) rendered.editorWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      else if (querySection === 'groups') groupSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (!current() || !groupSection.isConnected) return;
      showMetric(groupCount, '未知', '读取失败，可重试');
      retryGroups = () => { void loadGroups(); };
      groupBody.replaceChildren(consoleState('飞书群绑定读取失败', err.message, { tone: 'error', retry: () => { void loadGroups(); } }));
    }
  };
  void loadGroups();
}

const employeeErrors = { channel_employee_revalidation_required: '群成员正在重新核验，受保护动作暂时暂停。', channel_employee_member_required: '你或来源成员当前不在这个群中。',
  external_binding_required: '需要先完成本人的飞书身份绑定。', capability_forbidden: '你在所选仓库或组织没有配置权限（config.write）。', channel_employee_source_inactive: '应用已停用、机器人已移出或群已归档。',
  channel_employee_project_inactive: '项目已停用。', channel_employee_disabled: '旧群员工授权已停用。',
  channel_employee_sync_paused: '群授权或受众待核验，历史同步已暂停。', channel_bot_not_in_chat: '机器人当前不在这个群中。',
  channel_audience_unverified: '平台未提供完整成员范围，暂时无法核验。', channel_history_forbidden: '需要该群助手的负责人，或在其全部项目范围内有配置权限。',
  channel_audience_permission_required: '飞书应用还没有读取群成员的权限，无法核验你是否在群中。请超级管理员在「全局设置 → 飞书连接」查看缺少的权限，为应用开通 im:chat.members:read 并发布新版本后再保存。',
  channel_revision_conflict: '这个群的配置已被其他人修改，请刷新本页后重新保存。', service_role_unavailable: '所选服务角色已停用。', service_role_not_bindable: '管理助手不能绑定到群聊。',
  channel_service_scope_paused: '配置人在全部所选仓库的权限都已变化，助手暂停。', channel_service_binding_disabled: '群聊助手已停用。',
  schedule_destination_binding_required: '这个群没有启用的群聊助手绑定。',
  channel_service_binding_forbidden: '只有这个群聊助手的负责人、其项目范围所属组织的管理员或超级管理员可以修改、停用、转交它或停止它的回答。', channel_service_scope_invalid: '请至少选择一个仓库，或选择一个组织。',
  channel_service_scope_outside_organization: '这个群使用的是组织的飞书应用，只能选择该组织的仓库或整个组织。',
  channel_service_owner_ineligible: '新负责人需要对当前全部项目范围有配置权限，且账户处于启用状态。',
  service_role_model_not_configured: '服务角色尚未配置模型，请超级管理员在「全局设置 → 服务角色」中选择。' };
const employeeError = value => Object.entries(employeeErrors).find(([key]) => String(value).includes(key))?.[1] || String(value);

