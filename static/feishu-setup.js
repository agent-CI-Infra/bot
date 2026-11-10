const feishuSteps = ['创建应用', '应用凭据', '事件与回调', '发布与检查', '绑定与试用'];
// Only non-secret selections survive a step change. Credentials stay in the form until saved, never browser storage.
let feishuChoice = null;
const feishuAddress = (id = 'new', step = 0) => `#/settings/feishu/${id}/${step}`;
function feishuError(err) {
  const reasons = { channel_auth_failed: 'App ID 或 App Secret 无法通过鉴权，请从飞书应用的“凭证与基础信息”重新复制。',
    channel_bot_unavailable: '暂时读不到机器人信息。请先发布包含机器人能力的初始版本，再返回检查；配置事件后还需发布新版本。',
    channel_delivery_rejected: '飞书拒绝了请求。请检查凭据、机器人能力和已发布版本。',
    channel_delivery_failed: '服务器无法连接飞书开放平台，请检查网络后重试。',
    channel_app_ticket_required: '尚未收到有效的商店应用票据。先完成 HTTP 事件配置、安装和发布，再重新检查。',
    channel_http_credentials_required: 'HTTP 回调需要 Verification Token 和 Encrypt Key，请从“事件与回调 → 加密策略”填写。',
    channel_revision_conflict: '连接已被其他操作更新。请刷新本页、核对当前配置后重新保存。',
    channel_installation_conflict: '这个应用在该安装租户下已登记，请返回连接列表继续配置。' };
  return Object.entries(reasons).find(([code]) => err.message.includes(code))?.[1] || err.message;
}
function feishuList(items) { const list = element('ol', '', 'feishu-instructions'); for (const text of items) list.append(element('li', text)); return list; }
async function renderFeishuSetup(panel, request) {
  const data = await api('/api/channels/setup');
  if (request !== renderVersion) return;
  const match = /^#\/settings\/feishu\/(new|[a-f0-9]{48})\/([0-4])$/.exec(location.hash);
  if (!match) {
    const overview = card('飞书应用连接');
    overview.append(note('由全局管理员连接飞书应用，全系统共用，无需选择 GitHub 组织。每位用户在「身份与权限」中绑定本人身份，之后仍按已有项目权限使用。'),
      channelLink(feishuAddress(), '新增飞书应用连接', 'button-link'));
    if (!data.connectors.length) overview.append(note('尚未连接飞书应用。按向导完成应用创建、凭据、事件订阅、发布和试用。'));
    for (const c of data.connectors) {
      const row = element('div', '', 'channel-binding');
      row.append(element('strong', c.app_id), note(`全局共用 · ${c.enabled ? '启用' : '停用'} · ${c.transport === 'http' ? 'HTTP 回调' : '企业自建长连接'}`),
        channelLink(feishuAddress(c.id, 1), '继续配置', 'button-link'), channelLink(feishuAddress(c.id, 4), '连接诊断与群范围', 'button-link'));
      overview.append(row);
    }
    panel.append(overview); return;
  }
  const id = match[1], step = Number(match[2]), c = data.connectors.find(row => row.id === id);
  if (id !== 'new' && !c) { panel.append(note('连接不存在。'), channelLink('#/settings/feishu', '返回飞书连接')); return; }
  if (!c && step > 1) { panel.append(note('请先保存应用连接，再配置事件、发布和试用。'), channelLink(feishuAddress(), '从创建应用开始')); return; }
  const title = card('飞书应用连接向导'), nav = element('nav', '', 'wizard-steps'); nav.setAttribute('aria-label', '飞书连接步骤');
  title.append(note(`第 ${step + 1} / ${feishuSteps.length} 步${c ? ' · ' + c.app_id : ''}。应用连接可随时返回继续；凭据保存后不回显。`));
  feishuSteps.forEach((caption, i) => {
    const item = button(`${i + 1}. ${caption}`, () => { location.hash = feishuAddress(id, i); }, 'quiet');
    item.disabled = !c && i > 1; if (i === step) item.setAttribute('aria-current', 'step'); nav.append(item);
  }); title.append(nav, channelLink('#/settings/feishu', '返回连接列表')); panel.append(title);
  const body = card(feishuSteps[step]); panel.append(body);
  const go = (next = step + 1) => { location.hash = feishuAddress(id, next); };
  const next = caption => body.append(button(caption, () => go(), ''));
  if (step === 0) {
    const choices = element('div', '', 'project-form');
    const initial = feishuChoice?.id === id ? feishuChoice : c || { application_type: 'enterprise', transport: 'websocket' };
    const application = channelSelect(choices, '应用类型', 'application_type', [['enterprise', '企业自建'], ['saas', 'SaaS / 商店应用']], initial.application_type);
    const transport = channelSelect(choices, '事件接收方式', 'transport', [['websocket', '企业自建 SDK 长连接（无需公网事件地址）'], ['http', 'HTTP 事件回调']], initial.transport);
    const sync = () => { transport.options[0].disabled = application.value === 'saas'; if (application.value === 'saas') transport.value = 'http'; };
    application.addEventListener('change', sync); sync();
    body.append(note('需要飞书应用开发权限；发布版本可能需要企业管理员审核。使用应用机器人接收私聊和群内 @ 消息。'), choices,
      channelLink('https://open.feishu.cn/app', '打开飞书开发者后台', 'button-link'), feishuList([
        '创建或打开飞书应用，在“添加应用能力”中开启机器人。已有应用可以直接继续。',
        '在“权限管理 → 批量导入/导出”导入下方默认权限，包含消息收发和卡片创建与更新。成员变更和应用生命周期事件按订阅界面的提示开通所需权限。',
        '记录“凭证与基础信息”里的 App ID、App Secret。HTTP 接收还需“事件与回调 → 加密策略”里的 Verification Token 和 Encrypt Key。']),
      channelCopy('基础权限 JSON', JSON.stringify({ scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot', 'cardkit:card:write'], user: [] } }, null, 2)),
      note('卡片是默认功能：cardkit:card:write 用于创建与更新卡片，im:message:send_as_bot 用于发送和更新机器人消息卡片；还必须在后续“回调配置”添加 card.action.trigger，权限导入不会自动订阅回调。已有应用也需补齐并发布新版本。不申请读取全部群消息或群历史的权限。'),
      note('长连接不需要公网事件地址；身份绑定仍需用户浏览器能够访问控制台及 GitHub 登录。HTTP 必须使用飞书可访问的公网 HTTPS 地址。'),
      channelLink('#/settings/access', '配置公网 HTTPS 地址'), button('应用已准备，填写凭据', () => { feishuChoice = { id, application_type: application.value, transport: transport.value }; go(); }, ''));
  } else if (step === 1) {
    const choice = feishuChoice?.id === id ? feishuChoice : c || { application_type: 'enterprise', transport: 'websocket' };
    const form = element('form', '', 'project-form'), message = element('p', '', 'view-error'); message.setAttribute('role', 'alert');
    form.append(note('此应用连接全局共用，不绑定 GitHub 组织，也不授予用户项目权限。下方 tenant_key 表示飞书企业，用于校验消息来源。'));
    const app = channelField(form, 'App ID', 'app_id', c?.app_id || ''); app.required = true; app.readOnly = !!c;
    const secret = channelField(form, c ? 'App Secret（留空保留）' : 'App Secret', 'app_secret', '', 'password'); secret.required = !c;
    const bot = channelField(form, '机器人 open_id', 'bot_open_id', c?.bot_open_id || ''); bot.required = true;
    if (choice.application_type === 'enterprise') {
      const probe = button('检查凭据并读取机器人', async () => {
        message.textContent = ''; probe.disabled = true;
        try {
          const input = secret.value.trim() ? { app_id: app.value.trim(), app_secret: secret.value.trim() } : c ? { connector_id: c.id, expected_revision: c.revision } : { app_id: app.value.trim(), app_secret: '' };
          const result = await api('/api/channels/feishu/probe', 'POST', input); bot.value = result.bot_open_id;
          message.textContent = `凭据已验证${result.name ? ' · ' + result.name : ''}。事件投递仍需订阅并发布后验证。`; message.className = 'view-success';
        } catch (err) { message.className = 'view-error'; message.textContent = feishuError(err); } finally { probe.disabled = false; }
      }, 'quiet'); probe.type = 'button'; form.append(probe);
    }
    form.append(note('读取不到机器人时，先发布包含机器人能力的初始版本再重试；完成事件订阅后还需发布新版本。机器人 open_id 也可从飞书“获取机器人信息”接口取得。安装租户是应用实际安装的企业 tenant_key；允许的操作者租户是获准使用该连接的人所在企业，两者分别校验。'),
      channelLink('https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info', '飞书：获取机器人信息'));
    const installation = channelField(form, '应用安装租户 tenant_key', 'installation_tenant', c?.installation_tenant || ''); installation.required = true;
    const actors = channelField(form, '允许的操作者 tenant_key（逗号分隔）', 'actor_tenants', c?.actor_tenants.join(',') || ''); actors.required = true;
    let verification, encryption;
    if (choice.transport === 'http') {
      verification = channelField(form, c ? 'Verification Token（留空保留）' : 'Verification Token', 'verification_token', '', 'password'); verification.required = !c || c.transport !== 'http';
      encryption = channelField(form, c ? 'Encrypt Key（留空保留）' : 'Encrypt Key', 'encrypt_key', '', 'password'); encryption.required = !c || c.transport !== 'http';
      form.append(note('本系统校验 HTTP 原始请求签名并支持加密事件，Verification Token 和 Encrypt Key 都需填写。请使用本系统的加密策略要求。'));
    }
    const enabled = channelField(form, '启用连接', 'enabled', '', 'checkbox'); enabled.checked = c ? !!c.enabled : true;
    form.append(note(`当前接入：${choice.application_type === 'enterprise' ? '企业自建' : 'SaaS / 商店应用'} · ${choice.transport === 'http' ? 'HTTP 回调' : 'SDK 长连接'}。保存后按“启用连接”状态接收事件，管理操作仍检查用户绑定和项目权限。`));
    const save = element('button', '保存连接并继续'); save.type = 'submit'; form.append(message, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; message.textContent = ''; message.className = 'view-error';
      const credentials = Object.fromEntries([['app_secret', secret.value.trim()], ['verification_token', verification?.value.trim()], ['encrypt_key', encryption?.value.trim()]].filter(([, value]) => value));
      try {
        const result = await api('/api/channels/connectors' + (c ? '/' + c.id : ''), c ? 'PATCH' : 'POST', { app_id: app.value.trim(), installation_tenant: installation.value.trim(), actor_tenants: actors.value.split(',').map(s => s.trim()).filter(Boolean),
          bot_open_id: bot.value.trim(), application_type: choice.application_type, transport: choice.transport, enabled: enabled.checked, expected_revision: c?.revision ?? 0,
          ...(Object.keys(credentials).length ? { credentials } : {}) });
        secret.value = ''; if (verification) verification.value = ''; if (encryption) encryption.value = '';
        feishuChoice = null; location.hash = feishuAddress(result.connector_id, 2);
      } catch (err) { message.textContent = feishuError(err); } finally { save.disabled = false; }
    }); body.append(form);
  } else if (step === 2) {
    body.append(note(c.enabled ? '连接已启用，可以配置飞书事件订阅。' : '连接当前停用。请返回“应用凭据”启用，再完成事件验证。'));
    if (c.transport === 'http') {
      let callback = null;
      try { const origin = new URL(data.origin); if (origin.protocol === 'https:') callback = origin.origin + c.callback_path; } catch {}
      body.append(note('在“事件与回调 → 事件配置”选择“将事件发送至开发者服务器”。下面的地址来自本部署的控制台公网入口。'));
      if (callback) body.append(channelCopy('HTTP 回调地址', callback));
      else body.append(note('尚无可用的公网 HTTPS 地址。先在“公网接入”完成配置，再返回继续。'), channelLink('#/settings/access', '配置公网 HTTPS 地址'));
      body.append(note('还必须在“事件与回调 → 回调配置”选择“将回调发送至开发者服务器”，填写上面同一个 HTTP 回调地址。事件配置和回调配置需分别保存，确保两处地址验证均通过。'));
    } else body.append(note('等待下方传输状态显示已连接，再在飞书“事件与回调 → 事件配置”选择“使用长连接接收事件”并保存；随后在“回调配置”选择“使用长连接接收回调”并保存。两处必须分别配置，无需填写公网地址。'));
    body.append(facts([['传输状态', c.transport === 'http' ? 'HTTP 回调' : c.health.connection_state]]), feishuList([
      '在“事件配置”添加 im.message.receive_v1（接收消息）。只接收私聊及群内 @，不订阅全部群消息。',
      '必须在“回调配置 → 添加回调”单独添加 card.action.trigger（卡片回传交互），不要添加到“事件配置”，也不要选旧版 card.action.trigger_v1。卡片按钮默认依赖此回调。',
      '订阅 im.chat.member.user.added_v1、im.chat.member.user.deleted_v1，用于成员变化后使群接收范围失效；再添加应用卸载和状态变更事件。',
      c.application_type === 'saas' ? '商店应用还需配置 app_ticket 推送、安装租户和应用生命周期事件。尚未收到票据时无法检测发送凭据。' : '保存事件与回调配置，下一步发布应用版本。']),
      button('刷新连接状态', () => render().catch(error), 'quiet'));
    next('事件与卡片回调已保存，前往发布');
  } else if (step === 3) {
    body.append(feishuList(['在飞书“版本管理与发布”创建新版本，核对机器人能力、默认消息与卡片权限，以及事件订阅和 card.action.trigger 卡片回调。已有应用新增权限或回调后也必须重新发布。',
      '设置应用可用范围，让需要使用机器人的成员能搜索和私聊它。发布版本，需要审核时等待企业管理员通过。',
      '返回这里检查机器人信息。凭据可用不等于消息已经送达，下一步仍需实际绑定、查询并点击状态卡片。']),
      channelLink('https://open.feishu.cn/app', '打开飞书发布应用', 'button-link'));
    const status = element('p', '', 'view-error'); status.setAttribute('role', 'status');
    const probe = button('检查已发布的机器人', async () => {
      probe.disabled = true; status.textContent = '正在检查…';
      try {
        const result = await api('/api/channels/feishu/probe', 'POST', { connector_id: c.id, expected_revision: c.revision });
        status.className = 'view-success'; status.textContent = `凭据已验证 · ${result.name || result.bot_open_id}。尚未验证事件投递。`;
        if (result.bot_open_id !== c.bot_open_id) { status.className = 'view-error'; status.textContent = '机器人 open_id 与保存值不同。请返回“应用凭据”更新并保存，之后重新检查。'; }
      } catch (err) { status.className = 'view-error'; status.textContent = feishuError(err); } finally { probe.disabled = false; }
    }, ''); body.append(probe, status); next('进入绑定与试用');
  } else {
    body.append(feishuList(['让每位使用者进入“身份与权限”，按“飞书身份绑定”引导在机器人私聊发起 /bind，完成 GitHub 登录并回原私聊确认。',
      '绑定后私聊发送 /project <项目ID> 查询任务状态，确认收到业务结果。绑定不增加权限，项目管理员仍需授权。',
      '必须点击返回卡片上的“刷新执行状态”，确认收到更新结果后才完成接入。能聊天或读到机器人信息不代表卡片回调已配置；点击无响应时，检查“回调配置”的接收方式、card.action.trigger 订阅和已发布版本。',
      '需要群内使用时，先在下方批准项目和群的接收范围，再在该群 @ 机器人发起请求。']),
      channelLink('#/identity/feishu', '前往个人飞书身份绑定', 'button-link'), button('刷新收件与发送状态', () => render().catch(error), 'quiet'));
    await channelDiagnostics(c, panel);
  }
}
