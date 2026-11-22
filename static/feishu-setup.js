const feishuWizardSteps = ['应用与凭据', '订阅事件与发布', '完成与绑定'];
// Super administrators manage apps in global settings; organization and repository admins reach the same console from
// personal settings (#424). The server decides which apps each person sees and may change.
const feishuBase = () => location.hash.startsWith('#/identity/') ? '#/identity/feishu-apps' : '#/settings/feishu';
const feishuWizardAddress = (id = 'new', step = 0) => id === 'new' ? `${feishuBase()}/new/${step}` : `${feishuBase()}/${id}/setup/${step}`;
const feishuDetailAddress = id => `${feishuBase()}/${id}`;
const feishuOwner = c => c.owner ? `组织 ${c.owner.name} 的应用${c.creator ? ' · 创建人 ' + c.creator : ''}` : '全平台共用';
const feishuTransportText = c => c.application_type === 'saas' ? 'SaaS / 商店应用 · HTTP 回调' : c.transport === 'http' ? '企业自建 · HTTP 回调' : '企业自建 · SDK 长连接';

function feishuBadge(text, variant = '') {
  return element('span', text, 'feishu-binding-badge' + (variant ? ' feishu-binding-badge-' + variant : ''));
}
function feishuEnabledInfo(c) {
  return c.enabled ? { text: '已启用', variant: 'success' } : { text: '已停用', variant: 'muted' };
}
function feishuActivityInfo(c) {
  if (!c.enabled) return { text: '未运行', variant: 'muted' };
  if (c.transport === 'http') {
    if (c.health.last_error) return { text: '最近有错误', variant: 'danger' };
    if (c.health.last_received_at) return { text: 'HTTP 回调活跃', variant: 'success' };
    return { text: 'HTTP 回调待收事件', variant: 'info' };
  }
  const state = c.health.connection_state;
  if (state === 'connected') return { text: '已连接', variant: 'success' };
  if (state === 'connecting') return { text: '连接中', variant: 'warning' };
  if (state === 'failed') return { text: '连接失败', variant: 'danger' };
  return { text: '待连接', variant: 'muted' };
}
function feishuDraftKey() { return 'feishu_setup_draft:' + feishuBase(); }
function readFeishuDraft() {
  try {
    const raw = sessionStorage.getItem(feishuDraftKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}
function writeFeishuDraft(draft) {
  try {
    if (!draft) sessionStorage.removeItem(feishuDraftKey());
    else sessionStorage.setItem(feishuDraftKey(), JSON.stringify({ owner: draft.owner, application_type: draft.application_type, transport: draft.transport }));
  } catch {}
}

function feishuError(err) {
  const reasons = { channel_auth_failed: 'App ID 或 App Secret 无法通过鉴权，请从飞书应用的“凭证与基础信息”重新复制。',
    channel_bot_unavailable: '暂时读不到机器人信息。请先发布包含机器人能力的初始版本，再返回检查；配置事件后还需发布新版本。',
    channel_tenant_unavailable: '暂时读不到应用安装的企业信息。请在飞书“权限管理”开通应用身份权限“获取企业信息”（tenant:tenant:readonly），发布并通过必要审核后重新保存；已有该权限时请检查应用是否已启用。',
    channel_delivery_rejected: '飞书拒绝了请求。请检查凭据、机器人能力和已发布版本。',
    channel_delivery_failed: '服务器无法连接飞书开放平台，请检查网络后重试。',
    channel_rate_limited: '飞书暂时限制了请求频率，请稍后重试。',
    channel_application_permission_required: '飞书机器人接口可能仍返回旧名称。请在飞书开通应用身份权限“获取应用信息”（admin:app.info:readonly），发布并通过必要审核后刷新；系统只查询本应用信息。也可使用已有的 application:application:self_manage 权限。',
    channel_application_unavailable: '暂时无法读取最新应用名称，当前保留已保存名称或机器人接口返回的名称。请检查改名是否已发布及对应语言名称，稍后刷新。',
    channel_source_mismatch: '飞书返回的安装企业与此连接不一致，请核对应用凭据和安装企业后重新配置。',
    channel_app_ticket_required: '尚未收到有效的商店应用票据。先完成 HTTP 事件配置、安装和发布，再重新检查。',
    channel_http_credentials_required: 'HTTP 回调需要 Verification Token 和 Encrypt Key，请从“事件与回调 → 加密策略”填写。',
    channel_revision_conflict: '连接已被其他操作更新。请刷新本页、核对当前配置后重新保存。',
    channel_installation_conflict: '这个应用在该安装租户下已登记，请返回连接列表继续配置。',
    channel_connector_not_found: '该飞书应用连接不存在，或已被删除。',
    channel_application_forbidden: '你没有权限管理这个飞书应用，或不能为所选组织新增应用。组织的应用由创建人、组织管理员和超级管理员管理。',
    channel_transport_forbidden: '组织的应用只能使用企业自建应用和 SDK 长连接；HTTP 回调和商店应用只能由超级管理员配置。',
    channel_application_immutable: '应用创建后，App ID、安装企业和所属组织都不能修改。需要换用其他应用时，请新增一个连接。',
    organization_not_found: '所选组织不存在，请刷新本页后重新选择。' };
  return Object.entries(reasons).find(([code]) => err.message.includes(code))?.[1] || readErrorText(err);
}
// The required scopes come from the server list, so the wizard and every connection import and check the same set.
const feishuScopeJSON = (scopes, type) => JSON.stringify({ scopes: { tenant: scopes.filter(s => !s.enterprise_only || type === 'enterprise').map(s => s.scope), user: [] } }, null, 2);
function feishuScopeReport(result, scopes, connector) {
  const box = element('div', '', 'feishu-scope-check'), check = result.scopes, purposes = new Map(scopes.map(s => [s.scope, s.purpose]));
  box.setAttribute('aria-label', '飞书权限检查'); box.setAttribute('aria-live', 'polite');
  const json = element('details'); json.append(element('summary', '完整权限 JSON（一次导入全部所需权限）'), channelCopy('完整权限 JSON', feishuScopeJSON(scopes, connector?.application_type || 'enterprise')));
  if (check && !check.missing.length) { box.append(element('p', `飞书权限：所需的 ${check.required.length} 项均已开通。`, 'view-success'), json); return box; }
  if (check) {
    const list = element('ul', '', 'feishu-scope-missing');
    for (const scope of check.missing) list.append(element('li', `${scope} · ${purposes.get(scope) || ''}${check.pending.includes(scope) ? ' · 已申请，待审核或发布' : ''}`));
    box.append(element('p', `飞书权限：缺少 ${check.missing.length} 项，相关功能不可用。`, 'view-error'), list);
  } else box.append(element('p', result.scope_error ? '暂时无法自动检查飞书权限，请对照下方完整权限 JSON 在飞书「权限管理」核对。' : '尚未检查飞书权限，解决上方问题后重新检查。', 'view-error'));
  // Feishu's own permission errors link to this page; q pre-selects the missing scopes so they can be requested together.
  const page = connector?.app_id ? `https://open.feishu.cn/app/${encodeURIComponent(connector.app_id)}/auth` + (check ? '?' + new URLSearchParams({ q: check.missing.join(','), op_from: 'openapi', token_type: 'tenant' }) : '') : 'https://open.feishu.cn/app';
  box.append(note('在飞书「权限管理 → 批量导入/导出」导入下方完整权限 JSON，已开通的权限不受影响；再创建并发布新版本、通过必要审核，回到这里重新检查。'),
    channelLink(page, check ? '在飞书开通缺少的权限' : '打开飞书权限管理', 'button-link'), json);
  json.open = true; return box;
}
function feishuList(items) { const list = element('ol', '', 'feishu-instructions'); for (const text of items) list.append(element('li', text)); return list; }

function feishuCallbackUrl(originValue, callbackPath) {
  try {
    const origin = new URL(originValue);
    if (origin.protocol === 'https:') return origin.origin + callbackPath;
  } catch {}
  return null;
}
function buildFeishuEventsInstructions(c, data, { onRefresh = null, enableAction = null, nextAction = null } = {}) {
  const instructions = element('ol', '', 'feishu-instructions'); instructions.setAttribute('aria-label', '事件与回调配置步骤');
  const events = element('li'), callbacks = element('li'), publish = element('li');
  events.append(element('strong', '配置事件'));
  callbacks.append(element('strong', '配置新版卡片回调'));
  publish.append(element('strong', '创建并发布应用版本'));
  if (!c.enabled) {
    events.append(note('当前连接已停用。请先启用连接，再在飞书后台保存事件配置。'));
    if (enableAction) events.append(enableAction);
  }
  if (c.transport === 'http') {
    const callback = feishuCallbackUrl(data.origin, c.callback_path);
    events.append(note('在飞书“事件与回调 → 事件配置”选择“将事件发送至开发者服务器”，填写下方 HTTP 回调地址，保存并通过地址验证。'));
    if (callback) events.append(channelCopy('HTTP 回调地址', callback));
    else events.append(note('尚无可用的公网 HTTPS 地址。先在“公网接入”完成配置，再返回继续。'), channelLink('#/settings/access', '配置公网 HTTPS 地址'));
    callbacks.append(note('切换到“事件与回调 → 回调配置”，选择“将回调发送至开发者服务器”，填写第 1 步的同一个 HTTP 回调地址，单独保存并通过地址验证。'));
  } else {
    events.append(note('等待上方活跃状态显示「已连接」，再在飞书“事件与回调 → 事件配置”选择“使用长连接接收事件”并保存，无需填写公网地址。'));
    callbacks.append(note('切换到“事件与回调 → 回调配置”，选择“使用长连接接收回调”并单独保存，无需填写公网地址。'));
  }
  if (onRefresh) events.append(button('刷新连接状态', onRefresh, 'quiet'));
  events.append(
    note('在“事件配置 → 添加事件”添加 im.message.receive_v1（接收消息）和 im.message.recalled_v1（撤回消息）。获准投递的未 @ 群消息也会记录，记录不等于执行或回复。'),
    note('同时添加 im.chat.member.bot.added_v1、im.chat.member.bot.deleted_v1、im.chat.disbanded_v1，以及 im.chat.member.user.added_v1、im.chat.member.user.deleted_v1。机器人进群启动可见历史同步；被移出、群解散或应用卸载会停止同步。成员变化使项目群接收范围失效。'));
  if (c.application_type === 'saas') events.append(note('商店应用还需配置 app_ticket 推送、安装租户和应用生命周期事件。尚未收到票据时无法检测发送凭据。'));
  callbacks.append(
    note('在“回调配置 → 添加回调”的“卡片”分类中，选择新版“卡片回传交互”（card.action.trigger，推荐）并添加。权限导入不会自动订阅回调。'),
    note('不要选“消息卡片回传交互（旧）”（card.action.trigger_v1），旧版不支持长连接；新版回调应添加到“回调配置”。'));
  publish.append(
    note('在飞书“版本管理与发布”创建新版本，核对机器人能力、完整权限 JSON、事件订阅与 card.action.trigger 回调，设置可用范围并发布（需审核时等待企业管理员通过）。已有应用新增权限或回调后也必须重新发布。'),
    channelLink('https://open.feishu.cn/app', '打开飞书开发者后台', 'button-link'));
  if (nextAction) publish.append(nextAction);
  instructions.append(events, callbacks, publish);
  return instructions;
}

function pollFeishuConnectionState(c, request, targetNode, updateView) {
  if (!c.enabled || c.transport !== 'websocket' || c.health.connection_state === 'connected') return;
  let timer = null;
  const poll = async () => {
    if (request !== renderVersion || !targetNode.isConnected) return;
    try {
      const fresh = await api('/api/channels/setup');
      if (request !== renderVersion || !targetNode.isConnected) return;
      const latest = fresh.connectors.find(row => row.id === c.id);
      if (!latest) return;
      c.enabled = latest.enabled; c.revision = latest.revision; c.health = latest.health;
      updateView(latest);
      if (latest.enabled && latest.transport === 'websocket' && latest.health.connection_state !== 'connected')
        timer = setTimeout(poll, 3000);
    } catch {
      if (request === renderVersion && targetNode.isConnected) timer = setTimeout(poll, 5000);
    }
  };
  timer = setTimeout(poll, 3000);
  void timer;
}

async function confirmDeleteFeishuConnector(c, onDeleted) {
  const title = c.app_name ? `${c.app_name}（${c.app_id}）` : c.app_id;
  const confirmed = await askConfirm({
    title: '删除飞书应用连接',
    danger: true,
    action: '确认删除',
    progress: '正在删除飞书应用连接…',
    body: [
      `即将删除飞书应用连接「${title}」（${feishuOwner(c)}）。此操作不可撤销：`,
      [
        '立即断开该应用的长连接并永久删除已保存的密封凭据（App Secret / HTTP 密钥）',
        '停用该应用下的所有飞书群聊助手绑定并暂停相关会话定时任务',
        '撤销通过该应用绑定的个人飞书身份（本地历史聊天记录仍保留只读）',
        '删除后可用相同的 App ID 重新创建连接',
      ],
    ],
    run: async () => {
      await api('/api/channels/connectors/' + c.id, 'DELETE', { expected_revision: c.revision });
    },
  });
  if (confirmed) await onDeleted();
}

function renderFeishuList(panel, data, request) {
  const overview = settingsCard('飞书应用连接'), setupLinks = element('div', '', 'actions');
  if (data.platform || data.organizations.length) setupLinks.append(channelLink(feishuWizardAddress('new', 0), '新增飞书应用连接', 'button-link'));
  setupLinks.append(channelLink('#/identity/feishu', '管理个人与群绑定', 'button-link quiet'));
  if (data.platform) setupLinks.append(channelLink('#/settings/service-roles', '管理服务角色', 'button-link quiet'));
  overview.append(note(data.platform
    ? '超级管理员可以连接全平台共用的应用，也可以为某个组织连接应用。组织管理员和组织内仓库的管理员可以在「个人设置 → 组织飞书应用」为本组织连接企业自建应用。每位用户在「个人设置 → 飞书绑定」中绑定本人身份或配置飞书群的仓库与权限。'
    : '你可以为下列组织连接企业自建的飞书应用（SDK 长连接）。组织的应用只有该组织内有授权的人能看到和绑定；它所在的群只能选择本组织的仓库，经它绑定的飞书身份也只能使用本组织内的权限。应用由创建人、组织管理员和超级管理员管理。'),
  ...(data.platform || data.organizations.length ? [] : [note('你当前不能为任何组织新增应用，只能管理下方已有的应用。')]),
  setupLinks);

  if (!data.connectors.length) {
    overview.append(note(data.platform ? '尚未连接飞书应用。点击「新增飞书应用连接」按 3 步向导完成接入。' : '你还没有可管理的飞书应用。点击「新增飞书应用连接」按 3 步向导完成接入。'));
    panel.append(overview);
    return;
  }

  const list = element('div', '', 'feishu-binding-list');
  const feedback = element('p', '', 'view-error'); feedback.setAttribute('role', 'alert');
  overview.append(feedback, list);
  for (const c of data.connectors) {
    const row = element('article', '', 'feishu-binding-row');
    row.setAttribute('role', 'group'); row.setAttribute('aria-label', c.app_id);
    const main = element('div', '', 'feishu-row-main'), info = element('div', '', 'feishu-row-info');
    const titleLine = element('div', '', 'feishu-row-title');
    const enabledInfo = feishuEnabledInfo(c), activityInfo = feishuActivityInfo(c);
    titleLine.append(
      element('strong', c.app_name || '应用名称待获取'),
      feishuBadge(enabledInfo.text, enabledInfo.variant),
      feishuBadge(activityInfo.text, activityInfo.variant),
    );
    const lastSeen = c.health.last_received_at ? `最近收到事件：${timestamp(c.health.last_received_at)}` : '尚未收到事件';
    const healthParts = [lastSeen];
    if (c.health.queued) healthParts.push(`待处理 ${c.health.queued}`);
    if (c.health.failed) healthParts.push(`发送失败 ${c.health.failed}`);
    if (c.health.last_error) healthParts.push(`诊断：${c.health.last_error}`);
    info.append(
      titleLine,
      note(`企业：${c.tenant_name || '名称待获取'} · App ID：${c.app_id}`),
      note(`${feishuOwner(c)} · ${feishuTransportText(c)}`),
      note(healthParts.join(' · ')),
    );
    const actions = element('div', '', 'feishu-row-actions');
    const toggle = button(c.enabled ? '停用' : '启用', async () => {
      toggle.disabled = true; feedback.textContent = '';
      try {
        await api('/api/channels/connectors/' + c.id, 'PATCH', { enabled: !c.enabled, expected_revision: c.revision });
        if (request === renderVersion) await render().catch(error);
      } catch (err) {
        feedback.textContent = feishuError(err);
        toggle.disabled = false;
      }
    }, 'quiet');
    const remove = button('删除', () => {
      feedback.textContent = '';
      void confirmDeleteFeishuConnector(c, async () => {
        if (request === renderVersion) await render().catch(error);
      });
    }, 'quiet destructive');
    actions.append(channelLink(feishuDetailAddress(c.id), '管理', 'button-link'), toggle, remove);
    main.append(info, actions);
    row.append(main);
    list.append(row);
  }
  panel.append(overview);
}

async function renderFeishuDetail(panel, data, c, request, { openGuide = false, focusCredentials = false } = {}) {
  const base = feishuBase();
  const header = settingsCard(c.app_name || '应用名称待获取');
  const titleBar = element('div', '', 'feishu-detail-head'), titleBadges = element('div', '', 'feishu-detail-title'), headActions = element('div', '', 'actions');
  const enabledBadge = feishuBadge(feishuEnabledInfo(c).text, feishuEnabledInfo(c).variant);
  const activityBadge = feishuBadge(feishuActivityInfo(c).text, feishuActivityInfo(c).variant);
  titleBadges.append(enabledBadge, activityBadge, note(`App ID：${c.app_id}`));
  const headError = element('p', '', 'view-error'); headError.setAttribute('role', 'alert');
  const toggleBtn = button(c.enabled ? '停用连接' : '启用连接', async () => {
    toggleBtn.disabled = true; headError.textContent = '';
    try {
      await api('/api/channels/connectors/' + c.id, 'PATCH', { enabled: !c.enabled, expected_revision: c.revision });
      if (request === renderVersion) await render().catch(error);
    } catch (err) {
      headError.textContent = feishuError(err);
      toggleBtn.disabled = false;
    }
  }, 'quiet');
  headActions.append(channelLink(base, '返回连接列表', 'button-link quiet'), toggleBtn);
  titleBar.append(titleBadges, headActions);

  const summaryFacts = element('div');
  const renderSummaryFacts = current => {
    const activity = feishuActivityInfo(current);
    const enabled = feishuEnabledInfo(current);
    if (enabledBadge.textContent !== enabled.text) {
      enabledBadge.textContent = enabled.text;
      enabledBadge.className = 'feishu-binding-badge feishu-binding-badge-' + enabled.variant;
    }
    if (activityBadge.textContent !== activity.text) {
      activityBadge.textContent = activity.text;
      activityBadge.className = 'feishu-binding-badge feishu-binding-badge-' + activity.variant;
    }
    summaryFacts.replaceChildren(facts([
      ['应用名称', current.app_name || '应用名称待获取'],
      ['安装企业', current.tenant_name || '名称待获取'],
      ['应用所属', feishuOwner(current)],
      ['接入方式', feishuTransportText(current)],
      ['启用状态', enabled.text],
      ['活跃状态', activity.text],
      ['最后收到事件', current.health.last_received_at ? timestamp(current.health.last_received_at) : '尚未收到'],
      ['诊断', current.health.last_error || '无'],
    ]));
  };
  renderSummaryFacts(c);

  const probeStatus = element('p', '', 'view-success'), grants = element('div');
  probeStatus.setAttribute('role', 'status');
  const runProbe = async () => {
    refreshBtn.disabled = true; probeStatus.className = 'view-success'; probeStatus.textContent = '正在读取应用、企业信息与权限…';
    try {
      const result = await api('/api/channels/feishu/probe', 'POST', { connector_id: c.id, expected_revision: c.revision });
      if (request !== renderVersion) return;
      c.revision = result.revision; c.app_name = result.name || c.app_name; c.tenant_name = result.tenant_name || c.tenant_name;
      header.querySelector('h2').textContent = c.app_name || '应用名称待获取';
      renderSummaryFacts(c);
      probeStatus.className = result.tenant_error || result.app_error ? 'view-error' : 'view-success';
      const detail = result.tenant_error === 'channel_tenant_unavailable'
        ? '请在飞书开通“获取企业信息”（tenant:tenant:readonly）应用身份权限，发布并通过必要审核后，再刷新应用信息。'
        : feishuError(new Error(result.tenant_error || ''));
      probeStatus.textContent = [result.app_error ? feishuError(new Error(result.app_error)) : '',
        result.tenant_error ? `企业名称暂未更新。${detail}` : ''].filter(Boolean).join(' ') || '应用与企业信息已检查。';
      grants.replaceChildren(feishuScopeReport(result, data.feishu_scopes, c));
    } catch (err) {
      if (request !== renderVersion) return;
      probeStatus.className = 'view-error'; probeStatus.textContent = feishuError(err);
      grants.replaceChildren(feishuScopeReport({}, data.feishu_scopes, c));
    } finally { refreshBtn.disabled = false; }
  };
  const refreshBtn = button('刷新应用信息与权限', runProbe, 'quiet');
  const statusActions = element('div', '', 'actions');
  statusActions.append(refreshBtn, channelLink('#/identity/feishu', '管理个人与群绑定', 'button-link quiet'));
  header.append(titleBar, headError, summaryFacts, statusActions, probeStatus, grants);
  panel.append(header);
  if (c.enabled) void runProbe();
  pollFeishuConnectionState(c, request, header, renderSummaryFacts);

  // Section 2: In-place connection configuration & credentials (no forced step jump).
  const configCard = settingsCard('连接配置与凭据');
  configCard.id = 'feishu-credentials';
  const form = element('form', '', 'project-form'), formMessage = element('p', '', 'view-error');
  formMessage.setAttribute('role', 'alert');
  form.append(facts([['应用所属', feishuOwner(c)], ...(c.application_type === 'saas' ? [['安装租户 tenant_key', c.installation_tenant]] : [])]),
    note('所属组织、App ID 和安装企业创建后不可修改；凭据保存后不回显，留空即保留原值。'));
  const appInput = channelField(form, 'App ID', 'app_id', c.app_id); appInput.readOnly = true; appInput.required = true;
  let appTypeSelect = null, transportSelect = null;
  if (data.platform) {
    appTypeSelect = channelSelect(form, '应用类型', 'application_type', [['enterprise', '企业自建'], ['saas', 'SaaS / 商店应用']], c.application_type);
    transportSelect = channelSelect(form, '事件接收方式', 'transport', [['websocket', '企业自建 SDK 长连接（无需公网事件地址）'], ['http', 'HTTP 事件回调']], c.transport);
  }
  const secret = channelField(form, 'App Secret（留空保留）', 'app_secret', '', 'password');
  const httpFields = element('div', '', 'project-form');
  const verification = channelField(httpFields, 'Verification Token（留空保留）', 'verification_token', '', 'password');
  const encryption = channelField(httpFields, 'Encrypt Key（留空保留）', 'encrypt_key', '', 'password');
  httpFields.append(note('HTTP 回调模式校验原始请求签名并支持加密事件；首次切换为 HTTP 时必须填写 Verification Token 和 Encrypt Key。'));
  form.append(httpFields);
  const currentType = () => appTypeSelect ? appTypeSelect.value : c.application_type;
  const currentTransport = () => transportSelect ? transportSelect.value : c.transport;
  const syncEditMode = () => {
    if (appTypeSelect && transportSelect) {
      transportSelect.options[0].disabled = appTypeSelect.value === 'saas';
      if (appTypeSelect.value === 'saas') transportSelect.value = 'http';
    }
    const isHttp = currentTransport() === 'http';
    httpFields.hidden = !isHttp;
    verification.required = isHttp && c.transport !== 'http';
    encryption.required = isHttp && c.transport !== 'http';
    probeCredsBtn.hidden = currentType() !== 'enterprise';
  };
  const probeCredsBtn = button('检查凭据并读取机器人', async () => {
    formMessage.textContent = ''; probeCredsBtn.disabled = true;
    try {
      const input = secret.value.trim() ? { app_id: c.app_id, app_secret: secret.value.trim() } : { connector_id: c.id, expected_revision: c.revision };
      const result = await api('/api/channels/feishu/probe', 'POST', input);
      if (result.revision !== undefined) { c.revision = result.revision; c.bot_open_id = result.bot_open_id; }
      formMessage.className = 'view-success';
      formMessage.textContent = `凭据已验证${result.name ? ' · ' + result.name : ''}。`;
      grants.replaceChildren(feishuScopeReport(result, data.feishu_scopes, c));
    } catch (err) {
      formMessage.className = 'view-error'; formMessage.textContent = feishuError(err);
    } finally { probeCredsBtn.disabled = false; }
  }, 'quiet');
  probeCredsBtn.type = 'button';
  const enabledBox = channelField(form, '启用连接', 'enabled', '', 'checkbox'); enabledBox.checked = !!c.enabled;
  const saveBtn = element('button', '保存配置'); saveBtn.type = 'submit';
  const formActions = element('div', '', 'actions');
  formActions.append(saveBtn, probeCredsBtn);
  form.append(formMessage, formActions);
  if (appTypeSelect) appTypeSelect.addEventListener('change', syncEditMode);
  if (transportSelect) transportSelect.addEventListener('change', syncEditMode);
  syncEditMode();
  form.addEventListener('submit', async event => {
    event.preventDefault(); saveBtn.disabled = true; formMessage.textContent = ''; formMessage.className = 'view-error';
    const credentials = Object.fromEntries([
      ['app_secret', secret.value.trim()],
      ['verification_token', currentTransport() === 'http' ? verification.value.trim() : ''],
      ['encrypt_key', currentTransport() === 'http' ? encryption.value.trim() : ''],
    ].filter(([, value]) => value));
    try {
      const result = await api('/api/channels/connectors/' + c.id, 'PATCH', {
        app_id: c.app_id,
        application_type: currentType(),
        transport: currentTransport(),
        enabled: enabledBox.checked,
        expected_revision: c.revision,
        ...(Object.keys(credentials).length ? { credentials } : {}),
      });
      c.revision = result.revision; c.enabled = enabledBox.checked; c.application_type = currentType(); c.transport = currentTransport();
      secret.value = ''; verification.value = ''; encryption.value = '';
      formMessage.className = 'view-success'; formMessage.textContent = '连接配置已保存。';
      toggleBtn.textContent = c.enabled ? '停用连接' : '启用连接';
      renderSummaryFacts(c);
      syncEditMode();
    } catch (err) {
      formMessage.className = 'view-error'; formMessage.textContent = feishuError(err);
    } finally { saveBtn.disabled = false; }
  });
  configCard.append(form);
  panel.append(configCard);
  if (focusCredentials) configCard.scrollIntoView({ block: 'start' });

  // Section 3: Collapsible Feishu Setup Reference (Permissions JSON, Events, Card Callback, HTTP URL).
  const guideCard = settingsCard('飞书配置指南');
  const guideDetails = element('details', '', 'feishu-guide-details');
  guideDetails.open = openGuide;
  guideDetails.append(element('summary', '查看完整权限 JSON、事件订阅与卡片回调配置说明'));
  const guideBody = element('div', '', 'feishu-guide-body');
  guideBody.append(
    note('卡片、富文本、附件与群历史均使用统一的完整权限清单。在飞书“权限管理 → 批量导入/导出”一次导入下方 JSON，已开通权限不受影响；完成后创建并发布新版本。'),
    channelCopy('完整权限 JSON', feishuScopeJSON(data.feishu_scopes, c.application_type)),
    buildFeishuEventsInstructions(c, data, {
      onRefresh: async () => {
        try {
          const fresh = await api('/api/channels/setup');
          const latest = fresh.connectors.find(row => row.id === c.id);
          if (latest) { Object.assign(c, latest); renderSummaryFacts(c); }
        } catch (err) { headError.textContent = feishuError(err); }
      },
      enableAction: button('立即启用连接', () => toggleBtn.click(), 'quiet'),
    }),
  );
  guideDetails.append(guideBody);
  guideCard.append(guideDetails);
  panel.append(guideCard);

  // Section 4: Health, delivery diagnostics & super-admin local history maintenance.
  await channelDiagnostics(c, panel, data.platform);

  // Section 5: Delete connector.
  const dangerCard = settingsCard('删除应用连接');
  dangerCard.classList.add('feishu-danger-zone');
  dangerCard.append(
    note('删除后将立即断开连接、销毁密封凭据、停用该应用下的所有群聊助手绑定与会话定时任务，并撤销通过该应用绑定的个人飞书身份；历史聊天记录仍保留只读。'),
    button('删除此飞书应用连接', () => {
      void confirmDeleteFeishuConnector(c, async () => { location.hash = base; });
    }, 'quiet destructive'),
  );
  panel.append(dangerCard);
}

async function renderFeishuWizard(panel, data, id, step, request) {
  const base = feishuBase(), c = id === 'new' ? null : data.connectors.find(row => row.id === id);
  if (id !== 'new' && !c) { panel.append(note('连接不存在，或你没有权限管理它。'), channelLink(base, '返回飞书连接')); return; }
  if (!c && !data.platform && !data.organizations.length) { panel.append(note('你当前不能为任何组织新增飞书应用。'), channelLink(base, '返回飞书连接')); return; }
  if (!c && step > 0) {
    const empty = settingsCard('飞书应用连接向导'), emptyActions = element('div', '', 'feishu-page-actions');
    emptyActions.append(channelLink(feishuWizardAddress('new', 0), '从第 1 步开始', 'button-link'), channelLink(base, '返回连接列表', 'button-link quiet'));
    empty.append(note('请先保存应用连接，再继续配置事件、发布和试用。'), emptyActions);
    panel.append(empty);
    return;
  }

  const title = settingsCard('飞书应用连接向导'), nav = element('nav', '', 'wizard-steps');
  nav.setAttribute('aria-label', '飞书连接步骤');
  title.append(note(`第 ${step + 1} / ${feishuWizardSteps.length} 步${c ? ' · ' + (c.app_name || c.app_id) + (c.tenant_name ? ' · ' + c.tenant_name : '') : ''}。凭据保存后不回显。`));
  feishuWizardSteps.forEach((caption, i) => {
    const item = button(`${i + 1}. ${caption}`, () => { location.hash = feishuWizardAddress(c ? c.id : 'new', i); }, 'quiet');
    item.disabled = !c && i > 0 || Boolean(c && i === 0);
    if (i === step) item.setAttribute('aria-current', 'step');
    nav.append(item);
  });
  const wizardActions = element('div', '', 'feishu-page-actions');
  wizardActions.append(channelLink(base, '返回连接列表', 'button-link quiet'));
  title.append(nav, wizardActions);
  panel.append(title);

  const body = settingsCard(feishuWizardSteps[step]);
  panel.append(body);

  if (step === 0) {
    const savedDraft = readFeishuDraft() || {};
    const initialType = data.platform && ['enterprise', 'saas'].includes(savedDraft.application_type) ? savedDraft.application_type : 'enterprise';
    const initialTransport = data.platform && ['websocket', 'http'].includes(savedDraft.transport) ? savedDraft.transport : 'websocket';
    const form = element('form', '', 'project-form'), message = element('p', '', 'view-error');
    message.setAttribute('role', 'alert');

    const owners = [...(data.platform ? [['', '全平台共用（所有用户可见）']] : []), ...data.organizations.map(o => ['org:' + o.id, '组织 ' + o.name])];
    const defaultOwner = owners.some(([value]) => value === savedDraft.owner) ? savedDraft.owner : owners[0]?.[0];
    const owner = channelSelect(form, '应用所属', 'owner_tenant', owners, defaultOwner);
    const application = channelSelect(form, '应用类型', 'application_type', [['enterprise', '企业自建'], ['saas', 'SaaS / 商店应用']], initialType);
    const transport = channelSelect(form, '事件接收方式', 'transport', [['websocket', '企业自建 SDK 长连接（无需公网事件地址）'], ['http', 'HTTP 事件回调']], initialTransport);
    if (!data.platform) {
      application.value = 'enterprise'; transport.value = 'websocket';
      application.options[1].disabled = true; transport.options[1].disabled = true;
      form.append(note('组织的应用只能是企业自建应用，并通过 SDK 长连接接收事件；HTTP 回调和商店应用只能由超级管理员配置。'));
    }
    form.append(
      note('组织的应用只有该组织内有授权的人能看到和绑定；它所在的群只能选择本组织的仓库，经它绑定的飞书身份也只能使用本组织内的权限。所属组织、App ID 和安装企业保存后不可修改。'),
      note('应用连接不授予用户项目权限，也不限制操作者所属飞书企业；外部成员也需完成个人绑定并获得相应项目权限。'),
    );

    const prepBox = element('div', '', 'feishu-guide-body');
    const permissions = element('div'), installationNote = note('企业自建应用需先开通“获取企业信息”（tenant:tenant:readonly）应用身份权限，并发布包含机器人能力和该权限的初始版本、通过必要审核，再保存连接；否则无法自动获取安装企业。');
    const prepActions = element('div', '', 'actions');
    prepActions.append(channelLink('https://open.feishu.cn/app', '打开飞书开发者后台', 'button-link quiet'), ...(data.platform ? [channelLink('#/settings/access', '配置公网 HTTPS 地址', 'button-link quiet')] : []));
    prepBox.append(
      feishuList([
        '在飞书开发者后台创建或打开应用，在“添加应用能力”中开启机器人。',
        '在“权限管理 → 批量导入/导出”一次导入下方完整权限 JSON（包含消息收发、富文本/卡片、附件、群历史、群成员核验、姓名与企业信息），再发布初始版本。',
        '从“凭证与基础信息”复制 App ID 和 App Secret；选择 HTTP 回调时另需“事件与回调 → 加密策略”里的 Verification Token 和 Encrypt Key。',
      ]),
      prepActions,
      permissions,
      installationNote,
      note('卡片权限与回调会统一引导申请：cardkit:card:write 与 im:message:send_as_bot 用于卡片与消息发送，下一步还需在“回调配置”添加 card.action.trigger（权限导入不会自动订阅回调）。'),
    );
    form.append(prepBox);

    const app = channelField(form, 'App ID', 'app_id', ''); app.required = true;
    const secret = channelField(form, 'App Secret', 'app_secret', '', 'password'); secret.required = true;
    const botHint = note('');
    form.append(botHint);

    const probeGrants = element('div');
    const probeBtn = button('检查凭据并读取机器人', async () => {
      message.textContent = ''; probeBtn.disabled = true;
      try {
        const result = await api('/api/channels/feishu/probe', 'POST', { app_id: app.value.trim(), app_secret: secret.value.trim() });
        message.className = 'view-success';
        message.textContent = `凭据已验证${result.name ? ' · ' + result.name : ''}。事件投递仍需下一步订阅并发布后验证。`;
        probeGrants.replaceChildren(feishuScopeReport(result, data.feishu_scopes, { application_type: 'enterprise', app_id: app.value.trim() }));
      } catch (err) {
        message.className = 'view-error'; message.textContent = feishuError(err); probeGrants.replaceChildren();
      } finally { probeBtn.disabled = false; }
    }, 'quiet');
    probeBtn.type = 'button';
    form.append(probeBtn, probeGrants);

    const saasBox = element('div', '', 'project-form');
    const installation = channelField(saasBox, '应用安装租户 tenant_key', 'installation_tenant', '');
    saasBox.append(note('商店应用需要先指定机器人安装的飞书企业，才能换取该企业的访问令牌。此字段仅用于核对事件来源，不限制操作者所属企业。'));
    const enterpriseInstallHint = note('应用安装企业由系统在保存时自动获取，无需填写 tenant_key。安装企业仅用于核对应用事件来源，不限制操作者所属企业。');
    form.append(enterpriseInstallHint, saasBox);

    const httpBox = element('div', '', 'project-form');
    const verification = channelField(httpBox, 'Verification Token', 'verification_token', '', 'password');
    const encryption = channelField(httpBox, 'Encrypt Key', 'encrypt_key', '', 'password');
    httpBox.append(note('HTTP 回调校验原始请求签名并支持加密事件，Verification Token 和 Encrypt Key 都需填写。'));
    form.append(httpBox);

    const enabled = channelField(form, '启用连接', 'enabled', '', 'checkbox'); enabled.checked = true;
    const saveBtn = element('button', '保存连接并继续'); saveBtn.type = 'submit';
    form.append(message, saveBtn);

    const sync = () => {
      transport.options[0].disabled = application.value === 'saas';
      if (application.value === 'saas') transport.value = 'http';
      if (!data.platform) transport.options[1].disabled = true;
      writeFeishuDraft({ owner: owner.value, application_type: application.value, transport: transport.value });
      permissions.replaceChildren(channelCopy('完整权限 JSON', feishuScopeJSON(data.feishu_scopes, application.value)));
      const isEnterprise = application.value === 'enterprise';
      const isHttp = transport.value === 'http';
      installationNote.hidden = !isEnterprise;
      enterpriseInstallHint.hidden = !isEnterprise;
      saasBox.hidden = isEnterprise;
      installation.required = !isEnterprise;
      probeBtn.hidden = !isEnterprise;
      if (!isEnterprise) probeGrants.replaceChildren();
      httpBox.hidden = !isHttp;
      verification.required = isHttp;
      encryption.required = isHttp;
      botHint.textContent = isEnterprise
        ? '机器人身份由系统在保存时自动读取，无需填写 open_id。请先启用机器人能力并发布初始版本。'
        : '机器人身份无需填写。先保存连接、配置 HTTP 回调并接收应用票据，再在下一步检查并自动同步。';
    };
    owner.addEventListener('change', sync);
    application.addEventListener('change', sync);
    transport.addEventListener('change', sync);
    sync();

    form.addEventListener('submit', async event => {
      event.preventDefault(); saveBtn.disabled = true; message.textContent = ''; message.className = 'view-error';
      const isEnterprise = application.value === 'enterprise', isHttp = transport.value === 'http';
      const credentials = Object.fromEntries([
        ['app_secret', secret.value.trim()],
        ['verification_token', isHttp ? verification.value.trim() : ''],
        ['encrypt_key', isHttp ? encryption.value.trim() : ''],
      ].filter(([, value]) => value));
      try {
        const result = await api('/api/channels/connectors', 'POST', {
          app_id: app.value.trim(),
          ...(!isEnterprise ? { installation_tenant: installation.value.trim() } : {}),
          owner_tenant: owner.value ? owner.value.slice(4) : null,
          application_type: application.value,
          transport: transport.value,
          enabled: enabled.checked,
          expected_revision: 0,
          credentials,
        });
        secret.value = ''; verification.value = ''; encryption.value = '';
        writeFeishuDraft(null);
        location.hash = feishuWizardAddress(result.connector_id, 1);
      } catch (err) {
        message.className = 'view-error'; message.textContent = feishuError(err);
      } finally { saveBtn.disabled = false; }
    });
    body.append(form);
    return;
  }

  if (step === 1) {
    const statusLine = element('div', '', 'feishu-detail-title');
    const enabledBadge = feishuBadge(feishuEnabledInfo(c).text, feishuEnabledInfo(c).variant);
    const activityBadge = feishuBadge(feishuActivityInfo(c).text, feishuActivityInfo(c).variant);
    const transportFacts = element('div');
    const updateStatus = latest => {
      const enabled = feishuEnabledInfo(latest), activity = feishuActivityInfo(latest);
      if (enabledBadge.textContent !== enabled.text) {
        enabledBadge.textContent = enabled.text;
        enabledBadge.className = 'feishu-binding-badge feishu-binding-badge-' + enabled.variant;
      }
      if (activityBadge.textContent !== activity.text) {
        activityBadge.textContent = activity.text;
        activityBadge.className = 'feishu-binding-badge feishu-binding-badge-' + activity.variant;
      }
      transportFacts.replaceChildren(facts([['接入方式', feishuTransportText(latest)], ['活跃状态', activity.text]]));
    };
    statusLine.append(enabledBadge, activityBadge);
    updateStatus(c);

    const probeStatus = element('p', '', 'view-error'), grants = element('div');
    probeStatus.setAttribute('role', 'status');
    const probe = button('检查已发布的机器人与权限', async () => {
      probe.disabled = true; probeStatus.className = 'view-success'; probeStatus.textContent = '正在检查…';
      try {
        const result = await api('/api/channels/feishu/probe', 'POST', { connector_id: c.id, expected_revision: c.revision });
        c.revision = result.revision; c.bot_open_id = result.bot_open_id;
        probeStatus.className = 'view-success';
        probeStatus.textContent = `凭据已验证 · ${result.name || '机器人'}，机器人身份已自动同步。尚未验证事件投递。`;
        grants.replaceChildren(feishuScopeReport(result, data.feishu_scopes, c));
      } catch (err) {
        probeStatus.className = 'view-error'; probeStatus.textContent = feishuError(err); grants.replaceChildren();
      } finally { probe.disabled = false; }
    }, 'quiet');

    const nextActions = element('div', '', 'actions');
    nextActions.append(probe, button('完成配置，进入绑定与试用', () => { location.hash = feishuWizardAddress(c.id, 2); }, ''));

    body.append(
      statusLine,
      transportFacts,
      buildFeishuEventsInstructions(c, data, {
        onRefresh: async () => {
          const fresh = await api('/api/channels/setup');
          const latest = fresh.connectors.find(row => row.id === c.id);
          if (latest) { Object.assign(c, latest); updateStatus(c); }
        },
        enableAction: channelLink(feishuDetailAddress(c.id), '前往应用管理页启用连接'),
      }),
      nextActions,
      probeStatus,
      grants,
    );
    pollFeishuConnectionState(c, request, body, updateStatus);
    return;
  }

  // Step 2 (index 2): 完成与绑定
  body.append(
    feishuList([
      '让每位使用者在「个人设置 → 飞书绑定」点击「创建个人绑定」生成绑定串并在机器人私聊发送（旧私聊 /bind 链接仍保留兼容）。',
      '绑定后直接在私聊发送“你好”或“我能管理哪些项目”，确认收到助手回复后即完成接入。绑定本身不增加仓库权限。',
      '需要群内使用时，由已绑定飞书、在该群中并对相关仓库有配置权限的维护人，在「个人设置 → 飞书绑定」点击「创建群绑定」，配置仓库范围、权限与助手角色。',
      '日常启停、更新密钥、查看权限状态、收发诊断与历史维护，请随时进入该应用的管理详情页。',
    ]),
  );
  const doneActions = element('div', '', 'actions');
  doneActions.append(
    channelLink('#/identity/feishu', '前往飞书绑定', 'button-link'),
    channelLink(feishuDetailAddress(c.id), '进入应用管理页', 'button-link quiet'),
    channelLink(base, '返回连接列表', 'button-link quiet'),
  );
  body.append(doneActions);
}

async function renderFeishuSetup(panel, request) {
  const data = await api('/api/channels/setup');
  if (request !== renderVersion) return;
  const base = feishuBase(), hash = location.hash;

  // 1. Create wizard: #/<base>/new, #/<base>/new/0, legacy #/<base>/new/1, or #/<base>/<id>/setup/<1|2>
  const newMatch = /^#\/(?:settings\/feishu|identity\/feishu-apps)\/new(?:\/([0-4]))?$/.exec(hash);
  if (newMatch) {
    const rawStep = newMatch[1] ? Number(newMatch[1]) : 0;
    // Legacy /new/1 opened the credentials form directly; step 0 now combines app choice & credentials.
    await renderFeishuWizard(panel, data, 'new', rawStep <= 1 ? 0 : rawStep, request);
    return;
  }
  const setupMatch = /^#\/(?:settings\/feishu|identity\/feishu-apps)\/([a-f0-9]{48})\/setup\/([0-2])$/.exec(hash);
  if (setupMatch) {
    await renderFeishuWizard(panel, data, setupMatch[1], Number(setupMatch[2]), request);
    return;
  }

  // 2. Existing app detail page: #/<base>/<id> (and legacy #/<base>/<id>/<0-4> deep links)
  const detailMatch = /^#\/(?:settings\/feishu|identity\/feishu-apps)\/([a-f0-9]{48})(?:\/([0-4]))?$/.exec(hash);
  if (detailMatch) {
    const c = data.connectors.find(row => row.id === detailMatch[1]);
    if (!c) { panel.append(note('连接不存在，或你没有权限管理它。'), channelLink(base, '返回飞书连接')); return; }
    const legacyStep = detailMatch[2] !== undefined ? Number(detailMatch[2]) : null;
    await renderFeishuDetail(panel, data, c, request, { openGuide: legacyStep === 2, focusCredentials: legacyStep === 1 });
    return;
  }

  // 3. Default: clean connector list page.
  renderFeishuList(panel, data, request);
}
