// Personal identity proof belongs with account permissions; app credentials live in global settings.
async function feishuIdentityCard() {
  const data = await api('/api/channels/bindings'), section = card('飞书身份绑定'), request = renderVersion, nameLookups = [];
  section.id = 'feishu-identity';
  section.append(note('将本人的飞书账号关联到当前平台账户。本地账户和 GitHub 登录均可使用，无需先绑定 GitHub。之后仅能访问该账户实际获准的项目，绑定本身不会增加仓库权限。'));
  if (me.role === 'super_admin') section.append(channelLink('#/settings/feishu', '管理员：连接或管理飞书应用', 'button-link'));
  const steps = element('ol', '', 'feishu-binding-steps');
  for (const caption of ['点击下方“打开机器人私聊”，在飞书中发送 /bind（或“绑定”）。',
    '复制机器人在私聊中返回的认证字符串，粘贴到下方表单。',
    '核对当前平台账户和所选机器人，点击“确认绑定到当前账户”。']) steps.append(element('li', caption));
  if (data.applications.length) {
    section.append(steps, note('认证字符串五分钟内有效，仅可使用一次，请勿转发。'));
    const apps = element('div'); apps.setAttribute('aria-label', '可绑定的飞书应用');
    const label = a => `${a.tenant_name || '企业名称暂未获取'} · ${a.app_name || '机器人名称暂未获取'}`;
    for (const a of data.applications) {
      const row = element('div', '', 'channel-binding'), link = channelLink(a.chat_url, '打开机器人私聊', 'button-link');
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      row.append(element('strong', label(a)), link,
        note('若飞书未打开，请在飞书客户端搜索上方机器人名称；找不到时，请联系超级管理员检查应用可用范围。'));
      apps.append(row);
    }
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
          external_identity_conflict: '这个飞书身份已属于其他平台账户，请登录原账户处理。' };
        status.textContent = Object.entries(reasons).find(([key]) => err.message.includes(key))?.[1] || err.message;
        submit.disabled = false;
      }
    });
    section.append(apps, form);
  } else section.append(note('请联系超级管理员配置飞书应用。'));
  const challenge = /^#\/identity\/feishu\?challenge=([a-f0-9]{48})$/.exec(location.hash)?.[1];
  if (challenge) {
    const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
    const claim = button('绑定到当前平台账户', async () => {
      claim.disabled = true; status.textContent = '';
      try {
        await api('/api/channels/bindings/claim', 'POST', { challenge });
        history.replaceState(null, '', '#/identity/feishu'); await start();
      } catch (err) {
        const reason = { binding_expired: '绑定链接已过期，请在原飞书私聊重新发送 /bind。',
          binding_replayed: '此绑定请求已处理，请刷新状态或在原私聊重新发送 /bind。',
          binding_login_already_started: '此请求已关联平台账户，请完成原私聊确认；需要更换账户时重新发送 /bind。' };
        status.textContent = Object.entries(reason).find(([code]) => err.message.includes(code))?.[1] || err.message;
        claim.disabled = false;
      }
    }, '');
    section.append(note(`将绑定到当前平台账户：${me.username}。如需使用其他账户，请先退出登录并重新打开绑定链接。`), claim, status);
  }
  for (const p of data.pending) {
    const pending = element('div', '', 'channel-binding'); pending.setAttribute('aria-label', '待确认的飞书身份');
    pending.append(element('strong', '等待原飞书操作者确认'), facts([['平台账户', p.account.username],
      ['飞书账号', '发起本次绑定的飞书账号'], ['机器人', p.app_name || '机器人名称暂未获取'],
      ['机器人所属企业', p.tenant_name || '企业名称暂未获取'], ['有效期', new Date(p.expires_at).toLocaleString()]]),
      channelCopy('在原私聊发送的确认指令', '确认绑定 ' + p.confirmation));
    section.append(pending);
  }
  if (!data.bindings.length && !data.pending.length) section.append(element('p', '尚未绑定飞书身份', 'muted'));
  for (const b of data.bindings) {
    const row = element('div', '', 'channel-binding'), active = b.status === 'active';
    const name = () => { const value = typeof b.display_name === 'string' ? b.display_name.trim() : ''; return value && value !== b.external_actor ? value : ''; };
    const state = active ? '已绑定' : b.status === 'revoked' ? '已解绑' : '需要重新认证';
    const title = element('strong'), renderName = () => { title.textContent = `${name() || me.username + ' 的飞书账号'} · ${state}`; };
    renderName();
    row.setAttribute('aria-label', '我的飞书账号');
    row.append(title, note(`机器人：${b.app_name || '机器人名称暂未获取'}；所属企业：${b.tenant_name || '企业名称暂未获取'}`),
      note(`关联平台账户：${me.username}`));
    const nameStatus = note(name() ? '' : '飞书姓名暂不可读取，当前显示关联的平台账户。'); nameStatus.setAttribute('role', 'status');
    row.append(nameStatus);
    if (b.connection_enabled === 0) row.append(note('此机器人连接已停用。'));
    else if (b.connection_enabled === null) row.append(note('原机器人连接已不可用。'));
    if (b.can_read_name) {
      const refreshName = async () => {
        if (refresh.disabled) return;
        refresh.disabled = true; nameStatus.textContent = '正在读取飞书姓名…';
        try {
          const result = await api('/api/channels/bindings/' + encodeURIComponent(b.id) + '/name', 'POST', {});
          if (request !== renderVersion) return;
          b.display_name = result.display_name; renderName(); nameStatus.textContent = '飞书姓名已更新。';
        } catch (err) {
          if (request !== renderVersion) return;
          const changed = ['authorization_changed', 'external_binding_required', 'identity_not_found', 'channel_connector_inactive', 'channel_configuration_changed', 'login_required'].some(code => err.message.includes(code));
          nameStatus.textContent = changed ? '绑定或机器人连接状态已变化，请刷新飞书绑定状态。' : name() ? '暂时无法更新飞书姓名，保留上次读取的姓名。' : '飞书暂未提供姓名，当前显示关联的平台账户。';
        } finally { refresh.disabled = false; }
      };
      const refresh = button('刷新飞书姓名', refreshName, 'quiet'); row.append(refresh);
      if (!name()) nameLookups.push(refreshName);
    }
    if (active) row.append(button('解除飞书绑定', async () => {
      if (!confirm('解除绑定后，这个飞书身份不能继续管理项目。继续？')) return;
      try { await api('/api/identity/bindings/' + b.id, 'DELETE', {}); await start(); } catch (err) { error(err); }
    }, 'quiet'));
    else row.append(note('需要恢复时，在原飞书私聊发送 /reauth，重新完成双端验证。'));
    section.append(row);
  }
  section.append(button('刷新飞书绑定状态', () => start().catch(error), 'quiet'), note('绑定后可直接说“你好”“我能管理哪些项目”或“看看 bot 项目的任务”；需要明确目标时，助手会按名称追问。群聊由维护人在下方「飞书群聊助手」绑定后，群成员无需逐人绑定。'));
  // Names are presentation metadata: render immediately, then fill missing names without blocking the identity page.
  void (async () => { for (const lookup of nameLookups) { if (request !== renderVersion) break; await lookup(); } })();
  section.append(await channelServiceBindingSettings(), await channelPersonalChats());
  return section;
}
const employeeErrors = { channel_employee_revalidation_required: '群成员正在重新核验，受保护动作暂时暂停。', channel_employee_member_required: '你或来源成员当前不在这个群中。',
  external_binding_required: '需要先完成本人的飞书身份绑定。', capability_forbidden: '你在所选仓库或组织没有配置权限（config.write）。', channel_employee_source_inactive: '应用已停用、机器人已移出或群已归档。',
  channel_employee_project_inactive: '项目已停用。', channel_employee_disabled: '旧群员工授权已停用。',
  channel_employee_sync_paused: '群授权或受众待核验，历史同步已暂停。', channel_bot_not_in_chat: '机器人当前不在这个群中。',
  channel_audience_unverified: '平台未提供完整成员范围，暂时无法核验。', channel_history_forbidden: '需要该群助手的配置人，或在其全部项目范围内有配置权限。',
  channel_audience_permission_required: '飞书应用还没有读取群成员的权限，无法核验你是否在群中。请超级管理员在「全局设置 → 飞书连接」查看缺少的权限，为应用开通 im:chat.members:read 并发布新版本后再保存。',
  channel_revision_conflict: '这个群的配置已被其他人修改，请刷新本页后重新保存。', service_role_unavailable: '所选服务角色已停用。', service_role_not_bindable: '管理助手不能绑定到群聊。',
  channel_service_scope_paused: '配置人在全部所选仓库的权限都已变化，助手暂停。', channel_service_binding_disabled: '群聊助手已停用。',
  channel_destination_forbidden: '只有私聊的本人，或能管理该群聊助手的人可以登记。', schedule_destination_binding_required: '这个群没有启用的群聊助手绑定。',
  channel_service_binding_forbidden: '只有配置人、超级管理员或在全部范围内有配置权限的维护人可以停用。', channel_service_scope_invalid: '请至少选择一个仓库，或选择一个组织。',
  service_role_model_not_configured: '服务角色尚未配置模型，请超级管理员在「全局设置 → 服务角色」中选择。' };
