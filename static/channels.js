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
  return section;
}
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
  const control = document.createElement('select'); control.name = name;
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
}

function channelLink(url, caption, className) {
  if (!url.startsWith('#/')) return link(url, caption, className);
  const anchor = element('a', caption, className); anchor.href = url; return anchor;
}
