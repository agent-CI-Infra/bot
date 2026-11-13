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