const employeeError = value => Object.entries(employeeErrors).find(([key]) => String(value).includes(key))?.[1] || String(value);
// Notification destinations are registered here (#312); schedules and event subscriptions then pick them.
function channelDestinations(chatId, projects, registered) {
  const box = element('div', '', 'channel-destinations'), form = element('form', '', 'project-form');
  box.append(element('strong', '通知目的地'));
  for (const d of registered.filter(item => item.chat_id === chatId)) {
    const row = element('div', '', 'channel-binding');
    row.append(note(`已登记：${d.full_name || '项目已不可见'}（${new Date(d.created_at).toLocaleString()}）`), button('撤销此通知目的地', async () => {
      try { await api('/api/channels/destinations/' + d.id, 'DELETE', {}); await start(); } catch (err) { error(err); }
    }, 'quiet'));
    box.append(row);
  }
  if (!projects.length) { box.append(note('没有可登记的项目。')); return box; }
  const project = channelSelect(form, '通知项目', 'destination_project_' + chatId, projects.map(p => [p.id, p.full_name]));
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const save = element('button', '登记为通知目的地'); save.type = 'submit';
  form.append(note('登记后，可以在项目「定时计划」中把日报和事件订阅发到这里；登记本身不发送消息，每次发送前仍检查当前权限。'), status, save);
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '';
    try { await api('/api/channels/chats/' + chatId + '/destinations', 'POST', { project_id: project.value }); await start(); }
    catch (err) { status.textContent = employeeError(err.message); save.disabled = false; }
  });
  box.append(form); return box;
}
const participationOptions = [['mentions', '仅回应 @'], ['questions', '回应 @ 及以问号结尾的文字'], ['all', '读取每条新文字后判断是否发言']];
const bindingStates = { active: '生效中', paused: '已暂停', disabled: '已停用' };
// A group binds one service role and one project scope; members use it without binding themselves.
async function channelServiceBindingSettings() {
  const [data, { destinations }] = await Promise.all([api('/api/channels/service-bindings'), api('/api/channels/destinations')]), box = card('飞书群聊助手'), form = element('form', '', 'project-form');
  box.append(note('为机器人所在的群选择一个服务角色和项目范围（整个组织或多个仓库）。群成员无需绑定或授权，按这里的配置使用助手，也不需要先选项目。配置人需要已绑定飞书、在该群中，并对所选仓库（或整个组织）有配置权限；配置人失去某个仓库的权限时，只暂停该仓库。'));
  const chats = new Map([...data.chats.map(c => [c.id, `${c.app_name || c.app_id || '已配置群'} · ${c.chat_id}`]), ...data.bindings.filter(b => !data.chats.some(c => c.id === b.chat_id)).map(b => [b.chat_id, `${b.chat.app_name || '已配置群'} · ${b.chat.chat_id}`])]);
  const chat = channelSelect(form, '助手所在群', 'binding_chat', [...chats]);
  const role = channelSelect(form, '服务角色', 'binding_role', data.service_roles.map(r => [r.id, r.name + (r.recommended ? '（推荐）' : '')]));
  const roleNote = note(''); form.append(roleNote);
  const scope = element('fieldset', '', 'role-choices'); scope.append(element('legend', '项目范围'));
  const kind = name => { const control = document.createElement('input'); control.type = 'radio'; control.name = 'binding_scope'; control.value = name; return control; };
  const repositoriesKind = kind('repositories'), organizationKind = kind('organization');
  const repositoriesLabel = element('label', '', 'check'), organizationLabel = element('label', '', 'check');
  repositoriesLabel.append(repositoriesKind, ' 选择仓库'); organizationLabel.append(organizationKind, ' 整个组织');
  const repositories = element('div', '', 'role-choices'); repositories.setAttribute('aria-label', '可选择的仓库');
  const boxes = new Map(data.projects.map(p => { const wrap = checkbox('binding_repository:' + p.id, false, p.full_name); repositories.append(wrap); return [p.id, wrap.querySelector('input')]; }));
  const organization = document.createElement('select'); organization.setAttribute('aria-label', '组织');
  for (const o of data.organizations) organization.add(new Option(o.name, o.id));
  organizationKind.disabled = !data.organizations.length;
  scope.append(repositoriesLabel, repositories, organizationLabel, field('组织', organization), ...(data.organizations.length ? [] : [note('你没有组织级配置权限，只能选择仓库。')]));
  form.append(scope);
  const participation = channelSelect(form, '助手发言范围', 'binding_participation', participationOptions);
  form.append(note('注意：群内所有成员都能看到助手读取的所选仓库内容（包括私有仓库），由配置人负责控制范围。所有获准消息都会存入本地；扩大发言范围会增加模型用量，用量记在服务角色上，不计入项目。'));
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const save = element('button', '保存群聊助手'); save.type = 'submit';
  form.append(status, save);
  let expected = 0;
  const describeRole = () => {
    const r = data.service_roles.find(item => item.id === role.value);
    const labels = { none: '禁止', read: '只读', write: '读写', allow: '允许', deny: '拒绝' };
    roleNote.textContent = r ? `${r.responsibility || '自定义服务角色'} 权限：${data.permission_items.map(item => item.name + ' ' + (labels[r.permissions[item.id]] || '禁止')).join('；')}。` : '';
  };
  const showScope = () => { repositories.hidden = !repositoriesKind.checked; organization.closest('label').hidden = !organizationKind.checked; };
  const fill = () => {
    const current = data.bindings.find(b => b.chat_id === chat.value);
    expected = current?.revision || 0;
    role.value = current?.enabled && data.service_roles.some(r => r.id === current.service_role.id) ? current.service_role.id : (data.service_roles.find(r => r.recommended) || data.service_roles[0])?.id || '';
    participation.value = current?.participation || 'mentions';
    const org = current?.enabled && current.scope.organization;
    organizationKind.checked = !!org && !organizationKind.disabled; repositoriesKind.checked = !organizationKind.checked;
    if (org) organization.value = org.id;
    for (const [id, input] of boxes) input.checked = !!current?.enabled && current.scope.repositories.some(r => r.id === id);
    describeRole(); showScope();
  };
  for (const control of [repositoriesKind, organizationKind]) control.addEventListener('change', showScope);
  role.addEventListener('change', describeRole); chat.addEventListener('change', fill);
  save.disabled = !chats.size || !data.service_roles.length || !data.projects.length && !data.organizations.length;
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '正在核验你的飞书绑定、群成员身份和所选范围的配置权限…';
    const selected = organizationKind.checked ? { kind: 'organization', organization: organization.value } : { kind: 'repositories', repositories: [...boxes].filter(([, input]) => input.checked).map(([id]) => id) };
    try {
      await api('/api/channels/chats/' + chat.value + '/service-binding', 'PUT', { service_role_id: role.value, scope: selected, participation: participation.value, enabled: true, expected_revision: expected });
      await start();
    } catch (err) { status.textContent = employeeError(err.message); save.disabled = false; }
  });
  if (!chats.size) box.append(note('尚无可选择的群。请先完成个人绑定，在机器人已加入的目标群发一条消息，再刷新本页。'));
  if (!data.projects.length && !data.organizations.length) box.append(note('当前没有可配置的仓库。个人绑定不会增加项目权限。'));
  if (!data.service_roles.length) box.append(note('当前没有可用于群聊的服务角色，请联系超级管理员。'));
  box.append(form); if (chats.size) fill();
  for (const b of data.bindings) {
    const row = element('article', '', 'channel-binding'), scopeText = b.scope.organization ? '整个组织 ' + b.scope.organization.name : b.scope.repositories.map(r => r.full_name).join('、');
    row.setAttribute('aria-label', '群聊助手绑定');
    row.append(element('strong', `${bindingStates[b.state] || b.state} · ${b.service_role.name || '服务角色已删除'}`), note(`群：${b.chat.app_name ? b.chat.app_name + ' · ' : ''}${b.chat.chat_id}`),
      note('项目范围：' + scopeText), note('发言范围：' + (participationOptions.find(([id]) => id === b.participation)?.[1] || b.participation) + (b.configured_by ? '；配置人：' + b.configured_by : '')),
      ...(b.paused.length ? [note('暂停的仓库（配置人权限已变化）：' + b.paused.join('、'))] : []), ...(b.migrated ? [note('由旧群员工自动迁移为仓库问答助手。')] : []),
      ...(b.error ? [note(employeeError(b.error))] : []));
    const history = element('div');
    row.append(button('查看连续会话', () => channelConversation(b.chat_id, history).catch(err => error(err)), 'quiet'), button('查询该群本地记录', () => channelEmployeeHistory(b, history).catch(err => error(err)), 'quiet'));
    if (b.enabled && b.can_manage) row.append(button('停用群聊助手', async () => {
      try { await api('/api/channels/chats/' + b.chat_id + '/service-binding', 'PUT', { enabled: false, expected_revision: b.revision }); await start(); }
      catch (err) { error(err); }
    }, 'quiet'));
    if (b.enabled && b.can_manage) row.append(channelDestinations(b.chat_id, b.reachable_projects, destinations));
    row.append(history); box.append(row);
  }
  const legacy = data.legacy_employees.filter(g => g.enabled);
  if (legacy.length) {
    const old = element('div'); old.append(element('h4', '旧群员工'), note('旧群员工已不再接收群消息，只用于继续核验升级前已创建的任务。确认这些任务不再需要后可以停用。'));
    for (const g of legacy) {
      const row = element('article', '', 'channel-binding');
      row.append(element('strong', `仍有效 · ${g.full_name} · ${g.role_id}`), note(`未结束的任务：${g.open_tasks} 个`), button('停用旧群员工授权', async () => {
        try { await api('/api/channels/chats/' + g.chat_id + '/employee', 'PUT', { project_id: g.project_id, enabled: false, expected_revision: g.revision }); await start(); }
        catch (err) { error(err); }
      }, 'quiet'));
      old.append(row);
    }
    box.append(old);
  }
  return box;
}
async function channelPersonalChats() {
  const [data, { destinations }] = await Promise.all([api('/api/channels/employees'), api('/api/channels/destinations')]), personal = card('我的飞书私信会话');
  personal.append(note('私信与控制台管理对话共用管理助手、当前授权与执行回执。可按项目或任务名称提问并继续选择，无需先选项目。同一私信跨项目和话题延续上下文，个人记录不进入群聊。'));
  if (!data.personal_chats.length) personal.append(note('绑定后先在飞书私聊发一条普通消息，再刷新此页。'));
  for (const chat of data.personal_chats) {
    const row = element('article', '', 'channel-binding'), target = element('div');
    row.append(element('strong', '私信 ' + chat.chat_id), button('查看私信连续会话', () => channelConversation(chat.id, target).catch(error), 'quiet'),
      button('查询私信本地记录', () => channelEmployeeHistory({ chat_id: chat.id }, target).catch(error), 'quiet'));
    row.append(channelDestinations(chat.id, data.projects.map(p => ({ id: p.id, full_name: p.full_name })), destinations), target); personal.append(row);
  }
  return personal;
}
async function channelConversation(id, target) {
  target.replaceChildren(); const summary = element('div'), turns = element('div'), status = note(''), controls = element('div', '', 'actions');
  turns.setAttribute('aria-label', '连续会话记录'); status.setAttribute('role', 'status'); let offset = 0;
  const next = button('下一页会话记录', () => read(true), 'quiet'); next.hidden = true;
  const read = async more => {
    try {
      if (!more) { offset = 0; turns.replaceChildren(); }
      const result = await api('/api/channels/chats/' + id + '/conversation?offset=' + offset); offset = result.next_offset;
      const scopeText = result.binding ? (result.binding.scope.organization ? '整个组织 ' + result.binding.scope.organization.name : result.binding.scope.repositories.map(r => r.full_name).join('、')) : '';
      summary.replaceChildren(facts([['会话', result.mode === 'management' ? '个人飞书管理会话' : result.mode === 'service' ? '群聊助手会话（' + (result.binding.service_role.name || '服务角色已删除') + '）' : result.conversation_id],
        ['管理范围', result.mode === 'management' ? '全部有权项目（按请求确定目标）' : result.mode === 'service' ? scopeText : result.current_project || '尚未选择'], ['模型请求记录', String(result.usage.requests || 0)], ['用量未完整核验', String(result.usage.usage_missing_requests || 0)],
        ['后端未报告实际请求次数的回合', String(result.usage.provider_request_count_unknown || 0)],
        ['已记录费用', result.usage.costs.map(c => c.currency + ' ' + c.amount).join('、') || '尚无已定价费用'], ['未知费用请求', String(result.usage.unpriced_requests || 0)]]));
      status.textContent = '本地同步：' + channelSyncText(result.sync_state) + '。未核验／缺口：' + result.gaps.map(g => channelGapText(g.reason)).join('、') + '。费用只汇总同一模型请求账本，未知金额不按零处理。';
      for (const turn of result.turns) {
        const row = element('article', '', 'channel-binding');
        if (result.mode === 'management') row.append(element('strong', '管理助手 · ' + turn.state), note(new Date(turn.created_at).toLocaleString()),
          ...(turn.request ? [element('p', '我：' + turn.request)] : []), element('p', turn.reply || '等待处理'), channelLink('#/management', '打开管理对话与执行记录'));
        else if (result.mode === 'service') row.append(element('strong', turn.role_id + ' · ' + turn.state), note(new Date(turn.created_at).toLocaleString()),
          element('p', turn.reply || (turn.stale_source ? '来源或授权范围已变化，旧回答不再展示。' : turn.state === 'completed' ? '本轮保持安静。' : '本轮未完成：' + employeeError(turn.error || turn.state))));
        else row.append(element('strong', turn.role_id + ' · 项目 ' + turn.project_id), note(new Date(turn.created_at).toLocaleString() + ' · 来源 ' + turn.source_message),
          element('p', turn.reply || (turn.stale_source ? '来源或授权范围已变化，旧派生回答不再展示。' : turn.state === 'completed' ? '本轮保持安静。' : '本轮未完成：' + (turn.error || turn.state))),
          channelLink('#/projects/' + turn.project_id + '/overview/all', '查看同一项目任务看板')); turns.append(row);
      }
      if (!result.turns.length && !more) turns.append(note('当前授权范围暂无会话回合。原始本地消息可通过记录搜索查询。'));
      next.hidden = !result.has_more;
    } catch (err) { status.textContent = employeeError(err.message); }
  };
  controls.append(button('刷新连续会话', () => read(false), 'quiet'), next); target.append(summary, status, turns, controls); await read(false);
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
async function channelDiagnostics(c, panel) {
  const [{ operations }, { deliveries }] = await Promise.all([api('/api/channels/connectors/' + c.id + '/events'), api('/api/channels/connectors/' + c.id + '/outbox')]);
  const view = card('连接健康与收发记录');
  view.append(facts([['连接状态', c.enabled ? '启用' : '停用'], ['传输状态', c.transport === 'http' ? 'HTTP 事件回调' : c.health.connection_state],
    ['最后收到事件', c.health.last_received_at ? new Date(c.health.last_received_at).toLocaleString() : '尚未收到'], ['诊断', c.health.last_error || '无'], ['待处理', c.health.queued], ['发送失败', c.health.failed]]),
    note('应用鉴权成功或长连接已连接，都不能证明消息已经送达。请完成发布并在飞书中实测。群聊的项目范围在「身份与权限 → 飞书群聊助手」为每个群单独设置。'));
  for (const op of operations.slice(0, 10)) view.append(note(`渠道操作 ${op.operation_id} · ${op.state}${op.error ? ' · ' + op.error : ''}${op.conversation_id ? ' · 会话 ' + op.conversation_id : ''}`));
  if (operations.some(op => op.reaction_error === 'channel_reaction_permission_required'))
    view.append(note('处理中表情暂不可用：请在飞书开通应用身份权限 im:message.reactions:write_only，并发布新版本。普通消息回复不受影响。'));
  else if (operations.some(op => op.reaction_error)) view.append(note('部分处理中表情添加或清理未成功，可在收件诊断中查看；普通消息回复继续处理。'));
  for (const d of deliveries.slice(0, 10)) view.append(note(`发送 ${d.id} · ${d.state} · 尝试 ${d.attempts}${d.last_error ? ' · ' + d.last_error : ''}`));
  panel.append(view);
  await channelHistory(c, panel);
}

async function channelHistory(connector, panel) {
  const section = card('本地消息与历史同步'), { chats } = await api('/api/channels/chats?connector_id=' + connector.id);
  section.append(note('搜索只读取本地密封消息库，不向飞书回源。同步完成仅代表已遍历平台返回的可见范围，不能证明入群前历史或所有编辑均可见。附件当前仅保存资源引用，尚未下载或解析。'));
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
          element('p', m.content || '仅保存附件或资源引用，未解析'), ...(m.thread_id ? [note('话题 ' + m.thread_id)] : [])); results.append(item);
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
