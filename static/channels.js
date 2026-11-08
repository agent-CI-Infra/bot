titles.channels = '消息渠道';
async function renderChannels() {
  const panel = $('channels-panel'); panel.replaceChildren(); $('count').textContent = '';
  const data = await api('/api/channels/bindings'), binding = card('飞书双端身份绑定');
  binding.append(note('先在飞书私聊发送“绑定”，通过链接完成 GitHub 登录，再核对两端身份并回到原私聊确认。绑定不增加项目权限。转发链接或只验证一端不能完成绑定。'));
  for (const p of data.pending) binding.append(facts([['GitHub', `${p.github?.display_name} · ${p.github?.external_actor}`], ['飞书应用', p.app_id], ['安装租户', p.installation_tenant],
    ['操作者租户', p.actor_tenant], ['飞书 open_id', p.open_id], ['在原私聊发送', '确认绑定 ' + p.confirmation], ['有效期', new Date(p.expires_at).toLocaleString()]]));
  for (const b of data.bindings) {
    const row = element('div', '', 'channel-binding'); row.append(element('strong', `${b.external_actor} · ${b.status}`), note(`应用连接 ${b.connector}；操作者租户 ${b.external_tenant}`));
    if (b.status !== 'revoked') {
      const remove = element('button', '解除绑定', 'quiet'); remove.addEventListener('click', async () => {
        try { await api('/api/identity/bindings/' + b.id, 'DELETE', {}); await start(); } catch (err) { error(err); }
      }); row.append(remove);
    } binding.append(row);
  }
  panel.append(binding);
  const identity = await api('/api/identity'), { connectors } = await api('/api/channels/connectors');
  const field = (form, label, name, value = '', type = 'text') => {
    const wrap = element('label', label), input = document.createElement('input'); input.name = name; input.type = type; input.value = value; input.autocomplete = 'off'; wrap.append(input); form.append(wrap); return input;
  };
  const choose = (form, label, name, values) => {
    const wrap = element('label', label), select = document.createElement('select'); select.name = name;
    for (const [value, caption] of values) select.add(new Option(caption, value)); wrap.append(select); form.append(wrap); return select;
  };
  const configuration = card('飞书应用连接'), form = document.createElement('form');
  const selected = choose(form, '连接', 'connector', [['', '新增连接'], ...connectors.map(c => [c.id, c.app_id + ' · revision ' + c.revision])]);
  const tenant = choose(form, '项目所属组织', 'tenant_id', identity.tenants.map(t => [t.id, t.display_name]));
  const app = field(form, 'App ID', 'app_id'), installation = field(form, '应用安装租户 tenant_key', 'installation_tenant'), actors = field(form, '允许的操作者 tenant_key（逗号分隔）', 'actor_tenants'), bot = field(form, '机器人 open_id', 'bot_open_id');
  const application = choose(form, '应用类型', 'application_type', [['saas', 'SaaS / 商店应用'], ['enterprise', '企业自建']]);
  const transport = choose(form, '事件接收方式', 'transport', [['http', 'HTTP 事件回调'], ['websocket', '企业自建 SDK 长连接']]);
  const enabled = field(form, '启用连接', 'enabled', '', 'checkbox');
  const secret = field(form, 'App Secret（编辑时留空保留）', 'app_secret', '', 'password'), verification = field(form, 'Verification Token', 'verification_token', '', 'password'), encryption = field(form, 'Encrypt Key', 'encrypt_key', '', 'password');
  selected.addEventListener('change', () => {
    const c = connectors.find(c => c.id === selected.value); if (!c) return;
    tenant.value = c.tenant_id; app.value = c.app_id; installation.value = c.installation_tenant; actors.value = c.actor_tenants.join(','); bot.value = c.bot_open_id;
    application.value = c.application_type; transport.value = c.transport; enabled.checked = !!c.enabled;
    secret.value = verification.value = encryption.value = '';
  });
  const save = element('button', '保存连接'); save.type = 'submit'; form.append(save);
  form.addEventListener('submit', async e => {
    e.preventDefault(); const c = connectors.find(c => c.id === selected.value);
    const input = { tenant_id: tenant.value, app_id: app.value, installation_tenant: installation.value, actor_tenants: actors.value.split(',').map(s => s.trim()).filter(Boolean), bot_open_id: bot.value,
      application_type: application.value, transport: transport.value, enabled: enabled.checked, expected_revision: c?.revision ?? 0,
      ...(!c || secret.value || verification.value || encryption.value ? { credentials: { app_secret: secret.value, verification_token: verification.value, encrypt_key: encryption.value } } : {}) };
    try { const result = await api('/api/channels/connectors' + (c ? '/' + c.id : ''), c ? 'PATCH' : 'POST', input); notice('message', `连接已保存 · ${result.operation_id}`); await renderChannels(); } catch (err) { error(err); }
  });
  configuration.append(note('只订阅私聊和群内 @ 消息、卡片操作及成员变更。不申请全部群消息权限。自定义群 webhook 不能用作管理入口。凭据仅加密保存，之后不回显。'), form); panel.append(configuration);
  const projects = (await api('/api/management/query', 'POST', { operation: 'list_projects', target: {}, arguments: { limit: 100 } })).projects;
  for (const c of connectors) {
    const view = card(`${c.app_id} · 连接健康`), { groups } = await api('/api/channels/connectors/' + c.id + '/groups');
    view.append(facts([['HTTP 回调路径', c.callback_path], ['配置版本', c.revision], ['状态', c.enabled ? '启用' : '停用'], ['传输状态', c.transport === 'http' ? '等待 HTTP 回调' : c.health.connection_state], ['最后收到事件', c.health.last_received_at ? new Date(c.health.last_received_at).toLocaleString() : '尚未收到'], ['诊断', c.health.last_error || '无'], ['待处理', c.health.queued], ['发送失败', c.health.failed]]));
    const mapping = document.createElement('form'), project = choose(mapping, '项目', 'project', projects.filter(p => p.tenant_id === c.tenant_id).map(p => [p.id, p.full_name]));
    const chat = field(mapping, '群 chat_id', 'chat_id');
    const sensitivity = choose(mapping, '允许的敏感级别', 'sensitivity', [['public', '公开'], ['private', '私有']]);
    const details = field(mapping, '允许群接收详细结果', 'details', '', 'checkbox'), attest = field(mapping, '我已核实群受众（授权一小时；成员变更即失效）', 'attest', '', 'checkbox');
    const approve = element('button', '批准或更新群范围'); approve.type = 'submit'; mapping.append(approve);
    mapping.addEventListener('submit', async e => {
      e.preventDefault(); const current = groups.find(s => s.chat_id === chat.value && s.project_id === project.value);
      try { await api('/api/channels/connectors/' + c.id + '/groups', 'PUT', { chat_id: chat.value, project_id: project.value, fields: ['summary', 'status', 'operation', ...(details.checked ? ['result'] : [])], sensitivity: sensitivity.value,
        audience_verified_until: attest.checked ? Date.now() + 3590000 : 0, enabled: true, expected_revision: current?.revision ?? 0 }); await renderChannels(); } catch (err) { error(err); }
    }); view.append(mapping);
    for (const g of groups) {
      const row = element('div', '', 'channel-binding'); row.append(note(`${g.chat_id} → 项目 ${g.project_id} · ${g.fields.join(', ')} · revision ${g.revision} · ${g.enabled && g.audience_verified_until > Date.now() ? '已核实受众' : '未授权或需重新核实'}`));
      const revoke = element('button', '撤销群范围', 'quiet'); revoke.addEventListener('click', async () => {
        try { await api('/api/channels/connectors/' + c.id + '/groups', 'PUT', { chat_id: g.chat_id, project_id: g.project_id, fields: g.fields, sensitivity: g.sensitivity, audience_verified_until: 0, enabled: false, expected_revision: g.revision }); await renderChannels(); } catch (err) { error(err); }
      }); row.append(revoke); view.append(row);
    }
    const { operations } = await api('/api/channels/connectors/' + c.id + '/events'), { deliveries } = await api('/api/channels/connectors/' + c.id + '/outbox');
    for (const op of operations.slice(0, 10)) view.append(note(`渠道操作 ${op.operation_id} · ${op.state}${op.error ? ' · ' + op.error : ''}${op.conversation_id ? ' · 会话 ' + op.conversation_id : ''}`));
    for (const d of deliveries.slice(0, 10)) view.append(note(`发送 ${d.id} · ${d.state} · 尝试 ${d.attempts}${d.last_error ? ' · ' + d.last_error : ''}`));
    panel.append(view);
  }
}
