// Organization and platform administrators hand a group binding to someone who can configure its whole scope (#424).
function channelOwnerTransfer(binding) {
  const box = element('form', '', 'project-form'), status = element('p', '', 'view-error'); status.setAttribute('role', 'alert');
  if (!binding.owner_candidates.length) { box.append(note('转交负责人：暂无其他对全部项目范围有配置权限的账户。')); return box; }
  const owner = channelSelect(box, '转交负责人给', 'binding_owner_' + binding.chat_id, binding.owner_candidates.map(c => [c.id, c.username]));
  const submit = element('button', '转交负责人', 'quiet'); submit.type = 'submit'; box.append(status, submit);
  box.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; status.textContent = '';
    const name = owner.selectedOptions[0]?.textContent || '';
    const confirmed = await askConfirm({
      title: '转交群聊助手负责人',
      body: [`把这个群聊助手的负责人转交给 ${name}？转交后原负责人不能再修改它。`],
      action: '确认转交',
      danger: true,
    });
    if (!confirmed) { submit.disabled = false; return; }
    try { await api('/api/channels/chats/' + binding.chat_id + '/service-binding/owner', 'PUT', { owner_id: owner.value, expected_revision: binding.revision }); await start(); }
    catch (err) { status.textContent = employeeError(readErrorText(err)); submit.disabled = false; }
  });
  return box;
}

async function channelEmployeeHistory(grant, target, alive = () => true) {
  target.replaceChildren();
  const form = element('form', '', 'project-form');
  const keyword = channelField(form, '消息关键词', 'keyword');
  const sender = channelField(form, '发送者 ID', 'sender_id');
  const messageId = channelField(form, '消息 ID', 'message_id');
  const reply = channelField(form, '回复的消息 ID', 'reply_to');
  const from = channelField(form, '开始时间', 'from', '', 'datetime-local');
  const to = channelField(form, '结束时间', 'to', '', 'datetime-local');
  const submit = element('button', '搜索本地记录'); submit.type = 'submit';
  const status = element('p', '', 'muted'), results = element('div'), controls = element('div', '', 'actions');
  status.setAttribute('role', 'status');
  results.setAttribute('aria-label', '本地消息搜索结果');
  let cursor = null;
  const next = button('读取下一页本地消息', () => read(true), 'quiet'); next.hidden = true;
  const read = async (more = false) => {
    if (!alive() || !target.isConnected) return;
    submit.disabled = true; next.disabled = true;
    try {
      if (!more) { cursor = null; results.replaceChildren(); }
      const query = new URLSearchParams({ limit: '50' });
      for (const control of [keyword, sender, messageId, reply]) if (control.value.trim()) query.set(control.name, control.value.trim());
      for (const control of [from, to]) if (control.value) query.set(control.name, String(new Date(control.value).getTime()));
      if (cursor) query.set('cursor', cursor);
      const result = await api(`/api/channels/chats/${grant.chat_id}/messages?${query}`);
      if (!alive() || !target.isConnected) return;
      cursor = result.next_cursor;
      status.textContent = `同步：${channelSyncText(result.sync_state)}。缺口／未核验：${result.gaps.map(g => channelGapText(g.reason)).join('、')}。保留策略：${result.retention.days === null ? '保留至管理员显式清理' : result.retention.days + ' 天'}。`;
      if (!result.messages.length && !more) results.append(note('本地已同步范围没有匹配消息；这不代表飞书历史中从未存在。'));
      for (const m of result.messages) {
        const item = element('article', '', 'channel-binding');
        item.append(
          element('strong', `${m.sender_id || '未知发送者'} · ${m.message_type}`),
          note(timestamp(m.created_at) + ' · ' + m.message_id),
          element('p', m.content || '此消息没有可显示的文本'),
          ...(m.resources || []).map(r => note(`附件：${r.name} · ${{ pending: '待下载', ready: '可用', failed: '读取失败' }[r.state] || r.state}${r.size === null ? '' : ' · ' + r.size + ' 字节'}${r.mime ? ' · ' + r.mime : ''}${r.error ? ' · ' + r.error : ''}`)),
          ...(m.thread_id ? [note('话题 ' + m.thread_id)] : []),
        );
        results.append(item);
      }
      next.hidden = !result.has_more;
    } catch (err) {
      if (alive() && target.isConnected) status.textContent = employeeError(readErrorText(err));
    } finally {
      if (alive() && target.isConnected) { submit.disabled = false; next.disabled = false; }
    }
  };
  form.append(submit);
  form.addEventListener('submit', event => { event.preventDefault(); void read(false); });
  controls.append(next);
  target.append(
    note('搜索只读取本地密封消息库，不向飞书回源。图片和文件按消息保存来源；获授权助手读取时才下载，撤回和清理后不可再访问。'),
    form, status, results, controls,
  );
  await read(false);
  return { refresh: () => read(false) };
}

