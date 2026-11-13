const channelNameRequests = new Map();
function channelNameRequest(route) {
  const key = renderVersion + ':' + route;
  if (!channelNameRequests.has(key)) channelNameRequests.set(key, api(route, 'POST', {}).finally(() => channelNameRequests.delete(key)));
  return channelNameRequests.get(key);
}
const channelChatName = chat => chat.display_name || (chat.type === 'p2p' || chat.binding_id !== undefined ? '飞书姓名暂未获取' : '群名称暂未获取');
const channelChatContext = chat => `机器人：${chat.app_name || '机器人名称暂未获取'}；所属企业：${chat.tenant_name || '企业名称暂未获取'}${chat.organization_name ? '；应用所属组织：' + chat.organization_name : ''}`;
const channelNamePermissionHint = '读取飞书姓名所需的权限尚未生效。请该应用管理员在「全局设置 → 飞书连接」（组织应用在「设置 → 组织飞书应用」）导入完整权限 JSON，在飞书开通并发布后重试。';
function channelProfileDetails(chat, changed = () => {}) {
  const box = element('div'), context = note(channelChatContext(chat)), status = note(''), request = renderVersion;
  status.setAttribute('role', 'status'); box.append(context);
  if (chat.chat_id) { const ids = element('details'); ids.append(element('summary', '查看会话标识'), note(chat.chat_id)); box.append(ids); }
  if (chat.can_refresh_name) {
    const refresh = button(chat.binding_id ? '刷新飞书姓名' : '刷新群名称', async () => {
      refresh.disabled = true; status.textContent = '正在读取名称…';
      const route = chat.binding_id ? '/api/channels/bindings/' + encodeURIComponent(chat.binding_id) + '/name' : '/api/channels/chats/' + encodeURIComponent(chat.id) + '/name';
      try {
        // Several panels can show the same chat. Share the in-flight lookup, without keeping a cross-account cache.
        const result = await channelNameRequest(route); if (request !== renderVersion) return;
        Object.assign(chat, result, { id: chat.id }); context.textContent = channelChatContext(chat); changed(); status.textContent = '名称已更新。';
      } catch (err) {
        if (request !== renderVersion) return;
        const changedAccess = [401, 404, 409].includes(err.status) || /authorization_changed|channel_history_forbidden|capability_forbidden|source_inactive|external_binding_required/.test(err.message);
        status.textContent = changedAccess ? '会话或权限已变化，请刷新页面。' : `${chat.display_name ? '暂时无法更新，保留上次读取的名称。' : '暂时无法读取名称。'}${err.message.includes('channel_user_name_permission_required') ? channelNamePermissionHint : '请管理员检查飞书应用权限、发布状态和通讯录可见范围后重试。'}`;
      } finally { refresh.disabled = false; }
    }, 'quiet');
    box.append(refresh, status);
    if (!chat.display_name) setTimeout(() => { if (request === renderVersion && !chat.display_name) refresh.click(); }, 0);
  }
  return box;
}

// Clicking a binding row's body opens its chat history, without hijacking inner buttons, links, form controls, drawers or text selection.
function makeFeishuRowClickable(row, getHref, onUnavailable) {
  row.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.target.closest('a, button, input, select, textarea, label, summary, details, form, .feishu-row-drawer')) return;
    const selection = window.getSelection?.();
    if (selection && String(selection).trim()) return;
    const href = getHref();
    if (href) location.hash = href;
    else if (onUnavailable) onUnavailable();
  });
}

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

// Prompt-driven timers of one chat (#330): reload in-place so saving/pausing/resuming keeps the open drawer right where the user is working.
const scheduleStates = { active: '生效中', paused: '已暂停' };
const scheduleRunStates = { running: '运行中', completed: '已发送结果', silent: '无需通知，未发送', failed: '未完成', skipped: '已跳过' };
const scheduleErrors = { channel_schedule_forbidden: '只有私聊的本人，或能管理该群聊助手的人可以管理这里的定时任务。',
  channel_schedule_recurrence_required: '请填写 Cron 表达式或间隔分钟数，二选一。', channel_schedule_interval_invalid: '间隔须为 5 分钟到 31 天之间的整数分钟。',
  invalid_schedule_cron: 'Cron 表达式应为五段：分 时 日 月 周，例如 0 9 * * 1-5。', invalid_schedule_timezone: '时区无效，请使用 IANA 时区名，例如 Asia/Shanghai。',
  channel_schedule_revision_conflict: '定时任务已被其他操作修改，请刷新本页后重试。', channel_schedule_running: '这个定时任务正在运行，请稍后再试。',
  channel_schedule_missed: '服务未运行时错过了触发时间', channel_schedule_previous_run_active: '上一次运行尚未结束', channel_schedule_interrupted: '服务重启时中断',
  channel_schedule_changed: '定时任务在运行中被修改或删除', external_binding_required: '本人的飞书身份绑定已失效', principal_inactive: '账户已停用',
  user_paused: '已手动暂停', invalid_field: '名称、提示词和时区都需要填写。' };
