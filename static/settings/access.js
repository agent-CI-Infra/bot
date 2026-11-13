function addressBody(view, redraw) {
  const saved = view.onboarding.public_address, origin = input('origin', saved?.origin || '', { type: 'url', placeholder: 'https://你的域名，不带路径' });
  return [saved ? facts([['已验证地址', saved.origin], ['检查时间', timestamp(saved.checked_at)]]) : note('还没有验证过的公网地址。'),
    note('这是 Bot 唯一的公网入口：GitHub 把 webhook 送到这里，用户也从这里登录控制台，都到达本机业务端口 8791。检查会核对当前实例的一次性凭证，拒绝重定向、其他实例和私网地址。改了地址后：到「机器人账号」点当前 App 的「重新检查」更新 webhook；在 GitHub App 设置里把 Callback URL 和 Setup URL 改到新地址；用户需要在新地址重新登录。'),
    actionForm([field('公网 HTTPS 地址', origin)], '检查并保存', async () => {
      if (!origin.value.trim()) throw new Error('先填写公网 HTTPS 地址');
      view.onboarding.public_address = (await api('/api/onboarding/address', 'POST', { origin: origin.value.trim() })).public_address;
      redraw('已检查并保存 ' + view.onboarding.public_address.origin); view.app?.redraw();
    })];
}
// The token is write-only: the page shows whether one is saved, never the token or the pasted command.
function tunnelBody(view, redraw) {
  const tunnel = view.onboarding.tunnel, configured = tunnel.token_configured;
  const credential = tunnelCredential(configured ? '已保存；粘贴新的 token 或命令来替换' : '粘贴 tunnel token 或 Cloudflare 完整命令');
  const revoke = button('撤销 token', async () => {
    if (!await askConfirm({ title: '撤销 Cloudflare Tunnel token？', body: ['删除保存的 token，tunnel 服务随之断开；经 tunnel 转发的 webhook 不再到达，直到重新保存 token。', '已验证的公网地址和 GitHub App 的 webhook 地址都不变。'], action: '撤销', danger: true })) return;
    revoke.disabled = true;
    try { view.onboarding.tunnel = (await api('/api/onboarding/tunnel', 'POST', { revoke: true })).tunnel; redraw('已撤销 tunnel token'); }
    catch (err) { revoke.disabled = false; error(err); }
  }, 'quiet destructive');
  const nodes = [facts([['Token', configured ? '已保存' : '未配置'], ['连接状态', configured ? tunnelStates[tunnel.state] || tunnel.state : null], ['Service URL', tunnel.origin]]),
    note('只用自建 HTTPS 中转时不需要 tunnel。可以粘贴原始 token，或包含它的完整 cloudflared 安装、运行命令；只保存其中的 token，页面和接口都不再显示它。Published application 的 Service URL 必须是 http://webhook:8791。')];
  if (!tunnel.available) nodes.push(note('这台部署没有配置 tunnel 服务，保存和撤销都会失败。'));
  nodes.push(actionForm([field('Tunnel token 或完整命令', credential)], '保存 token', async () => {
    if (!credential.value.trim()) throw new Error('先粘贴 tunnel token 或完整命令');
    view.onboarding.tunnel = (await api('/api/onboarding/tunnel', 'POST', { token: credential.value })).tunnel; redraw('已保存 tunnel token');
  }, configured ? [revoke] : []));
  return nodes;
}
// The GitHub login configuration as it is in force: the OAuth App, where GitHub returns the user, and what a change does.
// It is read-only here; the wizard's third step is the only place that writes it, so the two never disagree about a value.
const loginOriginSources = { public_address: '已验证的公网地址', deployment: '部署配置的入口（BOT_PUBLIC_ORIGIN）', local: '本机地址（只在本地测试时可用）' };
const loginConfigSources = { wizard: '控制台向导保存', deployment: '部署环境变量', empty: '未配置' };
function loginAccessCard(login) {
  const section = card('GitHub 登录（只读）');
  if (!login) { section.append(note('这个部署没有登录配置接口，读不到 GitHub 登录设置。')); return section; }
  const separate = login.application_type === 'oauth_app', configured = login.source !== 'empty';
  section.append(facts([['登录状态', login.enabled ? '已启用：用户可以用 GitHub 账号登录' : '未启用：只能用本地账号登录'],
    // Nothing saved means no App at all: naming one here would contradict「Client ID 未填写」on the next line.
    ['OAuth App', !configured ? '未配置' : separate ? '独立 OAuth App（只用于登录）' : '仍复用仓库 GitHub App（登录与仓库连接没有分开）'],
    ['Client ID', login.client_id || '未填写'],
    ['Client secret', login.secret_configured ? '已保存（接口不回读）' : '未保存'],
    ['登录 Callback URL', login.callback_url || '还没有可用的公网地址'],
    ['回调地址来源', loginOriginSources[login.origin_source] || login.origin_source],
    ['配置来源', loginConfigSources[login.source] || login.source]]));
  // A configuration saved under another address still has that callback registered at GitHub.
  if (login.previous_callback_url) section.append(note(`这个配置是在旧地址保存的：GitHub 目前仍把用户送回 ${login.previous_callback_url}。请在该 OAuth App 里把 Authorization callback URL 改成上面的登录 Callback URL。`));
  if (login.migration_required) section.append(note('登录仍复用仓库 GitHub App：切换成独立 OAuth App 后，仓库 App 与它的安装都不变，但登录凭据要换。'));
  section.append(note('改动登录配置的影响：换 OAuth App 或 Client ID 后，现有 GitHub 会话失效，用户要用新 App 重新登录；旧 App 的个人授权要到 GitHub 的 Authorized GitHub Apps 里撤销。仓库连接用的 GitHub App、安装和 webhook 都由「机器人账号」和上面的地址管理，不受登录配置影响。'));
  // Read-only on purpose: the wizard owns the editor, this page only states what is in force and what changing it means.
  const onlyRead = element('p', '这里只显示当前生效的登录配置，不在这里修改；改配置或换凭据请到 ', 'muted');
  onlyRead.append(settingsLink('#/settings/onboarding/2', '接入向导第 3 步（GitHub 登录）'), '。');
  section.append(onlyRead);
  return section;
}