const channelSyncText = state => ({ active: '运行中', syncing: '正在同步', visible_range_complete: '可见范围已完成本次同步', blocked: '同步受阻', paused: '暂停', removed: '机器人已移出', archived: '群已归档', connector_deleted: '应用连接已删除' })[state] || state;
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
  const view = typeof settingsCard === 'function' ? settingsCard('连接健康与收发记录') : card('连接健康与收发记录');
  const transportLabel = typeof feishuActivityInfo === 'function' ? feishuActivityInfo(c).text : (c.transport === 'http' ? 'HTTP 事件回调' : c.health.connection_state);
  const actions = element('div', '', 'feishu-page-actions');
  actions.append(channelLink('#/conversations?connector=' + encodeURIComponent(c.id), '查看该应用的飞书会话', 'button-link quiet'));
  view.append(facts([['启用状态', c.enabled ? '已启用' : '已停用'], ['活跃状态', transportLabel],
    ['最后收到事件', c.health.last_received_at ? timestamp(c.health.last_received_at) : '尚未收到'], ['诊断', c.health.last_error || '无'], ['待处理', c.health.queued], ['发送失败', c.health.failed]]),
    note('应用鉴权成功或长连接已连接，都不能证明消息已经送达。请完成发布并在飞书中实测。群聊的项目范围与服务角色在「个人设置 → 飞书绑定」中为每个群单独设置；本地消息搜索、历史重同步与保留清理请在「飞书会话」中按会话操作。'),
    actions);
  if (!operations.length && !deliveries.length) view.append(note('暂无收发记录。'));
  for (const op of operations.slice(0, 10)) view.append(note(`渠道操作 ${op.operation_id} · ${op.state}${op.error ? ' · ' + op.error : ''}${op.conversation_id ? ' · 会话 ' + op.conversation_id : ''}`));
  if (operations.some(op => op.reaction_error === 'channel_reaction_permission_required'))
    view.append(note('处理中表情暂不可用：请在飞书开通应用身份权限 im:message.reactions:write_only，并发布新版本。普通消息回复不受影响。'));
  else if (operations.some(op => op.reaction_error)) view.append(note('部分处理中表情添加或清理未成功，可在收件诊断中查看；普通消息回复继续处理。'));
  for (const d of deliveries.slice(0, 10)) view.append(note(`发送 ${d.id} · ${d.state} · 尝试 ${d.attempts}${d.parts?.length ? ' · 已送达 ' + d.parts.filter(p => p.state === 'sent').length + '/' + d.parts.length + ' 项' : ''}${d.last_error === 'channel_delivery_unknown' ? ' · 部分送达结果待核对，已停止自动重发' : d.last_error ? ' · ' + d.last_error : ''}`));
  panel.append(view);
}

function channelLink(url, caption, className) {
  if (!url.startsWith('#/')) return link(url, caption, className);
  const anchor = element('a', caption, className); anchor.href = url; return anchor;
}