const scheduleError = value => scheduleErrors[String(value)] || employeeError(value);
const scheduleTime = (at, zone) => new Date(at).toLocaleString('zh-CN', { timeZone: zone });
async function channelSchedules(chatId) {
  const box = element('div', '', 'channel-schedules'); box.setAttribute('aria-label', '定时任务');
  const load = async () => {
    box.replaceChildren(element('strong', '定时任务'), note('到点后用这里的提示词唤醒本会话的助手，在本会话的权限内查询、汇总或处理，再把结果发回本会话；超出权限的项目和操作会被拒绝。私聊用管理助手和你本人的当前权限，群聊用本群绑定的服务角色和项目范围。模型用量记在对应的服务角色上。'));
    let data;
    try { data = await api('/api/channels/chats/' + chatId + '/schedules'); } catch (err) { box.append(note(scheduleError(err.message))); return; }
    const list = element('div');
    let fill = () => {};
    for (const s of data.schedules) {
      const row = element('article', '', 'channel-binding'); row.setAttribute('aria-label', '定时任务 ' + s.name);
      const rhythm = s.cron ? 'Cron ' + s.cron : '每 ' + s.interval_minutes + ' 分钟';
      row.append(element('strong', `${scheduleStates[s.state] || s.state} · ${s.name}`), note(`${rhythm}（${s.timezone}）${s.reason ? '；暂停原因：' + scheduleError(s.reason) : ''}`),
        element('p', '提示词：' + s.prompt), note(s.future.length ? '接下来：' + s.future.map(at => scheduleTime(at, s.timezone)).join('、') : '暂停中，不会自动触发。'));
      const latest = s.runs[0];
      if (latest) row.append(note(`最近一次（${latest.trigger === 'manual' ? '手动' : '定时'}，${scheduleTime(latest.created_at, s.timezone)}）：${scheduleRunStates[latest.state] || latest.state}${latest.error ? '，原因：' + scheduleError(latest.error) : ''}`));
      const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
      // A step returning false (a cancelled confirmation) leaves the panel as it is.
      const act = (caption, work) => button(caption, async () => { status.textContent = ''; try { if (await work() !== false) await load(); } catch (err) { status.textContent = scheduleError(err.message); } }, 'quiet');
      const actions = element('div', '', 'actions'); row.append(actions);
      if (s.can_manage) actions.append(act('立即运行一次', () => api('/api/channels/schedules/' + s.id + '/run', 'POST', {})),
        act(s.state === 'active' ? '暂停' : '恢复', () => api('/api/channels/schedules/' + s.id, 'PATCH', { expected_revision: s.revision, enabled: s.state !== 'active' })),
        button('编辑', () => fill(s), 'quiet'), act('删除', async () => { if (!confirm('删除定时任务「' + s.name + '」？')) return false; await api('/api/channels/schedules/' + s.id, 'DELETE', { expected_revision: s.revision }); }));
      else if (s.state === 'active') actions.append(act('停用（管理员）', () => api('/api/channels/schedules/' + s.id, 'PATCH', { expected_revision: s.revision, enabled: false })));
      row.append(status); list.append(row);
    }
    if (!data.schedules.length) list.append(note('还没有定时任务。'));
    box.append(list);
    if (data.can_manage) {
      const form = element('form', '', 'project-form'), title = element('strong', '新建定时任务');
      const name = channelField(form, '定时任务名称', 'schedule_name_' + chatId);
      const prompt = document.createElement('textarea'); prompt.name = 'schedule_prompt_' + chatId; prompt.rows = 4; prompt.maxLength = 8000;
      prompt.placeholder = '例如：汇总我可读的所有项目中过去 24 小时失败的任务和 CI，按项目分条列出；如果都没有异常，简短告知一切正常。';
      form.append(field('任务提示词', prompt));
      const zone = channelField(form, '时区', 'schedule_zone_' + chatId, 'Asia/Shanghai');
      const kind = channelSelect(form, '触发方式', 'schedule_kind_' + chatId, [['cron', 'Cron 表达式'], ['interval', '固定间隔']]);
      const cron = channelField(form, 'Cron 表达式（分 时 日 月 周）', 'schedule_cron_' + chatId, '0 9 * * *');
      const minutes = channelField(form, '间隔分钟数', 'schedule_minutes_' + chatId, '60', 'number'); minutes.min = '5';
      const enabled = checkbox('schedule_enabled_' + chatId, true, '保存后立即生效'); form.append(enabled);
      const preview = note(''), status = element('p', '', 'view-error'); status.setAttribute('role', 'alert'); preview.setAttribute('role', 'status');
      const save = element('button', '保存定时任务'); save.type = 'submit';
      let editing = null;
      const spec = () => ({ name: name.value.trim(), prompt: prompt.value.trim(), timezone: zone.value.trim(), ...(kind.value === 'cron' ? { cron: cron.value.trim() } : { interval_minutes: Number(minutes.value) }) });
      const showKind = () => { cron.closest('label').hidden = kind.value !== 'cron'; minutes.closest('label').hidden = kind.value === 'cron'; };
      kind.addEventListener('change', showKind); showKind();
      fill = s => { editing = s; title.textContent = '编辑定时任务「' + s.name + '」'; name.value = s.name; prompt.value = s.prompt; zone.value = s.timezone;
        kind.value = s.cron ? 'cron' : 'interval'; cron.value = s.cron || '0 9 * * *'; minutes.value = String(s.interval_minutes || 60); enabled.querySelector('input').checked = s.state === 'active'; showKind(); name.focus(); };
      form.append(button('预览触发时间', async () => {
        preview.textContent = '';
        try { const result = await api('/api/channels/schedules/preview', 'POST', { timezone: spec().timezone, ...(kind.value === 'cron' ? { cron: spec().cron } : { interval_minutes: spec().interval_minutes }) });
          preview.textContent = '接下来：' + result.future.map(at => scheduleTime(at, spec().timezone)).join('、'); }
        catch (err) { preview.textContent = scheduleError(err.message); }
      }, 'quiet'), preview, status, save);
      form.addEventListener('submit', async event => {
        event.preventDefault(); save.disabled = true; status.textContent = '';
        try {
          const body = { ...spec(), enabled: enabled.querySelector('input').checked };
          if (editing) await api('/api/channels/schedules/' + editing.id, 'PATCH', { ...body, expected_revision: editing.revision });
          else await api('/api/channels/chats/' + chatId + '/schedules', 'POST', body);
          await load();
        } catch (err) { status.textContent = scheduleError(err.message); save.disabled = false; }
      });
      box.append(title, form);
    }
  };
  await load();
  return box;
}

