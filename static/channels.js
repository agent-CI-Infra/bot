// Personal identity proof belongs with account permissions; app credentials live in global settings.
async function feishuIdentityCard() {
  const data = await api('/api/channels/bindings'), section = card('飞书身份绑定'); section.id = 'feishu-identity';
  section.append(note('将本人的飞书账号关联到当前平台账户。本地账户和 GitHub 登录均可使用，无需先绑定 GitHub。之后仅能访问该账户实际获准的项目，绑定本身不会增加仓库权限。'));
  if (me.role === 'super_admin') section.append(channelLink('#/settings/feishu', '管理员：连接或管理飞书应用', 'button-link'));
  const steps = element('ol', '', 'feishu-binding-steps');
  for (const caption of ['在飞书搜索管理员配置的机器人，打开私聊，发送 /bind（或“绑定”）。',
    '打开机器人返回的链接，使用本地账户或 GitHub 登录平台；核对当前账户并确认绑定。',
    '复制确认指令，回到发起绑定的同一个飞书私聊发送；然后刷新绑定状态。']) steps.append(element('li', caption));
  section.append(steps, note('绑定链接和确认指令五分钟内有效。必须由原飞书操作者在原私聊完成确认；只登录平台或转发链接不会完成绑定。'));
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
  if (data.applications.length) section.append(note('可绑定的飞书应用：' + data.applications.map(a => a.app_id).join('、')));
  else section.append(note('尚无已启用的飞书应用。请管理员在「全局设置 → 飞书连接」完成应用接入；如已有机器人，也可直接从它的私聊发起绑定。'));
  for (const p of data.pending) {
    const pending = element('div', '', 'channel-binding'); pending.setAttribute('aria-label', '待确认的飞书身份');
    pending.append(element('strong', '等待原飞书操作者确认'), facts([['平台账户', p.account.username],
      ['飞书应用', p.app_id], ['安装租户', p.installation_tenant], ['操作者租户', p.actor_tenant], ['飞书 open_id', p.open_id], ['有效期', new Date(p.expires_at).toLocaleString()]]),
      channelCopy('在原私聊发送的确认指令', '确认绑定 ' + p.confirmation));
    section.append(pending);
  }
  if (!data.bindings.length && !data.pending.length) section.append(element('p', '尚未绑定飞书身份', 'muted'));
  for (const b of data.bindings) {
    const row = element('div', '', 'channel-binding'), active = b.status === 'active';
    row.append(element('strong', `${b.external_actor} · ${active ? '已绑定' : b.status === 'revoked' ? '已解绑' : '需要重新认证'}`), note(`飞书应用 ${b.connector.replace(/^[a-f0-9]{48}:/, '')}；操作者租户 ${b.external_tenant}`));
    if (active) row.append(button('解除飞书绑定', async () => {
      if (!confirm('解除绑定后，这个飞书身份不能继续管理项目。继续？')) return;
      try { await api('/api/identity/bindings/' + b.id, 'DELETE', {}); await start(); } catch (err) { error(err); }
    }, 'quiet'));
    else row.append(note('需要恢复时，在原飞书私聊发送 /reauth，重新完成双端验证。'));
    section.append(row);
  }
  section.append(button('刷新飞书绑定状态', () => start().catch(error), 'quiet'), note('绑定后私聊发送 /project <项目ID> 查询任务状态。群内需 @ 机器人，并由管理员单独批准群接收范围。'));
  section.append(await channelEmployeeSettings());
  return section;
}
const employeeErrors = { channel_employee_revalidation_required: '群成员正在重新核验，受保护动作暂时暂停。', channel_employee_member_required: '维护人或来源成员已不在群中。',
  external_binding_required: '维护人需要有效的个人飞书绑定。', capability_forbidden: '维护人的当前项目权限不足。', channel_employee_source_inactive: '应用已停用、机器人已移出或群已归档。',
  channel_employee_project_inactive: '项目已停用。', channel_employee_role_unavailable: '所选角色不存在或已停用。', channel_employee_disabled: '群员工授权已停用。',
  channel_employee_sync_paused: '群授权或受众待核验，历史同步已暂停。', channel_bot_not_in_chat: '机器人当前不在这个群中。',
  channel_audience_unverified: '平台未提供完整成员范围，暂时无法核验。', channel_history_forbidden: '需要该群当前维护人及有效项目配置权限。' };
