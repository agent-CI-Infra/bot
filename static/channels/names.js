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