const participationOptions = [['mentions', '仅回应 @'], ['questions', '回应 @ 及以问号结尾的文字'], ['all', '读取每条新文字后判断是否发言']];
const bindingStates = { active: '生效中', paused: '已暂停', disabled: '已停用' };

// Group bindings list + on-demand creator/permission editor.
async function buildGroupBindingsSection(data, { initialOpen = false, initialChat = null } = {}) {
  const root = element('div'), editorWrap = element('div', '', 'feishu-creator-panel'), form = element('form', '', 'project-form');
  editorWrap.id = 'feishu-group-editor';
  editorWrap.hidden = !initialOpen;

  const editorHead = element('div', '', 'feishu-creator-head'), editorTitle = element('strong', '创建群绑定');
  editorHead.append(editorTitle, button('收起配置', () => { editorWrap.hidden = true; }, 'quiet'));
  editorWrap.append(editorHead,
    note('第一个配置的维护人成为该群助手负责人（需已绑定个人飞书、在该群中，并对所选仓库或组织有配置权限）；之后负责人、所属组织管理员和超级管理员均可在此修改仓库范围与服务角色。'));

  const chatOrganization = new Map([...data.chats.map(c => [c.id, c.organization || null]), ...data.bindings.map(b => [b.chat_id, b.chat.organization || null])]);
  const profiles = new Map([...data.chats.map(c => [c.id, c]), ...data.bindings.map(b => [b.chat_id, b.chat])]);
  const chatLabel = c => `${channelChatName(c)} · ${c.tenant_name || '企业名称暂未获取'} · ${c.app_name || '机器人名称暂未获取'} · ${c.chat_id}`;
  const chats = new Map([...profiles].map(([id, c]) => [id, chatLabel(c)]));
  const chat = channelSelect(form, '助手所在群', 'binding_chat', [...chats]);
  const updateOption = selected => { const option = [...chat.options].find(o => o.value === selected.id); if (option) option.textContent = chatLabel(selected); };
  const request = renderVersion;
  for (const selected of profiles.values()) if (!selected.display_name && selected.can_refresh_name) {
    void channelNameRequest('/api/channels/chats/' + encodeURIComponent(selected.id) + '/name').then(result => {
      if (request === renderVersion) { Object.assign(selected, result); updateOption(selected); }
    }).catch(() => {});
  }
  const profile = element('div'); form.append(profile);
  const showProfile = () => {
    const selected = profiles.get(chat.value); profile.replaceChildren();
    if (selected) profile.append(channelProfileDetails(selected, () => updateOption(selected)));
  };
  chat.addEventListener('change', showProfile);

  // Repository / Organization scope controls
  const scope = element('fieldset', '', 'role-choices'); scope.append(element('legend', '仓库与组织权限范围'));
  const kind = name => { const control = document.createElement('input'); control.type = 'radio'; control.name = 'binding_scope'; control.value = name; return control; };
  const repositoriesKind = kind('repositories'), organizationKind = kind('organization');
  const repositoriesLabel = element('label', '', 'check'), organizationLabel = element('label', '', 'check');
  repositoriesLabel.append(repositoriesKind, ' 选择仓库（按仓库精细授权）');
  organizationLabel.append(organizationKind, ' 整个组织（覆盖该组织全部可配置仓库）');

  const repositoriesWrap = element('div', '', 'feishu-repo-picker');
  const repoFilter = data.projects.length > 5 ? input('binding_repo_filter', '', { type: 'search', placeholder: '输入仓库名称筛选…' }) : null;
  if (repoFilter) repoFilter.setAttribute('aria-label', '筛选可选择的仓库');
  const repoCounter = note('');
  const repositories = element('div', '', 'role-choices feishu-repo-grid'); repositories.setAttribute('aria-label', '可选择的仓库');
  const boxes = new Map(data.projects.map(p => {
    const wrap = checkbox('binding_repository:' + p.id, false, p.full_name);
    repositories.append(wrap); return [p.id, wrap.querySelector('input')];
  }));
  const projectOrganization = new Map(data.projects.map(p => [p.id, p.organization]));

  const updateRepoCounter = () => {
    const allowed = [...boxes.values()].filter(control => control.closest('label').dataset.orgHidden !== '1');
    const checked = allowed.filter(control => control.checked);
    repoCounter.textContent = allowed.length ? `已勾选 ${checked.length} / ${allowed.length} 个你有配置权限的仓库` : '当前群所属组织下暂无可配置仓库';
  };
  const applyRepoVisibility = () => {
    const keyword = repoFilter ? repoFilter.value.trim().toLocaleLowerCase() : '';
    for (const [, control] of boxes) {
      const labelNode = control.closest('label');
      const orgHidden = labelNode.dataset.orgHidden === '1';
      const filterHidden = !!keyword && !labelNode.textContent.toLocaleLowerCase().includes(keyword);
      labelNode.hidden = orgHidden || filterHidden;
    }
    updateRepoCounter();
  };
  if (repoFilter) repoFilter.addEventListener('input', applyRepoVisibility);
  for (const [, control] of boxes) control.addEventListener('change', updateRepoCounter);

  const repoToolbar = element('div', '', 'actions');
  if (data.projects.length > 2) {
    repoToolbar.append(
      button('全选可见仓库', () => { for (const [, c] of boxes) if (!c.closest('label').hidden) c.checked = true; updateRepoCounter(); }, 'quiet'),
      button('清空勾选', () => { for (const [, c] of boxes) c.checked = false; updateRepoCounter(); }, 'quiet')
    );
  }
  if (repoFilter) repositoriesWrap.append(repoFilter);
  if (repoToolbar.childElementCount) repositoriesWrap.append(repoToolbar);
  repositoriesWrap.append(repoCounter, repositories);

  const organization = document.createElement('select'); organization.setAttribute('aria-label', '组织');
  for (const o of data.organizations) organization.add(new Option(o.name, o.id));
  organizationKind.disabled = !data.organizations.length;
  const organizationField = field('组织', organization), orgScopeNote = note('');
  const updateOrgNote = () => {
    const orgId = organization.value, count = data.projects.filter(p => p.organization === orgId).length;
    orgScopeNote.textContent = orgId ? `当前按整个组织授权（覆盖你在该组织下可配置的 ${count} 个仓库）。如需仅开放部分仓库，请切换上方「选择仓库」逐个勾选。` : '';
  };
  organization.addEventListener('change', updateOrgNote);
  scope.append(repositoriesLabel, repositoriesWrap, organizationLabel, organizationField, orgScopeNote,
    ...(data.organizations.length ? [] : [note('你没有组织级配置权限，只能按单个仓库勾选。')]));
  form.append(scope);

  // Service role & concrete permissions
  const role = channelSelect(form, '服务角色', 'binding_role', data.service_roles.map(r => [r.id, r.name + (r.recommended ? '（推荐）' : '')]));
  const roleNote = note(''), rolePermTags = element('div', '', 'feishu-perm-tags');
  form.append(roleNote, rolePermTags, note(me.role === 'super_admin'
    ? '群聊助手的实际操作权限 = 所选「服务角色权限」∩ 上方「仓库访问范围」。如需开启 GitHub 写入、任务创建或派活，可在「全局设置 → 服务角色」新增或调整角色。'
    : '群聊助手的实际操作权限 = 所选「服务角色权限」∩ 上方「仓库访问范围」。如需可写或可派活角色，请联系超级管理员在「全局设置 → 服务角色」中配置。'));

  const participation = channelSelect(form, '助手发言范围', 'binding_participation', participationOptions);
  form.append(note('注意：群内所有成员都能看到助手读取的所选仓库内容（包括私有仓库），由配置人负责控制范围。所有获准消息都会存入本地；扩大发言范围会增加模型用量，用量记在服务角色上，不计入项目。'));
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const ownership = note(''); ownership.setAttribute('role', 'status');
  const save = element('button', '保存群聊助手'); save.type = 'submit';
  const submitActions = element('div', '', 'actions');
  submitActions.append(save, button('取消', () => { editorWrap.hidden = true; }, 'quiet'));
  form.append(ownership, status, submitActions);

  let expected = 0;
  const unavailable = !chats.size || !data.service_roles.length || !data.projects.length && !data.organizations.length;
  const roleById = new Map(data.service_roles.map(r => [r.id, r]));
  const formatRoleSummary = roleId => {
    const r = roleById.get(roleId);
    if (!r) return '角色已停用或不可用';
    return data.permission_items.map(item => `${item.name} ${permissionModeLabels[r.permissions[item.id]] || r.permissions[item.id] || '无权限'}`).join('；');
  };
  const describeRole = () => {
    const r = roleById.get(role.value);
    rolePermTags.replaceChildren();
    if (!r) { roleNote.textContent = ''; return; }
    roleNote.textContent = `${r.responsibility || '自定义服务角色'} 权限：${formatRoleSummary(r.id)}。`;
    for (const item of data.permission_items) {
      const mode = r.permissions[item.id] || 'none', active = mode !== 'none' && mode !== 'deny';
      rolePermTags.append(element('span', `${item.name}：${permissionModeLabels[mode] || mode}`, 'feishu-perm-tag' + (active ? ' feishu-perm-tag-active' : '')));
    }
  };
  const showScope = () => {
    repositoriesWrap.hidden = !repositoriesKind.checked;
    organizationField.hidden = !organizationKind.checked;
    orgScopeNote.hidden = !organizationKind.checked;
    updateOrgNote();
  };
  const fill = () => {
    const current = data.bindings.find(b => b.chat_id === chat.value), organizationOnly = chatOrganization.get(chat.value) || null;
    expected = current?.revision || 0;
    editorTitle.textContent = current ? `配置仓库与权限 · ${channelChatName(current.chat)}` : '创建群绑定';
    // An organization app's group offers only that organization's repositories and the organization itself.
    for (const [id, control] of boxes) {
      const hidden = !!organizationOnly && projectOrganization.get(id) !== organizationOnly;
      control.closest('label').dataset.orgHidden = hidden ? '1' : '0';
      if (hidden) control.checked = false;
    }
    for (const option of organization.options) option.disabled = !!organizationOnly && option.value !== organizationOnly;
    if (organizationOnly && [...organization.options].some(o => o.value === organizationOnly)) organization.value = organizationOnly;
    organizationKind.disabled = !data.organizations.some(o => !organizationOnly || o.id === organizationOnly);
    const locked = !!current && !current.can_manage;
    ownership.textContent = locked ? `这个群的助手由 ${current.owner || '原负责人'} 负责；只有负责人、所属组织的管理员和超级管理员可以修改。` : current?.owner ? '负责人：' + current.owner : '';
    save.disabled = unavailable || locked;
    role.value = current?.enabled && data.service_roles.some(r => r.id === current.service_role.id) ? current.service_role.id : (data.service_roles.find(r => r.recommended) || data.service_roles[0])?.id || '';
    participation.value = current?.participation || 'mentions';
    const org = current?.enabled && current.scope.organization;
    organizationKind.checked = !!org && !organizationKind.disabled; repositoriesKind.checked = !organizationKind.checked;
    if (org) organization.value = org.id;
    for (const [id, control] of boxes) control.checked = !!current?.enabled && current.scope.repositories.some(r => r.id === id);
    showProfile(); applyRepoVisibility(); describeRole(); showScope();
  };
  for (const control of [repositoriesKind, organizationKind]) control.addEventListener('change', showScope);
  role.addEventListener('change', describeRole); chat.addEventListener('change', fill);
  save.disabled = unavailable;
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '正在核验你的飞书绑定、群成员身份和所选范围的配置权限…';
    const selected = organizationKind.checked ? { kind: 'organization', organization: organization.value } : { kind: 'repositories', repositories: [...boxes].filter(([, control]) => control.checked).map(([id]) => id) };
    try {
      await api('/api/channels/chats/' + chat.value + '/service-binding', 'PUT', { service_role_id: role.value, scope: selected, participation: participation.value, enabled: true, expected_revision: expected });
      if (location.hash.includes('?')) history.replaceState(null, '', '#/identity/feishu');
      await start();
    } catch (err) { status.textContent = employeeError(err.message); save.disabled = false; }
  });

  if (!chats.size) editorWrap.append(note('尚无可选择的群。请先完成个人绑定，在机器人已加入的目标群发一条消息，再刷新本页。'));
  if (!data.projects.length && !data.organizations.length) editorWrap.append(note('当前没有可配置的仓库。个人绑定不会增加项目权限。'));
  if (!data.service_roles.length) editorWrap.append(note('当前没有可用于群聊的服务角色，请联系超级管理员。'));
  editorWrap.append(form);

  const selectTargetChat = targetChatId => {
    if (targetChatId && [...chat.options].some(o => o.value === targetChatId)) chat.value = targetChatId;
    else if (!targetChatId) {
      const unbound = data.chats.find(c => !data.bindings.some(b => b.chat_id === c.id && b.enabled));
      if (unbound && [...chat.options].some(o => o.value === unbound.id)) chat.value = unbound.id;
    }
    if (chats.size) fill();
  };
  selectTargetChat(initialChat);

  const openEditor = (targetChatId = null) => {
    editorWrap.hidden = false;
    status.textContent = '';
    selectTargetChat(targetChatId);
    editorWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    (targetChatId ? repositoriesKind : chat).focus({ preventScroll: true });
  };

  root.append(editorWrap);

  const list = element('div', '', 'feishu-binding-list');
  list.setAttribute('aria-label', '飞书群绑定列表');
  if (!data.bindings.length) {
    list.append(element('p', '当前尚无已绑定的飞书群。点击「创建群绑定」可为机器人所在群配置仓库范围与角色权限。', 'muted'));
  }

  for (const b of data.bindings) {
    const row = element('article', '', 'feishu-binding-row channel-binding');
    const scopeText = b.scope.organization ? '整个组织 ' + b.scope.organization.name : b.scope.repositories.map(r => r.full_name).join('、');
    const canViewChat = b.can_view !== false;
    row.setAttribute('aria-label', '群聊助手绑定');
    if (canViewChat) {
      row.classList.add('feishu-binding-clickable');
      makeFeishuRowClickable(row, () => '#/conversations/' + b.chat_id);
    }

    const mainRow = element('div', '', 'feishu-row-main'), info = element('div', '', 'feishu-row-info'), actions = element('div', '', 'actions feishu-row-actions');
    const titleWrap = element('div', '', 'feishu-row-title'), groupName = element('strong', channelChatName(b.chat));
    const badge = element('span', `${bindingStates[b.state] || b.state} · ${b.service_role.name || '服务角色已删除'}`,
      'feishu-binding-badge' + (b.state === 'active' ? '' : ' feishu-binding-badge-muted'));
    titleWrap.append(groupName, badge);

    info.append(titleWrap,
      note('项目范围：' + scopeText),
      ...(b.scope.organization && b.enabled ? [note(b.reachable.length ? `可达仓库（${b.reachable.length}）：${b.reachable.join('、')}` : '当前组织范围下暂无可达仓库')] : []),
      note('角色权限：' + formatRoleSummary(b.service_role.id)),
      note('发言范围：' + (participationOptions.find(([id]) => id === b.participation)?.[1] || b.participation)),
      note(`负责人：${b.owner || '账户已删除'}${b.configured_by && b.configured_by !== b.owner ? '；最近修改：' + b.configured_by : ''}`),
      channelProfileDetails(b.chat, () => { groupName.textContent = channelChatName(b.chat); updateOption(b.chat); }),
      ...(b.paused.length ? [note('暂停的仓库（配置人权限已变化）：' + b.paused.join('、'))] : []),
      ...(b.migrated ? [note('由旧群员工自动迁移为仓库问答助手。')] : []),
      ...(b.error ? [note(employeeError(b.error))] : []),
      ...(!canViewChat ? [note('需要该群负责人或拥有全部绑定范围的配置权限才能查看聊天记录。')] : []));

    const scheduleDrawer = element('div', '', 'feishu-row-drawer'); scheduleDrawer.hidden = true;
    const transferDrawer = element('div', '', 'feishu-row-drawer'); transferDrawer.hidden = true;

    if (canViewChat) actions.append(channelLink('#/conversations/' + b.chat_id, '查看聊天记录', 'button-link quiet'));
    if (b.can_manage) actions.append(button(b.enabled ? '配置仓库与权限' : '重新启用并配置', () => openEditor(b.chat_id), 'quiet'));
    if (b.enabled && b.can_manage) {
      actions.append(button('定时任务', async () => {
        scheduleDrawer.hidden = !scheduleDrawer.hidden;
        if (!scheduleDrawer.hidden && !scheduleDrawer.dataset.loaded) {
          scheduleDrawer.dataset.loaded = '1';
          scheduleDrawer.replaceChildren(note('正在读取定时任务…'));
          scheduleDrawer.replaceChildren(await channelSchedules(b.chat_id));
        }
      }, 'quiet'));
    }
    if (b.can_transfer) {
      transferDrawer.append(channelOwnerTransfer(b));
      actions.append(button('转交负责人', () => { transferDrawer.hidden = !transferDrawer.hidden; }, 'quiet'));
    }
    if (b.enabled && b.can_manage) {
      actions.append(button('停用群聊助手', async () => {
        try { await api('/api/channels/chats/' + b.chat_id + '/service-binding', 'PUT', { enabled: false, expected_revision: b.revision }); await start(); }
        catch (err) { error(err); }
      }, 'quiet'));
    }

    mainRow.append(info, actions);
    row.append(mainRow, transferDrawer, scheduleDrawer);
    list.append(row);
  }
  root.append(list);

  const legacy = data.legacy_employees.filter(g => g.enabled);
  if (legacy.length) {
    const old = element('div', '', 'feishu-binding-list'); old.append(element('h4', '旧群员工'), note('旧群员工已不再接收群消息，只用于继续核验升级前已创建的任务。确认这些任务不再需要后可以停用。'));
    for (const g of legacy) {
      const row = element('article', '', 'feishu-binding-row channel-binding');
      row.append(element('strong', `仍有效 · ${g.full_name} · ${g.role_id}`), note(`未结束的任务：${g.open_tasks} 个`), button('停用旧群员工授权', async () => {
        try { await api('/api/channels/chats/' + g.chat_id + '/employee', 'PUT', { project_id: g.project_id, enabled: false, expected_revision: g.revision }); await start(); }
        catch (err) { error(err); }
      }, 'quiet'));
      old.append(row);
    }
    root.append(old);
  }

  return { root, editorWrap, openEditor };
}