const employeeError = value => Object.entries(employeeErrors).find(([key]) => String(value).includes(key))?.[1] || String(value);
async function channelEmployeeSettings() {
  const data = await api('/api/channels/employees'), box = card('我维护的群员工'), form = element('form', '', 'project-form');
  box.append(note('有目标项目配置资格且已绑定飞书的群成员可以维护授权。普通成员使用群员工无需逐个绑定。群成员和维护人的权限会自动复核；无法确认时暂停受保护动作。'));
  const chats = new Map([...data.chats, ...data.employees.map(g => ({ id: g.chat_id, chat_id: data.chats.find(c => c.id === g.chat_id)?.chat_id || g.chat_id }))].map(c => [c.id, c]));
  const chat = channelSelect(form, '员工所在群', 'employee_chat', [...chats.values()].map(c => [c.id, `${c.app_name || c.app_id || '已配置群'} · ${c.chat_id}`]));
  const project = channelSelect(form, '员工授权项目', 'employee_project', data.projects.map(p => [p.id, p.full_name]));
  const role = channelSelect(form, '员工使用角色', 'employee_role', []), caps = new Map();
  for (const [id, title] of [['tasks.read', '读取获准任务'], ['tasks.manage_own', '管理自己拥有或已分派的事项'], ['knowledge.read', '读取获准项目知识'], ['knowledge.write', '记录获准项目知识']]) {
    const input = channelField(form, title, 'employee_' + id, '', 'checkbox'); input.checked = id !== 'knowledge.write'; input.disabled = id === 'tasks.read'; caps.set(id, input);
  }
  const status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  const link = channelLink('#/projects/' + project.value + '/roles', '配置角色的任务管理、委派与 GitHub 能力');
  let expected = 0;
  const refresh = async () => {
    role.replaceChildren();
    if (!project.value) return;
    try {
      const result = await api('/api/repositories/' + project.value + '/roles');
      for (const r of result.configuration.roles.filter(r => r.enabled && r.kind !== 'evaluator' && r.role_id !== 'coordinator')) role.add(new Option(r.name || r.role_id, r.role_id));
      const current = data.employees.find(g => g.chat_id === chat.value && g.project_id === project.value); expected = current?.revision || 0;
      if (current) { role.value = current.role_id; for (const [id, input] of caps) input.checked = current.capabilities.includes(id); }
      link.href = '#/projects/' + project.value + '/roles';
    } catch (err) { status.textContent = employeeError(err.message); }
  };
  const save = element('button', '保存群员工授权'); save.type = 'submit'; save.disabled = !chats.size || !data.projects.length;
  form.append(link, status, save); project.addEventListener('change', () => void refresh()); chat.addEventListener('change', () => void refresh());
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '正在核验当前绑定、项目权限与群成员…';
    try {
      await api('/api/channels/chats/' + chat.value + '/employee', 'PUT', { project_id: project.value, role_id: role.value,
        capabilities: [...caps].filter(([, input]) => input.checked).map(([id]) => id), enabled: true, expected_revision: expected });
      await start();
    } catch (err) { status.textContent = employeeError(err.message); save.disabled = false; }
  });
  if (!chats.size) box.append(note('尚无可选择的群。请先完成个人绑定，在机器人已加入的目标群发一条消息，再刷新本页。'));
  if (!data.projects.length) box.append(note('当前没有可配置的项目。个人绑定不会增加项目权限。'));
  box.append(form); if (chats.size && data.projects.length) await refresh();
  for (const g of data.employees) {
    const row = element('article', '', 'channel-binding'), state = ({ active: '授权有效', paused: '已暂停', disabled: '已停用' })[g.state] || g.state;
    row.append(element('strong', `${state} · 项目 ${g.project_id} · ${g.role_id}`), note('群会话 ' + g.conversation_id), ...(g.error ? [note(employeeError(g.error))] : []));
    const history = element('div');
    row.append(button('查询该群本地记录', () => channelEmployeeHistory(g, history).catch(err => error(err)), 'quiet'), history);
    if (g.enabled) row.append(button('停用此群员工授权', async () => {
      try { await api('/api/channels/chats/' + g.chat_id + '/employee', 'PUT', { project_id: g.project_id, enabled: false, expected_revision: g.revision }); await start(); }
      catch (err) { error(err); }
    }, 'quiet'));
    box.append(row);
  }
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
async function channelDiagnostics(c, panel) {
  const [{ groups }, { projects }, { operations }, { deliveries }] = await Promise.all([
    api('/api/channels/connectors/' + c.id + '/groups'), api('/api/management/query', 'POST', { operation: 'list_projects', target: {}, arguments: { limit: 100 } }),
    api('/api/channels/connectors/' + c.id + '/events'), api('/api/channels/connectors/' + c.id + '/outbox')]);
  const view = card('连接健康与群接收范围');
  view.append(facts([['连接状态', c.enabled ? '启用' : '停用'], ['传输状态', c.transport === 'http' ? 'HTTP 事件回调' : c.health.connection_state],
    ['最后收到事件', c.health.last_received_at ? new Date(c.health.last_received_at).toLocaleString() : '尚未收到'], ['诊断', c.health.last_error || '无'], ['待处理', c.health.queued], ['发送失败', c.health.failed]]),
    note('应用鉴权成功或长连接已连接，都不能证明消息、卡片回调已配置。请完成发布并在飞书中实测。'));
  const mapping = element('form', '', 'project-form');
  const project = channelSelect(mapping, '项目', 'project', projects.map(p => [p.id, p.full_name]));
  const chat = channelField(mapping, '群 chat_id', 'chat_id'); chat.required = true;
  const sensitivity = channelSelect(mapping, '允许的敏感级别', 'sensitivity', [['public', '公开'], ['private', '私有']]);
  const details = channelField(mapping, '允许群接收详细结果', 'details', '', 'checkbox'), attest = channelField(mapping, '我已核实群受众（授权一小时；成员变更即失效）', 'attest', '', 'checkbox');
  const message = element('p', '', 'view-error'), approve = element('button', '批准或更新群范围'); message.setAttribute('role', 'alert'); approve.type = 'submit';
  mapping.append(message, approve); approve.disabled = !project.options.length;
  mapping.addEventListener('submit', async e => {
    e.preventDefault(); approve.disabled = true; message.textContent = '';
    const current = groups.find(s => s.chat_id === chat.value && s.project_id === project.value);
    try { await api('/api/channels/connectors/' + c.id + '/groups', 'PUT', { chat_id: chat.value, project_id: project.value, fields: ['summary', 'status', 'operation', ...(details.checked ? ['result'] : [])], sensitivity: sensitivity.value,
      audience_verified_until: attest.checked ? Date.now() + 3590000 : 0, enabled: true, expected_revision: current?.revision ?? 0 }); await render(); }
    catch (err) { message.textContent = err.message; } finally { approve.disabled = !project.options.length; }
  }); view.append(mapping);
  for (const g of groups) {
    const row = element('div', '', 'channel-binding'); row.append(note(`${g.chat_id} → 项目 ${g.project_id} · ${g.fields.join(', ')} · ${g.enabled && g.audience_verified_until > Date.now() ? '已核实受众' : '未授权或需重新核实'}`));
    row.append(button('撤销群范围', async () => {
      try { await api('/api/channels/connectors/' + c.id + '/groups', 'PUT', { chat_id: g.chat_id, project_id: g.project_id, fields: g.fields, sensitivity: g.sensitivity, audience_verified_until: 0, enabled: false, expected_revision: g.revision }); await render(); }
      catch (err) { error(err); }
    }, 'quiet')); view.append(row);
  }
  for (const op of operations.slice(0, 10)) view.append(note(`渠道操作 ${op.operation_id} · ${op.state}${op.error ? ' · ' + op.error : ''}${op.conversation_id ? ' · 会话 ' + op.conversation_id : ''}`));
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