// Organization and platform administrators hand a group binding to someone who can configure its whole scope (#424).
function channelOwnerTransfer(binding) {
  const box = element('form', '', 'project-form'), status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  if (!binding.owner_candidates.length) { box.append(note('转交负责人：暂无其他对全部项目范围有配置权限的账户。')); return box; }
  const owner = channelSelect(box, '转交负责人给', 'binding_owner_' + binding.chat_id, binding.owner_candidates.map(c => [c.id, c.username]));
  const submit = element('button', '转交负责人', 'quiet'); submit.type = 'submit'; box.append(status, submit);
  box.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; status.textContent = '';
    const name = owner.selectedOptions[0]?.textContent || '';
    if (!confirm(`把这个群聊助手的负责人转交给 ${name}？转交后原负责人不能再修改它。`)) { submit.disabled = false; return; }
    try { await api('/api/channels/chats/' + binding.chat_id + '/service-binding/owner', 'PUT', { owner_id: owner.value, expected_revision: binding.revision }); await start(); }
    catch (err) { status.textContent = employeeError(err.message); submit.disabled = false; }
  });
  return box;
}

async function channelEmployeeHistory(grant, target) {
  target.replaceChildren(); const form = element('form', '', 'project-form'), keyword = channelField(form, '查询关键词', 'employee_keyword'),
    sender = channelField(form, '查询发送者 ID', 'employee_sender'), status = element('p', '', 'muted'), messages = element('div');
  status.setAttribute('role', 'status'); let cursor;
  const next = button('下一页本地记录', () => read(true), 'quiet'); next.hidden = true;
  const read = async more => {
    if (!more) { cursor = undefined; messages.replaceChildren(); }
    const query = new URLSearchParams({ limit: '50' });
    if (keyword.value) query.set('keyword', keyword.value); if (sender.value) query.set('sender_id', sender.value); if (cursor) query.set('cursor', cursor);
    try {
      const result = await api(`/api/channels/chats/${grant.chat_id}/messages?${query}`); cursor = result.next_cursor;
      status.textContent = `本地同步状态：${channelSyncText(result.sync_state)}。未核验／缺口：${result.gaps.map(g => channelGapText(g.reason)).join('、')}。`;
      if (!result.messages.length && !more) messages.append(note('本地已同步范围没有匹配记录；这不代表飞书历史中从未存在。'));
      for (const m of result.messages) messages.append(facts([['发送者', m.sender_id || '未知'], ['时间', new Date(m.created_at).toLocaleString()], ['消息', m.message_id], ['内容', m.content]]));
      next.hidden = !result.has_more;
    } catch (err) { status.textContent = employeeError(err.message); }
  };
  const submit = element('button', '搜索本地记录'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', event => { event.preventDefault(); void read(false); }); target.append(form, status, messages, next); await read(false);
}

const channelSyncText = state => ({ active: '运行中', syncing: '正在同步', visible_range_complete: '可见范围已完成本次同步', blocked: '同步受阻', paused: '暂停', removed: '机器人已移出', archived: '群已归档' })[state] || state;
const channelGapText = reason => ({ platform_visibility_not_verified: '平台可见范围仍受权限约束', message_edit_event_unavailable: '编辑变更须在后续同步中核验', thread_time_boundary_unsupported: '话题分页不支持时间边界', retention: '部分内容已按保留策略清理', sync_pending: '尚有分页未完成', channel_history_inaccessible: '平台暂不可访问', channel_history_cursor_stalled: '分页游标未推进' })[reason] || employeeError(reason);

function channelCopy(caption, value) {
  const box = element('div', '', 'channel-copy'), text = document.createElement('textarea'), label = element('label', caption), status = element('p', '', 'muted');
  text.value = value; text.readOnly = true; text.rows = Math.min(8, value.split('\n').length); text.setAttribute('aria-label', caption); label.append(text); status.setAttribute('role', 'status');
  box.append(label, button('复制' + caption, async () => {
    try { await navigator.clipboard.writeText(value); status.textContent = '已复制'; }
    catch { text.focus(); text.select(); status.textContent = '已选中文本，请手动复制。'; }
  }, 'quiet'), status); return box;
}
function channelField(form, caption, name, value = '', type = 'text') {
  const control = document.createElement('input'); control.name = name; control.type = type; control.value = value; control.autocomplete = 'off';
  form.append(field(caption, control)); return control;
}
function channelSelect(form, caption, name, values, value) {
  const control = document.createElement('select'); control.name = name; control.setAttribute('aria-label', caption);
  for (const [id, title] of values) control.add(new Option(title, id));
  if (value !== undefined) control.value = value;
  form.append(field(caption, control)); return control;
}
async function channelDiagnostics(c, panel, history = true) {
  const [{ operations }, { deliveries }] = await Promise.all([api('/api/channels/connectors/' + c.id + '/events'), api('/api/channels/connectors/' + c.id + '/outbox')]);
  const view = card('连接健康与收发记录');
  view.append(facts([['连接状态', c.enabled ? '启用' : '停用'], ['传输状态', c.transport === 'http' ? 'HTTP 事件回调' : c.health.connection_state],
    ['最后收到事件', c.health.last_received_at ? new Date(c.health.last_received_at).toLocaleString() : '尚未收到'], ['诊断', c.health.last_error || '无'], ['待处理', c.health.queued], ['发送失败', c.health.failed]]),
    note('应用鉴权成功或长连接已连接，都不能证明消息已经送达。请完成发布并在飞书中实测。群聊的项目范围与服务角色在「个人设置 → 飞书绑定」中为每个群单独设置。'));
  for (const op of operations.slice(0, 10)) view.append(note(`渠道操作 ${op.operation_id} · ${op.state}${op.error ? ' · ' + op.error : ''}${op.conversation_id ? ' · 会话 ' + op.conversation_id : ''}`));
  if (operations.some(op => op.reaction_error === 'channel_reaction_permission_required'))
    view.append(note('处理中表情暂不可用：请在飞书开通应用身份权限 im:message.reactions:write_only，并发布新版本。普通消息回复不受影响。'));
  else if (operations.some(op => op.reaction_error)) view.append(note('部分处理中表情添加或清理未成功，可在收件诊断中查看；普通消息回复继续处理。'));
  for (const d of deliveries.slice(0, 10)) view.append(note(`发送 ${d.id} · ${d.state} · 尝试 ${d.attempts}${d.parts?.length ? ' · 已送达 ' + d.parts.filter(p => p.state === 'sent').length + '/' + d.parts.length + ' 项' : ''}${d.last_error === 'channel_delivery_unknown' ? ' · 部分送达结果待核对，已停止自动重发' : d.last_error ? ' · ' + d.last_error : ''}`));
  panel.append(view);
  // Reading a whole app's local chats stays with super administrators; group histories are read from their bindings.
  if (history) await channelHistory(c, panel);
}

async function channelHistory(connector, panel) {
  const section = card('本地消息与历史同步'), { chats } = await api('/api/channels/chats?connector_id=' + connector.id);
  section.append(note('搜索只读取本地密封消息库，不向飞书回源。同步完成仅代表已遍历平台返回的可见范围，不能证明入群前历史或所有编辑均可见。图片和文件按消息保存来源；获授权助手读取时才下载，撤回和清理后不可再访问。'));
  if (!chats.length) section.append(note('尚未收到此应用的会话事件。机器人进群或首次收到消息后会建立本地记录。'));
  const form = element('form', '', 'project-form');
  const select = channelSelect(form, '本地会话', 'chat', chats.map(c => [c.id, `${c.chat_type === 'group' ? '群' : '私信'} ${c.chat_id}`]));
  const keyword = channelField(form, '消息关键词', 'keyword'), sender = channelField(form, '发送者 ID', 'sender_id');
  const messageId = channelField(form, '消息 ID', 'message_id'), reply = channelField(form, '回复的消息 ID', 'reply_to');
  const from = channelField(form, '开始时间', 'from', '', 'datetime-local'), to = channelField(form, '结束时间', 'to', '', 'datetime-local');
  const queryButton = element('button', '搜索本地记录'); queryButton.type = 'submit'; queryButton.disabled = !chats.length;
  const status = element('p', '', 'muted'), results = element('div'), controls = element('div', '', 'actions');
  status.setAttribute('role', 'status'); results.setAttribute('aria-label', '本地消息搜索结果');
  let cursor = null;
  const search = async (more = false) => {
    queryButton.disabled = true;
    try {
      if (!more) { cursor = null; results.replaceChildren(); }
      const query = new URLSearchParams({ limit: '50' });
      for (const input of [keyword, sender, messageId, reply]) if (input.value) query.set(input.name, input.value);
      for (const input of [from, to]) if (input.value) query.set(input.name, String(new Date(input.value).getTime()));
      if (cursor) query.set('cursor', cursor);
      const result = await api(`/api/channels/chats/${select.value}/messages?${query}`);
      cursor = result.next_cursor;
      status.textContent = `同步：${channelSyncText(result.sync_state)}。缺口／未核验：${result.gaps.map(g => channelGapText(g.reason)).join('、')}。保留策略：${result.retention.days === null ? '保留至管理员显式清理' : result.retention.days + ' 天'}。`;
      if (!result.messages.length && !more) results.append(note('本地已同步范围没有匹配消息；这不代表飞书历史中从未存在。'));
      for (const m of result.messages) {
        const item = element('article', '', 'channel-binding');
        item.append(element('strong', `${m.sender_id || '未知发送者'} · ${m.message_type}`), note(new Date(m.created_at).toLocaleString() + ' · ' + m.message_id),
          element('p', m.content || '此消息没有可显示的文本'), ...(m.resources || []).map(r => note(`附件：${r.name} · ${{ pending: '待下载', ready: '可用', failed: '读取失败' }[r.state] || r.state}${r.size === null ? '' : ' · ' + r.size + ' 字节'}${r.mime ? ' · ' + r.mime : ''}${r.error ? ' · ' + r.error : ''}`)), ...(m.thread_id ? [note('话题 ' + m.thread_id)] : [])); results.append(item);
      }
      next.hidden = !result.has_more;
    } catch (err) { status.textContent = err.message; } finally { queryButton.disabled = !chats.length; }
  };
  const next = button('读取下一页本地消息', () => search(true), 'quiet'); next.hidden = true;
  controls.append(next, button('显式重新同步可见历史', async () => {
    if (!select.value) return;
    try { await api(`/api/channels/chats/${select.value}/sync`, 'POST', { full: true }); await search(); }
    catch (err) { status.textContent = err.message; }
  }, 'quiet'));
  form.append(queryButton); form.addEventListener('submit', e => { e.preventDefault(); void search(); });
  select.addEventListener('change', () => { void search(); });
  const retention = element('form', '', 'project-form'), days = channelField(retention, '保留天数（留空保留至显式清理）', 'days', '', 'number');
  days.min = '1'; days.max = '3650';
  const before = channelField(retention, '显式清理此时间之前的记录', 'before', '', 'datetime-local');
  const fresh = async () => (await api('/api/channels/chats?connector_id=' + connector.id)).chats.find(c => c.id === select.value);
  retention.append(button('保存本地保留策略', async () => {
    try { const chat = await fresh(); if (!chat) return; await api(`/api/channels/chats/${chat.id}/retention`, 'PUT', { days: days.value ? Number(days.value) : null, expected_revision: chat.revision }); await search(); }
    catch (err) { status.textContent = err.message; }
  }, 'quiet'), button('清理指定时间之前的本地记录', async () => {
    if (!before.value || !confirm('清理会删除原文及派生摘要，并保留覆盖边界。继续？')) return;
    try { const chat = await fresh(); if (!chat) return; await api(`/api/channels/chats/${chat.id}/retention`, 'DELETE', { before: new Date(before.value).getTime(), expected_revision: chat.revision }); await search(); }
    catch (err) { status.textContent = err.message; }
  }, 'quiet'));
  section.append(form, status, results, controls, retention); panel.append(section);
  if (chats.length) await search();
}

function channelLink(url, caption, className) {
  if (!url.startsWith('#/')) return link(url, caption, className);
  const anchor = element('a', caption, className); anchor.href = url; return anchor;
}
